import test from 'node:test';
import assert from 'node:assert/strict';
import {digest} from './youtube-video-discovery-offline.mjs';
import {recoverCoverageArtist,recoveryQueues,assertCoverageAdmission,CoverageLimit,
  recoverySearchCandidates} from './youtube-coverage-execution.mjs';
import {coverageRequest,coverageGate,historicalCoveragePacket} from './youtube-coverage-live.mjs';

const id='UC'+'z'.repeat(22),spotify='https://open.spotify.com/artist/3UvBjnS0xNdifivRctkxok';
function fixture(){
  const record={artist:{profileId:'1',cmArtist:'2',name:'Exact Artist',
    catalogProfile:{profile_id:'1',cm_artist:'2',name:'Exact Artist'},
    accounts:[{profile_id:'1',cm_artist:'2',platform:'spotify',is_active:1,
      account_url:spotify,disconnected_at:null}],releases:[]},
  tier:2,candidates:[{url:'https://www.youtube.com/@rejected',status:'not_a_match'}],videoContexts:[]};
  const recovery={profileId:'1',cmArtist:'2',savedDirectCandidates:[],
    savedVideoLeads:[{videoId:'abcdefghijk',url:'https://www.youtube.com/watch?v=abcdefghijk'}],
    newSearches:[{request:{q:'"Exact Artist" "Topic" site:youtube.com/channel/',num:10}}]};
  const calls=[];
  async function request(artist,kind,request){
    calls.push({kind,request});
    let data;
    if(kind==='model')data={model:'typesafe/jev-1.13',usage:{cost:.0001},
      answers:{combined_assessment:{type:'choice',choice:'artist_representation_supported'}}};
    else if(kind==='search')data={organic:[]};
    else if(request.url.includes('/video?'))data={success:true,id:'abcdefghijk',
      channel:{id,title:'Exact Artist'},uploader:{channelId:id},title:'Exact Artist — Song'};
    else data={success:true,channelId:id,channel:'https://www.youtube.com/channel/'+id,
      name:'Exact Artist',description:'My music project.',links:[spotify]};
    const raw=Buffer.from(JSON.stringify(data));
    return {kind,status:200,profileId:artist.profileId,cmArtist:artist.cmArtist,request,
      inputSha256:digest(request),data,rawBodyBase64:raw.toString('base64'),
      rawBodySha256:digest(raw),sourcePath:'generated-artifacts/test/receipt.json',at:'2026-11-18T00:00:00Z'};
  }
  return {record,recovery,calls,request,queues:recoveryQueues(record,recovery),conflicts:async()=>false};
}
test('rejected direct candidate no longer prevents video recovery and exact identity assessment',async()=>{
  const f=fixture();await recoverCoverageArtist({...f,round:0});
  assert.deepEqual(f.calls.map(c=>c.kind),['metadata','metadata','model']);
  assert.equal(f.record.candidates[1].status,'review_suggestion');
  assert.equal(f.record.candidates[1].assessment.ownershipAccepted,false);
  assert.equal(f.record.candidates[1].assessment.importEligible,false);
  await recoverCoverageArtist({...f,round:1});
  assert.equal(f.calls.length,3,'A suggestion stops further recovery for this artist');
});
test('conflicting uploader fields are held without channel selection or further paid checks',async()=>{
  const f=fixture(),original=f.request;
  f.request=async(...args)=>{
    const p=await original(...args);
    if(p.data.channel){p.data.uploader.channelId='UC'+'x'.repeat(22);
      const raw=Buffer.from(JSON.stringify(p.data));p.rawBodySha256=digest(raw);p.rawBodyBase64=raw.toString('base64');}
    return p;
  };
  await recoverCoverageArtist({...f,round:0});
  assert.equal(f.calls.length,1);
  assert.equal(f.record.candidates.length,1);
  assert.equal(f.record.recoveryEvents[0].kind,'conflicting_uploader');
});
test('shared channels cannot become suggestions',async()=>{
  const f=fixture();f.conflicts=async()=>true;
  await recoverCoverageArtist({...f,round:0});
  assert.deepEqual(f.calls.map(c=>c.kind),['metadata','metadata']);
  assert.equal(f.record.candidates[1].status,'held');
});
test('targeted search is only reached after saved leads and missing results fail closed',async()=>{
  const f=fixture();f.queues.videos=[];
  await recoverCoverageArtist({...f,round:0});
  assert.deepEqual(f.calls.map(c=>c.kind),['search']);
  assert.throws(()=>recoverySearchCandidates({error:'failure'}));
  const channels=recoverySearchCandidates({organic:[
    {link:'https://www.youtube.com/@ExactArtist/videos',title:'Exact Artist'},
    {link:'https://www.youtube.com/@ExactArtist',title:'duplicate'},
    {link:'https://youtube.com.evil.test/@bad'},
    {link:'https://www.youtube.com/watch?v=abcdefghijk'}]});
  assert.equal(channels.length,1);
  assert.equal(channels[0].url,'https://www.youtube.com/@ExactArtist');
});
function admission(){
  return {run:{owner:'owner',status:'running',scope_sha256:'scope',cap_cents:1000,reserved_cents:998},
    owner:'owner',scopeHash:'scope',approvalHash:'approval',
    operation:{profileId:'1',kind:'metadata',inputSha256:'new',approvalHash:'approval'},
    history:[],pending:[],live:new Map()};
}
test('shared cap allows the final two cents and refuses further spend or per-artist excess',()=>{
  const a=admission();assert.doesNotThrow(()=>assertCoverageAdmission(a));
  a.run.reserved_cents=1000;assert.throws(()=>assertCoverageAdmission(a),CoverageLimit);
  a.run.reserved_cents=0;a.history=Array.from({length:6},()=>({kind:'metadata',status:'returned'}));
  assert.throws(()=>assertCoverageAdmission(a),CoverageLimit);
});
test('unknown pending work, stale owner, old hashes, and unreturned outcomes prevent dispatch',()=>{
  for(const mutate of [
    a=>a.run.owner='other',
    a=>a.operation.approvalHash='other',
    a=>a.history.push({status:'admitted'}),
    a=>a.history.push({status:'returned',kind:'metadata',input_sha256:'new'}),
    a=>a.pending.push({operation_key:'unknown',profile_id:'2',kind:'metadata',input_sha256:'unknown'}),
  ]){
    const a=admission();mutate(a);assert.throws(()=>assertCoverageAdmission(a));
  }
});
test('an unapproved search is rejected before the ledger, filesystem or network is reached',async()=>{
  let queries=0,network=0;
  const request=coverageRequest({pool:{async query(){queries++;}},root:'unused',
    plan:{recovery:{recovery:[{profileId:'1',cmArtist:'2',newSearches:[]}]}},
    gate:{},check:async()=>{},fetchImpl:async()=>{network++;}});
  await assert.rejects(()=>request({profileId:'1',cmArtist:'2'},'search',
    {method:'POST',url:'https://google.serper.dev/search',body:{q:'not approved'}}),/Unapproved query/);
  assert.equal(queries,0);assert.equal(network,0);
});
test('the real gate rolls back at the cap without inserting an admission',async()=>{
  const statements=[];
  const client={release(){},async query(sql){
    statements.push(sql);
    if(sql.includes('FROM youtube_link_campaigns WHERE id='))return {rows:[{status:'stopped'}]};
    if(sql.includes('SELECT * FROM youtube_discovery_test_runs'))return {rows:[admission().run]};
    if(sql.includes('count(*)'))return {rows:[{n:0}]};
    return {rows:[]};
  }};
  const plan={id:'test',parentId:'parent',scopeSha256:'scope'},approval={approved:true};
  const gate=coverageGate({pool:{connect:async()=>client},plan,approval,owner:'owner'});
  client.query=async sql=>{
    statements.push(sql);
    if(sql.includes('FROM youtube_link_campaigns WHERE id='))return {rows:[{status:'stopped'}]};
    if(sql.includes('SELECT * FROM youtube_discovery_test_runs'))
      return {rows:[{...admission().run,reserved_cents:1000}]};
    if(sql.includes('count(*)'))return {rows:[{n:0}]};
    return {rows:[]};
  };
  await assert.rejects(()=>gate.admit({profileId:'1',kind:'metadata',key:'test',inputSha256:'new'}),CoverageLimit);
  assert.ok(statements.includes('ROLLBACK'));
  assert.ok(!statements.some(s=>s.startsWith('INSERT')));
});
test('an acknowledged missing resource is not replayed or treated as a successful capture',async()=>{
  const row={status:'returned',http_status:404,kind:'metadata'};
  await assert.rejects(()=>historicalCoveragePacket(row,{url:'https://example.test'},{profileId:'1'}),
    error=>error.code==='COVERAGE_RESOURCE_MISSING');
  await assert.rejects(()=>historicalCoveragePacket({...row,status:'admitted'},
    {url:'https://example.test'},{profileId:'1'}),/Uncertain/);
});
test('a continuation must count ancestor reservations and existing per-artist calls',()=>{
  const a=admission();
  a.run.reserved_cents=710+288;assert.doesNotThrow(()=>assertCoverageAdmission(a));
  a.run.reserved_cents=710+290;assert.throws(()=>assertCoverageAdmission(a),CoverageLimit);
  a.run.reserved_cents=710;
  a.history=Array.from({length:12},(_,i)=>({status:'returned',kind:i%2?'model':'metadata'}));
  assert.throws(()=>assertCoverageAdmission(a),CoverageLimit);
});
