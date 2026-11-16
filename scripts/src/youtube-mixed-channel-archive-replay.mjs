// Read-only replay of the exact reviewed cohort. No preparation/execution CLI imports.
// Keep the fence first so direct consumers are offline too, not just the test command.
import './youtube-ownership-offline-fence.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {digest} from './youtube-video-discovery-offline.mjs';
import {assertStagedSearchApproval} from './youtube-staged-search-plan.mjs';
import {assertVideoStageApproval} from './youtube-video-stage.mjs';
import {youtubeArtistFromCatalogPacket} from './youtube-ownership-evidence.mjs';
import {youtubeSearchCandidates} from './youtube-discovery-test.mjs';
import {rankYoutubeSearchCandidates} from './youtube-search-plan.mjs';
import {mapOrHoldSavedUploader} from './youtube-uploader-conflict-handling.mjs';
import {mixedCapturePlan} from './youtube-mixed-channel-captures.mjs';

export const MIXED_ARCHIVE_ID='youtube-mixed-captures-fresh-twenty-2026-11-13';
export const MIXED_ARCHIVE_SHA256='50bb3b0e4f07cf904f7e3b1775696b0167211c12569b8e177423a8ccaa5c4bec';
const workspace=fileURLToPath(new URL('../../',import.meta.url));

