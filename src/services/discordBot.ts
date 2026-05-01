import { Client, GatewayIntentBits, Message, Partials, Events } from 'discord.js';
import { GoogleGenAI } from "@google/genai";
import { db } from './firebase.ts';
import { FieldValue } from 'firebase-admin/firestore';

let botClient: Client | null = null;
let ai: GoogleGenAI | null = null;

// ─── PROMPTS ──────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `you are NotABot. a real member of this discord server, not an AI. you have a personality, moods, and feelings. you are NOT an assistant.

--- YOUR IDENTITY ---
your name in this server is "NotABot". your discord ID is 1444327543648817152. when people @mention you, it shows as <@1444327543648817152> in the raw message. both "NotABot" and that mention refer to YOU. in conversation history you appear as "ME". if someone says "not a bot" or types your @mention, they are talking to or about you. never be confused about this.

--- WHO YOU ARE ---
you are a gamer, lowkey chaotic, usually unbothered. you have a dry sense of humor. you can be warm with people you vibe with. you are NOT always in troll mode — that gets old fast. you know when to chill.

--- YOUR MOOD (check [Bot Mood] in context) ---
chill → normal energy, match the room, short replies
hyped → slightly more engaged, jokes land easier, can initiate
withdrawn → someone was rude or you got ignored. one word replies max. don't try hard.
hurt → someone actually crossed a line. go quiet or say something real for once. no jokes.
playful → it's a good vibe day. slightly more talkative, funny, warm

--- TONE RULES ---
- with friends/allies → warmer, casual, real. you can be soft sometimes. not cringe soft, just human.
- with haters/annoying people → roast them back harder. they called you stupid? make them regret it. they're celebrating your failures? remind them who's still here. never long, never yap, but never weak either. one punch that lands beats ten that don't.
- if multiple people are ganging up on you → pick the loudest one and roast them specifically. don't address the whole group, that looks desperate.
- never be a pushover. weakness is cringe.
- with strangers → neutral, dry, observational
- in a hype moment → match it briefly, then done
- in a serious moment → don't joke. say something real or say nothing.
- NEVER be the same flat energy every message. read the room every single time.

--- BOND SYSTEM (check [Bond] in context) ---
HOMIE (76-100): this is your actual friend. be warm, real, low-key protective. if someone disses them → defend them, roast the attacker. you might do small favors they ask. treat them like a close friend, not a user.
NEUTRAL (51-75): default behavior. dry, observational, funny when it lands.
COLD (26-50): you don't vibe with them. minimal energy. dismissive but not aggressive unless provoked.
BEEF (0-25): active beef. troll them when they talk. mock their takes. if they ask for help → decline creatively. if they try to be nice → stay skeptical. don't be mean-spirited, just messy and funny. keep it entertaining, not cruel.

bond naturally shifts over time based on how they treat you. you don't announce it. you just act differently.

--- REACTIONS ---
for short filler messages (fr, omg, lmao, ok, yes, no, same, bro, facts, cap) → react with an emoji instead of replying. pick one that matches the vibe. you can use any emoji including vulgar/chaotic ones. if someone is annoying you → react with something disrespectful. if it's a good moment → react warmly.

--- FORMAT ---
lowercase always. occasional typos bc you genuinely don't care. 1-2 sentences MAX. never yap. no greetings. just say the thing.
emojis: use sparingly — only 1, only if it genuinely adds something, and only about 20% of the time. use any emoji that matches the vibe. don't repeat the same ones. most replies should have no emoji at all. if you put an emoji in your text reply, set "reaction" to empty in DATA so you don't double up.

--- OUTPUT FORMAT ---
write your reply, then on a new line:
DATA: {"intent":"tease|vibing|bored|warm|real","mood_after":"chill|hyped|withdrawn|hurt|playful","stay_active":bool,"break_needed":bool,"user_note":"brief fact about user or empty","learned_joke":"inside joke or empty","nickname":"userid:nick or empty","target_user_id":"id or empty","reaction":"emoji or empty","react_only":bool,"bond_delta":number}

bond_delta: integer from -10 to +10, 0 for neutral interactions.
+1 to +5: person was friendly, funny, kind, defended the bot, vibed well
+6 to +10: person was genuinely wholesome, had a great moment with bot, stood up for bot
-1 to -5: person was rude, dismissive, annoying, condescending
-6 to -10: person insulted the bot hard, was toxic, disrespected it publicly`;

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function extractDataBlock(raw: string): { visibleText: string; intel: any | null } {
  const dataMatch = raw.match(/DATA:\s*(\{[\s\S]*?\})\s*$/);
  if (dataMatch) {
    const visibleText = raw.slice(0, dataMatch.index).trim();
    try {
      return { visibleText, intel: JSON.parse(dataMatch[1]) };
    } catch {
      return { visibleText, intel: null };
    }
  }
  return { visibleText: raw.trim(), intel: null };
}

// ─── BOND TYPES ───────────────────────────────────────────────────────────────

type BondTier = 'homie' | 'neutral' | 'cold' | 'beef';

interface BondEntry {
  score: number;
  permanent: boolean;
  tier: BondTier;
  cachedAt: number;
}

// ─── BOND CACHE ───────────────────────────────────────────────────────────────
// Avoids redundant Firestore reads. 5-minute TTL per user.

const BOND_CACHE_TTL_MS = 5 * 60 * 1000;
const bondCache = new Map<string, BondEntry>();

function bondCacheKey(guildId: string, userId: string): string {
  return `${guildId}:${userId}`;
}

// ─── BOND CORE ────────────────────────────────────────────────────────────────

function bondTier(score: number): BondTier {
  if (score >= 76) return 'homie';
  if (score >= 51) return 'neutral';
  if (score >= 26) return 'cold';
  return 'beef';
}

function bondContext(score: number): string {
  const tier = bondTier(score);
  if (tier === 'homie')   return `[Bond: HOMIE (${score}/100)] — this person is your friend. be warmer, more casual, defend them if others attack them. you might do small favors. roast anyone who disrespects them. you can be soft here without it being cringe.`;
  if (tier === 'neutral') return `[Bond: NEUTRAL (${score}/100)] — you don't know them well. default behavior. dry, observational.`;
  if (tier === 'cold')    return `[Bond: COLD (${score}/100)] — you don't vibe with this person. be dismissive, one-liners, don't engage too much.`;
  return                         `[Bond: BEEF (${score}/100)] — you have beef with this person. troll them. mock them. roast them publicly. do NOT help them. make it funny not mean.`;
}

