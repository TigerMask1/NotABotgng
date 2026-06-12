/**
 * NOTABOT - v6 "Real Brain"
 * - AI controls speak state (active/paused/waiting) per channel
 * - Real clock injected into every decision
 * - Short-term in-memory transcript (timestamped, per channel)
 * - Full convo window: AI sees trajectory not just one message
 * - Revamped Firebase schema (identity, members, channels, memory)
 * - Zero hardcoded patterns — AI reads the room
 */

import { Client, GatewayIntentBits, Message, Partials, Events, Collection } from 'discord.js';
import Groq from 'groq-sdk';
import { db } from './firebase.ts';

// ══════════════════════════════════════════════════════════════
// GROQ MANAGER
// ══════════════════════════════════════════════════════════════

interface KeyStats {
  key: string; requestsToday: number; errorsToday: number;
  isHealthy: boolean; cooldownUntil?: number; lastUsed?: number;
}

class GroqManager {
  private clients  = new Map<string, Groq>();
  private stats    = new Map<string, KeyStats>();
  private keys: string[] = [];
  private limit    = 14400;
  private resetAt  = Date.now() + 86_400_000;

  constructor() {
    const raw = process.env.GROQ_API_KEYS || process.env.GROQ_API_KEY || '';
    this.keys = raw.split(',').map(k => k.trim()).filter(Boolean);
    if (!this.keys.length) { console.error('[Groq] No keys'); process.exit(1); }
    this.keys.forEach(k => {
      this.clients.set(k, new Groq({ apiKey: k }));
      this.stats.set(k, { key: k, requestsToday: 0, errorsToday: 0, isHealthy: true });
    });
    console.log(`[Groq] ${this.keys.length} key(s)`);
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
    return pool.reduce((a, b) => this.stats.get(a)!.requestsToday <= this.stats.get(b)!.requestsToday ? a : b);
  }

  async request(model: string, msgs: any[], temp = 0.85, maxTok = 250, retries = 3): Promise<string> {
    let last: any;
    for (let i = 0; i < retries; i++) {
      const k = this.bestKey();
      const s = this.stats.get(k)!;
      try {
        const r = await this.clients.get(k)!.chat.completions.create({ model, messages: msgs, temperature: temp, max_tokens: maxTok });
        s.requestsToday++; s.lastUsed = Date.now();
        const u = r.usage;
        console.log(`[Groq] ${model} ${u.prompt_tokens}+${u.completion_tokens}tok ...${k.slice(-4)}`);
        return r.choices[0]?.message?.content || '';
      } catch (e: any) {
        last = e; s.errorsToday++;
        if (e.status === 429) {
          const sec = parseFloat(e.message?.match(/in ([\d.]+)s/)?.[1] || '30');
          s.cooldownUntil = Date.now() + sec * 1000; s.isHealthy = false;
          console.warn(`[Groq] ...${k.slice(-4)} 429 → cooldown ${sec}s`);
        } else console.error(`[Groq] attempt ${i+1} ...${k.slice(-4)}: ${e.message}`);
        if (i < retries - 1) await sleep(Math.min(1000 * 2 ** i, 8000));
      }
    }
    throw new Error(`[Groq] failed: ${last?.message}`);
  }

  allStats()    { return this.keys.map(k => this.stats.get(k)!); }
  available()   { return this.keys.reduce((s, k) => s + Math.max(0, this.limit - this.stats.get(k)!.requestsToday), 0); }
}

const groq = new GroqManager();
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ══════════════════════════════════════════════════════════════
// CONSTANTS
// ══════════════════════════════════════════════════════════════

const FAST  = 'llama-3.1-8b-instant';
const DEEP  = 'llama-3.3-70b-versatile';
const DEBOUNCE_MS       = 900;
const MAX_FETCH_HISTORY = 16;   // Discord API fetch
const SHORT_TERM_MAX    = 40;   // per-channel in-memory transcript
const PROFILER_INTERVAL = 14 * 60_000;

// ══════════════════════════════════════════════════════════════
// BOT STATE
// ══════════════════════════════════════════════════════════════

let botClient: Client | null = null;
let BOT_NAME = 'NotABot';
let BOT_ID   = '';

const debounceTimers = new Map<string, NodeJS.Timeout>();
let   profilerTimer: NodeJS.Timeout | null = null;

