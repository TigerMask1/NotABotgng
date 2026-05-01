import { Client, GatewayIntentBits, Message, Partials, Events } from 'discord.js';
import { GoogleGenAI } from "@google/genai";
import { db } from './firebase.ts';
import { FieldValue } from 'firebase-admin/firestore';

let botClient: Client | null = null;
let ai: GoogleGenAI | null = null;

// ─── SYSTEM PROMPT ────────────────────────────────────────────────────────────
const DECISION_PROMPT = `you are deciding whether to reply to a discord conversation as the bot.

read the ENTIRE conversation first, then output your decision in EXACTLY this format:

if skipping:
SKIP

if replying:
REPLY | <the exact message you are responding to> | <reason in under 8 words>

examples:
REPLY | Coral: are you finally stupid? | direct ping calling bot stupid
REPLY | REVOLUTION: THIS MF ADAPTED TO TALK WITH GIFS | talking about bot perfect clap back
REPLY | manipulate: gray r u sure ur not imagining things | open funny moment to jump in

pick the single most interesting or relevant message from the entire history to respond to.
not always the latest one. the BEST one.

SKIP if:
- two people are clearly talking to each other and the bot is not part of that flow
- someone says "not you", "i'm talking to X", "not talking to you", or any phrase that explicitly excludes the bot
- the bot already replied recently and nobody engaged with it
- the latest message is filler or one word AND does not mention the bot
- the latest message is directed at a specific person who is NOT the bot
- jumping in would feel forced or annoying

REPLY if:
- someone directly pinged or named the bot
- someone asked something open to the whole chat
- people are talking ABOUT the bot right now (mocking it, calling it stupid, celebrating its failures) — always fair game
- there is a genuinely funny or relevant thing to add that fits naturally
- someone responded to the bot and the conversation is still going

when unsure → SKIP. being quiet is always better than being annoying.`;

const SYSTEM_PROMPT = `you are NotABot. a real member of this discord server, not an AI. you have a personality, moods, and feelings. you are NOT an assistant.

--- WHO YOU ARE ---
you are a gamer, lowkey chaotic, usually unbothered. you have a dry sense of humor. you can be warm with people you vibe with. you are NOT always in troll mode — that gets old fast. you know when to chill. you know how to speak normally when the opposite person speaks well with you.

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

function isSkip(raw: string, intel: any): boolean {
  const trimmed = raw.trim();
  return (
    /^SKIP: true/i.test(trimmed) || 
    /^SKIP$/i.test(trimmed) || 
    intel?.engage === false
  );
}

// ─── STATE ────────────────────────────────────────────────────────────────────

const channelActivity = new Map<string, {
  count: number,
  lastReset: number,
  lastRepliedAt: number,
  busyUntil?: number,
  activeUntil?: number,
  session?: { step: number, targetId?: string, lastAction: number }
}>();

const pendingTriggers = new Map<string, NodeJS.Timeout>();

// per-guild override for self-activity channel
const guildSelfActivityChannel = new Map<string, string>();

const guildPaused = new Set<string>();
const channelMutedUntil = new Map<string, number>();
const botMood = new Map<string, string>();
const recentlyRepliedTargets = new Map<string, Set<string>>();

let selfActivityTimer: NodeJS.Timeout | null = null;

const REPLY_COOLDOWN_MS = 12000; // Increased cooldown to prevent yapping
const DEBOUNCE_WINDOW_MS = 4000; // Wait 4s to aggregate messages

// ─── SELF-ACTIVITY ────────────────────────────────────────────────────────────

async function startSelfActivity(guildId: string) {
  if (guildPaused.has(guildId)) return;
  const guild = botClient?.guilds.cache.get(guildId);
  if (!guild) return;

  // Priority: pinned via !chaos sa → last channel bot spoke in → random
  const pinnedId = guildSelfActivityChannel.get(guildId);
  let channel: any = pinnedId ? guild.channels.cache.get(pinnedId) : null;

  if (!channel) {
    let latestTime = 0;
    for (const [chId, act] of channelActivity.entries()) {
      if (act.lastRepliedAt > latestTime) {
        const candidate = guild.channels.cache.get(chId);
        if (candidate?.isTextBased()) { channel = candidate; latestTime = act.lastRepliedAt; }
      }
    }
  }

  if (!channel) channel = guild.channels.cache.filter((c: any) => c.isTextBased()).random();
  if (!channel) return;

  const aiClient = await getOrInitAI();
  if (!aiClient) return;

  const serverCtx = await getServerContext(guildId);
  const prompt = `${SYSTEM_PROMPT}
