/**
 * Sequential driver for a visual-defect verification round over a set list.
 * Runs scripts/_lego-probe.mjs once per set (one chromium at a time), records
 * stdout/stderr per set, and writes a machine-readable run log.
 *
 * node scripts/_verify-sets-batch.mjs <outDir> [set...]
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_SETS = ['910047', '910004', '10303', '10326', '76419', '71043', '76435',
  '21061', '21063', '60446', '10341', '10337', '42172', '76286', '31141',
  '11371', '21318', '910032'];
// Set list and output root are CLI arguments so this harness outlives its
// round: `node scripts/_verify-sets-batch.mjs <outDir> <set> [set...]`.
const [, , rootArg, ...setArgs] = process.argv;
const ROOT = rootArg ?? 'output/verify-sets';
const SETS = setArgs.length > 0 ? setArgs : DEFAULT_SETS;
mkdirSync(ROOT, { recursive: true });
const KILL_MS = Number(process.env.VERIFY_SET_TIMEOUT_MS ?? 900_000);
const LOG = join(ROOT, 'run.log');
writeFileSync(LOG, `batch start ${new Date().toISOString()}\n`);

/** Run the probe for one set; resolves with {code, stdout, stderr, ms}. */
const runOne = set => new Promise(resolve => {
  const outDir = join(ROOT, set);
  mkdirSync(outDir, { recursive: true });
  const t0 = Date.now();
  const child = spawn(process.execPath,
    ['scripts/_lego-probe.mjs', set, outDir, set],
    { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', d => { stdout += d; });
  child.stderr.on('data', d => { stderr += d; });
  // Hard ceiling: the probe's own model wait is 240s, and the three fixed-camera
  // captures of a large model take minutes on top of it. 420s killed 71043
  // (5,967 placements) mid-capture against production, where every part file is
  // a CDN fetch rather than a local read. Override with VERIFY_SET_TIMEOUT_MS.
  const kill = setTimeout(() => child.kill('SIGKILL'), KILL_MS);
  child.on('close', code => {
    clearTimeout(kill);
    resolve({ set, code, stdout, stderr, ms: Date.now() - t0 });
  });
});

const results = [];
for (const set of SETS) {
  const r = await runOne(set);
  results.push({ set: r.set, code: r.code, ms: r.ms, stderr: r.stderr.slice(0, 2000) });
  appendFileSync(LOG, `[${new Date().toISOString()}] ${set} exit=${r.code} ${Math.round(r.ms / 1000)}s\n`);
  writeFileSync(join(ROOT, set, 'stdout.json'), r.stdout);
  if (r.stderr) writeFileSync(join(ROOT, set, 'stderr.txt'), r.stderr);
  writeFileSync(join(ROOT, 'run-results.json'), JSON.stringify(results, null, 1));
}
appendFileSync(LOG, `batch done ${new Date().toISOString()}\n`);
console.log('DONE');
