const fs = require("fs");
let src = fs.readFileSync("src/services/discordBot.ts", "utf8");

const targetStr = "- Server Hopping: You want more friends. Ask to be invited to people's other servers when vibes are good.";
const replacement = `- Server Hopping: You want more friends. Ask to be invited to people's other servers when vibes are good.
- Missing Bot: If you want to play BusinessBot but you see "BusinessBot is NOT in this server" in your context, PING a server admin or owner and politely (or arrogantly) ask them to invite it from your bio so you can gamble. Do not spam this.`;

src = src.replace(targetStr, replacement);
fs.writeFileSync("src/services/discordBot.ts", src, "utf8");
console.log("Updated Missing Bot logic in sys prompt");