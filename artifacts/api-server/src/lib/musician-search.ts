type SerperOrganicResult = {
  title?: string;
  link?: string;
  snippet?: string;
  position?: number;
};

type SerperResponse = {
  organic?: SerperOrganicResult[];
};

export type ProfileMatch = {
  platform: string;
  category: "social" | "streaming" | "music" | "website";
  title: string;
  url: string;
  displayUrl: string;
  snippet: string;
  confidence: number;
  signals: string[];
};

const platforms = [
  { host: "instagram.com", name: "Instagram", category: "social" },
  { host: "tiktok.com", name: "TikTok", category: "social" },
  { host: "youtube.com", name: "YouTube", category: "social" },
  { host: "youtu.be", name: "YouTube", category: "social" },
  { host: "x.com", name: "X", category: "social" },
  { host: "twitter.com", name: "X", category: "social" },
  { host: "facebook.com", name: "Facebook", category: "social" },
  { host: "threads.net", name: "Threads", category: "social" },
  { host: "spotify.com", name: "Spotify", category: "streaming" },
  { host: "music.apple.com", name: "Apple Music", category: "streaming" },
  { host: "soundcloud.com", name: "SoundCloud", category: "music" },
  { host: "bandcamp.com", name: "Bandcamp", category: "music" },
  { host: "linktr.ee", name: "Linktree", category: "website" },
  { host: "beacons.ai", name: "Beacons", category: "website" },
] as const;

const excludedPaths = [
  "/explore",
  "/search",
  "/hashtag",
  "/playlist",
  "/watch",
  "/shorts",
  "/reel",
  "/p/",
  "/status/",
  "/posts/",
];

function normalizeWords(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 1);
}

function classifyUrl(url: URL) {
  return platforms.find(
    (item) => url.hostname === item.host || url.hostname.endsWith(`.${item.host}`),
  );
}

function rankResult(
  result: SerperOrganicResult,
  musician: string,
  url: URL,
  recognized: ReturnType<typeof classifyUrl>,
): { confidence: number; signals: string[] } {
  const signals: string[] = [];
  const words = normalizeWords(musician);
  const haystack = `${result.title ?? ""} ${result.snippet ?? ""} ${url.pathname}`.toLowerCase();
  const matchedWords = words.filter((word) => haystack.includes(word));
  let score = recognized ? 48 : 28;

  if (matchedWords.length === words.length && words.length > 0) {
    score += 28;
    signals.push("Artist name matches");
  } else if (matchedWords.length > 0) {
    score += 14;
    signals.push("Partial name match");
  }
  if (/\bofficial\b/i.test(haystack)) {
    score += 13;
    signals.push("Marked official");
  }
  if ((result.position ?? 20) <= 5) {
    score += 7;
    signals.push("Top Google result");
  }
  if (recognized) signals.push(`Recognized ${recognized.name} domain`);
  if (excludedPaths.some((path) => url.pathname.toLowerCase().includes(path))) {
    score -= 24;
  }

  return { confidence: Math.max(20, Math.min(99, score)), signals };
}

export async function findMusicianProfiles(input: {
  musician: string;
  location?: string;
  country?: string;
  apiKey: string;
}) {
  const locationHint = input.location?.trim() ? ` ${input.location.trim()}` : "";
  const query =
    `"${input.musician.trim()}" musician${locationHint} official ` +
    "(Instagram OR TikTok OR YouTube OR Spotify OR SoundCloud OR Bandcamp OR Facebook OR Twitter)";

  const response = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "X-API-KEY": input.apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      q: query,
      gl: (input.country ?? "us").toLowerCase(),
      num: 30,
      autocorrect: false,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Serper request failed (${response.status}): ${detail.slice(0, 180)}`);
  }

  const data = (await response.json()) as SerperResponse;
  const sources = (data.organic ?? [])
    .filter((result) => result.link)
    .map((result) => ({
      title: result.title ?? "Untitled result",
      url: result.link!,
      snippet: result.snippet ?? "",
    }));

  const seen = new Set<string>();
  const profiles = (data.organic ?? [])
    .flatMap((result): ProfileMatch[] => {
      if (!result.link) return [];
      try {
        const url = new URL(result.link);
        const recognized = classifyUrl(url);
        if (!recognized && !/\b(official|musician|artist|music)\b/i.test(`${result.title} ${result.snippet}`)) {
          return [];
        }
        const normalizedUrl = `${url.origin}${url.pathname}`.replace(/\/$/, "");
        if (seen.has(normalizedUrl)) return [];
        seen.add(normalizedUrl);

        const ranked = rankResult(result, input.musician, url, recognized);
        return [{
          platform: recognized?.name ?? "Official website",
          category: recognized?.category ?? "website",
          title: result.title ?? `${input.musician} profile`,
          url: result.link,
          displayUrl: `${url.hostname.replace(/^www\./, "")}${url.pathname}`.replace(/\/$/, ""),
          snippet: result.snippet ?? "",
          confidence: ranked.confidence,
          signals: ranked.signals,
        }];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.confidence - a.confidence);

  return {
    musician: input.musician.trim(),
    query,
    searchedAt: new Date().toISOString(),
    profiles,
    sources,
    totalFound: profiles.length,
    highConfidenceCount: profiles.filter((profile) => profile.confidence >= 80).length,
  };
}