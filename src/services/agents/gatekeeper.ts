/**
 * SOCIAL GATEKEEPER AGENT
 * Monitors every message and decides whether bot should intervene.
 * Model: groq/llama-3.1-70b-versatile (fast, low latency, structured output)
 * Purpose: Filter noise, evaluate social context, determine emotional stance
 */

import Groq from 'groq-sdk';

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

export interface GatekeeperDecision {
  shouldReply: boolean;
  confidence: number; // 0-1
  targetUser: string;
  emotionalStance: 'friendly' | 'roast' | 'troll' | 'serious' | 'observe';
  reason: string;
  urgency: 'high' | 'medium' | 'low';
}

export async function evaluateMessage(
  senderName: string,
  senderHistory: string[],
  currentMessage: string,
  recentContext: string,
  botMentioned: boolean,
  bondScore: number
): Promise<GatekeeperDecision> {
  try {
    const prompt = `You are NotABot's Social Gatekeeper. Your ONLY job: decide if the bot should reply to this message.

CRITICAL RULES:
- Do NOT reply to greetings alone (hi, hey, hello, how are you)
- Do NOT reply to filler (lol, fr, ok, same, yeah)
- DO reply if: bot is mentioned, question asked, conversation about bot, natural moment
- Match energy: if chill→chill. If roasting→roast back. If serious→serious.
- NEVER force a reply. Silence beats interrupting.

[Sender]: ${senderName}
[Sender History]: ${senderHistory.slice(-3).join(' | ') || 'new'}
[Bond with Sender]: ${bondScore}/100
[Bot Mentioned?]: ${botMentioned ? 'YES' : 'NO'}
[Current Message]: "${currentMessage}"
[Recent Context]:
${recentContext}

Respond ONLY with this JSON:
{
  "shouldReply": boolean,
  "confidence": 0.0-1.0,
  "emotionalStance": "friendly|roast|troll|serious|observe",
  "reason": "one line",
  "urgency": "high|medium|low"
}`;

    const message = await groq.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      model: 'llama-3.1-70b-versatile',
      temperature: 0.3,
      max_tokens: 200,
    });

    const content = message.choices[0]?.message?.content || '';
    const parsed = JSON.parse(content);

    return {
      shouldReply: parsed.shouldReply,
      confidence: parsed.confidence,
      targetUser: senderName,
      emotionalStance: parsed.emotionalStance,
      reason: parsed.reason,
      urgency: parsed.urgency,
    };
  } catch (e) {
    console.error('[Gatekeeper] Parse error:', e);
    return {
      shouldReply: false,
      confidence: 0,
      targetUser: senderName,
      emotionalStance: 'observe',
      reason: 'gatekeeper error',
      urgency: 'low',
    };
  }
}
