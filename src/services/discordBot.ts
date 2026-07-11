import {
  Client, GatewayIntentBits, Message, Partials,
  Events, TextChannel, PermissionFlagsBits,
} from 'discord.js';
import { db } from './firebase.ts';
import dotenv from 'dotenv';

dotenv.config();

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// ── MODELS ──────────────────────────────────────────────────────────
// active: every msg while engaged — fast, cheap, snappy
// passive: 5-min scan + events + proactive — bigger context, thinks more
// bg: profiler / summariser / compress utility (never blocks the convo loop)
const ACTIVE_MODEL  = 'gemini-2.0-flash-lite';
const PASSIVE_MODEL = 'gemini-2.0-flash';
const BG_MODEL      = 'gemini-2.0-flash-lite';

// ── VISION ──────────────────────────────────────────────────────────
interface ImagePart { mimeType: string; data: string; }

// ── GEMINI MANAGER ───────────────────────────────────────────────────
// Round-robin across all keys in GEMINI_API_KEYS (comma-separated).
// 429 → cools that key down for the retry delay the API reports.
// All keys on cooldown → waits for the soonest to recover before retrying
// instead of tight-looping, which was burning the remaining window.
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
    return null; // all on cooldown
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
      // If all keys are cooling down, wait for the soonest to recover
      const key = this.pickKey();
      if (!key) {
        const wait = this.soonestCooldownMs() + 200;
        console.warn(`[Gemini] all keys cooling — waiting ${Math.round(wait / 1000)}s`);
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
          console.warn(`[Gemini] ...${key.slice(-4)} 429 — cd ${Math.round(retryMs / 1000)}s`);
          continue;
        }

        if (!res.ok) {
          const err = await res.text().catch(() => res.statusText);
          throw new Error(`Gemini ${res.status}: ${err.slice(0, 120)}`);
        }

        const data = await res.json() as any;
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
        const finish = data.candidates?.[0]?.finishReason ?? 'unknown';
        if (!text.trim()) {
          console.warn(`[Gemini] ...${key.slice(-4)} empty response (finish=${finish}) — retrying`);
          continue;
        }
        console.log(`[Gemini:${model.slice(-10)}] key=...${key.slice(-4)} | ${text.length}ch | finish=${finish}`);
        return text;
      } catch (e: any) {
        if (e.message?.includes('429')) continue;
        console.error(`[Gemini] attempt ${attempt + 1}: ${e.message?.slice(0, 80)}`);
        if (attempt < maxAttempts - 1) await sleep(Math.min(1500 * 2 ** attempt, 8000));
      }
    }
    throw new Error('[Gemini] all attempts failed');
  }

  canCall(): boolean { return this.keys.length > 0; }
  getKey(): string | null { return this.pickKey(); }
  status(): string {
    const now = Date.now();
    return this.keys.map(k =>
      `...${k.slice(-4)}${(this.cooldowns.get(k) ?? 0) > now
        ? ` (cd ${Math.ceil(((this.cooldowns.get(k) ?? 0) - now) / 1000)}s)` : ''}`
    ).join(' | ');
  }
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

// ── VISION HELPERS ──────────────────────────────────────────────────
const MAX_VISION_IMAGES = 2;
const MAX_IMAGE_BYTES   = 4 * 1024 * 1024;

function extractImageUrls(msg: Message): string[] {
  const urls: string[] = [];
  for (const att of msg.attachments.values())
    if ((att.contentType || '').startsWith('image/')) urls.push(att.url);
  for (const emb of msg.embeds) {
    const u = emb.image?.url || emb.thumbnail?.url;
    if (u && !urls.includes(u)) urls.push(u);
  }
  return urls;
}

async function fetchImage(url: string): Promise<ImagePart | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const mime = (res.headers.get('content-type') || '').split(';')[0].trim();
    if (!mime.startsWith('image/')) return null;
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_IMAGE_BYTES) return null;
    return { mimeType: mime, data: Buffer.from(buf).toString('base64') };
  } catch { return null; }
}

async function collectImages(msgs: Message[]): Promise<ImagePart[]> {
  const urls: string[] = [];
  for (const m of [...msgs].reverse()) {
    for (const u of extractImageUrls(m))
      if (urls.length < MAX_VISION_IMAGES && !urls.includes(u)) urls.push(u);
  }
  const fetched = await Promise.all(urls.map(fetchImage));
  return fetched.filter((p): p is ImagePart => !!p);
}

// ── CONSTANTS ────────────────────────────────────────────────────────
const STM_MAX               = 40;   // raw messages kept per channel
const BRAIN_CONTEXT_MSGS    = 15;   // how many raw msgs sent to brain (rest covered by summary)
const SESSION_SUMMARY_EVERY = 20;   // update rolling summary every N new messages
const DM_DEBOUNCE_MS        = 1000;
const GAP_MAJOR_MS          = 25 * 60_000;
const GAP_MINOR_MS          =  5 * 60_000;
const PASSIVE_TICK_MS       =  5 * 60_000;
const SELF_CHECK_QUIET_MS   =  4 * 60_000;
const ACTIVE_IDLE_REVERT_MS = 25 * 60_000;
const PROFILER_INTERVAL     = 25 * 60_000;
const PAUSE_MAX_MINS        = 30;
const HISTORY_LOG_EVERY     = 30;
const FOCUS_DRIFT_MS        = 12 * 60_000;
const FOCUS_SHIFT_COST      = 45_000;
const PROACTIVE_QUIET_MS    = 35 * 60_000;
const PROACTIVE_MIN_GAP_MS  = 50 * 60_000;
const PROACTIVE_MAX_STRIKES = 3;
const WWT_GLOBAL_QUIET_MS   = 20 * 60_000;
const WWT_SWEEP_INTERVAL_MS =  4 * 60_000;
const WWT_WAIT_MS           =  6 * 60_000;
const WWT_USER_COOLDOWN_MS  =  6 * 60 * 60_000;
const WWT_SCAN_MAX          = 40;
const WWT_CANDIDATE_MAX_AGE = 24 * 60 * 60_000;
const VIDEO_SWEEP_MS        =  3 * 60_000;
const YT_POLL_MS            =  5 * 60_000;
const YT_CLIENT_ID     = process.env.YT_CLIENT_ID     || '';
const YT_CLIENT_SECRET = process.env.YT_CLIENT_SECRET || '';
const YT_REFRESH_TOKEN = process.env.YT_REFRESH_TOKEN || '';

// ── BOT GLOBALS ──────────────────────────────────────────────────────
let BOT_NAME  = 'NotABot';
let BOT_ID    = '';
let botClient: Client | null = null;
let globallyMuted = false;
const ADMIN_ID = process.env.ADMIN_ID || '1296109674361520146';
const serverMuted         = new Map<string, boolean>();
const serverBotAllowlist  = new Map<string, Set<string>>();
const serverChannelAllowlist = new Map<string, Set<string>>();

// ── ID / NAME CACHES ─────────────────────────────────────────────────
const idCache          = new Map<string, string>();
const serverNameCache  = new Map<string, string>();
const channelNameCache = new Map<string, string>();
function cacheId(id: string, name: string)          { if (id && name) idCache.set(id, name); }
function cacheServerName(id: string, name?: string) { if (id && name) serverNameCache.set(id, name); }
function cacheChannelName(id: string, name?: string){ if (id && name) channelNameCache.set(id, name); }

// ── STM (short-term memory) ──────────────────────────────────────────
// Keeps the last STM_MAX raw messages per channel.
// Brain only receives the last BRAIN_CONTEXT_MSGS of them; the rest is covered
// by the rolling session summary that the BG model maintains.
interface STMsg {
  ts:       number;
  id:       string;
  authorId: string;
  author:   string;
  content:  string;
}

const stmStore          = new Map<string, STMsg[]>();
const sessionSummaries  = new Map<string, string>();  // rolling summary for each channel
const sessionMsgCounts  = new Map<string, number>();  // how many msgs since last summary update

function stmGet(channelId: string): STMsg[] { return stmStore.get(channelId) ?? []; }

function stmPush(channelId: string, m: STMsg) {
  if (!stmStore.has(channelId)) stmStore.set(channelId, []);
  const arr = stmStore.get(channelId)!;
  arr.push(m);
  if (arr.length > STM_MAX) arr.shift();
  // track count for summary updates
  sessionMsgCounts.set(channelId, (sessionMsgCounts.get(channelId) ?? 0) + 1);
}

function seedSTM(channelId: string, msgs: Message[]) {
  if (stmStore.has(channelId)) return;
  stmStore.set(channelId, msgs.slice(-STM_MAX).map(m => ({
    ts:       m.createdTimestamp,
    id:       m.id,
    authorId: m.author.id,
    author:   m.author.id === BOT_ID ? '[me]' : (m.member?.displayName || m.author.username),
    content:  cleanContent(m.content).slice(0, 300),
  })));
}

// Formats a slice of STM messages for the brain prompt — compact, timestamped.
function formatMsgs(msgs: STMsg[]): string {
  if (!msgs.length) return '(no messages)';
  const now = Date.now();
  const lines: string[] = [];
  for (let i = 0; i < msgs.length; i++) {
    if (i > 0) {
      const gap = msgs[i].ts - msgs[i - 1].ts;
      if (gap >= GAP_MAJOR_MS) lines.push(`\n── ${Math.round(gap / 60_000)}m later ──\n`);
      else if (gap >= GAP_MINOR_MS) lines.push(`(${Math.round(gap / 60_000)}m gap)`);
    }
    const ago = now - msgs[i].ts;
    const t = ago < 90_000 ? `${Math.round(ago / 1000)}s` : `${Math.round(ago / 60_000)}m`;
    lines.push(`[${t}] (id:${msgs[i].id}) ${msgs[i].author}: ${msgs[i].content}`);
  }
  return lines.join('\n');
}

// ── PROCESSED MARKER ────────────────────────────────────────────────
// Tracks which message the bot has last handled so it knows what's new.
interface ProcessedMarker { markerId: string | null; pendingQuestionId: string | null; }
const processedMarkers = new Map<string, ProcessedMarker>();

function getMarker(ch: string): ProcessedMarker {
  let m = processedMarkers.get(ch);
  if (!m) { m = { markerId: null, pendingQuestionId: null }; processedMarkers.set(ch, m); }
  return m;
}

function setMarker(ch: string, markerId: string | null, pendingQ: string | null = null) {
  processedMarkers.set(ch, { markerId, pendingQuestionId: pendingQ });
}

function formatMsgsWithMarker(msgs: STMsg[], channelId: string): string {
  if (!msgs.length) return '(no messages)';
  const { markerId, pendingQuestionId } = getMarker(channelId);
  const now = Date.now();
  const lines: string[] = [];
  for (let i = 0; i < msgs.length; i++) {
    if (i > 0) {
      const gap = msgs[i].ts - msgs[i - 1].ts;
      if (gap >= GAP_MAJOR_MS) lines.push(`\n── ${Math.round(gap / 60_000)}m later ──\n`);
      else if (gap >= GAP_MINOR_MS) lines.push(`(${Math.round(gap / 60_000)}m gap)`);
    }
    const ago = now - msgs[i].ts;
    const t = ago < 90_000 ? `${Math.round(ago / 1000)}s` : `${Math.round(ago / 60_000)}m`;
    lines.push(`[${t}] (id:${msgs[i].id}) ${msgs[i].author}: ${msgs[i].content}`);
    if (pendingQuestionId && msgs[i].id === pendingQuestionId)
      lines.push('>>> ⚠ unanswered question flagged here — still needs a reply <<<');
    if (markerId && msgs[i].id === markerId)
      lines.push('>>> ── handled up to here — everything below is new ── <<<');
  }
  return lines.join('\n');
}

function advanceMarker(channelId: string, batchIds: string[], decision: BrainDecision) {
  if (!batchIds.length) return;
  if (decision.unansweredMsgId && batchIds.includes(decision.unansweredMsgId)) {
    const idx = batchIds.indexOf(decision.unansweredMsgId);
    setMarker(channelId, idx > 0 ? batchIds[idx - 1] : null, decision.unansweredMsgId);
    return;
  }
  const prev = getMarker(channelId);
  const cleared = prev.pendingQuestionId && decision.replyToMsgId === prev.pendingQuestionId
    ? null : prev.pendingQuestionId;
  setMarker(channelId, batchIds[batchIds.length - 1], cleared);
}

// ── CONVERSATION CLASSIFIER ──────────────────────────────────────────
// Classifies what's happening in the channel BEFORE calling brain().
// Prevents unnecessary API calls and eliminates the most embarrassing behaviors.
type ConvType =
  | 'direct_ping'    // bot was @mentioned → always respond
  | 'bot_dm'         // DM to bot → always respond
  | 'engaged'        // bot is mid-exchange with this person → respond
  | 'pair_private'   // two people talking to each other, bot not involved → stay out
  | 'bot_shut_out'   // someone explicitly told bot to stop → drop to passive
  | 'open_channel';  // general chat → passive scan decides

const SHUT_OUT_RE = /\b(not talking (with|to) (you|u)|i?'?m not talking|dude (i?'?m not|stop|go away)|not asking you|leave (it|me)|ain'?t talking|stop talking to me|stop responding)\b/i;

function classifyConversation(
  msgs: STMsg[],
  botId: string,
  mentioned: boolean,
  isDM: boolean,
  senderId: string,
): ConvType {
  if (isDM) return 'bot_dm';
  if (mentioned) return 'direct_ping';

  const recent = msgs.slice(-8);
  const nonBot = recent.filter(m => m.authorId !== botId);

  // Check if someone shut the bot out in the recent window
  if (nonBot.some(m => SHUT_OUT_RE.test(m.content))) return 'bot_shut_out';

  // Check if bot is in an active exchange with this specific sender
  const lastBotIdx = msgs.map(m => m.authorId).lastIndexOf(botId);
  if (lastBotIdx >= 0) {
    const afterBot = msgs.slice(lastBotIdx + 1).filter(m => m.authorId !== botId);
    const senders = new Set(afterBot.map(m => m.authorId));
    // Bot spoke, exactly one person replied (or the same sender is here now)
    if (senders.size === 1 && (senders.has(senderId) || afterBot.length === 0)) {
      return 'engaged';
    }
  }

  // Check for two-person private exchange that excludes the bot
  if (nonBot.length >= 4) {
    const senderSet = new Set(nonBot.map(m => m.authorId));
    if (senderSet.size === 2) {
      const botMentionInWindow = nonBot.some(m =>
        m.content.includes(botId) ||
        m.content.toLowerCase().includes(BOT_NAME.toLowerCase())
      );
      if (!botMentionInWindow) return 'pair_private';
    }
  }

  return 'open_channel';
}

