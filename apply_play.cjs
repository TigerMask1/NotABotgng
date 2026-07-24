const fs = require("fs");
let src = fs.readFileSync("src/services/discordBot.ts", "utf8");

const oldExecStart = src.indexOf("  if (decision.action === 'ignore') {");
const oldExecEnd = src.indexOf("else if (unprompted) state.consecutiveUnpromptedReplies++;", oldExecStart) + 60;

if (oldExecStart === -1 || oldExecEnd === -1) {
  console.log("Could not find bounds");
  process.exit(1);
}

const before = src.slice(0, oldExecStart);
const after = src.slice(oldExecEnd);

const newExec = `  if (decision.action === 'ignore') {
    state.consecutiveUnpromptedReplies = 0;
  }
  else if (unprompted) state.consecutiveUnpromptedReplies++;

  if (decision.action === 'play') {
    // When playing, the bot uses BusinessBot by sending a command in the channel.
    // It updates its status to "Playing BusinessBot in XXX"
    try {
      const g = botClient?.guilds.cache.get(guildId);
      if (g && botClient?.user) {
        botClient.user.setPresence({ activities: [{ name: \`BusinessBot in \${g.name}\`, type: 0 }] });
      }
    } catch (e) {}
    decision.action = 'speak'; // Convert to speak to actually send the message!
  }
`;

fs.writeFileSync("src/services/discordBot.ts", before + newExec + after, "utf8");
console.log("Updated executeBrainDecision");