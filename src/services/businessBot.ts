import {
  Client, GatewayIntentBits, Message, Partials, Events
} from 'discord.js';
import { db } from './firebase.ts';

let botClient: Client | null = null;
const PREFIX = '!';

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
    botClient!.user!.setPresence({ status: 'online', activities: [{ name: 'the economy', type: 3 }] });
  });

  botClient.on(Events.MessageCreate, async (msg: Message) => {
    // We allow other bots so NotABot can play.
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
  
  let userData = snap.data() || {
    botcoin: 100,
    username,
    businesses: [],
    lastDaily: 0,
    netWorth: 100
  };

  // Ensure document exists
  if (!snap.exists) {
    await userRef.set(userData);
  }

  // Commands
  switch (command) {
    case 'profile':
    case 'bal': {
      msg.reply(`📊 **${userData.username}'s Profile**\n💰 **Botcoin:** 🪙 ${userData.botcoin.toLocaleString()}\n📈 **Net Worth:** 🪙 ${userData.netWorth.toLocaleString()}`);
      break;
    }
    
    case 'daily': {
      const now = Date.now();
      const oneDay = 24 * 60 * 60 * 1000;
      if (now - userData.lastDaily < oneDay) {
        const hoursLeft = Math.ceil((oneDay - (now - userData.lastDaily)) / 3600000);
        msg.reply(`You already collected your daily! Come back in ${hoursLeft} hours.`);
        return;
      }
      userData.botcoin += 500;
      userData.netWorth += 500;
      userData.lastDaily = now;
      await userRef.set(userData);
      msg.reply(`✅ Collected daily **500** 🪙! New balance: ${userData.botcoin.toLocaleString()}`);
      break;
    }

    case 'gamble':
    case 'cf': {
      if (!args.length) {
        msg.reply("Specify amount! (e.g. `!gamble 100` or `!gamble all`)");
        return;
      }
      let amount = 0;
      if (args[0].toLowerCase() === 'all') amount = userData.botcoin;
      else amount = parseInt(args[0], 10);

      if (isNaN(amount) || amount <= 0) {
        msg.reply("Invalid amount."); return;
      }
      if (amount > userData.botcoin) {
        msg.reply(`You don't have enough 🪙! Balance: ${userData.botcoin}`); return;
      }

      const win = Math.random() > 0.5;
      if (win) {
        userData.botcoin += amount;
        userData.netWorth += amount;
        await userRef.set(userData);
        msg.reply(`🎉 You flipped a coin and **WON** 🪙 ${amount.toLocaleString()}! New balance: ${userData.botcoin.toLocaleString()}`);
      } else {
        userData.botcoin -= amount;
        userData.netWorth -= amount;
        await userRef.set(userData);
        msg.reply(`💀 You flipped a coin and **LOST** 🪙 ${amount.toLocaleString()}... New balance: ${userData.botcoin.toLocaleString()}`);
      }
      break;
    }
    
    case 'help': {
      msg.reply(`💼 **BusinessBot Commands** 💼\n\`!profile\` - View stats\n\`!daily\` - Free botcoins\n\`!cf <amount>\` - Coinflip gamble\n*(more coming soon!)*`);
      break;
    }
  }
}
