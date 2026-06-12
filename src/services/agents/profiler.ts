/**
 * MEMORY AND PROFILER AGENT - ASYNC BACKGROUND TASK
 * Runs every 10-15 minutes to build user profiles
 * Model: qwen/qwen3-32b (good for deep analysis without timeout)
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

    const prompt = `Analyze this user from their messages. Create a brief personality profile.

User: ${username}
Messages:
${messageText}

Profile (JSON):
{
  "personality": "one-line vibe (e.g., casual gamer, always joking)",
  "interests": ["topic1", "topic2"],
  "dynamics": ["how they talk", "what they care about"],
  "sentiment": "positive|neutral|negative"
}`;

    const response = await groqManager.request(
      'qwen/qwen3-32b',
      [{ role: 'user', content: prompt }],
      0.5,
      250
    );

    try {
      const parsed = JSON.parse(response);

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

      console.log(`[Profiler] ${username} profiled`);
    } catch (e) {
      console.warn(`[Profiler] JSON parse failed for ${username}`);
    }
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

    const prompt = `Summarize this Discord chat. Extract key facts, inside jokes, and group vibe.

${text}

Summary (JSON):
{"summary":"brief","insideJokes":[],"groupVibe":"description"}`;

    const response = await groqManager.request(
      'qwen/qwen3-32b',
      [{ role: 'user', content: prompt }],
      0.5,
      300
    );

    try {
      const parsed = JSON.parse(response);

      await db.collection('servers').doc(guildId).set(
        {
          compressedHistory: parsed,
          historyCompressedAt: new Date().toISOString(),
        },
        { merge: true }
      );

      console.log(`[Profiler] History compressed`);
    } catch (e) {
      console.warn(`[Profiler] JSON parse failed on compression`);
    }
  } catch (e) {
    console.error(`[Profiler] Compression error:`, e);
  }
}
