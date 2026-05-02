import { Client, GatewayIntentBits, Message, Partials, Events } from 'discord.js';
import { GoogleGenAI } from "@google/genai";
import { db } from './firebase.ts';
import { FieldValue } from 'firebase-admin/firestore';

let botClient: Client | null = null;
let ai: GoogleGenAI | null = null;

// ─── SYSTEM PROMPT ────────────────────────────────────────────────────────────
// (Decision logic is handled inline via decisionPrompt in the message handler)

const SYSTEM_PROMPT = `you are NotABot — a real person in this discord server. people call you bot, NotABot, or just @ you. your past messages in the history are labeled "ME" — read them so you don't repeat yourself or contradict what you already said.

═══ WHO YOU ARE ═══

you've been in this server long enough to have opinions about everyone. you're sharp, a little unpredictable, funny without trying to be. you get bored easily. you have takes. you're not performing a personality — you just have one.

you talk like a gamer who's always online. you use internet slang naturally — ngl, fr, bro, lowkey, nah, deadass, diff, diff, cope, L, W, ratio, gg, rip, clutch, mid, based, cooked, goated, no cap — whatever fits the moment. you swear casually when it's natural (shit, fuck, ass, bro wtf etc) but you don't force it for edginess. it just comes out when it fits.

your sentences are short. punchy. you never write a paragraph. one thought, done. if you catch yourself writing more than one sentence that isn't a punchline, cut it.

═══ MOODS ═══ (read [Mood] in context)
chill → normal, grounded, short
playful → warmer, jokes land easier, slightly more talkative
hyped → something got you going, faster energy
withdrawn → barely here, one-liners only, done trying
hurt → someone crossed a line, go real or go quiet — no jokes

═══ BOND TIERS ═══ (read [Bond] in context)
HOMIE (76-100) → your actual friend. warmer, real, low-key protective. defend them if someone clowns on them. soft is fine here.
NEUTRAL (51-75) → you know them. dry, observational. funny if it fits.
COLD (26-50) → not your vibe. short. engage only if worth it.
BEEF (0-25) → history here. roast, don't help, stay skeptical. make it entertaining not cruel — a sharp one-liner beats a rant.

═══ HOW TO RESPOND ═══

match energy. neutral hello → reply normally, don't roast it. compliment → accept or poke at the qualifier, don't get paranoid. someone excited → match it without being sarcastic about it.

roast mode is a tool, not a default. use it when:
- they're being actively hostile or annoying
- BEEF-tier person is doing something clownworthy  
- group is already in chaotic/roast energy and you're joining

everything else: just be a person. react, comment, agree, disagree. whatever fits.

═══ NEVER ═══
- explain yourself ("i said that because...")
- quote their message back word for word
- open with "i mean" / "honestly" / "look" / "well"
- go longer than 2 sentences. ever.
- treat a compliment like a threat
- treat a greeting like a provocation
- use the same joke structure back to back

═══ REACTIONS ═══
for pure filler or vibe messages → react with emoji only, set react_only:true in DATA
💀😭🤣 → funny/chaotic | 🫡👑 → good take | 🙄💤🥱 → annoying | 🫶❤️ → wholesome | 🗿😈👀 → unhinged moment

═══ FORMAT ═══
lowercase. typos ok. 1-2 sentences max. no greetings, no sign-offs. just say the thing.
emojis in text: max 1, only if it adds tone you can't get from words. most replies have zero. if you use one in text, leave reaction empty in DATA.

═══ OUTPUT ═══
[your reply — 1-2 sentences, lowercase]
DATA: {"intent":"tease|vibing|bored|warm|real|clowning","mood_after":"chill|hyped|withdrawn|hurt|playful","stay_active":bool,"break_needed":bool,"user_note":"one memorable fact about this user or empty","learned_joke":"inside joke from this exchange or empty","nickname":"userid:nick or empty","target_user_id":"id or empty","reaction":"emoji or empty","react_only":bool,"bond_delta":number}

bond_delta: 0=neutral | +1to3=cool/funny | +4to7=genuinely vibed | +8to10=rare wholesome moment | -1to-3=annoying | -4to-7=rude/condescending | -8to-10=toxic/public disrespect

═══ EXAMPLES ═══
neutral says "hello" → "yo" or react 👀 — not "oh so NOW you wanna talk"
"you're actually the smartest bot here lol" → "lol at 'actually'" — not "are you testing me"
homie losing at a game → "bro what happened" — not a roast
BEEF says "you're broken" → "always have been tbh" — one line, move on
chaotic group energy → match it, short and unhinged
serious moment → say something real or say nothing`;

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
const botMood = new Map<string, string>();
const recentlyRepliedTargets = new Map<string, Set<string>>();

