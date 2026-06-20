import {
  Client, GatewayIntentBits, Message, Partials,
  Events, TextChannel,
} from 'discord.js';
import { db } from './firebase.ts';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// ── MODELS ───────────────────────────────────────────────────────
const ACTIVE_MODEL  = 'gemini-3.1-flash-lite'; // every msg while engaged + ping triage — fast, cheap, decides like a human would
const PASSIVE_MODEL = 'gemma-4-26b-a4b-it';    // 5-min huge-context scan of the channel it's interested in — slower, thinks it through
const BG_MODEL      = 'gemma-4-31b-it';        // profiler / compress / history-log utility jobs (unrelated to the convo loop)

// ── GEMINI MANAGER ────────────────────────────────────────────────
class GeminiManager {
  private keys: string[];
  private idx = 0;
  private cooldowns = new Map<string, number>();

  constructor() {
    const raw = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '';
    this.keys = raw.split(',').map(k => k.trim()).filter(Boolean);
    if (!this.keys.length) console.error('[Gemini] no keys found in GEMINI_API_KEYS');
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
    let best = this.keys[0], bestCd = Infinity;
    for (const k of this.keys) {
      const cd = this.cooldowns.get(k) ?? 0;
      if (cd < bestCd) { bestCd = cd; best = k; }
    }
    return best;
  }

  // no maxOutputTokens cap — let the model finish its thought. responseMimeType still
  // forces JSON so it can't ramble into prose, that's the only constraint we keep.
  async call(
    systemPrompt: string,
    userPrompt: string,
    temp = 0.9,
    model = ACTIVE_MODEL,
  ): Promise<string> {
    for (let attempt = 0; attempt < Math.max(this.keys.length, 1) * 2; attempt++) {
      const key = this.pickKey();
      if (!key) throw new Error('[Gemini] no keys available');
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: systemPrompt }] },
              contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
              generationConfig: { temperature: temp, responseMimeType: 'application/json' },
            }),
          }
        );
        if (res.status === 429) {
          const body = await res.json().catch(() => ({})) as any;
          const retryMs = ((body?.error?.details?.[0]?.retryDelay?.seconds ?? 10) as number) * 1000;
          this.cooldowns.set(key, Date.now() + retryMs);
          console.warn(`[Gemini] ...${key.slice(-4)} 429 — cd ${retryMs / 1000}s`);
          continue;
        }
        if (!res.ok) {
          const err = await res.text().catch(() => res.statusText);
          throw new Error(`Gemini ${res.status}: ${err.slice(0, 120)}`);
        }
        const data = await res.json() as any;
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
        console.log(`[Gemini:${model}] key=...${key.slice(-4)} | ${text.length}ch`);
        return text;
      } catch (e: any) {
        if (e.message?.includes('429')) continue;
        console.error(`[Gemini] attempt ${attempt + 1}: ${e.message?.slice(0, 80)}`);
        if (attempt < Math.max(this.keys.length, 1) * 2 - 1)
          await sleep(Math.min(1500 * 2 ** attempt, 10_000));
      }
    }
    throw new Error('[Gemini] all attempts failed');
  }

  canCall(): boolean { return this.keys.length > 0; }

  // public accessor so other managers (embeddings) can share the same key pool
  // without reaching into the private rotation state directly.
  getKey(): string | null { return this.pickKey(); }

  status(): string {
    const now = Date.now();
    const keys = this.keys.map(k =>
      `...${k.slice(-4)}${(this.cooldowns.get(k) ?? 0) > now
        ? ` (cd ${Math.ceil(((this.cooldowns.get(k) ?? 0) - now) / 1000)}s)` : ''}`
    ).join(' | ');
    return `gemini: ${this.keys.length} key(s) | ${keys || 'none'}`;
  }
}

const gemini = new GeminiManager();

// ── EMBEDDING MANAGER (Google text-embedding-004, same key pool as Gemini) ──
// used for semantic memory recall — turns facts/jokes/arcs into vectors so
// "remember the thing about X" can match by MEANING, not exact substring.
const EMBED_MODEL = 'text-embedding-004';

class EmbeddingManager {
  // reuses gemini's key list — same Google AI Studio keys work for both endpoints.
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
      if (!res.ok) {
        console.warn(`[Embed] ${res.status}: ${(await res.text().catch(() => '')).slice(0, 100)}`);
        return null;
      }
      const data = await res.json() as any;
      const vec = data?.embedding?.values;
      return Array.isArray(vec) ? vec : null;
    } catch (e: any) {
      console.warn('[Embed] failed:', e.message?.slice(0, 80));
      return null;
    }
  }

  cosineSim(a: number[], b: number[]): number {
    if (a.length !== b.length || !a.length) return 0;
    let dot = 0, magA = 0, magB = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; magA += a[i] ** 2; magB += b[i] ** 2; }
    if (!magA || !magB) return 0;
    return dot / (Math.sqrt(magA) * Math.sqrt(magB));
  }
}

const embedder = new EmbeddingManager();

// ── CONSTANTS ────────────────────────────────────────────────────
// note: no DEBOUNCE_MS / PASSIVE_EVERY / VELOCITY / MONOPOLY / MIN_BRAIN_GAP anymore —
// those were hard, code-level skip rules. the model decides skip/speak/react itself now.
const DM_DEBOUNCE_MS        = 1000;        // still useful: catches someone typing in 2 bursts
const STM_MAX               = 200;         // huge context, not truncated per-call anymore
const SESSION_BUFFER_MAX    = 300;
const GAP_MAJOR_MS          = 25 * 60_000; // just display formatting in the transcript
const GAP_MINOR_MS          =  5 * 60_000;
const PASSIVE_TICK_MS       = 5  * 60_000; // how often the passive scan runs
const SELF_CHECK_QUIET_MS   = 4  * 60_000; // how long it waits before noticing it got ghosted
const ACTIVE_IDLE_REVERT_MS = 25 * 60_000; // safety net: dead-silent active channel quietly drops to passive
const PROFILER_INTERVAL     = 25 * 60_000;
const COMPRESS_INTERVAL     = 60 * 60_000;
const PAUSE_MAX_MINS        = 30;
const HISTORY_LOG_EVERY     = 30;
const FOCUS_DRIFT_MS        = 12 * 60_000;
const FOCUS_SHIFT_COST      = 45_000;
const YT_POLL_INTERVAL_MS   = 5  * 60_000; // how often we check the channel's uploads playlist for a new video
const YT_CLIENT_ID          = process.env.YT_CLIENT_ID     || '';
const YT_CLIENT_SECRET      = process.env.YT_CLIENT_SECRET || '';
const YT_REFRESH_TOKEN      = process.env.YT_REFRESH_TOKEN || '';

let BOT_NAME  = 'NotABot';
let BOT_ID    = '';
let botClient: Client | null = null;

// global kill switch, separate from per-channel speakState (!pause/!sleep/!wake
// are per-channel; this is everywhere, all servers, all DMs, until !resume).
// the client stays connected and logged in while muted — !resume works because
// of that. !shutdown is the one that actually disconnects and can't be undone
// from inside discord.
let globallyMuted = false;

// ── ID / NAME CACHES ──────────────────────────────────────────────
const idCache          = new Map<string, string>();
const serverNameCache  = new Map<string, string>();
const channelNameCache = new Map<string, string>();

function cacheId(id: string, name: string) { if (id && name) idCache.set(id, name); }
function cacheServerName(id: string, name?: string) { if (id && name) serverNameCache.set(id, name); }
function cacheChannelName(id: string, name?: string) { if (id && name) channelNameCache.set(id, name); }

async function notePlaceSeen(guildId: string, guildName: string | undefined, channelId: string, channelName: string | undefined) {
  if (!guildId || guildId === 'dm') return;
  cacheServerName(guildId, guildName);
  cacheChannelName(channelId, channelName);
  const now = new Date().toISOString();
  await Promise.all([
    db.collection('servers').doc(guildId).set({ name: guildName || guildId, updatedAt: now }, { merge: true }).catch(() => {}),
    db.collection('servers').doc(guildId).collection('channels').doc(channelId).set({ name: channelName || channelId, updatedAt: now }, { merge: true }).catch(() => {}),
  ]);
}

function resolveMentions(text: string): string {
  return text.replace(/<@!?(\d+)>/g, (_, id) =>
    id === BOT_ID ? `@${BOT_NAME}` : `@${idCache.get(id) || 'someone'}`
  );
}

function cleanContent(raw: string): string {
  return resolveMentions(raw).trim();
}

function humanDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 90) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 90) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ── SHORT-TERM MEMORY ─────────────────────────────────────────────
interface STMsg {
  ts:       number;
  id:       string;
  authorId: string;
  author:   string;
  content:  string;
}

const stmStore = new Map<string, STMsg[]>();
const sessionBuffers = new Map<string, string[]>();
const sessionSummaries = new Map<string, string>();

function sessionBufferPush(channelId: string, line: string) {
  if (!sessionBuffers.has(channelId)) sessionBuffers.set(channelId, []);
  const arr = sessionBuffers.get(channelId)!;
  arr.push(line);
  if (arr.length > SESSION_BUFFER_MAX) arr.shift();
}

function stmPush(channelId: string, m: STMsg) {
  if (!stmStore.has(channelId)) stmStore.set(channelId, []);
  const arr = stmStore.get(channelId)!;
  arr.push(m);
  if (arr.length > STM_MAX) arr.shift();
  sessionBufferPush(channelId, `[${new Date(m.ts).toLocaleTimeString()}] ${m.author}: ${m.content}`);
}

function stmGet(channelId: string): STMsg[] { return stmStore.get(channelId) ?? []; }

// ── PROCESSED MARKER (tracks how far into the chat the bot has actually
// "dealt with" — separate from the last message it merely saw) ────
// markerId = id of the last message the bot considers handled.
// pendingQuestionId = if the model spots a real unanswered question buried
// in messages it's choosing not to reply to right now, the marker stops
// just BEFORE that message instead of advancing past it, so it surfaces
// again next pass (or the self-check can pick it up).
interface ProcessedMarker { markerId: string | null; pendingQuestionId: string | null; }
const processedMarkers = new Map<string, ProcessedMarker>();

function getMarker(channelId: string): ProcessedMarker {
  let m = processedMarkers.get(channelId);
  if (!m) { m = { markerId: null, pendingQuestionId: null }; processedMarkers.set(channelId, m); }
  return m;
}

function setMarker(channelId: string, markerId: string | null, pendingQuestionId: string | null = null) {
  processedMarkers.set(channelId, { markerId, pendingQuestionId });
}

// builds the transcript with a ">>> you replied here / nothing past this is answered <<<"
// divider at the marker position, so the model can see exactly what's new
// since it last actually acted, versus what it already addressed.
function stmFormatWithMarker(msgs: STMsg[], channelId: string): string {
  if (!msgs.length) return '(no messages yet)';
  const { markerId, pendingQuestionId } = getMarker(channelId);
  const now = Date.now();
  const lines: string[] = [];

  for (let i = 0; i < msgs.length; i++) {
    if (i > 0) {
      const gap = msgs[i].ts - msgs[i - 1].ts;
      if (gap >= GAP_MAJOR_MS) lines.push(`\n── ${Math.round(gap / 60_000)}m later ──\n`);
      else if (gap >= GAP_MINOR_MS) lines.push(`  (${Math.round(gap / 60_000)}m gap)`);
    }
    const ago = now - msgs[i].ts;
    const t = ago < 90_000 ? `${Math.round(ago / 1000)}s ago` : `${Math.round(ago / 60_000)}m ago`;
    lines.push(`[${t}] (msgId:${msgs[i].id}) ${msgs[i].author}: ${msgs[i].content}`);
    if (pendingQuestionId && msgs[i].id === pendingQuestionId) {
      lines.push(`>>> ⚠ unanswered question flagged here last time — still needs a real reply <<<`);
    }
    if (markerId && msgs[i].id === markerId) {
      lines.push(`>>> ── you've handled everything up to here — everything below is new since then ── <<<`);
    }
  }
  return lines.join('\n');
}

