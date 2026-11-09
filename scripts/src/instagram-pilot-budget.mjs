import fs from 'node:fs/promises';

export const paidKinds = new Set(['serper', 'scrapecreators_candidate', 'scrapecreators_reference', 'jev']);

// Conservative prepaid-credit valuations, not purchases or promised invoice costs:
// Serper $1/1k; SC $47/25k credits, allowing TEN credits per profile;
// JEV $0.042/M input, $0 output, reserving more than its whole 262144-token context.
export const pilotReservationsCents = Object.freeze({
  serper: 1, scrapecreators_candidate: 2, scrapecreators_reference: 2, jev: 2,
  spotify_oembed: 0, public_page: 0,
});

/** An exclusive, fsynced journal makes any previous admission non-replayable. */
export async function createPilotBudget({ manifest, journalPath, transport, mode }) {
  // A separately approved research batch does not expand the original $10 pilot.
  const batch=manifest.authorization?.separateBatchApproval;
  const separateBatchAuthorized=['instagram-tiers-1-5-approved-250-usd20','instagram-tiers-1-5-approved-250-usd20-second','instagram-tiers-1-5-approved-238-usd19-third'].includes(batch?.runId)
    &&batch.maxArtists<=250&&batch.maxSpendCents<=2000
    &&manifest.artists.length<=250&&manifest.selection?.claimsAllowed===false
    &&manifest.selection?.experimentalAcceptanceEnabled===false&&manifest.selection?.fullTierRerun===false;
  const live = mode === 'live' && transport?.live === true && transport.fixture !== true
    && manifest.authorization?.approved === true && manifest.run_allowed === true
    && Number.isInteger(manifest.authorization.maxSpendCents)
    && manifest.authorization.maxSpendCents > 0
    && manifest.authorization.maxSpendCents <= (separateBatchAuthorized?2000:1000);
  if ((!live && (mode !== 'fixture' || transport?.fixture !== true)) || typeof transport?.dispatch !== 'function') {
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
    jev: limits.jev_requests_per_artist, spotify_oembed: 1,
    public_page: limits.public_music_page_requests_per_artist ?? 1 };
  const publicCap = limits.public_http_requests_total ?? cap.spotify_oembed + cap.public_page;
  for (const value of [...Object.values(cap), ...Object.values(perArtist), limits.paid_http_requests_total,
    publicCap, limits.global_concurrent_provider_requests, limits.per_request_timeout_seconds]) {
    if (!Number.isInteger(value) || value < 0) throw new Error('Invalid pilot request limits.');
  }
  if (limits.global_concurrent_provider_requests < 1 || limits.global_concurrent_provider_requests > 5) throw new Error('Invalid concurrency limit.');
  if (perArtist.public_page<1 || perArtist.public_page>4) throw new Error('Public music-page limit must be 1–4 per artist.');
  if (limits.per_request_timeout_seconds < 1 || !Number.isInteger(limits.jev_max_input_tokens_per_request)
    || limits.jev_max_input_tokens_per_request < 1 || !Number.isInteger(limits.jev_max_output_tokens_per_request)
    || limits.jev_max_output_tokens_per_request < 1) throw new Error('Invalid timeout or JEV token reservation.');
  if (manifest.artists.some(a => !/^\d+$/.test(String(a.profile_id)))) throw new Error('Invalid pilot profile identity.');
  const allowed = new Set(manifest.artists.filter(a => a.reference_preflight?.readiness === 'reference_usable'
    && a.source_identity_matches).map(a => String(a.profile_id)));
  const journal = await fs.open(journalPath, 'wx'); // Never resume/replay a previous journal.
  const counts = { paid: 0, scrapecreators: 0, byKind: {}, byArtist: {},
    reservedSpendCents: 0, maxSpendCents: live ? manifest.authorization.maxSpendCents : null,
    reusedCompletedPackets: 0 };
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
    const inputBytes = kind==='jev' ? (live && transport.inputBytes
      ? transport.inputBytes({kind,payload}) : Buffer.byteLength(JSON.stringify(payload))) : 0;
    if (kind === 'jev' && (!Number.isInteger(inputBytes) || inputBytes<1
      || inputBytes > limits.jev_max_input_tokens_per_request || !Number.isInteger(limits.jev_max_output_tokens_per_request))) {
      throw new Error('JEV evidence exceeds the conservative byte-based input reservation.');
    }
    await slot();
    try {
      const admission = serial.then(async () => {
        if (closed || stopped) throw new Error(stopped ?? 'Pilot budget is closed.');
        if (Date.now() >= deadlineAt) throw new Error('Pilot time budget exceeded before dispatch.');
        if (keys.has(key)) throw new Error('Admission already used; automatic replay is forbidden.');
        const cachedReceipt = live ? transport.cachedAdmission?.({profileId,kind,payload}) : undefined;
        const reserveCents = live && !cachedReceipt ? pilotReservationsCents[kind] : 0;
        if (live && counts.reservedSpendCents + reserveCents > counts.maxSpendCents) {
          stopped = 'Approved dollar ceiling reached; new admissions stopped.';
          throw new Error(stopped);
        }
        const artist = counts.byArtist[profileId] ?? {};
        if ((counts.byKind[kind] ?? 0) >= cap[kind] || (artist[kind] ?? 0) >= perArtist[kind]
          || (paidKinds.has(kind) && counts.paid >= limits.paid_http_requests_total)
          || (!paidKinds.has(kind) && (counts.byKind.spotify_oembed ?? 0)+(counts.byKind.public_page ?? 0)>=publicCap)
          || (kind.startsWith('scrapecreators_') && counts.scrapecreators >= limits.scrapecreators_requests_total)) {
          throw new Error('Pilot request cap reached; no dispatch.');
        }
        await append({ phase: 'admitted', profileId, kind, key, reserveCents, cachedReceipt, at: new Date().toISOString() });
        counts.reservedSpendCents += reserveCents;
        keys.add(key);
        counts.byKind[kind] = (counts.byKind[kind] ?? 0) + 1;
        artist[kind] = (artist[kind] ?? 0) + 1;
        counts.byArtist[profileId] = artist;
        if (cachedReceipt) counts.reusedCompletedPackets++;
        if (paidKinds.has(kind) && !cachedReceipt) counts.paid++;
        if (kind.startsWith('scrapecreators_') && !cachedReceipt) counts.scrapecreators++;
        return cachedReceipt;
      });
      serial = admission.catch(() => {});
      const cachedReceipt = await admission;
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
          cachedReceipt,
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