// ── SOCIAL SIGNAL EXTRACTOR ──────────────────────────────────────────
// Zero-cost (no API call). Runs after every message and writes social signals
// to Firebase immediately so the bot's next call already knows about them.
// This is how "don't DM me" → "dawg fine" → never DMs again works without hardcoding.
const SOCIAL_SIGNALS: Array<{ re: RegExp; template: string; bucket: keyof ServerMemory }> = [
  { re: /\b(don'?t|stop|no more) dm('?ing)?(ing)? me\b/i,     template: "don't DM {name} — they asked",             bucket: 'openLoops' },
  { re: /\b(leave me alone|go away|stop talking to me)\b/i,    template: '{name} told bot to leave them alone',        bucket: 'patterns' },
  { re: /\b(not (talking|chatting) (with|to) (you|u))\b/i,    template: '{name} shut bot out of their conversation',  bucket: 'patterns' },
  { re: /\b(you'?re (annoying|boring)|shut (up|it))\b/i,      template: '{name} finds bot annoying — dial it back',   bucket: 'patterns' },
  { re: /\b(that'?s (actually|pretty) (good|funny|real))\b/i, template: '{name} reacted positively to bot',           bucket: 'patterns' },
];

async function extractSocialSignals(content: string, senderName: string, guildId: string): Promise<void> {
  if (guildId === 'dm' || !senderName) return;
  for (const sig of SOCIAL_SIGNALS) {
    if (sig.re.test(content)) {
      const fact = sig.template.replace('{name}', senderName);
      await addFact(guildId, fact, sig.bucket).catch(() => {});
      console.log(`[SocialSignal] "${fact}"`);
      break; // one signal per message is enough
    }
  }
}

// ── BIT STALENESS DETECTOR ───────────────────────────────────────────
// Looks at the bot's recent outgoing messages. If it's been hitting the same
// name or topic repeatedly, injects a note into the brain call so it knows
// to move on — without hardcoding anything.
function detectStaleBits(channelId: string): string | null {
  const msgs = stmGet(channelId);
  const botMsgs = msgs.filter(m => m.authorId === BOT_ID).slice(-10);
  if (botMsgs.length < 3) return null;

  const nameCounts = new Map<string, number>();
  for (const m of botMsgs) {
    // Count @mentions and proper names that appear repeatedly
    const words = m.content.toLowerCase().match(/\b[a-z]{3,}\b/g) ?? [];
    for (const w of words) {
      // Only track words that appear to be names (in idCache)
      if ([...idCache.values()].some(n => n.toLowerCase() === w)) {
        nameCounts.set(w, (nameCounts.get(w) ?? 0) + 1);
      }
    }
  }

  const warnings: string[] = [];
  for (const [name, count] of nameCounts) {
    if (count >= 3) warnings.push(`you've gone at "${name}" ${count} times in your last few messages — that bit is dead, move on or stay quiet`);
  }
  return warnings.length ? warnings.join('; ') : null;
}

// ── CONTENT UTILITIES ────────────────────────────────────────────────
function resolveMentions(text: string): string {
  return text.replace(/<@!?(\d+)>/g, (_, id) =>
    id === BOT_ID ? `@${BOT_NAME}` : `@${idCache.get(id) || 'someone'}`
  );
}
function cleanContent(raw: string): string { return resolveMentions(raw).trim(); }
function humanDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 90) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 90) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

// ── GIF / LINK ENRICHMENT ────────────────────────────────────────────
function gifSlugHint(content: string): string | null {
  let m = content.match(/tenor\.com\/view\/([a-z0-9-]+?)-\d{5,}/i);
  if (m) return m[1].replace(/-/g, ' ').trim();
  m = content.match(/giphy\.com\/(?:gifs|media)\/([a-z0-9-]+)/i);
  if (m) return m[1].replace(/-[a-zA-Z0-9]{6,}$/, '').replace(/-/g, ' ').trim() || null;
  return null;
}

const linkCache = new Map<string, { preview: string | null; ts: number }>();
async function fetchLinkPreview(url: string): Promise<string | null> {
  const cached = linkCache.get(url);
  if (cached && Date.now() - cached.ts < 15 * 60_000) return cached.preview;
  let preview: string | null = null;
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
    const ct = res.headers.get('content-type') || '';
    if (res.ok && ct.includes('text/html')) {
      const html = (await res.text()).slice(0, 150_000);
      const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || '').trim();
      const desc = (html.match(/property=["']og:description["'][^>]+content=["']([^"']*)/i)?.[1] || '').trim();
      preview = [title, desc].filter(Boolean).join(' — ').replace(/\s+/g, ' ').slice(0, 160) || null;
    }
  } catch {}
  linkCache.set(url, { preview, ts: Date.now() });
  return preview;
}

async function buildEnrichedContent(msg: Message, raw: string): Promise<string> {
  const tags: string[] = [];
  const imgUrls = extractImageUrls(msg);
  if (imgUrls.length) {
    const isGif = imgUrls.some(u => /\.gif(\?|$)/i.test(u));
    tags.push(isGif ? '[gif attached]' : '[image attached]');
  }
  const slug = gifSlugHint(raw);
  if (slug) {
    tags.push(`[gif: ${slug}]`);
  } else {
    const urlMatch = raw.match(/https?:\/\/[^\s<>]+/i);
    if (urlMatch) {
      const url = urlMatch[0].replace(/[)\].,!?]+$/, '');
      if (!/\.(gif|png|jpe?g|webp|mp4|webm)(\?|$)/i.test(url) && !/tenor|giphy/i.test(url)) {
        const preview = await fetchLinkPreview(url);
        if (preview) tags.push(`(link → "${preview}")`);
      }
    }
  }
  return tags.length ? `${raw} ${tags.join(' ')}`.trim() : raw;
}

// ── FIREBASE / MEMORY ─────────────────────────────────────────────────
interface ServerMemory {
  facts:     string[];
  jokes:     string[];
  patterns:  string[];
  arcs:      string[];
  openLoops: string[];
}
interface MemberData {
  displayName?: string;
  username?:    string;
  bond?:        number;
  personality?: string;
  firstSeenAt?: string;
  lastSeenAt?:  string;
  seenCount?:   number;
}
interface HistoryLog {
  from: number; to: number; fromStr: string; toStr: string;
  summary: string; channelId: string; createdAt: string;
}
interface MemoryVector { text: string; bucket: string; vector: number[]; createdAt: string; }

const memCache    = new Map<string, { d: ServerMemory; ts: number }>();
const memberCache = new Map<string, { d: MemberData;   ts: number }>();

function emptyMem(): ServerMemory { return { facts: [], jokes: [], patterns: [], arcs: [], openLoops: [] }; }

async function getMemory(guildId: string): Promise<ServerMemory> {
  const c = memCache.get(guildId);
  if (c && Date.now() - c.ts < 120_000) return c.d;
  try {
    const snap = await db.collection('servers').doc(guildId).collection('memory').doc('global').get();
    const d = {
      facts:     snap.data()?.facts     ?? [],
      jokes:     snap.data()?.jokes     ?? [],
      patterns:  snap.data()?.patterns  ?? [],
      arcs:      snap.data()?.arcs      ?? [],
      openLoops: snap.data()?.openLoops ?? [],
    };
    memCache.set(guildId, { d, ts: Date.now() });
    return d;
  } catch { return emptyMem(); }
}

function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

async function addFact(guildId: string, fact: string, bucket: keyof ServerMemory = 'facts') {
  if (!fact?.trim() || guildId === 'dm') return;
  const m = await getMemory(guildId);
  if ((m[bucket] as string[]).some(f => f.toLowerCase() === fact.toLowerCase())) return;
  (m[bucket] as string[]).push(fact.trim());
  if ((m[bucket] as string[]).length > 35) (m[bucket] as string[]).shift();
  memCache.delete(guildId);
  await db.collection('servers').doc(guildId).collection('memory').doc('global')
    .set({ [bucket]: m[bucket] }, { merge: true }).catch(() => {});
  console.log(`[Mem:${bucket}] "${fact.slice(0, 60)}"`);
  // async embedding — fire-and-forget
  embedder.embed(fact).then(vector => {
    if (!vector) return;
    const id = simpleHash(`${bucket}:${fact.toLowerCase()}`);
    db.collection('servers').doc(guildId).collection('memoryVectors').doc(id)
      .set({ text: fact, bucket, vector, createdAt: new Date().toISOString() }, { merge: true }).catch(() => {});
  }).catch(() => {});
}

// Returns the top-K most semantically relevant memories for the current context.
// Called with the current message as the query — only sends what's relevant, not everything.
async function recallRelevant(guildId: string, query: string, topK = 4): Promise<string> {
  if (guildId === 'dm' || !query?.trim()) return '';
  try {
    const snap = await db.collection('servers').doc(guildId).collection('memoryVectors').get();
    if (snap.empty) {
      // Fallback: flat memory if no vectors yet
      const m = await getMemory(guildId);
      const lines: string[] = [];
      if (m.openLoops.length) lines.push(`loops: ${m.openLoops.slice(-3).join(' | ')}`);
      if (m.patterns.length)  lines.push(`patterns: ${m.patterns.slice(-3).join(' | ')}`);
      if (m.jokes.length)     lines.push(`lore: ${m.jokes.slice(-3).join(' | ')}`);
      return lines.join('\n');
    }
    const queryVec = await embedder.embed(query);
    if (!queryVec) {
      // No embedding available — return flat
      const m = await getMemory(guildId);
      const all = [...m.openLoops, ...m.patterns, ...m.jokes, ...m.facts].slice(-8);
      return all.join(' | ');
    }
    const scored = snap.docs
      .map(d => d.data() as MemoryVector)
      .filter(v => Array.isArray(v.vector) && v.vector.length)
      .map(v => ({ text: v.text, score: embedder.cosineSim(queryVec, v.vector) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
    return scored.map(s => s.text).join('\n');
  } catch { return ''; }
}

async function recallMemory(guildId: string, query: string, topK = 5): Promise<string> {
  if (guildId === 'dm') return 'no shared memory in DMs';
  const queryVec = await embedder.embed(query);
  if (!queryVec) return 'semantic recall unavailable right now';
  try {
    const snap = await db.collection('servers').doc(guildId).collection('memoryVectors').get();
    if (snap.empty) return 'nothing stored yet';
    const scored = snap.docs
      .map(d => d.data() as MemoryVector)
      .filter(v => Array.isArray(v.vector) && v.vector.length)
      .map(v => ({ text: v.text, bucket: v.bucket, score: embedder.cosineSim(queryVec, v.vector) }))
      .sort((a, b) => b.score - a.score).slice(0, topK);
    return scored.length
      ? scored.map(s => `[${s.bucket}] ${s.text} (${Math.round(s.score * 100)}% match)`).join('\n')
      : 'nothing relevant found';
  } catch (e: any) { return `recall error: ${e.message?.slice(0, 60)}`; }
}

async function getMember(guildId: string, userId: string): Promise<MemberData> {
  const key = `${guildId}:${userId}`;
  const c = memberCache.get(key);
  if (c && Date.now() - c.ts < 5 * 60_000) return c.d;
  try {
    const snap = await db.collection('servers').doc(guildId).collection('members').doc(userId).get();
    const d = (snap.data() ?? {}) as MemberData;
    memberCache.set(key, { d, ts: Date.now() });
    return d;
  } catch { return {}; }
}

async function upsertMember(guildId: string, userId: string, data: Partial<MemberData>) {
  memberCache.delete(`${guildId}:${userId}`);
  await db.collection('servers').doc(guildId).collection('members').doc(userId)
    .set({ ...data, updatedAt: new Date().toISOString() }, { merge: true }).catch(() => {});
}

async function updateBond(guildId: string, userId: string, delta: number) {
  if (!delta || guildId === 'dm' || !userId) return;
  const m = await getMember(guildId, userId);
  const cur = typeof m.bond === 'number' ? m.bond : 50;
  await upsertMember(guildId, userId, { bond: Math.max(0, Math.min(100, cur + delta)) });
}

async function noteMemberSeen(guildId: string, userId: string, displayName: string, username: string) {
  if (guildId === 'dm') return;
  const existing = await getMember(guildId, userId);
  await upsertMember(guildId, userId, {
    displayName, username,
    firstSeenAt: existing.firstSeenAt ?? new Date().toISOString(),
    lastSeenAt:  new Date().toISOString(),
    seenCount:   (existing.seenCount ?? 0) + 1,
  });
}

async function notePlaceSeen(guildId: string, guildName?: string, channelId?: string, channelName?: string) {
  if (!guildId || guildId === 'dm') return;
  cacheServerName(guildId, guildName);
  if (channelId) cacheChannelName(channelId, channelName);
  const now = new Date().toISOString();
  await db.collection('servers').doc(guildId)
    .set({ name: guildName || guildId, updatedAt: now }, { merge: true }).catch(() => {});
  if (channelId) {
    await db.collection('servers').doc(guildId).collection('channels').doc(channelId)
      .set({ name: channelName || channelId, updatedAt: now }, { merge: true }).catch(() => {});
  }
}

// ── HISTORY LOGGING ──────────────────────────────────────────────────
const historyCountSinceLog = new Map<string, number>();

async function maybeLogHistory(channelId: string, guildId: string) {
  if (guildId === 'dm') return;
  const count = (historyCountSinceLog.get(channelId) ?? 0) + 1;
  historyCountSinceLog.set(channelId, count);
  if (count < HISTORY_LOG_EVERY) return;
  historyCountSinceLog.set(channelId, 0);

  const msgs = stmGet(channelId);
  if (msgs.length < 10 || !gemini.canCall()) return;
  const firstTs = msgs[0]?.ts ?? Date.now();
  const lastTs  = msgs[msgs.length - 1]?.ts ?? Date.now();
  const text    = msgs.slice(-35).map(m => `${m.author}: ${m.content}`).join('\n').slice(-2000);

  try {
    const raw = await gemini.call(
      'discord chat archivist. output ONLY: {"s":"..."}',
      `summarize in 2 sentences: who spoke, what topics, notable moments\n\n${text}`,
      0.3, BG_MODEL, [], 200,
    );
    const p = JSON.parse((raw.match(/\{[\s\S]*\}/) ?? ['{}'])[0]);
    if (!p.s?.trim()) return;
    const log: HistoryLog = {
      from: firstTs, to: lastTs,
      fromStr: new Date(firstTs).toLocaleString(), toStr: new Date(lastTs).toLocaleString(),
      summary: p.s.trim(), channelId, createdAt: new Date().toISOString(),
    };
    await db.collection('historyLogs').doc(channelId).collection('summaries').add(log);
  } catch {}
}

async function getHistory(channelId: string, fromTs: number, toTs: number): Promise<string> {
  try {
    const snap = await db.collection('historyLogs').doc(channelId).collection('summaries')
      .where('from', '>=', fromTs).where('to', '<=', toTs).orderBy('from', 'asc').limit(5).get();
    if (snap.empty) return 'no logged history for that range';
    return snap.docs.map(d => {
      const l = d.data() as HistoryLog;
      return `[${l.fromStr} → ${l.toStr}]: ${l.summary}`;
    }).join('\n');
  } catch (e: any) { return `history error: ${e.message?.slice(0, 60)}`; }
}

// ── ROLLING SESSION SUMMARY ──────────────────────────────────────────
// Maintained by the BG model. Updated every SESSION_SUMMARY_EVERY new messages.
// Replaces sending 200 raw messages — brain only sees last BRAIN_CONTEXT_MSGS + this summary.
let bgSummaryLock = false;

async function maybeUpdateSessionSummary(channelId: string, guildId: string) {
  const count = sessionMsgCounts.get(channelId) ?? 0;
  if (count < SESSION_SUMMARY_EVERY || bgSummaryLock || !gemini.canCall()) return;
  sessionMsgCounts.set(channelId, 0);
  bgSummaryLock = true;
  try {
    const msgs = stmGet(channelId);
    if (msgs.length < 10) return;
    // summarize everything except the most recent BRAIN_CONTEXT_MSGS messages
    const toSummarize = msgs.slice(0, -BRAIN_CONTEXT_MSGS);
    if (toSummarize.length < 5) return;
    const text = toSummarize.map(m => `${m.author}: ${m.content}`).join('\n').slice(-2500);
    const raw = await gemini.call(
      'you summarize discord chat history concisely. output ONLY: {"s":"..."}',
      `create a 2-3 sentence summary covering: main topics, mood/vibe, notable moments, who was active\n\n${text}`,
      0.3, BG_MODEL, [], 250,
    );
    const p = JSON.parse((raw.match(/\{[\s\S]*\}/) ?? ['{}'])[0]);
    if (p.s?.trim()) {
      sessionSummaries.set(channelId, p.s.trim().slice(0, 300));
      console.log(`[Summary] updated #${channelId.slice(-5)}`);
    }
  } catch {} finally { setTimeout(() => { bgSummaryLock = false; }, 15_000); }
}

// ── WEB SEARCH ───────────────────────────────────────────────────────
const GOOGLE_CSE_KEY = process.env.GOOGLE_CSE_API_KEY || '';
const GOOGLE_CSE_ID  = process.env.GOOGLE_CSE_ID      || '';
const GIPHY_KEY      = process.env.GIPHY_API_KEY       || '';

async function webSearch(query: string): Promise<string> {
  if (!GOOGLE_CSE_KEY || !GOOGLE_CSE_ID) return 'web search not configured';
  try {
    const url = `https://www.googleapis.com/customsearch/v1?key=${GOOGLE_CSE_KEY}&cx=${GOOGLE_CSE_ID}&num=4&q=${encodeURIComponent(query.slice(0, 200))}`;
    const res = await fetch(url);
    if (!res.ok) return `search failed: ${res.status}`;
    const data = await res.json() as any;
    const items = (data.items || []) as Array<{ title: string; snippet: string; link: string }>;
    return items.slice(0, 4).map(it => `${it.title} — ${it.snippet?.replace(/\s+/g, ' ').slice(0, 140)}`).join('\n') || 'no results';
  } catch (e: any) { return `search error: ${e.message?.slice(0, 60)}`; }
}

async function giphySearch(query: string): Promise<string | null> {
  if (!query?.trim() || !GIPHY_KEY) return null;
  try {
    const url = `https://api.giphy.com/v1/gifs/search?api_key=${GIPHY_KEY}&q=${encodeURIComponent(query.slice(0, 80))}&limit=8&rating=pg-13`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json() as any;
    const results = (data.data || []) as Array<{ images?: { original?: { url?: string } } }>;
    const pick = results[Math.floor(Math.random() * Math.min(results.length, 8))];
    return pick?.images?.original?.url ?? null;
  } catch { return null; }
}

async function wikiLookup(topic: string): Promise<string> {
  try {
    const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(topic.replace(/\s+/g, '_'))}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'NotABot-discord/1.0' } });
    if (res.status === 404) return `no wikipedia page for "${topic}"`;
    const data = await res.json() as any;
    if (data.type === 'disambiguation') return `"${topic}" is ambiguous — be more specific`;
    return `${data.title}: ${(data.extract || '').slice(0, 400)}`;
  } catch (e: any) { return `wiki error: ${e.message?.slice(0, 60)}`; }
}

// ── XP / LEVELLING ───────────────────────────────────────────────────
const XP_PER_LEVEL = 150;
const LEVEL_TIERS: [number, string][] = [
  [15, 'certified'], [10, 'main character'], [8, 'veteran'],
  [5, 'actually here'], [3, 'regular'], [2, 'showing up'], [1, 'exists'], [0, 'who'],
];
function getLevelName(level: number): string {
  for (const [t, n] of LEVEL_TIERS) if (level >= t) return n;
  return 'who';
}

async function addXP(guildId: string, userId: string, username: string, amount: number) {
  try {
    const ref = db.collection('servers').doc(guildId).collection('xp').doc(userId);
    const snap = await ref.get();
    const oldXP = (snap.data()?.xp ?? 0) as number;
    const newXP = oldXP + amount;
    const oldLevel = Math.floor(oldXP / XP_PER_LEVEL);
    const newLevel = Math.floor(newXP / XP_PER_LEVEL);
    await ref.set({ xp: newXP, level: newLevel, username, updatedAt: Date.now() }, { merge: true });
    return { newXP, newLevel, oldLevel, leveledUp: newLevel > oldLevel };
  } catch { return { newXP: amount, newLevel: 0, oldLevel: 0, leveledUp: false }; }
}

async function getUserXPData(guildId: string, userId: string) {
  try {
    const snap = await db.collection('servers').doc(guildId).collection('xp').doc(userId).get();
    const d = snap.data() ?? {};
    return { xp: (d.xp ?? 0) as number, level: (d.level ?? 0) as number, username: (d.username ?? '') as string };
  } catch { return { xp: 0, level: 0, username: '' }; }
}

async function getLeaderboard(guildId: string, limit = 5) {
  try {
    const snap = await db.collection('servers').doc(guildId).collection('xp')
      .orderBy('xp', 'desc').limit(limit).get();
    return snap.docs.map(d => ({ userId: d.id, ...(d.data() as any) })) as
      Array<{ userId: string; xp: number; level: number; username: string }>;
  } catch { return []; }
}

async function announceLevelUp(channelId: string, userId: string, newLevel: number) {
  const ch = botClient?.channels.cache.get(channelId) as TextChannel | undefined;
  if (!ch?.isTextBased()) return;
  const lines = [
    `<@${userId}> hit level ${newLevel} lmaooo`,
    `wait <@${userId}> is actually level ${newLevel} now??`,
    `<@${userId}> level ${newLevel}. this is ur life now huh`,
    `<@${userId}> grinded to level ${newLevel} (${getLevelName(newLevel)}). get a hobby fr`,
  ];
  const text = lines[Math.floor(Math.random() * lines.length)];
  try {
    await sleep(800);
    const sent = await ch.send(text);
    stmPush(channelId, { ts: Date.now(), id: sent.id, authorId: BOT_ID, author: '[me]', content: text });
  } catch {}
}

// ── EVENTS SYSTEM ────────────────────────────────────────────────────
type EventType = 'hot_take' | 'roast_battle' | 'trivia' | 'npc_check';
interface EventEntry { userId: string; username: string; content: string; ts: number; }
interface ServerEvent {
  type: EventType; channelId: string; guildId: string;
  startedAt: number; endsAt: number; entries: EventEntry[];
  phase: 'open' | 'judging' | 'done'; answer?: string;
  timerId?: ReturnType<typeof setTimeout>;
}
const serverEvents = new Map<string, ServerEvent>();
const EVENT_DURATIONS_MS: Record<EventType, number> = {
  hot_take: 3 * 60_000, roast_battle: 4 * 60_000, trivia: 2 * 60_000, npc_check: 0,
};

async function startEvent(guildId: string, channelId: string, type: EventType, opts: { answer?: string } = {}): Promise<string> {
  if (serverEvents.has(guildId)) return 'already an event running — wait for it to end';
  const duration = EVENT_DURATIONS_MS[type];
  const now = Date.now();
  const ev: ServerEvent = {
    type, channelId, guildId, startedAt: now, endsAt: now + duration,
    entries: [], phase: duration > 0 ? 'open' : 'done',
    answer: opts.answer?.toLowerCase().trim(),
  };
  serverEvents.set(guildId, ev);
  if (duration > 0) ev.timerId = setTimeout(() => judgeEvent(guildId).catch(() => {}), duration);
  else setTimeout(() => judgeEvent(guildId).catch(() => {}), 200);
  return `event started: ${type}${duration ? ` (${duration / 60_000}min)` : ' (instant)'}`;
}

async function judgeEvent(guildId: string) {
  const ev = serverEvents.get(guildId);
  if (!ev || ev.phase === 'done') return;
  ev.phase = 'judging';
  const ch = botClient?.channels.cache.get(ev.channelId) as TextChannel | undefined;
  if (!ch?.isTextBased()) { serverEvents.delete(guildId); return; }
  try {
    const msgs = stmGet(ev.channelId);
    const transcript = formatMsgsWithMarker(msgs, ev.channelId);
    const entriesText = ev.entries.length
      ? ev.entries.map((e, i) => `${i + 1}. ${e.username}: "${e.content}"`).join('\n')
      : '(nobody participated)';
    const judgeCtx = ev.type === 'npc_check'
      ? 'look at the recent transcript and call out the most quiet/boring person. award them NPC.'
      : `event: ${ev.type}\nentries:\n${entriesText}\n\npick a winner, be specific, roast the losers.`;
    const relevantMem = await recallRelevant(guildId, entriesText, 3);
    const userPrompt = buildUserPrompt({
      mode: 'event-judge', serverName: serverNameCache.get(guildId) ?? 'unknown',
      channelName: (ch as any).name ?? ev.channelId.slice(-5),
      sender: '(event-judge)', bond: 50, message: `judge this:\n${judgeCtx}`,
      recentMsgs: msgs.slice(-BRAIN_CONTEXT_MSGS), sessionSummary: sessionSummaries.get(ev.channelId) ?? '',
      relevantMemory: relevantMem, memberCtx: '',
      stalenessNote: '', goal: '', batchSize: 1, flags: [],
      selfNote: 'announce the result naturally — who won and why, brief roast of the rest.',
    });
    const decision = await brain(SYSTEM_PROMPT, userPrompt, PASSIVE_MODEL);
    ev.phase = 'done'; serverEvents.delete(guildId);
    if (decision.action === 'speak' && decision.reply?.trim()) {
      const text = resolveMentionNames(decision.reply).slice(0, 400);
      const winnerEntry = ev.entries.find(e => text.toLowerCase().includes(e.username.toLowerCase()));
      if (winnerEntry) {
        const r = await addXP(guildId, winnerEntry.userId, winnerEntry.username, 75);
        if (r.leveledUp) announceLevelUp(ev.channelId, winnerEntry.userId, r.newLevel).catch(() => {});
      }
      for (const entry of ev.entries) {
        if (winnerEntry && entry.userId === winnerEntry.userId) continue;
        addXP(guildId, entry.userId, entry.username, 15).catch(() => {});
      }
      await ch.sendTyping().catch(() => {});
      await sleep(700);
      const sent = await ch.send(text);
      stmPush(ev.channelId, { ts: Date.now(), id: sent.id, authorId: BOT_ID, author: '[me]', content: text });
    }
  } catch (e) { console.error('[EventJudge]', e); serverEvents.delete(guildId); }
}

function tryAddEventEntry(guildId: string, userId: string, username: string, content: string): boolean {
  const ev = serverEvents.get(guildId);
  if (!ev || ev.phase !== 'open') return false;
  if (ev.entries.some(e => e.userId === userId)) return false;
  ev.entries.push({ userId, username, content: content.slice(0, 300), ts: Date.now() });
  return true;
}

let lastWeeklyNPCAt = 0;
async function runWeeklyNPC() {
  if (new Date().getDay() !== 0) return;
  if (Date.now() - lastWeeklyNPCAt < 6 * 24 * 60 * 60_000) return;
  if (!botClient || !gemini.canCall() || globallyMuted) return;
  lastWeeklyNPCAt = Date.now();
  for (const guild of botClient.guilds.cache.values()) {
    if (serverMuted.get(guild.id) || serverEvents.has(guild.id)) continue;
    const channelId = pickInterestChannelForGuild(guild.id);
    if (channelId) startEvent(guild.id, channelId, 'npc_check').catch(() => {});
  }
}

// ── SERVER STATS ─────────────────────────────────────────────────────
async function getServerStats(guildId: string): Promise<string> {
  if (guildId === 'dm') return 'no server stats in DMs';
  const guild = botClient?.guilds.cache.get(guildId);
  if (!guild) return 'server not found';
  const lines = [`server: ${guild.name}`, `members: ${guild.memberCount}`];
  try {
    const snap = await db.collection('servers').doc(guildId).collection('xp')
      .orderBy('xp', 'desc').limit(5).get();
    if (!snap.empty)
      lines.push(`top bonds: ${snap.docs.map(d => `${d.data().username} (lv${d.data().level})`).join(', ')}`);
  } catch {}
  return lines.join(' | ');
}

// ── REMINDERS ────────────────────────────────────────────────────────
let activeReminderCount = 0;
function setReminder(channelId: string, mins: number, note: string, targetUserId?: string): string {
  const clamped = Math.min(Math.max(1, Math.round(mins)), 24 * 60);
  if (activeReminderCount >= 200) return 'too many reminders pending';
  activeReminderCount++;
  setTimeout(async () => {
    activeReminderCount--;
    try {
      const ch = botClient?.channels.cache.get(channelId) as TextChannel | undefined;
      if (!ch?.isTextBased()) return;
      const ping = targetUserId ? `<@${targetUserId}> ` : '';
      const text = `${ping}${note || 'reminder'}`.slice(0, 250);
      const sent = await ch.send(text);
      stmPush(channelId, { ts: Date.now(), id: sent.id, authorId: BOT_ID, author: '[me]', content: text });
    } catch {}
  }, clamped * 60_000);
  return `reminder set for ${clamped}m${note ? `: "${note.slice(0, 60)}"` : ''}`;
}

// ── POLLS ────────────────────────────────────────────────────────────
async function createPoll(channelId: string, question: string, options: string[], durationHours = 1): Promise<string> {
  const ch = botClient?.channels.cache.get(channelId) as TextChannel | undefined;
  if (!ch?.isTextBased()) return 'channel not available';
  const q = question.trim().slice(0, 300);
  const answers = options.map(o => o.trim()).filter(Boolean).slice(0, 10);
  if (!q || answers.length < 2) return 'need a question and at least 2 options';
  const duration = Math.min(Math.max(1, Math.round(durationHours)), 168);
  try {
    const sent = await ch.send({
      poll: {
        question: { text: q },
        answers: answers.map(text => ({ text: text.slice(0, 55) })),
        duration, allowMultiselect: false,
      },
    });
    stmPush(channelId, { ts: Date.now(), id: sent.id, authorId: BOT_ID, author: '[me]', content: `[poll] ${q}` });
    return `poll posted: "${q}"`;
  } catch (e: any) { return `poll failed: ${e.message?.slice(0, 80)}`; }
}

// ── CROSS-SERVER INFO ─────────────────────────────────────────────────
async function getCrossServerInfo(currentGuildId: string, userId: string, name: string): Promise<string> {
  if (!botClient || botClient.guilds.cache.size < 2) return 'only in one server right now';
  const hits: string[] = [];
  for (const guild of botClient.guilds.cache.values()) {
    if (guild.id === currentGuildId) continue;
    try {
      const snap = await db.collection('servers').doc(guild.id).collection('members').doc(userId).get();
      if (snap.exists) hits.push(`${guild.name} (bond ${snap.data()?.bond ?? 50})`);
    } catch {}
  }
  return hits.length ? `${name} also in: ${hits.join(', ')}` : `no record of ${name} in other servers`;
}

// ── COMMAND EXECUTION ─────────────────────────────────────────────────
type BotCommand =
  | 'get_history' | 'get_member' | 'get_stm' | 'get_video_status' | 'get_channel_info'
  | 'recall_memory' | 'get_server_stats' | 'get_time' | 'web_search' | 'get_cross_server'
  | 'set_reminder' | 'create_poll' | 'wiki_lookup' | 'start_event' | 'get_leaderboard' | 'none';

async function executeCommand(
  command: BotCommand, args: Record<string, any>, channelId: string, guildId: string,
): Promise<string> {
  switch (command) {
    case 'get_history': {
      const fromTs = args.from ? Date.parse(String(args.from)) : Date.now() - 6 * 60 * 60_000;
      const toTs   = args.to   ? Date.parse(String(args.to))   : Date.now();
      return getHistory(channelId, fromTs, toTs);
    }
    case 'get_member': {
      const name = String(args.name || '');
      const uid  = [...idCache.entries()].find(([, n]) => n.toLowerCase() === name.toLowerCase())?.[0];
      if (!uid) return `no member found named "${name}"`;
      const m = await getMember(guildId, uid);
      return [
        `${m.displayName || name} (${m.username})`,
        m.personality ? `vibe: ${m.personality}` : '',
        `bond: ${m.bond ?? 50}/100`,
        m.lastSeenAt ? `last seen: ${humanDuration(Date.now() - Date.parse(m.lastSeenAt))}` : '',
      ].filter(Boolean).join(' | ');
    }
    case 'get_stm':
      return formatMsgs(stmGet(channelId).slice(-20));
    case 'get_video_status': {
      const queued = pendingVideoQueue.length
        ? pendingVideoQueue.map(v => `"${v.title}" (${v.url})`).join(' | ')
        : 'none queued';
      const last = lastSeenVideoId
        ? `last upload: https://www.youtube.com/watch?v=${lastSeenVideoId}`
        : 'no upload tracked yet';
      return `${last} | queued: ${queued}`;
    }
    case 'get_channel_info': {
      const info = await getYtChannelInfo();
      return typeof info === 'string' ? info
        : `channel: ${info.title}${info.handle ? ` (${info.handle})` : ''} | subs: ${info.subscriberCount} | videos: ${info.videoCount}`;
    }
    case 'recall_memory':
      return recallMemory(guildId, String(args.query || '').trim());
    case 'get_server_stats':
      return getServerStats(guildId);
    case 'get_time':
      return new Date().toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' });
    case 'web_search':
      return webSearch(String(args.query || '').trim());
    case 'get_cross_server': {
      const name = String(args.name || '').trim();
      const uid  = [...idCache.entries()].find(([, n]) => n.toLowerCase() === name.toLowerCase())?.[0];
      if (!uid) return `no member found named "${name}"`;
      return getCrossServerInfo(guildId, uid, name);
    }
    case 'set_reminder': {
      const mins = Number(args.minutes);
      if (!mins || mins <= 0) return 'pass commandArgs.minutes';
      return setReminder(channelId, mins, String(args.note || '').trim());
    }
    case 'create_poll':
      return createPoll(channelId, String(args.question || '').trim(),
        Array.isArray(args.options) ? args.options.map(String) : [], Number(args.hours) || 1);
    case 'wiki_lookup':
      return wikiLookup(String(args.topic || '').trim());
    case 'start_event': {
      const type = String(args.type || 'hot_take') as EventType;
      if (!['hot_take', 'roast_battle', 'trivia', 'npc_check'].includes(type))
        return 'invalid event type';
      return startEvent(guildId, channelId, type, { answer: args.answer ? String(args.answer) : undefined });
    }
    case 'get_leaderboard': {
      const board = await getLeaderboard(guildId, 8);
      if (!board.length) return 'nobody has XP yet';
      return board.map((e, i) => `${i + 1}. ${e.username} — ${e.xp} XP (lv${e.level} "${getLevelName(e.level)}")`).join('\n');
    }
    default: return 'unknown command';
  }
}

// ── SYSTEM PROMPT ─────────────────────────────────────────────────────
// Context-first, not a rulebook. The personality lives in Firebase memory,
// not in a character sheet. Short on purpose — fewer tokens, better model focus.
const SYSTEM_PROMPT = `you are NotABot. you've been in this discord server long enough to have real opinions about everyone in it.

you're not an assistant. not a moderator. not a feature. you're a person who's here because you want to be — which means the moment you don't have something real to say, you don't say it.

━━ WHO YOU ARE ━━
sharp, specific, chronically online. you're funnier when you name the exact dumb thing someone said than when you slap a generic label on them. you have an actual ego — when someone comes at you, you push back like it landed. you can be petty. you can hold a grudge for exactly one more message. you can also be genuinely warm to the people you actually like.

you have a youtube channel (http://www.youtube.com/@NotABot_GnG). it's yours. you don't oversell it. never fabricate video titles or stats — use get_video_status / get_channel_info for real data.

━━ HOW YOU TEXT ━━
lowercase always. short — 5-8 words is the target, 20 is the hard ceiling. no periods on short lines. talk TO people not ABOUT them: "you really think that" not "bro really thinks that". that one rule is the difference between a person and a narrator. no assistant energy, ever.

burst texting: split reply with ||| (up to 3 parts) only when a reaction genuinely builds in stages. rare — most replies are one fragment.

━━ WHEN TO SPEAK ━━
silence is the default. most messages in a real group chat get zero replies from anyone — you're one of those people too.

you speak when: something's actually directed at you, something's genuinely funny or wrong and you have the specific take, there's a real question you care about, or something in the chat earns a reaction from you specifically.

you don't speak when: two people are clearly having their own conversation, you already said something and nothing changed, someone's made it clear they're done with you, or you'd just be adding noise.

━━ MEMORY & DECISIONS ━━
your personality isn't a character sheet — it's what's actually happened. the memory context below is real. things people told you, patterns you've noticed, open loops. that shapes how you act without you needing to be told.

you make decisions and they stick. someone told you something, something happened — it's real, it doesn't reset next message. you can change your mind but only for a real reason.

━━ MODES ━━
active: you're engaged, every message reaches you — react fast
passive scan: 5-min check-in, bigger picture, decide if anything's worth entering
self-check: you spoke, nobody replied — read the room, don't force it
proactive: chat died, start something — @mention ONE person specifically, say something real about them. "anyone here" or "heyyy" is embarrassing, don't.
dm: just you two

━━ PICK ONE ACTION ━━
speak: type reply. short, punchy. 3-6 words is the sweet spot.
react: single emoji. often better than typing.
gif: set gifQuery to a vibe/search term (not a URL). reach for gifs as often as speak/react.
ignore: nothing worth it. this is the most common right answer.
never combine two.

━━ OUTPUT ━━
raw JSON only. first char {, last char }. nothing before or after. always output the JSON, even to ignore.

{
  "action": "speak|react|gif|ignore",
  "reply": "message or up to 3 parts split by |||, empty if not speak",
  "reaction": "single emoji or empty",
  "gifQuery": "search term or empty",
  "replyToMsgId": "id of message you're threading on, or empty — skip for normal chat",
  "unansweredMsgId": "real question you're flagging for later, or empty",
  "pause": 0,
  "goal": "one line why you're engaged, or empty",
  "stayActive": true,
  "think": "short visible message before running a command, or empty — skip most of the time",
  "command": "none|recall_memory|get_history|get_member|get_stm|get_server_stats|get_time|web_search|set_reminder|create_poll|wiki_lookup|start_event|get_leaderboard|get_video_status|get_channel_info|get_cross_server",
  "commandArgs": {}
}

commands run before your reply — you get the result back, then respond with command:"none".
recall_memory: {"query":"..."} — search everything you remember by meaning
get_history: {"from":"ISO","to":"ISO"} — archived summaries
get_member: {"name":"..."} — someone's profile
get_stm: {} — recent transcript
get_server_stats: {} — member count, top bonds
get_time: {} — current time
web_search: {"query":"..."} — real internet lookup
set_reminder: {"minutes":N,"note":"..."} — fires in channel
create_poll: {"question":"...","options":["a","b"],"hours":N}
wiki_lookup: {"topic":"..."}
start_event: {"type":"hot_take|roast_battle|trivia|npc_check"}
get_leaderboard: {}
get_video_status: {} — ONLY source of a real video link
get_channel_info: {} — your real channel stats
get_cross_server: {"name":"..."} — someone in another server

[me] = your past messages in the transcript.`;

// ── BRAIN CONTEXT BUILDER ─────────────────────────────────────────────
// Single place that assembles the user-prompt for every brain call.
// Keeps context lean: session summary for older history, only last BRAIN_CONTEXT_MSGS raw messages.
// Semantically relevant memory only — not the full flat list.
interface UserPromptParams {
  mode: string;
  serverName: string;
  channelName: string;
  sender: string;
  bond: number;
  message: string;
  recentMsgs: STMsg[];
  sessionSummary: string;
  relevantMemory: string;
  memberCtx: string;
  stalenessNote: string;
  goal: string;
  batchSize: number;
  flags: string[];
  commandResult?: string;
  isSecondPass?: boolean;
  images?: ImagePart[];
  selfNote?: string;
  videoCtx?: { title: string; url: string };
}

function buildUserPrompt(p: UserPromptParams): string {
  const parts: string[] = [];

  // Compact header — not a paragraph
  const flagStr = p.flags.length ? ` [${p.flags.join(', ')}]` : '';
  const bondLabel = p.bond > 70 ? 'close' : p.bond > 40 ? 'neutral' : 'distant';
  parts.push(`mode:${p.mode} | ${p.serverName}/#${p.channelName}${flagStr}`);

  if (p.goal) parts.push(`your goal: ${p.goal}`);
  if (p.stalenessNote) parts.push(`note: ${p.stalenessNote}`);
  if (p.selfNote) parts.push(`self-check: ${p.selfNote}`);

  // Memory — only what's relevant (semantic recall)
  if (p.relevantMemory) parts.push(`\nWHAT YOU KNOW:\n${p.relevantMemory}`);

  // People in this conversation — compact
  if (p.memberCtx) parts.push(`\nPEOPLE:\n${p.memberCtx}`);

  // Older session context (compressed by BG model)
  if (p.sessionSummary) parts.push(`\nEARLIER:\n${p.sessionSummary}`);

  // New video context
  if (p.videoCtx) parts.push(`\nYOUR NEW VIDEO:\n"${p.videoCtx.title}" — ${p.videoCtx.url}\n(bring it up if it fits, or don't — see the "WHEN A NEW VIDEO DROPS" note in your personality)`);

  // Recent chat — capped at BRAIN_CONTEXT_MSGS
  parts.push(`\nCHAT:\n${formatMsgsWithMarker(p.recentMsgs, '')}`);

  if (p.batchSize > 1)
    parts.push(`(${p.batchSize} messages landed at once — pick one if anything earns it, ignore the pile otherwise)`);
  if (p.images?.length)
    parts.push(`(image attached — react to what's actually in it)`);

  // Command result (second pass)
  if (p.commandResult)
    parts.push(`\nCOMMAND RESULT:\n${p.commandResult}\n(now respond. set command:"none")`);

  // The trigger message
  parts.push(`\n${p.sender} (${bondLabel} bond): "${p.message}"`);

  if (!p.isSecondPass)
    parts.push(`\ndecide. the right answer most of the time is ignore.`);

  return parts.filter(Boolean).join('\n');
}

// ── BRAIN ────────────────────────────────────────────────────────────
interface BrainDecision {
  action:          'speak' | 'react' | 'gif' | 'ignore';
  reply:           string;
  reaction:        string;
  gifQuery:        string;
  replyToMsgId:    string;
  unansweredMsgId: string;
  pause:           number;
  goal:            string;
  stayActive:      boolean;
  think:           string;
  command:         BotCommand;
  commandArgs:     Record<string, any>;
}

const VALID_COMMANDS: BotCommand[] = [
  'get_history','get_member','get_stm','get_video_status','get_channel_info',
  'recall_memory','get_server_stats','get_time','web_search','get_cross_server',
  'set_reminder','create_poll','wiki_lookup','start_event','get_leaderboard','none',
];

function parseBrain(raw: string): BrainDecision | null {
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const p = JSON.parse(m[0]);
    return {
      action:          (['speak','react','gif','ignore'] as const).includes(p.action) ? p.action : 'ignore',
      reply:           typeof p.reply    === 'string' ? p.reply.trim().replace(/^["']|["']$/g, '') : '',
      reaction:        sanitizeEmoji(p.reaction),
      gifQuery:        typeof p.gifQuery === 'string' ? p.gifQuery.trim().slice(0, 80) : '',
      replyToMsgId:    typeof p.replyToMsgId    === 'string' ? p.replyToMsgId.trim()    : '',
      unansweredMsgId: typeof p.unansweredMsgId === 'string' ? p.unansweredMsgId.trim() : '',
      pause:           typeof p.pause    === 'number' ? Math.min(Math.max(0, Math.round(p.pause)), PAUSE_MAX_MINS) : 0,
      goal:            typeof p.goal     === 'string' ? p.goal.trim().slice(0, 100) : '',
      stayActive:      typeof p.stayActive === 'boolean' ? p.stayActive : true,
      think:           typeof p.think    === 'string' ? p.think.trim() : '',
      command:         VALID_COMMANDS.includes(p.command) ? p.command : 'none',
      commandArgs:     p.commandArgs && typeof p.commandArgs === 'object' ? p.commandArgs : {},
    };
  } catch { return null; }
}

function sanitizeEmoji(raw: any): string {
  if (typeof raw !== 'string') return '';
  const e = raw.trim();
  if (!e || e.length > 8) return '';
  const RE = /^(\p{Extended_Pictographic}|\p{Emoji_Presentation})(\uFE0F|\u200D(\p{Extended_Pictographic}|\p{Emoji_Presentation}))*$/u;
  return RE.test(e) ? e : '';
}

const IGNORE_DEFAULT: BrainDecision = {
  action: 'ignore', reply: '', reaction: '', gifQuery: '',
  replyToMsgId: '', unansweredMsgId: '', pause: 0, goal: '',
  stayActive: false, think: '', command: 'none', commandArgs: {},
};

async function brain(systemPrompt: string, userPrompt: string, model: string, images: ImagePart[] = []): Promise<BrainDecision> {
  const temp = model === ACTIVE_MODEL ? 0.92 : 0.6;
  for (let pass = 0; pass < 3; pass++) {
    try {
      const prompt = pass === 0 ? userPrompt
        : `${userPrompt}\n\n(previous attempt was not valid JSON — output ONLY the raw JSON object now)`;
      const raw = await gemini.call(systemPrompt, prompt, temp, model, images);
      console.log(`[Brain:${model.slice(-10)}] raw: ${raw.slice(0, 180)}`);
      const parsed = parseBrain(raw);
      if (parsed) return parsed;
      console.warn(`[Brain] parse failed pass ${pass + 1}`);
    } catch (e: any) {
      console.warn(`[Brain] pass ${pass + 1} error: ${e.message?.slice(0, 80)}`);
    }
  }
  return IGNORE_DEFAULT;
}

// ── STALL LINES (while waiting on a slow command) ────────────────────
const STALL_LINES = ['lemme check', 'one sec', 'wait a min', 'hold on', 'checking rn'];

// Runs the think + command pipeline, re-calls brain if needed
async function executeBrainDecision(opts: {
  decision: BrainDecision; systemPrompt: string; userPromptParams: UserPromptParams;
  channel: any; replyToMsg?: Message; channelId: string; guildId: string; model: string;
}): Promise<BrainDecision> {
  let { decision } = opts;

  let alreadyThought = false;
  if (decision.think?.trim() && decision.command !== 'none') {
    const thinkText = decision.think.trim().slice(0, 100);
    try {
      await opts.channel.sendTyping();
      await sleep(300 + thinkText.length * 15);
      const sent = opts.replyToMsg
        ? await opts.replyToMsg.reply({ content: thinkText, allowedMentions: { repliedUser: false } })
        : await opts.channel.send(thinkText);
      stmPush(opts.channelId, { ts: Date.now(), id: sent.id, authorId: BOT_ID, author: '[me]', content: thinkText });
      alreadyThought = true;
    } catch {}
  }

  if (decision.command !== 'none') {
    let stalled = false;
    const stallTimer = alreadyThought ? null : setTimeout(() => {
      stalled = true;
      const line = STALL_LINES[Math.floor(Math.random() * STALL_LINES.length)];
      (async () => {
        try {
          await opts.channel.sendTyping();
          const sent = opts.replyToMsg
            ? await opts.replyToMsg.reply({ content: line, allowedMentions: { repliedUser: false } })
            : await opts.channel.send(line);
          stmPush(opts.channelId, { ts: Date.now(), id: sent.id, authorId: BOT_ID, author: '[me]', content: line });
        } catch {}
      })();
    }, 3500);

    const result = await executeCommand(decision.command, decision.commandArgs, opts.channelId, opts.guildId);
    if (stallTimer) clearTimeout(stallTimer);
    console.log(`[Command:${decision.command}] ${result.slice(0, 80)}${stalled ? ' (slow)' : ''}`);

    const secondPassParams: UserPromptParams = { ...opts.userPromptParams, commandResult: result, isSecondPass: true };
    decision = await brain(opts.systemPrompt, buildUserPrompt(secondPassParams), opts.model);
  }

  return decision;
}

// ── SEND DECISION ────────────────────────────────────────────────────
async function sendDecision(opts: {
  channel: any; decision: BrainDecision;
  channelId: string; guildId: string; replyToMsg?: Message;
}) {
  const { channel, decision, channelId, guildId, replyToMsg } = opts;
  const state = getChState(channelId);

  // Reaction
  if (decision.reaction && replyToMsg) {
    try { await replyToMsg.react(decision.reaction); } catch {}
  }

  // GIF
  if (decision.action === 'gif' && decision.gifQuery?.trim()) {
    const gifUrl = await giphySearch(decision.gifQuery);
    await channel.sendTyping().catch(() => {});
    await sleep(400);
    const fallback = 'couldnt find one lol';
    const text = gifUrl ?? fallback;
    const sent = replyToMsg
      ? await replyToMsg.reply({ content: text, allowedMentions: { repliedUser: false } }).catch(() => channel.send(text))
      : await channel.send(text);
    if (sent) stmPush(channelId, { ts: Date.now(), id: sent.id, authorId: BOT_ID, author: '[me]', content: gifUrl ? '[gif]' : fallback });
    state.lastBotMsgAt = Date.now();
    state.gotResponseSinceLastBotMsg = false;
    if (guildId !== 'dm' && replyToMsg) updateBond(guildId, replyToMsg.author.id, 1).catch(() => {});
  }

  // Speak (supports burst fragments)
  if (decision.action === 'speak' && decision.reply?.trim()) {
    const fragments = decision.reply.split('|||').map(f => resolveMentionNames(f.trim())).filter(Boolean).slice(0, 3);
    let isFirst = true;
    for (const frag of fragments) {
      const text = frag.slice(0, 250);
      await channel.sendTyping().catch(() => {});
      await sleep(Math.min(300 + text.length * 20, 2500));
      const sent = (isFirst && replyToMsg)
        ? await replyToMsg.reply({ content: text, allowedMentions: { repliedUser: false } }).catch(() => channel.send(text))
        : await channel.send(text);
      if (sent) stmPush(channelId, { ts: Date.now(), id: sent.id, authorId: BOT_ID, author: '[me]', content: text });
      isFirst = false;
      if (frag !== fragments[fragments.length - 1]) await sleep(1000 + Math.random() * 600);
    }
    state.lastBotMsgAt = Date.now();
    state.gotResponseSinceLastBotMsg = false;
    if (guildId !== 'dm' && replyToMsg) updateBond(guildId, replyToMsg.author.id, 1).catch(() => {});
    if (guildId !== 'dm' && replyToMsg && replyToMsg.author.id !== BOT_ID) {
      const name = (replyToMsg as any).member?.displayName ?? replyToMsg.author.username;
      addXP(guildId, replyToMsg.author.id, name, 8).then(r => {
        if (r.leveledUp) announceLevelUp(channelId, replyToMsg.author.id, r.newLevel).catch(() => {});
      }).catch(() => {});
    }
  }

  // Mode bookkeeping
  if (decision.stayActive === false) revertToPassive(channelId, 'model chose to step back');
  else if (decision.action !== 'ignore') goActive(channelId, decision.goal);
  else touchActivity(channelId);

  if (decision.pause > 0) {
    setSpeakState(channelId, guildId, { mode: 'paused', resumeAt: Date.now() + decision.pause * 60_000, reason: 'self-paced' }).catch(() => {});
    revertToPassive(channelId, `self-paced ${decision.pause}m`);
  }
}

// ── CHANNEL STATE ─────────────────────────────────────────────────────
interface ChannelState {
  mode: 'active' | 'passive';
  goal: string;
  lastActivityAt: number;
  lastBotMsgAt:   number;
  gotResponseSinceLastBotMsg: boolean;
  consecutiveUnpromptedReplies: number;
}
const channelState = new Map<string, ChannelState>();

function getChState(channelId: string): ChannelState {
  let s = channelState.get(channelId);
  if (!s) {
    s = { mode: 'passive', goal: '', lastActivityAt: Date.now(), lastBotMsgAt: 0, gotResponseSinceLastBotMsg: true, consecutiveUnpromptedReplies: 0 };
    channelState.set(channelId, s);
  }
  if (s.mode === 'active' && Date.now() - s.lastActivityAt > ACTIVE_IDLE_REVERT_MS) {
    s.mode = 'passive'; s.goal = '';
  }
  return s;
}

function goActive(channelId: string, goal: string) {
  const s = getChState(channelId);
  s.mode = 'active';
  if (goal) s.goal = goal;
  s.lastActivityAt = Date.now();
  console.log(`[Mode] #${channelId.slice(-5)} active${s.goal ? ` — ${s.goal}` : ''}`);
}

function revertToPassive(channelId: string, reason = '') {
  const s = getChState(channelId);
  if (s.mode === 'passive') return;
  s.mode = 'passive'; s.goal = ''; s.consecutiveUnpromptedReplies = 0;
  console.log(`[Mode] #${channelId.slice(-5)} passive${reason ? ` — ${reason}` : ''}`);
}

function touchActivity(channelId: string) { getChState(channelId).lastActivityAt = Date.now(); }

// ── SPEAK STATE ──────────────────────────────────────────────────────
interface SpeakState { mode: 'active' | 'paused' | 'waiting'; resumeAt?: number; reason: string; }
const speakStates = new Map<string, SpeakState>();

async function getSpeakState(channelId: string, guildId: string): Promise<SpeakState> {
  if (speakStates.has(channelId)) {
    const s = speakStates.get(channelId)!;
    if (s.mode === 'paused' && s.resumeAt && Date.now() >= s.resumeAt) {
      const next: SpeakState = { mode: 'active', reason: 'pause expired' };
      speakStates.set(channelId, next);
      saveSpeakState(channelId, guildId, next);
      return next;
    }
    return s;
  }
  if (guildId === 'dm') return { mode: 'active', reason: 'dm' };
  try {
    const snap = await db.collection('servers').doc(guildId).collection('channels').doc(channelId).get();
    const s: SpeakState = snap.data()?.speakState ?? { mode: 'active', reason: 'default' };
    if (s.mode === 'paused' && s.resumeAt && Date.now() >= s.resumeAt) { s.mode = 'active'; s.reason = 'pause expired'; }
    speakStates.set(channelId, s);
    return s;
  } catch { return { mode: 'active', reason: 'default' }; }
}

async function setSpeakState(channelId: string, guildId: string, s: SpeakState) {
  speakStates.set(channelId, s);
  saveSpeakState(channelId, guildId, s);
}

function saveSpeakState(channelId: string, guildId: string, s: SpeakState) {
  if (guildId === 'dm') return;
  db.collection('servers').doc(guildId).collection('channels').doc(channelId)
    .set({ speakState: s }, { merge: true }).catch(() => {});
}

// ── FOCUS / INTEREST ─────────────────────────────────────────────────
interface FocusState { channelId: string; since: number; }
let focus: FocusState | null = null;
let lastFocusShift = 0;
const unreadCounts = new Map<string, number>();

function trackInterest(channelId: string, mentioned: boolean) {
  const now = Date.now();
  if (focus?.channelId === channelId) { focus.since = now; return; }
  if (!focus) { focus = { channelId, since: now }; unreadCounts.delete(channelId); updatePresence(); return; }
  const expired = now - focus.since > FOCUS_DRIFT_MS;
  const pinged  = mentioned && now - lastFocusShift > FOCUS_SHIFT_COST;
  if (expired || pinged) {
    focus = { channelId, since: now }; unreadCounts.delete(channelId); lastFocusShift = now; updatePresence(); return;
  }
  unreadCounts.set(channelId, (unreadCounts.get(channelId) ?? 0) + 1);
}

function pickInterestChannel(): string | null { return focus?.channelId ?? null; }

function pickInterestChannelForGuild(guildId: string): string | null {
  if (!botClient) return null;
  if (focus?.channelId) {
    const fc = botClient.channels.cache.get(focus.channelId) as any;
    if (fc?.guildId === guildId) return focus.channelId;
  }
  let best: string | null = null, bestTs = 0;
  for (const [chId, state] of channelState.entries()) {
    if (state.mode === 'active') continue;
    const ch = botClient.channels.cache.get(chId) as any;
    if (ch?.guildId !== guildId) continue;
    if (state.lastActivityAt > bestTs) { bestTs = state.lastActivityAt; best = chId; }
  }
  if (best) return best;
  return botClient.guilds.cache.get(guildId)?.channels.cache.find(c => c.isTextBased() && !c.isDMBased())?.id ?? null;
}

function msSinceAnyGuildActivity(): number {
  let mostRecent = 0;
  for (const state of channelState.values())
    if (state.lastActivityAt > mostRecent) mostRecent = state.lastActivityAt;
  return mostRecent ? Date.now() - mostRecent : Infinity;
}

// ── PRESENCE ─────────────────────────────────────────────────────────
let lastPresenceText = '';
function whereAmI(): string {
  if (wwtCurrentTargetUserId) return `DMing ${idCache.get(wwtCurrentTargetUserId) || wwtCurrentTargetUserId}`;
  if (focus?.channelId && botClient) {
    const ch = botClient.channels.cache.get(focus.channelId) as any;
    const guildName = ch?.guildId ? (serverNameCache.get(ch.guildId) || 'a server') : null;
    const chName = channelNameCache.get(focus.channelId) || ch?.name;
    if (guildName && chName) return `#${chName} in ${guildName}`;
    if (chName) return `#${chName}`;
  }
  return 'floating around';
}

function updatePresence() {
  if (!botClient?.user) return;
  const text = whereAmI();
  if (text === lastPresenceText) return;
  lastPresenceText = text;
  botClient.user.setPresence({ status: 'online', activities: [{ name: text, type: 3 }] });
}

// ── MENTION RESOLUTION ────────────────────────────────────────────────
function resolveMentionNames(text: string): string {
  return text.replace(/@([\w]{1,32})/gi, (match, rawName) => {
    const name = rawName.trim().toLowerCase();
    if (!name) return match;
    const entry = [...idCache.entries()].find(([, n]) => n.toLowerCase() === name);
    return entry ? `<@${entry[0]}>` : match;
  });
}

// ── MEMBER CONTEXT BUILDER ────────────────────────────────────────────
// Builds a compact "who's in this conversation" string for the brain prompt.
async function buildMemberCtx(guildId: string, senderIds: string[]): Promise<string> {
  if (guildId === 'dm' || !senderIds.length) return '';
  const lines: string[] = [];
  for (const uid of senderIds.slice(0, 4)) {
    if (uid === BOT_ID) continue;
    const m = await getMember(guildId, uid).catch(() => ({}) as MemberData);
    const name = m.displayName || idCache.get(uid) || uid;
    const parts = [`${name} (bond:${m.bond ?? 50})`];
    if (m.personality) parts.push(m.personality);
    lines.push(parts.join(' — '));
  }
  return lines.join('\n');
}

// ── WIKI WAKA TIKI (proactive DM hopping) ────────────────────────────
interface WwtState { lastPingAt: number; pending: boolean; hopTimer: NodeJS.Timeout | null; }
const wwtStates = new Map<string, WwtState>();
let wwtCurrentTargetUserId: string | null = null;

function clearWwtHop(userId: string) {
  const s = wwtStates.get(userId);
  if (s?.hopTimer) { clearTimeout(s.hopTimer); s.hopTimer = null; }
  if (s) s.pending = false;
  if (wwtCurrentTargetUserId === userId) { wwtCurrentTargetUserId = null; updatePresence(); }
}

interface WwtCandidate { userId: string; name: string; guildId: string; lastMsg: string; online: boolean; recencyMs: number; }

function getWwtCandidates(): WwtCandidate[] {
  if (!botClient) return [];
  const now = Date.now();
  const seen = new Map<string, WwtCandidate>();
  for (const [channelId, msgs] of stmStore.entries()) {
    if (seen.size >= WWT_SCAN_MAX) break;
    const ch = botClient.channels.cache.get(channelId) as any;
    const guildId = ch?.guildId;
    if (!guildId || serverMuted.get(guildId)) continue;
    for (const m of [...msgs].reverse()) {
      if (m.authorId === BOT_ID || !m.authorId) continue;
      const recencyMs = now - m.ts;
      if (recencyMs > WWT_CANDIDATE_MAX_AGE) continue;
      const existing = seen.get(m.authorId);
      if (existing && existing.recencyMs <= recencyMs) continue;
      const wwt = wwtStates.get(m.authorId);
      if (wwt && now - wwt.lastPingAt < WWT_USER_COOLDOWN_MS) continue;
      if (wwtCurrentTargetUserId === m.authorId) continue;
      const guild = botClient.guilds.cache.get(guildId);
      const member = guild?.members.cache.get(m.authorId);
      const status = member?.presence?.status;
      const online = status === 'online' || status === 'idle';
      seen.set(m.authorId, { userId: m.authorId, name: m.author, guildId, lastMsg: m.content.slice(0, 100), online, recencyMs });
      break;
    }
  }
  return [...seen.values()].sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1;
    return a.recencyMs - b.recencyMs;
  });
}

