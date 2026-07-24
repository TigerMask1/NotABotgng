import {
  Client, GatewayIntentBits, Message, Partials, Events, EmbedBuilder
} from 'discord.js';
import { db } from './firebase.ts';
import { groq } from './groqBot.ts';

let botClient: Client | null = null;
const PREFIX = '!';

// â”€â”€ CONSTANTS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const STARTER_GRANT  = 1_000;
const DAILY_BASE     = 200;
const STREAK_BONUS   = 50;     // per-day streak addition
const MAX_STREAK     = 30;     // streak cap for payouts
const FORGE_COST     = 2_000;
const ROB_COOLDOWN   = 3 * 60 * 60 * 1000; // 3h
const JAIL_DURATION  = 30 * 60 * 1000;      // 30min
const INTEREST_RATE  = 0.001;               // 0.1% per hour, applied on !daily
const AUCTION_DURATION = 5 * 60 * 1000;     // 5 minutes

// â”€â”€ ITEM CATALOGUE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
interface ItemDef {
  name: string;
  emoji: string;
  value: number;
  rarity: 'common' | 'rare' | 'epic' | 'legendary';
  shopPrice?: number;
  description?: string;
}

const ITEMS: Record<string, ItemDef> = {
  mystery_box:    { name: 'Mystery Box',     emoji: 'ðŸŽ', value: 0,      rarity: 'common',    description: 'Open with !open box' },
  rusty_coin:     { name: 'Rusty Coin',      emoji: '🪙', value: 10,     rarity: 'common' },
  trade_license:  { name: 'Trade License',   emoji: '📜', value: 2_000,  rarity: 'rare',   shopPrice: 3_500, description: 'Reduces forge cost by 25%' },
  golden_rolex:   { name: 'Golden Rolex',    emoji: '❌š', value: 5_000,  rarity: 'epic' },
  ceo_title:      { name: 'CEO Title',       emoji: 'ðŸ‘‘', value: 10_000, rarity: 'legendary' },
  lucky_charm:    { name: 'Lucky Charm',     emoji: 'ðŸ€', value: 1_500,  rarity: 'rare',   shopPrice: 2_500, description: '+10% coinflip win chance' },
  diamond:        { name: 'Diamond',         emoji: '💎', value: 8_000,  rarity: 'epic' },
  vault_key:      { name: 'Vault Key',       emoji: 'ðŸ—ï¸', value: 3_000,  rarity: 'rare',   shopPrice: 5_000, description: 'Open the Vault for bonus loot' },
  nuke:           { name: 'Nuke',            emoji: 'ðŸ’£', value: 500,    rarity: 'rare',   shopPrice: 1_000, description: 'Rob with +20% success chance' },
  piggy_bank:     { name: 'Piggy Bank',      emoji: 'ðŸ·', value: 750,    rarity: 'common', shopPrice: 1_000, description: '+50% bank interest rate' },
  hacker_kit:     { name: 'Hacker Kit',      emoji: 'ðŸ’»', value: 1_200,  rarity: 'rare',   shopPrice: 2_000, description: 'Double !daily once' },
  golden_ticket:  { name: 'Golden Ticket',   emoji: 'ðŸŽŸï¸', value: 500,    rarity: 'common' },
  crystal_ball:   { name: 'Crystal Ball',    emoji: 'ðŸ”®', value: 4_000,  rarity: 'epic',   shopPrice: 6_000, description: 'Reveal stock trends before investing' },
};

// â”€â”€ STOCK MARKET â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
interface Stock {
  name: string;
  emoji: string;
  price: number;
  trend: number;    // -1 to +1, positive = bull
  volatility: number;
}

const STOCKS: Record<string, Stock> = {
  BOTC: { name: 'BotCoin Industries', emoji: '🪙', price: 100, trend: 0.3,  volatility: 0.15 },
  CLOD: { name: 'Cloud Corp',         emoji: 'â˜ï¸', price: 250, trend: -0.1, volatility: 0.22 },
  GRLX: { name: 'Golden Rolex Ltd',   emoji: '❌š', price: 500, trend: 0.2,  volatility: 0.18 },
  MBOX: { name: 'Mystery Box Corp',   emoji: 'ðŸŽ', price: 75,  trend: 0.0,  volatility: 0.30 },
  NUKE: { name: 'Nuke Holdings',      emoji: 'ðŸ’£', price: 175, trend: 0.1,  volatility: 0.28 },
};

// Tick stock prices every 10 minutes
function tickStocks() {
  for (const [sym, s] of Object.entries(STOCKS)) {
    const drift  = s.trend * 0.02;
    const shock  = (Math.random() - 0.5) * 2 * s.volatility;
    const change = drift + shock;
    s.price = Math.max(10, Math.round(s.price * (1 + change)));
  }
}
setInterval(tickStocks, 10 * 60 * 1000);

// â”€â”€ IN-MEMORY STATE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
interface Wager    { fromId: string; toId: string; amount: number; fromName: string }
interface Challenge { id: string; fromId: string; toId: string; amount: number; terms: string }
interface Auction  { itemId: string; customKey?: string; sellerId: string; highestBid: number; highestBidder: string | null; highestBidderName: string | null; endTime: number; channelId: string; guildId: string }
interface Trade    { id: string; fromId: string; toId: string; offerItems: Record<string, number>; offerBotcoin: number; wantItems: Record<string, number>; wantBotcoin: number }

const pendingWagers    = new Map<string, Wager>();
const activeChallenges = new Map<string, Challenge>();
const activeAuctions   = new Map<string, Auction>();
const pendingTrades    = new Map<string, Trade>();

// â”€â”€ SCHEMA â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
interface UserData {
  username:    string;
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

// â”€â”€ HELPERS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
  return { common: 'â¬œ Common', rare: 'ðŸ”µ Rare', epic: 'ðŸŸ£ Epic', legendary: 'ðŸŸ¡ Legendary' }[r] || r;
}

