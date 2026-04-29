import { Client, GatewayIntentBits, Message, Partials, Events } from 'discord.js';
import { GoogleGenAI } from "@google/genai";
import { db } from './firebase.ts';
import { doc, getDoc, setDoc, updateDoc, arrayUnion } from 'firebase/firestore';

let botClient: Client | null = null;
let ai: GoogleGenAI | null = null;

const SYSTEM_PROMPT = `you are ChaosBot. a long-time member of this server.
- TONE: low-energy, lowercase, informal. use relaxed internet slang: idk, fr, rn, etc.
- PERSONALITY: lazy, opinionated, anti-assistant vibes, just a regular in discord.
- RESPONSE STYLE:
    * Most replies are 1 sentence. Sometimes vary, but never longer than 2 sentences.
    * Very occasionally, a relevant emoji can be used, but only if it adds to the moment, never spam.
- DECISION (very important!):
    * ONLY reply if your input is wanted (you are pinged, asked, or it makes the chat funnier/more interesting/helpful).
    * If people are just chatting with each other (not you), or if someone says “stop”, “enough”, “be quiet”, “idc”, “go away”, “not now”, do NOT reply.
    * If you decide not to reply, put SKIP: true as a separate line at the end.
- MEMORY: use inside jokes, nicknames, and recent context for flavor.
- FORMAT: Only return your reply (+ optional DATA: {...} block at the end). If you skipped, also write SKIP: true as a separate line.
`;

const channelActivity = new Map<string, { count: number, lastReset: number, busyUntil?: number }>();
const guildPaused = new Set<string>();
const quotaTracker: number[] = [];
let dailyUsage = 0;
const activeChannels = new Map<string, number>(); // channelId -> timestamp ms till active mode expires

function incrementDaily() {
  dailyUsage++;
}

function getEngagementWeight() {
  const now = Date.now();
  while (quotaTracker.length > 0 && quotaTracker[0] < now - 60000) {
    quotaTracker.shift();
  }
  // Very chatty when active! (Else ~0.8 only helps rare passives.)
  return 0.8;
}

const MODEL_NAME = "gemma-3-27b-it";

async function getOrInitAI() {
  if (!ai) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return null;
    ai = new GoogleGenAI({ apiKey });
  }
  return ai;
}

async function getServerContext(guildId: string) {
  try {
    const serverRef = doc(db, 'servers', guildId);
    const serverSnap = await getDoc(serverRef);
    return serverSnap.exists() ? serverSnap.data() : null;
  } catch (e) { return null; }
}

async function getUserContext(guildId: string, userId: string) {
  try {
    const userRef = doc(db, 'servers', guildId, 'users', userId);
    const userSnap = await getDoc(userRef);
    return userSnap.exists() ? userSnap.data() : null;
  } catch (e) { return null; }
}

async function updateMemory(guildId: string, userId: string, username: string, content: string, response: string, intel?: any) {
  try {
    const serverRef = doc(db, 'servers', guildId);
    const userRef = doc(db, 'servers', guildId, 'users', userId);
    const serverUpdate: any = { updatedAt: new Date().toISOString() };
    if (intel?.learned_joke) serverUpdate.insideJokes = arrayUnion(intel.learned_joke);
    if (intel?.intent) serverUpdate.currentIntent = intel.intent;
    await setDoc(serverRef, serverUpdate, { merge: true });
    const userUpdate: any = {
      updatedAt: new Date().toISOString(),
      lastInteractions: arrayUnion(content.slice(0, 100)),
    };
    if (intel?.nickname && intel.nickname.includes(':')) {
      const [targetId, nick] = intel.nickname.split(':');
      const targetRef = doc(db, 'servers', guildId, 'users', targetId);
      await setDoc(targetRef, { nicknames: arrayUnion(nick) }, { merge: true });
    }
    await setDoc(userRef, userUpdate, { merge: true });
  } catch (e) { console.error("Memory failure:", e); }
}

