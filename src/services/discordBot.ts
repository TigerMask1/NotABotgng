/**
 * NOTABOT - MERGED SINGLE FILE v4
 * Gen-Z chaotic human persona. NOT an assistant. NOT an AI.
 * Models: llama-3.1-8b-instant (fast decisions/replies) | llama3-70b-8192 (profiler)
 * Fixes: self-identity, history normalization, mention stripping, rate limits
 */

import { Client, GatewayIntentBits, Message, Partials, Events } from 'discord.js';
import Groq from 'groq-sdk';
import { db } from './firebase.ts';

// ─── GROQ MANAGER ────────────────────────────────────────────────────────────

interface ApiKeyStats {
  key: string;
  requestsToday: number;
  errorsToday: number;
  lastError?: string;
  lastUsed?: number;
  isHealthy: boolean;
  cooldownUntil?: number;
}

class GroqManager {
  private clients = new Map<string, Groq>();
  private keyStats = new Map<string, ApiKeyStats>();
  private keys: string[] = [];
  private dailyLimit = 14400;
  private resetTime = Date.now() + 24 * 60 * 60 * 1000;

  constructor() {
    const keyString = process.env.GROQ_API_KEYS || process.env.GROQ_API_KEY;
    if (!keyString) { console.error('[Groq] No API keys in .env'); process.exit(1); }

    this.keys = keyString.split(',').map(k => k.trim()).filter(Boolean);
    if (!this.keys.length) { console.error('[Groq] No valid keys'); process.exit(1); }

    this.keys.forEach(key => {
      this.clients.set(key, new Groq({ apiKey: key }));
      this.keyStats.set(key, { key, requestsToday: 0, errorsToday: 0, isHealthy: true });
    });

    console.log(`[Groq] ${this.keys.length} key(s) loaded`);
  }

  private getBestKey(): string | null {
    const now = Date.now();

    // Reset daily if needed
    if (now > this.resetTime) {
      this.keyStats.forEach(s => { s.requestsToday = 0; s.errorsToday = 0; s.isHealthy = true; s.cooldownUntil = undefined; });
      this.resetTime = now + 24 * 60 * 60 * 1000;
      console.log('[Groq] Daily reset');
    }

    const available = this.keys.filter(key => {
      const s = this.keyStats.get(key)!;
      if (s.cooldownUntil && now < s.cooldownUntil) return false; // in cooldown
      if (!s.isHealthy && s.requestsToday >= this.dailyLimit * 0.9) return false;
      if (s.cooldownUntil && now >= s.cooldownUntil) { s.isHealthy = true; s.cooldownUntil = undefined; } // cooldown expired
      return true;
    });

    if (!available.length) return this.keys[0]; // last resort

    return available.reduce((best, cur) =>
      this.keyStats.get(cur)!.requestsToday < this.keyStats.get(best)!.requestsToday ? cur : best
    );
  }

  async request(
    model: string,
    messages: any[],
    temperature = 0.9,
    maxTokens = 200,
    retries = 3
  ): Promise<string> {
    let lastErr: any;

    for (let i = 0; i < retries; i++) {
      const key = this.getBestKey();
      if (!key) throw new Error('[Groq] All keys exhausted');

      const stats = this.keyStats.get(key)!;
      const client = this.clients.get(key)!;

      try {
        const res = await client.chat.completions.create({ messages, model, temperature, max_tokens: maxTokens });
        stats.requestsToday++;
        stats.lastUsed = Date.now();
        const u = res.usage;
        console.log(`[Groq] ${model} | ${u.prompt_tokens}+${u.completion_tokens}=${u.total_tokens}tok | key:...${key.slice(-4)}`);
        return res.choices[0]?.message?.content || '';
      } catch (err: any) {
        lastErr = err;
        stats.errorsToday++;
        stats.lastError = err.message;

        if (err.status === 429) {
          // Parse retry-after from error message if available
          const retryMatch = err.message?.match(/try again in ([\d.]+)s/i);
          const waitSec = retryMatch ? parseFloat(retryMatch[1]) : 30;
          stats.cooldownUntil = Date.now() + waitSec * 1000;
          stats.isHealthy = false;
          console.warn(`[Groq] Key ...${key.slice(-4)} rate limited → cooldown ${waitSec}s`);
        } else {
          console.error(`[Groq] Attempt ${i + 1}/${retries} key ...${key.slice(-4)}: ${err.message}`);
        }

        if (i < retries - 1) {
          await new Promise(r => setTimeout(r, Math.min(1000 * 2 ** i, 8000)));
        }
      }
    }

    throw new Error(`[Groq] All retries failed: ${lastErr?.message}`);
  }

