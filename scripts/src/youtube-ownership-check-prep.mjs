// Preparation only: local files and read-only spending reconciliation.
// This module has no provider dispatch path and cannot start paid work.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';
import {evidenceDigest,youtubeOwnershipUrl,YOUTUBE_OWNERSHIP_POLICY,YOUTUBE_OWNERSHIP_RULES} from './youtube-ownership-policy.mjs';

const source='generated-artifacts/youtube-no-link-20-usd2';
const output=source+'/ownership-check-preparation';
const read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
export function prepareYoutubeOwnershipCheck({approval,summary,inputs,ledger,receiptsVerified,preparedAt}){
  assert.equal(approval.discoveryOnly,true);
  assert.equal(summary.status,'completed');
  assert.equal(approval.scopeSha256,evidenceDigest(approval.scope));
  assert.equal(approval.capCents,200);
  assert.equal(ledger.id,approval.id);
  assert.equal(ledger.scope_sha256,approval.scopeSha256);
  assert.equal(ledger.status,'completed','The discovery run must be drained before another phase.');
  assert.equal(ledger.cap_cents,200);
  assert.equal(ledger.reserved_cents,40);
  assert.equal(ledger.result_count,20);
  assert.equal(receiptsVerified,20);
  assert.equal(summary.reservedUsd*100,ledger.reserved_cents);
  assert.equal(inputs.length,34);
  const artists=new Map(approval.scope.map(a=>[a.profile_id,a]));
  const targets=[],urls=new Map(),pairs=new Set();
  for(const input of inputs){
    const {policy,rules,state,inputSha256}=input;
    assert.equal(evidenceDigest({policy,rules,state}),inputSha256);
    assert.equal(policy,YOUTUBE_OWNERSHIP_POLICY);assert.equal(rules,YOUTUBE_OWNERSHIP_RULES);
    const artist=artists.get(input.profileId);
    assert.ok(artist);assert.equal(artist.cm_artist,input.cmArtist);
    assert.equal(String(state.artist.profileId),input.profileId);
    assert.equal(String(state.artist.cmArtist),input.cmArtist);
    const url=youtubeOwnershipUrl(input.url);
    assert.ok(url);assert.equal(youtubeOwnershipUrl(state.candidate.url),url);
    assert.equal(state.candidate.channelCapture,null);
    const key=input.profileId+':'+url;
    assert.ok(!pairs.has(key),'Duplicate artist/channel pair.');pairs.add(key);
    const requestUrl='https://api.scrapecreators.com/v1/youtube/channel?'+new URLSearchParams({url});
    const captureKey='youtube-channel-'+evidenceDigest(url);
    urls.set(url,{key:captureKey,method:'GET',requestUrl,channelUrl:url,
      conservativeReservationCents:2,provider:'scrapecreators',documentedCredits:1});
    targets.push({profileId:input.profileId,cmArtist:input.cmArtist,artist:artist.artist,
      tier:Number(artist.tier),channelUrl:url,captureKey,savedInputSha256:inputSha256,
      modelReservationCents:2,modelConditional:true});
  }
  const metadataRequests=[...urls.values()];
  const maximumNewReservationCents=metadataRequests.length*2+targets.length*2;
  assert.ok(ledger.reserved_cents+maximumNewReservationCents<=ledger.cap_cents);
  return {version:1,preparedAt,policy:YOUTUBE_OWNERSHIP_POLICY,
    runAllowed:false,approvalRequired:true,authorization:null,
    sourceApprovalId:approval.id,sourceScopeSha256:approval.scopeSha256,
    targets,metadataRequests,
    counts:{artists:new Set(targets.map(t=>t.profileId)).size,candidatePairs:targets.length,
      uniqueChannelUrls:metadataRequests.length,retainedCompletedNoMatchArtists:summary.noMatch,
      maximumMetadataCalls:metadataRequests.length,maximumModelCalls:targets.length,newSearches:0},
    spending:{parentBudgetId:ledger.id,maximumTotalCents:ledger.cap_cents,
      preservedPriorReservedCents:ledger.reserved_cents,remainingWithinOriginalCapCents:ledger.cap_cents-ledger.reserved_cents,
      metadataReservationCents:metadataRequests.length*2,modelReservationCents:targets.length*2,
      maximumNewReservationCents,maximumCombinedReservationCents:ledger.reserved_cents+maximumNewReservationCents,
      isConservativeReservationNotInvoice:true},
    model:{provider:'openrouter',endpoint:'https://openrouter.ai/api/alpha/decisions',
      expectedModel:'typesafe/jev-1.13',maxRequestBytes:6000,
      rulesSha256:evidenceDigest(YOUTUBE_OWNERSHIP_RULES),
      requestBinding:'After adding only the exact channel capture, build and hash the complete model request before admission. Over-size or unbound inputs are held, never silently truncated.',
      conditions:'Skip model work for unavailable/unbound metadata, confirmed Topic/fan/organization channels, known ownership conflicts or an already supported first-party declaration. Reuse proven channel aliases; never infer them from names.'},
    safety:{noNewSearches:true,noRetries:true,noCatalogWrites:true,noInstagramChanges:true,
      retainRawReceipts:true,retainEveryCandidate:true,preserveOriginalResults:true,
      parentBudgetMustBeReconciledAgainBeforeLaunch:true,
      noFreshOrResetSpendingCap:true,
      uncertainAdmissionsNeverReplayed:true,
      stopOnFundingAuthenticationRateLimitOrUncertainOutcome:true,
      missingMetadataIsNotAccountAbsence:true},
    readiness:'Scope and requests prepared offline. Paid execution requires explicit approval and a transactional admission gate bound to this plan and the unchanged parent budget.'};
}

