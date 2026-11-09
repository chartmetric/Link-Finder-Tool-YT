import assert from "node:assert/strict";
import test from "node:test";
import {
  hasCompletedSerperNoCandidate,
  validateRerunIdentities,
} from "../src/lib/musician-instagram-rerun";

const profile = {
  profile_id: "9007199254740993",
  cm_artist: "123",
  artist: "Example Artist",
  account_ids: ["456"],
};
const serper = JSON.stringify({ methodsUsed: [{ method: "serper", status: "used" }] });
const prior = (
  status: string,
  urls: string[] = [],
  resultJson = serper,
  cmArtist = profile.cm_artist,
) => ({ latest: [status, urls, resultJson, "", "old-run", "2026-11-03 00:00:00", cmArtist] as [string, string[], string, string, string, string, string] });

test("rerun eligibility requires a matching completed empty Serper result", () => {
  assert.equal(hasCompletedSerperNoCandidate(profile, prior("no_candidates")), true);
  assert.equal(hasCompletedSerperNoCandidate(profile), false);
  assert.equal(hasCompletedSerperNoCandidate(profile, prior("candidates_found")), false);
  assert.equal(hasCompletedSerperNoCandidate(profile, prior("failed")), false);
  assert.equal(hasCompletedSerperNoCandidate(profile, prior("no_candidates", ["https://instagram.com/account"])), false);
  assert.equal(hasCompletedSerperNoCandidate(profile, prior("no_candidates", [], "not-json")), false);
  assert.equal(hasCompletedSerperNoCandidate(profile, prior("no_candidates", [], JSON.stringify({
    methodsUsed: [{ method: "gemini", status: "used" }],
  }))), false);
  assert.equal(hasCompletedSerperNoCandidate(profile, prior("no_candidates", [], serper, "124")), false);
});

test("rerun identity validation preserves full UInt64 IDs and rejects invalid or duplicate identities", () => {
  assert.doesNotThrow(() => validateRerunIdentities([profile]));
  assert.throws(() => validateRerunIdentities([]), /NO_ELIGIBLE/);
  assert.throws(() => validateRerunIdentities([{ ...profile, cm_artist: "not-a-number" }]), /INVALID_LOOKUP/);
  assert.throws(() => validateRerunIdentities([{ ...profile, account_ids: ["18446744073709551616"] }]), /INVALID_LOOKUP/);
  assert.throws(() => validateRerunIdentities([profile, profile]), /INVALID_RERUN_PROFILE/);
});
