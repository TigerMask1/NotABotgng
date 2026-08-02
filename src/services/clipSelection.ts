export interface ClipSelectionMessage {
  author: string;
  userId?: string;
  authorId?: string;
  content?: string;
  avatarUrl?: string;
  attachmentUrls?: string[];
  embedImageUrls?: string[];
  reactionEmojiUrls?: string[];
  screenshotUrl?: string | null;
  isBot?: boolean;
}

const CLIP_SCORE_KEYWORDS = [
  'wtf', 'bro', 'lmao', 'fr', 'wait', 'dead', 'no way', 'actually',
  'embarrassing', 'stfu', 'shut up', 'haha', 'imagine', 'seriously',
  'please', 'stop', 'help', 'what', 'why', 'how', 'screenshot', 'gif',
];

export function scoreClipMessage(message: ClipSelectionMessage): number {
  const content = (message.content ?? '').trim();
  let score = 0;

  if (content) score += 1.2;
  if (content.length > 18) score += 0.6;
  if (content.includes('?')) score += 1.2;
  if (/[!?]/.test(content)) score += 0.6;

  const lowered = content.toLowerCase();
  if (CLIP_SCORE_KEYWORDS.some(word => lowered.includes(word))) score += 1.8;
  if (lowered.includes('notabot')) score += 0.8;
  if (lowered.includes('you')) score += 0.3;
  if (lowered.includes('me')) score += 0.2;

  const mediaCount = (message.attachmentUrls?.length ?? 0)
    + (message.embedImageUrls?.length ?? 0)
    + (message.reactionEmojiUrls?.length ?? 0);
  if (mediaCount > 0) score += 2.5 + Math.min(mediaCount - 1, 2) * 0.6;

  if (message.isBot) score -= 0.3;
  if (!content && mediaCount > 0) score += 1.6;

  return score;
}

export function scoreClipWindow(messages: ClipSelectionMessage[]): number {
  if (!messages.length) return 0;
  const total = messages.reduce((acc, message) => acc + scoreClipMessage(message), 0);
  const distinctAuthors = new Set(messages.map(message => message.author)).size;
  const mediaPresent = messages.some(message =>
    (message.attachmentUrls?.length ?? 0) + (message.embedImageUrls?.length ?? 0) + (message.reactionEmojiUrls?.length ?? 0) > 0
  );

  let score = total + Math.min(distinctAuthors - 1, 3) * 1.5;
  if (mediaPresent) score += 2;
  if (messages.length >= 6) score += 1.2;
  if (messages.length >= 8) score += 0.8;
  return score;
}

export function pickBestClipWindow(messages: ClipSelectionMessage[], preferredSize = 8): ClipSelectionMessage[] {
  const recent = messages.slice(-24);
  if (recent.length <= preferredSize) return recent.slice();

  const sizes = [preferredSize, Math.min(10, recent.length), Math.min(12, recent.length), Math.min(14, recent.length)];
  let bestWindow = recent.slice(-preferredSize);
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const size of sizes) {
    for (let start = 0; start <= recent.length - size; start += 1) {
      const window = recent.slice(start, start + size);
      const score = scoreClipWindow(window);
      if (score > bestScore || (score === bestScore && window.length > bestWindow.length)) {
        bestScore = score;
        bestWindow = window;
      }
    }
  }

  return bestWindow;
}
