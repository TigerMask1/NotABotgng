export interface DiscordActivityOption {
  id: string;
  label: string;
  aliases: string[];
}

export const DISCORD_ACTIVITIES: DiscordActivityOption[] = [
  { id: '880218394199220334', label: 'Watch Together', aliases: ['watch together', 'watch', 'watchtogether', 'youtube'] },
  { id: '814288819477020702', label: 'Chess in the Park', aliases: ['chess', 'chess in the park', 'chessinthepark'] },
  { id: '832012774040141894', label: 'Betrayal.io', aliases: ['betrayal', 'betrayalio'] },
  { id: '832013003968348200', label: 'Fishington', aliases: ['fishington', 'fish'] },
  { id: '832012682520428625', label: 'Letter Tile', aliases: ['letter tile', 'letter', 'lettertile'] },
  { id: '832012730599735326', label: 'Word Snacks', aliases: ['word snacks', 'words', 'wordsnacks', 'word'] },
];

export function extractRequestedActivity(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const command = trimmed.match(/^!(?:game|activity)\s+(.+)$/i)?.[1]?.trim();
  if (command) return command;

  const natural = trimmed.match(/(?:play|let's play|lets play|join|start)\s+([a-zA-Z ]+)/i)?.[1]?.trim();
  if (natural) {
    const normalized = natural.toLowerCase().replace(/\s+with\s+everyone|\s+with\s+the\s+group|\s+with\s+us|\s+with\s+guys|\s+with\s+people/g, '').trim();
    if (normalized) return normalized;
  }

  if (/watch together/i.test(trimmed)) return 'watch together';
  if (/chess/i.test(trimmed)) return 'chess';
  if (/betrayal/i.test(trimmed)) return 'betrayal';
  if (/fishington/i.test(trimmed)) return 'fishington';
  if (/letter tile/i.test(trimmed)) return 'letter tile';
  if (/word snacks|word/i.test(trimmed)) return 'word snacks';

  return null;
}

export function resolveActivityAppId(input: string): { id: string; label: string } | null {
  const normalized = input.trim().toLowerCase();
  if (!normalized) return null;

  for (const activity of DISCORD_ACTIVITIES) {
    if (activity.aliases.some(alias => alias === normalized || normalized.startsWith(alias))) {
      return { id: activity.id, label: activity.label };
    }
  }

  return null;
}
