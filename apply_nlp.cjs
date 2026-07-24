const fs = require("fs");
let src = fs.readFileSync("src/services/businessBot.ts", "utf8");
const target = fs.readFileSync("target_content.txt", "utf8");

const newContent = `async function handleNaturalLanguage(msg: Message) {
  const userId = msg.author.id;
  const username = msg.member?.displayName || msg.author.username;

  const userRef = db.collection('businessUsers').doc(userId);
  const snap = await userRef.get();
  const userData = (snap.data() as UserData | undefined) || defaultUser(username);

  let promptText = msg.content.replace(new RegExp('<@!?' + botClient!.user!.id + '>', 'g'), '').trim();
  if (!promptText) promptText = "Hello!";

  // Resolve mentioned users to help AI pick valid targets
  const mentionedUsers: { id: string; name: string }[] = [];
  for (const [id, user] of msg.mentions.users) {
    if (id === botClient!.user!.id) continue;
    mentionedUsers.push({ id, name: user.username });
  }
  const mentionCtx = mentionedUsers.length
    ? mentionedUsers.map(u => u.name + '=<@' + u.id + '>').join(', ')
    : 'none';

  const inventorySummary = Object.entries(userData.inventory || {})
    .filter(([, v]) => (v as number) > 0).map(([k, v]) => k + 'x' + v).join(', ') || 'empty';
  const stocksSummary = Object.entries(userData.stocks || {})
    .filter(([, v]) => (v as number) > 0).map(([k, v]) => k + 'x' + v).join(', ') || 'none';

  const stockPricesStr = Object.entries(STOCKS)
    .map(([sym, s]) => \`\${sym}: 🪙 \${s.price}\`)
    .join(' | ');

  const systemPrompt = [
    'You are BusinessBot — a sharp, professional, slightly sarcastic personal wealth manager. Address the user as "Sir". Keep all replies SHORT (1-2 sentences max).',
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
    '',
    'RULES:',
    '- wager/pay/rob/trade REQUIRE a real <@id> from MENTIONED USERS. If none -> action="ask" for clarification.',
    '- If amount > ' + userData.botcoin + ' coins -> action="reply" and tell Sir they cannot afford it.',
    '- ONLY output valid JSON. No markdown.',
    '',
    'FORMATS (pick one):',
    '{"action":"execute_command","command":"<name>","args":[...],"reply":"<short Sir-addressed line>"}',
    '{"action":"ask","reply":"<one question to Sir>"}',
    '{"action":"reply","reply":"<one-line response>"}',
  ].join('\\n');

  try {
    const raw = await groq.call(systemPrompt, promptText, 0.3, undefined, false);
    let parsed: any;
    try {
      parsed = JSON.parse(raw.replace(/\`\`\`json/gi, '').replace(/\`\`\`/g, '').trim());
    } catch {
      await msg.reply('Sir, I had trouble parsing that. Please rephrase.').catch(() => {});
      return;
    }

    if (parsed.reply) {
      await msg.reply(String(parsed.reply)).catch(() => {});
    }

    if (parsed.action === 'execute_command' && parsed.command) {
      const spendingCmds = new Set(['slots', 'pay', 'wager', 'buy', 'bounty']);
      if (spendingCmds.has(parsed.command)) {
        const amtStr = (parsed.command === 'pay' || parsed.command === 'wager')
          ? parsed.args?.[1] : parsed.args?.[0];
        const amt = parseInt(amtStr, 10);
        if (!isNaN(amt) && amt > userData.botcoin && parsed.command !== 'buy' && parsed.command !== 'bounty') return; // Basic check
      }
      await handleCommand(msg, parsed.command, (parsed.args || []).map(String));
    } else if (parsed.action === 'reply' && parsed.reply) {
       // Handled above
    }
  } catch (e) {
    console.error('[BusinessBot] NLP error:', e);
    await msg.reply('Sir, something went wrong on my end. Please try again.').catch(() => {});
  }
}`;

src = src.replace(target, newContent);
fs.writeFileSync("src/services/businessBot.ts", src, "utf8");
console.log("Updated businessBot.ts");