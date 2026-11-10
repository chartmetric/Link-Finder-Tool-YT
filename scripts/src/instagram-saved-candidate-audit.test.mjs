import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {auditCandidate,releaseMentions,auditCsv,loadAuditRows,writeAudit} from './instagram-saved-candidate-audit.mjs';

const ig='https://www.instagram.com/example_band/';
const spotify='https://open.spotify.com/artist/AAAAAAAAAAAAAAAAAAAAAA';
const youtube='https://www.youtube.com/@example_band';
const artist={profile_id:'1',cm_artist:'2',artist:'=Example Band',tier:2,account_ids:['3','4'],
  accounts:[{account_id:'3',platform:'spotify',account_url:spotify},{account_id:'4',platform:'youtube',account_url:youtube}]};
const reference={platform:'spotify',url:spotify,displayName:'Example Band'};
const profile={url:ig,identityComparison:{reference,candidate:{url:ig,displayName:'Example Band',
  bio:'Official band',directExternalUrls:[youtube]},status:'uncertain'},
  jevVerification:{verdict:'likely',sameIdentityProbability:0.57}};
const result={profileId:'1',status:'needs_review',urls:[],candidates:[{url:ig,status:'needs_review',reason:'No exact cross-link'}]};
const context={ownershipConfirmed:false,items:[{kind:'release',text:'Nasza Noc — Album'},
  {kind:'bio',text:'Instagram @example_band',source:'saved',binding:'not_account_bound',asOf:'2020-01-01',stale:true}]};
const requestPacket={decisionRequest:{state:{candidates:[{url:ig,candidate:{displayName:'Example Band'}}]}}};

test('offline audit identifies unused catalog connections and declarations without relabeling decisions',()=>{
  const before=JSON.stringify({profile,result,requestPacket});
  const row=auditCandidate({artist,result,candidateUrl:ig,profile,context,requestPacket});
  assert.equal(row.saved_score,0.57);
  assert.equal(row.saved_verdict,'likely');
  assert.equal(row.supported_link,false);
  assert.equal(row.safe_for_import,false);
  assert.ok(row.audit_flags.includes('alternate_catalog_binding_not_explicit_in_request'));
  assert.ok(row.audit_flags.includes('saved_instagram_declaration_not_used_as_support'));
  assert.equal(row.saved_instagram_declarations[0].stale,true);
  assert.equal(JSON.stringify({profile,result,requestPacket}),before);
  assert.ok(auditCsv([row]).includes(`"'=Example Band"`));
});

test('release evidence distinguishes owner-caption snippets, third-party mentions and incidental substrings',()=>{
  const evidence=[
    {kind:'post_caption_owner',sourceUrl:'https://www.instagram.com/reel/ABC/',
      snippet:'120 likes - example_band on today: band rehearsal #naszanoc'},
    {kind:'post_mention',sourceUrl:'https://www.instagram.com/p/DEF/',snippet:'Dancing to Nasza Noc by Example Band'},
    {kind:'post_caption_owner',snippet:'naszanocsomethingelse'},
  ];
  const matches=releaseMentions(context,evidence);
  assert.equal(matches.length,2);
  assert.equal(matches[0].match,'hashtag');
  assert.equal(matches[1].attribution,'other_or_unconfirmed_post_attribution');
  const row=auditCandidate({artist,result,candidateUrl:ig,profile,context,requestPacket,discovered:[{discoveryEvidence:evidence}]});
  assert.equal(row.unused_owned_post_release_matches.length,1);
  assert.equal(row.other_post_release_matches.length,1);
  assert.ok(row.audit_flags.includes('catalog_release_in_owned_post_not_supplied'));
  assert.equal(row.priority,'Review unused supporting evidence');
  const onlyOther=auditCandidate({artist,result,candidateUrl:ig,context:{items:[context.items[0]]},
    discovered:[{discoveryEvidence:[evidence[1]]}]});
  assert.equal(onlyOther.priority,'Uninspected retrieval clue');
  const fan=auditCandidate({artist,result,candidateUrl:'https://www.instagram.com/some_fan/',
    context:{items:[context.items[0]]},discovered:[{discoveryEvidence:[{
      kind:'post_caption_owner',sourceUrl:'https://www.instagram.com/reel/ABC/',snippet:'Nasza Noc — Fan made music video',
    }]}]});
  assert.equal(fan.priority,'Uninspected retrieval clue');
  assert.ok(fan.post_attribution_caution);
});

