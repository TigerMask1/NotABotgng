/**
 * MEMORY AND PROFILER AGENT - ASYNC BACKGROUND TASK
 * Runs every 10-15 minutes to build user profiles
 * Model: groq/mixtral-8x7b-32768 (long-form analysis)
 */

import { groqManager } from '../groqManager.ts';
import { db } from '../firebase.ts';

export interface UserProfile {
  personality: string;
  interests: string[];
  dynamics: string[];
  sentiment: 'positive' | 'neutral' | 'negative';
  lastUpdated: string;
}

export async function analyzeAndProfile(
  guildId: string,
  userId: string,
  username: string,
  recentMessages: Array<{ author: string; content: string }>
) {
  try {
    if (recentMessages.length < 3) return;

    const messageText = recentMessages.map((m) => `${m.author}: ${m.content}`).join('\n');

    const prompt = `Analyze this user's personality from their messages.

User: ${username}
Messages:
${messageText}

JSON output:
{
  "personality": "one-line vibe",
  "interests": ["topic1"],
  "dynamics": ["interaction_style"],
  "sentiment": "positive|neutral|negative"
}`;

    const response = await groqManager.request(
      'mixtral-8x7b-32768',
      [{ role: 'user', content: prompt }],
      0.5,
      300
    );

    const jsonMatch = response.match(/\{[^}]*\}/);
    if (!jsonMatch) return;

    const parsed = JSON.parse(jsonMatch[0]);

    await db
      .collection('servers')
      .doc(guildId)
      .collection('users')
      .doc(userId)
      .set(
        {
          personality: parsed.personality,
          interests: parsed.interests || [],
          dynamics: parsed.dynamics || [],
          sentiment: parsed.sentiment,
          profiledAt: new Date().toISOString(),
        },
        { merge: true }
      );

    console.log(`[Profiler] ${username} analyzed`);
  } catch (e) {
    console.error(`[Profiler] Error:`, e);
  }
}

export async function compressHistory(
  guildId: string,
  messages: Array<{ author: string; content: string }>
) {
  try {
    if (messages.length < 10) return;

    const text = messages.slice(-50).map((m) => `${m.author}: ${m.content}`).join('\n');

    const prompt = `Summarize this chat in 2-3 key facts, inside jokes, and group vibe.

${text}

JSON:
{"summary":"text","insideJokes":[],"groupVibe":"text"}`;

    const response = await groqManager.request(
      'mixtral-8x7b-32768',
      [{ role: 'user', content: prompt }],
      0.5,
      400
    );

    const jsonMatch = response.match(/\{[^}]*\}/);
    if (!jsonMatch) return;

    const parsed = JSON.parse(jsonMatch[0]);

    await db.collection('servers').doc(guildId).set(
      {
        compressedHistory: parsed,
        historyCompressedAt: new Date().toISOString(),
      },
      { merge: true }
    );

    console.log(`[Profiler] History compressed`);
  } catch (e) {
    console.error(`[Profiler] Compression error:`, e);
  }
}
