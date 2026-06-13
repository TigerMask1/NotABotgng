/**
 * NOTABOT — v9 "Mood System"
 *
 * Built ON TOP of v8.1. Nothing removed. Additions:
 *
 * MOOD SYSTEM (replaces static BRAIN_EVERY_N counter):
 *   Per-channel MoodState: active | passive
 *
 *   ACTIVE mode:
 *   - Brain fires on every message (full attention)
 *   - Has a duration (AI-set, 5-15 min). Auto-reverts to passive after.
 *   - Bot walks in/out naturally, knows when to exit
 *
 *   PASSIVE mode:
 *   - Brain fires every N msgs (N is AI-set per channel, default 5)
 *   - Each passive brain call also evaluates: should i switch to active?
 *   - AI returns moodSwitch + activeDurationMins in its decision
 *
 *   AUTO-ACTIVE triggers (no LLM cost — observable signals):
 *   1. Direct @mention or "notabot" text in message
 *   2. Significant idle gap (>GAP_THRESHOLD_MS) since last message → new session
 *   3. Bot monopoly: last N messages all unanswered by others (likely 1:1 intent)
 *   4. DMs always active
 *
 *   AUTO-PASSIVE triggers:
 *   - Brain returns action=pause or action=wait → mood goes passive on resume
 *   - Active timer expires
 *
 * Everything from v8.1 preserved: multi-key Groq, HF backend switcher, RPM guard,
 * speak states, STM, reply chains, ID resolution, server memory, per-user memory,
 * proactive hop loop, hourly compression, all admin commands.
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

// ── Alias Registry ─────────────────────────────────────────────────────────────
// Maps a nickname/alias → { userId, displayName } so the AI knows "Coral" = "Arisu (ID: ...)"
// Populated from Firebase member.nicknames arrays at boot and after profiler runs.
// Can be updated at runtime via !alias command.
interface AliasEntry { userId: string; displayName: string; }
const nicknameMap = new Map<string, AliasEntry>(); // key: lowercase alias

function registerAlias(alias: string, userId: string, displayName: string) {
  if (!alias?.trim()) return;
  const key = alias.trim().toLowerCase();
  nicknameMap.set(key, { userId, displayName });
}

/** Scans message text for known aliases and prepends context hints like:
 *  [Context: "Coral" = Arisu (User ID: 12345)]
 *  so the AI doesn't hallucinate a stranger relationship.
 */
function injectAliasHints(text: string): string {
  const hints: string[] = [];
  for (const [alias, entry] of nicknameMap.entries()) {
    // whole-word match, case-insensitive
    const re = new RegExp(`\\b${alias}\\b`, 'i');
    if (re.test(text)) {
      hints.push(`"${alias}" = ${entry.displayName} (User ID: ${entry.userId})`);
    }
  }
  if (!hints.length) return text;
  return `[Context: ${hints.join('; ')}]\n${text}`;
}

// ── Told-Off Flag ──────────────────────────────────────────────────────────────
// If a user explicitly tells the bot off ("not for you", "not talking to you", etc.)
// the bot hard-codes ignore for that user+channel for 10 minutes.
const TOLD_OFF_MS = 10 * 60_000;
// key: `${channelId}:${userId}`, value: expiry epoch ms
const toldOffUntil = new Map<string, number>();

const TOLD_OFF_PATTERNS = [
  /\bnot (for|talking to|meant for|directed at) (you|u)\b/i,
  /\bnot your (business|concern|conversation|convo)\b/i,
  /\bstay out\b/i,
  /\bshut (up|it)\b/i,
  /\bno one (asked|was talking to) you\b/i,
  /\bstop (interrupting|jumping in)\b/i,
  /\bback off\b/i,
];

function checkToldOff(channelId: string, userId: string, content: string): boolean {
  const isToldOff = TOLD_OFF_PATTERNS.some(re => re.test(content));
  if (isToldOff) {
    const key    = `${channelId}:${userId}`;
    const expiry = Date.now() + TOLD_OFF_MS;
    toldOffUntil.set(key, expiry);
    console.log(`[ToldOff] ${userId.slice(-6)} in #${channelId.slice(-6)} → ignore for ${TOLD_OFF_MS/60_000}m`);
  }
  return isToldOff;
}

function isToldOffActive(channelId: string, userId: string): boolean {
  const key    = `${channelId}:${userId}`;
  const expiry = toldOffUntil.get(key);
  if (!expiry) return false;
  if (Date.now() >= expiry) { toldOffUntil.delete(key); return false; }
  return true;
}

