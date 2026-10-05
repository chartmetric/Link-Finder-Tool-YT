import type { ProfileMatch } from "./musician-search";

type ChannelMetadata = { channelId?: string; handle: string; url: string };

function youtubeProfile(url: string) {
  try {
    const parsed = new URL(url);
    if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password
      || !["youtube.com", "www.youtube.com", "m.youtube.com"].includes(parsed.hostname)) return undefined;
    const path = decodeURIComponent(parsed.pathname).replace(/\/$/, "");
    if (/^\/channel\/UC[\w-]{22}$/.test(path)) return { channelId: path.slice(9) };
    if (/^\/@[^/?#\s]+$/.test(path)) return { handle: path.slice(2) };
  } catch { /* Invalid or non-profile URLs cannot establish equivalence. */ }
  return undefined;
}

/** Only provider-resolved, matching channel IDs establish URL equivalence. */
export function youtubeAliases(url: string, metadata: ChannelMetadata | undefined) {
  const requested = youtubeProfile(url);
  if (!requested || !metadata?.channelId || !/^UC[\w-]{22}$/.test(metadata.channelId)) return undefined;
  if (requested.channelId && requested.channelId !== metadata.channelId) return undefined;
  const canonical = youtubeProfile(metadata.url);
  if (canonical?.channelId && canonical.channelId !== metadata.channelId) return undefined;
  const metadataHandle = metadata.handle.replace(/^@/, "");
  const handle = canonical?.handle
    ?? (metadataHandle && metadataHandle !== metadata.channelId ? metadataHandle : undefined);
  if (requested.handle && (!handle || requested.handle.toLowerCase() !== handle.toLowerCase())) return undefined;
  // Never manufacture a handle from a channel ID or accept contradictory metadata.
  if (canonical?.handle && metadataHandle && metadataHandle !== metadata.channelId
    && canonical.handle.toLowerCase() !== metadataHandle.toLowerCase()) return undefined;
  if (handle && !youtubeProfile(`https://www.youtube.com/@${handle}`)) return undefined;
  const urlAliases = [...new Set([
    url,
    ...(handle ? [`https://www.youtube.com/@${handle}`] : []),
    `https://www.youtube.com/channel/${metadata.channelId}`,
  ])];
  return { channelId: metadata.channelId, urlAliases };
}

export function groupYouTubeAliases(profiles: ProfileMatch[]): ProfileMatch[] {
  const grouped = new Map<string, ProfileMatch>();
  for (const profile of profiles) {
    if (profile.platform.toLowerCase() !== "youtube" || !profile.channelId || !profile.urlAliases?.length) {
      grouped.set(`url:${profile.platform}:${profile.url}`, profile);
      continue;
    }
    const key = `youtube:${profile.channelId}`; // Channel IDs are case-sensitive.
    const prior = grouped.get(key);
    if (!prior) { grouped.set(key, profile); continue; }
    const preferred = profile.identityComparison && !prior.identityComparison
      ? profile : prior.identityComparison && !profile.identityComparison
        ? prior : profile.confidence > prior.confidence ? profile : prior;
    const merged = {
      ...preferred,
      confidence: Math.max(prior.confidence, profile.confidence),
      methods: [...new Set([...prior.methods, ...profile.methods])],
      signals: [...new Set([...prior.signals, ...profile.signals])],
      urlAliases: [...new Set([...prior.urlAliases!, ...profile.urlAliases])],
    };
    if (merged.identityComparison) delete merged.identityVerificationNote;
    grouped.set(key, merged);
  }
  return [...grouped.values()];
}
