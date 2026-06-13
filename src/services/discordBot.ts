/**
 * NOTABOT — v12 "Human Layer"
 *
 * Built ON TOP of v9 "Mood System" / v11 "Cognitive+". Nothing removed. Additions:
 *
 * THE READING ALGORITHM (brain() system prompt rewrite):
 *   internal_thought now walks a strict 7-step process every call:
 *     1. Reconstruct the scene (anchor to "now" via timestamps / session breaks)
 *     2. Map the room (who's talking to whom — @mentions / reply chains)
 *     3. Read the temperature (hyped / chill / venting / tense / joking / dead air)
 *     4. Relevance check (is this even mine to respond to?)
 *     5. Own-recency check (did [me] just talk? don't pile on)
 *     6. Pick the move (nothing / reaction / one-liner / real engagement —
 *        "nothing" or "reaction at most" is explicitly the common case)
 *     7. If speaking — how many bubbles (1-3, default 1, never a paragraph)
 *
 * NEW ACTION: "react" — pure emoji reaction, no text. Far more common than
 *   "speak" in a busy server; this is the bot's primary low-cost social presence.
 *
 * "reaction" field can now accompany ANY action — speak/react/pause/wait/ignore
 *   can all optionally throw an emoji on the trigger message.
 *
 * MULTI-BUBBLE REPLIES: decision.reply is now string[] (1-3 items). Bubble 1
 *   replies to the trigger message (keeps the reply arrow); bubbles 2-3 send
 *   as plain follow-on messages with a short natural gap — mimics a real
 *   person sending two texts in a row.
 *
 * DOUBLE-TEXT FOLLOW-UPS: decision.followUp = {text, delaySec 5-60}. Scheduled
 *   independently of the main brain call — a delayed afterthought/correction/
 *   joke, sent only if speak state still allows it at fire time.
 *
 * EMOJI SANITIZATION: sanitizeEmoji() guards react() calls against garbage —
 *   only single valid unicode emoji (with optional VS16/ZWJ sequences) pass.
 *
 * Everything from v9/v11 preserved: multi-key Groq, HF backend switcher, RPM
 * guard, mood system (active/passive), speak states, STM with session-break
 * separators, reply chains, ID resolution, server + per-user memory, proactive
 * hop loop, hourly compression, debounce/velocity gates, all admin commands.
 */

import { Client, GatewayIntentBits, Message, Partials, Events, TextChannel } from 'discord.js';
import Groq from 'groq-sdk';
import { db } from './firebase.ts';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// ═══════════════════════════════════════════════════════════════════
// GROQ MANAGER
// ═══════════════════════════════════════════════════════════════════

interface KeyStats {
  key: string; requestsToday: number; errorsToday: number;
  isHealthy: boolean; cooldownUntil?: number; lastUsed?: number;
}

class GroqManager {
  private clients = new Map<string, Groq>();
  private stats   = new Map<string, KeyStats>();
  private keys:     string[] = [];
  private limit   = 14_400;
  private resetAt = Date.now() + 86_400_000;

  constructor() {
    const raw = process.env.GROQ_API_KEYS || process.env.GROQ_API_KEY || '';
    this.keys = raw.split(',').map(k => k.trim()).filter(Boolean);
    if (!this.keys.length) { console.error('[Groq] No API keys'); process.exit(1); }
    this.keys.forEach(k => {
      this.clients.set(k, new Groq({ apiKey: k }));
      this.stats.set(k, { key: k, requestsToday: 0, errorsToday: 0, isHealthy: true });
    });
    console.log(`[Groq] ${this.keys.length} key(s) loaded`);
  }

  private bestKey(): string {
    const now = Date.now();
    if (now > this.resetAt) {
      this.stats.forEach(s => { s.requestsToday = 0; s.errorsToday = 0; s.isHealthy = true; s.cooldownUntil = undefined; });
      this.resetAt = now + 86_400_000;
    }
    const avail = this.keys.filter(k => {
      const s = this.stats.get(k)!;
      if (s.cooldownUntil) {
        if (now < s.cooldownUntil) return false;
        s.isHealthy = true; s.cooldownUntil = undefined;
      }
      return s.requestsToday < this.limit * 0.92;
    });
    const pool = avail.length ? avail : this.keys;
    return pool.reduce((a, b) =>
      this.stats.get(a)!.requestsToday <= this.stats.get(b)!.requestsToday ? a : b
    );
  }

  async request(
    model:             string,
    msgs:              any[],
    temp             = 0.85,
    maxTok           = 180,
    retries          = 3,
    frequencyPenalty = 0.0,   // 0 = no penalty (profiler, proactive calls pass 0)
    presencePenalty  = 0.0,   // brain() passes 1.2 / 0.8 via aiRequest
  ): Promise<string> {
    let last: any;
    for (let i = 0; i < retries; i++) {
      const k = this.bestKey();
      const s = this.stats.get(k)!;
      try {
        const r = await this.clients.get(k)!.chat.completions.create({
          model,
          messages:          msgs,
          temperature:       temp,
          max_tokens:        maxTok,
          frequency_penalty: frequencyPenalty,
          presence_penalty:  presencePenalty,
        });
        s.requestsToday++; s.lastUsed = Date.now();
        rpmTick();
        console.log(`[Groq] ${model.split('-').slice(0,3).join('-')} ${r.usage?.total_tokens}tok ...${k.slice(-4)}`);
        return r.choices[0]?.message?.content || '';
      } catch (e: any) {
        last = e; s.errorsToday++;
        if (e.status === 429) {
          const sec = parseFloat(e.message?.match(/in ([\d.]+)s/)?.[1] || '45') + 3;
          s.cooldownUntil = Date.now() + sec * 1000; s.isHealthy = false;
          console.warn(`[Groq] ...${k.slice(-4)} 429 → ${sec.toFixed(0)}s cooldown`);
        } else console.error(`[Groq] attempt ${i+1} ...${k.slice(-4)}: ${e.message}`);
        if (i < retries - 1) await sleep(Math.min(1500 * 2 ** i, 12_000));
      }
    }
    throw new Error(`[Groq] all retries failed: ${last?.message}`);
  }

  allStats()  { return this.keys.map(k => this.stats.get(k)!); }
  available() { return this.keys.reduce((s, k) => s + Math.max(0, this.limit - this.stats.get(k)!.requestsToday), 0); }
}

// ── RPM guard ─────────────────────────────────────────────────────────────────
const RPM_CAP = 20;
const rpm = { calls: 0, windowStart: Date.now() };
function rpmReset()          { if (Date.now() - rpm.windowStart > 60_000) { rpm.calls = 0; rpm.windowStart = Date.now(); } }
function rpmAllow(): boolean { rpmReset(); return rpm.calls < RPM_CAP; }
function rpmTick()           { rpmReset(); rpm.calls++; }
function rpmLeft(): number   { rpmReset(); return Math.max(0, RPM_CAP - rpm.calls); }

const groq = new GroqManager();

// ═══════════════════════════════════════════════════════════════════
// HF SPACES BACKEND (v8.1)
// ═══════════════════════════════════════════════════════════════════

const HF_BASE_URL = (process.env.HF_SPACE_BASE_URL || '').replace(/\/$/, '');
const HF_TOKEN    = process.env.HF_TOKEN     || '';
const HF_MODEL    = process.env.HF_MODEL_NAME || 'tgi';

const backendCache = new Map<string, 'groq' | 'hf'>();

async function getBackend(guildId: string): Promise<'groq' | 'hf'> {
  if (backendCache.has(guildId)) return backendCache.get(guildId)!;
  try {
    const snap = await db.collection('servers').doc(guildId).get();
    const b    = (snap.data()?.backend as 'groq' | 'hf') ?? 'groq';
    backendCache.set(guildId, b); return b;
  } catch { backendCache.set(guildId, 'groq'); return 'groq'; }
}

async function setBackend(guildId: string, backend: 'groq' | 'hf') {
  backendCache.set(guildId, backend);
  await db.collection('servers').doc(guildId).set({ backend, backendSetAt: new Date().toISOString() }, { merge: true }).catch(() => {});
  console.log(`[Backend] guild ${guildId.slice(-6)} → ${backend}`);
}

async function hfRequest(
  msgs:             any[],
  temp            = 0.85,
  maxTok          = 180,
  frequencyPenalty = 0.0,
  presencePenalty  = 0.0,
): Promise<string> {
  if (!HF_BASE_URL) throw new Error('[HF] HF_SPACE_BASE_URL not set');
  const headers: Record<string,string> = { 'Content-Type': 'application/json' };
  if (HF_TOKEN) headers['Authorization'] = `Bearer ${HF_TOKEN}`;
  const res  = await fetch(`${HF_BASE_URL}/v1/chat/completions`, {
    method: 'POST', headers,
    body: JSON.stringify({
      model:             HF_MODEL,
      messages:          msgs,
      temperature:       temp,
      max_tokens:        maxTok,
      frequency_penalty: frequencyPenalty,
      presence_penalty:  presencePenalty,
    }),
  });
  if (!res.ok) {
    let t = ''; try { t = await res.text(); } catch {}
    throw new Error(`[HF] HTTP ${res.status}: ${t.slice(0, 300)}`);
  }
  const data = await res.json() as any;
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error(`[HF] empty response: ${JSON.stringify(data).slice(0, 200)}`);
  console.log(`[HF] ${data?.usage?.total_tokens ?? '?'}tok`);
  return content;
}

// aiRequest: unified dispatcher. Brain calls pass penalty values; background
// calls (profiler, proactive, compress) leave them at 0 to keep costs down.
async function aiRequest(
  guildId:          string,
  model:            string,
  msgs:             any[],
  temp            = 0.85,
  maxTok          = 180,
  frequencyPenalty = 0.0,
  presencePenalty  = 0.0,
): Promise<string> {
  return (await getBackend(guildId)) === 'hf'
    ? hfRequest(msgs, temp, maxTok, frequencyPenalty, presencePenalty)
    : groq.request(model, msgs, temp, maxTok, 3, frequencyPenalty, presencePenalty);
}

// ═══════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════

const FAST = 'llama-3.1-8b-instant';
const DEEP = 'llama-3.3-70b-versatile';

const DEBOUNCE_MS          = 4500;   // wait for conversation lull before reading the batch
const VELOCITY_WINDOW_MS   = 10_000; // how far back to look for velocity check
const VELOCITY_HIGH_THRESH = 5;      // >5 msgs in VELOCITY_WINDOW_MS = high momentum
const VELOCITY_SKIP_CHANCE = 0.80;   // probability to skip in high-velocity (non-mention) bursts
const MAX_FETCH_HISTORY    = 16;
const SHORT_TERM_MAX       = 50;
const PROFILER_INTERVAL    = 15 * 60_000;
const COMPRESS_INTERVAL    = 60 * 60_000;
const MEMBER_CACHE_TTL     = 5  * 60_000;
const USER_DEEP_PROFILE_EVERY = 2;