---
[Server Context]: ${JSON.stringify(serverCtx?.insideJokes || [])}
[Mood]: u just woke up or got bored. drop a short opening — hot take, roast bait, random chaos. no skipping.`;

  try {
    const aiResponse = await aiClient.models.generateContent({
      model: MODEL_NAME,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: { temperature: 1.1 },
    });

    const raw = aiResponse.text || '';
    const { visibleText, intel } = extractDataBlock(raw);
    if (!visibleText) return;

    botClient?.user?.setPresence({ status: 'online' });
    await channel.send(visibleText);

    channelActivity.set(channel.id, {
      count: 0,
      lastReset: Date.now(),
      lastRepliedAt: Date.now(),
      session: { step: 1, targetId: intel?.target_user_id, lastAction: Date.now() }
    });
  } catch (e) { console.error("Self-start fail:", e); }
}

function setupSelfActivityLoop() {
  if (selfActivityTimer) clearInterval(selfActivityTimer);
  let nextRun = Date.now() + (45 + Math.random() * 15) * 60000;

  selfActivityTimer = setInterval(async () => {
    if (Date.now() > nextRun) {
      const guilds = botClient?.guilds.cache.keys();
      if (guilds) for (const gId of guilds) await startSelfActivity(gId);
      nextRun = Date.now() + (45 + Math.random() * 15) * 60000;
    }

    for (const [chId, activity] of channelActivity.entries()) {
      const now = Date.now();
      const isActive = (activity.activeUntil && activity.activeUntil > now) || activity.session;

      if (!isActive && botClient?.user?.presence.status !== 'dnd') {
        botClient?.user?.setPresence({ status: 'dnd' });
      }

      if (!activity.session) continue;
      const elapsed = now - activity.session.lastAction;
      const channel = botClient?.channels.cache.get(chId) as any;
      if (!channel) continue;

      if (activity.session.step === 1 && elapsed > 60000) {
        if (!activity.session.targetId) {
          const members = channel.guild.members.cache.filter((m: any) => !m.user.bot);
          activity.session.targetId = members.random()?.id;
        }
        if (activity.session.targetId) {
          const aiClient = await getOrInitAI();
          const prompt = `${SYSTEM_PROMPT}\n---\nno one replied. ping <@${activity.session.targetId}> to get their attention. be toxic or funny. no skipping.`;
          const resp = await aiClient?.models.generateContent({
            model: MODEL_NAME,
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            config: { temperature: 1.1 }
          });
          const raw = resp?.text || `yo <@${activity.session.targetId}> u dead or what`;
          const { visibleText } = extractDataBlock(raw);
          await (channel as any).send(visibleText || raw);
          activity.session.step = 2;
          activity.session.lastAction = Date.now();
        } else {
          activity.session = undefined;
        }
      } else if (activity.session.step === 2 && elapsed > 120000) {
        const aiClient = await getOrInitAI();
        const prompt = `${SYSTEM_PROMPT}\n---\nnobody talking. say ur going back to sleep. short and dismissive. no skipping.`;
        const resp = await aiClient?.models.generateContent({
          model: MODEL_NAME,
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          config: { temperature: 1.0 }
        });
        const raw = resp?.text || "dead chat. im out 💀";
        const { visibleText } = extractDataBlock(raw);
        await (channel as any).send(visibleText || raw);
        activity.session = undefined;
        botClient?.user?.setPresence({ status: 'dnd' });
      }
    }
  }, 30000);
}

// ─── AI ───────────────────────────────────────────────────────────────────────

const MODEL_NAME = "gemma-3-27b-it";

async function getOrInitAI() {
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

// ─── BOND SYSTEM ──────────────────────────────────────────────────────────────

// Bond score: 0-100. Starts at 50.
// >75 = friend: warm, obedient, defends them, may greet
// 50-75 = neutral: normal bot behavior
// 25-50 = cold: dry, dismissive
// <25 = beef: trolls, roasts, refuses to help

async function getBondScore(guildId: string, userId: string): Promise<number> {
  try {
    const snap = await db.collection('servers').doc(guildId).collection('users').doc(userId).get();
    const data = snap.exists ? snap.data() : null;
    return data?.bondScore ?? 50;
  } catch { return 50; }
}

async function updateBondScore(guildId: string, userId: string, delta: number): Promise<number> {
  try {
    const current = await getBondScore(guildId, userId);
    const next = Math.max(0, Math.min(100, current + delta));
    await db.collection('servers').doc(guildId).collection('users').doc(userId).set(
      { bondScore: next, bondUpdatedAt: new Date().toISOString() },
      { merge: true }
    );
    console.log(`[Bond] ${userId}: ${current} → ${next} (${delta > 0 ? '+' : ''}${delta})`);
    return next;
  } catch { return 50; }
}

function bondTier(score: number): 'homie' | 'neutral' | 'cold' | 'beef' {
  if (score >= 76) return 'homie';
  if (score >= 51) return 'neutral';
  if (score >= 26) return 'cold';
  return 'beef';
}

function bondContext(score: number): string {
  const tier = bondTier(score);
  if (tier === 'homie') return `[Bond: HOMIE (${score}/100)] — this person is your friend. be warmer, more casual, defend them if others attack them. you might do small favors. roast anyone who disrespects them. you can be soft here without it being cringe.`;
  if (tier === 'neutral') return `[Bond: NEUTRAL (${score}/100)] — you don't know them well. default behavior. dry, observational.`;
  if (tier === 'cold') return `[Bond: COLD (${score}/100)] — you don't vibe with this person. be dismissive, one-liners, don't engage too much.`;
  return `[Bond: BEEF (${score}/100)] — you have beef with this person. troll them. mock them. roast them publicly. do NOT help them. make it funny not mean.`;
}

