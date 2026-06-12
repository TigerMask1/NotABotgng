/**
 * GREETING AGENT
 * Handles when someone greets the bot (hi, hey, hello, etc.)
 * Makes replies feel HUMAN - natural, varied, contextual, warm
 * Model: groq/llama-3.1-70b-versatile
 */

import { groqManager } from '../groqManager.ts';

const GREETING_PERSONALITIES = [
  'you just woke up, a bit groggy, reply casually',
  'you\'re in a good mood, being warm and friendly',
  'you\'re chill, unbothered, short response',
  'you\'re hyped, showing actual energy',
  'you\'re tired, one-word or minimal response',
  'you\'re curious, asking them something back',
];

const HUMAN_GREETING_REPLIES = [
  // Natural, human-like responses to greetings
  'yo what\'s up',
  'hey hey',
  'yooo',
  'sup',
  'hiii',
  'yo',
  'heyyy',
  'hey 👋',
  'wassup',
  'iiii',
  'what\'s good',
  'hello hello',
  'yo how\'s it going',
  'henlooo',
  'yo yooo',
  'aye aye',
  'you good?',
  'what\'s new',
];

export interface GreetingResponse {
  text: string;
  shouldUpdateBond: boolean;
  bondDelta: number;
}

/**
 * Generate a human-like greeting response
 */
export async function generateGreeting(
  senderName: string,
  isFirstTime: boolean,
  bondScore: number,
  recentContext: string
): Promise<GreetingResponse> {
  try {
    // Sometimes just pick a pre-made response (most human)
    if (Math.random() < 0.5) {
      const reply = HUMAN_GREETING_REPLIES[Math.floor(Math.random() * HUMAN_GREETING_REPLIES.length)];
      return {
        text: reply,
        shouldUpdateBond: true,
        bondDelta: isFirstTime ? 2 : 0,
      };
    }

    // Sometimes generate with AI for variety
    const personality = GREETING_PERSONALITIES[Math.floor(Math.random() * GREETING_PERSONALITIES.length)];
    const bondContext = bondScore > 75 ? 'they\'re your friend' : bondScore > 50 ? 'they\'re neutral' : 'they\'re not close';

    const prompt = `You are NotABot greeting someone who just said hi. You\'re a real person, not an AI.

${personality}
they are ${bondContext}
they said: "hi"

Greeting back (1 sentence max, casual, lowercase): \n`;

    const response = await groqManager.request(
      'llama-3.1-70b-versatile',
      [{ role: 'user', content: prompt }],
      0.95, // High temp for variety
      50 // Short response
    );

    const text = response.trim().split('\n')[0];

    return {
      text: text.slice(0, 100),
      shouldUpdateBond: true,
      bondDelta: isFirstTime ? 3 : 1,
    };
  } catch (error) {
    console.error('[Greeter] Error:', error);
    // Fallback to pre-made response
    return {
      text: 'yo',
      shouldUpdateBond: false,
      bondDelta: 0,
    };
  }
}