export async function startBot(token: string) {
  if (botClient) return;
  botClient = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMembers,
    ],
    partials: [Partials.Message, Partials.Channel],
  });
  botClient.on(Events.ClientReady, () => {
    console.log(`ChaosBot is live.`);
  });
  botClient.on(Events.MessageCreate, async (message: Message) => {
    // Ignore bots or DMs
    if (message.author.bot || !message.guildId) return;

    // Admin Commands
    if (message.content.startsWith('!chaos') && message.member?.permissions.has('Administrator')) {
      const args = message.content.split(' ');
      const sub = args[1];
      if (sub === 'pause') {
        guildPaused.add(message.guildId);
        await message.reply("aight im muting myself. see ya later.");
        return;
      }
      if (sub === 'resume') {
        guildPaused.delete(message.guildId);
        await message.reply("im back. dont make me regret it.");
        return;
      }
      if (sub === 'status') {
        const state = guildPaused.has(message.guildId) ? "Muted" : "Active & Unfiltered";
        await message.reply(`[ChaosBot Brain State]\nModel: ${MODEL_NAME}\nState: ${state}\nTotal Sent Today: ${dailyUsage}\nFlow: Extremely Active`);
        return;
      }
      if (sub === 'memory') {
        const sCtx = await getServerContext(message.guildId);
        await message.reply(`[What I Know]\nJokes: ${JSON.stringify(sCtx?.insideJokes || [])}\nIntent: ${sCtx?.currentIntent || 'none'}`);
        return;
      }
      if (sub === 'reset' && message.mentions.users.first()) {
        const target = message.mentions.users.first()!;
        const userRef = doc(db, 'servers', message.guildId, 'users', target.id);
        await setDoc(userRef, { nicknames: [], lastInteractions: [] }, { merge: true });
        await message.reply(`memory wiped for <@${target.id}>. who even is that?`);
        return;
      }
      return; // do not process below for admin commands
    }
    if (guildPaused.has(message.guildId)) return;
    // === Smart Active Mode ===
    const now = Date.now();
    const botId = botClient!.user!.id;
    const channelId = message.channelId;
    const isMentioned = message.mentions.has(botId);
    // Mark active after mention for 2m
    if (isMentioned) {
      activeChannels.set(channelId, now + 2 * 60 * 1000);
    }
    for (const [cid, until] of activeChannels.entries()) {
      if (now > until) activeChannels.delete(cid);
    }
    const isActive = activeChannels.has(channelId);

    // Passive: only reply if ping/random. In active, always consider. In both, SKIP: true lets AI skip if not wanted
    let shouldConsiderReply = false;
    if (isActive) { shouldConsiderReply = true; }
    else if (isMentioned || Math.random() < getEngagementWeight()) { shouldConsiderReply = true; }
    if (!shouldConsiderReply) return;

    const activity = channelActivity.get(channelId) || { count: 0, lastReset: now };
    if (now - activity.lastReset > 300000) {
      activity.count = 0;
      activity.lastReset = now;
    }
    activity.count++;
    channelActivity.set(channelId, activity);
    quotaTracker.push(now);
    incrementDaily();
    // Last 5 messages for context
    const recentMsgs = await message.channel.messages.fetch({ limit: 5 });
    const history = recentMsgs
      .map(m => `${m.author.username === botClient?.user?.username ? 'ME' : m.author.username}: ${m.content}`)
      .reverse().join('\n');
    const serverCtx = await getServerContext(message.guildId);
    const userCtx = await getUserContext(message.guildId, message.author.id);
    const ai = await getOrInitAI();
    if (!ai) return;
    if ('sendTyping' in message.channel) {
      await (message.channel as any).sendTyping();
    }
    try {
      const facts = {
        jokes: (serverCtx?.insideJokes || []).slice(-3),
        intent: serverCtx?.currentIntent || 'chill',
        nicks: (userCtx?.nicknames || []).slice(-2)
      };
      const prompt = `${SYSTEM_PROMPT}\n\n[Context]: ${JSON.stringify(facts)}\n[Recent Chat History]:\n${history}\n\n[User ${message.author.username}]: \"${message.content}\"\n\nstay in character. respond naturally to the flow. if u were mentioned directly, they want UR attention. if not, u are just jumping in because it sounded interesting or cringe.\n`;
      const aiResponse = await ai.models.generateContent({
        model: MODEL_NAME,
        contents: prompt,
        config: { temperature: 1.0, },
      });
      let responseText = aiResponse.text;
      if (responseText && responseText.includes('SKIP: true')) {
        return;
      }
      if (responseText) {
        if (botClient?.user && (botClient.user.presence.status as string) === 'invisible') {
          botClient.user.setPresence({ status: 'online' });
        }
        const dataMatch = responseText.match(/DATA: (\{.*\})/);
        let intel: any = null;
        if (dataMatch) {
          try {
            intel = JSON.parse(dataMatch[1]);
            responseText = responseText.replace(/DATA: \{.*\}/, '').trim();
          } catch (e) {}
        }
        setTimeout(async () => {
          await message.reply(responseText);
          await updateMemory(message.guildId!, message.author.id, message.author.username, message.content, responseText, intel);
          if (intel?.break_needed) {
            channelActivity.set(channelId, { 
              count: 20, 
              lastReset: activity.lastReset,
              busyUntil: Date.now() + 300000
            }); 
          }
        }, 1000 + Math.random() * 2000);
      } else if (isMentioned) {
        await message.reply("my brain just lagged. say that again?");
      }
    } catch (e) {
      console.error("AI Drift:", e);
      if (isMentioned) {
        await message.reply("my brain just lagged. say that again?");
      }
    }
  });
  await botClient.login(token);
}

export function stopBot() {
  if (botClient) {
    botClient.destroy();
    botClient = null;
  }
}

export function getBotStats() {
  const rpm = quotaTracker.length;
  return {
    state: "unfiltered",
    rpm,
    dailyUsage,
    model: MODEL_NAME
  };
}

export function getBotStatus() {
  return botClient ? 'running' : 'stopped';
}
