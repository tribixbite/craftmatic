/**
 * Resident part-library cost for the master-add-on audit.
 *
 * For every distinct part id the corpus census found, compile the part's
 * cuboid prototype with the REAL compiler (`compilePartPrototype`, the code the
 * playable-add-on exporter runs) at each quality and record the cuboid count,
 * the stud count and the source (exact-box / mesh-decomposition /
 * aabb-fallback). Studs are reported separately: in a placed model only EXPOSED
 * studs are emitted, but a resident library must carry every top stud
 * (`studFacets` cuboids each), because exposure is a property of the assembly.
 *
 * Run from C:/git/craftmatic:
 *   bun scripts/part-library-cost.ts [--quality=balanced|high|ultra] [--limit=N] [--min-sets=N]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { setLDrawMirror, setLDrawRoot } from '../web/src/engine/ldraw-geometry.ts';
import { createPartGeometryProvider } from '../web/src/engine/ldraw-part-geometry.ts';
import { compilePartPrototype, LEGO_ENTITY_QUALITY, type LegoEntityQualityName } from '../web/src/engine/ldraw-part-prototype.ts';

setLDrawRoot('C:/git/clego/extracted/studio_release/app/ldraw');
// Offline: the prod mirror answers a missing part with a 503 after ~2 s, times 2 attempts x 3 paths x every alias, so one
// missing id costs tens of seconds. Parts absent from the local snapshot are counted unresolved and checked against the mirror separately.
setLDrawMirror(null);

const flag = (name: string): string | undefined => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const qualityName = (flag('quality') ?? 'balanced') as LegoEntityQualityName;
const quality = LEGO_ENTITY_QUALITY[qualityName];
const limit = Number(flag('limit') ?? 0);
const minSets = Number(flag('min-sets') ?? 0);
// --shard=k/n: take every n-th id starting at k, so several processes can split the library.
const shardSpec = (flag('shard') ?? '0/1').split('/').map(Number) as [number, number];
const census = JSON.parse(readFileSync('output/master-addon-audit/corpus-part-census.json', 'utf8')) as {
  parts: Record<string, { placements: number; sets: number }>;
};
// Heaviest-used first so a --limit run covers the most placements.
let ids = Object.entries(census.parts).filter(([, s]) => s.sets >= minSets).sort((a, b) => b[1].placements - a[1].placements).map(([id]) => id);
if (limit) ids = ids.slice(0, limit);
ids = ids.filter((_, i) => i % shardSpec[1] === shardSpec[0]);

const provider = createPartGeometryProvider();
interface Row { cuboids: number; studs: number; source: string; microcell: number; coarsened: number; ms: number; triangles: number }
const base = `output/master-addon-audit/proto-cost-${qualityName}${limit ? `-top${limit}` : ''}${minSets ? `-min${minSets}` : ''}`;
const out = shardSpec[1] > 1 ? `${base}-s${shardSpec[0]}of${shardSpec[1]}.json` : `${base}.json`;
// Checkpoint + resume: the run is long and a killed process must not lose its work.
let rows: Record<string, Row> = {};
let unresolved: string[] = [];
try {
  const prev = JSON.parse(readFileSync(out, 'utf8')) as { rows: Record<string, Row>; unresolved: string[] };
  rows = prev.rows; unresolved = prev.unresolved;
  console.error(`resuming: ${Object.keys(rows).length} rows, ${unresolved.length} unresolved already done`);
} catch { /* fresh run */ }
const doneIds = new Set([...Object.keys(rows), ...unresolved]);
// An unsharded checkpoint from an earlier run also counts as done (its rows are merged at analysis time).
try {
  const prev = JSON.parse(readFileSync(`${base}.json`, 'utf8')) as { rows: Record<string, Row>; unresolved: string[] };
  if (shardSpec[1] > 1) for (const id of [...Object.keys(prev.rows), ...prev.unresolved]) doneIds.add(id);
} catch { /* none */ }
ids = ids.filter(id => !doneIds.has(id));
const checkpoint = (): void => writeFileSync(out, JSON.stringify({ quality: qualityName, params: quality, compiled: Object.keys(rows).length, unresolved, rows }));
const t0 = Date.now();
let n = 0;
for (const id of ids) {
  // A part whose resolution never settles (seen: LSynth `ls*` ids and other missing
  // library files) must not stall the shard: race it against a 10 s timer and count it unresolved.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const mesh = await Promise.race([
    provider.getPartMesh(id),
    new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 10_000); }),
  ]);
  if (timer) clearTimeout(timer);
  if (!mesh) { unresolved.push(id); if (unresolved.length % 50 === 0) checkpoint(); continue; }
  const t = Date.now();
  const proto = compilePartPrototype(mesh, quality);
  rows[id] = { cuboids: proto.cuboids.length, studs: proto.studs.length, source: proto.source, microcell: proto.microcellLdu, coarsened: proto.metrics.coarsened, ms: Date.now() - t, triangles: mesh.triangles.length };
  n++;
  if (n % 250 === 0) { checkpoint(); console.error(`${qualityName}: ${n}/${ids.length} parts this run (${Object.keys(rows).length} total), ${Math.round((Date.now() - t0) / 1000)} s`); }
}
checkpoint();
console.error(`done ${qualityName}: ${n} compiled, ${unresolved.length} unresolved, ${Math.round((Date.now() - t0) / 1000)} s -> ${out}`);
