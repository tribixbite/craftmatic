/**
 * The lowest parts of a source model as craftmatic DRAWS them (its own part geometry, the same
 * `placementBox` the scene finders use), against the model's base. A part whose box runs well
 * under every plate is what grounds a whole model on itself in the export: the simulator's
 * `model-grounded` then reads the model as hanging (PROC-20: 42652's legs, 80049's post).
 * clego's `ld_bbox` reads Studio's library and can disagree with what craftmatic resolves.
 *
 * Usage: bun scripts/_lowest_parts.ts <model.ldr|.mpd> [N]
 * Output: N rows `bottom top part colour description at` (LDraw y is down: the lowest is the largest y).
 */
import { readFileSync } from 'node:fs';
import { parseLDrawDocument } from '../web/src/engine/ldraw-parser.ts';
import { setLDrawRoot } from '../web/src/engine/ldraw-geometry.ts';
import { createPartGeometryProvider, type LdrawPartMesh } from '../web/src/engine/ldraw-part-geometry.ts';
import { placementBox } from '../web/src/engine/scene-vehicles.ts';

setLDrawRoot('C:/git/clego/extracted/studio_release/app/ldraw');
const [file, nArg] = process.argv.slice(2);
if (!file) { console.error('usage: bun scripts/_lowest_parts.ts <model.ldr|.mpd> [N]'); process.exit(2); }
const n = Number(nArg ?? 20);
const doc = parseLDrawDocument(readFileSync(file, 'utf8'));
const provider = createPartGeometryProvider({ document: doc });
const meshes = new Map<string, LdrawPartMesh | null>();
await Promise.all([...new Set(doc.bricks.map(b => b.part))].map(async part => { meshes.set(part, await provider.getPartMesh(part)); }));
const rows = doc.bricks.map(b => ({ b, box: placementBox(b, meshes.get(b.part)) }));
rows.sort((p, q) => q.box.max[1] - p.box.max[1]);
for (const { b, box } of rows.slice(0, n)) {
  const at = [b.x, b.y, b.z].map(v => Number(v).toFixed(1)).join(',');
  console.log(`${box.max[1].toFixed(1)}\t${box.min[1].toFixed(1)}\t${b.part}\t${b.color}\t${meshes.get(b.part)?.description ?? '(no mesh)'}\t${at}`);
}