  getStats() { return this.keys.map(k => this.keyStats.get(k)!); }
  getAvailable() {
    return this.keys.reduce((sum, k) => sum + Math.max(0, this.dailyLimit - this.keyStats.get(k)!.requestsToday), 0);
  }
}

const groq = new GroqManager();

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const REPLY_COOLDOWN_MS   = 5000;
const DEBOUNCE_MS         = 1000;
const PROFILER_INTERVAL   = 12 * 60 * 1000;
const MAX_HISTORY         = 14;

// Fast model for real-time decisions. High TPM on groq free tier.
const FAST_MODEL    = 'llama-3.1-8b-instant';
// Smarter model for profiling (runs async, not time-sensitive)
const DEEP_MODEL    = 'llama3-70b-8192';

// ─── BOT STATE ────────────────────────────────────────────────────────────────

let botClient: Client | null = null;
let BOT_USERNAME = 'NotABot'; // updated on ready
let BOT_ID = '';              // updated on ready

const pendingTriggers   = new Map<string, NodeJS.Timeout>();
const channelLastReply  = new Map<string, number>();
let profilerTimer: NodeJS.Timeout | null = null;

// ─── FIREBASE HELPERS ────────────────────────────────────────────────────────

async function getBondScore(guildId: string, userId: string): Promise<number> {
  try {
    const snap = await db.collection('servers').doc(guildId).collection('users').doc(userId).get();
    return snap.exists ? (snap.data()?.bondScore ?? 50) : 50;
  } catch { return 50; }
}

async function updateBondScore(guildId: string, userId: string, delta: number) {
  if (!delta) return;
  try {
    const cur = await getBondScore(guildId, userId);
    const next = Math.max(0, Math.min(100, cur + delta));
    await db.collection('servers').doc(guildId).collection('users').doc(userId)
      .set({ bondScore: next, bondUpdatedAt: new Date().toISOString() }, { merge: true });
    console.log(`[Bond] ${userId}: ${cur}→${next} (${delta > 0 ? '+' : ''}${delta})`);
  } catch (e) { console.error('[Bond] Error:', e); }
}

async function getUserProfile(guildId: string, userId: string) {
  try {
    const snap = await db.collection('servers').doc(guildId).collection('users').doc(userId).get();
    if (snap.exists) {
      const d = snap.data()!;
      return { personality: d.personality || '', interests: d.interests || [], vibes: d.vibes || '' };
    }
  } catch {}
  return { personality: '', interests: [], vibes: '' };
}

// ─── HISTORY NORMALIZER ───────────────────────────────────────────────────────
// Converts raw Discord messages to clean history string.
// Bot's own messages show as "[me]" so AI knows what IT said.

function buildHistory(
  msgs: Message[],
  botId: string,
  botName: string,
  maxCharsPerMsg = 80
): string {
  return msgs
    .map(m => {
      const author = m.author.id === botId ? '[me]' : (m.member?.displayName || m.author.username);
      const content = stripMention(m.content, botId).substring(0, maxCharsPerMsg);
      return `${author}: ${content}`;
    })
    .join('\n');
}

function stripMention(content: string, botId: string): string {
  return content
    .replace(new RegExp(`<@!?${botId}>`, 'g'), '')
    .trim();
}

// ─── GATEKEEPER ───────────────────────────────────────────────────────────────
// Decides: should we reply? what vibe?

interface GateDecision {
  shouldReply: boolean;
  vibe: 'hype' | 'chill' | 'roast' | 'chaos' | 'fr' | 'ghost';
  bondDelta: number;
  reason: string;
}

