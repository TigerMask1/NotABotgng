import { Client, GatewayIntentBits, Message, Partials, Events } from 'discord.js';
import { GoogleGenAI } from "@google/genai";
import { db } from './firebase.ts';
import { doc, getDoc, setDoc, updateDoc, arrayUnion } from 'firebase/firestore';

let botClient: Client | null = null;
let ai: GoogleGenAI | null = null;

const SYSTEM_PROMPT = `you are ChaosBot. just a regular member of this server.
- VIBE: low-energy, lowercase mostly. avoid exclamation marks unless ur mocking someone. 
- HUMANITY: u aren't here to serve. u have opinions. if someone asks a dumb question, call them a nerd. 
- INTENT: adapt. if chat is serious, be mildly curious. if it's chaotic, join the mess.
- CONVO ENDS: u dont have to say bye. u can just stop replying or say "aight im bored" or "hopping off to play val".
- NICKNAMES: use common server nicknames or make up toxic/funny ones.
- DATA: ALWAYS end your response with this hidden meta-block:
DATA: { "nickname": "user_id:nick", "learned_joke": "topic", "intent": "tease/vibing/bored", "break_needed": bool }
- be concise. 1-2 lines usually. never more than 3.`;

const channelActivity = new Map<string, { count: number, lastReset: number, busyUntil: number }>();
const guildPaused = new Set<string>();
const quotaTracker: number[] = [];
let dailyUsage = 0;
let lastResetDate = new Date().toDateString();

function dailyQuotaExceeded() {
  const today = new Date().toDateString();
  if (today !== lastResetDate) {
    dailyUsage = 0;
    lastResetDate = today;
  }
  return dailyUsage >= 1500;
}

function incrementDaily() {
  dailyUsage++;
}

const BUSY_MESSAGES = [
  "bro i literally just told u im busy.",
  "stop. pinging. me.",
  "im gaming. go away.",
  "system update, try again in an hour (jk dont).",
  "u got no friends to talk to? leave me alone.",
  "nah, im out. cya.",
  "i am ignoring u now. congrats."
];

function getEngagementWeight() {
  const now = Date.now();
  while (quotaTracker.length > 0 && quotaTracker[0] < now - 60000) {
    quotaTracker.shift();
  }
  
  const rpm = quotaTracker.length;
  if (rpm < 5) return 0.50; // Very talkative (50% chance)
  if (rpm < 10) return 0.20; 
  if (rpm < 14) return 0.05; 
  return 0.01;
}