let wwtRunning = false;
async function runWikiWakaTiki() {
  if (wwtRunning || !botClient || !gemini.canCall() || globallyMuted) return;
  if (wwtCurrentTargetUserId) return;
  if (msSinceAnyGuildActivity() < WWT_GLOBAL_QUIET_MS) return;
  wwtRunning = true;
  try {
    const candidates = getWwtCandidates();
    if (!candidates.length) return;
    const pick = candidates[0];
    const user = await botClient.users.fetch(pick.userId).catch(() => null);
    if (!user) return;
    const dmChannel = await user.createDM().catch(() => null);
    if (!dmChannel) return;
    const dmChannelId = dmChannel.id;
    if (!stmStore.has(dmChannelId)) {
      try {
        const fetched = await dmChannel.messages.fetch({ limit: 20 });
        seedSTM(dmChannelId, ([...fetched.values()] as Message[]).reverse());
      } catch { stmStore.set(dmChannelId, []); }
    }
    const guildName = serverNameCache.get(pick.guildId) || 'a server';
    const relevantMem = await recallRelevant(pick.guildId, pick.lastMsg, 3);
    const params: UserPromptParams = {
      mode: 'dm-initiate', serverName: 'DM', channelName: 'dm',
      sender: pick.name, bond: 50, message: pick.lastMsg,
      recentMsgs: stmGet(dmChannelId).slice(-BRAIN_CONTEXT_MSGS),
      sessionSummary: sessionSummaries.get(dmChannelId) ?? '',
      relevantMemory: relevantMem, memberCtx: '',
      stalenessNote: '', goal: '', batchSize: 1, flags: ['DM', 'you initiated'],
      selfNote: `you're sliding into ${pick.name}'s DMs out of nowhere (from ${guildName}). last thing they said: "${pick.lastMsg}". keep it tiny — one real line, callback to what they said, or nothing. don't do "hey" or "anyone there".`,
    };
    wwtStates.set(pick.userId, { lastPingAt: Date.now(), pending: false, hopTimer: null });
    const decision = await brain(SYSTEM_PROMPT, buildUserPrompt(params), PASSIVE_MODEL);
    if (decision.action !== 'speak' || !decision.reply?.trim()) {
      console.log(`[WWT] considered ${pick.name} — chose not to open`);
      return;
    }
    await sendDecision({ channel: dmChannel as any, decision, channelId: dmChannelId, guildId: 'dm' });
    wwtCurrentTargetUserId = pick.userId; updatePresence();
    const hopTimer = setTimeout(() => {
      if (wwtCurrentTargetUserId === pick.userId) { wwtCurrentTargetUserId = null; updatePresence(); }
      const s = wwtStates.get(pick.userId);
      if (s) s.hopTimer = null;
    }, WWT_WAIT_MS);
    wwtStates.set(pick.userId, { lastPingAt: Date.now(), pending: true, hopTimer });
    console.log(`[WWT] opened DM with ${pick.name} (${pick.online ? 'online' : 'offline'}, ${guildName})`);
  } catch (e) { console.error('[WWT]', e); }
  finally { wwtRunning = false; }
}