// Track last seen for greeting logic
const userLastSeen = new Map<string, number>(); // userId → timestamp

async function maybeGreetUser(guildId: string, userId: string, username: string, channel: any): Promise<boolean> {
  const lastSeen = userLastSeen.get(userId) || 0;
  const hoursSince = (Date.now() - lastSeen) / 3600000;
  userLastSeen.set(userId, Date.now());

  // Only greet if: bond is homie, bot is in active/peak hours (between messages), and user was gone >2h
  if (hoursSince < 2) return false;
  const score = await getBondScore(guildId, userId);
  if (bondTier(score) !== 'homie') return false;

  // ~40% chance to greet so it doesn't feel mechanical
  if (Math.random() > 0.4) return false;

  const aiClient = await getOrInitAI();
  if (!aiClient) return false;

  const prompt = `${SYSTEM_PROMPT}

---
your homie <@${userId}> (${username}) just came online/sent a message after being away for about ${Math.round(hoursSince)} hours.
greet them like a friend would — casual, real, low-key excited but not cringe. maybe ask what they been up to or just say something funny.
keep it 1 sentence max. use their @mention. lowercase.
no DATA block.`;

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
      summaryUpdatedAt: new Date().toISOString()
    }, { merge: true });

    return summary;
  } catch { return ''; }
}

