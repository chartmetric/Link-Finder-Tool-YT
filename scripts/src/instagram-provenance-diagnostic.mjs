// Saved-evidence audit and four-call repeatability check. No discovery or imports.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createPilotBudget} from './instagram-pilot-budget.mjs';
import {createLiveTransport,jevRequest} from './instagram-pilot-live-transport.mjs';
import {instagramProfileUrl,hasCatalogCrossLink} from './musician-instagram-matching.mjs';
import {verificationGate} from './instagram-verification-benchmark.mjs';

const source='generated-artifacts/instagram-verification-benchmark-2026-11-06';
const previous='generated-artifacts/instagram-evidence-update-check-2026-11-06';
const output='generated-artifacts/instagram-provenance-diagnostic-2026-11-06';
const pairs=[['207595','35092'],['270344','208216']];
const read=async file=>JSON.parse(await fs.readFile(file,'utf8'));
const save=(file,value)=>fs.writeFile(file,JSON.stringify(value,null,2),{flag:'wx'});
const hash=value=>createHash('sha256').update(value).digest('hex');

export function correctedProfile(target,artist) {
  const linked=hasCatalogCrossLink(target.referenceMetadata,artist.candidateMetadata,
    artist.candidateMetadata.url,target.reference);
  return {url:artist.candidateMetadata.url,identityComparison:{
    reference:target.referenceMetadata,candidate:artist.candidateMetadata,
    status:linked?'likely':'uncertain',reasons:[linked
      ? 'Exact catalog-bound music link observed; ownership unassessed.'
      : 'No exact cross-link to the target catalog artist.'],
  }};
}

async function audit() {
  const artists=new Map(),rows=[];
  const names=await fs.readdir(`${source}/responses`);
  for(const name of (await fs.readdir(source)).filter(n=>n.endsWith('-metadata.json'))) {
    const a=await read(`${source}/${name}`);
    const rawFile=names.find(n=>n.startsWith(`${a.profile_id}-scrapecreators_candidate-`));
    assert.ok(rawFile,'Missing raw provider evidence');
    const raw=await read(`${source}/responses/${rawFile}`);
    assert.equal(raw.status,200);
    const user=raw.data.data?.user ?? raw.data.user;
    assert.equal(instagramProfileUrl(`https://www.instagram.com/${user.username}/`),a.candidateMetadata.url);
    const direct=[...new Set([user.external_url,...(user.bio_links??[]).map(b=>b.url)].filter(url=>{
      try {const u=new URL(url);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port;} catch{return false;}
    }))];
    const derived=a.candidateMetadata.externalUrls.filter(url=>!direct.includes(url));
    // Restore raw provenance without modifying any saved source.
    a.candidateMetadata.directExternalUrls=direct;
    rows.push({profileId:a.profile_id,artist:a.artist,rawPacket:rawFile,
      sourceSha256:hash(await fs.readFile(`${source}/responses/${rawFile}`)),
      directLinkCount:direct.length,derivedLinkCount:derived.length,
      derivedLinksPreviouslyLabeledAsDirect:derived,
      candidateBindingValid:true});
    artists.set(a.profile_id,a);
  }
  const previousChecks=[];
  for(const [id] of pairs) {
    const packet=await read(`${previous}/responses/${id}-updated-evidence-jev.json`);
    previousChecks.push({profileId:id,candidates:packet.decisionRequest.state.candidates.map(c=>({
      url:c.url,referenceMatchesTarget:c.reference.url===packet.decisionRequest.state.knownProfileUrl,
      comparisonStatus:c.identityComparisonStatus,
    }))});
  }
  const prepared=pairs.map(([id,controlId])=>{
    const a=artists.get(id),control=artists.get(controlId);
    const profiles=[correctedProfile(a,a),correctedProfile(a,control)];
    const payload={artist:a.artist,catalogReference:a.reference,profiles};
    const request=jevRequest(payload);
    assert.ok(Buffer.byteLength(JSON.stringify(request))<=6000);
    assert.ok(request.state.candidates.every(c=>c.reference.url===request.state.knownProfileUrl));
    assert.equal(profiles[1].identityComparison.status,'uncertain');
    return {a,control,payload,inputSha256:hash(JSON.stringify(request))};
  });
  return {rows,previousChecks,prepared};
}

