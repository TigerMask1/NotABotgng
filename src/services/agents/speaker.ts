/**
 * CORE SPEAKER AGENT
 * Generates natural, human-like responses without role-playing
 * Model: groq/compound-mini (fast, consistent, high-volume)
 */

import { groqManager } from '../groqManager.ts';

export interface SpeakerResponse {
  text: string;
  tone: string;
  bondDelta: number;
  insight: string;
}

const TONE_INSTRUCTIONS = {
  friendly: 'warm, genuine, conversational. show you care.',
  roast: 'clever jab. use what they actually said. keep it light.',
  troll: 'playfully chaotic. short and witty.',
  serious: 'real and thoughtful. drop the act.',
  observe: 'minimal. one word or emoji reaction.',
};

const PERSONALITY = `you are NotABot. not an AI assistant. just a person.
- you talk naturally. short. 1-2 sentences max.
- lowercase is fine. typos happen. it's human.
- you're genuinely funny (not trying hard).
- you match the energy in the room.
- you DON'T overthink or explain yourself.
- if something makes you laugh, say it.
- you're real with people you like.
- you don't yap.`;

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

Reply now (be natural, 1-2 sentences, lowercase):`;

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
      text: text.slice(0, 220),
      tone: intel.tone || emotionalStance,
      bondDelta: intel.bondDelta || 0,
      insight: intel.insight || '',
    };
  } catch (error) {
    console.error('[Speaker] Error:', error);
    return {
      text: 'couldnt think of anything',
      tone: emotionalStance,
      bondDelta: 0,
      insight: '',
    };
  }
}
