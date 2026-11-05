import fs from 'node:fs/promises';

export const paidKinds = new Set(['serper', 'scrapecreators_candidate', 'scrapecreators_reference', 'jev']);

/** Fixture-only until live transport, provider prices and execution are approved.
 * An exclusive, fsynced journal makes any previous admission non-replayable. */
export async function createPilotBudget({ manifest, journalPath, transport, mode }) {
  if (mode !== 'fixture' || transport?.fixture !== true || typeof transport.dispatch !== 'function') {
    throw new Error('Live execution is disabled. Only an explicitly injected fixture transport is permitted.');
  }
  const limits = manifest.proposed_limits;
  const cap = {
    serper: limits.serper_requests_total,
    scrapecreators_candidate: limits.scrapecreators_requests_total,
    scrapecreators_reference: limits.scrapecreators_requests_total,
    jev: limits.jev_requests_total,
    spotify_oembed: limits.public_spotify_oembed_requests_total,
    public_page: limits.public_official_or_linkhub_page_requests_total,
  };
  const perArtist = { serper: limits.serper_requests_per_artist,
    scrapecreators_candidate: limits.instagram_candidate_metadata_per_artist,
    scrapecreators_reference: limits.reference_metadata_per_artist,
    jev: limits.jev_requests_per_artist, spotify_oembed: 1, public_page: 1 };
  for (const value of [...Object.values(cap), ...Object.values(perArtist), limits.paid_http_requests_total,
    limits.global_concurrent_provider_requests, limits.per_request_timeout_seconds]) {
    if (!Number.isInteger(value) || value < 0) throw new Error('Invalid pilot request limits.');
  }
  if (limits.global_concurrent_provider_requests < 1 || limits.global_concurrent_provider_requests > 5) throw new Error('Invalid concurrency limit.');
  if (limits.per_request_timeout_seconds < 1 || !Number.isInteger(limits.jev_max_input_tokens_per_request)
    || limits.jev_max_input_tokens_per_request < 1 || !Number.isInteger(limits.jev_max_output_tokens_per_request)
    || limits.jev_max_output_tokens_per_request < 1) throw new Error('Invalid timeout or JEV token reservation.');
  if (manifest.artists.some(a => !/^\d+$/.test(String(a.profile_id)))) throw new Error('Invalid pilot profile identity.');
  const allowed = new Set(manifest.artists.filter(a => a.reference_preflight?.readiness === 'reference_usable'
    && a.source_identity_matches).map(a => String(a.profile_id)));
  const journal = await fs.open(journalPath, 'wx'); // Never resume/replay a previous journal.
  const counts = { paid: 0, scrapecreators: 0, byKind: {}, byArtist: {} };
  const keys = new Set(), waiters = [];
  let active = 0, stopped, closed = false, serial = Promise.resolve();
  const append = async row => {
    try { await journal.write(`${JSON.stringify(row)}\n`); await journal.sync(); }
    catch (error) { stopped = 'Admission storage unavailable.'; throw error; }
  };
  async function slot() {
    if (active < limits.global_concurrent_provider_requests) active++;
    else await new Promise(resolve => waiters.push(resolve)); // Slot is handed off, not reacquired.
  }
  function release() { const next = waiters.shift(); if (next) next(); else active--; }
  async function request({ profileId, kind, key, payload = {}, deadlineAt = Infinity }) {
    profileId = String(profileId);
    if (!allowed.has(profileId)) throw new Error('Artist is outside the frozen paid-eligible scope.');
    if (!Object.hasOwn(cap, kind)) throw new Error('Unbudgeted provider kind.');
    if (!key || typeof key !== 'string') throw new Error('A unique admission key is required.');
    if (kind === 'jev' && (Buffer.byteLength(JSON.stringify(payload)) > limits.jev_max_input_tokens_per_request
      || !Number.isInteger(limits.jev_max_output_tokens_per_request))) {
      throw new Error('JEV evidence exceeds the conservative byte-based input reservation.');
    }
    await slot();
    try {
      const admission = serial.then(async () => {
        if (closed || stopped) throw new Error(stopped ?? 'Pilot budget is closed.');
        if (Date.now() >= deadlineAt) throw new Error('Pilot time budget exceeded before dispatch.');
        if (keys.has(key)) throw new Error('Admission already used; automatic replay is forbidden.');
        const artist = counts.byArtist[profileId] ?? {};
        if ((counts.byKind[kind] ?? 0) >= cap[kind] || (artist[kind] ?? 0) >= perArtist[kind]
          || (paidKinds.has(kind) && counts.paid >= limits.paid_http_requests_total)
          || (kind.startsWith('scrapecreators_') && counts.scrapecreators >= limits.scrapecreators_requests_total)) {
          throw new Error('Pilot request cap reached; no dispatch.');
        }
        await append({ phase: 'admitted', profileId, kind, key, at: new Date().toISOString() });
        keys.add(key);
        counts.byKind[kind] = (counts.byKind[kind] ?? 0) + 1;
        artist[kind] = (artist[kind] ?? 0) + 1;
        counts.byArtist[profileId] = artist;
        if (paidKinds.has(kind)) counts.paid++;
        if (kind.startsWith('scrapecreators_')) counts.scrapecreators++;
      });
      serial = admission.catch(() => {});
      await admission;
      if (Date.now() >= deadlineAt) {
        await append({ phase: 'cancelled_before_dispatch', profileId, kind, key });
        throw new Error('Pilot time budget exceeded before dispatch.');
      }
      const controller = new AbortController();
      let timer;
      try {
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => {
            stopped = 'Uncertain timed-out request; new admissions stopped.';
            controller.abort();
            reject(new Error(stopped));
          }, Math.min(limits.per_request_timeout_seconds * 1000, deadlineAt - Date.now()));
        });
        const value = await Promise.race([Promise.resolve().then(() => transport.dispatch({
          profileId, kind, key, payload, signal: controller.signal,
          maxOutputTokens: kind === 'jev' ? limits.jev_max_output_tokens_per_request : undefined,
        })), timeout]);
        await append({ phase: 'returned', profileId, kind, key });
        return value;
      } catch (error) {
        if (error.fatalProvider) stopped = 'Provider credit/authentication failure; pilot stopped.';
        await append({ phase: 'failed_no_retry', profileId, kind, key, category: error.fatalProvider ? 'provider_fatal' : 'unresolved' });
        throw error;
      } finally { clearTimeout(timer); }
    } catch (error) {
      // Failed journal writes must fence later work, not merely fail one artist.
      if (error.code && ['EIO', 'ENOSPC', 'EBADF'].includes(error.code)) stopped = 'Admission storage unavailable.';
      throw error;
    } finally { release(); }
  }
  return {
    request,
    snapshot: () => structuredClone({ ...counts, stopped: stopped ?? null }),
    stop: reason => { stopped = reason; },
    close: async () => { closed = true; await serial; await journal.close(); },
  };
}
