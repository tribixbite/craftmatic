/**
 * LSCALE (BIZ-05 / BIZ-10 / BIZ-11): build a landmark at every detail level, verify each, render each, and write what the
 * Brick Wand needs to suggest a size.
 *
 *   bun scripts/_landmark_levels.ts <slug> [--levels=1,2,4] [--views=se,w] [--maxpx=1200] [--costs=<costs.json>]
 *                                   [--export] [--out=output/lscale/<slug>]
 *
 * For each level, `_grammar_render.ts --level=N` (the same pipeline the L00 runs use, at EXACTLY N studs per metre:
 * no silent brick or size clamp) writes the renders, the model (`<slug>-l<N>.ldr`) and the verify report. This script
 * reads them back, fails (exit 1) if any level is not one component with nothing unsupported, and writes
 *   `<out>/levels.json`      per level: parts, dims, verify report, cuboid estimate, seconds, shipped cuboids (when known);
 *   `<out>/detail-l<N>.json` the `PlacementDetail` for the pack of level N (`_playable_ref.ts --detail=`).
 * The shipped (resident) cuboids per level come from `--costs` (`{"1": {"residentCuboids": 15001, "uncompressedBytes": 9817167}}`, read off built packs by
 * `scripts/_marketplace_budget.ts --static-only`; each value `{residentCuboids, uncompressedBytes}`) or, with `--export`, from building each pack here. A level with no
 * measured cost is not offered by the suggestion: an estimate is not a measurement (the pre-merge estimate read 78k
 * for a pack that ships 15k).
 *
 * Inputs: the landmark's OSM JSON and `site.json` in `$CRAFTMATIC_DESIGNS/landmarks/<slug>/` (the private designs repo).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DETAIL_LEVELS, type DetailLevel, type PlacementDetail } from '../web/src/brickgen/levels/levels.js';
import { suggestSize, type LevelCost } from '../web/src/brickgen/levels/suggest.js';
import { BUDGET_TIERS } from '../web/src/engine/marketplace/budget.js';
import { PAD_STUDS } from '../web/src/brickgen/grammar/index.js';
import { LANDMARKS } from './_landmark_table.js';

const root = path.resolve(import.meta.dirname, '..');
const DESIGNS = process.env['CRAFTMATIC_DESIGNS'] ?? 'C:/git/craftmatic-designs';
const args = process.argv.slice(2);
const flag = (name: string, dflt: string): string => args.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? dflt;
const slug = args.find(a => !a.startsWith('--'));
const landmark = LANDMARKS.find(l => l.slug === slug);
if (!slug || !landmark) { console.error(`usage: _landmark_levels.ts <${LANDMARKS.map(l => l.slug).join('|')}> [flags: see the file header]`); process.exit(2); }

const dir = path.join(DESIGNS, 'landmarks', slug);
const fixture = path.join(dir, `${slug}.overpass.json`);
const out = flag('out', path.join('output', 'lscale', slug));
mkdirSync(path.join(root, out), { recursive: true });
const levels: DetailLevel[] = flag('levels', DETAIL_LEVELS.map(l => l.studsPerMetre).join(',')).split(',').map(n => {
  const l = DETAIL_LEVELS.find(k => k.studsPerMetre === Number(n));
  if (!l) throw new Error(`no detail level of ${n} studs per metre`);
  return l;
});
// The outline element decides whether the parts are used: an outline as tall as its parts hides them in massing.
const buildingArg = slug === 'cologne-cathedral' ? '--building=parts' : `--building=${landmark.osm[0]}`;

interface LevelRun {
  level: number; dims: [number, number, number]; parts: number; components: number; unsupported: number;
  overlaps: number; cuboidsEstimate: number; seconds: number; verified: boolean; notes: string[];
  /** Resident cuboids and uncompressed bytes of the built pack, when measured. */
  residentCuboids?: number;
  uncompressedBytes?: number;
}

const costsFile = flag('costs', '');
const measured: Record<string, { residentCuboids: number; uncompressedBytes: number }> = costsFile ? JSON.parse(readFileSync(costsFile, 'utf8')) as Record<string, { residentCuboids: number; uncompressedBytes: number }> : {};
const runs: LevelRun[] = [];
for (const level of levels) {
  const base = path.join(out, `l${level.studsPerMetre}`);
  const ldr = path.join(out, `${slug}-l${level.studsPerMetre}.ldr`);
  const t0 = Date.now();
  const r = spawnSync('bun', ['scripts/_grammar_render.ts', slug, base, `--fixture=${fixture}`, buildingArg, `--level=${level.studsPerMetre}`,
    `--views=${flag('views', 'se,w')}`, `--maxpx=${flag('maxpx', '1200')}`, `--ldr=${ldr}`], { cwd: root, encoding: 'utf8', timeout: 90 * 60_000, maxBuffer: 1 << 28 });
  if (r.status !== 0) { console.error(`level ${level.studsPerMetre}: render failed\n${(r.stderr || r.stdout).slice(-800)}`); process.exit(1); }
  const j = JSON.parse(readFileSync(path.join(root, `${base}.json`), 'utf8')) as { dims: [number, number, number]; report: { parts: number; components: number; unsupported: number; overlaps: number; budget: { cuboidsEstimate: number } }; notes: string[] };
  const verified = j.report.components === 1 && j.report.unsupported === 0 && j.report.overlaps === 0;
  runs.push({
    level: level.studsPerMetre, dims: j.dims, parts: j.report.parts, components: j.report.components, unsupported: j.report.unsupported, overlaps: j.report.overlaps,
    cuboidsEstimate: j.report.budget.cuboidsEstimate, seconds: Math.round((Date.now() - t0) / 1000), verified, notes: j.notes,
    ...(measured[String(level.studsPerMetre)] !== undefined ? measured[String(level.studsPerMetre)]! : {}),
  });
  console.log(`level ${level.studsPerMetre}: ${j.report.parts} parts, ${j.report.components} component(s), ${j.report.unsupported} unsupported, estimate ${j.report.budget.cuboidsEstimate} cuboids, ${runs.at(-1)!.seconds}s`);
}

