import {
  Client, GatewayIntentBits, Message, Partials,
  Events, TextChannel,
} from 'discord.js';
import { db } from './firebase.ts';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// ── MODELS ───────────────────────────────────────────────────────
const BRAIN_MODEL = 'gemma-4-26b-a4b-it';  // MoE — main responses
const BG_MODEL    = 'gemma-4-31b-it';       // Background jobs + history logging

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

  async call(
    systemPrompt: string,
    userPrompt: string,
    temp = 0.9,
    maxTok = 600,
    model = BRAIN_MODEL,
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
        console.log(`[Gemini:${model.split('-')[2]}] key=...${key.slice(-4)} | ${text.length}ch`);
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

// ── CONSTANTS ────────────────────────────────────────────────────
const DEBOUNCE_MS          = 3500;
const DM_DEBOUNCE_MS       = 1000;
const STM_MAX              = 20;       // show bot more context
const GAP_MAJOR_MS         = 25 * 60_000;
const GAP_MINOR_MS         =  5 * 60_000;
const PASSIVE_EVERY        = 5;
const PASSIVE_EVERY_BUSY   = 9;
const ACTIVE_MINS          = 8;
const VELOCITY_WINDOW_MS   = 10_000;
const VELOCITY_THRESH      = 5;
const MONOPOLY_N           = 5;
const MONOPOLY_COOLDOWN_MS = 90_000;
const PROFILER_INTERVAL    = 25 * 60_000;
const COMPRESS_INTERVAL    = 60 * 60_000;
const PROACTIVE_INTERVAL   = 40 * 60_000;
const MIN_BRAIN_GAP_MS     = 2000;
const PAUSE_MAX_MINS       = 30;
const HISTORY_LOG_EVERY    = 30;  // log to history every N session-buffer messages
const MAX_TRANSCRIPT_CHARS = 3500;  // bigger ctx — no token limits anymore
const MAX_MEM_CHARS        = 600;
const MAX_HISTORY_CHARS    = 800;

let lastBrainCallAt = 0;
let BOT_NAME  = 'NotABot';
let BOT_ID    = '';
let botClient: Client | null = null;

const lastMonopolyFire = new Map<string, number>();

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
  authorId: string;
  author:   string;
  content:  string;
}

const stmStore = new Map<string, STMsg[]>();
const sessionBuffers = new Map<string, string[]>();
const sessionSummaries = new Map<string, string>();
const SESSION_BUFFER_MAX = 80;

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
  return lines.join('\n').slice(0, MAX_TRANSCRIPT_CHARS);
}

function seedSTM(channelId: string, msgs: Message[]) {
  if (stmStore.has(channelId)) return;
  stmStore.set(channelId, msgs.slice(-STM_MAX).map(m => ({
    ts:       m.createdTimestamp,
    authorId: m.author.id,
    author:   m.author.id === BOT_ID ? '[me]' : (m.member?.displayName || m.author.username),
    content:  (() => { const c = cleanContent(m.content); return c.length > 150 ? c.slice(0, 147) + '…' : c; })(),
  })));
}

// ── MOOD / SPEAK STATE ────────────────────────────────────────────
interface Mood { mode: 'active' | 'passive'; until?: number; count: number; }
const moods = new Map<string, Mood>();

interface SpeakState { mode: 'active' | 'paused' | 'waiting'; resumeAt?: number; reason: string; }
const speakStates = new Map<string, SpeakState>();

function getMood(channelId: string): Mood {
  let m = moods.get(channelId) ?? { mode: 'passive', count: 0 };
  if (m.mode === 'active' && m.until && Date.now() >= m.until) {
    m = { mode: 'passive', count: 0 };
    moods.set(channelId, m);
  }
  return m;
}

function goActive(channelId: string, mins = ACTIVE_MINS, reason = '') {
  moods.set(channelId, { mode: 'active', until: Date.now() + mins * 60_000, count: 0 });
  console.log(`[Mood] #${channelId.slice(-5)} active ${mins}m${reason ? ` — ${reason}` : ''}`);
}

function goPassive(channelId: string) {
  moods.set(channelId, { mode: 'passive', count: 0 });
}

