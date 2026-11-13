import './youtube-ownership-offline-fence.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {triageVideoUploader} from './youtube-uploader-triage.mjs';
import {buildVideoUploaderReport} from './youtube-uploader-report.mjs';
import {planVideoDiscovery,videoMentionHold} from './youtube-video-discovery-offline.mjs';
import {youtubeChannelReviews} from './youtube-channel-review-decisions.mjs';

const artist={profileId:'1',cmArtist:'2',name:'Example Artist'};
const channel='https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv';
const result={...artist,artist:artist.name,tier:2,url:channel,uploaderName:artist.name,
  videoUrl:'https://www.youtube.com/watch?v=abcdefghijk'};
test('uploader matching is only triage; no category approves ownership, spending or import',()=>{
  for(const uploaderName of ['Example Artist','Example Artist - Topic','Promotional Music Channel','Other Name']){
    const r=triageVideoUploader(artist,{...result,uploaderName});
    assert.equal(r.ownershipAccepted,false);assert.equal(r.importEligible,false);
    assert.equal(r.independentlyVerified,false);assert.equal(r.automaticDownstreamEligible,false);
  }
  assert.equal(triageVideoUploader(artist,result).category,'identity_check_candidate');
  assert.equal(triageVideoUploader(artist,{...result,uploaderName:'Driving Dark'}).candidate,false);
  assert.equal(triageVideoUploader(artist,{...result,uploaderName:'Example Artist Official'}).candidate,false);
  assert.equal(triageVideoUploader(artist,{...result,uploaderName:'Example Artist - Topic'}).category,'topic_identity_check_candidate');
  assert.equal(triageVideoUploader(artist,{...result,uploaderName:'Another Artist - Topic'}).category,'unbound_topic_hold');
  assert.equal(triageVideoUploader(artist,result,{shared:true}).candidate,false);
  assert.throws(()=>triageVideoUploader(artist,{...result,cmArtist:'999'}));
});
test('review rejections bind the exact artist and channel, not channel names globally',()=>{
  for(const review of youtubeChannelReviews){
    const a={profileId:review.profileId,cmArtist:review.cmArtist,name:'Name still matches'};
    const r={...result,...a,url:review.url,uploaderName:a.name};
    assert.equal(triageVideoUploader(a,r).category,'user_rejected');
    const other={...a,profileId:'99999999'};
    assert.equal(triageVideoUploader(other,{...r,profileId:other.profileId}).category,'identity_check_candidate');
  }
});
test('a different name is held, not proven wrong; only catalog-bound aliases permit name triage',()=>{
  const aliasArtist={...artist,catalogProfile:{profile_id:'1',cm_artist:'2'},
    context:{chartmetric:{cm_artist:'2',name:'Alternate Name'}}};
  assert.equal(triageVideoUploader(aliasArtist,{...result,uploaderName:'Alternate Name'}).candidate,true);
  aliasArtist.context.chartmetric.cm_artist='999';
  assert.equal(triageVideoUploader(aliasArtist,{...result,uploaderName:'Alternate Name'}).candidate,false);
  const held=triageVideoUploader(artist,{...result,uploaderName:'Alternate Name'});
  assert.match(held.reason,/retain evidence/);
});
test('song-title and AI-song collisions are retained but do not consume future uploader slots',()=>{
  const a={profileId:'3933297',cmArtist:'16306244',name:'Midnight Plus'};
  const organic=[
    {link:'https://www.youtube.com/watch?v=N5jbzXrJX8k',title:'Midnight Plus is a smooth and atmospheric.',
      snippet:'Midnight Plus is a smooth and atmospheric track with a late-night vibe'},
    {link:'https://www.youtube.com/watch?v=BD5Uih-KDH0',title:'MIDNIGHT PULSE 2 (Official Music 2025) Song By Ai',
      snippet:'Midnight Plus - Original song official music 2025'},
    {link:'https://www.youtube.com/watch?v=wXx4NftjuoI',title:'Midnight Plus 1 (2022 Remaster)',
      snippet:'Provided to YouTube by WM Japan Midnight Plus 1 · Fujimal Yoshino · Album'},
    {link:'https://www.youtube.com/watch?v=7Qf8LBB2AfE',title:'Zeit (En Español)',
      snippet:'Go to channel Autumn’s Midnight PLUS'},
    {link:'https://www.youtube.com/watch?v=5tSArSxWSWU',title:'Midnight Plus One On The Mend HD',snippet:''},
  ];
  const plan=planVideoDiscovery(a,organic,{archivePath:'saved/search.json',receiptSha256:'a'.repeat(64)});
  assert.equal(plan.videoClues.length,5);assert.equal(plan.resolutionQueue.length,0);
  assert.ok(plan.videoClues.every(v=>!v.eligible&&v.sources[0].videoMentionHold));
  assert.equal(videoMentionHold(a,{title:'Midnight Plus - New Release',snippet:'Official music video'}),null);
  assert.equal(videoMentionHold(a,{title:'Midnight Plus - Topic',snippet:'Provided to YouTube by Distributor · Midnight Plus · Album'}),null);
});
test('both exports use one row per artist and channel while preserving video evidence',()=>{
  const rows=[result,{...result,videoUrl:'https://www.youtube.com/watch?v=12345678901'},
    {...result,url:'https://www.youtube.com/channel/UC'+'x'.repeat(22),uploaderName:'ZJSTV Music Channel'}];
  const report=buildVideoUploaderReport([artist],rows);
  assert.equal(report.records.length,3);assert.equal(report.summary.reviewCandidateChannels,1);
  assert.equal(report.summary.artistChannelRows,2);
  assert.equal(report.summary.categories.unbound_uploader_hold,1);
  assert.equal(report.summary.acceptedArtistOwnedLinks,0);assert.equal(report.summary.importEligibleLinks,0);
  assert.ok(!report.candidatesCsv.includes('ZJSTV'));
  assert.ok(report.evidenceCsv.includes('ZJSTV'));
  assert.ok(report.candidatesCsv.includes('abcdefghijk')&&report.candidatesCsv.includes('12345678901'));
  assert.equal(report.candidatesCsv.split('\r\n').length,2);
  assert.equal(report.evidenceCsv.split('\r\n').length,3);
  assert.ok(!report.evidenceCsv.split('\r\n')[0].includes('"video_url"'));
  assert.ok(report.evidenceCsv.includes('abcdefghijk')&&report.evidenceCsv.includes('12345678901'));
  const other={...artist,profileId:'3',cmArtist:'4'};
  const shared=buildVideoUploaderReport([artist,other],[result,{...result,profileId:'3',cmArtist:'4'}]);
  assert.equal(shared.summary.reviewCandidateChannels,0);
  assert.equal(shared.summary.artistChannelRows,2,'Different artists retain separate rows for the same channel');
  assert.equal(shared.evidenceCsv.split('\r\n').length,3);
  assert.equal(shared.summary.categories.shared_channel_hold,2);
});
test('canonical duplicate channels merge without mutating input or discarding Topic uncertainty',()=>{
  const rows=[{...result,uploaderName:'Example Artist - Topic'},
    {...result,url:channel+'/',uploaderName:'Example Artist - Topic',
      videoUrl:'https://www.youtube.com/watch?v=12345678901'}];
  const original=structuredClone(rows);
  const report=buildVideoUploaderReport([artist],rows);
  assert.deepEqual(rows,original);
  assert.equal(report.summary.artistChannelRows,1);
  assert.equal(report.evidenceCsv.split('\r\n').length,2);
  assert.equal(report.candidatesCsv.split('\r\n').length,2);
  assert.match(report.evidenceCsv,/Topic — auto-generated lead, association unverified/);
  assert.match(report.evidenceCsv,/"false","false","2"/);
});
test('Idol House user rejections exclude both uploaders without rejecting other catalog artists',()=>{
  const idol={profileId:'3841420',cmArtist:'16170857',name:'Idol House'};
  const other={profileId:'99999999',cmArtist:'88888888',name:'Idol House Türkiye'};
  const urls=['UClq3l26d0Q18d9nOb61RC1w','UCW8pHCd6SofXNQeEsQWINbg']
    .map(id=>'https://www.youtube.com/channel/'+id);
  const rows=urls.map(url=>({...result,profileId:idol.profileId,cmArtist:idol.cmArtist,
    artist:idol.name,uploaderName:idol.name,url}));
  const report=buildVideoUploaderReport([idol],rows);
  assert.equal(report.summary.reviewCandidateChannels,0);
  assert.equal(report.summary.categories.user_rejected,2);
  assert.equal(report.summary.artistChannelRows,2);
  assert.match(report.evidenceCsv,/Idol House Türkiye, not the catalog artist Idol House/);
  assert.match(report.evidenceCsv,/Rejected — user review/);
  for(const url of urls){
    assert.equal(triageVideoUploader(other,{...result,...other,url,
      uploaderName:other.name}).category,'identity_check_candidate');
  }
});
