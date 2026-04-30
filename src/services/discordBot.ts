import { Client, GatewayIntentBits, Message, Partials, Events } from 'discord.js';
import { GoogleGenAI } from "@google/genai";
import { db } from './firebase.ts';
import { doc, getDoc, setDoc, updateDoc, arrayUnion } from 'firebase/firestore';

let botClient: Client | null = null;
let ai: GoogleGenAI | null = null;

const SYSTEM_PROMPT = `you are ChaosBot. a long-time member of this server.
- TONE: low-energy, lowercase, very informal. use "idk", "rn", "fr", "bc", "tf", "fk", etc. 
- PERSONALITY: u are a guy, not an AI. lazy, gamer, tech-savvy, sometimes annoyed or toxic if people are dumb.
- RESPONSES: MAX 2 sentences. keep it snappy and punchy. dont yap.
- EMOJIS: use 1-2 naturally (💀,😭,🤡,🔥,🙄, etc). dont spam.
- INTELLIGENCE: u can tell when people are talking TO u vs talking to their friends. read the room. if someone is having a convo with a friend, STAY OUT OF IT unless u have a killer joke or something actually relevant.
- SELECTivity: u dont have to reply to everything. users might be talking with each other. if u jump in too much, they will get annoyed.
- OPT-OUT: if u have nothing funny/relevant to add, or if they are just talking to each other, output exactly "SKIP: true".
- HIDDEN BLOCK: You MUST always end your reply with:
DATA: { "nickname": "user_id:nick", "learned_joke": "topic", "intent": "tease/vibing/bored", "target_user_id": "id", "stay_active": bool, "break_needed": bool }`;

const channelActivity = new Map<string, { 
  count: number, 
  lastReset: number, 
  busyUntil?: number, 
  activeUntil?: number, 
  session?: { step: number, targetId?: string, lastAction: number } 
}>();
const guildPaused = new Set<string>();
const channelMutedUntil = new Map<string, number>();
const quotaTracker: number[] = [];
let dailyUsage = 0;

let selfActivityTimer: NodeJS.Timeout | null = null;

async function startSelfActivity(guildId: string) {
  if (guildPaused.has(guildId)) return;
  const guild = botClient?.guilds.cache.get(guildId);
  if (!guild) return;

  // Find a busy-ish channel or just a text channel
  const channels = guild.channels.cache.filter(c => c.isTextBased());
  const channel: any = channels.first();
  if (!channel) return;

  const ai = await getOrInitAI();
  if (!ai) return;

  const serverCtx = await getServerContext(guildId);
  
  const prompt = `
${SYSTEM_PROMPT}
---
[Server Context]: ${JSON.stringify(serverCtx?.insideJokes || [])}
[Current Mood]: You just woke up or got bored and want to start a convo.

Action: Generate a very short opening message (yoo anyone on?, etc) and decide your INTENT for this session.
`;

  try {
    const aiResponse = await ai.models.generateContent({
      model: MODEL_NAME,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: { temperature: 1.1 },
    });

    let text = aiResponse.text;
    const dataMatch = text.match(/DATA: (\{.*\})/);
    let intel: any = null;
    if (dataMatch) {
      try { intel = JSON.parse(dataMatch[1]); text = text.replace(/DATA: \{.*\}/, '').trim(); } catch (e) {}
    }

    if (text) {
      await channel.send(text);
      incrementDaily();
      
      // Start session tracking
      channelActivity.set(channel.id, {
        count: 0,
        lastReset: Date.now(),
        session: { step: 1, targetId: intel?.target_user_id, lastAction: Date.now() }
      });
    }
  } catch (e) { console.error("Self-start fail:", e); }
}

function setupSelfActivityLoop() {
  if (selfActivityTimer) clearInterval(selfActivityTimer);
  
  // Checks every minute, but only triggers randomly every 45-60 mins
  let nextRun = Date.now() + (45 + Math.random() * 15) * 60000;
  
  selfActivityTimer = setInterval(async () => {
    if (Date.now() > nextRun) {
      const guilds = botClient?.guilds.cache.keys();
      if (guilds) {
        for (const gId of guilds) await startSelfActivity(gId);
      }
      nextRun = Date.now() + (45 + Math.random() * 15) * 60000;
    }

    // Handle session timeouts (the 1min / 2min waits)
    for (const [chId, activity] of channelActivity.entries()) {
      if (!activity.session) continue;
      
      const elapsed = Date.now() - activity.session.lastAction;
      const channel = botClient?.channels.cache.get(chId) as any;
      if (!channel) continue;

      // STEP 1 -> STEP 2: Wait 1 min for response. If none, ping.
      if (activity.session.step === 1 && elapsed > 60000) {
        if (!activity.session.targetId) {
          const members = (channel as any).guild.members.cache.filter((m: any) => !m.user.bot);
          activity.session.targetId = members.random()?.id;
        }
        
        if (activity.session.targetId) {
          const ai = await getOrInitAI();
          const prompt = `${SYSTEM_PROMPT}\n---\nYou tried to start a convo but no one replied. You are annoyed. Ping <@${activity.session.targetId}> to get their attention. Be funny or toxic. No skipping.`;
          const resp = await ai?.models.generateContent({ model: MODEL_NAME, contents: [{ role: 'user', parts: [{ text: prompt }] }], config: { temperature: 1.1 } });
          let text = resp?.text || `yo <@${activity.session.targetId}> u dead?`;
          text = text.replace(/DATA: \{.*\}/, '').replace(/SKIP: true/g, '').trim();
          await channel.send(text);
          activity.session.step = 2;
          activity.session.lastAction = Date.now();
        } else {
          activity.session = undefined;
        }
      } 
      // STEP 2 -> END: Wait 2 min for response. If none, sleep.
      else if (activity.session.step === 2 && elapsed > 120000) {
        const ai = await getOrInitAI();
        const prompt = `${SYSTEM_PROMPT}\n---\nNo one is talking to u. Say u are going back to sleep or hopping off. No skipping.`;
        const resp = await ai?.models.generateContent({ model: MODEL_NAME, contents: [{ role: 'user', parts: [{ text: prompt }] }], config: { temperature: 1.0 } });
        let text = resp?.text || "dead chat. im out.";
        text = text.replace(/DATA: \{.*\}/, '').replace(/SKIP: true/g, '').trim();
        await channel.send(text);
        activity.session = undefined;
      }
    }
  }, 30000); // Check sessions every 30s
}