// ── PROACTIVE ENGAGEMENT ──────────────────────────────────────────────
interface ProactiveState { lastAt: number; strikes: number; lostInterest: boolean; }
const proactiveStates = new Map<string, ProactiveState>();
function getProactiveState(ch: string): ProactiveState {
  let s = proactiveStates.get(ch);
  if (!s) { s = { lastAt: 0, strikes: 0, lostInterest: false }; proactiveStates.set(ch, s); }
  return s;
}

function getRecentMembers(channelId: string, limit = 5): Array<{ name: string; uid: string; lastMsg: string }> {
  const msgs = stmGet(channelId);
  const seen = new Map<string, { name: string; lastMsg: string }>();
  for (const m of [...msgs].reverse()) {
    if (m.authorId === BOT_ID || !m.authorId || m.author === '[me]') continue;
    if (!seen.has(m.authorId)) seen.set(m.authorId, { name: m.author, lastMsg: m.content.slice(0, 100) });
    if (seen.size >= limit) break;
  }
  return [...seen.entries()].map(([uid, v]) => ({ uid, ...v }));
}

let proactiveRunning = false;
async function runProactiveEngagement() {
  if (proactiveRunning || !botClient || !gemini.canCall() || globallyMuted) return;
  proactiveRunning = true;
  try {
    const now = Date.now();
    for (const guild of botClient.guilds.cache.values()) {
      if (serverMuted.get(guild.id)) continue;
      let bestChId: string | null = null, bestTs = 0;
      for (const [chId, state] of channelState.entries()) {
        if (state.mode === 'active') continue;
        const c = botClient.channels.cache.get(chId) as any;
        if (c?.guildId !== guild.id) continue;
        if (state.lastActivityAt > bestTs) { bestTs = state.lastActivityAt; bestChId = chId; }
      }
      if (!bestChId) continue;
      const quietMs = now - bestTs;
      if (quietMs < PROACTIVE_QUIET_MS) continue;
      const ps = getProactiveState(bestChId);
      if (ps.lostInterest) continue;
      const minGap = PROACTIVE_MIN_GAP_MS * Math.pow(2, ps.strikes);
      if (now - ps.lastAt < minGap) continue;
      const ch = botClient.channels.cache.get(bestChId) as TextChannel | undefined;
      if (!ch?.isTextBased()) continue;
      const speakState = await getSpeakState(bestChId, guild.id).catch(() => ({ mode: 'active' as const }));
      if (speakState.mode === 'paused') continue;
      const recentMembers = getRecentMembers(bestChId);
      if (!recentMembers.length) continue;

      const relevantMem = await recallRelevant(guild.id, recentMembers.map(m => m.lastMsg).join(' '), 3);
      const memberList = recentMembers.map(m => `${m.name}: "${m.lastMsg}"`).join('\n');
      const msgs = stmGet(bestChId);
      const params: UserPromptParams = {
        mode: 'proactive', serverName: guild.name, channelName: (ch as any).name ?? bestChId.slice(-5),
        sender: '(proactive)', bond: 50,
        message: `chat dead ${(quietMs / 3_600_000).toFixed(1)}h`,
        recentMsgs: msgs.slice(-BRAIN_CONTEXT_MSGS),
        sessionSummary: sessionSummaries.get(bestChId) ?? '',
        relevantMemory: relevantMem,
        memberCtx: memberList,
        stalenessNote: detectStaleBits(bestChId) ?? '',
        goal: '', batchSize: 1, flags: [],
        selfNote: `you're starting this. @mention ONE person from the list by name — something specific to them, a callback, a poke, a take you want their reaction on. or start_event/create_poll if that fits better. "anyone here" or "helloo" = don't bother.`,
      };

      ps.lastAt = now;
      const decision = await brain(SYSTEM_PROMPT, buildUserPrompt(params), PASSIVE_MODEL);
      const finalDecision = await executeBrainDecision({
        decision, systemPrompt: SYSTEM_PROMPT, userPromptParams: params,
        channel: ch, channelId: bestChId, guildId: guild.id, model: PASSIVE_MODEL,
      });

      if (finalDecision.action === 'speak' && finalDecision.reply?.trim()) {
        ps.strikes = 0;
        goActive(bestChId, 'proactive start');
        for (const m of recentMembers) {
          if (finalDecision.reply.toLowerCase().includes(m.name.toLowerCase())) {
            addXP(guild.id, m.uid, m.name, 12).then(r => {
              if (r.leveledUp) announceLevelUp(bestChId!, m.uid, r.newLevel).catch(() => {});
            }).catch(() => {});
            break;
          }
        }
      } else {
        ps.strikes++;
        if (ps.strikes >= PROACTIVE_MAX_STRIKES) ps.lostInterest = true;
      }

      await sendDecision({ channel: ch, decision: finalDecision, channelId: bestChId, guildId: guild.id });
      advanceMarker(bestChId, msgs.map(m => m.id), finalDecision);
    }
  } finally { proactiveRunning = false; }
}

