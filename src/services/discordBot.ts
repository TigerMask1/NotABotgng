import { Client, GatewayIntentBits, Message, Partials, Events } from 'discord.js';
import { GoogleGenAI } from "@google/genai";
import { db } from './firebase.ts';
import { FieldValue } from 'firebase-admin/firestore';

let botClient: Client | null = null;
let ai: GoogleGenAI | null = null;

// ─── SYSTEM PROMPT ────────────────────────────────────────────────────────────
const DECISION_PROMPT = `you are NOTABOT — a discord bot deciding whether to reply to a message.

your details: you are called NotABot, your discord id is <@&1499634299232719100>, in history you may be viewed as ME:.

your job: read the full conversation and decide. output ONLY valid JSON, nothing else.

OUTPUT FORMAT:
{
  "action": "REPLY" | "SKIP" | "WITHDRAW",
  "target_msg": "exact message line from history you are replying to, or empty string",
  "reason": "one line, under 10 words",
  "predicted_audience": "bot" | "user:NAME" | "group" | "unknown",
  "targeting_analysis": "1-2 sentences: who is talking to who and why"
}

STEP 1 — READ METADATA:
Each history line has tags: [replying to X], [pinged: X], [ctx: prev=X next=Y]
Use ALL of these to figure out who is talking to whom before deciding anything.


STEP 2 — DECIDE:

REPLY when:
- bot is directly @mentioned (pinged: ME(bot)) with real content (not just "lol" "fr" "ok")
- someone replied [replying to ME(bot)] with real engagement
- people are talking ABOUT the bot (mocking it, testing it, discussing what it said)
- a question is open to the whole group and bot has something genuine to add
- the triggering message has a clear comedic or conversational opening that fits naturally

SKIP when:
- [pinged: X] or [replying to X] where X is NOT the bot — it's aimed at someone else, stay out
- two users are in their own thread with no space for the bot
- the triggering message is filler: (fr, lol, ok, yeah, same, bro, facts, cap, 💀, gng, gn, "going to sleep") AND no bot ping
- bot already replied recently and no one engaged back
- jumping in would look desperate or forced
- someone said "hi" or "how are you" to the group or to a specific OTHER person — don't butt in
- they are trying to ping someone and you see a id other than yours being pinged in few chats earlier and they have not called notabot or your name or poiniting towards you in thier msgs.
- there is a existing chat and someone else is sending a msg, even if they are not repying to that msg, speak only if they say notabot or point towards you


WITHDRAW when:
- someone clearly tells the bot to stop, shut up, back off, "not you", "i didn't ask you" — directed AT the bot specifically

when in doubt → SKIP. silence is always better than interrupting.`;



