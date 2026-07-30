const fs = require("fs");

let dBot = fs.readFileSync("src/services/discordBot.ts", "utf8");

// We need to replace the enqueueActive block.
// Since line endings can be \r\n, we use a regex or string replacement that normalizes it or ignores it.
const regex = /if \(mentioned \|\| getChState\(channelId\)\.mode === 'active'\) \{\s+enqueueActive\(channelId, guildId, \{ msg, mentioned, everyonePing, content \}\);\s+\}/;

const replacement = `if (mentioned || getChState(channelId).mode === 'active') {
      const st = getChState(channelId);
      const msSinceSpoke = st.lastBotMsgAt ? Date.now() - st.lastBotMsgAt : Infinity;
      const isReplyTarget = st.lastRepliedToSenderId === msg.author.id;
      if (!mentioned && msSinceSpoke < 4000 && (msg.author.bot || isReplyTarget)) {
        return;
      }
      enqueueActive(channelId, guildId, { msg, mentioned, everyonePing, content });
    }`;

if (regex.test(dBot)) {
    dBot = dBot.replace(regex, replacement);
    fs.writeFileSync("src/services/discordBot.ts", dBot);
    console.log("SUCCESS: discordBot.ts cooldown gate updated.");
} else {
    console.log("FAIL: regex did not match discordBot.ts");
}