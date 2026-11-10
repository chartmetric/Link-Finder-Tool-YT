// Local files only; no credentials, network, provider, claims or DB imports.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildSourcePolicyImpact, digest, renderSourcePolicyImpact, WARNING} from './instagram-source-policy-impact.mjs';

const workspace = fileURLToPath(new URL('../../', import.meta.url));
const flags = ['input', 'output', 'evaluation-time', 'minimum-source-identity-score',
  'max-evidence-age-ms', 'max-verifier-age-ms'];
export function parseImpactArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i]?.replace(/^--/, '');
    if (!argv[i]?.startsWith('--') || !flags.includes(name) || name in args
      || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('Unknown, duplicate or missing argument. Required: ' + flags.map(f => `--${f}`).join(' '));
    args[name] = argv[i + 1];
  }
  if (flags.some(f => !(f in args))) throw new Error('All settings and paths must be explicit; no defaults.');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(args.output)) throw new Error('--output must be a new directory name, not a path.');
  for (const key of ['minimum-source-identity-score', 'max-evidence-age-ms', 'max-verifier-age-ms']) {
    if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(args[key])) throw new Error(`Invalid numeric --${key}.`);
  }
  return args;
}

async function ensureRealDirectory(directory) {
  try { await fs.mkdir(directory); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = await fs.lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Output ancestors must be real directories, never symlinks.');
}

export async function runSourcePolicyImpact(argv) {
  const args = parseImpactArgs(argv);
  const inputFile = path.resolve(args.input);
  const inputBytes = await fs.readFile(inputFile);
  const report = buildSourcePolicyImpact(JSON.parse(inputBytes.toString('utf8')), {
    evaluationTime: args['evaluation-time'],
    config: {mode: 'offline', minimumSourceIdentityScore: Number(args['minimum-source-identity-score']),
      maxEvidenceAgeMs: Number(args['max-evidence-age-ms']),
      maxVerifierAgeMs: Number(args['max-verifier-age-ms'])},
  });
  report.inputFileSha256 = digest(inputBytes);
  // The only writable location is the repository's already ignored output root.
  for (const ignore of ['.gitignore', '.replitignore']) {
    const text = await fs.readFile(path.join(workspace, ignore), 'utf8');
    if (!text.split(/\r?\n/).includes('/generated-artifacts/')) throw new Error(`${ignore} must ignore /generated-artifacts/ before writing.`);
  }
  const root = path.join(workspace, 'generated-artifacts');
  await ensureRealDirectory(root);
  const parent = path.join(root, 'instagram-source-policy-impact');
  await ensureRealDirectory(parent);
  const output = path.join(parent, args.output);
  // Atomic exclusive directory creation. Existing runs, even partial ones, fail.
  await fs.mkdir(output);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', {flag: 'wx'});
  await fs.writeFile(path.join(output, 'report.md'), renderSourcePolicyImpact(report), {flag: 'wx'});
  return {output, counts: report.counts, warning: WARNING};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runSourcePolicyImpact(process.argv.slice(2)).then(out => console.log(JSON.stringify(out, null, 2)))
    .catch(error => { console.error(`Offline impact report stopped: ${error.message}`); process.exitCode = 1; });
}