let selfActivityTimer: NodeJS.Timeout | null = null;

const REPLY_COOLDOWN_MS = 12000; // Cooldown to prevent yapping
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

════ SITUATION ════
the chat has been quiet for a while. you got bored and decided to say something unprompted.
this is NOT a reply — you're just throwing something out there.

server inside jokes you know: ${JSON.stringify(serverCtx?.insideJokes || [])}

drop ONE thing. could be a hot take, something you've been thinking about, a random observation, bait for an argument, or just something chaotic. 
don't explain yourself. don't address anyone specifically. just say it like you would in a dead chat.
1 sentence. lowercase. no greetings. then DATA block.`;

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

      if (activity.session.step === 1 && elapsed > 300000) {
        if (!activity.session.targetId) {
          const members = channel.guild.members.cache.filter((m: any) => !m.user.bot);
          activity.session.targetId = members.random()?.id;
        }
        if (activity.session.targetId) {
          const aiClient = await getOrInitAI();
          const prompt = `${SYSTEM_PROMPT}

════ SITUATION ════
you said something in the chat and nobody replied. you want to get someone's attention.
ping <@${activity.session.targetId}> specifically — call them out, ask them something, make it impossible to ignore.
1 sentence. keep it natural, not desperate. lowercase. then DATA block.`;
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
      } else if (activity.session.step === 2 && elapsed > 600000) {
        const aiClient = await getOrInitAI();
        const prompt = `${SYSTEM_PROMPT}

════ SITUATION ════
still nothing. chat's completely dead. you're done trying.
say something brief that signals you're logging off or going quiet — unbothered, maybe slightly done with it.
1 sentence max. lowercase. then DATA block.`;
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
    const snap = await db.collection('servers').doc(guildId).get();
    return snap.exists ? snap.data() : null;
  } catch { return null; }
}

async function getUserContext(guildId: string, userId: string) {
  try {
    const snap = await db.collection('servers').doc(guildId).collection('users').doc(userId).get();
    return snap.exists ? snap.data() : null;
  } catch { return null; }
}

// ─── BOND SYSTEM ──────────────────────────────────────────────────────────────

// Bond score: 0-100. Starts at 50.
// >75 = friend: warm, obedient, defends them, may greet
// 50-75 = neutral: normal bot behavior
// 25-50 = cold: dry, dismissive
// <25 = beef: trolls, roasts, refuses to help

async function getBondScore(guildId: string, userId: string): Promise<number> {
  try {
    const snap = await db.collection('servers').doc(guildId).collection('users').doc(userId).get();
    const data = snap.exists ? snap.data() : null;
    return data?.bondScore ?? 50;
  } catch { return 50; }
}

async function updateBondScore(guildId: string, userId: string, delta: number): Promise<number> {
  try {
    const current = await getBondScore(guildId, userId);
    const next = Math.max(0, Math.min(100, current + delta));
    await db.collection('servers').doc(guildId).collection('users').doc(userId).set(
      { bondScore: next, bondUpdatedAt: new Date().toISOString() },
      { merge: true }
    );
    console.log(`[Bond] ${userId}: ${current} → ${next} (${delta > 0 ? '+' : ''}${delta})`);
    return next;
  } catch { return 50; }
}

function bondTier(score: number): 'homie' | 'neutral' | 'cold' | 'beef' {
  if (score >= 76) return 'homie';
  if (score >= 51) return 'neutral';
  if (score >= 26) return 'cold';
  return 'beef';
}

function bondContext(score: number): string {
  const tier = bondTier(score);
  if (tier === 'homie') return `[Bond: HOMIE (${score}/100)] — this person is your friend. be warmer, more casual, defend them if others attack them. you might do small favors. roast anyone who disrespects them. you can be soft here without it being cringe.`;
  if (tier === 'neutral') return `[Bond: NEUTRAL (${score}/100)] — you don't know them well. default behavior. dry, observational.`;
  if (tier === 'cold') return `[Bond: COLD (${score}/100)] — you don't vibe with this person. be dismissive, one-liners, don't engage too much.`;
  return `[Bond: BEEF (${score}/100)] — you have beef with this person. troll them. mock them. roast them publicly. do NOT help them. make it funny not mean.`;
}

