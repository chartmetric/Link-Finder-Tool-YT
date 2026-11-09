// Exactly two authorized JEV calls on saved evidence. No discovery or imports.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {resolveMusicEvidence} from './public-music-links.mjs';
import {instagramProfileUrl} from './musician-instagram-matching.mjs';
import {correctedProfile} from './instagram-provenance-diagnostic.mjs';
import {createLiveTransport,jevRequest} from './instagram-pilot-live-transport.mjs';
import {createPilotBudget} from './instagram-pilot-budget.mjs';
import {verificationGate} from './instagram-verification-benchmark.mjs';

const source='generated-artifacts/instagram-album-source-investigation-2026-11-09';
const benchmark='generated-artifacts/instagram-verification-benchmark-2026-11-06';
const output='generated-artifacts/instagram-catalog-album-verifier-test-2026-11-09';
const prior='generated-artifacts/instagram-broader-facts-validation-2026-11-06/summary.json';
const hash=value=>createHash('sha256').update(value).digest('hex');
const read=async f=>JSON.parse(await fs.readFile(f,'utf8'));
const save=(f,value)=>fs.writeFile(f,JSON.stringify(value,null,2),{flag:'wx'});

export function pairedAlbumRequests(artists) {
  assert.equal(artists.length,2);
  return artists.map((a,i)=>{
    const control=artists[1-i];
    assert.notEqual(a.reference.url,control.reference.url);
    const profiles=[correctedProfile(a,a),correctedProfile(a,control)];
    assert.equal(profiles[0].identityComparison.status,'likely');
    assert.equal(profiles[1].identityComparison.status,'uncertain');
    const payload={artist:a.artist,catalogReference:a.reference,profiles};
    const body=jevRequest(payload),bytes=Buffer.byteLength(JSON.stringify(body));
    assert.ok(bytes<=6000,'Full verifier request exceeds unchanged size cap.');
    assert.ok(body.state.candidates.every(c=>c.reference.url===body.state.knownProfileUrl));
    return {a,control,payload,body,bytes,inputSha256:hash(JSON.stringify(body))};
  });
}

async function prepare() {
  const sources=[];
  async function archived(file) {
    const text=await fs.readFile(file,'utf8');
    sources.push({file,sha256:hash(text)});return JSON.parse(text);
  }
  const db=await archived(`${source}/catalog-evidence.json`);
  const publicPages=await archived('generated-artifacts/instagram-music-path-check-2026-11-09/summary.json');
  const names=await fs.readdir(`${benchmark}/responses`),artists=[];
  for(const id of ['208216','35092']) {
    const a=await archived(`${benchmark}/${id}-metadata.json`);
    assert.equal(a.profile_id,id);
    const rawFile=names.find(n=>n.startsWith(`${id}-scrapecreators_candidate-`));
    assert.ok(rawFile);
    const raw=await archived(`${benchmark}/responses/${rawFile}`);
    assert.equal(raw.status,200);
    const user=raw.data.data?.user??raw.data.user;
    assert.equal(instagramProfileUrl(`https://www.instagram.com/${user.username}/`),a.candidateMetadata.url);
    a.candidateMetadata.directExternalUrls=[...new Set([user.external_url,...(user.bio_links??[]).map(b=>b.url)].filter(value=>{
      try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port;}catch{return false;}
    }))];
    const evidence=await resolveMusicEvidence({candidate:a.candidateMetadata,catalog:a.reference,
      lookupAlbum:async url=>{
        const matched=db.checked.find(c=>c.profileId===id&&url.includes(c.albumId));
        assert.ok(matched,'Album was not bound to this archived catalog investigation.');
        return {
          // The original archive lacks a query timestamp. Do not invent one or
          // describe replay time as the time the database was observed.
          album_rows:db.albumMetadata.filter(r=>r.spotify_album_id===matched.albumId)
            .map(r=>[r.spotify_album_id,r.album_type,r.active,r.updated_at]),
          artist_rows:db.albumEvidence.filter(r=>r.spotify_album_id===matched.albumId)
            .map(r=>[r.spotify_album_id,r.spotify_artist_id,r.is_deleted,r.updated_at]),
        };
      },readPage:async url=>{
        const page=publicPages.results.find(r=>r.profileId===id)?.evidence.pages.find(p=>p.sourceUrl===url);
        assert.ok(page,'No archived source-bound public page; refusing a network fallback.');return page;
      }});
    assert.equal(evidence.status,'exact_catalog_music_identity');
    a.candidateMetadata.externalLinkEvidence=evidence;
    a.candidateMetadata.externalUrls=[...new Set([...a.candidateMetadata.directExternalUrls,...evidence.externalUrls])];
    artists.push(a);
  }
  return {cases:pairedAlbumRequests(artists),sources};
}

