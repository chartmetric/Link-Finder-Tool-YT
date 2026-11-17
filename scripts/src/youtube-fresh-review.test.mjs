import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import {digest} from './youtube-video-discovery-offline.mjs';
import {freshReviewGate,freshReviewPlan,approveFreshReview,FRESH_REVIEW_POLICY} from './youtube-fresh-review.mjs';
import {reviewBatchArtist,reviewBatchRows,REVIEW_BATCH_POLICY} from './youtube-review-batch.mjs';
import {REPRESENTATION_VERSION,REPRESENTATION_ASSESSMENTS} from './youtube-artist-representation.mjs';
import {reviewBatchRequest} from './run-youtube-review-batch.mjs';

function planFixture(){
  const artists=Array.from({length:100},(_,i)=>({profile_id:String(i+1),cm_artist:String(i+101),tier:2}));
  const packets=artists.map(a=>({profileId:a.profile_id,cmArtist:a.cm_artist}));
  return freshReviewPlan({id:'youtube-test-100-review-repr-synthetic',sourceRoot:'generated-artifacts/youtube-batch-100-synthetic',
    version:REVIEW_BATCH_POLICY,freshPolicy:FRESH_REVIEW_POLICY,verificationPolicy:REPRESENTATION_VERSION,
    parallelism:16,providerIntervalMs:100,sourceReservedCents:0,experimentOnly:true,
    preparedAt:'2026-11-17T00:00:00Z',artists,packets,scopeSha256:digest(artists),
    catalogEvidenceSha256:digest(packets),maximumSpendCents:1000,maximumCalls:500,maximumCallsPerArtist:5,
    sourceFiles:{'generated-artifacts/synthetic.json':'a'.repeat(64)},runtimeFiles:{'runtime/synthetic.mjs':'b'.repeat(64)},
    pricing:{id:'typesafe/jev-1.13',promptUsdPerToken:'0.000000042',completionUsdPerToken:'0',contextTokens:262144}});
}
function gateFixture(){
  const plan=planFixture(),approval=approveFreshReview(plan,{planSha256:digest(plan),capCents:1000,approvedAt:'2026-11-17T01:00:00Z'});
  let rows=[],reserved=0,before;
  const run={id:plan.id,owner:'test-owner',status:'running',scope_sha256:plan.scopeSha256,cap_cents:1000};
  const c={release(){},async query(sql,a=[]){
    sql=sql.replace(/\s+/g,' ').trim();
    if(sql==='BEGIN'){before=structuredClone({rows,reserved});return {};}
    if(sql==='COMMIT'||sql.startsWith('SET LOCAL'))return {};
    if(sql==='ROLLBACK'){({rows,reserved}=before);return {};}
    if(sql.startsWith('SELECT status FROM youtube_link_campaigns'))return {rows:[{status:'stopped'}]};
    if(sql.startsWith('SELECT * FROM youtube_discovery_test_runs'))return {rows:[{...run,reserved_cents:reserved}]};
    if(sql.startsWith('SELECT count(*)'))return {rows:[{n:sql.includes('youtube_bounded_test_admissions')
      ?rows.filter(r=>r.status==='admitted'&&r.run_id!==a[0]).length:0}]};
    if(sql.startsWith('SELECT operation_key,profile_id,kind,input_sha256'))return {rows:rows.filter(r=>r.run_id===a[0]&&r.status==='admitted')};
    if(sql.startsWith('SELECT operation_key,kind,status'))return {rows:rows.filter(r=>r.run_id===a[0]&&r.profile_id===a[1])};
    if(sql.startsWith('INSERT INTO youtube_bounded_test_admissions')){
      assert.ok(!rows.some(r=>r.run_id===a[0]&&r.operation_key===a[1]));
      rows.push({run_id:a[0],operation_key:a[1],profile_id:a[2],kind:a[3],input_sha256:a[4],status:'admitted'});return {rowCount:1};
    }
    if(sql.startsWith('UPDATE youtube_discovery_test_runs SET reserved_cents')){
      if(run.owner!==a[1]||run.status!=='running'||reserved+2>1000)return {rowCount:0};
      reserved+=2;return {rowCount:1};
    }
    if(sql.startsWith("UPDATE youtube_bounded_test_admissions a SET status='returned'")){
      const r=rows.find(r=>r.run_id===a[0]&&r.operation_key===a[1]&&r.profile_id===a[2]&&
        r.input_sha256===a[3]&&r.status==='admitted'&&r.kind===a[7]&&run.owner===a[4]&&run.status==='running');
      if(!r)return {rowCount:0};r.status='returned';r.http_status=a[6];return {rowCount:1};
    }
    throw Error('Unexpected test SQL '+sql);
  }};
  return {plan,approval,run,gate:freshReviewGate({pool:{connect:async()=>c},plan,approval,owner:'test-owner'}),
    rows:()=>rows,spent:()=>reserved,setRows:r=>{rows=r;},setReserved:n=>{reserved=n;}};
}
const op=i=>({profileId:String(i),kind:'search',key:'search-'+i+'-0',inputSha256:'a'.repeat(64)});
test('fresh approval survives serialization and cannot change the cohort, policy, workers or $10 ceiling',()=>{
  const f=gateFixture();assert.deepEqual(approveFreshReview(f.plan,JSON.parse(JSON.stringify(f.approval))),f.approval);
  for(const p of [{...f.plan,parallelism:32},{...f.plan,verificationPolicy:'legacy'},
    {...f.plan,sourceReservedCents:320},{...f.plan,experimentOnly:false}])assert.throws(()=>freshReviewPlan(p));
  assert.throws(()=>approveFreshReview(f.plan,{...f.approval,capCents:2000}));
});
test('sixteen lanes reserve once; excess lanes close dispatch while sent responses drain',async()=>{
  const f=gateFixture();await Promise.all(Array.from({length:16},(_,i)=>f.gate.admit(op(i+1))));
  assert.equal(f.spent(),32);assert.equal(f.gate.live.size,16);
  await assert.rejects(f.gate.admit(op(17)));
  await Promise.all(Array.from({length:16},(_,i)=>f.gate.returned(op(i+1),'b'.repeat(64),200)));
  assert.equal(f.gate.live.size,0);assert.ok(f.rows().every(r=>r.status==='returned'));
  await assert.rejects(f.gate.admit(op(18)));
});
test('unknown pending work, changed ownership and duplicate or wrong-kind receipts stay fenced',async()=>{
  const a=gateFixture();
  a.setRows([{run_id:a.plan.id,operation_key:'search-99-0',profile_id:'99',kind:'search',input_sha256:'a'.repeat(64),status:'admitted'}]);
  await assert.rejects(a.gate.admit(op(1)));assert.equal(a.spent(),0);
  const b=gateFixture();b.run.owner='other';await assert.rejects(b.gate.admit(op(1)));assert.equal(b.spent(),0);
  const c=gateFixture();await c.gate.admit(op(1));
  await assert.rejects(c.gate.returned({...op(1),kind:'metadata'},'b'.repeat(64),200));
  assert.equal(c.rows()[0].status,'admitted');
  await c.gate.returned(op(1),'b'.repeat(64),500);
  assert.equal(c.rows()[0].http_status,500);await assert.rejects(c.gate.returned(op(1),'b'.repeat(64),200));
});
test('a fresh run has its own $10 cap and cannot spend past it',async()=>{
  const f=gateFixture();f.setReserved(998);await f.gate.admit(op(1));
  await f.gate.returned(op(1),'b'.repeat(64),200);
  await assert.rejects(f.gate.admit(op(2)));assert.equal(f.spent(),1000);
});
test('a continuation binds the original source approval, completed artists and acknowledged spending',()=>{
  const sourcePlan=planFixture(),sourceApproval=approveFreshReview(sourcePlan,{
    planSha256:digest(sourcePlan),capCents:1000,approvedAt:'2026-11-17T01:00:00Z'});
  const snapshot={run:{id:sourcePlan.id,status:'stopped',scope_sha256:sourcePlan.scopeSha256,
    cap_cents:1000,reserved_cents:0},admissions:[]};
  const p=freshReviewPlan({...sourcePlan,id:sourcePlan.id+'-cont1',continuation:true,
    sourceId:sourcePlan.id,continuationSourceRoot:'generated-artifacts/'+sourcePlan.id,sourcePlan,sourceApproval,
    sourcePlanSha256:digest(sourcePlan),sourceSnapshot:snapshot,sourceSnapshotSha256:digest(snapshot),
    sourceReservedCents:0,completedRecords:[]});
  assert.equal(p.maximumSpendCents,1000);assert.equal(p.continuation,true);
  assert.throws(()=>freshReviewPlan({...p,sourceReservedCents:2}));
  const bad=structuredClone(p);bad.sourceSnapshot.run.status='running';
  bad.sourceSnapshotSha256=digest(bad.sourceSnapshot);assert.throws(()=>freshReviewPlan(bad));
  assert.throws(()=>freshReviewPlan({...p,sourceApproval:{...sourceApproval,capCents:2000}}));
});
test('valid saved video responses with conflicting uploader IDs hold that artist without a paid retry or model call',async()=>{
  const id='UC'+'a'.repeat(22),other='UC'+'b'.repeat(22),calls=[];
  const artist={profileId:'1',cmArtist:'2',name:'Example Artist',
    catalogProfile:{profile_id:'1',cm_artist:'2'},accounts:[],releases:[]};
  const request=async(profileId,kind,key,request)=>{
    calls.push(kind);
    const data=kind==='search'?{organic:[{link:'https://www.youtube.com/watch?v=abcdefghijk',
      title:'Example Artist - My track (Official Audio)',snippet:'Example Artist music'}]}:
      {success:true,id:'abcdefghijk',title:'Example Artist - My track',channel:{id,title:'Example Artist'},
        uploader:{channelId:other},ownerByline:{channelId:id}};
    const raw=Buffer.from(JSON.stringify(data));
    return {profileId,cmArtist:'2',kind,status:200,request,inputSha256:digest(request),data,
      rawBodySha256:digest(raw),rawBodyBase64:raw.toString('base64'),
      at:'2026-11-17T00:00:00Z',sourcePath:'synthetic.json'};
  };
  const r=await reviewBatchArtist({artist,tier:2,request,conflicts:async()=>false,verificationPolicy:REPRESENTATION_VERSION});
  assert.deepEqual(calls,['search','metadata']);assert.equal(r.status,'held');
  assert.match(r.candidates[0].reason,/Conflicting provider/);
  const rows=reviewBatchRows([r]);assert.equal(rows[0].youtube_url,'');assert.equal(rows[0].status,'held');
  assert.equal(rows[0].ownership_accepted,false);
  await assert.rejects(reviewBatchArtist({artist,tier:2,request,conflicts:async()=>false}));
});
test('the new contract travels through search, channel capture, parsing and channel-level CSV output',async()=>{
  const channelId='UC'+'a'.repeat(22),url='https://www.youtube.com/channel/'+channelId;
  const spotify='https://open.spotify.com/artist/3UvBjnS0xNdifivRctkxok';
  const artist={profileId:'1',cmArtist:'2',name:'Example Artist',catalogProfile:{profile_id:'1',cm_artist:'2'},
    accounts:[{profile_id:'1',cm_artist:'2',account_id:'3',platform:'spotify',account_url:spotify,is_active:1}],releases:[]};
  const calls=[];
  const request=async(profileId,kind,key,request)=>{
    calls.push(kind);
    const data=kind==='search'?{organic:[{link:url,title:'Example Artist',snippet:'Artist music'}]}:
      kind==='metadata'?{success:true,channelId,channel:url,name:'Example Artist',description:'My original music',links:[spotify]}:
      {model:'typesafe/jev-1.13',usage:{cost:.0001},answers:{combined_assessment:{type:'choice',choice:'artist_representation_supported'}}};
    return {profileId,cmArtist:'2',kind,status:200,operationKey:key,request,inputSha256:digest(request),
      data,at:'2026-11-17T00:00:00Z',sourcePath:'synthetic.json'};
  };
  const r=await reviewBatchArtist({artist,tier:2,request,conflicts:async()=>false,verificationPolicy:REPRESENTATION_VERSION});
  assert.deepEqual(calls,['search','metadata','model']);
  const rows=reviewBatchRows([r]);assert.equal(rows.length,1);assert.equal(rows[0].youtube_url,url);
  assert.equal(rows[0].status,'review_suggestion');assert.equal(rows[0].ownership_accepted,false);
  assert.equal(rows[0].channel_type_label,'Artist-facing — management unverified');
});
test('shared paid transport accepts the new choice only when explicitly selected by the sealed fresh runner',async()=>{
  const root=await fs.mkdtemp(os.tmpdir()+'/fresh-review-transport-');
  try{
    await fs.mkdir(root+'/inputs');await fs.mkdir(root+'/receipts');
    const plan=planFixture();const request={method:'POST',url:'https://openrouter.ai/api/alpha/decisions',
      body:{model:'typesafe/jev-1.13',state:{artist:{profileId:'1',cmArtist:'101'}},
        questions:{combined_assessment:{type:'choice'}}}};
    let admits=0,acks=0;
    const transport=await reviewBatchRequest({root,plan,gate:{admit:async()=>{admits++;},returned:async()=>{acks++;}},
      assertFrozen:async()=>{},modelAssessments:REPRESENTATION_ASSESSMENTS,credentials:{openrouter:'synthetic'},
      fetchImpl:async()=>{assert.equal(admits,1);return new Response(JSON.stringify({
        model:'typesafe/jev-1.13',usage:{cost:.0001},
        answers:{combined_assessment:{type:'choice',choice:'artist_representation_supported'}}}),{status:200});}});
    const p=await transport('1','model','model-1-synthetic',request);
    assert.equal(p.data.answers.combined_assessment.choice,'artist_representation_supported');
    assert.equal(acks,1);assert.equal((await fs.readdir(root+'/receipts')).length,2);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
