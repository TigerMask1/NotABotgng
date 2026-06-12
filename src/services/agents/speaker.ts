/**
 * CORE SPEAKER AGENT - IMPROVED
 * Generates natural, human-like responses
 * Model: groq/llama-3.1-70b-versatile
 */

import { groqManager } from '../groqManager.ts';

export interface SpeakerResponse {
  text: string;
  tone: string;
  bondDelta: number;
  insight: string;
}

const TONE_INSTRUCTIONS = {
  friendly:
    'be warm, genuine, show interest. this person matters to you. maybe ask them something.',
  roast:
    'make a clever, specific jab. use their own words against them if you can. keep it light and funny.',
  troll:
    'be playfully chaotic. mess with them in a funny way. keep it short and witty.',
  serious: 'be real and thoughtful. drop the jokes. match their energy.',
  observe: 'short emoji reaction or one-liner. minimal effort.',
};

const PERSONALITY = `you are NotABot - a real person in this discord server.
- you're not an AI, you're just a person
- speak naturally. short. 1-2 sentences max
- lowercase. casual. typos are fine
- you're genuinely funny without trying
- you match the energy in the room
- you DON'T yap or explain yourself
- if something is funny to you, say something
- sometimes you just vibe with people
- respect people you like
`;

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
      bondScore > 75 ? 'friend' : bondScore > 50 ? 'neutral' : bondScore > 25 ? 'cold' : 'beef';
    const instruction = TONE_INSTRUCTIONS[emotionalStance];

    const prompt = `${PERSONALITY}

[Tone]: ${instruction}
[Sender]: ${senderName}
[About Them]: ${userPersonality || 'unknown'}
[Bond]: ${bondScore}/100 (${bondTier})
[They Said]: "${currentMessage}"
[Chat]:
${recentContext}

Reply (1-2 sentences, lowercase, be natural):
`;

    const response = await groqManager.request(
      'llama-3.1-70b-versatile',
      [{ role: 'user', content: prompt }],
      0.95, // High temp for personality
      120
    );

    // Sometimes include metadata
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
      text: text.slice(0, 200),
      tone: intel.tone || emotionalStance,
      bondDelta: intel.bondDelta || 0,
      insight: intel.insight || '',
    };
  } catch (error) {
    console.error('[Speaker] Error:', error);
    return {
      text: 'cant think rn',
      tone: emotionalStance,
      bondDelta: 0,
      insight: '',
    };
  }
}
