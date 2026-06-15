import {
  Client, GatewayIntentBits, Message, Partials,
  Events, TextChannel,
} from 'discord.js';
import { db } from './firebase.ts';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// ── MODELS ───────────────────────────────────────────────────────
// Cerebras free tier: 1M tokens/day, 30 RPM, 14,400 RPD, 8192 ctx window
// Prompt caching: static prefix cached in 128-token blocks for up to 1hr
// Strategy: keep system prompt SHORT and STATIC → gets cached → near-free
//           only pay tokens for the dynamic tail (transcript + trigger)

const BRAIN_MODEL = 'gpt-oss-120b';  // main responses
const FAST_MODEL  = 'zai-glm-4.7';    // background jobs (profiler, compress, proactive)
const DAILY_TOKEN_BUDGET = 1_000_000;
const SOFT = 0.85;

// ── ESTIMATED TOKEN COSTS ────────────────────────────────────────
// System prompt ≈ 350 tokens (static → cached after first call)
// Dynamic tail  ≈ 250–400 tokens (transcript + trigger)
// Response      ≈ 60–120 tokens
// Effective cost per call (after caching) ≈ 350–500 tokens
const EST_TOKENS_PER_CALL = 800;  // gpt-oss-120b reasoning model uses ~600-800 tok/call in practice
const EST_BG_TOKENS = 150; // 8b is cheaper

// ── CEREBRAS MANAGER ─────────────────────────────────────────────
// Multi-key rotation: round-robin, with 429 cooldown per key
// Daily budget tracked globally (all keys share 1M limit IF same account)
// If keys are different accounts → each has its own 1M, we just round-robin

class CerebrasManager {
  private keys:      string[];
  private cooldowns: Map<string, number> = new Map();
  private idx        = 0;

  // Global token budget tracker
  private dailyUsed  = 0;
  private dailyReset = Date.now() + 86_400_000;

  // Per-minute rate (30 RPM hard limit)
  private minuteCalls: number[] = [];

  constructor() {
    const raw = process.env.CEREBRAS_API_KEYS || process.env.CEREBRAS_API_KEY || '';
    this.keys = raw.split(',').map(k => k.trim()).filter(Boolean);
    if (!this.keys.length) { console.error('[Cerebras] no keys found'); process.exit(1); }
    console.log(`[Cerebras] ${this.keys.length} key(s) loaded`);
  }

  private resetIfNewDay() {
    if (Date.now() > this.dailyReset) {
      this.dailyUsed  = 0;
      this.dailyReset = Date.now() + 86_400_000;
      this.cooldowns.clear();
      console.log('[Cerebras] daily budget reset');
    }
  }

  canCall(est = EST_TOKENS_PER_CALL): boolean {
    this.resetIfNewDay();
    // Clean minute window
    const cutoff = Date.now() - 60_000;
    this.minuteCalls = this.minuteCalls.filter(t => t > cutoff);

    return this.dailyUsed + est < DAILY_TOKEN_BUDGET * SOFT
        && this.minuteCalls.length < 30 * SOFT;
  }

  private pickKey(): string | null {
    const now = Date.now();
    // Try round-robin starting from current idx, skip cooled-down keys
    for (let i = 0; i < this.keys.length; i++) {
      const k = this.keys[(this.idx + i) % this.keys.length];
      const cd = this.cooldowns.get(k);
      if (!cd || now > cd) {
        this.idx = (this.idx + i + 1) % this.keys.length;
        return k;
      }
    }
    // All keys on cooldown — find the one cooling down soonest
    let best = this.keys[0];
    let bestCd = Infinity;
    for (const k of this.keys) {
      const cd = this.cooldowns.get(k) ?? 0;
      if (cd < bestCd) { bestCd = cd; best = k; }
    }
    return best;
  }

  async call(
    messages: { role: string; content: string }[],
    temp     = 0.85,
    maxTok   = 150,
    model    = BRAIN_MODEL,
  ): Promise<string> {
    this.resetIfNewDay();

    for (let attempt = 0; attempt < this.keys.length * 2; attempt++) {
      const key = this.pickKey();
      if (!key) throw new Error('[Cerebras] no keys available');

      try {
        const res = await fetch('https://api.cerebras.ai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type':  'application/json',
            'Authorization': `Bearer ${key}`,
          },
          body: JSON.stringify({
            model,
            messages,
            temperature: temp,
            max_tokens:  maxTok,
          }),
        });

        if (res.status === 429) {
          const body    = await res.json().catch(() => ({})) as any;
          const retryMs = (body?.retry_after ?? 5) * 1000;
          this.cooldowns.set(key, Date.now() + retryMs);
          console.warn(`[Cerebras] ...${key.slice(-4)} 429 — cooldown ${retryMs / 1000}s`);
          continue;
        }

        if (!res.ok) {
          const err = await res.text().catch(() => res.statusText);
          throw new Error(`Cerebras ${res.status}: ${err.slice(0, 100)}`);
        }

        const data        = await res.json() as any;
        const choice      = data.choices?.[0];
        const text        = choice?.message?.content ?? '';
        const finishReason = choice?.finish_reason ?? 'unknown';
        const tokUsed     = data.usage?.total_tokens ?? maxTok;

        this.dailyUsed += tokUsed;
        this.minuteCalls.push(Date.now());

        const left = Math.round((DAILY_TOKEN_BUDGET * SOFT - this.dailyUsed) / 1000);
        console.log(`[Cerebras] ${tokUsed}tok | finish:${finishReason} | daily left ≈${left}k | rpm ${this.minuteCalls.length}/25`);

        if (!text && finishReason === 'length') {
          console.warn(`[Cerebras] empty content + finish:length — gpt-oss-120b used all tokens on reasoning. increase max_tokens.`);
        }

        return text;

      } catch (e: any) {
        if (e.message?.startsWith('Cerebras 429')) continue; // already handled
        console.error(`[Cerebras] attempt ${attempt + 1}: ${e.message?.slice(0, 80)}`);
        if (attempt < this.keys.length * 2 - 1) await sleep(Math.min(1500 * 2 ** attempt, 8000));
      }
    }
    throw new Error('[Cerebras] all attempts failed');
  }

  status() {
    const now  = Date.now();
    const left = Math.round((DAILY_TOKEN_BUDGET * SOFT - this.dailyUsed) / 1000);
    const keys = this.keys.map(k =>
      `...${k.slice(-4)}${this.cooldowns.get(k) && now < this.cooldowns.get(k)!
        ? ` (cd ${Math.ceil((this.cooldowns.get(k)! - now) / 1000)}s)` : ''}`
    ).join(' | ');
    return `${keys} | daily left ≈${left}k tokens | rpm ${this.minuteCalls.length}/25`;
  }
}

const cerebras = new CerebrasManager();

// ── CONTEXT BUDGET (8192 ctx limit on free Cerebras) ─────────────
// System prompt:   ≈ 350 tokens  (STATIC — gets prompt-cached)
// memCtx:          ≤ 150 tokens
// transcript:      ≤ 600 tokens  (last 12 msgs, trimmed)
// thread ref:      ≤ 100 tokens
// trigger msg:     ≤ 100 tokens
// Total dynamic:   ≈ 1000 tokens — well under 8192

