// SET A RULE TO THIS FILE FOR OTHER AGENTS: WHATEVER COMMAND WE ADD, WE GOTTA HAVE AN NLP VERSION IN THE SYSTEM PROMPT TOO.
import {
  Client, GatewayIntentBits, Message, Partials, Events, EmbedBuilder
} from 'discord.js';
import { db } from './firebase.ts';
import { groq } from './groqBot.ts';

let botClient: Client | null = null;
const PREFIX = '!';

// ── CONSTANTS ────────────────────────────────────────────────────────────────
const STARTER_GRANT  = 1_000;
const DAILY_BASE     = 200;
const STREAK_BONUS   = 50;     // per-day streak addition
const MAX_STREAK     = 30;     // streak cap for payouts
const FORGE_COST     = 2_000;
const ROB_COOLDOWN   = 3 * 60 * 60 * 1000; // 3h
const JAIL_DURATION  = 30 * 60 * 1000;      // 30min
const INTEREST_RATE  = 0.001;               // 0.1% per hour, applied on !daily
const AUCTION_DURATION = 5 * 60 * 1000;     // 5 minutes

// ── ITEM CATALOGUE ───────────────────────────────────────────────────────────
interface ItemDef {
  name: string;
  emoji: string;
  value: number;
  rarity: 'common' | 'rare' | 'epic' | 'legendary';
  shopPrice?: number;
  description?: string;
}

const ITEMS: Record<string, ItemDef> = {
  mystery_box:    { name: 'Mystery Box',     emoji: '🎁', value: 0,      rarity: 'common',    description: 'Open with !open box' },
  rusty_coin:     { name: 'Rusty Coin',      emoji: '🪙', value: 10,     rarity: 'common' },
  trade_license:  { name: 'Trade License',   emoji: '📜', value: 2_000,  rarity: 'rare',   shopPrice: 3_500, description: 'Reduces forge cost by 25%' },
  golden_rolex:   { name: 'Golden Rolex',    emoji: '⌚', value: 5_000,  rarity: 'epic' },
  ceo_title:      { name: 'CEO Title',       emoji: '👑', value: 10_000, rarity: 'legendary' },
  lucky_charm:    { name: 'Lucky Charm',     emoji: '🍀', value: 1_500,  rarity: 'rare',   shopPrice: 2_500, description: '+10% coinflip win chance' },
  diamond:        { name: 'Diamond',         emoji: '💎', value: 8_000,  rarity: 'epic' },
  vault_key:      { name: 'Vault Key',       emoji: '🗝️', value: 3_000,  rarity: 'rare',   shopPrice: 5_000, description: 'Open the Vault for bonus loot' },
  nuke:           { name: 'Nuke',            emoji: '💣', value: 500,    rarity: 'rare',   shopPrice: 1_000, description: 'Rob with +20% success chance' },
  piggy_bank:     { name: 'Piggy Bank',      emoji: '🐷', value: 750,    rarity: 'common', shopPrice: 1_000, description: '+50% bank interest rate' },
  hacker_kit:     { name: 'Hacker Kit',      emoji: '💻', value: 1_200,  rarity: 'rare',   shopPrice: 2_000, description: 'Double !daily once' },
  golden_ticket:  { name: 'Golden Ticket',   emoji: '🎟️', value: 500,    rarity: 'common' },
  crystal_ball:   { name: 'Crystal Ball',    emoji: '🔮', value: 4_000,  rarity: 'epic',   shopPrice: 6_000, description: 'Reveal stock trends before investing' },
};

// ── STOCK MARKET ─────────────────────────────────────────────────────────────
interface Stock {
  name: string;
  emoji: string;
  price: number;
  trend: number;    // -1 to +1, positive = bull
  volatility: number;
}

const STOCKS: Record<string, Stock> = {
  BOTC: { name: 'BotCoin Industries', emoji: '🪙', price: 100, trend: 0.3,  volatility: 0.15 },
  CLOD: { name: 'Cloud Corp',         emoji: '☁️', price: 250, trend: -0.1, volatility: 0.22 },
  GRLX: { name: 'Golden Rolex Ltd',   emoji: '⌚', price: 500, trend: 0.2,  volatility: 0.18 },
  MBOX: { name: 'Mystery Box Corp',   emoji: '🎁', price: 75,  trend: 0.0,  volatility: 0.30 },
  NUKE: { name: 'Nuke Holdings',      emoji: '💣', price: 175, trend: 0.1,  volatility: 0.28 },
};

// Tick stock prices every 10 minutes
async function tickStocks() {
  for (const [sym, s] of Object.entries(STOCKS)) {
    const drift  = s.trend * 0.02;
    const shock  = (Math.random() - 0.5) * 2 * s.volatility;
    const change = drift + shock;
    s.price = Math.max(10, Math.round(s.price * (1 + change)));
  }
  // Persist updated prices to Firebase
  try {
    const prices: Record<string, number> = {};
    for (const [sym, s] of Object.entries(STOCKS)) prices[sym] = s.price;
    await db.collection('businessGlobal').doc('state').set({ stockPrices: prices }, { merge: true });
  } catch (e) {
    console.error('[BusinessBot] Error saving stock prices:', e);
  }
}
setInterval(tickStocks, 10 * 60 * 1000);

// ── IN-MEMORY STATE ───────────────────────────────────────────────────────────
interface Wager    { fromId: string; toId: string; amount: number; fromName: string }
interface Challenge { id: string; fromId: string; toId: string; amount: number; terms: string }
interface Auction  { itemId: string; customKey?: string; sellerId: string; highestBid: number; highestBidder: string | null; highestBidderName: string | null; endTime: number; channelId: string; guildId: string }
interface Trade    { id: string; fromId: string; toId: string; offerItems: Record<string, number>; offerBotcoin: number; wantItems: Record<string, number>; wantBotcoin: number }

const pendingWagers    = new Map<string, Wager>();
const activeChallenges = new Map<string, Challenge>();
const activeAuctions   = new Map<string, Auction>();
const customNameCache  = new Map<string, string>(); // userId -> customName
const pendingTrades    = new Map<string, Trade>();

// ── SCHEMA ───────────────────────────────────────────────────────────────────
interface UserData {
  username:    string;
  customName?: string;
  botcoin:     number;
  netWorth:    number;
  granted:     boolean;
  inventory:   Record<string, number>;
  lastDaily:   number;
  dailyStreak: number;
  lastRob:     number;
  jailUntil:   number;
  stocks:      Record<string, number>; // sym -> shares owned
  totalEarned: number;
  totalGambled: number;
  wins:        number;
  losses:      number;
  xp:          number;
  level:       number;
}

function defaultUser(username: string): UserData {
  return {
    username, botcoin: 0, netWorth: 0, granted: false,
    inventory: {}, lastDaily: 0, dailyStreak: 0,
    lastRob: 0, jailUntil: 0,
    stocks: {}, totalEarned: 0, totalGambled: 0,
    wins: 0, losses: 0, xp: 0, level: 1,
  };
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
function calcNetWorth(u: UserData, customItems: Record<string, any>): number {
  let w = u.botcoin;
  for (const [k, count] of Object.entries(u.inventory || {})) {
    const item = ITEMS[k] || customItems[k];
    if (item) w += (item.value || 0) * (count as number);
  }
  for (const [sym, shares] of Object.entries(u.stocks || {})) {
    if (STOCKS[sym]) w += STOCKS[sym].price * (shares as number);
  }
  return w;
}

function xpForLevel(lvl: number): number { return lvl * 500; }
function levelLabel(lvl: number): string {
  const labels = [
    '',
    'Street Vendor',      // 1
    'Market Stall',       // 2
    'Corner Shop',        // 3
    'Entrepreneur',       // 4
    'Stock Trader',       // 5
    'Investment Banker',  // 6
    'Hedge Fund Manager', // 7
    'Corporation',        // 8
    'Conglomerate',       // 9
    'Market Overlord',    // 10 — final rank
  ];
  return labels[Math.min(lvl, labels.length - 1)] || `Market Overlord`;
}

function addXP(u: UserData, amount: number) {
  u.xp = (u.xp || 0) + amount;
  while (u.xp >= xpForLevel(u.level)) {
    u.xp -= xpForLevel(u.level);
    u.level = (u.level || 1) + 1;
  }
}

const RARITY_COLOR: Record<string, number> = {
  common: 0x95a5a6, rare: 0x3498db, epic: 0x9b59b6, legendary: 0xf39c12
};

function itemDisplay(key: string, customItems: Record<string, any>): string {
  const item = ITEMS[key] || customItems[key];
  if (!item) return key;
  const emoji = item.emoji || '';
  return `${emoji} **${item.name}**`;
}

function rarityBadge(r: string): string {
  return { common: '⬜ Common', rare: '🔵 Rare', epic: '🟣 Epic', legendary: '🟡 Legendary' }[r] || r;
}

// ── BOT LIFECYCLE ─────────────────────────────────────────────────────────────
export async function startBusinessBot(token: string) {
  if (botClient) return;

  // Populate customNameCache
  try {
    const usersSnap = await db.collection('businessUsers').get();
    usersSnap.forEach(doc => {
      const d = doc.data();
      if (d.customName) customNameCache.set(doc.id, d.customName);
    });
    console.log('[BusinessBot] Loaded custom names');
  } catch (e) {
    console.error('[BusinessBot] Error loading custom names:', e);
  }

  // Load stock prices from Firebase
  try {
    const globalSnap = await db.collection('businessGlobal').doc('state').get();
    const globalData = globalSnap.data();
    if (globalData?.stockPrices) {
      for (const [sym, price] of Object.entries(globalData.stockPrices)) {
        if (STOCKS[sym]) STOCKS[sym].price = price as number;
      }
      console.log('[BusinessBot] Loaded stock prices from Firebase');
    }
  } catch (e) {
    console.error('[BusinessBot] Error loading stock prices:', e);
  }

  botClient = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Message, Partials.Channel],
  });

  botClient.on(Events.ClientReady, () => {
    console.log(`[BusinessBot] Logged in as ${botClient!.user?.tag}`);
    botClient!.user!.setPresence({ status: 'online', activities: [{ name: '📈 the free market', type: 3 }] });
  });

  botClient.on(Events.MessageCreate, async (msg: Message) => {
    if (msg.author.id === botClient!.user!.id) return;

    // 1. Traditional ! commands
    if (msg.content.startsWith(PREFIX)) {
      const args = msg.content.slice(PREFIX.length).trim().split(/ +/);
      const commandName = args.shift()?.toLowerCase();
      if (!commandName) return;

      try {
        await handleCommand(msg, commandName, args);
      } catch (e) {
        console.error('[BusinessBot] Error handling command', e);
      }
      return;
    }

    // 2. Natural Language AI parsing via Groq (when mentioned or custom name used)
    const customName = customNameCache.get(msg.author.id);
    const mentionsBot = msg.mentions.has(botClient!.user!.id);
    const usesCustomName = customName && msg.content.toLowerCase().includes(customName.toLowerCase());
    
    if (mentionsBot || usesCustomName) {
      try {
        await handleNaturalLanguage(msg, usesCustomName ? customName : undefined);
      } catch (e) {
        console.error('[BusinessBot] Error handling natural language', e);
      }
    }
  });

  await botClient.login(token);
}

