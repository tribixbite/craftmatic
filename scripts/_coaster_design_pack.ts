/**
 * Build the add-on of a coaster design (WP-C02): `bun scripts/_coaster_design_pack.ts <design.json> <out-dir> [--car=<own-car.ldr>] [--stem=<stem>]`.
 * Writes `<out-dir>/<stem>.mcaddon` (a NEW directory per run: the script never deletes) and prints the pack's coaster facts.
 * Commit before building a pack you mean to keep: the pack's name carries the pipeline stamp.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setLDrawRoot } from '../web/src/engine/ldraw-geometry.ts';
import { buildGeneratedCoasterPack } from '../web/src/engine/coaster-design-pack.ts';
import type { CoasterDesign } from '../web/src/engine/coaster-design.ts';
import { computePipelineStamp } from './pipeline-stamp.ts';

const args = process.argv.slice(2);
const flag = (n: string): string | undefined => args.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const [designPath, outDir] = args.filter(a => !a.startsWith('--'));
if (!designPath || !outDir) { console.error('usage: bun scripts/_coaster_design_pack.ts <design.json> <out-dir> [--car=<ldr>] [--stem=<stem>]'); process.exit(2); }
if (!process.env.CRAFTMATIC_LDRAW_REF && existsSync('C:/git/clego/ldraw_ref')) process.env.CRAFTMATIC_LDRAW_REF = 'C:/git/clego/ldraw_ref';
setLDrawRoot('C:/git/clego/extracted/studio_release/app/ldraw');
const design = JSON.parse(readFileSync(designPath, 'utf8')) as CoasterDesign;
const carText = readFileSync(flag('car') ?? 'test/fixtures/coaster/own-car.ldr', 'utf8');
const t0 = performance.now();
const built = await buildGeneratedCoasterPack(design, carText, { ...(flag('stem') ? { stem: flag('stem')! } : {}), addon: { pipelineStamp: computePipelineStamp() } });
mkdirSync(outDir, { recursive: true });
const file = join(outDir, `${built.stem}.mcaddon`);
writeFileSync(file, built.result.bytes);
const r = built.gen.report;
console.log(`${file}: ${(built.result.bytes.length / 1e6).toFixed(2)} MB in ${Math.round(performance.now() - t0)} ms`);
console.log(`route ${r.lengthB.toFixed(1)} blocks, height ${r.heightB.toFixed(1)}, ${r.inversions} inversions, ${built.route.vehicles?.length} cars x ${built.route.trains} trains`);
for (const w of built.result.warnings) console.log(`  warning: ${w.slice(0, 300)}`);
