import test from 'node:test';
import assert from 'node:assert/strict';
import {catalogAccountContext,auditCatalogAccountOmissions} from './instagram-catalog-account-context.mjs';
import {enrichedRequest} from './instagram-next-saved-batch.mjs';

const url='https://www.instagram.com/example_dj/';
const spotify='https://open.spotify.com/artist/2BhXOZ96YbOdXz8F6HVUw4';
function fixture(){
  const accounts=[
    {account_id:'1',profile_id:'42',platform:'spotify',account_url:spotify},
    {account_id:'2',profile_id:'42',platform:'tiktok',account_url:'https://www.tiktok.com/@example_dj'},
    {account_id:'3',profile_id:'42',platform:'youtube',account_url:'https://www.youtube.com/@otherhandle'},
  ];
  const player={profile_id:'42',cm_artist:'123',accounts,account_ids:['1','2','3'],
    source_identity_matches:true,catalog_profile:{profile_id:'42',cm_artist:'123'}};
  return {artist:'Example',profileId:'42',player,selected:{url},context:{ownershipConfirmed:false,items:[]}};
}
test('all bound accounts reach the model, including exact handle support with a Spotify primary reference',()=>{
  const t=fixture(),candidate={url,displayName:'Example',bio:'Management and booking',externalUrls:[]};
  const r=enrichedRequest(t,candidate),e=r.body.state.catalogAccountEvidence;
  assert.equal(r.body.state.knownProfileUrl,spotify);assert.equal(e.accounts.length,3);
  assert.equal(e.accounts.find(a=>a.platform==='tiktok').exactCandidateHandleMatch,true);
  assert.equal(e.accounts.find(a=>a.platform==='youtube').exactCandidateHandleMatch,false);
  assert.ok(!('publicHandle' in e.accounts[0]));assert.match(e.note,/not proof alone/);
  assert.deepEqual(r.body.state.candidates[0].observedExactCatalogLinks,[]);
  assert.ok(r.bytes<=6000);assert.equal(r.profile.jevVerification,undefined);
});
test('ignore inactive, disconnected, unbound, foreign and malformed accounts; never trust a loose handle',()=>{
  for(const change of [
    a=>{a.is_active=false;},a=>{a.is_active=0;},a=>{a.is_active='0';},
    a=>{a.disconnected_at='2026-01-01';},a=>{a.profile_id='999';},a=>{a.cm_artist='999';},
    a=>{a.account_id='999';},a=>{a.account_url='https://evil.test/@example_dj';a.handle='example_dj';},
  ]){
    const t=fixture();change(t.player.accounts[1]);
    assert.ok(!catalogAccountContext(t.player,url).accounts.some(a=>a.platform==='tiktok'));
  }
  const t=fixture();t.player.catalog_profile.cm_artist='999';
  assert.throws(()=>catalogAccountContext(t.player,url),/bound artist/);
});
test('exact handles are URL-based and preserve punctuation; channel IDs and different handles are not matches',()=>{
  const t=fixture();t.player.accounts[1].account_url='https://www.tiktok.com/@example.dj';
  t.player.accounts[1].handle='example_dj';
  t.player.accounts[2].account_url='https://www.youtube.com/channel/UC_example_dj';
  const e=catalogAccountContext(t.player,url);
  assert.equal(e.accounts.find(a=>a.platform==='tiktok').exactCandidateHandleMatch,false);
  assert.ok(!('exactCandidateHandleMatch' in e.accounts.find(a=>a.platform==='youtube')));
});
test('oversize account context is held, never silently truncated or sent past the limit',()=>{
  const t=fixture();
  for(let i=0;i<80;i++){const id='extra'+i;t.player.account_ids.push(id);
    t.player.accounts.push({account_id:id,profile_id:'42',platform:'tiktok',account_url:'https://www.tiktok.com/@extra'+i});}
  assert.throws(()=>enrichedRequest(t,{url,displayName:'Example',bio:'Bio'}),/exceeds 6000/);
});
test('offline audit finds withheld support without changing saved decisions or mistaking search snippets for inputs',()=>{
  const t=fixture(),row={artist:'Example',candidateInstagramUrl:url,artistCatalogMetadata:t.player,
    status:'model_not_positive',score:0.26,metadataActuallyUsed:{knownProfileUrl:spotify,
      savedSearchEvidence:{snippet:'https://www.tiktok.com/@example_dj'}}};
  const original=structuredClone(row);
  const [r]=auditCatalogAccountOmissions([row]);
  assert.equal(r.catalogAccountsOmittedFromSavedCheck.length,2);assert.equal(r.omittedExactHandleMatches.length,1);
  assert.equal(r.status,row.status);assert.equal(r.score,row.score);assert.equal(r.decisionChanged,false);
  assert.deepEqual(row,original);
  const newer={...row,metadataActuallyUsed:{...row.metadataActuallyUsed,
    catalogAccountEvidence:r.revisedCatalogAccountContext}};
  assert.equal(auditCatalogAccountOmissions([newer])[0].catalogAccountsOmittedFromSavedCheck.length,0);
  const untested=auditCatalogAccountOmissions([{...row,metadataActuallyUsed:null}])[0];
  assert.equal(untested.offlineAuditStatus,'not_checked_no_saved_model_input');
  assert.equal(untested.omittedExactHandleMatches.length,0);
});
