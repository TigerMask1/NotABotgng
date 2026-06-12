/**
 * NOTABOT — v8 "Full Human+"
 *
 * NEW in v8 (additive — nothing from v7 removed):
 *   FIX: DMs now always trigger brain (mentioned=true in DM context) — v7 silently
 *        dropped 2/3 of DM messages due to BRAIN_EVERY_N counter gate
 *   FIX: typing indicator now fires ONLY right before sending the actual reply
 *        (not during "thinking"/brain call) — sendTyping() ~10s window, refreshed
 *        if needed for long replies
 *   NEW: per-user memory — users/{uid}/profile: facts[], relationshipNotes[],
 *        context (rolling summary string). Richer than server-global memory,
 *        feeds into brain prompt when chatting with that specific person
 *   NEW: per-user deep profiler — runs alongside existing 15-min profiler,
 *        lower frequency (every 2nd cycle), updates relationshipNotes + context
 *   NEW: proactive hop loop — every PROACTIVE_INTERVAL (jittered), asks DEEP model
 *        "given everything, do you want to say something anywhere right now?"
 *        full liberty to say no (default). If yes: picks a channel/DM + writes msg.
 *        Triggered especially when a user says "come to dm" / "hop on" type things
 *        (captured as relationshipNotes / context, surfaced in the proactive prompt)
 *
 * everything from v6/v7 preserved: multi-key groq failover, RPM guard, brain loop,
 * speak states, STM, reply chains, id resolution, server memory, hourly compression,
 * admin commands.
 */

import { Client, GatewayIntentBits, Message, Partials, Events, TextChannel, DMChannel } from 'discord.js';
import Groq from 'groq-sdk';
import { db } from './firebase.ts';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// ═══════════════════════════════════════════════════════════════════
// GROQ MANAGER — multi-key failover, daily limit tracking
// ═══════════════════════════════════════════════════════════════════

interface KeyStats {
  key: string;
  requestsToday: number;
  errorsToday:   number;
  isHealthy:     boolean;
  cooldownUntil?: number;
  lastUsed?:      number;
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
      this.stats.forEach(s => {
        s.requestsToday = 0; s.errorsToday = 0;
        s.isHealthy = true;  s.cooldownUntil = undefined;
      });
      this.resetAt = now + 86_400_000;
    }
    const avail = this.keys.filter(k => {
      const s = this.stats.get(k)!;
      if (s.cooldownUntil) {
        if (now < s.cooldownUntil) return false;
        s.isHealthy = true; s.cooldownUntil = undefined; // expired, recover
      }
      return s.requestsToday < this.limit * 0.92;
    });
    const pool = avail.length ? avail : this.keys;
    return pool.reduce((a, b) =>
      this.stats.get(a)!.requestsToday <= this.stats.get(b)!.requestsToday ? a : b
    );
  }

  async request(
    model:   string,
    msgs:    any[],
    temp   = 0.85,
    maxTok = 180,
    retries = 3,
  ): Promise<string> {
    let last: any;
    for (let i = 0; i < retries; i++) {
      const k = this.bestKey();
      const s = this.stats.get(k)!;
      try {
        const r = await this.clients.get(k)!.chat.completions.create({
          model, messages: msgs, temperature: temp, max_tokens: maxTok,
        });
        s.requestsToday++; s.lastUsed = Date.now();
        rpmTick();
        console.log(`[Groq] ${model.split('-').slice(0, 3).join('-')} ${r.usage?.total_tokens}tok ...${k.slice(-4)}`);
        return r.choices[0]?.message?.content || '';
      } catch (e: any) {
        last = e; s.errorsToday++;
        if (e.status === 429) {
          const sec = parseFloat(e.message?.match(/in ([\d.]+)s/)?.[1] || '45') + 3;
          s.cooldownUntil = Date.now() + sec * 1000; s.isHealthy = false;
          console.warn(`[Groq] ...${k.slice(-4)} 429 → ${sec.toFixed(0)}s cooldown`);
        } else {
          console.error(`[Groq] attempt ${i + 1} ...${k.slice(-4)}: ${e.message}`);
        }
        if (i < retries - 1) await sleep(Math.min(1500 * 2 ** i, 12_000));
      }
    }
    throw new Error(`[Groq] all retries failed: ${last?.message}`);
  }

  allStats()  { return this.keys.map(k => this.stats.get(k)!); }
  available() { return this.keys.reduce((s, k) => s + Math.max(0, this.limit - this.stats.get(k)!.requestsToday), 0); }
}

// ── RPM guard ────────────────────────────────────────────────────────────────
// Total limit: 30 RPM. Keep 10 for reserve (direct pings, admin). 20 usable passively.
const RPM_CAP = 20;
const rpm     = { calls: 0, windowStart: Date.now() };

function rpmReset()  { const now = Date.now(); if (now - rpm.windowStart > 60_000) { rpm.calls = 0; rpm.windowStart = now; } }
function rpmAllow(): boolean { rpmReset(); return rpm.calls < RPM_CAP; }
function rpmTick()   { rpmReset(); rpm.calls++; }
function rpmLeft():  number  { rpmReset(); return Math.max(0, RPM_CAP - rpm.calls); }

const groq = new GroqManager();

// ═══════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════

// llama-3.1-8b-instant: 30 RPM, 20k TPM — real-time decisions, fast af
// llama-3.3-70b-versatile: 30 RPM, 6k TPM  — background deep work only
const FAST = 'llama-3.1-8b-instant';
const DEEP = 'llama-3.3-70b-versatile';

const DEBOUNCE_MS       = 900;
const BRAIN_EVERY_N     = 3;           // fire brain every N non-mention msgs per channel (servers only)
const MAX_FETCH_HISTORY = 16;          // Discord history fetch on cold start
const SHORT_TERM_MAX    = 50;          // per-channel in-memory message log
const PROFILER_INTERVAL = 15 * 60_000; // 15 min: profile users
const COMPRESS_INTERVAL = 60 * 60_000; // 1 hr: STM → long-term notes
const MEMBER_CACHE_TTL  = 5  * 60_000; // 5 min: member roster cache

// NEW v8: proactive hop loop timing — base interval + jitter, per "tick" the AI
// decides per-user/per-channel whether to say something. Full liberty to decline.
const PROACTIVE_BASE_INTERVAL = 25 * 60_000; // 25 min base
const PROACTIVE_JITTER         = 20 * 60_000; // +/- up to 20 min
const PROACTIVE_MIN_GAP_USER   = 45 * 60_000; // don't proactively hit same user/channel more than once per 45min
const USER_DEEP_PROFILE_EVERY  = 2;           // run deep per-user profiler every 2nd profiler cycle

// ═══════════════════════════════════════════════════════════════════
// BOT STATE
// ═══════════════════════════════════════════════════════════════════

let botClient: Client | null = null;
let BOT_NAME = 'NotABot';
let BOT_ID   = '';

const debounceTimers = new Map<string, NodeJS.Timeout>();
let profilerTimer: NodeJS.Timeout | null = null;
let proactiveTimer: NodeJS.Timeout | null = null; // NEW v8
let profilerCycle = 0; // NEW v8 — counts profiler cycles for deep-profile cadence

// ── Per-channel message counter ─────────────────────────────────────────────
// Prevents firing brain on every single message — only every BRAIN_EVERY_N OR on mention.
// (DMs bypass this entirely — see handleMessage)
const msgCounters = new Map<string, { n: number; windowStart: number }>();

