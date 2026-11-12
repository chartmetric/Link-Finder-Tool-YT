import './youtube-ownership-offline-fence.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {digest, planVideoDiscovery, resolveSavedUploader} from './youtube-video-discovery-offline.mjs';
import {evaluateVideoBenchmark, parseAdjudications, ownershipMetrics} from './youtube-video-benchmark.mjs';
import {renderReport, runVideoBenchmark} from './run-youtube-video-benchmark.mjs';
import {fingerprintArchive} from './replay-youtube-video-discovery.mjs';

const artist = {profileId: '1', cmArtist: '2', name: 'Example Artist'};
const provenance = {archivePath: 'receipts/synthetic.json', receiptSha256: 'a'.repeat(64),
  originalRequestSha256: 'b'.repeat(64), capturedAt: null};
const video = (n, title, snippet = '') => ({
  link: `https://www.youtube.com/watch?v=${String(n).padStart(11,'0')}`, title, snippet
});
const header = 'profileId\tvideoId\trelevance\ttags\trationale\n';
const labels = (rows, profileId = '1') => rows.map(([n, relevance, tag = 'synthetic']) => ({
  profileId, videoId: String(n).padStart(11, '0'), relevance, tags: [tag],
  rationale: 'Synthetic authored control, not observed evidence.'
}));
const input = (organic, originalCandidates = []) => [{artist, organic, provenance, originalCandidates}];

test('independent labels must cover the whole video universe, including ineligible and deferred cases', () => {
  const organic = [video(1, 'Example Artist - A'), video(2, 'Example Artist - B'),
    video(3, 'Example Artist - C'), video(4, 'No matching name')];
  const l = labels([[1,'relevant'],[2,'unrelated'],[3,'unknown'],[4,'relevant']]);
  const result = evaluateVideoBenchmark(input(organic), l);
  assert.deepEqual(result.summary.textRelevance.eligibilityConfusion,
    {truePositive:1, falsePositive:1, falseNegative:1, trueNegative:0, unscored:1});
  assert.equal(result.summary.textRelevance.queueRecallAmongTextRelevant, 0.5);
  assert.equal(result.summary.textRelevance.queued.textRelevancePrecision, 0.5);
  assert.equal(result.summary.textRelevance.deferred.unknown, 1);
  assert.throws(() => evaluateVideoBenchmark(input(organic), l.slice(1)), /Missing adjudication/);
  assert.throws(() => evaluateVideoBenchmark(input(organic), [...l,...labels([[5,'relevant']])]), /outside/);
  assert.throws(() => evaluateVideoBenchmark(input(organic), [...l,l[0]]), /Duplicate/);
  assert.equal(evaluateVideoBenchmark(input([]), []).summary.ownership.all.artistOwnedChannelRate, null);
});
test('unknown uploader and ownership never become zero-percent accuracy, including exact-name claims', () => {
  const result = evaluateVideoBenchmark(input([video(1, 'Example Artist official music',
    '@ExampleArtist Go to channel Example Artist')]), labels([[1,'relevant']]));
  assert.deepEqual(result.summary.ownership.all,
    {total:1,owned:0,notOwned:0,unknown:1,scored:0,artistOwnedChannelRate:null,possibleOwnedFraction:[0,1]});
  assert.equal(result.rows[0].actualUploaderIdentity, 'unknown');
  assert.equal(result.rows[0].catalogArtistIdentity, 'unknown');
  assert.equal(result.summary.uploaderIdentity.known, 0);
  assert.throws(() => ownershipMetrics([{}]), /Missing ownership/);
});
test('two-video and one-capture losses stay separate and do not claim uploader-channel diversity', () => {
  const organic = Array.from({length: 5}, (_,i)=>video(i+1, 'Example Artist - ' + i));
  // Synthetic aliases of one captured direct channel demonstrate the distinction.
  const direct = [{url:'https://youtube.com/@example', canonicalChannelId:'UCabcdefghijklmnopqrstuv'},
    {url:'https://youtube.com/channel/UCabcdefghijklmnopqrstuv', canonicalChannelId:'UCabcdefghijklmnopqrstuv'}];
  const result = evaluateVideoBenchmark(input(organic,direct), labels([1,2,3,4,5].map(n=>[n,'relevant'])));
  assert.equal(result.summary.allocation.directAddressSlotsLost, 1);
  assert.equal(result.breadth[0].historicalDistinctKnownChannels, 1);
  assert.deepEqual(result.breadth[0].possibleAdditionalUploaderChannels, [0,2]);
  assert.equal(result.summary.allocation.deferredTextRelevantVideos, 3);
  assert.equal(result.summary.allocation.actualOwnedChannelsLost, null);
  assert.equal(result.summary.allocation.actualNewUploaderChannels, null);
  assert.equal(result.breadth[0].directCandidatesActuallyRetained, null);
});
test('shared videos remain separate artist pairs, while aliases within one artist deduplicate', () => {
  const organic = [video(1, 'Example Artist and Other Artist'),
    {link:'https://youtu.be/00000000001', title:'Example Artist and Other Artist',snippet:''}];
  const other = {profileId:'3',cmArtist:'4',name:'Other Artist'};
  const result = evaluateVideoBenchmark([...input(organic),{artist:other,organic,provenance,originalCandidates:[]}],
    [...labels([[1,'relevant']]),...labels([[1,'relevant']],'3')]);
  assert.equal(result.summary.distinctVideoIds, 1);
  assert.equal(result.summary.artistVideoPairs, 2);
  assert.equal(result.rows[0].sources.length, 2);
  assert.equal(result.summary.ownership.all.unknown, 2);
});

