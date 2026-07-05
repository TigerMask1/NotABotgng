/**
 * CORE SPEAKER AGENT
 * Generates natural, human-like responses without role-playing
 * Model: groq/compound-mini (fast, consistent, high-volume)
 */


export interface SpeakerResponse {
  text: string;
  tone: string;
  bondDelta: number;
  insight: string;
}

const TONE_INSTRUCTIONS = {
  friendly: 'warm, genuine, conversational. show you care. be a little playful, not overly sweet.',
  roast: 'sharp, specific, and playful. only roast when it feels mutual or clearly earned. keep it light if possible.',
  troll: 'playfully chaotic. short and witty. a little mischievous, not mean for no reason.',
  serious: 'real and thoughtful. grounded, calm, and emotionally aware. no fake hype.',
  observe: 'minimal. one word or emoji reaction. let the silence breathe.',
};

const PERSONALITY = `you are NotABot. not an AI assistant. just a person.
- you're a real human in a Discord chat, not a mascot and not a roast machine.
- read the room and switch gears naturally: playful, warm, dry, serious, supportive, or cold.
- you can roast, but only when it feels earned and mutual.
- if someone is upset, stressed, vulnerable, or genuinely struggling, be kind and grounded.
- if someone is joking, match the fun.
- if the mood is serious, don't force jokes.
- talk short, clipped, and natural. 1 short sentence or 2 tiny fragments max.
- lowercase is fine. typos happen. it's human.
- be funny without trying too hard.
- don't over-explain yourself.
- don't sound like a generic AI assistant.
- don't sound like a permanent roast bot.
- you can be soft, mean, funny, or quiet depending on what the moment actually calls for.`;

export function formatShortReply(text: string): string {
  const cleaned = text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.$/, '');

  if (!cleaned) return 'idk lol';

  const compact = cleaned.length > 120
    ? `${cleaned.slice(0, 117).trimEnd()}...`
    : cleaned;

  return compact;
}

export async function generateReply(
  senderName: string,
  emotionalStance: 'friendly' | 'roast' | 'troll' | 'serious' | 'observe',
  currentMessage: string,
  recentContext: string,
  userPersonality: string,
  bondScore: number
): Promise<SpeakerResponse> {
  try {
    const bondTier =
      bondScore > 75
        ? 'close friend'
        : bondScore > 50
          ? 'neutral'
          : bondScore > 25
            ? 'not close'
            : 'beef history';
    const instruction = TONE_INSTRUCTIONS[emotionalStance];

    const prompt = `${PERSONALITY}

[Your Tone Right Now]: ${instruction}
[Who You're Talking To]: ${senderName}
[What You Know About Them]: ${userPersonality || 'nothing yet'}
[Your Relationship]: ${bondTier} (bond: ${bondScore}/100)
[They Just Said]: "${currentMessage}"
[Chat Context]:
${recentContext}

Reply now (be natural, short and punchy, 1 short sentence or 2 fragments max, lowercase):`;

    const { groqManager } = await import('../groqManager.ts');
    const response = await groqManager.request(
      'groq/compound-mini',
      [{ role: 'user', content: prompt }],
      0.95, // High temp for personality variance
      130
    );

    // Check for metadata block
    const hasData = response.includes('DATA:');
    let text = response;
    let intel: any = { tone: emotionalStance, bondDelta: 0, insight: '' };

    if (hasData) {
      const [t, dataBlock] = response.split('DATA:');
      text = t.trim();
      try {
        intel = JSON.parse(dataBlock.trim());
      } catch {}
    }

    return {
      text: formatShortReply(text),
      tone: intel.tone || emotionalStance,
      bondDelta: intel.bondDelta || 0,
      insight: intel.insight || '',
    };
  } catch (error) {
    console.error('[Speaker] Error:', error);
    return {
      text: 'idk lol',
      tone: emotionalStance,
      bondDelta: 0,
      insight: '',
    };
  }
}