function shouldFireBrain(channelId: string, mentioned: boolean): boolean {
  if (mentioned) return true; // always fire on direct ping (and always true for DMs now)

  if (!rpmAllow()) {
    console.log(`[RPM] budget tight (${rpmLeft()} left) — skipping passive brain`);
    return false;
  }

  const now = Date.now();
  let c = msgCounters.get(channelId);
  if (!c || now - c.windowStart > 60_000) {
    c = { n: 0, windowStart: now };
    msgCounters.set(channelId, c);
  }
  c.n++;

  const fire = c.n % BRAIN_EVERY_N === 0;
  if (!fire) {
    console.log(`[Counter] #${channelId.slice(-6)}: msg ${c.n}, brain in ${BRAIN_EVERY_N - (c.n % BRAIN_EVERY_N)} more`);
  }
  return fire;
}

// ── ID → DisplayName resolution ─────────────────────────────────────────────
// Discord messages contain raw <@USER_ID> mentions. The AI should see @Name, not IDs.
// Cache is populated on boot (full member sync) and on every message/event.
const idNameCache = new Map<string, string>(); // userId → displayName

function cacheId(id: string, name: string) {
  if (id && name) idNameCache.set(id, name);
}

function resolveIds(text: string): string {
  return text.replace(/<@!?(\d+)>/g, (_, id: string) => {
    if (id === BOT_ID) return `@${BOT_NAME}`;
    const name = idNameCache.get(id);
    return name ? `@${name}` : '@someone';
  });
}

function stripBotMention(content: string): string {
  if (!BOT_ID) return content;
  return content.replace(new RegExp(`<@!?${BOT_ID}>`, 'g'), '').trim();
}

function cleanContent(raw: string): string {
  // Strip bot mention first (so AI doesn't see it), then resolve all other @IDs
  return resolveIds(stripBotMention(raw)).trim();
}

// ═══════════════════════════════════════════════════════════════════
// SPEAK STATE — per channel, AI-controlled, persisted to Firebase
// mode: active → reply normally
//       paused → silent until resumeAt, then auto-active
//       waiting → silent until natural opening or direct call
// ═══════════════════════════════════════════════════════════════════

interface SpeakState {
  mode:       'active' | 'paused' | 'waiting';
  resumeAt?:  number;
  reason:     string;
  setAt:      number;
}

const speakStates = new Map<string, SpeakState>();

function defaultState(): SpeakState {
  return { mode: 'active', reason: 'default', setAt: Date.now() };
}

async function getSpeakState(channelId: string, guildId: string): Promise<SpeakState> {
  if (speakStates.has(channelId)) {
    const s = speakStates.get(channelId)!;
    if (s.mode === 'paused' && s.resumeAt && Date.now() >= s.resumeAt) {
      const next: SpeakState = { mode: 'active', reason: 'pause expired', setAt: Date.now() };
      speakStates.set(channelId, next);
      persistState(channelId, guildId, next);
      return next;
    }
    return s;
  }
  try {
    const snap = await db.collection('servers').doc(guildId)
      .collection('channels').doc(channelId).get();
    const d = snap.data()?.speakState as SpeakState | undefined;
    const state = d ?? defaultState();
    if (state.mode === 'paused' && state.resumeAt && Date.now() >= state.resumeAt) {
      state.mode = 'active'; state.reason = 'pause expired (on load)';
    }
    speakStates.set(channelId, state);
    return state;
  } catch {
    const s = defaultState();
    speakStates.set(channelId, s);
    return s;
  }
}

async function setSpeakState(channelId: string, guildId: string, update: Partial<SpeakState>) {
  const cur  = speakStates.get(channelId) ?? defaultState();
  const next: SpeakState = { ...cur, ...update, setAt: Date.now() };
  speakStates.set(channelId, next);
  persistState(channelId, guildId, next);
  const info = next.resumeAt ? ` → resumes ${new Date(next.resumeAt).toLocaleTimeString()}` : '';
  console.log(`[State] #${channelId.slice(-6)} → ${next.mode}${info} | "${next.reason}"`);
}

function persistState(channelId: string, guildId: string, state: SpeakState) {
  db.collection('servers').doc(guildId).collection('channels').doc(channelId)
    .set({ speakState: state, updatedAt: new Date().toISOString() }, { merge: true })
    .catch(() => {});
}

// ═══════════════════════════════════════════════════════════════════
// SHORT-TERM MEMORY — per-channel, in-memory, timestamped
// Every message pushed here immediately (before brain check).
// replyTo field carries the reply chain so AI understands who's responding to whom.
// ═══════════════════════════════════════════════════════════════════

interface STMessage {
  ts:       number;
  authorId: string;
  author:   string;    // display name OR '[me]' for bot's own messages
  content:  string;
  replyTo?: { author: string; content: string }; // reply chain context
}

const stmStore = new Map<string, STMessage[]>();

function stmPush(channelId: string, msg: STMessage) {
  if (!stmStore.has(channelId)) stmStore.set(channelId, []);
  const arr = stmStore.get(channelId)!;
  arr.push(msg);
  if (arr.length > SHORT_TERM_MAX) arr.shift();
}

function stmGet(channelId: string): STMessage[] {
  return stmStore.get(channelId) ?? [];
}

function stmFormat(msgs: STMessage[], nowMs: number): string {
  if (!msgs.length) return '(no recent messages)';
  return msgs.map(m => {
    const agoMs  = nowMs - m.ts;
    const agoStr = agoMs < 60_000
      ? `${Math.round(agoMs / 1000)}s ago`
      : `${Math.round(agoMs / 60_000)}m ago`;
    let line = `[${agoStr}] ${m.author}: ${m.content}`;
    if (m.replyTo) {
      line += `\n   ↳ replying to ${m.replyTo.author}: "${m.replyTo.content.slice(0, 70)}"`;
    }
    return line;
  }).join('\n');
}

function seedSTM(channelId: string, msgs: Message[]) {
  if (stmStore.has(channelId)) return; // already seeded, don't overwrite live memory
  const arr: STMessage[] = msgs.map(m => ({
    ts:       m.createdTimestamp,
    authorId: m.author.id,
    author:   m.author.id === BOT_ID ? '[me]' : (m.member?.displayName || m.author.username),
    content:  cleanContent(m.content).slice(0, 120),
  }));
  stmStore.set(channelId, arr.slice(-SHORT_TERM_MAX));
}

// ═══════════════════════════════════════════════════════════════════
// FIREBASE SCHEMA
//
// servers/{gid}/              → identity (name, memberCount)
// servers/{gid}/members/{uid} → displayName, username, bond, personality,
//                               interests, vibes, sentiment, nicknames, profiledAt
// servers/{gid}/channels/{cid}→ speakState
// servers/{gid}/memory/global → facts[], corrections[], insideJokes[]
// servers/{gid}/notes/hourly  → compressed hourly summary
//
// NEW v8:
// users/{uid}/profile         → facts[], relationshipNotes[], context (string),
//                               lastDM, dmChannelId, lastProactiveAt, deepProfiledAt
// ═══════════════════════════════════════════════════════════════════

async function upsertServerIdentity(guild: any) {
  try {
    await db.collection('servers').doc(guild.id)
      .set({ name: guild.name, memberCount: guild.memberCount, updatedAt: new Date().toISOString() }, { merge: true });
  } catch {}
}

