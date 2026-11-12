// Run with --import ./scripts/src/youtube-ownership-offline-fence.mjs.
// All provider/model replies below are synthetic, not historical rechecks.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {captureYoutubeCandidates,consolidateYoutubeCandidates,YOUTUBE_CANDIDATE_POLICY} from './youtube-candidate-consolidation.mjs';
import {normalizeYoutubeChannel,youtubeDecisionRequest,parseYoutubeDecision} from './youtube-ownership-transport.mjs';
import {evidenceDigest,evaluateYoutubeOwnership,youtubeVerificationInput,reviewYoutubeBatch} from './youtube-ownership-policy.mjs';

const id='UC'+'a'.repeat(22),otherId='UC'+'b'.repeat(22);
const handle='https://www.youtube.com/@artist',idUrl='https://www.youtube.com/channel/'+id;
const spotify='https://open.spotify.com/artist/'+'A'.repeat(22);
const artist={profileId:'1',cmArtist:'2',name:'Artist',
  catalogProfile:{profile_id:'1',cm_artist:'2'},accounts:[{url:spotify}]};
const secondArtist={...artist,profileId:'3',cmArtist:'4',catalogProfile:{profile_id:'3',cm_artist:'4'}};
const candidates=()=>[{url:handle,title:'Artist',snippet:'Handle search result'},
  {url:idUrl,title:'Artist official',snippet:'ID search result',sourceUrl:idUrl+'/videos'}];
function receipt(url,patch={}){
  const request={method:'GET',url:'https://api.scrapecreators.com/v1/youtube/channel?'+new URLSearchParams({url})};
  return {kind:'metadata',status:200,at:'2026-11-11T01:00:00Z',request,
    inputSha256:evidenceDigest(request),data:{success:true,channelId:id,
      channel:handle,name:'Artist',description:'Music',links:[spotify],...patch}};
}
const capture=(url,patch)=>normalizeYoutubeChannel(receipt(url,patch),url);
const plan={model:{endpoint:'https://openrouter.ai/api/alpha/decisions',
  expectedModel:'typesafe/jev-1.13',maxRequestBytes:64000}};
async function check(groups,a=artist){
  let calls=0;
  for(const c of groups){
    const constraints={contradictoryPair:c.contradictoryPair===true};
    let decision=evaluateYoutubeOwnership(a,c,constraints);
    if(decision.status==='needs_identity_check'){
      const input=youtubeVerificationInput(a,c),prepared=youtubeDecisionRequest(input,plan);
      assert.ok(prepared.ready);calls++;
      const packet={request:prepared.request,inputSha256:prepared.inputSha256,status:200,
        data:{model:plan.model.expectedModel,usage:{cost:.001},answers:{
          same_identity:{noul:.54},verdict:{choice:'likely'},channel_type:{choice:'unknown'}}}};
      c.recordedAnswer=parseYoutubeDecision(packet,input,plan,prepared.inputSha256);
      decision=evaluateYoutubeOwnership(a,c,{...constraints,answer:c.recordedAnswer});
    }
    c.decision=decision;
  }
  return calls;
}

test('Provider-bound handle and ID need one metadata observation and one model check, with provenance intact',async()=>{
  const originals=candidates(),before=structuredClone(originals),admissions=[];
  const groups=await captureYoutubeCandidates(artist,originals,async c=>{
    admissions.push({key:'metadata-'+artist.profileId+'-'+evidenceDigest(c.url),reservedCents:2});
    return capture(c.url,{links:[spotify.replace('/artist/','/intl-pt/artist/')]});
  });
  assert.equal(groups.length,1);assert.equal(admissions.length,1);
  const c=groups[0];
  assert.equal(c.consolidation.policy,YOUTUBE_CANDIDATE_POLICY);
  assert.equal(c.consolidation.profileId,artist.profileId);
  assert.equal(c.consolidation.channelId,id);
  assert.equal(c.aliasProvenance.length,2);
  assert.equal(c.aliasProvenance[0].capture.rawReceiptSha256,c.capture.rawReceiptSha256);
  assert.equal(c.aliasProvenance[0].capture.requestedUrl,handle);
  assert.equal(c.aliasProvenance[1].capture,null);
  assert.equal(c.aliasProvenance[1].metadataReusedFrom.candidateUrl,handle);
  assert.equal(c.aliasProvenance[1].sourceUrl,idUrl+'/videos');
  assert.ok(c.providerAliases.includes(idUrl));
  assert.equal(await check(groups),1);
  assert.equal(c.decision.reason,'recorded_model_uncertain_or_unresolved_channel_type');
  assert.equal(c.decision.score,.54);assert.equal(c.decision.reviewSuggestion,false);
  assert.deepEqual(originals,before);
  assert.deepEqual(admissions,[{key:'metadata-'+artist.profileId+'-'+evidenceDigest(handle),reservedCents:2}]);
});

