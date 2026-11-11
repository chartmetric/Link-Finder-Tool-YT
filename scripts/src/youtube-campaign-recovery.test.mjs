import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {evidenceDigest,youtubeVerificationInput} from './youtube-ownership-policy.mjs';
import {MODEL_PLAN,evaluateCandidate,campaignTransport,YOUTUBE_CAMPAIGN_ID} from './youtube-campaign-core.mjs';
import {normalizeYoutubeChannel,youtubeDecisionRequest} from './youtube-ownership-transport.mjs';
import {reconcileRecovery,snapshotHash,recoveryStore,claimRecovery,approveRecovery,startRecovery,
  recoveryTransport,immutableJson,readJson} from './youtube-campaign-recovery-core.mjs';
import {artistFromMetadata,executeRecovery} from './youtube-campaign-recovery-worker.mjs';
import {freezeLocalModules} from './seal-youtube-campaign-runtime.mjs';
import {isolatedRecoveryPool} from './youtube-campaign-recovery-fixture.mjs';
import {observeRecoveredFixture} from './youtube-campaign-recovery-observer-fixture.mjs';

const at='2026-11-11T01:00:00.000Z',channelId='UC'+'a'.repeat(22),url='https://www.youtube.com/@janeartist';
const queue=[{profile_id:'1',cm_artist:'101',artist:'Jane Artist',tier:1}];
const approval={id:'fixture-only',explicitApproval:true,maximumSpendCents:null,totalArtists:1,
  scopeSha256:evidenceDigest(queue)};
const metadata={profileId:'1',cmArtist:'101',artist:'Jane Artist',
  catalogProfile:{profile_id:'1',cm_artist:'101'},chartmetric:{},linkedAccounts:[],
  releases:[],catalogTracks:[],tags:[],spotifyMetadata:null,platformSnapshots:[],profileMetadata:[]};
const search={method:'POST',url:'https://google.serper.dev/search',
  body:{q:'Jane Artist artist official YouTube channel',num:10}};
function stateFixture(){
  return {campaign:{id:'fixture-only',owner:randomUUID(),status:'stopped',scope_sha256:evidenceDigest(queue),
    approval_sha256:evidenceDigest(approval),reserved_cents:'0',maximum_spend_cents:null,total_artists:1},
  artists:queue.map((a,ordinal)=>({...a,campaign_id:'fixture-only',ordinal,status:'in_progress',likely:false})),
  admissions:[],channels:[],claims:[]};
}
// Entirely in-memory transaction store: no application tables, credentials,
// provider APIs, or catalog connections. Rollback and competing claims serialize.
function memoryStore(initial){
  let state=structuredClone(initial),tail=Promise.resolve();
  return {get state(){return state;},transaction(fn){
    const result=tail.then(async()=>{
      const next=structuredClone(state),out=await fn(next);
      if(next.nextOwner){next.campaign.owner=next.nextOwner;next.campaign.status='running';delete next.nextOwner;}
      state=next;return out;
    });
    tail=result.catch(()=>{});return result;
  }};
}
async function fixture(t,state=stateFixture(),scopeQueue=queue,scopeApproval=approval){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'youtube-recovery-fixture-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  for(const name of ['receipts','artists','metadata','inputs'])await fs.mkdir(root+'/'+name);
  await immutableJson(root+'/queue.json',scopeQueue);await immutableJson(root+'/approval.json',scopeApproval);
  await immutableJson(root+'/metadata/1.json',metadata);
  const add=async(kind,key,request,data,status=200)=>{
    const packet={at,kind,operationKey:key,status,inputSha256:evidenceDigest(request),request,data,parseFailed:false};
    const a={campaign_id:state.campaign.id,operation_key:key,profile_id:'1',kind,input_sha256:packet.inputSha256,
      reserved_cents:2,status:'returned',receipt_sha256:evidenceDigest(packet),http_status:status};
    state.admissions.push(a);state.campaign.reserved_cents=String(state.admissions.length*2);
    await immutableJson(root+'/receipts/'+evidenceDigest(key)+'.json',packet);
    return {packet,a};
  };
  const reconcile=()=>reconcileRecovery({root,snapshot:state,queue:scopeQueue,approval:scopeApproval});
  const plan=async()=>({version:1,campaignId:state.campaign.id,owner:randomUUID(),priorOwner:state.campaign.owner,
    scopeSha256:state.campaign.scope_sha256,originalApprovalSha256:state.campaign.approval_sha256,
    drained:{confirmed:true,priorOwner:state.campaign.owner,operator:'fixture operator',
      evidence:'fixture worker joined and exited',at},reconciliation:await reconcile()});
  return {root,state,add,reconcile,plan};
}
const approved=p=>({planSha256:evidenceDigest(p),owner:p.owner,priorOwner:p.priorOwner,
  explicitApproval:true,uncappedApproved:true,approvedBy:'fixture operator',at});