if (args.includes('--export')) {
  for (const run of runs) {
    const pack = path.join(out, `${slug}-l${run.level}.mcaddon`);
    const built = spawnSync('bun', ['scripts/_playable_ref.ts', path.join(out, `${slug}-l${run.level}.ldr`), pack, '--buildings=bricks', '--scale=1', `--label=${landmark.title} L${run.level}`], { cwd: root, encoding: 'utf8', timeout: 180 * 60_000, maxBuffer: 1 << 28, env: { ...process.env, CRAFTMATIC_LDRAW_MIRROR: 'off' } });
    if (built.status !== 0) { console.error(`level ${run.level}: export failed\n${(built.stderr || built.stdout).slice(-800)}`); process.exit(1); }
    const budget = spawnSync('bun', ['scripts/_marketplace_budget.ts', pack, '--static-only', `--json=${path.join(out, `l${run.level}-budget.json`)}`], { cwd: root, encoding: 'utf8' });
    const rep = JSON.parse(readFileSync(path.join(root, out, `l${run.level}-budget.json`), 'utf8')) as Array<{ static: { totalGeometryCuboids: number; uncompressedBytes: number } }> | { static: { totalGeometryCuboids: number; uncompressedBytes: number } };
    const st = (Array.isArray(rep) ? rep[0]! : rep).static;
    run.residentCuboids = st.totalGeometryCuboids; run.uncompressedBytes = st.uncompressedBytes; void budget;
  }
}

// What the wand shows. Extent in metres from the lattice (the grammar pads every side by PAD_STUDS studs).
const finest = runs.at(-1)!;
const extentM = { x: (finest.dims[0] - 2 * PAD_STUDS) / finest.level, y: finest.dims[1] / (finest.level * 2.5), z: (finest.dims[2] - 2 * PAD_STUDS) / finest.level };
const costs: LevelCost[] = runs.filter(r => r.residentCuboids !== undefined && r.uncompressedBytes !== undefined).map(r => ({ studsPerMetre: r.level, residentCuboids: r.residentCuboids!, uncompressedBytes: r.uncompressedBytes! }));
const tier = BUDGET_TIERS['standard']!;
const suggestion = suggestSize({ extent: extentM, costs, maxResidentCuboids: tier.maxResidentCuboids, maxUncompressedBytes: tier.maxUncompressedBytes });
for (const run of runs) {
  const level = DETAIL_LEVELS.find(l => l.studsPerMetre === run.level)!;
  // The wand of a level's pack speaks that pack's own percent (the real step over its studs per metre).
  const forPack = suggestSize({ extent: extentM, costs, maxResidentCuboids: tier.maxResidentCuboids, maxUncompressedBytes: tier.maxUncompressedBytes, forPack: level });
  const detail: PlacementDetail = {
    studsPerMetre: run.level, extentM: { x: Math.round(extentM.x), y: Math.round(extentM.y), z: Math.round(extentM.z) },
    suggestion: { pct: Math.max(25, Math.round(forPack.pct / level.studsPerMetre)), text: forPack.text },
    otherLevels: DETAIL_LEVELS.filter(l => l.studsPerMetre !== run.level && levels.includes(l)).map(l => ({ studsPerMetre: l.studsPerMetre, text: `The ${l.studsPerMetre}-stud pack has ${l.label}.` })),
  };
  writeFileSync(path.join(root, out, `detail-l${run.level}.json`), JSON.stringify(detail, null, 1));
}
writeFileSync(path.join(root, out, 'levels.json'), JSON.stringify({ slug, extentM, tier: tier.id, maxResidentCuboids: tier.maxResidentCuboids, suggestion: { pct: suggestion.pct, level: suggestion.level.studsPerMetre, text: suggestion.text, reason: suggestion.reason }, runs }, null, 1));
console.log(JSON.stringify({ suggestion: suggestion.text, reason: suggestion.reason }));
if (!existsSync(path.join(root, out, 'levels.json')) || runs.some(r => !r.verified)) { console.error('a level did not verify as one clean component'); process.exit(1); }
