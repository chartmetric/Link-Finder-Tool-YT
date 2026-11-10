import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {CORRECTION_PURPOSE, sha256, correctionContract, checkCorrectionReadiness,
  launchCorrection, refuseCorrectionInResearch} from './instagram-correction-readiness.mjs';
import {jevRequest} from './instagram-pilot-live-transport.mjs';
import {createPilotBudget} from './instagram-pilot-budget.mjs';
import {startApprovedPilot} from './instagram-pilot-live.mjs';
import {scoreKnownAnswers} from './instagram-known-answer-benchmark.mjs';

const jsonHash = x => sha256(JSON.stringify(x));
const now = Date.parse('2026-11-09T12:00:00Z');
const at = seconds => new Date(now + seconds * 1000).toISOString();

// Synthetic approvals and budgets below belong ONLY to offline unit fixtures.
// They are not policies/approvals for actual artists, results or paid calls.
async function fixture(t, clock = now) {
  const at = seconds => new Date(clock + seconds * 1000).toISOString();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'correction-readiness-'));
  t.after(() => fs.rm(dir, {recursive:true, force:true}));
  const scope = {purpose:CORRECTION_PURPOSE, profileType:'musician', platform:'instagram', tiers:[1,2,3,4,5]};
  const contract = {...await correctionContract(), resolvedModel:'fixture-resolved-model'};
  const state = {
    suite:{preparationOnly:false, purpose:CORRECTION_PURPOSE,
      labelReview:{approved:true, reference:'fixture independent review'}, cases:[]},
    policy:{version:1, scope, approval:{approved:true, approvedBy:'user', reference:'fixture approval',
      approvedAt:at(-100), expiresAt:at(100)}, maxResultAgeMs:60000, maxEvidenceAgeMs:120000,
      contract},
    results:{status:'completed', fixtureOnly:false, contract:structuredClone(contract),
      startedAt:at(-40), completedAt:at(-10), acceptanceRulesSha256:jsonHash(contract.acceptanceRules), cases:[]},
    launch:{version:1, scope, automaticRetries:0, ingestion:'account_links/claims.record/resolve-only',
      paidApproval:{approved:true, approvedBy:'user', reference:'fixture paid approval',
        approvedAt:at(-5), expiresAt:at(100), maxSpendCents:4, priorReservedCents:329}},
    inputs:[], packets:[], journals:[],
  };
  const ref = url => ({platform:'spotify', url});
  const catalog = 'https://open.spotify.com/artist/AAAAAAAAAAAAAAAAAAAAAA';
  for (const [i, positive] of [true, false].entries()) {
    const id = String(i + 1), url = `https://www.instagram.com/fixture${id}/`;
    const player = {profile_id:id, cm_artist:id, artist:`Fixture Artist ${id}`,
      account_ids:[id], accounts:[{account_id:id, platform:'spotify', account_url:catalog}]};
    const profile = {url, identityComparison:{status:'likely', reference:ref(catalog),
      candidate:{platform:'instagram', url, displayName:player.artist, externalUrls:[catalog]}}};
    const input = {player, payload:{artist:player.artist, catalogReference:ref(catalog), profiles:[profile]},
      discovery:{methodsUsed:[{method:'serper', status:'used'}], profiles:[{url}], knownAnswerUsedAsInput:false}};
    const body = jevRequest(input.payload);
    state.inputs.push(input);
    state.suite.cases.push({id, profileId:id, url, expectedArtistOwned:positive,
      requiredModelAccepted:positive, requiredApplicationAccepted:positive,
      labelProvenance:'fixture independent ownership adjudication'});
    state.packets.push({status:200, at:at(-20), requestBodySha256:jsonHash(body), decisionRequest:body,
      data:{model:contract.resolvedModel, answers:{candidate_0_same_identity:{noul:positive ? 0.97 : 0.1},
        candidate_0_verdict:{choice:positive ? 'verified' : 'mismatch'}}}});
    state.journals.push([{phase:'admitted', key:id, profileId:id, kind:'jev'}, {phase:'returned', key:id}]);
    state.results.cases.push({id, status:'completed', stage:'blind_discovery_and_verification',
      admissionKey:id, inputSha256:jsonHash(input), evidenceSha256:jsonHash(input.payload), requestSha256:jsonHash(body)});
  }
  async function write(file, value, raw = false) {
    const text = raw ? value : JSON.stringify(value);
    await fs.writeFile(path.join(dir, file), text);
    return {file, sha256:sha256(text)};
  }
  async function persist() {
    const source = await write('source.txt', 'synthetic evidence', true);
    for (let i = 0; i < state.inputs.length; i++) {
      const c = state.suite.cases[i], r = state.results.cases[i];
      c.input = await write(`input-${i}.json`, state.inputs[i]);
      c.sources = [{...source, observedAt:at(-50)}];
      if (r) {
        r.response = await write(`response-${i}.json`, state.packets[i]);
        r.journal = await write(`journal-${i}.json`, state.journals[i]);
      }
    }
    state.policy.suite = await write('suite.json', state.suite);
    state.launch.policy = await write('policy.json', state.policy);
    state.results.policySha256 = state.launch.policy.sha256;
    state.results.suiteSha256 = state.policy.suite.sha256;
    state.launch.results = await write('results.json', state.results);
    state.launch.paidApproval.policySha256 = state.launch.policy.sha256;
    state.launch.paidApproval.resultsSha256 = state.launch.results.sha256;
    await write('launch.json', state.launch);
    return path.join(dir, 'launch.json');
  }
  const launchFile = await persist();
  return {state, dir, launchFile, persist};
}