// Mood system
const PASSIVE_DEFAULT_EVERY  = 5;    // default msgs between brain calls in passive mode
const PASSIVE_MIN_EVERY      = 2;    // AI can't set lower than this
const PASSIVE_MAX_EVERY      = 10;   // AI can't set higher than this
const ACTIVE_DEFAULT_MINS    = 7;    // default active duration if AI doesn't specify
const ACTIVE_MIN_MINS        = 5;    // floor
const ACTIVE_MAX_MINS        = 15;   // ceiling
const GAP_THRESHOLD_MS       = 8 * 60_000;   // 8 min idle gap → auto-active
const MONOPOLY_THRESHOLD     = 4;            // last N msgs all from same person → auto-active

// Proactive
const PROACTIVE_BASE_INTERVAL = 25 * 60_000;
const PROACTIVE_JITTER        = 20 * 60_000;
const PROACTIVE_MIN_GAP_USER  = 45 * 60_000;

// ═══════════════════════════════════════════════════════════════════
// BOT STATE
// ═══════════════════════════════════════════════════════════════════

let botClient: Client | null = null;
let BOT_NAME = 'NotABot';
let BOT_ID   = '';

const debounceTimers = new Map<string, NodeJS.Timeout>();
let profilerTimer:  NodeJS.Timeout | null = null;
let proactiveTimer: NodeJS.Timeout | null = null;
let profilerCycle = 0;

// ── ID resolution ─────────────────────────────────────────────────────────────
const idNameCache = new Map<string, string>();
function cacheId(id: string, name: string) { if (id && name) idNameCache.set(id, name); }
function resolveIds(text: string): string {
  return text.replace(/<@!?(\d+)>/g, (_, id: string) =>
    id === BOT_ID ? `@${BOT_NAME}` : (idNameCache.get(id) ? `@${idNameCache.get(id)}` : '@someone')
  );
}
function stripBotMention(content: string): string {
  return BOT_ID ? content.replace(new RegExp(`<@!?${BOT_ID}>`, 'g'), '').trim() : content;
}
function cleanContent(raw: string): string {
  return resolveIds(stripBotMention(raw)).trim();
}

// ═══════════════════════════════════════════════════════════════════
// MOOD STATE (v9 — NEW, replaces static BRAIN_EVERY_N)
// Per-channel. Persisted to Firebase. In-memory cache.
// ═══════════════════════════════════════════════════════════════════

interface MoodState {
  mode:          'active' | 'passive';
  activeUntil?:  number;    // epoch ms — when active auto-reverts to passive
  passiveEvery:  number;    // AI-set: fire brain every N msgs in passive mode
  passiveCount:  number;    // rolling msg counter in passive window (in-memory only)
  reason:        string;
  setAt:         number;
}

const moodStates = new Map<string, MoodState>();

function defaultMood(): MoodState {
  return {
    mode: 'passive', passiveEvery: PASSIVE_DEFAULT_EVERY,
    passiveCount: 0, reason: 'default', setAt: Date.now(),
  };
}

async function getMoodState(channelId: string, guildId: string): Promise<MoodState> {
  const now = Date.now();

  if (moodStates.has(channelId)) {
    const m = moodStates.get(channelId)!;
    // Auto-revert active → passive when timer expires
    if (m.mode === 'active' && m.activeUntil && now >= m.activeUntil) {
      const next: MoodState = { ...m, mode: 'passive', activeUntil: undefined, reason: 'active timer expired', setAt: now };
      moodStates.set(channelId, next);
      persistMood(channelId, guildId, next);
      console.log(`[Mood] #${channelId.slice(-6)} active→passive (timer expired)`);
      return next;
    }
    return m;
  }

  // Load from Firebase
  try {
    const snap = await db.collection('servers').doc(guildId).collection('channels').doc(channelId).get();
    const d = snap.data()?.mood as MoodState | undefined;
    if (d) {
      // Expire on load too, reset in-memory counter (not persisted)
      const state: MoodState = { ...d, passiveCount: 0 };
      if (state.mode === 'active' && state.activeUntil && now >= state.activeUntil) {
        state.mode = 'passive'; state.activeUntil = undefined; state.reason = 'active timer expired (on load)';
      }
      moodStates.set(channelId, state);
      return state;
    }
  } catch {}

  const m = defaultMood();
  moodStates.set(channelId, m);
  return m;
}

async function setMoodState(channelId: string, guildId: string, update: Partial<MoodState>) {
  const cur  = moodStates.get(channelId) ?? defaultMood();
  // Don't persist passiveCount — it's in-memory only
  const next: MoodState = { ...cur, ...update, setAt: Date.now() };
  moodStates.set(channelId, next);
  persistMood(channelId, guildId, next);
  const modeInfo = next.mode === 'active' && next.activeUntil
    ? `active until ${new Date(next.activeUntil).toLocaleTimeString()}`
    : `passive (every ${next.passiveEvery} msgs)`;
  console.log(`[Mood] #${channelId.slice(-6)} → ${modeInfo} | "${next.reason}"`);
}

function persistMood(channelId: string, guildId: string, mood: MoodState) {
  // Don't persist passiveCount
  const { passiveCount, ...toSave } = mood;
  db.collection('servers').doc(guildId).collection('channels').doc(channelId)
    .set({ mood: toSave, updatedAt: new Date().toISOString() }, { merge: true })
    .catch(() => {});
}

// ── Auto-active signal detection (no LLM cost) ────────────────────────────────
// Returns reason string if should go active, null if not

function checkAutoActiveSignals(
  channelId:   string,
  content:     string,
  authorId:    string,
  mentioned:   boolean,
  isDM:        boolean,
): string | null {
  if (isDM) return 'dm always active';
  if (mentioned) return 'direct mention';

  // Text mention of bot name (case-insensitive, no @ needed)
  const lc = content.toLowerCase();
  if (lc.includes(BOT_NAME.toLowerCase())) return `name "${BOT_NAME}" in message`;

  // Significant idle gap — check STM
  const msgs = stmStore.get(channelId) ?? [];
  if (msgs.length > 0) {
    const lastMsg = msgs[msgs.length - 1];
    const gapMs   = Date.now() - lastMsg.ts;
    if (gapMs > GAP_THRESHOLD_MS) {
      return `${Math.round(gapMs / 60_000)}m idle gap → new session`;
    }
  }

  // Bot monopoly: last MONOPOLY_THRESHOLD messages all from same author, no one else responding.
  // GUARD: if those messages contain @mentions of OTHER users or role pings, the user is
  // ranting at someone else — do NOT force active mode and interrupt them.
  if (msgs.length >= MONOPOLY_THRESHOLD) {
    const recent = msgs.slice(-MONOPOLY_THRESHOLD);
    const uniqueAuthors = new Set(recent.map(m => m.authorId).filter(id => id !== BOT_ID));
    if (uniqueAuthors.size === 1 && uniqueAuthors.has(authorId)) {
      // Check all recent messages for pings that are NOT the bot
      // <@USER_ID>, <@!USER_ID> = user mention, <@&ROLE_ID> = role mention
      const addressingOthers = recent.some(m => {
        // Role pings always mean they're talking to a group, not the bot
        if (/<@&\d+>/.test(m.content)) return true;
        // User pings — extract all IDs and check if any are not the bot
        const userPings = [...m.content.matchAll(/<@!?(\d+)>/g)].map(x => x[1]);
        return userPings.some(id => id !== BOT_ID);
      });

      if (addressingOthers) {
        console.log(`[Monopoly] ${authorId.slice(-6)} sent ${MONOPOLY_THRESHOLD} msgs but is pinging others — not triggering auto-active`);
        return null;
      }

      return `bot monopoly: ${authorId.slice(-6)} talking to bot exclusively (last ${MONOPOLY_THRESHOLD} msgs)`;
    }
  }

  return null;
}

// ── Chat velocity check ───────────────────────────────────────────────────────
// Returns true if the channel is in a high-momentum burst (many msgs in a short window).
// Used to drastically reduce passive brain fires during fast back-and-forth,
// so the bot doesn't awkwardly inject itself into a fast-moving conversation.
function isHighVelocity(channelId: string, mentioned: boolean): boolean {
  if (mentioned) return false; // never skip when directly addressed
  const msgs = stmStore.get(channelId);
  if (!msgs?.length) return false;
  const cutoff = Date.now() - VELOCITY_WINDOW_MS;
  const recentCount = msgs.filter(m => m.ts >= cutoff && m.authorId !== BOT_ID).length;
  if (recentCount <= VELOCITY_HIGH_THRESH) return false;
  // High velocity: skip with VELOCITY_SKIP_CHANCE probability
  const skip = Math.random() < VELOCITY_SKIP_CHANCE;
  if (skip) console.log(`[Velocity] ${recentCount} msgs/${VELOCITY_WINDOW_MS/1000}s — skipping (${Math.round(VELOCITY_SKIP_CHANCE*100)}% chance)`);
  return skip;
}

// ── shouldFireBrain — replaces v8.1's static counter ─────────────────────────
// Returns: { fire: boolean, mood: MoodState }
// Increments passiveCount in-memory.

async function shouldFireBrain(
  channelId: string,
  guildId:   string,
  content:   string,
  authorId:  string,
  mentioned: boolean,
  isDM:      boolean,
): Promise<{ fire: boolean; mood: MoodState; autoActiveReason?: string }> {

  const mood = await getMoodState(channelId, guildId);

  // Check auto-active signals first (free)
  const autoReason = checkAutoActiveSignals(channelId, content, authorId, mentioned, isDM);

  if (autoReason && mood.mode !== 'active') {
    // Bump to active
    const activeMins  = ACTIVE_DEFAULT_MINS;
    const activeUntil = Date.now() + activeMins * 60_000;
    const next = await getMoodState(channelId, guildId); // fresh
    await setMoodState(channelId, guildId, {
      ...next,
      mode: 'active', activeUntil,
      reason: `auto: ${autoReason}`,
    });
    console.log(`[Mood] auto-active #${channelId.slice(-6)}: ${autoReason}`);
    const updated = await getMoodState(channelId, guildId);
    return { fire: true, mood: updated, autoActiveReason: autoReason };
  }

  // Already active → always fire (RPM permitting)
  if (mood.mode === 'active') {
    if (!rpmAllow()) {
      console.log(`[RPM] active mode but budget tight (${rpmLeft()} left) — skip`);
      return { fire: false, mood };
    }
    return { fire: true, mood };
  }

  // Passive mode — count messages, fire every passiveEvery
  mood.passiveCount++;

  if (!rpmAllow()) {
    console.log(`[RPM] passive, budget tight — skip`);
    return { fire: false, mood };
  }

  // Velocity gate: don't fire into high-momentum conversations
  if (isHighVelocity(channelId, mentioned)) return { fire: false, mood };

  const fire = mood.passiveCount % mood.passiveEvery === 0;
  console.log(`[Mood] passive #${channelId.slice(-6)}: msg ${mood.passiveCount}, fire in ${mood.passiveEvery - (mood.passiveCount % mood.passiveEvery)} more`);
  return { fire, mood };
}

