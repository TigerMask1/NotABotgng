import { notabotDb } from './supabase.js';

export interface YouTubeClipPayload {
  timestamp: number;
  guildId: string | null;
  guildName?: string | null;
  channelId: string;
  channelName?: string | null;
  clipMode?: string;
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
 * Saves a raw snippet of conversation to the youtube_queue in Supabase.
 */
export async function queueConversationForYouTube(payload: YouTubeClipPayload) {
  try {
    const mediaSummary = payload.messages.flatMap((message) => [
      ...(message.attachmentUrls ?? []),
      ...(message.embedImageUrls ?? []),
      ...(message.reactionEmojiUrls ?? []),
    ]).slice(0, 20);

    const { error } = await notabotDb.from('youtube_queue').insert({
      guild_id: payload.guildId,
      guild_name: payload.guildName ?? null,
      channel_id: payload.channelId,
      channel_name: payload.channelName ?? null,
      messages: payload.messages,
      media_summary: mediaSummary,
      clip_mode: payload.clipMode ?? 'normal',
      status: 'pending',
      queued_at: Date.now(),
    });

    if (error) throw error;
    console.log(`[YouTube Clipper] Saved snippet to queue for channel ${payload.channelId}`);
  } catch (error) {
    console.error(`[YouTube Clipper] Error saving to queue:`, error);
  }
}
