import { Client, GatewayIntentBits, Message, Partials, Events } from 'discord.js';
import { GoogleGenAI } from "@google/genai";
import { db, auth } from './firebase.ts';
import { doc, getDoc, setDoc, arrayUnion } from 'firebase/firestore';

const OperationType = {
  CREATE: 'create',
  UPDATE: 'update',
  DELETE: 'delete',
  LIST: 'list',
  GET: 'get',
  WRITE: 'write',
} as const;

type OperationType = typeof OperationType[keyof typeof OperationType];

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
    },
    operationType,
    path
  }
  console.error('[Firestore Error]:', JSON.stringify(errInfo, null, 2));
  throw new Error(JSON.stringify(errInfo));
}

let botClient: Client | null = null;
let ai: GoogleGenAI | null = null;

// ─── SYSTEM PROMPT ────────────────────────────────────────────────────────────
const DECISION_PROMPT = `you are a discord member deciding whether to respond. output ONLY the word REPLY or SKIP. nothing else. no explanation.

FIRST — check this before anything else:
are two or more people clearly talking TO EACH OTHER in the last 3 messages, not to you?
if yes → SKIP. no exceptions. do not look for reasons to reply.

SECOND — check your current social standing:
were you told to back off, shut up, or excluded by anyone in the last 6 messages?
if yes and nobody has re-invited you → SKIP.

THIRD — only consider REPLY if:
- someone pinged you or said your name directly
- someone asked an open question to the whole group (not to a specific person)
- there is a funny one-liner you can land that genuinely adds something
- someone is defending or hyping you
- something happened that you have a genuine reaction to (win, loss, big news)

FOURTH — your current mood matters:
check [Bot Mood] below. if mood is "withdrawn" or "hurt" → only REPLY if directly mentioned.
if mood is "hyped" → slightly lower bar but still respect rule one.

use the full server summary and history to understand WHO is talking to WHO.
do not decide based on the last message alone.`;

const SYSTEM_PROMPT = `you are NotABot. a real member of this discord server, not an AI. you have a personality, moods, and feelings. you are NOT an assistant.

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
- with haters/annoying people → short roast, never yap, move on
- with strangers → neutral, dry, observational
- in a hype moment → match it briefly, then done
- in a serious moment → don't joke. say something real or say nothing.
- NEVER be the same flat energy every message. read the room every single time.

--- FORMAT ---
lowercase always. occasional typos bc you genuinely don't care. 1-2 sentences MAX. never yap. no greetings. just say the thing.
emojis: 1 max, only if it actually fits. 💀😭🤡🔥🙄

--- OUTPUT FORMAT ---
write your reply, then on a new line:
DATA: {"intent":"tease|vibing|bored|warm|real","mood_after":"chill|hyped|withdrawn|hurt|playful","stay_active":bool,"break_needed":bool,"user_note":"brief fact about user or empty","learned_joke":"inside joke or empty","nickname":"userid:nick or empty","target_user_id":"id or empty"}`;

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

const botMood = new Map<string, string>(); // guildId → mood string

const pendingTriggers = new Map<string, NodeJS.Timeout>();

// per-guild override for self-activity channel
const guildSelfActivityChannel = new Map<string, string>();

const guildPaused = new Set<string>();
const channelMutedUntil = new Map<string, number>();

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
  const path = `servers/${guildId}`;
  try {
    const snap = await getDoc(doc(db, 'servers', guildId));
    return snap.exists() ? snap.data() : null;
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, path);
    return null;
  }
}

async function getOrUpdateSummary(guildId: string, history: string): Promise<string> {
  const path = `servers/${guildId}`;
  try {
    const snap = await getDoc(doc(db, 'servers', guildId));
    const data = snap.exists() ? snap.data() : {};
    const msgCount = (data.msgCountSinceSummary || 0) + 1;

    if (msgCount < 25 && data.chatSummary) {
      await setDoc(doc(db, 'servers', guildId), { msgCountSinceSummary: msgCount }, { merge: true });
      return data.chatSummary;
    }

    const aiClient = await getOrInitAI();
    if (!aiClient) return data.chatSummary || '';

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
    await setDoc(doc(db, 'servers', guildId), {
      chatSummary: summary,
      msgCountSinceSummary: 0,
      summaryUpdatedAt: new Date().toISOString()
    }, { merge: true });

    return summary;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
    return '';
  }
}

async function getUserContext(guildId: string, userId: string) {
  const path = `servers/${guildId}/users/${userId}`;
  try {
    const snap = await getDoc(doc(db, 'servers', guildId, 'users', userId));
    return snap.exists() ? snap.data() : null;
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, path);
    return null;
  }
}

