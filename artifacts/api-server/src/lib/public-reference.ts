/** Public HTTP(S) references only; never fetch user-supplied URLs on this server. */
export function parsePublicReference(value: string): URL | undefined {
  try {
    const trimmed = value.trim();
    const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.port) return undefined;
    if (!/^(?:[a-z\d](?:[a-z\d-]*[a-z\d])?\.)+[a-z]{2,63}$/i.test(url.hostname)
      || /\.(?:localhost|local|internal|test|invalid|example)$/i.test(url.hostname)) return undefined;
    url.hash = "";
    return url;
  } catch {
    return undefined;
  }
}

function referenceKey(url: URL) {
  const host = url.hostname.replace(/^(www|m)\./, "").replace(/^cricinfo\.com$/, "espncricinfo.com");
  const query = new URLSearchParams(url.search);
  for (const key of [...query.keys()]) {
    if (/^utm_/i.test(key) || ["fbclid", "gclid"].includes(key)) query.delete(key);
  }
  query.sort();
  return `${host}${url.pathname.replace(/\/$/, "")}${query.size ? `?${query}` : ""}`;
}

export async function resolvePublicReference(url: URL, serperApiKey?: string) {
  if (!serperApiKey) throw new Error("Public reference-page lookup is unavailable; Serper is not configured.");
  // Use indexed page metadata so ESPN's bot protection cannot block a direct
  // page fetch, and arbitrary input URLs cannot reach private network services.
  const lookupUrl = new URL(url);
  if (/^(www\.)?cricinfo\.com$/i.test(lookupUrl.hostname)) lookupUrl.hostname = "www.espncricinfo.com";
  const response = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: { "X-API-KEY": serperApiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ q: lookupUrl.toString(), num: 10 }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`Reference-page lookup failed (${response.status}). Please try again.`);
  const payload = await response.json() as { organic?: Array<{ title?: string; link?: string; snippet?: string }> };
  const page = payload.organic?.find(item => {
    const candidate = item.link && parsePublicReference(item.link);
    return candidate && referenceKey(candidate) === referenceKey(url) && item.title?.trim();
  });
  if (!page?.title) return undefined;
  const subject = page.title
    .split(/\s+[|–—]\s+|\s+-\s+/)[0]
    .replace(/\s+(?:player\s+)?(?:profile|stats|statistics|biography|bio|career|news)\b.*$/i, "")
    .trim();
  if (subject.length < 2 || subject.length > 200) return undefined;
  return {
    subject,
    handle: undefined,
    handlePlatform: "web" as const,
    knownProfileUrl: url.toString(),
    referenceMetadata: {
      platform: "web",
      handle: "",
      displayName: subject,
      bio: `Google-indexed reference page: ${page.title}${page.snippet ? `\n${page.snippet}` : ""}`,
      url: url.toString(),
    },
  };
}
