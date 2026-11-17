import test from 'node:test';
import assert from 'node:assert/strict';
import {coverageRecoveryPlan} from './youtube-coverage-recovery.mjs';
const channel='https://www.youtube.com/@exactartist';
function record(){
  return {artist:{profileId:'1',cmArtist:'2',name:'Exact Artist',
    catalogProfile:{profile_id:'1',cm_artist:'2',name:'Exact Artist'},accounts:[],releases:[]},
    tier:2,candidates:[{url:channel,status:'uncertain'}],
    discovery:{candidates:[{url:channel}],allSearchCandidates:[
      {url:channel},{url:'https://www.youtube.com/@alternative',relevance:{bucket:'name_match'}}]},
    videoContexts:[],videoPlan:{resolutionQueue:[{profileId:'1',cmArtist:'2',
      videoId:'abcdefghijk',url:'https://www.youtube.com/watch?v=abcdefghijk',eligible:true,
      sources:[{profileId:'1',cmArtist:'2',matchedNames:['exact artist'],videoMentionHold:null,
        receiptSha256:'a'.repeat(64),archivePath:'generated-artifacts/source/receipts/search.json'}]}]}};
}
test('recovers saved video leads even after direct candidates were selected',()=>{
  const r=record(),before=structuredClone(r),p=coverageRecoveryPlan([r]);
  assert.equal(p.summary.artistsWhoseVideoFallbackWasSuppressed,1);
  assert.equal(p.recovery[0].savedVideoLeads.length,1);
  assert.equal(p.recovery[0].savedDirectCandidates.length,1);
  assert.deepEqual(r,before);
  assert.equal(p.executionEnabled,false);assert.equal(p.inheritsSpendingApproval,false);
  assert.equal(p.summary.measuredCoverageGain,null);
});
test('does not reprocess already suggested artists or retry attempted uploaders',()=>{
  const r=record();r.candidates[0].status='review_suggestion';
  assert.equal(coverageRecoveryPlan([r]).recovery.length,0);
  r.candidates[0].status='held';r.candidates[0].sourceUrl=r.videoPlan.resolutionQueue[0].url;
  assert.equal(coverageRecoveryPlan([r]).recovery[0].savedVideoLeads.length,0);
});
test('keeps empty searches separate from nonmatches and uncertain decisions',()=>{
  const r=record();r.candidates=[];
  assert.equal(coverageRecoveryPlan([r]).summary.noSelectedChannel,1);
  r.candidates=[{status:'not_a_match'}];
  assert.equal(coverageRecoveryPlan([r]).summary.onlyNonmatches,1);
  r.candidates=[{status:'held'}];
  assert.equal(coverageRecoveryPlan([r]).summary.heldOrUncertain,1);
});
test('new searches use bound names and target direct channels and Topic presence separately',()=>{
  const r=record(),p=coverageRecoveryPlan([r]),qs=p.recovery[0].newSearches;
  assert.equal(qs.length,2);assert.ok(qs.every(q=>q.request.q.includes('"Exact Artist"')));
  assert.match(qs[0].request.q,/site:youtube.com\/@/);
  assert.match(qs[1].request.q,/"Topic"/);
  assert.equal(p.recovery[0].importEligible,false);
});
test('rejects wrong bindings, duplicates, unsafe URLs and unbound video clues',()=>{
  const r=record();assert.throws(()=>coverageRecoveryPlan([r,r]));
  r.artist.catalogProfile.cm_artist='999';assert.throws(()=>coverageRecoveryPlan([r]));
  const valid=record();valid.discovery.allSearchCandidates.push({url:'https://youtube.com.evil.test/@bad'});
  valid.videoPlan.resolutionQueue[0].sources[0].cmArtist='999';
  const p=coverageRecoveryPlan([valid]);
  assert.equal(p.recovery[0].savedVideoLeads.length,0);
  assert.equal(p.recovery[0].savedDirectCandidates.length,1);
});
test('deduplicates video queues and does not promote held mention clues',()=>{
  const r=record(),v=r.videoPlan.resolutionQueue[0];
  r.videoPlan.deferredVideos=[structuredClone(v)];
  assert.equal(coverageRecoveryPlan([r]).recovery[0].savedVideoLeads.length,1);
  v.sources[0].videoMentionHold='distribution_credits_do_not_match_catalog_name';
  r.videoPlan.deferredVideos=[];
  assert.equal(coverageRecoveryPlan([r]).recovery[0].savedVideoLeads.length,0);
});
