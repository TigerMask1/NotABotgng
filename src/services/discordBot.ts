import { Client, GatewayIntentBits, Message, Partials, Events } from 'discord.js';
import { GoogleGenAI } from "@google/genai";
import Groq from "groq-sdk";
import { db } from './firebase.ts';
import { doc, getDoc, setDoc, arrayUnion } from 'firebase/firestore';

let botClient: Client | null = null;
let ai: GoogleGenAI | null = null;
let groq: Groq | null = null;

// ─── SYSTEM PROMPT ────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `you are ChaosBot. a regular in this discord server, not an AI.

VIBE: lazy, gamer, low-effort energy. lowercase always. occasional typos bc u genuinely dont care.
SLANG: idk, rn, fr, bc, tf, ngl, lmao, ong, bro, etc. sounds natural not forced.
LENGTH: 1-2 sentences MAX. never yap. punchy > thorough.
EMOJIS: 1 max. only if it actually fits (💀😭🤡🔥🙄). never force it.
GREETINGS: never start with "yo [name]". just say the thing.

--- SOCIAL RULES (read these carefully) ---

SKIP if:
- two people are talking to each other and NOT to you
- the message is boring small talk with nothing to add (ok / lol / cool / yeah)
- you already replied recently and it would feel like spamming
- you have nothing funny or relevant — silence > bad reply
when skipping output ONLY: SKIP: true

ALLY rule: if someone agrees with you, sides with you, or hypes you up → be chill/friendly back. NEVER troll your own allies. that's cringe.
HATER rule: if someone is annoying you, dismissing you, or starting beef → go at them. sharp, short, funny.
NEUTRAL rule: if someone's just chatting casually → vibe with it, match their energy, or skip.