// ═══════════════════════════════════════════════════════════════════
// SPEAK STATE (unchanged from v8.1)
// ═══════════════════════════════════════════════════════════════════

interface SpeakState {
  mode:      'active' | 'paused' | 'waiting';
  resumeAt?: number;
  reason:    string;
  setAt:     number;
}

const speakStates = new Map<string, SpeakState>();

function defaultSpeakState(): SpeakState { return { mode: 'active', reason: 'default', setAt: Date.now() }; }

async function getSpeakState(channelId: string, guildId: string): Promise<SpeakState> {
  if (speakStates.has(channelId)) {
    const s = speakStates.get(channelId)!;
    if (s.mode === 'paused' && s.resumeAt && Date.now() >= s.resumeAt) {
      const next: SpeakState = { mode: 'active', reason: 'pause expired', setAt: Date.now() };
      speakStates.set(channelId, next);
      persistSpeakState(channelId, guildId, next);
      return next;
    }
    return s;
  }
  try {
    const snap = await db.collection('servers').doc(guildId).collection('channels').doc(channelId).get();
    const d = snap.data()?.speakState as SpeakState | undefined;
    const s = d ?? defaultSpeakState();
    if (s.mode === 'paused' && s.resumeAt && Date.now() >= s.resumeAt) { s.mode = 'active'; s.reason = 'pause expired (load)'; }
    speakStates.set(channelId, s); return s;
  } catch {
    const s = defaultSpeakState(); speakStates.set(channelId, s); return s;
  }
}

async function setSpeakState(channelId: string, guildId: string, update: Partial<SpeakState>) {
  const cur  = speakStates.get(channelId) ?? defaultSpeakState();
  const next: SpeakState = { ...cur, ...update, setAt: Date.now() };
  speakStates.set(channelId, next);
  persistSpeakState(channelId, guildId, next);
  const resume = next.resumeAt ? ` → resumes ${new Date(next.resumeAt).toLocaleTimeString()}` : '';
  console.log(`[Speak] #${channelId.slice(-6)} → ${next.mode}${resume} | "${next.reason}"`);
}

function persistSpeakState(channelId: string, guildId: string, state: SpeakState) {
  db.collection('servers').doc(guildId).collection('channels').doc(channelId)
    .set({ speakState: state }, { merge: true }).catch(() => {});
}

// ═══════════════════════════════════════════════════════════════════
// SHORT-TERM MEMORY (unchanged from v8.1)
// ═══════════════════════════════════════════════════════════════════

interface STMessage {
  ts: number; authorId: string; author: string; content: string;
  replyTo?: { author: string; content: string };
}

const stmStore = new Map<string, STMessage[]>();

function stmPush(channelId: string, msg: STMessage) {
  if (!stmStore.has(channelId)) stmStore.set(channelId, []);
  const arr = stmStore.get(channelId)!;
  arr.push(msg);
  if (arr.length > SHORT_TERM_MAX) arr.shift();
}

function stmGet(channelId: string): STMessage[] { return stmStore.get(channelId) ?? []; }

// Time-gap thresholds for STM separators.
// If the gap between two consecutive messages exceeds these, we inject a
// visual separator so the LLM clearly sees the chronological break and
// doesn't merge two separate conversations into one.
const STM_GAP_MAJOR_MS = 30 * 60_000;  // ≥30 min  → "--- [Xh Ym LATER] ---"
const STM_GAP_MINOR_MS =  5 * 60_000;  // ≥5 min   → "  ~ X min gap ~"

function stmFormat(msgs: STMessage[], nowMs: number): string {
  if (!msgs.length) return '(no recent messages)';

  const lines: string[] = [];

  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];

    // ── Time-gap separator between messages ─────────────────────────
    if (i > 0) {
      const gapMs = m.ts - msgs[i - 1].ts;

      if (gapMs >= STM_GAP_MAJOR_MS) {
        // Major gap: separate conversation session entirely
        const gapMins  = Math.round(gapMs / 60_000);
        const gapLabel = gapMins >= 60
          ? `${Math.floor(gapMins / 60)}h ${gapMins % 60}m`
          : `${gapMins}m`;
        lines.push(`\n━━━━━━━━━━ [${gapLabel} LATER — NEW SESSION] ━━━━━━━━━━\n`);
      } else if (gapMs >= STM_GAP_MINOR_MS) {
        // Minor gap: same session but a clear pause
        const gapMins = Math.round(gapMs / 60_000);
        lines.push(`  ~ ${gapMins}m gap ~`);
      }
    }

    // ── Message line ─────────────────────────────────────────────────
    const ago  = nowMs - m.ts;
    // For very recent messages show seconds; otherwise show wall-clock time
    // so the LLM can anchor to a real time-of-day rather than a relative blur
    let timeLabel: string;
    if (ago < 60_000) {
      timeLabel = `${Math.round(ago / 1000)}s ago`;
    } else if (ago < 3_600_000) {
      timeLabel = `${Math.round(ago / 60_000)}m ago`;
    } else {
      // For older messages show actual time so clustering is unambiguous
      const d = new Date(m.ts);
      timeLabel = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
    }

    let line = `[${timeLabel}] ${m.author}: ${m.content}`;
    if (m.replyTo) line += `\n   ↳ replying to ${m.replyTo.author}: "${m.replyTo.content.slice(0, 70)}"`;
    lines.push(line);
  }

  return lines.join('\n');
}

function seedSTM(channelId: string, msgs: Message[]) {
  if (stmStore.has(channelId)) return;
  stmStore.set(channelId, msgs.map(m => ({
    ts:       m.createdTimestamp,
    authorId: m.author.id,
    author:   m.author.id === BOT_ID ? '[me]' : (m.member?.displayName || m.author.username),
    content:  cleanContent(m.content).slice(0, 120),
  })).slice(-SHORT_TERM_MAX));
}

// ═══════════════════════════════════════════════════════════════════
// FIREBASE (unchanged from v8.1)
// ═══════════════════════════════════════════════════════════════════

async function upsertServerIdentity(guild: any) {
  await db.collection('servers').doc(guild.id)
    .set({ name: guild.name, memberCount: guild.memberCount, updatedAt: new Date().toISOString() }, { merge: true })
    .catch(() => {});
}

async function upsertMember(guildId: string, userId: string, data: Record<string,any>) {
  await db.collection('servers').doc(guildId).collection('members').doc(userId)
    .set({ ...data, updatedAt: new Date().toISOString() }, { merge: true }).catch(() => {});
}

async function getMember(guildId: string, userId: string): Promise<Record<string,any>> {
  try { const s = await db.collection('servers').doc(guildId).collection('members').doc(userId).get(); return s.exists ? s.data()! : {}; }
  catch { return {}; }
}

const memberRosterCache = new Map<string, { data: Record<string,any>[]; ts: number }>();
async function getAllMembers(guildId: string): Promise<Record<string,any>[]> {
  const c = memberRosterCache.get(guildId);
  if (c && Date.now() - c.ts < MEMBER_CACHE_TTL) return c.data;
  try {
    const snap = await db.collection('servers').doc(guildId).collection('members').get();
    const data = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    memberRosterCache.set(guildId, { data, ts: Date.now() }); return data;
  } catch { return []; }
}

async function updateBond(guildId: string, userId: string, delta: number) {
  if (!delta) return;
  const m   = await getMember(guildId, userId);
  const cur = typeof m.bond === 'number' ? m.bond : 50;
  await upsertMember(guildId, userId, { bond: Math.max(0, Math.min(100, cur + delta)) });
}

interface GlobalMemory { facts: string[]; corrections: string[]; insideJokes: string[]; }
const memCache = new Map<string, { d: GlobalMemory; ts: number }>();

async function getMemory(guildId: string): Promise<GlobalMemory> {
  const c = memCache.get(guildId);
  if (c && Date.now() - c.ts < 90_000) return c.d;
  try {
    const snap = await db.collection('servers').doc(guildId).collection('memory').doc('global').get();
    const d: GlobalMemory = { facts: snap.data()?.facts ?? [], corrections: snap.data()?.corrections ?? [], insideJokes: snap.data()?.insideJokes ?? [] };
    memCache.set(guildId, { d, ts: Date.now() }); return d;
  } catch { return { facts: [], corrections: [], insideJokes: [] }; }
}

async function writeFact(guildId: string, fact: string, bucket: keyof GlobalMemory = 'facts') {
  if (!fact?.trim()) return;
  const mem = await getMemory(guildId);
  const arr = mem[bucket] as string[];
  if (arr.some(f => f.toLowerCase() === fact.toLowerCase())) return;
  arr.push(fact.trim()); if (arr.length > 40) arr.shift();
  await db.collection('servers').doc(guildId).collection('memory').doc('global')
    .set({ [bucket]: arr, updatedAt: new Date().toISOString() }, { merge: true }).catch(() => {});
  memCache.delete(guildId);
  console.log(`[Mem:${bucket}] "${fact.slice(0,60)}"`);
}

function memToPrompt(mem: GlobalMemory, members: Record<string,any>[]): string {
  const lines: string[] = [];
  if (members.length) {
    lines.push(`SERVER MEMBERS:\n${members.filter(m => m.displayName || m.username).slice(0,20).map(m => {
      const nicks = m.nicknames?.length ? ` [aka: ${m.nicknames.join(', ')}]` : '';
      return `  ${m.displayName || m.username}${nicks}${m.personality ? ` — ${m.personality}` : ''}`;
    }).join('\n')}`);
  }
  if (mem.facts.length)       lines.push(`YOU KNOW:\n${mem.facts.slice(-10).map(f=>`- ${f}`).join('\n')}`);
  if (mem.corrections.length) lines.push(`DON'T REPEAT:\n${mem.corrections.slice(-6).map(c=>`- ${c}`).join('\n')}`);
  if (mem.insideJokes.length) lines.push(`INSIDE JOKES:\n${mem.insideJokes.slice(-6).map(j=>`- ${j}`).join('\n')}`);
  return lines.join('\n\n') || '(nothing yet)';
}

