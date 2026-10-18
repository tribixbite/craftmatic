/**
 * Is the per-part cuboid decomposition optimal? Compare the shipped scan-order
 * greedy merge (`greedyCuboids`) against two alternatives on the SAME coarse
 * lattice, so every candidate covers exactly the same solid cells with the
 * same colour labels (voxel IoU 1.0 by construction, and verified by
 * re-rasterising each result):
 *
 *   best-axis   the same greedy with all six axis extension orders; keep the fewest
 *   max-box     repeatedly take the largest same-label box that still fits the
 *               unmerged cells (corner candidates x six growth orders), until
 *               every cell is covered
 *
 * Parts come from output/master-addon-audit/frontier-worst50.json (the 50
 * costliest by body cuboids at balanced, plus the 50 whose cost x set-usage is
 * highest — the cuboids a library would actually spend). Meshes resolve from
 * Studio's LDraw library; the corpus is not read.
 *
 * Run from C:/git/craftmatic:  bun scripts/part-decomposition-compare.ts [--quality=balanced] [--list=worstByBody|heaviestBySets|both|sample:N]
 * Writes output/master-addon-audit/decomposition-compare-<quality>-<list>.json.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { setLDrawMirror, setLDrawRoot } from '../web/src/engine/ldraw-geometry.ts';
import { createPartGeometryProvider, type Vec3 } from '../web/src/engine/ldraw-part-geometry.ts';
import {
  bestOfCuboids, compilePartPrototype, downsample, fillInterior, greedyCuboids, greedyCuboidsOrdered, LEGO_ENTITY_QUALITY, maxBoxCuboids, rasterizeSurface,
  type Lattice, type LegoEntityQualityName, type PartCuboid,
} from '../web/src/engine/ldraw-part-prototype.ts';

setLDrawRoot('C:/git/clego/extracted/studio_release/app/ldraw');
setLDrawMirror(null);
const flag = (name: string): string | undefined => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const qualityName = (flag('quality') ?? 'balanced') as LegoEntityQualityName;
const quality = LEGO_ENTITY_QUALITY[qualityName];
const listName = flag('list') ?? 'both';
const D = 'output/master-addon-audit/';
const lists = JSON.parse(readFileSync(D + 'frontier-worst50.json', 'utf8')) as { worstByBody: string[]; heaviestBySets: string[] };
/** `--list=sample:N` draws N mesh-decomposition parts at random (seeded, so a re-run draws the same ones) from the cached balanced cost rows. */
function samplePartIds(n: number, seed = 20260919): string[] {
  const rows: Record<string, { source: string }> = {};
  for (const f of [`proto-cost-balanced.json`, ...[0, 1, 2, 3, 4].map(k => `proto-cost-balanced-s${k}of5.json`)]) Object.assign(rows, (JSON.parse(readFileSync(D + f, 'utf8')) as { rows: Record<string, { source: string }> }).rows);
  const pool = Object.entries(rows).filter(([, r]) => r.source === 'mesh-decomposition').map(([id]) => id).sort();
  let state = seed >>> 0;
  const rand = (): number => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; }; // LCG, deterministic
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [pool[i], pool[j]] = [pool[j]!, pool[i]!]; }
  return pool.slice(0, n);
}
const ids = listName.startsWith('sample:') ? samplePartIds(Number(listName.slice(7)))
  : [...new Set(listName === 'both' ? [...lists.worstByBody, ...lists.heaviestBySets] : lists[listName as keyof typeof lists])];
const outName = listName.replace(':', '');

type Order = [number, number, number];
const ORDERS: Order[] = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
const greedyOrdered = greedyCuboidsOrdered;
const maxBoxFirst = (lat: Lattice, boundsMax: Vec3): { cuboids: PartCuboid[]; timedOut: boolean } => ({ cuboids: maxBoxCuboids(lat, boundsMax), timedOut: false });

