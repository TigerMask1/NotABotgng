/**
 * SOCIAL GATEKEEPER AGENT - IMPROVED
 * Decides if bot should respond to a message
 * Now with special handling for greetings
 * Model: groq/llama-3.1-70b-versatile
 */

import { groqManager } from '../groqManager.ts';

export interface GatekeeperDecision {
  shouldReply: boolean;
  isGreeting: boolean; // Special flag for greeting handling
  confidence: number;
  emotionalStance: 'friendly' | 'roast' | 'troll' | 'serious' | 'observe';
  reason: string;
}

const GREETING_KEYWORDS = ['hi', 'hey', 'hello', 'yo', 'sup', 'howdy', 'greetings', 'what\'s up', 'hola', 'how are you'];
const FILLER_KEYWORDS = ['lol', 'fr', 'ok', 'yeah', 'same', 'nah', 'yep', 'no', 'yes', 'hm', 'gg', 'f', 'rip'];

function isGreeting(content: string): boolean {
  const lower = content.toLowerCase().trim();
  return GREETING_KEYWORDS.some((g) => lower.includes(g)) && content.length < 50;
}

function isFiller(content: string): boolean {
  const lower = content.toLowerCase().trim();
  return FILLER_KEYWORDS.includes(lower);
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
    // Quick local checks first
    const isGreet = isGreeting(currentMessage);
    const isFill = isFiller(currentMessage);

    // If greeting and bot is mentioned or online, ALWAYS reply
    if (isGreet && botMentioned) {
      return {
        shouldReply: true,
        isGreeting: true,
        confidence: 0.95,
        emotionalStance: 'friendly',
        reason: 'direct greeting to bot',
      };
    }

    // If pure filler and no mention, skip
    if (isFill && !botMentioned) {
      return {
        shouldReply: false,
        isGreeting: false,
        confidence: 0.9,
        emotionalStance: 'observe',
        reason: 'filler message',
      };
    }

    // If bot mentioned, always consider replying
    if (botMentioned) {
      return {
        shouldReply: true,
        isGreeting: false,
        confidence: 0.9,
        emotionalStance: bondScore > 75 ? 'friendly' : bondScore > 50 ? 'serious' : 'roast',
        reason: 'bot mentioned',
      };
    }

    // Use AI for nuanced decisions
    const prompt = `Decide if NotABot should respond. Be selective.

[Sender]: ${senderName}
[Profile]: ${senderProfile || 'unknown'}
[Bond]: ${bondScore}/100
[Message]: "${currentMessage}"
[Context]:
${recentContext.split('\n').slice(-5).join('\n')}

RULES:
- Reply if: genuine question, conversation natural, bot adds value
- Skip if: two users talking, bot not needed, message is filler
- ALWAYS reply if bot is directly pinged

JSON: {"shouldReply":bool,"emotionalStance":"friendly|roast|troll|serious|observe","reason":"one line"}`;

    const response = await groqManager.request(
      'llama-3.1-70b-versatile',
      [{ role: 'user', content: prompt }],
      0.3, // Low temp for consistent decisions
      150
    );

    const jsonMatch = response.match(/\{[^}]*\}/);
    if (!jsonMatch) {
      return {
        shouldReply: botMentioned,
        isGreeting: false,
        confidence: 0.5,
        emotionalStance: 'observe',
        reason: 'parse error',
      };
    }

    const parsed = JSON.parse(jsonMatch[0]);
    return {
      shouldReply: parsed.shouldReply,
      isGreeting: false,
      confidence: 0.8,
      emotionalStance: parsed.emotionalStance || 'observe',
      reason: parsed.reason || '',
    };
  } catch (e) {
    console.error('[Gatekeeper] Error:', e);
    return {
      shouldReply: botMentioned,
      isGreeting: false,
      confidence: 0,
      emotionalStance: 'observe',
      reason: 'gatekeeper error',
    };
  }
}
