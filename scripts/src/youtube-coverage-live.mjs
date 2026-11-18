import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {digest} from './youtube-video-discovery-offline.mjs';
import {durableIdentityFile} from './youtube-video-identity-execution.mjs';
import {coordinatorTransactions} from './campaign-parallel-coordinator.mjs';
import {assertParallelWorld,sourceSnapshot} from './youtube-review-parallel.mjs';
import {assertCoverageAdmission,CoverageLimit} from './youtube-coverage-execution.mjs';
import {providerStopReason} from './youtube-ownership-transport.mjs';
import {REPRESENTATION_ASSESSMENTS} from './youtube-artist-representation.mjs';

const externalHistorySql=`SELECT operation_key,status,http_status FROM (
  SELECT operation_key,profile_id,input_sha256,status,http_status FROM youtube_link_campaign_admissions
  UNION ALL SELECT operation_key,profile_id,input_sha256,status,http_status FROM youtube_video_stage_admissions
  UNION ALL SELECT operation_key,profile_id,input_sha256,status,http_status FROM youtube_video_identity_admissions
) history WHERE profile_id=$1 AND input_sha256=$2 LIMIT 1`;

export async function historicalCoveragePacket(row,request,artist){
  assert.equal(row.status,'returned','Uncertain historical operation cannot be repeated');
  if([404,410].includes(row.http_status)&&row.kind==='metadata'){
    const error=new Error('Previously acknowledged unavailable resource; not retried');
    error.code='COVERAGE_RESOURCE_MISSING';error.target=request.url;throw error;
  }
  assert.equal(row.http_status,200,'Failed historical request cannot be retried');
  assert.match(row.run_id,/^[a-z0-9-]+$/);
  assert.equal(row.profile_id,artist.profileId);assert.equal(row.input_sha256,digest(request));
  const prefix='generated-artifacts/'+row.run_id+'/receipts/'+digest(row.operation_key);
  const bytes=await fs.readFile(prefix+'.json'),receipt=JSON.parse(bytes);
  // Legacy review dispatches committed the parsed object hash; some other
  // dispatchers committed exact receipt bytes. Both are checked explicitly.
  assert.ok([digest(receipt),digest(bytes)].includes(row.receipt_sha256),'Historical receipt hash mismatch');
  assert.equal(receipt.profileId,artist.profileId);assert.equal(receipt.cmArtist,artist.cmArtist);
  assert.equal(receipt.runId,row.run_id);assert.equal(receipt.operationKey,row.operation_key);
  assert.deepEqual(receipt.request,request);assert.equal(receipt.status,200);
  const raw=await fs.readFile(prefix+'.raw');
  assert.equal(digest(raw),receipt.rawBodySha256);
  return {...receipt,data:JSON.parse(raw),sourcePath:prefix+'.json',rawBodyBase64:raw.toString('base64')};
}
export function coverageGate({pool,plan,approval,owner}){
  const tx=coordinatorTransactions(pool),live=new Map(),approvalHash=digest(approval);
  let closed=false;
  return {live,close(){closed=true;},async admit(op){
    try{await tx(async c=>{
      assert.equal(closed,false,'Recovery dispatch is closed');
      // The same parent lock is used by existing campaign and test workers.
      const parent=(await c.query('SELECT status FROM youtube_link_campaigns WHERE id=$1 FOR UPDATE',
        [plan.parentId])).rows[0];assert.equal(parent?.status,'stopped');
      const run=(await c.query('SELECT * FROM youtube_discovery_test_runs WHERE id=$1 FOR UPDATE',[plan.id])).rows[0];
      const priorId=plan.sourceRun?.id;
      if(priorId){
        assert.deepEqual(await sourceSnapshot(c,priorId),plan.sourceRun.snapshot,
          'Stopped recovery source ledger changed');
      }
      await assertParallelWorld(c,plan.id);
      const pending=(await c.query(`SELECT operation_key,profile_id,kind,input_sha256
        FROM youtube_bounded_test_admissions WHERE run_id=$1 AND status='admitted'`,[plan.id])).rows;
      const history=(await c.query(`SELECT kind,status,input_sha256 FROM youtube_bounded_test_admissions
        WHERE run_id=ANY($1::text[]) AND profile_id=$2`,
      [[plan.id,...(priorId?[priorId]:[])],op.profileId])).rows;
      assertCoverageAdmission({run:{...run,reserved_cents:Number(run.reserved_cents)+(plan.sourceRun?.reservedCents??0)},
        owner,approvalHash,scopeHash:plan.scopeSha256,
        operation:{...op,approvalHash},history,pending,live});
      const prior=(await c.query(`SELECT count(*)::int n FROM youtube_bounded_test_admissions
        WHERE profile_id=$1 AND kind=$2 AND input_sha256=$3`,
      [op.profileId,op.kind,op.inputSha256])).rows[0].n;
      assert.equal(prior,0,'Historical request must be reused, not charged again');
      assert.equal((await c.query(externalHistorySql,[op.profileId,op.inputSha256])).rows.length,0,
        'Historical request from another YouTube stage cannot be repeated');
      await c.query(`INSERT INTO youtube_bounded_test_admissions
        (run_id,operation_key,profile_id,kind,input_sha256,reserved_cents) VALUES($1,$2,$3,$4,$5,2)`,
      [plan.id,op.key,op.profileId,op.kind,op.inputSha256]);
      assert.equal((await c.query(`UPDATE youtube_discovery_test_runs SET reserved_cents=reserved_cents+2
        WHERE id=$1 AND owner=$2 AND status='running' AND reserved_cents+2+$3<=1000`,
      [plan.id,owner,plan.sourceRun?.reservedCents??0])).rowCount,1);
      live.set(op.key,{profileId:op.profileId,kind:op.kind,inputSha256:op.inputSha256});
    });}catch(e){if(!(e instanceof CoverageLimit))closed=true;throw e;}
  },async returned(op,receiptHash,status){
    await tx(async c=>{
      assert.deepEqual(live.get(op.key),{profileId:op.profileId,kind:op.kind,inputSha256:op.inputSha256});
      assert.equal((await c.query(`UPDATE youtube_bounded_test_admissions a
        SET status='returned',receipt_sha256=$6,http_status=$7 FROM youtube_discovery_test_runs r
        WHERE a.run_id=$1 AND a.operation_key=$2 AND a.profile_id=$3 AND a.input_sha256=$4
        AND a.status='admitted' AND a.kind=$8 AND r.id=a.run_id AND r.owner=$5 AND r.status='running'`,
      [plan.id,op.key,op.profileId,op.inputSha256,owner,receiptHash,status,op.kind])).rowCount,1);
      live.delete(op.key);
    });
  }};
}
export function coverageRequest({pool,root,plan,gate,check,fetchImpl=fetch,onReuse=()=>{}}){
  const artists=new Map(plan.recovery.recovery.map(a=>[a.profileId,a]));
  return async(artist,kind,request)=>{
    const selected=artists.get(artist.profileId);
    assert.equal(selected?.cmArtist,artist.cmArtist);
    assert.ok(['metadata','search','model'].includes(kind));
    const u=new URL(request.url);assert.equal(u.username,'');assert.equal(u.password,'');
    assert.equal(u.port,'');assert.equal(u.hash,'');
    if(kind==='search'){
      assert.equal(request.method,'POST');assert.equal(request.url,'https://google.serper.dev/search');
      assert.ok(selected.newSearches.some(s=>digest(s.request)===digest(request.body)),'Unapproved query');
    }else if(kind==='metadata'){
      assert.equal(request.method,'GET');assert.equal(u.origin,'https://api.scrapecreators.com');
      assert.ok(['/v1/youtube/channel','/v1/youtube/video'].includes(u.pathname));
      assert.equal([...u.searchParams.keys()].join(','),'url');
      const {normalizeDiscoveryChannel,normalizeDiscoveryVideo}=await import('./youtube-video-discovery-offline.mjs');
      const target=u.searchParams.get('url');
      assert.equal(u.pathname.endsWith('/channel')?normalizeDiscoveryChannel(target):
        normalizeDiscoveryVideo(target)?.url,target,'Unbound metadata target');
    }else{
      assert.equal(request.method,'POST');assert.equal(request.url,'https://openrouter.ai/api/alpha/decisions');
      assert.equal(request.body.model,'typesafe/jev-1.13');
      assert.equal(request.body.state.artist.profileId,artist.profileId);
      assert.equal(request.body.state.artist.cmArtist,artist.cmArtist);
      assert.deepEqual(Object.keys(request.body.questions),['combined_assessment']);
      assert.ok(Buffer.byteLength(JSON.stringify(request.body))<=64000);
    }
    await check();
    const inputSha256=digest(request);
    const prior=(await pool.query(`SELECT run_id,operation_key,profile_id,kind,input_sha256,status,receipt_sha256,http_status
      FROM youtube_bounded_test_admissions WHERE profile_id=$1 AND kind=$2 AND input_sha256=$3
      ORDER BY created_at LIMIT 1`,[artist.profileId,kind,inputSha256])).rows[0];
    if(prior){const packet=await historicalCoveragePacket(prior,request,artist);onReuse(prior);return packet;}
    const external=(await pool.query(externalHistorySql,[artist.profileId,inputSha256])).rows[0];
    if(external){
      const e=new Error('Saved paid request exists in another YouTube stage; not repeated');
      e.code='PRIOR_COVERAGE_REQUEST';throw e;
    }
    const key=kind+'-'+artist.profileId+'-'+inputSha256,op={profileId:artist.profileId,kind,key,inputSha256};
    const credential=process.env[kind==='search'?'SERPERDEV_API_KEY':kind==='metadata'?'SCRAPECREATORS_API_KEY':'OPENROUTER_API_KEY'];
    assert.ok(credential,'Required provider credential is missing');
    await durableIdentityFile(root+'/inputs/'+digest(key)+'.json',JSON.stringify({op,request}));
    await gate.admit(op);
    const headers=kind==='model'?{Authorization:'Bearer '+credential,'Content-Type':'application/json'}:
      {[kind==='search'?'X-API-KEY':'x-api-key']:credential,...(kind==='search'?{'Content-Type':'application/json'}:{})};
    const response=await fetchImpl(request.url,{method:request.method,headers,redirect:'error',
      signal:AbortSignal.timeout(120000),...(request.body?{body:JSON.stringify(request.body)}:{})});
    const chunks=[];let length=0;
    if(response.body)for await(const chunk of response.body){
      length+=chunk.length;assert.ok(length<=2*1024*1024,'Response exceeds approved size');chunks.push(chunk);
    }
    const raw=Buffer.concat(chunks),prefix=root+'/receipts/'+digest(key);
    await durableIdentityFile(prefix+'.raw',raw);
    const receipt={runId:plan.id,profileId:artist.profileId,cmArtist:artist.cmArtist,kind,operationKey:key,
      inputSha256,request,status:response.status,at:new Date().toISOString(),
      rawBodySha256:digest(raw),rawPath:'receipts/'+digest(key)+'.raw'};
    await durableIdentityFile(prefix+'.json',JSON.stringify(receipt));
    const data=JSON.parse(raw);
    const packet={...receipt,data,sourcePath:prefix+'.json',rawBodyBase64:raw.toString('base64')};
    await gate.returned(op,digest(receipt),response.status);
    const stop=providerStopReason(packet);if(stop)throw Error(stop);
    if(kind==='metadata'&&[404,410].includes(response.status)){
      const error=new Error('Unavailable channel or video; paid response saved and not retried');
      error.code='COVERAGE_RESOURCE_MISSING';error.target=request.url;
      error.sourceReceipt=packet.sourcePath;throw error;
    }
    assert.equal(response.status,200,'Provider failed; no retry');
    if(kind==='metadata'){
      assert.equal(data.success,true);
      assert.ok(Number.isFinite(data.credits_charged)&&data.credits_charged>=0&&data.credits_charged<=1);
    }
    if(kind==='model'){
      assert.ok(['typesafe/jev-1.13','typesafe/jev-1.13-20260917'].includes(data.model));
      assert.ok(Number.isFinite(data.usage?.cost)&&data.usage.cost>=0&&data.usage.cost<=.02);
      assert.deepEqual(Object.keys(data.answers??{}),['combined_assessment']);
      assert.ok(Object.hasOwn(REPRESENTATION_ASSESSMENTS,data.answers.combined_assessment?.choice));
    }
    return packet;
  };
}
