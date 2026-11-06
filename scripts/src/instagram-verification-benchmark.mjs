// Verification-only diagnostic: no Serper rediscovery, ClickHouse writes or claims.
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPilotBudget } from './instagram-pilot-budget.mjs';
import { createLiveTransport } from './instagram-pilot-live-transport.mjs';
import { instagramProfileUrl, referenceUrl, hasCatalogCrossLink } from './musician-instagram-matching.mjs';
import { isMusicLandingUrl, resolveMusicEvidence } from './public-music-links.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
export function selectBenchmark(cohort, references, research) {
  const accounts = new Map(references.map(r => [r.profile_id, r.accounts]));
  const saved = new Map(research.map(r => [r.profile_id, r]));
  const usedUrls = new Set(), selected = [];
  for (const tier of [1,2,3,4,5]) {
    const pool = cohort.filter(r => Number(r.tier) === tier)
      .sort((a,b) => hash(`verification-benchmark:${a.profile_id}`).localeCompare(hash(`verification-benchmark:${b.profile_id}`)));
    for (const bucket of ['catalog_benchmark','catalog_benchmark','saved_candidate','saved_candidate']) {
      const pick = pool.map(artist => {
        const refs = accounts.get(artist.profile_id) ?? [];
        const spotify = refs.filter(a => a[1] === 'spotify').map(a => referenceUrl(a[2],'spotify')).find(Boolean);
        const catalog = refs.filter(a => a[1] === 'instagram').map(a => instagramProfileUrl(a[2])).filter(Boolean);
        const prior = saved.get(artist.profile_id);
        const candidates = (prior?.instagram_urls ?? []).map(instagramProfileUrl).filter(Boolean);
        const url = (bucket === 'catalog_benchmark' ? catalog : candidates).find(url => !usedUrls.has(url));
        return { ...artist, bucket, url, reference: { platform: 'spotify', url: spotify },
          source_identity_matches: !!artist.cm_artist && artist.cm_artist !== '0',
          reference_preflight: {readiness:'reference_usable'},
          provenance: bucket === 'catalog_benchmark' ? 'active_catalog_link_provisional_not_independent_truth' : 'saved_unverified_discovery',
          savedSuccessfulSerper: prior ? (() => {
            try { return JSON.parse(prior.methods_json).some(m => m.method === 'serper' && m.status === 'used'); } catch { return false; }
          })() : false };
      }).find(r => r.url && r.reference.url && r.source_identity_matches
        && !selected.some(s => s.profile_id === r.profile_id)
        && (bucket === 'catalog_benchmark' || r.savedSuccessfulSerper));
      if (!pick) throw Error(`Insufficient eligible candidates for Tier ${tier}, ${bucket}; no replacement outside scope.`);
      usedUrls.add(pick.url); selected.push(pick);
    }
  }
  return selected;
}

export function controlFor(artist, available) {
  const normalize = name => name.normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
  const offset = available.findIndex(other => other.profile_id === artist.profile_id) + 1;
  const rotated = [...available.slice(offset),...available.slice(0,offset)];
  return rotated.find(other => other.profile_id !== artist.profile_id
    && other.reference.url !== artist.reference.url && other.url !== artist.url
    && normalize(other.artist) !== normalize(artist.artist)
    && other.referenceMetadata && other.candidateMetadata);
}

export function verificationGate(reference, catalog, profile, decision) {
  return hasCatalogCrossLink(reference,profile.identityComparison.candidate,profile.url,catalog)
    && profile.identityComparison.status === 'likely'
    && decision?.jevVerification?.verdict === 'verified'
    && decision.jevVerification.sameIdentityProbability >= 0.9
    && decision.jevVerification.sameIdentityProbability <= 1;
}

async function save(file, value) {
  await fs.writeFile(file,JSON.stringify(value,null,2),{flag:'wx'});
}
export async function prepareBenchmark(auditDir, outputDir) {
  const read = async file => JSON.parse(await fs.readFile(`${auditDir}/${file}`,'utf8'));
  const [cohort,refs,research,snapshot] = await Promise.all([
    read('cohort.json'),read('catalog-references.json'),read('saved-research.json'),read('snapshot.json')]);
  const artists = selectBenchmark(cohort,refs,research);
  const manifest = { run_allowed:false, artists, sourceAudit:auditDir, sourceSnapshot:snapshot,
    purpose:'20-artist verification-only benchmark, four per tier, with rotated cross-artist negative controls. Catalog positives are provisional.',
    proposed_limits:{
      serper_requests_total:0,serper_requests_per_artist:0,
      scrapecreators_requests_total:20,instagram_candidate_metadata_per_artist:1,reference_metadata_per_artist:0,
      jev_requests_total:20,jev_requests_per_artist:1,paid_http_requests_total:40,
      public_spotify_oembed_requests_total:20,public_official_or_linkhub_page_requests_total:80,
      public_http_requests_total:100,public_music_page_requests_per_artist:4,
      global_concurrent_provider_requests:1,per_request_timeout_seconds:20,
      jev_max_input_tokens_per_request:6000,jev_max_output_tokens_per_request:1000,
      automatic_retries:0,job_wall_time_minutes:15,
    }};
  await fs.mkdir(outputDir,{recursive:false});
  await save(`${outputDir}/manifest.json`,manifest);
  console.log(JSON.stringify({prepared:true,artists:artists.map(a=>({profileId:a.profile_id,artist:a.artist,tier:a.tier,bucket:a.bucket,url:a.url})),
    worstCaseNewReservedUsd:0.80,priorReservedUsd:0.43,claims:0,databaseWrites:0},null,2));
  return manifest;
}

