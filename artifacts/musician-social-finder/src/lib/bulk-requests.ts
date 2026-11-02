import type { BulkLaunchSource } from '@workspace/api-client-react';

type Pending = { requestId: string; launchSource: BulkLaunchSource };
const memory = new Map<string, Pending>();
const prefix = 'bulk-profiles:pending:';

/** Retain an uncertain request across reloads and type navigation in this tab.
 * This is descriptive metadata only; it contains no identity or credentials. */
export function bulkRequest(key: string, source: BulkLaunchSource): Pending {
  let pending = memory.get(key);
  try {
    const raw = sessionStorage.getItem(prefix + key);
    if (raw) {
      const parsed = JSON.parse(raw) as Pending;
      if (/^[0-9a-f-]{36}$/i.test(parsed.requestId) && typeof parsed.launchSource === 'string') pending = parsed;
    }
  } catch { /* In-memory idempotency remains available when browser storage is blocked. */ }
  if (!pending) pending = { requestId: crypto.randomUUID(), launchSource: source };
  memory.set(key, pending);
  try { sessionStorage.setItem(prefix + key, JSON.stringify(pending)); } catch { /* See above. */ }
  return pending;
}

export function completeBulkRequest(key: string, requestId: string) {
  if (memory.get(key)?.requestId === requestId) memory.delete(key);
  try {
    const raw = sessionStorage.getItem(prefix + key);
    if (raw && JSON.parse(raw).requestId === requestId) sessionStorage.removeItem(prefix + key);
  } catch { /* Storage may be blocked. */ }
}
