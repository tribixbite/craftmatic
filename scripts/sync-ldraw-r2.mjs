#!/usr/bin/env node
/**
 * Mirror the LDraw parts library into the `lego-models` R2 bucket so the
 * prod worker serves geometry SELF-HOSTED (R2-first) instead of live-proxying
 * library.ldraw.org, which rate-limits cold big-set bursts (prod incident
 * 2026-08-17: thousands of real parts reported "missing").
 *
 * Keys: ldraw/<relpath-under-library-root>, LOWERCASED (R2 keys are
 * case-sensitive; the client's normId() lowercases every request).
 *   ldraw/parts/3001.dat · ldraw/p/stud.dat · ldraw/unofficial/parts/x.dat
 *
 * Priority-tiered (primitives → official parts → subparts → unofficial) so
 * the highest-leverage files land first. RESUMABLE via _ldraw_r2_done.txt.
 *
 * Run: node scripts/sync-ldraw-r2.mjs [--workers 6] [--status]
 */
import { readdirSync, readFileSync, writeFileSync, appendFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';

const LIB = 'C:/git/clego/extracted/studio_release/app/ldraw';
const BUCKET = 'lego-models';
const DONE_FILE = 'C:/git/craftmatic/output/_ldraw_r2_done.txt';
const TIERS = [
  ['p', 'p/48', 'p/8'],
  ['parts'],
  ['parts/s', 'parts/textures'],
  ['UnOfficial/p', 'UnOfficial/p/48'],
  ['UnOfficial/parts', 'UnOfficial/parts/s'],
];

const args = process.argv.slice(2);
const WORKERS = parseInt(args[args.indexOf('--workers') + 1] || '6', 10) || 6;

const done = new Set(existsSync(DONE_FILE) ? readFileSync(DONE_FILE, 'utf8').split('\n').filter(Boolean) : []);

const queue = [];
for (const tier of TIERS) {
  for (const dir of tier) {
    const abs = join(LIB, dir);
    let names;
    try { names = readdirSync(abs); } catch { continue; }
    for (const f of names) {
      if (!f.toLowerCase().endsWith('.dat') && !f.toLowerCase().endsWith('.png')) continue;
      const rel = `${dir}/${f}`;
      const key = ('ldraw/' + rel).toLowerCase().replace(/\\/g, '/');
      if (done.has(key)) continue;
      try { if (!statSync(join(LIB, rel)).isFile()) continue; } catch { continue; }
      queue.push({ key, abs: join(LIB, rel) });
    }
  }
}

console.log(`${queue.length} files to upload (${done.size} already done), ${WORKERS} workers`);
if (args.includes('--status')) process.exit(0);

let ok = 0, fail = 0, inFlight = 0, i = 0;
const t0 = Date.now();

function put(item) {
  return new Promise(resolve => {
    execFile('bunx.exe', ['wrangler', 'r2', 'object', 'put', `${BUCKET}/${item.key}`,
      '--file', item.abs, '--content-type', 'text/plain', '--remote'],
      { timeout: 120000, windowsHide: true },
      (err) => resolve(!err));
  });
}

async function worker() {
  while (i < queue.length) {
    const item = queue[i++];
    const success = await put(item);
    if (success) { ok++; appendFileSync(DONE_FILE, item.key + '\n'); }
    else { fail++; }
    const n = ok + fail;
    if (n % 100 === 0) {
      const rate = n / ((Date.now() - t0) / 60000);
      console.log(`${n}/${queue.length} ok=${ok} fail=${fail} (${rate.toFixed(0)}/min, ETA ${((queue.length - n) / rate).toFixed(0)} min)`);
    }
  }
}

await Promise.all(Array.from({ length: WORKERS }, worker));
console.log(`DONE: ok=${ok} fail=${fail} of ${queue.length} in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