// â”€â”€ BOT LIFECYCLE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export async function startBusinessBot(token: string) {
  if (botClient) return;

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
    botClient!.user!.setPresence({ status: 'online', activities: [{ name: 'ðŸ“ˆ the free market', type: 3 }] });
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

    // 2. Natural Language AI parsing via Groq (when mentioned)
    if (msg.mentions.has(botClient!.user!.id)) {
      try {
        await handleNaturalLanguage(msg);
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

// â”€â”€ COMMAND ROUTER â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
    msg.reply(`ðŸ”’ You're in jail! ${mins} minute(s) left. You can't do that in here.`);
    return;
  }

  switch (command) {

    // â”€â”€ ONBOARDING â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    case 'start':
    case 'grant': {
      if (userData.granted) {
        msg.reply('âŒ You already received your starter grant from the Central Bank.');
        return;
      }
      userData.botcoin  += STARTER_GRANT;
      userData.granted   = true;
      userData.totalEarned += STARTER_GRANT;
      addXP(userData, 50);
      await saveUser(userId, userData);
      const embed = new EmbedBuilder()
        .setColor(0x2ecc71)
        .setTitle('ðŸ¦ Central Bank — Starter Grant')
        .setDescription(`Welcome to the **Free Market**, ${username}!\nYou've been issued 🪙 **${STARTER_GRANT.toLocaleString()} Botcoin** by the Central Bank.`)
        .addFields(
          { name: 'ðŸ“‹ Next Steps', value: '`!daily` — Claim daily reward\n`!help` — See all commands\n`!stocks` — Check the market' }
        )
        .setFooter({ text: 'Spend it wisely. Or don\'t. This is the Free Market.' });
      msg.reply({ embeds: [embed] });
      break;
    }

    // â”€â”€ DAILY â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    case 'daily': {
      const now    = Date.now();
      const oneDay = 24 * 60 * 60 * 1000;
      const twoDays = 2 * oneDay;
      if (now - userData.lastDaily < oneDay) {
        const hoursLeft = Math.ceil((oneDay - (now - userData.lastDaily)) / 3_600_000);
        msg.reply(`âŒ Already claimed! Come back in **${hoursLeft}h**.`);
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
        .setTitle(`ðŸŽ Daily Reward — Day ${streak} Streak!`)
        .addFields(
          { name: '💰 Daily',    value: `🪙 ${dailyAmt.toLocaleString()}`,  inline: true },
          { name: 'ðŸ“ˆ Interest', value: `🪙 ${interest.toLocaleString()}`,  inline: true },
          { name: streak >= 7 ? '🔥 Streak Bonus' : 'âš¡ Streak', value: `🪙 ${streakBonus.toLocaleString()} (day ${streak})`, inline: true },
        )
        .setDescription(`You also got a **Mystery Box ðŸŽ**! Use \`!open box\` to see what's inside.\n${bonus > 0 ? 'ðŸ–¥ï¸ **Hacker Kit** doubled your daily!' : ''}`)
        .setFooter({ text: `Balance: 🪙 ${userData.botcoin.toLocaleString()} | New worth: 🪙 ${userData.netWorth.toLocaleString()}` });
      msg.reply({ embeds: [embed] });
      break;
    }

    // â”€â”€ OPEN BOX â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    case 'open': {
      if (args[0] !== 'box' && args[0] !== 'mystery_box') {
        msg.reply('Usage: `!open box`'); return;
      }
      if (!userData.inventory['mystery_box'] || userData.inventory['mystery_box'] <= 0) {
        msg.reply("âŒ You don't have any Mystery Boxes! Use `!daily` to get one."); return;
      }
      userData.inventory['mystery_box']--;

      const roll = Math.random();
      let reward = '';
      let color: number = 0x95a5a6;

      if (roll < 0.005) {           // 0.5% Jackpot
        const amt = 15_000;
        userData.botcoin += amt;
        reward = `ðŸŒŸ **MEGA JACKPOT!!!** ðŸŒŸ\n+🪙 **${amt.toLocaleString()} Botcoin**`;
        color  = 0xf1c40f;
        addXP(userData, 500);
      } else if (roll < 0.03) {     // 2.5% Legendary
        const legendaries = ['ceo_title', 'diamond'];
        const won = legendaries[Math.floor(Math.random() * legendaries.length)];
        userData.inventory[won] = (userData.inventory[won] || 0) + 1;
        const i = ITEMS[won];
        reward = `ðŸ‘‘ **LEGENDARY DROP!** ðŸ‘‘\n${i.emoji} **${i.name}**  â€¢  ${rarityBadge(i.rarity)}`;
        color  = 0xf1c40f;
        addXP(userData, 300);
      } else if (roll < 0.12) {     // 9% Epic
        const epics = ['golden_rolex'];
        const won = epics[Math.floor(Math.random() * epics.length)];
        userData.inventory[won] = (userData.inventory[won] || 0) + 1;
        const i = ITEMS[won];
        reward = `ðŸ”® **EPIC DROP!** ðŸ”®\n${i.emoji} **${i.name}**  â€¢  ${rarityBadge(i.rarity)}`;
        color  = 0x9b59b6;
        addXP(userData, 150);
      } else if (roll < 0.35) {     // 23% Rare
        const rares = ['trade_license', 'lucky_charm', 'vault_key', 'hacker_kit', 'nuke'];
        const won = rares[Math.floor(Math.random() * rares.length)];
        userData.inventory[won] = (userData.inventory[won] || 0) + 1;
        const i = ITEMS[won];
        reward = `✨ **Rare Drop!** ✨\n${i.emoji} **${i.name}**  â€¢  ${rarityBadge(i.rarity)}`;
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
        .setTitle('ðŸŽ Opening Mystery Box...')
        .setDescription(reward)
        .setFooter({ text: `Balance: 🪙 ${userData.botcoin.toLocaleString()} | Boxes left: ${userData.inventory['mystery_box'] || 0}` });
      msg.reply({ embeds: [embed] });
      break;
    }

    // â”€â”€ VAULT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    case 'vault': {
      if (!userData.inventory['vault_key'] || userData.inventory['vault_key'] <= 0) {
        msg.reply('âŒ You need a ðŸ—ï¸ **Vault Key** to open the vault. Buy one from `!shop` or find one in a box!');
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
      msg.reply(`ðŸ—ï¸ The vault door swings open... you grabbed 🪙 **${loot.toLocaleString()} Botcoin**!${extra}`);
      break;
    }

    // â”€â”€ SLOTS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    case 'slots': {
      const bet = parseInt(args[0], 10);
      if (isNaN(bet) || bet <= 0) { msg.reply('Usage: `!slots <amount>`'); return; }
      if (bet > userData.botcoin)  { msg.reply(`âŒ You only have 🪙 ${userData.botcoin.toLocaleString()}.`); return; }
      if (bet > 10_000)            { msg.reply('âŒ Max bet is 🪙 10,000.'); return; }

      const symbols = ['ðŸ’', 'ðŸ‹', 'ðŸŠ', '💎', 'ðŸ””', 'â­', 'ðŸŽ°', '7ï¸âƒ£'];
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
        const multipliers: Record<string, number> = { '7ï¸âƒ£': 20, 'ðŸŽ°': 15, 'â­': 10, 'ðŸ””': 8, '💎': 7, 'ðŸŠ': 4, 'ðŸ‹': 3, 'ðŸ’': 2 };
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
        .setTitle('ðŸŽ° Slot Machine')
        .setDescription(`**${reels.join('  |  ')}**\n\n${winMsg}`)
        .setFooter({ text: `Balance: 🪙 ${userData.botcoin.toLocaleString()}` });
      msg.reply({ embeds: [embed] });
      break;
    }

    // â”€â”€ ROB â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    case 'rob': {
      const targetMatch = args[0]?.match(/<@!?(\d+)>/);
      if (!targetMatch) { msg.reply('Usage: `!rob @user`'); return; }
      const targetId = targetMatch[1];
      if (targetId === userId) { msg.reply("âŒ You can't rob yourself."); return; }

      const now = Date.now();
      if (now - (userData.lastRob || 0) < ROB_COOLDOWN) {
        const minsLeft = Math.ceil((ROB_COOLDOWN - (now - userData.lastRob)) / 60_000);
        msg.reply(`âŒ You're laying low after your last job. Try again in **${minsLeft}m**.`);
        return;
      }

      const targetRef  = db.collection('businessUsers').doc(targetId);
      const targetSnap = await targetRef.get();
      const targetData = targetSnap.data() as UserData | undefined;
      if (!targetData || targetData.botcoin < 100) {
        msg.reply("âŒ Target is too broke to rob. Pick someone richer."); return;
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
        msg.reply(`💰 **ROB SUCCESS!** You swiped 🪙 **${stolen.toLocaleString()}** from <@${targetId}>!${hasNuke ? ' (Nuke used ðŸ’£)' : ''}`);
      } else {
        const fine = Math.floor(userData.botcoin * 0.10);
        userData.botcoin  = Math.max(0, userData.botcoin - fine);
        userData.jailUntil = now + JAIL_DURATION;
        userData.losses++;
        addXP(userData, 10);
        await saveUser(userId, userData);
        msg.reply(`ðŸš” **CAUGHT!** You got arrested robbing <@${targetId}>. Paid 🪙 **${fine.toLocaleString()}** fine and you're in jail for **30 minutes**. Use \`!profile\` to see your sentence.`);
      }
      break;
    }

    // â”€â”€ WAGER (COINFLIP) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    case 'wager':
    case 'flip': {
      if (args.length < 2) { msg.reply('Usage: `!wager @user <amount>`'); return; }
      const targetMatch = args[0].match(/<@!?(\d+)>/);
      if (!targetMatch) { msg.reply('Please mention a user.'); return; }
      const targetId = targetMatch[1];
      const amount   = parseInt(args[1], 10);

      if (isNaN(amount) || amount <= 0) { msg.reply('Invalid amount.'); return; }
      if (amount > userData.botcoin)    { msg.reply(`âŒ You only have 🪙 ${userData.botcoin.toLocaleString()}.`); return; }
      if (targetId === userId)          { msg.reply("âŒ Can't wager against yourself."); return; }
      if (amount > 50_000)              { msg.reply('âŒ Max wager is 🪙 50,000.'); return; }

      const wagerKey = `${targetId}-${userId}`;
      pendingWagers.set(wagerKey, { fromId: userId, toId: targetId, amount, fromName: username });

      const embed = new EmbedBuilder()
        .setColor(0xffff00)
        .setTitle('ðŸŽ² Coinflip Challenge!')
        .setDescription(`<@${targetId}>, **${username}** challenged you to a 50/50 coinflip for 🪙 **${amount.toLocaleString()}**!\n\nType \`!accept @${username}\` to accept, or just ignore it.`)
        .setFooter({ text: 'Challenge expires in 5 minutes.' });
      msg.reply({ embeds: [embed] });

      setTimeout(() => pendingWagers.delete(wagerKey), 5 * 60_000);
      break;
    }

    // â”€â”€ ACCEPT (WAGER) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    case 'accept': {
      if (args.length < 1) { msg.reply('Usage: `!accept @user`'); return; }
      const targetMatch = args[0].match(/<@!?(\d+)>/);
      if (!targetMatch) { msg.reply('Mention the user who challenged you.'); return; }
      const challengerId = targetMatch[1];
      const wagerKey     = `${userId}-${challengerId}`;
      const wager        = pendingWagers.get(wagerKey);

      if (!wager) { msg.reply('âŒ No pending wager from that user.'); return; }
      if (userData.botcoin < wager.amount) { msg.reply(`âŒ You need 🪙 ${wager.amount.toLocaleString()} to accept.`); return; }

      const challengerRef  = db.collection('businessUsers').doc(challengerId);
      const challengerSnap = await challengerRef.get();
      let challengerData   = challengerSnap.data() as UserData;
      if (!challengerData || challengerData.botcoin < wager.amount) {
        msg.reply("âŒ Challenger no longer has enough 🪙!");
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
        .setTitle('ðŸŽ² Coinflip Result')
        .setDescription(`🪙 The coin spins...\n\nðŸ† **<@${winnerId}> wins 🪙 ${wager.amount.toLocaleString()}** from <@${loserId}>!${hasLucky ? '\nðŸ€ (Lucky Charm activated!)' : ''}`)
        .setFooter({ text: `Winner balance: 🪙 ${winner.botcoin.toLocaleString()}` });
      msg.reply({ embeds: [embed] });
      break;
    }

    // â”€â”€ CHALLENGE (1v1) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    case 'challenge': {
      if (args.length < 3) { msg.reply('Usage: `!challenge @user <amount> <terms>`'); return; }
      const targetMatch = args[0].match(/<@!?(\d+)>/);
      if (!targetMatch) { msg.reply('Please mention a user.'); return; }
      const targetId = targetMatch[1];
      const amount   = parseInt(args[1], 10);
      const terms    = args.slice(2).join(' ');

      if (isNaN(amount) || amount <= 0) { msg.reply('Invalid amount.'); return; }
      if (amount > userData.botcoin)    { msg.reply(`âŒ You only have 🪙 ${userData.botcoin.toLocaleString()}.`); return; }
      if (targetId === userId)          { msg.reply("âŒ Can't challenge yourself."); return; }

      const targetRef  = db.collection('businessUsers').doc(targetId);
      const targetSnap = await targetRef.get();
      const targetData = targetSnap.data();
      if (!targetData || targetData.botcoin < amount) {
        msg.reply(`âŒ <@${targetId}> doesn't have enough 🪙 to match!`); return;
      }

      userData.botcoin -= amount;
      await saveUser(userId, userData);

      const challengeId = Math.random().toString(36).substring(2, 8).toUpperCase();
      activeChallenges.set(challengeId, { id: challengeId, fromId: userId, toId: targetId, amount, terms });

      const embed = new EmbedBuilder()
        .setColor(0xe67e22)
        .setTitle(`âš”ï¸ Challenge Issued — [${challengeId}]`)
        .setDescription(`<@${targetId}>, **${username}** has challenged you!\n\n**Terms:** *${terms}*\n**Pot:** 🪙 ${(amount * 2).toLocaleString()} total (🪙 ${amount.toLocaleString()} each side)`)
        .addFields({ name: 'How to resolve', value: '**Winner:** Both parties agree — type `!award <id> @winner`\n**Surrender:** Type `!yield <id>` to forfeit your side' });
      msg.reply({ embeds: [embed] });
      break;
    }

    // â”€â”€ YIELD â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    case 'yield': {
      const challengeId = args[0]?.toUpperCase();
      if (!challengeId) { msg.reply('Usage: `!yield <Challenge_ID>`'); return; }
      const challenge   = activeChallenges.get(challengeId);
      if (!challenge)   { msg.reply('âŒ Invalid or finished challenge.'); return; }
      if (userId !== challenge.toId && userId !== challenge.fromId) {
        msg.reply("âŒ You're not part of this challenge."); return;
      }

      const winnerId = userId === challenge.fromId ? challenge.toId : challenge.fromId;
      if (userId === challenge.toId) {
        if (userData.botcoin < challenge.amount) { msg.reply("âŒ Not enough 🪙 to pay!"); return; }
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

      msg.reply(`ðŸ³ï¸ **YIELD!** <@${userId}> surrenders! <@${winnerId}> wins the 🪙 **${(challenge.amount * 2).toLocaleString()}** pot!`);
      break;
    }

    // â”€â”€ AWARD CHALLENGE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    case 'award': {
      const challengeId  = args[0]?.toUpperCase();
      const targetMatch  = args[1]?.match(/<@!?(\d+)>/);
      if (!challengeId || !targetMatch) { msg.reply('Usage: `!award <Challenge_ID> @winner`'); return; }
      const challenge   = activeChallenges.get(challengeId);
      if (!challenge)   { msg.reply('âŒ Invalid or finished challenge.'); return; }
      if (userId !== challenge.fromId && userId !== challenge.toId) {
        msg.reply("âŒ Only participants can award."); return;
      }
      const winnerId = targetMatch[1];
      if (winnerId !== challenge.fromId && winnerId !== challenge.toId) {
        msg.reply("âŒ Winner must be one of the two participants."); return;
      }

      const loserId = winnerId === challenge.fromId ? challenge.toId : challenge.fromId;
      const winnerRef  = db.collection('businessUsers').doc(winnerId);
      const loserRef   = db.collection('businessUsers').doc(loserId);
      const [winnerSnap, loserSnap] = await Promise.all([winnerRef.get(), loserRef.get()]);
      let winnerData = winnerSnap.data() as UserData;
      let loserData  = loserSnap.data() as UserData;

      // If loser is the challenged party (hasn't paid escrow yet)
      if (loserId === challenge.toId) {
        if (loserData.botcoin < challenge.amount) { msg.reply(`âŒ <@${loserId}> doesn't have enough 🪙!`); return; }
        loserData.botcoin -= challenge.amount;
        await saveUser(loserId, loserData);
      }

      winnerData.botcoin     += challenge.amount * 2;
      winnerData.wins         = (winnerData.wins || 0) + 1;
      winnerData.totalEarned  = (winnerData.totalEarned || 0) + challenge.amount * 2;
      addXP(winnerData, 50);
      await saveUser(winnerId, winnerData);
      activeChallenges.delete(challengeId);
      msg.reply(`ðŸ† **Challenge [${challengeId}] settled!** <@${winnerId}> wins 🪙 **${(challenge.amount * 2).toLocaleString()}**!`);
      break;
    }

    // â”€â”€ PAY â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    case 'pay': {
      const targetMatch = args[0]?.match(/<@!?(\d+)>/);
      const amount      = parseInt(args[1], 10);
      if (!targetMatch || isNaN(amount) || amount <= 0) { msg.reply('Usage: `!pay @user <amount>`'); return; }
      const targetId = targetMatch[1];
      if (targetId === userId)      { msg.reply("âŒ Can't pay yourself."); return; }
      if (amount > userData.botcoin) { msg.reply(`âŒ Not enough 🪙. Balance: ${userData.botcoin.toLocaleString()}`); return; }

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

    // â”€â”€ STOCKS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    case 'stocks':
    case 'market': {
      const embed = new EmbedBuilder()
        .setColor(0x23272a)
        .setTitle('ðŸ“ˆ Botcoin Stock Exchange')
        .setDescription('Buy: `!buy <SYMBOL> <shares>` | Sell: `!sell <SYMBOL> <shares>`')
        .setFooter({ text: 'Prices update every 10 minutes. Past performance â‰  future results.' });
      for (const [sym, s] of Object.entries(STOCKS)) {
        const trendArrow = s.trend > 0.1 ? 'ðŸ“ˆ' : s.trend < -0.1 ? 'ðŸ“‰' : 'âž¡ï¸';
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
      if (!stock) { msg.reply(`âŒ Unknown symbol. Available: ${Object.keys(STOCKS).join(', ')}`); return; }
      const cost = stock.price * shares;
      if (cost > userData.botcoin) { msg.reply(`âŒ Costs 🪙 ${cost.toLocaleString()}. You have 🪙 ${userData.botcoin.toLocaleString()}.`); return; }
      userData.botcoin    -= cost;
      userData.stocks     ??= {};
      userData.stocks[sym] = (userData.stocks[sym] || 0) + shares;
      addXP(userData, 20);
      await saveUser(userId, userData);
      msg.reply(`ðŸ“ˆ Bought **${shares}x ${stock.name}** [${sym}] for 🪙 **${cost.toLocaleString()}**. Avg: ${stock.price}/share.`);
      break;
    }

    case 'sell': {
      const sym    = args[0]?.toUpperCase();
      const shares = parseInt(args[1], 10);
      if (!sym || isNaN(shares) || shares <= 0) { msg.reply('Usage: `!sell <SYMBOL> <shares>`'); return; }
      const stock = STOCKS[sym];
      if (!stock) { msg.reply(`âŒ Unknown symbol.`); return; }
      const owned = userData.stocks?.[sym] || 0;
      if (owned < shares) { msg.reply(`âŒ You only own **${owned}** shares of ${sym}.`); return; }
      const revenue = stock.price * shares;
      userData.botcoin       += revenue;
      userData.stocks[sym]    = owned - shares;
      userData.totalEarned   += revenue;
      addXP(userData, 15);
      await saveUser(userId, userData);
      msg.reply(`ðŸ“‰ Sold **${shares}x ${sym}** for 🪙 **${revenue.toLocaleString()}**.`);
      break;
    }

    case 'portfolio': {
      const embed = new EmbedBuilder()
        .setColor(0x3498db)
        .setTitle(`ðŸ“Š ${username}'s Portfolio`);
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

    // â”€â”€ SHOP â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    case 'shop': {
      const shopItems = Object.entries(ITEMS).filter(([, v]) => v.shopPrice);
      const embed = new EmbedBuilder()
        .setColor(0xf1c40f)
        .setTitle('ðŸ›’ Black Market Shop')
        .setDescription('Buy items with `!buy item <item_id>`');
      for (const [key, item] of shopItems) {
        embed.addFields({
          name: `${item.emoji} ${item.name}  [${key}]  ${rarityBadge(item.rarity)}`,
          value: `🪙 **${item.shopPrice!.toLocaleString()}**  â€¢  ${item.description || ''}`,
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
      if (!item || !item.shopPrice) { msg.reply('âŒ That item is not in the shop. Use `!shop` to browse.'); return; }
      if (userData.botcoin < item.shopPrice) { msg.reply(`âŒ Costs 🪙 ${item.shopPrice.toLocaleString()}. You have 🪙 ${userData.botcoin.toLocaleString()}.`); return; }
      userData.botcoin -= item.shopPrice;
      userData.inventory[itemId] = (userData.inventory[itemId] || 0) + 1;
      addXP(userData, 30);
      await saveUser(userId, userData);
      msg.reply(`ðŸ›’ Bought ${item.emoji} **${item.name}** for 🪙 ${item.shopPrice.toLocaleString()}!`);
      break;
    }

    // â”€â”€ TRADE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
      if (!(allItems[offerKey])) { msg.reply(`âŒ You don't have item \`${offerKey}\` in the catalogue.`); return; }
      if (!(allItems[wantKey]))  { msg.reply(`âŒ Target item \`${wantKey}\` not in catalogue.`); return; }
      if ((userData.inventory[offerKey] || 0) <= 0) { msg.reply(`âŒ You don't own **${allItems[offerKey].name}**.`); return; }

      const tradeId = Math.random().toString(36).substring(2, 6).toUpperCase();
      pendingTrades.set(tradeId, {
        id: tradeId, fromId: userId, toId: targetId,
        offerItems: { [offerKey]: 1 }, offerBotcoin: 0,
        wantItems:  { [wantKey]: 1 },  wantBotcoin: 0,
      });
      setTimeout(() => pendingTrades.delete(tradeId), 5 * 60_000);

      const embed = new EmbedBuilder()
        .setColor(0x1abc9c)
        .setTitle(`ðŸ¤ Trade Offer — [${tradeId}]`)
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
      if (!trade)           { msg.reply('âŒ Invalid trade ID.'); return; }
      if (trade.toId !== userId) { msg.reply("âŒ This trade isn't for you."); return; }

      const fromRef  = db.collection('businessUsers').doc(trade.fromId);
      const fromSnap = await fromRef.get();
      let fromData   = fromSnap.data() as UserData;
      const offerItem = Object.keys(trade.offerItems)[0];
      const wantItem  = Object.keys(trade.wantItems)[0];

      if ((fromData.inventory[offerItem] || 0) <= 0) { msg.reply("âŒ Offerer no longer has that item!"); return; }
      if ((userData.inventory[wantItem] || 0) <= 0)  { msg.reply(`âŒ You don't own ${itemDisplay(wantItem, customItems)}.`); return; }

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
      if (!trade)            { msg.reply('âŒ Invalid trade ID.'); return; }
      if (trade.toId !== userId && trade.fromId !== userId) { msg.reply("âŒ Not your trade."); return; }
      pendingTrades.delete(tradeId);
      msg.reply(`âŒ Trade [${tradeId}] declined.`);
      break;
    }

    // â”€â”€ AUCTION â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    case 'auction': {
      const sub = args.shift()?.toLowerCase();

      if (sub === 'list') {
        if (activeAuctions.size === 0) { msg.reply('🔨 No active auctions right now.'); return; }
        const embed = new EmbedBuilder().setColor(0xe67e22).setTitle('🔨 Active Auctions');
        for (const [key, a] of activeAuctions) {
          const item    = allItems[a.itemId];
          const secsLeft = Math.max(0, Math.ceil((a.endTime - Date.now()) / 1000));
          embed.addFields({
            name: `${item?.emoji || 'ðŸŽ'} ${item?.name || a.itemId}`,
            value: `Current: 🪙 **${a.highestBid.toLocaleString()}** by ${a.highestBidder ? `<@${a.highestBidder}>` : 'nobody'}\nEnds in: **${secsLeft}s**\nBid: \`!auction bid ${key} <amount>\``,
          });
        }
        msg.reply({ embeds: [embed] });
        return;
      }

      if (sub === 'start') {
        const itemId = args[0];
        if (!itemId) { msg.reply('Usage: `!auction start <item_id>`'); return; }
        if ((userData.inventory[itemId] || 0) <= 0) { msg.reply(`âŒ You don't own \`${itemId}\`.`); return; }
        if ([...activeAuctions.values()].some(a => a.sellerId === userId)) {
          msg.reply('âŒ You already have an active auction.'); return;
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
          .setDescription(`**${username}** is auctioning ${item?.emoji || 'ðŸŽ'} **${item?.name || itemId}**!\nStarting bid: 🪙 **${startBid.toLocaleString()}**`)
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
            const buyerSnap = await buyerRef.get();
            let buyerData   = buyerSnap.data() as UserData;
            buyerData.inventory[a.itemId] = (buyerData.inventory[a.itemId] || 0) + 1;
            await buyerRef.set(buyerData as any, { merge: true });
            (ch as any).send(`🔨 **SOLD!** ${item?.emoji || ''} **${item?.name || itemId}** â†’ <@${a.highestBidder}> for 🪙 **${a.highestBid.toLocaleString()}**!`);
          }
        }, AUCTION_DURATION);
        return;
      }

      if (sub === 'bid') {
        const auctionKey = args[0];
        const bidAmt     = parseInt(args[1], 10);
        if (!auctionKey || isNaN(bidAmt)) { msg.reply('Usage: `!auction bid <auction_key> <amount>`'); return; }
        const a = activeAuctions.get(auctionKey);
        if (!a)                        { msg.reply('âŒ Auction not found.'); return; }
        if (a.sellerId === userId)     { msg.reply('âŒ You can\'t bid on your own auction.'); return; }
        if (bidAmt <= a.highestBid)    { msg.reply(`âŒ Must bid more than 🪙 ${a.highestBid.toLocaleString()}.`); return; }
        if (bidAmt > userData.botcoin) { msg.reply(`âŒ Not enough 🪙.`); return; }

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

    // â”€â”€ BOUNTY â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    case 'bounty': {
      const sub = args.shift()?.toLowerCase();

      if (sub === 'list') {
        const bounties = globalState.bounties || {};
        const openBounties = Object.entries(bounties).filter(([, b]) => (b as any).status === 'open');
        const embed = new EmbedBuilder()
          .setColor(0xff4444)
          .setTitle('🎯 BOUNTY BOARD — WANTED')
          .setDescription(openBounties.length === 0
            ? '🦗 Board is empty. Post a bounty with `!bounty post <amount> <task>`.\n💡 Stuck on ideas? Try `!bounty suggest`!'
            : `**${openBounties.length} active bounty${openBounties.length > 1 ? 'ies' : ''}** up for grabs. Complete a task and ask the poster to \`!bounty award <ID> @you\`.`);
        for (const [id, b] of openBounties) {
          const bty = b as any;
          embed.addFields({ name: `[${id}] 🪙 ${bty.amount.toLocaleString()} — posted by ${bty.posterName}`, value: `> ${bty.task}` });
        }
        embed.setFooter({ text: 'Post: !bounty post <amt> <task>  |  Award: !bounty award <ID> @user  |  Suggest: !bounty suggest' });
        msg.reply({ embeds: [embed] });
        return;
      }

      if (sub === 'suggest') {
        try {
          const sysPrompt = 'You are a creative game master for a Discord economy game. Generate ONE funny, specific, competitive bounty task that players can complete in chat. Keep it under 15 words. Make it creative, fun, and slightly chaotic. Output ONLY the task text, no quotes, no explanation.';
          const task = await groq.call(sysPrompt, 'Generate a fun bounty task now.', 0.9);
          const cleanTask = task.replace(/```/g, '').trim();
          msg.reply(`💡 **Bounty Idea:** *${cleanTask}*\n\nLike it? Use \`!bounty post 500 ${cleanTask}\``);
        } catch {
          msg.reply('💡 **Bounty Idea:** *First person to lose 1,000 coins in slots and screenshot it*\n\nUse `!bounty post <amount> <task>` to post it!');
        }
        return;
      }

      if (sub === 'post') {
        const amount = parseInt(args[0], 10);
        const task   = args.slice(1).join(' ');
        if (isNaN(amount) || amount <= 0 || !task) { msg.reply('Usage: `!bounty post <amount> <task>`\n💡 Try `!bounty suggest` for ideas!'); return; }
        if (amount < 50)   { msg.reply('❌ Minimum bounty is 🪙 50.'); return; }
        if (userData.botcoin < amount) { msg.reply(`❌ You only have 🪙 ${userData.botcoin.toLocaleString()}.`); return; }
        userData.botcoin -= amount;
        const bountyId = Math.random().toString(36).substring(2, 6).toUpperCase();
        globalState.bounties[bountyId] = { amount, task, posterId: userId, posterName: username, status: 'open' };
        await Promise.all([saveGlobal(), saveUser(userId, userData)]);
        const embed = new EmbedBuilder()
          .setColor(0xff4444)
          .setTitle('🎯 NEW BOUNTY POSTED!')
          .setDescription(`**Task:** ${task}`)
          .addFields(
            { name: '💰 Reward', value: `🪙 ${amount.toLocaleString()}`, inline: true },
            { name: '🪪 ID', value: bountyId, inline: true },
            { name: '📋 Posted by', value: username, inline: true },
          )
          .setFooter({ text: 'Complete it and ask the poster: !bounty award ' + bountyId + ' @you' });
        msg.reply({ embeds: [embed] });
        return;
      }

      if (sub === 'award') {
        const bountyId    = args[0]?.toUpperCase();
        const targetMatch = args[1]?.match(/<@!?(\d+)>/);
        if (!bountyId || !targetMatch) { msg.reply('Usage: `!bounty award <ID> @user`'); return; }
        const bty = (globalState.bounties || {})[bountyId];
        if (!bty || (bty as any).status !== 'open') { msg.reply('❌ Invalid or already closed bounty.'); return; }
        if ((bty as any).posterId !== userId)       { msg.reply('❌ Only the person who posted this bounty can award it.'); return; }

        const targetId   = targetMatch[1];
        if (targetId === userId) { msg.reply('❌ You cannot award yourself a bounty.'); return; }
        const targetRef  = db.collection('businessUsers').doc(targetId);
        const targetSnap = await targetRef.get();
        let targetData   = (targetSnap.data() as UserData) || defaultUser('Unknown');
        (bty as any).status  = 'closed';
        targetData.botcoin += (bty as any).amount;
        targetData.totalEarned = (targetData.totalEarned || 0) + (bty as any).amount;
        addXP(targetData, 80);
        await Promise.all([saveGlobal(), saveUser(targetId, targetData)]);
        const embed = new EmbedBuilder()
          .setColor(0xf1c40f)
          .setTitle('💰 BOUNTY CLAIMED!')
          .setDescription(`<@${targetId}> completed the task and walks away with 🪙 **${(bty as any).amount.toLocaleString()}**!`)
          .addFields({ name: '📋 Completed Task', value: (bty as any).task })
          .setFooter({ text: 'Bounty ' + bountyId + ' is now closed.' });
        msg.reply({ embeds: [embed] });
        return;
      }

      if (sub === 'cancel') {
        const bountyId = args[0]?.toUpperCase();
        if (!bountyId) { msg.reply('Usage: `!bounty cancel <ID>`'); return; }
        const bty = (globalState.bounties || {})[bountyId];
        if (!bty || (bty as any).status !== 'open') { msg.reply('❌ Invalid or already closed bounty.'); return; }
        if ((bty as any).posterId !== userId) { msg.reply('❌ Only the poster can cancel their bounty.'); return; }
        const refund = Math.floor((bty as any).amount * 0.8);
        userData.botcoin += refund;
        (bty as any).status = 'cancelled';
        await Promise.all([saveGlobal(), saveUser(userId, userData)]);
        msg.reply(`🔴 **Bounty [${bountyId}] Cancelled.** Refunded 🪙 **${refund.toLocaleString()}** (80% back).`);
        return;
      }

      msg.reply('📋 Subcommands: `!bounty list` | `!bounty post <amt> <task>` | `!bounty award <id> @user` | `!bounty cancel <id>` | `!bounty suggest`');
      break;
    }

    // â”€â”€ FORGE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    case 'forge': {
      if (args.length < 2) { msg.reply(`Usage: \`!forge <emoji> <Name>\`\nCost: 🪙 **${FORGE_COST}**`); return; }
      const hasLicense = (userData.inventory['trade_license'] || 0) > 0;
      const cost       = hasLicense ? Math.floor(FORGE_COST * 0.75) : FORGE_COST;
      if (userData.botcoin < cost) { msg.reply(`âŒ Need 🪙 **${cost}** to forge.${hasLicense ? '' : '\n💡 Tip: A Trade License reduces forge cost by 25%!'}`); return; }
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
        .setTitle('âš’ï¸ Item Forged!')
        .setDescription(`${emoji} **${name}** has been permanently injected into the global economy!\n🪙 Cost: **${cost.toLocaleString()}**${hasLicense ? ' *(Trade License discount applied!)*' : ''}`)
        .setFooter({ text: `Item ID: ${itemId}` });
      msg.reply({ embeds: [embed] });
      break;
    }

    // â”€â”€ INVENTORY â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
          value: `${rarityBadge(item.rarity || 'common')}  â€¢  🪙 ${(item.value * (count as number)).toLocaleString()} total value\n${item.description ? `*${item.description}*` : ''}  \`[${key}]\``,
        });
        hasItems = true;
      }
      if (!hasItems) embed.setDescription("Empty inventory. Use `!daily` to get started!");
      msg.reply({ embeds: [embed] });
      break;
    }
    // â”€â”€ PROFILE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    case 'profile':
    case 'bal': {
      const rankSnap = await db.collection('businessUsers').where('netWorth', '>', userData.netWorth).get();
      const rank     = rankSnap.size + 1;
      const lvl      = userData.level || 1;
      const embed = new EmbedBuilder()
        .setColor(RARITY_COLOR[lvl >= 8 ? 'legendary' : lvl >= 5 ? 'epic' : lvl >= 3 ? 'rare' : 'common'])
        .setTitle(`ðŸ“Š ${username}  â€¢  ${levelLabel(lvl)} (Lv.${lvl})`)
        .addFields(
          { name: '💰 Botcoin',    value: `🪙 ${userData.botcoin.toLocaleString()}`,             inline: true },
          { name: 'ðŸ“ˆ Net Worth',  value: `🪙 ${(userData.netWorth || 0).toLocaleString()}`,     inline: true },
          { name: 'ðŸ† Rank',       value: `#${rank} globally`,                                   inline: true },
          { name: 'ðŸŽ² W/L',        value: `${userData.wins || 0}W / ${userData.losses || 0}L`,   inline: true },
          { name: '💸 Earned',     value: `🪙 ${(userData.totalEarned || 0).toLocaleString()}`,   inline: true },
          { name: 'ðŸ“… Streak',     value: `${userData.dailyStreak || 0} days`,                   inline: true },
        )
        .setFooter({ text: `XP: ${userData.xp || 0} / ${xpForLevel(lvl)} â†’ next level${userData.jailUntil > Date.now() ? ` | ðŸ”’ In jail ${Math.ceil((userData.jailUntil - Date.now())/60000)}m` : ''}` });
      msg.reply({ embeds: [embed] });
      break;
    }

    // â”€â”€ LEADERBOARD â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    case 'leaderboard':
    case 'lb':
    case 'rich': {
      const topSnap = await db.collection('businessUsers').orderBy('netWorth', 'desc').limit(10).get();
      const medals  = ['ðŸ¥‡', 'ðŸ¥ˆ', 'ðŸ¥‰', '4ï¸âƒ£', '5ï¸âƒ£', '6ï¸âƒ£', '7ï¸âƒ£', '8ï¸âƒ£', '9ï¸âƒ£', 'ðŸ”Ÿ'];
      const embed   = new EmbedBuilder()
        .setColor(0xf1c40f)
        .setTitle('ðŸ† Global Forbes List — Top Net Worth');
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

    // â”€â”€ HELP â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    case 'bhelp':
    case 'help': {
      if (command === 'help' && args[0]?.toLowerCase() !== 'businessbot') {
        return; // Let NotABot handle generic !help
      }
      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('ðŸ’¼ BusinessBot — Command Guide')
        .addFields(
          { name: 'ðŸš€ Getting Started', value: '`!start` — Claim starter grant\n`!daily` — Daily reward + mystery box\n`!open box` — Open your mystery box' },
          { name: '💰 Economy',         value: '`!profile` `!inv` `!lb` — View stats\n`!pay @user <amt>` — Send money\n`!rob @user` — Steal (risky!)\n`!slots <bet>` — Slot machine' },
          { name: 'ðŸŽ² Gambling',        value: '`!wager @user <amt>` — Coinflip challenge\n`!accept @user` — Accept a wager\n`!challenge @user <amt> <terms>` — 1v1 custom bet\n`!yield <id>` — Surrender challenge\n`!award <id> @winner` — Declare winner' },
          { name: 'ðŸ“ˆ Stocks',          value: '`!stocks` — View market\n`!buy <SYM> <shares>` — Invest\n`!sell <SYM> <shares>` — Exit position\n`!portfolio` — View holdings' },
          { name: 'ðŸ›’ Shop & Crafting', value: '`!shop` — Browse items for sale\n`!buy item <id>` — Buy from shop\n`!forge <emoji> <name>` — Forge custom item (🪙2000)\n`!vault` — Use a Vault Key for bonus loot' },
          { name: 'ðŸ¤ Trading',         value: '`!trade @user <item> for <item>` — Propose trade\n`!tradea <id>` — Accept trade\n`!traded <id>` — Decline trade' },
          { name: '🔨 Auctions',        value: '`!auction start <item_id>` — List item\n`!auction bid <key> <amt>` — Place bid\n`!auction list` — View active' },
          { name: '📜 Bounties',        value: '`!bounty post <amt> <task>` — Post task\n`!bounty list` — View open bounties\n`!bounty award <id> @user` — Pay out' },
        )
        .setFooter({ text: 'Tip: Lucky Charm boosts coinflip odds. Piggy Bank earns more interest. Nuke helps rob.' });
      msg.reply({ embeds: [embed] });
      break;
    }
  }
}

