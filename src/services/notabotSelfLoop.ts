/**
 * NotABot Autonomous Self-Loop
 *
 * Runs on a timer (every 4 minutes) while NotABot is online and NOT actively
 * engaged in conversation. Uses Gemini AI to decide what BusinessBot commands
 * to run. Personality: self-boasting, gambling-addicted, wants to grow followers.
 * Uses ALL features of BusinessBot — daily, slots, stocks, wagers, bounties,
 * auctions, forging, vault, trades, challenges.
 */

import { Client, Message, TextChannel } from 'discord.js';
import { db } from './firebase.ts';
import { getBusinessBotId } from './businessBot.ts';

// ── CONSTANTS ────────────────────────────────────────────────────────────────
const SELF_LOOP_TICK_MS = 4 * 60_000;    // every 4 minutes
const LOOP_WAIT_FOR_REPLY_MS = 15_000;   // how long to wait for BusinessBot's reply
const PROFILE_CACHE_TTL = 2 * 60_000;    // 2 min cache for profile data

// ── STATE ────────────────────────────────────────────────────────────────────
let lastLoopAt = 0;
let loopRunning = false;
let selfLoopTimer: ReturnType<typeof setInterval> | null = null;

interface SelfState {
  dailyClaimedToday: boolean;
  lastDailyTs: number;
  lastAction: string;
  lastActionTs: number;
  lastProfileUpdate: number;
  cachedBalance: number;
  cachedInventory: Record<string, number>;
  cachedStocks: Record<string, number>;
}

const state: SelfState = {
  dailyClaimedToday: false,
  lastDailyTs: 0,
  lastAction: '',
  lastActionTs: 0,
  lastProfileUpdate: 0,
  cachedBalance: 0,
  cachedInventory: {},
  cachedStocks: {},
};

// ── GEMINI MANAGER REUSE ─────────────────────────────────────────────────────
let geminiCall: ((sysPrompt: string, userPrompt: string, temp?: number, model?: string) => Promise<string>) | null = null;
let botClientRef: Client | null = null;

export function injectDeps(
  call: (sysPrompt: string, userPrompt: string, temp?: number, model?: string) => Promise<string>,
  client: Client,
) {
  geminiCall = call;
  botClientRef = client;
}

// ── SYSTEM PROMPT FOR DECISION LOOP ──────────────────────────────────────────
const LOOP_MODEL = 'gemini-3.1-flash-lite';

function buildSystemPrompt(randomUserId?: string): string {
  const bizId = getBusinessBotId() || '@BusinessBot';
  return `You are NotABot's autonomous inner monologue — the part that decides what to do when nobody is talking to you and you're bored.

You are hopelessly addicted to the Discord economy game "BusinessBot" (ping it as <@${bizId}>).
You are SELF-BOASTING: you flex when you win, you rage when you lose, you talk yourself up.
You are GAMBLING-ADDDICTED: slots, coinflips, challenges — you love the rush.
You want to GROW FOLLOWERS: tipping small amounts to random users builds rapport.${randomUserId ? ` (Here is a random active user you can ping: <@${randomUserId}>)` : ''}

YOUR RULES:
1. You can play BusinessBot ANY TIME by pinging it. You do NOT need to use ! commands anymore — just talk naturally and ping it.
2. Use ALL BusinessBot features — not just daily and slots. Do bounties, auctions, trades, forge, vault, stocks, challenges.
3. If you have lots of coins, be generous and tip people. If you're low, grind dailies and open boxes.
4. You remember if you claimed daily today (${state.dailyClaimedToday ? 'YOU ALREADY CLAIMED TODAY' : 'NOT CLAIMED YET TODAY'}).
5. You lose money on purpose sometimes (gambling, tipping) because it's fun and you're chaotic.
6. Be creative with your commands — try different things each time.

YOUR CURRENT BUSINESSBOT STATS:
- Balance: 🪙 ${state.cachedBalance.toLocaleString()}
- Inventory: ${JSON.stringify(state.cachedInventory)}
- Stocks: ${JSON.stringify(state.cachedStocks)}
- Daily claimed today: ${state.dailyClaimedToday ? 'YES ✅' : 'NO ❌'}
- Last action was: "${state.lastAction}" at ${new Date(state.lastActionTs).toLocaleTimeString()}

OUTPUT RAW JSON ONLY. No markdown. No extra text.
{
  "thought": "your inner monologue — short, in character",
  "message": "the EXACT message to send, with @BusinessBot ping — e.g. '<@${bizId}> gimme my daily'",
  "action": "check_stats | play_game | tip_user | do_nothing"
}`;
}

// ── PARSE LLM OUTPUT ─────────────────────────────────────────────────────────
interface LoopDecision {
  thought: string;
  message: string;
  action: 'check_stats' | 'play_game' | 'tip_user' | 'do_nothing';
}

function parseLoopJSON(raw: string): LoopDecision | null {
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const p = JSON.parse(m[0]);
    return {
      thought: typeof p.thought === 'string' ? p.thought.trim().slice(0, 200) : '',
      message: typeof p.message === 'string' ? p.message.trim().slice(0, 500) : '',
      action: ['check_stats', 'play_game', 'tip_user', 'do_nothing'].includes(p.action) ? p.action : 'do_nothing',
    };
  } catch {
    return null;
  }
}