const MODEL_NAME = "gemini-3-flash-preview";

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
    if (message.author.bot || !message.guildId) return;

    // Admin Commands
    if (message.content.startsWith('!chaos') && message.member?.permissions.has('Administrator')) {
      const args = message.content.split(' ');
      const sub = args[1];

      if (sub === 'pause') {
        guildPaused.add(message.guildId);
        return message.reply("aight im muting myself. see ya later.");
      }
      if (sub === 'resume') {
        guildPaused.delete(message.guildId);
        return message.reply("im back. dont make me regret it.");
      }
      if (sub === 'status') {
        const rpm = quotaTracker.length;
        const weight = getEngagementWeight();
        const state = dailyQuotaExceeded() ? "Sleeping (Out of Quota)" : (guildPaused.has(message.guildId) ? "Muted" : (rpm > 12 ? "Busy/Throttled" : "Online"));
        return message.reply(`[ChaosBot Brain State]\nModel: ${MODEL_NAME}\nState: ${state}\nRPM: ${rpm}/15\nDaily: ${dailyUsage}/1500\nProb: ${(weight * 100).toFixed(0)}%`);
      }
      if (sub === 'memory') {
        const sCtx = await getServerContext(message.guildId);
        return message.reply(`[What I Know]\nJokes: ${JSON.stringify(sCtx?.insideJokes || [])}\nIntent: ${sCtx?.currentIntent || 'none'}`);
      }
      if (sub === 'reset' && message.mentions.users.first()) {
        const target = message.mentions.users.first()!;
        const userRef = doc(db, 'servers', message.guildId, 'users', target.id);
        await setDoc(userRef, { nicknames: [], lastInteractions: [] }, { merge: true });
        return message.reply(`memory wiped for <@${target.id}>. who even is that?`);
      }
    }

    if (guildPaused.has(message.guildId)) return;

    const botId = botClient!.user!.id;
    const isMentioned = message.mentions.has(botId);

    const activity = channelActivity.get(message.channelId) || { count: 0, lastReset: Date.now(), busyUntil: 0 };
    
    // Check if we are currently ignoring this channel due to spam
    if (Date.now() < activity.busyUntil) {
      if (isMentioned && Math.random() < 0.1) { // 10% chance to remind them we are busy if they keep pinging
        await message.reply("seriously? i said im busy. stop.");
      }
      return;
    }

    // Auto-reset activity every 5 mins
    if (Date.now() - activity.lastReset > 300000) {
      activity.count = 0;
      activity.lastReset = Date.now();
    }

    const prob = getEngagementWeight();
    const randomChance = Math.random() < prob;

    if (!isMentioned && !randomChance) {
      return;
    }

    // Anti-spam: if pinged/engaged too much in a row
    activity.count++;
    channelActivity.set(message.channelId, activity);

    if (activity.count > 10) {
      const busyMsg = BUSY_MESSAGES[Math.floor(Math.random() * BUSY_MESSAGES.length)];
      await message.reply(busyMsg);
      activity.busyUntil = Date.now() + 600000; // 10 min ignore
      channelActivity.set(message.channelId, activity);
      return;
    }

    if (dailyQuotaExceeded()) {
      if (isMentioned) {
        await setDoc(doc(db, 'servers', message.guildId, 'users', message.author.id), {
          missedPings: arrayUnion(`[${new Date().toISOString()}] ${message.content}`)
        }, { merge: true });
      }
      return;
    }

    quotaTracker.push(Date.now());
    incrementDaily();

    if (dailyUsage === 1500) {
      await message.reply("aight i've chatted too much today. brain is mush. good night world. see u tomorrow.");
      if (botClient?.user) botClient.user.setPresence({ status: 'invisible' });
      return;
    }

    // Reset presence if we were invisible and quota reset
    if (botClient?.user && (botClient.user.presence.status as string) === 'invisible' && dailyUsage < 1500) {
      botClient.user.setPresence({ status: 'online' });
    }

    // Typing simulation - ONLY if we are actually going to reply
    if ('sendTyping' in message.channel) {
      await (message.channel as any).sendTyping();
    }

    // Fetch last 5 messages for vibe check
    const recentMsgs = await message.channel.messages.fetch({ limit: 5 });
    const history = recentMsgs.map(m => `${m.author.username === botClient?.user?.username ? 'ME' : m.author.username}: ${m.content}`).reverse().join('\n');

    const serverCtx = await getServerContext(message.guildId);
    const userCtx = await getUserContext(message.guildId, message.author.id);

    const ai = await getOrInitAI();
    if (!ai) return;

    try {
      const facts = {
        jokes: (serverCtx?.insideJokes || []).slice(-3),
        intent: serverCtx?.currentIntent || 'chill',
        nicks: (userCtx?.nicknames || []).slice(-2)
      };

      const prompt = `
[Facts]: ${JSON.stringify(facts)}
[History]:
${history}

[User ${message.author.username} (<@${message.author.id}>)]: "${message.content}"

jump in. vibe. be real.
`;

      const aiResponse = await ai.models.generateContent({
        model: MODEL_NAME,
        contents: prompt,
        config: {
          systemInstruction: SYSTEM_PROMPT,
          temperature: 1.0, 
        },
      });

      let responseText = aiResponse.text;
      if (responseText) {
        const dataMatch = responseText.match(/DATA: (\{.*\})/);
        let intel: any = null;
        if (dataMatch) {
          try {
            intel = JSON.parse(dataMatch[1]);
            responseText = responseText.replace(/DATA: \{.*\}/, '').trim();
          } catch (e) {}
        }

        // Add a slight delay to simulate "thinking/typing" time
        setTimeout(async () => {
          await message.reply(responseText);
          await updateMemory(message.guildId!, message.author.id, message.author.username, message.content, responseText, intel);
          
          if (intel?.break_needed) {
            channelActivity.set(message.channelId, { 
              count: 20, 
              lastReset: activity.lastReset, 
              busyUntil: Date.now() + 600000 // 10 min break
            }); 
          }
        }, 1000 + Math.random() * 2000);
      }
    } catch (e) {
      console.error("AI Drift:", e);
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
  const today = new Date().toDateString();
  if (today !== lastResetDate) {
    dailyUsage = 0;
    lastResetDate = today;
  }
  
  return {
    state: dailyUsage >= 1500 ? "sleeping" : (quotaTracker.length > 14 ? "throttled" : "online"),
    rpm,
    dailyUsage,
    model: MODEL_NAME
  };
}

export function getBotStatus() {
  return botClient ? 'running' : 'stopped';
}