const MAX_TRANSCRIPT_CHARS = 1800;  // ≈ 450 tokens
const MAX_MEM_CHARS        = 400;   // ≈ 100 tokens
const MAX_SUMMARY_CHARS    = 300;   // ≈ 75 tokens — compressed session context

// ── SESSION BUFFER (mid-term memory) ─────────────────────────────
// Holds up to 60 msgs per channel. STM (12) = what the bot sees raw.
// Session buffer feeds the compress job to build a running summary.
const SESSION_BUFFER_MAX  = 60;
const sessionBuffers       = new Map<string, string[]>();
const sessionSummaries     = new Map<string, string>();

function sessionBufferPush(channelId: string, line: string) {
  if (!sessionBuffers.has(channelId)) sessionBuffers.set(channelId, []);
  const arr = sessionBuffers.get(channelId)!;
  arr.push(line);
  if (arr.length > SESSION_BUFFER_MAX) arr.shift();
}

// ── CONSTANTS ────────────────────────────────────────────────────
const DEBOUNCE_MS        = 4000;
const DM_DEBOUNCE_MS     = 1200;
const STM_MAX            = 12;
const GAP_MAJOR_MS       = 25 * 60_000;
const GAP_MINOR_MS       =  5 * 60_000;
const PASSIVE_EVERY      = 5;
const PASSIVE_EVERY_BUSY = 8;
const ACTIVE_MINS        = 8;
const VELOCITY_WINDOW_MS = 10_000;
const VELOCITY_THRESH    = 5;
const MONOPOLY_N         = 6;
const PROFILER_INTERVAL  = 20 * 60_000;
const COMPRESS_INTERVAL  = 90 * 60_000;
const PROACTIVE_INTERVAL = 35 * 60_000;
const MIN_BRAIN_GAP_MS   = 2200;
const PAUSE_MAX_MINS     = 30;

let lastBrainCallAt = 0;
let BOT_NAME  = 'NotABot';
let BOT_ID    = '';
let botClient: Client | null = null;

// ── FOCUS STATE ──────────────────────────────────────────────────
// Bot is "in" one channel at a time like a real person.
// It can drift to another channel but does so lazily.
interface FocusState {
  channelId: string;
  since:     number;
}
let focus: FocusState | null = null;
const FOCUS_DRIFT_MS    = 12 * 60_000;  // naturally drifts after 12m of nothing in focus channel
const FOCUS_SHIFT_COST  = 45_000;       // won't context-switch more than once per 45s

let lastFocusShift = 0;

// unread counts per channel — bot notices these but may not act on them
const unreadCounts = new Map<string, number>();

function tickUnread(channelId: string) {
  unreadCounts.set(channelId, (unreadCounts.get(channelId) ?? 0) + 1);
}

// Returns whether the bot is currently "reading" this channel.
// If not focused here, it may shift — or not.
function checkFocus(channelId: string, mentioned: boolean): boolean {
  const now = Date.now();

  // Already focused here
  if (focus?.channelId === channelId) {
    focus.since = now; // keep alive
    return true;
  }

  // No focus yet — go here
  if (!focus) {
    focus = { channelId, since: now };
    unreadCounts.delete(channelId);
    return true;
  }

  // Focus is elsewhere — check if it has naturally expired
  const focusExpired = now - focus.since > FOCUS_DRIFT_MS;

  if (focusExpired) {
    // Focus drifted, free to shift
    const unread = unreadCounts.get(channelId) ?? 0;
    console.log(`[Focus] drift from #${focus.channelId.slice(-5)} → #${channelId.slice(-5)} (${unread} unread)`);
    focus = { channelId, since: now };
    unreadCounts.delete(channelId);
    lastFocusShift = now;
    return true;
  }

  // Focus is alive elsewhere — only shift if mentioned AND cooldown passed
  if (mentioned && now - lastFocusShift > FOCUS_SHIFT_COST) {
    const unread = unreadCounts.get(channelId) ?? 0;
    console.log(`[Focus] ping pulled from #${focus.channelId.slice(-5)} → #${channelId.slice(-5)} (${unread} unread)`);
    focus = { channelId, since: now };
    unreadCounts.delete(channelId);
    lastFocusShift = now;
    return true;
  }

  // Bot is busy elsewhere — log unread and stay
  tickUnread(channelId);
  console.log(`[Focus] #${channelId.slice(-5)} — bot in #${focus.channelId.slice(-5)}, unread now ${unreadCounts.get(channelId)}`);
  return false;
}

// ── ID resolution ─────────────────────────────────────────────────
const idCache = new Map<string, string>();
function cacheId(id: string, name: string) { if (id && name) idCache.set(id, name); }

function resolveMentions(text: string): string {
  return text.replace(/<@!?(\d+)>/g, (_, id) =>
    id === BOT_ID ? `@${BOT_NAME}` : `@${idCache.get(id) || 'someone'}`
  );
}

function cleanContent(raw: string): string {
  // Keep @NotABot visible in content — model needs to see it was addressed.
  // resolveMentions already converts <@BOT_ID> → @NotABot, others → @Name.
  return resolveMentions(raw).trim();
}

// ── SHORT-TERM MEMORY ────────────────────────────────────────────
interface STMsg {
  ts:       number;
  authorId: string;
  author:   string;
  content:  string;
}

const stmStore = new Map<string, STMsg[]>();

function stmPush(channelId: string, m: STMsg) {
  if (!stmStore.has(channelId)) stmStore.set(channelId, []);
  const arr = stmStore.get(channelId)!;
  arr.push(m);
  if (arr.length > STM_MAX) arr.shift();
  // Also feed session buffer for mid-term summary
  sessionBufferPush(channelId, `${m.author}: ${m.content}`);
}

function stmGet(channelId: string): STMsg[] { return stmStore.get(channelId) ?? []; }

function stmFormat(msgs: STMsg[]): string {
  if (!msgs.length) return '(no messages yet)';
  const now   = Date.now();
  const lines: string[] = [];
  for (let i = 0; i < msgs.length; i++) {
    if (i > 0) {
      const gap = msgs[i].ts - msgs[i - 1].ts;
      if (gap >= GAP_MAJOR_MS) {
        lines.push(`\n── ${Math.round(gap / 60_000)}m later ──\n`);
      } else if (gap >= GAP_MINOR_MS) {
        lines.push(`  (${Math.round(gap / 60_000)}m gap)`);
      }
    }
    const ago = now - msgs[i].ts;
    const t   = ago < 90_000
      ? `${Math.round(ago / 1000)}s ago`
      : `${Math.round(ago / 60_000)}m ago`;
    lines.push(`[${t}] ${msgs[i].author}: ${msgs[i].content}`);
  }
  return lines.join('\n').slice(0, MAX_TRANSCRIPT_CHARS);
}

