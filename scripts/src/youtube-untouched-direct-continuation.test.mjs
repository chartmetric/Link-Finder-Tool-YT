import test from 'node:test';
import assert from 'node:assert/strict';
import {digest} from './youtube-video-discovery-offline.mjs';
import {mixedCapturePlan,approveMixedCaptures,DIRECT_CAPTURE_POLICY} from './youtube-mixed-channel-captures.mjs';
import {channelCheckBundle,approveChannelCheckBundle} from './youtube-channel-check-bundle.mjs';
import {untouchedDirectContinuation} from './youtube-untouched-direct-continuation.mjs';
import {catalogReadWithOneTimeoutRetry} from './youtube-catalog-read-retry.mjs';
import {identityCatalogCheck} from './youtube-video-identity-catalog.mjs';
import {catalogLinkedYoutubeClaims,youtubeClaimTokenFilter} from './youtube-catalog-linked-claims.mjs';
const at='2026-11-16T17:00:00Z',now=Date.parse(at);
const channel=n=>'UC'+String(n).padStart(22,'a'),url=n=>'https://www.youtube.com/channel/'+channel(n);
function fixture(){
  const make=(suffix,numbers)=>{
    const artists=numbers.map(n=>({profileId:String(n),cmArtist:String(100+n),name:'Artist '+n,tier:2,
      catalogProfile:{profile_id:String(n),cm_artist:String(100+n)}}));
    const p=mixedCapturePlan({version:DIRECT_CAPTURE_POLICY,id:'youtube-mixed-captures-'+suffix,
      preparedAt:at,artists,sourceSearchId:'youtube-test-synthetic-source',sourceUploaderIds:[],
      uploaderResults:[],cohortClaims:[],directLeads:artists.map(a=>({profileId:a.profileId,cmArtist:a.cmArtist,artist:a.name,
        candidates:[{url:url(a.profileId),title:a.name}]})),
      sourceFiles:{'generated-artifacts/source/plan.json':digest('source')},runtimeFiles:{'runtime/run.mjs':digest('runtime')}});
    const childApproval=approveMixedCaptures(p,{planSha256:digest(p),capCents:p.maximumSpendCents,approvedAt:at});
    const plan=channelCheckBundle({id:'youtube-batch-channel-checks-'+suffix,preparedAt:at,
      sourceBundleId:'youtube-batch-100-synthetic',sourceBundleSha256:digest('source'),
      children:[{id:p.id,plan:p}],runtimeFiles:{'runtime/run.mjs':digest('wrapper')}});
    const approval=approveChannelCheckBundle(plan,{planSha256:digest(plan),capCents:plan.maximumSpendCents,approvedAt:at});
    const op=p.operations[0];
    return {bundle:{plan,approval,childApprovals:[childApproval]},
      run:{id:p.id,owner:'owner-'+suffix,status:'stopped',plan_sha256:digest(p),
        approval_sha256:digest(childApproval),execution_sha256:digest(p.runtimeFiles),cap_cents:p.maximumSpendCents,reserved_cents:2},
      admission:{run_id:p.id,operation_key:op.key,profile_id:op.profileId,cm_artist:op.cmArtist,
        channel_id:op.allocationChannelKey,kind:'metadata',input_sha256:op.inputSha256,reserved_cents:2,
        status:'returned',http_status:200,receipt_sha256:digest('receipt'),raw_sha256:digest('raw')}};
  };
  const original=make('original-synthetic',[1,2,3]),continuation=make('continuation-synthetic',[2,3]);
  return {bundles:[original.bundle,continuation.bundle],runs:[original.run,continuation.run],
    admissions:[original.admission,continuation.admission]};
}
test('a second interruption preserves both paid prefixes and proposes only the exact untouched identity',()=>{
  const f=fixture(),before=structuredClone(f),scope=untouchedDirectContinuation(f);
  assert.deepEqual(f,before);assert.equal(scope.pending.length,1);assert.equal(scope.pending[0].operation.profileId,'3');
  assert.equal(scope.pending[0].sourceRunId,f.bundles[1].plan.children[0].id);
  assert.equal(scope.priorReservedCents,4);assert.equal(scope.maximumAdditionalCents,2);
  assert.equal(scope.originalMaximumCents,6);assert.equal(scope.providerRequests,0);
});
test('changed scope, unresolved paid requests, duplicate identities and unexplained spending fail closed',()=>{
  for(const change of [
    f=>f.admissions[1].status='admitted',
    f=>f.admissions[1].profile_id=f.admissions[0].profile_id,
    f=>f.admissions[1].cm_artist=f.admissions[0].cm_artist,
    f=>f.admissions[1].channel_id=f.admissions[0].channel_id,
    f=>f.runs[1].reserved_cents=4,
    f=>f.runs[1].owner='',
    f=>f.runs[1].status='running',
    f=>f.admissions[1].operation_key='not-in-plan',
    f=>f.admissions[1].receipt_sha256=null,
    f=>f.bundles[1].approval.planSha256=digest('wrong'),
    f=>f.runs.push({...f.runs[1],id:'unexplained'}),
    f=>f.admissions.push({...f.admissions[1]}),
    f=>f.bundles.reverse(),
  ]){
    const f=fixture();change(f);assert.throws(()=>untouchedDirectContinuation(f));
  }
});
test('read-only catalog timeout gets exactly one identical retry, never a fallback',async()=>{
  const calls=[],sql='SELECT profile_id FROM catalog';
  const rows=await catalogReadWithOneTimeoutRetry(async s=>{
    calls.push(s);if(calls.length===1)throw new Error('Catalog metadata HTTP 408; no retry.');return [{profile_id:'1'}];
  },sql);
  assert.deepEqual(calls,[sql,sql]);assert.deepEqual(rows,[{profile_id:'1'}]);
  let attempts=0;
  await assert.rejects(()=>catalogReadWithOneTimeoutRetry(async()=>{
    attempts++;throw new Error('Catalog metadata HTTP 408; no retry.');
  },sql));
  assert.equal(attempts,2);
  for(const message of ['Catalog metadata HTTP 500; no retry.','Identity conflict','Network failure']){
    attempts=0;await assert.rejects(()=>catalogReadWithOneTimeoutRetry(async()=>{attempts++;throw new Error(message);},sql));
    assert.equal(attempts,1);
  }
  await assert.rejects(()=>catalogReadWithOneTimeoutRetry(async()=>assert.fail('No writes'),'UPDATE catalog SET x=1'));
});
test('a recovered catalog read still blocks a shared channel or ineligible artist',async()=>{
  const selection={profileId:'1',cmArtist:'101',artist:'Artist 1',tier:2};
  const claims=[{alias:url(1),channelId:channel(1),profileId:'1',cmArtist:'101'}];
  let reads=0;
  const guard=identityCatalogCheck({selections:[selection]},{now:()=>now,query:async sql=>{
    if(sql.includes('FROM new_vertical.account FINAL')){
      reads++;if(reads===1)throw new Error('Catalog metadata HTTP 408; no retry.');
      return [{account_id:'77',account_url:url(1)}];
    }
    if(sql.includes('FROM new_vertical.l_profile_account FINAL'))return [{profile_id:'999',account_id:'77'}];
    if(sql.includes('FROM new_vertical.profile FINAL WHERE id IN'))return [{profile_id:'999',cm_artist:'1999'}];
    return [{profile_id:'1',cm_artist:'101',artist:'Artist 1',tier:2,snapshot_at:at}];
  }});
  await assert.rejects(()=>guard(claims));assert.equal(reads,2);
  let queries=0;
  await assert.rejects(()=>identityCatalogCheck({selections:[selection]},{now:()=>now,query:async()=>{
    queries++;return [];
  }})(claims));assert.equal(queries,1);
});
test('targeted catalog reads retain HTTP, encoded handles, tabs and every linked profile',async()=>{
  const claims=[{alias:'https://www.youtube.com/@someone',channelId:null}];
  const queries=[];
  const rows=await catalogLinkedYoutubeClaims(claims,async sql=>{
    queries.push(sql);
    if(sql.includes('FROM new_vertical.account FINAL'))return [
      {account_id:'10',account_url:'http://m.youtube.com/%40SomeOne/videos?x=1'},
      {account_id:'11',account_url:'https://music.youtube.com//@someone//about'},
      {account_id:'12',account_url:'https://www.youtube.com/@someone_else'},
      {account_id:'13',account_url:'https://youtube.example.com/@someone'}];
    if(sql.includes('FROM new_vertical.l_profile_account FINAL'))return [
      {account_id:'10',profile_id:'9'},{account_id:'10',profile_id:'8'},{account_id:'11',profile_id:'7'}];
    if(sql.includes('FROM new_vertical.profile FINAL'))return [
      {profile_id:'9',cm_artist:'99'},{profile_id:'8',cm_artist:'88'}];
    assert.fail('Unexpected query');
  });
  assert.equal(rows.length,3);assert.deepEqual(rows.map(r=>r.profile_id),['9','8','7']);
  assert.equal(rows[2].cm_artist,''); // A missing profile is not a clearance.
  assert.ok(queries.every(q=>!q.includes('JOIN')&&!q.includes('is_active')&&!q.includes('disconnected')));
  assert.match(queries[1],/account_id IN \(10,11\)/);
  assert.equal(youtubeClaimTokenFilter([{alias:'https://www.youtube.com/@étoile'}]),'');
  assert.match(youtubeClaimTokenFilter([{alias:url(1)}]),/decodeURLComponent/);
});
test('targeted catalog failures remain blocking instead of hiding a shared-channel claim',async()=>{
  let reads=0;
  await assert.rejects(()=>catalogLinkedYoutubeClaims([{alias:url(1)}],async()=>{
    reads++;throw new Error('Catalog unavailable');
  }));assert.equal(reads,1);
});