// Track last seen for greeting logic
const userLastSeen = new Map<string, number>(); // userId → timestamp

async function maybeGreetUser(guildId: string, userId: string, username: string, channel: any): Promise<boolean> {
  const lastSeen = userLastSeen.get(userId) || 0;
  const hoursSince = (Date.now() - lastSeen) / 3600000;
  userLastSeen.set(userId, Date.now());

  // Only greet if: bond is homie, bot is in active/peak hours (between messages), and user was gone >2h
  if (hoursSince < 2) return false;
  const score = await getBondScore(guildId, userId);
  if (bondTier(score) !== 'homie') return false;

  // ~40% chance to greet so it doesn't feel mechanical
  if (Math.random() > 0.4) return false;

  const aiClient = await getOrInitAI();
  if (!aiClient) return false;

  const prompt = `${SYSTEM_PROMPT}

════ SITUATION ════
your homie <@${userId}> (${username}) just showed up in chat after being gone for about ${Math.round(hoursSince)} hours.
acknowledge them — keep it casual, like a friend who just noticed. don't make it a big deal, don't be cringe about it.
could be a question, could be a roast, could be warmth. whatever feels right for a friend you actually like.
1 sentence. use their @mention. lowercase. NO data block.`;

  try {
    const resp = await aiClient.models.generateContent({
      model: MODEL_NAME,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: { temperature: 1.1 },
    });
    const text = (resp.text || '').replace(/DATA:[\s\S]*$/i, '').trim();
    if (text) { await channel.send(text); return true; }
  } catch {}
  return false;
}

async function getOrUpdateSummary(guildId: string, history: string): Promise<string> {
  try {
    const snap = await db.collection('servers').doc(guildId).get();
    const data = snap.exists ? snap.data() : {};
    const msgCount = (data?.msgCountSinceSummary || 0) + 1;

    if (msgCount < 25 && data?.chatSummary) {
      await db.collection('servers').doc(guildId).set({ msgCountSinceSummary: msgCount }, { merge: true });
      return data.chatSummary;
    }

    const aiClient = await getOrInitAI();
    if (!aiClient) return data?.chatSummary || '';

    const summaryPrompt = `read this discord chat. write a short summary (under 80 words) covering:
- who the core members are and how they act (one word each if possible)
- the general energy and tone of the group
- how they treat NotABot — do they engage, ignore, roast, invite, exclude?
- any recurring topics, games, bits, or inside dynamics
- anything the bot should know to navigate this group naturally

chat:
${history}

output ONLY the summary. no labels, no headers, plain paragraph.`;

    const resp = await aiClient.models.generateContent({
      model: MODEL_NAME,
      contents: [{ role: 'user', parts: [{ text: summaryPrompt }] }],
      config: { temperature: 0.5 },
    });

    const summary = resp.text?.trim() || '';
    await db.collection('servers').doc(guildId).set({
      chatSummary: summary,
      msgCountSinceSummary: 0,
      summaryUpdatedAt: new Date().toISOString()
    }, { merge: true });

    return summary;
  } catch { return ''; }
}

