/**
 * GREETING AGENT
 * Generates natural greeting responses
 * Model: groq/compound-mini (fast for real-time responses)
 */

import { groqManager } from '../groqManager.ts';

export interface GreetingResponse {
  text: string;
  shouldUpdateBond: boolean;
  bondDelta: number;
}

/**
 * Generate a greeting response
 * AI decides if it should greet or not based on context
 */
export async function generateGreeting(
  senderName: string,
  isFirstTime: boolean,
  bondScore: number,
  currentMessage: string,
  recentContext: string
): Promise<GreetingResponse> {
  try {
    const bondTier =
      bondScore > 75 ? 'friend' : bondScore > 50 ? 'neutral' : 'not close';

    const prompt = `You are NotABot greeting someone. You're a person, not an AI.

Context:
[Who]: ${senderName}
[Your bond]: ${bondTier} (${bondScore}/100)
[First time meeting them]: ${isFirstTime}
[They said]: "${currentMessage}"
[Recent chat]:
${recentContext}

Respond naturally to their greeting (1 sentence max, lowercase, be human):`;

    const response = await groqManager.request(
      'groq/compound-mini',
      [{ role: 'user', content: prompt }],
      0.85, // Higher temp for personality in greetings
      60
    );

    const text = response.trim().split('\n')[0];

    return {
      text: text.slice(0, 100),
      shouldUpdateBond: true,
      bondDelta: isFirstTime ? 3 : 1,
    };
  } catch (error) {
    console.error('[Greeter] Error:', error);
    // Simple fallback
    return {
      text: 'yo',
      shouldUpdateBond: false,
      bondDelta: 0,
    };
  }
}
