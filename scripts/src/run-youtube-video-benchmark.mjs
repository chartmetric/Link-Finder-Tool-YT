// Local CLI: read saved receipts, verify bindings, write only a new sibling output.
import './youtube-ownership-offline-fence.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {fingerprintArchive} from './replay-youtube-video-discovery.mjs';
import {digest, normalizeDiscoveryVideo} from './youtube-video-discovery-offline.mjs';
import {parseAdjudications, evaluateVideoBenchmark} from './youtube-video-benchmark.mjs';

const fixtureDir = new URL('../fixtures/', import.meta.url);
const csv = (headers, records) => '\ufeff' + [headers, ...records.map(r => headers.map(h => r[h] ?? ''))]
  .map(row => row.map(v => {
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    // Spreadsheet formula safety without altering JSON evidence.
    return '"' + (/^[=+@\-\t\r]/.test(s) ? "'" + s : s).replaceAll('"', '""') + '"';
  }).join(',')).join('\r\n') + '\r\n';
const escape = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function renderReport(result, policy) {
  const s = result.summary, p = n => n === null ? 'Unknown / not measurable' : (100 * n).toFixed(1) + '%';
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Saved video clue benchmark</title>
<style>body{font:16px system-ui;margin:40px auto;max-width:1200px;padding:0 20px;color:#182e32}h1,h2{color:#126b5e}table{border-collapse:collapse;width:100%;font-size:14px}td,th{border:1px solid #b7cac5;padding:8px;text-align:left}th{background:#e7f2ee}pre{white-space:pre-wrap;overflow-wrap:anywhere}small{color:#435d59}</style>
<h1>How often do saved video clues identify artist-owned channels?</h1>
<p><strong>Not measurable from this archive.</strong> All ${s.artistVideoPairs} artist/video pairs lack an exact saved video-to-uploader binding. Ownership remains unknown, not rejected, and not 0%.</p>
<p>${s.artists} artists; ${s.distinctVideoIds} distinct video IDs. Repeated videos across artists remain separate pairs. No paid requests, writes, acceptance changes or campaign activation.</p>
<h2>Source-text relevance is not ownership</h2>
<p>${escape(policy.adjudication.relevanceDefinition)} Catalog artist identity remains unknown, including exact-name performers.</p>
<table><tr><th>Subset</th><th>Pairs</th><th>Relevant</th><th>Unrelated</th><th>Unknown</th><th>Precision on scorable text</th></tr>
${['all','eligible','queued','deferred'].map(k => {const m=s.textRelevance[k];return `<tr><td>${k}</td><td>${m.total}</td><td>${m.relevant}</td><td>${m.unrelated}</td><td>${m.unknown}</td><td>${p(m.textRelevancePrecision)}</td></tr>`;}).join('')}</table>
<p>Eligibility recall on source-text positives: ${p(s.textRelevance.eligibilityRecallAmongTextRelevant)}. Queue retention of those positives: ${p(s.textRelevance.queueRecallAmongTextRelevant)}. Unknowns are excluded from precision, not counted as negatives. These are convenience-sample descriptions, not population accuracy.</p>
<h2>Cost of one channel capture and two video resolutions</h2>
<p>The two-video bound retains ${s.allocation.queuedVideos}/${s.allocation.eligibleVideos} eligible video clues and defers ${s.allocation.deferredVideos} (${p(s.allocation.videoDeferralFraction)}), including ${s.allocation.deferredTextRelevantVideos} source-text positives.</p>
<p>The original test selected ${s.allocation.historicalSelectedAddresses} direct candidate addresses. A single capture retains at most ${s.allocation.oneCaptureDirectRetentionCeiling} of those, losing ${s.allocation.directAddressSlotsLost} slots (${p(s.allocation.directAddressLossFraction)}) across ${s.allocation.artistsLosingSecondDirectSlot} artists, before any displacement by videos. Design maximum drops from ${s.allocation.maximumCaptureSlotsBefore} to ${s.allocation.maximumCaptureSlotsAfter} channel captures (50%). Resolutions can yield duplicate channels or no uploader; unique channels and owned-channel loss are unknown.</p>
<table><tr><th>Artist</th><th>Old direct slots</th><th>New direct ceiling</th><th>Lost direct slots</th><th>Video queued / eligible</th><th>Deferred relevant</th></tr>
${result.breadth.map(r=>`<tr><td>${escape(r.artist)}</td><td>${r.historicalSelectedAddresses}</td><td>${r.oneCaptureDirectRetentionCeiling}</td><td>${r.directAddressSlotsLost}</td><td>${r.queuedVideos} / ${r.eligibleVideos}</td><td>${r.deferredRelevantVideos}</td></tr>`).join('')}</table>
<h2>Strata and evidence gaps</h2><pre>${escape(JSON.stringify(policy.requiredStrata,null,2))}</pre>
<p>Song-title collisions, contributors, Topic/distribution mentions, covers, lyrics and same-name claims are saved text strata. No actual fan, cover, lyrics, Topic, distributor or exact-name uploader role is proven. Synthetic role controls are tested separately and never included in these rates.</p>
<h2>Adjudication limits</h2><pre>${escape(JSON.stringify(policy.adjudication,null,2))}</pre>
<h2>All saved cases</h2><p>Every case has uploader identity, exact catalog identity and ownership <strong>unknown</strong>. The accompanying JSON and CSV retain full source occurrences and receipt hashes.</p>
<table><tr><th>Artist / video</th><th>Text relevance</th><th>Queued</th><th>Independent source rationale</th></tr>
${result.rows.map(r=>`<tr><td>${escape(r.artist)}<br><small>${escape(r.videoId)}</small></td><td>${r.relevance}</td><td>${r.queued ? 'yes':'no'}</td><td>${escape(r.rationale)}</td></tr>`).join('')}</table></html>`;
}

export async function runVideoBenchmark(sourceArg, replayArg, outputArg) {
  const source = await fs.realpath(sourceArg), replay = await fs.realpath(replayArg);
  const out = path.join(await fs.realpath(path.dirname(outputArg)), path.basename(outputArg));
  for (const input of [source, replay])
    assert.ok(out !== input && !out.startsWith(input + path.sep), 'Output must be outside inputs');
  const sourceBefore = await fingerprintArchive(source), replayBefore = await fingerprintArchive(replay);
  const originalProof = JSON.parse(await fs.readFile(source + '-offline-review/archive-proof.json', 'utf8'));
  const replayProof = JSON.parse(await fs.readFile(path.join(replay, 'archive-proof.json'), 'utf8'));
  for (const expected of [originalProof.before, originalProof.after, replayProof.before, replayProof.after])
    assert.deepEqual(sourceBefore, expected, 'Source archive differs from its audited manifest');
  const replayBytes = await fs.readFile(path.join(replay, 'artist-clues.json'));
  const policyBytes = await fs.readFile(new URL('youtube-video-benchmark-policy.json', fixtureDir));
  const labelBytes = await fs.readFile(new URL('youtube-video-relevance-adjudications.tsv', fixtureDir));
  const policy = JSON.parse(policyBytes), saved = JSON.parse(replayBytes);
  assert.equal(digest(replayBytes), policy.replaySha256, 'Replay changed: source labels need re-review');
  const cohort = [];
  for (const a of saved) {
    const original = JSON.parse(await fs.readFile(path.join(source, 'artists', `${a.profileId}.json`), 'utf8'));
    assert.equal(original.artist.profileId, a.profileId);
    assert.equal(original.artist.cmArtist, a.cmArtist);
    assert.equal(original.artist.name, a.name);
    const sources = [...a.videoClues, ...a.channelClues].flatMap(c => c.sources);
    // Empty organic cases have no clue provenance; locate their original search receipt by key.
    let provenance = sources[0];
    if (!provenance) {
      for (const file of await fs.readdir(path.join(source, 'receipts'))) {
        const bytes = await fs.readFile(path.join(source, 'receipts', file));
        const receipt = JSON.parse(bytes);
        if (receipt.kind === 'search' && receipt.operationKey === `search-${a.profileId}-0`) {
          provenance = {archivePath: `receipts/${file}`, receiptSha256: digest(bytes),
            originalRequestSha256: receipt.inputSha256, capturedAt: receipt.at};
          break;
        }
      }
    }
    assert.ok(provenance, 'Missing original search receipt');
    assert.match(provenance.archivePath, /^receipts\/[^/\\]+\.json$/);
    const bytes = await fs.readFile(path.join(source, provenance.archivePath));
    assert.equal(digest(bytes), provenance.receiptSha256);
    const receipt = JSON.parse(bytes);
    assert.equal(receipt.kind, 'search'); assert.equal(receipt.status, 200);
    assert.equal(receipt.operationKey, `search-${a.profileId}-0`);
    assert.equal(digest(receipt.request), receipt.inputSha256);
    assert.equal(receipt.inputSha256, provenance.originalRequestSha256);
    for (const s of sources) {
      assert.equal(s.archivePath, provenance.archivePath); assert.equal(s.receiptSha256, digest(bytes));
      const result = receipt.data.organic[s.resultIndex];
      assert.equal(digest(result), s.resultSha256);
      assert.equal(result.link, s.sourceUrl); assert.equal(result.title ?? '', s.title);
      assert.equal(result.snippet ?? '', s.snippet);
    }
    // Pin the reviewed video universe, independently of current eligibility/queue predictions.
    const videoIds = new Set(receipt.data.organic.map(r => normalizeDiscoveryVideo(r.link)?.videoId).filter(Boolean));
    assert.deepEqual([...videoIds].sort(), a.videoClues.map(v => v.videoId).sort());
    const {archivePath, receiptSha256, originalRequestSha256, capturedAt} = provenance;
    cohort.push({artist: original.artist, organic: receipt.data.organic,
      provenance: {archivePath, receiptSha256, originalRequestSha256, capturedAt},
      originalCandidates: original.candidates});
  }
  const result = evaluateVideoBenchmark(cohort, parseAdjudications(labelBytes.toString()));
  const evidence = {policy, policySha256: digest(policyBytes), annotationsSha256: digest(labelBytes),
    heuristicSha256: digest(await fs.readFile(new URL('./youtube-video-discovery-offline.mjs', import.meta.url))),
    replaySha256: digest(replayBytes), savedLabels: result.rows, perArtistBreadth: result.breadth};
  const sourceAfter = await fingerprintArchive(source), replayAfter = await fingerprintArchive(replay);
  assert.deepEqual(sourceAfter, sourceBefore); assert.deepEqual(replayAfter, replayBefore);
  await fs.mkdir(out, {recursive: false}); // Refuse overwrites, including existing symlinks.
  const outputs = {
    'summary.json': JSON.stringify(result.summary, null, 2),
    'evidence.json': JSON.stringify(evidence, null, 2),
    'archive-proof.json': JSON.stringify({unchanged: true, sourceBefore, sourceAfter, replayBefore, replayAfter}, null, 2),
    'cases.csv': csv(['profileId','cmArtist','artist','videoId','url','relevance','rationale','tags',
      'eligible','queued','deferred','catalogArtistIdentity','actualUploaderIdentity','uploaderChannelId',
      'uploaderEvidence','artistOwnership','ownershipEvidence','sources'], result.rows),
    'candidate-breadth.csv': csv(Object.keys(result.breadth[0]), result.breadth),
    'report.html': renderReport(result, policy)
  };
  for (const [name, content] of Object.entries(outputs))
    await fs.writeFile(path.join(out, name), content, {flag: 'wx'});
  assert.deepEqual(await fingerprintArchive(source), sourceBefore);
  assert.deepEqual(await fingerprintArchive(replay), replayBefore);
  return result.summary;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 5, 'Usage: node run-youtube-video-benchmark.mjs SOURCE REPLAY NEW_OUTPUT');
  console.log(JSON.stringify(await runVideoBenchmark(...process.argv.slice(2)), null, 2));
}
