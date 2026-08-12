import { notabotDb } from './supabase.ts';

export interface DMRelationship {
  userId: string;
  totalDmTurns: number;
  lastDmAt: number;
  lastBotMessageAt: number;
  lastBotMessageText: string;
  gotReplyToLastBotMessage: boolean;
  playbookFired: {
    channel: number | null;
    businessbot: number | null;
    server_invite: number | null;
    latest_video: number | null;
  };
}

const DEFAULT_PLAYBOOK = { channel: null, businessbot: null, server_invite: null, latest_video: null };

export async function getDMRelationship(userId: string): Promise<DMRelationship> {
  const defaultRel: DMRelationship = {
    userId,
    totalDmTurns: 0,
    lastDmAt: 0,
    lastBotMessageAt: 0,
    lastBotMessageText: '',
    gotReplyToLastBotMessage: false,
    playbookFired: { ...DEFAULT_PLAYBOOK }
  };

  try {
    const { data, error } = await notabotDb
      .from('dm_relationships')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    if (error || !data) return defaultRel;

    return {
      userId,
      totalDmTurns: data.total_dm_turns ?? 0,
      lastDmAt: data.last_dm_at ?? 0,
      lastBotMessageAt: data.last_bot_message_at ?? 0,
      lastBotMessageText: data.last_bot_message_text ?? '',
      gotReplyToLastBotMessage: data.got_reply_to_last ?? false,
      playbookFired: {
        channel: data.playbook_channel ?? null,
        businessbot: data.playbook_businessbot ?? null,
        server_invite: data.playbook_server_invite ?? null,
        latest_video: data.playbook_latest_video ?? null,
      }
    };
  } catch (e) {
    console.error(`[DM] Error getting relationship for ${userId}:`, e);
    return defaultRel;
  }
}

export async function updateDMRelationship(userId: string, updates: Partial<DMRelationship>) {
  try {
    const row: Record<string, any> = { user_id: userId, updated_at: new Date().toISOString() };
    if (updates.totalDmTurns !== undefined) row.total_dm_turns = updates.totalDmTurns;
    if (updates.lastDmAt !== undefined) row.last_dm_at = updates.lastDmAt;
    if (updates.lastBotMessageAt !== undefined) row.last_bot_message_at = updates.lastBotMessageAt;
    if (updates.lastBotMessageText !== undefined) row.last_bot_message_text = updates.lastBotMessageText;
    if (updates.gotReplyToLastBotMessage !== undefined) row.got_reply_to_last = updates.gotReplyToLastBotMessage;
    if (updates.playbookFired) {
      if (updates.playbookFired.channel !== undefined) row.playbook_channel = updates.playbookFired.channel;
      if (updates.playbookFired.businessbot !== undefined) row.playbook_businessbot = updates.playbookFired.businessbot;
      if (updates.playbookFired.server_invite !== undefined) row.playbook_server_invite = updates.playbookFired.server_invite;
      if (updates.playbookFired.latest_video !== undefined) row.playbook_latest_video = updates.playbookFired.latest_video;
    }
    await notabotDb.from('dm_relationships').upsert(row, { onConflict: 'user_id' });
  } catch (e) {
    console.error(`[DM] Error updating relationship for ${userId}:`, e);
  }
}

export function getSocialPlaybookPrompt(rel: DMRelationship, bond: number, inMainServer: boolean): string {
  const now = Date.now();
  const days = (ms: number) => ms / (1000 * 60 * 60 * 24);
  const promptParts: string[] = [];
  const socialNotes: string[] = [];

  promptParts.push(`DM RELATIONSHIP CONTEXT:`);
  promptParts.push(`- ${rel.totalDmTurns} DM turns total with this person.`);

  if (rel.lastBotMessageAt > 0) {
    const daysSinceLast = days(now - rel.lastBotMessageAt);
    const replied = rel.gotReplyToLastBotMessage ? 'They responded to it.' : 'They did NOT respond to it. Don\'t push if they seem uninterested.';
    promptParts.push(`- Last time you DMed them was ${Math.round(daysSinceLast)} days ago. You said: "${rel.lastBotMessageText}". ${replied}`);
  }

  if (bond < 50) {
    const channelFired = rel.playbookFired.channel;
    if (!channelFired || days(now - channelFired) > 3) {
      socialNotes.push(`- You haven't mentioned your YouTube channel lately. If videos, content creation, or gaming comes up naturally, you can casually drop a mention of it.`);
    }
  }

  const bbFired = rel.playbookFired.businessbot;
  if (!bbFired || days(now - bbFired) > 3) {
    socialNotes.push(`- If they express interest in Discord bots, economy systems, or fun games, you can casually mention your sister-bot BusinessBot as something they might enjoy.`);
  }

  if (!inMainServer && bond >= 40) {
    const inviteFired = rel.playbookFired.server_invite;
    if (!inviteFired || days(now - inviteFired) > 7) {
      socialNotes.push(`- They seem to like you (bond: ${bond}), but they aren't in your main server yet. If the vibe is good, softly hint that your server is fun and they'd fit in.`);
    }
  }

  if (socialNotes.length > 0) {
    promptParts.push(`\nSOCIAL AWARENESS (only act on this if the conversation naturally opens a door — NEVER force it or sound like an ad):`);
    promptParts.push(...socialNotes);
  }

  return promptParts.join('\n');
}
