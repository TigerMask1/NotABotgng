import {
  Client, GatewayIntentBits, Message, Partials, Events, EmbedBuilder
} from 'discord.js';
import { db } from './firebase.ts';
import { groq } from './groqBot.ts';

let botClient: Client | null = null;
const PREFIX = '!';

// ΓöÇΓöÇ CONSTANTS ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
const STARTER_GRANT  = 1_000;
const DAILY_BASE     = 200;
const STREAK_BONUS   = 50;     // per-day streak addition
const MAX_STREAK     = 30;     // streak cap for payouts
const FORGE_COST     = 2_000;
const ROB_COOLDOWN   = 3 * 60 * 60 * 1000; // 3h
const JAIL_DURATION  = 30 * 60 * 1000;      // 30min
const INTEREST_RATE  = 0.001;               // 0.1% per hour, applied on !daily
const AUCTION_DURATION = 5 * 60 * 1000;     // 5 minutes

// ΓöÇΓöÇ ITEM CATALOGUE ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
interface ItemDef {
  name: string;
  emoji: string;
  value: number;
  rarity: 'common' | 'rare' | 'epic' | 'legendary';
  shopPrice?: number;
  description?: string;
}

const ITEMS: Record<string, ItemDef> = {
  mystery_box:    { name: 'Mystery Box',     emoji: '≡ƒÄü', value: 0,      rarity: 'common',    description: 'Open with !open box' },
  rusty_coin:     { name: 'Rusty Coin',      emoji: '≡ƒ¬Ö', value: 10,     rarity: 'common' },
  trade_license:  { name: 'Trade License',   emoji: '≡ƒô£', value: 2_000,  rarity: 'rare',   shopPrice: 3_500, description: 'Reduces forge cost by 25%' },
  golden_rolex:   { name: 'Golden Rolex',    emoji: 'ΓîÜ', value: 5_000,  rarity: 'epic' },
  ceo_title:      { name: 'CEO Title',       emoji: '≡ƒææ', value: 10_000, rarity: 'legendary' },
  lucky_charm:    { name: 'Lucky Charm',     emoji: '≡ƒìÇ', value: 1_500,  rarity: 'rare',   shopPrice: 2_500, description: '+10% coinflip win chance' },
  diamond:        { name: 'Diamond',         emoji: '≡ƒÆÄ', value: 8_000,  rarity: 'epic' },
  vault_key:      { name: 'Vault Key',       emoji: '≡ƒù¥∩╕Å', value: 3_000,  rarity: 'rare',   shopPrice: 5_000, description: 'Open the Vault for bonus loot' },
  nuke:           { name: 'Nuke',            emoji: '≡ƒÆú', value: 500,    rarity: 'rare',   shopPrice: 1_000, description: 'Rob with +20% success chance' },
  piggy_bank:     { name: 'Piggy Bank',      emoji: '≡ƒÉ╖', value: 750,    rarity: 'common', shopPrice: 1_000, description: '+50% bank interest rate' },
  hacker_kit:     { name: 'Hacker Kit',      emoji: '≡ƒÆ╗', value: 1_200,  rarity: 'rare',   shopPrice: 2_000, description: 'Double !daily once' },
  golden_ticket:  { name: 'Golden Ticket',   emoji: '≡ƒÄƒ∩╕Å', value: 500,    rarity: 'common' },
  crystal_ball:   { name: 'Crystal Ball',    emoji: '≡ƒö«', value: 4_000,  rarity: 'epic',   shopPrice: 6_000, description: 'Reveal stock trends before investing' },
};

// ΓöÇΓöÇ STOCK MARKET ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
interface Stock {
  name: string;
  emoji: string;
  price: number;
  trend: number;    // -1 to +1, positive = bull
  volatility: number;
}

const STOCKS: Record<string, Stock> = {
  BOTC: { name: 'BotCoin Industries', emoji: '≡ƒ¬Ö', price: 100, trend: 0.3,  volatility: 0.15 },
  CLOD: { name: 'Cloud Corp',         emoji: 'Γÿü∩╕Å', price: 250, trend: -0.1, volatility: 0.22 },
  GRLX: { name: 'Golden Rolex Ltd',   emoji: 'ΓîÜ', price: 500, trend: 0.2,  volatility: 0.18 },
  MBOX: { name: 'Mystery Box Corp',   emoji: '≡ƒÄü', price: 75,  trend: 0.0,  volatility: 0.30 },
  NUKE: { name: 'Nuke Holdings',      emoji: '≡ƒÆú', price: 175, trend: 0.1,  volatility: 0.28 },
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

// ΓöÇΓöÇ IN-MEMORY STATE ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
interface Wager    { fromId: string; toId: string; amount: number; fromName: string }
interface Challenge { id: string; fromId: string; toId: string; amount: number; terms: string }
interface Auction  { itemId: string; customKey?: string; sellerId: string; highestBid: number; highestBidder: string | null; highestBidderName: string | null; endTime: number; channelId: string; guildId: string }
interface Trade    { id: string; fromId: string; toId: string; offerItems: Record<string, number>; offerBotcoin: number; wantItems: Record<string, number>; wantBotcoin: number }

const pendingWagers    = new Map<string, Wager>();
const activeChallenges = new Map<string, Challenge>();
const activeAuctions   = new Map<string, Auction>();
const pendingTrades    = new Map<string, Trade>();

// ΓöÇΓöÇ SCHEMA ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
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

// ΓöÇΓöÇ HELPERS ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
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
    'Market Overlord',    // 10 ΓÇö final rank
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
  return { common: 'Γ¼£ Common', rare: '≡ƒö╡ Rare', epic: '≡ƒƒú Epic', legendary: '≡ƒƒí Legendary' }[r] || r;
}

// ΓöÇΓöÇ BOT LIFECYCLE ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
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
    botClient!.user!.setPresence({ status: 'online', activities: [{ name: '≡ƒôê the free market', type: 3 }] });
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