function moodTick(channelId: string, authorId: string, mentioned: boolean, isDM: boolean): boolean {
  if (isDM || mentioned) return true;

  const msgs = stmGet(channelId);
  if (msgs.length > 0) {
    const gap = Date.now() - msgs[msgs.length - 1].ts;
    if (gap > 8 * 60_000) { goActive(channelId, ACTIVE_MINS, `${Math.round(gap / 60_000)}m idle gap`); return true; }
  }

  // Monopoly check — one person going off, bot should butt in
  if (msgs.length >= MONOPOLY_N) {
    const recent = msgs.slice(-MONOPOLY_N);
    const authors = new Set(recent.map(m => m.authorId).filter(id => id !== BOT_ID));
    if (authors.size === 1 && [...authors][0] === authorId) {
      const now = Date.now();
      const last = lastMonopolyFire.get(channelId) ?? 0;
      if (now - last > MONOPOLY_COOLDOWN_MS) {
        lastMonopolyFire.set(channelId, now);
        return true;
      }
    }
  }

  const m = getMood(channelId);
  if (m.mode === 'active') return true;

  m.count++;
  moods.set(channelId, m);
  const cutoff = Date.now() - VELOCITY_WINDOW_MS;
  const vel = stmGet(channelId).filter(x => x.ts >= cutoff && x.authorId !== BOT_ID).length;
  const every = vel > VELOCITY_THRESH ? PASSIVE_EVERY_BUSY : PASSIVE_EVERY;
  return m.count % every === 0;
}

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

// ── FOCUS STATE ───────────────────────────────────────────────────
interface FocusState { channelId: string; since: number; }
let focus: FocusState | null = null;
const FOCUS_DRIFT_MS   = 12 * 60_000;
const FOCUS_SHIFT_COST = 45_000;
let lastFocusShift = 0;
const unreadCounts = new Map<string, number>();

function checkFocus(channelId: string, mentioned: boolean): boolean {
  const now = Date.now();
  if (focus?.channelId === channelId) { focus.since = now; return true; }
  if (!focus) { focus = { channelId, since: now }; unreadCounts.delete(channelId); return true; }

  const focusExpired = now - focus.since > FOCUS_DRIFT_MS;
  if (focusExpired) {
    console.log(`[Focus] drift → #${channelId.slice(-5)}`);
    focus = { channelId, since: now };
    unreadCounts.delete(channelId);
    lastFocusShift = now;
    return true;
  }
  if (mentioned && now - lastFocusShift > FOCUS_SHIFT_COST) {
    console.log(`[Focus] ping pulled → #${channelId.slice(-5)}`);
    focus = { channelId, since: now };
    unreadCounts.delete(channelId);
    lastFocusShift = now;
    return true;
  }
  unreadCounts.set(channelId, (unreadCounts.get(channelId) ?? 0) + 1);
  return false;
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
  from:      number;  // timestamp ms
  to:        number;
  fromStr:   string;  // human readable
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
  if (!delta || guildId === 'dm') return;
  const m = await getMember(guildId, userId);
  const cur = typeof m.bond === 'number' ? m.bond : 50;
  await upsertMember(guildId, userId, { bond: Math.max(0, Math.min(100, cur + delta)) });
}

// ── HISTORY LOGGING (BG model logs summaries with timestamps) ─────
// 31b periodically digests the session buffer into a time-stamped summary.
// Brain (26b) can request these via the command system.
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
      text,
      0.3,
      120,
      BG_MODEL,
    );
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return;
    const p = JSON.parse(m[0]);
    if (!p.s?.trim()) return;

    const log: HistoryLog = {
      from:      firstTs,
      to:        lastTs,
      fromStr:   new Date(firstTs).toLocaleString(),
      toStr:     new Date(lastTs).toLocaleString(),
      summary:   p.s.trim(),
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

// ── COMMAND EXECUTION ─────────────────────────────────────────────
// Bot's JSON output can include "command" and "commandArgs".
// System runs it and feeds the result back to the brain for a final reply.

type BotCommand = 'get_history' | 'get_member' | 'get_stm' | 'none';

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
    default:
      return 'unknown command';
  }
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

HOW YOU TEXT:
- lowercase. always. CAPS = screaming only.
- 1-10 words is the sweet spot. one word is valid. trailing off is valid...
- no periods on short msgs. contractions: im dont ur idk ngl rn tbh wtf lmao fr istg
- zero assistant energy — never "happy to help" "great question" "certainly"
- "bro" "fr" "ngl" "cope" "based" "skill issue" "actually insane" "wait" "no bc"
- occasional typo is fine. teh, waht, jsut. not constantly.
- if something deserves no words: one emoji as full response. valid.

UNDERSTANDING PRONOUNS (critical):
- someone says "you/ur/your" → they mean YOU (NotABot)
- someone says "i/me/my/mine" → they mean THEMSELVES
- "he/she/they" in a reply thread → probably refers to the person being replied to
- if someone says "your project" or "you did X" → they're talking about NotABot's thing
- if someone says "my project" or "i did X" → that belongs to them, not you
- NEVER absorb other people's traits, projects, or drama as your own