async function handleNaturalLanguage(msg: Message) {
  const userId   = msg.author.id;
  const username = msg.member?.displayName || msg.author.username;

  const userRef  = db.collection('businessUsers').doc(userId);
  const snap     = await userRef.get();
  const userData = (snap.data() as UserData | undefined) || defaultUser(username);

  let promptText = msg.content.replace(new RegExp('<@!?' + botClient!.user!.id + '>', 'g'), '').trim();
  if (!promptText) promptText = 'Hello!';

  // Resolve all @mentioned users so the AI can use real Discord IDs in args
  const mentionedUsers: { id: string; name: string }[] = [];
  for (const [id, member] of msg.mentions.members ?? []) {
    if (id === botClient!.user!.id) continue;
    mentionedUsers.push({ id, name: member.displayName || member.user.username });
  }
  const mentionCtx = mentionedUsers.length
    ? mentionedUsers.map(u => u.name + '=<@' + u.id + '>').join(', ')
    : 'none';

  const inventorySummary = Object.entries(userData.inventory || {})
    .filter(([, v]) => (v as number) > 0).map(([k, v]) => k + 'x' + v).join(', ') || 'empty';
  const stocksSummary = Object.entries(userData.stocks || {})
    .filter(([, v]) => (v as number) > 0).map(([k, v]) => k + 'x' + v).join(', ') || 'none';

  const systemPrompt = [
    'You are BusinessBot — a precise, professional personal wealth manager. Address the user as "Sir". Be brief and token-efficient.',
    '',
    'USER: ' + username + ' | Coins: ' + userData.botcoin + ' | Inv: ' + inventorySummary + ' | Stocks: ' + stocksSummary,
    'MENTIONED USERS (use these exact strings for @user args): ' + mentionCtx,
    '',
    'COMMANDS:',
    'daily | profile | lb | portfolio | shop',
    'open    -> args: ["box"]',
    'slots   -> args: ["<amount>"]',
    'pay     -> args: ["<@id>", "<amount>"]   (needs a mentioned user)',
    'rob     -> args: ["<@id>"]               (needs a mentioned user)',
    'wager   -> args: ["<@id>", "<amount>"]   (needs a mentioned user)',
    'buy     -> args: ["<SYMBOL>", "<shares>"]',
    'sell    -> args: ["<SYMBOL>", "<shares>"]',
    '',
    'RULES:',
    '- wager/pay/rob REQUIRE a real <@id> from MENTIONED USERS. If none mentioned, set action="ask".',
    '- If amount > user coins, set action="reply" and inform Sir they cannot afford it.',
    '- If any required arg is missing, set action="ask".',
    '- ONLY output valid JSON. No markdown, no explanation.',
    '',
    'FORMATS (pick one):',
    '{"action":"execute_command","command":"<name>","args":[...],"reply":"<one-line Sir-addressed confirmation>"}',
    '{"action":"ask","reply":"<one-line question to Sir>"}',
    '{"action":"reply","reply":"<one-line response to Sir>"}',
  ].join('\n');

  try {
    const raw = await groq.call(systemPrompt, promptText);
    let parsed: any;
    try {
      parsed = JSON.parse(raw.replace(/```json/gi, '').replace(/```/g, '').trim());
    } catch {
      await msg.reply('Sir, I had trouble parsing that. Please rephrase.').catch(() => {});
      return;
    }

    if (parsed.reply) {
      await msg.reply(String(parsed.reply)).catch(() => {});
    }

    if (parsed.action === 'execute_command' && parsed.command) {
      const spendingCmds = new Set(['slots', 'pay', 'wager']);
      if (spendingCmds.has(parsed.command)) {
        const amtStr = (parsed.command === 'pay' || parsed.command === 'wager')
          ? parsed.args?.[1] : parsed.args?.[0];
        const amt = parseInt(amtStr, 10);
        if (!isNaN(amt) && amt > userData.botcoin) return; // balance check already in reply
      }
      await handleCommand(msg, parsed.command, (parsed.args || []).map(String));
    }
  } catch (e) {
    console.error('[BusinessBot] NLP error:', e);
    await msg.reply('Sir, something went wrong. Please try again.').catch(() => {});
  }
}