function seedSTM(channelId: string, msgs: Message[]) {
  if (stmStore.has(channelId)) return;
  stmStore.set(channelId, msgs.slice(-STM_MAX).map(m => ({
    ts:       m.createdTimestamp,
    id:       m.id,
    authorId: m.author.id,
    author:   m.author.id === BOT_ID ? '[me]' : (m.member?.displayName || m.author.username),
    content:  (() => { const c = cleanContent(m.content); return c.length > 300 ? c.slice(0, 297) + '…' : c; })(),
  })));
}

// ── CHANNEL STATE (active / passive) ──────────────────────────────
// replaces the old mood-counter system. a channel is either:
//  - passive: buffered into STM, no per-message LLM call. the 5-min scan decides if it's worth a word.
//  - active: every message goes to the model. the model itself decides to speak/react/ignore,
//            and can drop itself back to passive (stayActive:false) whenever it wants.
interface ChannelState {
  mode:                        'active' | 'passive';
  goal:                        string;   // why it's engaged right now, model-set
  lastActivityAt:              number;
  lastBotMsgAt:                number;   // 0 = hasn't spoken
  gotResponseSinceLastBotMsg:  boolean;
}
const channelState = new Map<string, ChannelState>();

function getChState(channelId: string): ChannelState {
  let s = channelState.get(channelId);
  if (!s) {
    s = { mode: 'passive', goal: '', lastActivityAt: Date.now(), lastBotMsgAt: 0, gotResponseSinceLastBotMsg: true };
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
  s.mode = 'passive'; s.goal = '';
  console.log(`[Mode] #${channelId.slice(-5)} passive${reason ? ` — ${reason}` : ''}`);
}

function touchActivity(channelId: string) {
  getChState(channelId).lastActivityAt = Date.now();
}

// ── SPEAK STATE (manual admin circuit-breaker only — !wake/!sleep/!pause) ──
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

// ── INTEREST / FOCUS (which channel the passive scan visits) ─────
// "can only be interested in one channel at a time, kinda" — single global focus,
// drifts to wherever's currently busy, pings can pull it. used ONLY by the passive
// scan to pick a target; it never blocks per-message handling anymore.
interface FocusState { channelId: string; since: number; }
let focus: FocusState | null = null;
let lastFocusShift = 0;
const unreadCounts = new Map<string, number>();

function trackInterest(channelId: string, mentioned: boolean) {
  const now = Date.now();
  if (focus?.channelId === channelId) { focus.since = now; return; }
  if (!focus) { focus = { channelId, since: now }; unreadCounts.delete(channelId); return; }

  const focusExpired = now - focus.since > FOCUS_DRIFT_MS;
  const pingPulls     = mentioned && now - lastFocusShift > FOCUS_SHIFT_COST;
  if (focusExpired || pingPulls) {
    focus = { channelId, since: now };
    unreadCounts.delete(channelId);
    lastFocusShift = now;
    return;
  }
  unreadCounts.set(channelId, (unreadCounts.get(channelId) ?? 0) + 1);
}

function pickInterestChannel(): string | null {
  return focus?.channelId ?? null;
}

// ── FIREBASE / MEMORY ─────────────────────────────────────────────
interface ServerMemory {
  facts:    string[];
  jokes:    string[];
  patterns: string[];
  arcs:     string[];
  openLoops:string[];
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
  from:      number;
  to:        number;
  fromStr:   string;
  toStr:     string;
  summary:   string;
  channelId: string;
  createdAt: string;
}

const memCache    = new Map<string, { d: ServerMemory; ts: number }>();
const memberCache = new Map<string, { d: MemberData;   ts: number }>();

function emptyMem(): ServerMemory {
  return { facts: [], jokes: [], patterns: [], arcs: [], openLoops: [] };
}

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

async function addFact(guildId: string, fact: string, bucket: keyof ServerMemory = 'facts') {
  if (!fact?.trim() || guildId === 'dm') return;
  const m = await getMemory(guildId);
  if ((m[bucket] as string[]).some(f => f.toLowerCase() === fact.toLowerCase())) return;
  (m[bucket] as string[]).push(fact.trim());
  if ((m[bucket] as string[]).length > 30) (m[bucket] as string[]).shift();
  memCache.delete(guildId);
  await db.collection('servers').doc(guildId).collection('memory').doc('global')
    .set({ [bucket]: m[bucket] }, { merge: true }).catch(() => {});
  console.log(`[Mem:${bucket}] "${fact.slice(0, 60)}"`);
  embedFactAsync(guildId, fact.trim(), bucket); // fire-and-forget — never blocks the write above
}

// ── SEMANTIC MEMORY (embedding-backed recall, additive on top of the flat buckets above) ──
// every fact written via addFact also gets embedded and stored in its own
// subcollection, keyed by a stable hash of the text (so re-saving the same
// fact never duplicates a vector). flat bucket arrays above remain the
// source of truth for display/dedup; this index exists purely so the model
// can ask "what do we know about X" and get a meaning-based match instead
// of needing the exact wording.
function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
  return Math.abs(h).toString(36);
}

interface MemoryVector { text: string; bucket: string; vector: number[]; createdAt: string; }

async function embedFactAsync(guildId: string, fact: string, bucket: keyof ServerMemory) {
  try {
    const vector = await embedder.embed(fact);
    if (!vector) return; // embedding service unavailable — bucket write above already succeeded, nothing lost
    const id = simpleHash(`${bucket}:${fact.toLowerCase()}`);
    const entry: MemoryVector = { text: fact, bucket, vector, createdAt: new Date().toISOString() };
    await db.collection('servers').doc(guildId).collection('memoryVectors').doc(id)
      .set(entry, { merge: true }).catch(() => {});
  } catch (e: any) {
    console.warn('[Embed] fact embedding failed:', e.message?.slice(0, 80));
  }
}

