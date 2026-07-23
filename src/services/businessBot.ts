import {
  Client, GatewayIntentBits, Message, Partials, Events
} from 'discord.js';
import { db } from './firebase.ts';

let botClient: Client | null = null;
const PREFIX = '!';

// Central bank limits
const STARTER_GRANT = 1000;
const FORGE_COST = 2000;

// Temporary in-memory states
interface Wager {
  fromId: string;
  toId: string;
  amount: number;
}
const pendingWagers = new Map<string, Wager>(); // key: `${toId}-${fromId}`

interface Auction {
  itemId: string;
  sellerId: string;
  highestBid: number;
  highestBidder: string | null;
  endTime: number;
  channelId: string;
}
const activeAuctions = new Map<string, Auction>(); // key: itemId

// Addictive Item Definitions
let ITEMS: any = {
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

  // Fetch Global State (Custom Items, Bounties)
  const globalRef = db.collection('businessGlobal').doc('state');
  const globalSnap = await globalRef.get();
  let globalState = globalSnap.data();
  if (!globalState) {
    globalState = { customItems: {}, bounties: {} };
    await globalRef.set(globalState);
  }
  
  // Merge custom items into local ITEMS dictionary for easy lookup
  if (globalState.customItems) {
    for (const [k, v] of Object.entries(globalState.customItems)) {
      ITEMS[k] = v;
    }
  }

  // Helper to save user
  const saveUser = async (uid: string, data: any) => {
    // Recalculate net worth based on botcoin + items
    let itemValue = 0;
    for (const [itemKey, count] of Object.entries(data.inventory || {})) {
      if (ITEMS[itemKey]) {
        itemValue += (ITEMS[itemKey].value * (count as number));
      }
    }
    data.netWorth = data.botcoin + itemValue;
    await db.collection('businessUsers').doc(uid).set(data, { merge: true });
  };

  const saveGlobal = async () => {
    await globalRef.set(globalState);
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
        outcomeStr = `🔥 **LEGENDARY DROP!** 🔥 You unboxed a **${ITEMS[wonItem].name}**!`;
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
          const itemDef = ITEMS[key];
          if (itemDef) invStr += `- **${itemDef.name}** (x${count}) \`[ID: ${key}]\`\n`;
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

    case 'forge': {
      if (args.length < 2) {
        msg.reply(`Usage: \`!forge <emoji> <Name of item>\`\nCost: 🪙 **${FORGE_COST} Botcoin**`);
        return;
      }
      if (userData.botcoin < FORGE_COST) {
        msg.reply(`❌ You need 🪙 **${FORGE_COST} Botcoin** to forge a custom item.`);
        return;
      }

      const emoji = args[0];
      const name = args.slice(1).join(' ');
      const itemId = `custom_${Date.now()}`;

      // Deduct cost
      userData.botcoin -= FORGE_COST;
      
      // Save global item definition
      if (!globalState.customItems) globalState.customItems = {};
      globalState.customItems[itemId] = {
        name: `${name} ${emoji}`,
        value: FORGE_COST, // Base value is what it cost to forge
        creatorId: userId,
        creatorName: username
      };

      // Give 1 copy to the creator
      userData.inventory[itemId] = 1;

      await Promise.all([saveGlobal(), saveUser(userId, userData)]);
      
      msg.reply(`⚒️ **ITEM FORGED!** ⚒️\nYou spent 🪙 ${FORGE_COST} to permanently inject **${name} ${emoji}** into the global economy! It has been added to your inventory.`);
      break;
    }

    case 'bounty': {
      const sub = args.shift()?.toLowerCase();
      if (!sub) {
        msg.reply("Usage: `!bounty post <amount> <task>`, `!bounty list`, `!bounty award @user <id>`"); return;
      }

      if (sub === 'list') {
        const bounties = globalState.bounties || {};
        let str = `📜 **WANTED: THE BOUNTY BOARD** 📜\n\n`;
        let count = 0;
        for (const [id, b] of Object.entries(bounties)) {
          const bounty = b as any;
          if (bounty.status === 'open') {
            str += `**[ID: ${id}]** 🪙 **${bounty.amount}** - ${bounty.task} (by ${bounty.posterName})\n`;
            count++;
          }
        }
        if (count === 0) str += "No active bounties.";
        msg.reply(str);
      } 
      else if (sub === 'post') {
        const amount = parseInt(args[0], 10);
        const task = args.slice(1).join(' ');
        
        if (isNaN(amount) || amount <= 0 || !task) {
          msg.reply("Usage: `!bounty post <amount> <task>`"); return;
        }
        if (userData.botcoin < amount) {
          msg.reply(`❌ You don't have enough 🪙 to post this bounty!`); return;
        }

        // Deduct escrow
        userData.botcoin -= amount;
        
        const bountyId = Math.random().toString(36).substring(2, 6).toUpperCase();
        if (!globalState.bounties) globalState.bounties = {};
        globalState.bounties[bountyId] = {
          amount, task, posterId: userId, posterName: username, status: 'open'
        };

        await Promise.all([saveGlobal(), saveUser(userId, userData)]);
        msg.reply(`📜 **BOUNTY POSTED [ID: ${bountyId}]**\nYou locked up 🪙 **${amount}**. Anyone can claim it by doing the task and pinging you!`);
      }
      else if (sub === 'award') {
        const targetMatch = args[0]?.match(/<@!?(\d+)>/);
        const bountyId = args[1]?.toUpperCase();
        
        if (!targetMatch || !bountyId) {
          msg.reply("Usage: `!bounty award @user <Bounty_ID>`"); return;
        }
        const targetId = targetMatch[1];
        const bounty = (globalState.bounties || {})[bountyId];
        
        if (!bounty || bounty.status !== 'open') {
          msg.reply("❌ Invalid or closed bounty ID."); return;
        }
        if (bounty.posterId !== userId) {
          msg.reply("❌ Only the person who posted the bounty can award it."); return;
        }

        const targetRef = db.collection('businessUsers').doc(targetId);
        const targetSnap = await targetRef.get();
        let targetData = targetSnap.data();
        if (!targetData) {
          targetData = { botcoin: 0, username: 'Unknown', granted: false, netWorth: 0, inventory: {}, lastDaily: 0 };
        }

        // Payout
        bounty.status = 'closed';
        targetData.botcoin += bounty.amount;

        await Promise.all([
          saveGlobal(),
          saveUser(targetId, targetData),
          // no need to save userData, the escrow was already deducted
        ]);

        msg.reply(`💰 **BOUNTY CLAIMED!** 💰\n<@${targetId}> has been awarded 🪙 **${bounty.amount}** for completing the task: "${bounty.task}"!`);
      }
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

    case 'auction': {
      const sub = args.shift()?.toLowerCase();
      if (sub === 'start') {
        const itemId = args.join(' ');
        if (!userData.inventory[itemId] || userData.inventory[itemId] <= 0) {
          msg.reply(`❌ You don't have the item: ${itemId}`);
          return;
        }
        
        if (activeAuctions.has(itemId)) {
          msg.reply(`❌ This item type is already up for auction! Wait for it to finish.`);
          return;
        }

        // Temporarily deduct it
        userData.inventory[itemId]--;
        await saveUser(userId, userData);

        const itemDef = ITEMS[itemId];
        const startBid = Math.floor(itemDef.value / 2) || 10;
        
        activeAuctions.set(itemId, {
          itemId, sellerId: userId, highestBid: startBid, highestBidder: null, endTime: Date.now() + 60000, channelId: msg.channelId
        });

        msg.reply(`🔨 **AUCTION STARTED!** 🔨\n${username} is auctioning a **${itemDef.name}**!\nStarting bid is 🪙 **${startBid}**.\nType \`!bid ${itemId} <amount>\` to bid! Auction ends in 60 seconds.`);
        
        setTimeout(async () => {
          const auction = activeAuctions.get(itemId);
          if (!auction) return;
          activeAuctions.delete(itemId);

          if (!auction.highestBidder) {
            // Return item
            const ref = db.collection('businessUsers').doc(auction.sellerId);
            const dSnap = await ref.get();
            let d = dSnap.data();
            if (d) {
              d.inventory[itemId] = (d.inventory[itemId] || 0) + 1;
              await ref.set(d);
            }
            msg.channel.send(`🔨 Auction ended! No one bid on **${itemDef.name}**, it was returned to the seller.`);
          } else {
            // Transfer item
            const ref = db.collection('businessUsers').doc(auction.highestBidder);
            const dSnap = await ref.get();
            let d = dSnap.data();
            if (d) {
              d.inventory[itemId] = (d.inventory[itemId] || 0) + 1;
              await ref.set(d);
            }
            // Give seller money (handled during bid)
            msg.channel.send(`🔨 **SOLD!** 🔨\n**${itemDef.name}** goes to <@${auction.highestBidder}> for 🪙 **${auction.highestBid}**!`);
          }
        }, 60000);
      }
      break;
    }

    case 'bid': {
      const itemId = args[0];
      const bidAmount = parseInt(args[1], 10);
      
      const auction = activeAuctions.get(itemId);
      if (!auction) {
        msg.reply(`❌ No active auction for ${itemId}`); return;
      }
      if (isNaN(bidAmount) || bidAmount <= auction.highestBid) {
        msg.reply(`❌ You must bid higher than 🪙 ${auction.highestBid}`); return;
      }
      if (userData.botcoin < bidAmount) {
        msg.reply(`❌ You don't have enough Botcoin for that bid!`); return;
      }
      if (auction.sellerId === userId) {
        msg.reply(`❌ You cannot bid on your own auction.`); return;
      }

      // Return funds to previous bidder
      if (auction.highestBidder) {
        const prevRef = db.collection('businessUsers').doc(auction.highestBidder);
        const prevSnap = await prevRef.get();
        let prevData = prevSnap.data();
        if (prevData) {
          prevData.botcoin += auction.highestBid;
          await prevRef.set(prevData);
        }
      }

      // Deduct funds from new bidder and give to seller
      userData.botcoin -= bidAmount;
      
      const sellerRef = db.collection('businessUsers').doc(auction.sellerId);
      const sellerSnap = await sellerRef.get();
      let sellerData = sellerSnap.data();
      if (sellerData) {
        sellerData.botcoin += bidAmount;
        // if this was the first bid, we deduct the startBid which wasn't paid yet
        if (auction.highestBidder) {
          sellerData.botcoin -= auction.highestBid; 
        }
        await sellerRef.set(sellerData);
      }

      auction.highestBid = bidAmount;
      auction.highestBidder = userId;
      
      await saveUser(userId, userData);
      msg.reply(`💸 <@${userId}> takes the lead with a bid of 🪙 **${bidAmount}** for **${ITEMS[itemId].name}**!`);
      break;
    }

    case 'help': {
      msg.reply(`💼 **BusinessBot Free Market** 💼
\`!grant\` - Claim starter capital
\`!daily\` - Claim Mystery Box
\`!open box\` - Open Mystery Box
\`!inv\` - View items
\`!lb\` - Global Leaderboard
\`!wager @user <amount>\` - Coinflip
\`!pay @user <amount>\` - Transfer funds
\`!forge <emoji> <Name>\` - 2000🪙 Create a custom item
\`!bounty post <amount> <task>\` - Post a bounty
\`!bounty list\` - View bounties
\`!bounty award @user <id>\` - Pay a bounty
\`!auction start <item_id>\` - Sell an item
\`!bid <item_id> <amount>\` - Bid on auction`);
      break;
    }
  }
}
