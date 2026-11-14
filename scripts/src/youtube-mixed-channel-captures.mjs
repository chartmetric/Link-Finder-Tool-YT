// Preparation policy for direct channel URLs plus triaged video uploaders.
// A URL/handle is a request target, not a proven channel ID or artist identity.
import assert from 'node:assert/strict';
import {digest} from './youtube-video-discovery-offline.mjs';
import {youtubeSearchPlan} from './youtube-search-plan.mjs';
import {youtubeOwnershipUrl} from './youtube-ownership-policy.mjs';
import {youtubeChannelReviews} from './youtube-channel-review-decisions.mjs';
import {buildVideoUploaderReport} from './youtube-uploader-report.mjs';
export const MIXED_CAPTURE_POLICY='exact-mixed-source-youtube-captures-v1';
export const DIRECT_CAPTURE_POLICY='exact-saved-search-channel-captures-v1';
const norm=s=>String(s??'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const clone=v=>JSON.parse(JSON.stringify(v));
export function mixedCapturePlan(input){
  const version=input.version??MIXED_CAPTURE_POLICY;
  assert.ok([MIXED_CAPTURE_POLICY,DIRECT_CAPTURE_POLICY].includes(version));
  const directOnly=version===DIRECT_CAPTURE_POLICY;
  assert.match(input.id,/^youtube-mixed-captures-[a-z0-9-]{4,80}$/);
  assert.ok(Number.isFinite(Date.parse(input.preparedAt)));
  assert.match(input.sourceSearchId,/^youtube-test-[a-z0-9-]{4,100}$/);
  if(directOnly){
    assert.deepEqual(input.sourceUploaderIds,[]);assert.deepEqual(input.uploaderResults,[]);
    assert.ok(Array.isArray(input.cohortClaims));
  }else assert.ok(input.sourceUploaderIds.length);
  for(const id of input.sourceUploaderIds)assert.match(id,/^youtube-video-review-[a-z0-9-]{4,80}$/);
  assert.ok(input.artists.length&&input.artists.length<=20);
  assert.equal(new Set(input.artists.map(a=>a.profileId)).size,input.artists.length);
  assert.equal(new Set(input.artists.map(a=>a.cmArtist)).size,input.artists.length);
  for(const a of input.artists){
    assert.match(a.profileId,/^\d+$/);assert.match(a.cmArtist,/^\d+$/);
    assert.ok([1,2,3,4,5].includes(a.tier));assert.ok(a.name);
  }
  const artists=new Map(input.artists.map(a=>[a.profileId,a]));
  const pairs=new Map();
  const add=(a,url,observation)=>{
    const target=youtubeOwnershipUrl(url);assert.ok(target);
    const key=JSON.stringify([a.profileId,a.cmArtist,target]);
    const pair=pairs.get(key)??{profileId:a.profileId,cmArtist:a.cmArtist,artist:a.name,tier:a.tier,
      url:target,channelId:target.match(/\/channel\/(UC[A-Za-z0-9_-]{22})$/)?.[1]??null,observations:[]};
    pair.observations.push(observation);pairs.set(key,pair);
  };
  for(const source of input.directLeads){
    const a=artists.get(source.profileId);assert.ok(a&&a.cmArtist===source.cmArtist&&a.name===source.artist);
    const names=youtubeSearchPlan(a).names.filter(n=>n.kind!=='catalog_account_handle_not_confirmed_alias').map(n=>norm(n.value));
    for(const c of source.candidates){
      const title=String(c.title??'').replace(/\s*[-–—]\s*YouTube\s*$/iu,'').trim();
      const topic=/\s*[-–—]\s*Topic\s*$/iu.test(title);
      const name=topic?title.replace(/\s*[-–—]\s*Topic\s*$/iu,''):title;
      add(a,c.url,{source:'saved_direct_search',title:c.title,
        eligible:names.includes(norm(name)),topicHint:topic||/music\.youtube\.com/i.test(c.sourceUrl??''),
        provenance:clone(c),ownershipAccepted:false,
        reason:names.includes(norm(name))?'Channel title matches a catalog-bound name; capture and identity checks still required':
          'Artist mentioned in search evidence, but channel title has no exact catalog-bound name or alias'});
    }
  }
  const report=buildVideoUploaderReport(input.artists,input.uploaderResults);
  const groups=new Map();
  for(const record of report.records){
    const r=record.result,key=JSON.stringify([r.profileId,r.cmArtist,r.url]);
    const records=groups.get(key)??[];records.push(record);groups.set(key,records);
  }
  for(const records of groups.values()){
    const r=records[0].result,a=artists.get(r.profileId);assert.ok(a&&a.cmArtist===r.cmArtist);
    const consistent=new Set(records.map(x=>String(x.result.uploaderName).normalize('NFKC').toLowerCase().trim())).size===1;
    const eligible=consistent&&records.every(x=>x.triage.candidate);
    add(a,r.url,{source:'saved_video_uploaders',eligible,
      topicHint:/\s*[-–—]\s*Topic\s*$/iu.test(r.uploaderName),
      title:r.uploaderName,reason:eligible?'Uploader name triage only; independent artist identity still unverified':
        'Uploader excluded or conflicting; not eligible for verification selection',
      provenance:records.map(x=>({videoUrl:x.result.videoUrl,review:x.triage,
        rawReceipt:x.result.rawReceipt,ownershipAccepted:false})),ownershipAccepted:false});
  }
  const alternatives=[...pairs.values()];
  const owners=new Map();
  for(const p of alternatives){
    const key=p.url.toLowerCase(),claims=owners.get(key)??new Set();
    claims.add(p.profileId+':'+p.cmArtist);owners.set(key,claims);
  }
  if(directOnly)for(const claim of input.cohortClaims){
    assert.match(claim.profileId,/^\d+$/);assert.equal(typeof claim.cmArtist,'string');
    const alias=youtubeOwnershipUrl(claim.url);assert.ok(alias);
    const key=alias.toLowerCase(),claims=owners.get(key);
    if(claims)claims.add(claim.profileId+':'+claim.cmArtist);
  }
  for(const p of alternatives){
    const rejected=youtubeChannelReviews.some(r=>r.profileId===p.profileId&&r.cmArtist===p.cmArtist
      &&r.url===p.url&&r.status==='rejected');
    p.eligible=!rejected&&owners.get(p.url.toLowerCase()).size===1&&p.observations.some(o=>o.eligible)
      &&!p.observations.some(o=>o.source==='saved_video_uploaders'&&!o.eligible);
    if(directOnly)p.sharedChannelConflict=owners.get(p.url.toLowerCase()).size>1;
    p.disposition=rejected?'user_rejected':p.eligible?'eligible_unverified':'held_not_established';
    p.ownershipAccepted=false;p.importEligible=false;
  }
  const selections=[];
  for(const a of input.artists){
    const candidates=alternatives.filter(p=>p.profileId===a.profileId&&p.eligible);
    // Prefer a named ordinary channel over a Topic/music-presence lead, then
    // prefer a validated uploader observation. Never infer handle/ID aliases.
    candidates.sort((x,y)=>Number(x.observations.every(o=>o.topicHint))-Number(y.observations.every(o=>o.topicHint))
      ||Number(y.observations.some(o=>o.source==='saved_video_uploaders'&&o.eligible))-
        Number(x.observations.some(o=>o.source==='saved_video_uploaders'&&o.eligible)));
    const selected=candidates[0];if(!selected)continue;
    selected.disposition='selected_for_capture';
    for(const other of candidates.slice(1))other.disposition='deferred_one_channel_per_artist';
    selections.push({profileId:a.profileId,cmArtist:a.cmArtist,artist:a.name,tier:a.tier,
      url:selected.url,channelId:selected.channelId,
      topicLabel:selected.observations.some(o=>o.topicHint)
        ?'Topic/music lead — channel type needs capture':'Channel type needs capture',
      selectionEvidenceSha256:digest(selected)});
  }
  assert.ok(selections.length&&selections.length<=20);
  selections.sort((a,b)=>a.tier-b.tier);
  const operations=selections.map(s=>{
    const request={method:'GET',url:'https://api.scrapecreators.com/v1/youtube/channel?'+new URLSearchParams({url:s.url})};
    return {key:'metadata-'+s.profileId+'-'+digest(s.url).slice(0,16),kind:'metadata',
      profileId:s.profileId,cmArtist:s.cmArtist,targetUrl:s.url,expectedChannelId:s.channelId,
      // Namespaced URL keys are explicitly unresolved allocation identities,
      // never fabricated YouTube IDs. Captured aliases are checked on return.
      allocationChannelKey:s.channelId??'unresolved-url:'+s.url.toLowerCase(),
      request,inputSha256:digest(request),reservationCents:2};
  });
  for(const files of [input.sourceFiles,input.runtimeFiles]){
    assert.ok(files&&Object.keys(files).length);
    for(const [file,sha] of Object.entries(files)){
      assert.match(file,/^[A-Za-z0-9_./-]+$/);
      assert.ok(!file.startsWith('/')&&!file.split('/').some(p=>['','..','.'].includes(p)));
      assert.match(sha,/^[a-f0-9]{64}$/);
    }
  }
  assert.ok(Object.keys(input.sourceFiles).every(file=>file.startsWith('generated-artifacts/')));
  assert.ok(Object.keys(input.runtimeFiles).every(file=>file.startsWith('runtime/')));
  return {version,id:input.id,preparedAt:input.preparedAt,
    artists:clone(input.artists),directLeads:clone(input.directLeads),uploaderResults:clone(input.uploaderResults),
    sourceFiles:clone(input.sourceFiles),runtimeFiles:clone(input.runtimeFiles),alternatives,selections,operations,
    maximumCalls:operations.length,maximumSpendCents:operations.length*2,
    sourceSearchId:input.sourceSearchId,sourceUploaderIds:clone(input.sourceUploaderIds),
    ...(directOnly?{cohortClaims:clone(input.cohortClaims)}:{}),
    explicitApproval:false,executionEnabled:false,noRetries:true,noCatalogWrites:true,
    fullCampaignRemainsPaused:true,modelCalls:0,unknownModelRequestsApproved:false,
    note:'One channel capture per selected artist. Unproven handle/ID aliases stay separate; other eligible channels are deferred, not rejected. Channel capture is not artist identity verification.'};
}
export function validateMixedCapturePlan(plan){assert.deepEqual(mixedCapturePlan(plan),plan);return plan;}
export function approveMixedCaptures(plan,{planSha256,capCents,approvedAt}){
  validateMixedCapturePlan(plan);assert.equal(planSha256,digest(plan));
  assert.equal(capCents,plan.maximumSpendCents);assert.ok(Number.isFinite(Date.parse(approvedAt)));
  assert.ok(Date.parse(approvedAt)>=Date.parse(plan.preparedAt),'Approval predates this exact preparation');
  return {id:plan.id,policy:plan.version,planSha256,capCents,approvedAt,explicitApproval:true,executionEnabled:true,
    scope:'exact_channel_captures_only_no_models_no_retries_no_substitution'};
}