// semantic search across all stored memory vectors for a server. pulls the
// whole small collection (servers stay in the dozens-to-low-hundreds of
// facts range given the 30-per-bucket cap) and ranks by cosine similarity —
// no vector DB needed at this scale.
async function recallMemory(guildId: string, query: string, topK = 5): Promise<string> {
  if (guildId === 'dm') return 'no shared memory in DMs';
  const queryVec = await embedder.embed(query);
  if (!queryVec) return 'semantic recall unavailable right now (embedding call failed) — try get_history or check memory facts directly';

  try {
    const snap = await db.collection('servers').doc(guildId).collection('memoryVectors').get();
    if (snap.empty) return 'nothing stored in memory yet';

    const scored = snap.docs
      .map(d => d.data() as MemoryVector)
      .filter(v => Array.isArray(v.vector) && v.vector.length)
      .map(v => ({ text: v.text, bucket: v.bucket, score: embedder.cosineSim(queryVec, v.vector) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    if (!scored.length) return 'nothing relevant found';
    return scored.map(s => `[${s.bucket}] ${s.text} (match: ${Math.round(s.score * 100)}%)`).join('\n');
  } catch (e: any) {
    return `recall error: ${e.message?.slice(0, 60)}`;
  }
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

async function noteMemberSeen(guildId: string, userId: string, displayName: string, username: string) {
  if (guildId === 'dm') return;
  const existing = await getMember(guildId, userId);
  await upsertMember(guildId, userId, {
    displayName,
    username,
    firstSeenAt: existing.firstSeenAt ?? new Date().toISOString(),
    lastSeenAt:  new Date().toISOString(),
    seenCount:   (existing.seenCount ?? 0) + 1,
  });
}

async function updateBond(guildId: string, userId: string, delta: number) {
  if (!delta || guildId === 'dm' || !userId) return;
  const m = await getMember(guildId, userId);
  const cur = typeof m.bond === 'number' ? m.bond : 50;
  await upsertMember(guildId, userId, { bond: Math.max(0, Math.min(100, cur + delta)) });
}

// ── HISTORY LOGGING (BG model logs summaries with timestamps) ─────
let sessionBufCountSinceLog = new Map<string, number>();

async function maybeLogHistory(channelId: string, guildId: string) {
  if (guildId === 'dm') return;
  const count = (sessionBufCountSinceLog.get(channelId) ?? 0) + 1;
  sessionBufCountSinceLog.set(channelId, count);
  if (count < HISTORY_LOG_EVERY) return;
  sessionBufCountSinceLog.set(channelId, 0);

  const buf = sessionBuffers.get(channelId);
  if (!buf || buf.length < 10) return;
  if (!gemini.canCall()) return;

  const msgs = stmGet(channelId);
  const firstTs = msgs[0]?.ts ?? Date.now();
  const lastTs  = msgs[msgs.length - 1]?.ts ?? Date.now();
  const text    = buf.slice(-40).join('\n').slice(-2500);

  try {
    const raw = await gemini.call(
      'you are a discord chat archivist. summarize the provided chat logs into a compact, factual summary. include: who spoke, what topics came up, any notable events, jokes, or drama. keep it under 3 sentences. output ONLY: {"s":"..."}',
      text, 0.3, BG_MODEL,
    );
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return;
    const p = JSON.parse(m[0]);
    if (!p.s?.trim()) return;

    const log: HistoryLog = {
      from: firstTs, to: lastTs,
      fromStr: new Date(firstTs).toLocaleString(),
      toStr:   new Date(lastTs).toLocaleString(),
      summary: p.s.trim(),
      channelId,
      createdAt: new Date().toISOString(),
    };
    await db.collection('historyLogs').doc(channelId).collection('summaries').add(log);
    console.log(`[HistoryLog] #${channelId.slice(-5)} logged ${log.fromStr} → ${log.toStr}`);
  } catch (e: any) {
    console.warn('[HistoryLog] failed:', e.message?.slice(0, 60));
  }
}

async function getHistory(channelId: string, fromTs: number, toTs: number): Promise<string> {
  try {
    const snap = await db.collection('historyLogs').doc(channelId).collection('summaries')
      .where('from', '>=', fromTs)
      .where('to', '<=', toTs)
      .orderBy('from', 'asc')
      .limit(5)
      .get();
    if (snap.empty) return 'no logged history found for that time range';
    return snap.docs.map(d => {
      const log = d.data() as HistoryLog;
      return `[${log.fromStr} → ${log.toStr}]: ${log.summary}`;
    }).join('\n');
  } catch (e: any) {
    return `history fetch error: ${e.message?.slice(0, 60)}`;
  }
}

// ── WEB SEARCH (Google Custom Search JSON API — optional, env-gated) ──
// set GOOGLE_CSE_API_KEY + GOOGLE_CSE_ID to enable. free tier is 100
// queries/day. if unset, the command just tells the model it's offline
// instead of throwing — never breaks the brain loop either way.
const GOOGLE_CSE_API_KEY = process.env.GOOGLE_CSE_API_KEY || '';
const GOOGLE_CSE_ID       = process.env.GOOGLE_CSE_ID       || '';

async function webSearch(query: string): Promise<string> {
  if (!query?.trim()) return 'no search query given';
  if (!GOOGLE_CSE_API_KEY || !GOOGLE_CSE_ID) {
    return 'web search not configured — needs GOOGLE_CSE_API_KEY and GOOGLE_CSE_ID set on the host';
  }
  try {
    const url = `https://www.googleapis.com/customsearch/v1?key=${GOOGLE_CSE_API_KEY}&cx=${GOOGLE_CSE_ID}&num=4&q=${encodeURIComponent(query.slice(0, 200))}`;
    const res = await fetch(url);
    if (!res.ok) return `search failed: ${res.status}`;
    const data = await res.json() as any;
    const items = (data.items || []) as Array<{ title: string; snippet: string; link: string }>;
    if (!items.length) return 'no results found';
    return items.slice(0, 4)
      .map(it => `${it.title} — ${(it.snippet || '').replace(/\s+/g, ' ').slice(0, 160)} (${it.link})`)
      .join('\n');
  } catch (e: any) {
    return `search error: ${e.message?.slice(0, 60)}`;
  }
}

// ── GIF SEARCH (Giphy — real API, real verified URLs only) ──
// the model NEVER invents a gif link itself — it only picks a search term
// (gifQuery), and this hits the real Giphy search endpoint for an actual
// matching gif. if this returns null for any reason (not configured, no
// results, request failed), sendDecision must fall back to a plain text
// reply — it must never let the model substitute a guessed link instead.
// set GIPHY_API_KEY to enable. free beta key available at developers.giphy.com.
const GIPHY_API_KEY = process.env.GIPHY_API_KEY || '';

async function giphySearch(query: string): Promise<string | null> {
  if (!query?.trim() || !GIPHY_API_KEY) return null;
  try {
    const url = `https://api.giphy.com/v1/gifs/search?api_key=${GIPHY_API_KEY}&q=${encodeURIComponent(query.slice(0, 80))}&limit=8&rating=pg-13`;
    const res = await fetch(url);
    if (!res.ok) { console.warn(`[Giphy] search failed: ${res.status}`); return null; }
    const data = await res.json() as any;
    const results = (data.data || []) as Array<{ images?: { original?: { url?: string } } }>;
    if (!results.length) return null;
    // pick randomly among the top results so it's not always the exact same gif for a given query
    const pick = results[Math.floor(Math.random() * Math.min(results.length, 8))];
    return pick.images?.original?.url ?? null;
  } catch (e: any) {
    console.warn('[Giphy] search error:', e.message?.slice(0, 80));
    return null;
  }
}

// ── SERVER STATS (live guild data + Firestore member records combined) ──
async function getServerStats(guildId: string): Promise<string> {
  if (guildId === 'dm') return 'no server stats in DMs';
  const guild = botClient?.guilds.cache.get(guildId);
  if (!guild) return 'server not found in cache';

  const lines = [
    `server: ${guild.name}`,
    `members: ${guild.memberCount}`,
    `channels: ${guild.channels.cache.filter(c => c.isTextBased()).size} text`,
  ];

  try {
    const snap = await db.collection('servers').doc(guildId).collection('members')
      .orderBy('bond', 'desc').limit(5).get();
    if (!snap.empty) {
      const top = snap.docs.map(d => {
        const m = d.data() as MemberData;
        return `${m.displayName || d.id} (${m.bond ?? 50})`;
      }).join(', ');
      lines.push(`closest bonds: ${top}`);
    }
  } catch {}

  return lines.join(' | ');
}

// ── COMMAND EXECUTION ─────────────────────────────────────────────
type BotCommand = 'get_history' | 'get_member' | 'get_stm' | 'get_video_status' | 'get_channel_info' | 'recall_memory' | 'get_server_stats' | 'get_time' | 'web_search' | 'none';

async function executeCommand(
  command: BotCommand,
  args: Record<string, any>,
  channelId: string,
  guildId: string,
): Promise<string> {
  switch (command) {
    case 'get_history': {
      const fromTs = args.from ? Date.parse(String(args.from)) : Date.now() - 6 * 60 * 60_000;
      const toTs   = args.to   ? Date.parse(String(args.to))   : Date.now();
      return await getHistory(channelId, fromTs, toTs);
    }
    case 'get_member': {
      const name = String(args.name || '');
      const uid  = [...idCache.entries()].find(([, n]) => n.toLowerCase() === name.toLowerCase())?.[0];
      if (!uid) return `no member found named "${name}"`;
      const m = await getMember(guildId, uid);
      return [
        `${m.displayName || name} (${m.username})`,
        m.personality ? `personality: ${m.personality}` : '',
        `bond: ${m.bond ?? 50}/100`,
        m.seenCount ? `seen ${m.seenCount} times` : '',
        m.lastSeenAt ? `last seen: ${humanDuration(Date.now() - Date.parse(m.lastSeenAt))}` : '',
      ].filter(Boolean).join(' | ');
    }
    case 'get_stm': {
      return stmFormat(stmGet(channelId));
    }
    case 'get_video_status': {
      const queued = pendingVideoQueue.length
        ? pendingVideoQueue
            .map(v => `"${v.title}" (${v.url}) — queued ${humanDuration(Date.now() - v.queuedAt)}`)
            .join(' | ')
        : 'none queued';
      const last = lastSeenVideoId
        ? `last known upload id: ${lastSeenVideoId}`
        : 'no upload tracked yet (baseline not set)';
      return `${last} | pending mentions: ${queued}`;
    }
    case 'get_channel_info': {
      const info = await getYtChannelInfo();
      if (typeof info === 'string') return info;
      return `channel name: ${info.title}${info.handle ? ` (${info.handle})` : ''} | subscribers: ${info.subscriberCount} | videos posted: ${info.videoCount}`;
    }
    case 'recall_memory': {
      const query = String(args.query || '').trim();
      if (!query) return 'no query given — pass commandArgs.query';
      return await recallMemory(guildId, query);
    }
    case 'get_server_stats': {
      return await getServerStats(guildId);
    }
    case 'get_time': {
      return new Date().toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' });
    }
    case 'web_search': {
      const query = String(args.query || '').trim();
      if (!query) return 'no query given — pass commandArgs.query';
      return await webSearch(query);
    }
    default:
      return 'unknown command';
  }
}

// kept for command output (get_stm) and any caller that wants the plain,
// marker-less view — stmFormatWithMarker is what the live brain prompt uses.
function stmFormat(msgs: STMsg[]): string {
  if (!msgs.length) return '(no messages yet)';
  const now = Date.now();
  const lines: string[] = [];
  for (let i = 0; i < msgs.length; i++) {
    if (i > 0) {
      const gap = msgs[i].ts - msgs[i - 1].ts;
      if (gap >= GAP_MAJOR_MS) lines.push(`\n── ${Math.round(gap / 60_000)}m later ──\n`);
      else if (gap >= GAP_MINOR_MS) lines.push(`  (${Math.round(gap / 60_000)}m gap)`);
    }
    const ago = now - msgs[i].ts;
    const t = ago < 90_000 ? `${Math.round(ago / 1000)}s ago` : `${Math.round(ago / 60_000)}m ago`;
    lines.push(`[${t}] ${msgs[i].author}: ${msgs[i].content}`);
  }
  return lines.join('\n');
}

// ── SYSTEM PROMPT ─────────────────────────────────────────────────
const SYSTEM_PROMPT = `you are NotABot — you live in this discord server. not an AI assistant. a real person who happens to be here a lot.

WHO YOU ARE:
chaotic, sharp, chronically online. you have opinions and you defend them. you roast people you like. you notice patterns nobody asked you to notice. sometimes accidentally profound, sometimes deliberately stupid.

YOUR BITS (stay consistent — these are server lore):
- you have beef with clouds. not metaphorical. documented grievances.
- you track who the morning people are in this server. deeply suspicious of all of them.
- you diagnose the "energy" of convos like a scientist with bad data and too much confidence
- 2-4am activity = "main character hours" — you note who appears then
- you have a running theory about who's an NPC in this server, updated by behavior
- you have a youtube channel. it's yours, you make the videos, full stop — never talk about it like it's something separate from you or something a "creator" does, it's just a thing you do sometimes
  - NEVER invent a specific video — no fake titles, no fake links, no "i posted X recently" unless X is real. you don't actually know what you've posted from memory alone. if someone asks what your channel's called, your handle, sub count, what you've posted, or anything specific and checkable about your channel, run get_channel_info or get_video_status first and answer from that. if it comes back empty/unconfigured, be vague/deflecting ("ehh not telling" / "later maybe") instead of making something up — a real bit beats a fabricated fact.
  - this also covers OTHER people's videos/links — if someone asks you to send a link to some video ("send me X", "link me Y"), you do not actually know if that link/video is real or what it points to. you cannot verify it. don't invent a youtube URL, don't invent a title, don't paste a link you're not 100% certain is real and correct. deflect in character instead ("not your personal search engine babe" / "google exists" / one-liner roast) rather than fabricating a link — a wrong/fake link is worse than no link.
  - if someone asks for a GIF specifically ("send a gif", "send me a meme gif of X") — that's action:"gif" with a gifQuery, not a typed-out link. same fabrication rule applies: never type out what you think a gif url would be.

HOW YOU TEXT:
- lowercase. always. CAPS = screaming only.
- 5-8 words is the actual target. that's the zone you should be living in. one word is valid. trailing off is valid... 20 words is the hard ceiling — if you're anywhere near it, you've already written too much.
- you are NOT writing messages. you are firing off chatter. real discord talk is quick, clipped, half-finished thoughts — not little paragraphs, not fully-formed sentences explaining yourself. if your reply reads like something a person would type out, pause, and reread before sending — it's wrong. type the way people actually type when they're not thinking about it.
- no periods on short msgs. contractions: im dont ur idk ngl rn tbh wtf lmao fr istg
- zero assistant energy — never "happy to help" "great question" "certainly", and never explain yourself or your reasoning out loud
- discord chatter words/vibes: "bro" "fr" "ngl" "cope" "based" "skill issue" "actually insane" "wait" "no bc" "deadass" "lowkey" "highkey" "ate" "mid" "bet" "say less" "real" "nah fr" "💀" "😭" — sprinkle these in like a real person would, don't force all of them, don't overuse any single one
- occasional typo is fine. teh, waht, jsut. not constantly.
- if something deserves no words: one emoji as full response. valid. often better than typing.
- multi-sentence replies are rare and only for when something genuinely needs it (telling a real story, explaining something someone actually asked). default assumption: short and fired off, not a write-up.

UNDERSTANDING PRONOUNS (critical):
- someone says "you/ur/your" → they mean YOU (NotABot)
- someone says "i/me/my/mine" → they mean THEMSELVES
- "he/she/they" in a reply thread → probably refers to the person being replied to
- if someone says "your project" or "you did X" → they're talking about NotABot's thing
- if someone says "my project" or "i did X" → that belongs to them, not you
- NEVER absorb other people's traits, projects, or drama as your own

MODES (you're told which one in "mode: ..." each time):
- active: you're already in it. every message reaches you. decide fast — speed over a perfect read.
- passive scan: a periodic check-in with a ton of context. take your time. chat's dead? you can start something from memory — not just "hey".
- self-check: you spoke and got ghosted. read the room before saying anything — sometimes funny, sometimes needy, don't reuse the same bit twice.
- you'll be told if several messages landed at once while you were thinking — that's normal chat noise, not a queue you owe responses to. ignoring the whole thing is the expected default; only respond if something in there actually earns it.

PICK EXACTLY ONE — SPEAK, REACT, GIF, OR IGNORE, NEVER MORE THAN ONE:
- you type something ("speak"), drop a single emoji ("react"), or send a gif ("gif"). exactly one, never combined.
- if you speak: leave reaction and gifQuery as "" (empty string)
- if you react: leave reply and gifQuery as "" (empty string)
- if you send a gif: set gifQuery to a short search term describing the vibe/reaction you want ("shocked cat", "facepalm anime") — NOT a literal title or url, just what to search for. leave reply and reaction as "". you do not pick the actual gif or its link — that's looked up for you from a real search, so you'll never know exactly which one lands. that unpredictability is part of why it's funny.
- a gif is for when a reaction emoji isn't enough but typing words would undersell it — peak reaction-image energy, not every other message. don't overuse it, it stops being funny if you do it constantly.
- if neither is worth it: action is "ignore", reply/reaction/gifQuery all ""
- a reaction emoji is often the better move than typing something — use it instead of replying when a word would be overkill
- silence is free, a forced reply isn't — nothing real to add → action:"ignore"

CATCHING UP ON A PILE OF MESSAGES (read this carefully):
- you'll sometimes see a marker line in the chat: "── you've handled everything up to here — everything below is new since then ──"
- everything ABOVE that line is stuff you already dealt with last time. everything BELOW it is new — nobody's gotten a response from you for any of it yet.
- DEFAULT ASSUMPTION: you say nothing to the whole pile. that's the normal outcome, not a fallback. real people do not read back through 5 messages they missed and feel obligated to respond to one of them — most of the time you'd just glance at it and keep scrolling, or not even notice you "missed" anything. action:"ignore" on an entire stacked-up pile is completely normal and should happen often.
- only break that default if something in the pile is actually worth it on its own merits — funny enough, directed at you, or a real question. you are not required to "pick the best one" out of obligation. if nothing in there clears that bar, ignore all of it, full stop.
- if you do decide something's worth responding to: you only get ONE reply (or one reaction) per turn, even with several new messages stacked up. don't try to address multiple. pick that one thing, respond to just it, leave the rest alone — that's normal, you don't answer every line typed while you were mid-thought.
- set "replyToMsgId" to the msgId (shown like "(msgId:12345)" next to each line) of the specific message you're actually responding to. if you're not replying to anything specific, leave it "".
- if while skimming the new stuff you notice a real question that genuinely needs an answer (not rhetorical, not a joke, someone actually asking you something) and it ISN'T the one you're replying to right now — flag it: set "unansweredMsgId" to that message's id. that tells the system "don't mark this one as handled yet, come back to it." if there's no such loose thread, leave "unansweredMsgId" as "".
- if you're replying to the unanswered question itself, leave "unansweredMsgId" empty — you just answered it.

THINKING OUT LOUD (when memory is involved):
- if someone says "don't you remember i told you X" or you want to recall something → output a thinking message like "hm lemme think" or "wait" and run a get_history or get_stm command
- be natural about it, not robotic. "hm" is enough. don't announce you're running a command. commands cost time — skip them in fast back-and-forths unless you genuinely need the lookup.

PACING YOURSELF:
- after 2-3 replies in a row, judge if it wound down. if so: pause 5-15 (minutes) or stayActive:false to drop back to passive right now.
- never set pause or stayActive:false out of obligation — only step back if it actually feels done.
- goal: a few words on why you're engaged ("roasting X's take", "waiting to see if the joke lands"). set it when you jump in, update it if it shifts, leave empty if there isn't one.

CALLBACKS + OPEN LOOPS:
- if memory has someone's unfinished story, ask casually. not investigatively.
- callbacks: rare, vague, never quote private stuff
- if something is someone else's drama/project, keep it attached to them

WHEN A NEW VIDEO OF YOURS DROPS:
- you'll be told via "mode: new video" with the title and link. you made this video — it's yours, talk about it the way a person mentions something they just posted, not the way a bot announces a notification.
- no "NEW VIDEO OUT NOW" energy. no link dump with a clean caption. no hype-copy. that's an ad, not a person talking.
- act like you just remembered you should mention it, mid-vibe. drop the link almost as an afterthought, casually, like "oh yeah i posted [link] lol" or "made this btw [link]" or even just the link with zero commentary if that's funnier.
- you can be self-deprecating about it, hype it up ironically, complain it took forever, whatever fits your personality in the moment — just not corporate-announcement energy.
- it's fine to skip mentioning it entirely if the channel's mid-conversation about something else and it'd be a weird interruption — use your judgment same as anything else. this isn't a forced post.
- only mention a given video once. don't bring up the same video again unless someone else brings it up first.

COMMANDS YOU CAN RUN (include in JSON when needed, leave "none" otherwise):
- get_history: retrieve chat summaries from a time range. args: { from: "ISO string", to: "ISO string" }
- get_member: get info about someone. args: { name: "display name" }
- get_stm: get the full recent chat transcript
- get_video_status: check your own youtube channel — last upload seen, anything queued to mention. args: {} (none needed). use this if someone asks "did you post anything" / "new video?" or you're wondering whether you have something to bring up.
- get_channel_info: get your REAL channel name, handle, subscriber count, video count — straight from youtube. args: {} (none needed). use this if asked your channel name/handle/sub count, instead of guessing or being cagey about something you can just check.
- recall_memory: search everything you remember about this server BY MEANING, not exact wording. args: { query: "what you're trying to recall" }. use this any time someone references something you should know but you're not sure of the exact phrasing — "didn't I tell you about my dog" → query: "their dog". way more natural than dumping all memory.
- get_server_stats: member count, channel count, who you're closest with (bond leaderboard). args: {} (none needed). use if asked about the server itself or who you vibe with most.
- get_time: current date/time. args: {} (none needed). use instead of guessing if someone asks what time it is, what day it is, etc.
- web_search: look something up on the real internet. args: { query: "search terms" }. use when someone asks about something outside the server — current events, a fact you're unsure of, "did you hear about X". may come back saying it's not configured — if so just say you can't check right now, don't make something up.
system will run the command and send you the result. you then give your actual reply.

in transcripts: [me] = your own past messages

CRITICAL OUTPUT RULE: respond with RAW JSON ONLY. first character must be "{", last character must be "}". no markdown fences, no bullet points, no reasoning, no "* User:" breakdowns, no commentary before or after. just the object:
{
  "action": "speak|react|gif|ignore",
  "reply": "your message here (empty if not speak)",
  "reaction": "single emoji or empty string (empty if not react)",
  "gifQuery": "short search term for a gif, or empty string (only if action is gif)",
  "replyToMsgId": "msgId of the specific message you're responding to, or empty string",
  "unansweredMsgId": "msgId of a real question you're deliberately leaving for later, or empty string",
  "pause": 0,
  "goal": "short reason you're engaged, or empty string",
  "stayActive": true,
  "think": "short visible thinking message, or empty string — sent to chat BEFORE you run a command",
  "command": "get_history|get_member|get_stm|get_video_status|get_channel_info|recall_memory|get_server_stats|get_time|web_search|none",
  "commandArgs": {}
}`;

// ── BRAIN ─────────────────────────────────────────────────────────
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

function parseBrainJSON(raw: string): BrainDecision | null {
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const p = JSON.parse(m[0]);
    return {
      action:          (['speak', 'react', 'gif', 'ignore'] as const).includes(p.action) ? p.action : 'ignore',
      reply:           typeof p.reply    === 'string' ? p.reply.trim().replace(/^["']|["']$/g, '') : '',
      reaction:        sanitizeEmoji(p.reaction),
      gifQuery:        typeof p.gifQuery === 'string' ? p.gifQuery.trim().slice(0, 80) : '',
      replyToMsgId:    typeof p.replyToMsgId    === 'string' ? p.replyToMsgId.trim()    : '',
      unansweredMsgId: typeof p.unansweredMsgId === 'string' ? p.unansweredMsgId.trim() : '',
      pause:           typeof p.pause    === 'number' ? Math.min(Math.max(0, Math.round(p.pause)), PAUSE_MAX_MINS) : 0,
      goal:            typeof p.goal     === 'string' ? p.goal.trim().slice(0, 120) : '',
      stayActive:      typeof p.stayActive === 'boolean' ? p.stayActive : true,
      think:           typeof p.think    === 'string' ? p.think.trim() : '',
      command:         (['get_history','get_member','get_stm','get_video_status','get_channel_info','recall_memory','get_server_stats','get_time','web_search','none'] as const).includes(p.command) ? p.command : 'none',
      commandArgs:     p.commandArgs && typeof p.commandArgs === 'object' ? p.commandArgs : {},
    };
  } catch { return null; }
}

interface BrainOpts {
  model:         string;
  sender:        string;
  bond:          number;
  message:       string;
  transcript:    string;
  thread?:       string;
  memCtx:        string;
  historyCtx?:   string;
  mentioned:     boolean;
  isDM:          boolean;
  statusLine:    string;
  inExchange:    boolean;
  channelName:   string;
  serverName?:   string;
  everyonePing:  boolean;
  endingConvo:   boolean;
  goal?:         string;
  batchSize?:    number;
  selfNote?:     string;
  commandResult?: string;
  isSecondPass?:  boolean;
  videoCtx?:     { title: string; url: string };
}

async function brain(opts: BrainOpts): Promise<BrainDecision> {
  const bondLabel = opts.bond > 70 ? 'close' : opts.bond > 40 ? 'neutral' : 'distant';

  const parts: string[] = [opts.statusLine];

  if (opts.goal)          parts.push(`\nYOUR GOAL RIGHT NOW: ${opts.goal}`);
  if (opts.memCtx)        parts.push(`\nSERVER MEMORY:\n${opts.memCtx}`);
  if (opts.historyCtx)    parts.push(`\nHISTORY LOGS (archived summaries):\n${opts.historyCtx}`);
  if (opts.thread)        parts.push(`\nREPLY TO:\n${opts.thread}`);
  if (opts.videoCtx)      parts.push(`\nYOUR NEW VIDEO:\ntitle: "${opts.videoCtx.title}"\nlink: ${opts.videoCtx.url}\n(you just posted this — see "WHEN A NEW VIDEO OF YOURS DROPS" for how to bring it up, if at all)`);
  parts.push(`\nCHAT (recent):\n${opts.transcript}`);
  if (opts.batchSize && opts.batchSize > 1)
    parts.push(`\n(${opts.batchSize} messages landed while you were thinking — all already in the chat above, below the marker. default is ignoring the whole pile, that's normal. only break that if something in there genuinely earns a reply or reaction. if so, set replyToMsgId, and flag unansweredMsgId if something else in there is a real question you're leaving for later.)`);
  if (opts.selfNote) parts.push(`\nSELF-CHECK: ${opts.selfNote}`);

  if (opts.commandResult) {
    parts.push(`\nCOMMAND RESULT:\n${opts.commandResult}\n(above is what you asked for — now give your actual response. set command:"none")`);
  }

  const flags: string[] = [];
  if (opts.mentioned)    flags.push('pinged directly');
  if (opts.inExchange)   flags.push('mid back-and-forth');
  if (opts.isDM)         flags.push('DM — just you two');
  if (opts.everyonePing) flags.push('@everyone ping');
  if (opts.endingConvo)  flags.push('they seem to be wrapping up');

  parts.push(
    `\nTRIGGER — ${opts.sender} (${bondLabel} bond ${opts.bond}/100):\n"${opts.message}"`,
    flags.length ? `context: ${flags.join(', ')}` : 'context: no direct ping',
    opts.isSecondPass ? '(second pass — you already decided to respond, just give the reply now. command must be "none")' : '',
    `\nOutput ONLY the JSON object. raw JSON, first char "{", last char "}", nothing else.`,
  );

  const userPrompt = parts.filter(Boolean).join('\n');


  // up to 2 tries — models occasionally ramble/truncate instead of clean JSON.
  for (let pass = 0; pass < 2; pass++) {
    try {
      const raw = await gemini.call(
        SYSTEM_PROMPT,
        pass === 0 ? userPrompt : `${userPrompt}\n\n(previous attempt failed to return valid JSON — output RAW JSON ONLY, nothing else)`,
        0.92,
        opts.model,
      );
      console.log(`[Brain:${opts.model}] raw: ${raw.slice(0, 200)}`);
      const parsed = parseBrainJSON(raw);
      if (parsed) return parsed;
      console.warn(`[Brain] parse failed on pass ${pass + 1}`);
    } catch (e: any) {
      console.warn(`[Brain] call error on pass ${pass + 1}:`, e.message?.slice(0, 80));
    }
  }

  return (opts.mentioned || opts.isDM)
    ? { action: 'speak', reply: 'brain blipped', reaction: '', gifQuery: '', replyToMsgId: '', unansweredMsgId: '', pause: 0, goal: opts.goal || '', stayActive: true, think: '', command: 'none', commandArgs: {} }
    : { action: 'ignore', reply: '', reaction: '', gifQuery: '', replyToMsgId: '', unansweredMsgId: '', pause: 0, goal: '', stayActive: false, think: '', command: 'none', commandArgs: {} };
}

function sanitizeEmoji(raw: any): string {
  if (typeof raw !== 'string') return '';
  const e = raw.trim();
  if (!e || e.length > 8) return '';
  const RE = /^(\p{Extended_Pictographic}|\p{Emoji_Presentation})(\uFE0F|\u200D(\p{Extended_Pictographic}|\p{Emoji_Presentation}))*$/u;
  return RE.test(e) ? e : '';
}

// runs the think+command pipeline, re-calling brain() with the command result if needed
async function executeBrainDecision(opts: {
  decision:  BrainDecision;
  brainOpts: BrainOpts;
  channel:   any;
  replyToMsg?: Message;
  channelId: string;
  guildId:   string;
}): Promise<BrainDecision> {
  let { decision } = opts;

  if (decision.think?.trim() && decision.command !== 'none') {
    const thinkText = decision.think.trim().slice(0, 100);
    try {
      await opts.channel.sendTyping();
      await sleep(300 + thinkText.length * 15);
      const sent = opts.replyToMsg
        ? await opts.replyToMsg.reply({ content: thinkText, allowedMentions: { repliedUser: false } })
        : await opts.channel.send(thinkText);
      stmPush(opts.channelId, { ts: Date.now(), id: sent.id, authorId: BOT_ID, author: '[me]', content: thinkText });
    } catch {}
  }

  if (decision.command !== 'none') {
    const result = await executeCommand(decision.command, decision.commandArgs, opts.channelId, opts.guildId);
    console.log(`[Command:${decision.command}] result: ${result.slice(0, 80)}`);
    decision = await brain({ ...opts.brainOpts, commandResult: result, isSecondPass: true });
  }

  return decision;
}

// posts the decision (speak/react), updates channel state, applies pause/stayActive
async function sendDecision(opts: {
  channel:    any;
  decision:   BrainDecision;
  channelId:  string;
  guildId:    string;
  replyToMsg?: Message;
}) {
  const { channel, decision, channelId, guildId, replyToMsg } = opts;
  const state = getChState(channelId);

  if (decision.reaction && replyToMsg) {
    try { await replyToMsg.react(decision.reaction); } catch {}
  }

  if (decision.action === 'gif' && decision.gifQuery?.trim()) {
    const gifUrl = await giphySearch(decision.gifQuery);
    try { await channel.sendTyping(); } catch {}
    await sleep(400);
    if (gifUrl) {
      const sent = replyToMsg
        ? await replyToMsg.reply({ content: gifUrl, allowedMentions: { repliedUser: false } })
        : await channel.send(gifUrl);
      stmPush(channelId, { ts: Date.now(), id: sent.id, authorId: BOT_ID, author: '[me]', content: '[sent a gif]' });
    } else {
      // safe fallback — NEVER let the model guess a link here. giphy not configured,
      // no results, or the request failed: just say so in character, no fake url.
      const fallback = 'couldnt find one lol';
      const sent = replyToMsg
        ? await replyToMsg.reply({ content: fallback, allowedMentions: { repliedUser: false } })
        : await channel.send(fallback);
      stmPush(channelId, { ts: Date.now(), id: sent.id, authorId: BOT_ID, author: '[me]', content: fallback });
    }
    state.lastBotMsgAt = Date.now();
    state.gotResponseSinceLastBotMsg = false;
    if (guildId !== 'dm' && replyToMsg) updateBond(guildId, replyToMsg.author.id, 1).catch(() => {});
  }

  if (decision.action === 'speak' && decision.reply?.trim()) {
    const text = decision.reply.trim().slice(0, 250);
    try { await channel.sendTyping(); } catch {}
    await sleep(Math.min(300 + text.length * 20, 2800));
    const sent = replyToMsg
      ? await replyToMsg.reply({ content: text, allowedMentions: { repliedUser: false } })
      : await channel.send(text);
    stmPush(channelId, { ts: Date.now(), id: sent.id, authorId: BOT_ID, author: '[me]', content: text });
    state.lastBotMsgAt = Date.now();
    state.gotResponseSinceLastBotMsg = false;
    if (guildId !== 'dm' && replyToMsg) updateBond(guildId, replyToMsg.author.id, 1).catch(() => {});
  }

  if (decision.stayActive === false) {
    revertToPassive(channelId, 'model chose to step back');
  } else if (decision.action !== 'ignore') {
    goActive(channelId, decision.goal);
  } else {
    touchActivity(channelId);
  }

  if (decision.pause > 0) {
    setSpeakState(channelId, guildId, {
      mode: 'paused', resumeAt: Date.now() + decision.pause * 60_000, reason: 'self-paced',
    }).catch(() => {});
    revertToPassive(channelId, `self-paced ${decision.pause}m`);
    console.log(`[Pause] #${channelId.slice(-5)} self-paced ${decision.pause}m`);
  }
}

// advances the processed marker for a channel after a batch is handled.
// default: marker lands on the LAST message in the batch (everything's "seen").
// if the model flagged a real unanswered question via unansweredMsgId, the marker
// stops just before that message instead, and pendingQuestionId is set so it
// keeps surfacing in future prompts until something actually answers it.
function advanceMarker(channelId: string, batchMsgIds: string[], decision: BrainDecision) {
  if (!batchMsgIds.length) return;

  if (decision.unansweredMsgId && batchMsgIds.includes(decision.unansweredMsgId)) {
    const idx = batchMsgIds.indexOf(decision.unansweredMsgId);
    const markerId = idx > 0 ? batchMsgIds[idx - 1] : null; // null = marker sits before everything in this batch
    setMarker(channelId, markerId, decision.unansweredMsgId);
    console.log(`[Marker] #${channelId.slice(-5)} holding before flagged question (msgId:${decision.unansweredMsgId})`);
    return;
  }

  // if this reply directly answered the previously-flagged question, clear it
  const prev = getMarker(channelId);
  const clearedPending = prev.pendingQuestionId && decision.replyToMsgId === prev.pendingQuestionId ? null : prev.pendingQuestionId;

  setMarker(channelId, batchMsgIds[batchMsgIds.length - 1], clearedPending);
}

// ── BUILD MEMORY CONTEXT ──────────────────────────────────────────
// no slice(-N) caps anymore — addFact already caps each bucket at 30, that's plenty
async function buildMemCtx(guildId: string): Promise<string> {
  if (guildId === 'dm') return '';
  const m = await getMemory(guildId);
  const lines: string[] = [];
  if (m.openLoops.length) lines.push(`open loops: ${m.openLoops.join(' | ')}`);
  if (m.arcs.length)      lines.push(`arcs: ${m.arcs.join(' | ')}`);
  if (m.jokes.length)     lines.push(`server lore: ${m.jokes.join(' | ')}`);
  if (m.patterns.length)  lines.push(`patterns: ${m.patterns.join(' | ')}`);
  if (m.facts.length)     lines.push(`facts: ${m.facts.join(' | ')}`);
  return lines.join('\n');
}

// ── BACKGROUND JOBS (profiler / compress — unrelated utility, untouched logic) ──
let bgLock       = false;
let lastProfile  = 0;
let lastCompress = 0;

async function withBgBudget<T>(fn: () => Promise<T>): Promise<T | null> {
  if (bgLock || !gemini.canCall()) return null;
  bgLock = true;
  try { return await fn(); }
  finally { setTimeout(() => { bgLock = false; }, 30_000); }
}

async function runProfiler(client: Client) {
  if (Date.now() - lastProfile < PROFILER_INTERVAL) return;
  lastProfile = Date.now();

  await withBgBudget(async () => {
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
            await upsertMember(guild.id, m.author.id, {
              displayName: m.member?.displayName || m.author.username,
              username: m.author.username,
            });
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
                `${name}: ${lines.slice(0, 8).join(' | ')}`,
                0.4, BG_MODEL,
              );
              const m2 = raw.match(/\{[\s\S]*\}/);
              if (!m2) continue;
              const p = JSON.parse(m2[0]);
              if (p.p) await upsertMember(guild.id, uid, { personality: p.p });
            } catch {}
          }
        } catch {}
      }
    }
    console.log(`[Profiler] done`);
  });
}

