/**
 * NOTABOT - PRODUCTION DISCORD BOT V3
 * Three-tier multi-agent architecture:
 * - No hardcoded greeting detection (AI decides everything)
 * - Unified decision path (no special-case handlers)
 * - Updated to active Groq models (compound-mini, qwen3-32b)
 * - Multi-key API management with failover
 * - Async profiling every 12 minutes
 */

import { Client, GatewayIntentBits, Message, Partials, Events } from 'discord.js';
import { db } from './firebase.ts';
import { groqManager } from './groqManager.ts';
import { evaluateMessage } from './agents/gatekeeper.ts';
import { generateReply } from './agents/speaker.ts';
import { generateGreeting } from './agents/greeter.ts';
import { analyzeAndProfile, compressHistory } from './agents/profiler.ts';

let botClient: Client | null = null;

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const REPLY_COOLDOWN_MS = 4000;
const DEBOUNCE_WINDOW_MS = 1200;
const PROFILER_INTERVAL_MS = 12 * 60 * 1000; // 12 minutes
const MAX_HISTORY = 12;

const pendingTriggers = new Map<string, NodeJS.Timeout>();
const channelActivity = new Map<string, { lastReply: number; count: number }>();
let profilerTimer: NodeJS.Timeout | null = null;

// ─── HELPER: Bond Score ──────────────────────────────────────────────────────

async function getBondScore(guildId: string, userId: string): Promise<number> {
  try {
    const snap = await db.collection('servers').doc(guildId).collection('users').doc(userId).get();
    return snap.exists ? (snap.data()?.bondScore ?? 50) : 50;
  } catch {
    return 50;
  }
}

async function updateBondScore(guildId: string, userId: string, delta: number) {
  if (delta === 0) return;
  try {
    const current = await getBondScore(guildId, userId);
    const next = Math.max(0, Math.min(100, current + delta));
    await db
      .collection('servers')
      .doc(guildId)
      .collection('users')
      .doc(userId)
      .set(
        {
          bondScore: next,
          bondUpdatedAt: new Date().toISOString(),
        },
        { merge: true }
      );
    if (delta !== 0) console.log(`[Bond] ${userId}: ${current} → ${next} (${delta > 0 ? '+' : ''}${delta})`);
  } catch (e) {
    console.error(`[Bond] Error:`, e);
  }
}

// ─── HELPER: User Profile ────────────────────────────────────────────────────

async function getUserProfile(guildId: string, userId: string) {
  try {
    const snap = await db.collection('servers').doc(guildId).collection('users').doc(userId).get();
    if (snap.exists) {
      const data = snap.data();
      return {
        personality: data?.personality || '',
        interests: data?.interests || [],
        dynamics: data?.dynamics || [],
      };
    }
  } catch (e) {
    console.error(`[Profile] Error:`, e);
  }
  return { personality: '', interests: [], dynamics: [] };
}

// ─── PROFILER BACKGROUND TASK ────────────────────────────────────────────────

function startProfilerLoop(botInstance: Client) {
  if (profilerTimer) clearInterval(profilerTimer);

  profilerTimer = setInterval(async () => {
    try {
      const guilds = botInstance.guilds.cache.values();
      for (const guild of guilds) {
        const channels = guild.channels.cache.filter((c) => c.isTextBased());
        for (const channel of channels.values()) {
          try {
            const msgs = await (channel as any).messages.fetch({ limit: 20 });
            const history = [...msgs.values()]
              .reverse()
              .map((m: any) => ({
                author: m.author.username,
                content: m.content.substring(0, 100),
              }));

            const authors = new Set(history.map((m) => m.author));
            for (const author of authors) {
              const authorMsgs = history.filter((m) => m.author === author);
              const user = await guild.members
                .fetch({ query: author, limit: 1 })
                .catch(() => null);
              if (user) {
                await analyzeAndProfile(guild.id, user.id, author, authorMsgs);
              }
            }

            await compressHistory(guild.id, history);
          } catch (e) {
            // channel error, continue
          }
        }
      }
      console.log(`[Profiler] Cycle complete | Available reqs: ${groqManager.getAvailableRequests()}`);
    } catch (e) {
      console.error('[Profiler] Error:', e);
    }
  }, PROFILER_INTERVAL_MS);
}

// ─── MAIN MESSAGE HANDLER ────────────────────────────────────────────────────

