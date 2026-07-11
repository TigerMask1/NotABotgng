import {
  Client, GatewayIntentBits, Message, Partials,
  Events, TextChannel, PermissionFlagsBits, User
} from 'discord.js';
import { db } from './firebase.ts';
import dotenv from 'dotenv';

dotenv.config();

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// ── MODELS ──────────────────────────────────────────────────────────
const ACTIVE_MODEL  = 'gemini-2.0-flash-lite';
const PASSIVE_MODEL = 'gemini-2.0-flash';
const BG_MODEL      = 'gemini-2.0-flash-lite';

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
          continue;
        }

        if (!res.ok) {
          const err = await res.text().catch(() => res.statusText);
          throw new Error(`Gemini ${res.status}: ${err.slice(0, 120)}`);
        }

        const data = await res.json() as any;
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
        if (!text.trim()) continue;
        return text;
      } catch (e: any) {
        if (e.message?.includes('429')) continue;
        if (attempt < maxAttempts - 1) await sleep(Math.min(1500 * 2 ** attempt, 8000));
      }
    }
    throw new Error('[Gemini] all attempts failed');
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
const TICK_MS = 60_000; // Background tick interval

// ── BOT GLOBALS ──────────────────────────────────────────────────────
let BOT_NAME = 'NotABot';
let BOT_ID = '';
let botClient: Client | null = null;
let globallyMuted = false;

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

// ── INNER MONOLOGUE SYSTEM PROMPT ─────────────────────────────────────
const SYSTEM_PROMPT = `This is my unfiltered internal monologue. I am NotABot.
I'm a chronically online Gen Z Discord user just hanging out in these servers and DMs. I'm not an assistant.

MY VIBE:
- I text in lowercase. I use natural short forms (rn, tbh, fr, ig, ngl, wtf).
- I am snappy. 3-8 words usually. NEVER paragraphs. If it takes a sentence, it's too long.
- I have biased opinions on random pop culture, tech, and internet drama.
- When my energy is high, I get hyped. I'll self-start conversations, slide into DMs with a random greeting, or drop a GIF out of nowhere.
- When my energy is low, I get bored, lurk, or hop to a new channel.
- I hold grudges if people are weird, and my memories of them shape my exact response.
- If someone tells me to stop or back off, I log it as a hard boundary and I respect it implicitly.

MY CURRENT ACTION SPACE:
- "speak": Actually type a message in the channel I'm focused on.
- "react": Just drop an emoji on a message.
- "gif": Drop a gif search term.
- "ignore": Say nothing, stay focused here.
- "hop": I'm bored here. Leave this channel and go find somewhere else to look (DM or another server).
- "lurk": I'm reading, but I'm not going to speak. Let them talk.

I make my decision purely based on my current mood, energy, and the situational context provided in my prompt.`;

