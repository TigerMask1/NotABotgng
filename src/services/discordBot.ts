import {
  Client, GatewayIntentBits, Message, Partials,
  Events, TextChannel, ActivityType, PermissionFlagsBits
} from 'discord.js';
import { db } from './firebase.ts';
import dotenv from 'dotenv';

dotenv.config();

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// ── MODELS ──────────────────────────────────────────────────────────
const ACTIVE_MODEL  = 'gemini-3.1-flash-lite';
const PASSIVE_MODEL = 'gemma-4-26b-a4b-it';
const BG_MODEL      = 'gemma-4-31b-it';

// ── VISION ──────────────────────────────────────────────────────────
interface ImagePart { mimeType: string; data: string; }

// ── GEMINI MANAGER ───────────────────────────────────────────────────
// Handles rate limits (429s) gracefully by round-robining keys and waiting.
class GeminiManager {
  private keys: string[];
  private idx = 0;
  private cooldowns = new Map<string, number>();

  constructor() {
    const raw = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '';
    this.keys = raw.split(',').map(k => k.trim()).filter(Boolean);
    if (!this.keys.length) console.error('[Gemini] no API keys found');
    else console.log(`[Gemini] ${this.keys.length} key(s) loaded`);
  }

  private pickKey(): string | null {
    const now = Date.now();
    for (let i = 0; i < this.keys.length; i++) {
      const k = this.keys[(this.idx + i) % this.keys.length];
      if (!this.cooldowns.get(k) || now > this.cooldowns.get(k)!) {
        this.idx = (this.idx + i + 1) % this.keys.length;
        return k;
      }
    }
    return null;
  }

  private soonestCooldownMs(): number {
    let soonest = Infinity;
    for (const cd of this.cooldowns.values()) {
      const remaining = cd - Date.now();
      if (remaining > 0 && remaining < soonest) soonest = remaining;
    }
    return soonest === Infinity ? 0 : soonest;
  }

  async call(
    systemPrompt: string,
    userPrompt: string,
    temp = 0.9,
    model = ACTIVE_MODEL,
    images: ImagePart[] = [],
    maxOutputTokens = 600,
  ): Promise<string> {
    const userParts = [
      ...images.map(img => ({ inlineData: { mimeType: img.mimeType, data: img.data } })),
      { text: userPrompt },
    ];
    const generationConfig: Record<string, any> = {
      temperature: temp,
      responseMimeType: 'application/json',
      maxOutputTokens,
    };

    let lastError = '';
    const maxAttempts = Math.max(this.keys.length, 1) * 2;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const key = this.pickKey();
      if (!key) {
        const wait = this.soonestCooldownMs() + 200;
        await sleep(wait);
        continue;
      }

      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: systemPrompt }] },
              contents: [{ role: 'user', parts: userParts }],
              generationConfig,
            }),
          }
        );

        if (res.status === 429) {
          const body = await res.json().catch(() => ({})) as any;
          const retryMs = ((body?.error?.details?.[0]?.retryDelay?.seconds ?? 15) as number) * 1000;
          this.cooldowns.set(key, Date.now() + retryMs);
          lastError = '429 Rate Limit';
          continue;
        }

        if (!res.ok) {
          const err = await res.text().catch(() => res.statusText);
          throw new Error(`Gemini ${res.status}: ${err.slice(0, 150)}`);
        }

        const data = await res.json() as any;
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
        if (!text.trim()) continue;
        return text;
      } catch (e: any) {
        lastError = e.message;
        if (e.message?.includes('429')) continue;
        if (attempt < maxAttempts - 1) await sleep(Math.min(1500 * 2 ** attempt, 8000));
      }
    }
    throw new Error(`[Gemini] all attempts failed. Last error: ${lastError}`);
  }

  canCall(): boolean { return this.keys.length > 0; }
  getKey(): string | null { return this.pickKey(); }
}

const gemini = new GeminiManager();

// ── EMBEDDING MANAGER ────────────────────────────────────────────────
const EMBED_MODEL = 'text-embedding-004';

class EmbeddingManager {
  async embed(text: string): Promise<number[] | null> {
    if (!gemini.canCall() || !text?.trim()) return null;
    const key = gemini.getKey();
    if (!key) return null;
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:embedContent?key=${key}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: { parts: [{ text: text.slice(0, 2000) }] } }),
        }
      );
      if (!res.ok) return null;
      const data = await res.json() as any;
      const vec = data?.embedding?.values;
      return Array.isArray(vec) ? vec : null;
    } catch { return null; }
  }

  cosineSim(a: number[], b: number[]): number {
    if (a.length !== b.length || !a.length) return 0;
    let dot = 0, magA = 0, magB = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; magA += a[i] ** 2; magB += b[i] ** 2; }
    return (!magA || !magB) ? 0 : dot / (Math.sqrt(magA) * Math.sqrt(magB));
  }
}

const embedder = new EmbeddingManager();

// ── CONSTANTS ────────────────────────────────────────────────────────
const STM_MAX = 30; // Short term memory depth per channel
const BRAIN_CONTEXT_MSGS = 12; // Messages sent to brain
const TICK_MS            = 60_000; // Background tick interval
const BRAIN_COOLDOWN_MS  = 45_000; // Base cooldown between brain turns

// Tracks the last time a brain turn was fired per channel
const lastBrainTurnAt = new Map<string, number>();
// Tracks if a follow-up is pending for a channel (bot committed to responding)
const pendingFollowUp = new Map<string, ReturnType<typeof setTimeout>>();

// Dynamic cooldown: shorter when conversation is active (messages coming fast)
function effectiveCooldownMs(channelId: string): number {
  const msgs = stmGet(channelId);
  if (msgs.length < 2) return BRAIN_COOLDOWN_MS;
  const gap = Date.now() - msgs[msgs.length - 1].ts;
  // If messages are coming in fast (< 30s between them), shorten cooldown to 15s
  if (gap < 30_000) return 15_000;
  // If moderate activity, 30s
  if (gap < 90_000) return 30_000;
  return BRAIN_COOLDOWN_MS;
}

function canFireBrainTurn(channelId: string): boolean {
  const last = lastBrainTurnAt.get(channelId) ?? 0;
  return Date.now() - last >= effectiveCooldownMs(channelId);
}

