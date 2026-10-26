export const STARTING_PROFILE_TIMEOUT_MS = 30_000;
export const STARTING_PROFILE_MAX_ATTEMPTS = 2;

const platformNames: Record<string, string> = {
  instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube",
  spotify: "Spotify", web: "reference page",
};

export class StartingProfileLookupError extends Error {
  constructor(public readonly platform: string, public readonly timedOut: boolean, attempts: number, cause: unknown) {
    const name = platformNames[platform.toLowerCase()] ?? platform;
    const target = platform.toLowerCase() === "web" ? name : `${name} profile`;
    const detail = timedOut
      ? `timed out after ${attempts} attempts (30 seconds per attempt)`
      : `failed: ${cause instanceof Error ? cause.message : "provider request failed"}`;
    super(`Starting ${target} lookup ${detail}. Other platforms were not searched.`, { cause });
    this.name = "StartingProfileLookupError";
  }
}

/** Retry only our deadline aborts; invalid profiles, auth failures, and other
 * provider errors must not cause extra paid requests. The same deadline signal
 * is used through body decoding inside lookup, not just response headers. */
export async function lookupStartingProfile<T>(
  platform: string,
  lookup: (timeoutMs: number) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; attempt <= STARTING_PROFILE_MAX_ATTEMPTS; attempt++) {
    try {
      return await lookup(STARTING_PROFILE_TIMEOUT_MS);
    } catch (error) {
      const timedOut = error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name);
      if (!timedOut || attempt === STARTING_PROFILE_MAX_ATTEMPTS) {
        throw new StartingProfileLookupError(platform, timedOut, attempt, error);
      }
      // Short fixed backoff; never start a third attempt or retry the whole investigation.
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  throw new Error("Starting profile attempt limit reached.");
}