export async function prepareSavedYoutubeCheck(){
  const approval=await read(source+'/approval.json'),summary=await read(source+'/summary.json');
  const review=source+'/ownership-review-ready';
  const inputs=await read(review+'/verification-inputs.json');
  const journal=(await fs.readFile(source+'/admissions.jsonl','utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(journal.length,20);
  assert.equal(new Set(journal.map(r=>r.profileId)).size,20);
  for(const admission of journal){
    const target=approval.scope.find(t=>t.profile_id===admission.profileId);
    assert.ok(target);assert.equal(admission.reservedCents,2);
    const packet=await read(source+'/response-'+admission.profileId+'.json');
    assert.equal(packet.status,200);
    assert.deepEqual(packet.request,admission.request);
    assert.ok(Array.isArray(packet.body.organic));
    assert.equal(admission.request.q,`${target.artist} artist official YouTube channel`);
  }
  const pool=await connectSavedBatchPool();
  let ledger;
  const client=await pool.connect();
  try{
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const result=await client.query(`SELECT id,scope_sha256,cap_cents,reserved_cents,status,
      (SELECT count(*)::int FROM youtube_discovery_test_results r WHERE r.run_id=b.id) result_count
      FROM youtube_discovery_test_runs b WHERE id=$1`,[approval.id]);
    assert.equal(result.rows.length,1);ledger=result.rows[0];
    const saved=await client.query(`SELECT profile_id,cm_artist,status FROM youtube_discovery_test_results WHERE run_id=$1`,[approval.id]);
    for(const row of saved.rows){
      const target=approval.scope.find(t=>t.profile_id===row.profile_id);
      assert.ok(target);assert.equal(row.cm_artist,target.cm_artist);
      assert.ok(['candidates_found','no_match'].includes(row.status));
    }
    await client.query('COMMIT');
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();await pool.end();}
  const plan=prepareYoutubeOwnershipCheck({approval,summary,inputs,ledger,
    receiptsVerified:journal.length,preparedAt:new Date().toISOString()});
  plan.sourceFiles={
    approvalSha256:evidenceDigest(approval),summarySha256:evidenceDigest(summary),
    verificationInputsSha256:evidenceDigest(inputs),
    catalogEvidenceSha256:evidenceDigest(await read(review+'/catalog-evidence.json')),
  };
  plan.codeFingerprints={};
  for(const f of ['scripts/src/youtube-ownership-policy.mjs','scripts/src/youtube-ownership-check-prep.mjs'])
    plan.codeFingerprints[f]=evidenceDigest(await fs.readFile(f,'utf8'));
  await fs.mkdir(output,{recursive:false});
  await fs.writeFile(output+'/plan.json',JSON.stringify({...plan,planSha256:evidenceDigest(plan)},null,2),{flag:'wx'});
  const lines=['# Prepared YouTube ownership check','',
    '- Existing cohort: 20 artists; 16 have 34 candidate channel URLs.',
    '- Fetch up to 34 channel profiles, then perform up to 34 identity checks.',
    '- Keep the four completed no-channel search outcomes; do not search again.',
    '- Maximum additional conservative reservation: $1.36.',
    '- Preserve $0.40 already reserved; combined maximum reservation is $1.76 within the original $2 cap.',
    '- No paid requests have started. This preparation made zero database writes.',
    '- Do not reset or borrow Instagram funding. Reconcile the shared YouTube spending ledger again before launch.',
    '- Inspect each raw response and bind the requested URL to returned channel identifiers.',
    '- Topic/fan/label channels remain separate from artist-owned suggestions.',
    '- Stop on uncertain outcomes, billing/authentication failures or rate limits. Never replay admissions.',
    '- Catalog links and original search results remain unchanged.',''];
  await fs.writeFile(output+'/readiness.md',lines.join('\n'),{flag:'wx'});
  console.log(JSON.stringify({prepared:true,paidCalls:0,databaseWrites:0,counts:plan.counts,spending:plan.spending},null,2));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await prepareSavedYoutubeCheck();
