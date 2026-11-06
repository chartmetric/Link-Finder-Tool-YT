import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildCase,evaluateCase} from './instagram-broader-facts-validation.mjs';

const reference={platform:'spotify',url:'https://open.spotify.com/artist/1234567890123456789012',displayName:'Test Artist',externalUrls:[]};
const target={profile_id:'1',artist:'Test Artist',reference,referenceMetadata:reference};
const artist={candidateMetadata:{platform:'instagram',url:'https://www.instagram.com/testartist/',
  displayName:'Test Artist',directExternalUrls:[reference.url],externalUrls:[reference.url]}};
const control={candidateMetadata:{platform:'instagram',url:'https://www.instagram.com/otherartist/',
  displayName:'Other Artist',externalUrls:[]}};

test('labels stay outside model inputs and both candidates bind the target reference',()=>{
  const c=buildCase(target,[artist,control],['secret_positive_label','secret_negative_label'],'test');
  assert.ok(!JSON.stringify(c.body).includes('secret_'));
  const s=JSON.parse(c.body.messages[1].content).state;
  assert.ok(s.candidates.every(a=>a.reference.url===reference.url));
  assert.ok(s.candidates.every(a=>!('identityComparisonStatus' in a)&&!('identityComparisonReasons' in a)));
  assert.deepEqual(c.eligible,[true,false]);
  assert.equal(artist.candidateMetadata.directExternalUrls[0],reference.url);
});

test('high model confidence alone cannot pass a missing-link gate or approve live links',()=>{
  const c=buildCase(target,[artist,control],['positive','negative'],'test');
  const decisions=c.expectedUrls.map(url=>({url,verdict:'verified',same_identity_score:0.98,reason:'test'}));
  const d=evaluateCase(c,decisions);
  assert.deepEqual(d.map(x=>x.diagnosticThresholdPassed),[true,false]);
  assert.ok(d.every(x=>x.productionApproved===false));
});

test('no catalog reference blocks dispatch; likely is not verified',()=>{
  assert.throws(()=>buildCase({...target,reference:undefined},[artist,control],['a','b'],'test'),/reference/);
  const c=buildCase(target,[artist,control],['a','b'],'test');
  assert.ok(evaluateCase(c,c.expectedUrls.map(url=>({url,verdict:'likely',same_identity_score:0.99})))
    .every(d=>!d.diagnosticThresholdPassed));
});