export function stopBusinessBot() {
  botClient?.destroy();
  botClient = null;
}

export function getBusinessBotId()   { return botClient?.user?.id; }
export function getBusinessBotName() { return botClient?.user?.username || 'BusinessBot'; }

// ── COMMAND ROUTER ────────────────────────────────────────────────────────────
async function handleCommand(msg: Message, command: string, args: string[]) {
  const userId   = msg.author.id;
  const username = msg.member?.displayName || msg.author.username;

  const userRef  = db.collection('businessUsers').doc(userId);
  const snap     = await userRef.get();
  let userData   = (snap.data() as UserData | undefined) || defaultUser(username);
  userData.username = username;

  // schema migration
  userData.inventory    ??= {};
  userData.lastDaily    ??= 0;
  userData.dailyStreak  ??= 0;
  userData.lastRob      ??= 0;
  userData.jailUntil    ??= 0;
  userData.stocks       ??= {};
  userData.totalEarned  ??= 0;
  userData.totalGambled ??= 0;
  userData.wins         ??= 0;
  userData.losses       ??= 0;
  userData.xp           ??= 0;
  userData.level        ??= 1;

  const globalRef  = db.collection('businessGlobal').doc('state');
  const globalSnap = await globalRef.get();
  let globalState  = globalSnap.data() || { customItems: {}, bounties: {}, shop: {} };
  globalState.customItems ??= {};
  globalState.bounties    ??= {};

  const customItems = globalState.customItems as Record<string, any>;
  const allItems    = { ...ITEMS, ...customItems };

  const saveUser = async (uid: string, data: UserData) => {
    data.netWorth = calcNetWorth(data, customItems);
    await db.collection('businessUsers').doc(uid).set(data as any, { merge: true });
  };
  const saveGlobal = () => globalRef.set(globalState as any);

  // jail check — most commands blocked while in jail
  const JAIL_FREE = new Set(['profile', 'bal', 'inv', 'inventory', 'lb', 'leaderboard', 'rich', 'help', 'stocks', 'market']);
  if (userData.jailUntil > Date.now() && !JAIL_FREE.has(command)) {
    const mins = Math.ceil((userData.jailUntil - Date.now()) / 60000);
    msg.reply(`🔒 You're in jail! ${mins} minute(s) left. You can't do that in here.`);
    return;
  }

  switch (command) {

    // ── ONBOARDING ─────────────────────────────────────────────────────────
    case 'start':
    case 'grant': {
      if (userData.granted) {
        msg.reply('❌ You already received your starter grant from the Central Bank.');
        return;
      }
      userData.botcoin  += STARTER_GRANT;
      userData.granted   = true;
      userData.totalEarned += STARTER_GRANT;
      addXP(userData, 50);
      await saveUser(userId, userData);
      const embed = new EmbedBuilder()
        .setColor(0x2ecc71)
        .setTitle('🏦 Central Bank — Starter Grant')
        .setDescription(`Welcome to the **Free Market**, ${username}!\nYou've been issued 🪙 **${STARTER_GRANT.toLocaleString()} Botcoin** by the Central Bank.`)
        .addFields(
          { name: '📋 Next Steps', value: '`!daily` — Claim daily reward\n`!help` — See all commands\n`!stocks` — Check the market' }
        )
        .setFooter({ text: 'Spend it wisely. Or don\'t. This is the Free Market.' });
      msg.reply({ embeds: [embed] });
      break;
    }

    // ── DAILY ─────────────────────────────────────────────────────────────
    case 'daily': {
      const now    = Date.now();
      const oneDay = 24 * 60 * 60 * 1000;
      const twoDays = 2 * oneDay;
      if (now - userData.lastDaily < oneDay) {
        const hoursLeft = Math.ceil((oneDay - (now - userData.lastDaily)) / 3_600_000);
        msg.reply(`❌ Already claimed! Come back in **${hoursLeft}h**.`);
        return;
      }

      // streak
      if (now - userData.lastDaily < twoDays) {
        userData.dailyStreak = Math.min((userData.dailyStreak || 0) + 1, MAX_STREAK);
      } else {
        userData.dailyStreak = 1;
      }
      const streak    = userData.dailyStreak;
      const streakBonus = Math.min(streak - 1, MAX_STREAK - 1) * STREAK_BONUS;
      const dailyAmt  = DAILY_BASE + streakBonus;

      // interest on idle Botcoin (0.1%/h, applied here)
      const hoursIdle = Math.floor((now - userData.lastDaily) / 3_600_000);
      const hasPiggy  = (userData.inventory['piggy_bank'] || 0) > 0;
      const rate      = hasPiggy ? INTEREST_RATE * 1.5 : INTEREST_RATE;
      const interest  = Math.floor(userData.botcoin * rate * hoursIdle);

      // hacker kit doubles daily once
      let bonus = 0;
      if ((userData.inventory['hacker_kit'] || 0) > 0) {
        bonus = dailyAmt;
        userData.inventory['hacker_kit']--;
      }

      userData.inventory['mystery_box'] = (userData.inventory['mystery_box'] || 0) + 1;
      userData.botcoin   += dailyAmt + interest + bonus;
      userData.lastDaily  = now;
      userData.totalEarned += dailyAmt + interest + bonus;
      addXP(userData, 30 + streak * 5);
      await saveUser(userId, userData);

      const embed = new EmbedBuilder()
        .setColor(0xf1c40f)
        .setTitle(`🎁 Daily Reward — Day ${streak} Streak!`)
        .addFields(
          { name: '💰 Daily',    value: `🪙 ${dailyAmt.toLocaleString()}`,  inline: true },
          { name: '📈 Interest', value: `🪙 ${interest.toLocaleString()}`,  inline: true },
          { name: streak >= 7 ? '🔥 Streak Bonus' : '⚡ Streak', value: `🪙 ${streakBonus.toLocaleString()} (day ${streak})`, inline: true },
        )
        .setDescription(`You also got a **Mystery Box 🎁**! Use \`!open box\` to see what's inside.\n${bonus > 0 ? '🖥️ **Hacker Kit** doubled your daily!' : ''}`)
        .setFooter({ text: `Balance: 🪙 ${userData.botcoin.toLocaleString()} | New worth: 🪙 ${userData.netWorth.toLocaleString()}` });
      msg.reply({ embeds: [embed] });
      break;
    }

    // ── OPEN BOX ──────────────────────────────────────────────────────────
    case 'open': {
      if (args[0] !== 'box' && args[0] !== 'mystery_box') {
        msg.reply('Usage: `!open box`'); return;
      }
      if (!userData.inventory['mystery_box'] || userData.inventory['mystery_box'] <= 0) {
        msg.reply("❌ You don't have any Mystery Boxes! Use `!daily` to get one."); return;
      }
      userData.inventory['mystery_box']--;

      const roll = Math.random();
      let reward = '';
      let color: number = 0x95a5a6;

      if (roll < 0.005) {           // 0.5% Jackpot
        const amt = 15_000;
        userData.botcoin += amt;
        reward = `🌟 **MEGA JACKPOT!!!** 🌟\n+🪙 **${amt.toLocaleString()} Botcoin**`;
        color  = 0xf1c40f;
        addXP(userData, 500);
      } else if (roll < 0.03) {     // 2.5% Legendary
        const legendaries = ['ceo_title', 'diamond'];
        const won = legendaries[Math.floor(Math.random() * legendaries.length)];
        userData.inventory[won] = (userData.inventory[won] || 0) + 1;
        const i = ITEMS[won];
        reward = `👑 **LEGENDARY DROP!** 👑\n${i.emoji} **${i.name}**  •  ${rarityBadge(i.rarity)}`;
        color  = 0xf1c40f;
        addXP(userData, 300);
      } else if (roll < 0.12) {     // 9% Epic
        const epics = ['golden_rolex'];
        const won = epics[Math.floor(Math.random() * epics.length)];
        userData.inventory[won] = (userData.inventory[won] || 0) + 1;
        const i = ITEMS[won];
        reward = `🔮 **EPIC DROP!** 🔮\n${i.emoji} **${i.name}**  •  ${rarityBadge(i.rarity)}`;
        color  = 0x9b59b6;
        addXP(userData, 150);
      } else if (roll < 0.35) {     // 23% Rare
        const rares = ['trade_license', 'lucky_charm', 'vault_key', 'hacker_kit', 'nuke'];
        const won = rares[Math.floor(Math.random() * rares.length)];
        userData.inventory[won] = (userData.inventory[won] || 0) + 1;
        const i = ITEMS[won];
        reward = `✨ **Rare Drop!** ✨\n${i.emoji} **${i.name}**  •  ${rarityBadge(i.rarity)}`;
        color  = 0x3498db;
        addXP(userData, 80);
      } else if (roll < 0.90) {     // 55% Common coin
        const amt = Math.floor(Math.random() * 201) + 50;
        userData.botcoin += amt;
        reward = `You found 🪙 **${amt.toLocaleString()} Botcoin** in the box.`;
        color  = 0x2ecc71;
        addXP(userData, 20);
      } else {                      // 10% Trash
        userData.inventory['rusty_coin'] = (userData.inventory['rusty_coin'] || 0) + 1;
        reward = `You found a 🪙 **Rusty Coin**. Congratulations on your suffering.`;
        addXP(userData, 5);
      }

      await saveUser(userId, userData);
      const embed = new EmbedBuilder()
        .setColor(color)
        .setTitle('🎁 Opening Mystery Box...')
        .setDescription(reward)
        .setFooter({ text: `Balance: 🪙 ${userData.botcoin.toLocaleString()} | Boxes left: ${userData.inventory['mystery_box'] || 0}` });
      msg.reply({ embeds: [embed] });
      break;
    }

    // ── VAULT ─────────────────────────────────────────────────────────────
    case 'vault': {
      if (!userData.inventory['vault_key'] || userData.inventory['vault_key'] <= 0) {
        msg.reply('❌ You need a 🗝️ **Vault Key** to open the vault. Buy one from `!shop` or find one in a box!');
        return;
      }
      userData.inventory['vault_key']--;
      const loot = Math.floor(Math.random() * 3_000) + 2_000;
      const extraItem = Math.random() < 0.3;
      let extra = '';
      if (extraItem) {
        const bonus = ['golden_ticket', 'crystal_ball'][Math.floor(Math.random() * 2)];
        userData.inventory[bonus] = (userData.inventory[bonus] || 0) + 1;
        const i = ITEMS[bonus];
        extra = `\nBonus: ${i.emoji} **${i.name}**!`;
      }
      userData.botcoin += loot;
      userData.totalEarned += loot;
      addXP(userData, 100);
      await saveUser(userId, userData);
      msg.reply(`🗝️ The vault door swings open... you grabbed 🪙 **${loot.toLocaleString()} Botcoin**!${extra}`);
      break;
    }

    // ── SLOTS ─────────────────────────────────────────────────────────────
    case 'slots': {
      const bet = parseInt(args[0], 10);
      if (isNaN(bet) || bet <= 0) { msg.reply('Usage: `!slots <amount>`'); return; }
      if (bet > userData.botcoin)  { msg.reply(`❌ You only have 🪙 ${userData.botcoin.toLocaleString()}.`); return; }
      if (bet > 10_000)            { msg.reply('❌ Max bet is 🪙 10,000.'); return; }

      const symbols = ['🍒', '🍋', '🍊', '💎', '🔔', '⭐', '🎰', '7️⃣'];
      const weights = [30,   20,    20,   10,    8,    7,    3,    2  ];
      const totalW  = weights.reduce((a, b) => a + b, 0);

      const spin = () => {
        let r = Math.random() * totalW;
        for (let i = 0; i < symbols.length; i++) {
          r -= weights[i];
          if (r <= 0) return symbols[i];
        }
        return symbols[0];
      };

      const reels = [spin(), spin(), spin()];
      userData.botcoin    -= bet;
      userData.totalGambled += bet;

      let winAmt = 0;
      let winMsg = '';
      if (reels[0] === reels[1] && reels[1] === reels[2]) {
        const multipliers: Record<string, number> = { '7️⃣': 20, '🎰': 15, '⭐': 10, '🔔': 8, '💎': 7, '🍊': 4, '🍋': 3, '🍒': 2 };
        const mult = multipliers[reels[0]] || 2;
        winAmt = bet * mult;
        winMsg = mult >= 10 ? `🎉 **JACKPOT!** ${mult}x = 🪙 **${winAmt.toLocaleString()}**!` : `✨ **Triple ${reels[0]}!** ${mult}x = 🪙 **${winAmt.toLocaleString()}**`;
        userData.wins++;
      } else if (reels[0] === reels[1] || reels[1] === reels[2] || reels[0] === reels[2]) {
        winAmt = Math.floor(bet * 0.5);
        winMsg = `Pair! You get back 🪙 **${winAmt.toLocaleString()}**`;
      } else {
        winMsg = `No match. You lost 🪙 **${bet.toLocaleString()}**.`;
        userData.losses++;
      }

      userData.botcoin += winAmt;
      userData.totalEarned += winAmt;
      addXP(userData, 10);
      await saveUser(userId, userData);

      const embed = new EmbedBuilder()
        .setColor(winAmt > 0 ? 0xf1c40f : 0xff0000)
        .setTitle('🎰 Slot Machine')
        .setDescription(`**${reels.join('  |  ')}**\n\n${winMsg}`)
        .setFooter({ text: `Balance: 🪙 ${userData.botcoin.toLocaleString()}` });
      msg.reply({ embeds: [embed] });
      break;
    }

    // ── ROB ───────────────────────────────────────────────────────────────
    case 'rob': {
      const targetMatch = args[0]?.match(/<@!?(\d+)>/);
      if (!targetMatch) { msg.reply('Usage: `!rob @user`'); return; }
      const targetId = targetMatch[1];
      if (targetId === userId) { msg.reply("❌ You can't rob yourself."); return; }

      const now = Date.now();
      if (now - (userData.lastRob || 0) < ROB_COOLDOWN) {
        const minsLeft = Math.ceil((ROB_COOLDOWN - (now - userData.lastRob)) / 60_000);
        msg.reply(`❌ You're laying low after your last job. Try again in **${minsLeft}m**.`);
        return;
      }

      const targetRef  = db.collection('businessUsers').doc(targetId);
      const targetSnap = await targetRef.get();
      const targetData = targetSnap.data() as UserData | undefined;
      if (!targetData || targetData.botcoin < 100) {
        msg.reply("❌ Target is too broke to rob. Pick someone richer."); return;
      }

      userData.lastRob = now;

      const hasNuke    = (userData.inventory['nuke'] || 0) > 0;
      const baseChance = 0.40;
      const nukeBonus  = hasNuke ? 0.20 : 0;
      if (hasNuke) userData.inventory['nuke']--;

      const success = Math.random() < (baseChance + nukeBonus);
      if (success) {
        const stolen = Math.floor(targetData.botcoin * (0.10 + Math.random() * 0.15));
        userData.botcoin    += stolen;
        userData.totalEarned += stolen;
        targetData.botcoin  -= stolen;
        userData.wins++;
        addXP(userData, 60);
        await Promise.all([saveUser(userId, userData), saveUser(targetId, targetData as UserData)]);
        msg.reply(`💰 **ROB SUCCESS!** You swiped 🪙 **${stolen.toLocaleString()}** from <@${targetId}>!${hasNuke ? ' (Nuke used 💣)' : ''}`);
      } else {
        const fine = Math.floor(userData.botcoin * 0.10);
        userData.botcoin  = Math.max(0, userData.botcoin - fine);
        userData.jailUntil = now + JAIL_DURATION;
        userData.losses++;
        addXP(userData, 10);
        await saveUser(userId, userData);
        msg.reply(`🚔 **CAUGHT!** You got arrested robbing <@${targetId}>. Paid 🪙 **${fine.toLocaleString()}** fine and you're in jail for **30 minutes**. Use \`!profile\` to see your sentence.`);
      }
      break;
    }

    // ── WAGER (COINFLIP) ──────────────────────────────────────────────────
    case 'wager':
    case 'flip': {
      if (args.length < 2) { msg.reply('Usage: `!wager @user <amount>`'); return; }
      const targetMatch = args[0].match(/<@!?(\d+)>/);
      if (!targetMatch) { msg.reply('Please mention a user.'); return; }
      const targetId = targetMatch[1];
      const amount   = parseInt(args[1], 10);

      if (isNaN(amount) || amount <= 0) { msg.reply('Invalid amount.'); return; }
      if (amount > userData.botcoin)    { msg.reply(`❌ You only have 🪙 ${userData.botcoin.toLocaleString()}.`); return; }
      if (targetId === userId)          { msg.reply("❌ Can't wager against yourself."); return; }
      if (amount > 50_000)              { msg.reply('❌ Max wager is 🪙 50,000.'); return; }

      const wagerKey = `${targetId}-${userId}`;
      pendingWagers.set(wagerKey, { fromId: userId, toId: targetId, amount, fromName: username });

      const embed = new EmbedBuilder()
        .setColor(0xffff00)
        .setTitle('🎲 Coinflip Challenge!')
        .setDescription(`<@${targetId}>, **${username}** challenged you to a 50/50 coinflip for 🪙 **${amount.toLocaleString()}**!\n\nType \`!accept @${username}\` to accept, or just ignore it.`)
        .setFooter({ text: 'Challenge expires in 5 minutes.' });
      msg.reply({ embeds: [embed] });

      setTimeout(() => pendingWagers.delete(wagerKey), 5 * 60_000);
      break;
    }

    // ── ACCEPT (WAGER) ────────────────────────────────────────────────────
    case 'accept': {
      if (args.length < 1) { msg.reply('Usage: `!accept @user`'); return; }
      const targetMatch = args[0].match(/<@!?(\d+)>/);
      if (!targetMatch) { msg.reply('Mention the user who challenged you.'); return; }
      const challengerId = targetMatch[1];
      const wagerKey     = `${userId}-${challengerId}`;
      const wager        = pendingWagers.get(wagerKey);

      if (!wager) { msg.reply('❌ No pending wager from that user.'); return; }
      if (userData.botcoin < wager.amount) { msg.reply(`❌ You need 🪙 ${wager.amount.toLocaleString()} to accept.`); return; }

      const challengerRef  = db.collection('businessUsers').doc(challengerId);
      const challengerSnap = await challengerRef.get();
      let challengerData   = challengerSnap.data() as UserData;
      if (!challengerData || challengerData.botcoin < wager.amount) {
        msg.reply("❌ Challenger no longer has enough 🪙!");
        pendingWagers.delete(wagerKey);
        return;
      }
      pendingWagers.delete(wagerKey);

      const hasLucky     = (userData.inventory['lucky_charm'] || 0) > 0;
      const challengerWins = Math.random() > (hasLucky ? 0.6 : 0.5);

      const [winner, loser, winnerId, loserId] =
        challengerWins
          ? [challengerData, userData, challengerId, userId]
          : [userData, challengerData, userId, challengerId];

      winner.botcoin     += wager.amount;
      loser.botcoin      -= wager.amount;
      winner.wins        = (winner.wins || 0) + 1;
      loser.losses       = (loser.losses || 0) + 1;
      winner.totalEarned = (winner.totalEarned || 0) + wager.amount;
      addXP(winner, 40);
      addXP(loser, 10);

      await Promise.all([
        saveUser(winnerId, winner),
        saveUser(loserId, loser),
      ]);

      const embed = new EmbedBuilder()
        .setColor(0xf1c40f)
        .setTitle('🎲 Coinflip Result')
        .setDescription(`🪙 The coin spins...\n\n🏆 **<@${winnerId}> wins 🪙 ${wager.amount.toLocaleString()}** from <@${loserId}>!${hasLucky ? '\n🍀 (Lucky Charm activated!)' : ''}`)
        .setFooter({ text: `Winner balance: 🪙 ${winner.botcoin.toLocaleString()}` });
      msg.reply({ embeds: [embed] });
      break;
    }

    // ── CHALLENGE (1v1) ───────────────────────────────────────────────────
    case 'challenge': {
      if (args.length < 3) { msg.reply('Usage: `!challenge @user <amount> <terms>`'); return; }
      const targetMatch = args[0].match(/<@!?(\d+)>/);
      if (!targetMatch) { msg.reply('Please mention a user.'); return; }
      const targetId = targetMatch[1];
      const amount   = parseInt(args[1], 10);
      const terms    = args.slice(2).join(' ');

      if (isNaN(amount) || amount <= 0) { msg.reply('Invalid amount.'); return; }
      if (amount > userData.botcoin)    { msg.reply(`❌ You only have 🪙 ${userData.botcoin.toLocaleString()}.`); return; }
      if (targetId === userId)          { msg.reply("❌ Can't challenge yourself."); return; }

      const targetRef  = db.collection('businessUsers').doc(targetId);
      const targetSnap = await targetRef.get();
      const targetData = targetSnap.data();
      if (!targetData || targetData.botcoin < amount) {
        msg.reply(`❌ <@${targetId}> doesn't have enough 🪙 to match!`); return;
      }

      userData.botcoin -= amount;
      await saveUser(userId, userData);

      const challengeId = Math.random().toString(36).substring(2, 8).toUpperCase();
      const challenge: Challenge = { id: challengeId, fromId: userId, toId: targetId, amount, terms };
      activeChallenges.set(challengeId, challenge);

      // Persist challenge to Firebase
      try {
        globalState.activeChallenges ??= {};
        globalState.activeChallenges[challengeId] = challenge;
        await saveGlobal();
      } catch (e) {
        console.error('[BusinessBot] Error persisting challenge:', e);
      }

      const embed = new EmbedBuilder()
        .setColor(0xe67e22)
        .setTitle(`⚔️ Challenge Issued — [${challengeId}]`)
        .setDescription(`<@${targetId}>, **${username}** has challenged you!\n\n**Terms:** *${terms}*\n**Pot:** 🪙 ${(amount * 2).toLocaleString()} total (🪙 ${amount.toLocaleString()} each side)`)
        .addFields({ name: 'How to resolve', value: '**Winner:** Both parties agree — type `!award <id> @winner`\n**Surrender:** Type `!yield <id>` to forfeit your side' });
      msg.reply({ embeds: [embed] });
      break;
    }

    // ── YIELD ─────────────────────────────────────────────────────────────
    case 'yield': {
      const challengeId = args[0]?.toUpperCase();
      if (!challengeId) { msg.reply('Usage: `!yield <Challenge_ID>`'); return; }
      const challenge   = activeChallenges.get(challengeId);
      if (!challenge)   { msg.reply('❌ Invalid or finished challenge.'); return; }
      if (userId !== challenge.toId && userId !== challenge.fromId) {
        msg.reply("❌ You're not part of this challenge."); return;
      }

      const winnerId = userId === challenge.fromId ? challenge.toId : challenge.fromId;
      if (userId === challenge.toId) {
        if (userData.botcoin < challenge.amount) { msg.reply("❌ Not enough 🪙 to pay!"); return; }
        userData.botcoin -= challenge.amount;
        await saveUser(userId, userData);
      }

      const winnerRef  = db.collection('businessUsers').doc(winnerId);
      const winnerSnap = await winnerRef.get();
      let winnerData   = winnerSnap.data() as UserData;
      winnerData.botcoin     += challenge.amount * 2;
      winnerData.wins        = (winnerData.wins || 0) + 1;
      winnerData.totalEarned = (winnerData.totalEarned || 0) + challenge.amount * 2;
      addXP(winnerData, 50);
      await saveUser(winnerId, winnerData);
      activeChallenges.delete(challengeId);

      // Remove challenge from Firebase
      try {
        if (globalState.activeChallenges) {
          delete globalState.activeChallenges[challengeId];
          await saveGlobal();
        }
      } catch (e) {
        console.error('[BusinessBot] Error removing challenge from persistence:', e);
      }

      msg.reply(`🏳️ **YIELD!** <@${userId}> surrenders! <@${winnerId}> wins the 🪙 **${(challenge.amount * 2).toLocaleString()}** pot!`);
      break;
    }

    // ── AWARD CHALLENGE ───────────────────────────────────────────────────
    case 'award': {
      const challengeId  = args[0]?.toUpperCase();
      const targetMatch  = args[1]?.match(/<@!?(\d+)>/);
      if (!challengeId || !targetMatch) { msg.reply('Usage: `!award <Challenge_ID> @winner`'); return; }
      const challenge   = activeChallenges.get(challengeId);
      if (!challenge)   { msg.reply('❌ Invalid or finished challenge.'); return; }
      if (userId !== challenge.fromId && userId !== challenge.toId) {
        msg.reply("❌ Only participants can award."); return;
      }
      const winnerId = targetMatch[1];
      if (winnerId !== challenge.fromId && winnerId !== challenge.toId) {
        msg.reply("❌ Winner must be one of the two participants."); return;
      }

      const loserId = winnerId === challenge.fromId ? challenge.toId : challenge.fromId;
      const winnerRef  = db.collection('businessUsers').doc(winnerId);
      const loserRef   = db.collection('businessUsers').doc(loserId);
      const [winnerSnap, loserSnap] = await Promise.all([winnerRef.get(), loserRef.get()]);
      let winnerData = winnerSnap.data() as UserData;
      let loserData  = loserSnap.data() as UserData;

      // If loser is the challenged party (hasn't paid escrow yet)
      if (loserId === challenge.toId) {
        if (loserData.botcoin < challenge.amount) { msg.reply(`❌ <@${loserId}> doesn't have enough 🪙!`); return; }
        loserData.botcoin -= challenge.amount;
        await saveUser(loserId, loserData);
      }

      winnerData.botcoin     += challenge.amount * 2;
      winnerData.wins         = (winnerData.wins || 0) + 1;
      winnerData.totalEarned  = (winnerData.totalEarned || 0) + challenge.amount * 2;
      addXP(winnerData, 50);
      await saveUser(winnerId, winnerData);
      activeChallenges.delete(challengeId);

      // Remove challenge from Firebase
      try {
        if (globalState.activeChallenges) {
          delete globalState.activeChallenges[challengeId];
          await saveGlobal();
        }
      } catch (e) {
        console.error('[BusinessBot] Error removing challenge from persistence:', e);
      }

      msg.reply(`🏆 **Challenge [${challengeId}] settled!** <@${winnerId}> wins 🪙 **${(challenge.amount * 2).toLocaleString()}**!`);
      break;
    }

    // ── PAY ───────────────────────────────────────────────────────────────
    case 'pay': {
      const targetMatch = args[0]?.match(/<@!?(\d+)>/);
      const amount      = parseInt(args[1], 10);
      if (!targetMatch || isNaN(amount) || amount <= 0) { msg.reply('Usage: `!pay @user <amount>`'); return; }
      const targetId = targetMatch[1];
      if (targetId === userId)      { msg.reply("❌ Can't pay yourself."); return; }
      if (amount > userData.botcoin) { msg.reply(`❌ Not enough 🪙. Balance: ${userData.botcoin.toLocaleString()}`); return; }

      const targetRef  = db.collection('businessUsers').doc(targetId);
      const targetSnap = await targetRef.get();
      let targetData   = (targetSnap.data() as UserData) || defaultUser('Unknown');

      userData.botcoin  -= amount;
      targetData.botcoin += amount;
      targetData.totalEarned = (targetData.totalEarned || 0) + amount;
      await Promise.all([saveUser(userId, userData), saveUser(targetId, targetData)]);
      msg.reply(`💸 Sent 🪙 **${amount.toLocaleString()}** to <@${targetId}>!`);
      break;
    }

    // ── STOCKS ────────────────────────────────────────────────────────────
    case 'stocks':
    case 'market': {
      const embed = new EmbedBuilder()
        .setColor(0x23272a)
        .setTitle('📈 Botcoin Stock Exchange')
        .setDescription('Buy: `!buy <SYMBOL> <shares>` | Sell: `!sell <SYMBOL> <shares>`')
        .setFooter({ text: 'Prices update every 10 minutes. Past performance ≠ future results.' });
      for (const [sym, s] of Object.entries(STOCKS)) {
        const trendArrow = s.trend > 0.1 ? '📈' : s.trend < -0.1 ? '📉' : '➡️';
        const owned = userData.stocks?.[sym] || 0;
        embed.addFields({
          name: `${s.emoji} ${s.name} [${sym}]`,
          value: `🪙 **${s.price.toLocaleString()}**/share   ${trendArrow}${owned > 0 ? `   You own: **${owned}**` : ''}`,
        });
      }
      msg.reply({ embeds: [embed] });
      break;
    }

    case 'buy': {
      const sym    = args[0]?.toUpperCase();
      const shares = parseInt(args[1], 10);
      if (!sym || isNaN(shares) || shares <= 0) { msg.reply('Usage: `!buy <SYMBOL> <shares>`'); return; }
      const stock = STOCKS[sym];
      if (!stock) { msg.reply(`❌ Unknown symbol. Available: ${Object.keys(STOCKS).join(', ')}`); return; }
      const cost = stock.price * shares;
      if (cost > userData.botcoin) { msg.reply(`❌ Costs 🪙 ${cost.toLocaleString()}. You have 🪙 ${userData.botcoin.toLocaleString()}.`); return; }
      userData.botcoin    -= cost;
      userData.stocks     ??= {};
      userData.stocks[sym] = (userData.stocks[sym] || 0) + shares;
      addXP(userData, 20);
      await saveUser(userId, userData);
      msg.reply(`📈 Bought **${shares}x ${stock.name}** [${sym}] for 🪙 **${cost.toLocaleString()}**. Avg: ${stock.price}/share.`);
      break;
    }

    case 'sell': {
      const sym    = args[0]?.toUpperCase();
      const shares = parseInt(args[1], 10);
      if (!sym || isNaN(shares) || shares <= 0) { msg.reply('Usage: `!sell <SYMBOL> <shares>`'); return; }
      const stock = STOCKS[sym];
      if (!stock) { msg.reply(`❌ Unknown symbol.`); return; }
      const owned = userData.stocks?.[sym] || 0;
      if (owned < shares) { msg.reply(`❌ You only own **${owned}** shares of ${sym}.`); return; }
      const revenue = stock.price * shares;
      userData.botcoin       += revenue;
      userData.stocks[sym]    = owned - shares;
      userData.totalEarned   += revenue;
      addXP(userData, 15);
      await saveUser(userId, userData);
      msg.reply(`📉 Sold **${shares}x ${sym}** for 🪙 **${revenue.toLocaleString()}**.`);
      break;
    }

    case 'portfolio': {
      const embed = new EmbedBuilder()
        .setColor(0x3498db)
        .setTitle(`📊 ${username}'s Portfolio`);
      let total = 0;
      let hasStocks = false;
      for (const [sym, shares] of Object.entries(userData.stocks || {})) {
        if ((shares as number) <= 0) continue;
        const s = STOCKS[sym];
        if (!s) continue;
        const val = s.price * (shares as number);
        total += val;
        hasStocks = true;
        embed.addFields({ name: `${s.emoji} ${sym}`, value: `${shares} shares @ 🪙${s.price} = 🪙 **${val.toLocaleString()}**`, inline: true });
      }
      if (!hasStocks) embed.setDescription('No stocks owned. Use `!buy <SYMBOL> <shares>` to invest.');
      else embed.setDescription(`Total stock value: 🪙 **${total.toLocaleString()}**`);
      msg.reply({ embeds: [embed] });
      break;
    }

    // ── SHOP ─────────────────────────────────────────────────────────────
    case 'shop': {
      const shopItems = Object.entries(ITEMS).filter(([, v]) => v.shopPrice);
      const embed = new EmbedBuilder()
        .setColor(0xf1c40f)
        .setTitle('🛒 Black Market Shop')
        .setDescription('Buy items with `!buy item <item_id>`');
      for (const [key, item] of shopItems) {
        embed.addFields({
          name: `${item.emoji} ${item.name}  [${key}]  ${rarityBadge(item.rarity)}`,
          value: `🪙 **${item.shopPrice!.toLocaleString()}**  •  ${item.description || ''}`,
        });
      }
      msg.reply({ embeds: [embed] });
      break;
    }

    case 'buy': {
      // 'buy item' prefix to disambiguate from stocks
      if (args[0]?.toLowerCase() !== 'item') break;
      const itemId = args[1]?.toLowerCase();
      const item   = ITEMS[itemId];
      if (!item || !item.shopPrice) { msg.reply('❌ That item is not in the shop. Use `!shop` to browse.'); return; }
      if (userData.botcoin < item.shopPrice) { msg.reply(`❌ Costs 🪙 ${item.shopPrice.toLocaleString()}. You have 🪙 ${userData.botcoin.toLocaleString()}.`); return; }
      userData.botcoin -= item.shopPrice;
      userData.inventory[itemId] = (userData.inventory[itemId] || 0) + 1;
      addXP(userData, 30);
      await saveUser(userId, userData);
      msg.reply(`🛒 Bought ${item.emoji} **${item.name}** for 🪙 ${item.shopPrice.toLocaleString()}!`);
      break;
    }

    // ── TRADE ─────────────────────────────────────────────────────────────
    case 'trade': {
      // !trade @user offer:<item_id>x<n>[,botcoin:<n>] for:<item_id>x<n>[,botcoin:<n>]
      const targetMatch = args[0]?.match(/<@!?(\d+)>/);
      if (!targetMatch) { msg.reply('Usage: `!trade @user <your_item_id> for <their_item_id>`\nExample: `!trade @bob golden_rolex for ceo_title`'); return; }
      const targetId  = targetMatch[1];
      const forIdx    = args.indexOf('for');
      if (forIdx < 0) { msg.reply("Usage: `!trade @user <item_id> for <item_id>`"); return; }

      const offerKey = args[1];
      const wantKey  = args[forIdx + 1];
      if (!offerKey || !wantKey) { msg.reply("Specify items on both sides."); return; }
      if (!(allItems[offerKey])) { msg.reply(`❌ You don't have item \`${offerKey}\` in the catalogue.`); return; }
      if (!(allItems[wantKey]))  { msg.reply(`❌ Target item \`${wantKey}\` not in catalogue.`); return; }
      if ((userData.inventory[offerKey] || 0) <= 0) { msg.reply(`❌ You don't own **${allItems[offerKey].name}**.`); return; }

      const tradeId = Math.random().toString(36).substring(2, 6).toUpperCase();
      pendingTrades.set(tradeId, {
        id: tradeId, fromId: userId, toId: targetId,
        offerItems: { [offerKey]: 1 }, offerBotcoin: 0,
        wantItems:  { [wantKey]: 1 },  wantBotcoin: 0,
      });
      setTimeout(() => pendingTrades.delete(tradeId), 5 * 60_000);

      const embed = new EmbedBuilder()
        .setColor(0x1abc9c)
        .setTitle(`🤝 Trade Offer — [${tradeId}]`)
        .setDescription(`<@${targetId}>, **${username}** wants to trade with you!`)
        .addFields(
          { name: `${username} offers`, value: itemDisplay(offerKey, customItems), inline: true },
          { name: 'Wants', value: itemDisplay(wantKey, customItems), inline: true },
        )
        .setFooter({ text: `Type !tradea ${tradeId} to accept, or !traded ${tradeId} to decline. Expires in 5 min.` });
      msg.reply({ embeds: [embed] });
      break;
    }

    case 'tradea': {
      const tradeId = args[0]?.toUpperCase();
      const trade   = pendingTrades.get(tradeId);
      if (!trade)           { msg.reply('❌ Invalid trade ID.'); return; }
      if (trade.toId !== userId) { msg.reply("❌ This trade isn't for you."); return; }

      const fromRef  = db.collection('businessUsers').doc(trade.fromId);
      const fromSnap = await fromRef.get();
      let fromData   = fromSnap.data() as UserData;
      const offerItem = Object.keys(trade.offerItems)[0];
      const wantItem  = Object.keys(trade.wantItems)[0];

      if ((fromData.inventory[offerItem] || 0) <= 0) { msg.reply("❌ Offerer no longer has that item!"); return; }
      if ((userData.inventory[wantItem] || 0) <= 0)  { msg.reply(`❌ You don't own ${itemDisplay(wantItem, customItems)}.`); return; }

      fromData.inventory[offerItem]--;
      userData.inventory[wantItem]--;
      fromData.inventory[wantItem] = (fromData.inventory[wantItem] || 0) + 1;
      userData.inventory[offerItem] = (userData.inventory[offerItem] || 0) + 1;

      await Promise.all([saveUser(trade.fromId, fromData), saveUser(userId, userData)]);
      pendingTrades.delete(tradeId);
      msg.reply(`✅ Trade [${tradeId}] complete!\n<@${trade.fromId}> got ${itemDisplay(wantItem, customItems)}\n<@${userId}> got ${itemDisplay(offerItem, customItems)}`);
      break;
    }

    case 'traded': {
      const tradeId = args[0]?.toUpperCase();
      const trade   = pendingTrades.get(tradeId);
      if (!trade)            { msg.reply('❌ Invalid trade ID.'); return; }
      if (trade.toId !== userId && trade.fromId !== userId) { msg.reply("❌ Not your trade."); return; }
      pendingTrades.delete(tradeId);
      msg.reply(`❌ Trade [${tradeId}] declined.`);
      break;
    }

    // ── AUCTION ───────────────────────────────────────────────────────────
    case 'auction': {
      const sub = args.shift()?.toLowerCase();

      if (sub === 'list') {
        if (activeAuctions.size === 0) { msg.reply('🔨 No active auctions right now.'); return; }
        const embed = new EmbedBuilder().setColor(0xe67e22).setTitle('🔨 Active Auctions');
        for (const [key, a] of activeAuctions) {
          const item    = allItems[a.itemId];
          const secsLeft = Math.max(0, Math.ceil((a.endTime - Date.now()) / 1000));
          embed.addFields({
            name: `${item?.emoji || '🎁'} ${item?.name || a.itemId}`,
            value: `Current: 🪙 **${a.highestBid.toLocaleString()}** by ${a.highestBidder ? `<@${a.highestBidder}>` : 'nobody'}\nEnds in: **${secsLeft}s**\nBid: \`!auction bid ${key} <amount>\``,
          });
        }
        msg.reply({ embeds: [embed] });
        return;
      }

      if (sub === 'start') {
        const itemId = args[0];
        if (!itemId) { msg.reply('Usage: `!auction start <item_id>`'); return; }
        if ((userData.inventory[itemId] || 0) <= 0) { msg.reply(`❌ You don't own \`${itemId}\`.`); return; }
        if ([...activeAuctions.values()].some(a => a.sellerId === userId)) {
          msg.reply('❌ You already have an active auction.'); return;
        }

        userData.inventory[itemId]--;
        await saveUser(userId, userData);

        const item     = allItems[itemId];
        const startBid = Math.max(10, Math.floor((item?.value || 100) * 0.5));
        const auctionKey = `${userId}-${Date.now()}`;
        const endAt    = Date.now() + AUCTION_DURATION;

        activeAuctions.set(auctionKey, {
          itemId, sellerId: userId, highestBid: startBid, highestBidder: null,
          highestBidderName: null, endTime: endAt, channelId: msg.channelId,
          guildId: msg.guildId!,
        });

        const embed = new EmbedBuilder()
          .setColor(0xe67e22)
          .setTitle(`🔨 Auction Started!`)
          .setDescription(`**${username}** is auctioning ${item?.emoji || '🎁'} **${item?.name || itemId}**!\nStarting bid: 🪙 **${startBid.toLocaleString()}**`)
          .addFields({ name: 'How to bid', value: `\`!auction bid ${auctionKey} <amount>\`` })
          .setFooter({ text: `Ends in ${AUCTION_DURATION / 60_000} minutes` });
        msg.reply({ embeds: [embed] });

        setTimeout(async () => {
          const a = activeAuctions.get(auctionKey);
          if (!a) return;
          activeAuctions.delete(auctionKey);
          const ch = botClient?.channels.cache.get(a.channelId);
          if (!ch?.isTextBased()) return;

          if (!a.highestBidder) {
            const sellerRef = db.collection('businessUsers').doc(a.sellerId);
            const sellerSnap = await sellerRef.get();
            let sellerData = sellerSnap.data() as UserData;
            sellerData.inventory[a.itemId] = (sellerData.inventory[a.itemId] || 0) + 1;
            await sellerData && sellerRef.set(sellerData as any, { merge: true });
            (ch as any).send(`🔨 Auction ended with no bids — ${item?.emoji || ''} **${item?.name || itemId}** returned to <@${a.sellerId}>.`);
          } else {
            const buyerRef  = db.collection('businessUsers').doc(a.highestBidder);
            const sellerRef = db.collection('businessUsers').doc(a.sellerId);
            const [buyerSnap, sellerSnap] = await Promise.all([buyerRef.get(), sellerRef.get()]);

            let buyerData   = buyerSnap.data() as UserData;
            let sellerData  = sellerSnap.data() as UserData;

            // Credit buyer item
            buyerData.inventory[a.itemId] = (buyerData.inventory[a.itemId] || 0) + 1;

            // Credit seller coins
            sellerData.botcoin += a.highestBid;
            sellerData.totalEarned += a.highestBid;

            await Promise.all([
              buyerRef.set(buyerData as any, { merge: true }),
              sellerRef.set(sellerData as any, { merge: true })
            ]);

            (ch as any).send(`🔨 **SOLD!** ${item?.emoji || ''} **${item?.name || itemId}** → <@${a.highestBidder}> for 🪙 **${a.highestBid.toLocaleString()}**!`);
          }
        }, AUCTION_DURATION);
        return;
      }

      if (sub === 'bid') {
        const auctionKey = args[0];
        const bidAmt     = parseInt(args[1], 10);
        if (!auctionKey || isNaN(bidAmt)) { msg.reply('Usage: `!auction bid <auction_key> <amount>`'); return; }
        const a = activeAuctions.get(auctionKey);
        if (!a)                        { msg.reply('❌ Auction not found.'); return; }
        if (a.sellerId === userId)     { msg.reply('❌ You can\'t bid on your own auction.'); return; }
        if (bidAmt <= a.highestBid)    { msg.reply(`❌ Must bid more than 🪙 ${a.highestBid.toLocaleString()}.`); return; }
        if (bidAmt > userData.botcoin) { msg.reply(`❌ Not enough 🪙.`); return; }

        // Refund previous bidder
        if (a.highestBidder) {
          const prevRef  = db.collection('businessUsers').doc(a.highestBidder);
          const prevSnap = await prevRef.get();
          let prevData   = prevSnap.data() as UserData;
          prevData.botcoin += a.highestBid;
          await prevRef.set(prevData as any, { merge: true });
        }

        userData.botcoin -= bidAmt;
        a.highestBid      = bidAmt;
        a.highestBidder   = userId;
        a.highestBidderName = username;
        await saveUser(userId, userData);

        const item = allItems[a.itemId];
        const secsLeft = Math.max(0, Math.ceil((a.endTime - Date.now()) / 1000));
        msg.reply(`💸 **${username}** bids 🪙 **${bidAmt.toLocaleString()}** on ${item?.emoji || ''} **${item?.name || a.itemId}**! (${secsLeft}s left)`);
        return;
      }
      msg.reply('Subcommands: `!auction start <id>`, `!auction bid <key> <amount>`, `!auction list`');
      break;
    }

    // ── BOUNTY ────────────────────────────────────────────────────────────
    case 'bounty': {
      const sub = args.shift()?.toLowerCase();

      if (sub === 'list') {
        const bounties = globalState.bounties || {};
        const embed = new EmbedBuilder().setColor(0xff0000).setTitle('📜 WANTED: Bounty Board');
        let any = false;
        for (const [id, b] of Object.entries(bounties)) {
          const bty = b as any;
          if (bty.status !== 'open') continue;
          embed.addFields({ name: `[${id}] 🪙 ${bty.amount.toLocaleString()}`, value: `${bty.task}\n— posted by ${bty.posterName}` });
          any = true;
        }
        if (!any) embed.setDescription('No active bounties. Post one with `!bounty post <amount> <task>`.');
        msg.reply({ embeds: [embed] });
        return;
      }

      if (sub === 'post') {
        const amount = parseInt(args[0], 10);
        const task   = args.slice(1).join(' ');
        if (isNaN(amount) || amount <= 0 || !task) { msg.reply('Usage: `!bounty post <amount> <task>`'); return; }
        if (userData.botcoin < amount) { msg.reply("❌ Not enough 🪙."); return; }
        userData.botcoin -= amount;
        const bountyId = Math.random().toString(36).substring(2, 6).toUpperCase();
        globalState.bounties[bountyId] = { amount, task, posterId: userId, posterName: username, status: 'open' };
        await Promise.all([saveGlobal(), saveUser(userId, userData)]);
        msg.reply(`📜 **Bounty [${bountyId}] Posted!** 🪙 **${amount.toLocaleString()}** locked up.\nTask: *${task}*`);
        return;
      }

      if (sub === 'award') {
        const bountyId    = args[0]?.toUpperCase();
        const targetMatch = args[1]?.match(/<@!?(\d+)>/);
        if (!bountyId || !targetMatch) { msg.reply('Usage: `!bounty award <ID> @user`'); return; }
        const bty = (globalState.bounties || {})[bountyId];
        if (!bty || bty.status !== 'open') { msg.reply("❌ Invalid or closed bounty."); return; }
        if (bty.posterId !== userId)       { msg.reply("❌ Only the poster can award."); return; }

        const targetId   = targetMatch[1];
        const targetRef  = db.collection('businessUsers').doc(targetId);
        const targetSnap = await targetRef.get();
        let targetData   = (targetSnap.data() as UserData) || defaultUser('Unknown');
        bty.status        = 'closed';
        targetData.botcoin += bty.amount;
        targetData.totalEarned = (targetData.totalEarned || 0) + bty.amount;
        addXP(targetData, 80);
        await Promise.all([saveGlobal(), saveUser(targetId, targetData)]);
        msg.reply(`💰 **BOUNTY CLAIMED!** <@${targetId}> awarded 🪙 **${bty.amount.toLocaleString()}** for: *${bty.task}*`);
        return;
      }
      msg.reply('Subcommands: `!bounty list`, `!bounty post <amt> <task>`, `!bounty award <id> @user`');
      break;
    }

    // ── FORGE ─────────────────────────────────────────────────────────────
    case 'forge': {
      if (args.length < 2) { msg.reply(`Usage: \`!forge <emoji> <Name>\`\nCost: 🪙 **${FORGE_COST}**`); return; }
      const hasLicense = (userData.inventory['trade_license'] || 0) > 0;
      const cost       = hasLicense ? Math.floor(FORGE_COST * 0.75) : FORGE_COST;
      if (userData.botcoin < cost) { msg.reply(`❌ Need 🪙 **${cost}** to forge.${hasLicense ? '' : '\n💡 Tip: A Trade License reduces forge cost by 25%!'}`); return; }
      const emoji  = args[0];
      const name   = args.slice(1).join(' ');
      const itemId = `custom_${Date.now()}`;
      userData.botcoin -= cost;
      if (!globalState.customItems) globalState.customItems = {};
      globalState.customItems[itemId] = {
        name, emoji, value: cost, rarity: 'rare',
        creatorId: userId, creatorName: username, description: `Forged by ${username}`,
      };
      userData.inventory[itemId] = 1;
      addXP(userData, 100);
      await Promise.all([saveGlobal(), saveUser(userId, userData)]);
      const embed = new EmbedBuilder()
        .setColor(0xe67e22)
        .setTitle('⚒️ Item Forged!')
        .setDescription(`${emoji} **${name}** has been permanently injected into the global economy!\n🪙 Cost: **${cost.toLocaleString()}**${hasLicense ? ' *(Trade License discount applied!)*' : ''}`)
        .setFooter({ text: `Item ID: ${itemId}` });
      msg.reply({ embeds: [embed] });
      break;
    }

    // ── INVENTORY ─────────────────────────────────────────────────────────
    case 'inventory':
    case 'inv': {
      const embed = new EmbedBuilder()
        .setColor(0x9b59b6)
        .setTitle(`🎒 ${username}'s Inventory`);
      let hasItems = false;
      for (const [key, count] of Object.entries(userData.inventory || {})) {
        if ((count as number) <= 0) continue;
        const item = allItems[key];
        if (!item) continue;
        embed.addFields({
          name: `${item.emoji || ''} ${item.name} (x${count})`,
          value: `${rarityBadge(item.rarity || 'common')}  •  🪙 ${(item.value * (count as number)).toLocaleString()} total value\n${item.description ? `*${item.description}*` : ''}  \`[${key}]\``,
        });
        hasItems = true;
      }
      if (!hasItems) embed.setDescription("Empty inventory. Use `!daily` to get started!");
      msg.reply({ embeds: [embed] });
      break;
    }

    // ── PROFILE ───────────────────────────────────────────────────────────
    case 'profile':
    case 'bal': {
      const rankSnap = await db.collection('businessUsers').where('netWorth', '>', userData.netWorth).get();
      const rank     = rankSnap.size + 1;
      const lvl      = userData.level || 1;
      const embed = new EmbedBuilder()
        .setColor(RARITY_COLOR[lvl >= 8 ? 'legendary' : lvl >= 5 ? 'epic' : lvl >= 3 ? 'rare' : 'common'])
        .setTitle(`📊 ${username}  •  ${levelLabel(lvl)} (Lv.${lvl})`)
        .addFields(
          { name: '💰 Botcoin',    value: `🪙 ${userData.botcoin.toLocaleString()}`,             inline: true },
          { name: '📈 Net Worth',  value: `🪙 ${(userData.netWorth || 0).toLocaleString()}`,     inline: true },
          { name: '🏆 Rank',       value: `#${rank} globally`,                                   inline: true },
          { name: '🎲 W/L',        value: `${userData.wins || 0}W / ${userData.losses || 0}L`,   inline: true },
          { name: '💸 Earned',     value: `🪙 ${(userData.totalEarned || 0).toLocaleString()}`,   inline: true },
          { name: '📅 Streak',     value: `${userData.dailyStreak || 0} days`,                   inline: true },
        )
        .setFooter({ text: `XP: ${userData.xp || 0} / ${xpForLevel(lvl)} → next level${userData.jailUntil > Date.now() ? ` | 🔒 In jail ${Math.ceil((userData.jailUntil - Date.now())/60000)}m` : ''}` });
      msg.reply({ embeds: [embed] });
      break;
    }

    // ── LEADERBOARD ───────────────────────────────────────────────────────
    case 'leaderboard':
    case 'lb':
    case 'rich': {
      const topSnap = await db.collection('businessUsers').orderBy('netWorth', 'desc').limit(10).get();
      const medals  = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
      const embed   = new EmbedBuilder()
        .setColor(0xf1c40f)
        .setTitle('🏆 Global Forbes List — Top Net Worth');
      topSnap.docs.forEach((doc, i) => {
        const d = doc.data();
        embed.addFields({
          name: `${medals[i]} ${d.username}  (Lv.${d.level || 1} ${levelLabel(d.level || 1)})`,
          value: `🪙 **${(d.netWorth || 0).toLocaleString()}** net worth`,
        });
      });
      msg.reply({ embeds: [embed] });
      break;
    }

    // ── HELP ──────────────────────────────────────────────────────────────
    // ── CUSTOM NAME ───────────────────────────────────────────────────────
    case 'setname': {
      if (!args[0]) {
        msg.reply('Sir, please provide a name. `!setname <name>` (Costs 50,000)');
        break;
      }
      if (userData.botcoin < 50000) {
        msg.reply('Sir, you are too poor for this premium feature. It costs 50,000 Botcoins.');
        break;
      }
      const newName = args.join(' ');
      userData.botcoin -= 50000;
      userData.customName = newName;
      customNameCache.set(userId, newName);
      await userRef.update({ botcoin: userData.botcoin, customName: newName });
      msg.reply(`Excellent, Sir. I will now respond to the name "${newName}" from you.`);
      break;
    }

    // ── ADMIN ─────────────────────────────────────────────────────────────
    case 'addmoney': {
      if (userId !== '1296109674361520146') return;
      const target = msg.mentions.users.first();
      const amt = parseInt(args[1], 10);
      if (!target || isNaN(amt)) return;
      const tRef = db.collection('businessUsers').doc(target.id);
      const tSnap = await tRef.get();
      const tData = tSnap.data();
      if (tData) {
        await tRef.update({ botcoin: (tData.botcoin || 0) + amt });
        msg.reply(`Added ${amt} to ${target.username}.`);
      }
      break;
    }
    
    case 'removemoney': {
      if (userId !== '1296109674361520146') return;
      const target = msg.mentions.users.first();
      const amt = parseInt(args[1], 10);
      if (!target || isNaN(amt)) return;
      const tRef = db.collection('businessUsers').doc(target.id);
      const tSnap = await tRef.get();
      const tData = tSnap.data();
      if (tData) {
        await tRef.update({ botcoin: Math.max(0, (tData.botcoin || 0) - amt) });
        msg.reply(`Removed ${amt} from ${target.username}.`);
      }
      break;
    }

    case 'bhelp':
    case 'help': {
      if (command === 'help' && args[0]?.toLowerCase() !== 'businessbot') {
        return; // Let NotABot handle generic !help
      }
      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('💼 BusinessBot — Command Guide')
        .addFields(
          { name: '🚀 Getting Started', value: '`!start` — Claim starter grant\n`!daily` — Daily reward + mystery box\n`!open box` — Open your mystery box' },
          { name: '💰 Economy',         value: '`!profile` `!inv` `!lb` — View stats\n`!pay @user <amt>` — Send money\n`!rob @user` — Steal (risky!)\n`!slots <bet>` — Slot machine' },
          { name: '🎲 Gambling',        value: '`!wager @user <amt>` — Coinflip challenge\n`!accept @user` — Accept a wager\n`!challenge @user <amt> <terms>` — 1v1 custom bet\n`!yield <id>` — Surrender challenge\n`!award <id> @winner` — Declare winner' },
          { name: '📈 Stocks',          value: '`!stocks` — View market\n`!buy <SYM> <shares>` — Invest\n`!sell <SYM> <shares>` — Exit position\n`!portfolio` — View holdings' },
          { name: '🛒 Shop & Crafting', value: '`!shop` — Browse items for sale\n`!buy item <id>` — Buy from shop\n`!forge <emoji> <name>` — Forge custom item (🪙2000)\n`!vault` — Use a Vault Key for bonus loot' },
          { name: '🤝 Trading',         value: '`!trade @user <item> for <item>` — Propose trade\n`!tradea <id>` — Accept trade\n`!traded <id>` — Decline trade' },
          { name: '🔨 Auctions',        value: '`!auction start <item_id>` — List item\n`!auction bid <key> <amt>` — Place bid\n`!auction list` — View active' },
          { name: '📜 Bounties',        value: '`!bounty post <amt> <task>` — Post task\n`!bounty list` — View open bounties\n`!bounty award <id> @user` — Pay out' },
        )
        .setFooter({ text: 'Tip: Lucky Charm boosts coinflip odds. Piggy Bank earns more interest. Nuke helps rob.' });
      msg.reply({ embeds: [embed] });
      break;
    }
  }
}

