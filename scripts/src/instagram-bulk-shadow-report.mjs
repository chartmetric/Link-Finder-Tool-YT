// Local archived-result reporting only: no provider calls, claims or DB access.
import fs from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {instagramProfileUrl} from './musician-instagram-matching.mjs';
import {profileLinkDiagnostics,incompleteLinkEvidence} from './instagram-link-capture.mjs';
const csv=rows=>rows.map(row=>row.map(v=>{
  const text=String(v??''),safe=/^\s*[=+\-@]|^[\t\r]/.test(text)?`'${text}`:text;
  return `"${safe.replaceAll('"','""')}"`;
}).join(',')).join('\n')+'\n';

export function classifyShadowResult(r){
  const profiles=r.rawResult?.profiles??r.partialEvidence?.profiles??[];
  if(r.urls?.length)return 'supported_research_links';
  if(r.status==='no_candidates')return 'completed_no_candidates';
  if(r.reason){
    return profiles.length&&profiles.every(p=>/restricted profile/i.test(p.metadataLookupError??''))
      ?'restricted_skip':'processing_incomplete';
  }
  if(r.linkEvidenceIncomplete || profiles.some(incompleteLinkEvidence))return 'processing_incomplete';
  return 'unresolved_candidates';
}
// Reporting labels only; acceptance gates and import safety are unchanged.
export function finalOutcome(row){
  const incomplete=row.uninspected>0;
  switch(row.outcome){
    case 'supported_research_links':return {finalOutcome:'link_found',countsAsDone:true,recheckEligible:false};
    case 'completed_no_candidates':return {finalOutcome:'no_instagram_found',countsAsDone:true,recheckEligible:false};
    // Lower-ranked candidates skipped by the per-artist inspection cap are a bounded-search
    // limit, not a provider failure; they stay visible through boundedSearch and recheck.
    case 'unresolved_candidates':return {finalOutcome:'no_verified_link',countsAsDone:true,recheckEligible:true,boundedSearch:incomplete};
    default:return {finalOutcome:'incomplete',countsAsDone:false,recheckEligible:true};
  }
}
export async function relabelShadowRun(dir){
  const report=JSON.parse(await fs.readFile(`${dir}/workflow-report.json`,'utf8'));
  const rows=report.rows.map(r=>({profileId:r.profileId,cmArtist:r.cmArtist,artist:r.artist,tier:r.tier,
    previousOutcome:r.outcome,...finalOutcome(r),candidateUrls:r.rawCandidateUrls,
    linkCaptureDiagnostics:r.linkCaptureDiagnostics??[],
    uninspectedCandidates:r.uninspected??null,note:finalOutcome(r).finalOutcome==='no_verified_link'?`Candidates exist but none were confirmed; this is not proof the artist has no Instagram.${r.uninspected>0?` ${r.uninspected} lower-ranked candidate(s) were not inspected (per-artist cap).`:''}`:'',
    safeForImport:false}));
  const counts=Object.fromEntries([...new Set(rows.map(r=>r.finalOutcome))].map(k=>[k,rows.filter(r=>r.finalOutcome===k).length]));
  const columns=['profileId','cmArtist','artist','tier','previousOutcome','finalOutcome','countsAsDone','recheckEligible','uninspectedCandidates','candidateUrls','linkCaptureDiagnostics','note','safeForImport'];
  await fs.writeFile(`${dir}/final-outcomes.json`,JSON.stringify({counts,newProviderCalls:0,databaseWrites:0,rows},null,2),{flag:'wx'});
  await fs.writeFile(`${dir}/final-outcomes.csv`,csv([columns,...rows.map(r=>columns.map(k=>k==='linkCaptureDiagnostics'?JSON.stringify(r[k]):Array.isArray(r[k])?r[k].join(' | '):r[k]))]),{flag:'wx'});
  return counts;
}
export async function reportShadowRun(dir){
  const manifest=JSON.parse(await fs.readFile(`${dir}/approved-manifest.json`,'utf8'));
  const summary=JSON.parse(await fs.readFile(`${dir}/summary.json`,'utf8'));
  const results=summary.results;
  const rows=results.map(r=>{
    const artist=manifest.artists.find(a=>a.profile_id===r.profileId);
    const profiles=r.rawResult?.profiles??r.partialEvidence?.profiles??[];
    const attempts=r.discoveryAttempts??r.partialEvidence?.discoveryAttempts??[];
    const rawUrls=[...new Set(attempts.flatMap(a=>a.profiles??[]).map(p=>instagramProfileUrl(p.url)).filter(Boolean))];
    return {profileId:r.profileId,cmArtist:artist.cm_artist,accountIds:artist.account_ids,artist:artist.artist,
      tier:artist.tier,outcome:classifyShadowResult(r),finalOutcome:finalOutcome({outcome:classifyShadowResult(r),uninspected:r.uninspectedCandidates??null}).finalOutcome,serperCompleted:attempts.some(a=>a.methodsUsed?.some(m=>m.method==='serper'&&m.status==='used')),
      rawCandidateUrls:rawUrls,supportedResearchUrls:r.urls??[],verifiedCandidates:profiles.filter(p=>p.jevVerification?.verdict==='verified').length,
      linkCaptureDiagnostics:profiles.map(p=>({url:p.url,...profileLinkDiagnostics(p)})),
      uninspected:r.uninspectedCandidates??null,reason:r.reason??r.candidates?.filter(c=>c.status!=='supported').map(c=>c.reason).join(' | ')??'',
      safeForImport:false};
  });
  const decisions=results.flatMap(r=>(r.rawResult?.profiles??r.partialEvidence?.profiles??[]).map(p=>{
    const matching=r.candidates?.find(c=>c.url===p.url);
    const artist=manifest.artists.find(a=>a.profile_id===r.profileId);
    const diagnostics=profileLinkDiagnostics(p);
    return {profileId:r.profileId,cmArtist:r.cmArtist,artist:artist.artist,url:p.url,status:matching?.status??'unresolved',
      linkCapture:diagnostics.capture,linkCaptureStatus:diagnostics.capture.status,
      linkCaptureSourceUrl:diagnostics.capture.sourceUrl,linkCaptureFields:JSON.stringify(diagnostics.capture.fields??{}),
      linkResolution:diagnostics.resolution,linkAbsenceConfirmed:false,
      verdict:p.jevVerification?.verdict??'not_evaluated',score:p.jevVerification?.sameIdentityProbability??null,
      reason:matching?.reason??p.metadataLookupError??r.reason??'',safeForImport:false};
  }));
  const count=key=>Object.fromEntries([...new Set(rows.map(r=>r[key]))].map(k=>[k,rows.filter(r=>r[key]===k).length]));
  const report={planned:manifest.artists.length,recorded:rows.length,tiers:count('tier'),outcomes:count('outcome'),
    linkCaptureStatuses:Object.fromEntries([...new Set(decisions.map(d=>d.linkCaptureStatus))]
      .map(status=>[status,decisions.filter(d=>d.linkCaptureStatus===status).length])),
    profilesWithRawCandidates:rows.filter(r=>r.rawCandidateUrls.length).length,
    profilesWithSupportedResearchLinks:rows.filter(r=>r.supportedResearchUrls.length).length,
    serperCompletedProfiles:rows.filter(r=>r.serperCompleted).length,candidatesInspected:decisions.length,
    categoricallyVerifiedCandidates:decisions.filter(d=>d.verdict==='verified').length,
    paidRequests:summary.budget.paid,reservedUsd:summary.budget.reservedSpendCents/100,
    cumulativeOriginalReservedUsd:summary.cumulativeReservedUsd,stopped:summary.budget.stopped,
    benchmarkEvaluated:false,populationAccuracyClaim:false,readyForFullRerun:false,
    experimentalAcceptanceEnabled:false,safeForImport:false,claimsSubmitted:0,databaseWrites:0,
    storage:'Local research archive and CSV only; no ClickHouse or catalog updates.',rows,decisions};
  const columns=['profileId','cmArtist','accountIds','artist','tier','outcome','serperCompleted','rawCandidateUrls','supportedResearchUrls','linkCaptureDiagnostics','reason','safeForImport'];
  const candidateColumns=['profileId','cmArtist','artist','url','status','verdict','score','linkCaptureStatus','linkCaptureSourceUrl','linkCaptureFields','linkCapture','linkResolution','linkAbsenceConfirmed','reason','safeForImport'];
  for(const [file,text] of [
    ['workflow-report.json',JSON.stringify(report,null,2)],
    ['artist-research-results.csv',csv([columns,...rows.map(r=>columns.map(k=>k==='linkCaptureDiagnostics'?JSON.stringify(r[k]):Array.isArray(r[k])?r[k].join(' | '):r[k]))])],
    ['candidate-evidence.csv',csv([candidateColumns,...decisions.map(r=>candidateColumns.map(k=>k==='linkCapture'?JSON.stringify(r[k]):r[k]))])],
  ])await fs.writeFile(`${dir}/${file}`,text,{flag:'wx'});
  return report;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv[3]==='--relabel'){console.log(JSON.stringify(await relabelShadowRun(process.argv[2]),null,2));process.exit(0);}
  const report=await reportShadowRun(process.argv[2]);
  const {rows,decisions,...totals}=report;console.log(JSON.stringify(totals,null,2));
}
