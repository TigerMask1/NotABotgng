/**
 * NOTABOT - PRODUCTION DISCORD BOT
 * Three-tier multi-agent architecture using Groq models
 * 
 * Architecture:
 * 1. Social Gatekeeper (groq/llama-3.1-70b) - filters & decides if reply needed
 * 2. Core Speaker (groq/llama-3.1-70b) - generates natural responses
 * 3. Memory Profiler (groq/mixtral-8x7b) - async background analysis every 10-15 min
 */

import { Client, GatewayIntentBits, Message, Partials, Events, ChannelType } from 'discord.js';
import { db } from './firebase.ts';
import { evaluateMessage } from './agents/gatekeeper.ts';
import { generateReply } from './agents/speaker.ts';
import { analyzeAndProfile, compressHistory } from './agents/profiler.ts';

let botClient: Client | null = null;

// ─── STATE & CONFIG ──────────────────────────────────────────────────────

const REPLY_COOLDOWN_MS = 5000;
const DEBOUNCE_WINDOW_MS = 1500;
const PROFILER_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_HISTORY = 15;

const pendingTriggers = new Map<string, NodeJS.Timeout>();
const channelActivity = new Map<string, { lastReply: number; count: number }>();
let profilerTimer: NodeJS.Timeout | null = null;

// ─── HELPER: Get Bond Score ──────────────────────────────────────────────

async function getBondScore(guildId: string, userId: string): Promise<number> {
  try {
    const snap = await db.collection('servers').doc(guildId).collection('users').doc(userId).get();
    return snap.exists ? (snap.data()?.bondScore ?? 50) : 50;
  } catch {
    return 50;
  }
}

async function updateBondScore(guildId: string, userId: string, delta: number) {
  try {
    const current = await getBondScore(guildId, userId);
    const next = Math.max(0, Math.min(100, current + delta));
    await db.collection('servers').doc(guildId).collection('users').doc(userId).set(
      {
        bondScore: next,
        bondUpdatedAt: new Date().toISOString(),
      },
      { merge: true }
    );
    console.log(`[Bond] ${userId}: ${current} → ${next}`);
  } catch (e) {
    console.error(`[Bond] Update failed:`, e);
  }
}

// ─── HELPER: Get User Profile ────────────────────────────────────────────

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
    console.error(`[Profile] Load failed:`, e);
  }
  return { personality: '', interests: [], dynamics: [] };
}

// ─── HELPER: Store User Insight ──────────────────────────────────────────

async function storeInsight(guildId: string, userId: string, username: string, insight: string) {
  try {
    if (!insight || insight.length < 3) return;

    const snap = await db.collection('servers').doc(guildId).collection('users').doc(userId).get();
    const data = snap.exists ? snap.data() : {};
    const insights = [...(data?.insights || []), insight];
    const deduped = Array.from(new Set(insights)).slice(-10);

    await db.collection('servers').doc(guildId).collection('users').doc(userId).set(
      {
        insights: deduped,
        lastSeenUsername: username,
        lastSeenAt: new Date().toISOString(),
      },
      { merge: true }
    );
  } catch (e) {
    console.error(`[Insight] Store failed:`, e);
  }
}

// ─── PROFILER BACKGROUND TASK ────────────────────────────────────────────

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

            // Analyze each unique author
            const authors = new Set(history.map((m) => m.author));
            for (const author of authors) {
              const authorMsgs = history.filter((m) => m.author === author);
              const user = await guild.members.fetch({ query: author, limit: 1 }).catch(() => null);
              if (user) {
                await analyzeAndProfile(guild.id, user.id, author, authorMsgs);
              }
            }

            // Compress channel history
            await compressHistory(guild.id, history);
          } catch (e) {
            // channel error, continue
          }
        }
      }
      console.log('[Profiler] Cycle complete');
    } catch (e) {
      console.error('[Profiler] Error:', e);
    }
  }, PROFILER_INTERVAL_MS);
}

// ─── MESSAGE HANDLER ─────────────────────────────────────────────────────

async function handleMessage(message: Message) {
  if (message.author.bot) return;

  try {
    const isDM = message.channel.isDMBased();
    const isGuild = message.guildId && message.guild;

    if (!isDM && !isGuild) return;

    const botId = botClient!.user!.id;
    const isMentioned = message.mentions.has(botId);
    const now = Date.now();
    const windowTime = isMentioned ? 500 : DEBOUNCE_WINDOW_MS;

    // ── Debounce ──
    if (pendingTriggers.has(message.channelId)) {
      clearTimeout(pendingTriggers.get(message.channelId)!);
    }

    const trigger = setTimeout(async () => {
      pendingTriggers.delete(message.channelId);

      try {
        const senderName = message.member?.displayName || message.author.username;

        // ── Get Context ──
        const recentMsgs = await message.channel.messages.fetch({ limit: MAX_HISTORY });
        const historyArray = [...recentMsgs.values()]
          .reverse()
          .map(
            (m: any) =>
              `${m.author.username}: ${m.content.substring(0, 80)}`
          )
          .join('\n');

        const guildId = isGuild ? message.guildId! : 'dm';
        const bondScore = isGuild ? await getBondScore(guildId, message.author.id) : 50;
        const profile = isGuild ? await getUserProfile(guildId, message.author.id) : { personality: '', interests: [], dynamics: [] };

        // ── TIER 1: GATEKEEPER DECISION ──
        const decision = await evaluateMessage(
          senderName,
          profile.dynamics || [],
          message.content,
          historyArray,
          isMentioned,
          bondScore
        );

        console.log(
          `[Gate] ${senderName}: ${decision.shouldReply ? 'REPLY' : 'SKIP'} (${decision.emotionalStance}, ${(decision.confidence * 100).toFixed(0)}%)`
        );

        if (!decision.shouldReply) return;

        // Cooldown check
        const activity = channelActivity.get(message.channelId);
        if (activity && !isMentioned && now - activity.lastReply < REPLY_COOLDOWN_MS) {
          console.log('[Cooldown] Rate limited');
          return;
        }

        // ── TIER 2: SPEAKER GENERATION ──
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

        // ── Send Reply ──
        const delay = 200 + reply.text.length * 8;
        setTimeout(async () => {
          try {
            await message.reply({
              content: reply.text,
              allowedMentions: { repliedUser: false },
            });

            // Store insight if any
            if (isGuild && reply.insight) {
              await storeInsight(guildId, message.author.id, senderName, reply.insight);
            }

            // Update bond
            if (isGuild && reply.bondDelta !== 0) {
              await updateBondScore(guildId, message.author.id, reply.bondDelta);
            }

            // Track activity
            channelActivity.set(message.channelId, {
              lastReply: Date.now(),
              count: (activity?.count || 0) + 1,
            });

            console.log(`[Reply] ${reply.text.substring(0, 50)}...`);
          } catch (e) {
            console.error('[Send] Failed:', e);
          }
        }, delay);
      } catch (e) {
        console.error('[Handler] Process failed:', e);
      }
    }, windowTime);

    pendingTriggers.set(message.channelId, trigger);
  } catch (e) {
    console.error('[Handler] Outer error:', e);
  }
}

// ─── BOT STARTUP ─────────────────────────────────────────────────────────

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
    console.log(`✓ NotABot online (Groq multi-agent)`);
    botClient?.user?.setPresence({ status: 'online', activities: [{ name: 'messages', type: 0 }] });
    startProfilerLoop(botClient!);
  });

  botClient.on(Events.MessageCreate, (message) => handleMessage(message));

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