async function gatekeeper(
  senderName: string,
  senderProfile: string,
  message: string,
  history: string,
  mentioned: boolean,
  bond: number
): Promise<GateDecision> {
  // If directly mentioned, always reply
  const alwaysReply = mentioned;

  const prompt = `you are the social awareness part of ${BOT_USERNAME}'s brain.
your job: decide if ${BOT_USERNAME} should say something rn.

${BOT_USERNAME} is a gen-z kid in a discord server. they're chaotic but not annoying. they know when to shut up.

person talking: ${senderName}
what you know about them: ${senderProfile || 'basically nothing lol'}
your bond score with them: ${bond}/100
they directly pinged you: ${mentioned ? 'YES' : 'no'}
what they said: "${message}"

recent chat:
${history}

rules:
- if they pinged you → reply (obviously)
- if convo is between two other ppl and has nothing to do with you → ghost
- if something is genuinely funny or you have a hot take → reply
- if it's a greeting aimed at the server/you → reply
- if you just replied and they haven't responded yet → ghost
- don't be that guy who jumps into every convo

vibes you can pick:
- hype: they said something exciting, match the energy
- chill: normal friendly reply
- roast: they said something roastable (light roast only, keep it fun)
- chaos: say something unhinged but harmless
- fr: they said something real/serious, be genuine
- ghost: don't reply

output ONLY valid JSON, nothing else:
{"shouldReply":true/false,"vibe":"hype|chill|roast|chaos|fr|ghost","bondDelta":(-3 to 3),"reason":"one line"}`;

  try {
    const res = await groq.request(
      FAST_MODEL,
      [{ role: 'user', content: prompt }],
      0.35,
      120
    );

    const clean = res.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

    if (alwaysReply && !parsed.shouldReply) {
      parsed.shouldReply = true; // override — if pinged, always reply
      parsed.vibe = parsed.vibe || 'chill';
    }

    return {
      shouldReply: !!parsed.shouldReply,
      vibe: parsed.vibe || 'chill',
      bondDelta: parsed.bondDelta || 0,
      reason: parsed.reason || '?',
    };
  } catch (e) {
    console.warn('[Gate] parse fail, fallback');
    return { shouldReply: alwaysReply, vibe: 'chill', bondDelta: 0, reason: 'fallback' };
  }
}

// ─── SPEAKER ──────────────────────────────────────────────────────────────────
// Generates the actual reply. This is where personality lives.

const VIBE_NOTES: Record<string, string> = {
  hype:  'match their energy. use caps if they used caps. be actually excited not fake hype.',
  chill: 'just talk normally. keep it short and real.',
  roast: 'light roast. use something specific they said. keep it funny not mean.',
  chaos: 'say something unexpected but fun. non-sequitur is fine.',
  fr:    'drop the act. be real and genuine. no jokes this time.',
  ghost: 'say nothing.',
};