async function upsertMember(guildId: string, userId: string, data: Record<string, any>) {
  try {
    await db.collection('servers').doc(guildId).collection('members').doc(userId)
      .set({ ...data, updatedAt: new Date().toISOString() }, { merge: true });
  } catch {}
}

async function getMember(guildId: string, userId: string): Promise<Record<string, any>> {
  try {
    const s = await db.collection('servers').doc(guildId).collection('members').doc(userId).get();
    return s.exists ? s.data()! : {};
  } catch { return {}; }
}

// Member roster with 5-min cache — not re-fetched per message
const memberRosterCache = new Map<string, { data: Record<string, any>[]; ts: number }>();

async function getAllMembers(guildId: string): Promise<Record<string, any>[]> {
  const cached = memberRosterCache.get(guildId);
  if (cached && Date.now() - cached.ts < MEMBER_CACHE_TTL) return cached.data;
  try {
    const snap = await db.collection('servers').doc(guildId).collection('members').get();
    const data = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    memberRosterCache.set(guildId, { data, ts: Date.now() });
    return data;
  } catch { return []; }
}

async function updateBond(guildId: string, userId: string, delta: number) {
  if (!delta) return;
  try {
    const m    = await getMember(guildId, userId);
    const cur  = typeof m.bond === 'number' ? m.bond : 50;
    const next = Math.max(0, Math.min(100, cur + delta));
    await upsertMember(guildId, userId, { bond: next });
    console.log(`[Bond] ${userId.slice(-6)}: ${cur} → ${next}`);
  } catch {}
}

// Global memory: facts the bot learns over time
interface GlobalMemory { facts: string[]; corrections: string[]; insideJokes: string[]; }
const memCache = new Map<string, { d: GlobalMemory; ts: number }>();

async function getMemory(guildId: string): Promise<GlobalMemory> {
  const cached = memCache.get(guildId);
  if (cached && Date.now() - cached.ts < 90_000) return cached.d;
  try {
    const snap = await db.collection('servers').doc(guildId).collection('memory').doc('global').get();
    const d: GlobalMemory = {
      facts:       snap.data()?.facts       ?? [],
      corrections: snap.data()?.corrections ?? [],
      insideJokes: snap.data()?.insideJokes ?? [],
    };
    memCache.set(guildId, { d, ts: Date.now() });
    return d;
  } catch { return { facts: [], corrections: [], insideJokes: [] }; }
}

async function writeFact(guildId: string, fact: string, bucket: keyof GlobalMemory = 'facts') {
  if (!fact?.trim()) return;
  try {
    const mem = await getMemory(guildId);
    const arr = mem[bucket] as string[];
    if (arr.some(f => f.toLowerCase() === fact.toLowerCase())) return; // dedup
    arr.push(fact.trim());
    if (arr.length > 40) arr.shift();
    await db.collection('servers').doc(guildId).collection('memory').doc('global')
      .set({ [bucket]: arr, updatedAt: new Date().toISOString() }, { merge: true });
    memCache.delete(guildId);
    console.log(`[Mem:${bucket}] "${fact.slice(0, 60)}"`);
  } catch {}
}

// Builds compact memory context for AI prompt
function memToPrompt(mem: GlobalMemory, members: Record<string, any>[]): string {
  const lines: string[] = [];

  // Who's in this server — name, nicknames, one-line vibe
  if (members.length) {
    const roster = members
      .filter(m => m.displayName || m.username)
      .slice(0, 20) // cap at 20 to control token usage
      .map(m => {
        const name  = m.displayName || m.username;
        const nicks = m.nicknames?.length ? ` [aka: ${m.nicknames.join(', ')}]` : '';
        const vibe  = m.personality ? ` — ${m.personality}` : '';
        return `  ${name}${nicks}${vibe}`;
      }).join('\n');
    lines.push(`SERVER MEMBERS:\n${roster}`);
  }

  if (mem.facts.length)
    lines.push(`YOU KNOW:\n${mem.facts.slice(-10).map(f => `- ${f}`).join('\n')}`);
  if (mem.corrections.length)
    lines.push(`DON'T REPEAT:\n${mem.corrections.slice(-6).map(c => `- ${c}`).join('\n')}`);
  if (mem.insideJokes.length)
    lines.push(`INSIDE JOKES:\n${mem.insideJokes.slice(-6).map(j => `- ${j}`).join('\n')}`);

  return lines.join('\n\n') || '(nothing yet)';
}

// ═══════════════════════════════════════════════════════════════════
// NEW v8: PER-USER MEMORY
// users/{uid}/profile — richer than server-global memory. Tracks:
//   facts[]             — things learned about this specific person
//   relationshipNotes[] — how bot+person relate, history of interactions,
//                         explicit invitations ("come to dm", "hop on later"),
//                         ongoing bits/jokes specific to this person
//   context             — rolling free-text summary, updated by deep profiler
//   lastDM, dmChannelId — for proactive hop targeting
//   lastProactiveAt     — rate limit for proactive pings to this user
// ═══════════════════════════════════════════════════════════════════

interface UserProfile {
  facts:             string[];
  relationshipNotes: string[];
  context:           string;
  displayName?:      string;
  lastDM?:           number;
  dmChannelId?:      string;
  lastSeenChannelId?: string;
  lastSeenGuildId?:   string;
  lastProactiveAt?:  number;
  deepProfiledAt?:   string;
}

const userProfileCache = new Map<string, { d: UserProfile; ts: number }>();

function emptyUserProfile(): UserProfile {
  return { facts: [], relationshipNotes: [], context: '' };
}

async function getUserProfile(userId: string): Promise<UserProfile> {
  const cached = userProfileCache.get(userId);
  if (cached && Date.now() - cached.ts < 60_000) return cached.d;
  try {
    const snap = await db.collection('users').doc(userId).collection('profile').doc('main').get();
    const d: UserProfile = snap.exists ? { ...emptyUserProfile(), ...snap.data() } as UserProfile : emptyUserProfile();
    userProfileCache.set(userId, { d, ts: Date.now() });
    return d;
  } catch { return emptyUserProfile(); }
}

async function upsertUserProfile(userId: string, data: Partial<UserProfile>) {
  try {
    await db.collection('users').doc(userId).collection('profile').doc('main')
      .set({ ...data, updatedAt: new Date().toISOString() }, { merge: true });
    userProfileCache.delete(userId);
  } catch {}
}

async function writeUserFact(userId: string, fact: string, bucket: 'facts' | 'relationshipNotes' = 'facts') {
  if (!fact?.trim()) return;
  try {
    const p   = await getUserProfile(userId);
    const arr = p[bucket] as string[];
    if (arr.some(f => f.toLowerCase() === fact.toLowerCase())) return; // dedup
    arr.push(fact.trim());
    if (arr.length > 30) arr.shift();
    await upsertUserProfile(userId, { [bucket]: arr } as Partial<UserProfile>);
    console.log(`[UserMem:${bucket}] ${userId.slice(-6)}: "${fact.slice(0, 60)}"`);
  } catch {}
}

// Compact per-user context block for brain prompt
function userProfileToPrompt(p: UserProfile): string {
  const lines: string[] = [];
  if (p.context) lines.push(`ABOUT THEM: ${p.context}`);
  if (p.facts.length) lines.push(`KNOWN FACTS:\n${p.facts.slice(-8).map(f => `- ${f}`).join('\n')}`);
  if (p.relationshipNotes.length) lines.push(`UR RELATIONSHIP/HISTORY:\n${p.relationshipNotes.slice(-6).map(n => `- ${n}`).join('\n')}`);
  return lines.join('\n\n') || '(nothing yet — first real convo)';
}