export async function replayMixedChannelArchive({workspaceRoot=workspace}={}){
  const fingerprints=new Map();
  const bytes=async file=>{
    assert.ok(!path.isAbsolute(file)&&!file.split('/').includes('..'),'Unsafe archive path: '+file);
    let body;
    try{body=await fs.readFile(path.join(workspaceRoot,file));}
    catch(error){
      throw new Error(`Required real YouTube archive unavailable: ${file}. Restore the exact archived files; no provider refetch or substitute evidence is permitted.`,{cause:error});
    }
    const sha=digest(body);
    if(fingerprints.has(file))assert.equal(sha,fingerprints.get(file),'Archive changed during replay: '+file);
    fingerprints.set(file,sha);
    return body;
  };
  const json=async file=>JSON.parse(await bytes(file));
  const planPath=`generated-artifacts/${MIXED_ARCHIVE_ID}/plan.json`;
  const saved=await json(planPath);
  assert.equal(digest(saved),MIXED_ARCHIVE_SHA256,'Prepared mixed-capture archive fingerprint changed');
  // Every subsequent read must be one of the source files sealed by this plan.
  const boundBytes=async file=>{
    assert.ok(Object.hasOwn(saved.sourceFiles,file),'File not bound by prepared mixed-capture plan: '+file);
    const body=await bytes(file);
    assert.equal(digest(body),saved.sourceFiles[file],'Archived source fingerprint mismatch: '+file);
    return body;
  };
  const read=async file=>JSON.parse(await boundBytes(file));
  const receipts=async root=>{
    let names;
    try{names=await fs.readdir(path.join(workspaceRoot,root,'receipts'));}
    catch(error){throw new Error(`Required real YouTube receipt archive unavailable: ${root}/receipts. Restore the exact archive; do not refetch providers.`,{cause:error});}
    return Promise.all(names.filter(n=>n.endsWith('.json')).sort().map(n=>read(`${root}/receipts/${n}`)));
  };
  try{
    for(const file of Object.keys(saved.sourceFiles))await boundBytes(file);
    for(const [file,sha] of Object.entries(saved.runtimeFiles))
      assert.equal(digest(await bytes(`generated-artifacts/${saved.id}/${file}`)),sha,'Archived mixed runtime changed: '+file);
    assert.equal(saved.sourceSearchId,'youtube-test-20-review-search-2026-11-13');
    assert.deepEqual(saved.sourceUploaderIds,[
      'youtube-video-review-fresh-twenty-2026-11-13',
      'youtube-video-review-fresh-eight-continuation-2026-11-13',
      'youtube-video-review-fresh-six-hold-2026-11-13',
    ]);
    const searchRoot='generated-artifacts/'+saved.sourceSearchId;
    const search=await read(searchRoot+'/plan.json');
    assertStagedSearchApproval(search,await read(searchRoot+'/approval.json'));
    assert.equal((await read(searchRoot+'/summary.json')).status,'completed');
    const verifyFiles=async(root,plan)=>{
      for(const [name,sha] of Object.entries({...plan.evidenceFiles,...plan.runtimeFiles}))
        assert.equal(digest(await boundBytes(root+'/'+name)),sha,'Sealed source file changed: '+root+'/'+name);
    };
    await verifyFiles(searchRoot,search);
    const artists=search.artists.map(a=>({...youtubeArtistFromCatalogPacket(
      search.packets.find(p=>p.profileId===a.profile_id&&p.cmArtist===a.cm_artist)),tier:a.tier}));
    const searchReceipts=await receipts(searchRoot);
    assert.equal(searchReceipts.length,20);
    const directLeads=[];
    for(const a of search.artists){
      const record=await read(searchRoot+'/artists/'+a.profile_id+'.json');
      const {tier,...artist}=artists.find(x=>x.profileId===a.profile_id);
      assert.deepEqual(record.artist,artist);
      const op=search.operations.find(o=>o.profileId===a.profile_id);
      const matching=searchReceipts.filter(r=>r.operationKey===op.key);
      assert.equal(matching.length,1,'Expected one search receipt for '+op.key);
      const [receipt]=matching;
      assert.equal(receipt.status,200);
      assert.deepEqual(receipt.request,op.request);
      assert.equal(receipt.inputSha256,op.inputSha256);
      const ranked=rankYoutubeSearchCandidates(youtubeSearchCandidates(receipt.data),record.searchPlan,
        {limit:2,includeTopicChannels:true});
      assert.deepEqual(record.candidates,ranked.candidates);
      directLeads.push({profileId:a.profile_id,cmArtist:a.cm_artist,artist:a.artist,candidates:ranked.candidates});
    }
    const uploaderResults=[],unresolved=[],seen=new Set();
    for(const sourceId of saved.sourceUploaderIds){
      const root='generated-artifacts/'+sourceId,plan=await read(root+'/plan.json');
      assertVideoStageApproval(plan,await read(root+'/approval.json'));
      await read(root+'/summary.json'); // Stopped stages intentionally retain paid responses.
      await verifyFiles(root,plan);
      for(const receipt of await receipts(root)){
        assert.ok(!seen.has(receipt.operationKey),'Duplicate uploader receipt: '+receipt.operationKey);
        seen.add(receipt.operationKey);
        const op=plan.operations.find(o=>o.key===receipt.operationKey);
        assert.ok(op,'Uploader receipt must bind an approved operation');
        const evidence=await read(root+'/evidence/'+op.profileId+'.json');
        const rawBody=await boundBytes(root+'/'+receipt.rawPath);
        const clue=evidence.videoPlan.resolutionQueue.find(v=>v.videoId===op.videoId);
        const reviewed=mapOrHoldSavedUploader(evidence.artist,clue,{...receipt,rawBody},
          {runId:plan.id,planSha256:digest(plan)},{holdConflicts:true});
        if(reviewed.kind==='held_conflict'){
          unresolved.push({sourceId,operationKey:receipt.operationKey,...reviewed.result});
          continue;
        }
        const result=await read(root+'/results/'+digest(op.key)+'.json');
        for(const [key,value] of Object.entries(reviewed.result))assert.deepEqual(result[key],value);
        uploaderResults.push(result);
      }
    }
    assert.equal(seen.size,24);
    assert.equal(uploaderResults.length,22);
    assert.deepEqual(unresolved.map(r=>r.operationKey).sort(),[
      'video_uploader-3774889-14800073-R7ggpv_gKXU',
      'video_uploader-3977444-14288720-2dy69FinNV4',
    ]);
    const replay=mixedCapturePlan({...saved,artists,directLeads,uploaderResults});
    assert.deepEqual(replay,saved,'Live mixed-capture policy diverged from the reviewed real archive');
    return {saved,replay,unresolved,sourceFilesChecked:Object.keys(saved.sourceFiles).length};
  }finally{
    // Includes the prepared plan, all bound sources and frozen runtime files.
    for(const file of fingerprints.keys())await bytes(file);
  }
}
