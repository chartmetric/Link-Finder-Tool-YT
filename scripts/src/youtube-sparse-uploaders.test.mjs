import './youtube-ownership-offline-fence.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {digest,proposedUploaderRequest} from './youtube-video-discovery-offline.mjs';
import {videoStagePlan,SMALL_VIDEO_STAGE_POLICY} from './youtube-video-stage.mjs';
import {CONFLICT_HANDLING_FILE,CONFLICT_HANDLING_SCOPE} from './youtube-uploader-conflict-handling.mjs';
import {SPARSE_ID,SPARSE_SOURCE,historicalUploaderConflict,remainingRows,sparseSources,
  uploaderIdleBlockers,assertUploaderIdle} from './youtube-sparse-uploader-source.mjs';
import {sparseUploaderPlan,approveSparseUploaders} from './youtube-sparse-uploader-plan.mjs';
import {selectSparseCases} from './prepare-youtube-sparse-uploaders.mjs';
import {assertSparseNonReplay,sparseUploaderGate} from './youtube-sparse-uploader-gate.mjs';
import {approveVideoStage} from './youtube-video-stage.mjs';
const hash=digest('fixture'),at='2026-11-16T12:00:00Z';
function bundle(){
  const children=Array.from({length:2},(_,part)=>{
    const artists=Array.from({length:part?4:20},(_,i)=>{
      const id=String(part*20+i+1);
      return {profileId:id,cmArtist:String(100+Number(id)),name:'Artist '+id,tier:2,snapshotAt:at};
    });
    const operations=artists.flatMap(a=>Array.from({length:2},(_,i)=>{
      const videoId=String(Number(a.profileId)*2+i).padStart(11,'0');
      const videoUrl='https://www.youtube.com/watch?v='+videoId;
      return {profileId:a.profileId,cmArtist:a.cmArtist,videoId,videoUrl,
        key:`video_uploader-${a.profileId}-${a.cmArtist}-${videoId}`,kind:'video_uploader',
        request:proposedUploaderRequest(videoUrl)};
    }));
    const id=`youtube-video-review-sparse-100-2026-11-16-part-${part+1}`;
    return {id,plan:videoStagePlan({version:SMALL_VIDEO_STAGE_POLICY,id,preparedAt:at,
      sourceRunId:SPARSE_SOURCE,sourcePlanSha256:hash,artists,operations,
      evidenceFiles:{[CONFLICT_HANDLING_FILE]:digest(JSON.stringify(CONFLICT_HANDLING_SCOPE))},
      runtimeFiles:{'runtime/run.mjs':hash}})};
  });
  return sparseUploaderPlan({id:SPARSE_ID,preparedAt:at,sourcePlanSha256:hash,children,
    evidenceFiles:{'evidence/source.json':hash},runtimeFiles:{'runtime/run.mjs':hash}});
}
test('sparse aggregate binds exact unchanged bounded children and a separate summed cap',()=>{
  const p=bundle();
  assert.equal(p.proposedArtists,24);assert.equal(p.maximumCalls,48);assert.equal(p.maximumSpendCents,96);
  assert.deepEqual(p.children.map(c=>c.capCents),[80,16]);
  const args={planSha256:digest(p),capCents:96,approvedAt:at};
  const approval=approveSparseUploaders(p,args);
  assert.equal(approval.explicitApproval,true);assert.equal(p.explicitApproval,false);
  assert.equal(p.inheritsPriorApproval,false);assert.equal(p.acceptedArtistChannels,0);
  for(const capCents of [80,94,98])assert.throws(()=>approveSparseUploaders(p,{...args,capCents}));
  for(const change of [
    x=>x.children[1]=structuredClone(x.children[0]),
    x=>x.children[0].plan.operations[0].request.url+='&changed=1',
    x=>x.children[0].plan.operations[0].kind='metadata',
    x=>x.children[0].plan.sourceRunId='another-source',
    x=>x.children[0].plan.evidenceFiles[CONFLICT_HANDLING_FILE]=hash,
    x=>x.children[0].plan.artists.push(x.children[1].plan.artists[0]),
    x=>x.children[0].capCents=82,
    x=>x.maximumSpendCents=200,
    x=>x.runtimeFiles['../run.mjs']=hash,
    x=>x.unknownDownstreamRequestsApproved=true,
  ]){
    const changed=structuredClone(p);change(changed);
    assert.throws(()=>approveSparseUploaders(changed,{...args,planSha256:digest(changed)}));
  }
});
test('historical profile, catalog ID, video ID and operation key each exclude independently, even uncertain returns',()=>{
  const c={profileId:'1',cmArtist:'101',resolutionQueue:[{videoId:'00000000001',operation:{key:'exact'}}]};
  for(const status of ['admitted','returned'])for(const partial of [
    {profile_id:'1'},{cm_artist:'101'},{video_id:'00000000001'},{operation_key:'exact'},
  ])assert.equal(historicalUploaderConflict(c,[{...partial,status}]),true);
  assert.equal(historicalUploaderConflict(c,[{profile_id:'2',cm_artist:'102',video_id:'other'}]),false);
});
test('direct-first and current eligibility deferrals never become no-matches or replacement videos',()=>{
  const base={profileId:'1',cmArtist:'101',resolutionQueue:[{videoId:'first',operation:{key:'first'}}]};
  const sources={cases:[
    {...base,directSelected:true},{...base,profileId:'2',cmArtist:'102'},
    {...base,profileId:'3',cmArtist:'103'},{...base,profileId:'4',cmArtist:'104',resolutionQueue:[]},
    {...base,profileId:'5',cmArtist:'105'},
  ]};
  const result=selectSparseCases(sources,[{cm_artist:'102',status:'admitted'}],new Map([['1',{}],['5',{}]]));
  assert.deepEqual(result.map(c=>c.disposition),[
    'deferred_direct_capture_selected','deferred_historical_uploader_allocation',
    'deferred_current_catalog_eligibility','deferred_no_saved_video_request','proposed_saved_uploader_discovery']);
  assert.deepEqual(result[4].resolutionQueue,sources.cases[4].resolutionQueue);
});
test('remaining-artist parser preserves commas, accented names and exact string IDs',()=>{
  assert.deepEqual(remainingRows('\ufeff"artist","id"\r\n"ANIL, ""ÖZGEN""","9007199254740999"'),
    [['artist','id'],['ANIL, "ÖZGEN"','9007199254740999']]);
  for(const text of ['unquoted,columns','"unclosed','"quoted"oops'])assert.throws(()=>remainingRows(text));
});
test('uncertain unrelated identity receipt is reportable offline but still blocks runtime',async()=>{
  const client={query:async(sql,args)=>{
    assert.ok(sql.startsWith('SELECT'),'Read-only checks cannot write');
    return {rows:sql.includes('SELECT status FROM')?[{status:'stopped'}]:
      [{n:sql.includes('youtube_video_identity_admissions')&&args?.[0]==='admitted'?1:0}]};
  }};
  assert.deepEqual(await uploaderIdleBlockers(client),[{reason:'active_or_uncertain_work',
    table:'youtube_video_identity_admissions',status:'admitted',count:1}]);
  await assert.rejects(assertUploaderIdle(client));
});
test('locked non-replay excludes other runs without preventing a second frozen video in this run',async()=>{
  const p=bundle().children[0].plan,calls=[];
  const client={query:async(sql,args)=>{calls.push({sql,args});return {rows:[{n:0}]};}};
  await assertSparseNonReplay(client,p);
  assert.match(calls[0].sql,/run_id<>\$1/);
  assert.match(calls[0].sql,/profile_id=ANY.*OR cm_artist=ANY.*OR video_id=ANY/s);
  assert.equal(calls[0].args[0],p.id);
  assert.equal(calls[0].args[3].length,40);
  await assert.rejects(assertSparseNonReplay({query:async()=>({rows:[{n:1}]})},p));
});
test('new gate rolls back historical conflicts before any allocation or paid reservation',async()=>{
  const p=bundle().children[0].plan,approval=approveVideoStage(p,{expectedPlanSha256:digest(p),capCents:80,approvedAt:at});
  const calls=[],client={release(){},async query(sql){
    calls.push(sql);
    if(sql.includes('SELECT status FROM'))return {rows:[{status:'stopped'}]};
    if(sql.includes('run_id<>$1'))return {rows:[{n:1}]};
    return {rows:[{n:0}]};
  }};
  const pool={query:async()=>{},connect:async()=>client};
  await assert.rejects(sparseUploaderGate({pool,plan:p,approval,owner:'fixture'}).start());
  assert.ok(calls.indexOf('BEGIN')<calls.findIndex(s=>s.includes('FOR UPDATE')));
  assert.equal(calls.at(-1),'ROLLBACK');assert.ok(!calls.some(s=>s.startsWith('INSERT')));
});
test('available real parent archives validate all five cohorts without any network',async t=>{
  try{await fs.access('generated-artifacts/'+SPARSE_SOURCE+'/plan.json');}
  catch(e){if(e.code==='ENOENT'){t.skip('Saved operational archives not present in this checkout');return;}throw e;}
  const s=await sparseSources();
  assert.equal(s.cohorts.length,5);assert.equal(s.cases.length,100);
  assert.equal(s.selected.length,55);
  const c=s.cases.filter(c=>!c.directSelected&&c.resolutionQueue.length);
  assert.equal(c.length,24);assert.equal(c.reduce((n,c)=>n+c.resolutionQueue.length,0),44);
  assert.ok(c.every(c=>c.resolutionQueue.length<=2));
  for(const artist of c){
    if(artist.videoClues.some(v=>v.eligible&&v.sources.some(s=>!s.videoMentionHold&&s.roleHint==='topic_or_distribution')))
      assert.ok(artist.resolutionQueue.some(v=>v.sources.some(s=>!s.videoMentionHold&&s.roleHint==='topic_or_distribution')));
  }
});
