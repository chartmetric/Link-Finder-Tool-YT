import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sourceFactsOnly,answersFrom} from './instagram-jev-label-ablation.mjs';

test('only internal judgments are removed; IDs, source chains, criteria and original archive stay intact',()=>{
  const body={model:'unchanged',questions:{identity:{type:'noul',instructions:'unchanged'}},
    state:{artist:'Test',knownProfileUrl:'target',candidates:[{
      url:'instagram',identityComparisonStatus:'likely',identityComparisonReasons:['Internal judgment'],
      reference:{url:'target'},candidate:{externalUrls:['source_album'],musicLinkPath:{
        sourceUrl:'source_album',status:'exact_catalog_music_identity',ownershipAssessment:'unassessed',
        pages:[{sourceUrl:'hub',musicTargets:['source_album']}],
        catalogAlbumLinks:[{source:'catalog',albumId:'album',artistRows:[['album','artist',0,'date']],
          status:'exact_catalog_music_identity'}]}}}]}};
  const clone=structuredClone(body),clean=sourceFactsOnly(body);
  assert.deepEqual(body,clone);assert.deepEqual(clean.questions,body.questions);
  assert.equal(clean.model,body.model);
  const p=clean.state.candidates[0].candidate.musicLinkPath;
  assert.ok(!('status' in p)&&!('ownershipAssessment' in p));
  assert.ok(!('status' in p.catalogAlbumLinks[0]));
  assert.deepEqual(p.pages,body.state.candidates[0].candidate.musicLinkPath.pages);
  assert.deepEqual(p.catalogAlbumLinks[0].artistRows,[['album','artist',0,'date']]);
  assert.deepEqual(sourceFactsOnly(clean),clean);
});

test('identity probability is distinct from confidence in the verdict label',()=>{
  const answer={answers:{candidate_0_same_identity:{noul:0.76},
    candidate_0_verdict:{choice:'likely',confidence:0.96,probabilities:{verified:0.03,likely:0.97}}}};
  const parsed=answersFrom(answer,1)[0];
  assert.equal(parsed.sameIdentityProbability,0.76);
  assert.equal(parsed.verdictLabelConfidence,0.96);
  assert.equal(parsed.verdict,'likely');
  assert.throws(()=>answersFrom({answers:{}},1),/Incomplete/);
  assert.throws(()=>answersFrom({answers:{...answer.answers,candidate_0_same_identity:{noul:1.1}}},1),/invalid/);
});
