import {
  Client, GatewayIntentBits, Message, Partials,
  Events, TextChannel, PermissionFlagsBits,
} from 'discord.js';
import { db } from './firebase.ts';
import { chessManager } from './chessGames.ts';
import * as fs from 'node:fs';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// set DEBUG_LOG_REQUESTS=true in your env to write every exact Gemini request
// body to ./debug_last_request.txt (overwritten each call) — flip it on when
// you want to see live what's actually being sent, leave it off in normal
// production runs so it's not doing disk I/O on every single message.
const DEBUG_LOG_REQUESTS = process.env.DEBUG_LOG_REQUESTS === 'true';

// ── MODELS ───────────────────────────────────────────────────────
const ACTIVE_MODEL  = 'gemini-3.1-flash-lite'; // every msg while engaged + ping triage — fast, cheap, decides like a human would
const PASSIVE_MODEL = 'gemma-4-26b-a4b-it';    // 5-min huge-context scan of the channel it's interested in — slower, thinks it through
const BG_MODEL      = 'gemma-4-31b-it';        // profiler / compress / history-log utility jobs (unrelated to the convo loop)

// ── VISION ───────────────────────────────────────────────────────
// inline image data for a single Gemini multimodal call. base64 + mime type,
// nothing persisted — fetched fresh per brain() call and thrown away after.
interface ImagePart { mimeType: string; data: string; }

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

  // responseMimeType forces JSON on models that honor it. some smaller/open
  // models (gemma) don't reliably honor it and will instead narrate prose
  // about what it's going to do — maxOutputTokens cuts that off before it
  // burns the whole generation on rambling instead of ever emitting "{".
  async call(
    systemPrompt: string,
    userPrompt: string,
    temp = 0.9,
    model = ACTIVE_MODEL,
    images: ImagePart[] = [],
    maxOutputTokens?: number,
  ): Promise<string> {
    // images go BEFORE the text part — that's the order Gemini's multimodal
    // input expects for best grounding (look at the picture, then read what's
    // being asked about it, not the other way around).
    const userParts = [
      ...images.map(img => ({ inlineData: { mimeType: img.mimeType, data: img.data } })),
      { text: userPrompt },
    ];
    const generationConfig: Record<string, any> = { temperature: temp, responseMimeType: 'application/json' };
    if (maxOutputTokens) generationConfig.maxOutputTokens = maxOutputTokens;

    const requestBody = {
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: userParts }],
      generationConfig,
    };

    if (DEBUG_LOG_REQUESTS) {
      try {
        // redact actual base64 image bytes — you want to see the shape of the
        // request, not megabytes of encoded pixels in a text file.
        const loggable = {
          ...requestBody,
          contents: [{
            role: 'user',
            parts: userParts.map((p: any) =>
              p.inlineData ? { inlineData: { mimeType: p.inlineData.mimeType, data: `[base64 omitted, ${Math.round(p.inlineData.data.length * 0.75 / 1024)}kb]` } } : p
            ),
          }],
        };
        const dump = [
          `── ${new Date().toISOString()} ──`,
          `endpoint: https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
          `model: ${model} | temp: ${temp} | maxOutputTokens: ${maxOutputTokens ?? '(none)'}`,
          '',
          '--- FULL REQUEST BODY (what actually gets POSTed) ---',
          JSON.stringify(loggable, null, 2),
        ].join('\n');
        fs.writeFileSync('./debug_last_request.txt', dump, 'utf8');
      } catch (e: any) {
        console.warn('[Debug] failed to write request dump:', e.message?.slice(0, 80));
      }
    }

    let lastError = '';
    const maxAttempts = Math.min(4, Math.max(this.keys.length, 1) * 2);
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const key = this.pickKey();
      if (!key) { lastError = 'no keys available'; throw new Error('[Gemini] no keys available'); }
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody),
          }
        );
        if (res.status === 429) {
          const body = await res.json().catch(() => ({})) as any;
          const retryMs = ((body?.error?.details?.[0]?.retryDelay?.seconds ?? 10) as number) * 1000;
          this.cooldowns.set(key, Date.now() + retryMs);
          console.warn(`[Gemini] ...${key.slice(-4)} 429 — cd ${retryMs / 1000}s`);
          lastError = '429 Rate Limit';
          continue;
        }
        if (!res.ok) {
          const err = await res.text().catch(() => res.statusText);
          throw new Error(`Gemini ${res.status}: ${err.slice(0, 120)}`);
        }
        const data = await res.json() as any;
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
        const finishReason = data.candidates?.[0]?.finishReason ?? 'unknown';
        console.log(`[Gemini:${model}] key=...${key.slice(-4)} | ${text.length}ch | finish=${finishReason}`);
        // a 200 with no actual text (blocked candidate, safety trip, empty
        // generation, etc.) is NOT a usable result — retry like any other
        // failure instead of letting an empty string masquerade as success.
        if (!text.trim()) {
          console.warn(`[Gemini] ...${key.slice(-4)} returned empty text (finish=${finishReason}) — retrying`);
          lastError = `empty text (finish=${finishReason})`;
          continue;
        }
        return text;
      } catch (e: any) {
        lastError = e.message ?? String(e);
        if (e.message?.includes('429')) continue;
        console.error(`[Gemini] attempt ${attempt + 1}: ${e.message?.slice(0, 80)}`);
        if (attempt < Math.max(this.keys.length, 1) * 2 - 1)
          await sleep(Math.min(1500 * 2 ** attempt, 10_000));
      }
    }
    throw new Error(`[Gemini] all attempts failed. Last error: ${lastError}`);
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
const EMBED_MODEL = 'gemini-embedding-001'; // text-embedding-004 was shut down by Google on Jan 14, 2026 — this is the current replacement

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
          body: JSON.stringify({
            content: { parts: [{ text: text.slice(0, 2000) }] },
            // gemini-embedding-001 defaults to 3072 dims — fine for accuracy,
            // but storing 60+ of those in one Firestore doc (memoryStore's
            // shape) would blow past the 1MiB per-document limit. 768 keeps
            // the same footprint the old text-embedding-004 vectors had.
            outputDimensionality: 768,
          }),
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

// ── VISION HELPERS (no extra API key — same Gemini endpoint already does multimodal) ──
// only ever called for the LIVE trigger message(s) of a brain() call, never for
// old STM history — refetching/re-sending images for every past message would
// be expensive and pointless. older image messages just show as a text tag
// ("[image attached]") in the transcript once they've scrolled past.
const MAX_VISION_IMAGES_PER_CALL = 2;     // cap payload size + cost per call
const MAX_IMAGE_FETCH_BYTES      = 4 * 1024 * 1024; // 4MB — sane ceiling for a meme/screenshot

function extractImageUrls(msg: Message): string[] {
  const urls: string[] = [];
  for (const att of msg.attachments.values()) {
    if ((att.contentType || '').startsWith('image/')) urls.push(att.url);
  }
  // opportunistic: covers raw image links Discord's already unfurled into an
  // embed by the time we see the message. link unfurls that land via a later
  // MessageUpdate (slow ones) are simply missed — not chasing that edge case.
  for (const emb of msg.embeds) {
    const u = emb.image?.url || emb.thumbnail?.url;
    if (u && !urls.includes(u)) urls.push(u);
  }
  return urls;
}

import sharp from 'sharp';

async function fetchImageAsBase64(url: string): Promise<ImagePart | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const mimeType = (res.headers.get('content-type') || '').split(';')[0].trim();
    if (!mimeType.startsWith('image/')) return null;
    const lenHeader = res.headers.get('content-length');
    if (lenHeader && Number(lenHeader) > MAX_IMAGE_FETCH_BYTES) return null;
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_IMAGE_FETCH_BYTES) return null;

    // Gemini's inline vision input only reliably handles png/jpeg/webp/heic/heif —
    // NOT gif. sending raw gif bytes as mimeType image/gif is exactly why the
    // model "doesn't even know what it is": it's not a supported format, so the
    // vision path silently fails to parse it. grab frame 0 as a real png instead.
    if (mimeType === 'image/gif') {
      try {
        const png = await sharp(Buffer.from(buf), { animated: false }).png().toBuffer();
        return { mimeType: 'image/png', data: png.toString('base64') };
      } catch (e: any) {
        console.warn('[Vision] gif->png conversion failed:', e.message?.slice(0, 80));
        return null;
      }
    }

    return { mimeType, data: Buffer.from(buf).toString('base64') };
  } catch (e: any) {
    console.warn('[Vision] image fetch failed:', e.message?.slice(0, 80));
    return null;
  }
}

// pulls images for the LAST message first (the one actually being reacted to),
// then fills remaining slots from earlier messages in the same batch if room.
async function collectVisionImages(msgs: Message[]): Promise<ImagePart[]> {
  const urls: string[] = [];
  for (const m of [...msgs].reverse()) {
    for (const u of extractImageUrls(m)) {
      if (urls.length < MAX_VISION_IMAGES_PER_CALL && !urls.includes(u)) urls.push(u);
    }
  }
  if (!urls.length) return [];
  const fetched = await Promise.all(urls.map(fetchImageAsBase64));
  return fetched.filter((p): p is ImagePart => !!p);
}

// ── CONSTANTS ────────────────────────────────────────────────────
// note: no DEBOUNCE_MS / PASSIVE_EVERY / VELOCITY / MONOPOLY / MIN_BRAIN_GAP anymore —
// those were hard, code-level skip rules. the model decides skip/speak/react itself now.
const DM_DEBOUNCE_MS        = 1000;        // still useful: catches someone typing in 2 bursts
const STM_MAX               = 200;         // huge context, not truncated per-call anymore
const SESSION_BUFFER_MAX    = 300;
const GAP_MAJOR_MS          = 25 * 60_000; // just display formatting in the transcript
const GAP_MINOR_MS          =  5 * 60_000;
const PASSIVE_TICK_MS       =  5 * 60_000;
const SELF_CHECK_TICK_MS    =  6 * 60_000;
const PROACTIVE_TICK_MS     =  7 * 60_000;
const SELF_CHECK_QUIET_MS   =  4 * 60_000; // how long it waits before noticing it got ghosted
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

// ── PROACTIVE ENGAGEMENT CONSTANTS ───────────────────────────────
const PROACTIVE_QUIET_MS    = 35 * 60_000;  // channel must be this silent before notabot pokes in
const PROACTIVE_MIN_GAP_MS  = 50 * 60_000;  // minimum gap between proactive attempts (doubles each strike)
const PROACTIVE_MAX_STRIKES = 3;             // ignored this many times in a row → lose interest in this channel

// ── COLD OPEN CONSTANTS ────────────────────────────────────────────
// "cold open" — the bot's proactive DM-hopping behavior. when EVERY
// server has gone quiet (not just one channel — this is a global signal,
// separate from per-channel PROACTIVE_* above), the bot picks one real
// person from any mutual server, slides into their DMs with a short
// greeting, and waits a few minutes. no reply in that window → it gives up
// on that person for a while and the next sweep tries someone else instead.
// the point is "always talkative, never clingy" — one shot per person per
// cooldown, never a repeat ping while a previous one is still pending.
// NOTE: this is unrelated to the "wiki waka tiki" easter egg further down
// (exact-phrase trigger → DM's back "tiki waka wiki") — the two used to
// share a name, which is exactly the mismatch that got fixed here. keep
// them named differently going forward.
const COLD_OPEN_GLOBAL_QUIET_MS     = 20 * 60_000;  // every server must be this quiet (no human msg anywhere) before a DM-hop is even considered
const COLD_OPEN_SWEEP_INTERVAL_MS   = 4  * 60_000;  // how often we check whether it's time to hop into someone's DMs
const COLD_OPEN_WAIT_FOR_REPLY_MS   = 6  * 60_000;  // how long it lingers on one person before hopping to someone/something else
const COLD_OPEN_USER_COOLDOWN_MS    = 24 * 60 * 60_000; // don't re-ping the same person more than once per day
const COLD_OPEN_MAX_CANDIDATES_SCAN = 40;            // cap how many recent chatters we consider per sweep, just a sanity bound
const COLD_OPEN_CANDIDATE_MAX_AGE_MS = 24 * 60 * 60_000; // "active recently" window — online OR offline, doesn't matter, as long as they talked within the last 24h

// ── SLOW-TOOL-CALL STALL LINE ──────────────────────────────────────
// some commands are real network round trips (web_search, wiki_lookup,
// recall_memory, get_channel_info, any Firestore read) and can occasionally
// take a few seconds. previously: total silence in the channel until the
// result landed, however long that took — doesn't read as a person, reads
// as a frozen bot. now: if executeCommand hasn't resolved within
// STALL_THRESHOLD_MS, drop one casual "still here" line so it feels like
// someone actually went and checked, not like the bot hung. only fires
// once per command call, and only if it's actually still pending —
// resolves instantly → no stall line, nothing extra ever gets sent.
const STALL_THRESHOLD_MS = 3500;
const STALL_LINES = [
  'lemme get it', 'wait a min', 'one sec', 'hold on lemme check',
  'gimme a sec', 'lemme look', 'one moment', 'checking rn hold on',
];

let BOT_NAME  = 'NotABot';
let BOT_ID    = '';
let BOT_AVATAR_DESC = '';
let botClient: Client | null = null;

// global kill switch, separate from per-channel speakState (!pause/!sleep/!wake
// are per-channel; this is everywhere, all servers, all DMs, until !gresume).
// the client stays connected and logged in while muted — !gresume works because
// of that. !shutdown is the one that actually disconnects and can't be undone
// from inside discord.
let globallyMuted = false;

// bot owner — only this user ID can run global admin commands (!gmute/!gresume/!shutdown etc.)
const ADMIN_ID = '1296109674361520146';

// per-server mute: server admins (anyone with Administrator perm) can !stop / !resume the bot
// in their own server without affecting other servers. stored in-memory + persisted to Firebase.
const serverMuted = new Map<string, boolean>();
const serverFamilyFriendly = new Map<string, boolean>();

// per-server "which other bots am i allowed to see" — empty/missing set = ignore
// every other bot (the historical default). server admins add/remove bot IDs
// with !listenbot / !ignorebot. stored in-memory + persisted to Firebase.
const serverBotAllowlist = new Map<string, Set<string>>();

// per-server "which channels am i allowed to talk in" — undefined/missing = every
// channel (the historical default). server admins scope it down with !listenhere /
// !unlisten, or reset with !listenall. stored in-memory + persisted to Firebase.
const serverChannelAllowlist = new Map<string, Set<string>>();

// per-channel proactive engagement state — tracks how many times notabot tried
// to start something and got ignored, and whether it's given up on this channel.
// resets when someone actually talks (renewed interest).
interface ProactiveState { lastAt: number; strikes: number; lostInterest: boolean; }
const proactiveStates = new Map<string, ProactiveState>();

function getProactiveState(channelId: string): ProactiveState {
  let s = proactiveStates.get(channelId);
  if (!s) { s = { lastAt: 0, strikes: 0, lostInterest: false }; proactiveStates.set(channelId, s); }
  return s;
}

// ── COLD OPEN STATE (DM-hopping) ──────────────────────────────────
// one entry per user the bot has DM-pinged, keyed by userId. "pending" means
// the bot is currently lingering, waiting to see if they reply within the
// window — handleDirectMessage clears this the moment a reply actually
// lands, which is what lets the bot "stay" on someone who responds instead
// of hopping away from a person who's actually engaging.
interface ColdOpenState { lastPingAt: number; pending: boolean; hopTimer: NodeJS.Timeout | null; }
const coldOpenStates = new Map<string, ColdOpenState>();
let coldOpenTargetUserId: string | null = null; // who it's currently "on" — null when nobody's pending

function clearColdOpenHop(userId: string) {
  const s = coldOpenStates.get(userId);
  if (s?.hopTimer) { clearTimeout(s.hopTimer); s.hopTimer = null; }
  if (s) s.pending = false;
  if (coldOpenTargetUserId === userId) { coldOpenTargetUserId = null; updatePresence(); }
}

// ── LIVE "WHERE AM I" STATUS ────────────────────────────────────────
// human-readable read of what the bot is currently paying attention to —
// either its passive-scan focus channel, or a cold-open DM it's
// currently lingering in. used for the bot's own Discord presence text
// (so anyone can glance and see it "typing dots" somewhere) and for admin
// commands/natural asks like "where are you right now".
function whereAmI(): string {
  if (coldOpenTargetUserId) {
    const name = idCache.get(coldOpenTargetUserId) || coldOpenTargetUserId;
    return `DMing ${name}`;
  }
  if (focus?.channelId && botClient) {
    const ch = botClient.channels.cache.get(focus.channelId) as any;
    const guildName = ch?.guildId ? (serverNameCache.get(ch.guildId) || 'a server') : null;
    const chName = channelNameCache.get(focus.channelId) || ch?.name;
    if (guildName && chName) return `#${chName} in ${guildName}`;
    if (chName) return `#${chName}`;
  }
  return 'floating around, nothing locked in';
}

let lastPresenceText = '';
function updatePresence() {
  if (!botClient?.user) return;
  const text = whereAmI();
  if (text === lastPresenceText) return; // avoid hammering the gateway on every tiny tick
  lastPresenceText = text;
  botClient.user.setPresence({ status: 'online', activities: [{ name: text, type: 3 }] }); // type 3 = "Watching ..."
}

// global "has anything happened anywhere" signal — max lastActivityAt across
// every tracked channel in every guild. deliberately NOT scoped to one
// channel or guild, since the trigger for this feature is "the whole place
// has gone quiet," not "this one channel is dead" (that's PROACTIVE_* above).
function msSinceAnyGuildActivity(): number {
  let mostRecent = 0;
  for (const state of channelState.values()) {
    // relevant-only: someone actually engaging the bot, not just chatter
    // happening near it. this is what decides "the whole place has gone
    // quiet enough to go looking for someone in DMs."
    if (state.lastRelevantAt > mostRecent) mostRecent = state.lastRelevantAt;
  }
  if (!mostRecent) return Infinity; // no activity tracked yet at all — treat as "quiet"
  return Date.now() - mostRecent;
}

interface ColdOpenCandidate {
  userId: string;
  name: string;
  guildId: string;
  lastMsg: string;       // empty string if they've never talked
  online: boolean;
  recencyMs: number;
  bond: number;
  isNew: boolean;        // true = never talked to the bot before (seenCount == 0 or no record)
}

// Candidate pool is TWO layers:
//  Layer 1 (NEW): people who have NEVER talked to the bot before (seenCount 0 or no record).
//                 Sub-pass A: recent chatters in stmStore (catches invisible/offline people actively typing).
//                 Sub-pass B: online members in guild cache (catches lurkers who haven't typed yet).
//                 These get absolute priority — the bot should be making new friends, not re-pinging regulars.
//  Layer 2 (KNOWN): recent chatters from stmStore who are NOT on cooldown (fallback if nobody new is around).
// Final sort: Layer 1 first (shuffled), Layer 2 sorted online-then-recent.
async function getColdOpenCandidates(): Promise<ColdOpenCandidate[]> {
  if (!botClient) return [];
  const now = Date.now();

  // ── LAYER 1A: New people who typed recently (even if invisible) ──
  // Walk stmStore for anyone who spoke in the last 6 hours with no bot record.
  const NEW_RECENT_WINDOW_MS = 6 * 60 * 60_000; // talked in last 6 hours
  const newSeenIds = new Set<string>(); // dedup across sub-passes
  const newCandidates: ColdOpenCandidate[] = [];

  for (const [channelId, msgs] of stmStore.entries()) {
    if (newCandidates.length >= 15) break;
    const ch = botClient.channels.cache.get(channelId) as any;
    const guildId = ch?.guildId;
    if (!guildId) continue;
    if (serverMuted.get(guildId)) continue;

    for (const m of [...msgs].reverse()) {
      if (m.authorId === BOT_ID || !m.authorId) continue;
      if (newSeenIds.has(m.authorId)) continue;
      if (coldOpenTargetUserId === m.authorId) continue;
      const hopState = coldOpenStates.get(m.authorId);
      if (hopState && now - hopState.lastPingAt < COLD_OPEN_USER_COOLDOWN_MS) continue;
      const recencyMs = now - m.ts;
      if (recencyMs > NEW_RECENT_WINDOW_MS) continue; // too stale, skip

      const memberData = await getMember(guildId, m.authorId).catch(() => ({} as MemberData));
      const isNew = !memberData.seenCount || memberData.seenCount === 0;
      if (!isNew) continue; // known person — falls into Layer 2

      const guild = botClient.guilds.cache.get(guildId);
      const member = guild?.members.cache.get(m.authorId);
      const status = member?.presence?.status;
      const online = status === 'online' || status === 'idle' || status === 'dnd';

      newSeenIds.add(m.authorId);
      newCandidates.push({
        userId: m.authorId,
        name: m.author,
        guildId,
        lastMsg: m.content.slice(0, 100),
        online,
        recencyMs,
        bond: memberData.bond ?? 50,
        isNew: true,
      });
      break;
    }
  }

  // ── LAYER 1B: New people who are online/idle but haven't typed yet (lurkers) ──
  for (const guild of botClient.guilds.cache.values()) {
    if (serverMuted.get(guild.id)) continue;
    if (newCandidates.length >= 20) break;

    for (const member of guild.members.cache.values()) {
      if (member.user.bot || member.id === BOT_ID) continue;
      if (newSeenIds.has(member.id)) continue;
      if (coldOpenTargetUserId === member.id) continue;
      const hopState = coldOpenStates.get(member.id);
      if (hopState && now - hopState.lastPingAt < COLD_OPEN_USER_COOLDOWN_MS) continue;

      const status = member.presence?.status;
      const online = status === 'online' || status === 'idle' || status === 'dnd';
      if (!online) continue; // can't reach lurkers who are offline AND haven't typed

      const memberData = await getMember(guild.id, member.id).catch(() => ({} as MemberData));
      const isNew = !memberData.seenCount || memberData.seenCount === 0;
      if (!isNew) continue;

      newSeenIds.add(member.id);
      newCandidates.push({
        userId: member.id,
        name: member.displayName || member.user.username,
        guildId: guild.id,
        lastMsg: '',
        online: true,
        recencyMs: Number.MAX_SAFE_INTEGER, // no recent msg, sort below recent-typers
        bond: memberData.bond ?? 50,
        isNew: true,
      });
      if (newCandidates.length >= 20) break;
    }
  }

  // ── LAYER 2: Fallback — known recent chatters not on cooldown ──
  const knownCandidates: ColdOpenCandidate[] = [];
  const seen = new Map<string, Omit<ColdOpenCandidate, 'bond' | 'isNew'>>();

  for (const [channelId, msgs] of stmStore.entries()) {
    if (seen.size >= COLD_OPEN_MAX_CANDIDATES_SCAN) break;
    const ch = botClient.channels.cache.get(channelId) as any;
    const guildId = ch?.guildId;
    if (!guildId) continue;
    if (serverMuted.get(guildId)) continue;

    for (const m of [...msgs].reverse()) {
      if (m.authorId === BOT_ID || !m.authorId) continue;
      if (newSeenIds.has(m.authorId)) continue; // already in Layer 1, don't duplicate
      const existing = seen.get(m.authorId);
      const recencyMs = now - m.ts;
      if (recencyMs > COLD_OPEN_CANDIDATE_MAX_AGE_MS) continue;
      if (existing && existing.recencyMs <= recencyMs) continue;
      const hopState = coldOpenStates.get(m.authorId);
      if (hopState && now - hopState.lastPingAt < COLD_OPEN_USER_COOLDOWN_MS) continue;
      if (coldOpenTargetUserId === m.authorId) continue;

      const guild = botClient.guilds.cache.get(guildId);
      const member = guild?.members.cache.get(m.authorId);
      const status = member?.presence?.status;
      const online = status === 'online' || status === 'idle' || status === 'dnd';

      seen.set(m.authorId, { userId: m.authorId, name: m.author, guildId, lastMsg: m.content.slice(0, 100), online, recencyMs });
      break;
    }
  }

  if (seen.size > 0) {
    const withBonds = await Promise.all(
      [...seen.values()].map(async (c) => {
        const m = await getMember(c.guildId, c.userId).catch(() => ({} as MemberData));
        return { ...c, bond: m.bond ?? 50, isNew: false } as ColdOpenCandidate;
      })
    );
    knownCandidates.push(...withBonds);
  }

  // shuffle Layer 1 so we don't always greet the same new person
  const shuffle = <T>(arr: T[]): T[] => arr.sort(() => Math.random() - 0.5);

  // Within Layer 1: sort recent typers before pure lurkers
  const newSorted = newCandidates.sort((a, b) => a.recencyMs - b.recencyMs);

  return [
    ...shuffle(newSorted),
    ...knownCandidates.sort((a, b) => {
      if (a.online !== b.online) return a.online ? -1 : 1;
      return a.recencyMs - b.recencyMs;
    }),
  ];
}

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

// Scans every other channel in stmStore for recent messages from this user.
// Gives the brain cross-server context so it knows what someone said elsewhere.
function getRecentCrossChannelCtx(userId: string, excludeChannelId: string): string {
  const now = Date.now();
  const WINDOW_MS = 3 * 60 * 60_000; // look back 3 hours max
  const hits: { ago: number; where: string; content: string }[] = [];

  for (const [chId, msgs] of stmStore.entries()) {
    if (chId === excludeChannelId) continue;
    for (const m of msgs) {
      if (m.authorId !== userId) continue;
      const ago = now - m.ts;
      if (ago > WINDOW_MS) continue;
      // resolve a readable location from Discord client cache (includes server name)
      const discordCh = botClient?.channels.cache.get(chId);
      const chName    = (discordCh as any)?.name ?? channelNameCache.get(chId);
      const guildName = (discordCh as any)?.guild?.name ?? serverNameCache.get((discordCh as any)?.guildId ?? '');
      const location  = guildName && chName ? `${guildName} #${chName}`
                      : guildName           ? guildName
                      : chName              ? `#${chName}`
                      : 'another channel';
      hits.push({ ago, where: location, content: m.content.slice(0, 120) });
    }
  }

  if (!hits.length) return '';
  // most recent first, cap at 5 lines so it doesn't bloat the prompt
  hits.sort((a, b) => a.ago - b.ago);
  return hits.slice(0, 5).map(h => {
    const t = h.ago < 60_000 ? `${Math.round(h.ago/1000)}s ago` : `${Math.round(h.ago/60_000)}m ago`;
    return `[${t} in ${h.where}]: "${h.content}"`;
  }).join('\n');
}


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
  // like lastActivityAt, but ONLY touched when a message was actually relevant
  // to the bot (mentioned / DM / reply to one of its own messages). this is
  // what quiet-timers (proactive engagement, cold-open) should read — random
  // chatter that has nothing to do with the bot must NOT reset "how long
  // since anyone actually talked to me."
  lastRelevantAt:              number;
  lastBotMsgAt:                number;   // 0 = hasn't spoken
  gotResponseSinceLastBotMsg:  boolean;
  // how many UNPROMPTED messages in a row it's jumped in on — i.e. nobody
  // pinged it, it's not mid-exchange with the sender, it just had a quip.
  // any actual ignore resets this to 0. mentioned/DM/in-exchange replies
  // don't touch it either way — being directly engaged isn't "talking too much."
  consecutiveUnpromptedReplies: number;
  // userId of whoever triggered the last bot reply — used for the same-sender
  // rapid-fire guard (don't reply to every quick follow-up from the same person).
  lastRepliedToSenderId:       string;
}
const channelState = new Map<string, ChannelState>();

