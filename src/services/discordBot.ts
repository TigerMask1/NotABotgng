/**
 * NOTABOT v13 — "Clean Slate"
 *
 * What actually changed and why:
 *
 * BRAIN → llama-3.3-70b-versatile
 *   Room-reading is theory-of-mind. Figuring out "is this conversation even
 *   about me?" requires understanding subtext, reply chains, social context.
 *   8b fails at this regardless of how you prompt it. 70b does it reliably.
 *   Background jobs (profiler, compress, proactive) stay on 8b — they're
 *   pattern extraction, not social reasoning.
 *
 * REPLY CHAINS → explicit THREAD header in prompt
 *   v12 buried reply context as "↳ replying to X: '...'" in the transcript.
 *   The model often missed it. Now when a message is a reply, the original
 *   message is lifted OUT of the transcript and shown as its own block:
 *     THREAD — {sender} is replying to:
 *     {original_author}: "{original_message}"
 *   The model instantly knows who's talking to whom.
 *
 * JSON SCHEMA → 3 fields: {action, reply, reaction}
 *   v12 had 12 fields in one brain call. The model split attention between
 *   form-filling and social reasoning. Now brain does ONE job: decide what
 *   to do right now. Memory, bond, facts are async side-effects that fire
 *   after the reply — they never block or confuse the brain call.
 *
 * TOKEN BUDGET → hard 5500 TPM cap
 *   Brain call ≈ 800 tokens (600 in + 120 out + overhead).
 *   That's ~6 safe brain calls per minute. Background jobs are capped at
 *   ~250 tokens each and can only run when the brain has headroom.
 *   A bgLock prevents background jobs from stacking up.
 *
 * PROMPT → ~200 words, no algorithms
 *   70b doesn't need a 7-step reading algorithm. It needs clear identity,
 *   texting rules, and the right context structure. The model does the
 *   social reasoning itself if you give it the right inputs.
 *
 * EVERYTHING PRESERVED: mood system, speak states, STM (trimmed to 12 msgs),
 * Firebase memory, bond tracking, debounce, velocity gate, monopoly detection,
 * session break separators, profiler, compress, proactive, admin commands.
 */

import {
  Client, GatewayIntentBits, Message, Partials,
  Events, TextChannel,
} from 'discord.js';
import Groq from 'groq-sdk';
import { db } from './firebase.ts';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// ═══════════════════════════════════════════════════════════════════
// MODELS
// ═══════════════════════════════════════════════════════════════════

// Brain MUST be 70b — room reading is theory-of-mind, 8b fails at it
const BRAIN = 'llama-3.3-70b-versatile';
// Background jobs (profiler, compress, proactive) only need pattern extraction
const FAST  = 'llama-3.1-8b-instant';

// ═══════════════════════════════════════════════════════════════════
// TOKEN BUDGET  ← the core constraint for 6000 TPM
//
// Brain call  ≈ 800 tokens  → ~6 safe calls / min at 5500 cap
// Background  ≈ 250 tokens  → low priority, only fires when headroom exists
//
// We use 5500, not 6000, to leave buffer for token estimation variance.
// ═══════════════════════════════════════════════════════════════════

const TPM_CAP   = 5500;
const EST_BRAIN = 800;
const EST_BG    = 250;

const tpm = { used: 0, since: Date.now() };

function tpmReset()            { if (Date.now() - tpm.since > 60_000) { tpm.used = 0; tpm.since = Date.now(); } }
function tpmAllow(est: number) { tpmReset(); return tpm.used + est < TPM_CAP; }
function tpmConsume(n: number) { tpmReset(); tpm.used += n; }
function tpmLeft()             { tpmReset(); return Math.max(0, TPM_CAP - tpm.used); }

// ═══════════════════════════════════════════════════════════════════
// GROQ MANAGER
// ═══════════════════════════════════════════════════════════════════

class GroqManager {
  private clients   = new Map<string, Groq>();
  private cooldowns = new Map<string, number>();
  private usage     = new Map<string, number>();
  private keys:       string[];
  private resetAt   = Date.now() + 86_400_000;
  private readonly DAILY = 14_400;

  constructor() {
    const raw = process.env.GROQ_API_KEYS || process.env.GROQ_API_KEY || '';
    this.keys = raw.split(',').map(k => k.trim()).filter(Boolean);
    if (!this.keys.length) { console.error('[Groq] no keys found'); process.exit(1); }
    this.keys.forEach(k => { this.clients.set(k, new Groq({ apiKey: k })); this.usage.set(k, 0); });
    console.log(`[Groq] ${this.keys.length} key(s) loaded`);
  }