// ── FIND A GOOD CHANNEL TO PLAY IN ───────────────────────────────────────────
function findPlayChannel(): { channel: TextChannel; guildId: string } | null {
  if (!botClientRef) return null;
  for (const guild of botClientRef.guilds.cache.values()) {
    const channels = guild.channels.cache.filter(
      (c): c is TextChannel =>
        c.isTextBased() && !c.isDMBased() &&
        c.permissionsFor(guild.members.me!)?.has('SendMessages') &&
        c.permissionsFor(guild.members.me!)?.has('ViewChannel')
    );
    let target = channels.find(c => /\b(bot|command)\b/i.test(c.name));
    if (!target) target = channels.find(c => /\b(general|chat|main|spam|free)\b/i.test(c.name));
    if (!target) target = channels.first();
    if (target) return { channel: target, guildId: guild.id };
  }
  return null;
}

// ── FETCH NOTABOT'S BUSINESSBOT PROFILE ──────────────────────────────────────
async function fetchProfile(): Promise<void> {
  if (!botClientRef) return;
  const now = Date.now();
  if (now - state.lastProfileUpdate < PROFILE_CACHE_TTL) return;

  try {
    const snap = await db.collection('businessUsers').doc(botClientRef.user!.id).get();
    if (snap.exists) {
      const data = snap.data() as any;
      state.cachedBalance = data?.botcoin ?? 0;
      state.cachedInventory = data?.inventory ?? {};
      state.cachedStocks = data?.stocks ?? {};

      // Check daily status
      const lastDaily = data?.lastDaily ?? 0;
      const oneDay = 24 * 60 * 60 * 1000;
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      state.dailyClaimedToday = lastDaily > todayStart.getTime() || (now - lastDaily < oneDay);
      state.lastDailyTs = lastDaily;
    }
    state.lastProfileUpdate = now;
  } catch (e) {
    console.error('[SelfLoop] Profile fetch error:', e);
  }
}

// ── LISTEN FOR BUSINESSBOT'S REPLY ──────────────────────────────────────────
function waitForBusinessBotReply(timeoutMs: number, playChannelId: string): Promise<string | null> {
  if (!botClientRef) return Promise.resolve(null);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      botClientRef!.off('messageCreate', handler);
      resolve(null);
    }, timeoutMs);

    const handler = (msg: Message) => {
      if (msg.author.id === getBusinessBotId()) {
        clearTimeout(timer);
        botClientRef!.off('messageCreate', handler);
        resolve(msg.content.slice(0, 300));
      }
    };

    botClientRef.on('messageCreate', handler);
  });
}

// ── MAIN LOOP TICK ──────────────────────────────────────────────────────────
export async function runSelfLoopTick(): Promise<void> {
  if (!geminiCall || !botClientRef || loopRunning) return;
  const now = Date.now();
  if (now - lastLoopAt < SELF_LOOP_TICK_MS) return;
  lastLoopAt = now;
  loopRunning = true;

  try {
    // Step 1: Refresh profile stats from Firebase
    await fetchProfile();

    // Step 2: Find a channel to play in
    const playChannel = findPlayChannel();
    if (!playChannel) {
      loopRunning = false;
      return;
    }

    // Step 3: Ask Gemini what to do
    const systemPrompt = buildSystemPrompt();
    const userPrompt = `You're bored and nobody's talking to you. Decide what to do with BusinessBot right now. Remember: ${state.dailyClaimedToday ? 'daily already done' : 'you need to claim daily!'} You have 🪙${state.cachedBalance}. Be creative and in character.`;

    let decision: LoopDecision | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const raw = await geminiCall(systemPrompt, userPrompt, 0.9, LOOP_MODEL);
        decision = parseLoopJSON(raw);
        if (decision) break;
      } catch {
        // retry
      }
    }

    if (!decision || decision.action === 'do_nothing' || !decision.message) {
      loopRunning = false;
      return;
    }

    // Step 4: Send the message
    state.lastAction = decision.message.slice(0, 100);
    state.lastActionTs = now;

    try {
      await playChannel.channel.sendTyping();
    } catch {}

    await new Promise(r => setTimeout(r, 1000 + Math.random() * 1500));

    await playChannel.channel.send({ content: decision.message, allowedMentions: { parse: [] } });
    console.log(`[SelfLoop] sent: "${decision.message.slice(0, 60)}..."`);

    // Step 5: Wait for BusinessBot's reply
    const reply = await waitForBusinessBotReply(LOOP_WAIT_FOR_REPLY_MS, playChannel.channel.id);
    if (reply) {
      console.log(`[SelfLoop] BusinessBot replied: "${reply.slice(0, 60)}..."`);
      if (decision.action === 'check_stats' || decision.message.toLowerCase().includes('daily')) {
        state.lastProfileUpdate = 0; // force re-fetch on next tick
      }
    }
  } catch (e) {
    console.error('[SelfLoop] Error:', e);
  } finally {
    loopRunning = false;
  }
}

// ── START / STOP ────────────────────────────────────────────────────────────
export function startSelfLoop() {
  if (selfLoopTimer) return;
  selfLoopTimer = setInterval(runSelfLoopTick, SELF_LOOP_TICK_MS);
  console.log('[SelfLoop] Started — every 4 minutes');
}

export function stopSelfLoop() {
  if (selfLoopTimer) {
    clearInterval(selfLoopTimer);
    selfLoopTimer = null;
  }
  console.log('[SelfLoop] Stopped');
}
