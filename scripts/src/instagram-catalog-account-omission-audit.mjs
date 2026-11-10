// Offline only: reads the saved batch, writes new reports, never imports a
// provider transport or coordinator and never changes historical decisions.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {auditCatalogAccountOmissions} from './instagram-catalog-account-context.mjs';
import {enrichedRequest,digest} from './instagram-next-saved-batch.mjs';

const [inputFile,outputDir]=process.argv.slice(2);
assert.ok(inputFile&&outputDir,'Usage: node scripts/src/instagram-catalog-account-omission-audit.mjs INPUT.json NEW_OUTPUT_DIRECTORY');
const source=await fs.readFile(inputFile,'utf8'),original=JSON.parse(source);
assert.ok(Array.isArray(original)&&original.length>0);
const rows=auditCatalogAccountOmissions(original).map(row=>{
  let proposedRequestStatus='no_captured_candidate_metadata',proposedRequestBytes=null;
  if(row.capturedInstagramMetadata){
    try{
      const request=enrichedRequest({
        artist:row.artist,profileId:row.profileId,player:row.artistCatalogMetadata,context:row.catalogContext,
        selected:row.allSavedCandidates.find(c=>c.url===row.candidateInstagramUrl),
        sourceCapturedAt:row.sourceCapturedAt,
        sourceArtistName:row.metadataActuallyUsed?.savedSearchEvidence?.artistNameAtCapture,
      },row.capturedInstagramMetadata);
      proposedRequestStatus='ready_for_separately_approved_check';proposedRequestBytes=request.bytes;
    }catch(e){proposedRequestStatus='held: '+e.message;}
  }
  return {...row,proposedRequestStatus,proposedRequestBytes};
});
const omitted=rows.filter(r=>r.catalogAccountsOmittedFromSavedCheck.length);
const exact=rows.filter(r=>r.omittedExactHandleMatches.length);
const rejected=r=>['model_not_positive','observed_identity_conflict','unresolved_ownership_conflict'].includes(r.status);
const summary={
  sourceSha256:digest(source),artists:rows.length,checkedArtists:rows.filter(r=>r.metadataActuallyUsed).length,
  checkedWithOmittedCatalogAccounts:omitted.length,
  checkedNotAcceptedWithOmittedCatalogAccounts:omitted.filter(rejected).length,
  checkedWithOmittedExactHandleSupport:exact.length,
  checkedNotAcceptedWithOmittedExactHandleSupport:exact.filter(rejected).length,
  existingLikelyMatchesWithOmittedExactHandleSupport:exact.filter(r=>r.likelyReviewSuggestion).length,
  proposedRequestStatuses:rows.reduce((a,r)=>(a[r.proposedRequestStatus]=(a[r.proposedRequestStatus]??0)+1,a),{}),
  providerCalls:0,decisionsChanged:0,liveLinkChanges:0,
  note:'Input-completeness audit, not proof of correct identity or evidence that the omission caused a particular model answer. Handle reuse alone never accepts a candidate.',
};
const quote=value=>{
  let s=value!=null&&typeof value==='object'?JSON.stringify(value):String(value??'');
  if(/^[=+\-@\t\r]/.test(s))s="'"+s;
  return '"'+s.replaceAll('"','""')+'"';
};
await fs.mkdir(outputDir,{recursive:false});
for(const [name,data] of [
  ['all-500-account-context-audit.csv',rows],
  ['checked-not-accepted-missing-account-context.csv',omitted.filter(rejected)],
  ['checked-not-accepted-missing-handle-support.csv',exact.filter(rejected)],
]){
  const fields=Object.keys(rows[0]);
  await fs.writeFile(path.join(outputDir,name),'\ufeff'+[fields,...data.map(r=>fields.map(k=>r[k]))]
    .map(r=>r.map(quote).join(',')).join('\r\n'),{flag:'wx'});
}
await fs.writeFile(path.join(outputDir,'summary.json'),JSON.stringify(summary,null,2),{flag:'wx'});
assert.equal(await fs.readFile(inputFile,'utf8'),source,'Historical results must stay unchanged.');
console.log(JSON.stringify(summary,null,2));
