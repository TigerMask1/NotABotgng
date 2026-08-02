import { db } from './firebase.js';

export interface YouTubeClipPayload {
  timestamp: number;
  guildId: string | null;
  guildName?: string | null;
  channelId: string;
  channelName?: string | null;
  messages: {
    author: string;
    userId: string;
    content: string;
    avatarUrl: string;
    attachmentUrls: string[];
    embedImageUrls: string[];
    reactionEmojiUrls: string[];
    screenshotUrl?: string | null;
    isBot: boolean;
  }[];
}

/**
 * Saves a raw snippet of conversation to the youtube_queue in Firestore.
 */
export async function queueConversationForYouTube(payload: YouTubeClipPayload) {
  try {
    await db.collection('youtube_queue').add({
      ...payload,
      status: 'pending',
      queuedAt: Date.now(),
      mediaSummary: payload.messages.flatMap((message) => [
        ...(message.attachmentUrls ?? []),
        ...(message.embedImageUrls ?? []),
        ...(message.reactionEmojiUrls ?? []),
      ]).slice(0, 20)
    });
    console.log(`[YouTube Clipper] Saved snippet to queue for channel ${payload.channelId}`);
  } catch (error) {
    console.error(`[YouTube Clipper] Error saving to queue:`, error);
  }
}
