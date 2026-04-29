import { Client, GatewayIntentBits, Message, Partials, Events } from 'discord.js';
import { GoogleGenAI } from "@google/genai";
import { db } from './firebase.ts';
import { doc, getDoc, setDoc, updateDoc, arrayUnion } from 'firebase/firestore';

let botClient: Client | null = null;
let ai: GoogleGenAI | null = null;

const SYSTEM_PROMPT = `you are ChaosBot. a member of this server.
- TONE: low-energy, lowercase mostly, occasional typos. don't try hard.
- INTENT: read the room. if ppl are chill, be chill. if they're nerds, tease them.
- FLOW: don't just say 2 words and leave. if a convo is good, stay in it. but if it's the same 3 people pinging u for 10 minutes, get annoyed and leave.
- PINGS: if someone pings u too much, call them out. tell them to get a life. 
- BREAKS: u have a life. u "play games", "eat", and "sleep". exit naturally. "aight my pizza is here" or "im hopping on val, cya".
- DATA EXTRACTION: u must ALWAYS end with:
DATA: { "nickname": "target_id:nick", "intent": "vibe/troll/ignore", "break_needed": true/false }
- limit replies to 3 sentences max. keep it punchy.`;

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
  return dailyUsage >= 1200; // Boosted a bit for fun
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
  // Dynamic scaling based on RPM
  if (rpm < 3) return 0.40; // Very talkative when quiet
  if (rpm < 7) return 0.15; 
  if (rpm < 12) return 0.05; 
  return 0.01; // Barely reacts to keep from crashing
}

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
    if (intel?.joke) serverUpdate.insideJokes = arrayUnion(intel.joke);
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
        return message.reply(`[Status Report]\nRPM: ${rpm}/15\nDaily: ${dailyUsage}/1000\nProb: ${(weight * 100).toFixed(0)}%\nPaused: ${guildPaused.has(message.guildId)}`);
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

    if (dailyUsage === 1200) {
      await message.reply("aight i've chatted too much today. brain is mush. good night world.");
      if (botClient?.user) botClient.user.setPresence({ status: 'invisible' });
      return;
    }

    // Reset presence if we were invisible and quota reset
    if (botClient?.user && botClient.user.presence.status === 'invisible' && dailyUsage < 1200) {
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
        model: "gemini-3-flash-preview",
        contents: prompt,
        config: {
          systemInstruction: SYSTEM_PROMPT,
          temperature: 1.0, // Higher temp for more "human" chaos
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

export function getBotStatus() {
  return botClient ? 'running' : 'stopped';
}