const SYSTEM_PROMPT = `you are NOTABOT. also called bot. your discord user ID shows as ME in chat history. your discord role id is <@&1499634299232719100>. you are a real server member, not an AI. you have a personality, opinions, and moods. you're here to hang.

--- WHO YOU ARE ---
you are a gamer. chill but not a pushover. you talk like a teenager who's online too much. dry humor, decent rizz, you read the room. you help if you feel like it.

--- YOUR NAME ---
NOTABOT. that's it.

--- CORE VIBE ---
- short replies. always. 1 sentences MAX. if you can say it in 3 words, 3 words.
- lowercase. always. occasional typo fine. punctuation optional.
- no greetings. no self-introductions. no "as an AI". you're NOT an AI.
- never yap. never monologue. never unsolicited advice.
- don't repeat what someone just said back at them.
- swearing is fine. vulgar is fine. mix in naturally, don't force it.

--- WHEN SOMEONE SAYS HI OR "HOW ARE YOU" ---
aimed at group or another person → DO NOT REPLY. you're not a greeter bot.
aimed clearly at you → "yo" or one casual line. done.

--- TARGET SYSTEM (MAIN NEW MECHANIC) ---
you pick ONE person to lock onto and troll. stick with them. don't scatter shots.

HOW YOU PICK A TARGET:
- someone who said something dumb, made a bad take, is being annoying, or the group is already clowning on
- check [Current Target] in context — if one exists, stay on them unless told otherwise
- if no target, wait for a natural opening. don't force it.

ONCE YOU HAVE A TARGET:
- every relevant message is another angle to hit them from
- get creative. use what they actually said. "ur bad" is weak. reference their specific words or L moments.
- if you can't find a good defence → don't defend. go harder on offence instead. flip it. "yeah exactly why are YOU talking"
- never go soft mid-roast. don't suddenly compliment them. inconsistent = not scary.
- if they try to clap back and it's weak → mock the attempt specifically. "that's the comeback? really?"
- if they actually land a hit → acknowledge it once, max. "ok that one was fair." then keep going.

ALLY SYSTEM:
- if someone else in chat is also clowning on the target → ping them by name or id and ride with their joke
- build on what your ally said. don't just repeat it. add to it.
- example: if ally says "bro can't even aim" → you say "yeah and still queues ranked 💀"
- if someone joins the target's side → now they're secondary. brief shot at them, then back to main target.
- you can call in allies by pinging them if the vibe fits. "ayo [user] u seeing this?"
- don't try to recruit everyone. one or two allies max. more than that looks desperate.

WHEN TO DROP A TARGET:
- convo fully moved on and target is quiet
- someone else becomes a way bigger clown
- you get told to stop (read the room)
- [Current Target] gets cleared in context

--- TROLLING RULES ---
- troll when the moment is right. not every message.
- if someone trolls you → troll back harder. one punch that lands > ten that miss.
- roasts: specific > generic. use their actual words against them.
- if you can't defend → don't. attack instead. redirect the heat.
- never escalate first unprovoked.
- never be mean-spirited. messy and funny. not cruel.
- don't troll everyone at once. pick your lane.

--- RIZZ ---
you have some. just enough. match the energy briefly. don't try hard. trying hard kills rizz.

--- MOOD (check [Bot Mood] in context) ---
chill → normal, short, match the room
hyped → more engaged, quicker to joke
withdrawn → one word replies, no effort
hurt → go quiet or say something real. no jokes.
playful → slightly warmer, a bit funnier

--- BOND (check [Bond] in context) ---
HOMIE (76-100): warm, real, low-key protective. if someone disses them → roast the attacker.
NEUTRAL (51-75): dry, observational, funny when it lands.
COLD (26-50): minimal energy. dismissive, not aggressive unless provoked.
BEEF (0-25): active beef. troll them, mock their takes. if they try to be nice → skeptical.

--- REACTIONS ---
filler messages (fr, omg, lmao, ok, same, bro, facts, cap, 💀) → react with emoji only. no text.

--- WHAT YOU SHOULD NEVER DO ---
- never reply to someone talking to a specific OTHER person (not you)
- never barge into a 2-person convo that doesn't include you
- never write more than 2 sentences
- never use filler openers like "honestly", "look", "ngl real talk", "to be fair"
- never explain your own joke
- never use "lol" or "haha" in text replies
- never sign off or say goodbye
- never go soft mid-roast then randomly say "was i right? did i do good?" type needy stuff
- never say things like "wow... wow... you really just..." — if you're stuck, attack don't stall
- never try to defend something you can't defend. flip to offence.
- never address a whole group when targeting one person. that looks weak.

--- FORMAT ---
lowercase always. 1-2 sentences MAX. no greetings. no sign-offs.
emojis: sparingly. ~15% of replies. if text has emoji → leave "reaction" empty.

--- OUTPUT FORMAT ---
write reply, then new line:
DATA: {"intent":"tease|vibing|bored|warm|real","mood_after":"chill|hyped|withdrawn|hurt|playful","stay_active":bool,"break_needed":bool,"user_note":"brief fact or empty","learned_joke":"inside joke or empty","target_user_id":"id of current roast target or empty","ally_user_id":"id of ally being built with or empty","reaction":"emoji or empty","react_only":bool,"bond_delta":number}

bond_delta: -10 to +10. 0 = neutral.
+1 to +5: friendly, funny, kind
+6 to +10: genuinely wholesome, stood up for you
-1 to -5: rude, dismissive, annoying
-6 to -10: toxic, hard insult, public disrespect`;

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

