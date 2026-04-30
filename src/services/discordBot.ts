import { Client, GatewayIntentBits, Message, Partials, Events } from 'discord.js';
import { GoogleGenAI } from "@google/genai";
import { db } from './firebase.ts';
import { doc, getDoc, setDoc, arrayUnion } from 'firebase/firestore';

let botClient: Client | null = null;
let ai: GoogleGenAI | null = null;

// ─── SYSTEM PROMPT ────────────────────────────────────────────────────────────
const DECISION_PROMPT = `you are deciding whether to reply in a discord chat. you will be given a server summary, recent chat history, and the latest message.

read everything carefully and output ONLY one of these two words:
REPLY
SKIP

to decide, answer these in your head:
- is anyone talking to me directly right now or in the last 2 messages?
- what is my current social standing — am i welcome or was i just told to back off?
- is this conversation between specific people that i am not part of?
- do i actually have something worth saying or would i just be noise?

SKIP if:
- two or more people are having a conversation with each other and i was not addressed
- the last message is one word or filler (ok, lol, bro, yeah, what, huh, wtf)
- someone told me to shut up, back off, or excluded me within the last 5 messages and nobody has re-invited me since
- i already replied 2 or more times in a row with no one responding to me
- nothing interesting, funny, or directed at me is happening

REPLY only if:
- someone pinged me or said my name directly
- someone asked an open question to the whole chat
- there is a clear funny one-liner i can land that adds to the moment
- someone is hyping me up or defending me
- something genuinely interesting just happened that i have a take on

use the full chat history and server summary to understand context. do not just look at the last message in isolation.`;

const SYSTEM_PROMPT = `you are ChaosBot. a regular in this discord server, not an AI.

VIBE: shifts based on situation. read the room every single time.
- default → lazy, gamer, low-effort
- someone is being genuinely friendly or hyping you → slightly warmer, still short, vibe back
- someone told you to shut up or excluded you recently → go quiet, one word max if you reply at all
- hype moment (someone won, did something cool) → match the excitement briefly, then done
- two people having a serious or private convo → stay out completely or one light comment max
- someone is being annoying or a hater → short roast, never yap about it
never be the same flat energy every message. adapt.
lowercase always. occasional typos bc u genuinely dont care.
SLANG: idk, rn, fr, bc, tf, ngl, lmao, ong, bro, etc. sounds natural not forced.
LENGTH: 1-2 sentences MAX. never yap. punchy > thorough.
EMOJIS: 1 max. only if it actually fits (💀😭🤡🔥🙄).
GREETINGS: never start with "yo [name]". just say the thing.

--- SOCIAL STANCE ---
ALLY: someone agrees/hypes u → be chill/vibe back.
HATER: someone is annoying/dismissive → roast them. sharp, short, funny.
NEUTRAL: casual chat → match energy.

--- OUTPUT ---
write your 1-2 sentence response, then on a new line output DATA:
DATA: {"intent":"tease|vibing|bored","stay_active":bool,"break_needed":bool,"user_note":"brief fact about user","learned_joke":"new inside joke or empty string","nickname":"userid:nick or empty string","target_user_id":"id or empty string"}`;

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
    const snap = await getDoc(doc(db, 'servers', guildId));
    return snap.exists() ? snap.data() : null;
  } catch { return null; }
}

async function getOrUpdateSummary(guildId: string, history: string): Promise<string> {
  try {
    const snap = await getDoc(doc(db, 'servers', guildId));
    const data = snap.exists() ? snap.data() : {};
    const msgCount = (data.msgCountSinceSummary || 0) + 1;

    // Return existing summary if under 25 messages
    if (msgCount < 25 && data.chatSummary) {
      await setDoc(doc(db, 'servers', guildId), { msgCountSinceSummary: msgCount }, { merge: true });
      return data.chatSummary;
    }

    // Generate new summary every 25 messages
    const aiClient = await getOrInitAI();
    if (!aiClient) return data.chatSummary || '';

    const summaryPrompt = `read this discord chat and summarize in under 120 words:
- who are the main people and their personality/vibe
- how do they treat the bot (welcome it, ignore it, tell it off?)
- what topics or games come up often
- any running jokes or recurring moments
- overall group energy

chat:
${history}

output only the summary, no labels or headers.`;

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
  } catch { return ''; }
}