test('competing recovery claims serialize; preparation changes neither prior owner nor reservations',async t=>{
  const f=await fixture(t),p=await f.plan(),other={...p,owner:randomUUID()},store=memoryStore(f.state);
  const outcomes=await Promise.allSettled([claimRecovery(store,p),claimRecovery(store,other)]);
  assert.deepEqual(outcomes.map(o=>o.status),['fulfilled','rejected']);
  assert.equal(store.state.campaign.owner,p.priorOwner);
  assert.equal(store.state.campaign.reserved_cents,'0');
  await assert.rejects(()=>startRecovery(store,p),/separately recorded approval/);
  await approveRecovery(store,p,approved(p));
  assert.equal(store.state.campaign.owner,p.priorOwner,'Approval is not launch.');
  await startRecovery(store,p);assert.equal(store.state.campaign.owner,p.owner);
  await assert.rejects(()=>startRecovery(store,p));
  assert.equal(store.state.claims.length,1);
});
test('drain attestation, owner binding, exact plan approval and stale snapshots fail closed',async t=>{
  const f=await fixture(t),p=await f.plan();
  for(const changed of [{...p,drained:{...p.drained,confirmed:false}},{...p,priorOwner:randomUUID()}])
    await assert.rejects(()=>claimRecovery(memoryStore(f.state),changed));
  const store=memoryStore(f.state);await claimRecovery(store,p);
  for(const changed of [{...approved(p),owner:randomUUID()},{...approved(p),explicitApproval:false},
    {...approved(p),uncappedApproved:false},{...approved(p),planSha256:'other'}])
    await assert.rejects(()=>approveRecovery(store,p,changed));
  await store.transaction(s=>{s.channels.push({campaign_id:s.campaign.id,channel_id:channelId,profile_id:'1'});});
  await assert.rejects(()=>approveRecovery(store,p,approved(p)),/changed after preparation/);
});
test('interruption after committed admission but before journal/receipt retains reservation and blocks approval',async t=>{
  const f=await fixture(t);
  f.state.admissions.push({campaign_id:'fixture-only',operation_key:'search-1',profile_id:'1',kind:'search',
    input_sha256:evidenceDigest(search),reserved_cents:2,status:'admitted',receipt_sha256:null,http_status:null});
  f.state.campaign.reserved_cents='2';
  const p=await f.plan();
  assert.equal(p.reconciliation.reservedCents,2);
  assert.equal(p.reconciliation.blockers[0].reason,'uncertain_admission_no_retry');
  const store=memoryStore(f.state);await claimRecovery(store,p);
  await assert.rejects(()=>approveRecovery(store,p,approved(p)),/uncertain work/);
  assert.equal(store.state.admissions[0].status,'admitted');
  assert.equal(store.state.campaign.reserved_cents,'2');
});
test('local receipt saved before returned commit remains uncertain, never promoted or replayed',async t=>{
  const f=await fixture(t),{a}=await f.add('search','search-1',search,{organic:[]});
  a.status='admitted';a.receipt_sha256=null;a.http_status=null;
  const rec=await f.reconcile();assert.equal(rec.blockers[0].reason,'uncertain_admission_no_retry');
  assert.ok(rec.receipts[0].localSha256);
  const request=recoveryTransport({admissions:f.state.admissions,readReceipt:async()=>assert.fail('No read'),
    assertFrozen:async()=>{},dispatch:async()=>assert.fail('No dispatch')});
  await assert.rejects(()=>request('1','search','search-1',search),/Uncertain admission/);
  assert.equal(a.status,'admitted');assert.equal(f.state.campaign.reserved_cents,'2');
});
test('missing receipts and mismatched request, receipt hash, status or operation never become replay permission',async t=>{
  for(const mutate of [
    async(file)=>fs.unlink(file),
    async(file,p)=>fs.writeFile(file,JSON.stringify({...p,inputSha256:'b'.repeat(64)})),
    async(file,p)=>fs.writeFile(file,JSON.stringify({...p,request:{...search,body:{...search.body,q:'Other artist'}}})),
    async(file,p)=>fs.writeFile(file,JSON.stringify({...p,data:{organic:[],tampered:true}})),
    async(file,p)=>fs.writeFile(file,JSON.stringify({...p,status:500})),
    async(file,p)=>fs.writeFile(file,JSON.stringify({...p,operationKey:'different'})),
  ]){
    const f=await fixture(t),{packet}=await f.add('search','search-1',search,{organic:[]});
    await mutate(f.root+'/receipts/'+evidenceDigest('search-1')+'.json',packet);
    const rec=await f.reconcile();
    assert.ok(rec.blockers.some(b=>b.reason==='missing_or_mismatched_committed_receipt'));
    assert.equal(rec.reservedCents,2);assert.equal(f.state.admissions[0].status,'returned');
  }
});
test('all reservations, original metadata, completed results and immutable saves must reconcile',async t=>{
  const f=await fixture(t);
  await f.add('search','search-1',search,{organic:[]});
  f.state.campaign.reserved_cents='0';await assert.rejects(f.reconcile,/reservation/);
  f.state.campaign.reserved_cents='2';
  await fs.unlink(f.root+'/metadata/1.json');
  assert.ok((await f.reconcile()).blockers.some(b=>b.reason==='missing_original_artist_metadata'));
  await immutableJson(f.root+'/metadata/1.json',metadata);
  const record={artist:artistFromMetadata(metadata),searchStatus:'no_match',candidates:[]};
  await immutableJson(f.root+'/artists/1.json',record);
  f.state.artists[0].status='completed';f.state.artists[0].result_sha256=evidenceDigest(record);
  assert.equal((await f.reconcile()).results[0].sha256,evidenceDigest(record));
  await assert.rejects(()=>immutableJson(f.root+'/artists/1.json',{different:true}),/differs/);
  f.state.artists[0].result_sha256='other';await assert.rejects(f.reconcile,/result changed/);
});
async function paidCandidate(f){
  const candidate={url,title:'Jane Artist',snippet:'Official artist',sourceUrl:url,source:'serper',verified:false};
  await f.add('search','search-1',search,{organic:[{link:url,title:candidate.title,snippet:candidate.snippet}]});
  const req={method:'GET',url:'https://api.scrapecreators.com/v1/youtube/channel?'+new URLSearchParams({url})};
  const raw={success:true,channelId,channel:url,name:'Jane Artist',description:'Singer and songwriter. Official releases.',
    links:[],subscriberCount:1200};
  const {packet}=await f.add('metadata','channel-1-'+evidenceDigest(url),req,raw);
  const input=youtubeVerificationInput(artistFromMetadata(metadata),{...candidate,capture:normalizeYoutubeChannel(packet,url)});
  const prepared=youtubeDecisionRequest(input,MODEL_PLAN);
  await f.add('model','model-1-'+evidenceDigest(url),prepared.request,{
    model:MODEL_PLAN.model.expectedModel,usage:{cost:.001},answers:{
      same_identity:{noul:.8},verdict:{choice:'likely'},channel_type:{choice:'artist_owned'}}});
  return candidate;
}
test('interruption before result save reuses search, metadata and exact model answer with zero dispatch',async t=>{
  const f=await fixture(t),candidate=await paidCandidate(f);
  assert.deepEqual((await f.reconcile()).blockers,[]);
  const request=recoveryTransport({admissions:f.state.admissions,assertFrozen:async()=>{},
    readReceipt:key=>readJson(f.root+'/receipts/'+evidenceDigest(key)+'.json'),
    dispatch:async()=>assert.fail('Paid requests must not be replayed')});
  assert.equal((await request('1','search','search-1',search)).status,200);
  const checked=await evaluateCandidate({artist:artistFromMetadata(metadata),candidate,request,channelConflict:async()=>false});
  assert.equal(checked.decision.reviewSuggestion,true);assert.equal(checked.recordedAnswer.providerReportedUsd,.001);
  assert.equal(f.state.campaign.reserved_cents,'6');
  await assert.rejects(()=>request('1','search','search-1',{...search,body:{...search.body,q:'New context'}}),/differs/);
  await assert.rejects(()=>request('2','search','search-1',search));
});
test('only untouched operations dispatch and returned provider failures stay non-retryable',async t=>{
  const f=await fixture(t);let calls=0;
  await f.add('search','search-1',search,{error:'Insufficient credits'},402);
  assert.ok((await f.reconcile()).blockers.some(b=>b.reason==='returned_provider_failure_no_retry'));
  const request=recoveryTransport({admissions:f.state.admissions,assertFrozen:async()=>{},
    readReceipt:key=>readJson(f.root+'/receipts/'+evidenceDigest(key)+'.json'),dispatch:async()=>{calls++;return 'new';}});
  await assert.rejects(()=>request('1','search','search-1',search),/failure/);
  assert.equal(calls,0);
  assert.equal(await request('2','search','search-2',search),'new');assert.equal(calls,1);
});
test('preserved cross-artist channel conflict overrides a previously returned positive model answer',async t=>{
  const f=await fixture(t),candidate=await paidCandidate(f);
  const store=memoryStore(f.state);
  // A real run has both identities in its frozen queue. This test exercises
  // generation handoff and policy reuse without changing existing channel rows.
  await store.transaction(s=>{s.channels.push({campaign_id:s.campaign.id,channel_id:channelId,profile_id:'2'});});
  const plan={...(await f.plan()),reconciliation:{...(await f.reconcile()),snapshotSha256:snapshotHash(store.state)}};
  await claimRecovery(store,plan);await approveRecovery(store,plan,approved(plan));await startRecovery(store,plan);
  assert.equal(store.state.channels[0].profile_id,'2');
  const request=recoveryTransport({admissions:store.state.admissions,assertFrozen:async()=>{},
    readReceipt:key=>readJson(f.root+'/receipts/'+evidenceDigest(key)+'.json'),dispatch:async()=>assert.fail('No dispatch')});
  const checked=await evaluateCandidate({artist:artistFromMetadata(metadata),candidate,request,
    channelConflict:async id=>store.state.channels.some(c=>c.channel_id===id&&c.profile_id!=='1')});
  assert.equal(checked.decision.status,'ownership_conflict');assert.equal(checked.decision.reviewSuggestion,false);
  assert.equal(store.state.campaign.reserved_cents,'6');
  assert.equal(store.state.admissions.filter(a=>a.kind==='model').length,1);
});
test('sealing recovery copies its dependency graph without modifying source or the legacy runtime',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'youtube-recovery-seal-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const file='scripts/src/run-youtube-campaign.mjs',before=await fs.readFile(file,'utf8');
  const files=await freezeLocalModules('scripts/src/recover-youtube-campaign.mjs',directory+'/runtime');
  assert.ok([...files].some(f=>f.endsWith('/youtube-campaign-recovery-worker.mjs')));
  assert.equal(await fs.readFile(file,'utf8'),before);
  assert.equal(await fs.readFile(directory+'/runtime/run-youtube-campaign.mjs','utf8'),before);
});

