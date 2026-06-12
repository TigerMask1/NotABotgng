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
- Message is directed at you (mentioned or clear intent)
- It's a genuine greeting and feels natural to respond
- You can add something meaningful to the conversation
- Someone asked a real question
- You have something funny or relevant to say

Skip if:
- Two people are having their own conversation
- It's clearly not directed at you
- Message is empty/filler and no personal engagement
- You've recently replied and they haven't responded
- Replying would interrupt or feel forced

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