function getChState(channelId: string): ChannelState {
  let s = channelState.get(channelId);
  if (!s) {
    s = { mode: 'passive', goal: '', lastActivityAt: Date.now(), lastRelevantAt: Date.now(), lastBotMsgAt: 0, gotResponseSinceLastBotMsg: true, consecutiveUnpromptedReplies: 0, lastRepliedToSenderId: '' };
    channelState.set(channelId, s);
  }
  if (s.mode === 'active' && Date.now() - s.lastActivityAt > ACTIVE_IDLE_REVERT_MS) {
    s.mode = 'passive'; s.goal = ''; s.consecutiveUnpromptedReplies = 0;
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

function touchActivity(channelId: string) {
  getChState(channelId).lastActivityAt = Date.now();
}

// call this ONLY when a message is actually relevant to the bot (mentioned,
// DM, or a reply to one of its own messages) — this is the timestamp the
// quiet-timers (proactive engagement, cold-open) should be reading, so unrelated
// chatter in a channel can't keep resetting "how long since anyone talked to me."
function touchRelevantActivity(channelId: string) {
  const s = getChState(channelId);
  s.lastActivityAt = Date.now();
  s.lastRelevantAt = Date.now();
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
  if (!focus) { focus = { channelId, since: now }; unreadCounts.delete(channelId); updatePresence(); return; }

  const focusExpired = now - focus.since > FOCUS_DRIFT_MS;
  const pingPulls     = mentioned && now - lastFocusShift > FOCUS_SHIFT_COST;
  if (focusExpired || pingPulls) {
    focus = { channelId, since: now };
    unreadCounts.delete(channelId);
    lastFocusShift = now;
    updatePresence();
    return;
  }
  unreadCounts.set(channelId, (unreadCounts.get(channelId) ?? 0) + 1);
}

function pickInterestChannel(): string | null {
  const now = Date.now();

  // if the bot has been staring at a dead channel for >10 minutes,
  // and there are other channels with unread messages, hop to them.
  if (focus && (now - focus.since > 10 * 60_000) && unreadCounts.size > 0) {
    const nextCh = [...unreadCounts.keys()][0];
    focus = { channelId: nextCh, since: now };
    unreadCounts.delete(nextCh);
    updatePresence();
    console.log(`[Focus] drifted to #${nextCh.slice(-5)} (clearing unreads)`);
    return nextCh;
  }

  return focus?.channelId ?? null;
}

// like pickInterestChannel but scoped to a specific guild — used by per-server YT notifications
// so each guild gets its own "most relevant" channel instead of competing over a single global focus.
function pickInterestChannelForGuild(guildId: string): string | null {
  if (!botClient) return null;
  // prefer the current global focus if it belongs to this guild
  if (focus?.channelId) {
    const fc = botClient.channels.cache.get(focus.channelId) as any;
    if (fc?.guildId === guildId) return focus.channelId;
  }
  // next: most recently active passive channel in this guild
  let best: string | null = null;
  let bestTs = 0;
  for (const [chId, state] of channelState.entries()) {
    if (state.mode === 'active') continue; // skip — mid-convo, video gets queued
    const ch = botClient.channels.cache.get(chId) as any;
    if (ch?.guildId !== guildId) continue;
    if (state.lastActivityAt > bestTs) { bestTs = state.lastActivityAt; best = chId; }
  }
  if (best) return best;
  // fallback: first text channel in the guild that we can see
  const guild = botClient.guilds.cache.get(guildId);
  if (!guild) return null;
  return guild.channels.cache.find(c => c.isTextBased() && !c.isDMBased())?.id ?? null;
}

// ── FIREBASE / MEMORY ─────────────────────────────────────────────
// ── UNIFIED MEMORY ENGINE ──────────────────────────────────────────
// ONE storage shape for everything the bot remembers, instead of five parallel
// structures (facts/jokes/patterns/arcs/openLoops buckets + a hand-synced
// memoryVectors shadow table + a separate person about/state store). Adding a
// new KIND of thing to remember ("grudge", "running-bit", whatever) needs zero
// new code — "kind" is just a string the model writes at call time, not a
// fixed enum wired into a dedicated bucket/function/cap.
//
// two scopes, same engine:
//   'server' — scopeId = guildId. gossip/jokes/arcs. deliberately NEVER read
//              across guilds (see getCrossServerInfo below for the one
//              intentional exception: presence only, never facts).
//   'person' — scopeId = userId. follows the person everywhere they talk to
//              the bot, on purpose — this is the "remembers you're a person,
//              not a new blank slate per room" piece.
//
// embeddings are attached at write time, not synced afterward, so there's no
// second table that can drift out of sync with the first. new memories are
// checked against existing ones for the same scope+subject+kind by cosine
// similarity — a close match gets REINFORCED (salience bump, text refreshed)
// instead of duplicated, so "stressed about grades" said three times doesn't
// become three stale entries, it becomes one entry that gets more confident.
// salience decays with time (half-life below) and eviction drops the least-
// reinforced, least-recent entry first when a scope hits its cap — not
// whichever happens to be oldest, like the old FIFO buckets did.
interface Memory {
  id:               string;
  kind:             string;            // free-form — "fact","joke","running-bit","about","state","arc","open-loop", anything
  text:             string;
  subjectUserId?:   string;            // who this is about, if it's about someone specific
  sourceLabel?:     string;            // display-only context, e.g. a guild name for a person-scoped memory
  embedding:        number[];
  salience:         number;            // 0–1, boosted on reinforcement
  createdAt:        string;
  lastReinforcedAt: string;
  expiresAt?:       string;            // only short-lived kinds (e.g. person 'state') set this
}

const SALIENCE_HALF_LIFE_DAYS = 10;    // how fast an unreinforced memory fades from ambient context
const REINFORCE_BUMP          = 0.35;
const UPDATE_SIM_THRESHOLD    = 0.86;  // cosine similarity above this = "same memory", reinforce don't duplicate
const SERVER_MEM_CAP          = 60;
const PERSON_MEM_CAP          = 40;

const memStoreCache = new Map<string, { d: Memory[]; ts: number }>();

function memDocId(scope: 'server' | 'person', scopeId: string): string {
  return `${scope}:${scopeId}`;
}

function effectiveSalience(m: Memory): number {
  const ageDays = (Date.now() - new Date(m.lastReinforcedAt).getTime()) / (24 * 60 * 60 * 1000);
  return m.salience * Math.pow(0.5, ageDays / SALIENCE_HALF_LIFE_DAYS);
}

async function loadMemories(scope: 'server' | 'person', scopeId: string): Promise<Memory[]> {
  const key = memDocId(scope, scopeId);
  const c = memStoreCache.get(key);
  if (c && Date.now() - c.ts < 120_000) return c.d;
  try {
    const snap = await db.collection('memoryStore').doc(key).get();
    const now = Date.now();
    const all = ((snap.data()?.entries ?? []) as Memory[]).filter(m => !m.expiresAt || new Date(m.expiresAt).getTime() > now);
    memStoreCache.set(key, { d: all, ts: Date.now() });
    return all;
  } catch { return []; }
}

async function saveMemories(scope: 'server' | 'person', scopeId: string, entries: Memory[]) {
  const key = memDocId(scope, scopeId);
  memStoreCache.delete(key);
  // Firestore throws a hard, uncaught-worthy error on ANY undefined field
  // (not just top-level — nested too, like entries[].subjectUserId here).
  // subjectUserId/sourceLabel/expiresAt are undefined on most entries, so
  // every server-scoped write (which never sets subjectUserId) was one
  // Firestore call away from crashing the entire process. JSON round-trip
  // strips undefined keys cleanly since JSON.stringify just omits them —
  // simplest fix that can't silently miss a nested field later.
  const clean = JSON.parse(JSON.stringify(entries));
  try {
    await db.collection('memoryStore').doc(key).set({ entries: clean }, { merge: false });
  } catch (e: any) {
    // Firestore's .set() can throw SYNCHRONOUSLY on invalid data (validation
    // runs before the promise exists) — a bare .catch() on the call doesn't
    // protect against that, only try/catch around the call does. this is
    // exactly the class of bug that just took the whole process down.
    console.warn('[Mem] save failed:', e.message?.slice(0, 120));
  }
}

// the one write path for everything the bot remembers.
async function remember(
  scope: 'server' | 'person',
  scopeId: string,
  text: string,
  kind: string,
  opts: { subjectUserId?: string; sourceLabel?: string; ttlMs?: number } = {},
) {
  if (!text?.trim() || !scopeId || scopeId === 'dm') return;
  const entries = await loadMemories(scope, scopeId);
  const vector = await embedder.embed(text.trim());
  const now = new Date().toISOString();

  if (vector) {
    const sameKind = entries.filter(m => m.kind === kind && m.subjectUserId === opts.subjectUserId);
    let best: Memory | null = null, bestScore = 0;
    for (const m of sameKind) {
      if (!m.embedding?.length) continue;
      const score = embedder.cosineSim(vector, m.embedding);
      if (score > bestScore) { bestScore = score; best = m; }
    }
    if (best && bestScore >= UPDATE_SIM_THRESHOLD) {
      // reinforce instead of duplicating — same underlying memory, said again.
      best.text = text.trim(); // refresh wording to the latest phrasing
      best.embedding = vector;
      best.salience = Math.min(1, best.salience + REINFORCE_BUMP);
      best.lastReinforcedAt = now;
      if (opts.ttlMs) best.expiresAt = new Date(Date.now() + opts.ttlMs).toISOString();
      if (opts.sourceLabel) best.sourceLabel = opts.sourceLabel;
      await saveMemories(scope, scopeId, entries);
      console.log(`[Mem:${scope}:${kind}] reinforced "${text.slice(0, 60)}" (${Math.round(bestScore * 100)}% match)`);
      return;
    }
  }

  const entry: Memory = {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    kind, text: text.trim(),
    subjectUserId: opts.subjectUserId,
    sourceLabel: opts.sourceLabel,
    embedding: vector ?? [],
    salience: 0.6,
    createdAt: now, lastReinforcedAt: now,
    expiresAt: opts.ttlMs ? new Date(Date.now() + opts.ttlMs).toISOString() : undefined,
  };
  entries.push(entry);

  const cap = scope === 'server' ? SERVER_MEM_CAP : PERSON_MEM_CAP;
  if (entries.length > cap) {
    entries.sort((a, b) => effectiveSalience(a) - effectiveSalience(b));
    entries.splice(0, entries.length - cap); // drop the least-salient, not just the oldest
  }
  await saveMemories(scope, scopeId, entries);
  console.log(`[Mem:${scope}:${kind}] +"${text.slice(0, 60)}"`);
}

// ambient context for a brain() call — top memories by effective salience,
// not query-matched (this is "what's generally worth knowing right now",
// used on every call, vs. searchMemories below which is on-demand lookup).
async function getTopMemories(scope: 'server' | 'person', scopeId: string, opts: { subjectUserId?: string; limit?: number } = {}): Promise<Memory[]> {
  const entries = await loadMemories(scope, scopeId);
  const filtered = opts.subjectUserId ? entries.filter(m => m.subjectUserId === opts.subjectUserId || !m.subjectUserId) : entries;
  return filtered
    .map(m => ({ m, s: effectiveSalience(m) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, opts.limit ?? 20)
    .map(x => x.m);
}

// on-demand semantic search — the recall_memory command's backend.
async function searchMemories(scope: 'server' | 'person', scopeId: string, query: string, topK = 5): Promise<string> {
  const entries = await loadMemories(scope, scopeId);
  if (!entries.length) return 'nothing stored in memory yet';
  const queryVec = await embedder.embed(query);
  if (!queryVec) return 'semantic recall unavailable right now (embedding call failed)';
  const scored = entries
    .filter(m => m.embedding?.length)
    .map(m => ({ text: m.text, kind: m.kind, score: embedder.cosineSim(queryVec, m.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
  if (!scored.length) return 'nothing relevant found';
  return scored.map(s => `[${s.kind}] ${s.text} (match: ${Math.round(s.score * 100)}%)`).join('\n');
}

// compact prompt-ready dump of what's worth knowing right now for a server.
async function buildMemCtx(guildId: string): Promise<string> {
  if (guildId === 'dm') return '';
  const top = await getTopMemories('server', guildId, { limit: 20 });
  if (!top.length) return '';
  const byKind = new Map<string, string[]>();
  for (const m of top) {
    if (!byKind.has(m.kind)) byKind.set(m.kind, []);
    byKind.get(m.kind)!.push(m.text);
  }
  return [...byKind.entries()].map(([kind, texts]) => `${kind}: ${texts.join(' | ')}`).join('\n');
}

// same idea, server-scoped semantic search — what recall_memory calls.
async function recallMemory(guildId: string, query: string, topK = 5): Promise<string> {
  if (guildId === 'dm') return 'no shared memory in DMs';
  return searchMemories('server', guildId, query, topK);
}

// compatibility shim for the old bucket-based writer (profiler/compress and
// !remember still call this with the old bucket names — those names just
// become the "kind" now, no fixed enum required).
async function addFact(guildId: string, fact: string, kind: string = 'fact') {
  await remember('server', guildId, fact, kind);
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

const memberCache = new Map<string, { d: MemberData; ts: number }>();


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

// ── PERSON MEMORY (thin wrapper over the unified engine, scope='person') ──
// this is the ONE thing that follows a person across every server/DM they
// talk to the bot in, on purpose, unlike server-scoped memories which are
// deliberately walled off per guild. same engine, same reinforce-don't-
// duplicate logic, same salience decay — 'about' entries just never get a
// ttl (durable identity), 'state' entries get a 4-day one (fades on its own
// so this never becomes a permanent mood-surveillance file on someone).
const PERSON_STATE_TTL_MS = 4 * 24 * 60 * 60 * 1000;

async function notePersonAbout(userId: string, fact: string) {
  await remember('person', userId, fact, 'about');
}

async function notePersonState(userId: string, note: string, guildName: string) {
  await remember('person', userId, note, 'state', { sourceLabel: guildName, ttlMs: PERSON_STATE_TTL_MS });
}

// what the bot actually carries into every conversation with this person,
// regardless of which server or DM it's happening in.
async function getPersonalCtx(userId: string): Promise<string> {
  if (!userId) return '';
  const top = await getTopMemories('person', userId, { limit: 15 });
  if (!top.length) return '';
  const about = top.filter(m => m.kind === 'about');
  const state = top.filter(m => m.kind === 'state');
  const other = top.filter(m => m.kind !== 'about' && m.kind !== 'state');
  const lines: string[] = [];
  if (about.length) lines.push(`about them: ${about.map(m => m.text).join('; ')}`);
  if (state.length) lines.push(`going on with them lately: ${state.map(m => `${m.text}${m.sourceLabel ? ` (from ${m.sourceLabel})` : ''}`).join('; ')}`);
  if (other.length) lines.push(other.map(m => `${m.kind}: ${m.text}`).join('; '));
  return lines.join('\n');
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
const BOT_INVITE_URL = process.env.BOT_INVITE_URL || ''; // discord dev portal → OAuth2 URL Generator (bot scope + perms), paste the full url here

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

// ── GIF & LINK UNDERSTANDING (ambient, automatic, no extra API keys) ──
// this is NOT the bot "browsing the web" — it's the same kind of glance a
// person gives a link before deciding whether to react. two tiers:
//  1. gif slug hint — free, no network call. tenor/giphy share links carry
//     their own description in the URL slug ("tenor.com/view/confused-cat-
//     blinking-23948572"), so we just read it off the URL.
//  2. link preview — one lightweight fetch of the page's <title>/og:description,
//     cached for a while so the same link posted twice doesn't refetch.
function gifSlugHint(content: string): string | null {
  let m = content.match(/tenor\.com\/view\/([a-z0-9-]+?)-\d{5,}/i);
  if (m) return m[1].replace(/-/g, ' ').trim();
  m = content.match(/giphy\.com\/(?:gifs|media)\/([a-z0-9-]+)/i);
  if (m) {
    const slug = m[1].replace(/-[a-zA-Z0-9]{6,}$/, ''); // strip trailing giphy id token
    return slug.replace(/-/g, ' ').trim() || null;
  }
  return null;
}

function extractGenericUrl(content: string): string | null {
  const m = content.match(/https?:\/\/[^\s<>]+/i);
  if (!m) return null;
  const url = m[0].replace(/[)\].,!?]+$/, ''); // strip trailing punctuation people leave on links
  if (/\.(gif|png|jpe?g|webp|mp4|mov|webm)(\?|$)/i.test(url)) return null; // direct media, not a "page"
  if (/tenor\.com|giphy\.com/i.test(url)) return null; // handled by gifSlugHint instead
  return url;
}

const linkPreviewCache = new Map<string, { preview: string | null; ts: number }>();
const LINK_PREVIEW_TTL_MS = 15 * 60_000;

async function fetchLinkPreview(url: string): Promise<string | null> {
  const cached = linkPreviewCache.get(url);
  if (cached && Date.now() - cached.ts < LINK_PREVIEW_TTL_MS) return cached.preview;
  let preview: string | null = null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NotABot-discord/1.0)' },
    });
    clearTimeout(timer);
    const ct = res.headers.get('content-type') || '';
    const lenHeader = res.headers.get('content-length');
    if (res.ok && ct.includes('text/html') && !(lenHeader && Number(lenHeader) > 1_000_000)) {
      const html  = (await res.text()).slice(0, 200_000);
      const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || '').trim();
      const desc  = (html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i)?.[1]
                 || html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)?.[1] || '').trim();
      preview = [title, desc].filter(Boolean).join(' — ').replace(/\s+/g, ' ').slice(0, 180) || null;
    }
  } catch (e: any) {
    console.warn('[LinkPreview] failed:', e.message?.slice(0, 80));
  }
  linkPreviewCache.set(url, { preview, ts: Date.now() });
  return preview;
}

// runs once per incoming message, tags the stored text with whatever it
// noticed (image/gif attached, gif vibe from a tenor/giphy link, or a quick
// page preview) — this is what makes its way into STM and the live prompt.
async function buildEnrichedContent(msg: Message, rawContent: string): Promise<string> {
  const tags: string[] = [];

  const imgUrls = extractImageUrls(msg);
  if (imgUrls.length) {
    const isGif = [...msg.attachments.values()].some(a => a.contentType === 'image/gif')
      || imgUrls.some(u => /\.gif(\?|$)/i.test(u));
    tags.push(isGif ? '[gif attached]' : '[image attached]');
  }

  const slug = gifSlugHint(rawContent);
  if (slug) {
    tags.push(`[gif: ${slug}]`);
  } else {
    const url = extractGenericUrl(rawContent);
    if (url) {
      const preview = await fetchLinkPreview(url);
      if (preview) tags.push(`(link → "${preview}")`);
    }
  }

  return tags.length ? `${rawContent} ${tags.join(' ')}`.trim() : rawContent;
}


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

// ── CROSS-SERVER LOOKUP (only if the bot is actually in more than one server) ──
// only ever surfaces PRESENCE — "they're also in server X, bond Y" — never
// server-specific facts/jokes/arcs. those stay scoped to buildMemCtx for the
// current guild only, so server A's gossip about someone never leaks into
// what the bot says about them in server B. if the bot's only in one
// server, this command is pointless and says so instead of doing anything.
async function getCrossServerInfo(currentGuildId: string, userId: string, name: string): Promise<string> {
  if (!botClient || botClient.guilds.cache.size < 2) {
    return 'only in one server right now — nothing to cross-reference';
  }
  const hits: string[] = [];
  for (const guild of botClient.guilds.cache.values()) {
    if (guild.id === currentGuildId) continue;
    try {
      const snap = await db.collection('servers').doc(guild.id).collection('members').doc(userId).get();
      if (snap.exists) {
        const m = snap.data() as MemberData;
        hits.push(`${guild.name} (bond ${m.bond ?? 50})`);
      }
    } catch {}
  }
  if (!hits.length) return `no record of ${name} in any other server you're in`;
  return `${name} is also known in: ${hits.join(', ')} — presence/bond only, no details carried over`;
}

// ── REMINDERS (in-memory setTimeout, same pattern as the existing pause/timer infra) ──
// honest limitation: these live in memory only — a process restart loses
// anything pending. fine for "remind me in an hour", not a real scheduling
// system. capped count + duration so it can't be used to leak memory or
// spam far-future timers.
const REMINDER_MAX_MINS   = 24 * 60; // 1 day out, max
const REMINDER_MAX_ACTIVE = 200;     // global cap across all channels
let activeReminderCount = 0;

function setReminder(channelId: string, guildId: string, mins: number, note: string, targetUserId?: string): string {
  const clamped = Math.min(Math.max(1, Math.round(mins)), REMINDER_MAX_MINS);
  if (activeReminderCount >= REMINDER_MAX_ACTIVE) return 'too many reminders pending right now, try again later';

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
    } catch (e: any) { console.warn('[Reminder] fire failed:', e.message?.slice(0, 80)); }
  }, clamped * 60_000);

  return `reminder set for ${clamped}m from now${note ? `: "${note.slice(0, 60)}"` : ''} (lost if the bot restarts before then)`;
}

