export type TextTargetPlatform = 'instagram' | 'tiktok' | 'youtube';

export type ParsedTextProfileInput =
  | { ok: true; name: string; context?: string; subject: string; targetPlatforms?: TextTargetPlatform[] }
  | { ok: false; error: string };

export const TEXT_SUBJECT_MAX = 120;
export const PLATFORM_LABELS: Record<TextTargetPlatform, string> = { instagram: 'Instagram', tiktok: 'TikTok', youtube: 'YouTube' };

const SUFFIX = '(?:\\s+(?:link|links|url|profile|profiles|account|accounts|handle|handles|channel|page))?';
const SUPPORTED: Array<[RegExp, TextTargetPlatform]> = [
  [new RegExp(`^(?:instagram|insta|ig)${SUFFIX}$`, 'i'), 'instagram'],
  [new RegExp(`^(?:tiktok|tik\\s*tok)${SUFFIX}$`, 'i'), 'tiktok'],
  [new RegExp(`^(?:youtube|you\\s*tube|yt)${SUFFIX}$`, 'i'), 'youtube'],
];
const ALL = new RegExp(`^(?:all|all\\s+platforms|any|any\\s+platform)${SUFFIX}$`, 'i');
const UNSUPPORTED = new RegExp(`^(facebook|fb|twitter|x|linkedin|snapchat|spotify|threads|pinterest|reddit|twitch|soundcloud|bluesky|wikipedia|website)${SUFFIX}$`, 'i');
const GENERIC_PLATFORM_WORD = new RegExp(`^(?:link|links|url|profile|profiles|account|accounts|handle|handles|channel|page|social|socials)$`, 'i');

const LINK_LIKE = /\b(?:link|links|url|profile|profiles|account|accounts|handle|handles|channel|page)$/i;

function classify(part: string): { kind: 'platform'; platform: TextTargetPlatform } | { kind: 'all' } | { kind: 'unsupported'; label: string } | { kind: 'text' } {
  for (const [re, platform] of SUPPORTED) if (re.test(part)) return { kind: 'platform', platform };
  if (ALL.test(part) || GENERIC_PLATFORM_WORD.test(part)) return { kind: 'all' };
  const bad = part.match(UNSUPPORTED);
  if (bad) return { kind: 'unsupported', label: bad[1] };
  return { kind: 'text' };
}

/** Parses "role: name: platform link", "name: platform", or a plain name. */
export function parseTextProfileInput(raw: string): ParsedTextProfileInput {
  const value = raw.replace(/\s+/g, ' ').trim();
  if (!value) return { ok: false, error: 'Enter a person or creator name to search.' };
  if (/^https?:\/\//i.test(value)) return { ok: false, error: 'This looks like a URL. Switch to URL mode to investigate a link.' };
  const parts = value.split(':').map(part => part.trim()).filter(Boolean);
  if (!parts.length) return { ok: false, error: 'Enter a person or creator name to search.' };

  let targetPlatforms: TextTargetPlatform[] | undefined;
  const last = classify(parts[parts.length - 1]);
  if (last.kind === 'unsupported') {
    return { ok: false, error: `${last.label} is not a supported search platform. Text search covers Instagram, TikTok, and YouTube; remove the platform to search all three.` };
  }
  const lastPart = parts[parts.length - 1];
  if (last.kind === 'text' && (parts.length >= 3 || (parts.length === 2 && LINK_LIKE.test(lastPart)))) {
    return { ok: false, error: `"${lastPart}" is not a supported search platform. Text search covers Instagram, TikTok, and YouTube; remove the platform to search all three.` };
  }
  if (last.kind === 'platform' || last.kind === 'all') {
    parts.pop();
    if (last.kind === 'platform') targetPlatforms = [last.platform];
  }
  if (!parts.length) {
    return { ok: false, error: 'Add the person’s name before the platform, for example "cricketer: virat kohli: instagram link".' };
  }
  for (const part of parts) {
    const kind = classify(part).kind;
    if (kind !== 'text') return { ok: false, error: 'Put the platform last, for example "cricketer: virat kohli: instagram link".' };
  }
  const name = parts[parts.length - 1];
  const context = parts.slice(0, -1).join(', ') || undefined;
  if (name.length < 2) return { ok: false, error: 'The name must be at least 2 characters.' };
  const subject = context ? `${name}, ${context}` : name;
  if (subject.length > TEXT_SUBJECT_MAX) return { ok: false, error: `Name and context must be ${TEXT_SUBJECT_MAX} characters or fewer.` };
  return { ok: true, name, context, subject, targetPlatforms };
}