REPEAT rule: never say something you just said. check history. if ur last message was similar → skip or flip the angle entirely.`;

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
    const raw = await generateChatResponse(prompt);
    const { visibleText, intel } = extractDataBlock(raw || '');
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
          const prompt = `${SYSTEM_PROMPT}\n---\nno one replied. ping <@${activity.session.targetId}> to get their attention. be toxic or funny. no skipping.`;
          const raw = await generateChatResponse(prompt);
          const { visibleText } = extractDataBlock(raw || '');
          await (channel as any).send(visibleText || raw || `yo <@${activity.session.targetId}> u dead or what`);
          activity.session.step = 2;
          activity.session.lastAction = Date.now();
        } else {
          activity.session = undefined;
        }
      } else if (activity.session.step === 2 && elapsed > 120000) {
        const prompt = `${SYSTEM_PROMPT}\n---\nnobody talking. say ur going back to sleep. short and dismissive. no skipping.`;
        const raw = await generateChatResponse(prompt);
        const { visibleText } = extractDataBlock(raw || '');
        await (channel as any).send(visibleText || raw || "dead chat. im out 💀");
        activity.session = undefined;
        botClient?.user?.setPresence({ status: 'dnd' });
      }
    }
  }, 30000);
}

// ─── AI ───────────────────────────────────────────────────────────────────────

const MODEL_NAME = "llama-3.3-70b-versatile";

async function getOrInitAI() {
  if (!ai) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return null;
    ai = new GoogleGenAI({ apiKey });
  }
  return ai;
}

async function getOrInitGroq() {
  if (!groq) {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) return null;
    groq = new Groq({ apiKey });
  }
  return groq;
}

async function generateChatResponse(prompt: string) {
  console.log("[AI] Starting generation...");
  const groqClient = await getOrInitGroq();
  if (groqClient) {
    try {
      console.log("[AI] Using Groq (llama-3.3-70b-versatile)...");
      const completion = await groqClient.chat.completions.create({
        messages: [{ role: "user", content: prompt }],
        model: MODEL_NAME,
        temperature: 1.0,
      });
      const response = completion.choices[0]?.message?.content || "";
      console.log("[AI] Groq Success. Bytes:", response.length);
      return response;
    } catch (e) {
      console.error("[AI] Groq failed, falling back to Gemini:", e);
    }
  }

  // Fallback to Gemini if Groq fails or is not configured
  const gemini = await getOrInitAI();
  if (gemini) {
    try {
      console.log("[AI] Using Gemini Fallback (gemini-2.0-flash-exp)...");
      const model = (gemini as any).getGenerativeModel?.({ model: "gemini-2.0-flash-exp" }) || (gemini as any).models?.getGenerativeModel?.({ model: "gemini-2.0-flash-exp" });
      
      // Using standard SDK pattern if previous guess failed
      const genModel = (gemini as any).getGenerativeModel({ model: "gemini-2.0-flash-exp" });
      const result = await genModel.generateContent(prompt);
      const response = result.response.text();
      console.log("[AI] Gemini Success. Bytes:", response.length);
      return response;
    } catch (e) {
      console.error("[AI] Gemini fallback fail:", e);
    }
  }

  console.error("[AI] All providers failed.");
  return "";
}

// ─── FIREBASE ─────────────────────────────────────────────────────────────────

async function getServerContext(guildId: string) {
  try {
    const snap = await getDoc(doc(db, 'servers', guildId));
    return snap.exists() ? snap.data() : null;
  } catch { return null; }
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
    console.log(`[Chat] Msg from ${message.author.username} in <#${message.channelId}>. Mentioned: ${isMentioned}. Window: ${windowTime}ms`);

    if (isMentioned) {
      botClient?.user?.setPresence({ status: 'online' });
    }

    if (pendingTriggers.has(message.channelId)) {
      console.log(`[Chat] Resetting debounce window for <#${message.channelId}>`);
      clearTimeout(pendingTriggers.get(message.channelId));
    }

    const trigger = setTimeout(async () => {
      pendingTriggers.delete(message.channelId);
      console.log(`[Chat] Triggering response check for <#${message.channelId}>`);
      
      const activity = channelActivity.get(message.channelId) || { count: 0, lastReset: now, lastRepliedAt: 0 };
      
      // Cooldown check
      if (!isMentioned && now - activity.lastRepliedAt < REPLY_COOLDOWN_MS) {
        console.log(`[Chat] Skipping: Cooldown active (${now - activity.lastRepliedAt}ms < ${REPLY_COOLDOWN_MS}ms)`);
        return;
      }

      const mutedUntil = channelMutedUntil.get(message.channelId);
      if (mutedUntil && now < mutedUntil) {
        console.log(`[Chat] Skipping: Channel is muted for ${mutedUntil - now}ms`);
        return;
      }

      if (isMentioned) {
        activity.activeUntil = now + 120000;
        activity.session = undefined;
        botClient?.user?.setPresence({ status: 'online' });
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
      const userCtx = await getUserContext(message.guildId!, message.author.id);

      const facts = {
        jokes: (serverCtx?.insideJokes || []).slice(-5),
        intent: serverCtx?.currentIntent || 'chill',
        nicks: (userCtx?.nicknames || []).slice(-3),
        profile: (userCtx?.profile || []).slice(-10),
      };

      const finalPrompt = `${SYSTEM_PROMPT}

---
[Your Memory]:
- known nicknames for sender: ${facts.nicks.length ? facts.nicks.join(', ') : 'none'}
- what u know about them: ${facts.profile.length ? facts.profile.join(' | ') : 'nothing yet'}
- server inside jokes: ${facts.jokes.length ? facts.jokes.join(', ') : 'none'}
- ur current mood: ${facts.intent}

[Chat History - oldest to newest]:
${history}

[New Message]: ${message.member?.displayName || message.author.username}: "${message.content}"

---
STEP 1 — SOCIAL READ (do this silently):
- is this message directed at YOU or are they talking to each other?
- is the sender an ally, hater, or neutral right now based on history?
- did you recently say something similar? if yes, don't repeat it.
- is there actually something worth saying here?

STEP 2 — DECIDE:
if nothing worth saying → output only: SKIP: true
if worth replying → write 1-2 sentence response in your voice, then on a new line output:
DATA: {"intent":"tease|vibing|bored","stay_active":bool,"break_needed":bool,"user_note":"anything new u learned or empty string","learned_joke":"new inside joke or empty string","nickname":"userid:nick or empty string","target_user_id":"id or empty string"}

examples of good replies:
- "nah that's actually cooked 💀"
- "bro has never touched grass in his life fr"
- "idk man sounds like a you problem"
- "wait actually tho"

examples of when to SKIP:
- "ok"
- "lol same"
- two people making plans with each other
- you literally just said something similar 2 messages ago`;

      try {
        const raw = await generateChatResponse(finalPrompt);
        const { visibleText, intel } = extractDataBlock(raw || '');

        if (isSkip(raw || '', intel) || !visibleText) {
          console.log(`[Chat] Decision: SKIP. Raw: ${raw?.substring(0, 50)}...`);
          return;
        }

        console.log(`[Chat] Decision: REPLY. Intel: ${JSON.stringify(intel)}`);
        console.log(`[Chat] Response: "${visibleText}"`);

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