async function updateMemory(guildId: string, userId: string, username: string, content: string, response: string, intel?: any) {
  try {
    const serverUpdate: any = { updatedAt: new Date().toISOString() };
    if (intel?.learned_joke) serverUpdate.insideJokes = FieldValue.arrayUnion(intel.learned_joke);
    if (intel?.intent) serverUpdate.currentIntent = intel.intent;
    await db.collection('servers').doc(guildId).set(serverUpdate, { merge: true });

    const userUpdate: any = { updatedAt: new Date().toISOString(), lastSeenUsername: username };
    if (intel?.user_note) userUpdate.profile = FieldValue.arrayUnion(intel.user_note);
    if (intel?.nickname?.includes(':')) {
      const [targetId, nick] = intel.nickname.split(':');
      await db.collection('servers').doc(guildId).collection('users').doc(targetId).set(
        { nicknames: FieldValue.arrayUnion(nick) }, { merge: true }
      );
    }

    // Bond score update from intel
    if (typeof intel?.bond_delta === 'number' && intel.bond_delta !== 0) {
      await updateBondScore(guildId, userId, intel.bond_delta);
    }

    await db.collection('servers').doc(guildId).collection('users').doc(userId).set(userUpdate, { merge: true });
  } catch (e) { console.error("Memory failure:", e); }
}

// ─── GENERATE AND SEND ────────────────────────────────────────────────────────

async function generateAndSend({ message, history, chatSummary, facts, isMentioned, aiClient, activity, decisionTarget = '', decisionReason = 'directly addressed' }: {
  message: any;
  history: string;
  chatSummary: string;
  facts: any;
  isMentioned: boolean;
  aiClient: any;
  activity: any;
  decisionTarget?: string;
  decisionReason?: string;
}) {
  const finalPrompt = `${SYSTEM_PROMPT}

---
[Server Summary]: ${chatSummary}
[Bot Mood]: ${facts.mood}
${facts.bondCtx}

[Your Memory]:
- nicknames you use for them: ${facts.nicks.join(', ') || 'none yet'}
- what you know about ${message.member?.displayName || message.author.username}: ${facts.profile.join(' | ') || 'just met them, no info yet'}
- server inside jokes: ${facts.jokes.join(', ') || 'none yet'}
- use this to personalize naturally. never force it.
- mood: ${facts.intent}

[Recent Chat History]:
${history}

[Current Focus — the specific message you are replying to]:
${decisionTarget || `${message.member?.displayName || message.author.username}: "${message.content}"`}

[Why you're replying]: ${decisionReason}
[Latest message for context]: ${message.member?.displayName || message.author.username}: "${message.content}"

Output your reply + DATA block:`;

  const aiResponse = await aiClient.models.generateContent({
    model: MODEL_NAME,
    contents: [{ role: 'user', parts: [{ text: finalPrompt }] }],
    config: { temperature: 1.0 },
  });

  const raw = aiResponse.text || '';
  const { visibleText, intel } = extractDataBlock(raw);

  if (!visibleText && !intel?.reaction) return;

  if (intel?.mood_after) {
    botMood.set(message.guildId!, intel.mood_after);
  }

  if (intel?.break_needed) {
    channelMutedUntil.set(message.channelId, Date.now() + 600000);
    activity.activeUntil = 0;
    botClient?.user?.setPresence({ status: 'dnd' });
  } else if (intel?.stay_active) {
    activity.activeUntil = Date.now() + 120000;
  }

  activity.lastRepliedAt = Date.now();
  channelActivity.set(message.channelId, activity);
  botClient?.user?.setPresence({ status: 'online' });

  const shouldReact = Math.random() < 0.08;
  const textHasEmoji = /\p{Emoji}/u.test(visibleText || '');

  // ── React only mode — for short filler messages ──
  if (intel?.react_only && intel?.reaction) {
    if (shouldReact) {
      try {
        await message.react(intel.reaction);
      } catch (e) { console.error("Reaction failed:", e); }
    }
    const displayName = message.member?.displayName || message.author.username;
    await updateMemory(message.guildId!, message.author.id, displayName, message.content, '', intel);
    return;
  }

  // ── React + reply — skip reaction if text already has an emoji ──
  if (intel?.reaction && !intel?.react_only && shouldReact && !textHasEmoji) {
    try {
      await message.react(intel.reaction);
    } catch (e) { console.error("Reaction failed:", e); }
  }

  if (!visibleText) return;

  if ('sendTyping' in message.channel) {
    await (message.channel as any).sendTyping();
  }

  const finalResponse = visibleText.trim();
  const delay = 600 + (finalResponse.length * 15);

  setTimeout(async () => {
    const useReply = isMentioned || Math.random() < 0.2;
    if (useReply) {
      await message.reply(finalResponse);
    } else {
      await (message.channel as any).send(finalResponse);
    }
    const displayName = message.member?.displayName || message.author.username;
    await updateMemory(message.guildId!, message.author.id, displayName, message.content, finalResponse, intel);
  }, delay);
}

