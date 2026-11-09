import test from 'node:test';
import assert from 'node:assert/strict';
import {withOwnershipRubric,OWNERSHIP_RUBRIC} from './instagram-ownership-rubric.mjs';
import {jevRequest} from './instagram-pilot-live-transport.mjs';
import {assessInstagramCandidates} from './musician-instagram-matching.mjs';

const spotify='https://open.spotify.com/artist/AAAAAAAAAAAAAAAAAAAAAA';
const url='https://www.instagram.com/example_artist/';
const reference={platform:'spotify',url:spotify,displayName:'Example Artist'};
const candidate={platform:'instagram',url,displayName:'Example Artist',externalUrls:[spotify]};
const payload={artist:'Example Artist',catalogReference:reference,profiles:[
  {url,identityComparison:{reference,candidate,status:'likely'}}]};

test('opt-in changes only criteria, not source evidence, model, candidate order or archived input',()=>{
  const old=jevRequest(payload),snapshot=structuredClone(old);
  const next=jevRequest({...payload,ownershipRubric:OWNERSHIP_RUBRIC});
  assert.deepEqual(old,snapshot);assert.deepEqual(next.state,old.state);assert.equal(next.model,old.model);
  assert.deepEqual(next,withOwnershipRubric(old));assert.notDeepEqual(next.questions,old.questions);
  assert.match(next.questions.candidate_0_same_identity.instructions,/reciprocal link/);
  assert.match(next.questions.candidate_0_verdict.criteria.verified,/jointly support artist ownership/);
  assert.doesNotMatch(JSON.stringify(next.questions),/Frankelly|Shenge|belloo|minimum score|at least 0\.9/i);
  assert.throws(()=>jevRequest({...payload,ownershipRubric:'unrecognized'}),/Unknown/);
});

test('the unchanged evidence and numeric gates still hold weak, wrong, related and high-scoring cases',()=>{
  const player={artist:'Example Artist',profile_id:'1',account_ids:['2'],
    accounts:[{profile_id:'1',account_id:'2',platform:'spotify',account_url:spotify}]};
  const assess=(profile)=>assessInstagramCandidates({profiles:[profile],
    methodsUsed:[{method:'serper',status:'used'}]},player);
  const p={...payload.profiles[0],jevVerification:{verdict:'verified',sameIdentityProbability:0.95}};
  assert.deepEqual(assess(p).urls,[url]);
  for(const change of [
    {jevVerification:{verdict:'verified',sameIdentityProbability:0.89}},
    {jevVerification:{verdict:'likely',sameIdentityProbability:0.99}},
    {jevVerification:{verdict:'mismatch',sameIdentityProbability:0.01}},
    {identityComparison:{...p.identityComparison,candidate:{...candidate,externalUrls:[]}}},
    ...['record label','festival','fan account'].map(bio=>({
      identityComparison:{...p.identityComparison,candidate:{...candidate,bio}},
    })),
  ]) assert.deepEqual(assess({...p,...change}).urls,[]);
  assert.equal(assess(p).approvedCatalogLinks,false);
});