/** Re-rasterise cuboids onto the lattice and compare cell-for-cell (solid AND label). */
function coversExactly(lat: Lattice, cuboids: PartCuboid[]): { equal: boolean; iou: number } {
  const { nx, ny, nz, origin, cell } = lat;
  const cover = new Uint16Array(nx * ny * nz); // label+1 of the covering cuboid, 0 = uncovered
  for (const c of cuboids) {
    const x0 = Math.round((c.min[0] - origin[0]) / cell), y0 = Math.round((c.min[1] - origin[1]) / cell), z0 = Math.round((c.min[2] - origin[2]) / cell);
    // A flat part (zero extent on an axis) still occupies one cell row there.
    const x1 = Math.max(x0 + 1, Math.min(nx, Math.ceil((c.max[0] - origin[0]) / cell - 1e-9))), y1 = Math.max(y0 + 1, Math.min(ny, Math.ceil((c.max[1] - origin[1]) / cell - 1e-9))), z1 = Math.max(z0 + 1, Math.min(nz, Math.ceil((c.max[2] - origin[2]) / cell - 1e-9)));
    const lbl = c.color === 16 ? 0 : lat.colors.indexOf(c.color) + 1;
    for (let y = y0; y < y1; y++) for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) cover[(y * nz + z) * nx + x] = lbl + 1;
  }
  let inter = 0, union = 0, equal = true;
  for (let n = 0; n < cover.length; n++) {
    const a = lat.solid[n] === 1, b = cover[n]! > 0;
    if (a || b) union++;
    if (a && b) inter++;
    if (a !== b || (a && cover[n]! - 1 !== lat.label[n])) equal = false;
  }
  return { equal, iou: union ? inter / union : 1 };
}

const provider = createPartGeometryProvider();
interface Row { id: string; microcell: number; solidCells: number; shipped: number; greedyReplay: number; bestAxis: number; bestAxisOrder: string; maxBox: number; bestOf: number; maxBoxTimedOut: boolean; coverExact: boolean; ms: number }
const rows: Row[] = [];
const t0 = Date.now();
for (const id of ids) {
  const mesh = await Promise.race([provider.getPartMesh(id), new Promise<null>(r => setTimeout(() => r(null), 10_000))]);
  if (!mesh) { console.error(`unresolved ${id}`); continue; }
  const shipped = compilePartPrototype(mesh, quality);
  if (shipped.source !== 'mesh-decomposition') { console.error(`${id}: ${shipped.source}, skipped`); continue; }
  const t = Date.now();
  const { min, max } = mesh.bounds;
  const fine = rasterizeSurface(mesh.triangles, min, max, shipped.microcellLdu / 2);
  fillInterior(fine, shipped.hollow);
  const coarse = downsample(fine);
  const replay = greedyCuboids(coarse, max);
  let bestAxis = replay.length, bestOrder = 'shipped';
  for (const order of ORDERS) { const n = greedyOrdered(coarse, max, order).length; if (n < bestAxis) { bestAxis = n; bestOrder = order.join(''); } }
  const mb = maxBoxFirst(coarse, max);
  const bestOf = bestOfCuboids(coarse, max);
  const checks = [coversExactly(coarse, replay), coversExactly(coarse, mb.cuboids), coversExactly(coarse, bestOf), ...ORDERS.map(o => coversExactly(coarse, greedyOrdered(coarse, max, o)))];
  rows.push({ id, microcell: shipped.microcellLdu, solidCells: shipped.metrics.solidCells, shipped: shipped.cuboids.length, greedyReplay: replay.length, bestAxis, bestAxisOrder: bestOrder, maxBox: mb.cuboids.length, bestOf: bestOf.length, maxBoxTimedOut: mb.timedOut, coverExact: checks.every(c => c.equal && c.iou === 1), ms: Date.now() - t });
  console.error(`${id}: shipped ${shipped.cuboids.length} (replay ${replay.length}) best-axis ${bestAxis} [${bestOrder}] max-box ${mb.cuboids.length}${mb.timedOut ? ' (timed out)' : ''} exact=${rows[rows.length - 1]!.coverExact} ${Date.now() - t} ms`);
}
const sum = (f: (r: Row) => number): number => rows.reduce((a, r) => a + f(r), 0);
const summary = {
  quality: qualityName, parts: rows.length, replayMatchesShipped: rows.every(r => r.shipped === r.greedyReplay), allCoverExact: rows.every(r => r.coverExact),
  shipped: sum(r => r.shipped), bestAxis: sum(r => r.bestAxis), maxBox: sum(r => r.maxBox), minOfAll: sum(r => Math.min(r.shipped, r.bestAxis, r.maxBox)), bestOf: sum(r => r.bestOf), bestOfMatchesMin: rows.every(r => r.bestOf === Math.min(r.shipped, r.bestAxis, r.maxBox)),
  bestAxisSaving: +(1 - sum(r => r.bestAxis) / sum(r => r.shipped)).toFixed(4), maxBoxSaving: +(1 - sum(r => r.maxBox) / sum(r => r.shipped)).toFixed(4), minSaving: +(1 - sum(r => Math.min(r.shipped, r.bestAxis, r.maxBox)) / sum(r => r.shipped)).toFixed(4),
  maxBoxTimedOut: rows.filter(r => r.maxBoxTimedOut).length, seconds: Math.round((Date.now() - t0) / 1000),
};
console.log(JSON.stringify(summary, null, 1));
writeFileSync(D + `decomposition-compare-${qualityName}-${outName}.json`, JSON.stringify({ summary, rows }, null, 1));
