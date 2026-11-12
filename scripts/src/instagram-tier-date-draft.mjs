// Offline proposal only. Intentionally not imported by campaign workers.
// Passing this tier check is NOT paid admission or complete catalog eligibility.
import assert from 'node:assert/strict';

export const DRAFT_MAX_TIER_AGE_SECONDS = 36 * 60 * 60;

export function latestGlobalTierObservationSql(ids) {
  assert.ok(Array.isArray(ids) && ids.length > 0 && ids.length <= 10000);
  assert.ok(ids.every(id => typeof id === 'string' && /^[1-9]\d*$/.test(id)));
  assert.equal(new Set(ids).size, ids.length);
  // Do not filter tier/date before argMax: that could resurrect a superseded
  // eligible assignment after a demotion. Keep tier, date and rank together.
  return `SELECT toString(profile) profile_id,
 argMax(tuple(tier,tier_rank,toString(computed_at,'UTC')),
        tuple(computed_at,updated_at)) latest
 FROM new_vertical.l_profile_tier FINAL
 WHERE profile_type='musician' AND grain='global'
 AND profile IN (${ids.join(',')})
 GROUP BY profile`;
}

function utcMillis(value) {
  if (typeof value !== 'string') return NaN;
  // Catalog timestamps have explicit UTC semantics; never use local timezone.
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? value.replace(' ', 'T') + 'Z' : value;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(normalized))
    return NaN;
  const ms = Date.parse(normalized);
  if (!Number.isFinite(ms)) return NaN;
  const canonical = new Date(ms).toISOString();
  return canonical.slice(0, 19) === normalized.slice(0, 19) ? ms : NaN;
}

export function assessTierObservation(row, {now, maximumAgeSeconds}) {
  // No implicit clock or implicitly activated freshness policy.
  const nowMs = utcMillis(now);
  assert.ok(Number.isFinite(nowMs), 'Explicit UTC observation time required');
  assert.ok(Number.isInteger(maximumAgeSeconds) && maximumAgeSeconds > 0
    && maximumAgeSeconds <= DRAFT_MAX_TIER_AGE_SECONDS,
  'Draft age limit must be explicit and no greater than 36 hours');
  const held = reason => ({tierCheckPassed: false, reason});
  if (!row) return held('missing_global_tier');
  if (!Array.isArray(row.latest) || row.latest.length !== 3)
    return held('invalid_tier_observation');
  const [tier, rank, computedAt] = row.latest;
  if (!Number.isInteger(tier) || !Number.isFinite(rank))
    return held('invalid_tier_observation');
  const computedMs = utcMillis(computedAt);
  if (!Number.isFinite(computedMs)) return held('invalid_tier_timestamp');
  const ageSeconds = (nowMs - computedMs) / 1000;
  if (ageSeconds < 0) return held('future_tier_timestamp');
  if (tier < 1 || tier > 5) return held('outside_tiers_1_to_5');
  if (ageSeconds > maximumAgeSeconds)
    return {...held('stale_global_tier'), ageSeconds};
  return {tierCheckPassed: true, reason: 'fresh_per_artist_global_tier',
    tier, tierRank: rank, computedAt, ageSeconds};
}
