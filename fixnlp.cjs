const fs = require('fs');
let c = fs.readFileSync('src/services/businessBot.ts', 'utf8');
c = c.replace('for (const [id, member] of msg.mentions.members ?? []) {', 'for (const [id, user] of msg.mentions.users) {');
c = c.replace('mentionedUsers.push({ id, name: member.displayName || member.user.username });', 'mentionedUsers.push({ id, name: user.username });');
fs.writeFileSync('src/services/businessBot.ts', c, 'utf8');
console.log('Replaced successfully');