function seedSTM(channelId: string, msgs: Message[]) {
  if (stmStore.has(channelId)) return;
  stmStore.set(channelId, msgs.slice(-STM_MAX).map(m => ({
    ts:       m.createdTimestamp,
    authorId: m.author.id,
    author:   m.author.id === BOT_ID ? '[me]' : (m.member?.displayName || m.author.username),
    content:  (() => { const c = cleanContent(m.content); return c.length > 100 ? c.slice(0, 97) + '…' : c; })(),
  })));
}

// ── MOOD STATE ───────────────────────────────────────────────────
interface Mood { mode: 'active' | 'passive'; until?: number; count: number; }

const moods = new Map<string, Mood>();

// ── ACTIVITY CLOCK (self-pacing) ──────────────────────────────────
// Tracks how long the bot has been "active" in a channel and how many
// times it has replied during that stretch. This is fed to the model
// as a plain-text "clock" so it has a sense of elapsed time and can
// judge for itself when it's been talking too much.
interface ActivityClock { activeSince: number; replies: number; }
const activityClocks = new Map<string, ActivityClock>();

function clockLine(channelId: string, mood: Mood): string {
  if (mood.mode !== 'active') return '';
  const c = activityClocks.get(channelId);
  if (!c) return '';
  const mins = Math.max(0, Math.round((Date.now() - c.activeSince) / 60_000));
  return `active ${mins}m, ${c.replies} repl${c.replies === 1 ? 'y' : 'ies'} this stretch`;
}

function getMood(channelId: string): Mood {
  let m = moods.get(channelId) ?? { mode: 'passive', count: 0 };
  if (m.mode === 'active' && m.until && Date.now() >= m.until) {
    m = { mode: 'passive', count: 0 };
    moods.set(channelId, m);
    console.log(`[Mood] #${channelId.slice(-5)} active→passive (expired)`);
  }
  return m;
}

function goActive(channelId: string, mins = ACTIVE_MINS, reason = '') {
  const prev = moods.get(channelId);
  if (!prev || prev.mode !== 'active') {
    // fresh active streak — reset the clock
    activityClocks.set(channelId, { activeSince: Date.now(), replies: 0 });
  }
  moods.set(channelId, { mode: 'active', until: Date.now() + mins * 60_000, count: 0 });
  console.log(`[Mood] #${channelId.slice(-5)} active ${mins}m${reason ? ` — ${reason}` : ''}`);
}

function goPassive(channelId: string) {
  moods.set(channelId, { mode: 'passive', count: 0 });
  console.log(`[Mood] #${channelId.slice(-5)} passive`);
}

function moodTick(
  channelId: string,
  authorId:  string,
  mentioned: boolean,
  isDM:      boolean,
): boolean {
  if (isDM || mentioned) {
    goActive(channelId, ACTIVE_MINS, isDM ? 'DM' : 'mentioned');
    return true;
  }

  const msgs = stmGet(channelId);

  if (msgs.length > 0) {
    const gap = Date.now() - msgs[msgs.length - 1].ts;
    if (gap > 8 * 60_000) {
      goActive(channelId, ACTIVE_MINS, `${Math.round(gap / 60_000)}m idle gap`);
      return true;
    }
  }

  if (msgs.length >= MONOPOLY_N) {
    const recent  = msgs.slice(-MONOPOLY_N);
    const authors = new Set(recent.map(m => m.authorId).filter(id => id !== BOT_ID));
    if (authors.size === 1 && [...authors][0] === authorId) {
      const addressingOthers = recent.some(m => {
        const withoutMe = m.content.replace(new RegExp(`@${BOT_NAME}`, 'gi'), '');
        return withoutMe.includes('@');
      });
      if (!addressingOthers) {
        goActive(channelId, ACTIVE_MINS, `monopoly`);
        return true;
      }
    }
  }

  const m = getMood(channelId);
  if (m.mode === 'active') return true;

  m.count++;
  moods.set(channelId, m);

  const cutoff  = Date.now() - VELOCITY_WINDOW_MS;
  const vel     = stmGet(channelId).filter(x => x.ts >= cutoff && x.authorId !== BOT_ID).length;
  const every   = vel > VELOCITY_THRESH ? PASSIVE_EVERY_BUSY : PASSIVE_EVERY;
  const fire    = m.count % every === 0;

  if (!fire) console.log(`[Mood] #${channelId.slice(-5)} passive ${m.count}/${every}`);
  return fire;
}

// ── SPEAK STATE ──────────────────────────────────────────────────
interface SpeakState {
  mode:      'active' | 'paused' | 'waiting';
  resumeAt?: number;
  reason:    string;
}

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
  try {
    const snap = await db.collection('servers').doc(guildId).collection('channels').doc(channelId).get();
    const s: SpeakState = snap.data()?.speakState ?? { mode: 'active', reason: 'default' };
    if (s.mode === 'paused' && s.resumeAt && Date.now() >= s.resumeAt) {
      s.mode = 'active'; s.reason = 'pause expired';
    }
    speakStates.set(channelId, s);
    return s;
  } catch {
    return { mode: 'active', reason: 'default' };
  }
}

async function setSpeakState(channelId: string, guildId: string, s: SpeakState) {
  speakStates.set(channelId, s);
  saveSpeakState(channelId, guildId, s);
  const eta = s.resumeAt ? ` → resumes ${new Date(s.resumeAt).toLocaleTimeString()}` : '';
  console.log(`[Speak] #${channelId.slice(-5)} → ${s.mode}${eta} | ${s.reason}`);
}

function saveSpeakState(channelId: string, guildId: string, s: SpeakState) {
  if (guildId === 'dm') return;
  db.collection('servers').doc(guildId).collection('channels').doc(channelId)
    .set({ speakState: s }, { merge: true }).catch(() => {});
}

// ── FIREBASE / MEMORY ────────────────────────────────────────────
interface ServerMemory { facts: string[]; jokes: string[]; }

const memCache = new Map<string, { d: ServerMemory; ts: number }>();

async function getMemory(guildId: string): Promise<ServerMemory> {
  const c = memCache.get(guildId);
  if (c && Date.now() - c.ts < 120_000) return c.d;
  try {
    const snap = await db.collection('servers').doc(guildId).collection('memory').doc('global').get();
    const d: ServerMemory = { facts: snap.data()?.facts ?? [], jokes: snap.data()?.jokes ?? [] };
    memCache.set(guildId, { d, ts: Date.now() });
    return d;
  } catch { return { facts: [], jokes: [] }; }
}

async function addFact(guildId: string, fact: string, bucket: 'facts' | 'jokes' = 'facts') {
  if (!fact?.trim() || guildId === 'dm') return;
  const m = await getMemory(guildId);
  if (m[bucket].some(f => f.toLowerCase() === fact.toLowerCase())) return;
  m[bucket].push(fact.trim());
  if (m[bucket].length > 30) m[bucket].shift();
  memCache.delete(guildId);
  await db.collection('servers').doc(guildId).collection('memory').doc('global')
    .set({ [bucket]: m[bucket] }, { merge: true }).catch(() => {});
  console.log(`[Mem:${bucket}] "${fact.slice(0, 60)}"`);
}

