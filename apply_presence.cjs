const fs = require("fs");
let src = fs.readFileSync("src/services/discordBot.ts", "utf8");

// We need to find where brainOpts are created.
// Search for "const guildList ="
const target = "const guildList = botClient?.guilds.cache.map(g => g.name).join(', ') || '';";
if (!src.includes(target)) {
  console.log("Could not find guildList line");
  process.exit(1);
}

const replacement = `const guildList = botClient?.guilds.cache.map(g => g.name).join(', ') || '';
  const businessBotId = getBusinessBotId();
  const guild = opts.guildId ? botClient?.guilds.cache.get(opts.guildId) : null;
  const isBusinessBotHere = guild && businessBotId ? guild.members.cache.has(businessBotId) : false;
  const bbStatus = isBusinessBotHere ? "BusinessBot is IN this server." : "BusinessBot is NOT in this server.";
`;

src = src.replace(target, replacement);

const statusLineTarget = "const statusLine = guildList\n    ? `${opts.statusLine} | all servers i'm in: ${guildList}`\n    : opts.statusLine;";
const statusLineReplacement = "const statusLine = guildList\n    ? `${opts.statusLine} | all servers i'm in: ${guildList} | ${bbStatus}`\n    : `${opts.statusLine} | ${bbStatus}`;";

src = src.replace(statusLineTarget, statusLineReplacement);

fs.writeFileSync("src/services/discordBot.ts", src, "utf8");
console.log("Updated brain context with BusinessBot presence");