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
    platform?: string;
    title?: string;
    verdict?: "official" | "likely" | "uncertain" | "unrelated";
    reason?: string;
  }>;
};

type GeminiDiscovery = {
  profiles?: Array<{
    platform?: string;
    url?: string;
    title?: string;
    snippet?: string;
    confidence?: number;
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
  methods: string[];
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
  "/tag/",
  "/playlist",
  "/watch",
  "/shorts",
  "/reel",
  "/p/",
  "/video/",
  "/status/",
  "/posts/",
];

function parseJsonObject<T>(raw: string): T {
  const withoutFence = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const start = withoutFence.indexOf("{");
  const end = withoutFence.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("Verifier returned no JSON object");
  return JSON.parse(withoutFence.slice(start, end + 1)) as T;
}

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
  subject: string,
  url: URL,
  recognized: ReturnType<typeof classifyUrl>,
): { confidence: number; signals: string[] } {
  const signals: string[] = [];
  const words = normalizeWords(subject);
  const haystack = `${result.title ?? ""} ${result.snippet ?? ""} ${url.pathname}`.toLowerCase();
  const matchedWords = words.filter((word) => haystack.includes(word));
  let score = recognized ? 48 : 28;

  if (matchedWords.length === words.length && words.length > 0) {
    score += 28;
    signals.push("Name matches");
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

async function verifyWithOnlineModel(input: {
  subject: string;
  profiles: ProfileMatch[];
  apiKey: string;
  method: "gemini" | "deepseek";
  model: string;
}): Promise<ProfileMatch[]> {
  if (input.profiles.length === 0) return input.profiles;

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: input.model,
      max_tokens: 8192,
      temperature: 0,
      tools: [{
        type: "openrouter:web_search",
        parameters: {
          engine: "exa",
          mode: "auto",
          max_uses: 1,
          max_total_results: 10,
        },
      }],
      messages: [
        {
          role: "system",
          content:
            `You are the ${input.method === "gemini" ? "Gemini" : "DeepSeek"} independent verifier for public profiles. Use live web research. Return only valid JSON. Never invent URLs.`,
        },
        {
          role: "user",
          content: JSON.stringify({
            task:
              "For each candidate, decide whether it belongs to the named subject. The subject may be a person, creator, athlete, team, company, or brand. Use current online evidence. If the official Instagram, TikTok, or YouTube profile is missing from the candidates, add its correct URL. Return {profiles:[{platform,url,title,verdict,reason}]}; verdict must be official, likely, uncertain, or unrelated.",
            subject: input.subject,
            candidates: input.profiles
              .slice(0, input.method === "deepseek" ? 8 : 15)
              .map(({ url, title, snippet, platform }) => ({
              url,
              title,
              snippet,
              platform,
              })),
          }),
        },
      ],
    }),
    signal: AbortSignal.timeout(input.method === "deepseek" ? 75_000 : 25_000),
  });

  if (!response.ok) {
    throw new Error(`OpenRouter verification failed (${response.status})`);
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const raw = payload.choices?.[0]?.message?.content ?? "";
  const verification = parseJsonObject<GeminiVerification>(raw);
  const byUrl = new Map(
    (verification.profiles ?? [])
      .filter((item) => item.url && item.verdict)
      .map((item) => [item.url!, item]),
  );

  const ranked = input.profiles
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
          ? `${input.method === "gemini" ? "Gemini" : "DeepSeek"} verified official`
          : check.verdict === "likely"
            ? `${input.method === "gemini" ? "Gemini" : "DeepSeek"} found supporting evidence`
            : check.verdict === "unrelated"
              ? `${input.method === "gemini" ? "Gemini" : "DeepSeek"} flagged unrelated`
              : `${input.method === "gemini" ? "Gemini" : "DeepSeek"} verification inconclusive`;
      return {
        ...profile,
        confidence: Math.max(5, Math.min(99, profile.confidence + adjustment)),
        signals: [...profile.signals, label, ...(check.reason ? [check.reason.slice(0, 120)] : [])],
        methods: [...new Set([...profile.methods, input.method])],
      };
    })
    .sort((a, b) => b.confidence - a.confidence);
  const existingUrls = new Set(input.profiles.map((profile) => profile.url));
  const additions = (verification.profiles ?? []).flatMap((item): ProfileMatch[] => {
    if (!item.url || existingUrls.has(item.url) || !["official", "likely"].includes(item.verdict ?? "")) {
      return [];
    }
    try {
      const url = new URL(item.url);
      const recognized = classifyUrl(url);
      if (!recognized) return [];
      return [{
        platform: recognized.name,
        category: "social",
        title: item.title ?? `${input.subject} on ${recognized.name}`,
        url: item.url,
        displayUrl: `${url.hostname.replace(/^www\./, "")}${url.pathname}`.replace(/\/$/, ""),
        snippet: item.reason ?? "Official profile found by Gemini online research.",
        confidence: item.verdict === "official" ? 92 : 78,
        signals: [item.verdict === "official"
          ? `${input.method === "gemini" ? "Gemini" : "DeepSeek"} verified official`
          : `${input.method === "gemini" ? "Gemini" : "DeepSeek"} found supporting evidence`],
        methods: [input.method],
      }];
    } catch {
      return [];
    }
  });
  return [...ranked, ...additions].sort((a, b) => b.confidence - a.confidence);
}