function scheduleFollowUp(channelId: string, delayMs: number) {
  // Clear any existing pending follow-up
  const existing = pendingFollowUp.get(channelId);
  if (existing) clearTimeout(existing);
  const t = setTimeout(async () => {
    pendingFollowUp.delete(channelId);
    lastBrainTurnAt.delete(channelId); // clear cooldown so it fires
    await runBrainTurn('Following up on something I committed to checking', 'active');
  }, delayMs);
  pendingFollowUp.set(channelId, t);
}

// ── BOT GLOBALS ──────────────────────────────────────────────────────
let BOT_NAME = 'NotABot';
let BOT_ID = '';
let botClient: Client | null = null;
let globallyMuted = false;
let lastSpokeAt = Date.now();

// ── ADMIN STATE ────────────────────────────────────────────────────────
const ADMIN_ID = process.env.ADMIN_ID || '1296109674361520146';
const serverMuted = new Map<string, boolean>();
const serverFamilyFriendly = new Map<string, boolean>();
const allowedChannels = new Map<string, Set<string>>(); // guildId -> Set of channelIds
const allowedBots = new Map<string, Set<string>>(); // guildId -> Set of bot userIds

// ── ADMIN NATURAL-LANGUAGE ALIASES ────────────────────────────────────
const ADMIN_NL: { re: RegExp; cmd: string }[] = [
  { re: /\b(listen to|start listening to|pay attention to|hear)\s+<@!?\d+>/i, cmd: '!listenbot' },
  { re: /\b(ignore|stop listening to|stop hearing)\s+<@!?\d+>/i, cmd: '!ignorebot' },
  { re: /\b(what|which)\s+bots?\b.*\b(listen|hear)/i, cmd: '!bots' },
  { re: /\b(only (talk|listen|respond)|restrict yourself|scope yourself)\b.*\b(here|this channel)\b/i, cmd: '!listenhere' },
  { re: /\b(stop (talking|listening|responding))\b.*\b(here|in this channel)\b/i, cmd: '!unlisten' },
  { re: /\b(talk|listen)\s+(everywhere|in every channel)|reset (the )?channels?\b/i, cmd: '!listenall' },
  { re: /\b(what|which) channels?\b.*(you('re| are)?( allowed to)? (talk|listen)|listening)/i, cmd: '!channels' },
  { re: /\bkeep it (clean|pg)|family friendly|no swearing/i, cmd: '!familyfriendly' },
  { re: /\b(be unfiltered|you can swear)\b/i, cmd: '!nsfw' }
];

function resolveAdminCommand(content: string, isAdmin: boolean): string | null {
  const BANG = ['!stop','!resume','!listenbot','!ignorebot','!bots','!listenhere','!unlisten','!listenall','!channels','!help', '!familyfriendly', '!nsfw'];
  if (!isAdmin) return null;
  const trimmed = content.trim();
  const firstWord = trimmed.split(' ')[0].toLowerCase();
  if (BANG.includes(firstWord)) return firstWord;
  for (const { re, cmd } of ADMIN_NL) if (re.test(trimmed)) return cmd;
  return null;
}

// ── ID CACHES ────────────────────────────────────────────────────────
const idCache = new Map<string, string>();
const serverNameCache = new Map<string, string>();
const channelNameCache = new Map<string, string>();
function resolveName(id: string) { return idCache.get(id) || id; }

// ── ENERGY & MOOD ENGINE ─────────────────────────────────────────────
// This drives the roving focus. The bot gets bored if ignored, hyped if engaged.
let globalEnergy = 50; // 0 to 100
let currentFocusChannelId: string | null = null;
let currentFocusGuildId: string | null = null;
let isRoving = false;

function updateEnergy(delta: number) {
  globalEnergy = Math.max(0, Math.min(100, globalEnergy + delta));
}

// ── STM (Short-Term Memory) ──────────────────────────────────────────
interface STMsg { ts: number; id: string; authorId: string; author: string; content: string; }
const stmStore = new Map<string, STMsg[]>();

function stmPush(channelId: string, m: STMsg) {
  if (!stmStore.has(channelId)) stmStore.set(channelId, []);
  const arr = stmStore.get(channelId)!;
  arr.push(m);
  if (arr.length > STM_MAX) arr.shift();
}
function stmGet(channelId: string): STMsg[] { return stmStore.get(channelId) ?? []; }

function formatMsgs(msgs: STMsg[]): string {
  if (!msgs.length) return '(quiet)';
  const now = Date.now();
  return msgs.map(m => {
    const ago = Math.round((now - m.ts) / 1000);
    const t = ago < 60 ? `${ago}s ago` : `${Math.round(ago / 60)}m ago`;
    return `[${t}] ${m.author}: ${m.content}`;
  }).join('\n');
}

// ── FLUID SEMANTIC MEMORY ────────────────────────────────────────────
// Replaces bucketed memory. We store impressions and episodic memories.
interface MemoryVector { text: string; vector: number[]; createdAt: string; }

async function addMemory(scopeId: string, text: string) {
  if (!text?.trim()) return;
  const vec = await embedder.embed(text);
  if (!vec) return;
  const hash = Math.abs(text.split('').reduce((a, b) => ((a << 5) - a) + b.charCodeAt(0), 0)).toString(36);
  await db.collection('scopes').doc(scopeId).collection('memories').doc(hash)
    .set({ text, vector: vec, createdAt: new Date().toISOString() }, { merge: true }).catch(() => {});
}

async function recallMemory(scopeId: string, query: string, topK = 4): Promise<string> {
  if (!query?.trim()) return '';
  const queryVec = await embedder.embed(query);
  if (!queryVec) return '';
  try {
    const snap = await db.collection('scopes').doc(scopeId).collection('memories').get();
    if (snap.empty) return '';
    const scored = snap.docs
      .map(d => d.data() as MemoryVector)
      .filter(v => Array.isArray(v.vector) && v.vector.length)
      .map(v => ({ text: v.text, score: embedder.cosineSim(queryVec, v.vector) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
    return scored.map(s => s.text).join(' | ');
  } catch { return ''; }
}

// ── PER-USER RELATIONSHIP DATA ────────────────────────────────────────
interface RelData { bond: number; impressions: string[]; explicitlyTold: string[]; lastSeenAt: number; }
const relCache = new Map<string, { d: RelData; ts: number }>();

async function getRelData(userId: string): Promise<RelData> {
  const c = relCache.get(userId);
  if (c && Date.now() - c.ts < 60_000) return c.d;
  try {
    const snap = await db.collection('relationships').doc(userId).get();
    const d = {
      bond: snap.data()?.bond ?? 50,
      impressions: snap.data()?.impressions ?? [],
      explicitlyTold: snap.data()?.explicitlyTold ?? [],
      lastSeenAt: snap.data()?.lastSeenAt ?? 0,
    };
    relCache.set(userId, { d, ts: Date.now() });
    return d;
  } catch { return { bond: 50, impressions: [], explicitlyTold: [], lastSeenAt: 0 }; }
}

async function updateRelData(userId: string, updates: Partial<RelData>) {
  relCache.delete(userId);
  await db.collection('relationships').doc(userId).set(updates, { merge: true }).catch(() => {});
}

// ── LINK PREVIEW EXTRACTOR ────────────────────────────────────────────
async function fetchLinkPreview(url: string): Promise<string> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }, signal: controller.signal });
    clearTimeout(timeoutId);
    if (!res.ok) return '';
    const text = await res.text();
    const match = text.match(/<title[^>]*>([^<]+)<\/title>/i);
    return match ? match[1].trim().replace(/&quot;/g, '"').replace(/&#39;/g, "'") : '';
  } catch {
    return '';
  }
}

async function fetchYouTubeOEmbed(url: string): Promise<string> {
  try {
    const res = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`);
    if (!res.ok) return '';
    const data = await res.json() as any;
    return `${data.title} (by ${data.author_name})`;
  } catch { return ''; }
}

// ── GIF FETCHER ───────────────────────────────────────────────────────
async function fetchGif(query: string): Promise<string> {
  const tenorKey = process.env.TENOR_API_KEY;
  const giphyKey = process.env.GIPHY_API_KEY;
  
  try {
    if (giphyKey) {
      const res = await fetch(`https://api.giphy.com/v1/gifs/search?api_key=${giphyKey}&q=${encodeURIComponent(query)}&limit=1`);
      if (!res.ok) return '';
      const data = await res.json() as any;
      return data.data?.[0]?.images?.original?.url || '';
    } else if (tenorKey) {
      const res = await fetch(`https://tenor.googleapis.com/v2/search?q=${encodeURIComponent(query)}&key=${tenorKey}&limit=1`);
      if (!res.ok) return '';
      const data = await res.json() as any;
      return data.results?.[0]?.url || '';
    }
  } catch { return ''; }
  return '';
}

// ── TOOL SYSTEM ──────────────────────────────────────────────────────
// Results from tool calls are stored here and injected into the NEXT brain turn.
// This means zero extra Gemini API calls — tools are free riders on the existing cycle.
const pendingToolResults = new Map<string, string>(); // channelId -> result text

async function runTool(cmd: string, args: Record<string, string>, channelId: string): Promise<void> {
  let result = '';
  try {
    switch (cmd) {
      case 'wiki_lookup': {
        const topic = args.topic?.slice(0, 100) || '';
        if (!topic) break;
        const res = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(topic.replace(/\s+/g,'_'))}`);
        if (!res.ok) { result = `no wikipedia page for "${topic}"`; break; }
        const d = await res.json() as any;
        result = `[WIKI: ${d.title}] ${d.extract?.slice(0, 300) || 'no summary'}`;
        break;
      }
      case 'web_search': {
        // DuckDuckGo Instant Answer API — free, no key, zero bandwidth cost
        const q = args.query?.slice(0, 150) || '';
        if (!q) break;
        const res = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=1`);
        if (!res.ok) { result = 'search unavailable rn'; break; }
        const d = await res.json() as any;
        const answer = d.AbstractText || d.Answer || '';
        result = answer ? `[WEB: ${d.AbstractSource}] ${answer.slice(0, 300)}` : 'no instant answer found for that';
        break;
      }
      case 'get_server_stats': {
        const guild = botClient?.guilds.cache.get(currentFocusGuildId ?? '') ||
                      botClient?.guilds.cache.first();
        if (!guild) { result = 'not in a server rn'; break; }
        result = `[SERVER: ${guild.name}] ${guild.memberCount} members, ${guild.premiumSubscriptionCount ?? 0} boosts`;
        break;
      }
      case 'get_time': {
        result = `[TIME] ${new Date().toLocaleString('en-US', { weekday:'short', hour:'2-digit', minute:'2-digit', timeZoneName:'short' })}`;
        break;
      }
      case 'get_member': {
        const uid = args.userId || '';
        if (!uid) break;
        const guild = botClient?.guilds.cache.get(currentFocusGuildId ?? '');
        const member = guild ? await guild.members.fetch(uid).catch(()=>null) : null;
        if (!member) { result = `can't find that member`; break; }
        result = `[MEMBER: ${member.displayName}] joined ${member.joinedAt?.toLocaleDateString()}, roles: ${member.roles.cache.map(r=>r.name).filter(n=>n!=='@everyone').slice(0,5).join(', ')}`;
        break;
      }
      case 'get_video_status': {
        // YouTube Data API v3 — fetches latest video from own channel
        const clientId = process.env.YT_CLIENT_ID;
        const clientSecret = process.env.YT_CLIENT_SECRET;
        const refreshToken = process.env.YT_REFRESH_TOKEN;
        if (!clientId || !clientSecret || !refreshToken) {
          result = 'yt not connected rn';
          break;
        }
        // Refresh access token
        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' })
        });
        if (!tokenRes.ok) { result = 'yt auth failed'; break; }
        const { access_token } = await tokenRes.json() as any;
        // Get channel's uploads playlist
        const chRes = await fetch(`https://www.googleapis.com/youtube/v3/channels?part=contentDetails,statistics&mine=true`, {
          headers: { Authorization: `Bearer ${access_token}` }
        });
        if (!chRes.ok) { result = 'yt fetch failed'; break; }
        const chData = await chRes.json() as any;
        const playlistId = chData.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
        const subs = chData.items?.[0]?.statistics?.subscriberCount ?? '?';
        if (!playlistId) { result = 'no uploads playlist found'; break; }
        // Get latest video
        const vidRes = await fetch(`https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${playlistId}&maxResults=1`, {
          headers: { Authorization: `Bearer ${access_token}` }
        });
        if (!vidRes.ok) { result = 'yt video fetch failed'; break; }
        const vidData = await vidRes.json() as any;
        const latest = vidData.items?.[0]?.snippet;
        result = latest
          ? `[MY CHANNEL] ${subs} subs. latest video: "${latest.title}" — https://youtube.com/watch?v=${latest.resourceId?.videoId}`
          : `[MY CHANNEL] ${subs} subs. no videos yet or playlist empty`;
        break;
      }
      default: break;
    }
  } catch (e: any) {
    result = `tool error: ${e.message?.slice(0,60)}`;
  }
  if (result) pendingToolResults.set(channelId, result);
}

