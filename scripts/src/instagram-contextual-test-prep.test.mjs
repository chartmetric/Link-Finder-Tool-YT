import test from 'node:test';
import assert from 'node:assert/strict';
import {contextualTestPair} from './instagram-contextual-test-prep.mjs';
const music='https://open.spotify.com/artist/AAAAAAAAAAAAAAAAAAAAAA',url='https://www.instagram.com/example_artist/';
function fixture(){
  const profile={url,identityComparison:{reference:{platform:'spotify',url:music},status:'likely',reasons:['old judgment'],
    candidate:{url,displayName:'Example Artist',bio:'Singer. Label owner.',directExternalUrls:[music],externalUrls:[music]}},
    jevVerification:{sameIdentityProbability:0.99,verdict:'verified'}};
  return {artist:'Example Artist',profile,player:{profile_id:'1',artist:'Example Artist',account_ids:['1'],
    accounts:[{account_id:'1',platform:'spotify',account_url:music}]},
    context:{ownershipConfirmed:false,items:[{kind:'release',source:'saved_catalog',text:'Silver Horizon — Example Artist',
      binding:'profile_only',asOf:'2026-01-01'}]}};
}
test('two fresh frozen arms retain source uncertainty, fuller raw metadata, and no prior judgment or network calls',()=>{
  const target=fixture(),before=JSON.stringify(target),oldFetch=globalThis.fetch;
  globalThis.fetch=()=>{throw Error('No paid calls permitted.');};
  try{
    const pair=contextualTestPair(target,target.profile);
    assert.equal(pair.length,2);assert.equal(pair[0].variant,'current');assert.equal(pair[1].variant,'fuller_metadata');
    for(const r of pair){assert.ok(r.bytes<=6000);assert.equal(r.body.state.artist,target.artist);
      assert.equal(r.body.state.candidates[0].url,url);
      assert.doesNotMatch(JSON.stringify(r.body),/old judgment|jevVerification|identityComparisonStatus|identityComparisonReasons/);}
    assert.equal(pair[0].body.state.artistContext.savedCatalogContext,undefined);
    assert.equal(pair[1].body.state.artistContext.savedCatalogContext.items[0].text,target.context.items[0].text);
    assert.equal(JSON.stringify(target),before);
    const donor=structuredClone(target.profile);donor.url=donor.identityComparison.candidate.url='https://www.instagram.com/another_account/';
    donor.identityComparison.reference.url='https://open.spotify.com/artist/BBBBBBBBBBBBBBBBBBBBBB';
    const control=contextualTestPair(target,donor);
    assert.equal(control[1].body.state.candidates[0].url,donor.url);
    assert.equal(control[1].body.state.candidates[0].reference.url,music);
    target.context.items[0].text='界'.repeat(16000);
    assert.throws(()=>contextualTestPair(target,target.profile),/omit|bytes|fit|6000/);
  }finally{globalThis.fetch=oldFetch;}
});
test('a foreign target binding or grading labels cannot enter prepared requests',()=>{
  const target=fixture();target.profile.identityComparison.reference.url+='foreign';
  assert.throws(()=>contextualTestPair(target,target.profile),/Unbound/);
  const leak=fixture();leak.context.expectedArtistOwned=true;
  assert.throws(()=>contextualTestPair(leak,leak.profile),/Grading/);
});
