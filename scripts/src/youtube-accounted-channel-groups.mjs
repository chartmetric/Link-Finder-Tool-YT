// Group the unchanged approved requests within the coordinator's unchanged
// twenty-operation / forty-cent per-run limit. No historical scope is widened.
import assert from 'node:assert/strict';
import {digest} from './youtube-video-discovery-offline.mjs';
import {approveAccountedChannels} from './youtube-accounted-channel-plan.mjs';
import {accountedChannelReadiness} from './youtube-accounted-channel-readiness.mjs';
export function accountedChannelGroups(input){
  assert.match(input.id,/^youtube-accounted-channel-groups-[a-z0-9-]{4,60}$/);
  assert.ok(Number.isFinite(Date.parse(input.preparedAt)));
  assert.deepEqual(approveAccountedChannels(input.sourcePlan,input.sourceApproval),input.sourceApproval);
  assert.equal(input.previousAttempt.runs.length,0);
  assert.deepEqual(input.previousAttempt.admissions,[{n:0,reserved_cents:0}]);
  const parent=input.sourcePlan;
  const groups=[];
  for(let at=0;at<parent.operations.length;at+=20){
    const operations=parent.operations.slice(at,at+20),ids=new Set(operations.map(o=>o.profileId));
    groups.push({version:'exact-accounted-channel-group-v1',id:input.id+'-part-'+(groups.length+1),
      sourceRoot:parent.sourceRoot,parentId:input.id,groupIndex:groups.length,
      sourcePlanSha256:digest(parent),sourceApprovalSha256:digest(input.sourceApproval),
      selections:parent.selections.filter(s=>ids.has(s.profileId)),operations,
      runtimeFiles:input.runtimeFiles,maximumCalls:operations.length,maximumSpendCents:operations.length*2,
      noRetries:true,noCatalogWrites:true,modelCalls:0,uploaderCalls:0,explicitApproval:false,executionEnabled:false});
  }
  assert.ok(groups.length>0&&groups.length<=25);
  assert.deepEqual(groups.flatMap(g=>g.operations),parent.operations);
  assert.equal(groups.reduce((n,g)=>n+g.maximumSpendCents,0),parent.maximumSpendCents);
  for(const group of groups){
    assert.ok(group.maximumSpendCents<=40);assert.ok(group.maximumCalls<=20);
    assert.equal(group.selections.length,group.maximumCalls);
  }
  assert.ok(Object.keys(input.sourceFiles).length&&Object.keys(input.runtimeFiles).length);
  for(const [file,sha] of Object.entries(input.sourceFiles)){
    assert.match(file,/^generated-artifacts\/[A-Za-z0-9_./-]+$/);
    assert.ok(!file.split('/').includes('..'));assert.match(sha,/^[a-f0-9]{64}$/);
  }
  for(const [file,sha] of Object.entries(input.runtimeFiles)){
    assert.match(file,/^runtime\/[A-Za-z0-9_-]+\.mjs$/);assert.match(sha,/^[a-f0-9]{64}$/);
  }
  return {version:'exact-accounted-channel-groups-v1',id:input.id,preparedAt:input.preparedAt,
    sourcePlan:structuredClone(parent),sourceApproval:structuredClone(input.sourceApproval),
    previousAttempt:structuredClone(input.previousAttempt),sourceFiles:structuredClone(input.sourceFiles),
    runtimeFiles:structuredClone(input.runtimeFiles),groups:structuredClone(groups),
    maximumCalls:parent.maximumCalls,maximumSpendCents:parent.maximumSpendCents,
    allowedKinds:['metadata'],explicitApproval:false,executionEnabled:false,
    noRetries:true,noCatalogWrites:true,stopOnGroupFailure:true,sequentialGroups:true,modelCalls:0,uploaderCalls:0};
}
export function approveAccountedGroups(plan,{planSha256,capCents,approvedAt}){
  assert.deepEqual(accountedChannelGroups(plan),plan);
  assert.equal(planSha256,digest(plan));assert.equal(capCents,plan.maximumSpendCents);
  assert.ok(Date.parse(approvedAt)>=Date.parse(plan.preparedAt));
  return {id:plan.id,version:plan.version,planSha256,capCents,approvedAt,explicitApproval:true,
    scope:'unchanged_exact_channel_requests_in_bounded_groups_no_retries_or_catalog_writes'};
}
export function groupApproval(plan,approval,group){
  assert.deepEqual(approveAccountedGroups(plan,approval),approval);
  assert.deepEqual(plan.groups[group.groupIndex],group);
  return {id:group.id,parentId:plan.id,parentPlanSha256:digest(plan),parentApprovalSha256:digest(approval),
    planSha256:digest(group),capCents:group.maximumSpendCents,approvedAt:approval.approvedAt,
    explicitApproval:true,scope:approval.scope};
}
export async function assertZeroOriginalChannelAttempt(c,plan){
  assert.equal((await c.query('SELECT count(*)::int n FROM youtube_video_identity_runs WHERE id=$1',
    [plan.sourcePlan.id])).rows[0].n,0,'Original failed launch unexpectedly owns a run');
  assert.equal((await c.query('SELECT count(*)::int n FROM youtube_video_identity_admissions WHERE run_id=$1',
    [plan.sourcePlan.id])).rows[0].n,0,'Original attempt has a paid allocation');
}
export async function accountedGroupReadiness(c,plan,group,{ownRun=false,preparationOnly=false}={}){
  await assertZeroOriginalChannelAttempt(c,plan);
  await accountedChannelReadiness(c,group,{ownRun,preparationOnly});
  const ids=plan.groups.map(g=>g.id);
  const runs=(await c.query(`SELECT id,status,plan_sha256,cap_cents,reserved_cents
    FROM youtube_video_identity_runs WHERE id=ANY($1::text[])`,[ids])).rows;
  let total=0;
  for(const run of runs){
    const g=plan.groups.find(g=>g.id===run.id);assert.ok(g);
    assert.equal(run.plan_sha256,digest(g));assert.equal(run.cap_cents,g.maximumSpendCents);
    assert.ok(run.reserved_cents>=0&&run.reserved_cents<=g.maximumSpendCents);
    assert.ok(g.groupIndex<=group.groupIndex,'A later group was already attempted');
    if(g.groupIndex<group.groupIndex){assert.equal(run.status,'completed');assert.equal(run.reserved_cents,g.maximumSpendCents);}
    else assert.ok(ownRun&&run.status==='running','This group was already attempted');
    total+=run.reserved_cents;
  }
  assert.ok(total<=plan.maximumSpendCents);
  for(const earlier of plan.groups.slice(0,group.groupIndex))
    assert.ok(runs.some(r=>r.id===earlier.id&&r.status==='completed'),'Prior group is not complete');
  const rows=(await c.query(`SELECT run_id,operation_key,profile_id,cm_artist,channel_id,kind,input_sha256,
    reserved_cents,status,http_status FROM youtube_video_identity_admissions WHERE run_id=ANY($1::text[])`,[ids])).rows;
  assert.equal(rows.reduce((n,r)=>n+r.reserved_cents,0),total);
  for(const row of rows){
    const g=plan.groups.find(g=>g.id===row.run_id),op=g.operations.find(o=>o.key===row.operation_key);
    assert.ok(op);assert.equal(row.profile_id,op.profileId);assert.equal(row.cm_artist,op.cmArtist);
    assert.equal(row.channel_id,op.allocationChannelKey);assert.equal(row.kind,'metadata');
    assert.equal(row.input_sha256,op.inputSha256);assert.equal(row.reserved_cents,2);
    assert.equal(row.status,'returned');assert.equal(row.http_status,200);
  }
}