test('complete exact bindings yield a receipt, not permission to execute or import', async t => {
  const {launchFile} = await fixture(t, Date.now());
  const receipt = await checkCorrectionReadiness(launchFile);
  assert.equal(receipt.ready, true);
  assert.deepEqual(receipt.rows.map(r => r.applicationAccepted), [true,false]);
  assert.equal(receipt.paidRequestsStarted, 0);
  assert.equal(receipt.claimsSubmitted, 0);
  await assert.rejects(launchCorrection(launchFile), /execution remains disabled/);
});

test('missing policy, drafts, prepared/unadjudicated sets and offline scorecards fail closed', async t => {
  for (const [label, mutate] of [
    ['unapproved', s => {s.policy.approval.approved = false;}],
    ['missing approval', s => {delete s.policy.approval;}],
    ['preparation', s => {s.suite.preparationOnly = true;}],
    ['unreviewed labels', s => {s.suite.labelReview.approved = false;}],
    ['unknown label', s => {s.suite.cases[0].expectedArtistOwned = null;}],
    ['no negatives', s => {s.suite.cases.forEach(c => {c.expectedArtistOwned = true;});}],
    ['no positives', s => {s.suite.cases.forEach(c => {c.expectedArtistOwned = false;});}],
    ['pending scorecard', s => {s.results.status = 'not_tested';}],
    ['fixture result', s => {s.results.fixtureOnly = true;}],
    ['missing result', s => {s.results.cases.pop();}],
    ['duplicate result', s => {s.results.cases[1] = structuredClone(s.results.cases[0]);}],
    ['failed case', s => {s.results.cases[0].status = 'failed';}],
    ['verifier only', s => {s.results.cases[0].stage = 'verification_only';}],
  ]) {
    await t.test(label, async t => {
      const f = await fixture(t); mutate(f.state); await f.persist();
      await assert.rejects(checkCorrectionReadiness(f.launchFile, {now}));
    });
  }
  const f = await fixture(t);
  await fs.unlink(path.join(f.dir, 'policy.json'));
  await assert.rejects(checkCorrectionReadiness(f.launchFile, {now}), /ENOENT/);
  const s = scoreKnownAnswers({requests:[]});
  assert.equal(s.correctionRerunReady, false);
});

test('any model/schema/evidence/rule drift, stale result or unknown time blocks readiness', async t => {
  for (const [label, mutate] of [
    ['model alias', s => {s.policy.contract.requestedModel = 'different';}],
    ['schema', s => {s.policy.contract.requestSchemaSha256 = '0'.repeat(64);}],
    ['implementation', s => {s.policy.contract.implementation['public-music-links.mjs'] = '0'.repeat(64);}],
    ['threshold', s => {s.policy.contract.acceptanceRules.minimumIdentityProbability = 0.7;}],
    ['rules hash', s => {s.results.acceptanceRulesSha256 = '0'.repeat(64);}],
    ['resolved model', s => {s.packets[0].data.model = 'changed';}],
    ['input binding', s => {s.results.cases[0].inputSha256 = '0'.repeat(64);}],
    ['request binding', s => {s.results.cases[0].requestSha256 = '0'.repeat(64);}],
    ['evidence binding', s => {s.results.cases[0].evidenceSha256 = '0'.repeat(64);}],
    ['request substitution', s => {s.packets[0].decisionRequest.questions = {};}],
    ['stale result', s => {s.policy.maxResultAgeMs = 1;}],
    ['stale evidence', s => {s.policy.maxEvidenceAgeMs = 1;}],
    ['missing freshness policy', s => {delete s.policy.maxEvidenceAgeMs;}],
    ['expired approval', s => {s.policy.approval.expiresAt = at(-1);}],
    ['unapproved test', s => {s.results.startedAt = at(-200);}],
    ['future result', s => {s.results.completedAt = at(1);}],
    ['unknown response time', s => {delete s.packets[0].at;}],
    ['uncertain admission', s => {s.journals[0].pop();}],
    ['failed admission', s => {s.journals[0][1].phase = 'failed_no_retry';}],
    ['replayed admission', s => {s.journals[0].push(s.journals[0][0]);}],
  ]) {
    await t.test(label, async t => {
      const f = await fixture(t); mutate(f.state); await f.persist();
      await assert.rejects(checkCorrectionReadiness(f.launchFile, {now}));
    });
  }
  const f = await fixture(t);
  await fs.appendFile(path.join(f.dir, 'source.txt'), 'changed');
  await assert.rejects(checkCorrectionReadiness(f.launchFile, {now}), /Changed benchmark artifact/);
});

