import { db } from './firebase.js';

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

export async function getDMRelationship(userId: string): Promise<DMRelationship> {
  const defaultRel: DMRelationship = {
    userId,
    totalDmTurns: 0,
    lastDmAt: 0,
    lastBotMessageAt: 0,
    lastBotMessageText: '',
    gotReplyToLastBotMessage: false,
    playbookFired: { channel: null, businessbot: null, server_invite: null, latest_video: null }
  };

  try {
    const snap = await db.collection('dmRelationships').doc(userId).get();
    if (!snap.exists) return defaultRel;
    const data = snap.data() as Partial<DMRelationship>;
    return { ...defaultRel, ...data, playbookFired: { ...defaultRel.playbookFired, ...data.playbookFired } };
  } catch (e) {
    console.error(`[DM] Error getting relationship for ${userId}:`, e);
    return defaultRel;
  }
}

export async function updateDMRelationship(userId: string, updates: Partial<DMRelationship>) {
  try {
    await db.collection('dmRelationships').doc(userId).set(updates, { merge: true });
  } catch (e) {
    console.error(`[DM] Error updating relationship for ${userId}:`, e);
  }
}

export function getSocialPlaybookPrompt(rel: DMRelationship, bond: number, inMainServer: boolean): string {
  const now = Date.now();
  const days = (ms: number) => ms / (1000 * 60 * 60 * 24);
  const promptParts: string[] = [];
  const socialNotes: string[] = [];

  // Relationship Context
  promptParts.push(`DM RELATIONSHIP CONTEXT:`);
  promptParts.push(`- ${rel.totalDmTurns} DM turns total with this person.`);
  
  if (rel.lastBotMessageAt > 0) {
    const daysSinceLast = days(now - rel.lastBotMessageAt);
    const replied = rel.gotReplyToLastBotMessage ? 'They responded to it.' : 'They did NOT respond to it. Don\'t push if they seem uninterested.';
    promptParts.push(`- Last time you DMed them was ${Math.round(daysSinceLast)} days ago. You said: "${rel.lastBotMessageText}". ${replied}`);
  }

  // Playbook Readiness Checks
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
