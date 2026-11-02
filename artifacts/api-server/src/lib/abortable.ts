/** Stop waiting even if an adapter ignores AbortSignal; observe late failures. */
export async function abortable<T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return work();
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([cancelled, work()]); }
  finally { signal.removeEventListener("abort", abort); }
}
