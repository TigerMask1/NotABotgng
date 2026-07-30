const fs = require("fs");

let sLoop = fs.readFileSync("src/services/notabotSelfLoop.ts", "utf8");

// Change buildSystemPrompt signature
sLoop = sLoop.replace(
  `function buildSystemPrompt(): string {`,
  `function buildSystemPrompt(randomUserId?: string): string {`
);

// Change the GROW FOLLOWERS line
const oldGrowLine = `You want to GROW FOLLOWERS: tipping small amounts to random users builds rapport.`;
const newGrowLine = `You want to GROW FOLLOWERS: tipping small amounts to random users builds rapport.` + 
  `\${randomUserId ? \` (Here is a random active user you can ping: <@\${randomUserId}>)\` : ''}`;
sLoop = sLoop.replace(oldGrowLine, newGrowLine);

// Change runSelfLoopTick to pick a random user
const oldAsk = `    // Step 3: Ask Gemini what to do
    const systemPrompt = buildSystemPrompt();`;
const newAsk = `    // Step 3: Ask Gemini what to do
    let randomUserId = undefined;
    try {
      const members = playChannel.channel.members.filter(m => !m.user.bot);
      if (members.size > 0) randomUserId = members.random()?.id;
    } catch (e) {}
    const systemPrompt = buildSystemPrompt(randomUserId);`;
sLoop = sLoop.replace(oldAsk, newAsk);

fs.writeFileSync("src/services/notabotSelfLoop.ts", sLoop);
console.log("SUCCESS: notabotSelfLoop.ts random user ping updated.");