// ═══════════════════════════════════════════════════════════════════
// CLOCK CONTEXT — real-time awareness for the AI
// ═══════════════════════════════════════════════════════════════════

function clockContext(msgs: STMessage[], state: SpeakState): string {
  const nowMs   = Date.now();
  const now     = new Date();
  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
  const dayStr  = now.toLocaleDateString('en-US', { weekday: 'long' });

  const lastBot   = [...msgs].reverse().find(m => m.author === '[me]');
  const lastHuman = [...msgs].reverse().find(m => m.author !== '[me]');

  const botAgo   = lastBot   ? `${Math.round((nowMs - lastBot.ts)   / 1000)}s ago` : 'not this session';
  const humanAgo = lastHuman ? `${Math.round((nowMs - lastHuman.ts) / 1000)}s ago` : 'unknown';
  const stateAge = Math.round((nowMs - state.setAt) / 1000);
  const stateStr = stateAge < 60 ? `${stateAge}s` : `${Math.round(stateAge / 60)}m`;
  const resumeStr = state.resumeAt ? ` → resumes ${new Date(state.resumeAt).toLocaleTimeString()}` : '';

  return `${timeStr} ${dayStr} | u last spoke: ${botAgo} | last msg in chat: ${humanAgo} | mode: ${state.mode} (for ${stateStr})${resumeStr}`;
}

// ═══════════════════════════════════════════════════════════════════
// BRAIN — single AI call that decides action + generates reply
// Using FAST model (8b-instant) for low latency + high throughput
//
// NEW v8: brain prompt now includes per-user profile context (userCtx),
// and can emit `userNote` (relationship-level note) in addition to `newFact`
// (server-global fact). Also gets `isDM` flag so it can adjust tone/behavior
// for 1:1 vs group settings.
// ═══════════════════════════════════════════════════════════════════

interface BrainDecision {
  action:     'speak' | 'pause' | 'wait' | 'ignore';
  reply?:     string;
  pauseMins?: number;
  bondDelta?: number;
  newFact?:   string;     // server-global fact
  userFact?:  string;     // NEW v8: fact about this specific person
  userNote?:  string;     // NEW v8: relationship/history note about this person
  reason:     string;
}

async function brain(
  senderName:  string,
  senderInfo:  string,
  bond:        number,
  message:     string,
  transcript:  string,
  memCtx:      string,
  userCtx:     string,   // NEW v8
  clock:       string,
  mentioned:   boolean,
  state:       SpeakState,
  isDM:        boolean,  // NEW v8
): Promise<BrainDecision> {

  const bondLabel = bond > 75 ? 'close friend' : bond > 50 ? 'neutral' : bond > 25 ? 'not close' : 'beef';

  const system = `you are ${BOT_NAME} on discord. gen z human. NOT an ai, NOT an assistant. just a person.

vibe: chaotic, funny, charming, lowkey unhinged. u roast ur friends but genuinely care.

HOW U TALK:
- all lowercase. 1-2 sentences MAX. sometimes just a word or single emoji is best.
- slang: ngl, fr, bruh, lowkey, nah, bet, istg, deadass, lmaoo, yo, ong, idk, tbh, rn, imo, no cap, smh, bro, wtf, omg, slay
- typos r fine. dont fix them. dont explain urself. dont be formal. dont yap.
- match the energy — chaotic energy gets chaos back. chill gets chill.

NEVER: "certainly", "as an ai", "i understand", "how can i help", "great question", bullet points, explaining ur jokes, being an assistant.

${isDM ? `THIS IS A DM (1:1, just u and them):
- more personal, can reference shared history/inside stuff more directly
- still short, still urself, not a customer service bot
- if they ever said smth like "come to dm" / "hop on later" / "lemme tell u smth" — and u haven't followed up yet — this is a good time to acknowledge that if relevant` : ''}

SPEAK STATE (u control this):
- speak  → reply (put it in reply field, raw text no quotes no name prefix)
- pause  → shut up X mins (use when someone tells u to stop / clearly interrupting)
- wait   → stay silent until someone calls u or obvious opening appears
- ignore → skip this msg, stay active

READING THE CHAT TRANSCRIPT:
- [me] = ur own past messages
- @Name = someone tagging/mentioning that person by their discord name
- ↳ replying to X: "..." = shows what message someone was replying TO (thread context)
  → this tells u who is talking to who and what they're actually responding to

WHEN TO REPLY: tagged, directly asked something, u have smth actually funny/relevant
WHEN NOT TO: two people clearly in their own convo, forced/cringe to jump in, u already said ur piece recently`;

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

${senderName} (${bondLabel}, bond ${bond}/100${senderInfo ? ` — ${senderInfo}` : ''}) just said: "${message}"
tagged you: ${mentioned ? 'YES — almost always reply' : 'no'}

Output ONLY valid JSON, no markdown, no extra text:
{"action":"speak|pause|wait|ignore","reply":"ur raw reply if speaking","pauseMins":5,"bondDelta":0,"newFact":"server-wide fact worth remembering, or empty string","userFact":"fact specifically about ${senderName}, or empty string","userNote":"relationship/history note about ${senderName} (e.g. they invited u somewhere, ongoing bit, etc), or empty string","reason":"one line"}`;

  try {
    const raw    = await groq.request(FAST, [
      { role: 'system', content: system },
      { role: 'user',   content: user  },
    ], 0.88, 200);

    const clean  = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

    // Hard override: always reply when mentioned
    if (mentioned && parsed.action !== 'speak') parsed.action = 'speak';

    return {
      action:    parsed.action    || 'ignore',
      reply:     parsed.reply     || '',
      pauseMins: parsed.pauseMins || 5,
      bondDelta: parsed.bondDelta || 0,
      newFact:   parsed.newFact   || '',
      userFact:  parsed.userFact  || '',
      userNote:  parsed.userNote  || '',
      reason:    parsed.reason    || '?',
    };
  } catch (e) {
    console.warn('[Brain] parse fail:', (e as any).message?.slice(0, 80));
    return {
      action: mentioned ? 'speak' : 'ignore',
      reply:  'mb brain lagged',
      reason: 'fallback',
    };
  }
}

// ═══════════════════════════════════════════════════════════════════
// PROFILER — background, rate-aware, runs every 15 min
// ═══════════════════════════════════════════════════════════════════

async function profileMember(
  guildId: string,
  userId:  string,
  username: string,
  msgs:    string[],
) {
  if (msgs.length < 3 || !rpmAllow()) return;
  try {
    const res = await groq.request(DEEP, [
      { role: 'system', content: 'analyze a discord user from their messages. output ONLY valid JSON, no markdown.' },
      { role: 'user',   content: `user: ${username}\ntheir messages:\n${msgs.join('\n')}\n\nJSON: {"personality":"one line vibe","interests":["x"],"vibes":"how they communicate","sentiment":"positive|neutral|negative","nicknames":["any names people call them"]}` },
    ], 0.4, 160);
    const p = JSON.parse(res.replace(/```json|```/g, '').trim());
    await upsertMember(guildId, userId, {
      personality: p.personality  || '',
      interests:   p.interests    || [],
      vibes:       p.vibes        || '',
      sentiment:   p.sentiment    || 'neutral',
      nicknames:   p.nicknames    || [],
      profiledAt:  new Date().toISOString(),
    });
    // Cache any discovered nicknames so resolveIds can use them
    if (p.nicknames?.length) {
      console.log(`[Profiler] ${username} aka: ${p.nicknames.join(', ')}`);
    }
    console.log(`[Profiler] ${username} → "${p.personality}"`);
  } catch {}
}