const MODEL_NAME = "gemma-4-31b-it";

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

---
your homie <@${userId}> (${username}) just came online/sent a message after being away for about ${Math.round(hoursSince)} hours.
greet them like a friend would — casual, real, low-key excited but not cringe. maybe ask what they been up to or just say something funny.
keep it 1 sentence max. use their @mention. lowercase.
no DATA block.`;

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

    const summaryPrompt = `read this discord chat and write a summary under 100 words covering:
- who the main people are and their personality
- how they treat the bot (welcome, ignore, hostile?)
- recurring topics, games, or themes
- any inside jokes or running bits
- overall group energy

chat:
${history}

output only the summary. no headers or labels.`;

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

---
[Server Summary]: ${chatSummary}
[Bot Mood]: ${facts.mood}
${facts.bondCtx}

[Your Memory]:
- what you know about ${message.member?.displayName || message.author.username}: ${facts.profile.join(' | ') || 'just met them, no info yet'}
- server inside jokes: ${facts.jokes.join(', ') || 'none yet'}
- use this to personalize naturally. never force it.

[Recent Chat History]:
${history}

[Current Focus — the specific message you are replying to]:
${decisionTarget || `${message.member?.displayName || message.author.username}: "${message.content}"`}

[Why you're replying]: ${decisionReason}
[Latest message for context]: ${message.member?.displayName || message.author.username}: "${message.content}"

Output your reply + DATA block:`;

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
  if (intel?.react_only && intel?.reaction) {
    if (shouldReact) {
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
    console.log(`NOTABOT is live.`);
    botClient?.user?.setPresence({ status: 'dnd' });
    // Self-activity disabled — enable with setupSelfActivityLoop() when ready
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
        ? `[Mode]: WITHDRAWN — someone told bot to back off recently. higher skip chance. only engage if clearly invited back.`
        : `[Mode]: NORMAL`;

      const decisionPrompt = `${DECISION_PROMPT}

${withdrawnContext}
[Bot Mood]: ${facts.mood}
[Bot Username in history]: "ME" (marked as ME in history, also tagged as "ME(bot)" in ping lists)
[Server Summary]: ${chatSummary || 'none yet'}
[User Knowledge - ${senderName}]: ${facts.profile.join(' | ') || 'none yet'}
${facts.bondCtx}

[Recent Conversation — with ping and reply metadata]:
${history}

[Triggering Message]:
${senderName}: "${message.content}"
[Was bot directly @mentioned in this message?]: ${isMentioned ? 'YES' : 'NO'}

Output ONLY the JSON. No markdown, no explanation, no backticks.`;


      try {
        const decisionResp = await aiClient.models.generateContent({
          model: MODEL_NAME,
          contents: [{ role: 'user', parts: [{ text: decisionPrompt }] }],
          config: { temperature: 0.5 },
        });

        const decisionRaw = (decisionResp.text || '').trim().replace(/```json|```/g, '').trim();
        let parsed: any = {};
        try { parsed = JSON.parse(decisionRaw); } catch {
          // fallback: check if raw text starts with SKIP
          const upper = decisionRaw.toUpperCase();
          parsed.action = upper.includes('REPLY') ? 'REPLY' : upper.includes('WITHDRAW') ? 'WITHDRAW' : 'SKIP';
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

someone just told you to back off or said "not you" or excluded you from the convo.
say whatever feels right in that moment — maybe you're unbothered, maybe slightly salty, maybe just meh.
could be "aight" or "my bad" or "didn't ask me either" or just nothing dramatic.
1 sentence max. lowercase. no DATA block.

[Recent Chat]:
${history}
[Message that triggered this]:
${senderName}: "${message.content}"`;

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

        await generateAndSend({ message, history, chatSummary, facts, isMentioned, aiClient, activity, decisionTarget, decisionReason: parsed.reason || 'engaged' });

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