async function handleMessage(message: Message) {
  if (message.author.bot) return;

  try {
    const isDM = message.channel.isDMBased();
    const isGuild = message.guildId && message.guild;

    if (!isDM && !isGuild) return;

    const botId = botClient!.user!.id;
    const isMentioned = message.mentions.has(botId);
    const now = Date.now();
    const windowTime = isMentioned ? 300 : DEBOUNCE_WINDOW_MS;

    // Debounce
    if (pendingTriggers.has(message.channelId)) {
      clearTimeout(pendingTriggers.get(message.channelId)!);
    }

    const trigger = setTimeout(async () => {
      pendingTriggers.delete(message.channelId);

      try {
        const senderName = message.member?.displayName || message.author.username;
        const guildId = isGuild ? message.guildId! : 'dm';

        // Fetch context
        const recentMsgs = await message.channel.messages.fetch({ limit: MAX_HISTORY });
        const historyArray = [...recentMsgs.values()]
          .reverse()
          .map((m: any) => `${m.author.username}: ${m.content.substring(0, 60)}`)
          .join('\n');

        const bondScore = isGuild ? await getBondScore(guildId, message.author.id) : 50;
        const profile = isGuild ? await getUserProfile(guildId, message.author.id) : { personality: '', interests: [], dynamics: [] };

        // ═══════ TIER 1: UNIFIED GATEKEEPER DECISION ═══════
        // AI decides everything: whether to reply, emotional stance, even if it's a greeting
        const decision = await evaluateMessage(
          senderName,
          profile.personality || '',
          message.content,
          historyArray,
          isMentioned,
          bondScore
        );

        console.log(
          `[Gate] ${senderName}: ${decision.shouldReply ? 'REPLY' : 'SKIP'} (${decision.emotionalStance}, ${(decision.confidence * 100).toFixed(0)}%)`
        );

        if (!decision.shouldReply) return;

        // Cooldown
        const activity = channelActivity.get(message.channelId);
        if (activity && !isMentioned && now - activity.lastReply < REPLY_COOLDOWN_MS) {
          console.log('[Cooldown] Rate limited');
          return;
        }

        // ═══════ TIER 2: SPEAKER GENERATION ═══════
        const reply = await generateReply(
          senderName,
          decision.emotionalStance,
          message.content,
          historyArray,
          profile.personality,
          bondScore
        );

        if (!reply.text || reply.text.length < 2) {
          console.log('[Speaker] Empty response');
          return;
        }

        // Send reply
        const delay = 150 + reply.text.length * 6;
        setTimeout(async () => {
          try {
            await message.reply({
              content: reply.text,
              allowedMentions: { repliedUser: false },
            });

            if (isGuild && reply.bondDelta !== 0) {
              await updateBondScore(guildId, message.author.id, reply.bondDelta);
            }

            channelActivity.set(message.channelId, {
              lastReply: Date.now(),
              count: (activity?.count || 0) + 1,
            });

            console.log(`[Reply] ${reply.text.substring(0, 40)}...`);
          } catch (e) {
            console.error('[Send] Error:', e);
          }
        }, delay);
      } catch (e) {
        console.error('[Handler] Process error:', e);
      }
    }, windowTime);

    pendingTriggers.set(message.channelId, trigger);
  } catch (e) {
    console.error('[Handler] Error:', e);
  }
}

// ─── BOT STARTUP ─────────────────────────────────────────────────────────────

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
    console.log(`
╔════════════════════════════════════════╗`);
    console.log(`║  ✓ NotABot Online (V3 Pure AI)      ║`);
    console.log(`║  • Groq Manager: ${groqManager.getStats().length} keys         ║`);
    console.log(`║  • Available Reqs: ${groqManager.getAvailableRequests()}         ║`);
    console.log(`║  • Models: compound-mini, qwen3-32b ║`);
    console.log(`╚════════════════════════════════════════╝\n`);
    botClient?.user?.setPresence({ status: 'online', activities: [{ name: 'messages', type: 0 }] });
    startProfilerLoop(botClient!);
  });

  botClient.on(Events.MessageCreate, (message) => handleMessage(message));

  // Admin command to check Groq stats
  botClient.on(Events.MessageCreate, async (message) => {
    if (message.content === '!groq-stats' && message.member?.permissions.has('Administrator')) {
      const stats = groqManager.getStats();
      const available = groqManager.getAvailableRequests();
      const info = stats
        .map(
          (s) =>
            `Key **${s.key.slice(-6)}**: ${s.requestsToday} reqs, ${s.errorsToday} errs, healthy: ${s.isHealthy}`
        )
        .join('\n');
      await message.reply(`\`\`\`\nGroq Stats:\n${info}\n\nTotal Available: ${available}\n\`\`\``);
    }
  });

  await botClient.login(token);
}

export function stopBot() {
  if (botClient) {
    botClient.destroy();
    botClient = null;
  }
  if (profilerTimer) {
    clearInterval(profilerTimer);
  }
}

export function getBotStatus() {
  return botClient ? 'running' : 'stopped';
}
