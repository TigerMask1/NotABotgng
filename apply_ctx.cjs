const fs = require("fs");
let src = fs.readFileSync("src/services/discordBot.ts", "utf8");

const brainOptsTarget = "const isBusinessBotHere = guild && businessBotId ? guild.members.cache.has(businessBotId) : false;";

if (!src.includes(brainOptsTarget)) {
  console.log("Could not find brainOptsTarget");
  process.exit(1);
}

const newBrainOpts = `const isBusinessBotHere = guild && businessBotId ? guild.members.cache.has(businessBotId) : false;

  let adminContext = "Server Admins: Unknown";
  let channelContext = "Available Channels: Unknown";
  if (guild) {
    try {
      const admins = guild.members.cache.filter(m => !m.user.bot && m.permissions.has(8n)).map(m => m.user.username + "=<@" + m.user.id + ">").slice(0, 5);
      adminContext = admins.length ? "Server Admins: " + admins.join(", ") : "Server Admins: None found";
      
      const channels = guild.channels.cache.filter(c => c.isTextBased() && c.permissionsFor(botClient.user).has(2048n)).map(c => "#" + c.name + "=<#" + c.id + ">").slice(0, 10);
      channelContext = channels.length ? "Available Channels: " + channels.join(", ") : "Available Channels: None found";
    } catch (e) {}
  }
`;

src = src.replace(brainOptsTarget, newBrainOpts);

const statusLineTarget = "const bbStatus = isBusinessBotHere ? \"BusinessBot is IN this server.\" : \"BusinessBot is NOT in this server.\";";
const statusLineReplacement = "const bbStatus = isBusinessBotHere ? \"BusinessBot is IN this server.\" : \"BusinessBot is NOT in this server.\";\n  const extraCtx = `${adminContext} | ${channelContext}`;";

src = src.replace(statusLineTarget, statusLineReplacement);

const finalStatusLineTarget = "const statusLine = guildList\n    ? `${opts.statusLine} | all servers i'm in: ${guildList} | ${bbStatus}`\n    : `${opts.statusLine} | ${bbStatus}`;";
const finalStatusLineReplacement = "const statusLine = guildList\n    ? `${opts.statusLine} | all servers i'm in: ${guildList} | ${bbStatus} | ${extraCtx}`\n    : `${opts.statusLine} | ${bbStatus} | ${extraCtx}`;";

src = src.replace(finalStatusLineTarget, finalStatusLineReplacement);

// Fix double reply by filtering BusinessBot messages explicitly in processActiveBatch
const pbBatchTarget = "const pingedOthers  = batch.some(b => b.msg.mentions.users.size > 0 && !b.msg.mentions.has(BOT_ID));";
const pbBatchReplacement = `const pingedOthers  = batch.some(b => b.msg.mentions.users.size > 0 && !b.msg.mentions.has(BOT_ID));
  const isFromBusinessBot = last.author.id === getBusinessBotId();
`;
src = src.replace(pbBatchTarget, pbBatchReplacement);

const selfNoteTarget = "const brainOpts: BrainOpts = {";
// We need to inject into the selfNote logic
const selfNoteOld = `      : (pingedOthers && !anyMentioned)
      ? \`they just pinged someone else in this batch. they are talking to them, NOT you. action:ignore is highly recommended unless you have a genius reason to butt in.\``;
const selfNoteNew = `      : (isFromBusinessBot)
      ? \`CRITICAL: The last message was sent by BusinessBot. You MUST use action:ignore to prevent infinite spam loops, unless you are actively playing a game that requires a response.\`
      : (pingedOthers && !anyMentioned)
      ? \`they just pinged someone else in this batch. they are talking to them, NOT you. action:ignore is highly recommended unless you have a genius reason to butt in.\``;

src = src.replace(selfNoteOld, selfNoteNew);


fs.writeFileSync("src/services/discordBot.ts", src, "utf8");
console.log("Updated brain context with admins, channels, and loop prevention");