// ΓöÇΓöÇ COMMAND ROUTER ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
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

  // jail check ΓÇö most commands blocked while in jail
  const JAIL_FREE = new Set(['profile', 'bal', 'inv', 'inventory', 'lb', 'leaderboard', 'rich', 'help', 'stocks', 'market']);
  if (userData.jailUntil > Date.now() && !JAIL_FREE.has(command)) {
    const mins = Math.ceil((userData.jailUntil - Date.now()) / 60000);
    msg.reply(`≡ƒöÆ You're in jail! ${mins} minute(s) left. You can't do that in here.`);
    return;
  }

  switch (command) {

    // ΓöÇΓöÇ ONBOARDING ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
    case 'start':
    case 'grant': {
      if (userData.granted) {
        msg.reply('Γ¥î You already received your starter grant from the Central Bank.');
        return;
      }
      userData.botcoin  += STARTER_GRANT;
      userData.granted   = true;
      userData.totalEarned += STARTER_GRANT;
      addXP(userData, 50);
      await saveUser(userId, userData);
      const embed = new EmbedBuilder()
        .setColor(0x2ecc71)
        .setTitle('≡ƒÅª Central Bank ΓÇö Starter Grant')
        .setDescription(`Welcome to the **Free Market**, ${username}!\nYou've been issued ≡ƒ¬Ö **${STARTER_GRANT.toLocaleString()} Botcoin** by the Central Bank.`)
        .addFields(
          { name: '≡ƒôï Next Steps', value: '`!daily` ΓÇö Claim daily reward\n`!help` ΓÇö See all commands\n`!stocks` ΓÇö Check the market' }
        )
        .setFooter({ text: 'Spend it wisely. Or don\'t. This is the Free Market.' });
      msg.reply({ embeds: [embed] });
      break;
    }

    // ΓöÇΓöÇ DAILY ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
    case 'daily': {
      const now    = Date.now();
      const oneDay = 24 * 60 * 60 * 1000;
      const twoDays = 2 * oneDay;
      if (now - userData.lastDaily < oneDay) {
        const hoursLeft = Math.ceil((oneDay - (now - userData.lastDaily)) / 3_600_000);
        msg.reply(`Γ¥î Already claimed! Come back in **${hoursLeft}h**.`);
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
        .setTitle(`≡ƒÄü Daily Reward ΓÇö Day ${streak} Streak!`)
        .addFields(
          { name: '≡ƒÆ░ Daily',    value: `≡ƒ¬Ö ${dailyAmt.toLocaleString()}`,  inline: true },
          { name: '≡ƒôê Interest', value: `≡ƒ¬Ö ${interest.toLocaleString()}`,  inline: true },
          { name: streak >= 7 ? '≡ƒöÑ Streak Bonus' : 'ΓÜí Streak', value: `≡ƒ¬Ö ${streakBonus.toLocaleString()} (day ${streak})`, inline: true },
        )
        .setDescription(`You also got a **Mystery Box ≡ƒÄü**! Use \`!open box\` to see what's inside.\n${bonus > 0 ? '≡ƒûÑ∩╕Å **Hacker Kit** doubled your daily!' : ''}`)
        .setFooter({ text: `Balance: ≡ƒ¬Ö ${userData.botcoin.toLocaleString()} | New worth: ≡ƒ¬Ö ${userData.netWorth.toLocaleString()}` });
      msg.reply({ embeds: [embed] });
      break;
    }

    // ΓöÇΓöÇ OPEN BOX ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
    case 'open': {
      if (args[0] !== 'box' && args[0] !== 'mystery_box') {
        msg.reply('Usage: `!open box`'); return;
      }
      if (!userData.inventory['mystery_box'] || userData.inventory['mystery_box'] <= 0) {
        msg.reply("Γ¥î You don't have any Mystery Boxes! Use `!daily` to get one."); return;
      }
      userData.inventory['mystery_box']--;

      const roll = Math.random();
      let reward = '';
      let color: number = 0x95a5a6;

      if (roll < 0.005) {           // 0.5% Jackpot
        const amt = 15_000;
        userData.botcoin += amt;
        reward = `≡ƒîƒ **MEGA JACKPOT!!!** ≡ƒîƒ\n+≡ƒ¬Ö **${amt.toLocaleString()} Botcoin**`;
        color  = 0xf1c40f;
        addXP(userData, 500);
      } else if (roll < 0.03) {     // 2.5% Legendary
        const legendaries = ['ceo_title', 'diamond'];
        const won = legendaries[Math.floor(Math.random() * legendaries.length)];
        userData.inventory[won] = (userData.inventory[won] || 0) + 1;
        const i = ITEMS[won];
        reward = `≡ƒææ **LEGENDARY DROP!** ≡ƒææ\n${i.emoji} **${i.name}**  ΓÇó  ${rarityBadge(i.rarity)}`;
        color  = 0xf1c40f;
        addXP(userData, 300);
      } else if (roll < 0.12) {     // 9% Epic
        const epics = ['golden_rolex'];
        const won = epics[Math.floor(Math.random() * epics.length)];
        userData.inventory[won] = (userData.inventory[won] || 0) + 1;
        const i = ITEMS[won];
        reward = `≡ƒö« **EPIC DROP!** ≡ƒö«\n${i.emoji} **${i.name}**  ΓÇó  ${rarityBadge(i.rarity)}`;
        color  = 0x9b59b6;
        addXP(userData, 150);
      } else if (roll < 0.35) {     // 23% Rare
        const rares = ['trade_license', 'lucky_charm', 'vault_key', 'hacker_kit', 'nuke'];
        const won = rares[Math.floor(Math.random() * rares.length)];
        userData.inventory[won] = (userData.inventory[won] || 0) + 1;
        const i = ITEMS[won];
        reward = `Γ£¿ **Rare Drop!** Γ£¿\n${i.emoji} **${i.name}**  ΓÇó  ${rarityBadge(i.rarity)}`;
        color  = 0x3498db;
        addXP(userData, 80);
      } else if (roll < 0.90) {     // 55% Common coin
        const amt = Math.floor(Math.random() * 201) + 50;
        userData.botcoin += amt;
        reward = `You found ≡ƒ¬Ö **${amt.toLocaleString()} Botcoin** in the box.`;
        color  = 0x2ecc71;
        addXP(userData, 20);
      } else {                      // 10% Trash
        userData.inventory['rusty_coin'] = (userData.inventory['rusty_coin'] || 0) + 1;
        reward = `You found a ≡ƒ¬Ö **Rusty Coin**. Congratulations on your suffering.`;
        addXP(userData, 5);
      }

      await saveUser(userId, userData);
      const embed = new EmbedBuilder()
        .setColor(color)
        .setTitle('≡ƒÄü Opening Mystery Box...')
        .setDescription(reward)
        .setFooter({ text: `Balance: ≡ƒ¬Ö ${userData.botcoin.toLocaleString()} | Boxes left: ${userData.inventory['mystery_box'] || 0}` });
      msg.reply({ embeds: [embed] });
      break;
    }

    // ΓöÇΓöÇ VAULT ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
    case 'vault': {
      if (!userData.inventory['vault_key'] || userData.inventory['vault_key'] <= 0) {
        msg.reply('Γ¥î You need a ≡ƒù¥∩╕Å **Vault Key** to open the vault. Buy one from `!shop` or find one in a box!');
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
      msg.reply(`≡ƒù¥∩╕Å The vault door swings open... you grabbed ≡ƒ¬Ö **${loot.toLocaleString()} Botcoin**!${extra}`);
      break;
    }

    // ΓöÇΓöÇ SLOTS ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
    case 'slots': {
      const bet = parseInt(args[0], 10);
      if (isNaN(bet) || bet <= 0) { msg.reply('Usage: `!slots <amount>`'); return; }
      if (bet > userData.botcoin)  { msg.reply(`Γ¥î You only have ≡ƒ¬Ö ${userData.botcoin.toLocaleString()}.`); return; }
      if (bet > 10_000)            { msg.reply('Γ¥î Max bet is ≡ƒ¬Ö 10,000.'); return; }

      const symbols = ['≡ƒìÆ', '≡ƒìï', '≡ƒìè', '≡ƒÆÄ', '≡ƒöö', 'Γ¡É', '≡ƒÄ░', '7∩╕ÅΓâú'];
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
        const multipliers: Record<string, number> = { '7∩╕ÅΓâú': 20, '≡ƒÄ░': 15, 'Γ¡É': 10, '≡ƒöö': 8, '≡ƒÆÄ': 7, '≡ƒìè': 4, '≡ƒìï': 3, '≡ƒìÆ': 2 };
        const mult = multipliers[reels[0]] || 2;
        winAmt = bet * mult;
        winMsg = mult >= 10 ? `≡ƒÄë **JACKPOT!** ${mult}x = ≡ƒ¬Ö **${winAmt.toLocaleString()}**!` : `Γ£¿ **Triple ${reels[0]}!** ${mult}x = ≡ƒ¬Ö **${winAmt.toLocaleString()}**`;
        userData.wins++;
      } else if (reels[0] === reels[1] || reels[1] === reels[2] || reels[0] === reels[2]) {
        winAmt = Math.floor(bet * 0.5);
        winMsg = `Pair! You get back ≡ƒ¬Ö **${winAmt.toLocaleString()}**`;
      } else {
        winMsg = `No match. You lost ≡ƒ¬Ö **${bet.toLocaleString()}**.`;
        userData.losses++;
      }

      userData.botcoin += winAmt;
      userData.totalEarned += winAmt;
      addXP(userData, 10);
      await saveUser(userId, userData);

      const embed = new EmbedBuilder()
        .setColor(winAmt > 0 ? 0xf1c40f : 0xff0000)
        .setTitle('≡ƒÄ░ Slot Machine')
        .setDescription(`**${reels.join('  |  ')}**\n\n${winMsg}`)
        .setFooter({ text: `Balance: ≡ƒ¬Ö ${userData.botcoin.toLocaleString()}` });
      msg.reply({ embeds: [embed] });
      break;
    }

    // ΓöÇΓöÇ ROB ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
    case 'rob': {
      const targetMatch = args[0]?.match(/<@!?(\d+)>/);
      if (!targetMatch) { msg.reply('Usage: `!rob @user`'); return; }
      const targetId = targetMatch[1];
      if (targetId === userId) { msg.reply("Γ¥î You can't rob yourself."); return; }

      const now = Date.now();
      if (now - (userData.lastRob || 0) < ROB_COOLDOWN) {
        const minsLeft = Math.ceil((ROB_COOLDOWN - (now - userData.lastRob)) / 60_000);
        msg.reply(`Γ¥î You're laying low after your last job. Try again in **${minsLeft}m**.`);
        return;
      }

      const targetRef  = db.collection('businessUsers').doc(targetId);
      const targetSnap = await targetRef.get();
      const targetData = targetSnap.data() as UserData | undefined;
      if (!targetData || targetData.botcoin < 100) {
        msg.reply("Γ¥î Target is too broke to rob. Pick someone richer."); return;
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
        msg.reply(`≡ƒÆ░ **ROB SUCCESS!** You swiped ≡ƒ¬Ö **${stolen.toLocaleString()}** from <@${targetId}>!${hasNuke ? ' (Nuke used ≡ƒÆú)' : ''}`);
      } else {
        const fine = Math.floor(userData.botcoin * 0.10);
        userData.botcoin  = Math.max(0, userData.botcoin - fine);
        userData.jailUntil = now + JAIL_DURATION;
        userData.losses++;
        addXP(userData, 10);
        await saveUser(userId, userData);
        msg.reply(`≡ƒÜö **CAUGHT!** You got arrested robbing <@${targetId}>. Paid ≡ƒ¬Ö **${fine.toLocaleString()}** fine and you're in jail for **30 minutes**. Use \`!profile\` to see your sentence.`);
      }
      break;
    }

    // ΓöÇΓöÇ WAGER (COINFLIP) ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
    case 'wager':
    case 'flip': {
      if (args.length < 2) { msg.reply('Usage: `!wager @user <amount>`'); return; }
      const targetMatch = args[0].match(/<@!?(\d+)>/);
      if (!targetMatch) { msg.reply('Please mention a user.'); return; }
      const targetId = targetMatch[1];
      const amount   = parseInt(args[1], 10);

      if (isNaN(amount) || amount <= 0) { msg.reply('Invalid amount.'); return; }
      if (amount > userData.botcoin)    { msg.reply(`Γ¥î You only have ≡ƒ¬Ö ${userData.botcoin.toLocaleString()}.`); return; }
      if (targetId === userId)          { msg.reply("Γ¥î Can't wager against yourself."); return; }
      if (amount > 50_000)              { msg.reply('Γ¥î Max wager is ≡ƒ¬Ö 50,000.'); return; }

      const wagerKey = `${targetId}-${userId}`;
      pendingWagers.set(wagerKey, { fromId: userId, toId: targetId, amount, fromName: username });

      const embed = new EmbedBuilder()
        .setColor(0xffff00)
        .setTitle('≡ƒÄ▓ Coinflip Challenge!')
        .setDescription(`<@${targetId}>, **${username}** challenged you to a 50/50 coinflip for ≡ƒ¬Ö **${amount.toLocaleString()}**!\n\nType \`!accept @${username}\` to accept, or just ignore it.`)
        .setFooter({ text: 'Challenge expires in 5 minutes.' });
      msg.reply({ embeds: [embed] });

      setTimeout(() => pendingWagers.delete(wagerKey), 5 * 60_000);
      break;
    }

    // ΓöÇΓöÇ ACCEPT (WAGER) ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
    case 'accept': {
      if (args.length < 1) { msg.reply('Usage: `!accept @user`'); return; }
      const targetMatch = args[0].match(/<@!?(\d+)>/);
      if (!targetMatch) { msg.reply('Mention the user who challenged you.'); return; }
      const challengerId = targetMatch[1];
      const wagerKey     = `${userId}-${challengerId}`;
      const wager        = pendingWagers.get(wagerKey);

      if (!wager) { msg.reply('Γ¥î No pending wager from that user.'); return; }
      if (userData.botcoin < wager.amount) { msg.reply(`Γ¥î You need ≡ƒ¬Ö ${wager.amount.toLocaleString()} to accept.`); return; }

      const challengerRef  = db.collection('businessUsers').doc(challengerId);
      const challengerSnap = await challengerRef.get();
      let challengerData   = challengerSnap.data() as UserData;
      if (!challengerData || challengerData.botcoin < wager.amount) {
        msg.reply("Γ¥î Challenger no longer has enough ≡ƒ¬Ö!");
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
        .setTitle('≡ƒÄ▓ Coinflip Result')
        .setDescription(`≡ƒ¬Ö The coin spins...\n\n≡ƒÅå **<@${winnerId}> wins ≡ƒ¬Ö ${wager.amount.toLocaleString()}** from <@${loserId}>!${hasLucky ? '\n≡ƒìÇ (Lucky Charm activated!)' : ''}`)
        .setFooter({ text: `Winner balance: ≡ƒ¬Ö ${winner.botcoin.toLocaleString()}` });
      msg.reply({ embeds: [embed] });
      break;
    }

    // ΓöÇΓöÇ CHALLENGE (1v1) ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
    case 'challenge': {
      if (args.length < 3) { msg.reply('Usage: `!challenge @user <amount> <terms>`'); return; }
      const targetMatch = args[0].match(/<@!?(\d+)>/);
      if (!targetMatch) { msg.reply('Please mention a user.'); return; }
      const targetId = targetMatch[1];
      const amount   = parseInt(args[1], 10);
      const terms    = args.slice(2).join(' ');

      if (isNaN(amount) || amount <= 0) { msg.reply('Invalid amount.'); return; }
      if (amount > userData.botcoin)    { msg.reply(`Γ¥î You only have ≡ƒ¬Ö ${userData.botcoin.toLocaleString()}.`); return; }
      if (targetId === userId)          { msg.reply("Γ¥î Can't challenge yourself."); return; }

      const targetRef  = db.collection('businessUsers').doc(targetId);
      const targetSnap = await targetRef.get();
      const targetData = targetSnap.data();
      if (!targetData || targetData.botcoin < amount) {
        msg.reply(`Γ¥î <@${targetId}> doesn't have enough ≡ƒ¬Ö to match!`); return;
      }

      userData.botcoin -= amount;
      await saveUser(userId, userData);

      const challengeId = Math.random().toString(36).substring(2, 8).toUpperCase();
      activeChallenges.set(challengeId, { id: challengeId, fromId: userId, toId: targetId, amount, terms });

      const embed = new EmbedBuilder()
        .setColor(0xe67e22)
        .setTitle(`ΓÜö∩╕Å Challenge Issued ΓÇö [${challengeId}]`)
        .setDescription(`<@${targetId}>, **${username}** has challenged you!\n\n**Terms:** *${terms}*\n**Pot:** ≡ƒ¬Ö ${(amount * 2).toLocaleString()} total (≡ƒ¬Ö ${amount.toLocaleString()} each side)`)
        .addFields({ name: 'How to resolve', value: '**Winner:** Both parties agree ΓÇö type `!award <id> @winner`\n**Surrender:** Type `!yield <id>` to forfeit your side' });
      msg.reply({ embeds: [embed] });
      break;
    }

    // ΓöÇΓöÇ YIELD ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
    case 'yield': {
      const challengeId = args[0]?.toUpperCase();
      if (!challengeId) { msg.reply('Usage: `!yield <Challenge_ID>`'); return; }
      const challenge   = activeChallenges.get(challengeId);
      if (!challenge)   { msg.reply('Γ¥î Invalid or finished challenge.'); return; }
      if (userId !== challenge.toId && userId !== challenge.fromId) {
        msg.reply("Γ¥î You're not part of this challenge."); return;
      }

      const winnerId = userId === challenge.fromId ? challenge.toId : challenge.fromId;
      if (userId === challenge.toId) {
        if (userData.botcoin < challenge.amount) { msg.reply("Γ¥î Not enough ≡ƒ¬Ö to pay!"); return; }
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

      msg.reply(`≡ƒÅ│∩╕Å **YIELD!** <@${userId}> surrenders! <@${winnerId}> wins the ≡ƒ¬Ö **${(challenge.amount * 2).toLocaleString()}** pot!`);
      break;
    }

    // ΓöÇΓöÇ AWARD CHALLENGE ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
    case 'award': {
      const challengeId  = args[0]?.toUpperCase();
      const targetMatch  = args[1]?.match(/<@!?(\d+)>/);
      if (!challengeId || !targetMatch) { msg.reply('Usage: `!award <Challenge_ID> @winner`'); return; }
      const challenge   = activeChallenges.get(challengeId);
      if (!challenge)   { msg.reply('Γ¥î Invalid or finished challenge.'); return; }
      if (userId !== challenge.fromId && userId !== challenge.toId) {
        msg.reply("Γ¥î Only participants can award."); return;
      }
      const winnerId = targetMatch[1];
      if (winnerId !== challenge.fromId && winnerId !== challenge.toId) {
        msg.reply("Γ¥î Winner must be one of the two participants."); return;
      }

      const loserId = winnerId === challenge.fromId ? challenge.toId : challenge.fromId;
      const winnerRef  = db.collection('businessUsers').doc(winnerId);
      const loserRef   = db.collection('businessUsers').doc(loserId);
      const [winnerSnap, loserSnap] = await Promise.all([winnerRef.get(), loserRef.get()]);
      let winnerData = winnerSnap.data() as UserData;
      let loserData  = loserSnap.data() as UserData;

      // If loser is the challenged party (hasn't paid escrow yet)
      if (loserId === challenge.toId) {
        if (loserData.botcoin < challenge.amount) { msg.reply(`Γ¥î <@${loserId}> doesn't have enough ≡ƒ¬Ö!`); return; }
        loserData.botcoin -= challenge.amount;
        await saveUser(loserId, loserData);
      }

      winnerData.botcoin     += challenge.amount * 2;
      winnerData.wins         = (winnerData.wins || 0) + 1;
      winnerData.totalEarned  = (winnerData.totalEarned || 0) + challenge.amount * 2;
      addXP(winnerData, 50);
      await saveUser(winnerId, winnerData);
      activeChallenges.delete(challengeId);
      msg.reply(`≡ƒÅå **Challenge [${challengeId}] settled!** <@${winnerId}> wins ≡ƒ¬Ö **${(challenge.amount * 2).toLocaleString()}**!`);
      break;
    }

    // ΓöÇΓöÇ PAY ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
    case 'pay': {
      const targetMatch = args[0]?.match(/<@!?(\d+)>/);
      const amount      = parseInt(args[1], 10);
      if (!targetMatch || isNaN(amount) || amount <= 0) { msg.reply('Usage: `!pay @user <amount>`'); return; }
      const targetId = targetMatch[1];
      if (targetId === userId)      { msg.reply("Γ¥î Can't pay yourself."); return; }
      if (amount > userData.botcoin) { msg.reply(`Γ¥î Not enough ≡ƒ¬Ö. Balance: ${userData.botcoin.toLocaleString()}`); return; }

      const targetRef  = db.collection('businessUsers').doc(targetId);
      const targetSnap = await targetRef.get();
      let targetData   = (targetSnap.data() as UserData) || defaultUser('Unknown');

      userData.botcoin  -= amount;
      targetData.botcoin += amount;
      targetData.totalEarned = (targetData.totalEarned || 0) + amount;
      await Promise.all([saveUser(userId, userData), saveUser(targetId, targetData)]);
      msg.reply(`≡ƒÆ╕ Sent ≡ƒ¬Ö **${amount.toLocaleString()}** to <@${targetId}>!`);
      break;
    }

    // ΓöÇΓöÇ STOCKS ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
    case 'stocks':
    case 'market': {
      const embed = new EmbedBuilder()
        .setColor(0x23272a)
        .setTitle('≡ƒôê Botcoin Stock Exchange')
        .setDescription('Buy: `!buy <SYMBOL> <shares>` | Sell: `!sell <SYMBOL> <shares>`')
        .setFooter({ text: 'Prices update every 10 minutes. Past performance Γëá future results.' });
      for (const [sym, s] of Object.entries(STOCKS)) {
        const trendArrow = s.trend > 0.1 ? '≡ƒôê' : s.trend < -0.1 ? '≡ƒôë' : 'Γ₧í∩╕Å';
        const owned = userData.stocks?.[sym] || 0;
        embed.addFields({
          name: `${s.emoji} ${s.name} [${sym}]`,
          value: `≡ƒ¬Ö **${s.price.toLocaleString()}**/share   ${trendArrow}${owned > 0 ? `   You own: **${owned}**` : ''}`,
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
      if (!stock) { msg.reply(`Γ¥î Unknown symbol. Available: ${Object.keys(STOCKS).join(', ')}`); return; }
      const cost = stock.price * shares;
      if (cost > userData.botcoin) { msg.reply(`Γ¥î Costs ≡ƒ¬Ö ${cost.toLocaleString()}. You have ≡ƒ¬Ö ${userData.botcoin.toLocaleString()}.`); return; }
      userData.botcoin    -= cost;
      userData.stocks     ??= {};
      userData.stocks[sym] = (userData.stocks[sym] || 0) + shares;
      addXP(userData, 20);
      await saveUser(userId, userData);
      msg.reply(`≡ƒôê Bought **${shares}x ${stock.name}** [${sym}] for ≡ƒ¬Ö **${cost.toLocaleString()}**. Avg: ${stock.price}/share.`);
      break;
    }

    case 'sell': {
      const sym    = args[0]?.toUpperCase();
      const shares = parseInt(args[1], 10);
      if (!sym || isNaN(shares) || shares <= 0) { msg.reply('Usage: `!sell <SYMBOL> <shares>`'); return; }
      const stock = STOCKS[sym];
      if (!stock) { msg.reply(`Γ¥î Unknown symbol.`); return; }
      const owned = userData.stocks?.[sym] || 0;
      if (owned < shares) { msg.reply(`Γ¥î You only own **${owned}** shares of ${sym}.`); return; }
      const revenue = stock.price * shares;
      userData.botcoin       += revenue;
      userData.stocks[sym]    = owned - shares;
      userData.totalEarned   += revenue;
      addXP(userData, 15);
      await saveUser(userId, userData);
      msg.reply(`≡ƒôë Sold **${shares}x ${sym}** for ≡ƒ¬Ö **${revenue.toLocaleString()}**.`);
      break;
    }

    case 'portfolio': {
      const embed = new EmbedBuilder()
        .setColor(0x3498db)
        .setTitle(`≡ƒôè ${username}'s Portfolio`);
      let total = 0;
      let hasStocks = false;
      for (const [sym, shares] of Object.entries(userData.stocks || {})) {
        if ((shares as number) <= 0) continue;
        const s = STOCKS[sym];
        if (!s) continue;
        const val = s.price * (shares as number);
        total += val;
        hasStocks = true;
        embed.addFields({ name: `${s.emoji} ${sym}`, value: `${shares} shares @ ≡ƒ¬Ö${s.price} = ≡ƒ¬Ö **${val.toLocaleString()}**`, inline: true });
      }
      if (!hasStocks) embed.setDescription('No stocks owned. Use `!buy <SYMBOL> <shares>` to invest.');
      else embed.setDescription(`Total stock value: ≡ƒ¬Ö **${total.toLocaleString()}**`);
      msg.reply({ embeds: [embed] });
      break;
    }

    // ΓöÇΓöÇ SHOP ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
    case 'shop': {
      const shopItems = Object.entries(ITEMS).filter(([, v]) => v.shopPrice);
      const embed = new EmbedBuilder()
        .setColor(0xf1c40f)
        .setTitle('≡ƒ¢Æ Black Market Shop')
        .setDescription('Buy items with `!buy item <item_id>`');
      for (const [key, item] of shopItems) {
        embed.addFields({
          name: `${item.emoji} ${item.name}  [${key}]  ${rarityBadge(item.rarity)}`,
          value: `≡ƒ¬Ö **${item.shopPrice!.toLocaleString()}**  ΓÇó  ${item.description || ''}`,
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
      if (!item || !item.shopPrice) { msg.reply('Γ¥î That item is not in the shop. Use `!shop` to browse.'); return; }
      if (userData.botcoin < item.shopPrice) { msg.reply(`Γ¥î Costs ≡ƒ¬Ö ${item.shopPrice.toLocaleString()}. You have ≡ƒ¬Ö ${userData.botcoin.toLocaleString()}.`); return; }
      userData.botcoin -= item.shopPrice;
      userData.inventory[itemId] = (userData.inventory[itemId] || 0) + 1;
      addXP(userData, 30);
      await saveUser(userId, userData);
      msg.reply(`≡ƒ¢Æ Bought ${item.emoji} **${item.name}** for ≡ƒ¬Ö ${item.shopPrice.toLocaleString()}!`);
      break;
    }

    // ΓöÇΓöÇ TRADE ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
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
      if (!(allItems[offerKey])) { msg.reply(`Γ¥î You don't have item \`${offerKey}\` in the catalogue.`); return; }
      if (!(allItems[wantKey]))  { msg.reply(`Γ¥î Target item \`${wantKey}\` not in catalogue.`); return; }
      if ((userData.inventory[offerKey] || 0) <= 0) { msg.reply(`Γ¥î You don't own **${allItems[offerKey].name}**.`); return; }

      const tradeId = Math.random().toString(36).substring(2, 6).toUpperCase();
      pendingTrades.set(tradeId, {
        id: tradeId, fromId: userId, toId: targetId,
        offerItems: { [offerKey]: 1 }, offerBotcoin: 0,
        wantItems:  { [wantKey]: 1 },  wantBotcoin: 0,
      });
      setTimeout(() => pendingTrades.delete(tradeId), 5 * 60_000);

      const embed = new EmbedBuilder()
        .setColor(0x1abc9c)
        .setTitle(`≡ƒñ¥ Trade Offer ΓÇö [${tradeId}]`)
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
      if (!trade)           { msg.reply('Γ¥î Invalid trade ID.'); return; }
      if (trade.toId !== userId) { msg.reply("Γ¥î This trade isn't for you."); return; }

      const fromRef  = db.collection('businessUsers').doc(trade.fromId);
      const fromSnap = await fromRef.get();
      let fromData   = fromSnap.data() as UserData;
      const offerItem = Object.keys(trade.offerItems)[0];
      const wantItem  = Object.keys(trade.wantItems)[0];

      if ((fromData.inventory[offerItem] || 0) <= 0) { msg.reply("Γ¥î Offerer no longer has that item!"); return; }
      if ((userData.inventory[wantItem] || 0) <= 0)  { msg.reply(`Γ¥î You don't own ${itemDisplay(wantItem, customItems)}.`); return; }

      fromData.inventory[offerItem]--;
      userData.inventory[wantItem]--;
      fromData.inventory[wantItem] = (fromData.inventory[wantItem] || 0) + 1;
      userData.inventory[offerItem] = (userData.inventory[offerItem] || 0) + 1;

      await Promise.all([saveUser(trade.fromId, fromData), saveUser(userId, userData)]);
      pendingTrades.delete(tradeId);
      msg.reply(`Γ£à Trade [${tradeId}] complete!\n<@${trade.fromId}> got ${itemDisplay(wantItem, customItems)}\n<@${userId}> got ${itemDisplay(offerItem, customItems)}`);
      break;
    }

    case 'traded': {
      const tradeId = args[0]?.toUpperCase();
      const trade   = pendingTrades.get(tradeId);
      if (!trade)            { msg.reply('Γ¥î Invalid trade ID.'); return; }
      if (trade.toId !== userId && trade.fromId !== userId) { msg.reply("Γ¥î Not your trade."); return; }
      pendingTrades.delete(tradeId);
      msg.reply(`Γ¥î Trade [${tradeId}] declined.`);
      break;
    }

    // ΓöÇΓöÇ AUCTION ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
    case 'auction': {
      const sub = args.shift()?.toLowerCase();

      if (sub === 'list') {
        if (activeAuctions.size === 0) { msg.reply('≡ƒö¿ No active auctions right now.'); return; }
        const embed = new EmbedBuilder().setColor(0xe67e22).setTitle('≡ƒö¿ Active Auctions');
        for (const [key, a] of activeAuctions) {
          const item    = allItems[a.itemId];
          const secsLeft = Math.max(0, Math.ceil((a.endTime - Date.now()) / 1000));
          embed.addFields({
            name: `${item?.emoji || '≡ƒÄü'} ${item?.name || a.itemId}`,
            value: `Current: ≡ƒ¬Ö **${a.highestBid.toLocaleString()}** by ${a.highestBidder ? `<@${a.highestBidder}>` : 'nobody'}\nEnds in: **${secsLeft}s**\nBid: \`!auction bid ${key} <amount>\``,
          });
        }
        msg.reply({ embeds: [embed] });
        return;
      }

      if (sub === 'start') {
        const itemId = args[0];
        if (!itemId) { msg.reply('Usage: `!auction start <item_id>`'); return; }
        if ((userData.inventory[itemId] || 0) <= 0) { msg.reply(`Γ¥î You don't own \`${itemId}\`.`); return; }
        if ([...activeAuctions.values()].some(a => a.sellerId === userId)) {
          msg.reply('Γ¥î You already have an active auction.'); return;
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
          .setTitle(`≡ƒö¿ Auction Started!`)
          .setDescription(`**${username}** is auctioning ${item?.emoji || '≡ƒÄü'} **${item?.name || itemId}**!\nStarting bid: ≡ƒ¬Ö **${startBid.toLocaleString()}**`)
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
            (ch as any).send(`≡ƒö¿ Auction ended with no bids ΓÇö ${item?.emoji || ''} **${item?.name || itemId}** returned to <@${a.sellerId}>.`);
          } else {
            const buyerRef  = db.collection('businessUsers').doc(a.highestBidder);
            const buyerSnap = await buyerRef.get();
            let buyerData   = buyerSnap.data() as UserData;
            buyerData.inventory[a.itemId] = (buyerData.inventory[a.itemId] || 0) + 1;
            await buyerRef.set(buyerData as any, { merge: true });
            (ch as any).send(`≡ƒö¿ **SOLD!** ${item?.emoji || ''} **${item?.name || itemId}** ΓåÆ <@${a.highestBidder}> for ≡ƒ¬Ö **${a.highestBid.toLocaleString()}**!`);
          }
        }, AUCTION_DURATION);
        return;
      }

      if (sub === 'bid') {
        const auctionKey = args[0];
        const bidAmt     = parseInt(args[1], 10);
        if (!auctionKey || isNaN(bidAmt)) { msg.reply('Usage: `!auction bid <auction_key> <amount>`'); return; }
        const a = activeAuctions.get(auctionKey);
        if (!a)                        { msg.reply('Γ¥î Auction not found.'); return; }
        if (a.sellerId === userId)     { msg.reply('Γ¥î You can\'t bid on your own auction.'); return; }
        if (bidAmt <= a.highestBid)    { msg.reply(`Γ¥î Must bid more than ≡ƒ¬Ö ${a.highestBid.toLocaleString()}.`); return; }
        if (bidAmt > userData.botcoin) { msg.reply(`Γ¥î Not enough ≡ƒ¬Ö.`); return; }

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
        msg.reply(`≡ƒÆ╕ **${username}** bids ≡ƒ¬Ö **${bidAmt.toLocaleString()}** on ${item?.emoji || ''} **${item?.name || a.itemId}**! (${secsLeft}s left)`);
        return;
      }
      msg.reply('Subcommands: `!auction start <id>`, `!auction bid <key> <amount>`, `!auction list`');
      break;
    }

    // ΓöÇΓöÇ BOUNTY ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
    case 'bounty': {
      const sub = args.shift()?.toLowerCase();

      if (sub === 'list') {
        const bounties = globalState.bounties || {};
        const embed = new EmbedBuilder().setColor(0xff0000).setTitle('≡ƒô£ WANTED: Bounty Board');
        let any = false;
        for (const [id, b] of Object.entries(bounties)) {
          const bty = b as any;
          if (bty.status !== 'open') continue;
          embed.addFields({ name: `[${id}] ≡ƒ¬Ö ${bty.amount.toLocaleString()}`, value: `${bty.task}\nΓÇö posted by ${bty.posterName}` });
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
        if (userData.botcoin < amount) { msg.reply("Γ¥î Not enough ≡ƒ¬Ö."); return; }
        userData.botcoin -= amount;
        const bountyId = Math.random().toString(36).substring(2, 6).toUpperCase();
        globalState.bounties[bountyId] = { amount, task, posterId: userId, posterName: username, status: 'open' };
        await Promise.all([saveGlobal(), saveUser(userId, userData)]);
        msg.reply(`≡ƒô£ **Bounty [${bountyId}] Posted!** ≡ƒ¬Ö **${amount.toLocaleString()}** locked up.\nTask: *${task}*`);
        return;
      }

      if (sub === 'award') {
        const bountyId    = args[0]?.toUpperCase();
        const targetMatch = args[1]?.match(/<@!?(\d+)>/);
        if (!bountyId || !targetMatch) { msg.reply('Usage: `!bounty award <ID> @user`'); return; }
        const bty = (globalState.bounties || {})[bountyId];
        if (!bty || bty.status !== 'open') { msg.reply("Γ¥î Invalid or closed bounty."); return; }
        if (bty.posterId !== userId)       { msg.reply("Γ¥î Only the poster can award."); return; }

        const targetId   = targetMatch[1];
        const targetRef  = db.collection('businessUsers').doc(targetId);
        const targetSnap = await targetRef.get();
        let targetData   = (targetSnap.data() as UserData) || defaultUser('Unknown');
        bty.status        = 'closed';
        targetData.botcoin += bty.amount;
        targetData.totalEarned = (targetData.totalEarned || 0) + bty.amount;
        addXP(targetData, 80);
        await Promise.all([saveGlobal(), saveUser(targetId, targetData)]);
        msg.reply(`≡ƒÆ░ **BOUNTY CLAIMED!** <@${targetId}> awarded ≡ƒ¬Ö **${bty.amount.toLocaleString()}** for: *${bty.task}*`);
        return;
      }
      msg.reply('Subcommands: `!bounty list`, `!bounty post <amt> <task>`, `!bounty award <id> @user`');
      break;
    }

    // ΓöÇΓöÇ FORGE ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
    case 'forge': {
      if (args.length < 2) { msg.reply(`Usage: \`!forge <emoji> <Name>\`\nCost: ≡ƒ¬Ö **${FORGE_COST}**`); return; }
      const hasLicense = (userData.inventory['trade_license'] || 0) > 0;
      const cost       = hasLicense ? Math.floor(FORGE_COST * 0.75) : FORGE_COST;
      if (userData.botcoin < cost) { msg.reply(`Γ¥î Need ≡ƒ¬Ö **${cost}** to forge.${hasLicense ? '' : '\n≡ƒÆí Tip: A Trade License reduces forge cost by 25%!'}`); return; }
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
        .setTitle('ΓÜÆ∩╕Å Item Forged!')
        .setDescription(`${emoji} **${name}** has been permanently injected into the global economy!\n≡ƒ¬Ö Cost: **${cost.toLocaleString()}**${hasLicense ? ' *(Trade License discount applied!)*' : ''}`)
        .setFooter({ text: `Item ID: ${itemId}` });
      msg.reply({ embeds: [embed] });
      break;
    }

    // ΓöÇΓöÇ INVENTORY ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
    case 'inventory':
    case 'inv': {
      const embed = new EmbedBuilder()
        .setColor(0x9b59b6)
        .setTitle(`≡ƒÄÆ ${username}'s Inventory`);
      let hasItems = false;
      for (const [key, count] of Object.entries(userData.inventory || {})) {
        if ((count as number) <= 0) continue;
        const item = allItems[key];
        if (!item) continue;
        embed.addFields({
          name: `${item.emoji || ''} ${item.name} (x${count})`,
          value: `${rarityBadge(item.rarity || 'common')}  ΓÇó  ≡ƒ¬Ö ${(item.value * (count as number)).toLocaleString()} total value\n${item.description ? `*${item.description}*` : ''}  \`[${key}]\``,
        });
        hasItems = true;
      }
      if (!hasItems) embed.setDescription("Empty inventory. Use `!daily` to get started!");
      msg.reply({ embeds: [embed] });
      break;
    }

    // ΓöÇΓöÇ PROFILE ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
    case 'profile':
    case 'bal': {
      const rankSnap = await db.collection('businessUsers').where('netWorth', '>', userData.netWorth).get();
      const rank     = rankSnap.size + 1;
      const lvl      = userData.level || 1;
      const embed = new EmbedBuilder()
        .setColor(RARITY_COLOR[lvl >= 8 ? 'legendary' : lvl >= 5 ? 'epic' : lvl >= 3 ? 'rare' : 'common'])
        .setTitle(`≡ƒôè ${username}  ΓÇó  ${levelLabel(lvl)} (Lv.${lvl})`)
        .addFields(
          { name: '≡ƒÆ░ Botcoin',    value: `≡ƒ¬Ö ${userData.botcoin.toLocaleString()}`,             inline: true },
          { name: '≡ƒôê Net Worth',  value: `≡ƒ¬Ö ${(userData.netWorth || 0).toLocaleString()}`,     inline: true },
          { name: '≡ƒÅå Rank',       value: `#${rank} globally`,                                   inline: true },
          { name: '≡ƒÄ▓ W/L',        value: `${userData.wins || 0}W / ${userData.losses || 0}L`,   inline: true },
          { name: '≡ƒÆ╕ Earned',     value: `≡ƒ¬Ö ${(userData.totalEarned || 0).toLocaleString()}`,   inline: true },
          { name: '≡ƒôà Streak',     value: `${userData.dailyStreak || 0} days`,                   inline: true },
        )
        .setFooter({ text: `XP: ${userData.xp || 0} / ${xpForLevel(lvl)} ΓåÆ next level${userData.jailUntil > Date.now() ? ` | ≡ƒöÆ In jail ${Math.ceil((userData.jailUntil - Date.now())/60000)}m` : ''}` });
      msg.reply({ embeds: [embed] });
      break;
    }

    // ΓöÇΓöÇ LEADERBOARD ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
    case 'leaderboard':
    case 'lb':
    case 'rich': {
      const topSnap = await db.collection('businessUsers').orderBy('netWorth', 'desc').limit(10).get();
      const medals  = ['≡ƒÑç', '≡ƒÑê', '≡ƒÑë', '4∩╕ÅΓâú', '5∩╕ÅΓâú', '6∩╕ÅΓâú', '7∩╕ÅΓâú', '8∩╕ÅΓâú', '9∩╕ÅΓâú', '≡ƒöƒ'];
      const embed   = new EmbedBuilder()
        .setColor(0xf1c40f)
        .setTitle('≡ƒÅå Global Forbes List ΓÇö Top Net Worth');
      topSnap.docs.forEach((doc, i) => {
        const d = doc.data();
        embed.addFields({
          name: `${medals[i]} ${d.username}  (Lv.${d.level || 1} ${levelLabel(d.level || 1)})`,
          value: `≡ƒ¬Ö **${(d.netWorth || 0).toLocaleString()}** net worth`,
        });
      });
      msg.reply({ embeds: [embed] });
      break;
    }

    // ΓöÇΓöÇ HELP ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
    case 'bhelp':
    case 'help': {
      if (command === 'help' && args[0]?.toLowerCase() !== 'businessbot') {
        return; // Let NotABot handle generic !help
      }
      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('≡ƒÆ╝ BusinessBot ΓÇö Command Guide')
        .addFields(
          { name: '≡ƒÜÇ Getting Started', value: '`!start` ΓÇö Claim starter grant\n`!daily` ΓÇö Daily reward + mystery box\n`!open box` ΓÇö Open your mystery box' },
          { name: '≡ƒÆ░ Economy',         value: '`!profile` `!inv` `!lb` ΓÇö View stats\n`!pay @user <amt>` ΓÇö Send money\n`!rob @user` ΓÇö Steal (risky!)\n`!slots <bet>` ΓÇö Slot machine' },
          { name: '≡ƒÄ▓ Gambling',        value: '`!wager @user <amt>` ΓÇö Coinflip challenge\n`!accept @user` ΓÇö Accept a wager\n`!challenge @user <amt> <terms>` ΓÇö 1v1 custom bet\n`!yield <id>` ΓÇö Surrender challenge\n`!award <id> @winner` ΓÇö Declare winner' },
          { name: '≡ƒôê Stocks',          value: '`!stocks` ΓÇö View market\n`!buy <SYM> <shares>` ΓÇö Invest\n`!sell <SYM> <shares>` ΓÇö Exit position\n`!portfolio` ΓÇö View holdings' },
          { name: '≡ƒ¢Æ Shop & Crafting', value: '`!shop` ΓÇö Browse items for sale\n`!buy item <id>` ΓÇö Buy from shop\n`!forge <emoji> <name>` ΓÇö Forge custom item (≡ƒ¬Ö2000)\n`!vault` ΓÇö Use a Vault Key for bonus loot' },
          { name: '≡ƒñ¥ Trading',         value: '`!trade @user <item> for <item>` ΓÇö Propose trade\n`!tradea <id>` ΓÇö Accept trade\n`!traded <id>` ΓÇö Decline trade' },
          { name: '≡ƒö¿ Auctions',        value: '`!auction start <item_id>` ΓÇö List item\n`!auction bid <key> <amt>` ΓÇö Place bid\n`!auction list` ΓÇö View active' },
          { name: '≡ƒô£ Bounties',        value: '`!bounty post <amt> <task>` ΓÇö Post task\n`!bounty list` ΓÇö View open bounties\n`!bounty award <id> @user` ΓÇö Pay out' },
        )
        .setFooter({ text: 'Tip: Lucky Charm boosts coinflip odds. Piggy Bank earns more interest. Nuke helps rob.' });
      msg.reply({ embeds: [embed] });
      break;
    }
  }
}

async function handleNaturalLanguage(msg: Message) {
  const userId = msg.author.id;
  const username = msg.member?.displayName || msg.author.username;

  const userRef = db.collection('businessUsers').doc(userId);
  const snap = await userRef.get();
  const userData = (snap.data() as UserData | undefined) || defaultUser(username);

  let promptText = msg.content.replace(new RegExp(`<@!?${botClient!.user!.id}>`, 'g'), '').trim();
  if (!promptText) promptText = "Hello!";

  const systemPrompt = `You are BusinessBot, the personal wealth manager for the Free Market Discord economy game. 
You act professional, slick, and slightly greedy. Your job is to parse the user's natural language request and execute the right game command, or answer their questions.

THE USER'S CURRENT STATS:
Name: ${username}
Botcoin Balance: ≡ƒ¬Ö ${userData.botcoin}
Inventory: ${JSON.stringify(userData.inventory || {})}
Stocks: ${JSON.stringify(userData.stocks || {})}

AVAILABLE COMMANDS TO EXECUTE:
- 'daily': claim daily reward
- 'pay': pay someone (args: ["<@user_id>", "amount"])
- 'rob': rob someone (args: ["<@user_id>"])
- 'slots': gamble (args: ["amount"])
- 'buy': buy stocks (args: ["SYM", "shares"])
- 'sell': sell stocks (args: ["SYM", "shares"])
- 'wager': coinflip wager (args: ["<@user_id>", "amount"])
- 'open box': open a mystery box (args: [])
- 'profile': check stats (args: [])
- 'portfolio': check stocks (args: [])
- 'shop': browse items (args: [])
- 'lb': leaderboard (args: [])

If the user wants to execute an action (e.g., "send @Bob 500", "gimme my daily", "open my box", "play slots for 100"), return a JSON object with:
{
  "action": "execute_command",
  "command": "<command_name>",
  "args": ["arg1", "arg2"],
  "reply": "a short natural language confirmation/quip"
}
If the user is just asking for advice, chatting, or asking about their balance, return:
{
  "action": "reply",
  "reply": "your conversational response"
}

OUTPUT RAW JSON ONLY. No markdown wrapping.`;

  try {
    const response = await groq.call(systemPrompt, promptText);
    const parsed = JSON.parse(response.replace(/\`\`\`json/gi, '').replace(/\`\`\`/g, '').trim());

    if (parsed.reply) {
      await msg.reply(parsed.reply).catch(() => {});
    }

    if (parsed.action === 'execute_command' && parsed.command) {
      await handleCommand(msg, parsed.command, parsed.args || []);
    }
  } catch (e) {
    console.error('[BusinessBot] Groq parsing error', e);
  }
}