test('empty links are explicitly unknown, and TuneCore/unsupported websites are not fabricated as checked',()=>{
  const noLinks=structuredClone(profile);noLinks.identityComparison.candidate.directExternalUrls=[];
  const row=auditCandidate({artist,result,candidateUrl:ig,profile:noLinks,context,requestPacket});
  assert.ok(row.audit_flags.includes('no_external_links_captured_not_proof_of_absence'));
  const linked=structuredClone(profile);
  linked.identityComparison.candidate.directExternalUrls=[
    'https://social.tunecore.com/linkShare?linkid=ABC_123','https://example.test/artist'];
  const audit=auditCandidate({artist,result,candidateUrl:ig,profile:linked,context:{items:[]},requestPacket});
  assert.equal(audit.unchecked_supported_links.length,1);
  assert.equal(audit.unresolved_declared_links.length,1);
  assert.equal(audit.priority,'Review missing link-path evidence');
  const missing=auditCandidate({artist,result,candidateUrl:ig,context:{items:[]}});
  assert.equal(missing.saved_score,'');
  assert.equal(missing.original_request_available,false);
  assert.equal(missing.candidate_stage,'not_inspected');
});

test('saved archive audit includes all discovery candidates and no-candidate artists, hashes requests and refuses overlap',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'saved-audit-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const run=path.join(dir,'run');await fs.mkdir(path.join(run,'responses'),{recursive:true});
  const artist2={...artist,artist:'Other Artist',profile_id:'9',cm_artist:'10'};
  const evidence={...result,rawResult:{profiles:[profile]},discoveryAttempts:[{
    profiles:[{url:ig},{url:'https://www.instagram.com/second_candidate/'}]}]};
  await fs.writeFile(path.join(run,'approved-manifest.json'),JSON.stringify({artists:[artist,artist2]}));
  await fs.writeFile(path.join(run,'results.jsonl'),[evidence,{profileId:'9',status:'no_candidates',urls:[]}].map(JSON.stringify).join('\n')+'\n');
  await fs.writeFile(path.join(run,'artist-context-evidence.json'),JSON.stringify({packets:[artist,artist2].map(a=>({
    profileId:a.profile_id,cmArtist:a.cm_artist,collectedAt:'2026-11-09',platformSnapshots:[],spotifyMetadata:[],tags:[],
  }))}));
  const packet={...requestPacket,profileId:'1',requestBodySha256:createHash('sha256')
    .update(JSON.stringify(requestPacket.decisionRequest)).digest('hex')};
  const requestPath=path.join(run,'responses','1-jev-4.json');
  await fs.writeFile(requestPath,JSON.stringify(packet));
  const loaded=await loadAuditRows([run]);
  assert.equal(loaded.rows.length,3);
  assert.equal(loaded.rows.filter(r=>r.instagram_link).length,2);
  assert.equal(loaded.rows.filter(r=>r.candidate_stage==='no_saved_candidates').length,1);
  assert.equal(loaded.rows.filter(r=>r.candidate_stage==='not_inspected').length,1);
  const before=await fs.readFile(path.join(run,'results.jsonl'),'utf8');
  const summary=await writeAudit({directories:[run],outputDir:path.join(dir,'output')});
  assert.equal(summary.artists,2);assert.equal(summary.decisionsChanged,0);assert.equal(summary.paidCalls,0);
  assert.equal(await fs.readFile(path.join(run,'results.jsonl'),'utf8'),before);
  await assert.rejects(loadAuditRows([run,run]),/Overlapping/);
  await assert.rejects(writeAudit({directories:[run],outputDir:path.join(dir,'output')}),/EEXIST/);
  packet.requestBodySha256='corrupt';await fs.writeFile(requestPath,JSON.stringify(packet));
  await assert.rejects(loadAuditRows([run]),/hash mismatch/);
});
