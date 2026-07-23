import {
  Client, GatewayIntentBits, Message, Partials, Events
} from 'discord.js';
import { db } from './firebase.ts';

let botClient: Client | null = null;
const PREFIX = '!';

// Central bank limits
const STARTER_GRANT = 1000;

// Temporary in-memory state for wagers
interface Wager {
  fromId: string;
  toId: string;
  amount: number;
}
const pendingWagers = new Map<string, Wager>(); // key: `${toId}-${fromId}`

// Addictive Item Definitions
const ITEMS = {
  'mystery_box': { name: 'Mystery Box 🎁', value: 0 },
  'golden_rolex': { name: 'Golden Rolex ⌚', value: 5000 },
  'trade_license': { name: 'Trade License 📜', value: 2000 },
  'ceo_title': { name: 'CEO Title 👑', value: 10000 },
  'rusty_coin': { name: 'Rusty Coin 🪙', value: 10 }
};

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
    botClient!.user!.setPresence({ status: 'online', activities: [{ name: 'the free market', type: 3 }] });
  });

  botClient.on(Events.MessageCreate, async (msg: Message) => {
    if (!msg.content.startsWith(PREFIX)) return;

    const args = msg.content.slice(PREFIX.length).trim().split(/ +/);
    const commandName = args.shift()?.toLowerCase();

    if (!commandName) return;

    try {
      await handleCommand(msg, commandName, args);
    } catch (e) {
      console.error('[BusinessBot] Error handling command', e);
    }
  });

  await botClient.login(token);
}

export function stopBusinessBot() {
  if (botClient) {
    botClient.destroy();
    botClient = null;
  }
}

// ── COMMAND HANDLERS ────────────────────────────────────────────────────────