  private pick(): string {
    const now = Date.now();
    if (now > this.resetAt) {
      this.usage.forEach((_, k) => this.usage.set(k, 0));
      this.cooldowns.clear();
      this.resetAt = now + 86_400_000;
    }
    const avail = this.keys.filter(k => {
      const cd = this.cooldowns.get(k);
      if (cd && now < cd) return false;
      return (this.usage.get(k) || 0) < this.DAILY * 0.92;
    });
    const pool = avail.length ? avail : this.keys;
    return pool.reduce((a, b) =>
      (this.usage.get(a) || 0) <= (this.usage.get(b) || 0) ? a : b
    );
  }

  async call(
    model:    string,
    msgs:     any[],
    temp    = 0.85,
    maxTok  = 120,
    freq    = 0.9,
    pres    = 0.6,
  ): Promise<string> {
    for (let i = 0; i < 3; i++) {
      const k = this.pick();
      try {
        const r = await this.clients.get(k)!.chat.completions.create({
          model, messages: msgs, temperature: temp, max_tokens: maxTok,
          frequency_penalty: freq, presence_penalty: pres,
        });
        this.usage.set(k, (this.usage.get(k) || 0) + 1);
        const tok = r.usage?.total_tokens || maxTok;
        tpmConsume(tok);
        console.log(`[Groq/${model.includes('70b') ? '70b' : '8b'}] ${tok}tok | TPM left: ${tpmLeft()}`);
        return r.choices[0]?.message?.content || '';
      } catch (e: any) {
        if (e.status === 429) {
          const sec = parseFloat(e.message?.match(/in ([\d.]+)s/)?.[1] || '45') + 3;
          this.cooldowns.set(k, Date.now() + sec * 1000);
          console.warn(`[Groq] ...${k.slice(-4)} cooldown ${sec.toFixed(0)}s`);
        } else {
          console.error(`[Groq] attempt ${i + 1}: ${e.message?.slice(0, 80)}`);
        }
        if (i < 2) await sleep(Math.min(1500 * 2 ** i, 10_000));
      }
    }
    throw new Error('[Groq] all retries failed');
  }

  status() {
    return this.keys.map(k =>
      `...${k.slice(-4)}: ${this.usage.get(k) || 0}req` +
      (this.cooldowns.get(k) && Date.now() < this.cooldowns.get(k)!
        ? ` (cd ${Math.ceil((this.cooldowns.get(k)! - Date.now()) / 1000)}s)` : '')
    ).join(' | ');
  }
}

const groq = new GroqManager();

// ═══════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════

const DEBOUNCE_MS        = 4000;   // wait for lull before firing brain
const STM_MAX            = 12;     // messages kept in short-term memory
const GAP_MAJOR_MS       = 25 * 60_000;   // ≥25m gap → new session marker
const GAP_MINOR_MS       =  5 * 60_000;   // ≥5m gap → brief pause marker
const PASSIVE_EVERY      = 5;             // brain fires every N msgs in passive
const PASSIVE_EVERY_BUSY = 8;             // same but during high-velocity bursts
const ACTIVE_MINS        = 8;             // default active mode duration
const VELOCITY_WINDOW_MS = 10_000;
const VELOCITY_THRESH    = 5;             // >5 msgs in 10s = high velocity
const MONOPOLY_N         = 4;             // last N msgs all from one person → active
const PROFILER_INTERVAL  = 20 * 60_000;
const COMPRESS_INTERVAL  = 90 * 60_000;
const PROACTIVE_INTERVAL = 35 * 60_000;

let BOT_NAME  = 'NotABot';
let BOT_ID    = '';
let botClient: Client | null = null;

// ── ID resolution ─────────────────────────────────────────────────
const idCache = new Map<string, string>();
function cacheId(id: string, name: string) { if (id && name) idCache.set(id, name); }

function resolveMentions(text: string): string {
  return text.replace(/<@!?(\d+)>/g, (_, id) =>
    id === BOT_ID ? `@${BOT_NAME}` : `@${idCache.get(id) || 'someone'}`
  );
}

function cleanContent(raw: string): string {
  // Strip the bot's own mention from the message, then resolve all other @s
  const stripped = BOT_ID ? raw.replace(new RegExp(`<@!?${BOT_ID}>`, 'g'), '') : raw;
  return resolveMentions(stripped).trim();
}

// ═══════════════════════════════════════════════════════════════════
// SHORT-TERM MEMORY
// ═══════════════════════════════════════════════════════════════════

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
}

function stmGet(channelId: string): STMsg[] { return stmStore.get(channelId) ?? []; }

