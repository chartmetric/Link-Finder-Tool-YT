/** Read-only dashboard snapshots: retain the last success during refresh and
 * deduplicate expensive reads even when writes invalidate a pending snapshot. */
export function createCoverageCache<T>(
  read: () => Promise<T>,
  onError: (error: unknown) => void,
  now: () => number = Date.now,
) {
  const ttl = 5 * 60_000;
  const maxAge = 24 * 60 * 60_000;
  const cooldown = 30_000;
  let cached: { value: T; savedAt: number; expiresAt: number } | undefined;
  let inflight: Promise<T> | undefined;
  let revision = 0;
  let retryAfter = 0;
  let lastError: unknown;

  function refresh(): Promise<T> {
    if (inflight) return inflight;
    const currentRevision = revision;
    const request = Promise.resolve().then(read).then(value => {
      cached = { value, savedAt: now(), expiresAt: revision === currentRevision ? now() + ttl : 0 };
      lastError = undefined;
      retryAfter = now() + cooldown;
      return value;
    }).catch(error => {
      lastError = error;
      retryAfter = now() + cooldown;
      onError(error);
      throw error;
    }).finally(() => {
      if (inflight === request) inflight = undefined;
    });
    inflight = request;
    return request;
  }

  return {
    invalidate() {
      revision++;
      if (cached) cached.expiresAt = 0;
      // Never discard an in-flight read: concurrent invalidations must not
      // fan out more queries or remove the last successful figures.
    },
    get(): Promise<T> {
      if (cached && now() - cached.savedAt < maxAge) {
        if (cached.expiresAt <= now() && now() >= retryAfter) {
          void refresh().catch(() => { /* last success remains visible */ });
        }
        return Promise.resolve(cached.value);
      }
      if (inflight) return inflight;
      if (lastError && now() < retryAfter) return Promise.reject(lastError);
      return refresh();
    },
  };
}