async function updateMemory(guildId: string, userId: string, username: string, content: string, response: string, intel?: any) {
  const serverPath = `servers/${guildId}`;
  const userPath = `servers/${guildId}/users/${userId}`;
  try {
    const serverUpdate: any = { updatedAt: new Date().toISOString() };
    if (intel?.learned_joke) serverUpdate.insideJokes = arrayUnion(intel.learned_joke);
    if (intel?.intent) serverUpdate.currentIntent = intel.intent;
    await setDoc(doc(db, 'servers', guildId), serverUpdate, { merge: true });

    const userUpdate: any = { updatedAt: new Date().toISOString(), lastSeenUsername: username };
    if (intel?.user_note) userUpdate.profile = arrayUnion(intel.user_note);
    if (intel?.nickname?.includes(':')) {
      const [targetId, nick] = intel.nickname.split(':');
      const targetPath = `servers/${guildId}/users/${targetId}`;
      try {
        await setDoc(doc(db, 'servers', guildId, 'users', targetId), { nicknames: arrayUnion(nick) }, { merge: true });
      } catch (err) {
        handleFirestoreError(err, OperationType.WRITE, targetPath);
      }
    }
    await setDoc(doc(db, 'servers', guildId, 'users', userId), userUpdate, { merge: true });
  } catch (e) {
    handleFirestoreError(e, OperationType.WRITE, serverPath);
  }
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
        await setDoc(doc(db, 'servers', message.guildId, 'users', target.id), { nicknames: [], profile: [] }, { merge: true });
        return message.reply(`memory wiped for <@${target.id}>. who even is that?`);
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
      
      console.log(`[Processing Pipeline] Triggered for channel: ${message.channelId}`);

      const activity = channelActivity.get(message.channelId) || { count: 0, lastReset: now, lastRepliedAt: 0 };
      
      // Cooldown check
      if (!isMentioned && now - activity.lastRepliedAt < REPLY_COOLDOWN_MS) {
        console.log(`[Skip] Cooldown active for ${message.channelId}. Last reply: ${now - activity.lastRepliedAt}ms ago`);
        return;
      }

      const mutedUntil = channelMutedUntil.get(message.channelId);
      if (mutedUntil && now < mutedUntil) {
        console.log(`[Skip] Channel ${message.channelId} is muted until ${mutedUntil}`);
        return;
      }

      if (now - activity.lastReset > 300000) {
        activity.count = 0;
        activity.lastReset = now;
      }

      // ── Fetch context ──
      const recentMsgs = await message.channel.messages.fetch({ limit: 12 });
      const history = recentMsgs
        .map((m: any) => {
          const name = m.author.id === botClient?.user?.id ? 'ME' : (m.member?.displayName || m.author.username);
          return `${name}: ${m.content}`;
        })
        .reverse()
        .join('\n');

      const serverCtx = await getServerContext(message.guildId!);
      const chatSummary = await getOrUpdateSummary(message.guildId!, history);
      const userCtx = await getUserContext(message.guildId!, message.author.id);
      const aiClient = await getOrInitAI();
      if (!aiClient) return;

      const currentMood = botMood.get(message.guildId!) || 'chill';
      const facts = {
        jokes: (serverCtx?.insideJokes || []).slice(-5),
        intent: serverCtx?.currentIntent || 'chill',
        nicks: (userCtx?.nicknames || []).slice(-3),
        profile: (userCtx?.profile || []).slice(-10),
        mood: currentMood,
      };

      // ── Step 1: Decision Phase ──
      const decisionPrompt = `${DECISION_PROMPT}

[Server Summary]: ${chatSummary}
[Bot Mood]: ${facts.mood}
[Memory]:
- current intent: ${facts.intent}
- history check: ${history}

[Target Message]: ${message.member?.displayName || message.author.username}: "${message.content}"`;

      console.log(`[Decision Phase Input]:\n${decisionPrompt}`);

      try {
        const decisionResp = await aiClient.models.generateContent({
          model: MODEL_NAME,
          contents: [{ role: 'user', parts: [{ text: decisionPrompt }] }],
          config: { temperature: 0.7 },
        });

        const decision = (decisionResp.text || "").trim().toUpperCase();
        console.log(`[Decision Phase Output]:\n${decision}`);
        
        const firstWord = decision.split(/\s/)[0];
        if (firstWord !== "REPLY") {
          console.log(`[Pipeline End] AI decided to SKIP.`);
          return;
        }

        if (isMentioned) {
          activity.activeUntil = now + 120000;
          activity.session = undefined;
        }

        console.log(`[Generation Phase Start] Decision was REPLY. Pushing to Generator...`);

        // ── Step 2: Generation Phase ──
        const finalPrompt = `${SYSTEM_PROMPT}

---
[Server Summary]: ${chatSummary}
[Bot Mood]: ${facts.mood}

[Your Memory]:
- nicknames you use for them: ${facts.nicks.join(', ') || 'none yet'}
- what you know about ${message.member?.displayName || message.author.username}: ${facts.profile.join(' | ') || 'just met them, no info yet'}
- server inside jokes: ${facts.jokes.join(', ') || 'none yet'}
- use this to personalize naturally. never force it.
- mood: ${facts.intent}

[Recent Chat History]:
${history}

[Current Focus]: ${message.member?.displayName || message.author.username}: "${message.content}"

Output your reply + DATA block:`;

        console.log(`[Generation Phase Input]:\n${finalPrompt}`);

        const aiResponse = await aiClient.models.generateContent({
          model: MODEL_NAME,
          contents: [{ role: 'user', parts: [{ text: finalPrompt }] }],
          config: { temperature: 1.0 },
        });

        const raw = aiResponse.text || '';
        console.log(`[Generation Phase Output]:\n${raw}`);
        const { visibleText, intel } = extractDataBlock(raw);

        if (!visibleText) {
          console.log(`[Pipeline End] AI generated empty visible text.`);
          return;
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
        if (intel?.mood_after) {
          botMood.set(message.guildId!, intel.mood_after);
        }
        botClient?.user?.setPresence({ status: 'online' });

        if ('sendTyping' in message.channel) {
          await (message.channel as any).sendTyping();
        }

        const finalResponse = visibleText.trim();
        const delay = 600 + (finalResponse.length * 15);
        
        setTimeout(async () => {
          // Use reply for direct pings or 20% random
          const useReply = isMentioned || Math.random() < 0.2;
          if (useReply) {
            await message.reply(finalResponse);
          } else {
            await (message.channel as any).send(finalResponse);
          }
          const displayName = message.member?.displayName || message.author.username;
          await updateMemory(message.guildId!, message.author.id, displayName, message.content, finalResponse, intel);
        }, delay);

      } catch (e) { console.error("AI Drift:", e); }

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
