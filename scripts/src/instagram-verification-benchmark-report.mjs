import fs from 'node:fs/promises';
const directory = process.argv[2];
if(!directory?.startsWith('generated-artifacts/')) throw Error('Expected generated-artifacts directory.');
const summary = JSON.parse(await fs.readFile(`${directory}/summary.json`,'utf8'));
const csvRows = summary.results.map(row=>({
  profile_id:row.profileId,artist:row.artist,tier:row.tier,bucket:row.bucket,status:row.status,
  instagram_url:row.url??'',verdict:row.decision?.verdict??'',score:row.decision?.sameIdentityProbability??'',
  exact_cross_link:row.exactCatalogCrossLink??'',diagnostic_gate_passed:row.verifierOnlyGatePassed??'',
  control_artist:row.negativeControl?.artist??'',control_url:row.negativeControl?.url??'',
  control_verdict:row.negativeControl?.decision.verdict??'',control_score:row.negativeControl?.decision.sameIdentityProbability??'',
  control_gate_passed:row.negativeControl?.verifierOnlyGatePassed??'',reason:row.reason??'',
}));
const fields = Object.keys(csvRows[0]);
const cell = value => {
  let string = String(value);
  if(/^[=+@\t\r-]/.test(string)) string = `'${string}`;
  return `"${string.replaceAll('"','""')}"`;
};
await fs.writeFile(`${directory}/verification-results-NOT-FOR-IMPORT.csv`,
  [fields,...csvRows.map(row=>fields.map(field=>row[field]))].map(row=>row.map(cell).join(',')).join('\n')+'\n',{flag:'wx'});
const unresolved = summary.results.filter(r=>r.status!=='evaluated');
let actualJev = 0,credits = 0,jevPackets = 0,scPackets = 0;
for(const file of await fs.readdir(`${directory}/responses`)) {
  const packet = JSON.parse(await fs.readFile(`${directory}/responses/${file}`,'utf8'));
  if(packet.kind==='jev' && Number.isFinite(packet.data?.usage?.cost)) {actualJev+=packet.data.usage.cost;jevPackets++;}
  if(packet.kind.startsWith('scrapecreators_') && Number.isFinite(packet.data?.credits_charged)) {credits+=packet.data.credits_charged;scPackets++;}
}
const billing = {reportedJevCostUsd:actualJev,jevPacketsWithReportedCost:jevPackets,
  reportedScrapeCreatorsCredits:credits,scrapeCreatorsPacketsWithReportedCredits:scPackets,
  conservativeNewReservationUsd:summary.budget.reservedSpendCents/100,
  cumulativeReservationUsd:summary.cumulativeReservedUsd,
  note:'Conservative reservations are not actual charges. Missing provider billing is not assumed zero.'};
await fs.writeFile(`${directory}/billing-summary.json`,JSON.stringify(billing,null,2),{flag:'wx'});
const markdown = `# Tier 1–5 verification diagnostic

- Frozen sample: 20 artists, four per tier; 10 provisional catalog positives and 10 saved discovery candidates.
- Evaluated: ${summary.evaluated}; unresolved/not evaluated: ${unresolved.length}.
- Catalog benchmark gate passes: ${summary.catalogBenchmarkGatePasses}/${summary.catalogBenchmarksEvaluated}.
- Saved discovery candidate gate passes: ${summary.savedCandidateGatePasses}/${summary.savedCandidatesEvaluated}.
- Cross-artist negative control gate passes: ${summary.negativeControlGatePasses}/${summary.evaluated}.
- Cross-artist controls explicitly classified mismatch: ${summary.negativeControlMismatchVerdicts}/${summary.evaluated}.
- New paid provider requests: ${summary.budget.paid}; no Serper rediscovery.
- Conservative new reservation: $${billing.conservativeNewReservationUsd.toFixed(2)}; original $10 budget remaining after reservations: $${summary.remainingOriginalBudgetUsd.toFixed(2)}.
- Reported JEV charge: $${actualJev.toFixed(8)}; reported ScrapeCreators credits: ${credits}. Missing provider billing is not counted as zero.
- Claims/imports/database writes: 0; full rerun not started.

## Interpretation

This is a verifier-only diagnostic, not full pipeline acceptance, catalog approval or population precision/recall measurement.
Existing catalog links are provisional positive labels. Rotated cross-artist negatives are assumed different identities, not a comprehensive test of labels, fan pages, shared artist identities or aliases.
The exact-cross-link plus verified 0.90 gate was unchanged. A failed metadata read, missing music cross-link or inconclusive model verdict does not prove an account is wrong or absent.
Public music-page traversal retains its existing allowlist and four-request cap. Unsupported landing sites and direct release links may remain unexplored.
No automatic paid retries occurred. Metadata and exact outgoing decision payloads are archived separately from benchmark labels.

## Observed blockers in this sample

${summary.results.filter(r=>r.status==='evaluated'&&r.exactCatalogCrossLink).map(r=>
  `- ${r.artist}: exact catalog music-ID cross-link; model ${r.decision.verdict}, score ${r.decision.sameIdentityProbability}; diagnostic gate ${r.verifierOnlyGatePassed?'passed':'held'}.`).join('\n') || 'No exact cross-links were collected.'}

The archived metadata includes untraversed komi.io, lnk.to, DistroKid/Hyperfollow, paa.ge and bfan.link destinations, direct Spotify album/track links, and YouTube video links. These are unchecked paths, not proof that an Instagram account is wrong. Some accounts have no bio URLs at all.
The result does not justify weakening the threshold, accepting every catalog benchmark, or classifying unresolved accounts as absent. Complete supported music-path coverage and independently evaluate the evidence/score gate before a large rerun.

## Unresolved cases

${unresolved.map(r=>`- ${r.artist} (Tier ${r.tier}): ${r.status}; ${r.reason??''}`).join('\n') || 'None.'}
`;
await fs.writeFile(`${directory}/findings.md`,markdown,{flag:'wx'});
console.log(JSON.stringify({billing,evaluated:summary.evaluated,unresolved:unresolved.length,
  positiveGatePasses:summary.catalogBenchmarkGatePasses,positiveEvaluated:summary.catalogBenchmarksEvaluated,
  savedGatePasses:summary.savedCandidateGatePasses,savedEvaluated:summary.savedCandidatesEvaluated,
  negativeGatePasses:summary.negativeControlGatePasses,negativeMismatches:summary.negativeControlMismatchVerdicts},null,2));
