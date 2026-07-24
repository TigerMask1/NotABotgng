const fs = require("fs");
let src = fs.readFileSync("src/services/discordBot.ts", "utf8");

// BUG FIX 1: allowedMentions suppresses all pings including to BusinessBot.
// Change from { parse: [] } (suppress ALL) to { parse: ['users'] } so user pings work.
// This applies to all send() calls in sendDecision.
// Actually, we need to be selective — the original { parse: [] } prevents NotABot from
// accidentally pinging everyone. The right fix is to allow 'users' mentions only.
const oldMention = "allowedMentions: { parse: [] }";
const newMention = "allowedMentions: { parse: ['users'] }";

// Count occurrences
let count = 0;
let idx = 0;
while ((idx = src.indexOf(oldMention, idx)) !== -1) {
  count++;
  idx += oldMention.length;
}
console.log("Found", count, "occurrences of allowedMentions: { parse: [] }");

src = src.replaceAll(oldMention, newMention);

// BUG FIX 2: The double-reply happens because the channel stays active, and BusinessBot's
// reply gets processed as a new active batch, triggering brain() again. The model sees
// Yuki gambling context both times and says the same thing.
// Fix: When the bot has JUST spoken (< 5 seconds ago) and the new message is NOT a ping
// to it, skip the brain call entirely. This is different from the existing "you spoke 
// recently" selfNote — this is a hard gate to prevent burning tokens on rapid consecutive
// non-ping messages.
const oldEnqueue = "    if (mentioned || getChState(channelId).mode === 'active') {\n      enqueueActive(channelId, guildId, { msg, mentioned, everyonePing, content });\n    }";
const newEnqueue = `    if (mentioned || getChState(channelId).mode === 'active') {
      // Cooldown guard: if the bot JUST spoke and nobody pinged it, don't burn another
      // brain() call on a message that arrived in the immediate aftermath (e.g. BusinessBot
      // replying to a command, or two users chatting rapidly). The STM still records the
      // message so the bot sees it in the transcript next time — it just won't react to
      // every single line in real-time.
      const st = getChState(channelId);
      const msSinceSpoke = st.lastBotMsgAt ? Date.now() - st.lastBotMsgAt : Infinity;
      if (!mentioned && msSinceSpoke < 4000) {
        // silently absorb — it's already in STM from the push above
        return;
      }
      enqueueActive(channelId, guildId, { msg, mentioned, everyonePing, content });
    }`;

src = src.replace(oldEnqueue, newEnqueue);

// BUG FIX 3: Remove the hardcoded isFromBusinessBot selfNote — the user explicitly said
// they don't want hardcoded checks. The cooldown guard above handles the double-reply
// problem generically for ALL rapid messages, not just BusinessBot's.
const oldBBCheck = `      : (isFromBusinessBot)
      ? \`that was BusinessBot. if you just played a game, you can react or drop a short line if you won/lost. otherwise, don't reply to it again so you don't get stuck in a loop talking to a bot.\`
      : (pingedOthers && !anyMentioned)`;
const newBBCheck = `      : (pingedOthers && !anyMentioned)`;

src = src.replace(oldBBCheck, newBBCheck);

// Also remove the isFromBusinessBot variable since it's no longer used
const oldIsFromBB = `  const isFromBusinessBot = last.author.id === getBusinessBotId();\n`;
src = src.replace(oldIsFromBB, "");

fs.writeFileSync("src/services/discordBot.ts", src, "utf8");
console.log("All fixes applied");