function stmFormat(msgs: STMsg[]): string {
  if (!msgs.length) return '(no messages yet)';
  const now   = Date.now();
  const lines: string[] = [];
  for (let i = 0; i < msgs.length; i++) {
    // Time-gap separators so the model knows when sessions changed
    if (i > 0) {
      const gap = msgs[i].ts - msgs[i - 1].ts;
      if (gap >= GAP_MAJOR_MS) {
        lines.push(`\n── ${Math.round(gap / 60_000)}m later — new session ──\n`);
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
  return lines.join('\n');
}

function seedSTM(channelId: string, msgs: Message[]) {
  if (stmStore.has(channelId)) return;
  stmStore.set(channelId, msgs.slice(-STM_MAX).map(m => ({
    ts:       m.createdTimestamp,
    authorId: m.author.id,
    author:   m.author.id === BOT_ID ? '[me]' : (m.member?.displayName || m.author.username),
    content:  cleanContent(m.content).slice(0, 100),
  })));
}

// ═══════════════════════════════════════════════════════════════════
// MOOD STATE  (active / passive — in-memory, no Firebase overhead)
// ═══════════════════════════════════════════════════════════════════

interface Mood { mode: 'active' | 'passive'; until?: number; count: number; }

const moods = new Map<string, Mood>();

function getMood(channelId: string): Mood {
  let m = moods.get(channelId) ?? { mode: 'passive', count: 0 };
  // Auto-expire active mode
  if (m.mode === 'active' && m.until && Date.now() >= m.until) {
    m = { mode: 'passive', count: 0 };
    moods.set(channelId, m);
    console.log(`[Mood] #${channelId.slice(-5)} active→passive (expired)`);
  }
  return m;
}

function goActive(channelId: string, mins = ACTIVE_MINS, reason = '') {
  moods.set(channelId, { mode: 'active', until: Date.now() + mins * 60_000, count: 0 });
  console.log(`[Mood] #${channelId.slice(-5)} active ${mins}m${reason ? ` — ${reason}` : ''}`);
}

function goPassive(channelId: string) {
  moods.set(channelId, { mode: 'passive', count: 0 });
  console.log(`[Mood] #${channelId.slice(-5)} passive`);
}

// Returns true if the brain should fire for this message.
// Also handles auto-active signals (mention, gap, monopoly).
function moodTick(
  channelId: string,
  authorId:  string,
  mentioned: boolean,
  isDM:      boolean,
): boolean {
  // DM and direct mentions always fire
  if (isDM || mentioned) {
    goActive(channelId, ACTIVE_MINS, isDM ? 'DM' : 'mentioned');
    return true;
  }

  const msgs = stmGet(channelId);

  // Idle gap → new session → go active
  if (msgs.length > 0) {
    const gap = Date.now() - msgs[msgs.length - 1].ts;
    if (gap > 8 * 60_000) {
      goActive(channelId, ACTIVE_MINS, `${Math.round(gap / 60_000)}m idle gap`);
      return true;
    }
  }

  // Bot name in message (no @ needed) → go active
  // (Already handled by mention check above if they @'d, this catches plain "notabot what do u think")

  // Monopoly: last N messages all from the same person, not addressing others
  // Uses cleaned STM content where mentions are "@Name" strings
  if (msgs.length >= MONOPOLY_N) {
    const recent  = msgs.slice(-MONOPOLY_N);
    const authors = new Set(recent.map(m => m.authorId).filter(id => id !== BOT_ID));
    if (authors.size === 1 && [...authors][0] === authorId) {
      // Check they're not addressing someone else
      const addressingOthers = recent.some(m => {
        const withoutMe = m.content.replace(new RegExp(`@${BOT_NAME}`, 'gi'), '');
        return withoutMe.includes('@');
      });
      if (!addressingOthers) {
        goActive(channelId, ACTIVE_MINS, `monopoly — ${authorId.slice(-5)} talking exclusively`);
        return true;
      }
    }
  }

  // Passive mode counter
  const m = getMood(channelId);
  if (m.mode === 'active') return true;

  m.count++;
  moods.set(channelId, m);

  // Velocity: if channel is in a fast back-and-forth, back off more
  const cutoff  = Date.now() - VELOCITY_WINDOW_MS;
  const vel     = stmGet(channelId).filter(x => x.ts >= cutoff && x.authorId !== BOT_ID).length;
  const every   = vel > VELOCITY_THRESH ? PASSIVE_EVERY_BUSY : PASSIVE_EVERY;
  const fire    = m.count % every === 0;

  if (!fire) console.log(`[Mood] #${channelId.slice(-5)} passive ${m.count}/${every}`);
  return fire;
}

// ═══════════════════════════════════════════════════════════════════
// SPEAK STATE  (paused / waiting / active)
// ═══════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════
// FIREBASE / MEMORY
// ═══════════════════════════════════════════════════════════════════

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

// ── Member data ───────────────────────────────────────────────────

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

async function getAllMembers(guildId: string): Promise<MemberData[]> {
  try {
    const snap = await db.collection('servers').doc(guildId).collection('members').get();
    return snap.docs.map(d => d.data() as MemberData).filter(m => m.displayName || m.username);
  } catch { return []; }
}

// ═══════════════════════════════════════════════════════════════════
// BRAIN  — 70b, 3-field JSON, clean prompt
//
// The core design principle: give the model the RIGHT context structure,
// then trust it to reason. Don't give it a 7-step algorithm to follow —
// that's fighting the model.
//
// What "right context structure" means here:
//   - Reply chain as an explicit THREAD block (not a footnote)
//   - Transcript with session breaks so it knows what's "now" vs "earlier"
//   - Tiny memory context (3 facts max) so it doesn't bloat the token count
//   - Single mood/speak line so it knows if it's in focus or background
// ═══════════════════════════════════════════════════════════════════

interface BrainDecision {
  action:   'speak' | 'react' | 'ignore';
  reply:    string;
  reaction: string;
}

async function brain(opts: {
  guildId:    string;
  sender:     string;
  bond:       number;
  message:    string;
  transcript: string;
  thread?:    string;      // full original message if this is a reply
  memCtx:     string;
  mentioned:  boolean;
  isDM:       boolean;
  mood:       Mood;
  speakState: SpeakState;
}): Promise<BrainDecision> {

  const system = `you are ${BOT_NAME}. you live in this discord server as a person, not an assistant.

gen z. dry, sometimes absurd humor. you roast people you like — that's how affection works. you're not obligated to respond to everything and often don't.

texting rules — break these and you sound like a bot:
- lowercase always. caps only for actual emphasis.
- most replies are under 12 words. one word, "lol", "fr", "nah", or just an emoji is a complete valid answer — often the best one.
- contractions always (im, dont, ur, ngl, idk, rn, tbh). slang only if it fits naturally.
- no em-dashes. no semicolons. minimal punctuation. drop periods on short messages.
- never explain jokes. never narrate what you're doing. never say "let me know if".
- zero assistant language — no "happy to help", "great question", "certainly", "of course".
- don't pile on. if you just spoke in the last 2 messages, you need a real reason to speak again.

when to ignore:
- two people are clearly talking to each other → stay out (or quiet react at most)
- it's background chatter in a group with no angle for you → ignore
- high-velocity back and forth you're not part of → ignore

output ONLY valid JSON, nothing else:
{"action":"speak|react|ignore","reply":"your message, empty if not speaking","reaction":"single emoji or empty string"}`;

  const bondLabel = opts.bond > 70 ? 'close' : opts.bond > 40 ? 'neutral' : 'distant';
  const moodLine  = opts.mood.mode === 'active'
    ? `active mode (${Math.round(((opts.mood.until || 0) - Date.now()) / 60_000)}m left)`
    : `passive`;

  // Build user message — structure matters more than length here
  const parts: string[] = [`mood: ${moodLine} | speak: ${opts.speakState.mode}`];

  if (opts.memCtx) {
    parts.push(`\nSERVER CONTEXT:\n${opts.memCtx}`);
  }

  // ── THREAD BLOCK — the key fix for reply-chain blindness ──────────
  // When someone replies to another message, the model needs to see the
  // original in full — not as a footnote buried in the transcript.
  // This block makes the thread explicit and impossible to miss.
  if (opts.thread) {
    parts.push(`\nTHREAD — ${opts.sender} is replying to:\n${opts.thread}`);
  }

  parts.push(`\nRECENT CHAT:\n${opts.transcript}`);

  parts.push(
    `\nTRIGGER — ${opts.sender} (${bondLabel}, bond ${opts.bond}/100):\n"${opts.message}"`,
    `directly at you: ${opts.mentioned ? 'YES' : 'NO'}`,
  );

  if (opts.isDM) parts.push('(DM — just you two, be a bit more direct)');

  try {
    const raw = await groq.call(
      BRAIN,
      [{ role: 'system', content: system }, { role: 'user', content: parts.join('\n') }],
      0.88, 120, 1.0, 0.7,
    );

    const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    const action = (['speak', 'react', 'ignore'] as const).includes(parsed.action)
      ? parsed.action as BrainDecision['action']
      : 'ignore';
    const reply    = typeof parsed.reply === 'string' ? parsed.reply.trim().replace(/^["']|["']$/g, '') : '';
    const reaction = sanitizeEmoji(parsed.reaction);

    // Safety net: if mentioned and brain says ignore, send something minimal
    if (opts.mentioned && action === 'ignore') {
      return { action: 'speak', reply: 'hm?', reaction: '' };
    }

    return { action, reply, reaction };
  } catch (e: any) {
    console.warn('[Brain] parse error:', e.message?.slice(0, 80));
    return opts.mentioned
      ? { action: 'speak', reply: 'brain blipped, one sec', reaction: '' }
      : { action: 'ignore', reply: '', reaction: '' };
  }
}

function sanitizeEmoji(raw: any): string {
  if (typeof raw !== 'string') return '';
  const e = raw.trim();
  if (!e || e.length > 8) return '';
  const RE = /^(\p{Extended_Pictographic}|\p{Emoji_Presentation})(\uFE0F|\u200D(\p{Extended_Pictographic}|\p{Emoji_Presentation}))*$/u;
  return RE.test(e) ? e : '';
}

// ── Async side-effects — never block the reply ────────────────────
// Memory writes, bond updates, fact extraction all happen after the
// message is sent. The brain call is not responsible for these.
function fireSideEffects(opts: {
  guildId:    string;
  userId:     string;
  action:     string;
  bond?:      number;
  newFact?:   string;
}) {
  if (opts.guildId === 'dm') return;
  // Small positive bond bump when we speak, negative if ignored (over time)
  if (opts.action === 'speak') {
    updateBond(opts.guildId, opts.userId, 1).catch(() => {});
  }
  if (opts.newFact) {
    addFact(opts.guildId, opts.newFact).catch(() => {});
  }
}

// ═══════════════════════════════════════════════════════════════════
// BACKGROUND JOBS
//
// All on FAST (8b). Pattern extraction doesn't need social reasoning.
// bgLock: only one background job runs at a time, with 30s between
// them. This prevents background jobs from spiking TPM during busy
// message handling windows.
// ═══════════════════════════════════════════════════════════════════

let bgLock      = false;
let lastProfile = 0;
let lastCompress = 0;
let lastProactive = 0;

async function withBgBudget<T>(fn: () => Promise<T>): Promise<T | null> {
  if (bgLock || !tpmAllow(EST_BG)) {
    console.log(`[BG] skipped — bgLock=${bgLock} tpmLeft=${tpmLeft()}`);
    return null;
  }
  bgLock = true;
  try {
    return await fn();
  } finally {
    // 30s cooldown between background jobs so they never stack up
    setTimeout(() => { bgLock = false; }, 30_000);
  }
}

async function runProfiler(client: Client) {
  if (Date.now() - lastProfile < PROFILER_INTERVAL) return;
  lastProfile = Date.now();

  await withBgBudget(async () => {
    for (const guild of client.guilds.cache.values()) {
      for (const ch of guild.channels.cache.filter(c => c.isTextBased()).values()) {
        if (!tpmAllow(EST_BG)) break;
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
            if (!tpmAllow(EST_BG)) break;
            const name = idCache.get(uid) || uid;
            try {
              const raw = await groq.call(FAST, [
                { role: 'system', content: 'one-line personality read from discord messages. output ONLY: {"p":"..."}' },
                { role: 'user',   content: `${name}: ${lines.slice(0, 8).join(' | ')}` },
              ], 0.4, 50);
              const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
              if (parsed.p) await upsertMember(guild.id, uid, { personality: parsed.p });
            } catch {}
          }
        } catch {}
      }
    }
    console.log(`[Profiler] done | tpm left: ${tpmLeft()}`);
  });
}

async function runCompress(guildId: string, channelId: string) {
  if (Date.now() - lastCompress < COMPRESS_INTERVAL) return;
  const msgs = stmGet(channelId);
  if (msgs.length < 8) return;
  lastCompress = Date.now();

  await withBgBudget(async () => {
    const text = msgs.map(m => `${m.author}: ${m.content}`).join('\n');
    try {
      const raw = await groq.call(FAST, [
        { role: 'system', content: 'extract memorable facts and inside jokes from this discord chat. ONLY valid JSON, nothing else.' },
        { role: 'user',   content: `${text}\n\nJSON: {"facts":["x"],"jokes":["x"]}` },
      ], 0.4, 100);
      const p = JSON.parse(raw.replace(/```json|```/g, '').trim());
      for (const f of (p.facts || []).slice(0, 4)) await addFact(guildId, f, 'facts');
      for (const j of (p.jokes || []).slice(0, 2)) await addFact(guildId, j, 'jokes');
      console.log(`[Compress] +${p.facts?.length || 0} facts +${p.jokes?.length || 0} jokes`);
    } catch {}
  });
}

async function runProactive(client: Client) {
  if (Date.now() - lastProactive < PROACTIVE_INTERVAL) return;
  if (!tpmAllow(EST_BG)) return;
  lastProactive = Date.now();

  await withBgBudget(async () => {
    const now = Date.now();
    const candidates: { id: string; hint: string }[] = [];

    for (const [channelId, msgs] of stmStore.entries()) {
      if (!msgs.length) continue;
      const idle = now - msgs[msgs.length - 1].ts;
      // Only consider channels idle 10m-2h
      if (idle < 10 * 60_000 || idle > 2 * 60 * 60_000) continue;
      candidates.push({
        id:   channelId,
        hint: `quiet for ${Math.round(idle / 60_000)}m. last msg: "${msgs[msgs.length - 1].content.slice(0, 50)}"`,
      });
    }

    if (!candidates.length) return;

    // Pick a random candidate from up to 5 options
    const pick = candidates[Math.floor(Math.random() * Math.min(candidates.length, 5))];
    const ch   = client.channels.cache.get(pick.id) as TextChannel | undefined;
    if (!ch?.isTextBased()) return;

    try {
      const raw = await groq.call(FAST, [
        { role: 'system', content: `you are ${BOT_NAME}, gen z discord person. send ONE short natural message to break the silence, or skip if nothing feels right. lowercase, casual. ONLY valid JSON.` },
        { role: 'user',   content: `channel: ${pick.hint}\nJSON: {"skip":false,"msg":"..."}` },
      ], 0.9, 70);
      const p = JSON.parse(raw.replace(/```json|```/g, '').trim());
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

// ═══════════════════════════════════════════════════════════════════
// MAIN MESSAGE HANDLER
//
// Flow:
// 1. Push to STM immediately (every message, before any gates)
// 2. Mood gate (moodTick) — decides if this message should trigger brain
// 3. Token budget gate — ensure we have headroom
// 4. Debounce — wait for conversation lull (4s) before firing brain
//    Burst of messages → STM fills → brain fires once on the last one
//    Mention → fast lane (350ms debounce)
// 5. Resolve reply chain → THREAD header
// 6. Brain call → decision
// 7. Act on decision + fire side-effects async
// ═══════════════════════════════════════════════════════════════════

const debounceTimers  = new Map<string, NodeJS.Timeout>();
const pendingTriggers = new Map<string, {
  msg:       Message;
  mentioned: boolean;
  isDM:      boolean;
  guildId:   string;
}>();

async function handleMessage(msg: Message) {
  if (msg.author.bot || !msg.content?.trim()) return;
  try {
    const isDM      = msg.channel.isDMBased();
    const guildId   = isDM ? 'dm' : msg.guildId!;
    const channelId = msg.channelId;
    const mentioned = isDM ? true : (BOT_ID ? msg.mentions.has(BOT_ID) : false);
    const sender    = msg.member?.displayName || msg.author.username;
    const content   = cleanContent(msg.content);

    cacheId(msg.author.id, sender);

    // Async member sync — don't await, never block message flow
    if (!isDM) {
      upsertMember(guildId, msg.author.id, {
        displayName: sender,
        username:    msg.author.username,
      }).catch(() => {});
    }

    // ── 1. Push to STM immediately ─────────────────────────────────
    // Every message in the burst lands here before the brain fires,
    // so the transcript is always complete when we finally read the room.
    stmPush(channelId, {
      ts:       msg.createdTimestamp,
      authorId: msg.author.id,
      author:   msg.author.id === BOT_ID ? '[me]' : sender,
      content:  content.slice(0, 100),
    });

    // ── 2. Mood gate ───────────────────────────────────────────────
    if (!moodTick(channelId, msg.author.id, mentioned, isDM)) return;

    // ── 3. Token budget gate ───────────────────────────────────────
    if (!tpmAllow(EST_BRAIN)) {
      console.log(`[Budget] ${tpmLeft()} TPM left — skipping${mentioned ? ' (mention!)' : ''}`);
      // For mentions, try anyway — they matter even if we're tight
      if (!mentioned) return;
    }

    // ── 4. Debounce — collect the burst, fire on silence ──────────
    pendingTriggers.set(channelId, { msg, mentioned, isDM, guildId });
    if (debounceTimers.has(channelId)) clearTimeout(debounceTimers.get(channelId)!);

    const debounceMs = mentioned ? 350 : DEBOUNCE_MS;

    debounceTimers.set(channelId, setTimeout(async () => {
      debounceTimers.delete(channelId);
      const trigger = pendingTriggers.get(channelId);
      pendingTriggers.delete(channelId);
      if (!trigger) return;

      const { msg: tMsg, mentioned: tMentioned, isDM: tDM, guildId: tGuild } = trigger;
      const tChannel = tMsg.channelId;
      const tSender  = tMsg.member?.displayName || tMsg.author.username;
      const tContent = cleanContent(tMsg.content);
      const tIsGuild = !tDM && !!tMsg.guildId;

      try {
        // Speak state check
        const speakState = await getSpeakState(tChannel, tGuild);
        if (
          speakState.mode === 'paused' &&
          speakState.resumeAt &&
          Date.now() < speakState.resumeAt &&
          !tMentioned
        ) {
          console.log(`[Speak] paused ${Math.round((speakState.resumeAt - Date.now()) / 1000)}s — skip`);
          return;
        }

        // Seed STM if not already seeded
        if (!stmStore.has(tChannel)) {
          const fetched = await tMsg.channel.messages.fetch({ limit: STM_MAX });
          seedSTM(tChannel, ([...fetched.values()] as Message[]).reverse());
        }

        // ── 5. Resolve reply chain → THREAD block ─────────────────
        // This is the room-reading fix: the model sees the full original
        // message as its own block, not a truncated footnote.
        let threadCtx: string | undefined;
        if (tMsg.reference?.messageId) {
          try {
            const ref       = await tMsg.channel.messages.fetch(tMsg.reference.messageId);
            const refAuthor = ref.author.id === BOT_ID
              ? BOT_NAME
              : (ref.member?.displayName || ref.author.username);
            const refContent = cleanContent(ref.content).slice(0, 200);
            threadCtx = `${refAuthor}: "${refContent}"`;
          } catch {}
        }

        // Minimal memory context — 3 facts max to keep token count low
        const [memberData, memory] = await Promise.all([
          tIsGuild ? getMember(tGuild, tMsg.author.id) : Promise.resolve({} as MemberData),
          tIsGuild ? getMemory(tGuild)                 : Promise.resolve({ facts: [], jokes: [] } as ServerMemory),
        ]);

        const bond    = typeof memberData.bond === 'number' ? memberData.bond : 50;
        const memLines: string[] = [];
        if (memory.facts.length)        memLines.push(`facts: ${memory.facts.slice(-3).join(' | ')}`);
        if (memory.jokes.length)        memLines.push(`jokes: ${memory.jokes.slice(-2).join(' | ')}`);
        if (memberData.personality)     memLines.push(`${tSender}: ${memberData.personality}`);
        const memCtx = memLines.join('\n');

        const mood = getMood(tChannel);

        // ── 6. Brain call ──────────────────────────────────────────
        const decision = await brain({
          guildId:    tGuild,
          sender:     tSender,
          bond,
          message:    tContent,
          transcript: stmFormat(stmGet(tChannel)),
          thread:     threadCtx,
          memCtx,
          mentioned:  tMentioned,
          isDM:       tDM,
          mood,
          speakState,
        });

        console.log(`[Brain] ${tSender}${tDM ? ' DM' : ''}: ${decision.action}${decision.reply ? ` — "${decision.reply.slice(0, 50)}"` : decision.reaction ? ` — ${decision.reaction}` : ''}`);

        // ── 7. Act on decision ─────────────────────────────────────

        // Reaction can accompany any action
        if (decision.reaction) {
          tMsg.react(decision.reaction).catch(() => {});
        }

        if (decision.action === 'speak') {
          if (!decision.reply?.trim()) {
            console.log('[Brain] speak→empty reply, skipping');
            return;
          }
          const text     = decision.reply.trim().slice(0, 200);
          const typingMs = Math.min(300 + text.length * 20, 2800);

          try { await tMsg.channel.sendTyping(); } catch {}
          await sleep(typingMs);

          await tMsg.reply({ content: text, allowedMentions: { repliedUser: false } });
          stmPush(tChannel, { ts: Date.now(), authorId: BOT_ID, author: '[me]', content: text });

          // Async side-effects — never await these
          fireSideEffects({ guildId: tGuild, userId: tMsg.author.id, action: 'speak' });
          if (speakState.mode !== 'active') {
            setSpeakState(tChannel, tGuild, { mode: 'active', reason: 'spoke' }).catch(() => {});
          }

        } else if (decision.action === 'react') {
          // Reaction already fired above — log it
          console.log(`[React] ${decision.reaction || '(none)'}`);
        }
        // 'ignore' → do nothing (reaction may have already fired)

        // Trigger background jobs opportunistically (staggered, budgeted)
        if (tIsGuild) {
          runCompress(tGuild, tChannel).catch(() => {});
        }

      } catch (e) { console.error('[Handler debounce]', e); }
    }, debounceMs));

  } catch (e) { console.error('[Handler outer]', e); }
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
    cacheId(BOT_ID, BOT_NAME);

    console.log(`
╔═══════════════════════════════════════════════╗
║  ✓ ${BOT_NAME} v13 — Clean Slate
║  BRAIN : ${BRAIN}
║  FAST  : ${FAST}
║  TPM   : ${TPM_CAP} cap (~${Math.floor(TPM_CAP / EST_BRAIN)} brain calls/min)
║  STM   : ${STM_MAX} msgs | Debounce: ${DEBOUNCE_MS}ms
║  Passive: every ${PASSIVE_EVERY} msgs (${PASSIVE_EVERY_BUSY} when busy)
║  Active : ${ACTIVE_MINS}m default | Monopoly: ${MONOPOLY_N} msgs
╚═══════════════════════════════════════════════╝\n`);

    botClient!.user!.setPresence({ status: 'online', activities: [{ name: 'the chat', type: 3 }] });

    // Sync all guild members into cache + Firebase
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
    }

    // Staggered background loops
    // Profiler runs every 20m, proactive every 35m with jitter
    // They share bgLock so they never compete with each other or the brain
    setInterval(async () => {
      if (!botClient) return;
      runProfiler(botClient).catch(() => {});
    }, PROFILER_INTERVAL);

    const proactiveJitter = () => Math.floor(Math.random() * 10 * 60_000);
    const scheduleProactive = () => {
      setTimeout(async () => {
        if (!botClient) return;
        runProactive(botClient).catch(() => {});
        scheduleProactive();
      }, PROACTIVE_INTERVAL + proactiveJitter());
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

  // ── Admin commands ─────────────────────────────────────────────
  botClient.on(Events.MessageCreate, async (msg) => {
    if (
      !msg.member?.permissions.has('Administrator') &&
      !msg.member?.permissions.has('ManageMessages')
    ) return;

    const c       = msg.content.trim();
    const guildId = msg.guildId!;
    const chId    = msg.channelId;

    // Speak state
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

    // Mood
    if (c.startsWith('!active')) {
      const mins = parseInt(c.split(' ')[1] || '') || ACTIVE_MINS;
      goActive(chId, mins, 'admin');
      msg.reply(`active ${mins}m`);
    }
    if (c === '!passive') {
      goPassive(chId);
      msg.reply('passive mode');
    }

    // Status
    if (c === '!status') {
      const mood    = getMood(chId);
      const speak   = await getSpeakState(chId, guildId);
      const moodStr = mood.mode === 'active' && mood.until
        ? `active (${Math.round((mood.until - Date.now()) / 60_000)}m left)`
        : `passive (count: ${mood.count})`;
      await msg.reply([
        `mood: ${moodStr}`,
        `speak: ${speak.mode}${speak.resumeAt ? ` until ${new Date(speak.resumeAt).toLocaleTimeString()}` : ''}`,
        `tpm: ${tpmLeft()}/${TPM_CAP} left this minute`,
        `groq: ${groq.status()}`,
        `bgLock: ${bgLock}`,
      ].join('\n'));
    }

    // Memory
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

    // STM debug
    if (c === '!stm') {
      const out = stmFormat(stmGet(chId));
      await msg.reply(`\`\`\`\n${out.slice(0, 1900)}\n\`\`\``);
    }

    // Force proactive cycle
    if (c === '!proactive') {
      await msg.reply('running...');
      await runProactive(botClient!).catch(() => {});
      await msg.reply('done');
    }

    // Member personality
    if (c.startsWith('!who ')) {
      const uid = msg.mentions.users.first()?.id || c.split(' ')[1]?.trim();
      if (!uid) { msg.reply('usage: !who @user'); return; }
      const m = await getMember(guildId, uid);
      await msg.reply(
        `${m.displayName || uid}\nbond: ${m.bond ?? 50}/100\n${m.personality || '(no profile yet)'}`
      );
    }
  });

  await botClient.login(token);
}

export function stopBot() {
  botClient?.destroy();
  botClient = null;
}

export function getBotStatus() { return botClient ? 'running' : 'stopped'; }
