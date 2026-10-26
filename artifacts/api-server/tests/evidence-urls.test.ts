import assert from "node:assert/strict";
import { test } from "node:test";
import { groupEvidenceUrls } from "../../musician-social-finder/src/lib/evidence-urls.ts";

const channelId = "UC3xKOdrbTTCzkMmHlwZtKjw";
const idUrl = `https://www.youtube.com/channel/${channelId}`;
const handleUrl = "https://www.youtube.com/@keepsydneyopen6511";
const account = { platform: "YouTube", url: idUrl, channelId, urlAliases: [idUrl, handleUrl] };

test("confirmed handle and ID aliases display as one account while retaining both links", () => {
  assert.deepEqual(groupEvidenceUrls([idUrl, handleUrl], [account]), [
    { confirmedAccount: true, urls: [idUrl, handleUrl] },
  ]);
});

test("similar-looking URLs without metadata remain separate evidence", () => {
  assert.deepEqual(groupEvidenceUrls([idUrl, handleUrl], [{ ...account, channelId: undefined }]), [
    { confirmedAccount: false, urls: [idUrl] }, { confirmedAccount: false, urls: [handleUrl] },
  ]);
});

test("different channel IDs do not merge even if the displayed profile names match", () => {
  const otherUrl = "https://www.youtube.com/@different";
  const other = { platform: "YouTube", url: otherUrl, channelId: "UCmv1CLT6ZcFdTJMHxaR9XeA" };
  const groups = groupEvidenceUrls([idUrl, otherUrl, handleUrl], [account, other]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].urls, [idUrl, handleUrl]);
  assert.deepEqual(groups[1].urls, [otherUrl]);
});

test("evidence links not in a confirmed alias set are not attached by a similar handle", () => {
  const unrelated = "https://www.youtube.com/@keepsydneyopen";
  const groups = groupEvidenceUrls([handleUrl, unrelated, idUrl], [account]);
  assert.deepEqual(groups, [
    { confirmedAccount: true, urls: [handleUrl, idUrl] },
    { confirmedAccount: false, urls: [unrelated] },
  ]);
});

test("duplicate URLs are removed and no extra URLs are added to an outcome", () => {
  assert.deepEqual(groupEvidenceUrls([handleUrl, handleUrl], [account]), [
    { confirmedAccount: true, urls: [handleUrl] },
  ]);
});

test("conflicting channel metadata cannot imply a confirmed shared account", () => {
  const other = { ...account, channelId: "UCmv1CLT6ZcFdTJMHxaR9XeA", urlAliases: [] };
  const groups = groupEvidenceUrls([idUrl, handleUrl], [account, other]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].confirmedAccount, false);
});

test("first-party sources and non-YouTube links stay plain evidence", () => {
  const source = "https://www.instagram.com/keepsydneyopen/";
  assert.deepEqual(groupEvidenceUrls([source], []), [{ confirmedAccount: false, urls: [source] }]);
  assert.deepEqual(groupEvidenceUrls([], [account]), []);
});