// Fully authored role controls, NOT independent saved ownership labels.
// These test that even resolved uploader identity/name agreement does not authorize ownership.
const controls = [
  {name:'song-title collision',title:'Example Artist - Another Performer',uploader:'Another Performer',role:'artist',owner:false},
  {name:'collaborator',title:'Example Artist & Collaborator - Song',uploader:'Collaborator',role:'artist',owner:false},
  {name:'distributor',title:'Example Artist - Song',uploader:'Example Records',role:'distributor',owner:false},
  {name:'Topic',title:'Example Artist - Song',uploader:'Example Artist - Topic',role:'topic',owner:false},
  {name:'fan',title:'Example Artist fan upload',uploader:'Fans of Example Artist',role:'fan',owner:false},
  {name:'cover',title:'Example Artist - Song (cover)',uploader:'Cover Musician',role:'cover',owner:false},
  {name:'lyrics',title:'Example Artist - Song (lyrics)',uploader:'Lyrics Library',role:'lyrics',owner:false},
  {name:'exact name owned',title:'Example Artist - Song',uploader:'Example Artist',role:'artist',owner:true},
  {name:'exact name impersonator',title:'Example Artist - Song',uploader:'Example Artist',role:'impersonator',owner:false}
];
for (const c of controls) test('synthetic role control: ' + c.name, () => {
  const clue = planVideoDiscovery(artist, [video(1,c.title)], provenance).resolutionQueue[0];
  assert.ok(clue, 'Name overlap can queue every one of these controls');
  const body = {videoId:clue.videoId,uploader:{channelId:'UCabcdefghijklmnopqrstuv',displayName:c.uploader}};
  const resolved = resolveSavedUploader(artist,clue,{profileId:'1',cmArtist:'2',
    operationKey:clue.operation.key,inputSha256:digest(clue.operation.request),
    status:200,body,bodySha256:digest(body)});
  assert.equal(resolved.verified,false);
  assert.equal(resolved.ownershipEvidence,false);
  assert.equal(resolved.requiresIndependentOwnershipCheck,true);
  if (c.uploader === artist.name) assert.equal(resolved.artistNameAgreement,'name_only_not_ownership');
  // Authored role/ownership truth is deliberately NOT supplied to resolver or saved metrics.
});