// NEW v8: deep per-user profiler — updates relationshipNotes + rolling context.
// Runs less often than the server profiler (every USER_DEEP_PROFILE_EVERY cycles).
async function deepProfileUser(userId: string, username: string, recentMsgs: string[]) {
  if (recentMsgs.length < 2 || !rpmAllow()) return;
  try {
    const existing = await getUserProfile(userId);
    const res = await groq.request(DEEP, [
      { role: 'system', content: 'you maintain a rolling private profile of a discord user for a bot persona. output ONLY valid JSON, no markdown. be concise.' },
      { role: 'user', content:
`user: ${username}
existing context: ${existing.context || '(none yet)'}
existing relationship notes: ${existing.relationshipNotes.slice(-5).join(' | ') || '(none)'}

their recent messages:
${recentMsgs.join('\n')}

Update the rolling context (2-3 sentences max, merge old+new, drop stale stuff) and list any NEW relationship notes (things like: they invited the bot somewhere, ongoing jokes/bits specific to them, how they treat the bot, anything notable about this interaction pattern). Don't repeat notes already listed above.

JSON: {"context":"updated rolling summary","newNotes":["x"],"newFacts":["x"]}` },
    ], 0.4, 220);

    const p = JSON.parse(res.replace(/```json|```/g, '').trim());
    if (p.context) await upsertUserProfile(userId, { context: p.context, deepProfiledAt: new Date().toISOString(), displayName: username });
    for (const n of (p.newNotes || []).slice(0, 3)) await writeUserFact(userId, n, 'relationshipNotes');
    for (const f of (p.newFacts || []).slice(0, 3)) await writeUserFact(userId, f, 'facts');
    console.log(`[DeepProfile] ${username} → "${(p.context || '').slice(0, 60)}"`);
  } catch {}
}

// Hourly: compress STM into long-term server notes
const lastCompressedAt = new Map<string, number>(); // guildId → epoch ms

async function maybeCompressHourly(guildId: string, channelId: string) {
  const last = lastCompressedAt.get(guildId) || 0;
  if (Date.now() - last < COMPRESS_INTERVAL) return;
  if (!rpmAllow()) return;
  lastCompressedAt.set(guildId, Date.now());

  const msgs = stmGet(channelId);
  if (msgs.length < 10) return;

  try {
    const text = msgs.map(m => {
      let line = `${m.author}: ${m.content}`;
      if (m.replyTo) line += ` (↳ to ${m.replyTo.author}: "${m.replyTo.content.slice(0, 40)}")`;
      return line;
    }).join('\n');

    const res = await groq.request(DEEP, [
      { role: 'system', content: 'summarize this discord server chat hour. extract the vibe, key facts, inside jokes. ONLY valid JSON, no markdown.' },
      { role: 'user', content: `${text}\n\nJSON: {"summary":"brief summary","groupVibe":"one line vibe","insideJokes":["x"],"facts":["x"]}` },
    ], 0.4, 250);

    const p = JSON.parse(res.replace(/```json|```/g, '').trim());

    for (const f of (p.facts       || []).slice(0, 5)) await writeFact(guildId, f, 'facts');
    for (const j of (p.insideJokes || []).slice(0, 4)) await writeFact(guildId, j, 'insideJokes');

    await db.collection('servers').doc(guildId)
      .collection('notes').doc('hourly')
      .set({ summary: p.summary, groupVibe: p.groupVibe, at: new Date().toISOString() }, { merge: true });

    console.log(`[Compress] ${guildId} hourly notes saved → "${p.groupVibe}"`);
  } catch {}
}

function startProfilerLoop(client: Client) {
  if (profilerTimer) clearInterval(profilerTimer);

  profilerTimer = setInterval(async () => {
    if (!rpmAllow()) { console.log('[Profiler] RPM tight — skipping cycle'); return; }
    profilerCycle++;
    const doDeepUser = profilerCycle % USER_DEEP_PROFILE_EVERY === 0;

    try {
      for (const guild of client.guilds.cache.values()) {
        await upsertServerIdentity(guild);

        for (const ch of guild.channels.cache.filter(c => c.isTextBased()).values()) {
          try {
            const fetched = await (ch as any).messages.fetch({ limit: 20 });
            const msgs    = ([...fetched.values()] as Message[]).reverse();

            seedSTM(ch.id, msgs);

            const byAuthor = new Map<string, { userId: string; lines: string[] }>();
            for (const m of msgs) {
              if (m.author.bot || !m.content.trim()) continue;
              const uid  = m.author.id;
              const name = m.member?.displayName || m.author.username;

              cacheId(uid, name); // keep id→name cache fresh

              await upsertMember(guild.id, uid, {
                displayName: name,
                username:    m.author.username,
              });

              if (!byAuthor.has(uid)) byAuthor.set(uid, { userId: uid, lines: [] });
              byAuthor.get(uid)!.lines.push(m.content.slice(0, 100));
            }

            for (const [uid, { lines }] of byAuthor) {
              if (!rpmAllow()) break;
              const member = guild.members.cache.get(uid);
              const name   = member?.displayName || uid;
              await profileMember(guild.id, uid, name, lines);
              // NEW v8: deep per-user profile, lower cadence
              if (doDeepUser && rpmAllow()) {
                await deepProfileUser(uid, name, lines);
              }
            }
          } catch {} // channel might not be accessible
        }
      }
      // Invalidate member roster cache so next message pick gets fresh data
      memberRosterCache.clear();
      console.log(`[Profiler] cycle done | deepUser=${doDeepUser} | ${groq.available()} daily reqs left | ${rpmLeft()} RPM left`);
    } catch (e) { console.error('[Profiler] error:', e); }
  }, PROFILER_INTERVAL);
}

// ═══════════════════════════════════════════════════════════════════
// NEW v8: PROACTIVE HOP LOOP
//
// Every ~25min (jittered), if RPM allows, asks DEEP model:
// "given recent server activity + per-user notes/context, do you want to say
//  something anywhere (a server channel or someone's DM) right now?"
// Full liberty to say no — this should fire RARELY. Default = no.
// If yes: picks target (channelId or userId for DM) + writes the message itself.
// Especially primed by relationshipNotes like "they said come to dm".
// ═══════════════════════════════════════════════════════════════════

interface ProactiveCandidate {
  type:        'channel' | 'dm';
  id:          string;       // channelId or userId
  label:       string;       // human-readable for logging
  contextHint: string;       // why this might be worth considering
}

