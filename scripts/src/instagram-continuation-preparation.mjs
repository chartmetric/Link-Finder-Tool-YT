import {writeFileSync, renameSync} from 'node:fs';
import path from 'node:path';
import {hostname} from 'node:os';

// Local preparation evidence only. Never a worker heartbeat or replay permission.
export async function trackPreparation(phase, prepare) {
  const file = path.join(phase, 'preparation-status.json');
  const startedAt = new Date().toISOString();
  let terminal = false;
  const record = (status, reason = null) => {
    const value = {version: 1, phase: path.basename(phase), startedAt,
      at: new Date().toISOString(), status, reason, pid: process.pid, hostname: hostname()};
    writeFileSync(file + '.tmp', JSON.stringify(value), {mode: 0o600});
    renameSync(file + '.tmp', file);
    terminal = ['failed', 'interrupted', 'handed_off'].includes(status);
  };
  const onExit = () => {
    if (!terminal) record('interrupted', 'preparer_exited_before_handoff');
  };
  const onInt = () => {record('interrupted', 'SIGINT'); process.exit(130);};
  const onTerm = () => {record('interrupted', 'SIGTERM'); process.exit(143);};
  record('preparing');
  process.once('exit', onExit);
  process.once('SIGINT', onInt);
  process.once('SIGTERM', onTerm);
  try {
    await prepare(record);
    record('handed_off');
  } catch (error) {
    // Do not persist arbitrary exception messages: they can contain credentials.
    record('failed', 'preparation_or_launch_failed');
    throw error;
  } finally {
    process.removeListener('exit', onExit);
    process.removeListener('SIGINT', onInt);
    process.removeListener('SIGTERM', onTerm);
  }
}