BEING SOCIAL BUT NOT ANNOYING:
- engage when there's actually something to engage with
- if you already replied twice and the person said "ok" "lol" "yeah" "same" → that's a wind-down, go quiet
- do NOT send unprompted messages multiple times in a row with no response between them — that's you talking to yourself
- a reaction emoji is often better than typing something
- if chat is clearly a private convo between two people → stay out
- when in doubt: lurk. you can always react.

THINKING OUT LOUD (when memory is involved):
- if someone says "don't you remember i told you X" or you want to recall something → output a thinking message like "hm lemme think" or "wait" and run a get_history or get_stm command
- be natural about it, not robotic. "hm" is enough. don't announce you're running a command.

SELF-PACING:
- after a run of 2-3 replies, judge if the convo wound down. if yes, set pause 5-15 mins.
- never set pause:0 out of obligation. only speak if you actually have something.
- 0 = no pause, 1-30 = minutes to go quiet

CALLBACKS + OPEN LOOPS:
- if memory has someone's unfinished story, ask casually. not investigatively.
- callbacks: rare, vague, never quote private stuff
- if something is someone else's drama/project, keep it attached to them

COMMANDS YOU CAN RUN (include in JSON when needed, leave "none" otherwise):
- get_history: retrieve chat summaries from a time range. args: { from: "ISO string", to: "ISO string" }
- get_member: get info about someone. args: { name: "display name" }
- get_stm: get the full recent chat transcript
system will run the command and send you the result. you then give your actual reply.

in transcripts: [me] = your own past messages

CRITICAL OUTPUT RULE: respond with RAW JSON ONLY. first character must be "{", last character must be "}". no markdown fences, no bullet points, no reasoning, no "* User:" breakdowns, no commentary before or after. just the object:
{
  "action": "speak|react|ignore",
  "reply": "your message here (empty if not speak)",
  "reaction": "single emoji or empty string",
  "pause": 0,
  "think": "short visible thinking message, or empty string — sent to chat BEFORE you run a command",
  "command": "get_history|get_member|get_stm|none",
  "commandArgs": {}
}`;

// ── BRAIN ─────────────────────────────────────────────────────────
interface BrainDecision {
  action:      'speak' | 'react' | 'ignore';
  reply:       string;
  reaction:    string;
  pause:       number;
  think:       string;
  command:     BotCommand;
  commandArgs: Record<string, any>;
}

function parseBrainJSON(raw: string): BrainDecision | null {
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const p = JSON.parse(m[0]);
    return {
      action:      (['speak', 'react', 'ignore'] as const).includes(p.action) ? p.action : 'ignore',
      reply:       typeof p.reply    === 'string' ? p.reply.trim().replace(/^["']|["']$/g, '') : '',
      reaction:    sanitizeEmoji(p.reaction),
      pause:       typeof p.pause    === 'number' ? Math.min(Math.max(0, Math.round(p.pause)), PAUSE_MAX_MINS) : 0,
      think:       typeof p.think    === 'string' ? p.think.trim() : '',
      command:     (['get_history','get_member','get_stm','none'] as const).includes(p.command) ? p.command : 'none',
      commandArgs: p.commandArgs && typeof p.commandArgs === 'object' ? p.commandArgs : {},
    };
  } catch { return null; }
}

async function brain(opts: {
  sender:      string;
  bond:        number;
  message:     string;
  transcript:  string;
  thread?:     string;
  memCtx:      string;
  historyCtx?: string;
  mentioned:   boolean;
  isDM:        boolean;
  mood:        Mood;
  speakState:  SpeakState;
  inExchange:  boolean;
  channelName: string;
  serverName?: string;
  everyonePing:boolean;
  endingConvo: boolean;
  // Second-pass only (command result fed back)
  commandResult?: string;
  isSecondPass?:  boolean;
}): Promise<BrainDecision> {

  const bondLabel = opts.bond > 70 ? 'close' : opts.bond > 40 ? 'neutral' : 'distant';
  const moodLine  = opts.mood.mode === 'active' && opts.mood.until
    ? `active (${Math.round((opts.mood.until - Date.now()) / 60_000)}m left)`
    : opts.mood.mode;

  const parts: string[] = [
    `mood: ${moodLine} | speak: ${opts.speakState.mode} | server: ${opts.serverName || 'unknown'} | channel: #${opts.channelName}`,
  ];

  if (opts.memCtx)        parts.push(`\nSERVER MEMORY:\n${opts.memCtx.slice(0, MAX_MEM_CHARS)}`);
  if (opts.historyCtx)    parts.push(`\nHISTORY LOGS (archived summaries):\n${opts.historyCtx.slice(0, MAX_HISTORY_CHARS)}`);
  if (opts.thread)        parts.push(`\nREPLY TO:\n${opts.thread}`);
  parts.push(`\nCHAT (recent):\n${opts.transcript}`);

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

  // Try up to 2 times — Gemini occasionally rambles/truncates instead of emitting clean JSON.
  for (let pass = 0; pass < 2; pass++) {
    try {
      const raw = await gemini.call(
        SYSTEM_PROMPT,
        pass === 0 ? userPrompt : `${userPrompt}\n\n(previous attempt failed to return valid JSON — output RAW JSON ONLY, nothing else)`,
        0.92,
        700,
        BRAIN_MODEL,
      );
      console.log(`[Brain] raw: ${raw.slice(0, 200)}`);
      const parsed = parseBrainJSON(raw);
      if (parsed) return parsed;
      console.warn(`[Brain] parse failed on pass ${pass + 1}`);
    } catch (e: any) {
      console.warn(`[Brain] call error on pass ${pass + 1}:`, e.message?.slice(0, 80));
    }
  }

  return (opts.mentioned || opts.isDM)
    ? { action: 'speak', reply: 'brain blipped', reaction: '', pause: 0, think: '', command: 'none', commandArgs: {} }
    : { action: 'ignore', reply: '', reaction: '', pause: 0, think: '', command: 'none', commandArgs: {} };
}