test('reject-all, wrong acceptance, invalid decisions and missing blind recovery cannot pass', async t => {
  for (const [label, mutate] of [
    ['reject all', s => {s.packets[0].data.answers.candidate_0_verdict.choice = 'mismatch';}],
    ['wrong acceptance', s => {s.packets[1].data.answers = structuredClone(s.packets[0].data.answers);}],
    ['low positive score', s => {s.packets[0].data.answers.candidate_0_same_identity.noul = 0.89;}],
    ['invalid score', s => {s.packets[0].data.answers.candidate_0_same_identity.noul = 1.1;}],
    ['missing score', s => {delete s.packets[0].data.answers.candidate_0_same_identity;}],
    ['provider failed', s => {s.packets[0].status = 503;}],
    ['blind miss', s => {s.inputs[0].discovery.profiles = [];}],
    ['answer leakage', s => {s.inputs[0].discovery.knownAnswerUsedAsInput = true;}],
  ]) {
    await t.test(label, async t => {
      const f = await fixture(t); mutate(f.state);
      // Bind altered evidence afresh to test the actual discovery checks.
      f.state.results.cases[0].inputSha256 = jsonHash(f.state.inputs[0]);
      await f.persist();
      await assert.rejects(checkCorrectionReadiness(f.launchFile, {now}));
    });
  }
  const f = await fixture(t);
  // A high model score cannot bypass the independent evidence gate, even when
  // the new input, response and policy hashes are internally consistent.
  f.state.inputs[0].payload.profiles[0].identityComparison.candidate.externalUrls = [];
  const input = f.state.inputs[0], r = f.state.results.cases[0], body = jevRequest(input.payload);
  r.inputSha256 = jsonHash(input); r.evidenceSha256 = jsonHash(input.payload); r.requestSha256 = jsonHash(body);
  f.state.packets[0].decisionRequest = body; f.state.packets[0].requestBodySha256 = r.requestSha256;
  await f.persist();
  await assert.rejects(checkCorrectionReadiness(f.launchFile, {now}), /evidence\/acceptance check failed/);
});

test('paid approval, conservative aggregate budget, no-retry and claims-only safeguards remain separate', async t => {
  for (const mutate of [
    s => {s.launch.paidApproval.approved = false;},
    s => {s.launch.paidApproval.maxSpendCents = 1001;},
    s => {s.launch.paidApproval.priorReservedCents = 999;},
    s => {s.launch.paidApproval.expiresAt = at(-1);},
    s => {s.launch.paidApproval.approvedAt = at(-11);},
    s => {s.launch.automaticRetries = 1;},
    s => {s.launch.ingestion = 'direct-live-table-write';},
  ]) {
    const f = await fixture(t); mutate(f.state); await f.persist();
    await assert.rejects(checkCorrectionReadiness(f.launchFile, {now}));
  }
});

test('actual launch dispatcher blocks correction spending and cannot repurpose pilots', async t => {
  const f = await fixture(t, Date.now());
  let calls = 0;
  await assert.rejects(createPilotBudget({manifest:{purpose:CORRECTION_PURPOSE},
    journalPath:path.join(f.dir, 'never-created'), mode:'live',
    transport:{live:true, dispatch:async () => {calls++;}}}), /guarded run-correction/);
  const manifestPath = path.join(f.dir, 'pilot.json');
  await fs.writeFile(manifestPath, JSON.stringify({purpose:CORRECTION_PURPOSE}));
  await assert.rejects(startApprovedPilot({manifestPath, maxSpendCents:4}), /guarded run-correction/);
  assert.equal(calls, 0);
  await assert.rejects(fs.stat(path.join(f.dir, 'never-created')), /ENOENT/);
  for (const manifest of [{}, {purpose:'ordinary_research'}, {purpose:'brands'}, {purpose:'cricket'}]) {
    assert.doesNotThrow(() => refuseCorrectionInResearch(manifest));
  }
  const cli = fileURLToPath(new URL('./musician-instagram-research.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [cli, 'run-correction', f.launchFile],
    {encoding:'utf8', env:{PATH:process.env.PATH}});
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /execution remains disabled/);
  const bypass = spawnSync(process.execPath, [cli, 'run', '--attribution-correction'],
    {encoding:'utf8', env:{PATH:process.env.PATH}});
  assert.notEqual(bypass.status, 0);
  assert.match(bypass.stderr, /Use run-correction/);
});
