const fs = require('fs');
let text = fs.readFileSync('src/services/businessBot.ts', 'utf8');

const fixes = {
  'ðŸ“œ': '📜',
  'ðŸª™': '🪙',
  'â€”': '—',
  'â Œ': '❌',
  'âŒ': '❌',
  'ðŸ’°': '💰',
  'âš’ï¸ ': '⚒️',
  'ðŸŽ’': '🎒',
  'ðŸ¤ ': '🤝',
  'âœ…': '✅',
  'ðŸ”¨': '🔨',
  'ðŸŽ ': '🎁',
  'ðŸ’¡': '💡',
  'ðŸ¤”': '🤔',
  'âš ï¸ ': '⚠️',
  'ðŸŽ¯': '🎯',
  'ðŸ’¸': '💸',
  'ðŸŽ‰': '🎉',
  'âœ¨': '✨',
  'ðŸ§™': '🧙',
  'ðŸ’Ž': '💎',
  'ðŸš¨': '🚨',
  'ðŸ”¥': '🔥'
};

for (const [bad, good] of Object.entries(fixes)) {
  text = text.split(bad).join(good);
}

fs.writeFileSync('src/services/businessBot.ts', text, 'utf8');
console.log('Fixed mojibake');