export async function runBenchmark(outputDir) {
  const source = await fs.readFile(`${outputDir}/manifest.json`,'utf8');
  const manifest = JSON.parse(source);
  if (manifest.artists.length !== 20 || manifest.proposed_limits.serper_requests_total !== 0
    || manifest.proposed_limits.scrapecreators_requests_total !== 20 || manifest.proposed_limits.jev_requests_total !== 20) {
    throw Error('Unexpected frozen benchmark scope.');
  }
  // Source approval was $10, with $0.43 already reserved. This run cannot spend more than $1.
  manifest.authorization = { approved:true,maxSpendCents:100,priorReservedCents:43,
    sourceManifestSha256:hash(source),purpose:manifest.purpose,approvedBy:'user',noImports:true };
  if (manifest.authorization.maxSpendCents + manifest.authorization.priorReservedCents > 1000) throw Error('Original budget exceeded.');
  manifest.run_allowed = true;
  const keys = Object.fromEntries(['SERPERDEV_API_KEY','SCRAPECREATORS_API_KEY','OPENROUTER_API_KEY'].map(name=>{
    if(!process.env[name]) throw Error(`Missing required secret: ${name}`);
    return [name,process.env[name]];
  }));
  await fs.mkdir(`${outputDir}/responses`,{recursive:false});
  await save(`${outputDir}/approved-manifest.json`,manifest);
  const transport = createLiveTransport({keys,responseDir:`${outputDir}/responses`});
  const budget = await createPilotBudget({manifest,transport,journalPath:`${outputDir}/admissions.jsonl`,mode:'live'});
  const prepared = [], results = [];
  const deadlineAt = Date.now()+manifest.proposed_limits.job_wall_time_minutes*60000;
  async function request(a,kind,payload) {
    return budget.request({profileId:a.profile_id,kind,payload,key:`${a.profile_id}:${kind}:${a.sequence++}`,deadlineAt});
  }
  try {
    // Collect each account's own metadata once. Controls reuse these packets, not extra API requests.
    for(const selected of manifest.artists) {
      const a = {...selected,sequence:0};
      try {
        a.referenceMetadata = await request(a,'spotify_oembed',{url:a.reference.url});
        a.candidateMetadata = await request(a,'scrapecreators_candidate',{url:a.url});
        if(instagramProfileUrl(a.candidateMetadata.url) !== a.url) throw Error('Instagram response does not bind to requested identity.');
        if(a.candidateMetadata.externalUrls.some(isMusicLandingUrl)) {
          const hub = await resolveMusicEvidence({candidate:a.candidateMetadata,catalog:a.reference,
            readPage:url=>request(a,'public_page',{url})});
          a.candidateMetadata.externalLinkEvidence = hub;
          a.candidateMetadata.externalUrls = [...new Set([...a.candidateMetadata.externalUrls,...hub.externalUrls])];
        }
        prepared.push(a);
        await save(`${outputDir}/${a.profile_id}-metadata.json`,a);
        console.log(JSON.stringify({metadataReady:a.profile_id,tier:a.tier,bucket:a.bucket}));
      } catch(error) {
        results.push({profileId:a.profile_id,artist:a.artist,tier:a.tier,bucket:a.bucket,status:'metadata_unresolved',reason:error.message});
        console.log(JSON.stringify(results.at(-1)));
      }
      if(budget.snapshot().stopped) break;
    }
    for(const a of prepared) {
      if(budget.snapshot().stopped) break;
      const negative = controlFor(a,prepared);
      if(!negative) {
        results.push({profileId:a.profile_id,artist:a.artist,tier:a.tier,status:'no_control_available'}); continue;
      }
      const makeProfile = candidate => {
        const linked = hasCatalogCrossLink(a.referenceMetadata,candidate,candidate.url,a.reference);
        return {url:candidate.url,identityComparison:{reference:a.referenceMetadata,candidate,
          status:linked?'likely':'uncertain',score:linked?60:0}};
      };
      const profiles = [makeProfile(a.candidateMetadata),makeProfile(negative.candidateMetadata)];
      try {
        // Labels and catalog-benchmark membership are held outside the model input.
        const payload = {artist:a.artist,catalogReference:a.reference,profiles};
        const bytes = transport.inputBytes({kind:'jev',payload});
        if(bytes>6000) throw Error(`Full decision request exceeds unchanged 6000-byte limit (${bytes}); no JEV call.`);
        const decisions = await request(a,'jev',payload);
        const row = {profileId:a.profile_id,artist:a.artist,tier:a.tier,bucket:a.bucket,status:'evaluated',
          provenance:a.provenance,url:a.url,decision:decisions[0].jevVerification,
          exactCatalogCrossLink:profiles[0].identityComparison.status==='likely',
          verifierOnlyGatePassed:verificationGate(a.referenceMetadata,a.reference,profiles[0],decisions[0]),
          negativeControl:{profileId:negative.profile_id,artist:negative.artist,url:negative.url,
            decision:decisions[1].jevVerification,
            exactCatalogCrossLink:profiles[1].identityComparison.status==='likely',
            verifierOnlyGatePassed:verificationGate(a.referenceMetadata,a.reference,profiles[1],decisions[1])},
          approvedLinks:false,claimSubmitted:false};
        results.push(row); await save(`${outputDir}/${a.profile_id}-outcome.json`,row);
        console.log(JSON.stringify(row));
        if(row.negativeControl.verifierOnlyGatePassed) {
          budget.stop('Cross-artist control passed; stop for investigation.'); break;
        }
      } catch(error) {
        results.push({profileId:a.profile_id,artist:a.artist,tier:a.tier,bucket:a.bucket,status:'verification_unresolved',reason:error.message});
        console.log(JSON.stringify(results.at(-1)));
      }
    }
    const recorded = new Set(results.map(r=>r.profileId));
    for(const a of manifest.artists) if(!recorded.has(a.profile_id)) results.push({profileId:a.profile_id,artist:a.artist,tier:a.tier,bucket:a.bucket,
      status:'not_dispatched_after_stop',reason:budget.snapshot().stopped ?? 'No completed result'});
    const stats = budget.snapshot();
    const evaluated = results.filter(r=>r.status==='evaluated');
    const summary = {purpose:manifest.purpose,results,budget:stats,
      evaluated:evaluated.length,catalogBenchmarksEvaluated:evaluated.filter(r=>r.bucket==='catalog_benchmark').length,
      catalogBenchmarkGatePasses:evaluated.filter(r=>r.bucket==='catalog_benchmark'&&r.verifierOnlyGatePassed).length,
      savedCandidatesEvaluated:evaluated.filter(r=>r.bucket==='saved_candidate').length,
      savedCandidateGatePasses:evaluated.filter(r=>r.bucket==='saved_candidate'&&r.verifierOnlyGatePassed).length,
      negativeControlGatePasses:evaluated.filter(r=>r.negativeControl.verifierOnlyGatePassed).length,
      negativeControlMismatchVerdicts:evaluated.filter(r=>r.negativeControl.decision.verdict==='mismatch').length,
      priorReservedUsd:0.43,cumulativeReservedUsd:(43+stats.reservedSpendCents)/100,
      remainingOriginalBudgetUsd:(1000-43-stats.reservedSpendCents)/100,
      newSerperRequests:0,databaseWrites:0,claims:0,fullRerunStarted:false,safeForImport:false,
      caveats:['Diagnostic stratified sample, not a population precision/recall estimate.',
        'Catalog benchmark links are provisional labels, not independently adjudicated ground truth.',
        'Rotated cross-artist negatives test different catalog identities, not every related-entity attribution error.',
        'Verifier-only gate is diagnostic, not full discovery-pipeline acceptance or approval.',
        'Restricted and unavailable metadata remain unresolved, never absence.',
        'Missing music evidence and model uncertainty are separate from proven mismatch.'],
      finishedAt:new Date().toISOString()};
    await save(`${outputDir}/summary.json`,summary);
    console.log(JSON.stringify({...summary,results:undefined,budget:stats},null,2));
    return summary;
  } finally { await budget.close(); }
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const [command,a,b] = process.argv.slice(2);
  if(command==='prepare' && a && b) await prepareBenchmark(a,b);
  else if(command==='run' && a) await runBenchmark(a);
  else throw Error('Usage: prepare <audit-directory> <new-benchmark-directory> | run <prepared-benchmark-directory>');
}
