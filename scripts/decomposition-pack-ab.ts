#!/usr/bin/env bun
/**
 * Per-PACK A/B of the cuboid decomposition strategy.
 *
 * `scripts/part-decomposition-compare.ts` measured the per-PART saving of
 * `best-of` against the shipped `greedy` merge (-7.4 % over 399 random parts).
 * That is not the number that decides whether to ship it: the compiler runs
 * `mergeAlignedCuboids` over the WHOLE model afterwards, which absorbs
 * same-colour face-adjacent boxes across part boundaries, and a decomposition
 * that wins per part can hand that pass a worse arrangement. This compiles real
 * sets both ways and reports the count that actually reaches the device.
 *
 *   bun scripts/decomposition-pack-ab.ts [quality] [file...]
 *
 * Defaults to `balanced` and the three golden models the export tests use.
 */
import { readFileSync, existsSync } from 'node:fs';
import { parseLDrawDocument, embeddedPartTexts } from '../web/src/engine/ldraw-parser.js';
import { seedDatTexts, setLDrawRoot } from '../web/src/engine/ldraw-geometry.js';
import { compileLdrawEntityGeometry } from '../web/src/engine/ldraw-entity-compiler.js';
import type { LegoEntityQualityName } from '../web/src/engine/ldraw-part-prototype.js';

const LDRAW_ROOT = 'C:/git/clego/extracted/studio_release/app/ldraw';
const DEFAULT_FILES = [
  'C:/git/clego/lego_sets/OMR/75892-1.mpd',
  'C:/git/clego/lego_sets/OMR/7140-1.mpd',
  'C:/git/clego/lego_sets/IOModel2V2/10300-1-present.ldr',
];

const [qualityArg, ...fileArgs] = process.argv.slice(2);
const quality = (qualityArg ?? 'balanced') as LegoEntityQualityName;
const files = fileArgs.length ? fileArgs : DEFAULT_FILES;

setLDrawRoot(LDRAW_ROOT);

let totalGreedy = 0, totalBest = 0;
for (const file of files) {
  if (!existsSync(file)) { console.error(`missing: ${file}`); continue; }
  const doc = parseLDrawDocument(readFileSync(file, 'utf8'));
  seedDatTexts(embeddedPartTexts(doc));
  const cid = file.split('/').pop()!.replace(/\W+/g, '_').toLowerCase();
  const counts: Record<string, number> = {};
  for (const decomposition of ['greedy', 'best-of'] as const) {
    const g = await compileLdrawEntityGeometry(cid, 'car', doc.bricks, { quality, decomposition });
    counts[decomposition] = g.diagnostics.cubeCount;
    counts[`${decomposition}:meshes`] = g.meshes.length;
  }
  totalGreedy += counts['greedy']!;
  totalBest += counts['best-of']!;
  const d = counts['best-of']! - counts['greedy']!;
  console.log(
    `${file.split('/').pop()!.padEnd(28)} ${quality.padEnd(9)} `
    + `greedy ${String(counts['greedy']).padStart(7)}  best-of ${String(counts['best-of']).padStart(7)}  `
    + `${d >= 0 ? '+' : ''}${(d / counts['greedy']! * 100).toFixed(1)} %  `
    + `meshes ${counts['greedy:meshes']} -> ${counts['best-of:meshes']}`);
}
if (files.length > 1) {
  console.log(`${'TOTAL'.padEnd(28)} ${quality.padEnd(9)} `
    + `greedy ${String(totalGreedy).padStart(7)}  best-of ${String(totalBest).padStart(7)}  `
    + `${((totalBest - totalGreedy) / totalGreedy * 100).toFixed(1)} %`);
}
