// A new metadata-only policy for the fully accounted, split 500-search source.
// Historical 20/100-artist policies and approvals are deliberately unchanged.
import assert from 'node:assert/strict';
import {digest} from './youtube-video-discovery-offline.mjs';
import {youtubeSearchPlan} from './youtube-search-plan.mjs';
import {youtubeOwnershipUrl} from './youtube-ownership-policy.mjs';
import {youtubeChannelReviews} from './youtube-channel-review-decisions.mjs';
export const ACCOUNTED_CHANNEL_POLICY='exact-accounted-search-channel-checks-v1';
const norm=s=>String(s??'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const clone=v=>JSON.parse(JSON.stringify(v));
export function accountedChannelPlan(input){
  assert.match(input.id,/^youtube-accounted-channel-checks-[a-z0-9-]{4,65}$/);
  assert.ok(Number.isFinite(Date.parse(input.preparedAt)));
  assert.equal(input.records.length,500);
  for(const key of ['profileId','cmArtist'])
    assert.equal(new Set(input.records.map(r=>r.record.artist[key])).size,500);
  const claims=new Map();
  const claim=(url,profileId,cmArtist)=>{
    const target=youtubeOwnershipUrl(url);assert.ok(target);
    const key=target.toLowerCase(),owners=claims.get(key)??new Set();
    owners.add(String(profileId)+':'+String(cmArtist));claims.set(key,owners);
  };
  for(const r of input.records)for(const c of r.record.candidates)
    claim(c.url,r.record.artist.profileId,r.record.artist.cmArtist);
  for(const c of input.claims)claim(c.url,c.profileId,c.cmArtist);
  const rows=new Map();
  for(const r of input.currentRows){
    assert.ok(!rows.has(String(r.profile_id)),'Duplicate current eligibility');
    rows.set(String(r.profile_id),r);
  }
  const alternatives=[],selections=[],remaining=[];
  for(const source of input.records){
    const r=source.record,a=r.artist;
    assert.match(a.profileId,/^\d+$/);assert.match(a.cmArtist,/^\d+$/);
    assert.equal(r.ownershipAccepted,false);
    const current=rows.get(a.profileId);
    const at=String(current?.snapshot_at??'');
    const age=Date.parse(input.preparedAt)-Date.parse(at.includes('T')?at:at.replace(' ','T')+'Z');
    const eligibilityReason=!current?'Not present in the current eligible global-tier group':
      String(current.cm_artist)!==a.cmArtist||current.artist!==a.name?'Current catalog identity changed':
        ![1,2,3,4,5].includes(Number(current.tier))?'Current tier is outside 1–5':
          !Number.isFinite(age)||age<0||age>36*3600000?'Current global-tier snapshot is stale':null;
    const names=youtubeSearchPlan(a).names.filter(n=>n.kind!=='catalog_account_handle_not_confirmed_alias')
      .map(n=>norm(n.value));
    const pairs=new Map();
    for(const c of r.candidates){
      const url=youtubeOwnershipUrl(c.url);assert.ok(url);
      const pair=pairs.get(url)??{profileId:a.profileId,cmArtist:a.cmArtist,artist:a.name,
        startingTier:r.tier,tier:current?Number(current.tier):r.tier,url,observations:[],
        channelId:url.match(/\/channel\/(UC[A-Za-z0-9_-]{22})$/)?.[1]??null,
        sourceRunId:source.sourceRunId,sourceReceipt:source.sourceReceipt,
        sourceReceiptSha256:source.receiptSha256,ownershipAccepted:false,importEligible:false};
      const title=String(c.title??'').replace(/\s*[-–—]\s*YouTube\s*$/iu,'').trim();
      const topic=/\s*[-–—]\s*Topic\s*$/iu.test(title);
      const name=topic?title.replace(/\s*[-–—]\s*Topic\s*$/iu,''):title;
      pair.observations.push({title:c.title,topicHint:topic||/music\.youtube\.com/i.test(c.sourceUrl??''),
        exactCatalogName:names.includes(norm(name)),candidate:clone(c)});
      pairs.set(url,pair);
    }
    for(const p of pairs.values()){
      const rejected=youtubeChannelReviews.some(x=>x.profileId===a.profileId&&x.cmArtist===a.cmArtist
        &&x.url===p.url&&x.status==='rejected');
      p.sharedChannelConflict=claims.get(p.url.toLowerCase()).size>1;
      p.reason=rejected?'User rejected this exact artist/channel pair':eligibilityReason??
        (p.sharedChannelConflict?'The channel has claims from different catalog artists':
          p.observations.some(o=>o.exactCatalogName)?null:'Channel title does not match a catalog-bound name or alias');
      p.disposition=p.reason?'held_not_established':'eligible_unverified';
      p.topicLabel=p.observations.some(o=>/\s*[-–—]\s*Topic\s*$/iu.test(
        String(o.title??'').replace(/\s*[-–—]\s*YouTube\s*$/iu,'')))
        ?'Topic — auto-generated lead, association unverified':
          p.observations.some(o=>o.topicHint)?'YouTube Music lead — channel type unverified':
            'Channel type and artist ownership unverified';
      alternatives.push(p);
    }
    const eligible=[...pairs.values()].filter(p=>!p.reason).sort((x,y)=>
      Number(x.observations.every(o=>o.topicHint))-Number(y.observations.every(o=>o.topicHint)));
    const selected=eligible[0];
    if(selected){
      selected.disposition='selected_for_capture';
      for(const p of eligible.slice(1))p.disposition='deferred_one_channel_per_artist';
      selections.push({profileId:a.profileId,cmArtist:a.cmArtist,artist:a.name,startingTier:r.tier,
        tier:Number(current.tier),url:selected.url,channelId:selected.channelId,topicLabel:selected.topicLabel,
        sourceRunId:source.sourceRunId,sourceReceipt:source.sourceReceipt,
        sourceReceiptSha256:source.receiptSha256,selectionEvidenceSha256:digest(selected)});
    }else remaining.push({profileId:a.profileId,cmArtist:a.cmArtist,artist:a.name,startingTier:r.tier,
      savedVideoLeads:r.videoPlan.resolutionQueue.length,
      reason:eligibilityReason??(pairs.size?'Direct leads held; review or separately approved video fallback required':
        r.videoPlan.resolutionQueue.length?'Saved-video fallback requires separate approval':'No usable lead — channel absence not proven'),
      processed:false,noMatch:false});
  }
  const operations=selections.map(s=>{
    const request={method:'GET',url:'https://api.scrapecreators.com/v1/youtube/channel?'+new URLSearchParams({url:s.url})};
    return {key:'metadata-'+s.profileId+'-'+digest(s.url).slice(0,16),kind:'metadata',
      profileId:s.profileId,cmArtist:s.cmArtist,targetUrl:s.url,expectedChannelId:s.channelId,
      allocationChannelKey:s.channelId??'unresolved-url:'+s.url.toLowerCase(),
      request,inputSha256:digest(request),reservationCents:2};
  });
  assert.ok(operations.length>0&&operations.length<=500);
  for(const key of ['profileId','cmArtist','allocationChannelKey'])
    assert.equal(new Set(operations.map(o=>o[key])).size,operations.length,'Duplicate '+key);
  for(const [file,sha] of Object.entries(input.sourceFiles)){
    assert.match(file,/^generated-artifacts\/[A-Za-z0-9_./-]+$/);
    assert.ok(!file.split('/').includes('..'));assert.match(sha,/^[a-f0-9]{64}$/);
  }
  assert.ok(Object.keys(input.sourceFiles).length);
  for(const [file,sha] of Object.entries(input.runtimeFiles)){
    assert.match(file,/^runtime\/[A-Za-z0-9_-]+\.mjs$/);assert.match(sha,/^[a-f0-9]{64}$/);
  }
  assert.ok(Object.keys(input.runtimeFiles).length);
  return {version:ACCOUNTED_CHANNEL_POLICY,id:input.id,preparedAt:input.preparedAt,
    sourceRoot:input.sourceRoot,sourceFiles:clone(input.sourceFiles),runtimeFiles:clone(input.runtimeFiles),
    records:clone(input.records),claims:clone(input.claims),currentRows:clone(input.currentRows),
    alternatives,selections,remaining,operations,maximumCalls:operations.length,
    maximumSpendCents:operations.length*2,allowedKinds:['metadata'],noRetries:true,noCatalogWrites:true,
    explicitApproval:false,executionEnabled:false,modelCalls:0,uploaderCalls:0,
    note:'One exact channel target per selected artist. Metadata capture is not artist ownership verification. Unknown handle/ID equivalence is not inferred.'};
}
export function approveAccountedChannels(plan,{planSha256,capCents,approvedAt}){
  assert.deepEqual(accountedChannelPlan(plan),plan);
  assert.equal(planSha256,digest(plan));assert.equal(capCents,plan.maximumSpendCents);
  assert.ok(Date.parse(approvedAt)>=Date.parse(plan.preparedAt));
  return {id:plan.id,version:plan.version,planSha256,capCents,approvedAt,
    explicitApproval:true,executionEnabled:true,scope:'exact_channel_metadata_only_no_retries_no_catalog_writes'};
}
