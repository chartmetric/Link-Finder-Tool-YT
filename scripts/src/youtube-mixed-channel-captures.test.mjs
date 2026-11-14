import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import {digest} from './youtube-video-discovery-offline.mjs';
import {mixedCapturePlan,approveMixedCaptures,validateMixedCapturePlan,DIRECT_CAPTURE_POLICY} from './youtube-mixed-channel-captures.mjs';
import {channelCheckBundle,approveChannelCheckBundle} from './youtube-channel-check-bundle.mjs';
import {refreshedDirectCaptureInput} from './youtube-direct-capture-refresh.mjs';
import {executeMixedCaptures} from './run-youtube-mixed-captures.mjs';
const channel=n=>'UC'+String(n).padStart(22,'a');
const url=n=>'https://www.youtube.com/channel/'+channel(n);
const artist=(n,name)=>({profileId:String(n),cmArtist:String(n+100),name,tier:2,
  catalogProfile:{profile_id:String(n),cm_artist:String(n+100)}});
function input(){
  const artists=[artist(1,'Artist One'),artist(2,'Artist Two')];
  return {id:'youtube-mixed-captures-synthetic-test',preparedAt:'2026-11-13T20:00:00.000Z',artists,
    directLeads:artists.map((a,i)=>({profileId:a.profileId,cmArtist:a.cmArtist,artist:a.name,
      candidates:[{url:url(i+1),title:a.name,snippet:'artist music'}]})),uploaderResults:[],
    sourceSearchId:'youtube-test-synthetic-source',sourceUploaderIds:['youtube-video-review-synthetic-source'],
    sourceFiles:{'generated-artifacts/synthetic-source/plan.json':digest('source')},
    runtimeFiles:{'runtime/synthetic.mjs':digest('runtime')}};
}
const approval=plan=>approveMixedCaptures(plan,{planSha256:digest(plan),capCents:plan.maximumSpendCents,
  approvedAt:'2026-11-13T21:00:00.000Z'});