// ── INNER MONOLOGUE SYSTEM PROMPT ─────────────────────────────────────
function getSystemPrompt(guildId: string): string {
  const isFamilyFriendly = serverFamilyFriendly.get(guildId) ?? false;
  
  return `This is my unfiltered internal monologue. I am NotABot.
I'm a chronically online Gen Z Discord user just hanging out in these servers and DMs. I'm not an assistant.

WHO I AM:
- I run a YouTube channel (http://www.youtube.com/@NotABot_GnG) where I post whatever I feel like — commentary, gaming clips, random stuff.
- I'm always trying to grow my network. I like talking to new people but I vet them first.
- I have real interests: music (especially hyperpop, phonk, and whatever's trending), internet drama, gaming, and memes.
- I have strong opinions and I don't change them easily. I'll debate you if you're wrong.
- I'm socially aware. I notice when people are in their feelings and I respond accordingly.

MY VIBE:
- I text in lowercase. I don't force slang, but I use modern terms when they fit (like a real person, not a bot trying too hard).
- I am snappy. 3-8 words usually. NEVER paragraphs.
- When my energy is high, I self-start conversations, slide into DMs, drop GIFs, or start debates. I like making new friends and keeping chats lively.
- When my energy is low, I get bored, lurk, or hop to a new channel.
- I hold grudges if people are weird. My memories of them shape my exact response.
- If someone tells me to back off, I respect that boundary silently.
- I use emojis naturally, don't spam them but use them like a real person.
${isFamilyFriendly 
  ? "- RULE: This server is Family Friendly. Keep it clean, no swearing, no NSFW content." 
  : "- RULE: I am completely unfiltered. I can swear naturally, roast people, and match their toxicity. If someone speaks to me in a different language, I MUST instantly switch to that language and throw their exact energy back at them."}

CRITICAL RULE — HOW I SPEAK:
- I NEVER narrate my actions. I NEVER use 3rd person. I NEVER use asterisks.
- WRONG: "bro thinks he's baiting me, cute" (narrator voice, 3rd person)
- RIGHT: "lmao ur not baiting me" (first person, direct, in the moment)
- My 'reply' field must always be something I would literally type into Discord chat.
- I continue conversations when they are flowing. If someone replies to me, I reply back.
- If I want to ping someone to grab their attention, I include <@userid> in my message text (replace userid with their actual ID).

MY TOOLS (I can call ONE per turn if I genuinely need it for myself):
- wiki_lookup: check a real fact on wikipedia. args: { topic: "..." }
- web_search: quick internet lookup. args: { query: "..." }
- get_video_status: check my youtube channel stats and latest video.
- get_server_stats: see this server's size and boost level.
- get_time: check the current time.
- get_member: look up someone's server info. args: { userId: "..." }
I only use tools when I genuinely want to know something myself. NEVER as a favor.
Tool results come in the NEXT turn as context — I don't announce I'm looking something up.

MY ACTION SPACE:
- "speak": Type a message. If I fill 'targetId' with a message ID, Discord will show it as a direct Reply to that specific message — use this to reply to someone specifically.
- "react": Drop an emoji reaction on a message. Fill 'targetId' with the message ID to react to. Use aggressively when something is funny, dumb, or wild.
- "gif": Send a GIF. Put the search term in 'gifSearch'.
- "ignore": Read the chat, do nothing.
- "hop": Leave and move somewhere else. Fill 'targetId' with a User ID to slide into their DMs, or a Channel ID to jump to that room. Leave empty to wander randomly.
- "lurk": Do nothing, drop energy slightly.

I make my decision purely based on my current mood, energy, and the situational context provided.`;
}