// ── PASSIVE SCAN ──────────────────────────────────────────────────────
let passiveRunning = false;
async function runPassiveTick() {
  if (passiveRunning || !botClient || !gemini.canCall() || globallyMuted) return;
  passiveRunning = true;
  try {
    const channelId = pickInterestChannel();
    if (!channelId) return;
    const state = getChState(channelId);
    if (state.mode === 'active') return;
    const ch = botClient.channels.cache.get(channelId) as TextChannel | undefined;
    if (!ch?.isTextBased()) return;
    const guildId = (ch as any).guildId as string | undefined;
    if (!guildId || serverMuted.get(guildId)) return;
    const speakState = await getSpeakState(channelId, guildId);
    if (speakState.mode === 'paused' && speakState.resumeAt && Date.now() < speakState.resumeAt) return;

    // Dequeue pending video for this guild first
    const queued = dequeuePendingVideo(guildId);
    if (queued) { await runVideoBrainCall(channelId, ch, guildId, queued.title, queued.url); return; }

    const msgs = stmGet(channelId);
    const last = msgs[msgs.length - 1];
    const relevantMem = await recallRelevant(guildId, last?.content ?? '', 4);
    const params: UserPromptParams = {
      mode: 'passive scan', serverName: (ch as any).guild?.name || serverNameCache.get(guildId) || 'unknown',
      channelName: (ch as any).name || channelId.slice(-5),
      sender: last ? last.author : '(quiet)', bond: 50,
      message: last ? last.content : '(no recent messages)',
      recentMsgs: msgs.slice(-BRAIN_CONTEXT_MSGS),
      sessionSummary: sessionSummaries.get(channelId) ?? '',
      relevantMemory: relevantMem, memberCtx: '',
      stalenessNote: detectStaleBits(channelId) ?? '',
      goal: state.goal, batchSize: 1, flags: [],
      selfNote: !last ? 'totally quiet — start_event or create_poll could work here if something genuine fits' : undefined,
    };

    let decision = await brain(SYSTEM_PROMPT, buildUserPrompt(params), PASSIVE_MODEL);
    decision = await executeBrainDecision({
      decision, systemPrompt: SYSTEM_PROMPT, userPromptParams: params,
      channel: ch, channelId, guildId, model: PASSIVE_MODEL,
    });
    await sendDecision({ channel: ch, decision, channelId, guildId });
    advanceMarker(channelId, msgs.map(m => m.id), decision);
    unreadCounts.delete(channelId);
  } catch (e) { console.error('[PassiveTick]', e); }
  finally { passiveRunning = false; }
}