test('Two already obtained observations consolidate without deleting or refunding either reservation',async()=>{
  const observations=candidates().map(c=>({...c,capture:capture(c.url)}));
  const reservations=observations.map(c=>({key:evidenceDigest(c.url),reservedCents:2,status:'returned'}));
  const before=structuredClone(reservations),originals=structuredClone(observations);
  const groups=consolidateYoutubeCandidates(artist,observations);
  assert.equal(groups.length,1);
  assert.deepEqual(groups[0].aliasProvenance,observations);
  assert.notEqual(groups[0].aliasProvenance[0],observations[0]);
  assert.equal(await check(groups),1);
  assert.deepEqual(reservations,before);assert.deepEqual(observations,originals);
  assert.equal(reservations.reduce((n,r)=>n+r.reservedCents,0),4);
});

test('Same names and unbound, failed or spoofed captures never deduplicate',async()=>{
  const different=[{url:handle,title:'Artist'},{url:'https://www.youtube.com/@other',title:'Artist'}];
  let calls=0;
  const groups=await captureYoutubeCandidates(artist,different,async c=>{
    calls++;return capture(c.url,c.url===handle?{}:{channelId:otherId,channel:c.url});
  });
  assert.equal(groups.length,2);assert.equal(calls,2);assert.equal(await check(groups),2);
  for(const invalid of [null,{...capture(handle),bodySha256:'0'.repeat(64)},
    capture(handle,{channel:'https://www.youtube.com.evil.test/@artist'})]){
    let attempted=0;
    const result=await captureYoutubeCandidates(artist,candidates(),async()=>{attempted++;return invalid;});
    assert.equal(attempted,2);assert.equal(result.length,2);
  }
});

test('Metadata and assessments are never shared across artists, and reused channels remain conflicts',async()=>{
  let calls=0;
  const collect=a=>captureYoutubeCandidates(a,candidates(),async c=>{calls++;return capture(c.url);});
  const first=await collect(artist),second=await collect(secondArtist);
  assert.equal(calls,2);
  const reviews=reviewYoutubeBatch([{artist,candidates:first},{artist:secondArtist,candidates:second}]);
  assert.ok(reviews.every(r=>r.outcome==='ownership_conflict'));
  assert.ok(reviews.every(r=>!r.candidates[0].decision.reviewSuggestion));
  await check(first);await check(second,secondArtist);
  assert.notEqual(first[0].recordedAnswer.inputSha256,second[0].recordedAnswer.inputSha256);
  assert.throws(()=>consolidateYoutubeCandidates(artist,first),/fresh candidates/);
});

test('Conflicting captures, artist IDs and role evidence cannot be hidden behind an alias',async()=>{
  for(const patch of [
    {links:['https://open.spotify.com/intl-pt/artist/'+'B'.repeat(22)]},
    {isAutoGenerated:true},{description:'Fan channel for Artist'},
    {description:'Independent record label'},
  ]){
    const observations=candidates().map((c,i)=>({...c,capture:capture(c.url,i?patch:{})}));
    const before=structuredClone(observations);
    const groups=consolidateYoutubeCandidates(artist,observations);
    assert.equal(groups.length,1);assert.equal(groups[0].contradictoryPair,true);
    assert.equal(await check(groups),0);
    assert.equal(groups[0].decision.status,'ownership_conflict');
    assert.deepEqual(groups[0].aliasProvenance,before);
  }
});