async function main() {
  const prepared=await prepare(),previous=await read(prior);
  const priorCents=Math.round(previous.cumulativeConservativeReservationUsd*100);
  assert.equal(priorCents,317);
  assert.ok(priorCents+4<=1000);
  if(!process.argv.includes('--run-approved-test')) {
    console.log(JSON.stringify({calls:2,maxReservedUsd:0.04,
      cases:prepared.cases.map(c=>({artist:c.a.artist,bytes:c.bytes,control:c.control.artist,inputSha256:c.inputSha256})),
      newSearches:0,newDatabaseQueries:0,imports:0},null,2));return;
  }
  const keys=Object.fromEntries(['OPENROUTER_API_KEY','SERPERDEV_API_KEY','SCRAPECREATORS_API_KEY'].map(k=>{
    if(!process.env[k]) throw Error(`Missing secret: ${k}`);return [k,process.env[k]];
  }));
  await fs.mkdir(output,{recursive:false}); // Never repeat a paid journal.
  await fs.mkdir(`${output}/responses`);
  const manifest={run_allowed:true,authorization:{approved:true,approvedBy:'user',maxSpendCents:4,
    source:'User approved the two-artist verification-only test, reserving at most $0.04.',
    priorReservedCents:317,noImports:true},sources:prepared.sources,
    sourceEvidenceIsHistorical:true,catalogObservationTimeNotRecorded:true,
    pipelineModelAndThresholdUnchanged:true,
    artists:prepared.cases.map(({a})=>({profile_id:a.profile_id,source_identity_matches:true,
      reference_preflight:{readiness:'reference_usable'}})),
    proposed_limits:{serper_requests_total:0,serper_requests_per_artist:0,
      scrapecreators_requests_total:0,instagram_candidate_metadata_per_artist:0,reference_metadata_per_artist:0,
      jev_requests_total:2,jev_requests_per_artist:1,paid_http_requests_total:2,
      public_spotify_oembed_requests_total:0,public_official_or_linkhub_page_requests_total:0,
      public_http_requests_total:0,public_music_page_requests_per_artist:1,
      global_concurrent_provider_requests:1,per_request_timeout_seconds:20,
      jev_max_input_tokens_per_request:6000,jev_max_output_tokens_per_request:1000,
      automatic_retries:0,job_wall_time_minutes:3}};
  await save(`${output}/approved-scope.json`,manifest);
  const transport=createLiveTransport({keys,responseDir:`${output}/responses`});
  const budget=await createPilotBudget({manifest,transport,mode:'live',journalPath:`${output}/admissions.jsonl`});
  const results=[],deadlineAt=Date.now()+180000;
  try {
    for(const c of prepared.cases) {
      const key=`${c.a.profile_id}:catalog-album-verifier`;
      await save(`${output}/${c.a.profile_id}-request.json`,{request:c.body,inputSha256:c.inputSha256});
      assert.equal(hash(JSON.stringify(jevRequest(c.payload))),c.inputSha256);
      const decisions=await budget.request({profileId:c.a.profile_id,kind:'jev',key,payload:c.payload,deadlineAt});
      const packet=await read(`${output}/responses/${key.replaceAll(':','-')}.json`);
      assert.equal(packet.requestBodySha256,c.inputSha256);
      const cost=packet.data.usage.cost;
      assert.ok(Number.isFinite(cost)&&cost>=0&&cost<=0.02);
      const row={profileId:c.a.profile_id,artist:c.a.artist,candidateUrl:c.a.candidateMetadata.url,
        controlArtist:c.control.artist,positive:decisions[0].jevVerification,control:decisions[1].jevVerification,
        positiveGatePassed:verificationGate(c.a.referenceMetadata,c.a.reference,c.payload.profiles[0],decisions[0]),
        controlGatePassed:verificationGate(c.a.referenceMetadata,c.a.reference,c.payload.profiles[1],decisions[1]),
        resolvedModel:packet.data.model,reportedCostUsd:cost,inputSha256:c.inputSha256,
        inputBytes:c.bytes,productionApproved:false};
      results.push(row);await save(`${output}/${c.a.profile_id}-result.json`,row);
      console.log(JSON.stringify(row));
      if(row.control.verdict==='verified'&&row.control.sameIdentityProbability>=0.9) throw Error('Control promoted; stop further paid calls.');
      await new Promise(r=>setTimeout(r,1000));
    }
  }finally {
    await budget.close();
    const snapshot=budget.snapshot();
    await save(`${output}/summary.json`,{results,budget:snapshot,completed:results.length===2,
      cumulativeConservativeReservationUsd:(priorCents+snapshot.reservedSpendCents)/100,
      remainingOriginalBudgetUsd:(1000-priorCents-snapshot.reservedSpendCents)/100,
      reportedCostUsd:results.reduce((s,r)=>s+r.reportedCostUsd,0),
      newSearches:0,newMetadataCalls:0,newPublicRequests:0,newDatabaseQueries:0,claims:0,databaseWrites:0,
      fullRerunStarted:false,sourceEvidenceIsHistorical:true});
  }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) await main();