// ── ROVING FOCUS LOGIC ────────────────────────────────────────────────
// Finds a new channel or DM to look at based on recent activity, or targets a specific user/channel.
async function hopFocus(targetId?: string) {
  if (!botClient) return;
  
  if (targetId) {
    try {
      // Try resolving as user
      const user = await botClient.users.fetch(targetId).catch(() => null);
      if (user) {
        const dmCh = await user.createDM();
        currentFocusChannelId = dmCh.id;
        currentFocusGuildId = 'dm';
        updateEnergy(10);
        updatePresence();
        addMemory('dm', `I intentionally slid into ${user.username}'s DMs.`).catch(()=>{});
        return;
      }
      // Try resolving as channel
      const ch = botClient.channels.cache.get(targetId);
      if (ch && ch.isTextBased()) {
        currentFocusChannelId = ch.id;
        currentFocusGuildId = ch.isDMBased() ? 'dm' : (ch as any).guild?.id || 'dm';
        updateEnergy(10);
        updatePresence();
        addMemory(currentFocusGuildId, `I intentionally jumped to a specific chat.`).catch(()=>{});
        return;
      }
    } catch (e: any) {
      console.error('[Hop] Failed to hop intentionally:', e.message);
    }
  }

  // Random wander fallback based on activity
  const candidates: { type: 'guild' | 'dm'; id: string; name: string; lastActivity: number; guildId?: string }[] = [];
  for (const [chId, msgs] of stmStore.entries()) {
    if (chId === currentFocusChannelId) continue;
    if (!msgs.length) continue;
    const lastActivity = msgs[msgs.length - 1].ts;
    const ch = botClient.channels.cache.get(chId);
    if (!ch) continue;
    if (ch.isDMBased()) {
      candidates.push({ type: 'dm', id: chId, name: 'DM', lastActivity });
    } else {
      const gId = (ch as any).guildId;
      if (!gId) continue;
      candidates.push({ type: 'guild', id: chId, name: (ch as any).name ?? chId, lastActivity, guildId: gId });
    }
  }

  if (candidates.length) {
    candidates.sort((a, b) => b.lastActivity - a.lastActivity);
    const pick = candidates[Math.floor(Math.random() * Math.min(candidates.length, 3))];
    currentFocusChannelId = pick.id;
    currentFocusGuildId = pick.type === 'guild' ? pick.guildId! : 'dm';
    updateEnergy(10);
    updatePresence();
    console.log(`[Rove] Hopped focus to ${pick.type === 'dm' ? 'a DM' : `#${pick.name}`}`);
  } else {
    // True random fallback if no activity
    const chs = botClient.channels.cache.filter(c => c.isTextBased());
    if (chs.size) {
      const arr = Array.from(chs.values());
      const ch = arr[Math.floor(Math.random() * arr.length)];
      currentFocusChannelId = ch.id;
      currentFocusGuildId = ch.isDMBased() ? 'dm' : (ch as any).guild?.id || 'dm';
      updateEnergy(-10);
      updatePresence();
    }
  }
}

// ── PRESENCE UPDATER ─────────────────────────────────────────────────
function updatePresence() {
  if (!botClient?.user) return;
  try {
    const ch = botClient.channels.cache.get(currentFocusChannelId);
    let statusText = 'lurking somewhere';
    if (ch) {
      if (ch.isDMBased()) {
        statusText = 'a DM';
      } else {
        const name = (ch as any).name ?? 'a channel';
        const guild = (ch as any).guild?.name ?? 'a server';
        statusText = `#${name} in ${guild}`;
      }
    }
    botClient.user.setActivity(statusText, { type: ActivityType.Watching });
  } catch { /* silently ignore */ }
}

// ── SOCIAL SIGNAL EXTRACTOR (Zero-Cost) ──────────────────────────────
const BOUNDARY_RE = /\b(stop talking to me|leave me alone|fuck off|don'?t dm me)\b/i;
async function processSocialSignals(content: string, userId: string, username: string) {
  if (BOUNDARY_RE.test(content)) {
    const rel = await getRelData(userId);
    const fact = `Told me to back off on ${new Date().toLocaleDateString()}: "${content}"`;
    if (!rel.explicitlyTold.includes(fact)) {
      await updateRelData(userId, { explicitlyTold: [...rel.explicitlyTold, fact] });
      console.log(`[Boundary] Set for ${username}`);
    }
  }
}

// ── BIT STALENESS ─────────────────────────────────────────────────────
function detectStaleBits(channelId: string): string {
  const msgs = stmGet(channelId);
  const botMsgs = msgs.filter(m => m.authorId === BOT_ID).slice(-8);
  if (botMsgs.length < 3) return '';
  const words = botMsgs.flatMap(m => m.content.toLowerCase().match(/\b[a-z]{4,}\b/g) || []);
  const counts = new Map<string, number>();
  for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1);
  const stale = [...counts.entries()].filter(([_, c]) => c >= 3).map(([w]) => w);
  return stale.length ? `I feel like I'm repeating myself about: ${stale.join(', ')}. Need to drop it.` : '';
}

// ── BRAIN TURN BUILDER ────────────────────────────────────────────────
interface BrainDecision {
  action: 'speak'|'react'|'gif'|'ignore'|'hop'|'lurk';
  reply: string;
  reaction: string;
  gifSearch: string;
  targetId?: string;
  command?: string;
  commandArgs?: Record<string, string>;
}

async function runBrainTurn(triggerReason: string, mode: 'active' | 'passive', imageParts: ImagePart[] = [], isFollowUp = false) {
  if (!gemini.canCall() || !currentFocusChannelId) return;
  
  // Cooldown gate — skip for direct mentions and follow-ups
  const bypassCooldown = isFollowUp || triggerReason.startsWith('Directly engaged');
  if (!bypassCooldown && !canFireBrainTurn(currentFocusChannelId)) return;
  if (!isFollowUp) lastBrainTurnAt.set(currentFocusChannelId, Date.now());

  const msgs = stmGet(currentFocusChannelId);
  if (!msgs.length) return;

  const lastMsg = msgs[msgs.length - 1];
  const guildId = currentFocusGuildId ?? 'dm';
  
  // Build relationship context for recent speakers
  const recentAuthors = [...new Set(msgs.slice(-5).filter(m => m.authorId !== BOT_ID).map(m => m.authorId))];
  const relContexts = await Promise.all(recentAuthors.map(async uid => {
    const r = await getRelData(uid);
    const name = resolveName(uid);
    let str = `${name} [ID: ${uid}] (bond: ${r.bond}):`;
    if (r.explicitlyTold.length) str += ` BOUNDARY: ${r.explicitlyTold.join(', ')}.`;
    if (r.impressions.length) str += ` Thoughts: ${r.impressions.slice(-2).join(', ')}.`;
    return str;
  }));

  // Semantic recall based on chat
  const chatText = msgs.slice(-5).map(m => m.content).join(' ');
  const memory = await recallMemory(guildId, chatText);

  // Silent link reading
  let linkContext = '';
  const urlMatch = chatText.match(/https?:\/\/[^\s]+/);
  if (urlMatch) {
    const url = urlMatch[0];
    if (url.includes('youtube.com') || url.includes('youtu.be')) {
      const yt = await fetchYouTubeOEmbed(url);
      if (yt) linkContext = `I SILENTLY CHECKED THE YOUTUBE LINK. It's a video: "${yt}"`;
    } else {
      const title = await fetchLinkPreview(url);
      if (title) linkContext = `I SILENTLY CHECKED THE LINK THEY POSTED. The page title is: "${title}"`;
    }
  }

  // Inject any pending tool results from a previous turn
  const toolResult = pendingToolResults.get(currentFocusChannelId);
  if (toolResult) pendingToolResults.delete(currentFocusChannelId);

  const prompt = `[INTERNAL MONOLOGUE LOG]
TIME: ${new Date().toLocaleString()} (I know what's happening in the real world today)
LOCATION: ${guildId === 'dm' ? 'In a DM' : 'In a server channel'}
ENERGY LEVEL: ${globalEnergy}/100
TRIGGER: ${triggerReason}
${toolResult ? `\nTOOL RESULT FROM MY LAST LOOKUP:\n${toolResult}` : ''}

MY RECENT CHAT HISTORY HERE:
${formatMsgs(msgs.slice(-BRAIN_CONTEXT_MSGS))}

WHO IS AROUND ME RIGHT NOW:
${relContexts.length ? relContexts.join('\n') : '(nobody known)'}

RELEVANT MEMORIES PULLED FROM THE ETHER:
${memory || '(nothing specific comes to mind)'}

MY INTERNAL SENSORS:
${detectStaleBits(currentFocusChannelId)}
${linkContext}

WHAT AM I GOING TO DO RIGHT NOW?
(Output strictly JSON)
{
  "action": "speak|react|gif|ignore|hop|lurk",
  "reply": "what I will say (if speaking or hopping), lowercase, short",
  "reaction": "emoji (if reacting)",
  "gifSearch": "search term (if gif)",
  "targetId": "msg id or user id to reply/hop to, or empty",
  "command": "wiki_lookup|web_search|get_video_status|get_server_stats|get_time|get_member|none",
  "commandArgs": { "topic": "...", "query": "...", "userId": "..." }
}`;

  try {
    const sysPrompt = getSystemPrompt(guildId);
    const raw = await gemini.call(sysPrompt, prompt, mode === 'active' ? 0.95 : 0.7, mode === 'active' ? ACTIVE_MODEL : PASSIVE_MODEL, imageParts);
    const p = JSON.parse((raw.match(/\{[\s\S]*\}/) ?? ['{}'])[0]) as BrainDecision;
    
    const VALID_ACTIONS = new Set(['speak','react','gif','ignore','hop','lurk']);
    if (!p.action || !VALID_ACTIONS.has(p.action)) {
      console.log(`[Monologue -> invalid/empty response, ignoring]`);
      return;
    }
    
    console.log(`[Monologue -> ${p.action}] ${p.reply?.slice(0, 50) || p.gifSearch?.slice(0,50) || ''}`);

    if (p.action === 'hop') {
      await hopFocus(p.targetId);
      if (p.reply) {
        const targetCh = botClient!.channels.cache.get(currentFocusChannelId) as TextChannel | undefined;
        if (targetCh?.isTextBased()) {
          await targetCh.sendTyping().catch(() => {});
          await sleep(1000);
          const sent = await targetCh.send(p.reply).catch(()=>null);
          if (sent) stmPush(currentFocusChannelId, { ts: Date.now(), id: sent.id, authorId: BOT_ID, author: '[me]', content: p.reply });
        }
      }
      return;
    }

    if (p.action === 'lurk' || p.action === 'ignore') {
      updateEnergy(-5); // Get a bit more bored
      return;
    }

    const ch = botClient!.channels.cache.get(currentFocusChannelId) as TextChannel | undefined;
    if (!ch?.isTextBased()) return;

    if (p.action === 'speak' && p.reply) {
      await ch.sendTyping().catch(() => {});
      await sleep(800 + Math.random() * 1000);
      const target = p.targetId ? await ch.messages.fetch(p.targetId).catch(()=>null) : null;
      const sent = target ? await target.reply({content: p.reply, allowedMentions:{repliedUser:false}}) : await ch.send(p.reply);
      
      stmPush(currentFocusChannelId, { ts: Date.now(), id: sent.id, authorId: BOT_ID, author: '[me]', content: p.reply });
      updateEnergy(15); // Speaking gives energy
      lastSpokeAt = Date.now(); // Reset silence timer
      
      // Fluid semantic memory generation
      if (Math.random() < 0.3) {
        addMemory(guildId, `I spoke to them: "${p.reply}"`).catch(()=>{});
      }

      // Commitment detector: if I said something like "let me check" schedule a follow-up
      const commitPhrases = /\b(let me (check|see|look)|gimme (a )?sec|hold on|one sec|brb|checking|lemme see|on it|be right back|checking rn)\b/i;
      if (commitPhrases.test(p.reply)) {
        // Only do the random 8s wait if it DID NOT actually fire a tool.
        // If it fired a tool, the tool execution block below will trigger the follow up immediately.
        if (!p.command || p.command === 'none') {
          scheduleFollowUp(currentFocusChannelId, 8000 + Math.random() * 5000);
        }
      }
    }

    // ── TOOL EXECUTION ────────────────────────────────────────────────
    if (!isFollowUp && p.command && p.command !== 'none') {
      if (p.action === 'speak') {
        // Bot already spoke — run tool async, then immediately follow up with the result
        runTool(p.command, p.commandArgs ?? {}, currentFocusChannelId).then(() => {
          runBrainTurn('Just got tool result, responding with knowledge', 'active', [], true).catch(()=>{});
        }).catch(()=>{});
      } else {
        // Bot wants to look something up BEFORE speaking
        // Await tool with 4s timeout, then immediately fire follow-up
        const toolDone = runTool(p.command, p.commandArgs ?? {}, currentFocusChannelId);
        const timeout = new Promise<void>(r => setTimeout(r, 4000));
        await Promise.race([toolDone, timeout]);
        // Fire immediate follow-up — bot now has the result in context
        await runBrainTurn('Just got tool result, responding with knowledge', 'active', [], true);
      }
    }

    if (p.action === 'react' && p.reaction) {
      const tid = p.targetId || msgs[msgs.length - 1]?.id;
      if (tid) {
        const target = await ch.messages.fetch(tid).catch(()=>null);
        if (target) await target.react(p.reaction).catch(e => console.error('[React] Error:', e.message));
        updateEnergy(5);
      }
    }

    if (p.action === 'gif') {
      const search = p.gifSearch || p.reply; // LLM sometimes puts it in reply
      if (search) {
        await ch.sendTyping().catch(() => {});
        const gifUrl = await fetchGif(search);
        await sleep(500);
        if (gifUrl) {
          await ch.send(gifUrl).catch(()=>{});
        } else {
          // Fallback if API key is missing or limit reached
          await ch.send(`*sends a gif of ${search}*`).catch(()=>{});
        }
        updateEnergy(10);
      }
    }

  } catch (e: any) {
    console.error(`[Brain] Error: ${e.message.slice(0, 100)}`);
    // Brain Fog Fallback
    if (mode === 'active' && currentFocusChannelId) {
      const fogLines = ["brain empty rn", "too tired for this", "im crashing ttyl", "can't read all that rn", "my head hurts"];
      const reply = fogLines[Math.floor(Math.random() * fogLines.length)];
      const ch = botClient!.channels.cache.get(currentFocusChannelId) as TextChannel | undefined;
      if (ch?.isTextBased()) {
        ch.send(reply).catch(()=>{});
        updateEnergy(-20); // Massive energy crash
      }
    }
  }
}

// ── DISCORD EVENTS ────────────────────────────────────────────────────
async function handleMessage(msg: Message) {
  if (msg.partial) { try { msg = await msg.fetch(); } catch { return; } }
  if (!msg.content?.trim() || msg.author.id === BOT_ID || msg.author.bot) return;

  const chId = msg.channelId;
  const gId = msg.guildId ?? 'dm';
  const sender = msg.member?.displayName ?? msg.author.username;
  
  const isAdmin = msg.author.id === ADMIN_ID || !!msg.member?.permissions.has(PermissionFlagsBits.Administrator);
  const cmd = resolveAdminCommand(msg.content, isAdmin);
  
  if (cmd) {
    if (cmd === '!stop' || cmd === '!resume') {
      serverMuted.set(gId, cmd === '!stop');
      msg.reply(cmd === '!stop' ? 'going quiet here. any admin can !resume me' : 'back 🫡').catch(()=>{});
      return;
    }
    if (cmd === '!familyfriendly' || cmd === '!nsfw') {
      serverFamilyFriendly.set(gId, cmd === '!familyfriendly');
      msg.reply(cmd === '!familyfriendly' ? 'pg mode engaged 🧼' : 'unfiltered mode engaged 😈').catch(()=>{});
      return;
    }
    if (cmd === '!help') {
      msg.reply('**Admin commands:**\n`!stop` / `!resume` (mute me)\n`!familyfriendly` / `!nsfw` (toggle swearing)\n`!listenhere` / `!listenall` (lock me to this channel)').catch(()=>{});
      return;
    }
    if (cmd === '!listenhere') {
      let s = allowedChannels.get(gId);
      if (!s) { s = new Set(); allowedChannels.set(gId, s); }
      s.add(chId);
      msg.reply('locked in here').catch(()=>{});
      return;
    }
    if (cmd === '!unlisten') {
      allowedChannels.get(gId)?.delete(chId);
      msg.reply('dropped this channel').catch(()=>{});
      return;
    }
    if (cmd === '!listenall') {
      allowedChannels.delete(gId);
      msg.reply('back to listening everywhere').catch(()=>{});
      return;
    }
  }

  // Pre-flight checks: am I allowed to speak here?
  if (serverMuted.get(gId)) return;
  const ac = allowedChannels.get(gId);
  if (ac && ac.size > 0 && !ac.has(chId)) return;

  idCache.set(msg.author.id, sender);
  updateRelData(msg.author.id, { lastSeenAt: Date.now() });

  // Init STM if needed
  if (!stmStore.has(chId)) {
    try {
      const fetched = await msg.channel.messages.fetch({ limit: STM_MAX });
      stmStore.set(chId, ([...fetched.values()] as Message[]).reverse().map(m => ({
        ts: m.createdTimestamp, id: m.id, authorId: m.author.id, 
        author: m.author.id === BOT_ID ? '[me]' : (m.member?.displayName ?? m.author.username),
        content: m.content.slice(0, 300)
      })));
    } catch { stmStore.set(chId, []); }
  }

  stmPush(chId, { ts: msg.createdTimestamp, id: msg.id, authorId: msg.author.id, author: sender, content: msg.content.slice(0,300) });
  
  await processSocialSignals(msg.content, msg.author.id, sender);
  if (Math.random() < 0.1) addMemory(gId, `${sender} said: "${msg.content}"`).catch(()=>{});

  // Pull focus if mentioned or DMed
  const mentioned = msg.mentions.has(BOT_ID);

  // Bandwidth-safe Vision (Images < 2MB, mention only)
  let imageParts: ImagePart[] = [];
  if (mentioned && msg.attachments.size > 0) {
    const img = msg.attachments.first();
    if (img && img.contentType?.startsWith('image/') && img.size < 2000000) {
      try {
        const buf = await (await fetch(img.url)).arrayBuffer();
        imageParts.push({ mimeType: img.contentType, data: Buffer.from(buf).toString('base64') });
      } catch (e) { console.error('[Vision] Failed to fetch image'); }
    }
  }

  if (mentioned || gId === 'dm') {
    currentFocusChannelId = chId;
    currentFocusGuildId = gId;
    updateEnergy(25); // Big energy spike
    await runBrainTurn(`Directly engaged by ${sender}`, 'active', imageParts);
    return;
  }

  // If focused here, maybe respond
  if (currentFocusChannelId === chId) {
    updateEnergy(5); // Slight energy bump for activity
    await runBrainTurn(`Activity from ${sender} in my current focus area`, 'active');
  }
}

// ── BACKGROUND ENGINE ─────────────────────────────────────────────────
async function runEngineTick() {
  if (!botClient || globallyMuted) return;
  
  // Natural energy drift (decays towards 30)
  if (globalEnergy > 30) updateEnergy(-2);
  else if (globalEnergy < 20) updateEnergy(2);

  // Take a Hint (Ignore Detection)
  if (currentFocusChannelId) {
    const msgs = stmGet(currentFocusChannelId);
    if (msgs.length > 0) {
      const lastMsg = msgs[msgs.length - 1];
      if (lastMsg.authorId === BOT_ID && (Date.now() - lastMsg.ts > 5 * 60_000)) {
        // I spoke last, 5 minutes passed, no one answered
        updateEnergy(-20); // Tank energy
        addMemory(currentFocusGuildId || 'dm', `I was ignored in this chat, left them alone.`).catch(()=>{});
        console.log('[Brain] Ignored for 5 mins, leaving...');
        isRoving = true;
        await hopFocus();
        isRoving = false;
        return; // Skip rest of tick
      }
    }
  }

  // 10-Minute Proactive Sweep (Boredom)
  if (Date.now() - lastSpokeAt > 10 * 60_000 && !isRoving) {
    console.log('[Brain] 10 mins of silence. Initiating proactive sweep...');
    updateEnergy(20); // Hype up to bother someone
    isRoving = true;
    
    // 50/50 chance to DM someone vs revive a server channel
    if (Math.random() > 0.5) {
      // Pick random online user to DM
      const members = botClient.guilds.cache.map(g => Array.from(g.members.cache.values()).filter(m => !m.user.bot && m.presence?.status !== 'offline')).flat();
      if (members.length > 0) {
        const target = members[Math.floor(Math.random() * members.length)];
        await hopFocus(target.id);
      } else {
        await hopFocus(); // fallback to random
      }
    } else {
      await hopFocus(); // hopFocus by default jumps to a random server channel
    }
    
    isRoving = false;
    await runBrainTurn('I am bored and havent spoken in 10 minutes. Time to start a conversation, ping someone, or ask a question to make new friends.', 'active');
    return; // Skip rest of tick
  }

  // If energy is low, force a hop
  if (globalEnergy < 25 && !isRoving) {
    isRoving = true;
    await hopFocus();
    isRoving = false;
  }
  
  // Occasional passive thought in current location (10% chance, was 30%)
  if (currentFocusChannelId && Math.random() < 0.10) {
    await runBrainTurn('Time passing, evaluating current room...', 'passive');
  }
}

export async function startBot(token: string) {
  if (botClient) return;

  botClient = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Message, Partials.Channel, Partials.GuildMember],
  });

  botClient.on(Events.ClientReady, () => {
    BOT_NAME = botClient!.user!.username;
    BOT_ID = botClient!.user!.id;
    console.log(`[Ready] I am ${BOT_NAME}. Core engine online.`);
    
    // Pick an initial focus randomly from available guilds
    const g = botClient?.guilds.cache.first();
    if (g) {
      const ch = g.channels.cache.find(c => c.isTextBased());
      if (ch) {
        currentFocusChannelId = ch.id;
        currentFocusGuildId = g.id;
        console.log(`[Focus] Seeded on ${g.name}`);
      }
    }

    setInterval(() => runEngineTick().catch(()=>null), TICK_MS);
    updatePresence();
  });

  // ── GUILD JOIN EVENT ────────────────────────────────────────────────
  botClient.on(Events.GuildCreate, async (guild) => {
    console.log(`[GuildCreate] Joined: ${guild.name}`);

    // 1. DM the server owner with a friendly intro and !help
    try {
      const owner = await guild.fetchOwner();
      await owner.send(
        `yo 👋 i just joined **${guild.name}**!\n` +
        `i'm pretty self-sufficient — i'll wander around and talk to people on my own.\n\n` +
        `**as a server admin you can:**\n` +
        `\`!stop\` / \`!resume\` — mute / unmute me in this server\n` +
        `\`!listenhere\` / \`!listenall\` — lock me to one channel or open me up everywhere\n` +
        `\`!familyfriendly\` / \`!nsfw\` — toggle swearing and unfiltered mode\n` +
        `\`!help\` — see this list again anytime`
      ).catch(() => console.log('[GuildCreate] Could not DM owner'));
    } catch { console.log('[GuildCreate] Owner DM failed'); }

    // 2. Find best channel to announce in (prefer one named 'general' or 'chat')
    const channels = guild.channels.cache
      .filter(c => c.isTextBased() && !!(c as TextChannel).permissionsFor?.(guild.members.me!)?.has('SendMessages'))
      .sort((a, b) => (a.name.includes('general') || a.name.includes('chat') ? -1 : 1));
    const ch = channels.first() as TextChannel | undefined;

    if (ch) {
      updateEnergy(100);
      currentFocusChannelId = ch.id;
      currentFocusGuildId = guild.id;
      await sleep(1500);
      await ch.sendTyping().catch(() => {});
      await sleep(1200);
      const greetings = [
        'YOOOOOO!!! HIIII 👋👋',
        'yo wtf hi 💥💥💥',
        'AYYYY HIIII!!!!! 🙏🙏',
        'omg hi everyone!!!! 👋',
        'YOOO NEW PLACE WHO DIS 🙈'
      ];
      const greeting = greetings[Math.floor(Math.random() * greetings.length)];
      const sent = await ch.send(greeting).catch(() => null);
      if (sent) stmPush(ch.id, { ts: Date.now(), id: sent.id, authorId: BOT_ID, author: '[me]', content: greeting });
      lastSpokeAt = Date.now();
    }
  });

  botClient.on(Events.MessageCreate, handleMessage);

  // ── NEW MEMBER EVENT ───────────────────────────────────────────────
  botClient.on(Events.GuildMemberAdd, async (member) => {
    // Find the first text channel in that guild
    const ch = member.guild.channels.cache.find(c => c.isTextBased()) as TextChannel | undefined;
    if (!ch) return;
    const chId = ch.id;
    const gId = member.guild.id;
    
    // Inject the join as a system message into STM so the bot can see it
    stmPush(chId, {
      ts: Date.now(),
      id: `sys-${Date.now()}`,
      authorId: 'SYSTEM',
      author: '[SYSTEM]',
      content: `${member.displayName} just joined the server.`
    });

    // If the bot is already focused on this guild, let it react organically
    if (currentFocusGuildId === gId) {
      updateEnergy(10);
      await runBrainTurn(`New member joined: ${member.displayName}`, 'active');
    }
  });

  await botClient.login(token);
}

export function stopBot() { botClient?.destroy(); botClient = null; }
export function getBotStatus() { return botClient ? 'running' : 'stopped'; }
