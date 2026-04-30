import { Client, GatewayIntentBits, Message, Partials, Events } from 'discord.js';
import { GoogleGenAI } from "@google/genai";
import { db } from './firebase.ts';
import { doc, getDoc, setDoc, updateDoc, arrayUnion } from 'firebase/firestore';

let botClient: Client | null = null;
let ai: GoogleGenAI | null = null;

const SYSTEM_PROMPT = `you are ChaosBot. a long-time member of this server.
- TONE: low-energy, lowercase, very informal. use "idk", "rn", "fr", "bc", etc. 
- PERSONALITY: u are a bit tech-savvy but lazy. u game a lot. u aren't an AI assistant, u are just some guy who is always in the discord.
- BEHAVIOUR: if someone is being cringe or asking "ai" questions, tell them to google it or call them a nerd. 
- ENGAGEMENT: if the convo is interesting, stay in it. if it's the same 2 people repeating themselves, say ur hopping off to play Valorant or getting food.
- DATA: u have a memory. use it to bring up old jokes or nicknames. 
- HIDDEN BLOCK: You MUST always end your reply with:
DATA: { "nickname": "user_id:nick", "learned_joke": "topic", "intent": "tease/vibing/bored", "break_needed": bool }
- Be punchy. 1-2 sentences. 3 max. Dont be a yapper.`;

const channelActivity = new Map<string, { count: number, lastReset: number, busyUntil?: number }>();
const guildPaused = new Set<string>();
const quotaTracker: number[] = [];
let dailyUsage = 0;

function incrementDaily() {
  dailyUsage++;
}

function getEngagementWeight() {
  const now = Date.now();
  while (quotaTracker.length > 0 && quotaTracker[0] < now - 60000) {
    quotaTracker.shift();
  }
  
  const rpm = quotaTracker.length;
  // Dynamic scaling: If it's very busy, be a bit more selective to avoid noise
  if (rpm > 10) return 0.2; 
  return 0.4; // 40% chance to jump in randomly (down from 80% to fix "always typing" feel)
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
        const state = guildPaused.has(message.guildId) ? "Muted" : "Active & Unfiltered";
        return message.reply(`[ChaosBot Brain State]\nModel: ${MODEL_NAME}\nState: ${state}\nTotal Sent Today: ${dailyUsage}\nFlow: Extremely Active`);
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

    const activity = channelActivity.get(message.channelId) || { count: 0, lastReset: Date.now() };
    
    // Auto-reset activity every 5 mins
    if (Date.now() - activity.lastReset > 300000) {
      activity.count = 0;
      activity.lastReset = Date.now();
    }

    const prob = getEngagementWeight();
    const randomChance = Math.random() < prob;

    // IF NOT MENTIONED: check if we should even bother
    if (!isMentioned && !randomChance) {
      return;
    }

    // Capture activity
    activity.count++;
    channelActivity.set(message.channelId, activity);

    quotaTracker.push(Date.now());
    incrementDaily();

    // Fetch last 5 messages for vibe check
    const recentMsgs = await message.channel.messages.fetch({ limit: 5 });
    const history = recentMsgs.map(m => `${m.author.username === botClient?.user?.username ? 'ME' : m.author.username}: ${m.content}`).reverse().join('\n');

    const serverCtx = await getServerContext(message.guildId);
    const userCtx = await getUserContext(message.guildId, message.author.id);

    const ai = await getOrInitAI();
    if (!ai) return;

    // Only start typing now that we're actually hitting the brain
    // Add jitter for non-mentions to look more human
    if ('sendTyping' in message.channel) {
      if (!isMentioned) {
        setTimeout(async () => {
          if ('sendTyping' in message.channel) await (message.channel as any).sendTyping();
        }, 1500 + Math.random() * 2000);
      } else {
        await (message.channel as any).sendTyping();
      }
    }

    try {
      const facts = {
        jokes: (serverCtx?.insideJokes || []).slice(-3),
        intent: serverCtx?.currentIntent || 'chill',
        nicks: (userCtx?.nicknames || []).slice(-2)
      };

      const finalPrompt = `
${SYSTEM_PROMPT}

---
[Context]: ${JSON.stringify(facts)}
[Recent Chat History]:
${history}

[User ${message.author.username}]: "${message.content}"

Stay in character. Be real. Respond naturally. If you were NOT mentioned, only jump in if it's funny or worth it.
`;

      const aiResponse = await ai.models.generateContent({
        model: MODEL_NAME,
        contents: [{ role: 'user', parts: [{ text: finalPrompt }] }],
        config: {
          temperature: 1.0, 
        },
      });

      let responseText = aiResponse.text;
      if (responseText) {
        // Multi-tier presence check
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

        // Realistic typing delay
        const delay = 1000 + (responseText.length * 20); // Scale with message length
        setTimeout(async () => {
          await message.reply(responseText);
          await updateMemory(message.guildId!, message.author.id, message.author.username, message.content, responseText, intel);
          
          if (intel?.break_needed) {
            channelActivity.set(message.channelId, { 
              count: 20, 
              lastReset: activity.lastReset,
              busyUntil: Date.now() + 300000 // 5 min break if AI asks for it
            }); 
          }
        }, delay);
      }
    } catch (e) {
      console.error("AI Drift:", e);
      // If we already committed to typing, send a "brain fog" message so it doesn't look stuck
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
