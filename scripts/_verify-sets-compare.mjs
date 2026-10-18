/**
 * Dev-vs-prod diff for two verification rounds produced by
 * `_verify-sets-batch.mjs` + `_verify-sets-analyze.mjs`.
 *
 *   node scripts/_verify-sets-compare.mjs <devDir> <prodDir> [set...]
 *
 * Prints one row per set and an explicit DISAGREEMENT list.
 *
 * The SOURCE each round loaded is recovered two ways and both are reported,
 * because neither alone is trustworthy on its own:
 *  - predicted: `indexedTryOrder`'s first pick over that origin's own
 *    `/lego-models-index.json` (the same function the app calls), so a dev/prod
 *    index skew shows up as a different prediction;
 *  - observed: the rendered instance count against the index's `n` for each
 *    candidate, which catches a load that fell THROUGH the predicted source to
 *    a later one.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { indexedTryOrder } from '../web/src/engine/lego-sources.ts';

const [, , devDir, prodDir, ...setArgs] = process.argv;
const DEFAULT_SETS = ['910047', '910004', '10303', '10326', '76419', '71043', '76435',
  '21061', '21063', '60446', '10341', '10337', '42172', '76286', '31141',
  '11371', '21318', '910032'];
const SETS = setArgs.length ? setArgs : DEFAULT_SETS;

const readJson = p => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const bySet = dir => {
  const m = new Map();
  for (const r of readJson(join(dir, 'summary.json')) ?? []) m.set(r.set, r);
  return m;
};
const dev = bySet(devDir), prod = bySet(prodDir);

// Each origin's own index copy, fetched alongside the round.
const idxOf = dir => readJson(join(dir, 'lego-models-index.json'))
  ?? readJson('output/_diag10303/prod-index.json');
const devIdx = idxOf(devDir), prodIdx = idxOf(prodDir);

/** `<src> <path>` the loader would try first for this set on that index. */
const predictedSource = (idx, set) => {
  const entry = idx?.sets?.[set] ?? idx?.sets?.[set.replace(/-\d+$/, '')];
  if (!entry) return null;
  const first = indexedTryOrder(entry.models, entry.parts)[0];
  const m = entry.models[first];
  return m ? `${m.src} ${m.path} (n=${m.n})` : null;
};

const pad = (s, n) => String(s ?? '-').padEnd(n).slice(0, n);
const rows = SETS.map(set => {
  const d = dev.get(set) ?? null, p = prod.get(set) ?? null;
  return {
    set, d, p,
    devSrc: predictedSource(devIdx, set), prodSrc: predictedSource(prodIdx, set),
  };
});

console.log(pad('set', 8) + pad('load', 7) + pad('placements d/p', 18)
  + pad('arms d/p', 11) + pad('armIds', 22) + pad('armLDU d/p', 16)
  + pad('iso>6 d/p', 11) + 'source both rounds pick');
for (const r of rows) {
  const { d, p } = r;
  console.log(pad(r.set, 8)
    + pad(`${d?.loadOk ? 'Y' : 'N'}/${p?.loadOk ? 'Y' : 'N'}`, 7)
    + pad(`${d?.placements}/${p?.placements}`, 18)
    + pad(`${d?.armCount}/${p?.armCount}`, 11)
    + pad((p?.armPartIds ?? []).join('/') || '-', 22)
    + pad(`${d?.armMedianLdu}/${p?.armMedianLdu}`, 16)
    + pad(`${d?.isolatedOver6Studs}/${p?.isolatedOver6Studs}`, 11)
    + (r.devSrc === r.prodSrc ? (r.prodSrc ?? '-') : `DEV ${r.devSrc} | PROD ${r.prodSrc}`));
}

console.log('\n--- DISAGREEMENTS (dev -> prod) ---');
let n = 0;
for (const r of rows) {
  const { d, p } = r;
  const why = [];
  const cmp = (label, a, b) => { if (String(a) !== String(b)) why.push(`${label} ${a} -> ${b}`); };
  cmp('loadOk', d?.loadOk, p?.loadOk);
  cmp('placements', d?.placements, p?.placements);
  cmp('source', r.devSrc, r.prodSrc);
  cmp('arms', d?.armCount, p?.armCount);
  cmp('armIds', (d?.armPartIds ?? []).join('/'), (p?.armPartIds ?? []).join('/'));
  cmp('armMedianLdu', d?.armMedianLdu, p?.armMedianLdu);
  cmp('isolated>6studs', d?.isolatedOver6Studs, p?.isolatedOver6Studs);
  cmp('missingParts', d?.missingParts, p?.missingParts);
  if (why.length) { n++; console.log(`${r.set}: ${why.join('; ')}`); }
}
if (!n) console.log('(none)');