test('Provider-alias reuse references cannot substitute another URL, ID or capture',()=>{
  const first={url:handle,capture:capture(handle)};
  const reused={url:idUrl,capture:null,metadataReusedFrom:{candidateUrl:handle,channelId:id,
    bodySha256:first.capture.bodySha256,rawReceiptSha256:first.capture.rawReceiptSha256}};
  for(const patch of [{candidateUrl:idUrl},{channelId:otherId},{bodySha256:'0'.repeat(64)},
    {rawReceiptSha256:'0'.repeat(64)}]){
    assert.throws(()=>consolidateYoutubeCandidates(artist,
      [first,{...reused,metadataReusedFrom:{...reused.metadataReusedFrom,...patch}}]),/exact local/);
  }
  assert.throws(()=>consolidateYoutubeCandidates(artist,
    [first,{...reused,url:'https://www.youtube.com/@unobserved'}]),/exact local/);
});

test('Channel-ID-first and receipt-backed legacy aliases consolidate without inventing captures',async()=>{
  for(const firstUrl of [idUrl,'https://www.youtube.com/c/ArtistArchive']){
    const inputs=[{url:firstUrl},{url:handle},{url:idUrl}];
    let calls=0;
    const groups=await captureYoutubeCandidates(artist,inputs,async c=>{calls++;return capture(c.url);});
    assert.equal(calls,1);assert.equal(groups.length,1);
    assert.equal(groups[0].aliasProvenance.length,3);
    assert.equal(groups[0].capture.requestedUrl,firstUrl);
    assert.ok(groups[0].aliasProvenance.slice(1).every(c=>c.capture===null));
    assert.equal(await check(groups),1);
  }
});

test('A failure after one returned capture cannot erase its reservation or retry the failed call',async()=>{
  const admissions=[],returned=[];
  const inputs=[{url:handle},{url:'https://www.youtube.com/@separate'}];
  await assert.rejects(captureYoutubeCandidates(artist,inputs,async c=>{
    admissions.push({key:evidenceDigest(c.url),reservedCents:2});
    if(c.url!==handle)throw Error('uncertain request');
    const result=capture(c.url);
    returned.push(result.rawReceiptSha256);return result;
  }),/uncertain request/);
  assert.equal(admissions.length,2);assert.equal(returned.length,1);
  assert.equal(admissions.reduce((n,r)=>n+r.reservedCents,0),4);
});

test('The bounded runner opts in only on new approvals and retains conflict constraints and export provenance',async()=>{
  const source=await readFile(new URL('./run-youtube-bounded-test.mjs',import.meta.url),'utf8');
  assert.match(source,/candidatePolicy:YOUTUBE_CANDIDATE_POLICY/);
  assert.match(source,/assert\.equal\(scope\.candidatePolicy,YOUTUBE_CANDIDATE_POLICY/);
  assert.match(source,/await captureYoutubeCandidates\(artist,discovery\.candidates/);
  assert.match(source,/rankYoutubeSearchCandidates\(youtubeSearchCandidates\(response\.data\),searchPlan,\{limit:2,includeTopicChannels:scope.includeTopicChannels\}\)/);
  assert.match(source,/assert.equal\(scope.youtubeLinkPolicy,YOUTUBE_LINK_POLICY/);
  assert.match(source,/assert.equal\(scope.includeTopicChannels,true\)/);
  assert.match(source,/relatedTopicCandidates:discovery\.topicCandidates/);
  assert.match(source,/collectTargetPlatformMetadata\(manifest,\{targetPlatform:'youtube'\}\)/);
  assert.match(source,/assert\.equal\(scope\.discoveryPolicyVersion,1/);
  assert.match(source,/status:r\.outcome,channelAbsenceProven:false/);
  assert.match(source,/explicitApproval:false,approvalStatus:'awaiting_spending_approval'/);
  assert.match(source,/assert\.equal\(scope\.explicitApproval,true\)/);
  assert.match(source,/assert\.equal\(hash\(await read\(root\+'\/plan\.json'\)\),scope\.planSha256\)/);
  assert.match(source,/contradictoryPair:candidate\.contradictoryPair===true/);
  assert.match(source,/alias_provenance:c\.aliasProvenance/);
});