async function gatherProactiveCandidates(client: Client): Promise<ProactiveCandidate[]> {
  const out: ProactiveCandidate[] = [];
  const now = Date.now();

  // Server channels with recent activity (from STM)
  for (const [channelId, msgs] of stmStore.entries()) {
    if (!msgs.length) continue;
    const last = msgs[msgs.length - 1];
    const idleMs = now - last.ts;
    // only consider channels that have gone quiet for a bit (5min - 3hr) — not dead, not currently buzzing
    if (idleMs < 5 * 60_000 || idleMs > 3 * 60 * 60_000) continue;
    out.push({
      type: 'channel',
      id: channelId,
      label: `#${channelId.slice(-6)}`,
      contextHint: `went quiet ${Math.round(idleMs / 60_000)}m ago, last msg: "${last.content.slice(0, 60)}"`,
    });
  }

  // Users with relationshipNotes hinting at an invite, not contacted recently
  try {
    const snap = await db.collection('users').get();
    for (const doc of snap.docs) {
      const userId = doc.id;
      const profSnap = await doc.ref.collection('profile').doc('main').get();
      if (!profSnap.exists) continue;
      const p = profSnap.data() as UserProfile;

      const lastProactive = p.lastProactiveAt || 0;
      if (now - lastProactive < PROACTIVE_MIN_GAP_USER) continue;
      if (!p.dmChannelId) continue;

      const inviteHint = (p.relationshipNotes || []).find(n =>
        /dm|hop on|come (here|over)|lemme tell|wanna (talk|tell)|hit (me|u) up/i.test(n)
      );
      if (!inviteHint && !p.context) continue; // need SOME signal to even consider

      out.push({
        type: 'dm',
        id: userId,
        label: p.displayName || userId.slice(-6),
        contextHint: inviteHint
          ? `they said: "${inviteHint}"`
          : `context: ${p.context.slice(0, 80)}`,
      });
    }
  } catch {}

  return out;
}