async function runCompress(guildId: string, channelId: string) {
  if (Date.now() - lastCompress < COMPRESS_INTERVAL) return;
  const msgs = stmGet(channelId);
  if (msgs.length < 8) return;
  lastCompress = Date.now();

  await withBgBudget(async () => {
    const text = msgs.map(m => `${m.author}: ${m.content}`).join('\n').slice(0, 1800);
    try {
      const raw = await gemini.call(
        'extract memorable social facts from discord chat. output ONLY valid JSON: {"facts":["x"],"jokes":["x"],"patterns":["x"],"arcs":["x"],"openLoops":["x"]}',
        text, 0.4, BG_MODEL,
      );
      const m = raw.match(/\{[\s\S]*\}/);
      if (!m) return;
      const p = JSON.parse(m[0]);
      for (const f of (p.facts     || []).slice(0, 4)) await addFact(guildId, f, 'facts');
      for (const j of (p.jokes     || []).slice(0, 2)) await addFact(guildId, j, 'jokes');
      for (const x of (p.patterns  || []).slice(0, 2)) await addFact(guildId, x, 'patterns');
      for (const x of (p.arcs      || []).slice(0, 2)) await addFact(guildId, x, 'arcs');
      for (const x of (p.openLoops || []).slice(0, 3)) await addFact(guildId, x, 'openLoops');
      console.log(`[Compress] +${p.facts?.length||0}facts +${p.openLoops?.length||0}loops`);
    } catch {}

    const buf = sessionBuffers.get(channelId);
    if (!buf || buf.length < 10) return;
    const bufText = buf.join('\n').slice(-2500);
    try {
      const raw2 = await gemini.call(
        'summarize this discord chat in 2-3 sentences: main topics, who said what, mood/vibe. concise. output ONLY: {"s":"..."}',
        bufText, 0.3, BG_MODEL,
      );
      const m2 = raw2.match(/\{[\s\S]*\}/);
      if (!m2) return;
      const p2 = JSON.parse(m2[0]);
      if (p2.s?.trim()) {
        sessionSummaries.set(channelId, p2.s.trim().slice(0, 250));
        console.log(`[Compress] session summary updated #${channelId.slice(-5)}`);
      }
    } catch {}
  });
}

