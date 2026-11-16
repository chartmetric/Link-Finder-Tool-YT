import './youtube-ownership-offline-fence.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import dgram from 'node:dgram';
import {mixedCapturePlan} from './youtube-mixed-channel-captures.mjs';
import {replayMixedChannelArchive} from './youtube-mixed-channel-archive-replay.mjs';

const url=tail=>'https://www.youtube.com/'+tail;
const key=p=>[p.profileId,p.cmArtist,p.url].join('|');
const snapshot=p=>p.alternatives.map(a=>[key(a),a.disposition]).sort();

test('real twenty-artist search and three uploader archives retain all reviewed decisions',async t=>{
  const {saved,replay,unresolved,sourceFilesChecked}=await replayMixedChannelArchive();
  assert.equal(sourceFilesChecked,353);
  assert.equal(replay.artists.length,20);
  assert.equal(replay.selections.length,13);
  assert.equal(replay.alternatives.length,34);
  assert.equal(replay.alternatives.filter(a=>a.disposition==='held_not_established').length,19);
  assert.equal(replay.alternatives.filter(a=>a.disposition==='deferred_one_channel_per_artist').length,2);
  assert.equal(new Set(replay.alternatives.map(key)).size,34,'Exactly one row per artist/channel pair');
  assert.equal(new Set(replay.selections.map(a=>a.profileId)).size,13);
  assert.deepEqual(replay.selections.map(s=>[s.profileId,s.url]).sort(),[
    ['4140785',url('channel/UCbKjCA3zpRq18m55pA6XL4A')],
    ['246184',url('channel/UCoRVaDX4Jrkbu4Iki5mTRug')],
    ['243004',url('channel/UC0Jly2jls-qj1BE_u8TRPkA')],
    ['3563387',url('channel/UCaHDD24yZ-TNQus_aH_NWJw')],
    ['229412',url('channel/UCNRh9kkByBTYLo0IJupnAug')],
    ['3692947',url('channel/UCIQYcXpI3S2zCVCrL3hY2iw')],
    ['3977444',url('@edivibz')],['299514',url('@juicedupkt')],['270465',url('@drdonk')],
    ['3572217',url('channel/UCVRqp5UESiiYsjtiJm4Shng')],
    ['3560703',url('channel/UCHxl4y8qdsGHtufB9mQfLYA')],
    ['3774889',url('channel/UCQv-dJdVe7mgueW3UFVbQIQ')],
    ['269527',url('channel/UCPjflRirjVtKTVN40KSwLdg')],
  ].sort());
  assert.ok(replay.alternatives.every(a=>!a.ownershipAccepted&&!a.importEligible));
  assert.equal(replay.explicitApproval,false);
  assert.equal(replay.executionEnabled,false);
  assert.equal(replay.modelCalls,0);
  assert.equal(replay.maximumCalls,13);
  assert.equal(replay.maximumSpendCents,26);
  assert.equal(unresolved.length,2);
  assert.ok(unresolved.every(r=>r.resultKind==='held_conflict'&&!r.verified&&!r.ownershipEvidence));

  await t.test('snippet mentions cannot promote mismatching real channel titles',()=>{
    const input=structuredClone(saved);
    for(const lead of input.directLeads)for(const c of lead.candidates)
      c.snippet=`${lead.artist} official artist channel, verified owner, exact catalog match`;
    assert.deepEqual(snapshot(mixedCapturePlan(input)),snapshot(replay));
    for(const profileId of ['3972450','3549887','228281'])
      assert.ok(replay.alternatives.filter(a=>a.profileId===profileId).every(a=>!a.eligible));
  });
  await t.test('held real uploaders veto matching search titles and snippets',()=>{
    const input=structuredClone(saved);
    const held=replay.alternatives.filter(a=>a.observations.some(o=>o.source==='saved_video_uploaders'&&!o.eligible));
    assert.equal(held.length,12,'Exercise all held uploader pairs, not an empty fixture');
    for(const pair of held){
      const artist=input.artists.find(a=>a.profileId===pair.profileId);
      let lead=input.directLeads.find(a=>a.profileId===pair.profileId);
      if(!lead){lead={profileId:artist.profileId,cmArtist:artist.cmArtist,artist:artist.name,candidates:[]};input.directLeads.push(lead);}
      lead.candidates.push({url:pair.url,title:artist.name,snippet:`${artist.name} official channel`});
    }
    const result=mixedCapturePlan(input);
    for(const pair of held){
      const row=result.alternatives.find(a=>key(a)===key(pair));
      assert.equal(row.disposition,'held_not_established');
      assert.ok(row.observations.some(o=>o.source==='saved_direct_search'&&o.eligible));
    }
    assert.deepEqual(result.selections,replay.selections);
  });
  await t.test('handle targets stay unresolved and similarly named channels stay separate',()=>{
    const handles=replay.selections.filter(s=>s.url.includes('/@'));
    assert.equal(handles.length,3);
    for(const selection of handles){
      assert.equal(selection.channelId,null);
      const op=replay.operations.find(o=>o.profileId===selection.profileId);
      assert.equal(op.expectedChannelId,null);
      assert.equal(op.allocationChannelKey,'unresolved-url:'+selection.url.toLowerCase());
    }
    const edivibz=replay.alternatives.filter(a=>a.profileId==='3977444');
    assert.equal(edivibz.length,3);
    assert.equal(edivibz.find(a=>a.url.endsWith('UC2kb3Zn7snzWOLWxyZhGeNQ')).disposition,'deferred_one_channel_per_artist');
    const conqr=replay.alternatives.filter(a=>a.profileId==='269527');
    assert.equal(conqr.length,2);
    assert.equal(conqr.find(a=>a.url.endsWith('UCShdOCTIh2ALLKvPNYQGzeQ')).disposition,'deferred_one_channel_per_artist');
  });
  await t.test('Topic and Music leads retain labels without ownership acceptance',()=>{
    const topics=replay.alternatives.filter(a=>a.observations.some(o=>/ - Topic$/.test(o.title)));
    assert.equal(topics.length,4);
    assert.ok(topics.every(a=>a.observations.some(o=>o.topicHint)));
    const selected=replay.selections.filter(s=>replay.alternatives.find(a=>key(a)===key(s)).observations.some(o=>o.topicHint));
    assert.equal(selected.length,5);
    assert.ok(selected.every(s=>s.topicLabel==='Topic/music lead — channel type needs capture'));
    assert.equal(topics.find(a=>a.artist==='Марго Нуар'&&a.observations[0].title==='Вера В-Себя - Topic').disposition,'held_not_established');
  });
  await t.test('repeated real observations produce one row and preserve both sources',()=>{
    const input=structuredClone(saved);
    for(const lead of input.directLeads)lead.candidates.push(...structuredClone(lead.candidates));
    input.uploaderResults.push(...structuredClone(input.uploaderResults));
    const result=mixedCapturePlan(input);
    assert.deepEqual(snapshot(result),snapshot(replay));
    assert.equal(new Set(result.alternatives.map(key)).size,34);
    for(const profileId of ['3563387','229412']){
      const row=result.alternatives.find(a=>a.profileId===profileId&&a.disposition==='selected_for_capture');
      assert.deepEqual(new Set(row.observations.map(o=>o.source)),new Set(['saved_direct_search','saved_video_uploaders']));
    }
  });
});

test('missing archives fail clearly instead of skipping or synthesizing evidence',async()=>{
  await assert.rejects(replayMixedChannelArchive({workspaceRoot:'/dev/null/not-an-archive'}),
    /Required real YouTube archive unavailable: generated-artifacts\/youtube-mixed-captures-fresh-twenty-2026-11-13\/plan.json.*no provider refetch or substitute evidence is permitted/);
});

test('the offline fence blocks provider transports, sockets and DNS',()=>{
  for(const attempt of [
    ()=>fetch('https://api.scrapecreators.com'),
    ()=>http.get('http://example.com'),()=>https.request('https://example.com'),
    ()=>net.connect(443,'example.com'),()=>tls.connect(443,'example.com'),
    ()=>dns.lookup('example.com'),()=>dns.promises.resolve4('example.com'),
    ()=>dgram.createSocket('udp4'),
  ])assert.throws(attempt,/Network forbidden during offline YouTube evidence preparation/);
});