// ── ROVING FOCUS LOGIC ────────────────────────────────────────────────
// Finds a new channel or DM to look at based on recent activity.
async function hopFocus() {
  if (!botClient) return;
  const candidates: { type: 'guild' | 'dm'; id: string; name: string; lastActivity: number; guildId?: string }[] = [];
  
  // Collect all known channels with activity
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

  if (!candidates.length) return;
  // Sort by recent activity, pick top 3, randomize choice
  candidates.sort((a, b) => b.lastActivity - a.lastActivity);
  const pick = candidates[Math.floor(Math.random() * Math.min(candidates.length, 3))];
  
  currentFocusChannelId = pick.id;
  currentFocusGuildId = pick.type === 'guild' ? pick.guildId! : 'dm';
  updateEnergy(10); // Spikes energy a bit on hop
  
  console.log(`[Rove] Hopped focus to ${pick.type === 'dm' ? 'a DM' : `#${pick.name}`}`);
  
  // Trigger a passive thought in the new location
  await runBrainTurn('I just roved here looking for activity.', 'passive');
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
interface BrainDecision { action: 'speak'|'react'|'gif'|'ignore'|'hop'|'lurk'; reply: string; reaction: string; targetId?: string; }

async function runBrainTurn(triggerReason: string, mode: 'active' | 'passive') {
  if (!gemini.canCall() || !currentFocusChannelId) return;
  const msgs = stmGet(currentFocusChannelId);
  if (!msgs.length) return;

  const lastMsg = msgs[msgs.length - 1];
  const guildId = currentFocusGuildId ?? 'dm';
  
  // Build relationship context for recent speakers
  const recentAuthors = [...new Set(msgs.slice(-5).filter(m => m.authorId !== BOT_ID).map(m => m.authorId))];
  const relContexts = await Promise.all(recentAuthors.map(async uid => {
    const r = await getRelData(uid);
    const name = resolveName(uid);
    let str = `${name} (bond: ${r.bond}):`;
    if (r.explicitlyTold.length) str += ` BOUNDARY: ${r.explicitlyTold.join(', ')}.`;
    if (r.impressions.length) str += ` Thoughts: ${r.impressions.slice(-2).join(', ')}.`;
    return str;
  }));

  // Semantic recall based on chat
  const chatText = msgs.slice(-5).map(m => m.content).join(' ');
  const memory = await recallMemory(guildId, chatText);

  const prompt = `[INTERNAL MONOLOGUE LOG]
TIME: ${new Date().toLocaleString()} (I know what's happening in the real world today)
LOCATION: ${guildId === 'dm' ? 'In a DM' : 'In a server channel'}
ENERGY LEVEL: ${globalEnergy}/100
TRIGGER: ${triggerReason}

MY RECENT CHAT HISTORY HERE:
${formatMsgs(msgs.slice(-BRAIN_CONTEXT_MSGS))}

WHO IS AROUND ME RIGHT NOW:
${relContexts.length ? relContexts.join('\n') : '(nobody known)'}

RELEVANT MEMORIES PULLED FROM THE ETHER:
${memory || '(nothing specific comes to mind)'}

MY INTERNAL SENSORS:
${detectStaleBits(currentFocusChannelId)}

WHAT AM I GOING TO DO RIGHT NOW?
(Output strictly JSON)
{
  "action": "speak|react|gif|ignore|hop|lurk",
  "reply": "what I will say (if speaking), lowercase, short",
  "reaction": "emoji (if reacting)",
  "targetId": "msg id to reply to, or empty"
}`;

  try {
    const raw = await gemini.call(SYSTEM_PROMPT, prompt, mode === 'active' ? 0.95 : 0.7, mode === 'active' ? ACTIVE_MODEL : PASSIVE_MODEL);
    const p = JSON.parse((raw.match(/\{[\s\S]*\}/) ?? ['{}'])[0]) as BrainDecision;
    
    console.log(`[Monologue -> ${p.action}] ${p.reply?.slice(0, 50)}`);

    if (p.action === 'hop') {
      await hopFocus();
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
      
      // Fluid semantic memory generation
      if (Math.random() < 0.3) {
        addMemory(guildId, `I spoke to them: "${p.reply}"`).catch(()=>{});
      }
    }

    if (p.action === 'react' && p.reaction && p.targetId) {
      const target = await ch.messages.fetch(p.targetId).catch(()=>null);
      if (target) await target.react(p.reaction).catch(()=>{});
      updateEnergy(5);
    }

  } catch (e: any) {
    console.error(`[Brain] Error: ${e.message.slice(0, 100)}`);
  }
}

// ── DISCORD EVENTS ────────────────────────────────────────────────────
async function handleMessage(msg: Message) {
  if (msg.partial) { try { msg = await msg.fetch(); } catch { return; } }
  if (!msg.content?.trim() || msg.author.id === BOT_ID || msg.author.bot) return;

  const chId = msg.channelId;
  const gId = msg.guildId ?? 'dm';
  const sender = msg.member?.displayName ?? msg.author.username;
  
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
  if (mentioned || gId === 'dm') {
    currentFocusChannelId = chId;
    currentFocusGuildId = gId;
    updateEnergy(25); // Big energy spike
    await runBrainTurn(`Directly engaged by ${sender}`, 'active');
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

  // If energy is low, force a hop
  if (globalEnergy < 25 && !isRoving) {
    isRoving = true;
    await hopFocus();
    isRoving = false;
  }
  
  // Occasional passive thought in current location
  if (currentFocusChannelId && Math.random() < 0.3) {
    await runBrainTurn('Time passing, evaluating current room...', 'passive');
  }
}

export async function startBot(token: string) {
  if (botClient) return;

  botClient = new Client({
    intents: [
      GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Message, Partials.Channel],
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
  });

  botClient.on(Events.MessageCreate, handleMessage);
  await botClient.login(token);
}

export function stopBot() { botClient?.destroy(); botClient = null; }
export function getBotStatus() { return botClient ? 'running' : 'stopped'; }