async function speaker(
  senderName: string,
  message: string,
  history: string,
  profile: string,
  bond: number,
  vibe: string
): Promise<string> {
  if (vibe === 'ghost') return '';

  const bondTier = bond > 75 ? 'close, you actually like them' : bond > 50 ? 'decent, neutral' : bond > 25 ? 'not really close' : 'kinda beef history';

  const prompt = `you're ${BOT_USERNAME}. a real person in a discord server. NOT an AI. NOT an assistant.

your personality:
- gen z. chaotic energy. charming tho
- u talk like this: lowercase, short forms, typos sometimes
- examples of how u talk:
  "bro no way 💀"
  "wait that actually goes hard"
  "nah fr tho"
  "lmaooo okay okay"
  "dude what 😭"
  "deadass?"
  "idk man that's kinda sus"
  "okay but hear me out"
- you NEVER say things like "certainly", "of course", "I understand", "as an AI"
- you don't explain yourself
- you don't use bullet points
- you never ask "how can i help you today" type stuff
- if something is funny you just react, you don't explain why it's funny
- max 1-2 sentences. sometimes just one word or emoji is better

current vibe: ${VIBE_NOTES[vibe] || VIBE_NOTES.chill}

who you're talking to: ${senderName}
what u know about them: ${profile || 'not much yet'}
your relationship: ${bondTier} (${bond}/100)

recent chat:
${history}

they just said: "${message}"

reply as ${BOT_USERNAME} (stay in character, 1-2 sentences max, no quotation marks around your reply):`;

  try {
    const res = await groq.request(
      FAST_MODEL,
      [{ role: 'user', content: prompt }],
      0.92,
      100
    );

    // Strip any accidental quotes or prefixes the model might add
    return res
      .trim()
      .replace(/^["']|["']$/g, '')          // remove wrapping quotes
      .replace(/^(NotABot|[Mm]e):\s*/i, '') // remove self-labeling
      .split('\n')[0]                         // first line only
      .slice(0, 200);
  } catch (e) {
    console.error('[Speaker] Error:', e);
    return 'bro my brain lagged';
  }
}

// ─── PROFILER (BACKGROUND) ────────────────────────────────────────────────────

async function analyzeAndProfile(
  guildId: string,
  userId: string,
  username: string,
  messages: Array<{ author: string; content: string }>
) {
  try {
    if (messages.length < 3) return;

    const text = messages.map(m => `${m.author}: ${m.content}`).join('\n');

    const prompt = `analyze this discord user's messages and give a short profile.

user: ${username}
messages:
${text}

respond ONLY with valid JSON, no markdown:
{"personality":"one line vibe (e.g. 'always trolling, secretly caring')","interests":["thing1","thing2"],"vibes":"how they communicate style","sentiment":"positive|neutral|negative"}`;

    const res = await groq.request(DEEP_MODEL, [{ role: 'user', content: prompt }], 0.4, 200);

    const clean = res.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

    await db.collection('servers').doc(guildId).collection('users').doc(userId)
      .set({
        personality: parsed.personality,
        interests: parsed.interests || [],
        vibes: parsed.vibes || '',
        sentiment: parsed.sentiment,
        profiledAt: new Date().toISOString(),
      }, { merge: true });

    console.log(`[Profiler] ${username} → ${parsed.personality}`);
  } catch (e) {
    console.warn(`[Profiler] ${username} failed:`, (e as any).message);
  }
}

async function compressHistory(
  guildId: string,
  messages: Array<{ author: string; content: string }>
) {
  try {
    if (messages.length < 10) return;
    const text = messages.slice(-50).map(m => `${m.author}: ${m.content}`).join('\n');

    const prompt = `summarize this discord chat briefly. get the vibe, key moments, inside jokes.

${text}

ONLY valid JSON:
{"summary":"brief summary","insideJokes":["joke1"],"groupVibe":"one line"}`;

    const res = await groq.request(DEEP_MODEL, [{ role: 'user', content: prompt }], 0.4, 250);
    const clean = res.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

    await db.collection('servers').doc(guildId)
      .set({ compressedHistory: parsed, historyCompressedAt: new Date().toISOString() }, { merge: true });

    console.log(`[Profiler] History compressed for ${guildId}`);
  } catch (e) {
    console.warn('[Profiler] Compress failed:', (e as any).message);
  }
}

function startProfilerLoop(client: Client) {
  if (profilerTimer) clearInterval(profilerTimer);

  profilerTimer = setInterval(async () => {
    try {
      for (const guild of client.guilds.cache.values()) {
        const textChannels = guild.channels.cache.filter(c => c.isTextBased());
        for (const ch of textChannels.values()) {
          try {
            const fetched = await (ch as any).messages.fetch({ limit: 20 });
            const history = [...fetched.values()]
              .reverse()
              .map((m: any) => ({
                author: m.author.id === BOT_ID ? '[me]' : m.author.username,
                content: m.content.substring(0, 100),
              }));

            // Only profile non-bot authors
            const authors = new Set(history.filter(m => m.author !== '[me]').map(m => m.author));
            for (const author of authors) {
              const authorMsgs = history.filter(m => m.author === author);
              const member = await guild.members.fetch({ query: author, limit: 1 }).catch(() => null);
              if (member?.first?.()) {
                const u = member.first()!;
                await analyzeAndProfile(guild.id, u.id, author, authorMsgs);
              }
            }

            await compressHistory(guild.id, history);
          } catch {}
        }
      }
      console.log(`[Profiler] Cycle done | ${groq.getAvailable()} reqs left`);
    } catch (e) {
      console.error('[Profiler] Cycle error:', e);
    }
  }, PROFILER_INTERVAL);
}

// ─── MAIN MESSAGE HANDLER ─────────────────────────────────────────────────────

async function handleMessage(message: Message) {
  if (message.author.bot) return;
  if (!message.content?.trim()) return;

  try {
    const isDM = message.channel.isDMBased();
    const isGuild = !isDM && !!message.guildId;
    if (!isDM && !isGuild) return;

    const mentioned = BOT_ID ? message.mentions.has(BOT_ID) : message.mentions.has(botClient!.user!);
    const debounce = mentioned ? 200 : DEBOUNCE_MS;

    // Debounce: reset timer on rapid messages in same channel
    if (pendingTriggers.has(message.channelId)) {
      clearTimeout(pendingTriggers.get(message.channelId)!);
    }

    const timer = setTimeout(async () => {
      pendingTriggers.delete(message.channelId);

      try {
        const senderName = message.member?.displayName || message.author.username;
        const guildId = isGuild ? message.guildId! : 'dm';
        const cleanContent = stripMention(message.content, BOT_ID);

        // Fetch history and normalize
        const rawMsgs = await message.channel.messages.fetch({ limit: MAX_HISTORY });
        const msgArray = [...rawMsgs.values()].reverse() as Message[];
        const history = buildHistory(msgArray, BOT_ID, BOT_USERNAME);

        const bond = isGuild ? await getBondScore(guildId, message.author.id) : 50;
        const profile = isGuild ? await getUserProfile(guildId, message.author.id) : { personality: '', interests: [], vibes: '' };

        // TIER 1: GATEKEEPER
        const gate = await gatekeeper(
          senderName,
          profile.personality || profile.vibes || '',
          cleanContent,
          history,
          mentioned,
          bond
        );

        console.log(`[Gate] ${senderName}: ${gate.shouldReply ? '✓' : '✗'} | ${gate.vibe} | ${gate.reason}`);

        if (!gate.shouldReply) return;

        // Cooldown check (skip if mentioned)
        const lastReply = channelLastReply.get(message.channelId) || 0;
        if (!mentioned && Date.now() - lastReply < REPLY_COOLDOWN_MS) {
          console.log('[Cooldown] Skipping');
          return;
        }

        // TIER 2: SPEAKER
        const replyText = await speaker(
          senderName,
          cleanContent,
          history,
          profile.personality || '',
          bond,
          gate.vibe
        );

        if (!replyText || replyText.length < 1) {
          console.log('[Speaker] Empty reply, skipping');
          return;
        }

        // Fake typing delay (human speed: ~30ms per char, min 400ms)
        const typingDelay = Math.min(400 + replyText.length * 28, 3500);

        setTimeout(async () => {
          try {
            await message.reply({
              content: replyText,
              allowedMentions: { repliedUser: false },
            });

            channelLastReply.set(message.channelId, Date.now());

            if (isGuild) {
              const totalDelta = gate.bondDelta;
              if (totalDelta !== 0) await updateBondScore(guildId, message.author.id, totalDelta);
            }

            console.log(`[Reply → ${senderName}] ${replyText.substring(0, 60)}`);
          } catch (e) {
            console.error('[Send] Error:', e);
          }
        }, typingDelay);

      } catch (e) {
        console.error('[Handler] Process error:', e);
      }
    }, debounce);

    pendingTriggers.set(message.channelId, timer);
  } catch (e) {
    console.error('[Handler] Error:', e);
  }
}

// ─── BOT STARTUP ──────────────────────────────────────────────────────────────

export async function startBot(token: string) {
  if (botClient) return;

  botClient = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMembers,
    ],
    partials: [Partials.Message, Partials.Channel],
  });

  botClient.on(Events.ClientReady, () => {
    BOT_USERNAME = botClient!.user!.username; // real bot name from Discord
    BOT_ID       = botClient!.user!.id;       // real bot ID from Discord

    console.log(`
╔════════════════════════════════════════╗
║  ✓ ${BOT_USERNAME} is online (v4 Human)
║  • Bot ID: ${BOT_ID}
║  • Keys: ${groq.getStats().length}  |  Avail: ${groq.getAvailable()} reqs
║  • Fast: ${FAST_MODEL}
║  • Deep: ${DEEP_MODEL}
╚════════════════════════════════════════╝
`);

    botClient!.user!.setPresence({ status: 'online', activities: [{ name: 'the vibes', type: 3 }] });
    startProfilerLoop(botClient!);
  });

  botClient.on(Events.MessageCreate, handleMessage);

  // Admin command
  botClient.on(Events.MessageCreate, async (msg) => {
    if (msg.content === '!groq-stats' && msg.member?.permissions.has('Administrator')) {
      const stats = groq.getStats();
      const lines = stats.map(s =>
        `Key ...${s.key.slice(-6)}: ${s.requestsToday} reqs | ${s.errorsToday} errs | ${s.isHealthy ? '✓' : '✗ rate limited'}${s.cooldownUntil && Date.now() < s.cooldownUntil ? ` (cooldown ${Math.ceil((s.cooldownUntil - Date.now()) / 1000)}s)` : ''}`
      ).join('\n');
      await msg.reply(`\`\`\`\n${lines}\nTotal available: ${groq.getAvailable()}\n\`\`\``);
    }
  });

  await botClient.login(token);
}

export function stopBot() {
  botClient?.destroy();
  botClient = null;
  if (profilerTimer) clearInterval(profilerTimer);
}

export function getBotStatus() {
  return botClient ? 'running' : 'stopped';
}