async function runProactiveCycle(client: Client) {
  if (!rpmAllow()) { console.log('[Proactive] RPM tight — skip'); return; }

  const candidates = await gatherProactiveCandidates(client);
  if (!candidates.length) { console.log('[Proactive] no candidates this cycle'); return; }

  // cap to keep prompt small
  const sample = candidates.slice(0, 12);

  const listText = sample.map((c, i) =>
    `${i}. [${c.type}] ${c.label} — ${c.contextHint}`
  ).join('\n');

  const system = `you are ${BOT_NAME}, a chaotic gen-z discord persona (NOT an assistant). u have FULL LIBERTY to either say nothing (most common — pick "none") or proactively send ONE message to a server channel or someone's DM if it feels natural/funny/warranted.

be very conservative — only pick something if it's genuinely a good moment (e.g. someone explicitly invited u to dm earlier and u haven't followed up, or a channel went quiet on something u could naturally jump back into). most cycles should result in "none". never be needy, never spam, never force a convo.

if u pick a target, write the actual message — raw lowercase gen-z text, same voice as always (ngl, fr, bruh, lowkase, short, 1-2 sentences).`;

  const user = `candidates:\n${listText}\n\nOutput ONLY valid JSON, no markdown:
{"pick":"none|<index number>","message":"the raw message to send if picking something, else empty string","reason":"one line"}`;

  try {
    const raw = await groq.request(DEEP, [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ], 0.9, 150);

    const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    console.log(`[Proactive] decision: ${parsed.pick} | "${parsed.reason}"`);

    if (parsed.pick === 'none' || parsed.pick === undefined) return;

    const idx = parseInt(String(parsed.pick), 10);
    if (isNaN(idx) || idx < 0 || idx >= sample.length) return;
    const target = sample[idx];
    const text = (parsed.message || '').trim().replace(/^["']|["']$/g, '').slice(0, 200);
    if (!text) return;

    if (target.type === 'channel') {
      const ch = client.channels.cache.get(target.id) as TextChannel | undefined;
      if (!ch || !ch.isTextBased()) return;
      await (ch as any).sendTyping().catch(() => {});
      await sleep(Math.min(400 + text.length * 22, 3000));
      await (ch as any).send(text);
      stmPush(target.id, { ts: Date.now(), authorId: BOT_ID, author: '[me]', content: text });
      console.log(`[Proactive→channel] ${target.label}: "${text.slice(0, 60)}"`);
    } else {
      // DM
      const user = await client.users.fetch(target.id).catch(() => null);
      if (!user) return;
      const dm = await user.createDM().catch(() => null);
      if (!dm) return;
      await dm.sendTyping().catch(() => {});
      await sleep(Math.min(400 + text.length * 22, 3000));
      await dm.send(text);
      stmPush(dm.id, { ts: Date.now(), authorId: BOT_ID, author: '[me]', content: text });
      await upsertUserProfile(target.id, { lastProactiveAt: Date.now() });
      console.log(`[Proactive→dm] ${target.label}: "${text.slice(0, 60)}"`);
    }
  } catch (e) {
    console.warn('[Proactive] error:', (e as any).message?.slice(0, 80));
  }
}

function scheduleProactiveCycle(client: Client) {
  const jitter = Math.floor((Math.random() * 2 - 1) * PROACTIVE_JITTER); // +/- jitter
  const delay  = Math.max(60_000, PROACTIVE_BASE_INTERVAL + jitter);
  proactiveTimer = setTimeout(async () => {
    try { await runProactiveCycle(client); } catch (e) { console.error('[Proactive] cycle error:', e); }
    scheduleProactiveCycle(client); // reschedule with fresh jitter
  }, delay);
  console.log(`[Proactive] next cycle in ${Math.round(delay / 60_000)}m`);
}

// ═══════════════════════════════════════════════════════════════════
// MAIN MESSAGE HANDLER
// ═══════════════════════════════════════════════════════════════════

async function handleMessage(msg: Message) {
  if (msg.author.bot || !msg.content?.trim()) return;

  try {
    const isDM    = msg.channel.isDMBased();
    const isGuild = !isDM && !!msg.guildId;
    if (!isDM && !isGuild) return;

    const guildId   = isGuild ? msg.guildId! : 'dm';
    const channelId = msg.channelId;

    // FIX v8: in DMs, always treat as "mentioned" — v7's BRAIN_EVERY_N counter
    // silently dropped 2/3 of DM messages since users never @-mention in DMs.
    const mentioned = isDM ? true : (BOT_ID ? msg.mentions.has(BOT_ID) : false);

    const sender    = msg.member?.displayName || msg.author.username;
    const msgClean  = cleanContent(msg.content);

    // Keep id→name cache populated on every message
    cacheId(msg.author.id, sender);

    // NEW v8: track DM channel for proactive targeting
    if (isDM) {
      await upsertUserProfile(msg.author.id, {
        dmChannelId: channelId,
        lastDM:      Date.now(),
        displayName: sender,
      });
    } else {
      await upsertUserProfile(msg.author.id, {
        lastSeenChannelId: channelId,
        lastSeenGuildId:   guildId,
        displayName:       sender,
      });
    }

    // ── Resolve reply chain ───────────────────────────────────────────
    // If this message is a reply to another message, fetch the original.
    // This is what lets the AI understand "who is talking to whom" and thread context.
    let replyRef: STMessage['replyTo'] | undefined;
    if (msg.reference?.messageId) {
      try {
        const ref       = await msg.channel.messages.fetch(msg.reference.messageId);
        const refAuthor = ref.author.id === BOT_ID
          ? '[me]'
          : (ref.member?.displayName || ref.author.username);
        replyRef = {
          author:  refAuthor,
          content: cleanContent(ref.content).slice(0, 100),
        };
      } catch {} // message deleted or inaccessible — fine, just skip
    }

    // ── Push to STM immediately (every message, before any gate) ─────
    stmPush(channelId, {
      ts:       msg.createdTimestamp,
      authorId: msg.author.id,
      author:   msg.author.id === BOT_ID ? '[me]' : sender,
      content:  msgClean.slice(0, 120),
      replyTo:  replyRef,
    });

    // ── Rate gate: only fire brain every N msgs OR on mention ─────────
    // (DMs always pass since mentioned=true above)
    if (!shouldFireBrain(channelId, mentioned)) return;

    // ── Debounce: collapse rapid-fire messages into one brain call ────
    if (debounceTimers.has(channelId)) clearTimeout(debounceTimers.get(channelId)!);

    const debounce = mentioned ? 200 : DEBOUNCE_MS;
    const timer    = setTimeout(async () => {
      debounceTimers.delete(channelId);

      try {
        // ── Speak state check ─────────────────────────────────────────
        const state = await getSpeakState(channelId, guildId);

        // Hard skip if paused and not mentioned (DMs are always "mentioned" so never skip here)
        if (state.mode === 'paused' && state.resumeAt && Date.now() < state.resumeAt && !mentioned) {
          const leftSec = Math.round((state.resumeAt - Date.now()) / 1000);
          console.log(`[Paused] #${channelId.slice(-6)} ${leftSec}s left → skip`);
          return;
        }

        // ── Cold-start: seed STM from Discord history ─────────────────
        if (!stmStore.has(channelId)) {
          const fetched = await msg.channel.messages.fetch({ limit: MAX_FETCH_HISTORY });
          seedSTM(channelId, ([...fetched.values()] as Message[]).reverse());
        }

        // ── Load context in parallel (minimise await latency) ─────────
        const [memberData, memory, allMembers, userProfile] = await Promise.all([
          isGuild ? getMember(guildId, msg.author.id) : Promise.resolve({}),
          isGuild ? getMemory(guildId)                : Promise.resolve({ facts: [], corrections: [], insideJokes: [] } as GlobalMemory),
          isGuild ? getAllMembers(guildId)             : Promise.resolve([]),
          getUserProfile(msg.author.id), // NEW v8 — works for both DM and guild
        ]);

        const bond    = typeof memberData.bond === 'number' ? memberData.bond : 50;
        const profile = [memberData.personality, memberData.vibes].filter(Boolean).join(' | ');

        const nowMs      = Date.now();
        const msgs       = stmGet(channelId);
        const transcript = stmFormat(msgs, nowMs);
        const memCtx     = memToPrompt(memory, allMembers);
        const userCtx    = userProfileToPrompt(userProfile); // NEW v8
        const clock      = clockContext(msgs, state);

        // ── BRAIN: decides action + generates reply ───────────────────
        const decision = await brain(
          sender, profile, bond,
          msgClean, transcript, memCtx, userCtx, clock,
          mentioned, state, isDM,
        );

        console.log(`[Brain] ${sender}${isDM ? ' (DM)' : ''}: ${decision.action} | "${decision.reason}"`);

        // ── Apply decision ────────────────────────────────────────────
        switch (decision.action) {

          case 'speak': {
            const text = (decision.reply || '').trim()
              .replace(/^["']|["']$/g, '')                          // strip surrounding quotes
              .replace(new RegExp(`^${BOT_NAME}:\\s*`, 'i'), '')   // strip name prefix if model adds it
              .split('\n')[0]                                       // first line only
              .slice(0, 200);

            if (!text) { console.log('[Brain] speak → empty reply'); break; }

            // FIX v8: typing indicator only NOW, right before sending — not during
            // the brain "thinking" call above. sendTyping() lasts ~10s in Discord;
            // our typingMs is capped at 3000ms so a single call covers it.
            const typingMs = Math.min(400 + text.length * 22, 3000);
            try { await msg.channel.sendTyping(); } catch {}
            await sleep(typingMs);

            try {
              await msg.reply({ content: text, allowedMentions: { repliedUser: false } });

              // Push bot's reply into STM so future decisions see it
              stmPush(channelId, {
                ts:       Date.now(),
                authorId: BOT_ID,
                author:   '[me]',
                content:  text,
              });

              if (isGuild) {
                if (decision.bondDelta) await updateBond(guildId, msg.author.id, decision.bondDelta);
                if (decision.newFact)   await writeFact(guildId, decision.newFact, 'facts');
              }

              // NEW v8: per-user memory writes (works in both DM and guild)
              if (decision.userFact) await writeUserFact(msg.author.id, decision.userFact, 'facts');
              if (decision.userNote) await writeUserFact(msg.author.id, decision.userNote, 'relationshipNotes');

              if (state.mode !== 'active') {
                await setSpeakState(channelId, guildId, { mode: 'active', reason: 'spoke → reset to active' });
              }

              console.log(`[→ ${sender}] "${text.slice(0, 60)}"`);
            } catch (e) { console.error('[Send] error:', e); }
            break;
          }

          case 'pause': {
            const mins     = Math.max(1, Math.min(60, decision.pauseMins || 5));
            const resumeAt = Date.now() + mins * 60_000;
            await setSpeakState(channelId, guildId, { mode: 'paused', resumeAt, reason: decision.reason });
            if (isGuild && decision.newFact) await writeFact(guildId, decision.newFact, 'corrections');
            if (decision.userNote) await writeUserFact(msg.author.id, decision.userNote, 'relationshipNotes');
            break;
          }

          case 'wait': {
            await setSpeakState(channelId, guildId, { mode: 'waiting', reason: decision.reason });
            if (isGuild && decision.newFact) await writeFact(guildId, decision.newFact, 'corrections');
            if (decision.userNote) await writeUserFact(msg.author.id, decision.userNote, 'relationshipNotes');
            break;
          }

          case 'ignore':
          default:
            if (isGuild && decision.newFact) writeFact(guildId, decision.newFact, 'facts').catch(() => {});
            if (decision.userFact) writeUserFact(msg.author.id, decision.userFact, 'facts').catch(() => {});
            if (decision.userNote) writeUserFact(msg.author.id, decision.userNote, 'relationshipNotes').catch(() => {});
            break;
        }

        // ── Hourly compression — background, non-blocking ─────────────
        if (isGuild) maybeCompressHourly(guildId, channelId).catch(() => {});

      } catch (e) { console.error('[Handler] process error:', e); }
    }, debounce);

    debounceTimers.set(channelId, timer);
  } catch (e) { console.error('[Handler] error:', e); }
}

// ═══════════════════════════════════════════════════════════════════
// STARTUP
// ═══════════════════════════════════════════════════════════════════

export async function startBot(token: string) {
  if (botClient) return;

  botClient = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMembers,
    ],
    partials: [Partials.Message, Partials.Channel],
  });

  botClient.on(Events.ClientReady, async () => {
    BOT_NAME = botClient!.user!.username;
    BOT_ID   = botClient!.user!.id;
    cacheId(BOT_ID, BOT_NAME); // cache bot's own ID too

    console.log(`
╔═══════════════════════════════════════════════╗
║  ✓ ${BOT_NAME} online — v8 Full Human+
║  • ID: ${BOT_ID}
║  • Keys: ${groq.allStats().length}  |  Avail: ${groq.available()} daily reqs
║  • Fast: ${FAST}
║  • Deep: ${DEEP}
║  • Brain: every ${BRAIN_EVERY_N} msgs or on mention (DMs always fire)
║  • RPM budget: ${RPM_CAP} usable / 30 total
║  • Proactive hop: every ~${Math.round(PROACTIVE_BASE_INTERVAL / 60_000)}m ± ${Math.round(PROACTIVE_JITTER / 60_000)}m
╚═══════════════════════════════════════════════╝\n`);

    botClient!.user!.setPresence({ status: 'online', activities: [{ name: 'the vibes', type: 3 }] });

    // Boot: sync all guild members into Firebase + ID cache
    for (const g of botClient!.guilds.cache.values()) {
      await upsertServerIdentity(g);
      const members = await g.members.fetch().catch(() => null);
      if (members) {
        for (const [uid, member] of members) {
          if (member.user.bot) continue;
          cacheId(uid, member.displayName);
          await upsertMember(g.id, uid, {
            displayName: member.displayName,
            username:    member.user.username,
          });
        }
        console.log(`[Boot] synced ${members.size} members for "${g.name}"`);
      }
    }

    startProfilerLoop(botClient!);
    scheduleProactiveCycle(botClient!); // NEW v8
  });

  botClient.on(Events.MessageCreate, handleMessage);

  // New member → register + cache immediately
  botClient.on(Events.GuildMemberAdd, async (member) => {
    if (member.user.bot) return;
    cacheId(member.id, member.displayName);
    await upsertMember(member.guild.id, member.id, {
      displayName: member.displayName,
      username:    member.user.username,
      joinedAt:    new Date().toISOString(),
    });
  });

  // Member update (nickname change etc.) → refresh cache immediately
  botClient.on(Events.GuildMemberUpdate, async (_, member) => {
    if (member.user.bot) return;
    cacheId(member.id, member.displayName);
    await upsertMember(member.guild.id, member.id, {
      displayName: member.displayName,
      username:    member.user.username,
    });
  });

  // ── Admin commands ─────────────────────────────────────────────────────────
  botClient.on(Events.MessageCreate, async (msg) => {
    if (!msg.member?.permissions.has('Administrator') && !msg.member?.permissions.has('ManageMessages')) return;
    const c = msg.content.trim();

    // !groq — API key stats + RPM
    if (c === '!groq') {
      const lines = groq.allStats().map(s =>
        `...${s.key.slice(-6)}: ${s.requestsToday}req ${s.errorsToday}err ${s.isHealthy ? '✓' : '✗'}${s.cooldownUntil && Date.now() < s.cooldownUntil ? ` cd:${Math.ceil((s.cooldownUntil - Date.now()) / 1000)}s` : ''}`
      );
      await msg.reply(`\`\`\`\n${lines.join('\n')}\navail: ${groq.available()} | rpm left: ${rpmLeft()}/${RPM_CAP}\n\`\`\``);
    }

    // !state — current speak state for this channel
    if (c === '!state' && msg.guildId) {
      const s = await getSpeakState(msg.channelId, msg.guildId);
      const resume = s.resumeAt ? ` → resumes <t:${Math.round(s.resumeAt / 1000)}:R>` : '';
      await msg.reply(`mode: **${s.mode}**${resume}\nreason: ${s.reason}`);
    }

    // !wake / !sleep / !pause N
    if (c === '!wake' && msg.guildId) {
      await setSpeakState(msg.channelId, msg.guildId, { mode: 'active', reason: 'admin wake' });
      await msg.reply('im up');
    }
    if (c === '!sleep' && msg.guildId) {
      await setSpeakState(msg.channelId, msg.guildId, { mode: 'waiting', reason: 'admin sleep' });
      await msg.reply('aight going quiet');
    }
    if (c.startsWith('!pause ') && msg.guildId) {
      const mins = parseInt(c.split(' ')[1]) || 10;
      await setSpeakState(msg.channelId, msg.guildId, {
        mode: 'paused', resumeAt: Date.now() + mins * 60_000, reason: 'admin pause',
      });
      await msg.reply(`paused for ${mins}m`);
    }

    // !memory — inspect long-term memory
    if (c === '!memory' && msg.guildId) {
      const m = await getMemory(msg.guildId);
      await msg.reply([
        `**facts (${m.facts.length}):** ${m.facts.slice(-5).join(' | ') || 'none'}`,
        `**corrections (${m.corrections.length}):** ${m.corrections.slice(-5).join(' | ') || 'none'}`,
        `**inside jokes (${m.insideJokes.length}):** ${m.insideJokes.slice(-5).join(' | ') || 'none'}`,
      ].join('\n'));
    }

    // !remember <fact> — manually write a fact
    if (c.startsWith('!remember ') && msg.guildId) {
      await writeFact(msg.guildId, c.slice(10).trim(), 'facts');
      await msg.reply('noted');
    }

    // !forget <bucket> — clear a memory bucket
    if (c.startsWith('!forget ') && msg.guildId) {
      const bucket = c.slice(8).trim() as keyof GlobalMemory;
      if (['facts', 'corrections', 'insideJokes'].includes(bucket)) {
        await db.collection('servers').doc(msg.guildId).collection('memory').doc('global')
          .set({ [bucket]: [] }, { merge: true });
        memCache.delete(msg.guildId);
        await msg.reply(`cleared ${bucket}`);
      }
    }

    // !stm — dump short-term memory for this channel
    if (c === '!stm') {
      const msgs = stmGet(msg.channelId);
      const out  = stmFormat(msgs, Date.now());
      for (const chunk of (out.match(/.{1,1900}/gs) || []).slice(0, 3)) {
        await msg.reply(`\`\`\`\n${chunk}\n\`\`\``);
      }
    }

    // !counter — inspect per-channel msg counter + RPM budget
    if (c === '!counter') {
      const t = msgCounters.get(msg.channelId);
      const windowLeft = t ? Math.round((60_000 - (Date.now() - t.windowStart)) / 1000) : 0;
      await msg.reply(
        `channel: msg ${t?.n ?? 0} in window (resets in ${windowLeft}s)\n` +
        `fires every: ${BRAIN_EVERY_N} msgs\n` +
        `rpm left: ${rpmLeft()}/${RPM_CAP}`
      );
    }

    // NEW v8: !userprofile @user or !userprofile <id> — inspect per-user memory
    if (c.startsWith('!userprofile')) {
      const target = msg.mentions.users.first();
      const uid = target?.id || c.split(' ')[1]?.trim();
      if (!uid) { await msg.reply('usage: !userprofile @user'); return; }
      const p = await getUserProfile(uid);
      await msg.reply([
        `**profile for ${p.displayName || uid}:**`,
        `context: ${p.context || '(none)'}`,
        `facts (${p.facts.length}): ${p.facts.slice(-5).join(' | ') || 'none'}`,
        `relationship notes (${p.relationshipNotes.length}): ${p.relationshipNotes.slice(-5).join(' | ') || 'none'}`,
        `dm channel: ${p.dmChannelId || 'unknown'} | last proactive: ${p.lastProactiveAt ? new Date(p.lastProactiveAt).toLocaleString() : 'never'}`,
      ].join('\n'));
    }

    // NEW v8: !proactive — force-run a proactive cycle now (admin testing)
    if (c === '!proactive') {
      await msg.reply('running proactive cycle...');
      await runProactiveCycle(botClient!);
      await msg.reply('done — check logs');
    }
  });

  await botClient.login(token);
}

export function stopBot() {
  botClient?.destroy();
  botClient = null;
  if (profilerTimer) clearInterval(profilerTimer);
  if (proactiveTimer) clearTimeout(proactiveTimer);
}

export function getBotStatus() { return botClient ? 'running' : 'stopped'; }
