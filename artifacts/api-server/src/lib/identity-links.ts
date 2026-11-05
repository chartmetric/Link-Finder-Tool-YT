type LinkMetadata = { url: string; urlAliases?: string[]; bio?: string; externalUrls?: string[] };

/** Preserve provider-returned destinations, not redirect-wrapper guesses. */
export function externalProfileUrls(user: { external_url?: unknown; bio_links?: unknown }): string[] {
  const links = Array.isArray(user.bio_links) ? user.bio_links : [];
  return [...new Set([user.external_url, ...links.map(link => link?.url)].flatMap(value => {
    if (typeof value !== "string") return [];
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password && !url.port ? [url.href] : [];
    } catch { return []; }
  }))];
}

export function canonicalIdentityUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return undefined;
    const host = url.hostname.replace(/^(www|m)\./, "");
    const path = url.pathname.replace(/\/+$/, "");
    if (host === "open.spotify.com" && /^\/artist\/[A-Za-z0-9]{22}$/.test(path)) return `https://${host}${path}`;
    if (["youtube.com", "music.youtube.com"].includes(host)
      && /^\/(channel\/UC[\w-]{22}|@[\w.-]+)$/.test(path)) {
      return `https://www.youtube.com${path.startsWith("/@") ? path.toLowerCase() : path}`;
    }
    if (host === "instagram.com" && /^\/[a-z0-9._]{1,30}$/i.test(path)
      && !/^\/(p|reels?|stories|explore|accounts|direct|tv|about)$/i.test(path)) {
      return `https://www.instagram.com${path.toLowerCase()}/`;
    }
    if (host === "tiktok.com" && /^\/@[\w.]+$/.test(path)) return `https://www.tiktok.com${path.toLowerCase()}`;
    return undefined;
  } catch { return undefined; }
}

export function hasExactIdentityCrossLink(reference: LinkMetadata, candidate: LinkMetadata): boolean {
  const ownUrls = (metadata: LinkMetadata) => new Set([metadata.url, ...(metadata.urlAliases ?? [])]
    .map(canonicalIdentityUrl).filter((url): url is string => !!url));
  const destinations = (metadata: LinkMetadata) => [
    ...(metadata.externalUrls ?? []),
    ...(metadata.bio?.match(/https:\/\/[^\s<>"']+/g) ?? []).map(value => value.replace(/[),;]+$/, "")),
  ].map(canonicalIdentityUrl).filter((url): url is string => !!url);
  return destinations(reference).some(url => ownUrls(candidate).has(url))
    || destinations(candidate).some(url => ownUrls(reference).has(url));
}
