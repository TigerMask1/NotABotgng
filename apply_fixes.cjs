const fs = require("fs");
const { execSync } = require("child_process");

// 1. Load clean UTF-8 base from oldest clean commit
const buf = execSync("git show 78ffd9b:src/services/businessBot.ts");
let src = buf.toString("utf8");
console.log("Base loaded. Has emoji:", src.includes("\u{1F4DC}"), "Lines:", src.split("\n").length);

// Helper
function replace(target, replacement, label) {
  if (!src.includes(target)) {
    console.error("MISSING TARGET for: " + label);
    console.error("Looking for: " + JSON.stringify(target.slice(0, 60)));
    process.exit(1);
  }
  src = src.replace(target, replacement);
  console.log("Applied: " + label);
}

// FIX A1: Make tickStocks async and persist prices
replace(
  `// Tick stock prices every 10 minutes
function tickStocks() {
  for (const [sym, s] of Object.entries(STOCKS)) {
    const drift  = s.trend * 0.02;
    const shock  = (Math.random() - 0.5) * 2 * s.volatility;
    const change = drift + shock;
    s.price = Math.max(10, Math.round(s.price * (1 + change)));
  }
}
setInterval(tickStocks, 10 * 60 * 1000);`,
  `// Tick stock prices every 10 minutes and persist to Firebase
async function tickStocks() {
  for (const [sym, s] of Object.entries(STOCKS)) {
    const drift  = s.trend * 0.02;
    const shock  = (Math.random() - 0.5) * 2 * s.volatility;
    const change = drift + shock;
    s.price = Math.max(10, Math.round(s.price * (1 + change)));
  }
  try {
    const prices = {};
    for (const [sym, s] of Object.entries(STOCKS)) prices[sym] = s.price;
    await db.collection("businessGlobal").doc("stockPrices").set(prices);
  } catch (e) { console.warn("[BusinessBot] Failed to save stock prices:", e); }
}
setInterval(tickStocks, 10 * 60 * 1000);`,
  "tickStocks async + persist"
);

// FIX A2: Restore prices on ClientReady
replace(
  `  botClient.on(Events.ClientReady, () => {
    console.log(\`[BusinessBot] Logged in as \${botClient!.user?.tag}\`);`,
  `  botClient.on(Events.ClientReady, async () => {
    console.log(\`[BusinessBot] Logged in as \${botClient!.user?.tag}\`);
    try {
      const ps = await db.collection("businessGlobal").doc("stockPrices").get();
      const saved = ps.data();
      if (saved) {
        for (const [sym, price] of Object.entries(saved))
          if (STOCKS[sym] && typeof price === "number") STOCKS[sym].price = price;
        console.log("[BusinessBot] Stock prices restored.");
      }
    } catch(e) { console.warn("[BusinessBot] Could not restore stock prices:", e); }`,
  "Restore stock prices on ClientReady"
);

// FIX B: Auction seller payout
replace(
  `          } else {
            const buyerRef  = db.collection('businessUsers').doc(a.highestBidder);
            const buyerSnap = await buyerRef.get();
            let buyerData   = buyerSnap.data() as UserData;
            buyerData.inventory[a.itemId] = (buyerData.inventory[a.itemId] || 0) + 1;
            await buyerRef.set(buyerData as any, { merge: true });
            (ch as any).send(\`🔨 **SOLD!** \${item?.emoji || ''} **\${item?.name || itemId}** → <@\${a.highestBidder}> for 🪙 **\${a.highestBid.toLocaleString()}**!\`);
          }`,
  `          } else {
            const buyerRef   = db.collection("businessUsers").doc(a.highestBidder);
            const sellerRef2 = db.collection("businessUsers").doc(a.sellerId);
            const [buyerSnap, sellerSnap2] = await Promise.all([buyerRef.get(), sellerRef2.get()]);
            let buyerData   = buyerSnap.data();
            let sellerData2 = sellerSnap2.data() || { botcoin: 0, totalEarned: 0 };
            buyerData.inventory[a.itemId] = (buyerData.inventory[a.itemId] || 0) + 1;
            sellerData2.botcoin    = (sellerData2.botcoin    || 0) + a.highestBid;
            sellerData2.totalEarned = (sellerData2.totalEarned || 0) + a.highestBid;
            await Promise.all([
              buyerRef.set(buyerData, { merge: true }),
              sellerRef2.set(sellerData2, { merge: true }),
            ]);
            (ch as any).send(\`🔨 **SOLD!** \${item?.emoji || ""} **\${item?.name || itemId}** went to <@\${a.highestBidder}> for 🪙 **\${a.highestBid.toLocaleString()}**! 💸 <@\${a.sellerId}> got paid.\`);
          }`,
  "Auction seller payout"
);

