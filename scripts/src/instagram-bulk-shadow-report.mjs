// Local archived-result reporting only: no provider calls, claims or DB access.
import fs from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {instagramProfileUrl} from './musician-instagram-matching.mjs';
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
  return 'unresolved_candidates';
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
      tier:artist.tier,outcome:classifyShadowResult(r),serperCompleted:attempts.some(a=>a.methodsUsed?.some(m=>m.method==='serper'&&m.status==='used')),
      rawCandidateUrls:rawUrls,supportedResearchUrls:r.urls??[],verifiedCandidates:profiles.filter(p=>p.jevVerification?.verdict==='verified').length,
      uninspected:r.uninspectedCandidates??null,reason:r.reason??r.candidates?.filter(c=>c.status!=='supported').map(c=>c.reason).join(' | ')??'',
      safeForImport:false};
  });
  const decisions=results.flatMap(r=>(r.rawResult?.profiles??r.partialEvidence?.profiles??[]).map(p=>{
    const matching=r.candidates?.find(c=>c.url===p.url);
    const artist=manifest.artists.find(a=>a.profile_id===r.profileId);
    return {profileId:r.profileId,cmArtist:r.cmArtist,artist:artist.artist,url:p.url,status:matching?.status??'unresolved',
      verdict:p.jevVerification?.verdict??'not_evaluated',score:p.jevVerification?.sameIdentityProbability??null,
      reason:matching?.reason??p.metadataLookupError??r.reason??'',safeForImport:false};
  }));
  const count=key=>Object.fromEntries([...new Set(rows.map(r=>r[key]))].map(k=>[k,rows.filter(r=>r[key]===k).length]));
  const report={planned:manifest.artists.length,recorded:rows.length,tiers:count('tier'),outcomes:count('outcome'),
    profilesWithRawCandidates:rows.filter(r=>r.rawCandidateUrls.length).length,
    profilesWithSupportedResearchLinks:rows.filter(r=>r.supportedResearchUrls.length).length,
    serperCompletedProfiles:rows.filter(r=>r.serperCompleted).length,candidatesInspected:decisions.length,
    categoricallyVerifiedCandidates:decisions.filter(d=>d.verdict==='verified').length,
    paidRequests:summary.budget.paid,reservedUsd:summary.budget.reservedSpendCents/100,
    cumulativeOriginalReservedUsd:summary.cumulativeReservedUsd,stopped:summary.budget.stopped,
    benchmarkEvaluated:false,populationAccuracyClaim:false,readyForFullRerun:false,
    experimentalAcceptanceEnabled:false,safeForImport:false,claimsSubmitted:0,databaseWrites:0,
    storage:'Local research archive and CSV only; no ClickHouse or catalog updates.',rows,decisions};
  const columns=['profileId','cmArtist','accountIds','artist','tier','outcome','serperCompleted','rawCandidateUrls','supportedResearchUrls','reason','safeForImport'];
  const candidateColumns=['profileId','cmArtist','artist','url','status','verdict','score','reason','safeForImport'];
  for(const [file,text] of [
    ['workflow-report.json',JSON.stringify(report,null,2)],
    ['artist-research-results.csv',csv([columns,...rows.map(r=>columns.map(k=>Array.isArray(r[k])?r[k].join(' | '):r[k]))])],
    ['candidate-evidence.csv',csv([candidateColumns,...decisions.map(r=>candidateColumns.map(k=>r[k]))])],
  ])await fs.writeFile(`${dir}/${file}`,text,{flag:'wx'});
  return report;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const report=await reportShadowRun(process.argv[2]);
  const {rows,decisions,...totals}=report;console.log(JSON.stringify(totals,null,2));
}