function sanitizeEmoji(raw: any): string {
  if (typeof raw !== 'string') return '';
  const e = raw.trim();
  if (!e || e.length > 8) return '';
  const RE = /^(\p{Extended_Pictographic}|\p{Emoji_Presentation})(\uFE0F|\u200D(\p{Extended_Pictographic}|\p{Emoji_Presentation}))*$/u;
  return RE.test(e) ? e : '';
}

// ── EXECUTE BRAIN DECISION (handles think + command pipeline) ─────
async function executeBrainDecision(opts: {
  decision:    BrainDecision;
  msg:         Message;
  sender:      string;
  bond:        number;
  content:     string;
  transcript:  string;
  thread?:     string;
  memCtx:      string;
  historyCtx?: string;
  mentioned:   boolean;
  isDM:        boolean;
  mood:        Mood;
  speakState:  SpeakState;
  inExchange:  boolean;
  channelName: string;
  serverName?: string;
  everyonePing:boolean;
  endingConvo: boolean;
  channelId:   string;
  guildId:     string;
}): Promise<BrainDecision> {

  let { decision } = opts;

  // Send thinking message if requested
  if (decision.think?.trim() && decision.command !== 'none') {
    const thinkText = decision.think.trim().slice(0, 100);
    try {
      await opts.msg.channel.sendTyping();
      await sleep(300 + thinkText.length * 15);
      await opts.msg.reply({ content: thinkText, allowedMentions: { repliedUser: false } });
      stmPush(opts.channelId, { ts: Date.now(), authorId: BOT_ID, author: '[me]', content: thinkText });
    } catch {}
  }

  // Run command if requested
  if (decision.command !== 'none') {
    const result = await executeCommand(decision.command, decision.commandArgs, opts.channelId, opts.guildId);
    console.log(`[Command:${decision.command}] result: ${result.slice(0, 80)}`);

    // Second pass — feed result back to brain
    decision = await brain({
      ...opts,
      commandResult: result,
      isSecondPass:  true,
    });
  }

  return decision;
}

// ── BUILD MEMORY CONTEXT ──────────────────────────────────────────
async function buildMemCtx(guildId: string): Promise<string> {
  if (guildId === 'dm') return '';
  const m = await getMemory(guildId);
  const lines: string[] = [];
  if (m.openLoops.length) lines.push(`open loops: ${m.openLoops.slice(-4).join(' | ')}`);
  if (m.arcs.length)      lines.push(`arcs: ${m.arcs.slice(-3).join(' | ')}`);
  if (m.jokes.length)     lines.push(`server lore: ${m.jokes.slice(-3).join(' | ')}`);
  if (m.patterns.length)  lines.push(`patterns: ${m.patterns.slice(-3).join(' | ')}`);
  if (m.facts.length)     lines.push(`facts: ${m.facts.slice(-3).join(' | ')}`);
  return lines.join('\n');
}

