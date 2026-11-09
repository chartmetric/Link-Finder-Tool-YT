import test from 'node:test';
import assert from 'node:assert/strict';
import {addWebsiteEvidence} from './instagram-official-site-evidence-check.mjs';
const spotify='https://open.spotify.com/artist/AAAAAAAAAAAAAAAAAAAAAA';
const body={model:'fixed',state:{artist:'Example Artist',knownProfileUrl:spotify,candidates:[
  {url:'https://www.instagram.com/example/',reference:{url:spotify,externalUrls:[]}},
  {url:'https://www.instagram.com/wrong/',reference:{url:spotify,externalUrls:[]}},
]},questions:{identity:{type:'noul',instructions:'unchanged'}}};
const proof={url:'https://example.com/',status:200,title:'Example Artist',at:'2026-11-09T00:00:00Z',
  bodySha256:'a'.repeat(64),links:[spotify,'https://www.instagram.com/example/?hl=en']};

test('adds only shared, source-typed facts without relabeling reference or revealing expected answers',()=>{
  const snapshot=structuredClone(body),next=addWebsiteEvidence(body,proof);
  assert.deepEqual(body,snapshot);assert.deepEqual(next.questions,body.questions);
  assert.deepEqual(next.state.candidates,body.state.candidates);assert.equal(next.model,body.model);
  assert.deepEqual(next.state.websiteEvidence[0].links,proof.links);
  assert.deepEqual(next.state.candidates[0].reference.externalUrls,[]);
  assert.ok(!JSON.stringify(next).includes('expectedArtistOwned'));
  assert.ok(!JSON.stringify(next).includes('modelAccepted'));
});
test('requires exact music ID, direct Instagram URL, valid snapshot and unchanged size ceiling',()=>{
  for(const bad of [{...proof,status:403},{...proof,bodySha256:'missing'},
    {...proof,links:[spotify+'X',proof.links[1]]},
    {...proof,links:[spotify,'https://www.instagram.com/p/post/']},
    {...proof,links:[spotify,'https://secret:credential@www.instagram.com/example/']},
    {...proof,url:'http://example.com/'},{...proof,at:'invalid'}]){
    assert.throws(()=>addWebsiteEvidence(body,bad));
  }
  assert.throws(()=>addWebsiteEvidence({...body,padding:'x'.repeat(6001)},proof),/ceiling/);
});