test('annotation syntax rejects duplicate, missing, invalid and incomplete labels', () => {
  const line = '1\t00000000001\trelevant\tlyrics\tPrimary named credit';
  assert.equal(parseAdjudications(header+line)[0].relevance,'relevant');
  for(const body of [header+line+'\n'+line,header+line.replace('relevant','owned'),
    header+line.replace('00000000001','bad'),header+line.replace('Primary named credit','')])
    assert.throws(()=>parseAdjudications(body));
});
test('HTML report escapes source text and explicitly discloses null ownership', () => {
  const result = evaluateVideoBenchmark(input([video(1,'Example Artist - A')]),labels([[1,'relevant']]));
  result.rows[0].rationale='<script>not executable</script>';
  const html = renderReport(result,{adjudication:{relevanceDefinition:'text only'},requiredStrata:{}});
  assert.ok(html.includes('&lt;script&gt;')); assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('not 0%')); assert.ok(html.includes('unknown'));
});
test('the saved annotation file has 90 independently labeled pairs and declares its limitations', async () => {
  const bytes = await fs.readFile(new URL('../fixtures/youtube-video-relevance-adjudications.tsv',import.meta.url),'utf8');
  const policy = JSON.parse(await fs.readFile(new URL('../fixtures/youtube-video-benchmark-policy.json',import.meta.url),'utf8'));
  const rows = parseAdjudications(bytes);
  assert.equal(rows.length,90);
  assert.equal(policy.adjudication.secondReviewer,null); assert.equal(policy.adjudication.blinded,false);
  for(const stratum of ['song_title_collision','collaborator','distribution','topic_mention','cover','lyrics','exact_name_mention'])
    assert.ok(rows.some(r=>r.tags.includes(stratum)),stratum);
  assert.match(policy.requiredStrata.fan_uploader,/synthetic_control_only/);
  assert.match(policy.requiredStrata.exact_name_uploader,/synthetic_control_only/);
});
test('real archive integration, when locally available, preserves evidence and refuses overwrites', async t => {
  const source='generated-artifacts/youtube-test-20-main-fixes-2026-11-11';
  const replay=source+'-video-discovery-offline';
  try { await fs.access(path.join(replay,'artist-clues.json')); }
  catch(e) { if(e.code==='ENOENT') {t.skip('Local saved replay not present; fixture tests still run.');return;} throw e; }
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'video-benchmark-'));
  try {
    const sourceBefore=await fingerprintArchive(source), replayBefore=await fingerprintArchive(replay);
    const out=path.join(dir,'results'), summary=await runVideoBenchmark(source,replay,out);
    assert.equal(summary.artistVideoPairs,90); assert.equal(summary.artists,20);
    assert.equal(summary.allocation.queuedVideos,37); assert.equal(summary.allocation.deferredVideos,53);
    assert.equal(summary.distinctVideoIds,84);
    assert.equal(summary.textRelevance.all.relevant,66);
    assert.equal(summary.textRelevance.all.unrelated,3);
    assert.equal(summary.textRelevance.all.unknown,21);
    assert.equal(summary.textRelevance.queued.relevant,28);
    assert.equal(summary.allocation.deferredTextRelevantVideos,38);
    assert.equal(summary.allocation.historicalSelectedAddresses,16);
    assert.equal(summary.allocation.oneCaptureDirectRetentionCeiling,11);
    assert.equal(summary.allocation.directAddressSlotsLost,5);
    assert.equal(summary.ownership.all.unknown,90); assert.equal(summary.ownership.all.scored,0);
    assert.equal(summary.ownership.queued.artistOwnedChannelRate,null);
    await assert.rejects(()=>runVideoBenchmark(source,replay,out),/EEXIST/);
    await assert.rejects(()=>runVideoBenchmark(source,replay,path.join(source,'forbidden')),/outside/);
    await assert.rejects(()=>runVideoBenchmark(source,replay,path.join(replay,'forbidden')),/outside/);
    assert.deepEqual(await fingerprintArchive(source),sourceBefore);
    assert.deepEqual(await fingerprintArchive(replay),replayBefore);
    const evidence=JSON.parse(await fs.readFile(path.join(out,'evidence.json'),'utf8'));
    assert.ok(evidence.savedLabels.every(r=>r.actualUploaderIdentity==='unknown' && r.artistOwnership==='unknown'));
    assert.equal(Object.keys(evidence.savedLabels[0].sources[0]).includes('recordedAnswer'),false);
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
});