function directInput(){
  const f=input();
  return {...f,version:DIRECT_CAPTURE_POLICY,sourceUploaderIds:[],cohortClaims:f.directLeads.flatMap(r=>
    r.candidates.map(c=>({url:c.url,profileId:r.profileId,cmArtist:r.cmArtist})))};
}
test('an unexecuted direct proposal can be narrowed after a daily tier refresh without transferring approval',()=>{
  const previous=mixedCapturePlan(directInput());
  const rows=previous.selections.map(s=>({profile_id:s.profileId,cm_artist:s.cmArtist,artist:s.artist,tier:3}));
  const options={id:'youtube-mixed-captures-refreshed-synthetic',preparedAt:'2026-11-14T01:35:00Z',
    sourceFiles:previous.sourceFiles,runtimeFiles:previous.runtimeFiles};
  const result=refreshedDirectCaptureInput(previous,rows,options),plan=mixedCapturePlan(result.input);
  assert.deepEqual(plan.operations,previous.operations);assert.ok(plan.selections.every(s=>s.tier===3));
  assert.ok(plan.artists.every(a=>a.startingTier===previous.artists.find(p=>p.profileId===a.profileId).tier));
  assert.deepEqual(result.deferred,[]);
  assert.throws(()=>approveMixedCaptures(plan,approval(previous)));
  const partial=refreshedDirectCaptureInput(previous,rows.slice(1),options);
  assert.equal(mixedCapturePlan(partial.input).maximumCalls,1);
  assert.equal(partial.deferred.length,1);assert.equal(partial.deferred[0].noMatch,false);
  assert.equal(partial.deferred[0].processed,false);assert.equal(partial.deferred[0].paidCalls,0);
  const held=refreshedDirectCaptureInput(previous,rows.map(r=>({...r,cm_artist:'99999'})),options);
  assert.equal(held.input,null);assert.equal(held.deferred.length,2);
  assert.throws(()=>refreshedDirectCaptureInput(previous,[...rows,rows[0]],options));
  assert.throws(()=>refreshedDirectCaptureInput(previous,rows,{...options,id:previous.id}));
});
test('direct-search captures require a new policy and cannot inherit mixed-source approval or invent uploaders',()=>{
  const p=mixedCapturePlan(directInput());validateMixedCapturePlan(p);
  assert.equal(p.version,DIRECT_CAPTURE_POLICY);assert.deepEqual(p.sourceUploaderIds,[]);
  assert.deepEqual(p.uploaderResults,[]);assert.equal(p.modelCalls,0);
  assert.equal(approval(p).policy,DIRECT_CAPTURE_POLICY);
  const legacy=approval(mixedCapturePlan(input()));
  assert.throws(()=>approveMixedCaptures(p,legacy));
  for(const patch of [{sourceUploaderIds:['youtube-video-review-invented-source']},
    {uploaderResults:[{not:'a saved uploader'}]},{cohortClaims:undefined}]){
    assert.throws(()=>mixedCapturePlan({...directInput(),...patch}));
  }
});
test('claims from another cohort or historical profile hold a direct candidate without proving a mismatch',()=>{
  const f=directInput();
  f.cohortClaims.push({url:url(1),profileId:'999',cmArtist:'1999',source:'another_source_cohort'});
  const p=mixedCapturePlan(f);
  assert.equal(p.maximumCalls,1);assert.equal(p.selections[0].profileId,'2');
  const held=p.alternatives.find(a=>a.profileId==='1');
  assert.equal(held.sharedChannelConflict,true);assert.equal(held.disposition,'held_not_established');
  assert.equal(held.ownershipAccepted,false);assert.equal(held.importEligible,false);
});
test('aggregate channel approval binds every child, exact URLs, summed cap and metadata-only authority',()=>{
  const child=mixedCapturePlan(directInput());
  const p=channelCheckBundle({id:'youtube-batch-channel-checks-synthetic',preparedAt:'2026-11-13T20:01:00Z',
    sourceBundleId:'youtube-batch-100-synthetic',sourceBundleSha256:digest('source'),
    children:[{id:child.id,plan:child}],runtimeFiles:{'runtime/run.mjs':digest('wrapper')}});
  assert.equal(p.maximumCalls,2);assert.equal(p.maximumSpendCents,4);
  assert.deepEqual(p.allowedKinds,['metadata']);assert.equal(p.uploaderCalls,0);assert.equal(p.modelCalls,0);
  const opts={planSha256:digest(p),capCents:4,approvedAt:'2026-11-13T21:00:00Z'};
  const a=approveChannelCheckBundle(p,opts);
  assert.throws(()=>approveChannelCheckBundle(p,{...opts,capCents:26}));
  for(const change of [
    x=>x.children[0].plan.operations[0].targetUrl=url(9),
    x=>x.maximumSpendCents++,x=>x.allowedKinds.push('model'),
    x=>x.runtimeFiles['runtime/run.mjs']=digest('changed'),x=>x.sourceBundleSha256=digest('changed'),
  ]){
    const q=structuredClone(p);change(q);assert.throws(()=>approveChannelCheckBundle(q,a));
  }
  const duplicate=mixedCapturePlan({...directInput(),id:'youtube-mixed-captures-another-cohort'});
  assert.throws(()=>channelCheckBundle({...p,children:[...p.children,{id:duplicate.id,plan:duplicate}]}));
});
test('plan deduplicates channel URLs, retains Topic labels and defers alternatives without alias guesses',()=>{
  const f=input(),a=f.directLeads[0];
  a.candidates.push({...a.candidates[0]}, {url:url(3),title:'Artist One - Topic',sourceUrl:url(3)});
  const p=mixedCapturePlan(f);
  assert.equal(p.maximumCalls,2);assert.equal(p.maximumSpendCents,4);
  assert.equal(p.alternatives.length,3);assert.equal(p.alternatives[0].observations.length,2);
  assert.equal(p.alternatives[2].disposition,'selected_for_capture');
  const topic=p.alternatives.find(a=>a.url===url(3));
  assert.equal(topic.disposition,'deferred_one_channel_per_artist');
  assert.equal(topic.observations[0].topicHint,true);
  assert.equal(p.modelCalls,0);assert.equal(p.explicitApproval,false);assert.equal(p.executionEnabled,false);
  assert.ok(p.alternatives.every(a=>!a.ownershipAccepted&&!a.importEligible));
  validateMixedCapturePlan(p);
});
test('a snippet mention cannot turn another person, a group or a label into a matching channel',()=>{
  const f=input();
  for(const title of ['Record Label','Artist One Türkiye','A Band','Lyric Uploader'])
    f.directLeads[0].candidates.unshift({url:url(f.directLeads[0].candidates.length+3),title,
      snippet:'Artist One official songs and music'});
  const p=mixedCapturePlan(f);
  assert.equal(p.selections[0].url,url(1));
  assert.equal(p.alternatives.filter(a=>a.disposition==='held_not_established').length,4);
});
test('unknown handles stay unresolved targets and do not become guessed channel IDs',()=>{
  const f=input();f.directLeads[0].candidates=[{url:'https://www.youtube.com/@artistone',title:'Artist One'}];
  const p=mixedCapturePlan(f),op=p.operations[0];
  assert.equal(op.expectedChannelId,null);
  assert.equal(op.allocationChannelKey,'unresolved-url:https://www.youtube.com/@artistone');
  assert.equal(p.selections[0].channelId,null);
  assert.ok(op.request.url.includes(encodeURIComponent('https://www.youtube.com/@artistone')));
});
test('cross-artist shared URLs and exact user rejections are held, not selected',()=>{
  const f=input();f.artists.push(artist(3,'A Third Artist'));
  f.directLeads.push({profileId:'3',cmArtist:'103',artist:'A Third Artist',
    candidates:[{url:url(1),title:'A Third Artist'}]});
  const p=mixedCapturePlan(f);
  assert.equal(p.maximumCalls,1);assert.equal(p.selections[0].profileId,'2');
  const rejected=artist(3568519,'BROWN BEAVERS');rejected.cmArtist='16153374';
  rejected.catalogProfile.cm_artist=rejected.cmArtist;f.artists.push(rejected);
  f.directLeads.push({profileId:rejected.profileId,cmArtist:rejected.cmArtist,artist:rejected.name,
    candidates:[{url:'https://www.youtube.com/channel/UCoh7-Yh-mgKVDM_8HbjKPUQ',title:'BROWN BEAVERS'}]});
  assert.equal(mixedCapturePlan(f).alternatives.at(-1).disposition,'user_rejected');
});
test('approval binds exact inputs, targets, code and cost with no permission for models',()=>{
  const p=mixedCapturePlan(input()),a=approval(p);
  assert.equal(a.executionEnabled,true);
  for(const change of [
    q=>q.selections[0].url=url(9),q=>q.operations[0].request.url+='&other=1',
    q=>q.maximumSpendCents++,q=>q.runtimeFiles['runtime/synthetic.mjs']=digest('changed'),
  ]){
    const modified=structuredClone(p);change(modified);
    assert.throws(()=>approveMixedCaptures(modified,a));
  }
  assert.throws(()=>approveMixedCaptures(p,{...a,capCents:5}));
  assert.throws(()=>approveMixedCaptures(p,{...a,approvedAt:'2026-11-12T00:00:00.000Z'}));
});
async function executionFixture(t){
  const root=await fs.mkdtemp(os.tmpdir()+'/mixed-capture-test-');
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const plan=mixedCapturePlan(input()),state={run:null,admissions:[],claims:[],requests:[]};
  let backup;
  const client={release(){},async query(sql,args=[]){
    if(sql==='BEGIN'){backup=structuredClone({...state,requests:[]});return {rows:[]};}
    if(sql==='ROLLBACK'){const requests=state.requests;Object.assign(state,backup);state.requests=requests;return {rows:[]};}
    if(sql==='COMMIT')return {rows:[]};
    if(sql.startsWith('SELECT status FROM youtube_link_campaigns'))return {rows:[{status:'stopped'}]};
    if(sql.startsWith('INSERT INTO youtube_video_identity_runs')){
      state.run={id:args[0],owner:args[1],plan_sha256:args[2],approval_sha256:args[3],
        execution_sha256:args[4],cap_cents:args[5],reserved_cents:0,status:'running'};return {rowCount:1};
    }
    if(sql.startsWith('SELECT * FROM youtube_video_identity_runs'))return {rows:[structuredClone(state.run)]};
    if(sql.startsWith('SELECT * FROM youtube_video_identity_admissions'))return {rows:structuredClone(state.admissions)};
    if(sql.startsWith('SELECT profile_id,cm_artist FROM youtube_video_identity_claims')
      ||sql.startsWith('SELECT * FROM youtube_video_identity_claims'))return {rows:state.claims};
    if(sql.includes('FROM youtube_link_campaign_channels')||sql.includes('FROM youtube_discovery_test_results'))return {rows:[]};
    if(sql.startsWith('INSERT INTO youtube_video_identity_admissions')){
      state.admissions.push({run_id:args[0],operation_key:args[1],profile_id:args[2],cm_artist:args[3],
        channel_id:args[4],kind:'metadata',input_sha256:args[5],reserved_cents:2,status:'admitted'});return {rowCount:1};
    }
    if(sql.includes('SET reserved_cents=reserved_cents+2')){
      assert.ok(state.run.reserved_cents+2<=state.run.cap_cents);state.run.reserved_cents+=2;return {rowCount:1};
    }
    if(sql.startsWith('INSERT INTO youtube_video_identity_claims'))return {rowCount:1};
    if(sql.includes("SET status='returned'")){
      const receipt=JSON.parse(await fs.readFile(root+'/receipts/'+digest(args[1])+'.json'));
      const raw=await fs.readFile(root+'/'+receipt.rawPath);
      assert.equal(digest(receipt),args[2]);assert.equal(digest(raw),args[3]);
      const r=state.admissions.find(a=>a.operation_key===args[1]);assert.equal(r.status,'admitted');
      Object.assign(r,{status:'returned',receipt_sha256:args[2],raw_sha256:args[3],http_status:200});return {rowCount:1};
    }
    if(sql.includes("SET status='completed'")){state.run.status='completed';return {rowCount:1};}
    if(sql.includes("SET status='stopped'")){state.run.status='stopped';return {rowCount:1};}
    throw Error('Unexpected test SQL: '+sql);
  }};
  const f={root,plan,approval:approval(plan),pool:{connect:async()=>client},client,state,
    credential:'synthetic-key',assertFrozen:async()=>{},checkCatalog:async()=>{},
    readinessCheck:async()=>{}};
  f.fetchImpl=async request=>{
    const i=state.requests.length;state.requests.push(request);
    assert.equal(state.admissions.length,i+1);assert.equal(state.admissions[i].status,'admitted');
    const op=plan.operations[i];assert.equal(request,op.request.url);
    return Response.json({success:true,credits_charged:1,channelId:op.expectedChannelId,
      channel:op.targetUrl,name:plan.selections[i].artist,description:'Musician'});
  };
  return f;
}
test('capture execution reserves before sending, saves before acknowledgment and stays within exact cap',async t=>{
  const f=await executionFixture(t);await executeMixedCaptures(f);
  assert.equal(f.state.requests.length,2);assert.equal(f.state.run.reserved_cents,4);
  assert.equal(f.state.run.status,'completed');assert.ok(f.state.admissions.every(a=>a.status==='returned'));
  const out=JSON.parse(await fs.readFile(f.root+'/returns.json'));
  assert.equal(out.returns.length,2);assert.ok(out.returns.every(r=>!r.ownershipAccepted&&!r.importEligible));
  // The database run primary key and exclusive files prevent replay.
  let touched=false;
  await assert.rejects(()=>executeMixedCaptures({...f,approval:{...f.approval,capCents:99},
    fetchImpl:async()=>{touched=true;}}));assert.equal(touched,false);
});
test('a handle capture resolves only from saved metadata and stays unapproved as an artist link',async t=>{
  const f=await executionFixture(t),i=input();i.directLeads[0].candidates[0].url='https://www.youtube.com/@artistone';
  f.plan=mixedCapturePlan(i);f.approval=approval(f.plan);
  f.fetchImpl=async request=>{
    const n=f.state.requests.length;f.state.requests.push(request);
    const op=f.plan.operations[n];
    assert.equal(request,op.request.url);assert.equal(f.state.admissions[n].status,'admitted');
    return Response.json({success:true,credits_charged:1,channelId:channel(n+1),channel:op.targetUrl,
      name:f.plan.selections[n].artist,description:'Musician'});
  };
  await executeMixedCaptures(f);
  const out=JSON.parse(await fs.readFile(f.root+'/returns.json'));
  assert.equal(f.plan.operations[0].expectedChannelId,null);
  assert.equal(out.returns[0].capture.body.channelId,channel(1));
  assert.equal(out.returns[0].ownershipAccepted,false);
  assert.equal(f.state.run.reserved_cents,4);
});
test('new direct-search policy uses the bounded capture executor without any uploader or model calls',async t=>{
  const f=await executionFixture(t);f.plan=mixedCapturePlan(directInput());f.approval=approval(f.plan);
  await executeMixedCaptures(f);
  assert.equal(f.state.requests.length,2);assert.equal(f.state.run.reserved_cents,4);
  assert.equal(f.state.run.status,'completed');
  assert.ok(f.state.requests.every(r=>r.startsWith('https://api.scrapecreators.com/v1/youtube/channel?')));
});
test('new catalog conflicts and lost acknowledgment preserve the paid receipt and stop dispatch',async t=>{
  for(const fault of ['catalog_after_return','database_acknowledgment']){
    await t.test(fault,async t=>{
      const f=await executionFixture(t);
      if(fault==='catalog_after_return'){
        let checks=0;f.checkCatalog=async()=>{if(++checks===3)throw Error('new artist claim');};
      }else{
        const query=f.client.query.bind(f.client);
        f.client.query=async(sql,args)=>{
          if(sql.includes("SET status='returned'"))throw Error('lost acknowledgment');
          return query(sql,args);
        };
      }
      await assert.rejects(()=>executeMixedCaptures(f));
      assert.equal(f.state.requests.length,1);assert.equal(f.state.run.reserved_cents,2);
      assert.equal(f.state.admissions[0].status,'admitted');assert.equal(f.state.run.status,'stopped');
      const op=f.plan.operations[0],receipt=JSON.parse(await fs.readFile(f.root+'/receipts/'+digest(op.key)+'.json'));
      assert.equal(digest(await fs.readFile(f.root+'/'+receipt.rawPath)),receipt.rawBodySha256);
    });
  }
});
for(const fault of ['provider_error','wrong_channel','unknown_price','malformed','catalog_change','readiness_failure']){
  test('capture execution stops without retries after '+fault,async t=>{
    const f=await executionFixture(t),normal=f.fetchImpl;
    if(fault==='readiness_failure')f.readinessCheck=async()=>{throw Error('unacknowledged earlier charge');};
    else if(fault==='catalog_change')f.checkCatalog=async()=>{throw Error('eligibility changed');};
    else f.fetchImpl=async request=>{
      const res=await normal(request),body=await res.json();
      if(fault==='wrong_channel')body.channelId=channel(9);
      if(fault==='unknown_price')body.credits_charged=2;
      if(fault==='malformed')return new Response('{broken');
      return Response.json(body,{status:fault==='provider_error'?500:200});
    };
    await assert.rejects(()=>executeMixedCaptures(f));
    assert.ok(f.state.requests.length<=1);
    if(f.state.requests.length){assert.equal(f.state.run.reserved_cents,2);assert.equal(f.state.run.status,'stopped');
      assert.equal(f.state.admissions[0].status,'admitted');}
    else assert.equal(f.state.run,null);
  });
}