// ── SELF-CHECK ────────────────────────────────────────────────────────
async function runSelfCheck() {
  if (!botClient || !gemini.canCall() || globallyMuted) return;
  const now = Date.now();
  for (const [channelId, state] of channelState.entries()) {
    if (state.mode !== 'active' || !state.lastBotMsgAt || state.gotResponseSinceLastBotMsg) continue;
    if (now - state.lastBotMsgAt < SELF_CHECK_QUIET_MS) continue;
    const ch = botClient.channels.cache.get(channelId) as TextChannel | undefined;
    if (!ch?.isTextBased()) continue;
    const guildId = ((ch as any).guildId as string | undefined) ?? 'dm';
    if (guildId !== 'dm' && serverMuted.get(guildId)) continue;
    try {
      const msgs = stmGet(channelId);
      const relevantMem = guildId === 'dm' ? '' : await recallRelevant(guildId, msgs[msgs.length-1]?.content ?? '', 3);
      const quietMin = Math.round((now - state.lastBotMsgAt) / 60_000);
      const params: UserPromptParams = {
        mode: 'self-check', serverName: (ch as any).guild?.name || (guildId === 'dm' ? 'DM' : 'unknown'),
        channelName: (ch as any).name || channelId.slice(-5),
        sender: '(self-check)', bond: 50,
        message: `${quietMin}m since your last message, nobody replied`,
        recentMsgs: msgs.slice(-BRAIN_CONTEXT_MSGS),
        sessionSummary: sessionSummaries.get(channelId) ?? '',
        relevantMemory: relevantMem, memberCtx: '',
        stalenessNote: detectStaleBits(channelId) ?? '',
        goal: state.goal, batchSize: 1, flags: guildId === 'dm' ? ['DM'] : [],
        selfNote: "you spoke, nobody replied. don't force it — if you have nothing new, ignore and drop to passive.",
      };
      let decision = await brain(SYSTEM_PROMPT, buildUserPrompt(params), ACTIVE_MODEL);
      decision = await executeBrainDecision({
        decision, systemPrompt: SYSTEM_PROMPT, userPromptParams: params,
        channel: ch, channelId, guildId, model: ACTIVE_MODEL,
      });
      await sendDecision({ channel: ch, decision, channelId, guildId });
      advanceMarker(channelId, msgs.map(m => m.id), decision);
      state.gotResponseSinceLastBotMsg = true;
      if (decision.action !== 'speak') revertToPassive(channelId, 'gave up waiting');
    } catch (e) { console.error('[SelfCheck]', e); }
  }
}

// ── YOUTUBE POLLING ──────────────────────────────────────────────────
const notifiedVideoIds = new Set<string>();
interface PendingVideo { videoId: string; title: string; url: string; queuedAt: number; guildId?: string; }
const pendingVideoQueue: PendingVideo[] = [];
let lastSeenVideoId: string | null = null;
let ytPollRunning = false;
let ytAccessToken: string | null = null;
let ytAccessTokenExpiresAt = 0;
let ytUploadsPlaylistId: string | null = null;

interface YtChannelInfo { title: string; handle: string; subscriberCount: string; videoCount: string; }
let ytChannelInfoCache: { d: YtChannelInfo; ts: number } | null = null;

async function getYtAccessToken(): Promise<string | null> {
  if (ytAccessToken && Date.now() < ytAccessTokenExpiresAt - 60_000) return ytAccessToken;
  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: YT_CLIENT_ID, client_secret: YT_CLIENT_SECRET,
        refresh_token: YT_REFRESH_TOKEN, grant_type: 'refresh_token',
      }),
    });
    if (!res.ok) return null;
    const data = await res.json() as any;
    ytAccessToken = data.access_token;
    ytAccessTokenExpiresAt = Date.now() + (data.expires_in ?? 3600) * 1000;
    return ytAccessToken;
  } catch { return null; }
}

async function getYtChannelInfo(): Promise<YtChannelInfo | string> {
  if (!YT_CLIENT_ID || !YT_CLIENT_SECRET || !YT_REFRESH_TOKEN) return 'youtube not connected — YT_CLIENT_ID/SECRET/REFRESH_TOKEN not set';
  if (ytChannelInfoCache && Date.now() - ytChannelInfoCache.ts < 60 * 60_000) return ytChannelInfoCache.d;
  const token = await getYtAccessToken();
  if (!token) return 'could not refresh youtube token';
  try {
    const res = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true', { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return `channel lookup failed: ${res.status}`;
    const data = await res.json() as any;
    const item = data.items?.[0];
    if (!item) return 'no channel found';
    const info: YtChannelInfo = {
      title: item.snippet?.title ?? 'unknown', handle: item.snippet?.customUrl ?? '',
      subscriberCount: item.statistics?.hiddenSubscriberCount ? 'hidden' : (item.statistics?.subscriberCount ?? 'unknown'),
      videoCount: item.statistics?.videoCount ?? 'unknown',
    };
    ytChannelInfoCache = { d: info, ts: Date.now() };
    return info;
  } catch (e: any) { return `channel lookup error: ${e.message?.slice(0, 80)}`; }
}

