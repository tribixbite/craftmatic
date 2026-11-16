/**
 * Geometry vehicle census (VEH-20, census class 1): for each set, the vehicles the export would find WITHOUT a
 * vehicle title - the vehicle discovery the LEGO tab runs (`discoverPlayableComponents`, then the geometry finder
 * `geometryVehicles` for a title that names no whole vehicle) - over the index's first-pick source, without
 * building a pack. With `--base=<scene-vehicles module>` it also runs an older copy of the finder (one without
 * `geometryVehicles` is run the way the pipeline called it before: the scene finder, then the whole-model car when
 * the scene held nothing and the title names no scenery) and marks every set whose vehicles CHANGED.
 *
 * Usage: bun scripts/_geometry_vehicle_census.ts <set>... | --list=<file of set numbers> [--base=<path to an older scene-vehicles.ts>] [--tsv=<out>]
 * Output: one line per set (`kind(parts, motion)` per vehicle, `=` unchanged or `CHANGED`), totals at the end.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { setLDrawRoot } from '../web/src/engine/ldraw-geometry.ts';
import { createPartGeometryProvider, type LdrawPartMesh } from '../web/src/engine/ldraw-part-geometry.ts';
import { discoverPlayableComponents, isSceneryLabel, isWholeVehicleLabel, type PlayableBrickComponent } from '../web/src/engine/playable-components.ts';
import * as current from '../web/src/engine/scene-vehicles.ts';
import type { ParsedBrick } from '../web/src/engine/ldraw-parser.ts';
import { loadModelBricks } from './model-source.ts';
import { firstPickSource, legoTabLabel, readModelsIndex } from './favourite-sets.ts';

setLDrawRoot('C:/git/clego/extracted/studio_release/app/ldraw');
if (!process.env.CRAFTMATIC_LDRAW_REF && existsSync('C:/git/clego/ldraw_ref')) process.env.CRAFTMATIC_LDRAW_REF = 'C:/git/clego/ldraw_ref';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => args.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const listFile = flag('list');
const sets = [...args.filter(a => !a.startsWith('--')), ...(listFile ? readFileSync(listFile, 'utf8').split(/\s+/).filter(Boolean) : [])];
if (!sets.length) { console.error('usage: bun scripts/_geometry_vehicle_census.ts <set>... | --list=<file> [--base=<scene-vehicles.ts>] [--tsv=<out>]'); process.exit(2); }
type Finder = typeof current;
const baseFile = flag('base');
const base: Partial<Finder> | null = baseFile ? await import(baseFile) as Partial<Finder> : null;

/** What a finder module gives a model whose title names no whole vehicle (the pipeline's order). */
function geometry(f: Partial<Finder>, bricks: ParsedBrick[], meshes: Map<string, LdrawPartMesh | null>, scenery: boolean): PlayableBrickComponent[] {
  if (f.geometryVehicles) { const g = f.geometryVehicles(bricks, meshes, scenery); return [...g.inScene, ...g.whole]; }
  const inScene = f.findSceneVehicles!(bricks, meshes).components;
  if (inScene.length || scenery) return inScene;
  return f.findWholeModelVehicles!(bricks, meshes).components;
}
const show = (list: readonly PlayableBrickComponent[]): string => list.map(c => `${c.kind}(${c.bricks.length}${c.motion ? `, ${c.motion}` : ''})`).sort().join(' ') || '-';

const index = readModelsIndex();
const rows: string[] = [['set', 'label', 'path', 'now', 'before', 'changed', 'why'].join('\t')];
let changed = 0, found = 0;
for (const set of sets) {
  const entry = index[set];
  const pick = firstPickSource(entry);
  const label = legoTabLabel(set, entry?.name);
  if (!pick || !existsSync(pick.file)) { console.log(`${set}: no source`); continue; }
  const { bricks } = await loadModelBricks(pick.file);
  const provider = createPartGeometryProvider();
  const meshes = new Map<string, LdrawPartMesh | null>();
  await Promise.all([...new Set(bricks.map(b => b.part))].map(async part => { meshes.set(part, await provider.getPartMesh(part)); }));
  const titled = discoverPlayableComponents(bricks, label, 'auto', part => meshes.get(part)?.description ?? '');
  let now: string, before = '', why = '';
  if (titled.components.length || isWholeVehicleLabel(label)) {
    now = before = `title: ${show(titled.components)}`;
  } else {
    const scenery = isSceneryLabel(label);
    const list = geometry(current, bricks, meshes, scenery);
    now = show(list);
    why = list.map(c => c.provenance).join(' | ');
    if (base) before = show(geometry(base, bricks, meshes, scenery));
    if (list.length) found++;
  }
  const diff = base && now !== before;
  if (diff) changed++;
  rows.push([set, label, pick.model.path, now, before, diff ? 'CHANGED' : '=', why].join('\t'));
  console.log(`${set}\t${label}\t${now}${base ? `\t${diff ? `CHANGED from ${before}` : '='}` : ''}`);
}
console.log(`${sets.length} sets: ${found} with a geometry vehicle${base ? `; ${changed} changed against the base finder` : ''}`);
const tsv = flag('tsv');
if (tsv) writeFileSync(tsv, `${rows.join('\n')}\n`);
