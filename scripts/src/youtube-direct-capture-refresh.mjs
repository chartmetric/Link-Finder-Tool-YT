import assert from 'node:assert/strict';
import {DIRECT_CAPTURE_POLICY,validateMixedCapturePlan} from './youtube-mixed-channel-captures.mjs';
import {returnedYoutubeUrl} from './youtube-ownership-policy.mjs';

// Preparation only: narrow an unexecuted proposal, never transfer its approval.
export function refreshedDirectCaptureInput(previous,currentRows,options){
  validateMixedCapturePlan(previous);assert.equal(previous.version,DIRECT_CAPTURE_POLICY);
  assert.notEqual(options.id,previous.id);
  const rows=new Map();
  for(const r of currentRows){
    const key=String(r.profile_id);assert.ok(!rows.has(key),'Duplicate eligibility row');rows.set(key,r);
  }
  const eligible=[],deferred=[];
  for(const s of previous.selections){
    const r=rows.get(s.profileId);
    const reason=!r?'Not present in the latest eligible global-tier group':
      String(r.cm_artist)!==s.cmArtist||r.artist!==s.artist?'Catalog identity changed':
        !Number.isInteger(Number(r.tier))||Number(r.tier)<1||Number(r.tier)>5?'Current tier is outside 1–5':null;
    if(reason)deferred.push({...s,reason,processed:false,noMatch:false,paidCalls:0});
    else eligible.push({s,r});
  }
  if(!eligible.length)return {input:null,deferred};
  const chosen=new Map(eligible.map(x=>[x.s.profileId,x]));
  const artists=previous.artists.filter(a=>chosen.has(a.profileId)).map(a=>{
    const {s,r}=chosen.get(a.profileId);assert.equal(a.cmArtist,s.cmArtist);
    return {...structuredClone(a),startingTier:a.startingTier??a.tier,tier:Number(r.tier)};
  });
  assert.equal(artists.length,eligible.length);
  const directLeads=previous.directLeads.filter(a=>chosen.has(a.profileId)).map(a=>{
    const {s}=chosen.get(a.profileId);assert.equal(a.cmArtist,s.cmArtist);
    const candidates=a.candidates.filter(c=>returnedYoutubeUrl(c.url)===s.url);
    assert.ok(candidates.length,'Do not substitute a different direct lead');
    return {...structuredClone(a),candidates};
  });
  assert.equal(directLeads.length,eligible.length);
  return {input:{version:DIRECT_CAPTURE_POLICY,id:options.id,preparedAt:options.preparedAt,artists,directLeads,
    uploaderResults:[],sourceSearchId:previous.sourceSearchId,sourceUploaderIds:[],
    cohortClaims:structuredClone(previous.cohortClaims),sourceFiles:structuredClone(options.sourceFiles),
    runtimeFiles:structuredClone(options.runtimeFiles)},deferred};
}
