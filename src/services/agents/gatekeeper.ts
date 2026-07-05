/**
 * SOCIAL GATEKEEPER AGENT
 * Decides if bot should respond - AI makes ALL decisions including greetings
 * No hardcoded patterns. Pure AI decision making.
 * Model: groq/compound-mini (fast, high-volume, consistent)
 */

import { groqManager } from '../groqManager.ts';

export interface GatekeeperDecision {
  shouldReply: boolean;
  confidence: number;
  emotionalStance: 'friendly' | 'roast' | 'troll' | 'serious' | 'observe';
  reason: string;
}

export async function evaluateMessage(
  senderName: string,
  senderProfile: string,
  currentMessage: string,
  recentContext: string,
  botMentioned: boolean,
  bondScore: number
): Promise<GatekeeperDecision> {
  try {
    // Let AI decide everything - no hardcoded shortcuts
    const prompt = `You are NotABot's decision maker. Decide if you should respond to this message.
Be natural. Be selective. Sometimes staying silent is better.

[Sender]: ${senderName}
[About Sender]: ${senderProfile || 'no info yet'}
[Your Bond with Sender]: ${bondScore}/100
[Bot Mentioned?]: ${botMentioned ? 'YES' : 'NO'}
[Message]: "${currentMessage}"
[Recent Context]:
${recentContext.split('\n').slice(-6).join('\n')}

DECISION GUIDELINES:
Reply if:
- Message is directed at you or clearly wants a response
- It's a genuine greeting, check-in, vent, joke, or real question
- You can add warmth, humor, support, or a sharp but fair reaction
- The moment actually calls for a reply, not just a reflex

Skip if:
- Two people are having their own conversation and you're not needed
- It's filler and no real engagement is happening
- You're just being noisy or forcing a reply
- You already spoke recently and nothing new earned another turn

TONE RULES:
- Roast only when the moment is playful, mutual, or clearly deserves a jab
- Be supportive when someone is sad, stressed, insecure, or genuinely struggling
- Be calm and grounded when the vibe is serious or quiet
- Be playful when the room is joking around
- Be minimal or silent when nothing needs to be said

Output ONLY valid JSON, no markdown:
{
  "shouldReply": boolean,
  "emotionalStance": "friendly|roast|troll|serious|observe",
  "reason": "one line explanation",
  "confidence": 0.0-1.0
}`;

    const response = await groqManager.request(
      'groq/compound-mini',
      [{ role: 'user', content: prompt }],
      0.4, // Moderate temp for consistent but thoughtful decisions
      200
    );

    try {
      const parsed = JSON.parse(response);
      return {
        shouldReply: parsed.shouldReply,
        confidence: parsed.confidence || 0.75,
        emotionalStance: parsed.emotionalStance || 'observe',
        reason: parsed.reason || 'ai decision',
      };
    } catch (e) {
      // Fallback if JSON parsing fails
      console.warn('[Gatekeeper] JSON parse failed, falling back to text analysis');
      const shouldReply = response.toLowerCase().includes('true') || botMentioned;
      return {
        shouldReply,
        confidence: botMentioned ? 0.9 : 0.6,
        emotionalStance: 'observe',
        reason: 'fallback decision',
      };
    }
  } catch (e) {
    console.error('[Gatekeeper] Error:', e);
    // Safest fallback: only reply if explicitly mentioned
    return {
      shouldReply: botMentioned,
      confidence: 0,
      emotionalStance: 'observe',
      reason: 'gatekeeper error - safe fallback',
    };
  }
}
