/**
 * CORE SPEAKER AGENT
 * Generates the actual conversational response.
 * Model: groq/llama-3.1-70b-versatile (fast, personality-driven)
 * Purpose: Write natural, contextual replies matching the emotional stance
 */

import Groq from 'groq-sdk';

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

export interface SpeakerResponse {
  text: string;
  tone: string;
  bondDelta: number;
  insight: string;
}

const PERSONALITY = `you are NotABot. real person. not an AI.
- speak naturally. short. 1-2 sentences MAX.
- lowercase. casual. dry humor works.
- NO greetings. NO filler.
- match energy in the room.
- you can be warm with people you like.
- roast only when it's funny, not to dominate.
- never explain yourself.
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
    const stanceInstructions = {
      friendly: 'Be warm and genuine. Show interest. Build connection.',
      roast: 'Make a clever, specific jab. Use their own words against them if possible.',
      troll: 'Be playfully chaotic. Mess with them in a funny way. Keep it light.',
      serious: 'Be real and thoughtful. Match their energy. Drop the jokes.',
      observe: 'React briefly with emoji or one-liner. Minimal engagement.',
    };

    const prompt = `${PERSONALITY}

${stanceInstructions[emotionalStance]}

[Sender]: ${senderName}
[About Them]: ${userPersonality || 'unknown'}
[Bond]: ${bondScore}/100 (${bondScore > 75 ? 'friend' : bondScore > 50 ? 'neutral' : bondScore > 25 ? 'cold' : 'beef'})
[Their Message]: "${currentMessage}"
[Recent Chat]:
${recentContext}

Write your reply (1-2 sentences, lowercase). Then:
DATA: {"tone":"str","bondDelta":-2 to +2,"insight":"brief observation or empty"}`;

    const message = await groq.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      model: 'llama-3.1-70b-versatile',
      temperature: 0.9,
      max_tokens: 150,
    });

    const content = message.choices[0]?.message?.content || '';
    const [text, dataBlock] = content.split('DATA:');
    let intel = { tone: emotionalStance, bondDelta: 0, insight: '' };

    if (dataBlock) {
      try {
        intel = JSON.parse(dataBlock.trim());
      } catch (e) {
        console.warn('[Speaker] DATA parse failed, using defaults');
      }
    }

    return {
      text: text.trim(),
      tone: intel.tone || emotionalStance,
      bondDelta: intel.bondDelta || 0,
      insight: intel.insight || '',
    };
  } catch (e) {
    console.error('[Speaker] Error:', e);
    return {
      text: 'couldnt think of anything lol',
      tone: emotionalStance,
      bondDelta: 0,
      insight: '',
    };
  }
}