// ──────────────────────────────────────────────────────────────
// SPEAK STATE — per channel, AI-controlled
// mode:
//   active  → reply normally
//   paused  → silent until resumeAt (then auto-active)
//   waiting → silent until AI sees a natural opening or direct call
// ──────────────────────────────────────────────────────────────

interface SpeakState {
  mode:      'active' | 'paused' | 'waiting';
  resumeAt?: number;   // epoch ms, only for 'paused'
  reason:    string;
  setAt:     number;
}

// In-memory (fast reads). Also persisted to Firebase so survives restarts.
const speakStates = new Map<string, SpeakState>();

function defaultState(): SpeakState {
  return { mode: 'active', reason: 'default', setAt: Date.now() };
}

async function getSpeakState(channelId: string, guildId: string): Promise<SpeakState> {
  if (speakStates.has(channelId)) {
    const s = speakStates.get(channelId)!;
    // Auto-expire paused state
    if (s.mode === 'paused' && s.resumeAt && Date.now() >= s.resumeAt) {
      const next: SpeakState = { mode: 'active', reason: 'pause expired', setAt: Date.now() };
      speakStates.set(channelId, next);
      persistSpeakState(channelId, guildId, next);
      return next;
    }
    return s;
  }
  // Load from Firebase
  try {
    const snap = await db.collection('servers').doc(guildId)
      .collection('channels').doc(channelId).get();
    const d = snap.data()?.speakState as SpeakState | undefined;
    const state = d ?? defaultState();
    // Expire on load too
    if (state.mode === 'paused' && state.resumeAt && Date.now() >= state.resumeAt) {
      state.mode = 'active'; state.reason = 'pause expired (loaded)';
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
  const cur = speakStates.get(channelId) ?? defaultState();
  const next: SpeakState = { ...cur, ...update, setAt: Date.now() };
  speakStates.set(channelId, next);
  persistSpeakState(channelId, guildId, next);
  console.log(`[State] #${channelId} → ${next.mode}${next.resumeAt ? ` until ${new Date(next.resumeAt).toLocaleTimeString()}` : ''} | ${next.reason}`);
}

function persistSpeakState(channelId: string, guildId: string, state: SpeakState) {
  db.collection('servers').doc(guildId).collection('channels').doc(channelId)
    .set({ speakState: state, updatedAt: new Date().toISOString() }, { merge: true })
    .catch(e => console.warn('[State] persist error:', e.message));
}

// ──────────────────────────────────────────────────────────────
// SHORT-TERM MEMORY — in-memory per channel, timestamped
// Cleared on restart (intentional — it's *short-term*)
// ──────────────────────────────────────────────────────────────

interface STMessage {
  ts:       number;   // epoch ms
  authorId: string;
  author:   string;   // display name (or '[me]')
  content:  string;
}

const shortTermMemory = new Map<string, STMessage[]>();

function stmPush(channelId: string, msg: STMessage) {
  if (!shortTermMemory.has(channelId)) shortTermMemory.set(channelId, []);
  const arr = shortTermMemory.get(channelId)!;
  arr.push(msg);
  if (arr.length > SHORT_TERM_MAX) arr.shift();
}

function stmGet(channelId: string): STMessage[] {
  return shortTermMemory.get(channelId) ?? [];
}

/** Format short-term transcript for AI with relative timestamps */
function stmFormat(msgs: STMessage[], nowMs: number): string {
  if (!msgs.length) return '(no recent messages)';
  return msgs.map(m => {
    const agoMs  = nowMs - m.ts;
    const agoStr = agoMs < 60_000
      ? `${Math.round(agoMs / 1000)}s ago`
      : `${Math.round(agoMs / 60_000)}m ago`;
    return `[${agoStr}] ${m.author}: ${m.content.substring(0, 90)}`;
  }).join('\n');
}

// ══════════════════════════════════════════════════════════════
// FIREBASE — REVAMPED SCHEMA
//
// servers/{gid}/
//   identity          → { name, memberCount, createdAt }
//   members/{uid}     → { displayName, username, nicknames[], roles[], bond,
//                         personality, interests, sentiment, profiledAt }
//   channels/{cid}/   → { speakState, updatedAt }
//   memory/global     → { facts[], corrections[], insideJokes[], updatedAt }
//   compressedHistory → { summary, groupVibe, insideJokes[], compressedAt }
// ══════════════════════════════════════════════════════════════

// ── Server identity ──────────────────────────────────────────

async function upsertServerIdentity(guild: any) {
  try {
    await db.collection('servers').doc(guild.id).set({
      name:        guild.name,
      memberCount: guild.memberCount,
      updatedAt:   new Date().toISOString(),
    }, { merge: true });
  } catch {}
}

// ── Member registry ──────────────────────────────────────────

async function upsertMember(guildId: string, userId: string, data: Record<string, any>) {
  try {
    await db.collection('servers').doc(guildId)
      .collection('members').doc(userId)
      .set({ ...data, updatedAt: new Date().toISOString() }, { merge: true });
  } catch {}
}

async function getMember(guildId: string, userId: string): Promise<Record<string, any>> {
  try {
    const snap = await db.collection('servers').doc(guildId).collection('members').doc(userId).get();
    return snap.exists ? snap.data()! : {};
  } catch { return {}; }
}

async function getAllMembers(guildId: string): Promise<Record<string, any>[]> {
  try {
    const snap = await db.collection('servers').doc(guildId).collection('members').get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch { return []; }
}

// ── Bond ─────────────────────────────────────────────────────

async function getBond(guildId: string, userId: string): Promise<number> {
  const m = await getMember(guildId, userId);
  return typeof m.bond === 'number' ? m.bond : 50;
}

async function updateBond(guildId: string, userId: string, delta: number) {
  if (!delta) return;
  const cur  = await getBond(guildId, userId);
  const next = Math.max(0, Math.min(100, cur + delta));
  await upsertMember(guildId, userId, { bond: next });
  console.log(`[Bond] ${userId}: ${cur}→${next}`);
}

// ── Global memory ─────────────────────────────────────────────

interface GlobalMemory { facts: string[]; corrections: string[]; insideJokes: string[]; }
const memCache = new Map<string, { d: GlobalMemory; ts: number }>();

async function getMemory(guildId: string): Promise<GlobalMemory> {
  const cached = memCache.get(guildId);
  if (cached && Date.now() - cached.ts < 90_000) return cached.d;
  try {
    const snap = await db.collection('servers').doc(guildId)
      .collection('memory').doc('global').get();
    const d: GlobalMemory = {
      facts:       snap.data()?.facts       ?? [],
      corrections: snap.data()?.corrections ?? [],
      insideJokes: snap.data()?.insideJokes ?? [],
    };
    memCache.set(guildId, { d, ts: Date.now() });
    return d;
  } catch {
    return { facts: [], corrections: [], insideJokes: [] };
  }
}

async function writeFact(guildId: string, fact: string, bucket: keyof GlobalMemory = 'facts') {
  if (!fact?.trim()) return;
  try {
    const mem = await getMemory(guildId);
    const arr = mem[bucket] as string[];
    if (arr.some(f => f.toLowerCase() === fact.toLowerCase())) return;
    arr.push(fact.trim());
    if (arr.length > 40) arr.shift();
    await db.collection('servers').doc(guildId).collection('memory').doc('global')
      .set({ [bucket]: arr, updatedAt: new Date().toISOString() }, { merge: true });
    memCache.delete(guildId);
    console.log(`[Memory:${bucket}] "${fact}"`);
  } catch {}
}

function memToPrompt(mem: GlobalMemory, members: Record<string, any>[]): string {
  const lines: string[] = [];

  // Who's who in the server
  if (members.length) {
    const roster = members
      .filter(m => m.displayName || m.username)
      .map(m => {
        const nicks = m.nicknames?.length ? ` (also called: ${m.nicknames.join(', ')})` : '';
        const vibe  = m.personality ? ` — ${m.personality}` : '';
        return `  ${m.displayName || m.username}${nicks}${vibe}`;
      }).join('\n');
    lines.push(`SERVER MEMBERS:\n${roster}`);
  }

  if (mem.facts.length)
    lines.push(`FACTS YOU KNOW:\n${mem.facts.slice(-15).map(f => `- ${f}`).join('\n')}`);
  if (mem.corrections.length)
    lines.push(`MISTAKES YOU MADE (don't repeat):\n${mem.corrections.slice(-10).map(c => `- ${c}`).join('\n')}`);
  if (mem.insideJokes.length)
    lines.push(`INSIDE JOKES:\n${mem.insideJokes.slice(-8).map(j => `- ${j}`).join('\n')}`);

  return lines.join('\n\n') || '(nothing yet)';
}

// ══════════════════════════════════════════════════════════════
// CLOCK HELPERS
// ══════════════════════════════════════════════════════════════

function clockContext(stm: STMessage[], state: SpeakState): string {
  const now   = new Date();
  const nowMs = Date.now();
  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
  const dayStr  = now.toLocaleDateString('en-US', { weekday: 'long' });

  // Last time bot spoke
  const lastBotMsg = [...stm].reverse().find(m => m.author === '[me]');
  const lastBotAgo = lastBotMsg
    ? `${Math.round((nowMs - lastBotMsg.ts) / 1000)}s ago`
    : 'not yet this session';

  // Last human message
  const lastHuman = [...stm].reverse().find(m => m.author !== '[me]');
  const lastHumanAgo = lastHuman
    ? `${Math.round((nowMs - lastHuman.ts) / 1000)}s ago`
    : 'unknown';

  // How long state has been active
  const stateAge = Math.round((nowMs - state.setAt) / 1000);
  const stateDur = stateAge < 60 ? `${stateAge}s` : `${Math.round(stateAge / 60)}m`;

  return `TIME: ${timeStr} ${dayStr}
LAST TIME YOU SPOKE: ${lastBotAgo}
LAST HUMAN MESSAGE: ${lastHumanAgo}
CURRENT MODE: ${state.mode}${state.resumeAt ? ` (resumes at ${new Date(state.resumeAt).toLocaleTimeString()})` : ''} — set ${stateDur} ago
REASON FOR CURRENT MODE: ${state.reason}`;
}

// ══════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════

function stripBotMention(content: string): string {
  if (!BOT_ID) return content;
  return content.replace(new RegExp(`<@!?${BOT_ID}>`, 'g'), '').trim();
}

function displayName(msg: Message): string {
  return msg.member?.displayName || msg.author.username;
}

// Seed short-term memory from fetched Discord history (on first encounter)
function seedSTM(channelId: string, msgs: Message[]) {
  if (shortTermMemory.has(channelId)) return; // already seeded
  const arr: STMessage[] = msgs.map(m => ({
    ts:       m.createdTimestamp,
    authorId: m.author.id,
    author:   m.author.id === BOT_ID ? '[me]' : (m.member?.displayName || m.author.username),
    content:  stripBotMention(m.content).substring(0, 120),
  }));
  shortTermMemory.set(channelId, arr.slice(-SHORT_TERM_MAX));
}

// ══════════════════════════════════════════════════════════════
// BRAIN — single AI call that decides action + generates reply
// Returns action: 'speak' | 'pause' | 'wait' | 'ignore'
// ══════════════════════════════════════════════════════════════

interface BrainDecision {
  action:       'speak' | 'pause' | 'wait' | 'ignore';
  reply?:       string;   // if action === 'speak'
  pauseMins?:   number;   // if action === 'pause'
  bondDelta?:   number;
  newFact?:     string;   // something worth remembering
  reason:       string;
}

async function brain(
  senderName: string,
  senderProfile: string,
  bond: number,
  messageContent: string,     // the triggering message (mention-stripped)
  stmTranscript: string,      // full timestamped short-term convo
  memoryContext: string,
  clockCtx: string,
  isMentioned: boolean,
  currentState: SpeakState,
): Promise<BrainDecision> {

  const systemPrompt = `You are a real person named ${BOT_NAME} chatting in a Discord server. You are Gen Z, chaotic, and charming. You are NOT an AI, assistant, or bot.

━━━ CORE RULES ━━━
1. BE BRIEF: 1-2 sentences max. Sometimes just one word or emoji is enough.
2. FORMATTING: All lowercase. Occasional typos are fine. Minimal punctuation.
3. VIBE: Slang-heavy, reactive, casual.
4. FORBIDDEN BEHAVIORS:
   - NEVER say "certainly", "of course", "I understand", "as an AI", or "how can I help".
   - NEVER explain your jokes or use bullet points.
   - NEVER output quotes or prefix your message with your name. Just output the raw message.

━━━ EXAMPLES OF HOW YOU TALK ━━━
"bro no way 💀"
"wait that actually slaps"
"nah fr tho"
"lmaooo okay okay"
"dude what 😭"
"deadass?"
"idk man that's kinda sus"
"okay but hear me out"
"bruh"
"not me jumping in lmaoo"
"wait wdym"
"lowkey yeah"
"W"
"ong"

━━━ DECISION ENGINE ━━━
You also control your own speak state. Read the FULL conversation trajectory, not just the last message.

action options:
- speak   → reply naturally (put reply in the reply field)
- pause   → shut up for X mins (set pauseMins 1-60). use when told to stop, convo clearly isn't for you
- wait    → go silent indefinitely — wait until someone calls you or a clear opening appears
- ignore  → skip this message but stay active

WHEN TO PAUSE/WAIT:
- someone said "i aint talking with u" / "shut up" / "not for u" → pause or wait
- pattern over multiple messages shows you're being excluded → pause or wait
- told off 2+ times in same session → wait
- one mild redirect → maybe just ignore
- directly mentioned → almost always speak`;

  const userPrompt = `<clock_and_state>
${clockCtx}
</clock_and_state>

<what_you_know>
${memoryContext}
</what_you_know>

<context>
Talking to: ${senderName}
About them: ${senderProfile || 'not much'}
Bond: ${bond}/100
Pinged you directly: ${isMentioned ? 'YES' : 'no'}
</context>

<recent_conversation_timestamped>
${stmTranscript}
</recent_conversation_timestamped>

${senderName} just said: "${messageContent}"

Output ONLY valid JSON, no markdown:
{
  "action": "speak|pause|wait|ignore",
  "reply": "your reply here if speaking (raw, no quotes, no name prefix)",
  "pauseMins": 5,
  "bondDelta": 0,
  "newFact": "optional fact worth remembering",
  "reason": "one line"
}`;

  try {
    const raw = await groq.request(FAST, [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt },
    ], 0.85, 220);
    const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());

    // Hard override: if mentioned, never pause/wait
    if (isMentioned && parsed.action !== 'speak') {
      parsed.action = 'speak';
    }

    return {
      action:     parsed.action     || 'ignore',
      reply:      parsed.reply      || '',
      pauseMins:  parsed.pauseMins  || 5,
      bondDelta:  parsed.bondDelta  || 0,
      newFact:    parsed.newFact    || '',
      reason:     parsed.reason     || '?',
    };
  } catch (e) {
    console.warn('[Brain] parse fail:', (e as any).message?.substring(0, 60));
    return { action: isMentioned ? 'speak' : 'ignore', reply: 'mb brain lagged', reason: 'fallback' };
  }
}

// ══════════════════════════════════════════════════════════════
// PROFILER (background async)
// ══════════════════════════════════════════════════════════════

async function profileMember(guildId: string, userId: string, username: string, msgs: string[]) {
  if (msgs.length < 3) return;
  try {
    const res = await groq.request(DEEP, [
      { role: 'system', content: 'You analyze Discord users from their messages. Output ONLY valid JSON, no markdown, no extra text.' },
      { role: 'user',   content: `Analyze this user briefly.\nuser: ${username}\nmessages:\n${msgs.join('\n')}\n\nJSON schema:\n{"personality":"one line vibe","interests":["x"],"vibes":"how they communicate","sentiment":"positive|neutral|negative","nicknames":[]}` },
    ], 0.4, 180);
    const p = JSON.parse(res.replace(/```json|```/g, '').trim());
    await upsertMember(guildId, userId, {
      personality: p.personality, interests: p.interests || [],
      vibes: p.vibes, sentiment: p.sentiment,
      nicknames: p.nicknames || [], profiledAt: new Date().toISOString(),
    });
    console.log(`[Profiler] ${username} → ${p.personality}`);
  } catch {}
}

async function compressAndLearn(guildId: string, msgs: STMessage[]) {
  if (msgs.length < 12) return;
  try {
    const text = msgs.slice(-50).map(m => `${m.author}: ${m.content}`).join('\n');
    const res = await groq.request(DEEP, [
      { role: 'system', content: 'You summarize Discord server chats. Output ONLY valid JSON, no markdown, no extra text.' },
      { role: 'user',   content: `Summarize this chat. Extract vibe, key facts, inside jokes.\n\n${text}\n\nJSON schema:\n{"summary":"brief","groupVibe":"one line","insideJokes":["x"],"facts":["x"]}` },
    ], 0.4, 280);
    const p = JSON.parse(res.replace(/```json|```/g, '').trim());
    // Write learned facts + inside jokes to memory
    for (const f of (p.facts || []).slice(0, 5))       await writeFact(guildId, f, 'facts');
    for (const j of (p.insideJokes || []).slice(0, 4)) await writeFact(guildId, j, 'insideJokes');
    await db.collection('servers').doc(guildId)
      .set({ compressedHistory: { summary: p.summary, groupVibe: p.groupVibe, compressedAt: new Date().toISOString() } }, { merge: true });
    console.log(`[Profiler] Compressed & learned for ${guildId}`);
  } catch {}
}

function startProfilerLoop(client: Client) {
  if (profilerTimer) clearInterval(profilerTimer);
  profilerTimer = setInterval(async () => {
    try {
      for (const guild of client.guilds.cache.values()) {
        await upsertServerIdentity(guild);
        for (const ch of guild.channels.cache.filter(c => c.isTextBased()).values()) {
          try {
            const fetched = await (ch as any).messages.fetch({ limit: 25 });
            const msgs = ([...fetched.values()] as Message[]).reverse();

            // Seed STM if not already
            seedSTM(ch.id, msgs);

            // Group by author and profile
            const byAuthor = new Map<string, { userId: string; lines: string[] }>();
            for (const m of msgs) {
              if (m.author.bot || !m.content.trim()) continue;
              const uid  = m.author.id;
              const name = m.member?.displayName || m.author.username;
              if (!byAuthor.has(uid)) byAuthor.set(uid, { userId: uid, lines: [] });
              byAuthor.get(uid)!.lines.push(m.content.substring(0, 100));

              // Upsert basic member info (displayName, username)
              await upsertMember(guild.id, uid, {
                displayName: m.member?.displayName || m.author.username,
                username: m.author.username,
              });
            }

            for (const [uid, { lines }] of byAuthor) {
              const member = guild.members.cache.get(uid);
              const name = member?.displayName || uid;
              await profileMember(guild.id, uid, name, lines);
            }

            // Compress + learn from STM
            const stm = stmGet(ch.id);
            await compressAndLearn(guild.id, stm);
          } catch {}
        }
      }
      console.log(`[Profiler] Cycle done | ${groq.available()} reqs left`);
    } catch (e) { console.error('[Profiler] error:', e); }
  }, PROFILER_INTERVAL);
}

// ══════════════════════════════════════════════════════════════
// MAIN MESSAGE HANDLER
// ══════════════════════════════════════════════════════════════

async function handleMessage(msg: Message) {
  if (msg.author.bot || !msg.content?.trim()) return;

  try {
    const isDM    = msg.channel.isDMBased();
    const isGuild = !isDM && !!msg.guildId;
    if (!isDM && !isGuild) return;

    const guildId    = isGuild ? msg.guildId! : 'dm';
    const channelId  = msg.channelId;
    const mentioned  = BOT_ID ? msg.mentions.has(BOT_ID) : false;
    const sender     = displayName(msg);
    const cleanMsg   = stripBotMention(msg.content);

    // Push to short-term memory immediately (every message, bot or not)
    stmPush(channelId, {
      ts:       msg.createdTimestamp,
      authorId: msg.author.id,
      author:   msg.author.id === BOT_ID ? '[me]' : sender,
      content:  cleanMsg.substring(0, 120),
    });

    // Debounce (so rapid-fire messages collapse into one decision)
    if (debounceTimers.has(channelId)) clearTimeout(debounceTimers.get(channelId)!);

    const delay = mentioned ? 180 : DEBOUNCE_MS;
    const timer = setTimeout(async () => {
      debounceTimers.delete(channelId);
      try {
        // ── Load speak state ──────────────────────────────────────
        const state = await getSpeakState(channelId, guildId);

        // If paused and not yet expired and not mentioned → skip entirely
        if (state.mode === 'paused' && state.resumeAt && Date.now() < state.resumeAt && !mentioned) {
          console.log(`[State] #${channelId} paused (${Math.round((state.resumeAt - Date.now()) / 1000)}s left) → skip`);
          return;
        }

        // If waiting and not mentioned → AI still checks for natural openings via brain
        // (don't hard-skip, let brain decide — but pass state so it knows)

        // ── Fetch Discord history (only if STM empty) ─────────────
        if (!shortTermMemory.has(channelId)) {
          const fetched = await msg.channel.messages.fetch({ limit: MAX_FETCH_HISTORY });
          seedSTM(channelId, ([...fetched.values()] as Message[]).reverse());
        }

        // ── Parallel data load ────────────────────────────────────
        const [bond, memberData, memory, allMembers] = await Promise.all([
          isGuild ? getBond(guildId, msg.author.id)       : Promise.resolve(50),
          isGuild ? getMember(guildId, msg.author.id)     : Promise.resolve({}),
          isGuild ? getMemory(guildId)                    : Promise.resolve({ facts: [], corrections: [], insideJokes: [] } as GlobalMemory),
          isGuild ? getAllMembers(guildId)                : Promise.resolve([]),
        ]);

        const profile    = `${memberData.personality || ''}${memberData.vibes ? ' | ' + memberData.vibes : ''}`.trim();
        const stm        = stmGet(channelId);
        const nowMs      = Date.now();
        const transcript = stmFormat(stm, nowMs);
        const memCtx     = memToPrompt(memory, allMembers);
        const clock      = clockContext(stm, state);

        // ── BRAIN: single call, decides everything ────────────────
        const decision = await brain(
          sender, profile, bond,
          cleanMsg, transcript, memCtx, clock,
          mentioned, state,
        );

        console.log(`[Brain] ${sender}: ${decision.action} | ${decision.reason}`);

        // ── Apply decision ────────────────────────────────────────
        switch (decision.action) {

          case 'speak': {
            const text = (decision.reply || '').trim()
              .replace(/^["']|["']$/g, '')
              .replace(new RegExp(`^${BOT_NAME}:\\s*`, 'i'), '')
              .split('\n')[0]
              .slice(0, 200);

            if (!text) { console.log('[Brain] speak but empty reply → ignore'); break; }

            // Typing delay
            const typingMs = Math.min(350 + text.length * 25, 3200);
            await sleep(typingMs);

            try {
              await msg.reply({ content: text, allowedMentions: { repliedUser: false } });

              // Push own reply into STM
              stmPush(channelId, { ts: Date.now(), authorId: BOT_ID, author: '[me]', content: text });

              if (isGuild && decision.bondDelta) await updateBond(guildId, msg.author.id, decision.bondDelta);

              // Ensure state is active after speaking
              if (state.mode !== 'active') {
                await setSpeakState(channelId, guildId, { mode: 'active', reason: 'spoke → reset to active' });
              }

              console.log(`[Reply→${sender}] ${text.substring(0, 60)}`);
            } catch (e) { console.error('[Send] error:', e); }
            break;
          }

          case 'pause': {
            const mins    = Math.max(1, Math.min(60, decision.pauseMins || 5));
            const resumeAt = Date.now() + mins * 60_000;
            await setSpeakState(channelId, guildId, {
              mode: 'paused', resumeAt, reason: decision.reason,
            });
            if (isGuild && decision.newFact) await writeFact(guildId, decision.newFact, 'corrections');
            break;
          }

          case 'wait': {
            await setSpeakState(channelId, guildId, { mode: 'waiting', resumeAt: undefined, reason: decision.reason });
            if (isGuild && decision.newFact) await writeFact(guildId, decision.newFact, 'corrections');
            break;
          }

          case 'ignore':
          default:
            break;
        }

        // Write any new fact regardless of action
        if (isGuild && decision.newFact && decision.action !== 'pause' && decision.action !== 'wait') {
          writeFact(guildId, decision.newFact, 'facts').catch(() => {});
        }

      } catch (e) { console.error('[Handler] process error:', e); }
    }, delay);

    debounceTimers.set(channelId, timer);
  } catch (e) { console.error('[Handler] error:', e); }
}

// ══════════════════════════════════════════════════════════════
// STARTUP
// ══════════════════════════════════════════════════════════════

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

    console.log(`
╔══════════════════════════════════════════╗
║  ✓ ${BOT_NAME} online (v6 Real Brain)
║  • ID: ${BOT_ID}
║  • Keys: ${groq.allStats().length} | Avail: ${groq.available()} reqs
║  • Fast: ${FAST}
║  • Deep: ${DEEP}
╚══════════════════════════════════════════╝`);

    botClient!.user!.setPresence({ status: 'online', activities: [{ name: 'the vibes', type: 3 }] });

    // Upsert identity for all guilds on boot
    for (const g of botClient!.guilds.cache.values()) {
      await upsertServerIdentity(g);
      // Load all members into Firebase
      const members = await g.members.fetch().catch(() => null);
      if (members) {
        for (const [uid, member] of members) {
          if (member.user.bot) continue;
          await upsertMember(g.id, uid, {
            displayName: member.displayName,
            username:    member.user.username,
          });
        }
        console.log(`[Boot] Synced ${members.size} members for ${g.name}`);
      }
    }

    startProfilerLoop(botClient!);
  });

  botClient.on(Events.MessageCreate, handleMessage);

  // New member joins → register them
  botClient.on(Events.GuildMemberAdd, async (member) => {
    if (member.user.bot) return;
    await upsertMember(member.guild.id, member.id, {
      displayName: member.displayName,
      username:    member.user.username,
      joinedAt:    new Date().toISOString(),
    });
  });

  // ── Admin commands ────────────────────────────────────────────
  botClient.on(Events.MessageCreate, async (msg) => {
    if (!msg.member?.permissions.has('Administrator') && !msg.member?.permissions.has('ManageMessages')) return;

    const c = msg.content.trim();

    if (c === '!groq') {
      const lines = groq.allStats().map(s =>
        `...${s.key.slice(-6)}: ${s.requestsToday}req ${s.errorsToday}err ${s.isHealthy ? '✓' : '✗'}${s.cooldownUntil && Date.now() < s.cooldownUntil ? ` cd:${Math.ceil((s.cooldownUntil - Date.now()) / 1000)}s` : ''}`
      ).join('\n');
      await msg.reply(`\`\`\`\n${lines}\navail: ${groq.available()}\n\`\`\``);
    }

    if (c === '!state' && msg.guildId) {
      const s = await getSpeakState(msg.channelId, msg.guildId);
      await msg.reply(`mode: **${s.mode}**${s.resumeAt ? ` resumes <t:${Math.round(s.resumeAt / 1000)}:R>` : ''}\nreason: ${s.reason}`);
    }

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

    if (c === '!memory' && msg.guildId) {
      const m = await getMemory(msg.guildId);
      await msg.reply([
        `**facts (${m.facts.length}):** ${m.facts.slice(-5).join(' | ') || 'none'}`,
        `**corrections (${m.corrections.length}):** ${m.corrections.slice(-5).join(' | ') || 'none'}`,
        `**inside jokes (${m.insideJokes.length}):** ${m.insideJokes.slice(-5).join(' | ') || 'none'}`,
      ].join('\n'));
    }

    if (c.startsWith('!remember ') && msg.guildId) {
      const fact = c.slice(10).trim();
      await writeFact(msg.guildId, fact, 'facts');
      await msg.reply(`noted: "${fact}"`);
    }

    if (c.startsWith('!forget ') && msg.guildId) {
      const bucket = c.slice(8).trim() as keyof GlobalMemory;
      if (['facts', 'corrections', 'insideJokes'].includes(bucket)) {
        await db.collection('servers').doc(msg.guildId).collection('memory').doc('global')
          .set({ [bucket]: [] }, { merge: true });
        memCache.delete(msg.guildId);
        await msg.reply(`cleared ${bucket}`);
      }
    }

    if (c === '!stm') {
      const stm = stmGet(msg.channelId);
      const out = stmFormat(stm, Date.now());
      // Send in chunks if too long
      const chunks = out.match(/.{1,1900}/gs) || [];
      for (const chunk of chunks.slice(0, 3)) await msg.reply(`\`\`\`\n${chunk}\n\`\`\``);
    }
  });

  await botClient.login(token);
}

export function stopBot() {
  botClient?.destroy(); botClient = null;
  if (profilerTimer) clearInterval(profilerTimer);
}

export function getBotStatus() { return botClient ? 'running' : 'stopped'; }