async function main() {
  const diagnostics=await audit();
  // Offline mode never creates a live journal or invokes a transport.
  if(!process.argv.includes('--run-approved-test')) {
    console.log(JSON.stringify({audited:diagnostics.rows.length,
      derivedLinkProfiles:diagnostics.rows.filter(r=>r.derivedLinkCount).map(r=>r.profileId),
      previousChecks:diagnostics.previousChecks,
      prepared:diagnostics.prepared.map(p=>({artist:p.a.artist,inputSha256:p.inputSha256,
        bytes:Buffer.byteLength(JSON.stringify(jevRequest(p.payload)))}))},null,2));
    return;
  }
  const prior=await read(`${previous}/summary.json`);
  assert.equal(prior.cumulativeConservativeReservationUsd,1.23);
  assert.ok(1.23+0.08<=10);
  const keys=Object.fromEntries(['OPENROUTER_API_KEY','SERPERDEV_API_KEY','SCRAPECREATORS_API_KEY'].map(k=>{
    if(!process.env[k]) throw Error(`Missing secret: ${k}`);return [k,process.env[k]];
  }));
  await fs.mkdir(output,{recursive:false}); // Exclusive: never replay admitted calls.
  await fs.mkdir(`${output}/responses`);
  await save(`${output}/offline-audit.json`,{rows:diagnostics.rows,previousChecks:diagnostics.previousChecks});
  const manifest={run_allowed:true,authorization:{approved:true,approvedBy:'user',maxSpendCents:8,
    source:'User approved diagnostics followed by a test run within the remaining pilot budget.',
    priorReservedCents:123,noImports:true},
    artists:diagnostics.prepared.map(({a})=>({profile_id:a.profile_id,source_identity_matches:true,
      reference_preflight:{readiness:'reference_usable'}})),
    proposed_limits:{
      serper_requests_total:0,serper_requests_per_artist:0,
      scrapecreators_requests_total:0,instagram_candidate_metadata_per_artist:0,reference_metadata_per_artist:0,
      jev_requests_total:4,jev_requests_per_artist:2,paid_http_requests_total:4,
      public_spotify_oembed_requests_total:0,public_official_or_linkhub_page_requests_total:0,
      public_http_requests_total:0,public_music_page_requests_per_artist:1,
      global_concurrent_provider_requests:1,per_request_timeout_seconds:20,
      jev_max_input_tokens_per_request:6000,jev_max_output_tokens_per_request:1000,
      automatic_retries:0,job_wall_time_minutes:5,
    }};
  await save(`${output}/approved-scope.json`,manifest);
  const transport=createLiveTransport({keys,responseDir:`${output}/responses`});
  const budget=await createPilotBudget({manifest,transport,mode:'live',journalPath:`${output}/admissions.jsonl`});
  const results=[];
  const deadlineAt=Date.now()+300000;
  try {
    for(const {a,control,payload,inputSha256} of diagnostics.prepared) {
      for(let repeat=1;repeat<=2;repeat++) {
        assert.equal(hash(JSON.stringify(jevRequest(payload))),inputSha256);
        const decisions=await budget.request({profileId:a.profile_id,kind:'jev',
          key:`${a.profile_id}:provenance-check:${repeat}`,payload,deadlineAt});
        const row={profileId:a.profile_id,artist:a.artist,repeat,inputSha256,
          positive:decisions[0].jevVerification,control:decisions[1].jevVerification,
          controlArtist:control.artist,
          positiveVerifierGatePassed:verificationGate(a.referenceMetadata,a.reference,payload.profiles[0],decisions[0]),
          controlVerifierGatePassed:verificationGate(a.referenceMetadata,a.reference,payload.profiles[1],decisions[1])};
        results.push(row);
        await save(`${output}/${a.profile_id}-repeat-${repeat}.json`,row);
        console.log(JSON.stringify(row));
      }
    }
  } finally {
    await budget.close();
    const snapshot=budget.snapshot();
    await save(`${output}/summary.json`,{results,budget:snapshot,
      cumulativeConservativeReservationUsd:1.23+snapshot.reservedSpendCents/100,
      remainingOriginalBudgetUsd:10-1.23-snapshot.reservedSpendCents/100,
      newDiscoveryCalls:0,newMetadataCalls:0,databaseWrites:0,claims:0,
      fullRerunStarted:false,sourceEvidenceIsHistorical:true,
      completed:results.length===4});
  }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) await main();
