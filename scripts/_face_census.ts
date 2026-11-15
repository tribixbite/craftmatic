/**
 * Face census over the favourites (audit 2026-11-15 A-10, FIG-04): per set, every head the source places, the print
 * it names, whether a library prints it, and whether face art draws it (`scripts/face-census.ts`).
 *
 * Usage: bun scripts/_face_census.ts [set…] [--faces=DIR] [--json=OUT] [--missing=OUT.txt]
 *   --faces=DIR    seed face art from DIR first (the art `_playable_ref.ts --faces=` would ship).
 *   --json=OUT     write every head row and per-set summary as JSON.
 *   --missing=OUT  write the named prints with no LDraw print and no art, one per line (gen-face-art.py input).
 * Reads the same first-pick source as the sweep, against the same libraries as a CLI build (Studio's install, then
 * clego's `ldraw_ref/` copy of the mirror). Offline unless a part is missing from both.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { seedFaceArt } from '../web/src/engine/head-face.ts';
import { setLDrawRoot } from '../web/src/engine/ldraw-geometry.ts';
import { createPartGeometryProvider } from '../web/src/engine/ldraw-part-geometry.ts';
import { censusHeads, summariseHeads, type HeadCensusRow, type HeadCensusSummary } from './face-census.ts';
import { FAVOURITES, firstPickSource, readModelsIndex } from './favourite-sets.ts';
import { loadModelBricks, readFaceArtDir } from './model-source.ts';

setLDrawRoot('C:/git/clego/extracted/studio_release/app/ldraw');
if (!process.env.CRAFTMATIC_LDRAW_REF && existsSync('C:/git/clego/ldraw_ref')) process.env.CRAFTMATIC_LDRAW_REF = 'C:/git/clego/ldraw_ref';
process.env.CRAFTMATIC_LDRAW_MIRROR_CACHE ??= 'output/ldraw-mirror-cache';

const argv = process.argv.slice(2);
const opt = (name: string): string | undefined => argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const facesDir = opt('faces');
if (facesDir) console.error(`[faces] seeded ${seedFaceArt(readFaceArtDir(facesDir))} face art from ${facesDir}`);
const targets = argv.filter(a => !a.startsWith('--'));
const index = readModelsIndex();

const out: Record<string, { file: string; summary: HeadCensusSummary; heads: HeadCensusRow[] }> = {};
const missing = new Set<string>();
const pad = (v: string | number, n: number): string => String(v).padStart(n);
console.log(`${'set'.padEnd(7)} ${pad('heads', 5)} ${pad('real', 4)} ${pad('print', 5)} ${pad('art', 4)} ${pad('noArt', 5)} ${pad('anon', 4)}  source`);
for (const set of targets.length ? targets : FAVOURITES) {
  const pick = firstPickSource(index[set]);
  if (!pick || !existsSync(pick.file)) { console.log(`${set.padEnd(7)} no source`); continue; }
  const model = await loadModelBricks(pick.file);
  const heads = await censusHeads(model.bricks, createPartGeometryProvider());
  const summary = summariseHeads(heads);
  for (const p of summary.missingArt) missing.add(p);
  out[set] = { file: pick.model.path, summary, heads };
  console.log(`${set.padEnd(7)} ${pad(summary.heads, 5)} ${pad(summary.real, 4)} ${pad(summary.printed, 5)} ${pad(summary.art, 4)} ${pad(summary.namedDefault, 5)} ${pad(summary.anonymous, 4)}  ${pick.model.path}`);
}
const all = Object.values(out).map(o => o.summary);
const total = (k: keyof Omit<HeadCensusSummary, 'missingArt'>): number => all.reduce((s, x) => s + x[k], 0);
console.log(`${'total'.padEnd(7)} ${pad(total('heads'), 5)} ${pad(total('real'), 4)} ${pad(total('printed'), 5)} ${pad(total('art'), 4)} ${pad(total('namedDefault'), 5)} ${pad(total('anonymous'), 4)}`);
console.log(`named prints with no LDraw print and no art: ${missing.size}`);
const jsonOut = opt('json');
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(out, null, 1));
const missingOut = opt('missing');
if (missingOut) writeFileSync(missingOut, [...missing].sort().join('\n') + '\n');