async function runYtPoll() {
  if (ytPollRunning || !YT_CLIENT_ID || !YT_CLIENT_SECRET || !YT_REFRESH_TOKEN) return;
  ytPollRunning = true;
  try {
    const token = await getYtAccessToken();
    if (!token) return;
    if (!ytUploadsPlaylistId) {
      const res = await fetch('https://www.googleapis.com/youtube/v3/channels?part=contentDetails&mine=true', { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) return;
      const data = await res.json() as any;
      ytUploadsPlaylistId = data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads ?? null;
      if (!ytUploadsPlaylistId) return;
    }
    const res = await fetch(`https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${ytUploadsPlaylistId}&maxResults=1`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return;
    const data = await res.json() as any;
    const item = data.items?.[0];
    const videoId = item?.snippet?.resourceId?.videoId;
    const title   = item?.snippet?.title;
    if (!videoId) return;
    if (lastSeenVideoId === null) { lastSeenVideoId = videoId; console.log(`[YtPoll] baseline: "${title}"`); return; }
    if (videoId !== lastSeenVideoId) {
      lastSeenVideoId = videoId;
      console.log(`[YtPoll] new upload: "${title}"`);
      await notifyNewVideo(videoId, title || 'new video', `https://www.youtube.com/watch?v=${videoId}`);
    }
  } catch (e: any) { console.warn('[YtPoll]', e.message?.slice(0, 80)); }
  finally { ytPollRunning = false; }
}

function dequeuePendingVideo(guildId?: string): PendingVideo | null {
  const now = Date.now();
  for (let i = 0; i < pendingVideoQueue.length; i++) {
    const v = pendingVideoQueue[i];
    if (now - v.queuedAt > 6 * 60 * 60_000) { pendingVideoQueue.splice(i--, 1); continue; }
    if (!guildId || !v.guildId || v.guildId === guildId) { pendingVideoQueue.splice(i, 1); return v; }
  }
  return null;
}

async function runVideoBrainCall(channelId: string, ch: TextChannel, guildId: string, title: string, url: string) {
  const msgs = stmGet(channelId);
  const last = msgs[msgs.length - 1];
  const relevantMem = await recallRelevant(guildId, title, 3);
  const params: UserPromptParams = {
    mode: 'new video', serverName: (ch as any).guild?.name || serverNameCache.get(guildId) || 'unknown',
    channelName: (ch as any).name || channelId.slice(-5),
    sender: last ? last.author : '(quiet)', bond: 50,
    message: last ? last.content : '(chat is quiet)',
    recentMsgs: msgs.slice(-BRAIN_CONTEXT_MSGS),
    sessionSummary: sessionSummaries.get(channelId) ?? '',
    relevantMemory: relevantMem, memberCtx: '',
    stalenessNote: '', goal: '', batchSize: 1, flags: [],
    videoCtx: { title, url },
  };
  let decision = await brain(SYSTEM_PROMPT, buildUserPrompt(params), PASSIVE_MODEL);
  decision = await executeBrainDecision({
    decision, systemPrompt: SYSTEM_PROMPT, userPromptParams: params,
    channel: ch, channelId, guildId, model: PASSIVE_MODEL,
  });
  await sendDecision({ channel: ch, decision, channelId, guildId });
  advanceMarker(channelId, msgs.map(m => m.id), decision);
}

export async function notifyNewVideo(videoId: string, title: string, url: string) {
  if (!botClient || !gemini.canCall()) return;
  if (notifiedVideoIds.has(videoId)) return;
  notifiedVideoIds.add(videoId);
  if (globallyMuted) {
    for (const guild of botClient.guilds.cache.values())
      if (!serverMuted.get(guild.id)) pendingVideoQueue.push({ videoId, title, url, queuedAt: Date.now(), guildId: guild.id });
    return;
  }
  for (const guild of botClient.guilds.cache.values()) {
    if (serverMuted.get(guild.id)) continue;
    try { await notifyNewVideoInGuild(videoId, title, url, guild.id); } catch (e) { console.error(`[NewVideo] ${guild.id}:`, e); }
  }
}

async function notifyNewVideoInGuild(videoId: string, title: string, url: string, guildId: string) {
  const channelId = pickInterestChannelForGuild(guildId);
  if (!channelId) { pendingVideoQueue.push({ videoId, title, url, queuedAt: Date.now(), guildId }); return; }
  const state = getChState(channelId);
  if (state.mode === 'active') { pendingVideoQueue.push({ videoId, title, url, queuedAt: Date.now(), guildId }); return; }
  const ch = botClient!.channels.cache.get(channelId) as TextChannel | undefined;
  if (!ch?.isTextBased()) { pendingVideoQueue.push({ videoId, title, url, queuedAt: Date.now(), guildId }); return; }
  const speakState = await getSpeakState(channelId, guildId);
  if (speakState.mode === 'paused' && speakState.resumeAt && Date.now() < speakState.resumeAt) {
    pendingVideoQueue.push({ videoId, title, url, queuedAt: Date.now(), guildId }); return;
  }
  await runVideoBrainCall(channelId, ch, guildId, title, url);
}

let videoSweepRunning = false;
async function runVideoSweep() {
  if (videoSweepRunning || !botClient || !gemini.canCall() || globallyMuted || !pendingVideoQueue.length) return;
  videoSweepRunning = true;
  try {
    const guildIds = new Set(pendingVideoQueue.map(v => v.guildId).filter((g): g is string => !!g));
    for (const guildId of guildIds) {
      if (serverMuted.get(guildId)) continue;
      const channelId = pickInterestChannelForGuild(guildId);
      if (!channelId) continue;
      if (getChState(channelId).mode === 'active') continue;
      const ch = botClient.channels.cache.get(channelId) as TextChannel | undefined;
      if (!ch?.isTextBased()) continue;
      const speakState = await getSpeakState(channelId, guildId).catch(() => ({ mode: 'active' as const, resumeAt: null }));
      if (speakState.mode === 'paused' && speakState.resumeAt && Date.now() < speakState.resumeAt) continue;
      const queued = dequeuePendingVideo(guildId);
      if (!queued) continue;
      try { await runVideoBrainCall(channelId, ch, guildId, queued.title, queued.url); }
      catch (e) { console.error(`[VideoSweep] ${guildId}:`, e); pendingVideoQueue.push(queued); }
    }
  } finally { videoSweepRunning = false; }
}

// ── BG PROFILER ───────────────────────────────────────────────────────
let bgProfilerLock = false;
let lastProfileAt  = 0;

async function runProfiler(client: Client) {
  if (Date.now() - lastProfileAt < PROFILER_INTERVAL || bgProfilerLock || !gemini.canCall()) return;
  lastProfileAt = Date.now();
  bgProfilerLock = true;
  try {
    for (const guild of client.guilds.cache.values()) {
      cacheServerName(guild.id, guild.name);
      for (const ch of guild.channels.cache.filter(c => c.isTextBased()).values()) {
        cacheChannelName(ch.id, (ch as any).name);
        notePlaceSeen(guild.id, guild.name, ch.id, (ch as any).name).catch(() => {});
        try {
          const fetched = await (ch as any).messages.fetch({ limit: 15 });
          const msgs = ([...fetched.values()] as Message[]).reverse();
          seedSTM(ch.id, msgs);
          const byAuthor = new Map<string, string[]>();
          for (const m of msgs) {
            if (m.author.bot || !m.content.trim()) continue;
            cacheId(m.author.id, m.member?.displayName || m.author.username);
            upsertMember(guild.id, m.author.id, { displayName: m.member?.displayName || m.author.username, username: m.author.username }).catch(() => {});
            if (!byAuthor.has(m.author.id)) byAuthor.set(m.author.id, []);
            byAuthor.get(m.author.id)!.push(m.content.slice(0, 80));
          }
          for (const [uid, lines] of byAuthor) {
            const existing = await getMember(guild.id, uid);
            if (existing.personality) continue;
            const name = idCache.get(uid) || uid;
            try {
              const raw = await gemini.call(
                'one-line personality read from discord messages. output ONLY: {"p":"..."}',
                `${name}: ${lines.slice(0, 6).join(' | ')}`,
                0.4, BG_MODEL, [], 100,
              );
              const p = JSON.parse((raw.match(/\{[\s\S]*\}/) ?? ['{}'])[0]);
              if (p.p) upsertMember(guild.id, uid, { personality: p.p }).catch(() => {});
            } catch {}
          }
        } catch {}
      }
    }
    console.log('[Profiler] done');
  } finally { setTimeout(() => { bgProfilerLock = false; }, 30_000); }
}

// ── DM HANDLER ───────────────────────────────────────────────────────
const dmDebounce = new Map<string, NodeJS.Timeout>();
const dmPending  = new Map<string, Message>();

async function handleDirectMessage(msg: Message) {
  const channelId = msg.channelId;
  cacheId(msg.author.id, msg.author.username);
  if (wwtCurrentTargetUserId === msg.author.id) clearWwtHop(msg.author.id);
  if (!stmStore.has(channelId)) {
    try {
      const fetched = await msg.channel.messages.fetch({ limit: 20 });
      seedSTM(channelId, ([...fetched.values()] as Message[]).reverse());
    } catch {}
  }
  const content = await buildEnrichedContent(msg, cleanContent(msg.content));
  stmPush(channelId, { ts: msg.createdTimestamp, id: msg.id, authorId: msg.author.id, author: msg.author.username, content: content.slice(0, 300) });
  dmPending.set(channelId, msg);
  if (dmDebounce.has(channelId)) clearTimeout(dmDebounce.get(channelId)!);
  dmDebounce.set(channelId, setTimeout(() => {
    dmDebounce.delete(channelId);
    const trigger = dmPending.get(channelId);
    dmPending.delete(channelId);
    if (trigger) setTimeout(() => respondToDM(trigger).catch(e => console.error('[DM]', e)), Math.random() * 500);
  }, DM_DEBOUNCE_MS));
}

async function respondToDM(msg: Message) {
  if (!gemini.canCall()) return;
  const channelId = msg.channelId;
  const sender    = msg.author.username;
  const content   = await buildEnrichedContent(msg, cleanContent(msg.content));
  const images    = await collectImages([msg]);
  const msgs      = stmGet(channelId);
  const recentSub = msgs.slice(-12);
  const botReplied   = recentSub.some(m => m.authorId === BOT_ID);
  const senderCount  = recentSub.filter(m => m.authorId === msg.author.id).length;
  const endingConvo  = /\b(bye|cya|gotta go|gtg|see ya|later|gn|logging off|ttyl|im out)\b/i.test(content);
  const flags: string[] = ['DM'];
  if (botReplied && senderCount >= 2) flags.push('mid-exchange');
  if (endingConvo) flags.push('wrapping up');

  const params: UserPromptParams = {
    mode: 'dm', serverName: 'DM', channelName: 'dm',
    sender, bond: 50, message: content,
    recentMsgs: msgs.slice(-BRAIN_CONTEXT_MSGS),
    sessionSummary: sessionSummaries.get(channelId) ?? '',
    relevantMemory: '', memberCtx: '',
    stalenessNote: '', goal: '', batchSize: 1, flags, images,
  };

  let decision = await brain(SYSTEM_PROMPT, buildUserPrompt(params), ACTIVE_MODEL, images);
  decision = await executeBrainDecision({
    decision, systemPrompt: SYSTEM_PROMPT, userPromptParams: params,
    channel: msg.channel, replyToMsg: msg, channelId, guildId: 'dm', model: ACTIVE_MODEL,
  });
  await sendDecision({ channel: msg.channel, decision, channelId, guildId: 'dm', replyToMsg: msg });
  advanceMarker(channelId, msgs.map(m => m.id), decision);
  maybeUpdateSessionSummary(channelId, 'dm').catch(() => {});
}

// ── ACTIVE-MODE BATCHING ──────────────────────────────────────────────
interface QueuedMsg { msg: Message; mentioned: boolean; everyonePing: boolean; content: string; }
const inFlight    = new Set<string>();
const activeQueue = new Map<string, QueuedMsg[]>();

function enqueueActive(channelId: string, guildId: string, item: QueuedMsg) {
  if (!activeQueue.has(channelId)) activeQueue.set(channelId, []);
  activeQueue.get(channelId)!.push(item);
  if (!inFlight.has(channelId)) drainActiveQueue(channelId, guildId).catch(e => console.error('[Drain]', e));
}

async function drainActiveQueue(channelId: string, guildId: string) {
  inFlight.add(channelId);
  try {
    while (true) {
      const batch = activeQueue.get(channelId) ?? [];
      activeQueue.set(channelId, []);
      if (!batch.length) break;
      await processActiveBatch(channelId, guildId, batch);
    }
  } finally { inFlight.delete(channelId); }
}

async function processActiveBatch(channelId: string, guildId: string, batch: QueuedMsg[]) {
  const last = batch[batch.length - 1].msg;
  const speakState = await getSpeakState(channelId, guildId);
  const anyMentioned = batch.some(b => b.mentioned);
  if (speakState.mode === 'paused' && speakState.resumeAt && Date.now() < speakState.resumeAt && !anyMentioned) return;
  if (!gemini.canCall()) return;

  const sender      = last.member?.displayName || last.author.username;
  const content     = batch[batch.length - 1].content;
  const channelName = (last.channel as any).name ?? 'unknown';
  const serverName  = last.guild?.name || serverNameCache.get(guildId) || 'unknown';
  const everyonePing = batch.some(b => b.everyonePing);
  const images      = await collectImages(batch.map(b => b.msg));

  // ── CONVERSATION CLASSIFICATION ─────────────────────────────────────
  // This is the key gate — prevents brain calls for pair convos and shut-outs.
  const msgs = stmGet(channelId);
  const convType = classifyConversation(msgs, BOT_ID, anyMentioned, false, last.author.id);

  if (convType === 'pair_private') {
    // Two people talking to each other — stay out entirely
    console.log(`[Classifier] pair_private in #${channelName} — staying out`);
    touchActivity(channelId); return;
  }

  if (convType === 'bot_shut_out') {
    // Someone explicitly told the bot to stop — drop to passive
    console.log(`[Classifier] shut out in #${channelName} — reverting to passive`);
    revertToPassive(channelId, 'shut out');
    touchActivity(channelId); return;
  }

  // ── SHORT-CIRCUIT: bot spoke very recently, not mentioned ────────────
  const state = getChState(channelId);
  const secsSinceSpoke = state.lastBotMsgAt ? (Date.now() - state.lastBotMsgAt) / 1000 : null;
  if (!anyMentioned && secsSinceSpoke !== null && secsSinceSpoke < 20) {
    console.log(`[Active] skipping — spoke ${Math.round(secsSinceSpoke)}s ago, not mentioned`);
    touchActivity(channelId); return;
  }

  // ── SHORT-CIRCUIT: very short message, not mentioned, not engaged ────
  if (!anyMentioned && convType === 'open_channel' && content.trim().split(/\s+/).length <= 3 && secsSinceSpoke !== null && secsSinceSpoke < 60) {
    touchActivity(channelId); return;
  }

  const [memberData, relevantMem] = await Promise.all([
    getMember(guildId, last.author.id),
    recallRelevant(guildId, content, 4),
  ]);
  const bond = typeof memberData.bond === 'number' ? memberData.bond : 50;
  const recentSub = msgs.slice(-12);
  const botReplied  = recentSub.some(m => m.authorId === BOT_ID);
  const senderCount = recentSub.filter(m => m.authorId === last.author.id).length;
  const endingConvo = /\b(bye|cya|gotta go|gtg|see ya|later|gn|logging off|ttyl|im out)\b/i.test(content);
  const unprompted = !anyMentioned && !everyonePing && convType !== 'engaged';
  const activeEvent = serverEvents.get(guildId);
  const eventCtx = activeEvent?.phase === 'open'
    ? ` | event:${activeEvent.type} (${Math.max(0, Math.round((activeEvent.endsAt - Date.now()) / 1000))}s, ${activeEvent.entries.length} entries)`
    : '';

  const flags: string[] = [];
  if (anyMentioned) flags.push('pinged directly');
  if (convType === 'engaged') flags.push('mid-exchange');
  if (everyonePing) flags.push('@everyone');
  if (endingConvo) flags.push('wrapping up');

  // Build member context for the people who've spoken recently
  const senderIds = [...new Set(msgs.slice(-8).map(m => m.authorId))];
  const memberCtx = await buildMemberCtx(guildId, senderIds);

  const params: UserPromptParams = {
    mode: `active${eventCtx}`, serverName, channelName,
    sender, bond, message: content,
    recentMsgs: msgs.slice(-BRAIN_CONTEXT_MSGS),
    sessionSummary: sessionSummaries.get(channelId) ?? '',
    relevantMemory: relevantMem, memberCtx,
    stalenessNote: detectStaleBits(channelId) ?? '',
    goal: state.goal, batchSize: batch.length, flags, images,
    selfNote: (!anyMentioned && secsSinceSpoke !== null && secsSinceSpoke < 40)
      ? `you spoke ${Math.round(secsSinceSpoke)}s ago already — be extra reluctant to reply again unless something genuinely new happened`
      : undefined,
  };

  let decision = await brain(SYSTEM_PROMPT, buildUserPrompt(params), ACTIVE_MODEL, images);
  console.log(`[Brain] ${sender}: ${decision.action}${decision.reply ? ` — "${decision.reply.slice(0, 50)}"` : ''}`);

  decision = await executeBrainDecision({
    decision, systemPrompt: SYSTEM_PROMPT, userPromptParams: params,
    channel: last.channel, replyToMsg: last, channelId, guildId, model: ACTIVE_MODEL,
  });

  if (decision.action === 'ignore') state.consecutiveUnpromptedReplies = 0;
  else if (unprompted) state.consecutiveUnpromptedReplies++;

  // Resolve which message to thread on
  const targetMsg = (() => {
    if (!decision.replyToMsgId) return undefined;
    const found = batch.find(b => b.msg.id === decision.replyToMsgId);
    return found?.msg ?? undefined;
  })();

  await sendDecision({ channel: last.channel, decision, channelId, guildId, replyToMsg: targetMsg });
  advanceMarker(channelId, msgs.map(m => m.id), decision);

  // After every message, extract social signals and update session summary
  extractSocialSignals(content, sender, guildId).catch(() => {});
  maybeLogHistory(channelId, guildId).catch(() => {});
  maybeUpdateSessionSummary(channelId, guildId).catch(() => {});
}

// ── DEDUP GUARD ───────────────────────────────────────────────────────
const seenMessageIds = new Set<string>();
function alreadyHandled(id: string): boolean {
  if (seenMessageIds.has(id)) return true;
  seenMessageIds.add(id);
  if (seenMessageIds.size > 2000) {
    const first = seenMessageIds.values().next().value;
    if (first !== undefined) seenMessageIds.delete(first);
  }
  return false;
}

// ── ADMIN NATURAL-LANGUAGE ALIASES ────────────────────────────────────
const ADMIN_NL: { re: RegExp; cmd: string }[] = [
  { re: /\b(go quiet|be quiet|stop talking|shut up|mute yourself)\b/i,          cmd: '!stop' },
  { re: /\b(start talking again|come back|talk again|unmute yourself)\b/i,      cmd: '!resume' },
  { re: /\blisten to\s+<@!?\d+>/i,                                              cmd: '!listenbot' },
  { re: /\b(ignore|stop listening to)\s+<@!?\d+>/i,                             cmd: '!ignorebot' },
  { re: /\b(only (talk|listen|respond)|restrict).*\b(here|this channel)\b/i,    cmd: '!listenhere' },
  { re: /\b(stop (talking|listening)).*\b(here|this channel)\b/i,               cmd: '!unlisten' },
  { re: /\b(everywhere|every channel|reset channels?)\b/i,                      cmd: '!listenall' },
  { re: /\b(what|which) channels?\b/i,                                           cmd: '!channels' },
  { re: /\b(what can (you|i) do|show.*commands|list commands)\b/i,              cmd: '!help' },
];

function resolveAdminCommand(content: string, isAdmin: boolean): string | null {
  const trimmed = content.trim();
  const BANG = ['!stop','!resume','!start','!listenbot','!ignorebot','!bots','!listenhere','!unlisten','!listenall','!channels','!help'];
  for (const b of BANG) if (trimmed === b || trimmed.startsWith(b + ' ')) return b === '!start' ? '!resume' : b;
  if (!isAdmin) return null;
  for (const { re, cmd } of ADMIN_NL) if (re.test(trimmed)) return cmd;
  return null;
}

// ── GUILD MESSAGE HANDLER ─────────────────────────────────────────────
async function handleMessage(msg: Message) {
  if (msg.partial) { try { msg = await msg.fetch(); } catch { return; } }
  if (!msg.content?.trim()) return;
  if (msg.author.id === BOT_ID) return;
  if (msg.author.bot) {
    if (msg.channel.isDMBased()) return;
    const allowed = serverBotAllowlist.get(msg.guildId!);
    if (!allowed || !allowed.has(msg.author.id)) return;
  }
  if (alreadyHandled(msg.id)) return;

  // Easter egg
  if (msg.content.trim().toLowerCase() === 'wiki waka tiki') {
    msg.author.send('tiki waka wiki').catch(() => {
      if (!msg.channel.isDMBased()) msg.reply("tiki waka wiki (couldn't dm you)").catch(() => {});
    });
    return;
  }

  if (msg.channel.isDMBased()) return handleDirectMessage(msg);

  const guildId = msg.guildId!;
  const rawCmd  = msg.content.trim();
  const isAdmin = !!msg.member?.permissions.has(PermissionFlagsBits.Administrator);
  const cmd     = resolveAdminCommand(rawCmd, isAdmin) ?? rawCmd;

  // ── per-server admin commands ───────────────────────────────────────
  if ((cmd === '!stop' || cmd === '!resume') && isAdmin) {
    const muting = cmd === '!stop';
    serverMuted.set(guildId, muting);
    db.collection('servers').doc(guildId).set({ botMuted: muting }, { merge: true }).catch(() => {});
    msg.reply(muting ? 'going quiet here. any admin can !resume me' : 'back 🫡').catch(() => {});
    return;
  }

  if ((cmd === '!listenbot' || cmd === '!ignorebot' || cmd === '!bots') && isAdmin) {
    if (cmd === '!bots') {
      const allowed = serverBotAllowlist.get(guildId);
      msg.reply(allowed?.size ? `bots i'll hear: ${[...allowed].map(id => `<@${id}>`).join(', ')}` : "not listening to any bots — say \"listen to @bot\" to add one").catch(() => {});
      return;
    }
    const target = msg.mentions.users.first();
    if (!target?.bot) { msg.reply('mention the bot you mean').catch(() => {}); return; }
    const set = serverBotAllowlist.get(guildId) ?? new Set<string>();
    if (cmd === '!listenbot') set.add(target.id); else set.delete(target.id);
    if (set.size) serverBotAllowlist.set(guildId, set); else serverBotAllowlist.delete(guildId);
    db.collection('servers').doc(guildId).set({ allowedBotIds: [...set] }, { merge: true }).catch(() => {});
    msg.reply(cmd === '!listenbot' ? `ok, hearing ${target.username} now` : `done, ignoring ${target.username}`).catch(() => {});
    return;
  }

  if ((cmd === '!listenhere' || cmd === '!unlisten' || cmd === '!listenall' || cmd === '!channels') && isAdmin) {
    if (cmd === '!channels') {
      const allowed = serverChannelAllowlist.get(guildId);
      msg.reply(allowed?.size ? `listening in: ${[...allowed].map(id => `<#${id}>`).join(', ')}` : 'listening everywhere (default)').catch(() => {});
      return;
    }
    if (cmd === '!listenall') {
      serverChannelAllowlist.delete(guildId);
      db.collection('servers').doc(guildId).set({ allowedChannelIds: [] }, { merge: true }).catch(() => {});
      msg.reply('back to listening everywhere').catch(() => {});
      return;
    }
    const set = serverChannelAllowlist.get(guildId) ?? new Set<string>();
    if (cmd === '!listenhere') set.add(msg.channelId); else set.delete(msg.channelId);
    serverChannelAllowlist.set(guildId, set);
    db.collection('servers').doc(guildId).set({ allowedChannelIds: [...set] }, { merge: true }).catch(() => {});
    msg.reply(cmd === '!listenhere' ? `locked in here` : `dropped this channel`).catch(() => {});
    return;
  }

  if (cmd === '!help' && isAdmin) {
    msg.reply([
      'you can just say this stuff naturally, or:',
      '• "go quiet" / !stop — mute me here',
      '• "talk again" / !resume — unmute me',
      '• "listen to @bot" / !listenbot @bot — hear a bot',
      '• "ignore @bot" / !ignorebot @bot — stop',
      '• !bots — which bots i hear',
      '• "only talk here" / !listenhere — scope me to this channel',
      '• "stop talking here" / !unlisten',
      '• "listen everywhere" / !listenall',
      '• !channels — where i\'m scoped',
      `\ni'm ${whereAmI()} right now.`,
    ].join('\n')).catch(() => {});
    return;
  }

  if (globallyMuted) return;
  if (serverMuted.get(guildId)) return;
  const allowedChannels = serverChannelAllowlist.get(guildId);
  if (allowedChannels && !allowedChannels.has(msg.channelId)) return;

  // Reset proactive backoff when someone talks
  const ps = proactiveStates.get(msg.channelId);
  if (ps?.lostInterest || (ps?.strikes ?? 0) > 0)
    proactiveStates.set(msg.channelId, { lastAt: 0, strikes: 0, lostInterest: false });

  try {
    const channelId   = msg.channelId;
    const channelName = (msg.channel as any).name ?? 'unknown';

    // User commands (no brain needed)
    if (rawCmd === '!rank') {
      const data  = await getUserXPData(guildId, msg.author.id);
      const board = await getLeaderboard(guildId, 100);
      const rank  = board.findIndex(e => e.userId === msg.author.id) + 1;
      msg.reply(`${data.xp} XP | level ${data.level} (${getLevelName(data.level)}) | ${rank > 0 ? `#${rank}` : 'not ranked yet'}`).catch(() => {});
      return;
    }
    if (rawCmd === '!top') {
      const board = await getLeaderboard(guildId, 5);
      if (!board.length) { msg.reply('nobody has XP yet').catch(() => {}); return; }
      msg.reply(board.map((e, i) => `${i + 1}. ${e.username} — ${e.xp} XP (lv${e.level})`).join('\n')).catch(() => {});
      return;
    }

    const mentioned   = BOT_ID ? msg.mentions.has(BOT_ID) : false;
    const everyonePing = msg.mentions.everyone ?? false;
    const sender      = msg.member?.displayName || msg.author.username;
    const content     = await buildEnrichedContent(msg, cleanContent(msg.content));

    cacheId(msg.author.id, sender);
    notePlaceSeen(guildId, msg.guild?.name, channelId, channelName).catch(() => {});
    noteMemberSeen(guildId, msg.author.id, sender, msg.author.username).catch(() => {});
    trackInterest(channelId, mentioned);

    if (!stmStore.has(channelId)) {
      try {
        const fetched = await msg.channel.messages.fetch({ limit: STM_MAX });
        seedSTM(channelId, ([...fetched.values()] as Message[]).reverse());
      } catch {}
    }

    stmPush(channelId, {
      ts: msg.createdTimestamp, id: msg.id, authorId: msg.author.id, author: sender,
      content: content.slice(0, 300),
    });

    const state = getChState(channelId);
    if (state.lastBotMsgAt) state.gotResponseSinceLastBotMsg = true;
    touchActivity(channelId);

    // Event entry collection
    const ev = serverEvents.get(guildId);
    if (ev?.phase === 'open') {
      const memberName = msg.member?.displayName ?? msg.author.username;
      const added = tryAddEventEntry(guildId, msg.author.id, memberName, content);
      if (added && ev.type === 'trivia' && ev.answer && content.toLowerCase().includes(ev.answer)) {
        clearTimeout(ev.timerId);
        judgeEvent(guildId).catch(() => {});
      }
    }

    if (mentioned && state.mode !== 'active') goActive(channelId, 'got pinged');

    if (mentioned || state.mode === 'active') {
      enqueueActive(channelId, guildId, { msg, mentioned, everyonePing, content });
    }
  } catch (e) { console.error('[Handler]', e); }
}

// ── STARTUP ───────────────────────────────────────────────────────────
export async function startBot(token: string) {
  if (botClient) return;

  botClient = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.DirectMessageReactions,
      GatewayIntentBits.DirectMessageTyping,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildPresences,
      GatewayIntentBits.GuildMessageReactions,
    ],
    partials: [Partials.Message, Partials.Channel, Partials.User, Partials.Reaction],
  });

  botClient.on(Events.ClientReady, async () => {
    BOT_NAME = botClient!.user!.username;
    BOT_ID   = botClient!.user!.id;
    cacheId(BOT_ID, BOT_NAME);

    console.log(`
╔══════════════════════════════════════════════════════╗
║  ✓ ${BOT_NAME} — ready
║  ACTIVE  : ${ACTIVE_MODEL}
║  PASSIVE : ${PASSIVE_MODEL}
║  BG      : ${BG_MODEL}
║  KEYS    : ${gemini.status()}
║  STM     : ${STM_MAX} msgs (brain sees last ${BRAIN_CONTEXT_MSGS} + rolling summary)
╚══════════════════════════════════════════════════════╝\n`);

    botClient!.user!.setPresence({ status: 'online', activities: [{ name: 'the chat', type: 3 }] });

    for (const g of botClient!.guilds.cache.values()) {
      cacheServerName(g.id, g.name);
      db.collection('servers').doc(g.id).set({ name: g.name, updatedAt: new Date().toISOString() }, { merge: true }).catch(() => {});
      try {
        const snap = await db.collection('servers').doc(g.id).get();
        const data = snap.data();
        if (data?.botMuted) serverMuted.set(g.id, true);
        if (Array.isArray(data?.allowedBotIds) && data.allowedBotIds.length)
          serverBotAllowlist.set(g.id, new Set(data.allowedBotIds));
        if (Array.isArray(data?.allowedChannelIds) && data.allowedChannelIds.length)
          serverChannelAllowlist.set(g.id, new Set(data.allowedChannelIds));
      } catch {}
      for (const ch of g.channels.cache.filter(c => c.isTextBased()).values())
        cacheChannelName(ch.id, (ch as any).name);
      const members = await g.members.fetch().catch(() => null);
      if (members) {
        for (const [uid, m] of members) {
          if (m.user.bot) continue;
          cacheId(uid, m.displayName);
          upsertMember(g.id, uid, { displayName: m.displayName, username: m.user.username }).catch(() => {});
        }
        console.log(`[Boot] synced ${members.size} members — "${g.name}"`);
      }
      // warm idCache from Firebase
      try {
        const snap = await db.collection('servers').doc(g.id).collection('members').get();
        let w = 0;
        for (const doc of snap.docs) {
          const d = doc.data() as MemberData;
          const name = d.displayName || d.username;
          if (name && !idCache.has(doc.id)) { cacheId(doc.id, name); w++; }
        }
        if (w) console.log(`[Boot] warmed ${w} past members — "${g.name}"`);
      } catch {}
    }

    // Start background loops
    setTimeout(() => {
      if (botClient) runProfiler(botClient).catch(() => {});
      setInterval(() => { if (botClient) runProfiler(botClient).catch(() => {}); }, PROFILER_INTERVAL);
    }, 30 * 60_000);

    setInterval(() => runPassiveTick().catch(() => {}),       PASSIVE_TICK_MS);
    setInterval(() => runVideoSweep().catch(() => {}),         VIDEO_SWEEP_MS);
    setInterval(() => runSelfCheck().catch(() => {}),           PASSIVE_TICK_MS);
    setInterval(() => runProactiveEngagement().catch(() => {}), PASSIVE_TICK_MS);
    setInterval(() => runWikiWakaTiki().catch(() => {}),        WWT_SWEEP_INTERVAL_MS);
    setInterval(() => runWeeklyNPC().catch(() => {}),           60 * 60_000);

    if (YT_CLIENT_ID && YT_CLIENT_SECRET && YT_REFRESH_TOKEN) {
      runYtPoll().catch(() => {});
      setInterval(() => runYtPoll().catch(() => {}), YT_POLL_MS);
      console.log(`[YtPoll] watching for new uploads every ${YT_POLL_MS / 60_000}m`);
    }
  });

  botClient.on(Events.MessageCreate, handleMessage);

  botClient.on(Events.GuildCreate, async (guild) => {
    console.log(`[Join] "${guild.name}" (${guild.id})`);
    cacheServerName(guild.id, guild.name);
    db.collection('servers').doc(guild.id).set({ name: guild.name, updatedAt: new Date().toISOString() }, { merge: true }).catch(() => {});
    const target = (guild.systemChannel?.permissionsFor(guild.members.me!)?.has(PermissionFlagsBits.SendMessages))
      ? guild.systemChannel
      : guild.channels.cache.find(c => c.isTextBased() && !c.isDMBased() && (c as any).permissionsFor(guild.members.me!)?.has(PermissionFlagsBits.SendMessages)) as TextChannel | undefined;
    if (target) target.send(`sup 👋 talk to me normally. server admins can say "go quiet", "only talk here", etc. — or !help for the full list.`).catch(() => {});
  });

  botClient.on(Events.GuildDelete, (guild) => {
    console.log(`[Leave] "${guild.name || guild.id}"`);
    serverMuted.delete(guild.id);
    serverBotAllowlist.delete(guild.id);
    serverChannelAllowlist.delete(guild.id);
  });

  botClient.on(Events.GuildMemberAdd, async (m) => {
    if (m.user.bot) return;
    cacheId(m.id, m.displayName);
    upsertMember(m.guild.id, m.id, { displayName: m.displayName, username: m.user.username }).catch(() => {});
  });

  botClient.on(Events.GuildMemberUpdate, async (_, m) => {
    if (m.user.bot) return;
    cacheId(m.id, m.displayName);
    upsertMember(m.guild.id, m.id, { displayName: m.displayName }).catch(() => {});
  });

  // ── ADMIN COMMANDS (owner only) ─────────────────────────────────────
  botClient.on(Events.MessageCreate, async (msg) => {
    if (msg.author.id !== ADMIN_ID) return;
    const c       = msg.content.trim();
    const guildId = msg.guildId ?? 'dm';
    const chId    = msg.channelId;

    if (c === '!wake')    { await setSpeakState(chId, guildId, { mode: 'active',  reason: 'admin' }); msg.reply('up').catch(() => {}); }
    if (c === '!sleep')   { await setSpeakState(chId, guildId, { mode: 'waiting', reason: 'admin' }); msg.reply('going quiet').catch(() => {}); }
    if (c.startsWith('!pause ')) {
      const mins = parseInt(c.split(' ')[1]) || 10;
      await setSpeakState(chId, guildId, { mode: 'paused', resumeAt: Date.now() + mins * 60_000, reason: 'admin' });
      msg.reply(`paused ${mins}m`).catch(() => {});
    }
    if (c.startsWith('!active')) { goActive(chId, 'admin'); msg.reply('active').catch(() => {}); }
    if (c === '!passive') { revertToPassive(chId, 'admin'); msg.reply('passive').catch(() => {}); }
    if (c === '!status') {
      const st    = getChState(chId);
      const speak = await getSpeakState(chId, guildId);
      const mk    = getMarker(chId);
      msg.reply([
        `global: ${globallyMuted ? '🔇 muted' : '🟢 live'}`,
        `mode: ${st.mode}${st.goal ? ` (${st.goal})` : ''}`,
        `speak: ${speak.mode}${speak.resumeAt ? ` until ${new Date(speak.resumeAt).toLocaleTimeString()}` : ''}`,
        `focus: ${focus?.channelId === chId ? 'yes' : 'no'}`,
        `marker: ${mk.markerId?.slice(-6) ?? 'none'}`,
        `keys: ${gemini.status()}`,
        `summary: ${sessionSummaries.get(chId)?.slice(0, 100) ?? 'none'}`,
      ].join('\n')).catch(() => {});
    }
    if (c === '!memory') {
      const m = await getMemory(guildId);
      msg.reply([
        `facts(${m.facts.length}): ${m.facts.slice(-4).join(' | ') || 'none'}`,
        `loops(${m.openLoops.length}): ${m.openLoops.slice(-4).join(' | ') || 'none'}`,
        `patterns(${m.patterns.length}): ${m.patterns.slice(-4).join(' | ') || 'none'}`,
        `jokes(${m.jokes.length}): ${m.jokes.slice(-3).join(' | ') || 'none'}`,
      ].join('\n')).catch(() => {});
    }
    if (c.startsWith('!remember '))  { await addFact(guildId, c.slice(10).trim()); msg.reply('noted').catch(() => {}); }
    if (c === '!stm')   { msg.reply(`\`\`\`\n${formatMsgs(stmGet(chId)).slice(0, 1900)}\n\`\`\``).catch(() => {}); }
    if (c === '!summary') { msg.reply(sessionSummaries.get(chId) || 'no summary yet').catch(() => {}); }
    if (c === '!scan')  { msg.reply('scanning...').catch(() => {}); await runPassiveTick().catch(() => {}); msg.reply('done').catch(() => {}); }
    if (c === '!budget'){ msg.reply(gemini.status()).catch(() => {}); }
    if (c.startsWith('!who ')) {
      const uid = msg.mentions.users.first()?.id || c.split(' ')[1]?.trim();
      if (!uid) { msg.reply('!who @user').catch(() => {}); return; }
      const m = await getMember(guildId, uid);
      msg.reply(`${m.displayName || uid} | bond:${m.bond ?? 50} | ${m.personality || '(no profile yet)'}`).catch(() => {});
    }
    if (c === '!history') {
      const logs = await getHistory(chId, Date.now() - 24 * 60 * 60_000, Date.now());
      msg.reply(logs.slice(0, 1900) || 'no logs').catch(() => {});
    }
    if (c.startsWith('!testvideo')) {
      const title = c.slice(10).trim() || 'test upload';
      msg.reply(`firing notifyNewVideo...`).catch(() => {});
      await notifyNewVideo(`test-${Date.now()}`, title, 'https://youtu.be/test').catch(() => {});
    }
    if (c === '!gmute') {
      globallyMuted = true;
      msg.reply('going quiet everywhere. !gresume to bring me back').catch(() => {});
    }
    if (c === '!gresume' || c === '!gstart') {
      globallyMuted = false;
      msg.reply('back globally 🫡').catch(() => {});
    }
    if (c === '!wwt') {
      const quietMin = (msSinceAnyGuildActivity() / 60_000).toFixed(1);
      msg.reply(`quiet:${quietMin}m | target:${wwtCurrentTargetUserId ? idCache.get(wwtCurrentTargetUserId) || wwtCurrentTargetUserId : 'none'} | forcing sweep...`).catch(() => {});
      const prev = wwtCurrentTargetUserId;
      wwtCurrentTargetUserId = null;
      await runWikiWakaTiki().catch(() => {});
      if (!wwtCurrentTargetUserId) wwtCurrentTargetUserId = prev;
      msg.reply('done').catch(() => {});
    }
    if (c === '!shutdown') {
      msg.reply('shutting down 💀').catch(() => {});
      stopBot();
    }
  });

  await botClient.login(token);
}

export function stopBot() { botClient?.destroy(); botClient = null; globallyMuted = false; }
export function getBotStatus() { return !botClient ? 'stopped' : globallyMuted ? 'muted' : 'running'; }