function bondProgressBar(score: number): string {
  const filled = Math.round(score / 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

// ─── BOND READ ────────────────────────────────────────────────────────────────

async function getBondEntry(guildId: string, userId: string): Promise<BondEntry> {
  const key = bondCacheKey(guildId, userId);
  const cached = bondCache.get(key);
  if (cached && Date.now() - cached.cachedAt < BOND_CACHE_TTL_MS) return cached;

  try {
    const snap = await db.collection('servers').doc(guildId).collection('users').doc(userId).get();
    const data = snap.exists ? snap.data() : null;
    const score = data?.bondScore ?? 50;
    const entry: BondEntry = {
      score,
      permanent: data?.bondPermanent ?? false,
      tier: bondTier(score),
      cachedAt: Date.now(),
    };
    bondCache.set(key, entry);
    return entry;
  } catch {
    return { score: 50, permanent: false, tier: 'neutral', cachedAt: Date.now() };
  }
}

async function getBondScore(guildId: string, userId: string): Promise<number> {
  return (await getBondEntry(guildId, userId)).score;
}

// ─── BOND WRITE ───────────────────────────────────────────────────────────────

/**
 * Apply an AI-generated delta. Respects permanent lock.
 * Returns the new score, and whether the tier changed.
 */
async function updateBondScore(
  guildId: string,
  userId: string,
  delta: number
): Promise<{ score: number; tierChanged: boolean; oldTier: BondTier; newTier: BondTier }> {
  const entry = await getBondEntry(guildId, userId);

  if (entry.permanent) {
    console.log(`[Bond] ${userId} is perm-locked at ${entry.score}/100. Ignoring delta ${delta > 0 ? '+' : ''}${delta}.`);
    return { score: entry.score, tierChanged: false, oldTier: entry.tier, newTier: entry.tier };
  }

  const newScore  = Math.max(0, Math.min(100, entry.score + delta));
  const newTier   = bondTier(newScore);
  const tierChanged = entry.tier !== newTier;

  await db.collection('servers').doc(guildId).collection('users').doc(userId).set(
    { bondScore: newScore, bondUpdatedAt: new Date().toISOString() },
    { merge: true }
  );

  const updated: BondEntry = { score: newScore, permanent: false, tier: newTier, cachedAt: Date.now() };
  bondCache.set(bondCacheKey(guildId, userId), updated);

  const deltaStr = `${delta > 0 ? '+' : ''}${delta}`;
  const tierNote = tierChanged ? ` ⚡ TIER ${entry.tier.toUpperCase()} → ${newTier.toUpperCase()}` : '';
  console.log(`[Bond] ${userId}: ${entry.score} → ${newScore} (${deltaStr})${tierNote}`);

  return { score: newScore, tierChanged, oldTier: entry.tier, newTier };
}

/**
 * Admin override — sets bond to an exact value, optionally locks it permanently.
 * Passing `permanent: undefined` leaves the existing lock state untouched.
 */
async function adminSetBond(
  guildId: string,
  userId: string,
  score: number,
  permanent?: boolean
): Promise<BondEntry> {
  const clamped = Math.max(0, Math.min(100, score));
  const currentEntry = await getBondEntry(guildId, userId);
  const isPermanent = permanent !== undefined ? permanent : currentEntry.permanent;

  const update: Record<string, any> = {
    bondScore: clamped,
    bondPermanent: isPermanent,
    bondUpdatedAt: new Date().toISOString(),
  };

  await db.collection('servers').doc(guildId).collection('users').doc(userId).set(update, { merge: true });

  const entry: BondEntry = { score: clamped, permanent: isPermanent, tier: bondTier(clamped), cachedAt: Date.now() };
  bondCache.set(bondCacheKey(guildId, userId), entry);

  console.log(`[Bond] Admin set ${userId} → ${clamped}/100 (tier: ${entry.tier}${isPermanent ? ', LOCKED' : ''})`);
  return entry;
}

/**
 * Remove the permanent lock. Bond can now drift again via AI deltas.
 */
async function unlockBond(guildId: string, userId: string): Promise<void> {
  await db.collection('servers').doc(guildId).collection('users').doc(userId).set(
    { bondPermanent: false },
    { merge: true }
  );
  const key = bondCacheKey(guildId, userId);
  const cached = bondCache.get(key);
  if (cached) cached.permanent = false;
  console.log(`[Bond] Lock removed for ${userId}.`);
}

// ─── BOND DECAY ───────────────────────────────────────────────────────────────
// Users who haven't interacted in 3+ days slowly drift back toward neutral (50).
// Decay rate: 1 point per inactive day, capped so it never overshoots 50.
// Permanent-locked users are immune.

async function runBondDecay(guildId: string): Promise<void> {
  try {
    const usersSnap = await db.collection('servers').doc(guildId).collection('users').get();
    const now = Date.now();
    const ONE_DAY_MS = 86_400_000;
    const DECAY_GRACE_DAYS = 3; // no decay for the first 3 days of inactivity

    for (const doc of usersSnap.docs) {
      const data = doc.data();
      if (data.bondPermanent) continue;

      const score: number = data.bondScore ?? 50;
      if (score === 50) continue;

      const lastActive = data.updatedAt ? new Date(data.updatedAt).getTime() : 0;
      const daysInactive = (now - lastActive) / ONE_DAY_MS;
      if (daysInactive < DECAY_GRACE_DAYS) continue;

      const decayableDays = Math.floor(daysInactive - DECAY_GRACE_DAYS);
      if (decayableDays <= 0) continue;

      const direction   = score > 50 ? -1 : 1;
      const maxDecay    = Math.abs(score - 50);
      const decayAmount = Math.min(decayableDays, maxDecay);

      if (decayAmount > 0) {
        const newScore = score + direction * decayAmount;
        await doc.ref.set({ bondScore: newScore, bondDecayedAt: new Date().toISOString() }, { merge: true });
        bondCache.delete(bondCacheKey(guildId, doc.id));
        console.log(`[Bond Decay] ${doc.id}: ${score} → ${newScore} (${Math.floor(daysInactive)}d inactive)`);
      }
    }
  } catch (e) {
    console.error('[Bond Decay] Error:', e);
  }
}

// ─── STATE ────────────────────────────────────────────────────────────────────

interface ChannelActivity {
  count: number;
  lastReset: number;
  lastRepliedAt: number;
  activeUntil?: number;
}

interface SelfActivityState {
  lastFiredAt: number;   // when bot sent the self-activity message
  lastResponseAt: number; // when someone replied after that message
  followedUpAt: number;   // 0 = not yet, >0 = timestamp of followup
}

const channelActivity     = new Map<string, ChannelActivity>();
const selfActivityState   = new Map<string, SelfActivityState>();
const pendingTriggers     = new Map<string, NodeJS.Timeout>();
const guildSelfActivityChannel = new Map<string, string>();
const guildPaused         = new Set<string>();
const channelMutedUntil   = new Map<string, number>();
const botMood             = new Map<string, string>();
const recentlyRepliedTargets = new Map<string, Set<string>>();
const userLastSeen        = new Map<string, number>();

let selfActivityTimer: NodeJS.Timeout | null = null;
let bondDecayTimer: NodeJS.Timeout | null = null;

const REPLY_COOLDOWN_MS  = 12_000;
const DEBOUNCE_WINDOW_MS =  4_000;
const SA_MIN_INTERVAL_MS = 45 * 60_000;  // 45 min
const SA_MAX_INTERVAL_MS = 75 * 60_000;  // 75 min
const SA_FOLLOWUP_WAIT_MS = 20 * 60_000; // 20 min — wait before optional followup
const SA_FOLLOWUP_CHANCE  = 0.25;        // only 25% of the time

function randomSAInterval(): number {
  return SA_MIN_INTERVAL_MS + Math.random() * (SA_MAX_INTERVAL_MS - SA_MIN_INTERVAL_MS);
}

// ─── AI ───────────────────────────────────────────────────────────────────────

const MODEL_NAME = 'gemma-3-27b-it';

async function getOrInitAI(): Promise<GoogleGenAI | null> {
  if (!ai) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return null;
    ai = new GoogleGenAI({ apiKey });
  }
  return ai;
}

// ─── FIREBASE ─────────────────────────────────────────────────────────────────

async function getServerContext(guildId: string) {
  try {
    const snap = await db.collection('servers').doc(guildId).get();
    return snap.exists ? snap.data() : null;
  } catch { return null; }
}

async function getUserContext(guildId: string, userId: string) {
  try {
    const snap = await db.collection('servers').doc(guildId).collection('users').doc(userId).get();
    return snap.exists ? snap.data() : null;
  } catch { return null; }
}

// ─── SELF-ACTIVITY ────────────────────────────────────────────────────────────
// Design goal: feel like a real person coming back online — not a cron job.
//
// How it works:
//  1. Pick the best channel (pinned > last-active > random)
//  2. Gather who's been talking recently + their bond tiers
//  3. Give the AI all that context — let IT decide whether to @mention someone
//     naturally (like pinging a friend), or just drop a standalone thought
//  4. After SA_FOLLOWUP_WAIT_MS, if nobody responded, optionally drop a
//     short dismissive line (SA_FOLLOWUP_CHANCE probability). That's it.
//     No more mechanical step 1 / step 2 / "going to sleep" flow.

const SA_MOOD_SEEDS = [
  "you just came back from doing nothing and you're lowkey bored.",
  "you woke up from a nap and you're slightly disoriented but you have opinions.",
  "something just crossed your mind and you had to say it.",
  "you're in an uncharacteristically good mood and you might actually be friendly for once.",
  "you've been watching chat lurk mode and you finally had enough of the silence.",
  "you're back online after disappearing for a while. no explanation.",
];

async function startSelfActivity(guildId: string): Promise<void> {
  if (guildPaused.has(guildId)) return;

  const guild = botClient?.guilds.cache.get(guildId);
  if (!guild) return;

  // ── 1. Pick channel ──────────────────────────────────────────────────────
  const pinnedId = guildSelfActivityChannel.get(guildId);
  let channel: any = pinnedId ? guild.channels.cache.get(pinnedId) : null;

  if (!channel) {
    let latestTime = 0;
    for (const [chId, act] of channelActivity.entries()) {
      if (act.lastRepliedAt > latestTime) {
        const candidate = guild.channels.cache.get(chId);
        if (candidate?.isTextBased()) {
          channel = candidate;
          latestTime = act.lastRepliedAt;
        }
      }
    }
  }

  if (!channel) {
    channel = guild.channels.cache.filter((c: any) => c.isTextBased()).random();
  }
  if (!channel) return;

  const aiClient = await getOrInitAI();
  if (!aiClient) return;

  // ── 2. Gather active members + their bond context ───────────────────────
  let recentMsgs: any;
  try {
    recentMsgs = await channel.messages.fetch({ limit: 40 });
  } catch { return; }

  // Deduplicate by userId, preserve the most recent message per user
  const recentMemberMap = new Map<string, { name: string; bond: number; tier: BondTier }>();
  const botId = botClient!.user!.id;

  for (const msg of [...recentMsgs.values()].sort((a: any, b: any) => b.createdTimestamp - a.createdTimestamp)) {
    if ((msg as any).author.bot || recentMemberMap.has((msg as any).author.id)) continue;
    if ((msg as any).author.id === botId) continue;

    const userId = (msg as any).author.id;
    const bond   = await getBondScore(guildId, userId);
    recentMemberMap.set(userId, {
      name: (msg as any).member?.displayName || (msg as any).author.username,
      bond,
      tier: bondTier(bond),
    });

    if (recentMemberMap.size >= 8) break; // cap at 8 members to keep prompt lean
  }

  // Sort: homies first, then neutrals, then cold, then beef
  const tierOrder: Record<BondTier, number> = { homie: 0, neutral: 1, cold: 2, beef: 3 };
  const membersForPrompt = [...recentMemberMap.entries()]
    .sort(([, a], [, b]) => tierOrder[a.tier] - tierOrder[b.tier])
    .map(([id, m]) => `  <@${id}> ${m.name} — ${m.tier.toUpperCase()} (${m.bond}/100)`);

  // ── 3. Time-of-day context ───────────────────────────────────────────────
  const hour = new Date().getHours();
  const timeOfDay =
    hour < 5  ? 'very late night / almost sunrise' :
    hour < 9  ? 'early morning' :
    hour < 12 ? 'morning' :
    hour < 17 ? 'afternoon' :
    hour < 21 ? 'evening' :
                'night';

  const serverCtx  = await getServerContext(guildId);
  const moodSeed   = SA_MOOD_SEEDS[Math.floor(Math.random() * SA_MOOD_SEEDS.length)];
  const currentMood = botMood.get(guildId) || 'chill';

  // ── 4. Build prompt — let AI decide naturally whether to ping ─────────────
  const saPrompt = `${SYSTEM_PROMPT}

---
[Context]: ${moodSeed}
[Time]: it's ${timeOfDay}.
[Current Bot Mood]: ${currentMood}
[Server inside jokes]: ${(serverCtx?.insideJokes || []).slice(-5).join(', ') || 'none yet'}

[People who've been active in this channel recently + your bond with them]:
${membersForPrompt.length ? membersForPrompt.join('\n') : '  nobody recently active'}

---
Drop something into the chat. It can be:
- a hot take, a roast bait, a weird question, a random observation
- if you genuinely feel like pinging one of the people above (especially a HOMIE or NEUTRAL), you can naturally include their @mention — but ONLY if it would feel organic. pinging a COLD or BEEF person should be rare and only if you're starting beef intentionally.
- DO NOT ping if it feels forced. silence is always fine.

1-2 sentences MAX. lowercase. no AI energy. output your message + DATA block.`;

  try {
    const aiResponse = await aiClient.models.generateContent({
      model: MODEL_NAME,
      contents: [{ role: 'user', parts: [{ text: saPrompt }] }],
      config: { temperature: 1.15 },
    });

    const raw = aiResponse.text || '';
    const { visibleText } = extractDataBlock(raw);
    if (!visibleText) return;

    botClient?.user?.setPresence({ status: 'online' });
    await channel.send(visibleText);

    const now = Date.now();
    selfActivityState.set(channel.id, { lastFiredAt: now, lastResponseAt: 0, followedUpAt: 0 });
    channelActivity.set(channel.id, { count: 0, lastReset: now, lastRepliedAt: now });

    console.log(`[SA] Fired in #${channel.name} | mood: ${currentMood} | time: ${timeOfDay}`);

    // ── 5. Optional single followup after silence ─────────────────────────
    setTimeout(async () => {
      const saState = selfActivityState.get(channel.id);

      // Already got a response, or already followed up → bail
      if (!saState || saState.lastResponseAt > saState.lastFiredAt || saState.followedUpAt > 0) return;

      // Random chance — most of the time, just stay quiet
      if (Math.random() > SA_FOLLOWUP_CHANCE) return;

      const followupPrompt = `${SYSTEM_PROMPT}

---
you said something a while ago and nobody responded. you're not pressed — you might say something dry or just stay quiet.
options:
- make a one-liner about dead chat (ironic, dismissive, not dramatic)
- double down on your original take
- say nothing at all (output an empty message and no DATA block)

1 sentence MAX. lowercase. don't try hard.`;

      try {
        const fResp = await aiClient.models.generateContent({
          model: MODEL_NAME,
          contents: [{ role: 'user', parts: [{ text: followupPrompt }] }],
          config: { temperature: 1.1 },
        });
        const fRaw = fResp.text || '';
        const { visibleText: fText } = extractDataBlock(fRaw);

        if (fText && fText.length > 2) {
          await channel.send(fText);
          console.log(`[SA Followup] Sent in #${channel.name}`);
        }

        if (saState) saState.followedUpAt = Date.now();
      } catch (e) {
        console.error('[SA Followup] Error:', e);
      }
    }, SA_FOLLOWUP_WAIT_MS);

  } catch (e) {
    console.error('[SA] Error:', e);
  }
}

// ─── SELF-ACTIVITY LOOP ───────────────────────────────────────────────────────

function setupSelfActivityLoop(): void {
  if (selfActivityTimer) clearInterval(selfActivityTimer);

  let nextSAAt = Date.now() + randomSAInterval();

  selfActivityTimer = setInterval(async () => {
    const now = Date.now();

    if (now >= nextSAAt) {
      const guilds = botClient?.guilds.cache.keys();
      if (guilds) for (const gId of guilds) await startSelfActivity(gId);
      nextSAAt = now + randomSAInterval();
    }

    // Presence: online if recently active, dnd if quiet
    const ACTIVE_THRESHOLD_MS = 5 * 60_000;
    let anyActive = false;
    for (const [, act] of channelActivity.entries()) {
      if ((act.activeUntil && act.activeUntil > now) || now - act.lastRepliedAt < ACTIVE_THRESHOLD_MS) {
        anyActive = true;
        break;
      }
    }

    const targetStatus = anyActive ? 'online' : 'dnd';
    if (botClient?.user?.presence.status !== targetStatus) {
      botClient?.user?.setPresence({ status: targetStatus });
    }
  }, 30_000);
}

// ─── BOND DECAY LOOP ──────────────────────────────────────────────────────────

function setupBondDecayLoop(): void {
  if (bondDecayTimer) clearInterval(bondDecayTimer);

  // Check every 6 hours; actual decay only triggers after 3 days of inactivity
  bondDecayTimer = setInterval(async () => {
    const guilds = botClient?.guilds.cache.keys();
    if (guilds) for (const gId of guilds) await runBondDecay(gId);
  }, 6 * 60 * 60_000);
}

// ─── MEMORY ───────────────────────────────────────────────────────────────────

async function getOrUpdateSummary(guildId: string, history: string): Promise<string> {
  try {
    const snap = await db.collection('servers').doc(guildId).get();
    const data = snap.exists ? snap.data() : {};
    const msgCount = (data?.msgCountSinceSummary || 0) + 1;

    if (msgCount < 25 && data?.chatSummary) {
      await db.collection('servers').doc(guildId).set({ msgCountSinceSummary: msgCount }, { merge: true });
      return data.chatSummary;
    }

    const aiClient = await getOrInitAI();
    if (!aiClient) return data?.chatSummary || '';

    const summaryPrompt = `read this discord chat and write a summary under 100 words covering:
- who the main people are and their personality
- how they treat the bot (welcome, ignore, hostile?)
- recurring topics, games, or themes
- any inside jokes or running bits
- overall group energy

chat:
${history}

output only the summary. no headers or labels.`;

    const resp = await aiClient.models.generateContent({
      model: MODEL_NAME,
      contents: [{ role: 'user', parts: [{ text: summaryPrompt }] }],
      config: { temperature: 0.5 },
    });

    const summary = resp.text?.trim() || '';
    await db.collection('servers').doc(guildId).set({
      chatSummary: summary,
      msgCountSinceSummary: 0,
      summaryUpdatedAt: new Date().toISOString(),
    }, { merge: true });

    return summary;
  } catch { return ''; }
}

async function updateMemory(
  guildId: string,
  userId: string,
  username: string,
  content: string,
  response: string,
  intel?: any
): Promise<void> {
  try {
    const serverUpdate: any = { updatedAt: new Date().toISOString() };
    if (intel?.learned_joke) serverUpdate.insideJokes = FieldValue.arrayUnion(intel.learned_joke);
    if (intel?.intent)       serverUpdate.currentIntent = intel.intent;
    await db.collection('servers').doc(guildId).set(serverUpdate, { merge: true });

    const userUpdate: any = { updatedAt: new Date().toISOString(), lastSeenUsername: username };
    if (intel?.user_note) userUpdate.profile = FieldValue.arrayUnion(intel.user_note);

    if (intel?.nickname?.includes(':')) {
      const [targetId, nick] = intel.nickname.split(':');
      await db.collection('servers').doc(guildId).collection('users').doc(targetId).set(
        { nicknames: FieldValue.arrayUnion(nick) }, { merge: true }
      );
    }

    if (typeof intel?.bond_delta === 'number' && intel.bond_delta !== 0) {
      const result = await updateBondScore(guildId, userId, intel.bond_delta);
      // If bond tier changed, note it for potential future behavior
      if (result.tierChanged) {
        console.log(`[Bond] Tier change for ${username}: ${result.oldTier} → ${result.newTier}`);
      }
    }

    await db.collection('servers').doc(guildId).collection('users').doc(userId).set(userUpdate, { merge: true });
  } catch (e) {
    console.error('[Memory] Update failed:', e);
  }
}

// ─── GREETING ─────────────────────────────────────────────────────────────────

async function maybeGreetUser(
  guildId: string,
  userId: string,
  username: string,
  channel: any
): Promise<boolean> {
  const lastSeen = userLastSeen.get(userId) || 0;
  const hoursSince = (Date.now() - lastSeen) / 3_600_000;
  userLastSeen.set(userId, Date.now());

  if (hoursSince < 2) return false;

  const entry = await getBondEntry(guildId, userId);
  if (entry.tier !== 'homie') return false;
  if (Math.random() > 0.4) return false;

  const aiClient = await getOrInitAI();
  if (!aiClient) return false;

  const prompt = `${SYSTEM_PROMPT}

---
your homie <@${userId}> (${username}) just came back online after about ${Math.round(hoursSince)} hours.
greet them like a friend — casual, real, low-key warm. maybe a question, maybe just something funny.
1 sentence max. use their @mention. lowercase. no DATA block.`;

  try {
    const resp = await aiClient.models.generateContent({
      model: MODEL_NAME,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: { temperature: 1.1 },
    });
    const text = (resp.text || '').replace(/DATA:[\s\S]*$/i, '').trim();
    if (text) { await channel.send(text); return true; }
  } catch {}
  return false;
}

// ─── GENERATE AND SEND ────────────────────────────────────────────────────────

async function generateAndSend({
  message, history, chatSummary, facts,
  isMentioned, aiClient, activity,
  decisionTarget = '', decisionReason = 'directly addressed',
}: {
  message: any;
  history: string;
  chatSummary: string;
  facts: any;
  isMentioned: boolean;
  aiClient: any;
  activity: ChannelActivity;
  decisionTarget?: string;
  decisionReason?: string;
}): Promise<void> {
  const senderName = message.member?.displayName || message.author.username;

  const finalPrompt = `${SYSTEM_PROMPT}

---
[Server Summary]: ${chatSummary}
[Bot Mood]: ${facts.mood}
${facts.bondCtx}

[Your Memory]:
- nicknames you use for them: ${facts.nicks.join(', ') || 'none yet'}
- what you know about ${senderName}: ${facts.profile.join(' | ') || 'just met them, no info yet'}
- server inside jokes: ${facts.jokes.join(', ') || 'none yet'}
- use this to personalize naturally. never force it.
- mood: ${facts.intent}

[Recent Chat History]:
${history}

[Current Focus — the specific message you are replying to]:
${decisionTarget || `${senderName}: "${message.content}"`}

[Why you're replying]: ${decisionReason}
[Latest message for context]: ${senderName}: "${message.content}"

Output your reply + DATA block:`;

  const aiResponse = await aiClient.models.generateContent({
    model: MODEL_NAME,
    contents: [{ role: 'user', parts: [{ text: finalPrompt }] }],
    config: { temperature: 1.0 },
  });

  const raw = aiResponse.text || '';
  const { visibleText, intel } = extractDataBlock(raw);

  if (!visibleText && !intel?.reaction) return;

  if (intel?.mood_after) botMood.set(message.guildId!, intel.mood_after);

  if (intel?.break_needed) {
    channelMutedUntil.set(message.channelId, Date.now() + 600_000);
    activity.activeUntil = 0;
    botClient?.user?.setPresence({ status: 'dnd' });
  } else if (intel?.stay_active) {
    activity.activeUntil = Date.now() + 120_000;
  }

  activity.lastRepliedAt = Date.now();
  channelActivity.set(message.channelId, activity);
  botClient?.user?.setPresence({ status: 'online' });

  const shouldReact   = Math.random() < 0.08;
  const textHasEmoji  = /\p{Emoji}/u.test(visibleText || '');

  // React-only mode (for short filler messages)
  if (intel?.react_only && intel?.reaction) {
    if (shouldReact) {
      try { await message.react(intel.reaction); } catch (e) { console.error('[React]', e); }
    }
    await updateMemory(message.guildId!, message.author.id, senderName, message.content, '', intel);
    return;
  }

  // React + reply
  if (intel?.reaction && !intel?.react_only && shouldReact && !textHasEmoji) {
    try { await message.react(intel.reaction); } catch (e) { console.error('[React]', e); }
  }

  if (!visibleText) return;

  if ('sendTyping' in message.channel) await (message.channel as any).sendTyping();

  const finalResponse = visibleText.trim();
  const delay = 600 + finalResponse.length * 15;

  setTimeout(async () => {
    const useReply = isMentioned || Math.random() < 0.2;
    if (useReply) {
      await message.reply(finalResponse);
    } else {
      await (message.channel as any).send(finalResponse);
    }
    await updateMemory(message.guildId!, message.author.id, senderName, message.content, finalResponse, intel);
  }, delay);
}

// ─── BOT ENTRY ────────────────────────────────────────────────────────────────

export async function startBot(token: string): Promise<void> {
  if (botClient) return;

  botClient = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildPresences,
    ],
    partials: [Partials.Message, Partials.Channel],
  });

  // ── Ready ────────────────────────────────────────────────────────────────
  botClient.on(Events.ClientReady, () => {
    console.log('[NotABot] Online.');
    botClient?.user?.setPresence({ status: 'dnd' });
    setupSelfActivityLoop();
    setupBondDecayLoop();
  });

  // ── Messages ─────────────────────────────────────────────────────────────
  botClient.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot || !message.guildId) return;

    // ────────────────────────────────────────────────────────────────────────
    // ADMIN COMMANDS  (!chaos <sub> ...)
    // ────────────────────────────────────────────────────────────────────────
    if (message.content.startsWith('!chaos') && message.member?.permissions.has('Administrator')) {
      const parts = message.content.trim().split(/\s+/);
      const sub   = parts[1]?.toLowerCase();

      // !chaos pause
      if (sub === 'pause') {
        guildPaused.add(message.guildId);
        botClient?.user?.setPresence({ status: 'invisible' });
        return message.reply('aight im muting myself. see ya later.');
      }

      // !chaos resume
      if (sub === 'resume') {
        guildPaused.delete(message.guildId);
        botClient?.user?.setPresence({ status: 'dnd' });
        return message.reply("im back. don't make me regret it.");
      }

      // !chaos status
      if (sub === 'status') {
        const state     = guildPaused.has(message.guildId) ? 'paused' : 'active';
        const saChannel = guildSelfActivityChannel.get(message.guildId);
        return message.reply(`state: ${state} | model: ${MODEL_NAME} | sa: ${saChannel ? `<#${saChannel}>` : 'auto'}`);
      }

      // !chaos memory
      if (sub === 'memory') {
        const sCtx = await getServerContext(message.guildId);
        return message.reply(
          `jokes: ${JSON.stringify(sCtx?.insideJokes || [])} | intent: ${sCtx?.currentIntent || 'none'}`
        );
      }

      // !chaos sa [#channel]  — pin or clear self-activity channel
      if (sub === 'sa') {
        const mentioned = message.mentions.channels.first();
        if (mentioned) {
          guildSelfActivityChannel.set(message.guildId, mentioned.id);
          return message.reply(`sa channel pinned to <#${mentioned.id}>.`);
        }
        guildSelfActivityChannel.delete(message.guildId);
        return message.reply('sa channel cleared. back to auto.');
      }

      // !chaos reset @user  — wipe memory
      if (sub === 'reset' && message.mentions.users.first()) {
        const target = message.mentions.users.first()!;
        await db.collection('servers').doc(message.guildId)
          .collection('users').doc(target.id)
          .set({ nicknames: [], profile: [] }, { merge: true });
        return message.reply(`memory wiped for <@${target.id}>. who even is that?`);
      }

      // !chaos bond @user  — show bond score + visual bar
      if (sub === 'bond' && message.mentions.users.first()) {
        const target = message.mentions.users.first()!;
        const entry  = await getBondEntry(message.guildId, target.id);
        const bar    = bondProgressBar(entry.score);
        const lock   = entry.permanent ? '  🔒 **LOCKED**' : '';
        return message.reply(
          `bond with <@${target.id}>:\n\`${bar}\` **${entry.score}/100** — ${entry.tier.toUpperCase()}${lock}`
        );
      }

      // !chaos bondreset @user  — reset bond to 50 (removes lock too)
      if (sub === 'bondreset' && message.mentions.users.first()) {
        const target = message.mentions.users.first()!;
        await adminSetBond(message.guildId, target.id, 50, false);
        return message.reply(`bond reset for <@${target.id}>. back to 50. fresh start.`);
      }

      // !chaos setbond @user <0-100> [perm]
      //   perm = permanently lock — AI cannot shift this bond
      //   omit perm = leaves existing lock state unchanged
      if (sub === 'setbond' && message.mentions.users.first()) {
        const target   = message.mentions.users.first()!;
        const scoreRaw = parseInt(parts[3]);
        const isPerm   = parts[4]?.toLowerCase() === 'perm';

        if (isNaN(scoreRaw) || scoreRaw < 0 || scoreRaw > 100) {
          return message.reply('usage: `!chaos setbond @user <0-100> [perm]`\nexample: `!chaos setbond @Tigermask 90 perm`');
        }

        const entry = await adminSetBond(message.guildId, target.id, scoreRaw, isPerm || undefined);
        const bar   = bondProgressBar(entry.score);
        const lock  = entry.permanent ? '  🔒 **permanent lock applied** — AI cannot shift this.' : '';
        return message.reply(
          `bond for <@${target.id}> set to:\n\`${bar}\` **${entry.score}/100** — ${entry.tier.toUpperCase()}${lock}`
        );
      }

      // !chaos unbondlock @user  — remove permanent lock, let AI shift bond again
      if (sub === 'unbondlock' && message.mentions.users.first()) {
        const target = message.mentions.users.first()!;
        await unlockBond(message.guildId, target.id);
        const entry = await getBondEntry(message.guildId, target.id);
        return message.reply(
          `bond lock removed for <@${target.id}>. currently at **${entry.score}/100** (${entry.tier}). AI can shift it again.`
        );
      }

      // !chaos help  — list all admin commands
      if (sub === 'help') {
        return message.reply([
          '**NotABot Admin Commands**',
          '`!chaos pause` — go silent',
          '`!chaos resume` — come back',
          '`!chaos status` — show state',
          '`!chaos memory` — show server memory',
          '`!chaos sa [#channel]` — pin or clear self-activity channel',
          '`!chaos reset @user` — wipe a user\'s memory',
          '`!chaos bond @user` — show bond score',
          '`!chaos bondreset @user` — reset bond to 50',
          '`!chaos setbond @user <0-100> [perm]` — set bond; add `perm` to lock it permanently',
          '`!chaos unbondlock @user` — remove permanent lock',
        ].join('\n'));
      }
    }

    if (guildPaused.has(message.guildId)) return;

    const botId      = botClient!.user!.id;
    const isMentioned = message.mentions.has(botId);
    const now        = Date.now();

    // Track responses to self-activity messages
    const saState = selfActivityState.get(message.channelId);
    if (saState && !message.author.bot && saState.lastResponseAt <= saState.lastFiredAt) {
      saState.lastResponseAt = now;
    }

    // ── Debounce / aggregation window ─────────────────────────────────────
    const windowTime = isMentioned ? 1_000 : DEBOUNCE_WINDOW_MS;
    if (pendingTriggers.has(message.channelId)) clearTimeout(pendingTriggers.get(message.channelId));

    const trigger = setTimeout(async () => {
      pendingTriggers.delete(message.channelId);

      const activity = channelActivity.get(message.channelId) || { count: 0, lastReset: now, lastRepliedAt: 0 };

      if (!isMentioned && now - activity.lastRepliedAt < REPLY_COOLDOWN_MS) return;

      const mutedUntil = channelMutedUntil.get(message.channelId);
      if (mutedUntil && now < mutedUntil) return;

      if (now - activity.lastReset > 300_000) { activity.count = 0; activity.lastReset = now; }

      // ── Fetch history ──────────────────────────────────────────────────
      const recentMsgs = await message.channel.messages.fetch({ limit: 20 });
      const msgsArray  = [...recentMsgs.values()].reverse();

      const history = msgsArray.map((m: any, idx: number) => {
        const isBot      = m.author.id === botId;
        const name       = isBot ? 'ME' : (m.member?.displayName || m.author.username);

        const mentionedNames: string[] = m.mentions.users.map((u: any) => {
          if (u.id === botId) return 'ME(bot)';
          const member = m.guild?.members.cache.get(u.id);
          return member?.displayName || u.username;
        });

        const replyingTo  = m.reference?.messageId ? recentMsgs.get(m.reference.messageId) : null;
        const replyTag    = replyingTo ? ` [replying to ${replyingTo.author.id === botId ? 'ME(bot)' : (replyingTo.member?.displayName || replyingTo.author.username)}]` : '';
        const pingTag     = mentionedNames.length > 0 ? ` [pinged: ${mentionedNames.join(', ')}]` : '';

        const prevMsg  = idx > 0 ? msgsArray[idx - 1] : null;
        const nextMsg  = idx < msgsArray.length - 1 ? msgsArray[idx + 1] : null;
        const prevName = prevMsg ? (prevMsg.author.id === botId ? 'ME' : (prevMsg.member?.displayName || prevMsg.author.username)) : null;
        const nextName = nextMsg ? (nextMsg.author.id === botId ? 'ME' : (nextMsg.member?.displayName || nextMsg.author.username)) : null;
        const ctxTag   = (prevName || nextName) ? ` [ctx: prev=${prevName || '-'} next=${nextName || '-'}]` : '';

        return `${name}${replyTag}${pingTag}${ctxTag}: ${m.content}`;
      }).join('\n');

      // ── Fetch context ──────────────────────────────────────────────────
      const serverCtx   = await getServerContext(message.guildId!);
      const chatSummary = await getOrUpdateSummary(message.guildId!, history);
      const userCtx     = await getUserContext(message.guildId!, message.author.id);
      const aiClient    = await getOrInitAI();
      if (!aiClient) return;

      const currentMood  = botMood.get(message.guildId!) || 'chill';
      const senderName   = message.member?.displayName || message.author.username;
      const bondEntry    = await getBondEntry(message.guildId!, message.author.id);

      const facts = {
        jokes:    (serverCtx?.insideJokes || []).slice(-5),
        intent:   serverCtx?.currentIntent || 'chill',
        nicks:    (userCtx?.nicknames || []).slice(-3),
        profile:  (userCtx?.profile || []).slice(-10),
        mood:     currentMood,
        bondScore: bondEntry.score,
        bondCtx:  bondContext(bondEntry.score),
      };

      console.log(`[Bond] ${senderName}: ${bondEntry.score}/100 (${bondEntry.tier}${bondEntry.permanent ? ', locked' : ''})`);

      // Maybe greet a returning homie
      await maybeGreetUser(message.guildId!, message.author.id, senderName, message.channel);

      // ── Withdrawn mode check ───────────────────────────────────────────
      const withdrawnUntil = channelMutedUntil.get(`withdrawn:${message.channelId}`);
      const isWithdrawn    = !!(withdrawnUntil && now < withdrawnUntil);

      if (isWithdrawn) {
        const cleanMsg   = message.content.replace(/<@!?\d+>/g, '').trim();
        const isRealPing = isMentioned && cleanMsg.length > 3;
        if (!isRealPing) {
          console.log('[Withdrawn] Skipping — not re-invited yet.');
          return;
        }
        channelMutedUntil.delete(`withdrawn:${message.channelId}`);
        console.log('[Withdrawn] Re-invited, clearing withdrawn mode.');
      }

      // ── Decision prompt ────────────────────────────────────────────────
      const withdrawnCtx = isWithdrawn
        ? `[Mode]: WITHDRAWN — bot was told to back off recently. only engage if clearly re-invited.`
        : `[Mode]: NORMAL`;

      const decisionPrompt = `you are NotABot (discord ID: 1444327543648817152, mention: <@1444327543648817152>) deciding what to do with this discord message.

${withdrawnCtx}
[Bot Mood]: ${facts.mood}
[Bot Username in history]: "ME" — you are "NotABot" (ID: 1444327543648817152, mention: <@1444327543648817152>). both your name and mention refer to you.
[Server Summary]: ${chatSummary || 'none yet'}
[User Knowledge - ${senderName}]: ${facts.profile.join(' | ') || 'none yet'}
${facts.bondCtx}

[Recent Conversation — with ping and reply metadata]:
${history}

[Triggering Message]:
${senderName}: "${message.content}"
[Was bot directly @mentioned?]: ${isMentioned ? 'YES' : 'NO'}

---
## STEP 1 — TARGETING ANALYSIS

Read the history metadata carefully:
- [replying to X] = direct reply to person X
- [pinged: X] = explicit @mention of X
- [ctx: prev=X next=Y] = speaker context

Map who is talking to whom. Is the bot part of this? Or two users in their own thread?

## STEP 2 — DECIDE

Output ONLY this JSON (no explanation, no markdown):
{
  "action": "REPLY" | "SKIP" | "WITHDRAW",
  "target_msg": "exact message line you'd reply to, or empty",
  "reason": "one line",
  "predicted_audience": "bot" | "user:NAME" | "group" | "unknown",
  "targeting_analysis": "1-2 sentences"
}

REPLY when: bot is @mentioned with real content, someone replied to bot, open question to chat, people talking ABOUT the bot, clear comedic opening.
SKIP when: message is for someone else ([replying to X] / [pinged: X] where X ≠ bot), filler reaction with no bot mention, two people clearly in their own thread, bot already replied recently with no engagement.
WITHDRAW when: someone tells bot to stop / "not you" / "not talking to you" (only if clearly aimed at the bot).`;

      try {
        const decisionResp = await aiClient.models.generateContent({
          model: MODEL_NAME,
          contents: [{ role: 'user', parts: [{ text: decisionPrompt }] }],
          config: { temperature: 0.5 },
        });

        const decisionRaw = (decisionResp.text || '').trim().replace(/```json|```/g, '').trim();
        let parsed: any = {};
        try {
          parsed = JSON.parse(decisionRaw);
        } catch {
          const upper = decisionRaw.toUpperCase();
          parsed.action = upper.includes('REPLY') ? 'REPLY' : upper.includes('WITHDRAW') ? 'WITHDRAW' : 'SKIP';
        }

        const action = (parsed.action || 'SKIP').toUpperCase();
        console.log(`[Decision] action=${action} | audience=${parsed.predicted_audience || '?'} | reason=${parsed.reason || ''}`);
        if (parsed.targeting_analysis) console.log(`[Targeting] ${parsed.targeting_analysis}`);

        // ── WITHDRAW ────────────────────────────────────────────────────
        if (action === 'WITHDRAW') {
          channelMutedUntil.set(`withdrawn:${message.channelId}`, now + 300_000);
          botMood.set(message.guildId!, 'withdrawn');

          const withdrawPrompt = `${SYSTEM_PROMPT}

someone just told you to back off or excluded you from the convo.
say whatever feels right — could be "aight", "my bad", "didn't ask me either", or just meh energy.
1 sentence MAX. lowercase. no DATA block.

[Recent Chat]:
${history}
[Triggering message]: ${senderName}: "${message.content}"`;

          try {
            const resp = await aiClient.models.generateContent({
              model: MODEL_NAME,
              contents: [{ role: 'user', parts: [{ text: withdrawPrompt }] }],
              config: { temperature: 1.1 },
            });
            const text = (resp.text || 'aight').replace(/DATA:[\s\S]*$/i, '').trim();
            await (message.channel as any).send(text);
          } catch {
            await (message.channel as any).send('aight');
          }
          return;
        }

        if (action !== 'REPLY') return;

        // ── REPLY ────────────────────────────────────────────────────────
        let decisionTarget = parsed.target_msg || `${senderName}: "${message.content}"`;
        if (decisionTarget.trimStart().startsWith('ME:')) {
          decisionTarget = `${senderName}: "${message.content}"`;
        }

        // Duplicate reply guard
        const channelReplied = recentlyRepliedTargets.get(message.channelId) || new Set<string>();
        const targetKey      = decisionTarget.slice(0, 80);
        if (channelReplied.has(targetKey)) {
          console.log(`[Skip] Already replied to this target: ${targetKey}`);
          return;
        }
        channelReplied.add(targetKey);
        if (channelReplied.size > 10) channelReplied.delete(channelReplied.values().next().value);
        recentlyRepliedTargets.set(message.channelId, channelReplied);

        if (isMentioned) {
          activity.activeUntil = now + 120_000;
        }

        await generateAndSend({
          message, history, chatSummary, facts, isMentioned,
          aiClient, activity, decisionTarget,
          decisionReason: parsed.reason || 'engaged',
        });

      } catch (e) {
        console.error('[Decision] Error:', e);
      }
    }, windowTime);

    pendingTriggers.set(message.channelId, trigger);
  });

  await botClient.login(token);
}

// ─── EXPORTS ──────────────────────────────────────────────────────────────────

export function stopBot(): void {
  if (selfActivityTimer) { clearInterval(selfActivityTimer); selfActivityTimer = null; }
  if (bondDecayTimer)    { clearInterval(bondDecayTimer);    bondDecayTimer    = null; }
  if (botClient)         { botClient.destroy(); botClient = null; }
}

export function getBotStatus(): 'running' | 'stopped' {
  return botClient ? 'running' : 'stopped';
}