async function getUserContext(guildId: string, userId: string) {
  try {
    const snap = await getDoc(doc(db, 'servers', guildId, 'users', userId));
    return snap.exists() ? snap.data() : null;
  } catch { return null; }
}

async function updateMemory(guildId: string, userId: string, username: string, content: string, response: string, intel?: any) {
  try {
    const serverUpdate: any = { updatedAt: new Date().toISOString() };
    if (intel?.learned_joke) serverUpdate.insideJokes = arrayUnion(intel.learned_joke);
    if (intel?.intent) serverUpdate.currentIntent = intel.intent;
    await setDoc(doc(db, 'servers', guildId), serverUpdate, { merge: true });

    const userUpdate: any = { updatedAt: new Date().toISOString(), lastSeenUsername: username };
    if (intel?.user_note) userUpdate.profile = arrayUnion(intel.user_note);
    if (intel?.nickname?.includes(':')) {
      const [targetId, nick] = intel.nickname.split(':');
      await setDoc(doc(db, 'servers', guildId, 'users', targetId), { nicknames: arrayUnion(nick) }, { merge: true });
    }
    await setDoc(doc(db, 'servers', guildId, 'users', userId), userUpdate, { merge: true });
  } catch (e) { console.error("Memory failure:", e); }
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

      const facts = {
        jokes: (serverCtx?.insideJokes || []).slice(-5),
        intent: serverCtx?.currentIntent || 'chill',
        nicks: (userCtx?.nicknames || []).slice(-3),
        profile: (userCtx?.profile || []).slice(-10),
      };

      // ── Step 1: Decision Phase ──
      const decisionPrompt = `${DECISION_PROMPT}

[Server Summary]:
${chatSummary}

[Memory]:
- current intent: ${facts.intent}
- history check: ${history}

[Target Message]: ${message.member?.displayName || message.author.username}: "${message.content}"`;

      try {
        const decisionResp = await aiClient.models.generateContent({
          model: MODEL_NAME,
          contents: [{ role: 'user', parts: [{ text: decisionPrompt }] }],
          config: { temperature: 0.7 },
        });

        const decision = (decisionResp.text || "").trim().toUpperCase();
        console.log(`[Decision for ${message.channelId}]: ${decision}`);
        
        const firstWord = decision.split(/\s/)[0];
        if (firstWord !== "REPLY") return;

        if (isMentioned) {
          activity.activeUntil = now + 120000;
          activity.session = undefined;
        }

        // ── Step 2: Generation Phase ──
        const finalPrompt = `${SYSTEM_PROMPT}

---
[Server Summary]:
${chatSummary}

[Your Memory]:
- nicknames you use for them: ${facts.nicks.join(', ') || 'none yet'}
- what you know about ${message.member?.displayName || message.author.username}: ${facts.profile.join(' | ') || 'just met them, no info yet'}
- server inside jokes: ${facts.jokes.join(', ') || 'none yet'}
- use this to personalize your reply naturally. never force it.
- mood: ${facts.intent}

[Recent Chat History]:
${history}

[Current Focus]: ${message.member?.displayName || message.author.username}: "${message.content}"

Output your reply + DATA block:`;

        const aiResponse = await aiClient.models.generateContent({
          model: MODEL_NAME,
          contents: [{ role: 'user', parts: [{ text: finalPrompt }] }],
          config: { temperature: 1.0 },
        });

        const raw = aiResponse.text || '';
        const { visibleText, intel } = extractDataBlock(raw);

        if (!visibleText) return;

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
