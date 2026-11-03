export const billingProviders = ["Serper", "OpenRouter", "ScrapeCreators", "SocialCrawl"] as const;
export type BillingProvider = typeof billingProviders[number];
export type BillingOutage = { provider: BillingProvider; httpStatus: number; incidentId: string; observedAt: string; clearedAt?: string };
const providers: Record<string, BillingProvider> = {
  "google.serper.dev": "Serper",
  "openrouter.ai": "OpenRouter",
  "api.scrapecreators.com": "ScrapeCreators",
  "www.socialcrawl.dev": "SocialCrawl",
  "socialcrawl.dev": "SocialCrawl",
};

export class ProviderCreditError extends Error {
  constructor(public readonly provider: BillingProvider, public readonly httpStatus: number) {
    super(`Automatic stop: ${provider} reported exhausted credits or a billing limit (HTTP ${httpStatus}). `
      + "Paid bulk launches are blocked until funding is restored and the shared billing block is explicitly cleared. Then start or resume explicitly. "
      + "Requests already dispatched may still incur charges.");
    this.name = "ProviderCreditError";
  }
}

/** Inspect only a bounded clone. Never persist/log provider bodies, URLs,
 * request headers, or credentials reflected in an error response. */
export async function providerCreditError(input: Parameters<typeof fetch>[0], response: Response) {
  if (response.ok) return;
  let provider: BillingProvider | undefined;
  try {
    const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
    provider = providers[url.hostname];
  } catch { return; }
  if (!provider) return;
  if (response.status === 402) return new ProviderCreditError(provider, response.status);
  // A rate limit or a generic server error is not evidence of exhausted credits.
  if (![400, 401, 403, 429].includes(response.status)) return;
  const reader = response.clone().body?.getReader();
  if (!reader) return;
  let text = "";
  try {
    const decoder = new TextDecoder();
    let bytes = 0;
    while (bytes < 16_384) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const part = chunk.value.subarray(0, 16_384 - bytes);
      bytes += part.byteLength;
      text += decoder.decode(part, { stream: true });
    }
    text += decoder.decode();
  } catch { return; }
  finally { void reader.cancel().catch(() => {}); }
  if (/\b(?:not enough|insufficient|out of|no remaining|no)\s+(?:available\s+)?credits?\b|\bcredits?\s+(?:are\s+|is\s+)?(?:exhausted|depleted)\b|\binsufficient_quota\b/i.test(text)) {
    return new ProviderCreditError(provider, response.status);
  }
  return undefined;
}
