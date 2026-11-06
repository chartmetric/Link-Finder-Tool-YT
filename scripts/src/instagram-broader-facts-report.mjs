// Local report only; no provider calls.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

const dir='generated-artifacts/instagram-broader-facts-validation-2026-11-06';
const read=async f=>JSON.parse(await fs.readFile(`${dir}/${f}`,'utf8'));
const summary=await read('summary.json');
const scope=await read('approved-scope.json');
const journal=(await fs.readFile(`${dir}/admissions.jsonl`,'utf8')).trim().split('\n').map(JSON.parse);
assert.equal(journal.filter(r=>r.phase==='admitted').length,summary.admitted);
assert.equal(journal.filter(r=>r.phase==='returned').length,summary.results.length);
const rows=[];
for(const r of summary.results) {
  const archived=await read(`${r.key}-request.json`);
  const hash=createHash('sha256').update(JSON.stringify(archived.request)).digest('hex');
  assert.equal(hash,archived.requestSha256);
  assert.equal(hash,scope.cases.find(c=>c.key===r.key).requestSha256);
  for(const c of r.candidates) {
    assert.equal(c.productionApproved,false);
    rows.push({key:r.key,profile_id:r.profileId,artist:r.artist,tier:r.tier??'',
      url:c.url,label:c.label,verdict:c.verdict,score:c.same_identity_score,
      exact_link_eligible:c.exactLinkEligible,diagnostic_passed:c.diagnosticThresholdPassed,
      production_approved:false});
  }
}
const counts={};
for(const r of rows) {
  const count=counts[r.label]??={tested:0,verifiedVerdict:0,diagnosticPassed:0};
  count.tested++;
  if(r.verdict==='verified') count.verifiedVerdict++;
  if(r.diagnostic_passed) count.diagnosticPassed++;
}
const csvValue=v=>`"${String(v).replaceAll('"','""')}"`;
const columns=Object.keys(rows[0]??{});
await fs.writeFile(`${dir}/results-NOT-FOR-IMPORT.csv`,
  [columns.join(','),...rows.map(r=>columns.map(c=>csvValue(r[c])).join(','))].join('\n')+'\n',{flag:'wx'});
const report={completed:summary.completed,requestsCompleted:summary.results.length,
  candidateAssessments:rows.length,counts,blocked:summary.blocked,
  exactEligible:rows.filter(r=>r.exact_link_eligible).length,
  diagnosticPassed:rows.filter(r=>r.diagnostic_passed).length,
  reportedCostUsd:summary.reportedCostUsd,
  cumulativeConservativeReservationUsd:summary.cumulativeConservativeReservationUsd,
  remainingOriginalBudgetUsd:summary.remainingOriginalBudgetUsd,
  caveats:['Historical convenience sample, not population accuracy.',
    'Catalog positives are provisional, not independently adjudicated.',
    'Two Frankelly comparisons repeat the same positive; assessments are not unique artists.',
    'Wrong-person and festival regression evidence is saved search snippets, not fresh profile metadata.',
    'Rooby label association is blocked for missing reference, not a paid model rejection.',
    'Alternate model only; JEV and production rules unchanged. No discovery recovery tested.']};
await fs.writeFile(`${dir}/report.json`,JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify(report,null,2));