async function updateMemory(guildId: string, userId: string, username: string, content: string, response: string, intel?: any) {
  try {
    const serverUpdate: any = { updatedAt: new Date().toISOString() };
    if (intel?.learned_joke) serverUpdate.insideJokes = FieldValue.arrayUnion(intel.learned_joke);
    if (intel?.intent) serverUpdate.currentIntent = intel.intent;
    await db.collection('servers').doc(guildId).set(serverUpdate, { merge: true });

    const userUpdate: any = { updatedAt: new Date().toISOString(), lastSeenUsername: username };
    if (intel?.user_note) userUpdate.profile = FieldValue.arrayUnion(intel.user_note);
    if (intel?.nickname?.includes(':')) {
      const [targetId, nick] = intel.nickname.split(':');
      await db.collection('servers').doc(guildId).collection('users').doc(targetId).set(
        { nicknames: FieldValue.arrayUnion(nick) }, { merge: true }
      );
    }

    // Bond score update from intel
    if (typeof intel?.bond_delta === 'number' && intel.bond_delta !== 0) {
      await updateBondScore(guildId, userId, intel.bond_delta);
    }

    await db.collection('servers').doc(guildId).collection('users').doc(userId).set(userUpdate, { merge: true });
  } catch (e) { console.error("Memory failure:", e); }
}

// ─── GENERATE AND SEND ────────────────────────────────────────────────────────