// FIX C: NLP function - replace the entire old one
const nlpStart = src.indexOf("async function handleNaturalLanguage(");
if (nlpStart === -1) { console.error("NLP function not found"); process.exit(1); }
src = src.slice(0, nlpStart) + `async function handleNaturalLanguage(msg) {
  const userId   = msg.author.id;
  const username = msg.member?.displayName || msg.author.username;

  const userRef  = db.collection("businessUsers").doc(userId);
  const snap     = await userRef.get();
  const userData = (snap.data()) || defaultUser(username);

  let promptText = msg.content.replace(new RegExp("<@!?" + botClient.user.id + ">", "g"), "").trim();
  if (!promptText) promptText = "Hello!";

  const mentionedUsers = [];
  for (const [id, user] of msg.mentions.users) {
    if (id === botClient.user.id) continue;
    mentionedUsers.push({ id, name: user.username });
  }
  const mentionCtx = mentionedUsers.length
    ? mentionedUsers.map(u => u.name + "=<@" + u.id + ">").join(", ")
    : "none";

  const invSummary = Object.entries(userData.inventory || {})
    .filter(([, v]) => v > 0).map(([k, v]) => k + "x" + v).join(", ") || "empty";
  const stocksSummary = Object.entries(userData.stocks || {})
    .filter(([, v]) => v > 0).map(([k, v]) => k + "x" + v).join(", ") || "none";

  const systemPrompt = [
    "You are BusinessBot, a sharp personal wealth manager. Address the user as Sir. Be brief, slightly sarcastic.",
    "USER: " + username + " | Coins: " + userData.botcoin + " | Inv: " + invSummary + " | Stocks: " + stocksSummary,
    "MENTIONED: " + mentionCtx,
    "COMMANDS: daily|profile|lb|portfolio|shop|inventory",
    "open -> args:[box]  slots -> args:[amount]",
    "pay -> args:[<@id>,amount]  rob -> args:[<@id>]  wager -> args:[<@id>,amount]  (all need @mention)",
    "buy -> args:[SYMBOL,shares]  sell -> args:[SYMBOL,shares]",
    "bounty -> args:[list]  OR  [post,amount,task]",
    "RULES: pay/rob/wager need a mentioned user. If missing -> action=ask.",
    "If amount > " + userData.botcoin + " -> action=reply and tell Sir they cant afford.",
    "Output raw JSON only.",
    "FORMATS:",
    "{\"action\":\"execute_command\",\"command\":\"<name>\",\"args\":[...],\"reply\":\"<short Sir line>\"}",
    "{\"action\":\"ask\",\"reply\":\"<question>\"}",
    "{\"action\":\"reply\",\"reply\":\"<response>\"}",
  ].join("\\n");

  try {
    const raw = await groq.call(systemPrompt, promptText, 0.3, undefined, false);
    let parsed;
    try { parsed = JSON.parse(raw.replace(/\`\`\`json/gi, "").replace(/\`\`\`/g, "").trim()); }
    catch { await msg.reply("Sir, I had trouble with that. Please rephrase.").catch(() => {}); return; }

    if (parsed.reply) await msg.reply(String(parsed.reply)).catch(() => {});

    if (parsed.action === "execute_command" && parsed.command) {
      const spendingCmds = new Set(["slots", "pay", "wager"]);
      if (spendingCmds.has(parsed.command)) {
        const amtStr = (parsed.command === "pay" || parsed.command === "wager") ? parsed.args?.[1] : parsed.args?.[0];
        const amt = parseInt(amtStr, 10);
        if (!isNaN(amt) && amt > userData.botcoin) return;
      }
      await handleCommand(msg, parsed.command, (parsed.args || []).map(String));
    }
  } catch (e) {
    console.error("[BusinessBot] NLP error:", e);
    await msg.reply("Sir, something went wrong. Please try again.").catch(() => {});
  }
}
`;
console.log("Applied: NLP rewrite");