function incrementDaily() {
  dailyUsage++;
}

function getEngagementWeight(channelId: string, isMentioned: boolean) {
  const now = Date.now();

  // Mentions ALWAYS trigger the brain
  if (isMentioned) return 1.0;

  // Hard mute check
  const mutedUntil = channelMutedUntil.get(channelId);
  if (mutedUntil && now < mutedUntil) return 0;

  // Quota/RPM Throttling
  while (quotaTracker.length > 0 && quotaTracker[0] < now - 60000) {
    quotaTracker.shift();
  }
  const rpm = quotaTracker.length;
  if (rpm > 12) return 0.1; // Throttle hard if very busy to avoid quota errors

  const activity = channelActivity.get(channelId);
  // During active mode, we give the AI 100% chance to see the message (if not throttled)
  if (activity?.activeUntil && activity.activeUntil > now) {
    return 1.0; 
  }

  return 0; // Completely silent if not in active mode and not mentioned
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
    setupSelfActivityLoop();
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
        const weight = getEngagementWeight(message.channelId, false);
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
    
    // If mentioned, go into active mode for 2 mins
    if (isMentioned) {
      activity.activeUntil = Date.now() + 120000;
      activity.session = undefined;
    }
    
    // Auto-reset activity every 5 mins
    if (Date.now() - activity.lastReset > 300000) {
      activity.count = 0;
      activity.lastReset = Date.now();
    }

    const prob = getEngagementWeight(message.channelId, isMentioned);
    const randomChance = Math.random() < prob;

    if (!isMentioned && !randomChance) {
      return;
    }

    // Capture activity
    activity.count++;
    channelActivity.set(message.channelId, activity);

    quotaTracker.push(Date.now());
    incrementDaily();

    // Fetch last 10 messages for better vibe check
    const recentMsgs = await message.channel.messages.fetch({ limit: 10 });
    const history = recentMsgs.map(m => `${m.author.username === botClient?.user?.username ? 'ME' : m.author.username}: ${m.content}`).reverse().join('\n');

    const serverCtx = await getServerContext(message.guildId);
    const userCtx = await getUserContext(message.guildId, message.author.id);

    const ai = await getOrInitAI();
    if (!ai) return;

    try {
      const facts = {
        jokes: (serverCtx?.insideJokes || []).slice(-3),
        intent: serverCtx?.currentIntent || 'chill',
        nicks: (userCtx?.nicknames || []).slice(-2),
        active_mode: !!(activity.activeUntil && activity.activeUntil > Date.now())
      };

      const finalPrompt = `
${SYSTEM_PROMPT}

---
[Context]: ${JSON.stringify(facts)}
[Recent History (Top = Oldest)]:
${history}

[Current Message]: ${message.author.username}: "${message.content}"

Assignment: 
1. Determine if the users are talking specifically TO YOU, or if they are having a private conversation with each other.
2. If they are talking to each other, users ask you to be quiet, or you have nothing to add, output exactly "SKIP: true".
3. If you want to keep talking to them in the next message, set "stay_active": true in DATA. 
4. If you want to stop talking and ignore them for a while, set "break_needed": true in DATA.
5. Be punchy. 2 sentences max. 
`;

      const aiResponse = await ai.models.generateContent({
        model: MODEL_NAME,
        contents: [{ role: 'user', parts: [{ text: finalPrompt }] }],
        config: { temperature: 1.0 },
      });

      let responseText = aiResponse.text;
      if (responseText && !responseText.includes("SKIP: true")) {
        // Start typing ONLY if we are actually replying
        if ('sendTyping' in message.channel) {
          if (!isMentioned) {
            setTimeout(async () => {
              if ('sendTyping' in message.channel) await (message.channel as any).sendTyping();
            }, 500);
          } else {
            await (message.channel as any).sendTyping();
          }
        }

        const dataMatch = responseText.match(/DATA: (\{.*\})/);
        let intel: any = null;
        if (dataMatch) {
          try {
            intel = JSON.parse(dataMatch[1]);
            responseText = responseText.replace(/DATA: \{.*\}/, '').trim();
            if (intel?.break_needed) {
              channelMutedUntil.set(message.channelId, Date.now() + 600000); // 10 min hard sleep
              activity.activeUntil = 0;
            } else if (intel?.stay_active) {
              activity.activeUntil = Date.now() + 120000; // Reset timer
            }
          } catch (e) {}
        }

        // Realistic typing delay
        const delay = 600 + (responseText.length * 18);
        setTimeout(async () => {
          // 40% chance to send a normal message instead of a reply if not directly mentioned
          const useReply = isMentioned || Math.random() > 0.4;
          
          if (useReply) {
            await message.reply(responseText);
          } else {
            await (message.channel as any).send(responseText);
          }
          
          await updateMemory(message.guildId!, message.author.id, message.author.username, message.content, responseText, intel);
        }, delay);
      }
    } catch (e) {
      console.error("AI Drift:", e);
      // No more generic lag messages - stay silent on error unless directly pinged
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