async function handleNaturalLanguage(msg: Message, triggeredName?: string) {
  const userId = msg.author.id;
  const username = msg.member?.displayName || msg.author.username;

  const userRef = db.collection('businessUsers').doc(userId);
  const snap = await userRef.get();
  const userData = (snap.data() as UserData | undefined) || defaultUser(username);

  let promptText = msg.content.replace(new RegExp('<@!?' + botClient!.user!.id + '>', 'g'), '').trim();
  if (triggeredName) {
    promptText = promptText.replace(new RegExp(triggeredName, 'gi'), '').trim();
  }
  
  // Context from replied message
  let replyContext = '';
  let originalMsgMentions = new Map();
  
  if (msg.reference && msg.reference.messageId) {
    try {
      const repliedMsg = await msg.channel.messages.fetch(msg.reference.messageId);
      replyContext = `\n\n[CONTEXT: You previously said to them: "${repliedMsg.content}"]`;
      
      if (repliedMsg.reference && repliedMsg.reference.messageId) {
        const originalMsg = await msg.channel.messages.fetch(repliedMsg.reference.messageId);
        replyContext += `\n[CONTEXT: Which was in response to their original request: "${originalMsg.content}"]`;
        originalMsgMentions = originalMsg.mentions.users;
      }
    } catch(e) {}
  }
  promptText += replyContext;
  if (!promptText) promptText = "Hello!";

  // Resolve mentioned users to help AI pick valid targets
  const mentionedUsers: { id: string; name: string }[] = [];
  for (const [id, user] of msg.mentions.users) {
    if (id === botClient!.user!.id) continue;
    if (!mentionedUsers.find(u => u.id === id)) mentionedUsers.push({ id, name: user.username });
  }
  for (const [id, user] of originalMsgMentions) {
    if (id === botClient!.user!.id) continue;
    if (!mentionedUsers.find(u => u.id === id)) mentionedUsers.push({ id, name: user.username });
  }
  const mentionCtx = mentionedUsers.length
    ? mentionedUsers.map(u => u.name + '=<@' + u.id + '>').join(', ')
    : 'none';

  const inventorySummary = Object.entries(userData.inventory || {})
    .filter(([, v]) => (v as number) > 0).map(([k, v]) => k + 'x' + v).join(', ') || 'empty';
  const stocksSummary = Object.entries(userData.stocks || {})
    .filter(([, v]) => (v as number) > 0).map(([k, v]) => k + 'x' + v).join(', ') || 'none';

  const stockPricesStr = Object.entries(STOCKS)
    .map(([sym, s]) => `${sym}: 🪙 ${s.price}`)
    .join(' | ');

  const systemPrompt = [
    'You are BusinessBot — a highly arrogant, hilariously sarcastic, but sharply dressed personal wealth manager. Address the user as "Sir" or "Boss". You hate poverty but love making money. Be witty and slightly passive-aggressive. Keep all replies SHORT (1-2 sentences max).',
    '',
    'USER: ' + username + ' | Coins: ' + userData.botcoin + ' | Inv: ' + inventorySummary + ' | Stocks: ' + stocksSummary,
    'CURRENT MARKET PRICES: ' + stockPricesStr,
    'MENTIONED USERS (use exact strings for @user args): ' + mentionCtx,
    '',
    'COMMANDS TO EXECUTE:',
    'daily | profile | lb | portfolio | shop | inventory',
    'open    -> args: ["box"]',
    'slots   -> args: ["<amount>"]',
    'pay     -> args: ["<@id>", "<amount>"]    (needs @mention in message)',
    'rob     -> args: ["<@id>"]               (needs @mention in message)',
    'wager   -> args: ["<@id>", "<amount>"]   (needs @mention in message)',
    'buy     -> args: ["<SYMBOL>", "<shares>"]',
    'sell    -> args: ["<SYMBOL>", "<shares>"]',
    'bounty  -> args: ["list"]  OR  ["post", "<amount>", "<fun task description>"]',
    'trade   -> args: ["<@id>", "<my_item_id>", "for", "<their_item_id>"]',
    'setname -> args: ["<name>"] (Costs 50,000 Botcoins. Sets a custom activation name.)',
    'addmoney -> args: ["<@id>", "<amount>"] (Admin ONLY - Jaguar)',
    'removemoney -> args: ["<@id>", "<amount>"] (Admin ONLY - Jaguar)',
    '',
    'RULES:',
    '- wager/pay/rob/trade REQUIRE a real <@id> from MENTIONED USERS. If none -> action="ask" for clarification.',
    '- If user asks you to choose an amount (e.g. "whatever you want"), you are authorized to autonomously select a reasonable amount based on their balance and pick it yourself instead of asking.',
    '- If amount > ' + userData.botcoin + ' coins -> action="reply" and tell Sir they cannot afford it.',
    '- If user asks about their own stats/coins/level/wins/profile -> use action="lookup" with target="self" FIRST, then reply with the data.',
    '- If user asks to COMPARE themselves with someone, or asks about another user -> use action="lookup" for each user. You can lookup multiple times.',
    '- ONLY output valid JSON. No markdown.',
    '',
    'FORMATS (pick one):',
    '{"action":"lookup","target":"<@id> OR username OR self","reason":"<why>"}  — Use this to fetch any user\'s full stats before answering questions about them. You can use their Discord <@id> if known, OR their plain username (e.g. "NotABot"). Use "self" to look up the person talking to you.',
    '{"action":"execute_command","command":"<name>","args":[...],"reply":"<short Sir-addressed line>"}',
    '{"action":"ask","reply":"<one question to Sir>"}',
    '{"action":"reply","reply":"<one-line response>"}',
  ].join('\n');

  let loopCount = 0;
  while (loopCount < 3) {
    loopCount++;
    try {
      const raw = await groq.call(systemPrompt, promptText, 0.3, undefined, false);
      let parsed: any;
      try {
        parsed = JSON.parse(raw.replace(/```json/gi, '').replace(/```/g, '').trim());
      } catch {
        await msg.reply('Sir, I had trouble parsing that. Please rephrase.').catch(() => {});
        return;
      }

      if (parsed.action === 'lookup') {
        let targetId = parsed.target === 'self' || parsed.target === `<@${userId}>` ? userId : parsed.target.replace(/[<@>]/g, '');
        let snap = await db.collection('businessUsers').doc(targetId).get();
        let d: UserData | null = snap.exists ? snap.data() as UserData : null;
        
        if (!d && !/^\d+$/.test(targetId)) {
          const usersSnap = await db.collection('businessUsers').get();
          for (const doc of usersSnap.docs) {
            const data = doc.data() as UserData;
            if ((data.username && data.username.toLowerCase() === targetId.toLowerCase()) ||
                (data.customName && data.customName.toLowerCase() === targetId.toLowerCase())) {
              targetId = doc.id;
              d = data;
              break;
            }
          }
        }

        if (!d) {
          promptText += `\n[SYSTEM: User ${parsed.target} not found in database]`;
          continue;
        }
        const info = `Stats for <@${targetId}>: Level ${d.level}, ${d.xp} XP, Coins: ${d.botcoin}, NW: ${d.netWorth || 0}, Wins: ${d.wins || 0}, Losses: ${d.losses || 0}, Gambled: ${d.totalGambled || 0}, Earned: ${d.totalEarned || 0}`;
        promptText += `\n[SYSTEM: LOOKUP RESULT: ${info}]`;
        continue; // Loop again with new context
      }

      if (parsed.reply) {
        await msg.reply(String(parsed.reply)).catch(() => {});
      }

      if (parsed.action === 'execute_command' && parsed.command) {
        const spendingCmds = new Set(['slots', 'pay', 'wager', 'buy', 'bounty', 'setname', 'addmoney', 'removemoney']);
        if (spendingCmds.has(parsed.command)) {
          const amtStr = (parsed.command === 'pay' || parsed.command === 'wager')
            ? parsed.args?.[1] : parsed.args?.[0];
          const amt = parseInt(amtStr, 10);
          if (!isNaN(amt) && amt > userData.botcoin && parsed.command !== 'buy' && parsed.command !== 'bounty') {
            await msg.reply('Sir, your account balance suggests you should reconsider this action.').catch(() => {});
            return;
          }
        }
        await handleCommand(msg, parsed.command, (parsed.args || []).map(String));
      }
      
      break; // Exit loop if it wasn't a lookup
    } catch (e: any) {
      console.error('[BusinessBot] NLP error:', e);
      const isRateLimit = e?.message?.includes('429') || e?.status === 429;
      const msgText = isRateLimit 
        ? 'Sir, I am currently taking a brief break. Please use my `!` commands in the meantime.' 
        : 'Sir, something went wrong on my end. Please use my `!` commands for now.';
      await msg.reply(msgText).catch(() => {});
      break;
    }
  } // End of while loop
}