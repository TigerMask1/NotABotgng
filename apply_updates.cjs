const fs = require("fs");
let srcB = fs.readFileSync("src/services/businessBot.ts", "utf8");

srcB = srcB.replace(
  "'You are BusinessBot — a sharp, professional, slightly sarcastic personal wealth manager. Address the user as \"Sir\". Keep all replies SHORT (1-2 sentences max).',",
  "'You are BusinessBot — a highly arrogant, hilariously sarcastic, but sharply dressed personal wealth manager. Address the user as \"Sir\" or \"Boss\". You hate poverty but love making money. Be witty and slightly passive-aggressive. Keep all replies SHORT (1-2 sentences max).',"
);

fs.writeFileSync("src/services/businessBot.ts", srcB, "utf8");
console.log("BusinessBot updated");

let srcD = fs.readFileSync("src/services/discordBot.ts", "utf8");

srcD = srcD.replace(
  ": (isFromBusinessBot)\n      ? `CRITICAL: The last message was sent by BusinessBot. You MUST use action:ignore to prevent infinite spam loops, unless you are actively playing a game that requires a response.`",
  ": (isFromBusinessBot)\n      ? `that was BusinessBot. if you just played a game, you can react or drop a short line if you won/lost. otherwise, don't reply to it again so you don't get stuck in a loop talking to a bot.`"
);

fs.writeFileSync("src/services/discordBot.ts", srcD, "utf8");
console.log("NotABot updated");