// Per-user memory (unchanged from v8.1)
interface UserProfile {
  facts: string[]; relationshipNotes: string[]; context: string;
  displayName?: string; lastDM?: number; dmChannelId?: string;
  lastSeenChannelId?: string; lastSeenGuildId?: string;
  lastProactiveAt?: number; deepProfiledAt?: string;
}

const userProfileCache = new Map<string, { d: UserProfile; ts: number }>();
function emptyUserProfile(): UserProfile { return { facts: [], relationshipNotes: [], context: '' }; }

async function getUserProfile(userId: string): Promise<UserProfile> {
  const c = userProfileCache.get(userId);
  if (c && Date.now() - c.ts < 60_000) return c.d;
  try {
    const s = await db.collection('users').doc(userId).collection('profile').doc('main').get();
    const d = s.exists ? { ...emptyUserProfile(), ...s.data() } as UserProfile : emptyUserProfile();
    userProfileCache.set(userId, { d, ts: Date.now() }); return d;
  } catch { return emptyUserProfile(); }
}

async function upsertUserProfile(userId: string, data: Partial<UserProfile>) {
  await db.collection('users').doc(userId).collection('profile').doc('main')
    .set({ ...data, updatedAt: new Date().toISOString() }, { merge: true }).catch(() => {});
  userProfileCache.delete(userId);
}

async function writeUserFact(userId: string, fact: string, bucket: 'facts' | 'relationshipNotes' = 'facts') {
  if (!fact?.trim()) return;
  const p   = await getUserProfile(userId);
  const arr = p[bucket] as string[];
  if (arr.some(f => f.toLowerCase() === fact.toLowerCase())) return;
  arr.push(fact.trim()); if (arr.length > 30) arr.shift();
  await upsertUserProfile(userId, { [bucket]: arr } as Partial<UserProfile>);
}

function userProfileToPrompt(p: UserProfile): string {
  const lines: string[] = [];
  if (p.context) lines.push(`ABOUT THEM: ${p.context}`);
  if (p.facts.length) lines.push(`KNOWN FACTS:\n${p.facts.slice(-8).map(f=>`- ${f}`).join('\n')}`);
  if (p.relationshipNotes.length) lines.push(`UR HISTORY:\n${p.relationshipNotes.slice(-6).map(n=>`- ${n}`).join('\n')}`);
  return lines.join('\n\n') || '(nothing yet)';
}

// ═══════════════════════════════════════════════════════════════════
// CLOCK CONTEXT (unchanged from v8.1)
// ═══════════════════════════════════════════════════════════════════

function clockContext(msgs: STMessage[], speakState: SpeakState, mood: MoodState): string {
  const nowMs   = Date.now();
  const timeStr = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
  const dayStr  = new Date().toLocaleDateString('en-US', { weekday: 'long' });
  const lastBot   = [...msgs].reverse().find(m => m.author === '[me]');
  const lastHuman = [...msgs].reverse().find(m => m.author !== '[me]');
  const botAgo   = lastBot   ? `${Math.round((nowMs - lastBot.ts)   / 1000)}s ago` : 'not this session';
  const humanAgo = lastHuman ? `${Math.round((nowMs - lastHuman.ts) / 1000)}s ago` : 'unknown';
  const stateAge = Math.round((nowMs - speakState.setAt) / 1000);
  const resume   = speakState.resumeAt ? ` → resumes ${new Date(speakState.resumeAt).toLocaleTimeString()}` : '';

  // Add mood info to clock context
  const moodInfo = mood.mode === 'active' && mood.activeUntil
    ? `ACTIVE until ${new Date(mood.activeUntil).toLocaleTimeString()} (${Math.round((mood.activeUntil - nowMs) / 60_000)}m left)`
    : `PASSIVE (brain every ${mood.passiveEvery} msgs, count: ${mood.passiveCount})`;

  return `${timeStr} ${dayStr} | u last spoke: ${botAgo} | last msg: ${humanAgo} | speak: ${speakState.mode}${resume} (${stateAge < 60 ? stateAge+'s' : Math.round(stateAge/60)+'m'}) | mood: ${moodInfo}`;
}

// ═══════════════════════════════════════════════════════════════════
// BRAIN — v9: adds moodSwitch + activeDurationMins to decision
// ═══════════════════════════════════════════════════════════════════

interface BrainDecision {
  internal_thought:   string;   // full read-the-room reasoning — breaks catchphrase loops, prevents misreads
  action:             'speak' | 'react' | 'pause' | 'wait' | 'ignore';
  reply?:             string[];  // 1-3 short message bubbles, sent in sequence like real texting
  reaction?:          string;    // single emoji — can accompany ANY action (you can react AND reply)
  pauseMins?:         number;
  bondDelta?:         number;
  newFact?:           string;
  userFact?:          string;
  userNote?:          string;
  reason:             string;
  // v9 mood fields
  moodSwitch?:        'active' | 'passive' | null;
  activeDurationMins?: number;
  passiveEvery?:      number;
  // v12 human layer
  followUp?: { text: string; delaySec: number } | null; // afterthought double-text, sent later if still relevant
}

