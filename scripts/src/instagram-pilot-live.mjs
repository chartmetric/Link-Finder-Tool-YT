import fs from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { runPilot, pilotPreflight } from './instagram-pilot-runner.mjs';
import { createLiveTransport } from './instagram-pilot-live-transport.mjs';

export function evaluateKnownCases(results, holdouts) {
  const cases = holdouts.cases.map(expected => {
    const result = results.find(r => r.profileId === String(expected.profile_id));
    const urls = result?.urls ?? [];
    const wrong = expected.user_reported_wrong_url;
    const positive = expected.user_supplied_positive_url;
    return { profileId: String(expected.profile_id), artist: expected.artist,
      passed: !!result && (!wrong || !urls.includes(wrong)) && (!positive || urls.includes(positive))
        && (expected.artist !== 'Rooby Jeantal' || urls.length === 0),
      supportedUrls: urls, requiredPositive: positive ?? null,
      reason: result?.reason ?? result?.status ?? 'Missing regression result',
      userHypothesisNotAssumedTrue: !!expected.hypothesis_not_confirmed };
  });
  return { passed: cases.every(c => c.passed), cases };
}

export async function startApprovedPilot({ manifestPath, holdoutsPath, outputDir, maxSpendCents }) {
  if (!Number.isInteger(maxSpendCents) || maxSpendCents < 1 || maxSpendCents > 1000) {
    throw new Error('Approved pilot ceiling must not exceed $10.');
  }
  const original = await fs.readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(original);
  const preflight = pilotPreflight(manifest);
  if (manifest.artists.length !== 50 || manifest.proposed_limits.eligible_artists_before_prerequisite_fixes !== 34
    || manifest.proposed_limits.paid_http_requests_total > 205
    || manifest.proposed_limits.serper_requests_total > 68
    || manifest.proposed_limits.scrapecreators_requests_total > 103
    || manifest.proposed_limits.jev_requests_total > 34) throw new Error('Manifest exceeds approved frozen pilot scope.');
  manifest.run_allowed = true;
  manifest.authorization = { approved: true, maxSpendCents, approvedBy: 'user',
    purpose: 'Small verification pilot only; no claims, imports, or full-tier rerun',
    sourceManifestSha256: createHash('sha256').update(original).digest('hex'),
    startedAt: new Date().toISOString() };
  // Fail before creating a run if credentials are absent. Never log their values.
  const keys = Object.fromEntries(['SERPERDEV_API_KEY','SCRAPECREATORS_API_KEY','OPENROUTER_API_KEY']
    .map(name => { if (!process.env[name]) throw new Error(`Required secret is missing: ${name}`); return [name,process.env[name]]; }));
  await fs.mkdir(outputDir, { recursive: false }); // New run only; never restart a paid admission journal.
  const responseDir = join(outputDir, 'responses');
  await fs.mkdir(responseDir);
  await fs.writeFile(join(outputDir, 'approved-manifest.json'), JSON.stringify(manifest,null,2), {flag:'wx'});
  await fs.writeFile(join(outputDir, 'preflight.json'), JSON.stringify(preflight,null,2), {flag:'wx'});
  const resultJournal = await fs.open(join(outputDir, 'results.jsonl'), 'wx');
  let evaluation;
  try {
    const result = await runPilot({ manifest, mode: 'live',
      journalPath: join(outputDir, 'admissions.jsonl'),
      transport: createLiveTransport({keys,responseDir}),
      onResult: async r => {
        await resultJournal.write(`${JSON.stringify(r)}\n`); await resultJournal.sync();
        const artist = manifest.artists.find(a => String(a.profile_id) === r.profileId);
        console.log(JSON.stringify({profileId:r.profileId,artist:artist.artist,status:r.status,
          supportedUrls:r.urls?.length ?? 0,reason:r.reason}));
      },
      evaluateRegressions: async results => {
        // Holdouts are read ONLY here, after blind regression discovery has finished.
        const holdouts = JSON.parse(await fs.readFile(holdoutsPath,'utf8'));
        evaluation = evaluateKnownCases(results,holdouts);
        await fs.writeFile(join(outputDir,'regression-evaluation.json'),JSON.stringify(evaluation,null,2),{flag:'wx'});
        console.log(JSON.stringify({regressionsPassed:evaluation.passed,expandingToRemainingCases:evaluation.passed}));
        return evaluation.passed;
      },
    });
    const summary = { ...result, evaluation, finishedAt:new Date().toISOString(), maxSpendUsd:maxSpendCents/100,
      conservativeReservedSpendUsd:result.budget.reservedSpendCents/100,
      fullTierRerunStarted:false, legacyResultsModified:false, safeForImport:false };
    await fs.writeFile(join(outputDir,'summary.json'),JSON.stringify(summary,null,2),{flag:'wx'});
    console.log(JSON.stringify({finished:true,regressionStagePassed:result.regressionStagePassed,
      paidRequests:result.budget.paid,reservedSpendUsd:summary.conservativeReservedSpendUsd,
      claimsSubmitted:0,databaseWrites:0,outputDir}));
    return summary;
  } finally { await resultJournal.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [manifestPath,holdoutsPath,outputDir,cap] = process.argv.slice(2);
  if (!manifestPath || !holdoutsPath || !outputDir || cap !== '--approved-cap-usd=10' || process.argv.length !== 6) {
    throw new Error('Usage: node instagram-pilot-live.mjs <manifest> <holdouts> <new-output-dir> --approved-cap-usd=10');
  }
  await startApprovedPilot({manifestPath,holdoutsPath,outputDir,maxSpendCents:1000});
}
