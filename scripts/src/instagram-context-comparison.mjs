// Verification-only before/after comparison on saved metadata. No Serper, ScrapeCreators, public fetches, writes or claims.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createPilotBudget} from './instagram-pilot-budget.mjs';
import {jevRequest,fitArtistContext} from './instagram-pilot-live-transport.mjs';
import {hasCatalogCrossLink} from './musician-instagram-matching.mjs';
import {controlFor,verificationGate} from './instagram-verification-benchmark.mjs';
import {enrichManifest,attachMetadataContext,select} from './instagram-artist-metadata-overlay.mjs';

const source='generated-artifacts/instagram-verification-benchmark-2026-11-06';
const output='generated-artifacts/instagram-context-comparison-2026-11-09';
const hash=x=>createHash('sha256').update(x).digest('hex');
const save=(f,x)=>fs.writeFile(f,JSON.stringify(x,null,2),{flag:'wx'});

async function loadArtists() {
  const files=(await fs.readdir(source)).filter(f=>f.endsWith('-metadata.json'));
  const artists=[];
  for(const f of files) artists.push(JSON.parse(await fs.readFile(`${source}/${f}`,'utf8')));
  const ids=artists.map(a=>a.profile_id).join(',');
  const rows=await select(`SELECT toString(l.profile_id) profile_id,toString(a.id) account_id,a.platform,a.account_url
    FROM new_vertical.l_profile_account AS l FINAL INNER JOIN (SELECT id,platform,account_url FROM new_vertical.account FINAL
    WHERE is_active=1 AND platform='spotify') a ON a.id=l.account_id WHERE l.disconnected_at IS NULL AND l.profile_id IN (${ids})`);
  for(const a of artists) {
    const mine=rows.filter(r=>r.profile_id===String(a.profile_id)&&r.account_url.replace(/\/$/,'')===a.reference.url);
    a.accounts=mine.map(r=>({account_id:r.account_id,platform:'spotify',account_url:r.account_url}));
    a.account_ids=mine.map(r=>r.account_id);
  }
  return artists;
}
const profile=(a,candidate)=>{
  const linked=hasCatalogCrossLink(a.referenceMetadata,candidate,candidate.url,a.reference);
  return {url:candidate.url,identityComparison:{reference:a.referenceMetadata,candidate,status:linked?'likely':'uncertain',score:linked?60:0}};
};
export function buildCases(artists,contexts) {
  const cases=[];
  for(const a of artists) {
    const negative=controlFor(a,artists); if(!negative) continue;
    const base={artist:a.artist,catalogReference:a.reference,profiles:[profile(a,a.candidateMetadata),profile(a,negative.candidateMetadata)]};
    const ctx=contexts.get(String(a.profile_id));
    cases.push({a,negative,variant:'without_context',payload:base});
    if(ctx) cases.push({a,negative,variant:'with_context',payload:fitArtistContext({...base,artistContext:ctx},6000)});
  }
  return cases.filter(c=>c.variant==='without_context'?cases.some(x=>x.a===c.a&&x.variant==='with_context'):true);
}
async function main() {
  const artists=await loadArtists();
  const overlay=await enrichManifest({artists:artists.map(a=>({profile_id:a.profile_id,cm_artist:a.cm_artist,artist:a.artist,tier:a.tier,
    account_ids:a.account_ids,accounts:a.accounts}))},{maxArtists:100});
  const attached=attachMetadataContext({artists:artists.map(a=>({profile_id:a.profile_id,cm_artist:a.cm_artist,
    artist:a.artist,tier:a.tier,account_ids:a.account_ids,accounts:a.accounts}))},overlay);
  const contexts=new Map(attached.artists.filter(a=>a.metadata_context).map(a=>[String(a.profile_id),a.metadata_context]));
  const cases=buildCases(artists,contexts);
  for(const c of cases) c.bytes=Buffer.byteLength(JSON.stringify(jevRequest(c.payload)));
  const summary=cases.map(c=>({profileId:c.a.profile_id,artist:c.a.artist,bucket:c.a.bucket,variant:c.variant,bytes:c.bytes,
    contextItems:c.payload.artistContext?.items.length??0}));
  if(!process.argv.includes('--run-approved-comparison')) {
    console.log(JSON.stringify({artistsWithContext:contexts.size,of:artists.length,calls:cases.length,maxReservedUsd:cases.length*0.02,cases:summary},null,1));return;
  }
  if(cases.length*2>100) throw Error('Comparison exceeds the approved $1 cap.');
  if(!process.env.OPENROUTER_API_KEY) throw Error('Missing OPENROUTER_API_KEY.');
  await fs.mkdir(output); await fs.mkdir(`${output}/responses`);
  const manifest={run_allowed:true,authorization:{approved:true,approvedBy:'user',maxSpendCents:100,priorReservedCents:0,noImports:true,
    source:'User approved a test run; $1 verification-only cap proposed to and accepted by the user.'},
    purpose:'Same saved evidence and unchanged gate, with and without supplemental catalog context.',
    artists:artists.map(a=>({profile_id:a.profile_id,source_identity_matches:true,reference_preflight:{readiness:'reference_usable'}})),
    proposed_limits:{serper_requests_total:0,serper_requests_per_artist:0,scrapecreators_requests_total:0,
      instagram_candidate_metadata_per_artist:0,reference_metadata_per_artist:0,jev_requests_total:cases.length,
      jev_requests_per_artist:2,paid_http_requests_total:cases.length,public_spotify_oembed_requests_total:0,
      public_official_or_linkhub_page_requests_total:0,public_http_requests_total:0,public_music_page_requests_per_artist:1,
      global_concurrent_provider_requests:1,per_request_timeout_seconds:20,jev_max_input_tokens_per_request:6000,
      jev_max_output_tokens_per_request:1000,automatic_retries:0,job_wall_time_minutes:15}};
  await save(`${output}/approved-scope.json`,manifest);
  await save(`${output}/context-evidence.json`,overlay);
  const transport={live:true,inputBytes:({payload})=>Buffer.byteLength(JSON.stringify(jevRequest(payload))),
    dispatch:async({payload,key,signal})=>{
      const body=JSON.stringify(jevRequest(payload));
      const r=await fetch('https://openrouter.ai/api/alpha/decisions',{method:'POST',redirect:'error',signal,
        headers:{Authorization:`Bearer ${process.env.OPENROUTER_API_KEY}`,'Content-Type':'application/json'},body});
      const data=JSON.parse(await r.text());
      await save(`${output}/responses/${key.replaceAll(':','-')}.json`,{status:r.status,decisionRequest:JSON.parse(body),requestBodySha256:hash(body),data});
      if(!r.ok||data.error) throw Error(`JEV HTTP ${r.status}; no retry.`);
      if(!Number.isFinite(data.usage?.cost)||data.usage.cost>0.02) throw Error('Missing or excessive charge.');
      return payload.profiles.map((p,i)=>({url:p.url,jevVerification:{sameIdentityProbability:data.answers[`candidate_${i}_same_identity`].noul,
        verdict:data.answers[`candidate_${i}_verdict`].choice}}));
    }};
  const budget=await createPilotBudget({manifest,transport,mode:'live',journalPath:`${output}/admissions.jsonl`});
  const results=[],deadlineAt=Date.now()+15*60000;
  try {
    for(const c of cases) {
      if(budget.snapshot().stopped) break;
      try {
        const d=await budget.request({profileId:c.a.profile_id,kind:'jev',key:`${c.a.profile_id}:${c.variant}`,payload:c.payload,deadlineAt});
        const pos=profile(c.a,c.a.candidateMetadata),neg=profile(c.a,c.negative.candidateMetadata);
        const row={profileId:c.a.profile_id,artist:c.a.artist,tier:c.a.tier,bucket:c.a.bucket,variant:c.variant,
          exactCatalogCrossLink:pos.identityComparison.status==='likely',
          positive:d[0].jevVerification,positiveGatePassed:verificationGate(c.a.referenceMetadata,c.a.reference,pos,d[0]),
          control:d[1].jevVerification,controlGatePassed:verificationGate(c.a.referenceMetadata,c.a.reference,neg,d[1])};
        results.push(row);console.log(JSON.stringify(row));
        if(row.controlGatePassed) budget.stop('Unrelated control passed; stopping.');
      } catch(e) { results.push({profileId:c.a.profile_id,variant:c.variant,status:'unresolved',reason:e.message});console.log(JSON.stringify(results.at(-1))); }
    }
  } finally {
    await budget.close();
    await save(`${output}/summary.json`,{results,budget:budget.snapshot(),newSearches:0,newMetadataCalls:0,claims:0,databaseWrites:0,safeForImport:false});
  }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) await main();