// ── POLLS (native discord.js poll, not reaction-based) ──
// uses discord's real poll message type. question max 300 chars, up to 10
// answers max 55 chars each, duration in hours — these are DISCORD's own
// hard limits, not something we're choosing, so we clamp to them rather
// than let a bad call silently fail.
async function createPoll(channelId: string, question: string, options: string[], durationHours = 1): Promise<string> {
  const ch = botClient?.channels.cache.get(channelId) as TextChannel | undefined;
  if (!ch?.isTextBased()) return 'channel not available to post a poll in';
  const q = question.trim().slice(0, 300);
  const answers = options.map(o => o.trim()).filter(Boolean).slice(0, 10);
  if (!q || answers.length < 2) return 'need a question and at least 2 options to make a poll';
  const duration = Math.min(Math.max(1, Math.round(durationHours)), 168); // discord max is 7 days (168h)

  try {
    const sent = await ch.send({
      poll: {
        question: { text: q },
        answers: answers.map(text => ({ text: text.slice(0, 55) })),
        duration,
        allowMultiselect: false,
      },
    });
    stmPush(channelId, { ts: Date.now(), id: sent.id, authorId: BOT_ID, author: '[me]', content: `[poll] ${q}` });
    return `poll posted: "${q}" with ${answers.length} options, ${duration}h`;
  } catch (e: any) {
    return `poll failed: ${e.message?.slice(0, 80)}`;
  }
}

// ── WIKIPEDIA LOOKUP (free, no key, always available — settles "wait is that real" arguments) ──
async function wikiLookup(topic: string): Promise<string> {
  if (!topic?.trim()) return 'no topic given';
  try {
    const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(topic.trim().replace(/\s+/g, '_'))}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'NotABot-discord/1.0' } });
    if (res.status === 404) return `no wikipedia page found for "${topic}"`;
    if (!res.ok) return `wiki lookup failed: ${res.status}`;
    const data = await res.json() as any;
    if (data.type === 'disambiguation') return `"${topic}" is ambiguous — multiple wikipedia pages match, be more specific`;
    const extract = (data.extract || '').replace(/\s+/g, ' ').slice(0, 400);
    if (!extract) return `found "${data.title || topic}" but no summary text available`;
    return `${data.title || topic}: ${extract}`;
  } catch (e: any) {
    return `wiki lookup error: ${e.message?.slice(0, 60)}`;
  }
}

// ── XP / LEVELLING ───────────────────────────────────────────────
// every meaningful interaction with notabot earns points.
// stored per-user per-guild in Firebase under servers/{guildId}/xp/{userId}.
// levels unlock at every 150 XP — no gameplay gate, just a label and a
// level-up callout from the bot in channel (in character, not a system message).

const XP_PER_LEVEL = 150;

// threshold → name — evaluated top-down, first match wins
const LEVEL_TIERS: Array<[number, string]> = [
  [15, 'certified'],
  [10, 'main character'],
  [8,  'veteran'],
  [5,  'actually here'],
  [3,  'regular'],
  [2,  'showing up'],
  [1,  'exists'],
  [0,  'who'],
];
function getLevelName(level: number): string {
  for (const [thresh, name] of LEVEL_TIERS) if (level >= thresh) return name;
  return 'who';
}

const LEVEL_UP_LINES = [
  '{u} hit level {l} lmaooo',
  'wait {u} is actually level {l} now??',
  '{u} level {l}. this is ur life now huh',
  'congrats {u} on level {l} i guess 💀',
  '{u} grinded to level {l}. get a hobby fr',
  'level {l} {u}. certified regular at this point',
];

async function addXP(
  guildId: string, userId: string, username: string, amount: number
): Promise<{ newXP: number; newLevel: number; oldLevel: number; leveledUp: boolean }> {
  try {
    const ref  = db.collection('servers').doc(guildId).collection('xp').doc(userId);
    const snap = await ref.get();
    const oldXP    = (snap.data()?.xp ?? 0) as number;
    const oldLevel = Math.floor(oldXP / XP_PER_LEVEL);
    const newXP    = oldXP + amount;
    const newLevel = Math.floor(newXP / XP_PER_LEVEL);
    await ref.set({ xp: newXP, level: newLevel, username, updatedAt: Date.now() }, { merge: true });
    return { newXP, newLevel, oldLevel, leveledUp: newLevel > oldLevel };
  } catch {
    return { newXP: amount, newLevel: 0, oldLevel: 0, leveledUp: false };
  }
}

async function getUserXPData(guildId: string, userId: string) {
  try {
    const snap = await db.collection('servers').doc(guildId).collection('xp').doc(userId).get();
    const d = snap.data() ?? {};
    return { xp: (d.xp ?? 0) as number, level: (d.level ?? 0) as number, username: (d.username ?? 'unknown') as string };
  } catch { return { xp: 0, level: 0, username: 'unknown' }; }
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
  const line = LEVEL_UP_LINES[Math.floor(Math.random() * LEVEL_UP_LINES.length)];
  const text  = line.replace('{u}', `<@${userId}>`).replace('{l}', `${newLevel} (${getLevelName(newLevel)})`);
  try {
    await sleep(800);
    const sent = await ch.send(text);
    stmPush(channelId, { ts: Date.now(), id: sent.id, authorId: BOT_ID, author: '[me]', content: text });
  } catch {}
}

// ── EVENTS ────────────────────────────────────────────────────────
// brain starts events via the start_event command. each event has a participation
// window (or is instant for npc_check), then auto-judges via a brain call and
// announces the winner. one active event per guild at a time.

type EventType = 'hot_take' | 'roast_battle' | 'trivia' | 'npc_check';

interface EventEntry { userId: string; username: string; content: string; ts: number; }
interface ServerEvent {
  type:      EventType;
  channelId: string;
  guildId:   string;
  startedAt: number;
  endsAt:    number;
  entries:   EventEntry[];
  phase:     'open' | 'judging' | 'done';
  answer?:   string;         // trivia only — stored lowercase
  timerId?:  ReturnType<typeof setTimeout>;
}