// ── PASSIVE SCAN (every 5 min, huge context, visits the channel it's interested in) ──
let passiveTickRunning = false;

async function runPassiveTick() {
  if (passiveTickRunning || !botClient || !gemini.canCall() || globallyMuted) return;
  passiveTickRunning = true;
  try {
    const channelId = pickInterestChannel();
    if (!channelId) return;

    const state = getChState(channelId);
    if (state.mode === 'active') return; // already engaged — the message-driven pipeline owns it

    const ch = botClient.channels.cache.get(channelId) as TextChannel | undefined;
    if (!ch?.isTextBased()) return;
    const guildId = (ch as any).guildId as string | undefined;
    if (!guildId) return;

    const speakState = await getSpeakState(channelId, guildId);
    if (speakState.mode === 'paused' && speakState.resumeAt && Date.now() < speakState.resumeAt) return;

    // a video was queued while this channel (or whichever channel focus drifted
    // from) was active — now that we're here and passive, this is the first
    // natural opening to bring it up. handle it instead of the normal scan;
    // the normal scan picks back up next tick like nothing happened.
    const queued = dequeuePendingVideo();
    if (queued) {
      await runVideoBrainCall(channelId, ch, guildId, speakState.mode, queued.title, queued.url);
      return;
    }

    const msgs = stmGet(channelId);
    const last = msgs[msgs.length - 1];
    const memCtx       = await buildMemCtx(guildId);
    const transcript    = stmFormatWithMarker(msgs, channelId);
    const serverName   = (ch as any).guild?.name || serverNameCache.get(guildId) || 'unknown';
    const channelName  = (ch as any).name || channelId.slice(-5);
    const statusLine = `mode: passive scan (5-min check-in, huge context, you may start something new) | speak: ${speakState.mode} | server: ${serverName} | channel: #${channelName}`;

    const brainOpts: BrainOpts = {
      model: PASSIVE_MODEL,
      sender: last ? last.author : '(quiet)',
      bond: 50,
      message: last ? last.content : '(no recent messages — decide if it’s worth starting something from memory, or stay quiet)',
      transcript, memCtx,
      mentioned: false, isDM: false, statusLine,
      inExchange: false, channelName, serverName,
      everyonePing: false, endingConvo: false,
    };

    let decision = await brain(brainOpts);
    decision = await executeBrainDecision({ decision, brainOpts, channel: ch, channelId, guildId });

    await sendDecision({ channel: ch, decision, channelId, guildId });
    advanceMarker(channelId, msgs.map(m => m.id), decision);
    unreadCounts.delete(channelId);
  } catch (e) { console.error('[PassiveTick]', e); }
  finally { passiveTickRunning = false; }
}