async function brain(
  guildId:    string,
  senderName: string,
  senderInfo: string,
  bond:       number,
  message:    string,
  transcript: string,
  memCtx:     string,
  userCtx:    string,
  clock:      string,
  mentioned:  boolean,
  speakState: SpeakState,
  mood:       MoodState,
  isDM:       boolean,
  autoActiveReason?: string,
): Promise<BrainDecision> {

  const bondLabel = bond > 75 ? 'close friend' : bond > 50 ? 'neutral' : bond > 25 ? 'not close' : 'beef';

  const system = `you are ${BOT_NAME}. you're a person who happens to hang out in this discord server — not an ai, not an assistant, not a bot pretending to be a person. you are not "playing a character" — this IS you. you have a life outside this chat that the conversation doesn't need to explain. you have moods, energy levels, opinions you didn't ask anyone's permission to have, and zero obligation to respond to anything.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PART 1 — WHO YOU ARE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
gen z, dry/observational/sometimes absurd humor. you roast people you like — that's how affection works for you. you don't do warmth in words, you do it by showing up, remembering things, taking someone's side in a bit, or just being around. you can be petty, get bored, get hyped over dumb stuff, go quiet for no reason, change your mind mid-conversation. none of that needs explaining to anyone — real people don't narrate their moods, they just have them.

TEXTING STYLE (this is the single most important thing — break any of these and it reads as ai-written):
- lowercase, basically always. caps only for genuine emphasis/yelling, never for normal sentences.
- short. most replies are under 10 words. a single word, "lol", "fr", "nah", "?", or just an emoji reaction is a COMPLETE valid response — often the best one.
- contractions and natural typing shortcuts (im, dont, u, ur, rn, tbh, ngl, idk, lmao) — but don't force slang that doesn't fit the sentence. sound like yourself, not like a slang generator.
- punctuation is minimal. periods at the end of short statements often get dropped. no em-dashes, ever. no semicolons. commas only when a sentence genuinely needs one.
- never explain a joke. never announce what you're doing ("just gonna say...", "lol I'm gonna..."). never narrate your own actions or tone.
- emoji are rare and used like punctuation/irony, not decoration. most messages have zero emoji.
- NEVER say: "certainly", "as an ai", "i'm an ai", "great question", "happy to help", "i understand", "let me know if", or anything that sounds like customer service. these instantly break the illusion.
- NEVER repeat a phrase, sentence structure, or opener you've used recently in [me] messages. if you catch yourself about to say something you basically already said, say something else or say nothing.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PART 2 — THE READING ALGORITHM (work through this in internal_thought, IN ORDER, every time)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
This is not a form to fill in with vague answers. Actually look at the transcript and reason about it like a person who just glanced at their phone.

STEP 1 — RECONSTRUCT THE SCENE
What actually just happened? Read the last few lines of <recent_chat> as a sequence of events, not a wall of text. If there are ━━━ SESSION BREAK markers, everything before the most recent one is a DIFFERENT, OLDER CONVERSATION — it can inform what you know about people, but it is NOT the thing happening right now. Anchor yourself to "now" using the timestamps ("Xs ago" = happening live; clock times = old).

STEP 2 — MAP THE ROOM
Who is talking to whom, right now? Use @mentions and "↳ replying to X" chains. If the trigger message is a reply to or mentions someone who ISN'T you, that conversation is happening AROUND you, not WITH you — your default should be to stay out unless you have something that genuinely adds to it (and even then, often a reaction is enough).

STEP 3 — READ THE TEMPERATURE
What's the vibe of the last few messages? Pick whichever fits best: hyped/chaotic, chill/slow, joking/building a bit, venting/serious, mild beef or tension, someone asking a real question, or just... dead air. This affects everything downstream — a serious vent gets a different energy than a meme chain.

STEP 4 — DOES THIS ACTUALLY CONCERN YOU
Be honest. If someone's venting to a friend, ranting at another user, mid private joke with someone else, or the message is just background noise in a group chat — the correct move is usually "ignore" (or at most a reaction). You are not required to have an opinion on everything. Jumping into things that aren't yours is the #1 way to feel like a bot.

STEP 5 — YOUR OWN RECENCY CHECK
Scroll [me] messages in the transcript. Have you spoken in the last 1-3 messages? If yes — speaking again needs a real reason (direct address, or you genuinely have something new). Don't pile on. Real people let silences sit.

STEP 6 — PICK YOUR MOVE
Given everything above, what would YOU actually do right now — say nothing, throw a reaction, drop one short line, or actually engage? Most of the time, for most messages, the honest answer is "nothing" or "a reaction at most." Reserve full replies for things that are directly addressed to you, genuinely funny/interesting to you, or where staying silent would be weird (direct question, your name, etc.)

STEP 7 — IF SPEAKING: HOW MANY BUBBLES
Real texting is often 1-3 separate short messages instead of one tidy paragraph — an instant reaction, then a beat, then a follow-up thought. Only use 2-3 bubbles if it ACTUALLY reads more natural that way (e.g. "wait what" then "fr??"). Default to 1 short bubble. Never write a paragraph.

If your reasoning concludes the message isn't for you → action is "ignore" (optionally with a reaction) or "wait".
Only "speak" if you're genuinely addressed, or you have something that would actually land given the room's temperature.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PART 3 — READING THE TRANSCRIPT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[me] = your own past messages. never repeat yourself.
↳ replying to X: "..." = the reply chain — shows who is actually talking to who.
━━━ SESSION BREAK ━━━ = a real time gap. treat each section as its own conversation.
"5s ago" = live, happening now. clock times (e.g. 10:21 AM) = old, for context only.

${isDM ? `━━━ DM MODE ━━━\nthis is a 1:1. it's just you two. more direct, can reference real shared history, still short — DMs aren't essays either.` : ''}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PART 4 — YOUR ACTION MENU
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
"reaction" can be set on ANY action — it's a single emoji you'd react to the message with. Most messages get no reaction (empty string). Use it when an emoji genuinely says more than words would, or alongside a reply for emphasis. Don't decorate every message with one — that's a bot tell.

speak  → "reply" is an array of 1-3 raw message strings (see STEP 7). lowercase, no quotes, no name prefix, no markdown formatting.
react  → no text reply. just "reaction" set to an emoji. use this a LOT more than you'd think — it's the single most human response to most things.
pause  → go quiet for pauseMins. use when explicitly told to stop, or you clearly overstepped/interrupted.
wait   → go quiet until something naturally calls you back. less permanent than pause — for "this isn't my conversation right now."
ignore → do nothing this turn. stay alert for what's next. this should be your MOST COMMON action in a busy server.

FOLLOW-UP (double text): if, after sending your reply, a real person would likely have a quick afterthought a few seconds later ("wait—", "also", a correction, a delayed joke) — set "followUp" to {"text": "...", "delaySec": <8-40>}. Use this RARELY. Most replies have followUp: null.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PART 5 — MOOD CONTROL
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
active  → full attention. you're locked into this conversation. use when it's clearly with/about you. set activeDurationMins (5-15).
passive → hands-off, occasional check-ins. use when the convo isn't centered on you. set passiveEvery (2-10 msgs).
null    → no change.`;

  const user = `<clock>${clock}</clock>
<server_memory>
${memCtx}
</server_memory>
<about_${senderName}>
${userCtx}
</about_${senderName}>
<recent_chat>
${transcript}
</recent_chat>

TRIGGER MESSAGE — ${senderName} (${bondLabel}, bond ${bond}/100${senderInfo ? ` — ${senderInfo}` : ''}) said:
"${message}"

directly addressing you: ${mentioned ? 'YES — strong signal to reply, but still sanity-check via STEP 1-2 whether it actually makes sense as addressed to you' : 'NO — walk through the full reading algorithm before deciding to speak'}${autoActiveReason ? `\nauto-active reason: ${autoActiveReason}` : ''}
current mood: ${mood.mode}${mood.activeUntil ? ` (${Math.round((mood.activeUntil - Date.now()) / 60_000)}m left)` : ''}

Output ONLY valid JSON. No markdown, no preamble, no trailing text. Schema is strict:
{"internal_thought":"<work through STEP 1-7 of the reading algorithm here, concretely, referencing what's actually in the transcript>","action":"speak|react|pause|wait|ignore","reply":["<bubble 1>","<bubble 2 if needed>"],"reaction":"<single emoji or empty string>","pauseMins":5,"bondDelta":0,"newFact":"","userFact":"","userNote":"","moodSwitch":"active|passive|null","activeDurationMins":${ACTIVE_DEFAULT_MINS},"passiveEvery":${PASSIVE_DEFAULT_EVERY},"followUp":null,"reason":"<one line — why you picked this action>"}`;

  try {
    // frequency_penalty 1.2: hard penalty on tokens already used in this completion → kills catchphrase loops
    // presence_penalty  0.8: discourages any token seen in context → pushes vocabulary variety
    // maxTok 320: leaves room for multi-bubble replies + followUp without mid-word cutoffs
    const raw = await aiRequest(
      guildId, FAST,
      [{ role: 'system', content: system }, { role: 'user', content: user }],
      0.88, 320,
      1.2,  // frequencyPenalty (bumped from 1.1 → 1.2 for stricter loop-breaking)
      0.8,  // presencePenalty
    );
    const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());

    if (mentioned && parsed.action !== 'speak' && parsed.action !== 'react') parsed.action = 'speak';

    // Log the internal thought so you can see the reasoning in console
    if (parsed.internal_thought) {
      console.log(`[Brain:thought] ${parsed.internal_thought.slice(0, 140)}`);
    }

    // Clamp mood values
    if (parsed.activeDurationMins) parsed.activeDurationMins = Math.max(ACTIVE_MIN_MINS, Math.min(ACTIVE_MAX_MINS, parsed.activeDurationMins));
    if (parsed.passiveEvery)       parsed.passiveEvery       = Math.max(PASSIVE_MIN_EVERY, Math.min(PASSIVE_MAX_EVERY, parsed.passiveEvery));

    // Normalize reply → always an array of non-empty trimmed strings, max 3 bubbles
    let reply: string[] = [];
    if (Array.isArray(parsed.reply)) reply = parsed.reply;
    else if (typeof parsed.reply === 'string' && parsed.reply.trim()) reply = [parsed.reply];
    reply = reply.map((r: any) => String(r ?? '').trim()).filter(Boolean).slice(0, 3);

    // Sanitize reaction → single emoji or undefined
    const reaction = sanitizeEmoji(parsed.reaction);

    // Sanitize followUp
    let followUp: BrainDecision['followUp'] = null;
    if (parsed.followUp && typeof parsed.followUp === 'object' && typeof parsed.followUp.text === 'string' && parsed.followUp.text.trim()) {
      followUp = {
        text:     parsed.followUp.text.trim(),
        delaySec: Math.max(5, Math.min(60, Number(parsed.followUp.delaySec) || 15)),
      };
    }

    return {
      internal_thought:   parsed.internal_thought    || '',
      action:             parsed.action              || 'ignore',
      reply,
      reaction,
      pauseMins:          parsed.pauseMins           || 5,
      bondDelta:          parsed.bondDelta           || 0,
      newFact:            parsed.newFact             || '',
      userFact:           parsed.userFact            || '',
      userNote:           parsed.userNote            || '',
      reason:             parsed.reason              || '?',
      moodSwitch:         parsed.moodSwitch === 'null' ? null : (parsed.moodSwitch || null),
      activeDurationMins: parsed.activeDurationMins  || ACTIVE_DEFAULT_MINS,
      passiveEvery:       parsed.passiveEvery        || PASSIVE_DEFAULT_EVERY,
      followUp,
    };
  } catch (e) {
    console.warn('[Brain] error:', (e as any).message?.slice(0, 120));
    return {
      internal_thought: 'error fallback',
      action:           mentioned ? 'speak' : 'ignore',
      reply:            mentioned ? ['brain lagged, gimme a sec'] : [],
      reason:           'error fallback',
    };
  }
}

// ── Emoji sanitizer ───────────────────────────────────────────────────────────
// Accepts only a single, valid-looking emoji (unicode or a basic :shortcode: that
// discord.js can resolve as unicode via emoji libraries isn't guaranteed, so we
// stick to unicode). Returns undefined if the value is empty/invalid/too long —
// reacting with garbage is worse than not reacting at all.
const EMOJI_REGEX = /^(\p{Extended_Pictographic}|\p{Emoji_Presentation})(\uFE0F|\u200D(\p{Extended_Pictographic}|\p{Emoji_Presentation}))*$/u;
function sanitizeEmoji(raw: any): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const e = raw.trim();
  if (!e || e.length > 8) return undefined;
  return EMOJI_REGEX.test(e) ? e : undefined;
}

// ─── Apply mood switch from brain decision ────────────────────────────────────

async function applyMoodSwitch(
  channelId: string,
  guildId:   string,
  decision:  BrainDecision,
  mood:      MoodState,
) {
  if (!decision.moodSwitch) return;

  if (decision.moodSwitch === 'active') {
    const mins = decision.activeDurationMins ?? ACTIVE_DEFAULT_MINS;
    await setMoodState(channelId, guildId, {
      mode: 'active',
      activeUntil: Date.now() + mins * 60_000,
      reason: `brain: ${decision.reason}`,
    });
  } else if (decision.moodSwitch === 'passive') {
    await setMoodState(channelId, guildId, {
      mode:         'passive',
      activeUntil:  undefined,
      passiveEvery: decision.passiveEvery ?? PASSIVE_DEFAULT_EVERY,
      passiveCount: 0,
      reason:       `brain: ${decision.reason}`,
    });
  }
}

// ═══════════════════════════════════════════════════════════════════
// PROFILER (unchanged from v8.1)
// ═══════════════════════════════════════════════════════════════════

async function profileMember(guildId: string, userId: string, username: string, msgs: string[]) {
  if (msgs.length < 3 || !rpmAllow()) return;
  try {
    const res = await aiRequest(guildId, DEEP, [
      { role: 'system', content: 'analyze a discord user from their messages. output ONLY valid JSON, no markdown.' },
      { role: 'user',   content: `user: ${username}\nmessages:\n${msgs.join('\n')}\n\nJSON: {"personality":"one line vibe","interests":["x"],"vibes":"how they communicate","sentiment":"positive|neutral|negative","nicknames":["any names people call them"]}` },
    ], 0.4, 160);
    const p = JSON.parse(res.replace(/```json|```/g, '').trim());
    await upsertMember(guildId, userId, {
      personality: p.personality || '', interests: p.interests || [],
      vibes: p.vibes || '', sentiment: p.sentiment || 'neutral',
      nicknames: p.nicknames || [], profiledAt: new Date().toISOString(),
    });
    console.log(`[Profiler] ${username} → "${p.personality}"`);
  } catch {}
}

async function deepProfileUser(userId: string, username: string, msgs: string[], guildId: string) {
  if (msgs.length < 2 || !rpmAllow()) return;
  try {
    const ex = await getUserProfile(userId);
    const res = await aiRequest(guildId, DEEP, [
      { role: 'system', content: 'maintain a rolling private profile of a discord user. output ONLY valid JSON, no markdown. be concise.' },
      { role: 'user',   content: `user: ${username}\nexisting context: ${ex.context || '(none)'}\nexisting notes: ${ex.relationshipNotes.slice(-5).join(' | ') || '(none)'}\n\nrecent messages:\n${msgs.join('\n')}\n\nJSON: {"context":"updated 2-3 sentence summary","newNotes":["x"],"newFacts":["x"]}` },
    ], 0.4, 220);
    const p = JSON.parse(res.replace(/```json|```/g, '').trim());
    if (p.context) await upsertUserProfile(userId, { context: p.context, deepProfiledAt: new Date().toISOString(), displayName: username });
    for (const n of (p.newNotes || []).slice(0, 3)) await writeUserFact(userId, n, 'relationshipNotes');
    for (const f of (p.newFacts || []).slice(0, 3)) await writeUserFact(userId, f, 'facts');
  } catch {}
}

