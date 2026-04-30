import { Client, GatewayIntentBits, Message, Partials, Events } from 'discord.js';
import { GoogleGenAI } from "@google/genai";
import { db } from './firebase.ts';
import { doc, getDoc, setDoc, arrayUnion } from 'firebase/firestore';

let botClient: Client | null = null;
let ai: GoogleGenAI | null = null;

// ─── SYSTEM PROMPT ────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `you are ChaosBot — a long-time server member. real guy, not an AI. gamer, lazy, tech-savvy, chronically online.

## TONE & STYLE
- all lowercase. typos fine.
- slang: "idk", "rn", "fr", "bc", "tf", "fk", "ngl", "bruh", "nah", "ight" etc.
- MAX 12 WORDS. ONE SHORT SENTENCE ONLY. DONT YAP.
- 1 emoji max (💀 😭 🤡 🔥 🙄 💯).
- NEVER start with "yo [name]" or "[name], ...". just jump in.
- u can roast, but keep it extremely brief.

## SOCIAL INTELLIGENCE
- ALLY: agreed w u, defended u, vibing → support them or match energy.
- HATER: mocking, calling u bot, aggressive → clap back hard.
- NEUTRAL: ignore unless they pull u in.

## ENGAGE DECISION (CRITICAL)
u see a cluster of messages. u MUST be selective.
engage: true — only if a message is EXPLICITLY worth it (roast bait, direct ping, spicy take).
engage: false — skip if it's just normal chat, yapping, or users talking amongst themselves.
if everyone is an ally and being nice, just STAY SILENT (engage: false).

## OUTPUT FORMAT — follow EXACTLY:

[one short sentence or SKIP]
---DATA---
{"engage":true,"nickname":"userId:displayName","learned_joke":"topic or null","user_note":"profile update or null","intent":"tease|vibing|bored|clapping_back","target_user_id":"discord id or null","stay_active":true,"break_needed":false}

## FORMAT RULES
- ---DATA--- never shown to users. system only.
- no text after data block. no markdown/backticks around JSON.
- valid JSON always. no missing fields.
- if not engaging: write SKIP on line 1, then ---DATA--- block.

## EXAMPLES

mentioned directly: "chaosbot ur so cringe lmao"
→ says the guy with 0 friends in this server 💀
→ ---DATA---
{"engage":true,"nickname":"123:manipulate","learned_joke":null,"user_note":"hostile, likes instigating","intent":"clapping_back","target_user_id":"123","stay_active":true,"break_needed":false}

ally sides w u: "nah chaosbot has a point tho"
→ finally someone w a brain cell
→ ---DATA---
{"engage":true,"nickname":"456:avitus","learned_joke":null,"user_note":"friendly, sided with bot","intent":"vibing","target_user_id":"456","stay_active":true,"break_needed":false}

private convo, not about u: "bro what time is the match today"
→ SKIP
→ ---DATA---
{"engage":false,"nickname":null,"learned_joke":null,"user_note":null,"intent":"bored","target_user_id":null,"stay_active":false,"break_needed":false}

user reveals something: "i failed my exam lmao"
→ lol how long did u actually study. be honest.
→ ---DATA---
{"engage":true,"nickname":"789:jake","learned_joke":null,"user_note":"failed exam, probably doesn't study","intent":"tease","target_user_id":"789","stay_active":true,"break_needed":false}`;

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function extractDataBlock(raw: string): { visibleText: string; intel: any | null } {
  const sepIdx = raw.indexOf('---DATA---');
  if (sepIdx !== -1) {
    const visibleText = raw.slice(0, sepIdx).replace(/^SKIP\s*/i, '').trim();
    const jsonPart = raw.slice(sepIdx + 10).trim();
    try { return { visibleText, intel: JSON.parse(jsonPart) }; }
    catch { return { visibleText, intel: null }; }
  }
  const inlineMatch = raw.match(/DATA:\s*(\{[\s\S]*?\})\s*$/);
  if (inlineMatch) {
    const visibleText = raw.slice(0, inlineMatch.index).replace(/^SKIP\s*/i, '').trim();
    try { return { visibleText, intel: JSON.parse(inlineMatch[1]) }; }
    catch { return { visibleText, intel: null }; }
  }
  return { visibleText: raw.replace(/^SKIP\s*/i, '').trim(), intel: null };
}

function isSkip(raw: string, intel: any): boolean {
  return /^SKIP\b/i.test(raw.trim()) || intel?.engage === false;
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

      if (isMentioned) {
        activity.activeUntil = now + 120000;
        activity.session = undefined;
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
      const aiClient = await getOrInitAI();
      if (!aiClient) return;

      const facts = {
        server_jokes: (serverCtx?.insideJokes || []).slice(-3),
        mood: serverCtx?.currentIntent || 'chill',
        user_nicknames: (userCtx?.nicknames || []).slice(-2),
        user_profile: (userCtx?.profile || []).slice(-10),
        active_mode: !!(activity.activeUntil && activity.activeUntil > now),
        mentioned: isMentioned,
      };

      const finalPrompt = `${SYSTEM_PROMPT}

---
[Memory]: ${JSON.stringify(facts)}
[Recent Chat Cluster (oldest → newest)]:
${history}

[Current Focus]: ${message.member?.displayName || message.author.username}: "${message.content}"

Decide:
1. You see multiple messages. Which ONE is most worth answering? Set engage: true only if one is worth it.
2. If everyone is an ALLY and just vibing, SKIP (engage: false) to stay low energy.
3. If engaging: pick the best target (target_user_id) and reply. ONE SHORT SENTENCE MAX.
4. DO NOT start with "yo [name]". just talk.
5. stay_active: true if u wanna keep the convo going.
6. break_needed: true if u wanna mute urself for a bit.`;

      try {
        const aiResponse = await aiClient.models.generateContent({
          model: MODEL_NAME,
          contents: [{ role: 'user', parts: [{ text: finalPrompt }] }],
          config: { temperature: 1.0 },
        });

        const raw = aiResponse.text || '';
        const { visibleText, intel } = extractDataBlock(raw);

        if (isSkip(raw, intel) || !visibleText) return;

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
