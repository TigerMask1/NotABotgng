const fs = require("fs");
let src = fs.readFileSync("src/services/discordBot.ts", "utf8");

const oldParseStart = src.indexOf("function parseBrainJSON");
const endStr = "return null; }";
const oldParseEnd = src.indexOf(endStr, oldParseStart) + endStr.length;

if (oldParseStart === -1 || oldParseEnd === -1) {
  console.log("Could not find bounds");
  process.exit(1);
}

const before = src.slice(0, oldParseStart);
const after = src.slice(oldParseEnd);

const newParse = `function parseBrainJSON(raw: string): BrainDecision | null {
  try {
    const m = raw.match(/\\{[\\s\\S]*\\}/);
    if (!m) return null;
    const p = JSON.parse(m[0]);
    return {
      action:          (['speak', 'play', 'react', 'gif', 'ignore'] as const).includes(p.action) ? p.action : 'ignore',
      reply:           typeof p.reply    === 'string' ? p.reply.trim().replace(/^["']|["']$/g, '') : '',
      reaction:        sanitizeEmoji(p.reaction),
      gifQuery:        typeof p.gifQuery === 'string' ? p.gifQuery.trim().slice(0, 80) : '',
      replyToMsgId:    typeof p.replyToMsgId    === 'string' ? p.replyToMsgId.trim()    : '',
      unansweredMsgId: typeof p.unansweredMsgId === 'string' ? p.unansweredMsgId.trim() : '',
      aboutSender:     typeof p.aboutSender === 'string' ? p.aboutSender.trim().slice(0, 150) : '',
      pause:           typeof p.pause    === 'number' ? Math.min(Math.max(0, Math.round(p.pause)), PAUSE_MAX_MINS) : 0,
      goal:            typeof p.goal     === 'string' ? p.goal.trim().slice(0, 120) : '',
      stayActive:      typeof p.stayActive === 'boolean' ? p.stayActive : true,
      think:           typeof p.think    === 'string' ? p.think.trim() : '',
      command:         (['get_history','get_member','get_stm','get_video_status','get_channel_info','recall_memory','set_reminder','get_server_stats','get_time','web_search','get_cross_server','create_poll','wiki_lookup','start_event','get_leaderboard','start_game','play_chess_move','djs_script','none'] as const).includes(p.command) ? p.command : 'none',
      commandArgs:     p.commandArgs && typeof p.commandArgs === 'object' ? p.commandArgs : {},
    };
  } catch { return null; }
}`;

fs.writeFileSync("src/services/discordBot.ts", before + newParse + after, "utf8");
console.log("Updated parseBrainJSON");