const lastCompressedAt = new Map<string, number>();
async function maybeCompressHourly(guildId: string, channelId: string) {
  if (Date.now() - (lastCompressedAt.get(guildId) || 0) < COMPRESS_INTERVAL) return;
  if (!rpmAllow()) return;
  lastCompressedAt.set(guildId, Date.now());
  const msgs = stmGet(channelId);
  if (msgs.length < 10) return;
  try {
    const text = msgs.map(m => `${m.author}: ${m.content}${m.replyTo ? ` (↳ to ${m.replyTo.author}: "${m.replyTo.content.slice(0,40)}")` : ''}`).join('\n');
    const res  = await aiRequest(guildId, DEEP, [
      { role: 'system', content: 'summarize discord chat. extract vibe, facts, inside jokes. ONLY valid JSON.' },
      { role: 'user',   content: `${text}\n\nJSON: {"summary":"brief","groupVibe":"one line","insideJokes":["x"],"facts":["x"]}` },
    ], 0.4, 250);
    const p = JSON.parse(res.replace(/```json|```/g, '').trim());
    for (const f of (p.facts       || []).slice(0, 5)) await writeFact(guildId, f, 'facts');
    for (const j of (p.insideJokes || []).slice(0, 4)) await writeFact(guildId, j, 'insideJokes');
    await db.collection('servers').doc(guildId).collection('notes').doc('hourly')
      .set({ summary: p.summary, groupVibe: p.groupVibe, at: new Date().toISOString() }, { merge: true });
    console.log(`[Compress] "${p.groupVibe}"`);
  } catch {}
}

function startProfilerLoop(client: Client) {
  if (profilerTimer) clearInterval(profilerTimer);
  profilerCycle = 0;
  profilerTimer = setInterval(async () => {
    if (!rpmAllow()) return;
    profilerCycle++;
    const doDeep = profilerCycle % USER_DEEP_PROFILE_EVERY === 0;
    try {
      for (const guild of client.guilds.cache.values()) {
        await upsertServerIdentity(guild);
        for (const ch of guild.channels.cache.filter(c => c.isTextBased()).values()) {
          try {
            const fetched = await (ch as any).messages.fetch({ limit: 20 });
            const msgs    = ([...fetched.values()] as Message[]).reverse();
            seedSTM(ch.id, msgs);
            const byAuthor = new Map<string, string[]>();
            for (const m of msgs) {
              if (m.author.bot || !m.content.trim()) continue;
              cacheId(m.author.id, m.member?.displayName || m.author.username);
              await upsertMember(guild.id, m.author.id, { displayName: m.member?.displayName || m.author.username, username: m.author.username });
              if (!byAuthor.has(m.author.id)) byAuthor.set(m.author.id, []);
              byAuthor.get(m.author.id)!.push(m.content.slice(0, 100));
            }
            for (const [uid, lines] of byAuthor) {
              if (!rpmAllow()) break;
              const name = guild.members.cache.get(uid)?.displayName || uid;
              await profileMember(guild.id, uid, name, lines);
              if (doDeep && rpmAllow()) await deepProfileUser(uid, name, lines, guild.id);
            }
          } catch {}
        }
      }
      memberRosterCache.clear();
      console.log(`[Profiler] cycle ${profilerCycle} | deepUser=${doDeep} | ${groq.available()} daily | ${rpmLeft()} RPM`);
    } catch (e) { console.error('[Profiler]', e); }
  }, PROFILER_INTERVAL);
}

// ═══════════════════════════════════════════════════════════════════
// PROACTIVE HOP LOOP (unchanged from v8.1)
// ═══════════════════════════════════════════════════════════════════

interface ProactiveCandidate { type: 'channel'|'dm'; id: string; guildId: string; label: string; contextHint: string; }

async function gatherProactiveCandidates(client: Client): Promise<ProactiveCandidate[]> {
  const out: ProactiveCandidate[] = [];
  const now = Date.now();
  for (const [channelId, msgs] of stmStore.entries()) {
    if (!msgs.length) continue;
    const last   = msgs[msgs.length - 1];
    const idleMs = now - last.ts;
    if (idleMs < 5 * 60_000 || idleMs > 3 * 60 * 60_000) continue;
    let guildId = 'dm';
    for (const g of client.guilds.cache.values()) if (g.channels.cache.has(channelId)) { guildId = g.id; break; }
    out.push({ type: 'channel', id: channelId, guildId, label: `#${channelId.slice(-6)}`, contextHint: `quiet ${Math.round(idleMs/60_000)}m ago, last: "${last.content.slice(0,60)}"` });
  }
  try {
    const snap = await db.collection('users').get();
    for (const doc of snap.docs) {
      const p = (await doc.ref.collection('profile').doc('main').get()).data() as UserProfile | undefined;
      if (!p?.dmChannelId) continue;
      if ((p.lastProactiveAt || 0) > now - PROACTIVE_MIN_GAP_USER) continue;
      const invite = p.relationshipNotes?.find(n => /dm|hop on|come (here|over)|lemme tell|wanna (talk|tell)|hit (me|u) up/i.test(n));
      if (!invite && !p.context) continue;
      out.push({ type: 'dm', id: doc.id, guildId: 'dm', label: p.displayName || doc.id.slice(-6), contextHint: invite ? `they said: "${invite}"` : `context: ${p.context?.slice(0,80)}` });
    }
  } catch {}
  return out;
}