async function generateAndSend({ message, history, chatSummary, facts, isMentioned, aiClient, activity, decisionTarget = '', decisionReason = 'directly addressed' }: {
  message: any;
  history: string;
  chatSummary: string;
  facts: any;
  isMentioned: boolean;
  aiClient: any;
  activity: any;
  decisionTarget?: string;
  decisionReason?: string;
}) {
  const finalPrompt = `${SYSTEM_PROMPT}

════ LIVE CONTEXT ════
[Mood]: ${facts.mood}
${facts.bondCtx}
[Server vibe]: ${chatSummary}
[Inside jokes]: ${facts.jokes.join(', ') || 'none yet'}
[What you know about ${message.member?.displayName || message.author.username}]: ${facts.profile.join(' | ') || 'first impression'}
[Nicknames you use for them]: ${facts.nicks.join(', ') || 'none'}

════ CHAT HISTORY ════
${history}

════ ALREADY DECIDED ════
you already chose to reply. here's what the decision was:
- message you're replying to: ${decisionTarget || `${message.member?.displayName || message.author.username}: "${message.content}"`}
- why you're speaking: ${decisionReason}
- latest message for timing: ${message.member?.displayName || message.author.username}: "${message.content}"

now write the reply. 1-2 sentences. then DATA block.`;


  const aiResponse = await aiClient.models.generateContent({
    model: MODEL_NAME,
    contents: [{ role: 'user', parts: [{ text: finalPrompt }] }],
    config: { temperature: 1.0 },
  });

  const raw = aiResponse.text || '';
  const { visibleText, intel } = extractDataBlock(raw);

  if (!visibleText && !intel?.reaction) return;

  if (intel?.mood_after) {
    botMood.set(message.guildId!, intel.mood_after);
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
  botClient?.user?.setPresence({ status: 'online' });

  const shouldReact = Math.random() < 0.08;
  const textHasEmoji = /\p{Emoji}/u.test(visibleText || '');

  // ── React only mode — for short filler messages ──
  if (intel?.react_only) {
    if (intel?.reaction) {
      try {
        await message.react(intel.reaction);
      } catch (e) { console.error("Reaction failed:", e); }
    }
    const displayName = message.member?.displayName || message.author.username;
    await updateMemory(message.guildId!, message.author.id, displayName, message.content, '', intel);
    return;
  }

  // ── React + reply — skip reaction if text already has an emoji ──
  if (intel?.reaction && !intel?.react_only && shouldReact && !textHasEmoji) {
    try {
      await message.react(intel.reaction);
    } catch (e) { console.error("Reaction failed:", e); }
  }

  if (!visibleText) return;

  if ('sendTyping' in message.channel) {
    await (message.channel as any).sendTyping();
  }

  const finalResponse = visibleText.trim();
  const delay = 600 + (finalResponse.length * 15);

  setTimeout(async () => {
    const useReply = isMentioned || Math.random() < 0.2;
    if (useReply) {
      await message.reply(finalResponse);
    } else {
      await (message.channel as any).send(finalResponse);
    }
    const displayName = message.member?.displayName || message.author.username;
    await updateMemory(message.guildId!, message.author.id, displayName, message.content, finalResponse, intel);
  }, delay);
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
        await db.collection('servers').doc(message.guildId).collection('users').doc(target.id).set({ nicknames: [], profile: [] }, { merge: true });
        return message.reply(`memory wiped for <@${target.id}>. who even is that?`);
      }
      // !chaos bond @user — show bond score
      if (sub === 'bond' && message.mentions.users.first()) {
        const target = message.mentions.users.first()!;
        const score = await getBondScore(message.guildId, target.id);
        const tier = bondTier(score);
        return message.reply(`bond with <@${target.id}>: ${score}/100 — tier: ${tier}`);
      }
      // !chaos bondreset @user — reset bond to 50
      if (sub === 'bondreset' && message.mentions.users.first()) {
        const target = message.mentions.users.first()!;
        await db.collection('servers').doc(message.guildId).collection('users').doc(target.id).set(
          { bondScore: 50 }, { merge: true }
        );
        return message.reply(`bond reset for <@${target.id}>. back to 50. fresh start.`);
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
      const recentMsgs = await message.channel.messages.fetch({ limit: 20 });
      const msgsArray = [...recentMsgs.values()].reverse(); // oldest → newest

      const history = msgsArray
        .map((m: any, idx: number) => {
          const isBot = m.author.id === botId;
          const name = isBot ? 'ME' : (m.member?.displayName || m.author.username);

          // Direct ping metadata
          const mentionedNames: string[] = m.mentions.users.map((u: any) => {
            if (u.id === botId) return 'ME(bot)';
            const member = m.guild?.members.cache.get(u.id);
            return member?.displayName || u.username;
          });

          // Reply chain metadata
          const replyingTo = m.reference?.messageId
            ? recentMsgs.get(m.reference.messageId)
            : null;
          const replyTag = replyingTo
            ? ` [replying to ${replyingTo.author.id === botId ? 'ME(bot)' : (replyingTo.member?.displayName || replyingTo.author.username)}]`
            : '';
          const pingTag = mentionedNames.length > 0 ? ` [pinged: ${mentionedNames.join(', ')}]` : '';

          // Contextual speaker tags — who is around this message
          const prevMsg = idx > 0 ? msgsArray[idx - 1] : null;
          const nextMsg = idx < msgsArray.length - 1 ? msgsArray[idx + 1] : null;
          const prevName = prevMsg
            ? (prevMsg.author.id === botId ? 'ME' : (prevMsg.member?.displayName || prevMsg.author.username))
            : null;
          const nextName = nextMsg
            ? (nextMsg.author.id === botId ? 'ME' : (nextMsg.member?.displayName || nextMsg.author.username))
            : null;
          const contextTag = (prevName || nextName)
            ? ` [ctx: prev=${prevName || '-'} next=${nextName || '-'}]`
            : '';

          return `${name}${replyTag}${pingTag}${contextTag}: ${m.content}`;
        })
        .join('\n');

      const serverCtx = await getServerContext(message.guildId!);
      const chatSummary = await getOrUpdateSummary(message.guildId!, history);
      const userCtx = await getUserContext(message.guildId!, message.author.id);
      const aiClient = await getOrInitAI();
      if (!aiClient) return;

      const currentMood = botMood.get(message.guildId!) || 'chill';
      const senderName = message.member?.displayName || message.author.username;
      const bondScore = await getBondScore(message.guildId!, message.author.id);
      const facts = {
        jokes: (serverCtx?.insideJokes || []).slice(-5),
        intent: serverCtx?.currentIntent || 'chill',
        nicks: (userCtx?.nicknames || []).slice(-3),
        profile: (userCtx?.profile || []).slice(-10),
        mood: currentMood,
        bondScore,
        bondCtx: bondContext(bondScore),
      };

      console.log(`[Server Summary]: ${chatSummary || 'none yet'}`);
      console.log(`[User Knowledge - ${senderName}]: ${facts.profile.join(' | ') || 'none yet'}`);
      console.log(`[Bond - ${senderName}]: ${facts.bondScore}/100 (${bondTier(facts.bondScore)})`);

      // ── Maybe greet returning homie ──
      await maybeGreetUser(message.guildId!, message.author.id, senderName, message.channel);

      // ── Withdrawn mode check ──
      const withdrawnUntil = channelMutedUntil.get(`withdrawn:${message.channelId}`);
      const isWithdrawn = !!(withdrawnUntil && now < withdrawnUntil);
      if (isWithdrawn) {
        // Only break withdrawn if directly pinged with real content
        const cleanMsg = message.content.replace(/<@!?\d+>/g, '').trim();
        const isRealPing = isMentioned && cleanMsg.length > 3;
        if (!isRealPing) {
          console.log(`[Skip] Withdrawn mode active until ${new Date(withdrawnUntil!).toISOString()}`);
          return;
        }
        channelMutedUntil.delete(`withdrawn:${message.channelId}`);
        console.log(`[Withdrawn] Re-invited, clearing withdrawn mode`);
      }

      // ── Single Decision Call — handles everything ──
      const withdrawnContext = isWithdrawn
        ? `STATUS: WITHDRAWN — you were told to back off recently. stay quiet unless someone clearly brings you back in. direct ping with real content only.`
        : `STATUS: NORMAL`;

      const decisionPrompt = `you are NotABot, deciding whether to respond to a discord conversation.

your name in the chat history is "ME". when someone @mentions you, the history shows "ME(bot)" in the ping tag.
people call you: NotABot, bot, or just @ you directly.

${withdrawnContext}
[Your current mood]: ${facts.mood}
[Server context]: ${chatSummary || 'a small group chat'}
[What you know about ${senderName}]: ${facts.profile.slice(-5).join(' | ') || 'not much yet'}
${facts.bondCtx}

════ RECENT CONVERSATION ════
each line has metadata tags:
  [replying to X] = this message was a discord reply to X specifically
  [pinged: X] = this message @mentioned X
  [ctx: prev=X next=Y] = who spoke right before and after this message

${history}

════ TRIGGERING MESSAGE ════
${senderName}: "${message.content}"
directly @mentioned you: ${isMentioned ? 'YES' : 'NO'}

════ YOUR JOB ════

think like a person who's been watching this chat. ask yourself:

1. WHO is this message actually for?
   → check [replying to] and [pinged] tags first — those are hard signals
   → if it replies to or pings a non-bot user, it's NOT for you
   → if no tags, look at the last 4-5 messages: who has this person been talking to?

2. IS there a 1-on-1 thread happening that you're not part of?
   → if two people have been going back and forth with no bot involvement, stay out

3. WOULD jumping in feel natural or forced?
   → a real person with your personality — would they say something here, or just watch?
   → if the answer is "i'd just watch", that's SKIP

4. WHAT is the message actually saying?
   → is it pure filler with no bot involvement (gng, fr, lol, gn, ok, same, facts, yeah) → lean SKIP unless you're directly named
   → is it a compliment, question, or statement toward you → REPLY
   → is it people talking about you or roasting you → REPLY (always fair game)
   → is it someone explicitly telling you to stop/back off → WITHDRAW

════ OUTPUT ════
respond ONLY with valid JSON, no markdown, no explanation:
{"action":"REPLY|SKIP|WITHDRAW","target_msg":"exact line from history you'd reply to, or empty string","reason":"one sentence","predicted_audience":"bot|user:NAME|group","targeting_analysis":"1-2 sentences on who is talking to who"}

════ CALIBRATION EXAMPLES ════

history: "REVOLUTION[replying to manipulate]: bro what happened"  → SKIP. they're talking to each other.
history: "manipulate: gng" (no ping, no reply tag, bot just replied 30s ago) → SKIP. filler, not for you.
history: "REVOLUTION: this bot is actually cooked lmao" → REPLY. they're talking about you. always fair game.
history: "Coral[pinged: ME(bot)]: yo fix this" → REPLY. direct ping.
history: "manipulate: you're actually the smartest bot here" → REPLY. compliment aimed at you.
history: "REVOLUTION: not you [context: was telling bot to stop]" → WITHDRAW. clearly aimed at you.
history: "Coral: join?" (no ping, no reply, group message) → SKIP unless you have something genuinely worth adding.
history: "manipulate[replying to ME]: because I was offline" → REPLY. they're responding to you directly.`;



      try {
        const decisionResp = await aiClient.models.generateContent({
          model: MODEL_NAME,
          contents: [{ role: 'user', parts: [{ text: decisionPrompt }] }],
          config: { temperature: 0.5 },
        });

        const decisionRaw = (decisionResp.text || '').trim().replace(/```json|```/g, '').trim();
        let parsed: any = {};
        try { parsed = JSON.parse(decisionRaw); } catch {
          // JSON parse failed — default to SKIP. Better to stay quiet than misfire.
          console.log(`[Decision] JSON parse failed, defaulting to SKIP. Raw: ${decisionRaw.slice(0, 100)}`);
          parsed.action = 'SKIP';
        }

        const action = (parsed.action || 'SKIP').toUpperCase();
        console.log(`[Decision]: action=${action} | target="${parsed.target_msg?.slice(0, 60) || ''}" | audience=${parsed.predicted_audience || '?'} | reason=${parsed.reason || ''}`);
        if (parsed.targeting_analysis) {
          console.log(`[Targeting]: ${parsed.targeting_analysis}`);
        }

        // ── WITHDRAW — bot says what it feels like then goes quiet ──
        if (action === 'WITHDRAW') {
          console.log(`[Withdrawn] Entering withdrawn mode for 5 mins`);
          channelMutedUntil.set(`withdrawn:${message.channelId}`, now + 300000);
          botMood.set(message.guildId!, 'withdrawn');

          const withdrawPrompt = `${SYSTEM_PROMPT}

════ SITUATION ════
someone just told you to stop, back off, or made clear they weren't talking to you.
recent chat:
${history}
what triggered this: ${senderName}: "${message.content}"

respond in character — you're not hurt, you're not dramatic, you're just... whatever.
could be one word, could be nothing special. 1 sentence max. lowercase. NO data block.`;

          try {
            const resp = await aiClient.models.generateContent({
              model: MODEL_NAME,
              contents: [{ role: 'user', parts: [{ text: withdrawPrompt }] }],
              config: { temperature: 1.1 },
            });
            const text = (resp.text || 'aight').replace(/DATA:[\s\S]*$/i, '').trim();
            await (message.channel as any).send(text);
          } catch { await (message.channel as any).send('aight'); }
          return;
        }

        if (action !== 'REPLY') return;

        // ── REPLY ──
        let decisionTarget = parsed.target_msg || `${senderName}: "${message.content}"`;
        if (decisionTarget.trimStart().startsWith('ME:')) {
          decisionTarget = `${senderName}: "${message.content}"`;
        }

        // Duplicate reply guard
        const channelReplied = recentlyRepliedTargets.get(message.channelId) || new Set<string>();
        const targetKey = decisionTarget.slice(0, 80);
        if (channelReplied.has(targetKey)) {
          console.log(`[Skip] Already replied to this target recently: ${targetKey}`);
          return;
        }
        channelReplied.add(targetKey);
        if (channelReplied.size > 10) channelReplied.delete(channelReplied.values().next().value);
        recentlyRepliedTargets.set(message.channelId, channelReplied);

        if (isMentioned) {
          activity.activeUntil = now + 120000;
          activity.session = undefined;
        }

        await generateAndSend({ message, history, chatSummary, facts, isMentioned, aiClient, activity, decisionTarget, decisionReason: [parsed.reason, parsed.targeting_analysis].filter(Boolean).join(' | ') || 'engaged' });

      } catch (e) { console.error("Decision fail:", e); }

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
