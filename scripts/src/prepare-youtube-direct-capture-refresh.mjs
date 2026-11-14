import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {digest} from './youtube-video-discovery-offline.mjs';
import {refreshedDirectCaptureInput} from './youtube-direct-capture-refresh.mjs';
import {mixedCapturePlan} from './youtube-mixed-channel-captures.mjs';
import {channelCheckBundle,approveChannelCheckBundle} from './youtube-channel-check-bundle.mjs';
import {mixedCaptureReadiness} from './youtube-mixed-capture-readiness.mjs';
import {mixedClaims} from './run-youtube-mixed-captures.mjs';
import {identityEligibilitySql,identityCatalogCheck} from './youtube-video-identity-catalog.mjs';
import {select} from './instagram-artist-metadata-overlay.mjs';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';
import {freezeLocalModules} from './seal-youtube-campaign-runtime.mjs';
const previousId='youtube-batch-channel-checks-direct-100-2026-11-13';
const id='youtube-batch-channel-checks-direct-100-refreshed-2026-11-13';
const root='generated-artifacts/'+id,previousRoot='generated-artifacts/'+previousId;
const read=async file=>JSON.parse(await fs.readFile(file));
const save=async(file,value)=>fs.writeFile(file,typeof value==='string'?value:JSON.stringify(value,null,2),{flag:'wx'});
const cell=v=>{let s=String(v??'');if(/^[=+\-@\t\r\n]/u.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};
const csv=rows=>'\ufeff'+rows.map(r=>r.map(cell).join(',')).join('\r\n');
async function noPriorAdmissions(client,ids){
  const runs=(await client.query('SELECT id,reserved_cents,status FROM youtube_video_identity_runs WHERE id=ANY($1::text[])',[ids])).rows;
  const admissions=(await client.query('SELECT count(*)::int n FROM youtube_video_identity_admissions WHERE run_id=ANY($1::text[])',[ids])).rows[0].n;
  assert.equal(admissions,0,'This refresh does not recover or replay paid requests');
  assert.equal(runs.length,0,'Existing run ownership needs a different recovery procedure');
}
async function frozenRuntime(entry,folder){
  const files=await freezeLocalModules(path.join(path.dirname(fileURLToPath(import.meta.url)),entry),folder+'/runtime');
  const hashes={};
  for(const f of files){const key='runtime/'+path.basename(f);hashes[key]=digest(await fs.readFile(folder+'/'+key));}
  return hashes;
}
export async function prepareDirectCaptureRefresh(){
  try{await fs.lstat(root);assert.fail('Preparation already exists');}catch(e){if(e.code!=='ENOENT')throw e;}
  const previous=await read(previousRoot+'/plan.json'),approval=await read(previousRoot+'/approval.json');
  assert.deepEqual(approveChannelCheckBundle(previous,approval),approval);
  const originalOps=new Map(previous.children.flatMap(c=>c.plan.operations).map(o=>[o.key,o]));
  const sourceFiles={};
  for(const file of ['plan.json','approval.json','run-started.json'])
    sourceFiles[previousRoot+'/'+file]=digest(await fs.readFile(previousRoot+'/'+file));
  for(const child of previous.children){
    assert.equal(digest(await read('generated-artifacts/'+child.id+'/plan.json')),child.planSha256);
    for(const [file,sha] of Object.entries(child.plan.sourceFiles)){
      assert.equal(digest(await fs.readFile(file)),sha);sourceFiles[file]=sha;
    }
    // Plan files are hashed as stored bytes in sourceFiles, not as parsed JSON.
    sourceFiles['generated-artifacts/'+child.id+'/plan.json']=digest(await fs.readFile('generated-artifacts/'+child.id+'/plan.json'));
  }
  const pool=await connectSavedBatchPool();let client;
  try{
    client=await pool.connect();await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await noPriorAdmissions(client,previous.children.map(c=>c.id));
    await client.query('COMMIT');
  }catch(error){if(client)await client.query('ROLLBACK');throw error;}finally{client?.release();await pool.end();}
  const currentRows=await select(identityEligibilitySql(previous.children.flatMap(c=>c.plan.selections)));
  await fs.mkdir(root);
  await save(root+'/eligibility-refresh.json',{previousId,observedAt:new Date().toISOString(),currentRows,
    priorPaidCalls:0,priorReservedCents:0,originalArtistDenominator:100,
    warning:'Missing current eligibility is deferred, not a completed check or no-match.'});
  sourceFiles[root+'/eligibility-refresh.json']=digest(await fs.readFile(root+'/eligibility-refresh.json'));
  const children=[],selected=[],deferred=[];
  for(let i=0;i<previous.children.length;i++){
    const old=previous.children[i].plan,childId='youtube-mixed-captures-direct-refreshed-100-2026-11-13-part-'+(i+1);
    const result=refreshedDirectCaptureInput(old,currentRows,{id:childId,preparedAt:new Date().toISOString(),
      sourceFiles,runtimeFiles:{'runtime/preflight.mjs':digest('preflight')}});
    deferred.push(...result.deferred);
    if(!result.input)continue;
    let plan=mixedCapturePlan(result.input);
    assert.equal(plan.maximumCalls,result.input.artists.length);
    for(const o of plan.operations)assert.deepEqual(o,originalOps.get(o.key),'Only unchanged original channel requests may be proposed');
    await identityCatalogCheck(plan)(mixedClaims(plan));
    const p=await connectSavedBatchPool();let c;
    try{
      c=await p.connect();await c.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await noPriorAdmissions(c,previous.children.map(c=>c.id));
      await mixedCaptureReadiness(c,plan,{preparationOnly:true});await c.query('COMMIT');
    }catch(error){if(c)await c.query('ROLLBACK');throw error;}finally{c?.release();await p.end();}
    const folder='generated-artifacts/'+childId;await fs.mkdir(folder);
    const runtimeFiles=await frozenRuntime('run-youtube-mixed-captures.mjs',folder);
    plan=mixedCapturePlan({...result.input,runtimeFiles});await save(folder+'/plan.json',plan);
    children.push({id:childId,plan});
    selected.push(...plan.selections.map(s=>({...s,startingTier:old.selections.find(a=>a.profileId===s.profileId).tier})));
  }
  const runtimeFiles=await frozenRuntime('run-youtube-channel-check-bundle.mjs',root);
  const plan=channelCheckBundle({id,preparedAt:new Date().toISOString(),sourceBundleId:previous.sourceBundleId,
    sourceBundleSha256:previous.sourceBundleSha256,children,runtimeFiles});
  assert.ok(plan.maximumSpendCents<=approval.capCents);
  assert.equal(plan.maximumCalls+deferred.length,previous.maximumCalls);
  for(const [file,sha] of Object.entries(sourceFiles))assert.equal(digest(await fs.readFile(file)),sha);
  await save(root+'/plan.json',plan);
  await save(root+'/proposed-channel-checks.csv',csv([
    ['artist','starting_tier','current_tier','profile_id','cm_artist','youtube_url','channel_type_label','ownership_accepted','import_eligible'],
    ...selected.map(s=>[s.artist,s.startingTier,s.tier,s.profileId,s.cmArtist,s.url,s.topicLabel,false,false])]));
  await save(root+'/deferred-current-eligibility.csv',csv([
    ['artist','starting_tier','profile_id','cm_artist','youtube_url','reason','processed','no_match','paid_calls'],
    ...deferred.map(s=>[s.artist,s.tier,s.profileId,s.cmArtist,s.url,s.reason,false,false,0])]));
  const summary={id,status:'prepared_not_approved',previousId,previousApprovedCents:approval.capCents,
    previousPaidCalls:0,previousReservedCents:0,sourceArtists:100,channelChecks:plan.maximumCalls,
    maximumAdditionalCents:plan.maximumSpendCents,maximumSearchPlusThisStageCents:200+plan.maximumSpendCents,
    previouslyUnselectedArtists:45,newlyDeferredArtists:deferred.length,
    planSha256:digest(plan),paidCalls:0,ledgerWrites:0,catalogWrites:0,
    priority:'Original frozen starting-tier/source-cohort order retained; current tiers revalidated and separately recorded.'};
  await save(root+'/preparation.json',summary);return summary;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  assert.deepEqual(process.argv.slice(2),['--prepare-only']);console.log(JSON.stringify(await prepareDirectCaptureRefresh()));
}