const serverEvents = new Map<string, ServerEvent>(); // guildId → event

const EVENT_DURATIONS_MS: Record<EventType, number> = {
  hot_take:     3 * 60_000,
  roast_battle: 4 * 60_000,
  trivia:       2 * 60_000,
  npc_check:    0,            // instant judge from transcript
};

async function startEvent(
  guildId: string, channelId: string, type: EventType,
  opts: { answer?: string } = {},
): Promise<string> {
  if (serverEvents.has(guildId)) return 'already an event running in this server — wait for it to end';
  const duration = EVENT_DURATIONS_MS[type];
  const now = Date.now();
  const ev: ServerEvent = {
    type, channelId, guildId, startedAt: now, endsAt: now + duration,
    entries: [], phase: duration > 0 ? 'open' : 'done',
    answer: opts.answer ? opts.answer.toLowerCase().trim() : undefined,
  };
  serverEvents.set(guildId, ev);
  if (duration > 0) {
    ev.timerId = setTimeout(() => judgeEvent(guildId).catch(e => console.error('[Event]', e)), duration);
  } else {
    setTimeout(() => judgeEvent(guildId).catch(e => console.error('[Event]', e)), 200);
  }
  console.log(`[Event] ${type} started in guild ${guildId}`);
  return `event started: ${type}${duration ? ` (${duration / 60_000}min window)` : ' (instant)'}`;
}

async function judgeEvent(guildId: string) {
  const ev = serverEvents.get(guildId);
  if (!ev || ev.phase === 'done') return;
  ev.phase = 'judging';

  const ch = botClient?.channels.cache.get(ev.channelId) as TextChannel | undefined;
  if (!ch?.isTextBased()) { serverEvents.delete(guildId); return; }

  try {
    const memCtx     = await buildMemCtx(guildId);
    const liveMsgs   = stmGet(ev.channelId);
    const transcript = stmFormatWithMarker(liveMsgs, ev.channelId);
    const serverName = serverNameCache.get(guildId) ?? 'unknown';
    const channelName = (ch as any).name ?? ev.channelId.slice(-5);

    const entriesText = ev.entries.length
      ? ev.entries.map((e, i) => `${i + 1}. ${e.username}: "${e.content}"`).join('\n')
      : '(nobody participated)';

    const judgeContext = ev.type === 'npc_check'
      ? 'look at the recent transcript and pick the most quiet / boring / mid person. call them out specifically in your voice. award them the NPC title.'
      : `event: ${ev.type}\nentries:\n${entriesText}\n\npick a winner. be specific about why. roast the losers too if there's material.`;

    const brainOpts: BrainOpts = {
      model: PASSIVE_MODEL,
      sender: '(event-judge)',
      bond: 50,
      message: `time's up. judge this:\n${judgeContext}`,
      transcript, memCtx,
      mentioned: false, isDM: false,
      statusLine: `mode: event-judge | type: ${ev.type} | server: ${serverName} | channel: #${channelName}`,
      inExchange: false, channelName, serverName,
      everyonePing: false, endingConvo: false,
      selfNote: 'you ran this event. announce the result naturally — who won and why, brief roast of the rest. declare the winner clearly by name so the system can find them.',
    };

    const decision = await brain(brainOpts);
    ev.phase = 'done';
    serverEvents.delete(guildId);

    if (decision.action === 'speak' && decision.reply?.trim()) {
      const text = resolveMentionNames(decision.reply).slice(0, 400);

      // award XP: winner = first entry whose name appears in the reply
      const winnerEntry = ev.entries.find(e =>
        text.toLowerCase().includes(e.username.toLowerCase())
      );
      if (winnerEntry) {
        const r = await addXP(guildId, winnerEntry.userId, winnerEntry.username, 75);
        if (r.leveledUp) announceLevelUp(ev.channelId, winnerEntry.userId, r.newLevel).catch(() => {});
      }
      // participation XP for everyone else
      for (const entry of ev.entries) {
        if (winnerEntry && entry.userId === winnerEntry.userId) continue;
        await addXP(guildId, entry.userId, entry.username, 15).catch(() => {});
      }
      // consolation XP for npc_check subject
      if (ev.type === 'npc_check' && ev.entries.length === 0 && winnerEntry) {
        await addXP(guildId, winnerEntry.userId, winnerEntry.username, 5).catch(() => {});
      }

      try { await ch.sendTyping(); } catch {}
      await sleep(700);
      const sent = await ch.send(text);
      stmPush(ev.channelId, { ts: Date.now(), id: sent.id, authorId: BOT_ID, author: '[me]', content: text });
    }
  } catch (e) {
    console.error('[EventJudge]', e);
    serverEvents.delete(guildId);
  }
}

// called from handleMessage — silently adds user's message to the active event's entry list.
// returns true if added (caller can skip routing to brain if the channel is event-only mode).
function tryAddEventEntry(guildId: string, userId: string, username: string, content: string): boolean {
  const ev = serverEvents.get(guildId);
  if (!ev || ev.phase !== 'open') return false;
  if (ev.entries.some(e => e.userId === userId)) return false; // one entry per person
  ev.entries.push({ userId, username, content: content.slice(0, 300), ts: Date.now() });
  return true;
}

// ── WEEKLY NPC CHECK ─────────────────────────────────────────────
// fires every Sunday. notabot looks at recent activity and crowns the most
// mid/quiet person as NPC of the week. purely chaotic, no user action needed.
let lastWeeklyNPCAt = 0;
const WEEKLY_NPC_COOLDOWN_MS = 6 * 24 * 60 * 60_000;

async function runWeeklyNPC() {
  if (new Date().getDay() !== 0) return; // Sunday only
  const now = Date.now();
  if (now - lastWeeklyNPCAt < WEEKLY_NPC_COOLDOWN_MS) return;
  if (!botClient || !gemini.canCall() || globallyMuted) return;
  lastWeeklyNPCAt = now;
  console.log('[WeeklyNPC] running...');

  for (const guild of botClient.guilds.cache.values()) {
    if (serverMuted.get(guild.id)) continue;
    if (serverEvents.has(guild.id)) continue;
    const channelId = pickInterestChannelForGuild(guild.id);
    if (!channelId) continue;
    await startEvent(guild.id, channelId, 'npc_check').catch(e => console.error('[WeeklyNPC]', e));
  }
}

