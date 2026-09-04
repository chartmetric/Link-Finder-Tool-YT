type SerperOrganicResult = {
  title?: string;
  link?: string;
  snippet?: string;
  position?: number;
};

type SerperResponse = {
  organic?: SerperOrganicResult[];
};

type GeminiVerification = {
  profiles?: Array<{
    url?: string;
    verdict?: "official" | "likely" | "uncertain" | "unrelated";
    reason?: string;
  }>;
};

export type ProfileMatch = {
  platform: string;
  category: "social";
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
  "/video/",
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

async function verifyWithGeminiOnline(input: {
  musician: string;
  profiles: ProfileMatch[];
  apiKey: string;
}): Promise<ProfileMatch[]> {
  if (input.profiles.length === 0) return input.profiles;

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "google/gemini-3.5-flash:online",
      max_tokens: 8192,
      temperature: 0,
      messages: [
        {
          role: "system",
          content:
            "You verify musician profiles using live web research. Return only valid JSON. Never invent URLs.",
        },
        {
          role: "user",
          content: JSON.stringify({
            task:
              "For each candidate, decide whether it belongs to the named musician. Use current online evidence. Return {profiles:[{url,verdict,reason}]}; verdict must be official, likely, uncertain, or unrelated.",
            musician: input.musician,
            candidates: input.profiles.slice(0, 15).map(({ url, title, snippet, platform }) => ({
              url,
              title,
              snippet,
              platform,
            })),
          }),
        },
      ],
    }),
    signal: AbortSignal.timeout(25_000),
  });

  if (!response.ok) {
    throw new Error(`OpenRouter verification failed (${response.status})`);
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const raw = payload.choices?.[0]?.message?.content ?? "";
  const jsonText = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const verification = JSON.parse(jsonText) as GeminiVerification;
  const byUrl = new Map(
    (verification.profiles ?? [])
      .filter((item) => item.url && item.verdict)
      .map((item) => [item.url!, item]),
  );

  return input.profiles
    .map((profile) => {
      const check = byUrl.get(profile.url);
      if (!check) return profile;
      const adjustment =
        check.verdict === "official"
          ? 12
          : check.verdict === "likely"
            ? 6
            : check.verdict === "unrelated"
              ? -45
              : -8;
      const label =
        check.verdict === "official"
          ? "Gemini verified official"
          : check.verdict === "likely"
            ? "Gemini found supporting evidence"
            : check.verdict === "unrelated"
              ? "Gemini flagged unrelated"
              : "Gemini verification inconclusive";
      return {
        ...profile,
        confidence: Math.max(5, Math.min(99, profile.confidence + adjustment)),
        signals: [...profile.signals, label, ...(check.reason ? [check.reason.slice(0, 120)] : [])],
      };
    })
    .sort((a, b) => b.confidence - a.confidence);
}

export async function findMusicianProfiles(input: {
  musician: string;
  location?: string;
  country?: string;
  apiKey: string;
  openrouterApiKey?: string;
}) {
  const locationHint = input.location?.trim() ? ` ${input.location.trim()}` : "";
  const targets = ["Instagram", "TikTok", "YouTube"];
  const queries = targets.map(
    (platform) => `${input.musician.trim()} musician${locationHint} official ${platform}`,
  );
  const searches = await Promise.all(
    queries.map(async (q) => {
      const response = await fetch("https://google.serper.dev/search", {
        method: "POST",
        headers: {
          "X-API-KEY": input.apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          q,
          gl: (input.country ?? "us").toLowerCase(),
          num: 10,
          autocorrect: false,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        const detail = await response.text();
        throw new Error(`Serper request failed (${response.status}): ${detail.slice(0, 180)}`);
      }
      return (await response.json()) as SerperResponse;
    }),
  );
  const organic = searches.flatMap((search) => search.organic ?? []);
  const query = queries.join(" | ");
  const sources = organic
    .filter((result) => result.link)
    .map((result) => ({
      title: result.title ?? "Untitled result",
      url: result.link!,
      snippet: result.snippet ?? "",
    }));

  const seen = new Set<string>();
  let profiles = organic
    .flatMap((result): ProfileMatch[] => {
      if (!result.link) return [];
      try {
        const url = new URL(result.link);
        const recognized = classifyUrl(url);
        if (!recognized) return [];
        const normalizedUrl = `${url.origin}${url.pathname}`.replace(/\/$/, "");
        if (seen.has(normalizedUrl)) return [];
        seen.add(normalizedUrl);

        const ranked = rankResult(result, input.musician, url, recognized);
        return [{
          platform: recognized.name,
          category: "social",
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
    .sort((a, b) => b.confidence - a.confidence)
    .filter(
      (profile, index, all) =>
        index < 15 &&
        all.filter((item) => item.platform === profile.platform).indexOf(profile) < 5,
    );

  if (input.openrouterApiKey) {
    profiles = await verifyWithGeminiOnline({
      musician: input.musician,
      profiles,
      apiKey: input.openrouterApiKey,
    });
  }
  profiles = targets
    .map((platform) => profiles.find((profile) => profile.platform === platform))
    .filter((profile): profile is ProfileMatch => Boolean(profile));

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