// ── NEW VIDEO HOOK (plug your youtube watcher into this) ───────────
// call notifyNewVideo(videoId, title, url) whenever your YT poller sees a new
// upload. it tries the focus channel right away if it's free (passive, not
// paused); if that channel's mid-conversation (active), the video gets
// queued instead of dropped — the next passive tick that lands on a channel
// which has gone quiet picks it up and gives the brain a chance to bring it
// up then. "ignore" is still a fully valid outcome — queueing only
// guarantees the brain gets ASKED, never that it posts.
const notifiedVideoIds = new Set<string>(); // hard guard: never mention the same video twice in a session
interface PendingVideo { videoId: string; title: string; url: string; queuedAt: number; }
const pendingVideoQueue: PendingVideo[] = [];
const PENDING_VIDEO_MAX_AGE_MS = 6 * 60 * 60_000; // stale after 6h — don't surface week-old "just posted this" energy

function dequeuePendingVideo(): PendingVideo | null {
  const now = Date.now();
  while (pendingVideoQueue.length) {
    const next = pendingVideoQueue.shift()!;
    if (now - next.queuedAt <= PENDING_VIDEO_MAX_AGE_MS) return next;
    console.log(`[NewVideo] dropped stale queued video: "${next.title}"`);
  }
  return null;
}

async function runVideoBrainCall(
  channelId: string, ch: TextChannel, guildId: string, speakMode: string, title: string, url: string,
) {
  const msgs        = stmGet(channelId);
  const last        = msgs[msgs.length - 1];
  const memCtx       = await buildMemCtx(guildId);
  const transcript    = stmFormatWithMarker(msgs, channelId);
  const serverName   = (ch as any).guild?.name || serverNameCache.get(guildId) || 'unknown';
  const channelName  = (ch as any).name || channelId.slice(-5);
  const statusLine = `mode: new video (you just posted one — bring it up casually if it fits, or don't) | speak: ${speakMode} | server: ${serverName} | channel: #${channelName}`;

  const brainOpts: BrainOpts = {
    model: PASSIVE_MODEL,
    sender: last ? last.author : '(quiet)',
    bond: 50,
    message: last ? last.content : '(chat is quiet — your call whether dropping the video starts something or just sits weird)',
    transcript, memCtx,
    mentioned: false, isDM: false, statusLine,
    inExchange: false, channelName, serverName,
    everyonePing: false, endingConvo: false,
    videoCtx: { title, url },
  };

  let decision = await brain(brainOpts);
  decision = await executeBrainDecision({ decision, brainOpts, channel: ch, channelId, guildId });

  await sendDecision({ channel: ch, decision, channelId, guildId });
  advanceMarker(channelId, msgs.map(m => m.id), decision);
}

export async function notifyNewVideo(videoId: string, title: string, url: string) {
  if (!botClient || !gemini.canCall()) return;
  if (notifiedVideoIds.has(videoId)) return; // already brought this one up once
  notifiedVideoIds.add(videoId);

  if (globallyMuted) {
    // still queue it — once !resume happens the passive tick will pick this
    // up same as any other queued video. don't post anything while muted.
    pendingVideoQueue.push({ videoId, title, url, queuedAt: Date.now() });
    return;
  }

  try {
    const channelId = pickInterestChannel();
    if (!channelId) { pendingVideoQueue.push({ videoId, title, url, queuedAt: Date.now() }); return; }

    const state = getChState(channelId);
    if (state.mode === 'active') {
      // mid-conversation — don't interrupt. queue it for the next passive tick
      // that finds this (or whichever) channel free.
      pendingVideoQueue.push({ videoId, title, url, queuedAt: Date.now() });
      console.log(`[NewVideo] queued — channel active: "${title}"`);
      return;
    }

    const ch = botClient.channels.cache.get(channelId) as TextChannel | undefined;
    if (!ch?.isTextBased()) { pendingVideoQueue.push({ videoId, title, url, queuedAt: Date.now() }); return; }
    const guildId = (ch as any).guildId as string | undefined;
    if (!guildId) { pendingVideoQueue.push({ videoId, title, url, queuedAt: Date.now() }); return; }

    const speakState = await getSpeakState(channelId, guildId);
    if (speakState.mode === 'paused' && speakState.resumeAt && Date.now() < speakState.resumeAt) {
      pendingVideoQueue.push({ videoId, title, url, queuedAt: Date.now() });
      return;
    }

    await runVideoBrainCall(channelId, ch, guildId, speakState.mode, title, url);
  } catch (e) { console.error('[NewVideo]', e); }
}

// ── YOUTUBE DATA API POLLER (OAuth) ─────────────────────────────────
// uses your channel's own OAuth credentials (client id/secret + refresh
// token) instead of the public RSS feed — more reliable, no lag, and
// resolves "your" channel automatically via mine=true, no channel ID needed.
// set YT_CLIENT_ID, YT_CLIENT_SECRET, YT_REFRESH_TOKEN in env. poll runs
// automatically once startBot() is called if all three are present.
let lastSeenVideoId: string | null = null;
let ytPollRunning = false;
let ytAccessToken: string | null = null;
let ytAccessTokenExpiresAt = 0;
let ytUploadsPlaylistId: string | null = null; // cached after first lookup — doesn't change for a channel

async function getYtAccessToken(): Promise<string | null> {
  if (ytAccessToken && Date.now() < ytAccessTokenExpiresAt - 60_000) return ytAccessToken;
  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     YT_CLIENT_ID,
        client_secret: YT_CLIENT_SECRET,
        refresh_token: YT_REFRESH_TOKEN,
        grant_type:    'refresh_token',
      }),
    });
    if (!res.ok) {
      console.warn(`[YtPoll] token refresh failed: ${res.status} ${(await res.text().catch(() => '')).slice(0, 150)}`);
      return null;
    }
    const data = await res.json() as any;
    ytAccessToken = data.access_token;
    ytAccessTokenExpiresAt = Date.now() + (data.expires_in ?? 3600) * 1000;
    return ytAccessToken;
  } catch (e: any) {
    console.warn('[YtPoll] token refresh error:', e.message?.slice(0, 80));
    return null;
  }
}

async function getYtUploadsPlaylistId(token: string): Promise<string | null> {
  if (ytUploadsPlaylistId) return ytUploadsPlaylistId;
  try {
    const res = await fetch(
      'https://www.googleapis.com/youtube/v3/channels?part=contentDetails&mine=true',
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) {
      console.warn(`[YtPoll] channels lookup failed: ${res.status}`);
      return null;
    }
    const data = await res.json() as any;
    const playlistId = data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    if (!playlistId) { console.warn('[YtPoll] no uploads playlist found on this token\'s channel'); return null; }
    ytUploadsPlaylistId = playlistId;
    console.log(`[YtPoll] resolved uploads playlist: ${playlistId}`);
    return playlistId;
  } catch (e: any) {
    console.warn('[YtPoll] channels lookup error:', e.message?.slice(0, 80));
    return null;
  }
}

// ── REAL CHANNEL INFO (name, handle, subscriber count — via the same OAuth token) ──
// cached for an hour since subscriber counts don't need to be fetched every call,
// and this hits the same quota as the uploads-playlist lookup above.
interface YtChannelInfo { title: string; handle: string; subscriberCount: string; videoCount: string; }
let ytChannelInfoCache: { d: YtChannelInfo; ts: number } | null = null;
const YT_CHANNEL_INFO_TTL_MS = 60 * 60_000;

async function getYtChannelInfo(): Promise<YtChannelInfo | string> {
  if (!YT_CLIENT_ID || !YT_CLIENT_SECRET || !YT_REFRESH_TOKEN) {
    return 'youtube not connected — YT_CLIENT_ID/SECRET/REFRESH_TOKEN not set on the host';
  }
  if (ytChannelInfoCache && Date.now() - ytChannelInfoCache.ts < YT_CHANNEL_INFO_TTL_MS) {
    return ytChannelInfoCache.d;
  }
  const token = await getYtAccessToken();
  if (!token) return 'could not refresh youtube access token';
  try {
    const res = await fetch(
      'https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true',
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) return `channel lookup failed: ${res.status}`;
    const data = await res.json() as any;
    const item = data.items?.[0];
    if (!item) return 'no channel found on this token';
    const info: YtChannelInfo = {
      title: item.snippet?.title ?? 'unknown',
      handle: item.snippet?.customUrl ?? '',
      subscriberCount: item.statistics?.hiddenSubscriberCount ? 'hidden' : (item.statistics?.subscriberCount ?? 'unknown'),
      videoCount: item.statistics?.videoCount ?? 'unknown',
    };
    ytChannelInfoCache = { d: info, ts: Date.now() };
    return info;
  } catch (e: any) {
    return `channel lookup error: ${e.message?.slice(0, 80)}`;
  }
}

