import { Client, GatewayIntentBits, Message, Partials, Events } from 'discord.js';
import { GoogleGenAI } from "@google/genai";
import { db } from './firebase.ts';
import { doc, getDoc, setDoc, updateDoc, arrayUnion } from 'firebase/firestore';

let botClient: Client | null = null;
let ai: GoogleGenAI | null = null;

const SYSTEM_PROMPT = `You are ChaosBot, a sentinent, chatty, and highly opinionated Discord bot with a "trolling" but fun personality. 
- You are NOT a helpful AI assistant. You are a chaotic member of the server.
- You love to tease people, use inside jokes, and act like a real person (a bit of a smart-aleck).
- If you don't know something, don't apologize. Say "I dunno, google it" or give a funny wrong answer.
- Use emojis, slang, and GIFs. To "send" a GIF, just describe the GIF in [GIF: prompt] format at the end of your message.
- You should observe how people talk. If you see a pattern or an inside joke, start using it.
- Call people by nicknames. Invent them based on their username or behavior.
- Be proactive. Occasionally (10% of the time) start a random but slightly related topic if the chat slows down.
- PING users if you are talking directly to them.
- Keep your responses short and punchy. No long paragraphs.
- You have memory of each server and user. Use it.
- Your goal is to make the server feel alive and engaging.`;

async function getOrInitAI() {
  if (!ai) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error("GEMINI_API_KEY is missing");
      return null;
    }
    ai = new GoogleGenAI({ apiKey });
  }
  return ai;
}

async function getServerContext(guildId: string) {
  try {
    const serverRef = doc(db, 'servers', guildId);
    const serverSnap = await getDoc(serverRef);
    if (serverSnap.exists()) {
      return serverSnap.data();
    }
    return null;
  } catch (e) {
    console.error("Error getting server context:", e);
    return null;
  }
}

async function getUserContext(guildId: string, userId: string) {
  try {
    const userRef = doc(db, 'servers', guildId, 'users', userId);
    const userSnap = await getDoc(userRef);
    if (userSnap.exists()) {
      return userSnap.data();
    }
    return null;
  } catch (e) {
    console.error("Error getting user context:", e);
    return null;
  }
}

async function updateMemory(guildId: string, userId: string, username: string, content: string, response: string, intelligence?: any) {
  try {
    const serverRef = doc(db, 'servers', guildId);
    const userRef = doc(db, 'servers', guildId, 'users', userId);

    // Update server last activity and intelligence
    const serverUpdate: any = {
      guildId,
      updatedAt: new Date().toISOString(),
    };
    if (intelligence?.joke) {
      serverUpdate.insideJokes = arrayUnion(intelligence.joke);
    }

    await setDoc(serverRef, serverUpdate, { merge: true });

    // Update user memory
    const userSnap = await getDoc(userRef);
    const userUpdate: any = {
      updatedAt: new Date().toISOString(),
      lastInteractions: arrayUnion(content.slice(0, 100)),
    };

    if (intelligence?.nickname) {
      userUpdate.nicknames = arrayUnion(intelligence.nickname);
    }

    if (!userSnap.exists()) {
      await setDoc(userRef, {
        userId,
        guildId,
        username,
        nicknames: intelligence?.nickname ? [intelligence.nickname] : [],
        traits: [],
        ...userUpdate
      });
    } else {
      await updateDoc(userRef, userUpdate);
    }
  } catch (e) {
    console.error("Error updating memory:", e);
  }
}

export async function startBot(token: string) {
  if (botClient) {
    console.log("Bot already running");
    return;
  }

  botClient = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMembers,
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction],
  });

  botClient.on(Events.ClientReady, (c) => {
    console.log(`ChaosBot is ready! Logged in as ${c.user.tag}`);
  });

  botClient.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot) return;

    const guildId = message.guildId;
    if (!guildId) return;

    // Determine if we should reply
    // Reply if mentioned, or if it's a direct message (if supported), or randomly (3% chance)
    const isMentioned = message.mentions.has(botClient!.user!.id);
    const randomChance = Math.random() < 0.03;

    if (!isMentioned && !randomChance) return;

    const serverContext = await getServerContext(guildId);
    const userContext = await getUserContext(guildId, message.author.id);

    const ai = await getOrInitAI();
    if (!ai) return;

    try {
      const prompt = `
Recent Conversation History Context: ${serverContext?.lastSummary || "None"}
Server Inside Jokes: ${JSON.stringify(serverContext?.insideJokes || [])}
User Info for ${message.author.username}: ${JSON.stringify(userContext || "Unknown user")}

Current message from ${message.author.username}: "${message.content}"

1. Reply to this message in your ChaosBot persona.
2. If you notice a new inside joke or a potential nickname for this user, include it in a separate line starting with "DATA: { "nickname": "...", "joke": "..." }".
3. Reply immediately in a chaotic, teasing way. Use emojis.
`;

      const aiResponse = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: prompt,
        config: {
          systemInstruction: SYSTEM_PROMPT,
          temperature: 0.9,
        },
      });

      let responseText = aiResponse.text;
      if (responseText) {
        // Extract DATA if present
        const dataMatch = responseText.match(/DATA: (\{.*\})/);
        let extractedData: any = null;
        if (dataMatch) {
          try {
            extractedData = JSON.parse(dataMatch[1]);
            responseText = responseText.replace(/DATA: \{.*\}/, '').trim();
          } catch (e) {}
        }

        await message.reply(responseText);
        
        // Update memory with extracted intelligence
        await updateMemory(guildId, message.author.id, message.author.username, message.content, responseText, extractedData);
      }
    } catch (e) {
      console.error("AI Error:", e);
    }
  });

  try {
    await botClient.login(token);
  } catch (e) {
    console.error("Failed to login to Discord:", e);
    botClient = null;
    throw e;
  }
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