async function discoverWithGeminiOnline(input: {
  subject: string;
  location?: string;
  apiKey: string;
}): Promise<ProfileMatch[]> {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${input.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "google/gemini-3.5-flash",
      max_tokens: 8192,
      temperature: 0,
      tools: [{
        type: "openrouter:web_search",
        parameters: { engine: "exa", mode: "auto", max_uses: 1, max_total_results: 10 },
      }],
      messages: [{
        role: "user",
        content: `Use live web search to find the official Instagram, TikTok, and YouTube profile URLs for ${input.subject}${input.location ? ` in ${input.location}` : ""}. Return only JSON: {"profiles":[{"platform":"Instagram|TikTok|YouTube","url":"https://...","title":"...","snippet":"evidence","confidence":0-100}]}. Omit platforms you cannot verify.`,
      }],
    }),
    signal: AbortSignal.timeout(25_000),
  });
  if (!response.ok) throw new Error(`OpenRouter discovery failed (${response.status})`);
  const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const raw = payload.choices?.[0]?.message?.content ?? "";
  const parsed = parseJsonObject<GeminiDiscovery>(raw);
  return (parsed.profiles ?? []).flatMap((item): ProfileMatch[] => {
    if (!item.url || !targetsForPlatform(item.platform)) return [];
    try {
      const url = new URL(item.url);
      const platform = targetsForPlatform(item.platform)!;
      return [{
        platform,
        category: "social",
        title: item.title ?? `${input.subject} on ${platform}`,
        url: item.url,
        displayUrl: `${url.hostname.replace(/^www\./, "")}${url.pathname}`.replace(/\/$/, ""),
        snippet: item.snippet ?? "Found through Gemini online research.",
        confidence: Math.max(20, Math.min(99, item.confidence ?? 75)),
        signals: ["Gemini online discovery"],
        methods: ["gemini"],
      }];
    } catch {
      return [];
    }
  });
}

function targetsForPlatform(value?: string) {
  const normalized = value?.toLowerCase();
  if (normalized === "instagram") return "Instagram";
  if (normalized === "tiktok") return "TikTok";
  if (normalized === "youtube") return "YouTube";
  return undefined;
}

