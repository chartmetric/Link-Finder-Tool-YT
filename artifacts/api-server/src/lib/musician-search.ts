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
  identityComparison?: {
    status: "likely" | "uncertain" | "mismatch";
    score: number;
    reasons: string[];
    reference: IdentityMetadata;
    candidate: IdentityMetadata;
  };
  identityVerificationNote?: string;
  jevVerification?: {
    verdict: "verified" | "likely" | "uncertain" | "mismatch";
    sameIdentityProbability: number;
    verdictConfidence: number;
    probabilities: Record<string, number>;
  };
};

type IdentityMetadata = {
  platform: string;
  handle: string;
  displayName?: string;
  bio?: string;
  imageUrl?: string;
  url: string;
  followers?: number;
  verified?: boolean;
  channelId?: string;
};

const socialPlatformDefinitions = [
  {
    key: "instagram",
    name: "Instagram",
    aliases: ["instagram"],
    scrapeCreatorsProfilePath: "/instagram/profile",
  },
  {
    key: "tiktok",
    name: "TikTok",
    aliases: ["tiktok"],
    scrapeCreatorsProfilePath: "/tiktok/profile",
  },
  {
    key: "youtube",
    name: "YouTube",
    aliases: ["youtube"],
    scrapeCreatorsProfilePath: "/youtube/channel",
  },
] as const;

type DiscoveryPlatform = typeof socialPlatformDefinitions[number]["name"];