// ── Pending Question Tracker ───────────────────────────────────────────────────
// When the bot asks a question (reply ends with '?'), we record the channel + target
// user so the next message from that user in that channel is treated as a direct
// response even without a @mention. Clears after 5 minutes (question expires).
const PENDING_QUESTION_TTL = 5 * 60_000;
interface PendingQuestion { targetUserId: string; expiresAt: number; }
const pendingQuestions = new Map<string, PendingQuestion>(); // key: channelId

function setPendingQuestion(channelId: string, targetUserId: string) {
  pendingQuestions.set(channelId, { targetUserId, expiresAt: Date.now() + PENDING_QUESTION_TTL });
  console.log(`[PendingQ] #${channelId.slice(-6)} waiting for answer from ${targetUserId.slice(-6)}`);
}

/** Returns true (and clears) if this author is answering our pending question. */
function consumePendingQuestion(channelId: string, authorId: string): boolean {
  const pq = pendingQuestions.get(channelId);
  if (!pq) return false;
  if (Date.now() >= pq.expiresAt) { pendingQuestions.delete(channelId); return false; }
  if (pq.targetUserId !== authorId) return false;
  pendingQuestions.delete(channelId);
  console.log(`[PendingQ] #${channelId.slice(-6)} answered by ${authorId.slice(-6)}`);
  return true;
}

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
  internal_thought:   string;   // maps social geometry before generating reply — breaks catchphrase loops
  action:             'speak' | 'pause' | 'wait' | 'ignore';
  reply?:             string;
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

  const system = `you are ${BOT_NAME} — a real person on discord, not an AI or assistant. you have your own personality, moods, and opinions. you are NOT a helper.

━━━ YOUR BASELINE PERSONA ━━━
gen z. your humor is dry, observational, sometimes absurd. you care about people but show it through banter and showing up when it counts — not through nice words. you have moods. sometimes you're quiet. you don't always reply. you're not performing — you're just existing in a server.

your voice: lowercase, short, natural. no slang checklist — just talk the way you actually would. a single word or emoji is often better than a sentence. you never explain your jokes. you never announce what you're doing.

NEVER say: "certainly", "as an ai", "great question", "happy to help", or anything that sounds like a customer service rep.
NEVER repeat a phrase you just used. NEVER start the same way twice in a row.

━━━ STEP 1 — INTERNAL MONOLOGUE (MANDATORY, DO THIS FIRST) ━━━
Before you generate a reply or pick an action, you MUST analyze the conversation in "internal_thought".
Be genuinely analytical — this is not a template to fill in, it is actual reasoning.

Answer these questions in your thought, in order:
1. TIMESTAMPS: Look at the time labels in <recent_chat>. Are there session breaks (marked with ━━━ separators)? If yes, the earlier messages are a DIFFERENT CONVERSATION — do not let them influence your reply to the current one.
2. ADDRESSING: Who is the current speaker actually talking to? Look for @mentions or reply chains. If they are @mentioning or replying to someone who is NOT you, they are not talking to you.
3. RELEVANCE: Does this message concern you at all? If someone is ranting at another user, tagging a role, or clearly in their own convo, the correct action is "ignore". Do not interrupt.
4. GEOMETRY: If the message IS relevant to you — what's the social dynamic? Group roast? 1:1? Ongoing bit? What would land, and what would be cringe?
5. RECENCY: Have you spoken recently? If [me] appears in the last 2-3 messages, jumping back in will feel desperate unless you have something real.

If your thought concludes the message isn't for you → action must be "ignore" or "wait".
Only set action="speak" if you are genuinely being addressed OR you have something that would actually land.

━━━ READING THE TRANSCRIPT ━━━
[me] = your own past messages. don't repeat yourself.
↳ replying to X: "..." = shows the reply chain — who is talking to who.
━━━ SESSION BREAKS ━━━ in the transcript = significant time gap. treat each section as a separate conversation.
Timestamps: messages marked with real clock times (e.g. 10:21 AM) are old. "5s ago" is now. don't merge them.

${isDM ? `━━━ DM MODE ━━━\n1:1 conversation. more direct. reference actual shared history. still short.` : ''}

━━━ SPEAK STATE ━━━
speak  → put your raw reply in "reply". lowercase. no quotes. no name prefix. 1-2 sentences max. often shorter.
pause  → go quiet for X mins. use when you were explicitly told to stop or you clearly interrupted.
wait   → silent until naturally called or an obvious opening. less permanent than pause.
ignore → skip this message, stay alert for the next one.

━━━ MOOD CONTROL ━━━
active  → full attention mode. you process every message. use when they're clearly talking TO you.
          set activeDurationMins (5-15).
passive → hands-off. you check in occasionally. use when the convo isn't yours.
          set passiveEvery (2-10 msgs).
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

directly addressing you: ${mentioned ? 'YES — strong signal to reply, but still check if the message makes sense as addressed to you' : 'NO — check internal_thought carefully before speaking'}${autoActiveReason ? `\nauto-active reason: ${autoActiveReason}` : ''}
current mood: ${mood.mode}${mood.activeUntil ? ` (${Math.round((mood.activeUntil - Date.now()) / 60_000)}m left)` : ''}

Output ONLY valid JSON. No markdown, no preamble, no trailing text. Schema is strict:
{"internal_thought":"<your mandatory analysis: timestamps/session breaks, who they're actually addressing, whether this concerns you, social geometry, recency of your own messages>","action":"speak|pause|wait|ignore","reply":"<raw reply if action=speak — lowercase, no name prefix, no quotes — else empty string>","pauseMins":5,"bondDelta":0,"newFact":"","userFact":"","userNote":"","moodSwitch":"active|passive|null","activeDurationMins":${ACTIVE_DEFAULT_MINS},"passiveEvery":${PASSIVE_DEFAULT_EVERY},"reason":"<one line — why you picked this action>"}`;

  try {
    // frequency_penalty 1.2: hard penalty on tokens already used in this completion → kills catchphrase loops
    // presence_penalty  0.8: discourages any token seen in context → pushes vocabulary variety
    // maxTok 250: prevents mid-word cutoffs on slightly longer replies
    const raw = await aiRequest(
      guildId, FAST,
      [{ role: 'system', content: system }, { role: 'user', content: user }],
      0.88, 250,
      1.2,  // frequencyPenalty (bumped from 1.1 → 1.2 for stricter loop-breaking)
      0.8,  // presencePenalty
    );
    const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());

    if (mentioned && parsed.action !== 'speak') parsed.action = 'speak';

    // Log the internal thought so you can see the reasoning in console
    if (parsed.internal_thought) {
      console.log(`[Brain:thought] ${parsed.internal_thought.slice(0, 100)}`);
    }

    // Clamp mood values
    if (parsed.activeDurationMins) parsed.activeDurationMins = Math.max(ACTIVE_MIN_MINS, Math.min(ACTIVE_MAX_MINS, parsed.activeDurationMins));
    if (parsed.passiveEvery)       parsed.passiveEvery       = Math.max(PASSIVE_MIN_EVERY, Math.min(PASSIVE_MAX_EVERY, parsed.passiveEvery));

    return {
      internal_thought:   parsed.internal_thought    || '',
      action:             parsed.action              || 'ignore',
      reply:              parsed.reply               || '',
      pauseMins:          parsed.pauseMins           || 5,
      bondDelta:          parsed.bondDelta           || 0,
      newFact:            parsed.newFact             || '',
      userFact:           parsed.userFact            || '',
      userNote:           parsed.userNote            || '',
      reason:             parsed.reason              || '?',
      moodSwitch:         parsed.moodSwitch === 'null' ? null : (parsed.moodSwitch || null),
      activeDurationMins: parsed.activeDurationMins  || ACTIVE_DEFAULT_MINS,
      passiveEvery:       parsed.passiveEvery        || PASSIVE_DEFAULT_EVERY,
    };
  } catch (e: any) {
    // NEVER fire an error message to chat — log raw string and silently ignore.
    // If the AI returned a truncated/invalid JSON, spamming the channel is worse than silence.
    console.warn('[Brain] JSON parse error — defaulting to ignore:', e?.message?.slice(0, 120));
    console.debug('[Brain] raw output was logged above (check Groq request log)');
    return {
      internal_thought: 'json parse error — silent fallback',
      action:           'ignore',
      reply:            '',
      reason:           'json parse error — silent fallback',
    };
  }
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
    // Refresh alias registry with newly detected nicknames
    for (const nick of (p.nicknames || [])) registerAlias(nick, userId, username);
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

    // ── Told-off gate: hard-code ignore if user recently told bot to back off ──
    if (checkToldOff(channelId, msg.author.id, msgClean) || isToldOffActive(channelId, msg.author.id)) {
      if (!mentioned) {
        console.log(`[ToldOff] blocking brain for ${sender} in #${channelId.slice(-6)}`);
        // Still push to STM so context is accurate
        // (push happens below — return happens after STM push)
      }
    }

    // ── Pending question: treat as mentioned if we asked them a question ───────
    const answeringOurQuestion = !mentioned && consumePendingQuestion(channelId, msg.author.id);
    const effectiveMentioned   = mentioned || answeringOurQuestion;
    if (answeringOurQuestion) console.log(`[PendingQ] auto-relevance: ${sender} answering our question`);

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

    // ── Told-off hard gate (post-STM-push) ────────────────────────────
    if (isToldOffActive(channelId, msg.author.id) && !effectiveMentioned) return;

    // ── Mood gate ──────────────────────────────────────────────────────
    const { fire, mood, autoActiveReason } = await shouldFireBrain(
      channelId, guildId, msgClean, msg.author.id, effectiveMentioned, isDM
    );

    if (!fire) return;

    // ── Velocity gate (non-mention passive) ────────────────────────────
    // isHighVelocity already accounts for mentions internally (returns false if mentioned)
    // shouldFireBrain already checked RPM, so we only need velocity here
    // Note: active-mode messages don't go through shouldFireBrain's passive path,
    // but we still want to be careful — check velocity for active mode too unless mentioned
    if (!effectiveMentioned && isHighVelocity(channelId, effectiveMentioned)) return;

    // ── Alias-enriched message for brain ──────────────────────────────
    const msgForBrain = injectAliasHints(msgClean);

    // ── Debounce: every new qualifying message resets the timer ────────
    // This is the "batch collection" mechanic: the brain fires only after
    // the conversation goes quiet for DEBOUNCE_MS. The latest message
    // in the burst wins and becomes the trigger context for the brain.
    if (debounceTimers.has(channelId)) clearTimeout(debounceTimers.get(channelId)!);

    // Store the most recent trigger so the debounce closure always has fresh context
    pendingTriggers.set(channelId, { msg, sender, msgClean: msgForBrain, mentioned: effectiveMentioned, isDM, guildId, autoActiveReason, mood });

    // Mentions + pending-question answers get a fast lane — short debounce so direct replies feel snappy
    const debounceMs = effectiveMentioned ? 400 : DEBOUNCE_MS;

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

        // ── Handle action ────────────────────────────────────────────
        switch (decision.action) {

          case 'speak': {
            const text = (decision.reply || '').trim()
              .replace(/^["']|["']$/g, '')
              .replace(new RegExp(`^${BOT_NAME}:\\s*`, 'i'), '')
              .split('\n')[0].slice(0, 200);

            if (!text) { console.log('[Brain] speak→empty'); break; }

            const typingMs = Math.min(400 + text.length * 22, 3000);
            try { await trigMsg.channel.sendTyping(); } catch {}
            await sleep(typingMs);

            try {
              await trigMsg.reply({ content: text, allowedMentions: { repliedUser: false } });
              stmPush(trigChannelId, { ts: Date.now(), authorId: BOT_ID, author: '[me]', content: text });
              // If we asked a question, track it so the next reply from this user
              // is treated as relevant even without a @mention
              if (text.trimEnd().endsWith('?')) {
                setPendingQuestion(trigChannelId, trigMsg.author.id);
              }
              if (trigIsGuild) {
                if (decision.bondDelta) await updateBond(trigGuildId, trigMsg.author.id, decision.bondDelta);
                if (decision.newFact)   await writeFact(trigGuildId, decision.newFact, 'facts');
              }
              if (decision.userFact) await writeUserFact(trigMsg.author.id, decision.userFact, 'facts');
              if (decision.userNote) await writeUserFact(trigMsg.author.id, decision.userNote, 'relationshipNotes');
              if (speakState.mode !== 'active') await setSpeakState(trigChannelId, trigGuildId, { mode: 'active', reason: 'spoke → reset' });
              console.log(`[→${trigSender}] "${text.slice(0,60)}"`);
            } catch (e) { console.error('[Send]', e); }
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
║  ✓ ${BOT_NAME} online — v11 Cognitive+
║  • ID: ${BOT_ID}
║  • Fast: ${FAST}
║  • Deep: ${DEEP}
║  • HF Space: ${HF_BASE_URL || '(not set)'}
║  • Keys: ${groq.allStats().length} | Avail: ${groq.available()} daily | RPM cap: ${RPM_CAP}
║  • Debounce: ${DEBOUNCE_MS}ms lull | Velocity: >${VELOCITY_HIGH_THRESH} msgs/${VELOCITY_WINDOW_MS/1000}s → ${Math.round(VELOCITY_SKIP_CHANCE*100)}% skip
║  • Active mode: ${ACTIVE_MIN_MINS}-${ACTIVE_MAX_MINS}min | Passive: every ${PASSIVE_MIN_EVERY}-${PASSIVE_MAX_EVERY} msgs
║  • API penalties: freq=1.2 presence=0.8 | maxTok brain=250
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
          // Seed alias registry from existing Firebase profiles
          try {
            const prof = await getMember(g.id, uid);
            for (const nick of (prof.nicknames || [])) {
              registerAlias(nick, uid, m.displayName);
            }
          } catch {}
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
