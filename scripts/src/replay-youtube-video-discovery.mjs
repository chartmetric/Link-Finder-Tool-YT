// Offline-only read of the completed archive; exclusive sibling output, never modifies source.
import './youtube-ownership-offline-fence.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {digest, planVideoDiscovery, proposedVideoAllocation} from './youtube-video-discovery-offline.mjs';

export async function fingerprintArchive(dir, prefix = '') {
  const result = {};
  for (const entry of (await fs.readdir(dir, {withFileTypes: true})).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(dir, entry.name), key = prefix + entry.name;
    if (entry.isDirectory()) Object.assign(result, await fingerprintArchive(file, key + '/'));
    else if (entry.isSymbolicLink()) result[key] = 'symlink:' + await fs.readlink(file);
    else if (entry.isFile()) result[key] = digest(await fs.readFile(file));
    else throw Error('Unsupported archive entry: ' + key);
  }
  return result;
}
export async function replayVideoDiscovery(root, out) {
  const source = await fs.realpath(root), parent = await fs.realpath(path.dirname(out));
  const destination = path.join(parent, path.basename(out));
  assert.ok(destination !== source && !destination.startsWith(source + path.sep), 'Output must be outside source');
  const read = async file => JSON.parse(await fs.readFile(path.join(source, file), 'utf8'));
  const baseline = JSON.parse(await fs.readFile(source + '-offline-review/archive-proof.json', 'utf8'));
  const before = await fingerprintArchive(source);
  assert.equal(Object.keys(before).length, 200);
  assert.deepEqual(before, baseline.before, 'Source differs from original saved-evidence audit');
  assert.deepEqual(before, baseline.after);
  const scope = await read('plan.json'), run = await read('summary.json');
  assert.equal(run.status, 'completed'); assert.equal(scope.artists.length, 20);
  const searches = new Map();
  for (const file of await fs.readdir(source + '/receipts')) {
    const receipt = await read('receipts/' + file);
    assert.equal(receipt.inputSha256, digest(receipt.request));
    if (receipt.kind !== 'search') continue;
    assert.equal(receipt.status, 200); assert.ok(Array.isArray(receipt.data.organic));
    const profileId = /^search-(\d+)-0$/.exec(receipt.operationKey)?.[1];
    assert.ok(profileId); assert.ok(!searches.has(profileId));
    searches.set(profileId, {receipt, provenance: {archivePath: 'receipts/' + file,
      receiptSha256: digest(await fs.readFile(source + '/receipts/' + file)),
      originalRequestSha256: receipt.inputSha256, capturedAt: receipt.at}});
  }
  assert.equal(searches.size, 20);
  const artists = [];
  for (const row of scope.artists) {
    const original = await read('artists/' + row.profile_id + '.json');
    assert.equal(original.artist.profileId, row.profile_id);
    assert.equal(original.artist.cmArtist, row.cm_artist);
    const saved = searches.get(row.profile_id); assert.ok(saved);
    const clues = planVideoDiscovery(original.artist, saved.receipt.data.organic, saved.provenance);
    artists.push({name: original.artist.name, ...clues,
      originalDirectChannelCandidates: original.allSearchCandidates.length,
      originalSelectedCandidates: original.candidates.length,
      originalDecisions: original.candidates.map(c => ({url: c.url, decision: c.decision})),
      normalizedSubpageSources: clues.channelClues.flatMap(c => c.sources)
        .filter(s => /\/(?:about|videos|shorts|streams|playlists|featured|community|releases)\/?(?:[?#]|$)/.test(s.sourceUrl)),
      uploaderResolution: 'not_fetched_no_saved_video_metadata_receipts'});
  }
  const sum = fn => artists.reduce((n, a) => n + fn(a), 0);
  const summary = {mode: 'offline_only', artists: artists.length,
    originalArchiveEntries: 200, originalZeroDirectCandidates: sum(a => Number(!a.originalDirectChannelCandidates)),
    zeroDirectWithVideoClues: sum(a => Number(!a.originalDirectChannelCandidates && a.videoClues.length > 0)),
    zeroDirectWithQueuedVideos: sum(a => Number(!a.originalDirectChannelCandidates && a.resolutionQueue.length > 0)),
    videoClues: sum(a => a.videoClues.length), plannedVideoOperations: sum(a => a.resolutionQueue.length),
    deferredEligibleVideos: sum(a => a.deferredVideos.length),
    normalizedSubpageSources: sum(a => a.normalizedSubpageSources.length),
    snippetMentions: sum(a => a.snippetHandles.length),
    resolvedUploaders: 0, newVerifiedMatches: 0, newProviderCalls: 0, catalogWrites: 0,
    originalDecisionsChanged: 0, allocation: proposedVideoAllocation(),
    limitations: ['Video/snippet relevance is not uploader identity or artist ownership.',
      'No video metadata was refetched; uploader identities remain unknown.',
      'Proposed endpoint/schema/pricing need review and a new exact-scope approval before any execution.',
      'Name overlap can be a song title or collaborator; no acceptance thresholds changed.']};
  const after = await fingerprintArchive(source);
  assert.deepEqual(after, before, 'Original archive changed during replay');
  await fs.mkdir(destination, {recursive: false});
  for (const [file, body] of Object.entries({'summary.json': summary, 'artist-clues.json': artists,
    'archive-proof.json': {filesAndSymlinks: 200, before, after, matchesOriginalAudit: true, unchanged: true}}))
    await fs.writeFile(path.join(destination, file), JSON.stringify(body, null, 2), {flag: 'wx'});
  assert.deepEqual(await fingerprintArchive(source), before);
  return summary;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 4, 'Usage: node replay-youtube-video-discovery.mjs SOURCE NEW_OUTPUT');
  console.log(JSON.stringify(await replayVideoDiscovery(process.argv[2], process.argv[3]), null, 2));
}