function platformDefinition(value?: string) {
  const normalized = value?.toLowerCase();
  return socialPlatformDefinitions.find((platform) =>
    platform.key === normalized
    || platform.name.toLowerCase() === normalized
    || platform.aliases.some((alias) => alias === normalized),
  );
}

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
      max_tokens: 700,
      temperature: 0,
      ...(input.method === "deepseek"
        ? { response_format: { type: "json_object" } }
        : {}),
      ...(input.method === "gemini"
        ? {
            tools: [{
              type: "openrouter:web_search",
              parameters: {
                engine: "exa",
                mode: "auto",
                max_uses: 1,
                max_total_results: 10,
              },
            }],
          }
        : {}),
      messages: [
        {
          role: "system",
          content:
            `You are the ${input.method === "gemini" ? "Gemini live-web" : "DeepSeek independent"} verifier for public profiles. ${input.method === "gemini" ? "Use live web research." : "Assess the supplied search evidence independently."} Return only valid JSON. Never invent URLs.`,
        },
        {
          role: "user",
          content: JSON.stringify({
            task:
              "For each candidate, decide whether it belongs to the named subject. The subject may be a person, creator, athlete, team, company, or brand. Use current online evidence. If the official Instagram, TikTok, or YouTube profile is missing from the candidates, add its correct URL. Return {profiles:[{platform,url,title,verdict,reason}]}; verdict must be official, likely, uncertain, or unrelated.",
            subject: input.subject,
            candidates: [...new Map(input.profiles.map((profile) => [profile.url, profile])).values()]
              .slice(0, 6)
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
      signal: AbortSignal.timeout(20_000),
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
  targets: DiscoveryPlatform[];
  location?: string;
  handle?: string;
  handlePlatform?: string;
  knownProfileUrl?: string;
  apiKey: string;
}): Promise<ProfileMatch[]> {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${input.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "google/gemini-3.5-flash-lite",
      max_tokens: 1200,
      temperature: 0,
      tools: [{
        type: "openrouter:web_search",
        parameters: { engine: "exa", mode: "auto", max_uses: 1, max_total_results: 10 },
      }],
      messages: [{
        role: "user",
        content: `Use live web search to find the official ${input.targets.join(" and ")} profile URLs for ${input.subject}${input.location ? ` in ${input.location}` : ""}.${input.knownProfileUrl ? ` Known identity profile: ${input.knownProfileUrl}.` : ""}${input.handle ? ` Known ${input.handlePlatform ?? "social"} handle: @${input.handle}.` : ""} Use the known profile as an identity clue. Return only profiles on ${input.targets.join(" or ")}; do not return the known profile or posts/videos. Return only JSON: {"profiles":[{"platform":"${input.targets.join("|")}","url":"https://...","title":"...","snippet":"evidence","confidence":0-100}]}. Omit platforms you cannot verify. Never invent URLs.`,
      }],
    }),
    signal: AbortSignal.timeout(20_000),
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
      if (!input.targets.includes(platform)) return [];
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
  return platformDefinition(value)?.name;
}

function isTargetProfileUrl(value: string, targets: DiscoveryPlatform[]): boolean {
  try {
    const url = new URL(value);
    const recognized = classifyUrl(url);
    if (!recognized || !targets.includes(recognized.name)) return false;
    const parts = url.pathname.split("/").filter(Boolean);
    if (recognized.name === "Instagram") {
      return parts.length === 1 && /^[\w.]{2,120}$/.test(parts[0])
        && !["p", "reel", "reels", "stories", "explore", "direct", "accounts"].includes(parts[0].toLowerCase());
    }
    if (recognized.name === "TikTok") {
      return parts.length === 1 && /^@[\w.-]{2,120}$/.test(parts[0]);
    }
    return (parts.length === 1 && /^@[\w.-]{2,120}$/.test(parts[0]))
      || (parts.length === 2 && ["channel", "c", "user"].includes(parts[0].toLowerCase()) && /^[\w-]{2,120}$/.test(parts[1]));
  } catch {
    return false;
  }
}

function profileHandleFromUrl(value: string): string {
  try {
    const parts = new URL(value).pathname.split("/").filter(Boolean);
    return (parts.find((part) => part.startsWith("@")) ?? parts.at(-1) ?? "").replace(/^@/, "");
  } catch {
    return "";
  }
}

export function parseKnownProfileUrl(value: string): {
  platform: "instagram" | "tiktok" | "youtube" | "spotify";
  handle: string;
  url: string;
  channelId?: string;
} | undefined {
  try {
    const trimmed = value.trim();
    const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    if (url.username || url.password) return undefined;
    const host = url.hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");
    const parts = url.pathname.split("/").filter(Boolean);
    const platform = host === "instagram.com"
      ? "instagram"
      : host === "tiktok.com"
        ? "tiktok"
        : host === "youtube.com"
          ? "youtube"
          : host === "open.spotify.com"
            ? "spotify"
            : undefined;
    if (!platform) return undefined;
    const channelId = platform === "youtube" && parts.length === 2 && parts[0] === "channel" && /^UC[\w-]{22}$/.test(parts[1]) ? parts[1] : undefined;
    const handle = platform === "youtube"
      ? channelId ?? (parts.length === 1 && parts[0]?.startsWith("@") ? parts[0].slice(1) : "")
      : platform === "tiktok"
        ? parts.length === 1 && parts[0]?.startsWith("@") ? parts[0].slice(1) : ""
        : platform === "spotify"
          ? parts.length === 2 && parts[0] === "artist" && /^[a-zA-Z0-9]{22}$/.test(parts[1]) ? parts[1] : ""
          : parts.length === 1 ? parts[0] : "";
    if (!handle || !/^[\w.-]{2,120}$/.test(handle)) return undefined;
    if (platform === "instagram" && ["explore", "reels", "reel", "p", "stories", "direct", "accounts"].includes(handle.toLowerCase())) return undefined;
    url.search = "";
    url.hash = "";
    return { platform, handle, url: url.toString(), ...(channelId ? { channelId } : {}) };
  } catch {
    return undefined;
  }
}

export async function resolveKnownProfileIdentity(value: string, apiKey: string) {
  const parsed = parseKnownProfileUrl(value);
  if (!parsed) return undefined;
  const metadata = await fetchIdentityMetadata({
    platform: parsed.platform,
    url: parsed.url,
    apiKey,
  });
  if (!metadata) return undefined;
  if (parsed.channelId) {
    if (metadata.channelId !== parsed.channelId || !metadata.displayName?.trim()) return undefined;
  } else if (parsed.platform === "spotify") {
    if (metadata.handle !== parsed.handle) return undefined;
  } else if (metadata.handle.toLowerCase() !== parsed.handle.toLowerCase()) return undefined;
  return {
    subject: metadata.displayName?.trim() || `@${parsed.handle}`,
    handle: parsed.platform === "spotify" || (parsed.channelId && metadata.handle === parsed.channelId) ? undefined : metadata.handle,
    handlePlatform: parsed.platform,
    knownProfileUrl: parsed.url,
    referenceMetadata: metadata,
  };
}

function commonPrefixLength(a: string, b: string): number {
  let index = 0;
  while (index < a.length && index < b.length && a[index] === b[index]) index += 1;
  return index;
}

async function fetchIdentityMetadata(input: {
  platform: string;
  url: string;
  apiKey: string;
}): Promise<IdentityMetadata | undefined> {
  if (input.platform.toLowerCase() === "spotify") {
    const parsed = parseKnownProfileUrl(input.url);
    if (parsed?.platform !== "spotify") return undefined;
    const response = await fetch(`https://open.spotify.com/oembed?${new URLSearchParams({ url: parsed.url })}`, {
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) throw new Error(`Spotify artist lookup failed (${response.status})`);
    const payload = await response.json() as { title?: string; thumbnail_url?: string; provider_name?: string };
    if (payload.provider_name !== "Spotify" || !payload.title?.trim()) return undefined;
    return {
      platform: "spotify",
      handle: parsed.handle,
      displayName: payload.title.trim(),
      url: parsed.url,
      ...(payload.thumbnail_url ? { imageUrl: payload.thumbnail_url } : {}),
    };
  }
  const definition = platformDefinition(input.platform);
  if (!definition) return undefined;
  const platform = definition.key;
  const expectedHandle = profileHandleFromUrl(input.url);
  const channelId = platform === "youtube" ? parseKnownProfileUrl(input.url)?.channelId : undefined;
  const query = new URLSearchParams(channelId ? { channelId } : { handle: expectedHandle });
  const response = await fetch(
    `https://api.scrapecreators.com/v1${definition.scrapeCreatorsProfilePath}?${query}`,
    {
      headers: { "x-api-key": input.apiKey },
      signal: AbortSignal.timeout(12_000),
    },
  );
  if (!response.ok) {
    const failure = await response.json().catch(() => undefined) as {
      error?: { message?: string };
    } | undefined;
    throw new Error(failure?.error?.message ?? `Metadata lookup failed (${response.status})`);
  }
  const payload = (await response.json()) as any;
  if (platform === "instagram") {
    const user = payload.data?.user;
    if (!user) return undefined;
    return {
      platform: input.platform,
      handle: user.username ?? expectedHandle,
      ...(user.full_name ? { displayName: user.full_name } : {}),
      ...(user.biography ? { bio: user.biography } : {}),
      ...(user.profile_pic_url_hd || user.profile_pic_url
        ? { imageUrl: user.profile_pic_url_hd ?? user.profile_pic_url }
        : {}),
      url: `https://www.instagram.com/${user.username ?? expectedHandle}/`,
      ...(user.edge_followed_by?.count !== undefined ? { followers: user.edge_followed_by.count } : {}),
      ...(user.is_verified !== undefined ? { verified: user.is_verified } : {}),
    };
  }
  if (platform === "tiktok") {
    const user = payload.user;
    if (!user) return undefined;
    return {
      platform: input.platform,
      handle: user.uniqueId ?? expectedHandle,
      ...(user.nickname ? { displayName: user.nickname } : {}),
      ...(user.signature ? { bio: user.signature } : {}),
      ...(user.avatarLarger || user.avatarMedium || user.avatarThumb
        ? { imageUrl: user.avatarLarger ?? user.avatarMedium ?? user.avatarThumb }
        : {}),
      url: `https://www.tiktok.com/@${user.uniqueId ?? expectedHandle}`,
      ...(payload.stats?.followerCount !== undefined ? { followers: payload.stats.followerCount } : {}),
      ...(user.verified !== undefined ? { verified: user.verified } : {}),
    };
  }
  if (!payload.channel && !payload.name) return undefined;
  return {
    platform: input.platform,
    handle: payload.handle?.replace(/^@/, "") || profileHandleFromUrl(payload.channel ?? input.url) || expectedHandle,
    ...(payload.channelId ? { channelId: payload.channelId } : {}),
    ...(payload.name ? { displayName: payload.name } : {}),
    ...(payload.description ? { bio: payload.description } : {}),
    ...(payload.avatar?.image?.sources?.at(-1)?.url ? { imageUrl: payload.avatar.image.sources.at(-1).url } : {}),
    url: payload.channel ?? input.url,
    ...(payload.subscriberCount !== undefined ? { followers: payload.subscriberCount } : {}),
    ...(payload.isVerified !== undefined ? { verified: payload.isVerified } : {}),
  };
}

function compareIdentity(reference: IdentityMetadata, candidate: IdentityMetadata, evidence: string[] = []) {
  const clean = (value?: string) => (value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const referenceName = clean(reference.displayName);
  const candidateName = clean(candidate.displayName);
  const referenceHandle = clean(reference.handle);
  const candidateHandle = clean(candidate.handle);
  const referenceBioWords = new Set((reference.bio ?? "").toLowerCase().match(/[a-z0-9]{4,}/g) ?? []);
  const candidateBioWords = new Set((candidate.bio ?? "").toLowerCase().match(/[a-z0-9]{4,}/g) ?? []);
  const sharedBioWords = [...referenceBioWords].filter((word) => candidateBioWords.has(word));
  const reasons: string[] = [];
  let score = 0;

  if (evidence.some((signal) => signal.toLowerCase().includes("link in bio"))) {
    score += 60;
    reasons.push("Direct link from the known profile");
  }
  if (referenceName && candidateName && (referenceName.includes(candidateName) || candidateName.includes(referenceName))) {
    score += 35;
    reasons.push("Display names closely match");
  }
  if (referenceHandle === candidateHandle) {
    score += 35;
    reasons.push("Handles match exactly");
  } else if (commonPrefixLength(referenceHandle, candidateHandle) >= 5) {
    score += 20;
    reasons.push("Handles share a strong prefix");
  }
  if (sharedBioWords.length >= 2) {
    score += 20;
    reasons.push(`Bios share: ${sharedBioWords.slice(0, 3).join(", ")}`);
  } else if (!reference.bio || !candidate.bio) {
    reasons.push("Bio comparison unavailable");
  }
  if (candidate.verified) {
    score += 10;
    reasons.push("Candidate is verified");
  }
  if (
    reference.followers !== undefined && candidate.followers !== undefined
    && Number.isFinite(reference.followers) && Number.isFinite(candidate.followers)
    && reference.followers >= 0 && candidate.followers >= 0
  ) {
    const larger = Math.max(reference.followers, candidate.followers);
    const smaller = Math.min(reference.followers, candidate.followers);
    const ratio = larger / Math.max(1, smaller);
    if (larger >= 10_000 && ratio >= 100) {
      score -= 25;
      reasons.push(
        `Follower counts differ greatly (${reference.followers.toLocaleString()} vs ${candidate.followers.toLocaleString()}); platform audiences can vary`,
      );
    } else if (larger >= 10_000 && ratio >= 10) {
      score -= 10;
      reasons.push(
        `Follower counts differ (${reference.followers.toLocaleString()} vs ${candidate.followers.toLocaleString()}); platform audiences can vary`,
      );
    }
  }
  if (reference.imageUrl && candidate.imageUrl) reasons.push("Both profile images available for visual review");
  if (reasons.length === 0) reasons.push("No strong identity signals matched");

  return {
    status: score >= 55 ? "likely" as const : score >= 25 ? "uncertain" as const : "mismatch" as const,
    score: Math.max(0, Math.min(100, score)),
    reasons,
    reference,
    candidate,
  };
}

export async function findProfiles(input: {
  subject?: string;
  handle?: string;
  handlePlatform?: "instagram" | "tiktok" | "youtube" | "spotify" | "x" | "twitter" | "facebook";
  knownProfileUrl?: string;
  referenceMetadata?: IdentityMetadata;
  excludeReferencePlatform?: boolean;
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
  const identityHint = [
    input.knownProfileUrl,
    cleanHandle ? `@${cleanHandle}` : undefined,
    input.handlePlatform,
  ].filter(Boolean).join(" ");
  const referencePlatform = input.excludeReferencePlatform ? targetsForPlatform(input.handlePlatform) : undefined;
  const targets: DiscoveryPlatform[] = socialPlatformDefinitions
    .map((platform) => platform.name)
    .filter((platform) => platform !== referencePlatform);
  const selected = input.methods?.length
    ? input.methods
    : ["serper", "tavily", "gemini", "scrapecreators", "socialcrawl"];
  const queries = targets.map(
    (platform) => input.excludeReferencePlatform
      ? `${subject}${locationHint}${cleanHandle ? ` @${cleanHandle}` : ""} official site:${platform === "Instagram" ? "instagram.com" : platform === "YouTube" ? "youtube.com/@" : "tiktok.com/@"}`
      : `${subject}${locationHint}${identityHint ? ` ${identityHint}` : ""} official ${platform}`,
  );
  const methodMeta = {
    serper: { label: "Serper", estimatedCostUsd: targets.length * 0.001, costNote: `${targets.length} queries at roughly $1 per 1,000 queries` },
    tavily: { label: "Tavily", estimatedCostUsd: targets.length * 0.008, costNote: `${targets.length} basic searches at roughly $0.008 per credit` },
    gemini: { label: "Gemini Online Discovery", estimatedCostUsd: 0.01, costNote: "Web search for profile links; JEV checks identity separately when profile metadata is readable" },
    jev: { label: "JEV Decision", estimatedCostUsd: 0, costNote: "Typed identity decision over gathered evidence; exact OpenRouter usage cost shown" },
    deepseek: { label: "DeepSeek Verification", estimatedCostUsd: 0.008, costNote: "Automatic independent candidate review using V4.1 Flash and token usage" },
    scrapecreators: { label: "ScrapeCreators", estimatedCostUsd: 0, costNote: "0 cached or 10 live credits; dollar cost depends on your credit pack" },
    socialcrawl: { label: "SocialCrawl", estimatedCostUsd: 0, costNote: "3 credits for Instagram, TikTok, and YouTube searches; dollar cost depends on your credit pack" },
  } as const;
  const methodKeys = ["serper", "tavily", "gemini", "jev", "deepseek", "scrapecreators", "socialcrawl"] as const;
  const statuses = new Map<string, "used" | "unavailable" | "failed">();
  const durations = new Map<string, number>();
  const verifierResults = new Map<string, ProfileMatch[]>();
  let geminiDiscovery: ProfileMatch[] = [];
  let scrapeCreatorsCreditsCharged: number | undefined;
  let socialCrawlCreditsCharged: number | undefined;
  let jevCostUsd = 0;
  let jevStatusNote: string | undefined;
  const organic: Array<SerperOrganicResult & { method: string }> = [];

  const runSearches = async (
    method: string,
    runner: (query: string) => Promise<SerperOrganicResult[]>,
  ) => {
    const startedAt = performance.now();
    try {
      const results = await Promise.all(queries.map(runner));
      organic.push(...results.flat().map((result) => ({ ...result, method })));
      statuses.set(method, "used");
    } catch {
      statuses.set(method, "failed");
    } finally {
      durations.set(method, Math.round(performance.now() - startedAt));
    }
  };

  const runScrapeCreators = async () => {
    const startedAt = performance.now();
    if (!input.scrapeCreatorsApiKey || !cleanHandle || !input.handlePlatform) {
      statuses.set("scrapecreators", "unavailable");
      durations.set("scrapecreators", 0);
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
        signal: AbortSignal.timeout(25_000),
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
    } finally {
      durations.set("scrapecreators", Math.round(performance.now() - startedAt));
    }
  };

  const runSocialCrawl = async () => {
    const startedAt = performance.now();
    if (!input.socialCrawlApiKey) {
      statuses.set("socialcrawl", "unavailable");
      durations.set("socialcrawl", 0);
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
          signal: AbortSignal.timeout(25_000),
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
    } finally {
      durations.set("socialcrawl", Math.round(performance.now() - startedAt));
    }
  };

  const runGeminiDiscovery = async () => {
    const startedAt = performance.now();
    if (!input.openrouterApiKey) {
      statuses.set("gemini", "unavailable");
      durations.set("gemini", 0);
      return;
    }
    try {
      geminiDiscovery = await discoverWithGeminiOnline({
        subject,
        targets,
        location: input.location,
        handle: cleanHandle,
        handlePlatform: input.handlePlatform,
        knownProfileUrl: input.knownProfileUrl,
        apiKey: input.openrouterApiKey,
      });
      verifierResults.set("gemini", geminiDiscovery);
      statuses.set("gemini", "used");
    } catch {
      statuses.set("gemini", "failed");
    } finally {
      durations.set("gemini", Math.round(performance.now() - startedAt));
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
    selected.includes("gemini")
      ? runGeminiDiscovery()
      : Promise.resolve(),
  ]);

  const query = queries.join(" | ");
  const sources = organic
    .filter((result) => result.link && (!input.excludeReferencePlatform || isTargetProfileUrl(result.link, targets)))
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
        if (input.excludeReferencePlatform && !isTargetProfileUrl(result.link, targets)) return [];
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

  profiles = [...profiles, ...geminiDiscovery];

  const referencePlatformForFallback = targetsForPlatform(input.handlePlatform);
  const fallbackPlatforms = targets.filter(
    (platform) =>
      platform !== referencePlatformForFallback
      && !geminiDiscovery.some((profile) => profile.platform === platform),
  );
  if (
    fallbackPlatforms.length > 0
    && !selected.includes("scrapecreators")
    && input.scrapeCreatorsApiKey
    && cleanHandle
    && input.handlePlatform
  ) {
    const startedAt = performance.now();
    try {
      const params = new URLSearchParams({
        platform: input.handlePlatform,
        handle: cleanHandle,
        cache_max_age: "7d",
      });
      const response = await fetch(`https://api.scrapecreators.com/v1/find-social-profiles?${params}`, {
        headers: { "x-api-key": input.scrapeCreatorsApiKey },
        signal: AbortSignal.timeout(25_000),
      });
      if (!response.ok) throw new Error(`ScrapeCreators deep check failed (${response.status})`);
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
      profiles.push(...(data.profiles ?? []).flatMap((profile): ProfileMatch[] => {
        const platform = targetsForPlatform(profile.platform);
        if (!profile.url || !platform || !fallbackPlatforms.includes(platform)
          || (input.excludeReferencePlatform && !isTargetProfileUrl(profile.url, targets))) return [];
        try {
          const url = new URL(profile.url);
          return [{
            platform,
            category: "social",
            title: `${profile.handle ? `@${profile.handle}` : subject} on ${platform}`,
            url: profile.url,
            displayUrl: `${url.hostname.replace(/^www\./, "")}${url.pathname}`.replace(/\/$/, ""),
            snippet: `ScrapeCreators evidence: ${(profile.evidence ?? []).join(", ") || "linked social profile"}`,
            confidence: Math.max(20, Math.min(99, Math.round((profile.confidence ?? 0.7) * 100))),
            signals: [
              "Recovered by ScrapeCreators deep check",
              ...(profile.evidence ?? []).map((evidence) => `Evidence: ${evidence.replaceAll("_", " ")}`),
            ],
            methods: ["scrapecreators"],
          }];
        } catch {
          return [];
        }
      }));
      statuses.set("scrapecreators", "used");
      selected.push("scrapecreators");
    } catch {
      statuses.set("scrapecreators", "failed");
      selected.push("scrapecreators");
    } finally {
      durations.set("scrapecreators", Math.round(performance.now() - startedAt));
    }
  }

  if (input.excludeReferencePlatform) {
    profiles = profiles.filter((profile) => isTargetProfileUrl(profile.url, targets));
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

  if (input.scrapeCreatorsApiKey && input.knownProfileUrl && input.handlePlatform) {
    const referencePlatform = targetsForPlatform(input.handlePlatform);
    const geminiPlatforms = new Set(geminiDiscovery.map((profile) => profile.platform));
    const candidatesToCompare = profiles
      .filter((profile) => {
        if (
          profile.platform === referencePlatform
          || (!input.excludeReferencePlatform && geminiPlatforms.has(profile.platform))
          || (!input.excludeReferencePlatform && !profile.methods.includes("serper") && !profile.methods.includes("scrapecreators"))
        ) return false;
        try {
          return input.excludeReferencePlatform
            ? isTargetProfileUrl(profile.url, targets)
            : !excludedPaths.some((path) => new URL(profile.url).pathname.toLowerCase().includes(path));
        } catch {
          return false;
        }
      });
    let reference: IdentityMetadata | undefined = input.referenceMetadata;
    let referenceFailure: string | undefined;
    if (referencePlatform && !reference) {
      try {
        reference = await fetchIdentityMetadata({
          platform: referencePlatform,
          url: input.knownProfileUrl,
          apiKey: input.scrapeCreatorsApiKey,
        });
      } catch (error) {
        referenceFailure = error instanceof Error ? error.message : "Identity metadata lookup failed";
      }
    }
    if (reference) {
      const comparisons = await Promise.all(candidatesToCompare.map(async (profile) => {
        try {
          const candidate = await fetchIdentityMetadata({
            platform: profile.platform,
            url: profile.url,
            apiKey: input.scrapeCreatorsApiKey!,
          });
          return candidate
            ? { url: profile.url, comparison: compareIdentity(reference, candidate, profile.signals) }
            : { url: profile.url, note: "No profile metadata returned for this candidate" };
        } catch (error) {
          return {
            url: profile.url,
            note: error instanceof Error ? error.message : "Candidate metadata lookup failed",
          };
        }
      }));
      const comparisonByUrl = new Map(comparisons.filter((item) => item.comparison).map(
        (item) => [item.url, item.comparison!] as const,
      ));
      const noteByUrl = new Map(comparisons.filter((item) => item.note).map(
        (item) => [item.url, item.note!] as const,
      ));
      profiles = profiles.map((profile) => {
        const identityComparison = comparisonByUrl.get(profile.url);
        const identityVerificationNote = noteByUrl.get(profile.url);
        if (!identityComparison) return identityVerificationNote
          ? { ...profile, identityVerificationNote }
          : profile;
        const confidenceAdjustment = identityComparison.status === "likely"
          ? 5
          : identityComparison.status === "mismatch"
            ? -12
            : 0;
        return {
          ...profile,
          confidence: Math.max(5, Math.min(99, profile.confidence + confidenceAdjustment)),
          signals: [...profile.signals, `Identity check: ${identityComparison.status}`],
          identityComparison,
        };
      });
    } else if (referenceFailure) {
      const candidateUrls = new Set(candidatesToCompare.map((profile) => profile.url));
      profiles = profiles.map((profile) => candidateUrls.has(profile.url)
        ? { ...profile, identityVerificationNote: referenceFailure }
        : profile);
    }
  }

  const jevCandidates = profiles.filter((profile) => profile.identityComparison);
  if (input.excludeReferencePlatform && !selected.includes("jev")) selected.push("jev");
  if (input.excludeReferencePlatform && !input.openrouterApiKey) {
    statuses.set("jev", "unavailable");
    jevStatusNote = "JEV is not configured for this search.";
  } else if (input.excludeReferencePlatform && jevCandidates.length === 0) {
    statuses.set("jev", "unavailable");
    jevStatusNote = profiles.length
      ? "No candidate had readable profile metadata for an identity comparison."
      : "No candidate profiles were found to verify.";
  }
  if (input.openrouterApiKey && jevCandidates.length > 0) {
    const startedAt = performance.now();
    try {
      const questions = Object.fromEntries(jevCandidates.flatMap((profile, index) => [
        [`candidate_${index}_same_identity`, {
          type: "noul",
          instructions: `Evaluate only candidates[${index}] (${profile.url}). Does it belong to the same person, creator, brand, or entity as knownProfileUrl?`,
          criteria: {
            true: "The supplied metadata and evidence support the same identity",
            false: "The evidence supports different identities or is too weak",
          },
        }],
        [`candidate_${index}_verdict`, {
          type: "choice",
          instructions: `Evaluate only candidates[${index}] (${profile.url}). Classify its identity match against knownProfileUrl.`,
          criteria: {
            verified: "A direct official cross-link or uniquely conclusive evidence",
            likely: "Multiple strong and consistent identity signals",
            uncertain: "Some overlap but insufficient evidence",
            mismatch: "Conflicting or clearly unrelated identity evidence",
          },
        }],
      ]));
      const response = await fetch("https://openrouter.ai/api/alpha/decisions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${input.openrouterApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "typesafe/jev-1.13",
          state: {
            subject,
            knownProfileUrl: input.knownProfileUrl,
            candidates: jevCandidates.map((profile, index) => ({
              index,
              url: profile.url,
              methods: profile.methods,
              metadata: profile.identityComparison,
              evidence: profile.signals,
            })),
          },
          questions,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`JEV decision failed (${response.status})`);
      const payload = (await response.json()) as {
        answers?: Record<string, {
          noul?: number;
          choice?: string;
          confidence?: number;
          probabilities?: Record<string, number>;
        }>;
        usage?: { cost?: number };
      };
      jevCostUsd = payload.usage?.cost ?? 0;
      const verificationByUrl = new Map(jevCandidates.flatMap((profile, index) => {
        const sameIdentity = payload.answers?.[`candidate_${index}_same_identity`];
        const verdict = payload.answers?.[`candidate_${index}_verdict`];
        if (
          sameIdentity?.noul === undefined
          || !verdict?.choice
          || !["verified", "likely", "uncertain", "mismatch"].includes(verdict.choice)
        ) return [];
        return [[profile.url, {
          verdict: verdict.choice as "verified" | "likely" | "uncertain" | "mismatch",
          sameIdentityProbability: sameIdentity.noul,
          verdictConfidence: verdict.confidence ?? Math.max(...Object.values(verdict.probabilities ?? { unknown: 0 })),
          probabilities: verdict.probabilities ?? {},
        }] as const];
      }));
      profiles = profiles.map((profile) => {
        const jevVerification = verificationByUrl.get(profile.url);
        return jevVerification
          ? {
              ...profile,
              jevVerification,
              signals: [...profile.signals, `JEV decision: ${jevVerification.verdict}`],
            }
          : profile;
      });
      verifierResults.set("jev", profiles.filter((profile) => profile.jevVerification));
      statuses.set("jev", "used");
      selected.push("jev");
    } catch {
      statuses.set("jev", "failed");
      jevStatusNote = "JEV did not return a decision. Candidate discovery results are still shown.";
      selected.push("jev");
    } finally {
      durations.set("jev", Math.round(performance.now() - startedAt));
    }
  }

  const methodsUsed = methodKeys
    .filter((method) => selected.includes(method))
    .map((method) => ({
      method,
      ...methodMeta[method],
      ...(method === "scrapecreators" && scrapeCreatorsCreditsCharged !== undefined
        ? { costNote: `${scrapeCreatorsCreditsCharged} credits charged for this request` }
        : {}),
      ...(method === "socialcrawl" && socialCrawlCreditsCharged !== undefined
        ? { costNote: `${socialCrawlCreditsCharged} credits charged for this request` }
        : {}),
      ...(method === "jev"
        ? {
            estimatedCostUsd: jevCostUsd,
            costNote: jevStatusNote ?? `Exact OpenRouter usage cost: $${jevCostUsd.toFixed(8)}`,
          }
        : {}),
      status: statuses.get(method) ?? "failed",
      durationMs: durations.get(method) ?? 0,
      results: method === "gemini" || method === "jev" || method === "deepseek"
        ? (verifierResults.get(method) ?? []).slice(0, 10).map((profile) => ({
            title: profile.title,
            url: profile.url,
            snippet: profile.snippet,
          }))
        : method === "scrapecreators"
          ? profiles
              .filter((profile) => profile.methods.includes("scrapecreators"))
              .slice(0, 10)
              .map((profile) => ({
                title: profile.title,
                url: profile.url,
                snippet: profile.snippet,
              }))
        : organic
            .filter((result) => result.method === method && result.link
              && (!input.excludeReferencePlatform || isTargetProfileUrl(result.link, targets)))
            .slice(0, 30)
            .map((result) => ({
              title: result.title ?? "Untitled result",
              url: result.link!,
              snippet: result.snippet ?? "",
            })),
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