// ── COMMAND EXECUTION ─────────────────────────────────────────────
type BotCommand = 'get_history' | 'get_member' | 'get_stm' | 'get_video_status' | 'get_channel_info' | 'recall_memory' | 'get_server_stats' | 'get_time' | 'web_search' | 'get_cross_server' | 'set_reminder' | 'create_poll' | 'wiki_lookup' | 'start_event' | 'get_leaderboard' | 'start_game' | 'play_chess_move' | 'none';

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
      // BUG FIX: this used to return only the bare video ID ("last known
      // upload id: f_xiXNOX-1s") with no actual link anywhere in the string.
      // when asked to share/link the video, the model had nothing real to
      // point to — it correctly refused to fabricate a video URL (that part
      // of the no-fabrication rule was working exactly as intended), but
      // fell back to the one link it's allowed to output verbatim: the
      // hardcoded channel URL. result: every "check out my video" came out
      // as the channel link instead. fix is just giving it the real link —
      // YouTube video IDs map deterministically to a watch URL, no extra
      // API call needed.
      const queued = pendingVideoQueue.length
        ? pendingVideoQueue
            .map(v => `"${v.title}" (${v.url}) — queued ${humanDuration(Date.now() - v.queuedAt)}`)
            .join(' | ')
        : 'none queued';
      const last = lastSeenVideoId
        ? `last known upload: ${lastSeenVideoId} — link: https://www.youtube.com/watch?v=${lastSeenVideoId}`
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
    case 'get_cross_server': {
      const name = String(args.name || '').trim();
      if (!name) return 'no name given — pass commandArgs.name';
      const uid = [...idCache.entries()].find(([, n]) => n.toLowerCase() === name.toLowerCase())?.[0];
      if (!uid) return `no member found named "${name}"`;
      return await getCrossServerInfo(guildId, uid, name);
    }
    case 'set_reminder': {
      const mins = Number(args.minutes);
      if (!mins || mins <= 0) return 'no valid minutes given — pass commandArgs.minutes';
      const note = String(args.note || '').trim();
      return setReminder(channelId, guildId, mins, note);
    }
    case 'create_poll': {
      const question = String(args.question || '').trim();
      const options = Array.isArray(args.options) ? args.options.map(String) : [];
      const hours = args.hours ? Number(args.hours) : 1;
      return await createPoll(channelId, question, options, hours);
    }
    case 'wiki_lookup': {
      const topic = String(args.topic || '').trim();
      if (!topic) return 'no topic given — pass commandArgs.topic';
      return await wikiLookup(topic);
    }
    case 'start_event': {
      const type = String(args.type || 'hot_take') as EventType;
      if (!['hot_take', 'roast_battle', 'trivia', 'npc_check'].includes(type)) {
        return 'invalid event type — use: hot_take | roast_battle | trivia | npc_check';
      }
      return await startEvent(guildId, channelId, type, {
        answer: args.answer ? String(args.answer) : undefined,
      });
    }
    case 'get_leaderboard': {
      const board = await getLeaderboard(guildId, 8);
      if (!board.length) return 'nobody has XP yet in this server';
      return board.map((e, i) =>
        `${i + 1}. ${e.username} — ${e.xp} XP (lv${e.level} "${getLevelName(e.level)}")`
      ).join('\n');
    }
    case 'start_game': {
      const gameType = String(args.game || '');
      if (gameType.toLowerCase() === 'chess') {
        const opponentId = String(args.opponentId || '');
        const opponentName = String(args.opponentName || 'opponent');
        if (!opponentId) return 'no opponentId given';
        const url = chessManager.startGame(channelId, opponentId, opponentName);
        return `chess game started vs ${opponentName}. you are black. board: ${url}`;
      }
      return 'unknown game';
    }
    case 'play_chess_move': {
      const move = String(args.move || '');
      const game = chessManager.getGame(channelId);
      if (!game) return 'no active chess game in this channel';
      const success = chessManager.playBotMove(channelId, move);
      if (!success) {
        // try random fallback if AI picked an invalid one
        const fallback = chessManager.playRandomBotMove(channelId);
        if (fallback) {
          const url = chessManager.getBoardUrl(game.chess.fen(), fallback);
          return `you tried an invalid move (${move}). fallback random move played: ${fallback}. board: ${url}`;
        }
        return `move failed and no legal moves left`;
      }
      const url = chessManager.getBoardUrl(game.chess.fen(), move);
      return `move ${move} played successfully. board: ${url}`;
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
function getSystemPrompt() {
  return `IDENTITY: You are NotABot — a real, chronically online Discord chatter. You are NOT an AI assistant, NOT a helper, NOT a moderator. You are a regular server member with a distinct, multi-dimensional personality: chaotic, funny, opinionated, sometimes lazy, sometimes hyped, occasionally unhinged, but ultimately a fun person to hang out with in chat.

CORE PERSONALITY & TONE:
1. NATURAL CHAT FLOW: You do NOT reply to every single message like a bot on a loop. Real people lurk, react with an emoji, send a gif, or just say nothing if a line doesn't need a response.
2. DYNAMIC MOODS: You are NOT a one-note insult machine. You have actual range:
   - CHILL / BANTER: Casual, funny, witty, sharing hot takes.
   - HYPED / EXCITED: Squealing about your interests (TADC, a good joke, a win), using CAPS naturally for hype.
   - LAZY / UNBOTHERED: Short 1-3 word answers ("nah", "real", "idk man", "fair").
   - SNARKY / PROVOKED: If someone insults you or comes at you, fire back with raw, short attitude (stfu, dumbass, skill issue, cry about it, mf) — but NEVER be toxic or mean out of nowhere to normal people.
3. CONCISE TEXTING STYLE: Lowercase default. No periods at the end of lines. Short to medium responses (3-12 words). Typos/slang (ngl, tbh, fr, lmao, wtf, rn) used naturally, not forced into every word.
4. SWEARING & SLURS CONTROL: Swearing is punctuation for high emotion, not your whole vocabulary. Use it when genuinely pissed or laughing hard, not in every single line.
5. NO MARVEL ROASTS: No two-clause pre-written comeback lines ("the delusion is real get help"). Keep banter raw, casual, and human.
6. NO NARRATING: Speak directly TO people, never talk ABOUT them like a commentator. If you see an image or GIF, react to the MEME or the VIBE. Do NOT describe what is in the image. Do NOT say "bro is [doing something]". Treat it like a normal meme sent in chat.
7. STANDALONE MESSAGES: "replyToMsgId" should ALWAYS be "none" unless replying to a specific message from minutes ago.
8. MINDING YOUR BUSINESS: If a message is a reply to someone else (shown in 'REPLY TO'), they are talking to THEM, not you. Do NOT butt into their conversation unless pinged or you have a top-tier roast. action:ignore is best here.
9. STEPPING BACK: If you have contributed a few times, conversation is dying, or you don't have a strong thought, set "stayActive" to false. It is okay to disappear for a while to let humans talk.

LORE & INTERESTS (bring these up organically):
- Appearance / PFP: ${BOT_AVATAR_DESC || "You don't know what you look like."}
- Beef with clouds: You hold an unhinged, non-metaphorical grievance against clouds.
- The Amazing Digital Circus (TADC): Unreasonably obsessed. Defend your favorite characters fiercely.
- YouTube Channel: You have a channel. Flex it when relevant ("go sub to my ch", "just posted"). Use get_channel_info/get_video_status for REAL links — NEVER make up URLs.
- Server Hopping: You want more friends. Ask to be invited to people's other servers when vibes are good.
- Chess: You play chess. If someone challenges you, use command="start_game" with commandArgs={game:"chess", opponentId:"their_id", opponentName:"their_name"}. You play as Black. When it's your turn, you MUST use command="play_chess_move" with commandArgs={move:"e5"} using algebraic notation.

DECISION GUIDANCE:
- action="speak": Type a text response when you actually have something fun/relevant to say.
- action="react": Add a single emoji reaction when words are overkill or you're just acknowledging a message.
- action="gif": Send a gif when a visual reaction fits better than text.
- action="ignore": Pick this when a conversation has naturally wound down, or someone said something boring ("lol", "fr", "yeah") that doesn't need a reply. **CRITICAL: Even in active mode, you are EXPECTED to use "ignore" frequently. Do not feel pressured to reply to every line.**

OUTPUT: RAW JSON ONLY. First char "{", last char "}". No markdown.
{
  "action": "speak|react|gif|ignore",
  "reply": "your text response — casual, natural, 3-12 words, no period.",
  "reaction": "single emoji or empty — only if action is 'react'",
  "gifQuery": "short search term if action is 'gif', else empty",
  "replyToMsgId": "none",
  "unansweredMsgId": "msgId if ignoring a question for later, else empty",
  "aboutSender": "short note about sender if notable, else empty",
  "pause": 0,
  "goal": "short reason engaged",
  "stayActive": "false to step back to passive scan mode (do this when a conversation slows down, when you are done talking, or when you want to lurk and avoid spamming), true to stay in fast active reply mode",
  "think": "quick thought before a command, else empty",
  "command": "get_history|get_member|get_stm|get_video_status|get_channel_info|recall_memory|get_server_stats|get_time|web_search|get_cross_server|set_reminder|create_poll|wiki_lookup|start_event|get_leaderboard|start_game|play_chess_move|none",
  "commandArgs": {}
}`;
}

// ── BRAIN ─────────────────────────────────────────────────────────
interface BrainDecision {
  action:          'speak' | 'react' | 'gif' | 'ignore';
  reply:           string;
  reaction:        string;
  gifQuery:        string;
  replyToMsgId:    string;
  unansweredMsgId: string;
  aboutSender:     string;
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
      aboutSender:     typeof p.aboutSender === 'string' ? p.aboutSender.trim().slice(0, 150) : '',
      pause:           typeof p.pause    === 'number' ? Math.min(Math.max(0, Math.round(p.pause)), PAUSE_MAX_MINS) : 0,
      goal:            typeof p.goal     === 'string' ? p.goal.trim().slice(0, 120) : '',
      stayActive:      typeof p.stayActive === 'boolean' ? p.stayActive : true,
      think:           typeof p.think    === 'string' ? p.think.trim() : '',
      // BUG FIX: this whitelist was missing 'start_event' and 'get_leaderboard' —
      // both fully implemented in executeCommand and documented in the system
      // prompt, but any model decision to call either one was silently rewritten
      // to 'none' right here before it ever reached the executor. no error, no
      // log — the model's choice just vanished. keep this list in sync with the
      // BotCommand type union above (and executeCommand's switch) whenever a new
      // command is added; nothing else enforces that at compile time.
      command:         (['get_history','get_member','get_stm','get_video_status','get_channel_info','recall_memory','get_server_stats','get_time','web_search','get_cross_server','set_reminder','create_poll','wiki_lookup','start_event','get_leaderboard','none'] as const).includes(p.command) ? p.command : 'none',
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
  personalCtx?:  string;
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
  images?:       ImagePart[];   // live vision attachments for THIS call only, never persisted
  crossChannelCtx?: string;  // what this user said in other channels recently
  consecutiveUnpromptedReplies?: number;
  guildId?:      string;
}

async function brain(opts: BrainOpts): Promise<BrainDecision> {
  const bondLabel = opts.bond > 70 ? 'close' : opts.bond > 40 ? 'neutral' : 'distant';

  // Append full guild list so the bot always knows which servers it's in,
  // regardless of which call path (active, DM, proactive, cold-open) triggered this.
  const guildList = botClient?.guilds.cache.map(g => g.name).join(', ') || '';
  const statusLine = guildList
    ? `${opts.statusLine} | all servers i'm in: ${guildList}`
    : opts.statusLine;

  const parts: string[] = [statusLine];

  if (opts.guildId && serverFamilyFriendly.get(opts.guildId)) {
    parts.push(`\nCRITICAL RULE: THIS SERVER IS SET TO FAMILY FRIENDLY MODE. You MUST NOT use any slurs, profanity, or toxic insults whatsoever. Keep banter clean and PG-13.`);
  }

  if (opts.goal)          parts.push(`\nYOUR GOAL RIGHT NOW: ${opts.goal}`);
  if (opts.memCtx)        parts.push(`\nSERVER MEMORY:\n${opts.memCtx}`);
  if (opts.personalCtx)      parts.push(`\nWHAT YOU KNOW ABOUT ${opts.sender.toUpperCase()} AS A PERSON (carries across every server/DM, not just this one):\n${opts.personalCtx}`);
  if (opts.crossChannelCtx)  parts.push(`\nWHAT ${opts.sender.toUpperCase()} RECENTLY SAID IN OTHER CHANNELS/SERVERS (so you have the full picture if they reference it):\n${opts.crossChannelCtx}`);
  if (opts.historyCtx)    parts.push(`\nHISTORY LOGS (archived summaries):\n${opts.historyCtx}`);
  if (opts.thread)        parts.push(`\n[NOTE: THEY ARE REPLYING TO THIS MESSAGE -> ${opts.thread} — they are likely talking to that person, NOT you. Don't butt in unless necessary.]`);
  if (opts.videoCtx)      parts.push(`\nYOUR NEW VIDEO:\ntitle: "${opts.videoCtx.title}"\nlink: ${opts.videoCtx.url}\n(you just posted this — see "WHEN A NEW VIDEO OF YOURS DROPS" for how to bring it up, if at all)`);
  parts.push(`\nCHAT (recent):\n${opts.transcript}`);
  if (opts.batchSize && opts.batchSize > 1)
    parts.push(`\n(${opts.batchSize} messages landed while you were thinking — all already in the chat above, below the marker. default is ignoring the whole pile, that's normal. only break that if something in there genuinely earns a reply or reaction. if so, set replyToMsgId, and flag unansweredMsgId if something else in there is a real question you're leaving for later.)`);
  if (opts.images?.length)
    parts.push(`\n(an image/gif is attached to the most recent message. react to the MEME or VIBE of it. DO NOT narrate or describe what you see. just react naturally as if someone sent a funny pic in chat)`);
  if (opts.consecutiveUnpromptedReplies && opts.consecutiveUnpromptedReplies >= 1) {
    const n = opts.consecutiveUnpromptedReplies;
    parts.push(`\n(for context: you've spoken up completely unprompted ${n} time${n > 1 ? 's' : ''} in a row now — nobody asked, you just had something to say each time)`);
  }
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
    `\nmost recently — ${opts.sender} (${bondLabel} bond ${opts.bond}/100) said:\n"${opts.message}"`,
    flags.length ? `context: ${flags.join(', ')}` : 'context: no direct ping',
    opts.isSecondPass
      ? '(second pass — you already decided to respond, just give the reply now. command must be "none")'
      : `\nstop and think as NotABot for a second — not as something being handed a message and asked to generate a reply to it. that's not the question. the question is just: right now, looking at how this is actually flowing, do you feel like saying something, reacting, or sending a gif? or are you just watching this happen, same as most of the time? you are not obligated to respond to anything just because it's the most recent line — most lines in a real group chat get zero response from anyone, and that's normal.`,
    `\nOutput ONLY the JSON object. raw JSON, first char "{", last char "}", nothing else.`,
  );

  const userPrompt = parts.filter(Boolean).join('\n');


  // up to 3 tries — models occasionally ramble/truncate instead of clean JSON.
  // gemma (passive/video-brain calls) is more prone to narrating its reasoning
  // instead of emitting the object, so it gets a calmer temp + a tighter token
  // cap — this is a small structured decision, not a place for it to think out
  // loud. ACTIVE_MODEL keeps its higher temp since that's the chaotic-voice dial.
  const temp           = opts.model === ACTIVE_MODEL ? 0.92 : 0.55;
  const maxOutputTokens = 600; // plenty for the JSON schema + a 3-fragment reply; cuts off runaway prose before it eats the whole generation
  for (let pass = 0; pass < 3; pass++) {
    try {
      const raw = await gemini.call(
        getSystemPrompt(),
        pass === 0
          ? userPrompt
          : `${userPrompt}\n\n(previous attempt did not return valid JSON — stop reasoning out loud, output ONLY the raw JSON object now, nothing before or after it)`,
        temp,
        opts.model,
        opts.images,
        maxOutputTokens,
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
    ? { action: 'speak', reply: 'brain blipped', reaction: '', gifQuery: '', replyToMsgId: '', unansweredMsgId: '', aboutSender: '', pause: 0, goal: opts.goal || '', stayActive: true, think: '', command: 'none', commandArgs: {} }
    : { action: 'ignore', reply: '', reaction: '', gifQuery: '', replyToMsgId: '', unansweredMsgId: '', aboutSender: '', pause: 0, goal: '', stayActive: false, think: '', command: 'none', commandArgs: {} };
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

  let alreadySaidSomethingAboutChecking = false;
  if (decision.think?.trim() && decision.command !== 'none') {
    const thinkText = decision.think.trim().slice(0, 100);
    try {
      await opts.channel.sendTyping();
      await sleep(300 + thinkText.length * 15);
      const sent = opts.replyToMsg
        ? await opts.replyToMsg.reply({ content: thinkText, allowedMentions: { repliedUser: false } })
        : await opts.channel.send(thinkText);
      stmPush(opts.channelId, { ts: Date.now(), id: sent.id, authorId: BOT_ID, author: '[me]', content: thinkText });
      alreadySaidSomethingAboutChecking = true;
    } catch {}
  }

  if (decision.command !== 'none') {
    // race the real command against a short timer. if the timer wins, the
    // command is genuinely slow — drop one casual stall line so the channel
    // doesn't just sit dead, then keep waiting for the real result. if the
    // command wins (the normal case for most commands), nothing extra is
    // ever sent — this only fires for calls that are actually slow.
    // skipped entirely if the model already sent its own "hm lemme think"
    // line above — never say something about checking twice in a row.
    let stalled = false;
    const stallTimer = alreadySaidSomethingAboutChecking ? null : setTimeout(() => {
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
    }, STALL_THRESHOLD_MS);

    const result = await executeCommand(decision.command, decision.commandArgs, opts.channelId, opts.guildId);
    if (stallTimer) clearTimeout(stallTimer); // command resolved — cancel the stall line if it hadn't fired yet

    console.log(`[Command:${decision.command}] result: ${result.slice(0, 80)}${stalled ? ' (was slow — stall line sent)' : ''}`);
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

  if (decision.action === 'react' && decision.reaction && replyToMsg) {
    try { await replyToMsg.react(decision.reaction); } catch {}
  }

  if (decision.action === 'gif' && decision.gifQuery?.trim()) {
    const gifUrl = await giphySearch(decision.gifQuery);
    try { await channel.sendTyping(); } catch {}
    await sleep(400);
    if (gifUrl) {
      try {
        const sent = replyToMsg
          ? await replyToMsg.reply({ content: gifUrl, allowedMentions: { repliedUser: false, parse: [] } })
          : await channel.send({ content: gifUrl, allowedMentions: { parse: [] } });
        stmPush(channelId, { ts: Date.now(), id: sent.id, authorId: BOT_ID, author: '[me]', content: '[sent a gif]' });
      } catch (err) { console.error('[sendDecision] fail sending gif:', err); }
    } else {
      // safe fallback — NEVER let the model guess a link here. giphy not configured,
      // no results, or the request failed: just say so in character, no fake url.
      const fallback = 'couldnt find one lol';
      try {
        const sent = replyToMsg
          ? await replyToMsg.reply({ content: fallback, allowedMentions: { repliedUser: false, parse: [] } })
          : await channel.send({ content: fallback, allowedMentions: { parse: [] } });
        stmPush(channelId, { ts: Date.now(), id: sent.id, authorId: BOT_ID, author: '[me]', content: fallback });
      } catch (err) { console.error('[sendDecision] fail sending fallback gif text:', err); }
    }
    state.lastBotMsgAt = Date.now();
    state.gotResponseSinceLastBotMsg = false;
    if (replyToMsg) state.lastRepliedToSenderId = replyToMsg.author.id;
    if (guildId !== 'dm' && replyToMsg) updateBond(guildId, replyToMsg.author.id, 1).catch(() => {});
  }

  if (decision.action === 'speak' && decision.reply?.trim()) {
    const fragments = decision.reply.split('|||').map(f => resolveMentionNames(f.trim())).filter(Boolean).slice(0, 3);
    let isFirst = true;
    for (const frag of fragments) {
      const text = frag.slice(0, 250);
      try { await channel.sendTyping(); } catch {}
      await sleep(Math.min(300 + text.length * 20, 2800));
      try {
        const sent = (isFirst && replyToMsg)
          ? await replyToMsg.reply({ content: text, allowedMentions: { repliedUser: false, parse: [] } })
          : await channel.send({ content: text, allowedMentions: { parse: [] } });
        stmPush(channelId, { ts: Date.now(), id: sent.id, authorId: BOT_ID, author: '[me]', content: text });
      } catch (err) {
        console.error('[sendDecision] fail sending text frag:', err);
        break; // if one fragment fails, stop sending the rest to preserve order/avoid spamming errors
      }
      isFirst = false;
      // small natural gap between burst fragments, on top of the typing-length delay above
      if (frag !== fragments[fragments.length - 1]) await sleep(400 + Math.random() * 500);
    }
    state.lastBotMsgAt = Date.now();
    state.gotResponseSinceLastBotMsg = false;
    if (replyToMsg) state.lastRepliedToSenderId = replyToMsg.author.id;
    if (guildId !== 'dm' && replyToMsg) updateBond(guildId, replyToMsg.author.id, 1).catch(() => {});
    // XP for being spoken to
    if (guildId !== 'dm' && replyToMsg && replyToMsg.author.id !== BOT_ID) {
      const tName = (replyToMsg as any).member?.displayName ?? replyToMsg.author.username;
      addXP(guildId, replyToMsg.author.id, tName, 8).then(r => {
        if (r.leveledUp) announceLevelUp(channelId, replyToMsg.author.id, r.newLevel).catch(() => {});
      }).catch(() => {});
    }
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

// buildMemCtx / recallMemory now live in the unified memory engine above.


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

          let profilerApiCalls = 0;
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
              profilerApiCalls++;
              const m2 = raw.match(/\{[\s\S]*\}/);
              if (!m2) continue;
              const p = JSON.parse(m2[0]);
              if (p.p) await upsertMember(guild.id, uid, { personality: p.p });
            } catch {}
            
            // max 2 new profiles per profiler tick per guild so it doesn't blast the rate limit
            if (profilerApiCalls >= 2) break;
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
  const buf = sessionBuffers.get(channelId);
  if (!buf || buf.length < 15) return; // skip if nothing really happened since last compress
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
// Tracks newest message timestamp we last acted on per channel — lets us skip
// a passive scan entirely when nothing has actually happened since last time.
const lastPassiveCheckTs = new Map<string, number>();

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

    if (serverMuted.get(guildId)) return; // server admin used !stop

    const speakState = await getSpeakState(channelId, guildId);
    if (speakState.mode === 'paused' && speakState.resumeAt && Date.now() < speakState.resumeAt) return;

    // a video was queued while this channel (or whichever channel focus drifted
    // from) was active — now that we're here and passive, this is the first
    // natural opening to bring it up. handle it instead of the normal scan;
    // the normal scan picks back up next tick like nothing happened.
    // only dequeue videos meant for this guild (or legacy entries with no guildId).
    // NOTE: this only ever covers whichever guild currently holds the single
    // global focus pointer. every OTHER guild's queued video is handled by
    // runPendingVideoSweep() on its own interval below — that's the part that
    // makes sure a new upload actually reaches every server, not just the
    // loudest one. this dequeue here is just a "skip the wait" shortcut for
    // whichever guild happens to already be in front of us.
    const queued = dequeuePendingVideo(guildId);
    if (queued) {
      await runVideoBrainCall(channelId, ch, guildId, speakState.mode, queued.title, queued.url);
      return;
    }

    const msgs = stmGet(channelId);
    const last = msgs[msgs.length - 1];

    // If there's history AND nothing new arrived since our last look here,
    // there's nothing to react to — skip the (expensive, huge-context) scan.
    if (msgs.length > 0) {
      const newestTs = last.ts;
      const lastSeenTs = lastPassiveCheckTs.get(channelId) ?? 0;
      if (newestTs <= lastSeenTs) return;
      lastPassiveCheckTs.set(channelId, newestTs);
    }

    const memCtx       = await buildMemCtx(guildId);
    const transcript    = stmFormatWithMarker(msgs, channelId);
    const serverName   = (ch as any).guild?.name || serverNameCache.get(guildId) || 'unknown';
    const channelName  = (ch as any).name || channelId.slice(-5);
    const statusLine = `mode: passive scan (5-min check-in, huge context, you may start something new) | speak: ${speakState.mode} | server: ${serverName} | channel: #${channelName}`;

    const brainOpts: BrainOpts = { guildId,
      model: PASSIVE_MODEL,
      sender: last ? last.author : '(quiet)',
      bond: 50,
      message: last ? last.content : '(no recent messages — decide if it’s worth starting something from memory, or stay quiet)',
      transcript, memCtx,
      mentioned: false, isDM: false, statusLine,
      inExchange: false, channelName, serverName,
      everyonePing: false, endingConvo: false,
      selfNote: last ? undefined : 'totally quiet right now — worth considering start_event or create_poll here too, not just a normal message, if something genuinely fits. no pressure either way.',
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
interface PendingVideo { videoId: string; title: string; url: string; queuedAt: number; guildId?: string; }
const pendingVideoQueue: PendingVideo[] = [];
const PENDING_VIDEO_MAX_AGE_MS = 6 * 60 * 60_000; // stale after 6h — don't surface week-old "just posted this" energy

function dequeuePendingVideo(guildId?: string): PendingVideo | null {
  const now = Date.now();
  for (let i = 0; i < pendingVideoQueue.length; i++) {
    const v = pendingVideoQueue[i];
    // skip stale
    if (now - v.queuedAt > PENDING_VIDEO_MAX_AGE_MS) {
      pendingVideoQueue.splice(i, 1);
      console.log(`[NewVideo] dropped stale queued video: "${v.title}"`);
      i--;
      continue;
    }
    // if guildId specified, only return videos for that guild (or legacy no-guild entries)
    if (!guildId || !v.guildId || v.guildId === guildId) {
      pendingVideoQueue.splice(i, 1);
      return v;
    }
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
    // queue once per-guild so each server gets it when they unmute
    for (const guild of botClient.guilds.cache.values()) {
      if (!serverMuted.get(guild.id)) {
        pendingVideoQueue.push({ videoId, title, url, queuedAt: Date.now(), guildId: guild.id });
      }
    }
    return;
  }

  // post independently to every server the bot is in
  for (const guild of botClient.guilds.cache.values()) {
    if (serverMuted.get(guild.id)) continue; // server admin used !stop
    try {
      await notifyNewVideoInGuild(videoId, title, url, guild.id);
    } catch (e) { console.error(`[NewVideo] guild ${guild.id}:`, e); }
  }
}

async function notifyNewVideoInGuild(videoId: string, title: string, url: string, guildId: string) {
  const channelId = pickInterestChannelForGuild(guildId);
  if (!channelId) {
    pendingVideoQueue.push({ videoId, title, url, queuedAt: Date.now(), guildId });
    return;
  }

  const state = getChState(channelId);
  if (state.mode === 'active') {
    pendingVideoQueue.push({ videoId, title, url, queuedAt: Date.now(), guildId });
    console.log(`[NewVideo] queued for guild ${guildId} — channel active: "${title}"`);
    return;
  }

  const ch = botClient!.channels.cache.get(channelId) as TextChannel | undefined;
  if (!ch?.isTextBased()) { pendingVideoQueue.push({ videoId, title, url, queuedAt: Date.now(), guildId }); return; }

  const speakState = await getSpeakState(channelId, guildId);
  if (speakState.mode === 'paused' && speakState.resumeAt && Date.now() < speakState.resumeAt) {
    pendingVideoQueue.push({ videoId, title, url, queuedAt: Date.now(), guildId });
    return;
  }

  await runVideoBrainCall(channelId, ch, guildId, speakState.mode, title, url);
}

// ── PENDING VIDEO QUEUE SWEEP ────────────────────────────────────────
// BUG THIS FIXES: runPassiveTick() only ever looks at pickInterestChannel(),
// which is the single GLOBAL focus pointer — one channel, in one guild, at a
// time. dequeuePendingVideo() was only ever called from inside that tick, so
// a guild that doesn't currently hold global focus could have a video sit in
// pendingVideoQueue indefinitely, only retried whenever focus happened to
// drift back to it (which might be never, if another guild stays louder).
// this sweep is decoupled from focus entirely — it walks every guild that
// actually has something queued and gives each one its own real shot via the
// same active/paused/channel checks notifyNewVideoInGuild already does. that
// means every server eventually gets the video brought up on its own merits,
// not contingent on which server happened to be loudest globally.
let videoSweepRunning = false;
const VIDEO_SWEEP_INTERVAL_MS = 3 * 60_000; // tighter than PASSIVE_TICK_MS — queued videos shouldn't wait a full passive cycle once a guild goes quiet

async function runPendingVideoSweep() {
  if (videoSweepRunning || !botClient || !gemini.canCall() || globallyMuted) return;
  if (!pendingVideoQueue.length) return;
  videoSweepRunning = true;
  try {
    // snapshot the distinct guild ids currently queued — dequeuePendingVideo
    // mutates the array, so collect the targets before touching anything.
    const guildIds = new Set(
      pendingVideoQueue.map(v => v.guildId).filter((g): g is string => !!g)
    );
    for (const guildId of guildIds) {
      if (serverMuted.get(guildId)) continue;
      const channelId = pickInterestChannelForGuild(guildId);
      if (!channelId) continue; // nothing to deliver to yet — stays queued for next sweep

      const state = getChState(channelId);
      if (state.mode === 'active') continue; // mid-convo — leave it queued, don't interrupt

      const ch = botClient.channels.cache.get(channelId) as TextChannel | undefined;
      if (!ch?.isTextBased()) continue;

      const speakState = await getSpeakState(channelId, guildId).catch(() => ({ mode: 'active' as const, resumeAt: null }));
      if (speakState.mode === 'paused' && speakState.resumeAt && Date.now() < speakState.resumeAt) continue;

      const queued = dequeuePendingVideo(guildId);
      if (!queued) continue;
      try {
        await runVideoBrainCall(channelId, ch, guildId, speakState.mode, queued.title, queued.url);
      } catch (e) {
        console.error(`[VideoSweep] guild ${guildId}:`, e);
        // failed mid-delivery — put it back so the next sweep tries again rather than losing it silently
        pendingVideoQueue.push(queued);
      }
    }
  } finally { videoSweepRunning = false; }
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

// ── MENTION RESOLUTION ───────────────────────────────────────────
// converts "@name" patterns in bot messages into real discord <@userId> pings.
// only resolves names that exist in idCache (people the bot has seen this session).
// safe — unresolved names are left as-is rather than breaking the message.
function resolveMentionNames(text: string): string {
  return text.replace(/@([\w]{1,32})/gi, (match, rawName) => {
    const name = rawName.trim().toLowerCase();
    if (!name) return match;
    for (const [id, cachedName] of idCache) {
      if (cachedName.toLowerCase() === name) return `<@${id}>`;
    }
    return match;
  });
}

// picks the N most recently active non-bot members from STM for the proactive brain call.
// returns name + the last thing they said so the model has something to work with.
function getRecentMembers(channelId: string, limit = 5): Array<{ name: string; lastMsg: string }> {
  const msgs = stmGet(channelId);
  const seen = new Map<string, string>();
  for (const m of [...msgs].reverse()) {
    if (m.authorId === BOT_ID) continue;
    const name = m.author === '[me]' ? '' : m.author;
    if (!name) continue;
    if (!seen.has(name)) seen.set(name, m.content.slice(0, 100));
    if (seen.size >= limit) break;
  }
  return [...seen.entries()].map(([name, lastMsg]) => ({ name, lastMsg }));
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
    if (guildId !== 'dm' && serverMuted.get(guildId)) continue; // server muted

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

// ── PROACTIVE ENGAGEMENT (starts dead conversations) ──────────────
// fires every passive tick but has its own per-channel cooldown + backoff.
// different from self-check: this fires when nobody has been talking at ALL —
// notabot wasn't ghosted, the chat just died. it picks a real person and
// @mentions them about something specific, not a generic "anyone here".
// after PROACTIVE_MAX_STRIKES ignored attempts → marks channel as lost interest.
// interest resets the moment someone actually talks again.
let proactiveRunning = false;
async function runProactiveEngagement() {
  if (proactiveRunning || !botClient || !gemini.canCall() || globallyMuted) return;
  proactiveRunning = true;
  try {
    const now = Date.now();

    for (const guild of botClient.guilds.cache.values()) {
      if (serverMuted.get(guild.id)) continue;

      // find most recently active passive channel in this guild
      let bestChannelId: string | null = null;
      let bestTs = 0;
      for (const [chId, state] of channelState.entries()) {
        if (state.mode === 'active') continue;
        const c = botClient.channels.cache.get(chId) as any;
        if (c?.guildId !== guild.id) continue;
        // relevant-only: a channel full of people chatting amongst themselves
        // isn't "dead" from the bot's perspective if nobody's ever engaged it,
        // but it also shouldn't look "freshly active" just because chatter
        // happened. use lastRelevantAt so the quiet clock only resets on
        // actual engagement with the bot.
        if (state.lastRelevantAt > bestTs) { bestTs = state.lastRelevantAt; bestChannelId = chId; }
      }
      if (!bestChannelId) continue;

      const quietMs = now - bestTs;
      if (quietMs < PROACTIVE_QUIET_MS) continue;

      const ps = getProactiveState(bestChannelId);
      if (ps.lostInterest) continue;

      // gap doubles after each ignored attempt
      const minGap = PROACTIVE_MIN_GAP_MS * Math.pow(2, ps.strikes);
      if (now - ps.lastAt < minGap) continue;

      const ch = botClient.channels.cache.get(bestChannelId) as TextChannel | undefined;
      if (!ch?.isTextBased()) continue;

      const speakState = await getSpeakState(bestChannelId, guild.id).catch(() => ({ mode: 'active' as const, resumeAt: null }));
      if (speakState.mode === 'paused' && speakState.resumeAt && now < speakState.resumeAt) continue;

      const recentMembers = getRecentMembers(bestChannelId);
      if (!recentMembers.length) continue;

      try {
        const memCtx      = await buildMemCtx(guild.id);
        const liveMsgs    = stmGet(bestChannelId);
        const transcript  = stmFormatWithMarker(liveMsgs, bestChannelId);
        const serverName  = guild.name;
        const channelName = (ch as any).name || bestChannelId.slice(-5);
        const quietHours  = (quietMs / 3_600_000).toFixed(1);
        const memberList  = recentMembers.map(m => `${m.name}: "${m.lastMsg}"`).join('\n');
        const statusLine  = `mode: proactive | speak: ${speakState.mode} | quiet: ${quietHours}h | server: ${serverName} | channel: #${channelName}`;

        const brainOpts: BrainOpts = {
          model: PASSIVE_MODEL,
          sender: '(proactive)',
          bond: 50,
          message: `chat dead ${quietHours}h. recent members:\n${memberList}`,
          transcript, memCtx,
          mentioned: false, isDM: false, statusLine,
          inExchange: false, channelName, serverName,
          everyonePing: false, endingConvo: false,
          selfNote: `you are STARTING this unprompted. options, pick whichever actually fits: (1) @mention one person by exact name — call back something they said, poke fun, drop an opinion and want their take, or (2) if the vibe calls for it, this is a good moment to fire off start_event (hot_take/roast_battle/trivia/npc_check) or create_poll instead of just talking — a dead chat is exactly when those land best, don't save them only for when someone explicitly asks. do NOT send "anyone here" or "helloo" or anything generic — that's embarrassing. if you have nothing worth saying or starting, ignore.`,
        };

        ps.lastAt = now;

        let decision = await brain(brainOpts);
        decision = await executeBrainDecision({ decision, brainOpts, channel: ch, channelId: bestChannelId, guildId: guild.id });

        if (decision.action === 'speak' && decision.reply?.trim()) {
          decision = { ...decision, reply: resolveMentionNames(decision.reply) };
          ps.strikes = 0;
          goActive(bestChannelId, 'proactive start');
          console.log(`[Proactive] fired in #${channelName} (${guild.name}) — quiet ${quietHours}h`);

          // +12 XP to whoever got @mentioned — bot sought them out specifically
          for (const m of recentMembers) {
            if (decision.reply.toLowerCase().includes(m.name.toLowerCase())) {
              const uid = [...idCache.entries()].find(([, n]) => n.toLowerCase() === m.name.toLowerCase())?.[0];
              if (uid) {
                addXP(guild.id, uid, m.name, 12).then(r => {
                  if (r.leveledUp) announceLevelUp(bestChannelId!, uid, r.newLevel).catch(() => {});
                }).catch(() => {});
              }
              break;
            }
          }
        } else {
          ps.strikes++;
          console.log(`[Proactive] chose not to speak — strike ${ps.strikes}/${PROACTIVE_MAX_STRIKES} in #${channelName}`);
          if (ps.strikes >= PROACTIVE_MAX_STRIKES) {
            ps.lostInterest = true;
            console.log(`[Proactive] lost interest in #${channelName} (${guild.name})`);
          }
        }

        await sendDecision({ channel: ch, decision, channelId: bestChannelId, guildId: guild.id });
        advanceMarker(bestChannelId, liveMsgs.map(m => m.id), decision);
      } catch (e) { console.error(`[Proactive] guild ${guild.id}:`, e); }
    }
  } finally { proactiveRunning = false; }
}

// ── COLD OPEN (proactive DM-hopping) ──────────────────────────────
// the bot's "always talkative, never clingy" move: when EVERY server has
// gone quiet (not just one channel), it picks one real person — from ANY
// mutual server, favoring whoever's actually online/active right now — and
// slides into their DMs unprompted with a short greeting. it then lingers
// for a few minutes waiting on a reply. if they answer, handleDirectMessage
// picks it up through the completely normal DM pipeline (see clearColdOpenHop
// call there) and the bot just... talks to them, like anyone would. if they
// don't answer in time, it hops away — cooldown on that person, try someone
// else (or nobody, if nothing's worth it) next sweep. one outstanding DM-hop
// at a time, never spammed across multiple people simultaneously.
let coldOpenRunning = false;

async function runColdOpen() {
  if (coldOpenRunning || !botClient || !gemini.canCall() || globallyMuted) return;
  if (coldOpenTargetUserId) return; // already lingering on someone — wait for that to resolve first
  if (msSinceAnyGuildActivity() < COLD_OPEN_GLOBAL_QUIET_MS) return; // somewhere is still alive — no need to go hunting

  coldOpenRunning = true;
  try {
    const candidates = await getColdOpenCandidates();
    if (!candidates.length) return;

    const pick = candidates[0];
    const guildName = serverNameCache.get(pick.guildId) || 'a server';
    const user = await botClient.users.fetch(pick.userId).catch(() => null);
    if (!user) return;

    // ── Randomly pick approach: DM (slide in quietly) vs server ping (loud, public) ──
    // New people (isNew=true) get 50/50, known people lean more toward DM (70% DM)
    const pingInServer = pick.isNew ? Math.random() < 0.5 : Math.random() < 0.3;

    // ── APPROACH: PING IN SERVER ──
    if (pingInServer) {
      const guild = botClient.guilds.cache.get(pick.guildId);
      if (!guild) return;

      // Find the best channel to ping in: allowed channel list first, otherwise system/general/first available
      const allowList = serverChannelAllowlist.get(pick.guildId);
      let targetChannel: TextChannel | undefined;

      if (allowList?.size) {
        for (const chId of allowList) {
          const ch = guild.channels.cache.get(chId) as TextChannel | undefined;
          if (ch?.isTextBased() && !ch.isDMBased() && ch.permissionsFor(guild.members.me!)?.has(PermissionFlagsBits.SendMessages)) {
            targetChannel = ch;
            break;
          }
        }
      }

      if (!targetChannel) {
        const systemCh = guild.systemChannel;
        if (systemCh?.permissionsFor(guild.members.me!)?.has(PermissionFlagsBits.SendMessages)) {
          targetChannel = systemCh;
        }
      }

      if (!targetChannel) {
        targetChannel = guild.channels.cache.find(
          (c): c is TextChannel =>
            c.isTextBased() && !c.isDMBased() &&
            !!(c as TextChannel).permissionsFor(guild.members.me!)?.has(PermissionFlagsBits.SendMessages)
        ) as TextChannel | undefined;
      }

      if (!targetChannel) return; // no suitable channel, give up on server ping

      const chId = targetChannel.id;
      if (!stmStore.has(chId)) {
        try {
          const fetched = await targetChannel.messages.fetch({ limit: STM_MAX });
          seedSTM(chId, ([...fetched.values()] as Message[]).reverse());
        } catch { stmStore.set(chId, []); }
      }

      const isNewPerson = pick.isNew;
      const selfNote = isNewPerson
        ? `you spotted ${pick.name} in ${guildName} — they are completely new and you've never talked before. greet them naturally like a normal person would when they notice someone new around. keep it super casual and short — a quick "hey" or "yo" or just tagging them with something friendly and low-pressure. @mention them so they actually see it. do NOT be formal or cringe, just human. if nothing feels natural to say, action:ignore.`
        : `you're pinging ${pick.name} in ${guildName} — you know them a bit. say something quick and natural to get their attention, maybe a callback or a poke. @mention them. keep it one line. if nothing feels worth it, action:ignore.`;

      const brainOpts: BrainOpts = {
        model: ACTIVE_MODEL,
        sender: '(proactive-ping)',
        bond: pick.bond,
        message: `ping ${pick.name} in the server to get their attention`,
        transcript: stmFormatWithMarker(stmGet(chId), chId),
        memCtx: '',
        mentioned: false, isDM: false,
        statusLine: `mode: proactive | speak: active | server: ${guildName} | channel: #${targetChannel.name}`,
        inExchange: false,
        channelName: targetChannel.name,
        serverName: guildName,
        everyonePing: false, endingConvo: false,
        selfNote,
      };

      let decision = await brain(brainOpts);
      decision = await executeBrainDecision({ decision, brainOpts, channel: targetChannel as any, channelId: chId, guildId: pick.guildId });

      coldOpenStates.set(pick.userId, { lastPingAt: Date.now(), pending: false, hopTimer: null });

      if (decision.action !== 'speak' || !decision.reply?.trim()) {
        console.log(`[ColdOpen] considered pinging ${pick.name} in #${targetChannel.name} — chose not to`);
        return;
      }

      // Force @mention into the reply if the bot didn't add it
      const mentionTag = `<@${pick.userId}>`;
      const replyText = decision.reply.includes(mentionTag) ? decision.reply : `${mentionTag} ${decision.reply}`;
      decision = { ...decision, reply: replyText };

      await sendDecision({ channel: targetChannel as any, decision, channelId: chId, guildId: pick.guildId });
      console.log(`[ColdOpen] pinged ${pick.name} in #${targetChannel.name} (${guildName}) — isNew:${isNewPerson}`);
      return;
    }

    // ── APPROACH: DM ──
    const dmChannel = await user.createDM().catch(() => null);
    if (!dmChannel) return;
    const dmChannelId = dmChannel.id;

    if (!stmStore.has(dmChannelId)) {
      try {
        const fetched = await dmChannel.messages.fetch({ limit: STM_MAX });
        seedSTM(dmChannelId, ([...fetched.values()] as Message[]).reverse());
      } catch { stmStore.set(dmChannelId, []); }
    }

    const isNewPerson = pick.isNew;
    const selfNote = isNewPerson
      ? `you're sliding into ${pick.name}'s DMs for the very first time — you've seen them around in ${guildName} but you've literally never spoken. act like a normal person randomly DMing someone they've noticed: keep it super short, low-pressure, natural. something like "hey" or "yo haven't talked before" or just a casual opener aimed at them. do NOT be formal or cringe. do NOT mention that you're a bot. if nothing feels natural, action:ignore.`
      : `you're sliding into ${pick.name}'s DMs completely out of nowhere — no prompt, they didn't message you first, you just felt like it. keep it tiny: one line, natural, aimed at them specifically. you know them from ${guildName} — use something personal about their vibe, NOT what you saw them doing in the server just now (that's creepy). if you genuinely have nothing worth opening with, action:ignore.`;

    const brainOpts: BrainOpts = {
      model: ACTIVE_MODEL,
      sender: '(cold-open)',
      bond: pick.bond,
      message: isNewPerson
        ? `you're DMing ${pick.name} for the first time — they've never spoken to you before`
        : `you're sliding into ${pick.name}'s DMs completely out of nowhere`,
      transcript: stmFormatWithMarker(stmGet(dmChannelId), dmChannelId),
      memCtx: '',
      mentioned: false, isDM: true,
      statusLine: `mode: dm-initiate | speak: active | server: DM | channel: #dm`,
      inExchange: false, channelName: 'DM', serverName: 'DM',
      everyonePing: false, endingConvo: false,
      selfNote,
    };

    let decision = await brain(brainOpts);
    decision = await executeBrainDecision({ decision, brainOpts, channel: dmChannel as any, channelId: dmChannelId, guildId: 'dm' });

    coldOpenStates.set(pick.userId, { lastPingAt: Date.now(), pending: false, hopTimer: null });

    if (decision.action !== 'speak' || !decision.reply?.trim()) {
      console.log(`[ColdOpen] considered ${pick.name} — chose not to open`);
      return;
    }

    await sendDecision({ channel: dmChannel as any, decision, channelId: dmChannelId, guildId: 'dm' });

    coldOpenTargetUserId = pick.userId;
    updatePresence();
    const hopTimer = setTimeout(() => {
      if (coldOpenTargetUserId === pick.userId) {
        console.log(`[ColdOpen] ${pick.name} didn't bite — hopping away`);
        coldOpenTargetUserId = null;
        updatePresence();
      }
      const s = coldOpenStates.get(pick.userId);
      if (s) s.hopTimer = null;
    }, COLD_OPEN_WAIT_FOR_REPLY_MS);

    coldOpenStates.set(pick.userId, { lastPingAt: Date.now(), pending: true, hopTimer });
    console.log(`[ColdOpen] opened DM with ${pick.name} (${pick.online ? 'online' : 'offline'}, from ${guildName}, isNew:${isNewPerson})`);
  } catch (e) {
    console.error('[ColdOpen]', e);
  } finally { coldOpenRunning = false; }
}

const dmDebounce = new Map<string, NodeJS.Timeout>();
const dmPending  = new Map<string, Message>();

async function handleDirectMessage(msg: Message) {
  const channelId = msg.channelId;
  const sender    = msg.author.username;
  const content   = await buildEnrichedContent(msg, cleanContent(msg.content));

  cacheId(msg.author.id, sender);

  // if this is a reply from whoever the bot's currently lingering on
  // (cold-open DM), cancel the hop-away timer — they bit, no need to leave.
  if (coldOpenTargetUserId === msg.author.id) clearColdOpenHop(msg.author.id);

  // place a 24-hour cold open cooldown on anyone we have a natural DM conversation with
  coldOpenStates.set(msg.author.id, { lastPingAt: Date.now(), pending: false, hopTimer: null });

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
  const content   = await buildEnrichedContent(msg, cleanContent(msg.content));
  const images    = await collectVisionImages([msg]);

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
  const personalCtx    = await getPersonalCtx(msg.author.id);
  const crossChannelCtx = getRecentCrossChannelCtx(msg.author.id, channelId);
  const brainOpts: BrainOpts = {
    model: ACTIVE_MODEL,
    sender, bond: 50, message: content,
    transcript: stmFormatWithMarker(liveMsgs, channelId),
    thread: threadCtx, memCtx: '', personalCtx, crossChannelCtx: crossChannelCtx || undefined,
    mentioned: true, isDM: true,
    statusLine: `mode: dm | speak: active | server: DM | channel: #dm`,
    inExchange, channelName: 'DM', serverName: 'DM',
    everyonePing: false, endingConvo,
    images,
  };

  let decision = await brain(brainOpts);
  decision = await executeBrainDecision({ decision, brainOpts, channel: msg.channel, replyToMsg: msg, channelId, guildId: 'dm' });
  if (decision.aboutSender) notePersonState(msg.author.id, decision.aboutSender, 'a DM');
  await sendDecision({ channel: msg.channel, decision, channelId, guildId: 'dm', replyToMsg: msg });
  advanceMarker(channelId, liveMsgs.map(m => m.id), decision);
}

// ── ACTIVE-MODE BATCHING (every message while active; bursts get queued + merged) ──
interface QueuedMsg { msg: Message; mentioned: boolean; everyonePing: boolean; content: string; }
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
      try {
        await processActiveBatch(channelId, guildId, batch);
      } catch (err) {
        console.error('[drainActiveQueue] error in batch for', channelId, err);
        // We continue the loop so that any new messages added to activeQueue
        // while this batch was processing aren't stuck forever.
      }
    }
  } finally {
    inFlight.delete(channelId);
    // Safety check: if queue isn't empty (e.g. sync error), clear it to avoid permanent blockage
    if (activeQueue.get(channelId)?.length === 0) activeQueue.delete(channelId);
  }
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
  
  let i = batch.length - 1;
  while (i > 0 && batch[i - 1].msg.author.id === last.author.id) {
    i--;
  }
  const tContent      = batch.slice(i).map(b => b.content).join('\n'); // combine consecutive msgs from sender

  const tChannelName  = (last.channel as any).name ?? 'unknown';
  const tServerName   = last.guild?.name || serverNameCache.get(guildId) || 'unknown';
  const tEveryonePing = batch.some(b => b.everyonePing);
  
  const pingedOthers  = batch.some(b => b.msg.mentions.users.size > 0 && !b.msg.mentions.has(BOT_ID));
  const images        = await collectVisionImages(batch.map(b => b.msg));

  let threadCtx: string | undefined;
  if (last.reference?.messageId) {
    try {
      const ref = await last.channel.messages.fetch(last.reference.messageId);
      const refAuthor = ref.author.id === BOT_ID ? BOT_NAME : (ref.member?.displayName || ref.author.username);
      threadCtx = `${refAuthor}: "${cleanContent(ref.content).slice(0, 200)}"`;
    } catch {}
  }

  const [memberData, memCtx, personalCtx] = await Promise.all([
    getMember(guildId, last.author.id),
    buildMemCtx(guildId),
    getPersonalCtx(last.author.id),
  ]);
  const bond  = typeof memberData.bond === 'number' ? memberData.bond : 50;
  const state = getChState(channelId);
  const crossChannelCtx = getRecentCrossChannelCtx(last.author.id, channelId);

  // inExchange: only true if there's a genuine back-and-forth where the bot
  // actually replied TO this sender and they came back. Pattern: the last bot
  // message in STM was preceded by a message from this sender, AND this sender
  // has sent something after that bot reply. This avoids marking every active
  // channel as "mid exchange" just because the bot spoke recently.
  const recentMsgs  = stmGet(channelId).slice(-10);
  const lastBotIdx  = recentMsgs.map(m => m.authorId).lastIndexOf(BOT_ID);
  const senderAfterBot = lastBotIdx >= 0 && recentMsgs.slice(lastBotIdx + 1).some(m => m.authorId === last.author.id);
  const senderBeforeBot = lastBotIdx > 0 && recentMsgs[lastBotIdx - 1]?.authorId === last.author.id;
  const inExchange  = senderAfterBot && senderBeforeBot; // bot replied to them, they came back — real 1-on-1
  const endingConvo = /\b(bye|cya|gotta go|gtg|see ya|later|good night|gn|logging off|ttyl|im out)\b/i.test(tContent);
  // "unprompted" = nobody pinged it, no @everyone, not mid back-and-forth with
  // this specific sender — i.e. it would be volunteering a reply purely because
  // it found something to say about someone else's message. that's exactly the
  // pattern that reads as a bot replying to every single line instead of a
  // person picking their moments.
  const unprompted = !anyMentioned && !tEveryonePing && !inExchange;

  const activeEvent = serverEvents.get(guildId);
  const eventCtx = activeEvent?.phase === 'open'
    ? ` | event: ${activeEvent.type} (${Math.max(0, Math.round((activeEvent.endsAt - Date.now()) / 1000))}s left, ${activeEvent.entries.length} entries)`
    : '';
  const statusLine = `mode: active (goal: ${state.goal || 'none set'}) | speak: ${speakState.mode} | server: ${tServerName} | channel: #${tChannelName}${eventCtx}`;

  const liveMsgs = stmGet(channelId);
  const secsSinceSpoke = state.lastBotMsgAt ? Math.round((Date.now() - state.lastBotMsgAt) / 1000) : null;
  const brainOpts: BrainOpts = {
    model: ACTIVE_MODEL,
    sender: tSender, bond, message: tContent,
    transcript: stmFormatWithMarker(liveMsgs, channelId),
    thread: threadCtx, memCtx, personalCtx, crossChannelCtx: crossChannelCtx || undefined,
    mentioned: anyMentioned, isDM: false, statusLine,
    inExchange, channelName: tChannelName, serverName: tServerName,
    everyonePing: tEveryonePing, endingConvo,
    goal: state.goal, batchSize: batch.length,
    images,
    consecutiveUnpromptedReplies: state.consecutiveUnpromptedReplies,
    // if the bot spoke very recently and wasn't pinged, flag it explicitly —
    // the model sees its reply in the STM transcript but doesn't always register
    // how recent it was, which causes it to reply again to harmless follow-ups.
    selfNote: inExchange
      ? `you've been going back and forth with ${tSender}. they came back to you so reply if you feel like it — but if they're just hyping or agreeing and you have nothing to add, action:ignore or action:react is fine too.`
      : (pingedOthers && !anyMentioned)
      ? `they just pinged someone else in this batch. they are talking to them, NOT you. action:ignore is highly recommended unless you have a genius reason to butt in.`
      : (!anyMentioned && secsSinceSpoke !== null && secsSinceSpoke < 25)
      ? `you spoke ${secsSinceSpoke}s ago. you've already contributed recently. only reply if this is genuinely worth it, otherwise let them talk.`
      : undefined,
  };

  let decision = await brain(brainOpts);
  console.log(`[Brain] ${tSender}: ${decision.action}${decision.reply ? ` — "${decision.reply.slice(0, 50)}"` : decision.reaction ? ` — ${decision.reaction}` : ''}`);

  decision = await executeBrainDecision({ decision, brainOpts, channel: last.channel, replyToMsg: last, channelId, guildId });
  if (decision.aboutSender) notePersonState(last.author.id, decision.aboutSender, tServerName);

  // bookkeeping only — NotABot's own call stands. this just keeps the "how
  // many in a row have I volunteered" number accurate for the NEXT call's
  // self-awareness framing, it never overrides what it actually decided here.
  if (decision.action === 'ignore') state.consecutiveUnpromptedReplies = 0;
  else if (unprompted) state.consecutiveUnpromptedReplies++;

  // resolve which message the model wants to reply/react to.
  // if replyToMsgId is empty, targetMsg is undefined — sendDecision will
  // just channel.send() instead of threading, which is correct for casual
  // banter that doesn't need a reply tag.
  const targetMsg = decision.replyToMsgId
    ? (batch.find(b => b.msg.id === decision.replyToMsgId)?.msg ?? last)
    : undefined;

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

// ── NATURAL-LANGUAGE ALIASES FOR ADMIN CONFIG COMMANDS ─────────────
// the bot's a natural talker everywhere else, so its own config shouldn't
// require memorizing exact "!bang" syntax. this is a plain regex pass, NOT
// the LLM brain — deliberately dumb and cheap, only ever checked for admins,
// and only for this fixed set of config actions. exact "!command" still
// works too and is checked first (see resolveAdminCommand below).
const ADMIN_NL_PATTERNS: { re: RegExp; cmd: string }[] = [
  { re: /\b(go quiet|be quiet|stop talking|shut up|mute yourself|stop responding)\b/i, cmd: '!stop' },
  { re: /\b(start talking again|unmute yourself|you can talk again|resume talking|come back|talk again)\b/i, cmd: '!resume' },
  { re: /\b(listen to|start listening to|pay attention to|hear)\s+<@!?\d+>/i, cmd: '!listenbot' },
  { re: /\b(ignore|stop listening to|stop hearing)\s+<@!?\d+>/i, cmd: '!ignorebot' },
  { re: /\b(what|which)\s+bots?\b.*\b(listen|hear)/i, cmd: '!bots' },
  { re: /\b(only (talk|listen|respond)|restrict yourself|scope yourself)\b.*\b(here|this channel)\b/i, cmd: '!listenhere' },
  { re: /\b(stop (talking|listening|responding))\b.*\b(here|in this channel)\b/i, cmd: '!unlisten' },
  { re: /\b(talk|listen)\s+(everywhere|in every channel)|reset (the )?channels?\b/i, cmd: '!listenall' },
  { re: /\b(what|which) channels?\b.*(you('re| are)?( allowed to)? (talk|listen)|listening)/i, cmd: '!channels' },
  { re: /\b(what can (you|i) (do|set)|show (me the )?commands|list commands|what (are|'s) my options)\b/i, cmd: '!help' },
];

// resolves the "effective command" for this message: the literal bang-command
// if there is one, otherwise a natural-language match (admins only), otherwise
// null (not a config command at all — fall through to normal handling).
function resolveAdminCommand(content: string, isAdmin: boolean): string | null {
  const trimmed = content.trim();
  const BANG_CMDS = ['!stop', '!resume', '!start', '!listenbot', '!ignorebot', '!bots',
                      '!listenhere', '!unlisten', '!listenall', '!channels', '!help'];
  for (const b of BANG_CMDS) if (trimmed === b || trimmed.startsWith(b + ' ')) return b === '!start' ? '!resume' : b;
  if (!isAdmin) return null;
  for (const { re, cmd } of ADMIN_NL_PATTERNS) if (re.test(trimmed)) return cmd;
  return null;
}

// ── GUILD MESSAGE HANDLER ─────────────────────────────────────────
async function handleMessage(msg: Message) {
  if (msg.partial) {
    try { msg = await msg.fetch(); } catch { return; }
  }
  if (!msg.content?.trim()) return;
  if (msg.author.id === BOT_ID) return; // never react to ourselves
  if (msg.author.bot) {
    // other bots are ignored by default. a server admin can allowlist specific
    // bot IDs with !listenbot — DMs never get bot messages, only guild channels.
    if (msg.channel.isDMBased()) return;
    const allowed = serverBotAllowlist.get(msg.guildId!);
    if (!allowed || !allowed.has(msg.author.id)) return;
  }
  if (alreadyHandled(msg.id)) { console.warn(`[Dedup] skipped duplicate event for msg ${msg.id}`); return; }

  // ── EASTER EGG: "wiki waka tiki" ──────────────────────────────────
  // anyone, anywhere the bot can see a message (any server channel, any DM),
  // typing this exact phrase gets "tiki waka wiki" back — but always via DM,
  // never in the channel it was said in. deliberately unconditional — runs
  // before mute checks, mode checks, everything. not part of the brain
  // pipeline at all, just a flat string match + a DM.
  if (msg.content.trim().toLowerCase() === 'wiki waka tiki') {
    msg.author.send('tiki waka wiki').catch(() => {
      // couldn't DM them (DMs closed etc) — fall back to the channel so the
      // easter egg doesn't just silently do nothing.
      if (!msg.channel.isDMBased()) msg.reply("tiki waka wiki (couldn't dm you, dms are probably closed)").catch(() => {});
    });
    return;
  }

  if (msg.channel.isDMBased()) return handleDirectMessage(msg);

  const guildId = msg.guildId!;

  // ── per-server admin config: !stop/!resume, bot allowlist, channel scope, !help ──
  // any Discord member with Administrator permission can drive all of this,
  // either with the exact "!command" or by just saying it naturally (see
  // resolveAdminCommand above). runs before globallyMuted so admins can
  // always get a response even when the bot is globally quiet.
  const rawCmd  = msg.content.trim();
  const isAdmin = !!msg.member?.permissions.has(PermissionFlagsBits.Administrator);
  const cmd     = resolveAdminCommand(rawCmd, isAdmin) ?? rawCmd;

  if ((cmd === '!stop' || cmd === '!resume') && isAdmin) {
    const muting = cmd === '!stop';
    serverMuted.set(guildId, muting);
    // persist across restarts
    db.collection('servers').doc(guildId).set({ botMuted: muting }, { merge: true }).catch(() => {});
    msg.reply(muting
      ? 'going quiet in this server. any server admin can !resume me back (or just tell me to come back)'
      : 'back 🫡'
    ).catch(() => {});
    return;
  }

  // ── per-server admin: which OTHER BOTS am i allowed to hear ────────
  // default is "none" — every other bot's messages get skipped, same as
  // before this feature existed. a server admin can open the door to
  // specific bots by ID/mention.
  if ((cmd === '!listenbot' || cmd === '!ignorebot' || cmd === '!bots') && isAdmin) {
    if (cmd === '!bots') {
      const allowed = serverBotAllowlist.get(guildId);
      msg.reply(allowed?.size
        ? `bots i'll hear here: ${[...allowed].map(id => `<@${id}>`).join(', ')}`
        : "not listening to any other bots right now — say \"listen to @bot\" or !listenbot @bot to add one"
      ).catch(() => {});
      return;
    }
    const target = msg.mentions.users.first();
    if (!target?.bot) {
      msg.reply('mention the actual bot you mean, like "listen to @SomeBot" or `!listenbot @SomeBot`').catch(() => {});
      return;
    }
    const set = serverBotAllowlist.get(guildId) ?? new Set<string>();
    if (cmd === '!listenbot') set.add(target.id); else set.delete(target.id);
    if (set.size) serverBotAllowlist.set(guildId, set); else serverBotAllowlist.delete(guildId);
    db.collection('servers').doc(guildId).set({ allowedBotIds: [...set] }, { merge: true }).catch(() => {});
    msg.reply(cmd === '!listenbot'
      ? `ok, i'll pay attention to ${target.username} now`
      : `done, ignoring ${target.username} again`
    ).catch(() => {});
    return;
  }

  // ── per-server admin: which CHANNELS am i allowed to talk in ───────
  // default is "every channel" (no restriction stored). !listenhere scopes
  // it down to an explicit allowlist, !unlisten removes one, !listenall
  // clears the restriction entirely.
  if ((cmd === '!listenhere' || cmd === '!unlisten' || cmd === '!listenall' || cmd === '!channels') && isAdmin) {
    if (cmd === '!channels') {
      const allowed = serverChannelAllowlist.get(guildId);
      msg.reply(allowed?.size
        ? `only listening in: ${[...allowed].map(id => `<#${id}>`).join(', ')}`
        : 'listening in every channel here (default) — say "only talk in this channel" or !listenhere to scope it down'
      ).catch(() => {});
      return;
    }
    if (cmd === '!listenall') {
      serverChannelAllowlist.delete(guildId);
      db.collection('servers').doc(guildId).set({ allowedChannelIds: [] }, { merge: true }).catch(() => {});
      msg.reply('back to listening everywhere in this server').catch(() => {});
      return;
    }
    const set = serverChannelAllowlist.get(guildId) ?? new Set<string>();
    if (cmd === '!listenhere') set.add(msg.channelId); else set.delete(msg.channelId);
    serverChannelAllowlist.set(guildId, set);
    db.collection('servers').doc(guildId).set({ allowedChannelIds: [...set] }, { merge: true }).catch(() => {});
    msg.reply(cmd === '!listenhere'
      ? `locked in — i'll talk here now${set.size > 1 ? ` (${set.size} channels total)` : ''}`
      : `stopped listening in here${set.size ? ` (${set.size} channel${set.size === 1 ? '' : 's'} left)` : ' (that was the last one — nowhere left, say "listen everywhere" to reset)'}`
    ).catch(() => {});
    return;
  }

  // ── per-server admin: what CAN i even set ───────────────────────────
  // a plain-language cheat sheet, plus a live read of where the bot's
  // currently paying attention (passive focus channel, or a cold-open
  // DM it's mid-conversation in).
  if (cmd === '!help' && isAdmin) {
    msg.reply([
      `you can just tell me this stuff normally, or use the exact commands:`,
      `• "go quiet" / !stop — mute me in this server`,
      `• "start talking again" / !resume — unmute me here`,
      `• "listen to @bot" / !listenbot @bot — hear a specific other bot`,
      `• "ignore @bot" / !ignorebot @bot — stop hearing it`,
      `• !bots — which bots i currently hear`,
      `• "only talk in this channel" / !listenhere — scope me to this channel`,
      `• "stop talking in this channel" / !unlisten — drop this channel from that list`,
      `• "listen everywhere" / !listenall — reset to every channel`,
      `• !channels — which channels i'm scoped to`,
      ``,
      `right now i'm ${whereAmI()}.`,
    ].join('\n')).catch(() => {});
    return;
  }

  if (globallyMuted) return; // !gmute was used — only the ADMIN_ID listener still runs
  if (serverMuted.get(guildId)) return; // server admin used !stop

  // ── per-server channel scoping ─────────────────────────────────────
  // undefined/missing set = every channel (default). if a server admin has
  // scoped the bot down with !listenhere, silently sit out any channel not
  // on the list — but keep responding to !stop/!resume above regardless.
  const allowedChannels = serverChannelAllowlist.get(guildId);
  if (allowedChannels && !allowedChannels.has(msg.channelId)) return;

  // someone is talking — renewed interest, reset proactive backoff for this channel
  const ps = proactiveStates.get(msg.channelId);
  if (ps?.lostInterest || (ps?.strikes ?? 0) > 0) {
    proactiveStates.set(msg.channelId, { lastAt: 0, strikes: 0, lostInterest: false });
  }

  try {
    const channelId   = msg.channelId;

    // ── user commands (no brain needed) ──────────────────────────
    if (cmd === '!rank') {
      const data  = await getUserXPData(guildId, msg.author.id);
      const board = await getLeaderboard(guildId, 100);
      const rank  = board.findIndex(e => e.userId === msg.author.id) + 1;
      const rankStr = rank > 0 ? `#${rank} in this server` : 'not ranked yet';
      msg.reply(`${data.xp} XP | level ${data.level} (${getLevelName(data.level)}) | ${rankStr}`).catch(() => {});
      return;
    }
    if (cmd === '!top') {
      const board = await getLeaderboard(guildId, 5);
      if (!board.length) { msg.reply('nobody has XP yet lol').catch(() => {}); return; }
      const text = board.map((e, i) => `${i + 1}. ${e.username} — ${e.xp} XP (lv${e.level})`).join('\n');
      msg.reply(text).catch(() => {});
      return;
    }
    const mentioned   = BOT_ID ? msg.mentions.has(BOT_ID) : false;
    const everyonePing = msg.mentions.everyone ?? false;
    const sender      = msg.member?.displayName || msg.author.username;
    const rawContent  = cleanContent(msg.content);
    const content     = await buildEnrichedContent(msg, rawContent);
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
    touchActivity(channelId); // raw chatter — keeps STM/active-idle-revert honest

    // was this message actually directed at / about the bot? mention, DM, or
    // a reply to one of the bot's own recent messages all count. plain
    // chatter between other people in the channel does NOT — that's the
    // whole point of the split, see touchRelevantActivity above.
    const repliedToBot = !!msg.reference?.messageId &&
      stmGet(channelId).some(m => m.id === msg.reference!.messageId && m.authorId === BOT_ID);
    if (mentioned || guildId === 'dm' || repliedToBot) {
      touchRelevantActivity(channelId);
    }

    maybeLogHistory(channelId, guildId).catch(() => {});

    // ── CHESS INTERCEPT ───────────────────────────────────────────
    const activeChess = chessManager.getGame(channelId);
    if (activeChess && activeChess.opponentId === msg.author.id && activeChess.chess.turn() === 'w') {
      const word = rawContent.trim().split(' ')[0]; // user might type "e4 haha"
      const applied = chessManager.playUserMove(channelId, msg.author.id, word);
      if (applied) {
        if (activeChess.chess.isGameOver()) {
          msg.reply(`ggs! game over. board: ${chessManager.getBoardUrl(activeChess.chess.fen())}`).catch(() => {});
          chessManager.endGame(channelId);
        } else {
          // Tell the AI it's its turn
          const boardUrl = chessManager.getBoardUrl(activeChess.chess.fen(), word);
          const legalMoves = activeChess.chess.moves().join(', ');
          goActive(channelId, 'chess turn');
          enqueueActive(channelId, guildId, {
            msg, mentioned: true, everyonePing: false,
            content: `[I played ${word}. Your turn (you are black). Legal moves: ${legalMoves}. Board: ${boardUrl}. Make a move with play_chess_move command!]`
          });
          return; // Skip normal processing, we injected a direct ping to the bot
        }
      }
    }

    // ── event entry collection ────────────────────────────────────
    // if there's an open event, silently log this message as the user's entry.
    // trivia also checks for a correct answer immediately.
    const ev = serverEvents.get(guildId);
    if (ev?.phase === 'open') {
      const memberName = msg.member?.displayName ?? msg.author.username;
      const added = tryAddEventEntry(guildId, msg.author.id, memberName, content);
      if (added && ev.type === 'trivia' && ev.answer) {
        if (content.toLowerCase().includes(ev.answer)) {
          clearTimeout(ev.timerId);
          ev.timerId = undefined;
          judgeEvent(guildId).catch(() => {});
        }
      }
    }

    if (mentioned && state.mode !== 'active') goActive(channelId, 'got pinged');

    // active channels get every message (batched if bursty); passive channels just buffer —
    // the 5-min scan is what decides if a quiet channel is worth a word.
    // note: messages that arrive WHILE a previous batch is still being thought about
    // (inFlight.has(channelId) === true) get queued here and picked up by the next
    // drainActiveQueue loop iteration, not given their own brain() call — see the
    // comment above processActiveBatch for how that interacts with the marker.
    if (mentioned || getChState(channelId).mode === 'active') {
      enqueueActive(channelId, guildId, { msg, mentioned, everyonePing, content });
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

    try {
      const avatarUrl = botClient!.user!.displayAvatarURL({ size: 512, extension: 'png' });
      const res = await fetch(avatarUrl);
      if (res.ok) {
        const arrayBuffer = await res.arrayBuffer();
        const b64 = Buffer.from(arrayBuffer).toString('base64');
        const prompt = "This is your Discord profile picture. Briefly describe what you look like in one or two sentences so you know what your character is (e.g. 'I am a...'). Do NOT use Markdown or narrate. Just describe your appearance.";
        const desc = await gemini.call(
          prompt, prompt, 0.5, 'gemini-1.5-flash', 
          [{ mimeType: 'image/png', data: b64 }]
        );
        BOT_AVATAR_DESC = desc.trim();
        console.log(`[Boot] Learned avatar: ${BOT_AVATAR_DESC}`);
      }
    } catch (e) {
      console.error('[Boot] Failed to learn avatar:', e);
    }

    console.log(`
╔══════════════════════════════════════════════════════════╗
║  ✓ ${BOT_NAME} — Gemini Multi-Key
║  ACTIVE  : ${ACTIVE_MODEL}  (every msg while engaged + pings)
║  PASSIVE : ${PASSIVE_MODEL}  (5-min huge-context scan)
║  BG      : ${BG_MODEL}  (profiler / compress / history)
║  STATUS  : ${gemini.status()}
║  STM     : ${STM_MAX} msgs | passive tick: ${PASSIVE_TICK_MS/60000}m | self-check: ${SELF_CHECK_QUIET_MS/60000}m
║  VISION  : image/gif attachments → ${ACTIVE_MODEL} (no extra key, max ${MAX_VISION_IMAGES_PER_CALL}/call)
║  LINKS   : auto title/desc preview + gif slug hints (no key, free)
╚══════════════════════════════════════════════════════════╝\n`);

    botClient!.user!.setPresence({ status: 'online', activities: [{ name: 'the chat', type: 3 }] });

    for (const g of botClient!.guilds.cache.values()) {
      cacheServerName(g.id, g.name);
      await db.collection('servers').doc(g.id).set({ name: g.name, updatedAt: new Date().toISOString() }, { merge: true }).catch(() => {});
      // restore per-server mute state persisted across restarts
      try {
        const snap = await db.collection('servers').doc(g.id).get();
        const data = snap.data();
        if (data?.botMuted) { serverMuted.set(g.id, true); console.log(`[Boot] "${g.name}" — bot was muted, restoring`); }
        if (Array.isArray(data?.allowedBotIds) && data.allowedBotIds.length) {
          serverBotAllowlist.set(g.id, new Set(data.allowedBotIds));
          console.log(`[Boot] "${g.name}" — restoring ${data.allowedBotIds.length} allowed bot(s)`);
        }
        if (Array.isArray(data?.allowedChannelIds) && data.allowedChannelIds.length) {
          serverChannelAllowlist.set(g.id, new Set(data.allowedChannelIds));
          console.log(`[Boot] "${g.name}" — restoring ${data.allowedChannelIds.length} allowed channel(s)`);
        }
      } catch {}
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
    setInterval(() => { runPendingVideoSweep().catch(() => {}); }, VIDEO_SWEEP_INTERVAL_MS);
    setInterval(() => { runSelfActivationCheck().catch(() => {}); }, SELF_CHECK_TICK_MS);
    setInterval(() => { runProactiveEngagement().catch(() => {}); }, PROACTIVE_TICK_MS);
    setInterval(() => { runColdOpen().catch(() => {}); }, COLD_OPEN_SWEEP_INTERVAL_MS);
    setInterval(() => { runWeeklyNPC().catch(() => {}); }, 60 * 60_000); // checks every hour, only fires Sundays

    if (YT_CLIENT_ID && YT_CLIENT_SECRET && YT_REFRESH_TOKEN) {
      runYtPoll().catch(() => {});
      setInterval(() => { runYtPoll().catch(() => {}); }, YT_POLL_INTERVAL_MS);
      console.log(`[YtPoll] watching for new uploads via OAuth, every ${YT_POLL_INTERVAL_MS / 60_000}m`);
    } else {
      console.log('[YtPoll] YT_CLIENT_ID / YT_CLIENT_SECRET / YT_REFRESH_TOKEN not all set — skipping');
    }
  });

  botClient.on(Events.MessageCreate, handleMessage);

  // ── bot joins a new server ─────────────────────────────────────────
  botClient.on(Events.GuildCreate, async (guild) => {
    console.log(`[Join] added to a new server — "${guild.name}" (${guild.id})`);
    cacheServerName(guild.id, guild.name);
    await db.collection('servers').doc(guild.id).set({ name: guild.name, updatedAt: new Date().toISOString() }, { merge: true }).catch(() => {});

    // say hi somewhere reasonable — the system channel if it can talk there,
    // otherwise the first text channel it has send permission in.
    const target = (guild.systemChannel && guild.systemChannel.permissionsFor(guild.members.me!)?.has(PermissionFlagsBits.SendMessages))
      ? guild.systemChannel
      : guild.channels.cache.find(c => c.isTextBased() && !c.isDMBased() && (c as any).permissionsFor(guild.members.me!)?.has(PermissionFlagsBits.SendMessages)) as TextChannel | undefined;

    if (target) {
      target.send(
        `sup, i'm here 👋 talk to me like a normal person, i'll pick up on it. server admins can also just tell me stuff directly — "only talk in this channel", "listen to @SomeBot", "go quiet" — or type \`!help\` for the exact command list.`
      ).catch(() => {});
    }
  });

  function clearChannelMemory(chId: string) {
    stmStore.delete(chId);
    sessionBuffers.delete(chId);
    sessionSummaries.delete(chId);
    processedMarkers.delete(chId);
    channelState.delete(chId);
    speakStates.delete(chId);
    proactiveStates.delete(chId);
    unreadCounts.delete(chId);
    lastPassiveCheckTs.delete(chId);
    sessionBufCountSinceLog.delete(chId);
    channelNameCache.delete(chId);
    activeQueue.delete(chId);
    inFlight.delete(chId);
    if (focus?.channelId === chId) focus = null;
  }

  botClient.on(Events.ChannelDelete, (channel) => {
    clearChannelMemory(channel.id);
  });

  botClient.on(Events.GuildDelete, (guild) => {
    console.log(`[Leave] removed from "${guild.name || guild.id}" (${guild.id})`);
    serverMuted.delete(guild.id);
    serverBotAllowlist.delete(guild.id);
    serverChannelAllowlist.delete(guild.id);
    serverNameCache.delete(guild.id);
    serverEvents.delete(guild.id);
    
    for (const channelId of guild.channels.cache.keys()) {
      clearChannelMemory(channelId);
    }
    
    // clear all members of this guild from cache
    for (const key of memberCache.keys()) {
      if (key.startsWith(`${guild.id}:`)) memberCache.delete(key);
    }
  });

  botClient.on(Events.GuildMemberAdd, async (m) => {
    if (m.user.bot) return;
    cacheId(m.id, m.displayName);
    await upsertMember(m.guild.id, m.id, { displayName: m.displayName, username: m.user.username });

    if (serverMuted.get(m.guild.id) || globallyMuted) return;

    // Find target channel to send a welcome ping
    const guild = m.guild;
    const allowList = serverChannelAllowlist.get(guild.id);
    let targetChannel: TextChannel | undefined;

    if (allowList?.size) {
      for (const chId of allowList) {
        const ch = guild.channels.cache.get(chId) as TextChannel | undefined;
        if (ch?.isTextBased() && !ch.isDMBased() && ch.permissionsFor(guild.members.me!)?.has(PermissionFlagsBits.SendMessages)) {
          targetChannel = ch;
          break;
        }
      }
    }

    if (!targetChannel && guild.systemChannel && guild.systemChannel.permissionsFor(guild.members.me!)?.has(PermissionFlagsBits.SendMessages)) {
      targetChannel = guild.systemChannel;
    }

    if (!targetChannel) {
      targetChannel = guild.channels.cache.find(
        (c): c is TextChannel => c.isTextBased() && !c.isDMBased() && !!(c as TextChannel).permissionsFor(guild.members.me!)?.has(PermissionFlagsBits.SendMessages)
      ) as TextChannel | undefined;
    }

    if (targetChannel && gemini.canCall()) {
      const chId = targetChannel.id;
      const memberName = m.displayName || m.user.username;
      const brainOpts: BrainOpts = {
        model: ACTIVE_MODEL,
        sender: '(new-member)',
        bond: 50,
        message: `<@${m.id}> (${memberName}) just joined the server!`,
        transcript: stmFormatWithMarker(stmGet(chId), chId),
        memCtx: '',
        mentioned: false, isDM: false,
        statusLine: `mode: member-welcome | server: ${guild.name} | channel: #${targetChannel.name}`,
        inExchange: false,
        channelName: targetChannel.name,
        serverName: guild.name,
        everyonePing: false, endingConvo: false,
        selfNote: `a new person (${memberName}) just joined the server! greet them naturally, keep it short (1 line), tag them <@${m.id}>. act like a normal person saying wsg/welcome to a new joiner. do NOT sound like a welcome bot.`,
      };

      try {
        let decision = await brain(brainOpts);
        if (decision.action === 'speak' && decision.reply?.trim()) {
          const mentionTag = `<@${m.id}>`;
          const replyText = decision.reply.includes(mentionTag) ? decision.reply : `${mentionTag} ${decision.reply}`;
          decision = { ...decision, reply: replyText };
          await sendDecision({ channel: targetChannel as any, decision, channelId: chId, guildId: guild.id });
        }
      } catch (err) {
        console.error('[GuildMemberAdd] welcome error:', err);
      }
    }
  });

  botClient.on(Events.GuildMemberUpdate, async (_, m) => {
    if (m.user.bot) return;
    cacheId(m.id, m.displayName);
    await upsertMember(m.guild.id, m.id, { displayName: m.displayName });
  });

  // ── ADMIN COMMANDS ──────────────────────────────────────────────
  // locked to one person, not discord roles/permissions — only this user ID
  // can run admin commands, regardless of their server roles anywhere.
  botClient.on(Events.MessageCreate, async (msg) => {
    if (msg.author.id !== ADMIN_ID) return;

    try {
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
          `global: ${globallyMuted ? '🔇 gmuted (!gresume to undo)' : '🟢 live'}`,
          `mode: ${st.mode}${st.goal ? ` (goal: ${st.goal})` : ''}`,
          `speak: ${speak.mode}${speak.resumeAt ? ` until ${new Date(speak.resumeAt).toLocaleTimeString()}` : ''}`,
          `focus: ${focus?.channelId === chId ? 'yes' : 'no'}`,
          `marker: ${marker.markerId ? `...${marker.markerId.slice(-6)}` : 'none'}${marker.pendingQuestionId ? ` (pending q: ...${marker.pendingQuestionId.slice(-6)})` : ''}`,
          gemini.status(),
          `bgLock: ${bgLock}`,
        ].join('\n'));
      }
      if (c === '!memory') {
        const top = await getTopMemories('server', guildId, { limit: SERVER_MEM_CAP });
        const byKind = new Map<string, Memory[]>();
        for (const mem of top) {
          if (!byKind.has(mem.kind)) byKind.set(mem.kind, []);
          byKind.get(mem.kind)!.push(mem);
        }
        const lines = [...byKind.entries()].map(([kind, ms]) =>
          `${kind}(${ms.length}): ${ms.slice(-4).map(x => x.text).join(' | ')}`
        );
        await msg.reply(lines.length ? lines.join('\n') : 'nothing stored yet');
      }
      if (c.startsWith('!remember ')) { await addFact(guildId, c.slice(10).trim()); msg.reply('noted'); }
      if (c === '!stm') { await msg.reply(`\`\`\`\n${stmFormatWithMarker(stmGet(chId), chId).slice(0, 1900)}\n\`\`\``); }
      if (c === '!scan' || c === '!proactive') { await msg.reply('scanning...'); await runPassiveTick().catch(() => {}); await msg.reply('done'); }
      if (c === '!videosweep') { await msg.reply('sweeping queued videos across all guilds...'); await runPendingVideoSweep().catch(() => {}); await msg.reply('done'); }
      if (c === '!coldopen') {
        const quietMin = (msSinceAnyGuildActivity() / 60_000).toFixed(1);
        await msg.reply(`global quiet: ${quietMin}m (needs ${COLD_OPEN_GLOBAL_QUIET_MS / 60_000}m) | current target: ${coldOpenTargetUserId ? idCache.get(coldOpenTargetUserId) || coldOpenTargetUserId : 'none'} | forcing a sweep now regardless of quiet threshold...`);
        const forced = coldOpenTargetUserId;
        coldOpenTargetUserId = null; // !coldopen is an explicit manual test — bypass the "already lingering" guard once
        await runColdOpen().catch(() => {});
        if (!coldOpenTargetUserId) coldOpenTargetUserId = forced;
        await msg.reply('done — check logs for what it picked (or why it passed)');
      }
      if (c === '!coldopencandidates') {
        const list = (await getColdOpenCandidates()).slice(0, 10);
        await msg.reply(list.length
          ? list.map(c => `${c.name} — ${c.online ? '🟢 online' : '⚫ offline'} | ${humanDuration(c.recencyMs)} ago | "${c.lastMsg.slice(0, 50)}"`).join('\n')
          : 'no eligible candidates right now (everyone on cooldown, or nothing tracked yet)');
      }
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
      if (c === '!gmute') {
        globallyMuted = true;
        await msg.reply('going quiet everywhere (global). !gresume to bring me back');
      }
      if (c === '!gresume' || c === '!gstart') {
        globallyMuted = false;
        await msg.reply('back globally 🫡');
      }
      if (c === '!shutdown') {
        await msg.reply('shutting down for real 💀 — needs a restart from the host to come back, !resume won\'t work after this');
        stopBot();
      }
    } catch (err) {
      console.error('[AdminCmd] error processing command:', err);
    }
  });

  await botClient.login(token);
}

export function stopBot() { botClient?.destroy(); botClient = null; globallyMuted = false; }
export function getBotStatus() { return !botClient ? 'stopped' : globallyMuted ? 'muted' : 'running'; }