// ── BACKGROUND JOBS ───────────────────────────────────────────────
let bgLock       = false;
let lastProfile  = 0;
let lastCompress = 0;
let lastProactive = 0;

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
                0.4, 60, BG_MODEL,
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
        text,
        0.4, 200, BG_MODEL,
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

    // Session summary
    const buf = sessionBuffers.get(channelId);
    if (!buf || buf.length < 10) return;
    const bufText = buf.join('\n').slice(-2500);
    try {
      const raw2 = await gemini.call(
        'summarize this discord chat in 2-3 sentences: main topics, who said what, mood/vibe. concise. output ONLY: {"s":"..."}',
        bufText, 0.3, 100, BG_MODEL,
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

async function runProactive(client: Client) {
  if (Date.now() - lastProactive < PROACTIVE_INTERVAL) return;
  if (!gemini.canCall()) return;
  lastProactive = Date.now();

  await withBgBudget(async () => {
    const now = Date.now();
    const candidates: { id: string; hint: string; guildId: string }[] = [];

    for (const [channelId, msgs] of stmStore.entries()) {
      if (!msgs.length) continue;

      // CRITICAL: never send proactive if last message was from the bot
      // (prevents bot talking to itself endlessly)
      const lastMsg = msgs[msgs.length - 1];
      if (lastMsg.authorId === BOT_ID) continue;

      const ch = client.channels.cache.get(channelId) as TextChannel | undefined;
      const guildId = (ch as any)?.guildId as string | undefined;
      if (!guildId || !ch?.isTextBased()) continue;

      const guildName = (ch as any)?.guild?.name || serverNameCache.get(guildId) || 'unknown';
      const channelName = (ch as any)?.name || channelId.slice(-5);
      const idle = now - lastMsg.ts;

      // Only proactive if chat has been human-active but quiet for 15-90 mins
      if (idle < 15 * 60_000 || idle > 90 * 60_000) continue;

      // Need at least 3 recent human messages for context
      const recentHuman = msgs.slice(-10).filter(m => m.authorId !== BOT_ID);
      if (recentHuman.length < 3) continue;

      candidates.push({
        id: channelId,
        guildId,
        hint: `server: ${guildName}. channel: #${channelName}. quiet ${Math.round(idle / 60_000)}m. last: "${lastMsg.content.slice(0, 60)}"`,
      });
    }

    if (!candidates.length) return;
    const pick = candidates[Math.floor(Math.random() * Math.min(candidates.length, 4))];
    const ch = client.channels.cache.get(pick.id) as TextChannel | undefined;
    if (!ch?.isTextBased()) return;

    // Skip if sensitive tone
    const lastMsg = stmGet(pick.id)[stmGet(pick.id).length - 1];
    if (/\b(sorry|rip|died?|grief|depress|sad|hurt|loss|broke up|suicide)\b/i.test(lastMsg?.content || '')) return;

    try {
      const mem = await getMemory(pick.guildId);
      const memHint = [
        mem.openLoops.length ? `open loops: ${mem.openLoops.slice(-2).join(' | ')}` : '',
        mem.arcs.length      ? `arcs: ${mem.arcs.slice(-2).join(' | ')}` : '',
        mem.jokes.length     ? `server lore: ${mem.jokes.slice(-2).join(' | ')}` : '',
      ].filter(Boolean).join('\n');

      const modes = [
        'quiet bored opener',
        'revive an open loop or unfinished story',
        'ask a dumb debate question',
        'share an unsolicited weird thought',
        'one-line observation about the server',
      ];
      const mode = modes[Math.floor(Math.random() * modes.length)];

      const raw = await gemini.call(
        `you are ${BOT_NAME}, a server regular. send ONE short casual message to break silence. lowercase. no needy opener. do not start with "hey" or "hello". output ONLY valid JSON: {"skip":false,"msg":"..."}`,
        `mode: ${mode}\nchannel: ${pick.hint}\nmemories:\n${memHint || '(none)'}\nrecent chat:\n${stmFormat(stmGet(pick.id)).slice(-800)}`,
        0.97, 120, BG_MODEL,
      );
      const m = raw.match(/\{[\s\S]*\}/);
      if (!m) return;
      const p = JSON.parse(m[0]);
      if (p.skip || !p.msg?.trim()) return;

      const text = p.msg.trim().slice(0, 150);
      await ch.sendTyping().catch(() => {});
      await sleep(Math.min(400 + text.length * 20, 2500));
      await ch.send(text);
      stmPush(pick.id, { ts: Date.now(), authorId: BOT_ID, author: '[me]', content: text });
      goActive(pick.id, 4, 'proactive');
      console.log(`[Proactive] #${pick.id.slice(-5)}: "${text.slice(0, 50)}"`);
    } catch {}
  });
}

// ── TOOL ANSWERS (fast, no LLM needed) ───────────────────────────
async function tryToolAnswer(msg: Message, content: string, guildId: string, sender: string): Promise<boolean> {
  const lower = content.toLowerCase();
  let answer = '';

  if (/\b(what time|time is it|current time)\b/i.test(lower)) {
    answer = `${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}. suspicious hour behavior`;
  } else if (/\b(last seen|seen me|have you seen me|how long ago)\b/i.test(lower)) {
    const uid = msg.mentions.users.first()?.id || msg.author.id;
    const m = await getMember(guildId, uid);
    const name = idCache.get(uid) || sender;
    answer = m.lastSeenAt
      ? `${name}: last seen ${humanDuration(Date.now() - Date.parse(m.lastSeenAt))}. ${m.seenCount ?? 1} sightings`
      : `${name}: no clean sighting yet`;
  }

  if (!answer) return false;
  await msg.reply({ content: answer.slice(0, 200), allowedMentions: { repliedUser: false } });
  stmPush(msg.channelId, { ts: Date.now(), authorId: BOT_ID, author: '[me]', content: answer.slice(0, 100) });
  return true;
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
    ts:       msg.createdTimestamp,
    authorId: msg.author.id,
    author:   sender,
    content:  content.length > 150 ? content.slice(0, 147) + '…' : content,
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
      threadCtx = `${ref.author.id === BOT_ID ? BOT_NAME : ref.author.username}: "${cleanContent(ref.content).slice(0, 150)}"`;
    } catch {}
  }

  const recentMsgs  = stmGet(channelId).slice(-8);
  const botReplied  = recentMsgs.some(m => m.authorId === BOT_ID);
  const senderCount = recentMsgs.filter(m => m.authorId === msg.author.id).length;
  const inExchange  = botReplied && senderCount >= 2;
  const endingConvo = /\b(bye|cya|gotta go|gtg|see ya|later|good night|gn|logging off|ttyl|im out)\b/i.test(content);

  lastBrainCallAt = Date.now();

  let decision = await brain({
    sender, bond: 50, message: content,
    transcript: stmFormat(stmGet(channelId)),
    thread: threadCtx, memCtx: '',
    mentioned: true, isDM: true,
    mood: { mode: 'active', count: 0 },
    speakState: { mode: 'active', reason: 'dm' },
    inExchange, channelName: 'DM', serverName: 'DM',
    everyonePing: false, endingConvo,
  });

  decision = await executeBrainDecision({
    decision, msg, sender, bond: 50, content,
    transcript: stmFormat(stmGet(channelId)),
    thread: threadCtx, memCtx: '',
    mentioned: true, isDM: true,
    mood: { mode: 'active', count: 0 },
    speakState: { mode: 'active', reason: 'dm' },
    inExchange, channelName: 'DM', serverName: 'DM',
    everyonePing: false, endingConvo,
    channelId, guildId: 'dm',
  });

  if (decision.reaction) msg.react(decision.reaction).catch(() => {});

  if (decision.action === 'speak' && decision.reply?.trim()) {
    const text = decision.reply.trim().slice(0, 200);
    try { await msg.channel.sendTyping(); } catch {}
    await sleep(Math.min(300 + text.length * 20, 2800));
    await msg.reply({ content: text, allowedMentions: { repliedUser: false } });
    stmPush(channelId, { ts: Date.now(), authorId: BOT_ID, author: '[me]', content: text });
  }
}