export async function findProfiles(input: {
  subject?: string;
  handle?: string;
  handlePlatform?: "instagram" | "tiktok" | "youtube" | "x" | "twitter" | "facebook";
  location?: string;
  country?: string;
  methods?: string[];
  serperApiKey?: string;
  tavilyApiKey?: string;
  openrouterApiKey?: string;
  scrapeCreatorsApiKey?: string;
  socialCrawlApiKey?: string;
}) {
  const cleanHandle = input.handle?.trim().replace(/^@/, "");
  const subject = input.subject?.trim() || (cleanHandle ? `@${cleanHandle}` : "");
  const locationHint = input.location?.trim() ? ` ${input.location.trim()}` : "";
  const targets = ["Instagram", "TikTok", "YouTube"];
  const selected = input.methods?.length
    ? input.methods
    : ["serper", "tavily", "gemini", "scrapecreators", "socialcrawl"];
  const queries = targets.map(
    (platform) => `${subject}${locationHint} official ${platform}`,
  );
  const methodMeta = {
    serper: { label: "Serper", estimatedCostUsd: 0.003, costNote: "3 queries at roughly $1 per 1,000 queries" },
    tavily: { label: "Tavily", estimatedCostUsd: 0.024, costNote: "3 basic searches at roughly $0.008 per credit" },
    gemini: { label: "Gemini Verification", estimatedCostUsd: 0.01, costNote: "Automatic separate verification pass; web search and token charges vary" },
    deepseek: { label: "DeepSeek Verification", estimatedCostUsd: 0.008, costNote: "Automatic independent pass using V4 Flash 0731, capped Exa search, and token usage" },
    scrapecreators: { label: "ScrapeCreators", estimatedCostUsd: 0, costNote: "0 cached or 10 live credits; dollar cost depends on your credit pack" },
    socialcrawl: { label: "SocialCrawl", estimatedCostUsd: 0, costNote: "3 credits for Instagram, TikTok, and YouTube searches; dollar cost depends on your credit pack" },
  } as const;
  const methodKeys = ["serper", "tavily", "gemini", "deepseek", "scrapecreators", "socialcrawl"] as const;
  const statuses = new Map<string, "used" | "unavailable" | "failed">();
  let scrapeCreatorsCreditsCharged: number | undefined;
  let socialCrawlCreditsCharged: number | undefined;
  const organic: Array<SerperOrganicResult & { method: string }> = [];

  const runSearches = async (
    method: string,
    runner: (query: string) => Promise<SerperOrganicResult[]>,
  ) => {
    try {
      const results = await Promise.all(queries.map(runner));
      organic.push(...results.flat().map((result) => ({ ...result, method })));
      statuses.set(method, "used");
    } catch {
      statuses.set(method, "failed");
    }
  };

  const runScrapeCreators = async () => {
    if (!input.scrapeCreatorsApiKey || !cleanHandle || !input.handlePlatform) {
      statuses.set("scrapecreators", "unavailable");
      return;
    }
    try {
      const params = new URLSearchParams({
        platform: input.handlePlatform,
        handle: cleanHandle,
        cache_max_age: "7d",
      });
      const response = await fetch(`https://api.scrapecreators.com/v1/find-social-profiles?${params}`, {
        headers: { "x-api-key": input.scrapeCreatorsApiKey },
        signal: AbortSignal.timeout(45_000),
      });
      if (!response.ok) throw new Error(`ScrapeCreators failed (${response.status})`);
      const data = (await response.json()) as {
        credits_charged?: number;
        profiles?: Array<{
          platform?: string;
          handle?: string;
          url?: string;
          confidence?: number;
          evidence?: string[];
        }>;
      };
      scrapeCreatorsCreditsCharged = data.credits_charged;
      organic.push(...(data.profiles ?? []).flatMap((profile): Array<SerperOrganicResult & { method: string }> => {
        const platform = targetsForPlatform(profile.platform);
        if (!profile.url || !platform) return [];
        return [{
          title: `${profile.handle ? `@${profile.handle}` : subject} on ${platform}`,
          link: profile.url,
          snippet: `ScrapeCreators evidence: ${(profile.evidence ?? []).join(", ") || "linked social profile"}`,
          position: (profile.confidence ?? 0) >= 0.9 ? 1 : 6,
          method: "scrapecreators",
        }];
      }));
      statuses.set("scrapecreators", "used");
    } catch {
      statuses.set("scrapecreators", "failed");
    }
  };

  const runSocialCrawl = async () => {
    if (!input.socialCrawlApiKey) {
      statuses.set("socialcrawl", "unavailable");
      return;
    }
    const endpoints = [
      { platform: "Instagram", path: "/instagram/search/profiles" },
      { platform: "TikTok", path: "/tiktok/search/users" },
      { platform: "YouTube", path: "/youtube/search" },
    ] as const;
    try {
      const responses = await Promise.all(endpoints.map(async ({ platform, path }) => {
        const params = new URLSearchParams({ query: subject });
        const response = await fetch(`https://www.socialcrawl.dev/v1${path}?${params}`, {
          headers: { "x-api-key": input.socialCrawlApiKey! },
          signal: AbortSignal.timeout(35_000),
        });
        if (!response.ok) throw new Error(`SocialCrawl ${platform} failed (${response.status})`);
        const data = (await response.json()) as {
          credits_used?: number;
          data?: {
            items?: Array<{
              author?: {
                username?: string | null;
                display_name?: string | null;
                bio?: string | null;
                verified?: boolean | null;
                followers?: number | null;
                url?: string | null;
              };
              post?: {
                author?: {
                  username?: string | null;
                  display_name?: string | null;
                  bio?: string | null;
                  verified?: boolean | null;
                  followers?: number | null;
                  url?: string | null;
                };
                ext?: { channel_id?: string | null };
              };
            }>;
          };
        };
        return { platform, data };
      }));
      socialCrawlCreditsCharged = responses.reduce(
        (sum, response) => sum + (response.data.credits_used ?? 0),
        0,
      );
      for (const { platform, data } of responses) {
        for (const item of data.data?.items ?? []) {
          const author = item.author ?? item.post?.author;
          const username = author?.username?.replace(/^@/, "");
          const channelId = item.post?.ext?.channel_id;
          const url = author?.url
            ?? (platform === "Instagram" && username ? `https://www.instagram.com/${username}` : undefined)
            ?? (platform === "TikTok" && username ? `https://www.tiktok.com/@${username}` : undefined)
            ?? (platform === "YouTube" && username ? `https://www.youtube.com/@${username}` : undefined)
            ?? (platform === "YouTube" && channelId ? `https://www.youtube.com/channel/${channelId}` : undefined);
          if (!url) continue;
          organic.push({
            title: `${author?.display_name ?? username ?? subject} on ${platform}`,
            link: url,
            snippet: [
              author?.bio,
              author?.verified ? "Verified profile" : undefined,
              author?.followers ? `${author.followers.toLocaleString()} followers` : undefined,
            ].filter(Boolean).join(" · "),
            position: author?.verified ? 1 : 5,
            method: "socialcrawl",
          });
        }
      }
      statuses.set("socialcrawl", "used");
    } catch {
      statuses.set("socialcrawl", "failed");
    }
  };

  await Promise.all([
    selected.includes("serper")
      ? input.serperApiKey
        ? runSearches("serper", async (q) => {
            const response = await fetch("https://google.serper.dev/search", {
              method: "POST",
              headers: { "X-API-KEY": input.serperApiKey!, "Content-Type": "application/json" },
              body: JSON.stringify({ q, gl: (input.country ?? "us").toLowerCase(), num: 10, autocorrect: false }),
              signal: AbortSignal.timeout(15_000),
            });
            if (!response.ok) throw new Error(`Serper failed (${response.status})`);
            return ((await response.json()) as SerperResponse).organic ?? [];
          })
        : Promise.resolve(statuses.set("serper", "unavailable"))
      : Promise.resolve(),
    selected.includes("tavily")
      ? input.tavilyApiKey
        ? runSearches("tavily", async (q) => {
            const response = await fetch("https://api.tavily.com/search", {
              method: "POST",
              headers: { Authorization: `Bearer ${input.tavilyApiKey}`, "Content-Type": "application/json" },
              body: JSON.stringify({ query: q, search_depth: "basic", max_results: 10, include_answer: false }),
              signal: AbortSignal.timeout(20_000),
            });
            if (!response.ok) throw new Error(`Tavily failed (${response.status})`);
            const data = (await response.json()) as { results?: Array<{ title?: string; url?: string; content?: string }> };
            return (data.results ?? []).map((item, position) => ({
              title: item.title, link: item.url, snippet: item.content, position: position + 1,
            }));
          })
        : Promise.resolve(statuses.set("tavily", "unavailable"))
      : Promise.resolve(),
    selected.includes("scrapecreators")
      ? runScrapeCreators()
      : Promise.resolve(),
    selected.includes("socialcrawl")
      ? runSocialCrawl()
      : Promise.resolve(),
  ]);

  const query = queries.join(" | ");
  const sources = organic
    .filter((result) => result.link)
    .map((result) => ({
      title: result.title ?? "Untitled result",
      url: result.link!,
      snippet: result.snippet ?? "",
    }));

  let profiles = organic
    .flatMap((result): ProfileMatch[] => {
      if (!result.link) return [];
      try {
        const url = new URL(result.link);
        const recognized = classifyUrl(url);
        if (!recognized) return [];
        const ranked = rankResult(result, subject, url, recognized);
        return [{
          platform: recognized.name,
          category: "social",
          title: result.title ?? `${subject} profile`,
          url: result.link,
          displayUrl: `${url.hostname.replace(/^www\./, "")}${url.pathname}`.replace(/\/$/, ""),
          snippet: result.snippet ?? "",
          confidence: ranked.confidence,
          signals: [...ranked.signals, `Found by ${methodMeta[result.method as keyof typeof methodMeta].label}`],
          methods: [result.method],
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

  if (input.openrouterApiKey && profiles.length > 0) {
    try {
      profiles = await verifyWithOnlineModel({
        subject,
        profiles,
        apiKey: input.openrouterApiKey,
        method: "gemini",
        model: "google/gemini-3.5-flash",
      });
      statuses.set("gemini", "used");
    } catch {
      statuses.set("gemini", "failed");
    }
  } else if (selected.includes("gemini") && input.openrouterApiKey) {
    try {
      profiles = await discoverWithGeminiOnline({
        subject,
        location: input.location,
        apiKey: input.openrouterApiKey,
      });
      statuses.set("gemini", "used");
    } catch {
      statuses.set("gemini", "failed");
    }
  } else {
    statuses.set("gemini", "unavailable");
  }

  if (input.openrouterApiKey && profiles.length > 0) {
    try {
      profiles = await verifyWithOnlineModel({
        subject,
        profiles,
        apiKey: input.openrouterApiKey,
        method: "deepseek",
        model: "deepseek/deepseek-v4-flash-0731",
      });
      statuses.set("deepseek", "used");
    } catch {
      statuses.set("deepseek", "failed");
    }
  } else {
    statuses.set("deepseek", "unavailable");
  }

  const merged = new Map<string, ProfileMatch>();
  for (const profile of profiles) {
    const key = `${profile.platform}:${new URL(profile.url).pathname.replace(/\/$/, "").toLowerCase()}`;
    const prior = merged.get(key);
    if (!prior) merged.set(key, profile);
    else merged.set(key, {
      ...prior,
      confidence: Math.min(99, Math.max(prior.confidence, profile.confidence) + 5),
      methods: [...new Set([...prior.methods, ...profile.methods])],
      signals: [...new Set([...prior.signals, ...profile.signals, "Confirmed by multiple methods"])],
    });
  }
  profiles = [...merged.values()].sort(
    (a, b) => b.confidence - a.confidence || b.methods.length - a.methods.length,
  );
  profiles = targets
    .map((platform) => profiles.find((profile) => profile.platform === platform))
    .filter((profile): profile is ProfileMatch => Boolean(profile));

  const methodsUsed = methodKeys
    .filter((method) => selected.includes(method) || method === "gemini" || method === "deepseek")
    .map((method) => ({
      method,
      ...methodMeta[method],
      ...(method === "scrapecreators" && scrapeCreatorsCreditsCharged !== undefined
        ? { costNote: `${scrapeCreatorsCreditsCharged} credits charged for this request` }
        : {}),
      ...(method === "socialcrawl" && socialCrawlCreditsCharged !== undefined
        ? { costNote: `${socialCrawlCreditsCharged} credits charged for this request` }
        : {}),
      status: statuses.get(method) ?? "failed",
    }));

  return {
    subject,
    query,
    searchedAt: new Date().toISOString(),
    profiles,
    sources,
    totalFound: profiles.length,
    highConfidenceCount: profiles.filter((profile) => profile.confidence >= 80).length,
    methodsUsed,
    estimatedCostUsd: methodsUsed
      .filter((method) => method.status === "used")
      .reduce((sum, method) => sum + method.estimatedCostUsd, 0),
  };
}