async function handleCommand(msg: Message, command: string, args: string[]) {
  const userId = msg.author.id;
  const username = msg.author.username;

  // Initialize or fetch user
  const userRef = db.collection('businessUsers').doc(userId);
  const snap = await userRef.get();
  
  let userData = snap.data();
  if (!userData) {
    userData = { botcoin: 0, username, granted: false, netWorth: 0, inventory: {}, lastDaily: 0 };
    await userRef.set(userData);
  }

  // Ensure newer schema fields exist
  if (!userData.inventory) userData.inventory = {};
  if (!userData.lastDaily) userData.lastDaily = 0;

  // Helper to save user
  const saveUser = async (uid: string, data: any) => {
    // Recalculate net worth based on botcoin + items
    let itemValue = 0;
    for (const [itemKey, count] of Object.entries(data.inventory || {})) {
      if ((ITEMS as any)[itemKey]) {
        itemValue += ((ITEMS as any)[itemKey].value * (count as number));
      }
    }
    data.netWorth = data.botcoin + itemValue;
    await db.collection('businessUsers').doc(uid).set(data, { merge: true });
  };

  switch (command) {
    case 'grant': {
      if (userData.granted) {
        msg.reply("❌ You have already received your starter grant from the Central Bank.");
        return;
      }
      userData.botcoin += STARTER_GRANT;
      userData.granted = true;
      await saveUser(userId, userData);
      msg.reply(`🏦 **Central Bank Transfer Complete**\nYou received a one-time grant of 🪙 **${STARTER_GRANT} Botcoin**. Spend it wisely!`);
      break;
    }

    case 'daily': {
      const now = Date.now();
      const oneDay = 24 * 60 * 60 * 1000;
      if (now - userData.lastDaily < oneDay) {
        const hoursLeft = Math.ceil((oneDay - (now - userData.lastDaily)) / 3600000);
        msg.reply(`❌ You already claimed your daily box! Come back in ${hoursLeft} hours.`);
        return;
      }
      
      userData.inventory['mystery_box'] = (userData.inventory['mystery_box'] || 0) + 1;
      userData.lastDaily = now;
      await saveUser(userId, userData);
      
      msg.reply(`🎁 **Daily Claimed!** You received 1x **Mystery Box 🎁**!\nType \`!open box\` to see what's inside!`);
      break;
    }

    case 'open': {
      if (args[0] !== 'box' && args[0] !== 'mystery_box') {
        msg.reply("Usage: `!open box`"); return;
      }
      if (!userData.inventory['mystery_box'] || userData.inventory['mystery_box'] <= 0) {
        msg.reply("❌ You don't have any Mystery Boxes to open!"); return;
      }

      // Consume box
      userData.inventory['mystery_box']--;
      
      // Roll RNG
      const roll = Math.random();
      let outcomeStr = '';

      if (roll < 0.001) { // 0.1% Jackpot
        userData.botcoin += 10000;
        outcomeStr = "🌟 **JACKPOT!!!** 🌟 You found 🪙 **10,000 Botcoin** inside!!!";
      } else if (roll < 0.051) { // 5% Legendary Item
        const legendaryItems = ['golden_rolex', 'ceo_title'];
        const wonItem = legendaryItems[Math.floor(Math.random() * legendaryItems.length)];
        userData.inventory[wonItem] = (userData.inventory[wonItem] || 0) + 1;
        outcomeStr = `🔥 **LEGENDARY DROP!** 🔥 You unboxed a **${(ITEMS as any)[wonItem].name}**!`;
      } else if (roll < 0.251) { // 20% Rare Item / Botcoin
        if (Math.random() > 0.5) {
          userData.inventory['trade_license'] = (userData.inventory['trade_license'] || 0) + 1;
          outcomeStr = `✨ **Rare Drop!** ✨ You unboxed a **Trade License 📜**!`;
        } else {
          userData.botcoin += 500;
          outcomeStr = `✨ **Rare Drop!** ✨ You found 🪙 **500 Botcoin**!`;
        }
      } else if (roll < 0.900) { // 65% Common
        const amount = Math.floor(Math.random() * 151) + 50; // 50 to 200
        userData.botcoin += amount;
        outcomeStr = `You opened the box and found 🪙 **${amount} Botcoin**!`;
      } else { // 10% Trash
        userData.inventory['rusty_coin'] = (userData.inventory['rusty_coin'] || 0) + 1;
        outcomeStr = `You opened the box and found... a **Rusty Coin 🪙**. Tough luck.`;
      }

      await saveUser(userId, userData);
      msg.reply(`🎁 Opening Mystery Box...\n\n${outcomeStr}`);
      break;
    }

    case 'inventory':
    case 'inv': {
      let invStr = '';
      for (const [key, count] of Object.entries(userData.inventory)) {
        if (count && (count as number) > 0) {
          const itemDef = (ITEMS as any)[key];
          if (itemDef) invStr += `- **${itemDef.name}** x${count}\n`;
        }
      }
      if (!invStr) invStr = "Your inventory is empty.";
      msg.reply(`🎒 **${userData.username}'s Inventory**\n${invStr}`);
      break;
    }

    case 'profile':
    case 'bal': {
      msg.reply(`📊 **${userData.username}'s Profile**\n💰 **Botcoin:** 🪙 ${userData.botcoin.toLocaleString()}\n📈 **Net Worth:** 🪙 ${(userData.netWorth || 0).toLocaleString()}`);
      break;
    }

    case 'leaderboard':
    case 'lb':
    case 'rich': {
      const snapshot = await db.collection('businessUsers').orderBy('netWorth', 'desc').limit(5).get();
      let lbStr = `🏆 **Global Forbes List (Top 5 Net Worth)** 🏆\n\n`;
      let rank = 1;
      snapshot.forEach(doc => {
        const d = doc.data();
        lbStr += `**#${rank}** - ${d.username} : 🪙 ${(d.netWorth || 0).toLocaleString()}\n`;
        rank++;
      });
      msg.reply(lbStr);
      break;
    }

    case 'pay': {
      if (args.length < 2) {
        msg.reply("Usage: `!pay @user <amount>`");
        return;
      }
      const targetMatch = args[0].match(/<@!?(\d+)>/);
      if (!targetMatch) {
        msg.reply("Please mention a user."); return;
      }
      const targetId = targetMatch[1];
      const amount = parseInt(args[1], 10);

      if (isNaN(amount) || amount <= 0) {
        msg.reply("Invalid amount."); return;
      }
      if (amount > userData.botcoin) {
        msg.reply(`❌ You don't have enough 🪙! Balance: ${userData.botcoin}`); return;
      }
      if (targetId === userId) {
        msg.reply("❌ You can't pay yourself."); return;
      }

      const targetRef = db.collection('businessUsers').doc(targetId);
      const targetSnap = await targetRef.get();
      let targetData = targetSnap.data();
      if (!targetData) {
        targetData = { botcoin: 0, username: 'Unknown User', granted: false, netWorth: 0, inventory: {}, lastDaily: 0 };
      }

      userData.botcoin -= amount;
      targetData.botcoin += amount;

      await Promise.all([
        saveUser(userId, userData),
        saveUser(targetId, targetData)
      ]);

      msg.reply(`💸 You paid 🪙 **${amount}** to <@${targetId}>!`);
      break;
    }

    case 'wager': {
      if (args.length < 2) {
        msg.reply("Usage: `!wager @user <amount>`"); return;
      }
      const targetMatch = args[0].match(/<@!?(\d+)>/);
      if (!targetMatch) {
        msg.reply("Please mention a user."); return;
      }
      const targetId = targetMatch[1];
      const amount = parseInt(args[1], 10);

      if (isNaN(amount) || amount <= 0) {
        msg.reply("Invalid amount."); return;
      }
      if (amount > userData.botcoin) {
        msg.reply(`❌ You don't have enough 🪙 to wager that much! Balance: ${userData.botcoin}`); return;
      }
      if (targetId === userId) {
        msg.reply("❌ You can't wager against yourself."); return;
      }

      const wagerKey = `${targetId}-${userId}`;
      pendingWagers.set(wagerKey, { fromId: userId, toId: targetId, amount });
      
      msg.reply(`🎲 <@${targetId}>, you have been challenged to a 50/50 coinflip for 🪙 **${amount}** by ${username}!\nType \`!accept @${username}\` to accept.`);
      break;
    }

    case 'accept': {
      if (args.length < 1) {
        msg.reply("Usage: `!accept @user`"); return;
      }
      const targetMatch = args[0].match(/<@!?(\d+)>/);
      if (!targetMatch) {
        msg.reply("Please mention the user who challenged you."); return;
      }
      const challengerId = targetMatch[1];
      const wagerKey = `${userId}-${challengerId}`;
      const wager = pendingWagers.get(wagerKey);

      if (!wager) {
        msg.reply("❌ No pending wager found from that user."); return;
      }

      if (userData.botcoin < wager.amount) {
        msg.reply(`❌ You don't have enough 🪙 to accept this wager! You need ${wager.amount}.`); return;
      }
      
      const challengerRef = db.collection('businessUsers').doc(challengerId);
      const challengerSnap = await challengerRef.get();
      let challengerData = challengerSnap.data()!;

      if (challengerData.botcoin < wager.amount) {
        msg.reply(`❌ The challenger no longer has enough 🪙 for this wager!`);
        pendingWagers.delete(wagerKey);
        return;
      }

      pendingWagers.delete(wagerKey);

      const challengerWins = Math.random() > 0.5;

      if (challengerWins) {
        challengerData.botcoin += wager.amount;
        userData.botcoin -= wager.amount;
        
        await Promise.all([
          saveUser(challengerId, challengerData),
          saveUser(userId, userData)
        ]);
        
        msg.reply(`🎲 The coin landed on heads! <@${challengerId}> **WINS** 🪙 ${wager.amount} from <@${userId}>!`);
      } else {
        challengerData.botcoin -= wager.amount;
        userData.botcoin += wager.amount;
        
        await Promise.all([
          saveUser(challengerId, challengerData),
          saveUser(userId, userData)
        ]);

        msg.reply(`🎲 The coin landed on tails! <@${userId}> **WINS** 🪙 ${wager.amount} from <@${challengerId}>!`);
      }
      break;
    }

    case 'help': {
      msg.reply(`💼 **BusinessBot Free Market** 💼
\`!grant\` - Claim your starter capital (Once)
\`!daily\` - Claim your daily Mystery Box
\`!open box\` - Open a Mystery Box
\`!inv\` - View your items
\`!profile\` - View stats & Net Worth
\`!lb\` - View Global Leaderboard
\`!pay @user <amount>\` - Transfer funds
\`!wager @user <amount>\` - Challenge someone to a coinflip
\`!accept @user\` - Accept a wager`);
      break;
    }
  }
}