async function launchFixture(f){
  const plan=await f.plan(),pool=isolatedRecoveryPool(f.state),store=recoveryStore(pool,f.state.campaign.id);
  await claimRecovery(store,plan);await approveRecovery(store,plan,approved(plan));
  const directory=f.root+'/recovery';await fs.mkdir(directory);await fs.mkdir(directory+'/inputs');
  return {plan,pool,directory,assertFrozen:async()=>{},root:f.root,credentials:{serper:'fixture-only'},
    selectImpl:async()=>JSON.parse(await fs.readFile(f.root+'/queue.json','utf8'))};
}
test('separately approved SQL recovery completes an interrupted artist without charging saved requests again',async t=>{
  const f=await fixture(t);await paidCandidate(f);
  const before=structuredClone(f.state.admissions),h=await launchFixture(f);
  await executeRecovery({...h,fetchImpl:async()=>assert.fail('No network dispatch for returned evidence')});
  assert.deepEqual(h.pool.failures,[]);
  assert.equal(h.pool.state.campaign.status,'completed');
  assert.equal(h.pool.state.campaign.owner,h.plan.owner);
  assert.equal(h.pool.state.campaign.reserved_cents,'6');
  assert.deepEqual(h.pool.state.admissions,before);
  assert.equal(h.pool.state.artists[0].status,'completed');
  assert.equal(h.pool.state.artists[0].likely,true);
  assert.equal((await readJson(f.root+'/artists/1.json')).candidates[0].recordedAnswer.answer.verdict,'likely');
  assert.ok(h.pool.queries.some(q=>q==='SELECT * FROM youtube_link_campaigns WHERE id=$1 FOR UPDATE'));
  assert.ok(!h.pool.queries.some(q=>/DELETE|TRUNCATE|reserved_cents=0/.test(q)));
});
test('interruption after result file save but before coordinator commit preserves and commits that exact file',async t=>{
  const f=await fixture(t);const candidate=await paidCandidate(f);
  const request=recoveryTransport({admissions:f.state.admissions,assertFrozen:async()=>{},
    readReceipt:key=>readJson(f.root+'/receipts/'+evidenceDigest(key)+'.json'),dispatch:async()=>assert.fail('No dispatch')});
  const checked=await evaluateCandidate({artist:artistFromMetadata(metadata),candidate,request,channelConflict:async()=>false});
  const record={artist:artistFromMetadata(metadata),searchStatus:'candidates_found',candidates:[checked]};
  await immutableJson(f.root+'/artists/1.json',record);
  const original=await fs.readFile(f.root+'/artists/1.json','utf8'),h=await launchFixture(f);
  await executeRecovery({...h,fetchImpl:async()=>assert.fail('No dispatch')});
  assert.equal(await fs.readFile(f.root+'/artists/1.json','utf8'),original);
  assert.equal(h.pool.state.artists[0].result_sha256,evidenceDigest(record));
  assert.equal(h.pool.state.campaign.reserved_cents,'6');
});
test('SQL recovery preserves global channel holds for both the resumed artist and an earlier completed positive',async t=>{
  const fullQueue=[...queue,{profile_id:'2',cm_artist:'102',artist:'Second Artist',tier:2}];
  const fullApproval={...approval,totalArtists:2,scopeSha256:evidenceDigest(fullQueue)};
  const s=stateFixture();Object.assign(s.campaign,{total_artists:2,scope_sha256:evidenceDigest(fullQueue),
    approval_sha256:evidenceDigest(fullApproval)});
  const priorRecord={artist:{profileId:'2',cmArtist:'102'},candidates:[{decision:{reviewSuggestion:true}}]};
  s.artists.push({...fullQueue[1],campaign_id:s.campaign.id,ordinal:1,status:'completed',
    likely:true,result_sha256:evidenceDigest(priorRecord)});
  s.channels.push({campaign_id:s.campaign.id,channel_id:channelId,profile_id:'2'});
  const f=await fixture(t,s,fullQueue,fullApproval);await paidCandidate(f);
  await immutableJson(f.root+'/artists/2.json',priorRecord);
  const oldFile=await fs.readFile(f.root+'/artists/2.json','utf8'),h=await launchFixture(f);
  await executeRecovery({...h,fetchImpl:async()=>assert.fail('No dispatch')});
  assert.equal(h.pool.state.campaign.status,'completed');
  assert.equal(h.pool.state.channels.length,2);
  assert.ok(h.pool.state.artists.every(a=>a.likely===false&&a.reason==='channel_reused_across_catalog_artists'));
  assert.equal(await fs.readFile(f.root+'/artists/2.json','utf8'),oldFile);
  assert.equal((await readJson(f.root+'/artists/1.json')).candidates[0].decision.status,'ownership_conflict');
  assert.equal(h.pool.state.campaign.reserved_cents,'6');
});
test('SQL recovery dispatches only untouched work with additional reservations, receipts and owner fences',async t=>{
  const f=await fixture(t),h=await launchFixture(f);let calls=0;
  await executeRecovery({...h,fetchImpl:async()=>{
    calls++;return new Response(JSON.stringify({organic:[]}),{status:200});
  }});
  assert.equal(calls,1);assert.deepEqual(h.pool.failures,[]);
  assert.equal(h.pool.state.campaign.reserved_cents,'2');
  assert.equal(h.pool.state.admissions[0].status,'returned');
  assert.equal(h.pool.state.artists[0].searched,true);
  assert.equal(h.pool.state.artists[0].checked,false);
  assert.equal((await fs.readdir(f.root+'/receipts')).length,1);
});
test('receipt loss after approval blocks SQL handoff before any owner or reservation change',async t=>{
  const f=await fixture(t);await f.add('search','search-1',search,{organic:[]});
  const h=await launchFixture(f);
  await fs.unlink(f.root+'/receipts/'+evidenceDigest('search-1')+'.json');
  await assert.rejects(()=>executeRecovery({...h,fetchImpl:async()=>assert.fail('No dispatch')}));
  assert.equal(h.pool.state.campaign.owner,h.plan.priorOwner);
  assert.equal(h.pool.state.campaign.reserved_cents,'2');
  assert.equal(h.pool.state.claims[0].status,'approved');
});
test('a new interrupted dispatch remains admitted and stops this recovery without replay or refund',async t=>{
  const f=await fixture(t),h=await launchFixture(f);let calls=0;
  await assert.rejects(()=>executeRecovery({...h,fetchImpl:async()=>{calls++;throw Error('fixture connection lost');}}));
  assert.equal(calls,1);assert.equal(h.pool.state.campaign.status,'stopped');
  assert.equal(h.pool.state.claims[0].status,'stopped');
  assert.equal(h.pool.state.campaign.reserved_cents,'2');
  assert.equal(h.pool.state.admissions[0].status,'admitted');
  await assert.rejects(()=>executeRecovery({...h,fetchImpl:async()=>{calls++;assert.fail('No replay');}}));
  assert.equal(calls,1);assert.equal(h.pool.state.campaign.reserved_cents,'2');
});
test('interruption immediately after admission commit and before journal append cannot authorize dispatch',async t=>{
  const f=await fixture(t);
  await fs.mkdir(f.root+'/admissions.jsonl'); // Force the post-commit write to fail.
  let calls=0;
  const request=campaignTransport({root:f.root,assertFrozen:async()=>{},credentials:{serper:'fixture-only'},
    fetchImpl:async()=>{calls++;assert.fail('Journal write failed before dispatch');},
    admit:async op=>{
      f.state.admissions.push({campaign_id:f.state.campaign.id,operation_key:op.key,profile_id:op.profileId,
        kind:op.kind,input_sha256:op.inputSha256,reserved_cents:2,status:'admitted'});
      f.state.campaign.reserved_cents='2';
    },returned:async()=>assert.fail('No receipt can be returned')});
  await assert.rejects(()=>request('1','search','search-1',search));
  assert.equal(calls,0);
  assert.equal((await f.reconcile()).blockers[0].reason,'uncertain_admission_no_retry');
  assert.equal(f.state.campaign.reserved_cents,'2');
});
test('interruption after durable receipt save but before returned commit preserves an uncertain charge',async t=>{
  const f=await fixture(t);let calls=0;
  const request=campaignTransport({root:f.root,assertFrozen:async()=>{},credentials:{serper:'fixture-only'},
    fetchImpl:async()=>{calls++;return new Response(JSON.stringify({organic:[]}),{status:200});},
    admit:async op=>{
      f.state.admissions.push({campaign_id:f.state.campaign.id,operation_key:op.key,profile_id:op.profileId,
        kind:op.kind,input_sha256:op.inputSha256,reserved_cents:2,status:'admitted'});
      f.state.campaign.reserved_cents='2';
    },returned:async()=>{throw Error('fixture interrupted before returned commit');}});
  await assert.rejects(()=>request('1','search','search-1',search));
  assert.equal(calls,1);assert.equal((await fs.readdir(f.root+'/receipts')).length,1);
  const rec=await f.reconcile();
  assert.ok(rec.receipts[0].localSha256);assert.equal(rec.blockers[0].reason,'uncertain_admission_no_retry');
  assert.equal(f.state.admissions[0].status,'admitted');assert.equal(f.state.campaign.reserved_cents,'2');
});
for(const hasExistingInput of [false,true])test(
  `real read-only observer archives recovered candidates with ${hasExistingInput?'an existing':'no prior'} input file`,async t=>{
  const actualApproval={...approval,id:YOUTUBE_CAMPAIGN_ID},s=stateFixture();
  Object.assign(s.campaign,{id:YOUTUBE_CAMPAIGN_ID,approval_sha256:evidenceDigest(actualApproval),updated_at:new Date(at)});
  for(const a of s.artists)a.campaign_id=YOUTUBE_CAMPAIGN_ID;
  const f=await fixture(t,s,queue,actualApproval),candidate=await paidCandidate(f);
  const request=recoveryTransport({admissions:f.state.admissions,assertFrozen:async()=>{},
    readReceipt:key=>readJson(f.root+'/receipts/'+evidenceDigest(key)+'.json'),dispatch:async()=>assert.fail('No dispatch')});
  const checked=await evaluateCandidate({artist:artistFromMetadata(metadata),candidate,request,channelConflict:async()=>false});
  const relative='inputs/1-'+evidenceDigest(url)+'.json';
  if(hasExistingInput)await immutableJson(f.root+'/'+relative,checked);
  const original=JSON.stringify(checked),h=await launchFixture(f);
  await executeRecovery({...h,fetchImpl:async()=>assert.fail('No dispatch')});
  assert.equal(await fs.readFile(f.root+'/'+relative,'utf8'),original,'Existing input must be retained exactly.');
  const observed=await observeRecoveredFixture({directory:h.directory,root:f.root,state:h.pool.state});
  assert.equal(observed.progress.status,'completed');
  assert.equal(observed.progress.searchedArtists,1);assert.equal(observed.progress.checkedArtists,1);
  assert.equal(observed.progress.likelyMatches,1);assert.equal(observed.progress.reservedUsd,.06);
  assert.equal(await fs.readFile(observed.archive+'/youtube-campaign-archive/'+YOUTUBE_CAMPAIGN_ID+'/'+relative,'utf8'),original);
  assert.equal((await readJson(observed.archive+'/youtube-campaign-archive/'+YOUTUBE_CAMPAIGN_ID+'/artists/1.json')).candidates.length,1);
});
test('mismatched existing original candidate input is preserved and stops recovery before artist completion',async t=>{
  const f=await fixture(t);await paidCandidate(f);
  const file=f.root+'/inputs/1-'+evidenceDigest(url)+'.json',previous={saved:'different interrupted candidate evidence'};
  await immutableJson(file,previous);
  const original=await fs.readFile(file,'utf8'),h=await launchFixture(f);
  await assert.rejects(()=>executeRecovery({...h,fetchImpl:async()=>assert.fail('No dispatch')}));
  assert.equal(await fs.readFile(file,'utf8'),original);
  assert.equal(h.pool.state.campaign.status,'stopped');assert.equal(h.pool.state.artists[0].status,'failed');
  assert.equal(h.pool.state.campaign.reserved_cents,'6');
  await assert.rejects(()=>fs.readFile(f.root+'/artists/1.json'),{code:'ENOENT'});
});