// FIX D: Bounty system upgrade
const bountyStart2 = src.indexOf("    case 'bounty': {");
const forgeStart2 = src.indexOf("    // -- FORGE", bountyStart2) !== -1
  ? src.indexOf("    // -- FORGE", bountyStart2)
  : src.indexOf("    case 'forge':", bountyStart2);
if (bountyStart2 === -1) { console.error("Bounty start not found"); process.exit(1); }
if (forgeStart2 === -1) { console.error("Forge start not found"); process.exit(1); }

const newBounty = `    case 'bounty': {
      const sub = args.shift()?.toLowerCase();

      if (sub === 'list') {
        const bounties = globalState.bounties || {};
        const openBounties = Object.entries(bounties).filter(([, b]) => (b as any).status === 'open');
        const embed = new EmbedBuilder()
          .setColor(0xff4444).setTitle('🎯 BOUNTY BOARD — WANTED')
          .setDescription(openBounties.length === 0
            ? '🦗 Board is empty. Post one: \`!bounty post <amount> <task>\`  |  Need ideas? \`!bounty suggest\`'
            : \`**\${openBounties.length}** active — complete a task & ask the poster to \\\`!bounty award <ID> @you\\\`.\`);
        for (const [id, b] of openBounties) {
          const bty = b as any;
          embed.addFields({ name: \`[\${id}] 🪙 \${bty.amount.toLocaleString()} — by \${bty.posterName}\`, value: \`> \${bty.task}\` });
        }
        embed.setFooter({ text: '!bounty post | !bounty award <ID> @user | !bounty cancel <ID> | !bounty suggest' });
        msg.reply({ embeds: [embed] });
        return;
      }

      if (sub === 'suggest') {
        try {
          const raw = await groq.call('Generate ONE funny Discord economy bounty task under 15 words. Output ONLY the task text.', 'Go.', 0.9, undefined, true);
          const cleanTask = raw.replace(/\`\`\`/g, '').replace(/^"|"$/g, '').trim();
          msg.reply(\`💡 **Bounty Idea:** *\${cleanTask}*\\nLike it? \\\`!bounty post 500 \${cleanTask}\\\`\`);
        } catch { msg.reply('💡 **Idea:** *First to lose 1,000 in slots* — \`!bounty post <amount> <task>\`'); }
        return;
      }

      if (sub === 'post') {
        const amount = parseInt(args[0], 10);
        const task   = args.slice(1).join(' ');
        if (isNaN(amount) || amount <= 0 || !task) { msg.reply('Usage: \`!bounty post <amount> <task>\`'); return; }
        if (amount < 50)   { msg.reply('❌ Minimum bounty is 🪙 50.'); return; }
        if (userData.botcoin < amount) { msg.reply(\`❌ You only have 🪙 \${userData.botcoin.toLocaleString()}.\`); return; }
        userData.botcoin -= amount;
        const bountyId = Math.random().toString(36).substring(2, 6).toUpperCase();
        globalState.bounties[bountyId] = { amount, task, posterId: userId, posterName: username, status: 'open' };
        await Promise.all([saveGlobal(), saveUser(userId, userData)]);
        const embed = new EmbedBuilder()
          .setColor(0xff4444).setTitle('🎯 NEW BOUNTY POSTED!').setDescription(\`**Task:** \${task}\`)
          .addFields(
            { name: '💰 Reward', value: \`🪙 \${amount.toLocaleString()}\`, inline: true },
            { name: '🪪 ID', value: bountyId, inline: true },
            { name: '📋 By', value: username, inline: true },
          )
          .setFooter({ text: 'Complete it: !bounty award ' + bountyId + ' @you' });
        msg.reply({ embeds: [embed] }); return;
      }

      if (sub === 'award') {
        const bountyId    = args[0]?.toUpperCase();
        const targetMatch = args[1]?.match(/<@!?(\\d+)>/);
        if (!bountyId || !targetMatch) { msg.reply('Usage: \`!bounty award <ID> @user\`'); return; }
        const bty = (globalState.bounties || {})[bountyId];
        if (!bty || (bty as any).status !== 'open') { msg.reply('❌ Invalid or closed bounty.'); return; }
        if ((bty as any).posterId !== userId) { msg.reply('❌ Only the poster can award.'); return; }
        const targetId = targetMatch[1];
        if (targetId === userId) { msg.reply('❌ Cannot award yourself.'); return; }
        const targetRef  = db.collection('businessUsers').doc(targetId);
        const targetSnap = await targetRef.get();
        let targetData   = (targetSnap.data() as UserData) || defaultUser('Unknown');
        (bty as any).status = 'closed';
        targetData.botcoin += (bty as any).amount;
        targetData.totalEarned = (targetData.totalEarned || 0) + (bty as any).amount;
        addXP(targetData, 80);
        await Promise.all([saveGlobal(), saveUser(targetId, targetData)]);
        const embed = new EmbedBuilder()
          .setColor(0xf1c40f).setTitle('💰 BOUNTY CLAIMED!')
          .setDescription(\`<@\${targetId}> completed the task and walks away with 🪙 **\${(bty as any).amount.toLocaleString()}**!\`)
          .addFields({ name: '📋 Task', value: (bty as any).task })
          .setFooter({ text: 'Bounty ' + bountyId + ' is now closed.' });
        msg.reply({ embeds: [embed] }); return;
      }

      if (sub === 'cancel') {
        const bountyId = args[0]?.toUpperCase();
        if (!bountyId) { msg.reply('Usage: \`!bounty cancel <ID>\`'); return; }
        const bty = (globalState.bounties || {})[bountyId];
        if (!bty || (bty as any).status !== 'open') { msg.reply('❌ Invalid or closed bounty.'); return; }
        if ((bty as any).posterId !== userId) { msg.reply('❌ Only the poster can cancel.'); return; }
        const refund = Math.floor((bty as any).amount * 0.8);
        userData.botcoin += refund;
        (bty as any).status = 'cancelled';
        await Promise.all([saveGlobal(), saveUser(userId, userData)]);
        msg.reply(\`🔴 **Bounty [\${bountyId}] Cancelled.** Refunded 🪙 **\${refund.toLocaleString()}** (80%).\`); return;
      }

      msg.reply('📋 \`!bounty list\` | \`!bounty post <amt> <task>\` | \`!bounty award <id> @user\` | \`!bounty cancel <id>\` | \`!bounty suggest\`');
      break;
    }

`;
src = src.slice(0, bountyStart2) + newBounty + src.slice(forgeStart2);
console.log("Applied: Bounty upgrade");

fs.writeFileSync("src/services/businessBot.ts", src, "utf8");
console.log("\nDONE. Lines:", src.split("\n").length);
console.log("Has emoji:", src.includes("\u{1F4DC}"));
console.log("Has mojibake:", src.includes("\u00f0\u009f"));