async function runYtPoll() {
  if (ytPollRunning || !YT_CLIENT_ID || !YT_CLIENT_SECRET || !YT_REFRESH_TOKEN) return;
  ytPollRunning = true;
  try {
    const token = await getYtAccessToken();
    if (!token) return;
    const playlistId = await getYtUploadsPlaylistId(token);
    if (!playlistId) return;

    const res = await fetch(
      `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${playlistId}&maxResults=1`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) { console.warn(`[YtPoll] playlistItems fetch failed: ${res.status}`); return; }
    const data = await res.json() as any;
    const item = data.items?.[0];
    const videoId = item?.snippet?.resourceId?.videoId;
    const title   = item?.snippet?.title;
    if (!videoId) return;

    if (lastSeenVideoId === null) {
      // first run after boot — just learn the current latest, don't announce
      // whatever was already posted before the bot started watching.
      lastSeenVideoId = videoId;
      console.log(`[YtPoll] baseline set: "${title}"`);
      return;
    }

    if (videoId !== lastSeenVideoId) {
      lastSeenVideoId = videoId;
      console.log(`[YtPoll] new upload detected: "${title}"`);
      await notifyNewVideo(videoId, title || 'new video', `https://www.youtube.com/watch?v=${videoId}`);
    }
  } catch (e: any) {
    console.warn('[YtPoll] failed:', e.message?.slice(0, 80));
  } finally { ytPollRunning = false; }
}

// ── SELF-ACTIVATION (noticed it got ghosted) ──────────────────────
async function runSelfActivationCheck() {
  if (!botClient || !gemini.canCall() || globallyMuted) return;
  const now = Date.now();

  for (const [channelId, state] of channelState.entries()) {
    if (state.mode !== 'active') continue;
    if (!state.lastBotMsgAt || state.gotResponseSinceLastBotMsg) continue;
    if (now - state.lastBotMsgAt < SELF_CHECK_QUIET_MS) continue;

    const ch = botClient.channels.cache.get(channelId) as TextChannel | undefined;
    if (!ch?.isTextBased()) continue;
    const guildId = ((ch as any).guildId as string | undefined) ?? 'dm';

    try {
      const memCtx      = guildId === 'dm' ? '' : await buildMemCtx(guildId);
      const liveMsgs     = stmGet(channelId);
      const transcript   = stmFormatWithMarker(liveMsgs, channelId);
      const serverName  = (ch as any).guild?.name || serverNameCache.get(guildId) || (guildId === 'dm' ? 'DM' : 'unknown');
      const channelName = (ch as any).name || channelId.slice(-5);
      const quietMin    = Math.round((now - state.lastBotMsgAt) / 60_000);
      const statusLine  = `mode: self-check (you spoke, nobody replied) | speak: active | server: ${serverName} | channel: #${channelName}`;

      const brainOpts: BrainOpts = {
        model: ACTIVE_MODEL,
        sender: '(self-check)', bond: 50,
        message: `(${quietMin}m since your last message, nobody's replied — decide what, if anything, to do. don't force it.)`,
        transcript, memCtx,
        mentioned: false, isDM: guildId === 'dm', statusLine,
        inExchange: false, channelName, serverName,
        everyonePing: false, endingConvo: false,
        goal: state.goal,
      };

      let decision = await brain(brainOpts);
      decision = await executeBrainDecision({ decision, brainOpts, channel: ch, channelId, guildId });
      await sendDecision({ channel: ch, decision, channelId, guildId });
      advanceMarker(channelId, liveMsgs.map(m => m.id), decision);

      state.gotResponseSinceLastBotMsg = true; // prevent an immediate re-fire loop
      if (decision.action !== 'speak') revertToPassive(channelId, 'gave up waiting');
    } catch (e) { console.error('[SelfCheck]', e); }
  }
}

// ── DIRECT MESSAGES ───────────────────────────────────────────────
const dmDebounce = new Map<string, NodeJS.Timeout>();
const dmPending  = new Map<string, Message>();

async function handleDirectMessage(msg: Message) {
  const channelId = msg.channelId;
  const sender    = msg.author.username;
  const content   = cleanContent(msg.content);

  cacheId(msg.author.id, sender);

  if (!stmStore.has(channelId)) {
    try {
      const fetched = await msg.channel.messages.fetch({ limit: STM_MAX });
      seedSTM(channelId, ([...fetched.values()] as Message[]).reverse());
    } catch {}
  }

  stmPush(channelId, {
    ts: msg.createdTimestamp, id: msg.id, authorId: msg.author.id, author: sender,
    content: content.length > 300 ? content.slice(0, 297) + '…' : content,
  });

  dmPending.set(channelId, msg);
  if (dmDebounce.has(channelId)) clearTimeout(dmDebounce.get(channelId)!);
  dmDebounce.set(channelId, setTimeout(() => {
    dmDebounce.delete(channelId);
    const trigger = dmPending.get(channelId);
    dmPending.delete(channelId);
    if (trigger) respondToDM(trigger).catch(e => console.error('[DM] error:', e));
  }, DM_DEBOUNCE_MS));
}

async function respondToDM(msg: Message) {
  if (!gemini.canCall()) return;

  const channelId = msg.channelId;
  const sender    = msg.author.username;
  const content   = cleanContent(msg.content);

  let threadCtx: string | undefined;
  if (msg.reference?.messageId) {
    try {
      const ref = await msg.channel.messages.fetch(msg.reference.messageId);
      threadCtx = `${ref.author.id === BOT_ID ? BOT_NAME : ref.author.username}: "${cleanContent(ref.content).slice(0, 200)}"`;
    } catch {}
  }

  const recentMsgs  = stmGet(channelId).slice(-10);
  const botReplied  = recentMsgs.some(m => m.authorId === BOT_ID);
  const senderCount = recentMsgs.filter(m => m.authorId === msg.author.id).length;
  const inExchange  = botReplied && senderCount >= 2;
  const endingConvo = /\b(bye|cya|gotta go|gtg|see ya|later|good night|gn|logging off|ttyl|im out)\b/i.test(content);

  const liveMsgs = stmGet(channelId);
  const brainOpts: BrainOpts = {
    model: ACTIVE_MODEL,
    sender, bond: 50, message: content,
    transcript: stmFormatWithMarker(liveMsgs, channelId),
    thread: threadCtx, memCtx: '',
    mentioned: true, isDM: true,
    statusLine: `mode: dm | speak: active | server: DM | channel: #dm`,
    inExchange, channelName: 'DM', serverName: 'DM',
    everyonePing: false, endingConvo,
  };

  let decision = await brain(brainOpts);
  decision = await executeBrainDecision({ decision, brainOpts, channel: msg.channel, replyToMsg: msg, channelId, guildId: 'dm' });
  await sendDecision({ channel: msg.channel, decision, channelId, guildId: 'dm', replyToMsg: msg });
  advanceMarker(channelId, liveMsgs.map(m => m.id), decision);
}

// ── ACTIVE-MODE BATCHING (every message while active; bursts get queued + merged) ──
interface QueuedMsg { msg: Message; mentioned: boolean; everyonePing: boolean; }
const inFlight     = new Set<string>();
const activeQueue   = new Map<string, QueuedMsg[]>();

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

// NOTE on the "don't reply to msgs that land mid-think" behavior:
// while brain() is awaiting the Gemini call for an in-flight batch, any new
// messages that arrive get queued into activeQueue (see enqueueActive above)
// rather than firing a second concurrent brain() call. drainActiveQueue only
// picks up the NEXT batch after the current processActiveBatch() fully
// finishes (including sendDecision + advanceMarker). so messages 2-5 that
// arrive while message 1 is being thought about never get their own reply —
// they just sit there and get folded into the transcript (below the marker)
// for the next pass, exactly like the spec asks for.
async function processActiveBatch(channelId: string, guildId: string, batch: QueuedMsg[]) {
  const last = batch[batch.length - 1].msg;

  const speakState = await getSpeakState(channelId, guildId);
  const anyMentioned = batch.some(b => b.mentioned);
  if (speakState.mode === 'paused' && speakState.resumeAt && Date.now() < speakState.resumeAt && !anyMentioned) {
    return; // explicit admin override (!pause) — manual circuit breaker, not a judgment skip
  }
  if (!gemini.canCall()) return;

  const tSender      = last.member?.displayName || last.author.username;
  const tContent      = cleanContent(last.content);
  const tChannelName  = (last.channel as any).name ?? 'unknown';
  const tServerName   = last.guild?.name || serverNameCache.get(guildId) || 'unknown';
  const tEveryonePing = batch.some(b => b.everyonePing);

  let threadCtx: string | undefined;
  if (last.reference?.messageId) {
    try {
      const ref = await last.channel.messages.fetch(last.reference.messageId);
      const refAuthor = ref.author.id === BOT_ID ? BOT_NAME : (ref.member?.displayName || ref.author.username);
      threadCtx = `${refAuthor}: "${cleanContent(ref.content).slice(0, 200)}"`;
    } catch {}
  }

  const [memberData, memCtx] = await Promise.all([
    getMember(guildId, last.author.id),
    buildMemCtx(guildId),
  ]);
  const bond  = typeof memberData.bond === 'number' ? memberData.bond : 50;
  const state = getChState(channelId);

  const recentMsgs  = stmGet(channelId).slice(-12);
  const botReplied  = recentMsgs.some(m => m.authorId === BOT_ID);
  const senderCount = recentMsgs.filter(m => m.authorId === last.author.id).length;
  const inExchange  = botReplied && senderCount >= 2;
  const endingConvo = /\b(bye|cya|gotta go|gtg|see ya|later|good night|gn|logging off|ttyl|im out)\b/i.test(tContent);

  const statusLine = `mode: active (goal: ${state.goal || 'none set'}) | speak: ${speakState.mode} | server: ${tServerName} | channel: #${tChannelName}`;

  const liveMsgs = stmGet(channelId);
  const brainOpts: BrainOpts = {
    model: ACTIVE_MODEL,
    sender: tSender, bond, message: tContent,
    transcript: stmFormatWithMarker(liveMsgs, channelId),
    thread: threadCtx, memCtx,
    mentioned: anyMentioned, isDM: false, statusLine,
    inExchange, channelName: tChannelName, serverName: tServerName,
    everyonePing: tEveryonePing, endingConvo,
    goal: state.goal, batchSize: batch.length,
  };

  let decision = await brain(brainOpts);
  console.log(`[Brain] ${tSender}: ${decision.action}${decision.reply ? ` — "${decision.reply.slice(0, 50)}"` : decision.reaction ? ` — ${decision.reaction}` : ''}`);

  decision = await executeBrainDecision({ decision, brainOpts, channel: last.channel, replyToMsg: last, channelId, guildId });

  // resolve which message in this batch the model actually wants to reply/react to —
  // falls back to the last (trigger) message if replyToMsgId is empty/unrecognized.
  const targetMsg = batch.find(b => b.msg.id === decision.replyToMsgId)?.msg ?? last;

  await sendDecision({ channel: last.channel, decision, channelId, guildId, replyToMsg: targetMsg });
  advanceMarker(channelId, liveMsgs.map(m => m.id), decision);

  runCompress(guildId, channelId).catch(() => {});
}

// ── DEDUP GUARD ────────────────────────────────────────────────────
// belt-and-suspenders: protects against the same message getting handled
// twice, whether from a redelivered gateway event or two bot processes
// accidentally running off the same token. caps its own size so it can't
// leak memory over a long-running process — a rolling window of recent IDs
// is plenty since duplicates, if they happen, land within the same second.
const seenMessageIds = new Set<string>();
const SEEN_IDS_MAX = 2000;