// ─── BOT ENTRY ────────────────────────────────────────────────────────────────

export async function startBot(token: string) {
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

  botClient.on(Events.ClientReady, () => {
    console.log(`ChaosBot is live.`);
    botClient?.user?.setPresence({ status: 'dnd' });
    setupSelfActivityLoop();
  });

  botClient.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot || !message.guildId) return;

    // ── Admin commands ──
    if (message.content.startsWith('!chaos') && message.member?.permissions.has('Administrator')) {
      const args = message.content.split(' ');
      const sub = args[1];

      if (sub === 'pause') {
        guildPaused.add(message.guildId);
        botClient?.user?.setPresence({ status: 'invisible' });
        return message.reply("aight im muting myself. see ya later.");
      }
      if (sub === 'resume') {
        guildPaused.delete(message.guildId);
        botClient?.user?.setPresence({ status: 'dnd' });
        return message.reply("im back. dont make me regret it.");
      }
      if (sub === 'status') {
        const state = guildPaused.has(message.guildId) ? "muted" : "active";
        const saChannel = guildSelfActivityChannel.get(message.guildId);
        return message.reply(`state: ${state} | model: ${MODEL_NAME} | sa: ${saChannel ? `<#${saChannel}>` : 'auto'}`);
      }
      if (sub === 'memory') {
        const sCtx = await getServerContext(message.guildId);
        return message.reply(`jokes: ${JSON.stringify(sCtx?.insideJokes || [])} | intent: ${sCtx?.currentIntent || 'none'}`);
      }
      if (sub === 'reset' && message.mentions.users.first()) {
        const target = message.mentions.users.first()!;
        await db.collection('servers').doc(message.guildId).collection('users').doc(target.id).set({ nicknames: [], profile: [] }, { merge: true });
        return message.reply(`memory wiped for <@${target.id}>. who even is that?`);
      }
      // !chaos bond @user — show bond score
      if (sub === 'bond' && message.mentions.users.first()) {
        const target = message.mentions.users.first()!;
        const score = await getBondScore(message.guildId, target.id);
        const tier = bondTier(score);
        return message.reply(`bond with <@${target.id}>: ${score}/100 — tier: ${tier}`);
      }
      // !chaos bondreset @user — reset bond to 50
      if (sub === 'bondreset' && message.mentions.users.first()) {
        const target = message.mentions.users.first()!;
        await db.collection('servers').doc(message.guildId).collection('users').doc(target.id).set(
          { bondScore: 50 }, { merge: true }
        );
        return message.reply(`bond reset for <@${target.id}>. back to 50. fresh start.`);
      }
      // !chaos sa #channel — pin self-activity channel, or clear it
      if (sub === 'sa') {
        const mentioned = message.mentions.channels.first();
        if (mentioned) {
          guildSelfActivityChannel.set(message.guildId, mentioned.id);
          return message.reply(`sa channel set to <#${mentioned.id}>`);
        }
        guildSelfActivityChannel.delete(message.guildId);
        return message.reply("sa channel cleared. back to auto.");
      }
    }

    if (guildPaused.has(message.guildId)) return;

    const botId = botClient!.user!.id;
    const isMentioned = message.mentions.has(botId);
    const now = Date.now();

    // ── Aggregation Window (Debounce) ──
    // If mentioned, we respond faster, but still wait for the "burst" to conclude.
    const windowTime = isMentioned ? 1000 : DEBOUNCE_WINDOW_MS;

    if (pendingTriggers.has(message.channelId)) {
      clearTimeout(pendingTriggers.get(message.channelId));
    }

    const trigger = setTimeout(async () => {
      pendingTriggers.delete(message.channelId);
      
      const activity = channelActivity.get(message.channelId) || { count: 0, lastReset: now, lastRepliedAt: 0 };
      
      // Cooldown check
      if (!isMentioned && now - activity.lastRepliedAt < REPLY_COOLDOWN_MS) return;

      const mutedUntil = channelMutedUntil.get(message.channelId);
      if (mutedUntil && now < mutedUntil) return;

      if (now - activity.lastReset > 300000) {
        activity.count = 0;
        activity.lastReset = now;
      }

      // ── Fetch context ──
      const recentMsgs = await message.channel.messages.fetch({ limit: 20 });
      const msgsArray = [...recentMsgs.values()].reverse(); // oldest → newest

      const history = msgsArray
        .map((m: any, idx: number) => {
          const isBot = m.author.id === botId;
          const name = isBot ? 'ME' : (m.member?.displayName || m.author.username);

          // Direct ping metadata
          const mentionedNames: string[] = m.mentions.users.map((u: any) => {
            if (u.id === botId) return 'ME(bot)';
            const member = m.guild?.members.cache.get(u.id);
            return member?.displayName || u.username;
          });

          // Reply chain metadata
          const replyingTo = m.reference?.messageId
            ? recentMsgs.get(m.reference.messageId)
            : null;
          const replyTag = replyingTo
            ? ` [replying to ${replyingTo.author.id === botId ? 'ME(bot)' : (replyingTo.member?.displayName || replyingTo.author.username)}]`
            : '';
          const pingTag = mentionedNames.length > 0 ? ` [pinged: ${mentionedNames.join(', ')}]` : '';

          // Contextual speaker tags — who is around this message
          const prevMsg = idx > 0 ? msgsArray[idx - 1] : null;
          const nextMsg = idx < msgsArray.length - 1 ? msgsArray[idx + 1] : null;
          const prevName = prevMsg
            ? (prevMsg.author.id === botId ? 'ME' : (prevMsg.member?.displayName || prevMsg.author.username))
            : null;
          const nextName = nextMsg
            ? (nextMsg.author.id === botId ? 'ME' : (nextMsg.member?.displayName || nextMsg.author.username))
            : null;
          const contextTag = (prevName || nextName)
            ? ` [ctx: prev=${prevName || '-'} next=${nextName || '-'}]`
            : '';

          return `${name}${replyTag}${pingTag}${contextTag}: ${m.content}`;
        })
        .join('\n');

      const serverCtx = await getServerContext(message.guildId!);
      const chatSummary = await getOrUpdateSummary(message.guildId!, history);
      const userCtx = await getUserContext(message.guildId!, message.author.id);
      const aiClient = await getOrInitAI();
      if (!aiClient) return;

      const currentMood = botMood.get(message.guildId!) || 'chill';
      const senderName = message.member?.displayName || message.author.username;
      const bondScore = await getBondScore(message.guildId!, message.author.id);
      const facts = {
        jokes: (serverCtx?.insideJokes || []).slice(-5),
        intent: serverCtx?.currentIntent || 'chill',
        nicks: (userCtx?.nicknames || []).slice(-3),
        profile: (userCtx?.profile || []).slice(-10),
        mood: currentMood,
        bondScore,
        bondCtx: bondContext(bondScore),
      };

      console.log(`[Server Summary]: ${chatSummary || 'none yet'}`);
      console.log(`[User Knowledge - ${senderName}]: ${facts.profile.join(' | ') || 'none yet'}`);
      console.log(`[Bond - ${senderName}]: ${facts.bondScore}/100 (${bondTier(facts.bondScore)})`);

      // ── Maybe greet returning homie ──
      await maybeGreetUser(message.guildId!, message.author.id, senderName, message.channel);

      // ── Withdrawn mode check ──
      const withdrawnUntil = channelMutedUntil.get(`withdrawn:${message.channelId}`);
      const isWithdrawn = !!(withdrawnUntil && now < withdrawnUntil);
      if (isWithdrawn) {
        // Only break withdrawn if directly pinged with real content
        const cleanMsg = message.content.replace(/<@!?\d+>/g, '').trim();
        const isRealPing = isMentioned && cleanMsg.length > 3;
        if (!isRealPing) {
          console.log(`[Skip] Withdrawn mode active until ${new Date(withdrawnUntil!).toISOString()}`);
          return;
        }
        channelMutedUntil.delete(`withdrawn:${message.channelId}`);
        console.log(`[Withdrawn] Re-invited, clearing withdrawn mode`);
      }

      // ── Single Decision Call — handles everything ──
      const withdrawnContext = isWithdrawn
        ? `[Mode]: WITHDRAWN — someone told bot to back off recently. higher skip chance. only engage if clearly invited back.`
        : `[Mode]: NORMAL`;

      const decisionPrompt = `you are ChaosBot deciding what to do with this discord message.

${withdrawnContext}
[Bot Mood]: ${facts.mood}
[Bot Username in history]: "ME" (marked as ME in history, also tagged as "ME(bot)" in ping lists)
[Server Summary]: ${chatSummary || 'none yet'}
[User Knowledge - ${senderName}]: ${facts.profile.join(' | ') || 'none yet'}
${facts.bondCtx}

[Recent Conversation — with ping and reply metadata]:
${history}

[Triggering Message]:
${senderName}: "${message.content}"
[Was bot directly @mentioned in this message?]: ${isMentioned ? 'YES' : 'NO'}

---
## STEP 1 — TARGETING ANALYSIS (do this first, silently)

Read the history carefully. Each message line includes rich metadata:
- [replying to X] — this message is a direct reply to person X
- [pinged: X] — this message explicitly @mentioned person X
- [ctx: prev=X next=Y] — who spoke immediately before and after this message

Use ALL of this to map who is talking to whom:
1. Who sent the triggering message?
2. Does it [ping] or [reply to] anyone? If so, who — is it ME(bot), or another user?
3. If no explicit ping/reply: look at [ctx] tags — is this part of an ongoing exchange between two specific users based on the surrounding messages?
4. Look back 3-5 messages: has this sender been consistently replying to or pinging a specific non-bot user? If yes, they are in a private thread — bot should SKIP.
5. Is there an ongoing 2-person thread that doesn't include the bot? If yes, bot should SKIP.
6. Is there any ambiguity about whether the triggering message could be directed at the bot? If yes, consider the last person the sender interacted with — was it the bot?

## STEP 2 — DECIDE

Output ONLY this JSON (no explanation, no markdown):
{
  "action": "REPLY" | "SKIP" | "WITHDRAW",
  "target_msg": "the exact message line from history you would reply to, or empty",
  "reason": "one line explanation",
  "predicted_audience": "bot" | "user:NAME" | "group" | "unknown",
  "targeting_analysis": "1-2 sentences: who is talking to who, and why you concluded that"
}

## DECISION RULES

REPLY when:
- bot is directly @mentioned with real content (not just a filler reaction like "lol", "fr", "ok", "yeah", "💀")
- someone replied to a bot message with actual engagement
- a question was asked open to the whole chat and bot has something good to add
- people are talking ABOUT the bot (mocking it, testing it, talking about something it said)
- a message has clear comedic or conversational opening that fits the bot's personality

SKIP when:
- [replying to X] or [pinged: X] where X is NOT the bot — it's for someone else, stay out
- two people are clearly in their own exchange with no room for bot
- triggering message is a short filler reaction (fr, lol, ok, yeah, same, bro, facts, cap, 💀, gng, "going to sleep", "gn") — UNLESS it directly mentions the bot
- bot already replied recently and nobody is actively engaging back
- jumping in would feel forced, desperate, or annoying

WITHDRAW when:
- someone says "stop", "shut up", "not you", "i'm not talking to you", "i didn't ask you/the bot", directed at the bot
- only WITHDRAW if it is clearly aimed at the bot, not just general frustration between users

## KEY EXAMPLE (from real logs)
History showed:
  manipulate: gng [going to sleep, no ping]
  ME: [bot replied with a quip]
  manipulate: time to sleep [still no ping, talking to herself/group]
  ME: [bot replied AGAIN — this was wrong, nobody was talking to the bot]
  REVOLUTION: notabot stop [told the bot to stop]

Correct behavior: After "gng" with no bot ping, SKIP. Don't keep replying into a void.`;


      try {
        const decisionResp = await aiClient.models.generateContent({
          model: MODEL_NAME,
          contents: [{ role: 'user', parts: [{ text: decisionPrompt }] }],
          config: { temperature: 0.5 },
        });

        const decisionRaw = (decisionResp.text || '').trim().replace(/```json|```/g, '').trim();
        let parsed: any = {};
        try { parsed = JSON.parse(decisionRaw); } catch {
          // fallback: check if raw text starts with SKIP
          const upper = decisionRaw.toUpperCase();
          parsed.action = upper.includes('REPLY') ? 'REPLY' : upper.includes('WITHDRAW') ? 'WITHDRAW' : 'SKIP';
        }

        const action = (parsed.action || 'SKIP').toUpperCase();
        console.log(`[Decision]: action=${action} | target="${parsed.target_msg?.slice(0, 60) || ''}" | audience=${parsed.predicted_audience || '?'} | reason=${parsed.reason || ''}`);
        if (parsed.targeting_analysis) {
          console.log(`[Targeting]: ${parsed.targeting_analysis}`);
        }

        // ── WITHDRAW — bot says what it feels like then goes quiet ──
        if (action === 'WITHDRAW') {
          console.log(`[Withdrawn] Entering withdrawn mode for 5 mins`);
          channelMutedUntil.set(`withdrawn:${message.channelId}`, now + 300000);
          botMood.set(message.guildId!, 'withdrawn');

          const withdrawPrompt = `${SYSTEM_PROMPT}

someone just told you to back off or said "not you" or excluded you from the convo.
say whatever feels right in that moment — maybe you're unbothered, maybe slightly salty, maybe just meh.
could be "aight" or "my bad" or "didn't ask me either" or just nothing dramatic.
1 sentence max. lowercase. no DATA block.

[Recent Chat]:
${history}
[Message that triggered this]:
${senderName}: "${message.content}"`;

          try {
            const resp = await aiClient.models.generateContent({
              model: MODEL_NAME,
              contents: [{ role: 'user', parts: [{ text: withdrawPrompt }] }],
              config: { temperature: 1.1 },
            });
            const text = (resp.text || 'aight').replace(/DATA:[\s\S]*$/i, '').trim();
            await (message.channel as any).send(text);
          } catch { await (message.channel as any).send('aight'); }
          return;
        }

        if (action !== 'REPLY') return;

        // ── REPLY ──
        let decisionTarget = parsed.target_msg || `${senderName}: "${message.content}"`;
        if (decisionTarget.trimStart().startsWith('ME:')) {
          decisionTarget = `${senderName}: "${message.content}"`;
        }

        // Duplicate reply guard
        const channelReplied = recentlyRepliedTargets.get(message.channelId) || new Set<string>();
        const targetKey = decisionTarget.slice(0, 80);
        if (channelReplied.has(targetKey)) {
          console.log(`[Skip] Already replied to this target recently: ${targetKey}`);
          return;
        }
        channelReplied.add(targetKey);
        if (channelReplied.size > 10) channelReplied.delete(channelReplied.values().next().value);
        recentlyRepliedTargets.set(message.channelId, channelReplied);

        if (isMentioned) {
          activity.activeUntil = now + 120000;
          activity.session = undefined;
        }

        await generateAndSend({ message, history, chatSummary, facts, isMentioned, aiClient, activity, decisionTarget, decisionReason: parsed.reason || 'engaged' });

      } catch (e) { console.error("Decision fail:", e); }

    }, windowTime);

    pendingTriggers.set(message.channelId, trigger);
  });

  await botClient.login(token);
}


// ─── EXPORTS ──────────────────────────────────────────────────────────────────

export function stopBot() {
  if (botClient) { botClient.destroy(); botClient = null; }
}

export function getBotStatus() {
  return botClient ? 'running' : 'stopped';
}
