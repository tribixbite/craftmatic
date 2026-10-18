/**
 * Part AABB extents (LDU) for every distinct corpus part id, to test how many
 * parts would fit the 30x30x30-pixel custom-block geometry bound at the
 * exporter's scale.
 *
 * Run from C:/git/craftmatic:  bun scripts/part-block-bounds.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { setLDrawMirror, setLDrawRoot } from '../web/src/engine/ldraw-geometry.ts';
import { createPartGeometryProvider } from '../web/src/engine/ldraw-part-geometry.ts';

setLDrawRoot('C:/git/clego/extracted/studio_release/app/ldraw');
// Offline: the prod mirror answers a missing part with a 503 after ~2 s, times 2 attempts x 3 paths x every alias, so one
// missing id costs tens of seconds. Parts absent from the local snapshot are counted unresolved and checked against the mirror separately.
setLDrawMirror(null);
const census = JSON.parse(readFileSync('output/master-addon-audit/corpus-part-census.json', 'utf8')) as { parts: Record<string, { placements: number; sets: number }> };
const provider = createPartGeometryProvider();
const out: Record<string, { ext: [number, number, number]; triangles: number; studs: number }> = {};
let n = 0;
const hung: string[] = [];
const ids = Object.entries(census.parts).sort((a, b) => b[1].placements - a[1].placements).map(([id]) => id);
for (const id of ids) {
  // A part whose resolution never settles must not stall the whole pass: race it against a 30 s timer.
  const mesh = await Promise.race([
    provider.getPartMesh(id),
    new Promise<null>(resolve => setTimeout(() => resolve(null), 30_000)),
  ]);
  if (!mesh) { hung.push(id); console.error(`no mesh / timeout: ${id}`); continue; }
  const { min, max } = mesh.bounds;
  out[id] = { ext: [max[0] - min[0], max[1] - min[1], max[2] - min[2]], triangles: mesh.triangles.length, studs: mesh.studs.length };
  if (++n % 2000 === 0) console.error(`${n} parts`);
  if (n % 500 === 0) writeFileSync('output/master-addon-audit/part-bounds.json', JSON.stringify(out));
}
writeFileSync('output/master-addon-audit/part-bounds.json', JSON.stringify(out));
console.error(`done ${n} parts, ${hung.length} unresolved/timeout: ${hung.slice(0, 40).join(' ')}`);
