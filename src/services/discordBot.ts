/**
 * NOTABOT — v7 "Full Human"
 *
 * fixes from v6:
 *   FAST = llama-3.1-8b-instant   → 20k TPM vs 70b's 6k TPM  (kills 429s)
 *   brain fires every 3 msgs OR on mention  (not every single message)
 *   global RPM guard: 30 total - 10 reserve = 20 usable/min
 *   <@USER_ID> → @DisplayName resolved everywhere before AI sees it
 *   reply chain: msg.reference fetched → shown as "↳ replying to X: ..." in STM
 *   member roster cached 5 min (not re-fetched per message)
 *   sender data = 1 Firebase read, not 2
 *   hourly STM → long-term notes (separate 1h timer from 15-min profiler)
 *   lean prompts: ~600 tokens/call (was ~1000+)
 *   GuildMemberUpdate: tracks nickname changes in real-time
 *   !counter admin cmd: inspect per-channel msg counter + RPM left
 */

import { Client, GatewayIntentBits, Message, Partials, Events } from 'discord.js';
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
const BRAIN_EVERY_N     = 3;           // fire brain every N non-mention msgs per channel
const MAX_FETCH_HISTORY = 16;          // Discord history fetch on cold start
const SHORT_TERM_MAX    = 50;          // per-channel in-memory message log
const PROFILER_INTERVAL = 15 * 60_000; // 15 min: profile users
const COMPRESS_INTERVAL = 60 * 60_000; // 1 hr: STM → long-term notes
const MEMBER_CACHE_TTL  = 5  * 60_000; // 5 min: member roster cache

// ═══════════════════════════════════════════════════════════════════
// BOT STATE
// ═══════════════════════════════════════════════════════════════════

let botClient: Client | null = null;
let BOT_NAME = 'NotABot';
let BOT_ID   = '';

const debounceTimers = new Map<string, NodeJS.Timeout>();
let profilerTimer: NodeJS.Timeout | null = null;

// ── Per-channel message counter ─────────────────────────────────────────────
// Prevents firing brain on every single message — only every BRAIN_EVERY_N OR on mention.
const msgCounters = new Map<string, { n: number; windowStart: number }>();

function shouldFireBrain(channelId: string, mentioned: boolean): boolean {
  if (mentioned) return true; // always fire on direct ping

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
// ═══════════════════════════════════════════════════════════════════

interface BrainDecision {
  action:     'speak' | 'pause' | 'wait' | 'ignore';
  reply?:     string;
  pauseMins?: number;
  bondDelta?: number;
  newFact?:   string;
  reason:     string;
}

async function brain(
  senderName:  string,
  senderInfo:  string,
  bond:        number,
  message:     string,
  transcript:  string,
  memCtx:      string,
  clock:       string,
  mentioned:   boolean,
  state:       SpeakState,
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

<memory>
${memCtx}
</memory>

<recent_chat>
${transcript}
</recent_chat>

${senderName} (${bondLabel}, bond ${bond}/100${senderInfo ? ` — ${senderInfo}` : ''}) just said: "${message}"
tagged you: ${mentioned ? 'YES — almost always reply' : 'no'}

Output ONLY valid JSON, no markdown, no extra text:
{"action":"speak|pause|wait|ignore","reply":"ur raw reply if speaking","pauseMins":5,"bondDelta":0,"newFact":"anything worth remembering, or empty string","reason":"one line"}`;

  try {
    const raw    = await groq.request(FAST, [
      { role: 'system', content: system },
      { role: 'user',   content: user  },
    ], 0.88, 180);

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
      { role: 'user',   content: `${text}\n\nJSON: {"summary":"brief summary","groupVibe":"one line vibe","insideJokes":["x"],"facts":["x"]}` },
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
            }
          } catch {} // channel might not be accessible
        }
      }
      // Invalidate member roster cache so next message pick gets fresh data
      memberRosterCache.clear();
      console.log(`[Profiler] cycle done | ${groq.available()} daily reqs left | ${rpmLeft()} RPM left`);
    } catch (e) { console.error('[Profiler] error:', e); }
  }, PROFILER_INTERVAL);
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
    const mentioned = BOT_ID ? msg.mentions.has(BOT_ID) : false;
    const sender    = msg.member?.displayName || msg.author.username;
    const msgClean  = cleanContent(msg.content);

    // Keep id→name cache populated on every message
    cacheId(msg.author.id, sender);

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
    if (!shouldFireBrain(channelId, mentioned)) return;

    // ── Debounce: collapse rapid-fire messages into one brain call ────
    if (debounceTimers.has(channelId)) clearTimeout(debounceTimers.get(channelId)!);

    const debounce = mentioned ? 200 : DEBOUNCE_MS;
    const timer    = setTimeout(async () => {
      debounceTimers.delete(channelId);

      try {
        // ── Speak state check ─────────────────────────────────────────
        const state = await getSpeakState(channelId, guildId);

        // Hard skip if paused and not mentioned
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
        const [memberData, memory, allMembers] = await Promise.all([
          isGuild ? getMember(guildId, msg.author.id) : Promise.resolve({}),
          isGuild ? getMemory(guildId)                : Promise.resolve({ facts: [], corrections: [], insideJokes: [] } as GlobalMemory),
          isGuild ? getAllMembers(guildId)             : Promise.resolve([]),
        ]);

        const bond    = typeof memberData.bond === 'number' ? memberData.bond : 50;
        const profile = [memberData.personality, memberData.vibes].filter(Boolean).join(' | ');

        const nowMs      = Date.now();
        const msgs       = stmGet(channelId);
        const transcript = stmFormat(msgs, nowMs);
        const memCtx     = memToPrompt(memory, allMembers);
        const clock      = clockContext(msgs, state);

        // ── BRAIN: decides action + generates reply ───────────────────
        const decision = await brain(
          sender, profile, bond,
          msgClean, transcript, memCtx, clock,
          mentioned, state,
        );

        console.log(`[Brain] ${sender}: ${decision.action} | "${decision.reason}"`);

        // ── Apply decision ────────────────────────────────────────────
        switch (decision.action) {

          case 'speak': {
            const text = (decision.reply || '').trim()
              .replace(/^["']|["']$/g, '')                          // strip surrounding quotes
              .replace(new RegExp(`^${BOT_NAME}:\\s*`, 'i'), '')   // strip name prefix if model adds it
              .split('\n')[0]                                       // first line only
              .slice(0, 200);

            if (!text) { console.log('[Brain] speak → empty reply'); break; }

            // Simulate human typing delay
            const typingMs = Math.min(400 + text.length * 22, 3000);
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
            break;
          }

          case 'wait': {
            await setSpeakState(channelId, guildId, { mode: 'waiting', reason: decision.reason });
            if (isGuild && decision.newFact) await writeFact(guildId, decision.newFact, 'corrections');
            break;
          }

          case 'ignore':
          default:
            if (isGuild && decision.newFact) writeFact(guildId, decision.newFact, 'facts').catch(() => {});
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
║  ✓ ${BOT_NAME} online — v7 Full Human
║  • ID: ${BOT_ID}
║  • Keys: ${groq.allStats().length}  |  Avail: ${groq.available()} daily reqs
║  • Fast: ${FAST}
║  • Deep: ${DEEP}
║  • Brain: every ${BRAIN_EVERY_N} msgs or on mention
║  • RPM budget: ${RPM_CAP} usable / 30 total
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
  });

  await botClient.login(token);
}

export function stopBot() {
  botClient?.destroy();
  botClient = null;
  if (profilerTimer) clearInterval(profilerTimer);
}

export function getBotStatus() { return botClient ? 'running' : 'stopped'; }