function alreadyHandled(id: string): boolean {
  if (seenMessageIds.has(id)) return true;
  seenMessageIds.add(id);
  if (seenMessageIds.size > SEEN_IDS_MAX) {
    const first = seenMessageIds.values().next().value;
    if (first !== undefined) seenMessageIds.delete(first);
  }
  return false;
}

// ── GUILD MESSAGE HANDLER ─────────────────────────────────────────
async function handleMessage(msg: Message) {
  if (msg.partial) {
    try { msg = await msg.fetch(); } catch { return; }
  }
  if (msg.author.bot || !msg.content?.trim()) return;
  if (globallyMuted) return; // !stop was used — only the admin listener still runs, so !resume still works
  if (alreadyHandled(msg.id)) { console.warn(`[Dedup] skipped duplicate event for msg ${msg.id}`); return; }
  if (msg.channel.isDMBased()) return handleDirectMessage(msg);

  try {
    const guildId     = msg.guildId!;
    const channelId   = msg.channelId;
    const mentioned   = BOT_ID ? msg.mentions.has(BOT_ID) : false;
    const everyonePing = msg.mentions.everyone ?? false;
    const sender      = msg.member?.displayName || msg.author.username;
    const content     = cleanContent(msg.content);
    const channelName = (msg.channel as any).name ?? 'unknown';

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
      content: content.length > 300 ? content.slice(0, 297) + '…' : content,
    });

    const state = getChState(channelId);
    if (state.lastBotMsgAt) state.gotResponseSinceLastBotMsg = true;
    touchActivity(channelId);

    maybeLogHistory(channelId, guildId).catch(() => {});

    if (mentioned && state.mode !== 'active') goActive(channelId, 'got pinged');

    // active channels get every message (batched if bursty); passive channels just buffer —
    // the 5-min scan is what decides if a quiet channel is worth a word.
    // note: messages that arrive WHILE a previous batch is still being thought about
    // (inFlight.has(channelId) === true) get queued here and picked up by the next
    // drainActiveQueue loop iteration, not given their own brain() call — see the
    // comment above processActiveBatch for how that interacts with the marker.
    if (mentioned || getChState(channelId).mode === 'active') {
      enqueueActive(channelId, guildId, { msg, mentioned, everyonePing });
    }
  } catch (e) { console.error('[Handler outer]', e); }
}

// ── STARTUP ───────────────────────────────────────────────────────
export async function startBot(token: string) {
  if (botClient) return;

  botClient = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
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
╔══════════════════════════════════════════════════════════╗
║  ✓ ${BOT_NAME} — Gemini Multi-Key
║  ACTIVE  : ${ACTIVE_MODEL}  (every msg while engaged + pings)
║  PASSIVE : ${PASSIVE_MODEL}  (5-min huge-context scan)
║  BG      : ${BG_MODEL}  (profiler / compress / history)
║  STATUS  : ${gemini.status()}
║  STM     : ${STM_MAX} msgs | passive tick: ${PASSIVE_TICK_MS/60000}m | self-check: ${SELF_CHECK_QUIET_MS/60000}m
╚══════════════════════════════════════════════════════════╝\n`);

    botClient!.user!.setPresence({ status: 'online', activities: [{ name: 'the chat', type: 3 }] });

    for (const g of botClient!.guilds.cache.values()) {
      cacheServerName(g.id, g.name);
      await db.collection('servers').doc(g.id).set({ name: g.name, updatedAt: new Date().toISOString() }, { merge: true }).catch(() => {});
      for (const ch of g.channels.cache.filter(c => c.isTextBased()).values()) {
        cacheChannelName(ch.id, (ch as any).name);
      }
      const members = await g.members.fetch().catch(() => null);
      if (members) {
        for (const [uid, m] of members) {
          if (m.user.bot) continue;
          cacheId(uid, m.displayName);
          await upsertMember(g.id, uid, { displayName: m.displayName, username: m.user.username });
        }
        console.log(`[Boot] synced ${members.size} members — "${g.name}"`);
      }
      try {
        const snap = await db.collection('servers').doc(g.id).collection('members').get();
        let w = 0;
        for (const doc of snap.docs) {
          const d = doc.data() as MemberData;
          const name = d.displayName || d.username;
          if (name && !idCache.has(doc.id)) { cacheId(doc.id, name); w++; }
        }
        if (w) console.log(`[Boot] warmed ${w} past members from Firebase — "${g.name}"`);
      } catch {}
    }

    setTimeout(() => {
      if (botClient) runProfiler(botClient).catch(() => {});
      setInterval(() => { if (botClient) runProfiler(botClient).catch(() => {}); }, PROFILER_INTERVAL);
    }, 30 * 60_000);

    setInterval(() => { runPassiveTick().catch(() => {}); }, PASSIVE_TICK_MS);
    setInterval(() => { runSelfActivationCheck().catch(() => {}); }, PASSIVE_TICK_MS);

    if (YT_CLIENT_ID && YT_CLIENT_SECRET && YT_REFRESH_TOKEN) {
      runYtPoll().catch(() => {});
      setInterval(() => { runYtPoll().catch(() => {}); }, YT_POLL_INTERVAL_MS);
      console.log(`[YtPoll] watching for new uploads via OAuth, every ${YT_POLL_INTERVAL_MS / 60_000}m`);
    } else {
      console.log('[YtPoll] YT_CLIENT_ID / YT_CLIENT_SECRET / YT_REFRESH_TOKEN not all set — skipping');
    }
  });

  botClient.on(Events.MessageCreate, handleMessage);

  botClient.on(Events.GuildMemberAdd, async (m) => {
    if (m.user.bot) return;
    cacheId(m.id, m.displayName);
    await upsertMember(m.guild.id, m.id, { displayName: m.displayName, username: m.user.username });
  });

  botClient.on(Events.GuildMemberUpdate, async (_, m) => {
    if (m.user.bot) return;
    cacheId(m.id, m.displayName);
    await upsertMember(m.guild.id, m.id, { displayName: m.displayName });
  });

  // ── ADMIN COMMANDS ──────────────────────────────────────────────
  // locked to one person, not discord roles/permissions — only this user ID
  // can run admin commands, regardless of their server roles anywhere.
  const ADMIN_ID = '1296109674361520146';

  botClient.on(Events.MessageCreate, async (msg) => {
    if (msg.author.id !== ADMIN_ID) return;

    const c       = msg.content.trim();
    const guildId = msg.guildId!;
    const chId    = msg.channelId;

    if (c === '!wake')    { await setSpeakState(chId, guildId, { mode: 'active', reason: 'admin' }); msg.reply('im up'); }
    if (c === '!sleep')   { await setSpeakState(chId, guildId, { mode: 'waiting', reason: 'admin' }); msg.reply('going quiet'); }
    if (c.startsWith('!pause ')) {
      const mins = parseInt(c.split(' ')[1]) || 10;
      await setSpeakState(chId, guildId, { mode: 'paused', resumeAt: Date.now() + mins * 60_000, reason: 'admin' });
      msg.reply(`paused ${mins}m`);
    }
    if (c.startsWith('!active')) { goActive(chId, 'admin'); msg.reply('active'); }
    if (c === '!passive') { revertToPassive(chId, 'admin'); msg.reply('passive mode'); }
    if (c === '!status') {
      const st    = getChState(chId);
      const speak = await getSpeakState(chId, guildId);
      const marker = getMarker(chId);
      await msg.reply([
        `global: ${globallyMuted ? '🔇 muted (!resume to undo)' : '🟢 live'}`,
        `mode: ${st.mode}${st.goal ? ` (goal: ${st.goal})` : ''}`,
        `speak: ${speak.mode}${speak.resumeAt ? ` until ${new Date(speak.resumeAt).toLocaleTimeString()}` : ''}`,
        `focus: ${focus?.channelId === chId ? 'yes' : 'no'}`,
        `marker: ${marker.markerId ? `...${marker.markerId.slice(-6)}` : 'none'}${marker.pendingQuestionId ? ` (pending q: ...${marker.pendingQuestionId.slice(-6)})` : ''}`,
        gemini.status(),
        `bgLock: ${bgLock}`,
      ].join('\n'));
    }
    if (c === '!memory') {
      const m = await getMemory(guildId);
      await msg.reply(
        `facts(${m.facts.length}): ${m.facts.slice(-4).join(' | ') || 'none'}\n` +
        `jokes(${m.jokes.length}): ${m.jokes.slice(-3).join(' | ') || 'none'}\n` +
        `loops(${m.openLoops.length}): ${m.openLoops.slice(-3).join(' | ') || 'none'}\n` +
        `arcs(${m.arcs.length}): ${m.arcs.slice(-3).join(' | ') || 'none'}`
      );
    }
    if (c.startsWith('!remember ')) { await addFact(guildId, c.slice(10).trim()); msg.reply('noted'); }
    if (c === '!stm') { await msg.reply(`\`\`\`\n${stmFormatWithMarker(stmGet(chId), chId).slice(0, 1900)}\n\`\`\``); }
    if (c === '!scan' || c === '!proactive') { await msg.reply('scanning...'); await runPassiveTick().catch(() => {}); await msg.reply('done'); }
    if (c === '!budget') { await msg.reply(gemini.status()); }
    if (c.startsWith('!who ')) {
      const uid = msg.mentions.users.first()?.id || c.split(' ')[1]?.trim();
      if (!uid) { msg.reply('usage: !who @user'); return; }
      const m = await getMember(guildId, uid);
      await msg.reply(`${m.displayName || uid}\nbond: ${m.bond ?? 50}/100\n${m.personality || '(no profile yet)'}`);
    }
    if (c === '!history') {
      const logs = await getHistory(chId, Date.now() - 24 * 60 * 60_000, Date.now());
      await msg.reply(logs.slice(0, 1900) || 'no recent logs');
    }
    if (c.startsWith('!testvideo')) {
      const title = c.slice(10).trim() || 'test upload';
      await msg.reply(`firing notifyNewVideo("test-${Date.now()}", "${title}", "https://youtu.be/test")...`);
      await notifyNewVideo(`test-${Date.now()}`, title, 'https://youtu.be/test').catch(() => {});
    }
    if (c === '!videoqueue') {
      await msg.reply(pendingVideoQueue.length
        ? pendingVideoQueue.map(v => `"${v.title}" — queued ${humanDuration(Date.now() - v.queuedAt)}`).join('\n')
        : 'queue empty');
    }
    if (c === '!ytdebug') {
      await msg.reply([
        `creds set: ${!!(YT_CLIENT_ID && YT_CLIENT_SECRET && YT_REFRESH_TOKEN)}`,
        `access token cached: ${!!ytAccessToken}${ytAccessToken ? ` (expires ${new Date(ytAccessTokenExpiresAt).toLocaleTimeString()})` : ''}`,
        `uploads playlist: ${ytUploadsPlaylistId || 'not resolved yet'}`,
        `last seen video id: ${lastSeenVideoId || 'none yet (baseline not set)'}`,
      ].join('\n'));
    }
    if (c === '!stop') {
      globallyMuted = true;
      await msg.reply('going quiet everywhere. !resume to bring me back');
    }
    if (c === '!resume' || c === '!start') {
      globallyMuted = false;
      await msg.reply('back 🫡');
    }
    if (c === '!shutdown') {
      await msg.reply('shutting down for real 💀 — needs a restart from the host to come back, !resume won\'t work after this');
      stopBot();
    }
  });

  await botClient.login(token);
}

export function stopBot() { botClient?.destroy(); botClient = null; globallyMuted = false; }
export function getBotStatus() { return !botClient ? 'stopped' : globallyMuted ? 'muted' : 'running'; }