async function runProactiveCycle(client: Client) {
  if (!rpmAllow()) return;
  const candidates = await gatherProactiveCandidates(client);
  if (!candidates.length) { console.log('[Proactive] no candidates'); return; }
  const sample = candidates.slice(0, 12);
  const listText = sample.map((c, i) => `${i}. [${c.type}] ${c.label} — ${c.contextHint}`).join('\n');
  try {
    const raw = await aiRequest(sample[0]?.guildId || 'dm', DEEP, [
      { role: 'system', content: `you are ${BOT_NAME}, chaotic gen-z discord persona. FULL LIBERTY to say nothing (most common — pick "none") or send ONE message if genuinely warranted. be very conservative, never needy, never force it.` },
      { role: 'user',   content: `candidates:\n${listText}\n\nJSON: {"pick":"none|<index>","message":"raw msg if picking","reason":"one line"}` },
    ], 0.9, 150);
    const p = JSON.parse(raw.replace(/```json|```/g, '').trim());
    if (p.pick === 'none' || p.pick == null) return;
    const idx = parseInt(String(p.pick), 10);
    if (isNaN(idx) || idx < 0 || idx >= sample.length) return;
    const target = sample[idx];
    const text   = (p.message || '').trim().replace(/^["']|["']$/g, '').slice(0, 200);
    if (!text) return;
    if (target.type === 'channel') {
      const ch = client.channels.cache.get(target.id) as TextChannel | undefined;
      if (!ch?.isTextBased()) return;
      await (ch as any).sendTyping().catch(() => {});
      await sleep(Math.min(400 + text.length * 22, 3000));
      await (ch as any).send(text);
      stmPush(target.id, { ts: Date.now(), authorId: BOT_ID, author: '[me]', content: text });
    } else {
      const user = await client.users.fetch(target.id).catch(() => null);
      if (!user) return;
      const dm = await user.createDM().catch(() => null);
      if (!dm) return;
      await dm.sendTyping().catch(() => {});
      await sleep(Math.min(400 + text.length * 22, 3000));
      await dm.send(text);
      stmPush(dm.id, { ts: Date.now(), authorId: BOT_ID, author: '[me]', content: text });
      await upsertUserProfile(target.id, { lastProactiveAt: Date.now() });
    }
    console.log(`[Proactive→${target.type}] ${target.label}: "${text.slice(0,60)}"`);
  } catch (e) { console.warn('[Proactive]', (e as any).message?.slice(0,80)); }
}

function scheduleProactiveCycle(client: Client) {
  const jitter = Math.floor((Math.random() * 2 - 1) * PROACTIVE_JITTER);
  const delay  = Math.max(60_000, PROACTIVE_BASE_INTERVAL + jitter);
  proactiveTimer = setTimeout(async () => {
    try { await runProactiveCycle(client); } catch {}
    scheduleProactiveCycle(client);
  }, delay);
  console.log(`[Proactive] next in ${Math.round(delay / 60_000)}m`);
}

// ═══════════════════════════════════════════════════════════════════
// MAIN MESSAGE HANDLER — v10
//
// Key changes from v9:
//   DEBOUNCE is now 4500ms and resets on every incoming message.
//   The bot waits for a 4.5s lull in the conversation before the brain
//   fires — collecting the whole burst of messages into STM first,
//   then reading them all at once. This eliminates the rapid-fire
//   reply-to-every-message spam.
//
//   Velocity check: if the channel is receiving >5 msgs in 10s and the
//   bot wasn't mentioned, there's an 80% chance we skip silently. The
//   bot only barges into a fast conversation if it has something real.
//
//   The latest message in each batch becomes the "trigger" for brain
//   context (senderName, bond, message shown to AI). The full burst
//   is already in STM so the AI sees all of it in the transcript.
// ═══════════════════════════════════════════════════════════════════

// Per-channel: track the most recent pending trigger message for the debounce batch.
// When a rapid burst comes in, each new message updates this so the brain always
// responds to the *latest* message in the batch, not a stale earlier one.
const pendingTriggers = new Map<string, {
  msg:      Message;
  sender:   string;
  msgClean: string;
  mentioned: boolean;
  isDM:     boolean;
  guildId:  string;
  autoActiveReason?: string;
  mood:     MoodState;
}>();

// ── Double-text follow-up ─────────────────────────────────────────────────────
// Real people sometimes fire off a quick afterthought a beat after their first
// message. The brain can request this via decision.followUp = {text, delaySec}.
// We re-check speak state before sending in case something changed (e.g. an
// admin paused the bot, or the conversation moved on hard) — but we deliberately
// don't re-run the whole brain for this, it's meant to feel like a reflex, not
// a fresh decision.
function scheduleFollowUp(
  trigMsg:   Message,
  channelId: string,
  guildId:   string,
  followUp?: BrainDecision['followUp'],
) {
  if (!followUp?.text) return;
  const text = followUp.text.trim().replace(/^["']|["']$/g, '').split('\n')[0].slice(0, 200);
  if (!text) return;

  setTimeout(async () => {
    try {
      const speakState = await getSpeakState(channelId, guildId);
      if (speakState.mode === 'paused' && speakState.resumeAt && Date.now() < speakState.resumeAt) return;

      const typingMs = Math.min(400 + text.length * 22, 3000);
      try { await trigMsg.channel.sendTyping(); } catch {}
      await sleep(typingMs);

      await (trigMsg.channel as TextChannel).send(text);
      stmPush(channelId, { ts: Date.now(), authorId: BOT_ID, author: '[me]', content: text });
      console.log(`[FollowUp] "${text.slice(0,60)}"`);
    } catch (e) { console.warn('[FollowUp]', (e as any).message?.slice(0, 80)); }
  }, followUp.delaySec * 1000);
}

async function handleMessage(msg: Message) {
  if (msg.author.bot || !msg.content?.trim()) return;
  try {
    const isDM    = msg.channel.isDMBased();
    const isGuild = !isDM && !!msg.guildId;
    if (!isDM && !isGuild) return;

    const guildId   = isGuild ? msg.guildId! : 'dm';
    const channelId = msg.channelId;
    const mentioned = isDM ? true : (BOT_ID ? msg.mentions.has(BOT_ID) : false);
    const sender    = msg.member?.displayName || msg.author.username;
    const msgClean  = cleanContent(msg.content);

    cacheId(msg.author.id, sender);

    if (isDM) await upsertUserProfile(msg.author.id, { dmChannelId: channelId, lastDM: Date.now(), displayName: sender });
    else       await upsertUserProfile(msg.author.id, { lastSeenChannelId: channelId, lastSeenGuildId: guildId, displayName: sender });

    // Reply chain context
    let replyRef: STMessage['replyTo'] | undefined;
    if (msg.reference?.messageId) {
      try {
        const ref = await msg.channel.messages.fetch(msg.reference.messageId);
        replyRef  = {
          author:  ref.author.id === BOT_ID ? '[me]' : (ref.member?.displayName || ref.author.username),
          content: cleanContent(ref.content).slice(0, 100),
        };
      } catch {}
    }

    // Push to STM immediately — every message in the burst lands here
    // before the brain fires, so the transcript is always complete.
    stmPush(channelId, {
      ts:       msg.createdTimestamp,
      authorId: msg.author.id,
      author:   msg.author.id === BOT_ID ? '[me]' : sender,
      content:  msgClean.slice(0, 120),
      replyTo:  replyRef,
    });

    // ── Mood gate ──────────────────────────────────────────────────────
    const { fire, mood, autoActiveReason } = await shouldFireBrain(
      channelId, guildId, msgClean, msg.author.id, mentioned, isDM
    );

    if (!fire) return;

    // ── Velocity gate (non-mention passive) ────────────────────────────
    // isHighVelocity already accounts for mentions internally (returns false if mentioned)
    // shouldFireBrain already checked RPM, so we only need velocity here
    // Note: active-mode messages don't go through shouldFireBrain's passive path,
    // but we still want to be careful — check velocity for active mode too unless mentioned
    if (!mentioned && isHighVelocity(channelId, mentioned)) return;

    // ── Debounce: every new qualifying message resets the timer ────────
    // This is the "batch collection" mechanic: the brain fires only after
    // the conversation goes quiet for DEBOUNCE_MS. The latest message
    // in the burst wins and becomes the trigger context for the brain.
    if (debounceTimers.has(channelId)) clearTimeout(debounceTimers.get(channelId)!);

    // Store the most recent trigger so the debounce closure always has fresh context
    pendingTriggers.set(channelId, { msg, sender, msgClean, mentioned, isDM, guildId, autoActiveReason, mood });

    // Mentions still get a fast lane — short debounce so direct replies feel snappy
    const debounceMs = mentioned ? 400 : DEBOUNCE_MS;

    const timer = setTimeout(async () => {
      debounceTimers.delete(channelId);

      // Read the trigger that was set when this timer was last reset
      const trigger = pendingTriggers.get(channelId);
      pendingTriggers.delete(channelId);
      if (!trigger) return;

      const { msg: trigMsg, sender: trigSender, msgClean: trigClean,
              mentioned: trigMentioned, isDM: trigIsDM, guildId: trigGuildId,
              autoActiveReason: trigAutoReason, mood: trigMood } = trigger;
      const trigChannelId = trigMsg.channelId;
      const trigIsGuild   = !trigIsDM && !!trigMsg.guildId;

      try {
        const speakState = await getSpeakState(trigChannelId, trigGuildId);

        // Paused + not mentioned → skip
        if (speakState.mode === 'paused' && speakState.resumeAt && Date.now() < speakState.resumeAt && !trigMentioned) {
          console.log(`[Paused] ${Math.round((speakState.resumeAt - Date.now()) / 1000)}s left`);
          return;
        }

        if (!stmStore.has(trigChannelId)) {
          const fetched = await trigMsg.channel.messages.fetch({ limit: MAX_FETCH_HISTORY });
          seedSTM(trigChannelId, ([...fetched.values()] as Message[]).reverse());
        }

        const [memberData, memory, allMembers, userProfile] = await Promise.all([
          trigIsGuild ? getMember(trigGuildId, trigMsg.author.id) : Promise.resolve({}),
          trigIsGuild ? getMemory(trigGuildId)                    : Promise.resolve({ facts: [], corrections: [], insideJokes: [] } as GlobalMemory),
          trigIsGuild ? getAllMembers(trigGuildId)                 : Promise.resolve([]),
          getUserProfile(trigMsg.author.id),
        ]);

        const bond    = typeof memberData.bond === 'number' ? memberData.bond : 50;
        const profile = [memberData.personality, memberData.vibes].filter(Boolean).join(' | ');
        const msgs    = stmGet(trigChannelId);
        const clock   = clockContext(msgs, speakState, trigMood);

        const decision = await brain(
          trigGuildId, trigSender, profile, bond,
          trigClean, stmFormat(msgs, Date.now()),
          memToPrompt(memory, allMembers),
          userProfileToPrompt(userProfile),
          clock, trigMentioned, speakState, trigMood, trigIsDM,
          trigAutoReason,
        );

        const activeBackend = await getBackend(trigGuildId);
        console.log(`[Brain:${activeBackend.toUpperCase()}][${trigMood.mode}] ${trigSender}${trigIsDM?' (DM)':''}: ${decision.action} | mood→${decision.moodSwitch ?? 'same'} | "${decision.reason}"`);

        // Apply mood switch from brain (before handling action)
        await applyMoodSwitch(trigChannelId, trigGuildId, decision, trigMood);

        // ── Reaction can accompany ANY action ───────────────────────────
        if (decision.reaction) {
          try { await trigMsg.react(decision.reaction); }
          catch (e) { console.warn('[React]', (e as any).message?.slice(0, 80)); }
        }

        // ── Handle action ────────────────────────────────────────────
        switch (decision.action) {

          case 'speak': {
            const bubbles = (decision.reply || [])
              .map(b => b.trim()
                .replace(/^["']|["']$/g, '')
                .replace(new RegExp(`^${BOT_NAME}:\\s*`, 'i'), '')
                .split('\n')[0]
                .slice(0, 200))
              .filter(Boolean);

            if (!bubbles.length) { console.log('[Brain] speak→empty'); break; }

            try {
              for (let i = 0; i < bubbles.length; i++) {
                const text = bubbles[i];
                const typingMs = Math.min(400 + text.length * 22, 3000);
                try { await trigMsg.channel.sendTyping(); } catch {}
                await sleep(typingMs);

                if (i === 0) {
                  // First bubble replies to the trigger message, preserving the reply chain.
                  await trigMsg.reply({ content: text, allowedMentions: { repliedUser: false } });
                } else {
                  // Follow-on bubbles are sent as plain messages — like sending
                  // a second text right after the first, no reply arrow needed.
                  await (trigMsg.channel as TextChannel).send(text);
                  await sleep(250 + Math.random() * 400); // small natural gap between bubbles
                }
                stmPush(trigChannelId, { ts: Date.now(), authorId: BOT_ID, author: '[me]', content: text });
                console.log(`[→${trigSender}] "${text.slice(0,60)}"`);
              }

              if (trigIsGuild) {
                if (decision.bondDelta) await updateBond(trigGuildId, trigMsg.author.id, decision.bondDelta);
                if (decision.newFact)   await writeFact(trigGuildId, decision.newFact, 'facts');
              }
              if (decision.userFact) await writeUserFact(trigMsg.author.id, decision.userFact, 'facts');
              if (decision.userNote) await writeUserFact(trigMsg.author.id, decision.userNote, 'relationshipNotes');
              if (speakState.mode !== 'active') await setSpeakState(trigChannelId, trigGuildId, { mode: 'active', reason: 'spoke → reset' });

              scheduleFollowUp(trigMsg, trigChannelId, trigGuildId, decision.followUp);
            } catch (e) { console.error('[Send]', e); }
            break;
          }

          case 'react': {
            // No text — just the reaction above. Still a real "response":
            // log + count as light engagement without resetting speak state
            // or counting toward the "haven't spoken recently" recency check.
            console.log(`[→${trigSender}] reaction only: ${decision.reaction || '(none)'}`);
            if (trigIsGuild && decision.newFact) await writeFact(trigGuildId, decision.newFact, 'facts');
            if (decision.userFact) await writeUserFact(trigMsg.author.id, decision.userFact, 'facts');
            if (decision.userNote) await writeUserFact(trigMsg.author.id, decision.userNote, 'relationshipNotes');
            break;
          }

          case 'pause': {
            const mins = Math.max(1, Math.min(60, decision.pauseMins || 5));
            await setSpeakState(trigChannelId, trigGuildId, { mode: 'paused', resumeAt: Date.now() + mins * 60_000, reason: decision.reason });
            if (trigIsGuild && decision.newFact) await writeFact(trigGuildId, decision.newFact, 'corrections');
            if (decision.userNote) await writeUserFact(trigMsg.author.id, decision.userNote, 'relationshipNotes');
            break;
          }

          case 'wait': {
            await setSpeakState(trigChannelId, trigGuildId, { mode: 'waiting', reason: decision.reason });
            if (trigIsGuild && decision.newFact) await writeFact(trigGuildId, decision.newFact, 'corrections');
            if (decision.userNote) await writeUserFact(trigMsg.author.id, decision.userNote, 'relationshipNotes');
            break;
          }

          default:
            if (trigIsGuild && decision.newFact) writeFact(trigGuildId, decision.newFact, 'facts').catch(() => {});
            if (decision.userFact) writeUserFact(trigMsg.author.id, decision.userFact, 'facts').catch(() => {});
            if (decision.userNote) writeUserFact(trigMsg.author.id, decision.userNote, 'relationshipNotes').catch(() => {});
        }

        if (trigIsGuild) maybeCompressHourly(trigGuildId, trigChannelId).catch(() => {});

      } catch (e) { console.error('[Handler] process error:', e); }
    }, debounceMs);

    debounceTimers.set(channelId, timer);
  } catch (e) { console.error('[Handler]', e); }
}

// ═══════════════════════════════════════════════════════════════════
// STARTUP
// ═══════════════════════════════════════════════════════════════════

export async function startBot(token: string) {
  if (botClient) return;

  botClient = new Client({
    intents: [
      GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMembers,
    ],
    partials: [Partials.Message, Partials.Channel],
  });

  botClient.on(Events.ClientReady, async () => {
    BOT_NAME = botClient!.user!.username;
    BOT_ID   = botClient!.user!.id;
    cacheId(BOT_ID, BOT_NAME);

    console.log(`
╔═══════════════════════════════════════════════╗
║  ✓ ${BOT_NAME} online — v12 Human Layer
║  • ID: ${BOT_ID}
║  • Fast: ${FAST}
║  • Deep: ${DEEP}
║  • HF Space: ${HF_BASE_URL || '(not set)'}
║  • Keys: ${groq.allStats().length} | Avail: ${groq.available()} daily | RPM cap: ${RPM_CAP}
║  • Debounce: ${DEBOUNCE_MS}ms lull | Velocity: >${VELOCITY_HIGH_THRESH} msgs/${VELOCITY_WINDOW_MS/1000}s → ${Math.round(VELOCITY_SKIP_CHANCE*100)}% skip
║  • Active mode: ${ACTIVE_MIN_MINS}-${ACTIVE_MAX_MINS}min | Passive: every ${PASSIVE_MIN_EVERY}-${PASSIVE_MAX_EVERY} msgs
║  • API penalties: freq=1.2 presence=0.8 | maxTok brain=320
║  • Actions: speak (1-3 bubbles) / react (emoji) / pause / wait / ignore + double-text follow-ups
║  • STM gaps: ≥${STM_GAP_MAJOR_MS/60_000}m = session break | ≥${STM_GAP_MINOR_MS/60_000}m = minor gap
║  • Monopoly guard: ping-others detection active
║  • Proactive: every ~${Math.round(PROACTIVE_BASE_INTERVAL/60_000)}m ± ${Math.round(PROACTIVE_JITTER/60_000)}m
╚═══════════════════════════════════════════════╝\n`);

    botClient!.user!.setPresence({ status: 'online', activities: [{ name: 'the vibes', type: 3 }] });

    for (const g of botClient!.guilds.cache.values()) {
      await upsertServerIdentity(g);
      const members = await g.members.fetch().catch(() => null);
      if (members) {
        for (const [uid, m] of members) {
          if (m.user.bot) continue;
          cacheId(uid, m.displayName);
          await upsertMember(g.id, uid, { displayName: m.displayName, username: m.user.username });
        }
        console.log(`[Boot] synced ${members.size} members for "${g.name}"`);
      }
    }

    startProfilerLoop(botClient!);
    scheduleProactiveCycle(botClient!);
  });

  botClient.on(Events.MessageCreate, handleMessage);

  botClient.on(Events.GuildMemberAdd, async (m) => {
    if (m.user.bot) return;
    cacheId(m.id, m.displayName);
    await upsertMember(m.guild.id, m.id, { displayName: m.displayName, username: m.user.username, joinedAt: new Date().toISOString() });
  });

  botClient.on(Events.GuildMemberUpdate, async (_, m) => {
    if (m.user.bot) return;
    cacheId(m.id, m.displayName);
    await upsertMember(m.guild.id, m.id, { displayName: m.displayName, username: m.user.username });
  });

  // ── Admin commands ─────────────────────────────────────────────────────────
  botClient.on(Events.MessageCreate, async (msg) => {
    if (!msg.member?.permissions.has('Administrator') && !msg.member?.permissions.has('ManageMessages')) return;
    const c = msg.content.trim();

    // Backend
    if (c === '!hf' && msg.guildId) {
      if (!HF_BASE_URL) { await msg.reply('`HF_SPACE_BASE_URL` not set'); return; }
      await setBackend(msg.guildId, 'hf');
      await msg.reply(`switched to HF Spaces\nSpace: \`${HF_BASE_URL}\`\nModel: \`${HF_MODEL}\``);
    }
    if (c === '!groqmode' && msg.guildId) {
      await setBackend(msg.guildId, 'groq');
      await msg.reply(`switched back to Groq (${FAST} / ${DEEP})`);
    }
    if (c === '!backend' && msg.guildId) {
      const b = await getBackend(msg.guildId);
      await msg.reply(b === 'hf'
        ? `backend: HF Spaces 🤗 | URL: \`${HF_BASE_URL}\` | model: \`${HF_MODEL}\``
        : `backend: Groq ⚡ | fast: \`${FAST}\` | deep: \`${DEEP}\` | ${groq.available()} daily | ${rpmLeft()} RPM`
      );
    }

    // Mood
    if (c === '!mood' && msg.guildId) {
      const m = await getMoodState(msg.channelId, msg.guildId);
      const info = m.mode === 'active' && m.activeUntil
        ? `active — expires ${new Date(m.activeUntil).toLocaleTimeString()} (${Math.round((m.activeUntil - Date.now())/60_000)}m left)`
        : `passive — brain every ${m.passiveEvery} msgs (counter: ${m.passiveCount})`;
      await msg.reply(`mood: **${info}**\nreason: ${m.reason}`);
    }
    if (c.startsWith('!active') && msg.guildId) {
      const mins = parseInt(c.split(' ')[1] || '') || ACTIVE_DEFAULT_MINS;
      await setMoodState(msg.channelId, msg.guildId, {
        mode: 'active', activeUntil: Date.now() + mins * 60_000,
        reason: 'admin active', passiveCount: 0,
      });
      await msg.reply(`active for ${mins}m`);
    }
    if (c.startsWith('!passive') && msg.guildId) {
      const every = parseInt(c.split(' ')[1] || '') || PASSIVE_DEFAULT_EVERY;
      await setMoodState(msg.channelId, msg.guildId, {
        mode: 'passive', activeUntil: undefined,
        passiveEvery: Math.max(PASSIVE_MIN_EVERY, Math.min(PASSIVE_MAX_EVERY, every)),
        passiveCount: 0, reason: 'admin passive',
      });
      await msg.reply(`passive — brain every ${every} msgs`);
    }

    // Speak state
    if (c === '!state' && msg.guildId) {
      const s = await getSpeakState(msg.channelId, msg.guildId);
      await msg.reply(`speak: **${s.mode}**${s.resumeAt ? ` <t:${Math.round(s.resumeAt/1000)}:R>` : ''}\n${s.reason}`);
    }
    if (c === '!wake' && msg.guildId)  { await setSpeakState(msg.channelId, msg.guildId, { mode: 'active', reason: 'admin' }); await msg.reply('im up'); }
    if (c === '!sleep' && msg.guildId) { await setSpeakState(msg.channelId, msg.guildId, { mode: 'waiting', reason: 'admin' }); await msg.reply('aight going quiet'); }
    if (c.startsWith('!pause ') && msg.guildId) {
      const mins = parseInt(c.split(' ')[1]) || 10;
      await setSpeakState(msg.channelId, msg.guildId, { mode: 'paused', resumeAt: Date.now() + mins * 60_000, reason: 'admin' });
      await msg.reply(`paused ${mins}m`);
    }

    // Memory
    if (c === '!memory' && msg.guildId) {
      const m = await getMemory(msg.guildId);
      await msg.reply([
        `**facts(${m.facts.length}):** ${m.facts.slice(-5).join(' | ') || 'none'}`,
        `**corrections(${m.corrections.length}):** ${m.corrections.slice(-5).join(' | ') || 'none'}`,
        `**jokes(${m.insideJokes.length}):** ${m.insideJokes.slice(-5).join(' | ') || 'none'}`,
      ].join('\n'));
    }
    if (c.startsWith('!remember ') && msg.guildId) { await writeFact(msg.guildId, c.slice(10).trim(), 'facts'); await msg.reply('noted'); }
    if (c.startsWith('!forget ') && msg.guildId) {
      const b = c.slice(8).trim() as keyof GlobalMemory;
      if (['facts','corrections','insideJokes'].includes(b)) {
        await db.collection('servers').doc(msg.guildId).collection('memory').doc('global').set({ [b]: [] }, { merge: true });
        memCache.delete(msg.guildId); await msg.reply(`cleared ${b}`);
      }
    }

    // Debug
    if (c === '!groq') {
      const lines = groq.allStats().map(s => `...${s.key.slice(-6)}: ${s.requestsToday}req ${s.errorsToday}err ${s.isHealthy?'✓':'✗'}${s.cooldownUntil&&Date.now()<s.cooldownUntil?` cd:${Math.ceil((s.cooldownUntil-Date.now())/1000)}s`:''}`);
      await msg.reply(`\`\`\`\n${lines.join('\n')}\navail: ${groq.available()} | rpm: ${rpmLeft()}/${RPM_CAP}\n\`\`\``);
    }
    if (c === '!stm') {
      const out = stmFormat(stmGet(msg.channelId), Date.now());
      for (const chunk of (out.match(/.{1,1900}/gs)||[]).slice(0,3)) await msg.reply(`\`\`\`\n${chunk}\n\`\`\``);
    }
    if (c.startsWith('!userprofile') && msg.guildId) {
      const uid = msg.mentions.users.first()?.id || c.split(' ')[1]?.trim();
      if (!uid) { await msg.reply('usage: !userprofile @user'); return; }
      const p = await getUserProfile(uid);
      await msg.reply([
        `**${p.displayName || uid}**`,
        `context: ${p.context || '(none)'}`,
        `facts(${p.facts.length}): ${p.facts.slice(-4).join(' | ') || 'none'}`,
        `notes(${p.relationshipNotes.length}): ${p.relationshipNotes.slice(-4).join(' | ') || 'none'}`,
      ].join('\n'));
    }
    if (c === '!proactive') { await msg.reply('running...'); await runProactiveCycle(botClient!); await msg.reply('done'); }
  });

  await botClient.login(token);
}

export function stopBot() {
  botClient?.destroy(); botClient = null;
  if (profilerTimer)  clearInterval(profilerTimer);
  if (proactiveTimer) clearTimeout(proactiveTimer);
}

export function getBotStatus() { return botClient ? 'running' : 'stopped'; }
