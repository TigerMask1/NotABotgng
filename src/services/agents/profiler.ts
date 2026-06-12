/**
 * MEMORY AND PROFILER AGENT
 * Runs asynchronously every 10-15 minutes to build user profiles.
 * Model: groq/mixtral-8x7b-32768 (best for long-form analysis, 32k context)
 * Purpose: Extract relationships, build profiles, compress historical data
 */

import Groq from 'groq-sdk';
import { db } from '../firebase.ts';
import { FieldValue } from 'firebase-admin/firestore';

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

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
    if (recentMessages.length < 3) return; // Not enough data

    const messageText = recentMessages
      .map((m) => `${m.author}: ${m.content}`)
      .join('\n');

    const prompt = `Analyze this user from their recent messages and create a personality profile.

User: ${username}
Recent Messages:
${messageText}

Extract (JSON):
{
  "personality": "one-line vibe (e.g., 'chaotic gamer, always joking')",
  "interests": ["topic1", "topic2"],
  "dynamics": ["how they interact", "what triggers them"],
  "sentiment": "positive|neutral|negative"
}`;

    const message = await groq.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      model: 'mixtral-8x7b-32768',
      temperature: 0.5,
      max_tokens: 300,
    });

    const content = message.choices[0]?.message?.content || '';
    const parsed = JSON.parse(content);

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
    console.error(`[Profiler] Failed for ${userId}:`, e);
  }
}

export async function compressHistory(
  guildId: string,
  messageHistory: Array<{ author: string; content: string }>
) {
  try {
    if (messageHistory.length < 10) return;

    const historyText = messageHistory
      .slice(-50)
      .map((m) => `${m.author}: ${m.content}`)
      .join('\n');

    const prompt = `Compress this chat history into 2-3 key facts about what happened, any inside jokes, and overall vibe.

${historyText}

Output (JSON):
{
  "summary": "one paragraph",
  "keyMoments": ["moment1", "moment2"],
  "insideJokes": ["joke1"],
  "groupVibe": "description"
}`;

    const message = await groq.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      model: 'mixtral-8x7b-32768',
      temperature: 0.5,
      max_tokens: 400,
    });

    const content = message.choices[0]?.message?.content || '';
    const parsed = JSON.parse(content);

    await db.collection('servers').doc(guildId).set(
      {
        compressedHistory: parsed,
        historyCompressedAt: new Date().toISOString(),
      },
      { merge: true }
    );

    console.log(`[Profiler] History compressed for guild ${guildId}`);
  } catch (e) {
    console.error(`[Profiler] Compression failed:`, e);
  }
}