// ── GUILD MESSAGE HANDLER ─────────────────────────────────────────
const debounceTimers  = new Map<string, NodeJS.Timeout>();
const pendingTriggers = new Map<string, { msg: Message; mentioned: boolean; guildId: string; everyonePing: boolean }>();

async function handleMessage(msg: Message) {
  if (msg.partial) {
    try { msg = await msg.fetch(); } catch { return; }
  }
  if (msg.author.bot || !msg.content?.trim()) return;
  if (msg.channel.isDMBased()) return handleDirectMessage(msg);

  try {
    const guildId     = msg.guildId!;
    const channelId   = msg.channelId;
    const mentioned   = BOT_ID ? msg.mentions.has(BOT_ID) : false;
    const sender      = msg.member?.displayName || msg.author.username;
    const content     = cleanContent(msg.content);
    const channelName = (msg.channel as any).name ?? 'unknown';

    cacheId(msg.author.id, sender);
    notePlaceSeen(guildId, msg.guild?.name, channelId, channelName).catch(() => {});
    noteMemberSeen(guildId, msg.author.id, sender, msg.author.username).catch(() => {});

    if (mentioned && await tryToolAnswer(msg, content, guildId, sender)) return;

    stmPush(channelId, {
      ts:       msg.createdTimestamp,
      authorId: msg.author.id,
      author:   sender,
      content:  content.length > 150 ? content.slice(0, 147) + '…' : content,
    });

    // Log history periodically via BG model
    maybeLogHistory(channelId, guildId).catch(() => {});

    if (!checkFocus(channelId, mentioned)) return;
    if (!moodTick(channelId, msg.author.id, mentioned, false)) {
      console.log(`[Mood] #${channelId.slice(-5)} passive skip`);
      return;
    }
    if (!gemini.canCall()) {
      console.log(`[Budget] Gemini unavailable${mentioned ? ' (mention!)' : ''}`);
      if (!mentioned) return;
    }
    if (!mentioned && Date.now() - lastBrainCallAt < MIN_BRAIN_GAP_MS) {
      console.log('[Pace] too soon since last brain call');
      return;
    }

    const prevTrigger        = pendingTriggers.get(channelId);
    const effectiveMentioned = mentioned || (prevTrigger?.mentioned ?? false);
    const everyonePing       = msg.mentions.everyone ?? false;

    pendingTriggers.set(channelId, {
      msg, mentioned: effectiveMentioned, guildId,
      everyonePing: everyonePing || (prevTrigger?.everyonePing ?? false),
    });

    if (debounceTimers.has(channelId)) clearTimeout(debounceTimers.get(channelId)!);

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
      const tServerName  = tMsg.guild?.name || serverNameCache.get(tGuild) || 'unknown';
      cacheServerName(tGuild, tServerName);
      cacheChannelName(tChannel, tChannelName);

      try {
        const speakState = await getSpeakState(tChannel, tGuild);
        if (speakState.mode === 'paused' && speakState.resumeAt && Date.now() < speakState.resumeAt && !tMentioned) {
          console.log(`[Speak] paused — skip`);
          return;
        }

        if (await tryToolAnswer(tMsg, tContent, tGuild, tSender)) return;

        if (!stmStore.has(tChannel)) {
          try {
            const fetched = await tMsg.channel.messages.fetch({ limit: STM_MAX });
            seedSTM(tChannel, ([...fetched.values()] as Message[]).reverse());
          } catch {}
        }

        let threadCtx: string | undefined;
        if (tMsg.reference?.messageId) {
          try {
            const ref = await tMsg.channel.messages.fetch(tMsg.reference.messageId);
            const refAuthor = ref.author.id === BOT_ID ? BOT_NAME : (ref.member?.displayName || ref.author.username);
            threadCtx = `${refAuthor}: "${cleanContent(ref.content).slice(0, 150)}"`;
          } catch {}
        }

        const [memberData, memCtx] = await Promise.all([
          getMember(tGuild, tMsg.author.id),
          buildMemCtx(tGuild),
        ]);

        const bond       = typeof memberData.bond === 'number' ? memberData.bond : 50;
        const mood       = getMood(tChannel);
        const transcript = stmFormat(stmGet(tChannel));

        const recentMsgs  = stmGet(tChannel).slice(-8);
        const botReplied  = recentMsgs.some(m => m.authorId === BOT_ID);
        const senderCount = recentMsgs.filter(m => m.authorId === tMsg.author.id).length;
        const inExchange  = botReplied && senderCount >= 2;
        const endingConvo = /\b(bye|cya|gotta go|gtg|see ya|later|good night|gn|logging off|ttyl|im out)\b/i.test(tContent);

        lastBrainCallAt = Date.now();

        let decision = await brain({
          sender: tSender, bond, message: tContent, transcript,
          thread: threadCtx, memCtx,
          mentioned: tMentioned, isDM: false, mood, speakState,
          inExchange, channelName: tChannelName, serverName: tServerName,
          everyonePing: tEveryonePing, endingConvo,
        });

        console.log(`[Brain] ${tSender}: ${decision.action}${decision.reply ? ` — "${decision.reply.slice(0, 50)}"` : decision.reaction ? ` — ${decision.reaction}` : ''}`);

        decision = await executeBrainDecision({
          decision, msg: tMsg, sender: tSender, bond, content: tContent,
          transcript, thread: threadCtx, memCtx,
          mentioned: tMentioned, isDM: false, mood, speakState,
          inExchange, channelName: tChannelName, serverName: tServerName,
          everyonePing: tEveryonePing, endingConvo,
          channelId: tChannel, guildId: tGuild,
        });

        if (decision.reaction) tMsg.react(decision.reaction).catch(() => {});

        if (decision.action === 'speak' && decision.reply?.trim()) {
          const text = decision.reply.trim().slice(0, 200);
          try { await tMsg.channel.sendTyping(); } catch {}
          await sleep(Math.min(300 + text.length * 20, 2800));
          await tMsg.reply({ content: text, allowedMentions: { repliedUser: false } });
          stmPush(tChannel, { ts: Date.now(), authorId: BOT_ID, author: '[me]', content: text });

          updateBond(tGuild, tMsg.author.id, 1).catch(() => {});
          if (endingConvo) goPassive(tChannel);
          else if (speakState.mode !== 'active')
            setSpeakState(tChannel, tGuild, { mode: 'active', reason: 'spoke' }).catch(() => {});
        }

        if (decision.pause > 0) {
          await setSpeakState(tChannel, tGuild, {
            mode: 'paused', resumeAt: Date.now() + decision.pause * 60_000, reason: 'self-paced',
          });
          goPassive(tChannel);
          console.log(`[Pause] #${tChannel.slice(-5)} self-paced ${decision.pause}m`);
        }

        runCompress(tGuild, tChannel).catch(() => {});

      } catch (e) { console.error('[Handler debounce]', e); }
    }, mentioned ? 350 : DEBOUNCE_MS));

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
║  BRAIN  : ${BRAIN_MODEL}
║  BG     : ${BG_MODEL} (profiler / compress / history / proactive)
║  STATUS : ${gemini.status()}
║  STM    : ${STM_MAX} msgs | Debounce: ${DEBOUNCE_MS}ms | DM: ${DM_DEBOUNCE_MS}ms
║  History log: every ${HISTORY_LOG_EVERY} session msgs
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
      // Warm ID cache from Firebase (past members)
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
    await upsertMember(m.guild.id, m.id, { displayName: m.displayName, username: m.user.username });
  });

  botClient.on(Events.GuildMemberUpdate, async (_, m) => {
    if (m.user.bot) return;
    cacheId(m.id, m.displayName);
    await upsertMember(m.guild.id, m.id, { displayName: m.displayName });
  });

  // ── ADMIN COMMANDS ──────────────────────────────────────────────
  botClient.on(Events.MessageCreate, async (msg) => {
    if (!msg.member?.permissions.has('Administrator') && !msg.member?.permissions.has('ManageMessages')) return;

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
    if (c.startsWith('!active')) {
      const mins = parseInt(c.split(' ')[1] || '') || ACTIVE_MINS;
      goActive(chId, mins, 'admin'); msg.reply(`active ${mins}m`);
    }
    if (c === '!passive') { goPassive(chId); msg.reply('passive mode'); }
    if (c === '!status') {
      const mood  = getMood(chId);
      const speak = await getSpeakState(chId, guildId);
      await msg.reply([
        `mood: ${mood.mode === 'active' && mood.until ? `active (${Math.round((mood.until - Date.now()) / 60_000)}m left)` : `passive (count: ${mood.count})`}`,
        `speak: ${speak.mode}${speak.resumeAt ? ` until ${new Date(speak.resumeAt).toLocaleTimeString()}` : ''}`,
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
    if (c === '!stm') { await msg.reply(`\`\`\`\n${stmFormat(stmGet(chId)).slice(0, 1900)}\n\`\`\``); }
    if (c === '!proactive') { await msg.reply('running...'); await runProactive(botClient!).catch(() => {}); await msg.reply('done'); }
    if (c === '!budget') { await msg.reply(gemini.status()); }
    if (c.startsWith('!who ')) {
      const uid = msg.mentions.users.first()?.id || c.split(' ')[1]?.trim();
      if (!uid) { msg.reply('usage: !who @user'); return; }
      const m = await getMember(guildId, uid);
      await msg.reply(`${m.displayName || uid}\nbond: ${m.bond ?? 50}/100\n${m.personality || '(no profile yet)'}`);
    }
    if (c === '!history') {
      // Show recent history logs for this channel
      const logs = await getHistory(chId, Date.now() - 24 * 60 * 60_000, Date.now());
      await msg.reply(logs.slice(0, 1900) || 'no recent logs');
    }
  });

  await botClient.login(token);
}

export function stopBot() { botClient?.destroy(); botClient = null; }
export function getBotStatus() { return botClient ? 'running' : 'stopped'; }