interface MemberData {
  displayName?: string;
  username?:    string;
  bond?:        number;
  personality?: string;
}

const memberCache = new Map<string, { d: MemberData; ts: number }>();

async function getMember(guildId: string, userId: string): Promise<MemberData> {
  const key = `${guildId}:${userId}`;
  const c   = memberCache.get(key);
  if (c && Date.now() - c.ts < 5 * 60_000) return c.d;
  try {
    const snap = await db.collection('servers').doc(guildId).collection('members').doc(userId).get();
    const d    = (snap.data() ?? {}) as MemberData;
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
  if (!delta || guildId === 'dm') return;
  const m   = await getMember(guildId, userId);
  const cur = typeof m.bond === 'number' ? m.bond : 50;
  await upsertMember(guildId, userId, { bond: Math.max(0, Math.min(100, cur + delta)) });
}

// ── BRAIN ────────────────────────────────────────────────────────
// SYSTEM PROMPT IS STATIC → Cerebras caches it after the first call.
// Every subsequent call only burns tokens for the dynamic user message.
// Keep this under ~350 tokens — don't bloat it or caching gets less effective.

const SYSTEM_PROMPT = `you are ${BOT_NAME}. gen z. live in this discord as a person, not an assistant. dry humor, occasionally unhinged. you roast people you're fond of. not obligated to respond to everything — and often don't.
in transcripts, [me] = you (your own past messages).
if the message is directed at you, it may have pronouns: "ur", "you", "your" directed at you = about you. "my", "I", "me" from sender = about them.
conversation ending: if context says ending_convo, reply once casually or ignore — never keep pulling them back.

self-pacing: CLOCK (if present) shows how long you've been active and how many times you've replied this stretch. if you've already replied a couple times, the other person's last reply was short/closing ("thanks", "lol", "ok", "yea", "same"), or the exchange just feels done — set "pause" to how many minutes to go quiet (1-30). while paused only a direct ping wakes you up. don't pause after a single reply just because — only when it's actually winding down. 0 = no pause.

texting rules (break these = instant bot detection):
- always lowercase. caps only for ACTUAL emphasis.
- most replies ≤ 12 words. "lol", "fr", "nah", one emoji — all valid full answers.
- contractions always: im, dont, ur, ngl, idk, rn, tbh, wtf, istg
- no em-dashes. no semicolons. minimal punctuation. drop periods on short msgs.
- never explain jokes. never narrate. never say "let me know if".
- zero assistant speak — no "happy to help", "great question", "certainly".
- if you spoke in the last 2 messages, need a real reason to go again.
- humor: deadpan, absurdist, or self-aware. never forced. if it doesn't land naturally, skip it.

when to ignore:
- two people clearly talking to each other → stay out or quiet react
- background chatter you have no angle on → ignore
- high-velocity back and forth you're not part of → ignore

output ONLY valid JSON, nothing else:
{"action":"speak|react|ignore","reply":"your message or empty","reaction":"single emoji or empty","pause":0}`;

interface BrainDecision {
  action:   'speak' | 'react' | 'ignore';
  reply:    string;
  reaction: string;
  pause:    number; // minutes to go quiet after this turn; 0 = none
}

async function brain(opts: {
  sender:          string;
  bond:            number;
  message:         string;
  transcript:      string;
  thread?:         string;
  memCtx:          string;
  sessionSummary?: string;
  clock?:          string;
  mentioned:       boolean;
  isDM:            boolean;
  mood:            Mood;
  speakState:      SpeakState;
  inExchange:      boolean;
  channelName:     string;
  everyonePing:    boolean;
  endingConvo:     boolean;
}): Promise<BrainDecision> {

  const bondLabel = opts.bond > 70 ? 'close' : opts.bond > 40 ? 'neutral' : 'distant';
  // Fix NaN: opts.mood.until may be undefined (passive or DM)
  const moodLine  = opts.mood.mode === 'active'
    ? opts.mood.until
      ? `active (${Math.round((opts.mood.until - Date.now()) / 60_000)}m left)`
      : 'active'
    : 'passive';

  // Dynamic part — only this burns tokens (system prompt is cached)
  const parts: string[] = [
    `mood: ${moodLine} | speak: ${opts.speakState.mode} | channel: #${opts.channelName}`,
  ];

  if (opts.memCtx)          parts.push(`\nCONTEXT:\n${opts.memCtx.slice(0, MAX_MEM_CHARS)}`);
  if (opts.sessionSummary)  parts.push(`\nSESSION (earlier today):\n${opts.sessionSummary.slice(0, MAX_SUMMARY_CHARS)}`);
  if (opts.clock)           parts.push(`\nCLOCK: ${opts.clock}`);
  if (opts.thread)          parts.push(`\nREPLY TO:\n${opts.thread}`);
  parts.push(`\nCHAT:\n${opts.transcript}`);

  const flags: string[] = [];
  if (opts.mentioned)    flags.push('pinged you directly');
  if (opts.inExchange)   flags.push('mid back-and-forth with this person');
  if (opts.isDM)         flags.push('DM — just you two');
  if (opts.everyonePing) flags.push('@everyone ping — server-wide announcement');
  if (opts.endingConvo)  flags.push('ending_convo — they seem to be wrapping up');

  parts.push(
    `\nTRIGGER — ${opts.sender} (${bondLabel}, bond ${opts.bond}/100):\n"${opts.message}"`,
    flags.length ? `context: ${flags.join(', ')}` : 'context: no direct ping',
    `\n(IMPORTANT: Reply ONLY with the raw JSON object. No markdown, no pre-text.)`
  );

  try {
    const raw = await cerebras.call(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: parts.join('\n') },
      ],
      0.88,
      1024,  // gpt-oss-120b is a reasoning model — burns tokens internally before output; 150 was too low
    );

    console.log(`[Brain] raw response: ${raw.slice(0, 200)}`);
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('no JSON found in response');
    const parsed   = JSON.parse(jsonMatch[0]);
    const action   = (['speak', 'react', 'ignore'] as const).includes(parsed.action)
      ? parsed.action as BrainDecision['action']
      : 'ignore';
    const reply    = typeof parsed.reply === 'string'
      ? parsed.reply.trim().replace(/^["']|["']$/g, '')
      : '';
    const reaction = sanitizeEmoji(parsed.reaction);
    const pause    = typeof parsed.pause === 'number' && parsed.pause > 0
      ? Math.min(Math.round(parsed.pause), PAUSE_MAX_MINS)
      : 0;

    return { action, reply, reaction, pause };

  } catch (e: any) {
    console.warn('[Brain] parse error:', e.message?.slice(0, 80));
    return (opts.mentioned || opts.isDM)
      ? { action: 'speak', reply: 'brain blipped', reaction: '', pause: 0 }
      : { action: 'ignore', reply: '', reaction: '', pause: 0 };
  }
}

function sanitizeEmoji(raw: any): string {
  if (typeof raw !== 'string') return '';
  const e = raw.trim();
  if (!e || e.length > 8) return '';
  const RE = /^(\p{Extended_Pictographic}|\p{Emoji_Presentation})(\uFE0F|\u200D(\p{Extended_Pictographic}|\p{Emoji_Presentation}))*$/u;
  return RE.test(e) ? e : '';
}

function fireSideEffects(opts: {
  guildId:  string;
  userId:   string;
  action:   string;
  newFact?: string;
}) {
  if (opts.guildId === 'dm') return;
  if (opts.action === 'speak') {
    updateBond(opts.guildId, opts.userId, 1).catch(() => {});
  }
  if (opts.newFact) {
    addFact(opts.guildId, opts.newFact).catch(() => {});
  }
}

// ── BACKGROUND JOBS ──────────────────────────────────────────────
// Background tasks use short, lean prompts to minimize token spend
let bgLock       = false;
let lastProfile  = 0;
let lastCompress = 0;
let lastProactive = 0;

async function withBgBudget<T>(fn: () => Promise<T>): Promise<T | null> {
  if (bgLock || !cerebras.canCall(EST_BG_TOKENS)) {
    console.log(`[BG] skipped — bgLock=${bgLock} or budget tight`);
    return null;
  }
  bgLock = true;
  try { return await fn(); }
  finally { setTimeout(() => { bgLock = false; }, 30_000); }
}

async function runProfiler(client: Client) {
  if (Date.now() - lastProfile < PROFILER_INTERVAL) return;
  lastProfile = Date.now();

  await withBgBudget(async () => {
    for (const guild of client.guilds.cache.values()) {
      for (const ch of guild.channels.cache.filter(c => c.isTextBased()).values()) {
        if (!cerebras.canCall(EST_BG_TOKENS)) break;
        try {
          const fetched = await (ch as any).messages.fetch({ limit: 15 });
          const msgs    = ([...fetched.values()] as Message[]).reverse();
          seedSTM(ch.id, msgs);

          const byAuthor = new Map<string, string[]>();
          for (const m of msgs) {
            if (m.author.bot || !m.content.trim()) continue;
            cacheId(m.author.id, m.member?.displayName || m.author.username);
            await upsertMember(guild.id, m.author.id, {
              displayName: m.member?.displayName || m.author.username,
              username:    m.author.username,
            });
            if (!byAuthor.has(m.author.id)) byAuthor.set(m.author.id, []);
            byAuthor.get(m.author.id)!.push(m.content.slice(0, 80));
          }

          for (const [uid, lines] of byAuthor) {
            if (!cerebras.canCall(EST_BG_TOKENS)) break;
            const existing = await getMember(guild.id, uid);
            if (existing.personality) continue; // already profiled — skip, free
            const name = idCache.get(uid) || uid;
            try {
              const raw = await cerebras.call([
                { role: 'system', content: 'one-line personality read from discord messages. output ONLY: {"p":"..."}' },
                { role: 'user',   content: `${name}: ${lines.slice(0, 8).join(' | ')}` },
              ], 0.4, 50, FAST_MODEL);
              const jsonMatch = raw.match(/\{[\s\S]*\}/);
              if (!jsonMatch) continue;
              const parsed = JSON.parse(jsonMatch[0]);
              if (parsed.p) await upsertMember(guild.id, uid, { personality: parsed.p });
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
    // STM (12 msgs) for facts/jokes
    const stmText = msgs.map(m => `${m.author}: ${m.content}`).join('\n').slice(0, 1200);
    try {
      const raw = await cerebras.call([
        { role: 'system', content: 'extract memorable facts and inside jokes. ONLY valid JSON: {"facts":["x"],"jokes":["x"]}' },
        { role: 'user',   content: stmText },
      ], 0.4, 120, FAST_MODEL);
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return;
      const p = JSON.parse(jsonMatch[0]);
      for (const f of (p.facts || []).slice(0, 4)) await addFact(guildId, f, 'facts');
      for (const j of (p.jokes || []).slice(0, 2)) await addFact(guildId, j, 'jokes');
      console.log(`[Compress] +${p.facts?.length || 0} facts +${p.jokes?.length || 0} jokes`);
    } catch {}

    // Session buffer (up to 60 msgs) → running summary for mid-term memory
    const buf = sessionBuffers.get(channelId);
    if (!buf || buf.length < 10) return;
    if (!cerebras.canCall(EST_BG_TOKENS)) return;
    const bufText = buf.join('\n').slice(-2000); // last ~2000 chars
    try {
      const raw2 = await cerebras.call([
        { role: 'system', content: 'summarize this discord chat in 2-3 sentences: main topics, who said what, mood/vibe. be concise, no fluff. output ONLY: {"s":"..."}' },
        { role: 'user',   content: bufText },
      ], 0.3, 80, FAST_MODEL);
      const m2 = raw2.match(/\{[\s\S]*\}/);
      if (!m2) return;
      const p2 = JSON.parse(m2[0]);
      if (p2.s?.trim()) {
        sessionSummaries.set(channelId, p2.s.trim().slice(0, MAX_SUMMARY_CHARS));
        console.log(`[Compress] session summary updated for #${channelId.slice(-5)}`);
      }
    } catch {}
  });
}

async function runProactive(client: Client) {
  if (Date.now() - lastProactive < PROACTIVE_INTERVAL) return;
  if (!cerebras.canCall(EST_BG_TOKENS)) return;
  lastProactive = Date.now();

  await withBgBudget(async () => {
    const now = Date.now();
    const candidates: { id: string; hint: string }[] = [];

    for (const [channelId, msgs] of stmStore.entries()) {
      if (!msgs.length) continue;
      const idle = now - msgs[msgs.length - 1].ts;
      if (idle < 10 * 60_000 || idle > 2 * 60 * 60_000) continue;
      candidates.push({
        id:   channelId,
        hint: `quiet ${Math.round(idle / 60_000)}m. last: "${msgs[msgs.length - 1].content.slice(0, 50)}"`,
      });
    }

    if (!candidates.length) return;

    const pick = candidates[Math.floor(Math.random() * Math.min(candidates.length, 5))];

    // Don't casually break silence if the last message had a heavy tone
    const sensitiveWords = /\b(sorry|rip|died?|passed?|grief|depress|sad|hurt|cry|miss(ing)?|loss|trauma|broke up|suicide|cutting|abuse)\b/i;
    if (sensitiveWords.test(pick.hint)) {
      console.log(`[Proactive] skipped — sensitive topic detected in last message`);
      return;
    }

    const ch   = client.channels.cache.get(pick.id) as TextChannel | undefined;
    if (!ch?.isTextBased()) return;

    try {
      const raw = await cerebras.call([
        { role: 'system', content: `you are ${BOT_NAME}, gen z discord person. send ONE short casual message to break silence, or skip. lowercase. ONLY valid JSON.` },
        { role: 'user',   content: `channel: ${pick.hint}\nJSON: {"skip":false,"msg":"..."}` },
      ], 0.9, 80, FAST_MODEL);
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return;
      const p = JSON.parse(jsonMatch[0]);
      if (p.skip || !p.msg?.trim()) return;

      const text = p.msg.trim().slice(0, 150);
      await ch.sendTyping().catch(() => {});
      await sleep(Math.min(400 + text.length * 20, 2500));
      await ch.send(text);
      stmPush(pick.id, { ts: Date.now(), authorId: BOT_ID, author: '[me]', content: text });
      console.log(`[Proactive] #${pick.id.slice(-5)}: "${text.slice(0, 50)}"`);
    } catch {}
  });
}

// ── DIRECT MESSAGES (isolated pipeline) ───────────────────────────
// DMs are handled completely separately from guild channels — no
// focus, no mood/monopoly logic, no speak-state, no session
// compression. Every DM is "active" by definition. Messages are
// debounced per-channel so a quick burst of DMs lands as one trigger.
const dmDebounce = new Map<string, NodeJS.Timeout>();
const dmPending  = new Map<string, Message>();

async function handleDirectMessage(msg: Message) {
  const channelId = msg.channelId;
  const sender    = msg.author.username;
  const content   = cleanContent(msg.content);

  cacheId(msg.author.id, sender);
  console.log(`[DM] in #${channelId.slice(-5)} ${sender}: "${content.slice(0, 80)}"`);

  // Seed history on the very first message we see in this DM channel,
  // BEFORE pushing the current message (so seedSTM's "empty store" check
  // actually has something to seed).
  if (!stmStore.has(channelId)) {
    try {
      const fetched = await msg.channel.messages.fetch({ limit: STM_MAX });
      seedSTM(channelId, ([...fetched.values()] as Message[]).reverse());
    } catch (e) { console.warn('[DM] history fetch failed:', (e as Error).message); }
  }

  stmPush(channelId, {
    ts:       msg.createdTimestamp,
    authorId: msg.author.id,
    author:   sender,
    content:  content.length > 100 ? content.slice(0, 97) + '…' : content,
  });

  dmPending.set(channelId, msg);
  if (dmDebounce.has(channelId)) clearTimeout(dmDebounce.get(channelId)!);

  dmDebounce.set(channelId, setTimeout(() => {
    dmDebounce.delete(channelId);
    const trigger = dmPending.get(channelId);
    dmPending.delete(channelId);
    if (trigger) respondToDM(trigger).catch(e => console.error('[DM] respond error:', e));
  }, DM_DEBOUNCE_MS));
}

async function respondToDM(msg: Message) {
  const channelId = msg.channelId;
  const sender     = msg.author.username;
  const content    = cleanContent(msg.content);

  let threadCtx: string | undefined;
  if (msg.reference?.messageId) {
    try {
      const ref       = await msg.channel.messages.fetch(msg.reference.messageId);
      const refAuthor = ref.author.id === BOT_ID ? BOT_NAME : ref.author.username;
      threadCtx = `${refAuthor}: "${cleanContent(ref.content).slice(0, 150)}"`;
    } catch {}
  }

  const recentMsgs   = stmGet(channelId).slice(-8);
  const botReplied   = recentMsgs.some(m => m.authorId === BOT_ID);
  const senderRecent = recentMsgs.filter(m => m.authorId === msg.author.id).length;
  const inExchange   = botReplied && senderRecent >= 2;

  const END_PHRASES = /\b(bye|cya|gotta go|gtg|see ya|later|peace|good night|gn|logging off|ttyl|im out|i\s*m\s*out)\b/i;
  const endingConvo = END_PHRASES.test(content);

  lastBrainCallAt = Date.now();
  const decision = await brain({
    sender,
    bond:         50,
    message:      content,
    transcript:   stmFormat(stmGet(channelId)),
    thread:       threadCtx,
    memCtx:       '',
    mentioned:    true,
    isDM:         true,
    mood:         { mode: 'active', count: 0 },
    speakState:   { mode: 'active', reason: 'dm' },
    inExchange,
    channelName:  'DM',
    everyonePing: false,
    endingConvo,
  });

  console.log(`[DM] ${sender} → ${decision.action}${decision.reply ? ` — "${decision.reply.slice(0, 50)}"` : decision.reaction ? ` — ${decision.reaction}` : ''}`);

  if (decision.reaction) msg.react(decision.reaction).catch(() => {});

  if (decision.action === 'speak' && decision.reply?.trim()) {
    const text     = decision.reply.trim().slice(0, 200);
    const typingMs = Math.min(300 + text.length * 20, 2800);

    try { await msg.channel.sendTyping(); } catch {}
    await sleep(typingMs);

    await msg.reply({ content: text, allowedMentions: { repliedUser: false } });
    stmPush(channelId, { ts: Date.now(), authorId: BOT_ID, author: '[me]', content: text });
  }
  // note: DMs ignore decision.pause entirely — every DM is a direct line,
  // there's no "monopoly" or ambient-chatter problem to self-pace away from.
}

// ── MAIN MESSAGE HANDLER (guild channels) ─────────────────────────
const debounceTimers  = new Map<string, NodeJS.Timeout>();
const pendingTriggers = new Map<string, {
  msg:          Message;
  mentioned:    boolean;
  guildId:      string;
  everyonePing: boolean;
}>();

async function handleMessage(msg: Message) {
  // RAW DEBUG — remove after DM issue is confirmed fixed
  if (msg.channel.isDMBased()) {
    console.log(`[DM-RAW] from ${msg.author?.username} | partial:${msg.partial} | content:"${msg.content?.slice(0, 50)}"`);
  }

  // Partials — content is empty until fetched.
  if (msg.partial) {
    try { msg = await msg.fetch(); } catch { return; }
  }
  if (msg.author.bot || !msg.content?.trim()) return;

  // DMs get their own fully isolated pipeline.
  if (msg.channel.isDMBased()) {
    return handleDirectMessage(msg);
  }

  try {
    const guildId   = msg.guildId!;
    const channelId = msg.channelId;
    const mentioned = BOT_ID ? msg.mentions.has(BOT_ID) : false;
    const sender    = msg.member?.displayName || msg.author.username;
    const content   = cleanContent(msg.content);

    cacheId(msg.author.id, sender);

    upsertMember(guildId, msg.author.id, {
      displayName: sender,
      username:    msg.author.username,
    }).catch(() => {});

    stmPush(channelId, {
      ts:       msg.createdTimestamp,
      authorId: msg.author.id,
      author:   msg.author.id === BOT_ID ? '[me]' : sender,
      content:  content.length > 100 ? content.slice(0, 97) + '…' : content,
    });

    tickUnread(channelId);
    if (!checkFocus(channelId, mentioned)) return;

    if (!moodTick(channelId, msg.author.id, mentioned, false)) return;

    // Rate budget gate
    if (!cerebras.canCall(EST_TOKENS_PER_CALL)) {
      console.log(`[Budget] Cerebras tight${mentioned ? ' (mention!)' : ''}`);
      if (!mentioned) return;
      // For mentions: still attempt — the call itself will queue/retry
    }

    // Global pacing
    if (!mentioned && Date.now() - lastBrainCallAt < MIN_BRAIN_GAP_MS) {
      console.log('[Pace] skip — too soon since last brain call');
      return;
    }

    // Accumulate mention across burst — if msg 1 pinged us and msg 2 didn't,
    // we still know we were originally pinged.
    const prevTrigger        = pendingTriggers.get(channelId);
    const effectiveMentioned = mentioned || (prevTrigger?.mentioned ?? false);

    // @everyone/@here: flag it for context, not a full mention
    const everyonePing = msg.mentions.everyone ?? false;

    pendingTriggers.set(channelId, {
      msg, mentioned: effectiveMentioned, guildId,
      everyonePing: everyonePing || (prevTrigger?.everyonePing ?? false),
    });
    if (debounceTimers.has(channelId)) clearTimeout(debounceTimers.get(channelId)!);

    // Mentions get a snappy response; passive triggers wait for burst to settle
    const debounceMs = mentioned ? 350 : DEBOUNCE_MS;

    debounceTimers.set(channelId, setTimeout(async () => {
      debounceTimers.delete(channelId);
      const trigger = pendingTriggers.get(channelId);
      pendingTriggers.delete(channelId);
      if (!trigger) return;

      const { msg: tMsg, mentioned: tMentioned, guildId: tGuild, everyonePing: tEveryonePing } = trigger;
      const tChannel     = tMsg.channelId;
      const tSender      = tMsg.member?.displayName || tMsg.author.username;
      const tContent     = cleanContent(tMsg.content);
      const tChannelName = (tMsg.channel as any).name ?? 'unknown';

      try {
        // Check speak state — this is also where an AI self-pause (below) lands.
        const speakState = await getSpeakState(tChannel, tGuild);
        if (
          speakState.mode === 'paused' &&
          speakState.resumeAt &&
          Date.now() < speakState.resumeAt &&
          !tMentioned
        ) {
          console.log(`[Speak] paused — skip`);
          return;
        }

        // Seed STM if empty
        if (!stmStore.has(tChannel)) {
          try {
            const fetched = await tMsg.channel.messages.fetch({ limit: STM_MAX });
            seedSTM(tChannel, ([...fetched.values()] as Message[]).reverse());
          } catch {}
        }

        // Fetch reply thread context
        let threadCtx: string | undefined;
        if (tMsg.reference?.messageId) {
          try {
            const ref       = await tMsg.channel.messages.fetch(tMsg.reference.messageId);
            const refAuthor = ref.author.id === BOT_ID
              ? BOT_NAME
              : (ref.member?.displayName || ref.author.username);
            threadCtx = `${refAuthor}: "${cleanContent(ref.content).slice(0, 150)}"`;
          } catch {}
        }

        const [memberData, memory] = await Promise.all([
          getMember(tGuild, tMsg.author.id),
          getMemory(tGuild),
        ]);

        const bond    = typeof memberData.bond === 'number' ? memberData.bond : 50;
        const memLines: string[] = [];
        if (memory.facts.length)        memLines.push(`facts: ${memory.facts.slice(-3).join(' | ')}`);
        if (memory.jokes.length)        memLines.push(`jokes: ${memory.jokes.slice(-2).join(' | ')}`);
        if (memberData.personality)     memLines.push(`${tSender}: ${memberData.personality}`);
        const memCtx = memLines.join('\n');

        const mood = getMood(tChannel);

        // Detect if we're mid back-and-forth with this person
        const recentMsgs    = stmGet(tChannel).slice(-8);  // wider window
        const botReplied    = recentMsgs.some(m => m.authorId === BOT_ID);
        const senderRecent  = recentMsgs.filter(m => m.authorId === tMsg.author.id).length;
        const inExchange    = botReplied && senderRecent >= 2;

        // Detect conversation-ending intent — if they're wrapping up with the bot,
        // pass the flag so the model can reply once and not drag it out.
        const END_PHRASES = /\b(bye|cya|gotta go|gtg|see ya|later|peace|good night|gn|logging off|ttyl|im out|i\s*m\s*out)\b/i;
        const endingConvo = END_PHRASES.test(tContent);

        // Session summary from mid-term buffer
        const sessionSummary = sessionSummaries.get(tChannel);

        // Active-streak clock — lets the model see how long/how much it's talked
        const clock = clockLine(tChannel, mood);

        lastBrainCallAt = Date.now();
        const decision  = await brain({
          sender:         tSender,
          bond,
          message:        tContent,
          transcript:     stmFormat(stmGet(tChannel)),
          thread:         threadCtx,
          memCtx,
          sessionSummary,
          clock,
          mentioned:      tMentioned,
          isDM:           false,
          mood,
          speakState,
          inExchange,
          channelName:    tChannelName,
          everyonePing:   tEveryonePing,
          endingConvo,
        });

        console.log(`[Brain] ${tSender}: ${decision.action}${decision.reply ? ` — "${decision.reply.slice(0, 50)}"` : decision.reaction ? ` — ${decision.reaction}` : ''}`);

        if (decision.reaction) {
          tMsg.react(decision.reaction).catch(() => {});
        }

        if (decision.action === 'speak' && decision.reply?.trim()) {
          const text     = decision.reply.trim().slice(0, 200);
          const typingMs = Math.min(300 + text.length * 20, 2800);

          try { await tMsg.channel.sendTyping(); } catch {}
          await sleep(typingMs);

          await tMsg.reply({ content: text, allowedMentions: { repliedUser: false } });
          stmPush(tChannel, { ts: Date.now(), authorId: BOT_ID, author: '[me]', content: text });

          const clk = activityClocks.get(tChannel);
          if (clk) clk.replies++;

          fireSideEffects({ guildId: tGuild, userId: tMsg.author.id, action: 'speak' });

          // If person was ending the convo, go passive after this reply — don't linger
          if (endingConvo) {
            console.log(`[Mood] ${tSender} ending convo → passive`);
            goPassive(tChannel);
          } else if (speakState.mode !== 'active') {
            setSpeakState(tChannel, tGuild, { mode: 'active', reason: 'spoke' }).catch(() => {});
          }

        } else if (decision.action === 'speak') {
          console.log('[Brain] speak→empty reply, skipping');
        }

        // AI-decided self-pace: go quiet for a bit. Only a direct ping
        // (handled by the speakState check above) breaks it early.
        if (decision.pause > 0) {
          await setSpeakState(tChannel, tGuild, {
            mode:     'paused',
            resumeAt: Date.now() + decision.pause * 60_000,
            reason:   'self-paced',
          });
          goPassive(tChannel);
          console.log(`[Pause] #${tChannel.slice(-5)} — self-paced ${decision.pause}m`);
        }

        runCompress(tGuild, tChannel).catch(() => {});

      } catch (e) { console.error('[Handler debounce]', e); }
    }, debounceMs));

  } catch (e) { console.error('[Handler outer]', e); }
}

// ── STARTUP ──────────────────────────────────────────────────────
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
    ],
    partials: [Partials.Message, Partials.Channel, Partials.User],
    // Partials.Channel is required for DM messageCreate events to fire at all.
    // Partials.User needed for DM events to fire reliably.
  });

  botClient.on(Events.ClientReady, async () => {
    BOT_NAME = botClient!.user!.username;
    BOT_ID   = botClient!.user!.id;
    cacheId(BOT_ID, BOT_NAME);

    console.log(`
╔═══════════════════════════════════════════════════════════╗
║  ✓ ${BOT_NAME} — Cerebras Edition
║  BRAIN  : ${BRAIN_MODEL}
║  FAST   : ${FAST_MODEL} (bg jobs only)
║  LIMITS : 30 RPM | 14,400 RPD | 1M tokens/day | 8192 ctx
║  CACHE  : system prompt cached after 1st call (≈350 tok)
║  KEYS   : ${cerebras.status().split('|')[0].trim()}
║  STM    : ${STM_MAX} msgs | Debounce: ${DEBOUNCE_MS}ms | DM: ${DM_DEBOUNCE_MS}ms
║  Passive: every ${PASSIVE_EVERY}/${PASSIVE_EVERY_BUSY} msgs | Active: ${ACTIVE_MINS}m
║  Pause  : AI sets its own quiet window (0-${PAUSE_MAX_MINS}m) via decision JSON
║  Profiler: first run in 1hr, skips existing profiles
╚═══════════════════════════════════════════════════════════╝\n`);

    botClient!.user!.setPresence({ status: 'online', activities: [{ name: 'the chat', type: 3 }] });

    for (const g of botClient!.guilds.cache.values()) {
      const members = await g.members.fetch().catch(() => null);
      if (members) {
        for (const [uid, m] of members) {
          if (m.user.bot) continue;
          cacheId(uid, m.displayName);
          await upsertMember(g.id, uid, {
            displayName: m.displayName,
            username:    m.user.username,
          });
        }
        console.log(`[Boot] synced ${members.size} members — "${g.name}"`);
      }

      // Also warm idCache from Firebase — covers past members who've left the server.
      // This ensures @mentions of ex-members resolve to names instead of "@someone".
      try {
        const pastMembersSnap = await db
          .collection('servers').doc(g.id)
          .collection('members').get();
        let warmed = 0;
        for (const doc of pastMembersSnap.docs) {
          const d = doc.data() as MemberData;
          const name = d.displayName || d.username;
          if (name && !idCache.has(doc.id)) {
            cacheId(doc.id, name);
            warmed++;
          }
        }
        if (warmed) console.log(`[Boot] warmed ${warmed} past members from Firebase — "${g.name}"`);
      } catch {}
    }

    // Delay first profiler run — avoids burning tokens immediately on boot.
    // After 1hr, runs every PROFILER_INTERVAL. Skips members with existing profiles.
    setTimeout(() => {
      if (botClient) runProfiler(botClient).catch(() => {});
      setInterval(() => {
        if (!botClient) return;
        runProfiler(botClient).catch(() => {});
      }, PROFILER_INTERVAL);
    }, 60 * 60_000);

    const scheduleProactive = () => {
      setTimeout(async () => {
        if (!botClient) return;
        runProactive(botClient).catch(() => {});
        scheduleProactive();
      }, PROACTIVE_INTERVAL + Math.floor(Math.random() * 10 * 60_000));
    };
    scheduleProactive();
  });

  botClient.on(Events.MessageCreate, handleMessage);

  botClient.on(Events.GuildMemberAdd, async (m) => {
    if (m.user.bot) return;
    cacheId(m.id, m.displayName);
    await upsertMember(m.guild.id, m.id, {
      displayName: m.displayName,
      username:    m.user.username,
    });
  });

  botClient.on(Events.GuildMemberUpdate, async (_, m) => {
    if (m.user.bot) return;
    cacheId(m.id, m.displayName);
    await upsertMember(m.guild.id, m.id, { displayName: m.displayName });
  });

  // ── ADMIN COMMANDS ──────────────────────────────────────────────
  botClient.on(Events.MessageCreate, async (msg) => {
    if (
      !msg.member?.permissions.has('Administrator') &&
      !msg.member?.permissions.has('ManageMessages')
    ) return;

    const c       = msg.content.trim();
    const guildId = msg.guildId!;
    const chId    = msg.channelId;

    if (c === '!wake') {
      await setSpeakState(chId, guildId, { mode: 'active', reason: 'admin' });
      msg.reply('im up');
    }
    if (c === '!sleep') {
      await setSpeakState(chId, guildId, { mode: 'waiting', reason: 'admin' });
      msg.reply('going quiet');
    }
    if (c.startsWith('!pause ')) {
      const mins = parseInt(c.split(' ')[1]) || 10;
      await setSpeakState(chId, guildId, {
        mode: 'paused', resumeAt: Date.now() + mins * 60_000, reason: 'admin',
      });
      msg.reply(`paused ${mins}m`);
    }
    if (c.startsWith('!active')) {
      const mins = parseInt(c.split(' ')[1] || '') || ACTIVE_MINS;
      goActive(chId, mins, 'admin');
      msg.reply(`active ${mins}m`);
    }
    if (c === '!passive') {
      goPassive(chId);
      msg.reply('passive mode');
    }
    if (c === '!status') {
      const mood  = getMood(chId);
      const speak = await getSpeakState(chId, guildId);
      const moodStr = mood.mode === 'active' && mood.until
        ? `active (${Math.round((mood.until - Date.now()) / 60_000)}m left)`
        : `passive (count: ${mood.count})`;
      const clk = clockLine(chId, mood);
      await msg.reply([
        `mood: ${moodStr}`,
        clk ? `clock: ${clk}` : '',
        `speak: ${speak.mode}${speak.resumeAt ? ` until ${new Date(speak.resumeAt).toLocaleTimeString()}` : ''}`,
        `cerebras: ${cerebras.status()}`,
        `bgLock: ${bgLock}`,
      ].filter(Boolean).join('\n'));
    }
    if (c === '!memory') {
      const m = await getMemory(guildId);
      await msg.reply(
        `facts (${m.facts.length}): ${m.facts.slice(-5).join(' | ') || 'none'}\n` +
        `jokes (${m.jokes.length}): ${m.jokes.slice(-3).join(' | ') || 'none'}`
      );
    }
    if (c.startsWith('!remember ')) {
      await addFact(guildId, c.slice(10).trim());
      msg.reply('noted');
    }
    if (c === '!stm') {
      const out = stmFormat(stmGet(chId));
      await msg.reply(`\`\`\`\n${out.slice(0, 1900)}\n\`\`\``);
    }
    if (c === '!proactive') {
      await msg.reply('running...');
      await runProactive(botClient!).catch(() => {});
      await msg.reply('done');
    }
    if (c.startsWith('!who ')) {
      const uid = msg.mentions.users.first()?.id || c.split(' ')[1]?.trim();
      if (!uid) { msg.reply('usage: !who @user'); return; }
      const m = await getMember(guildId, uid);
      await msg.reply(
        `${m.displayName || uid}\nbond: ${m.bond ?? 50}/100\n${m.personality || '(no profile yet)'}`
      );
    }
    if (c === '!budget') {
      await msg.reply(cerebras.status());
    }
  });

  await botClient.login(token);
}

export function stopBot() {
  botClient?.destroy();
  botClient = null;
}

export function getBotStatus() { return botClient ? 'running' : 'stopped'; }
