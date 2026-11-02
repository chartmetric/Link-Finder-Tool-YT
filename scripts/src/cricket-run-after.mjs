import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

// An explicitly authorized follow-on run, not a retry/resume daemon. Never
// advance after an interrupted predecessor or replay a paid outcome.
const [predecessor, next] = process.argv.slice(2);
if (![predecessor, next].every(id => /^[0-9a-f-]{36}$/i.test(id ?? '')) || predecessor === next) {
  throw new Error('Supply distinct predecessor and next run UUIDs.');
}
const lockPath = `generated-artifacts/cricket-1000/${predecessor}.lock`;
const gatePath = `generated-artifacts/cricket-1000/${next}.waiting.lock`;
const gate = await fs.open(gatePath, 'wx');
function command(args, capture = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/src/cricket-instagram.mjs', ...args], {
      stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    });
    let output = '';
    if (capture) child.stdout.on('data', data => { output += data; });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve(output) : reject(new Error(`Runner exited ${code}`)));
  });
}
try {
  console.log(JSON.stringify({ waitingFor: predecessor, nextRun: next, automaticPaidRetries: false }));
  const deadline = Date.now() + 6 * 60 * 60 * 1000;
  while (true) {
    try { await fs.access(lockPath); }
    catch (error) { if (error.code === 'ENOENT') break; throw error; }
    if (Date.now() > deadline) throw new Error('Predecessor still active after six hours; follow-on not started.');
    await delay(30000);
  }
  const status = JSON.parse(await command(['status', predecessor], true));
  if (status.counts.running || status.counts.queued) {
    throw new Error('Predecessor has unfinished or uncertain work; follow-on not started.');
  }
  const nextStatus = JSON.parse(await command(['status', next], true));
  if (Object.keys(nextStatus.counts).some(state => state !== 'queued') || !nextStatus.counts.queued) {
    throw new Error('Follow-on is not an untouched queued selection; review before launching.');
  }
  await command(['run', next]);
} finally {
  await gate.close();
  await fs.unlink(gatePath);
}
