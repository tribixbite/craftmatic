/**
 * Diagnostic: why does minifig hair float above the head in Minecraft exports?
 *
 * Loads a set, finds every minifig head (3626*) and the part directly above it,
 * resolves BOTH parts' real LDraw triangle geometry, and prints:
 *   • the world-LDU vertical relationship (head crown vs hair underside),
 *   • the voxel column each occupies at a given cell size,
 *   • whether an air layer separates them.
 *
 * Usage: bun scripts/_hair_probe.ts [model.io] [cellLDU]
 */
import { readFileSync } from 'node:fs';
import { extractIoModel } from '../web/src/engine/io-extractor.ts';
import { parseLDraw, type ParsedBrick } from '../web/src/engine/ldraw-parser.ts';
import { synthesizeLSynth } from '../web/src/engine/lsynth.ts';
import { setLDrawRoot, __debugWorldTris, __debugCells } from '../web/src/engine/ldraw-geometry.ts';

setLDrawRoot('C:/git/clego/extracted/studio_release/app/ldraw');
const file = process.argv[2] ?? 'C:/git/clego/lego_sets/IO/71799-1.io';
const cell = Number(process.argv[3] ?? 4);

const b = readFileSync(file);
const io = await extractIoModel(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
const bricks = parseLDraw(synthesizeLSynth(io.text).text);

const bare = (p: string) => p.replace(/\.dat$/i, '').toLowerCase().replace(/^.*[/\\]/, '');
const heads = bricks.filter(x => /^3626/.test(bare(x.part)));
console.log(`${bricks.length} bricks, ${heads.length} heads (3626*)`);

/** World-LDU AABB of a brick's resolved triangles (null when no geometry). */
async function aabb(brick: ParsedBrick) {
  const tris = await __debugWorldTris(brick);
  if (!tris || tris.length === 0) return null;
  let xn = Infinity, xx = -Infinity, yn = Infinity, yx = -Infinity, zn = Infinity, zx = -Infinity;
  for (const [v0, v1, v2] of tris) for (const v of [v0, v1, v2]) {
    if (v[0] < xn) xn = v[0]; if (v[0] > xx) xx = v[0];
    if (v[1] < yn) yn = v[1]; if (v[1] > yx) yx = v[1];
    if (v[2] < zn) zn = v[2]; if (v[2] > zx) zx = v[2];
  }
  return { xn, xx, yn, yx, zn, zx, n: tris.length };
}

let reported = 0;
for (const head of heads) {
  if (reported >= 6) break;
  // The part sitting on the head: nearest brick above (LDraw Y is DOWN, so a
  // smaller y is higher) within one stud horizontally.
  const near = bricks
    .filter(x => x !== head && Math.hypot(x.x - head.x, x.z - head.z) < 24 && Math.abs(x.y - head.y) < 40)
    .sort((p, q) => p.y - q.y);
  console.log(`\nhead ${head.part} @ (${head.x},${head.y},${head.z}) neighbours: ` +
    near.map(n => `${n.part}@dy${(n.y - head.y).toFixed(1)}`).join(' '));
  const above = near.filter(x => x.y <= head.y).sort((p, q) => q.y - p.y)[0];
  if (!above) continue;
  const hb = await aabb(head);
  const ab = await aabb(above);
  if (!hb || !ab) { console.log(`  head ${head.part}: geometry missing (head=${!!hb} above=${!!ab})`); continue; }
  reported++;
  // Crown = smallest world Y of the head (highest point). Hair underside = LARGEST world Y.
  const gapLDU = hb.yn - ab.yx;      // >0 → hair bottom is ABOVE head crown (real air gap)
  const headTopCell = Math.round(-hb.yn / cell);
  const hairBotCell = Math.round(-ab.yx / cell);
  console.log(
    `\nhead ${head.part} @ (${head.x},${head.y},${head.z})  crownY=${hb.yn.toFixed(2)} baseY=${hb.yx.toFixed(2)}\n` +
    `  above ${above.part} @ (${above.x},${above.y},${above.z})  topY=${ab.yn.toFixed(2)} underY=${ab.yx.toFixed(2)} tris=${ab.n}\n` +
    `  LDU overlap: hairUnder(${ab.yx.toFixed(2)}) vs headCrown(${hb.yn.toFixed(2)}) → gap ${gapLDU.toFixed(2)} LDU` +
    ` (${gapLDU > 0 ? 'SEPARATE' : 'OVERLAPPING'})\n` +
    `  grid rows @cell ${cell}: head top row ${headTopCell}, hair bottom row ${hairBotCell}` +
    ` → ${hairBotCell - headTopCell - 1} empty row(s) between if both are solid at their extremes`,
  );

  // ── Real voxel footprints, straight from the export rasterizer ─────────────
  const hCells = await __debugCells(head, cell);
  const aCells = await __debugCells(above, cell);
  const key = (c: [number, number, number]) => `${c[0]},${c[1]},${c[2]}`;
  const hSet = new Set(hCells.map(key));
  const aSet = new Set(aCells.map(key));
  const rows = (cs: Array<[number, number, number]>) => {
    const m = new Map<number, number>();
    for (const c of cs) m.set(c[1], (m.get(c[1]) ?? 0) + 1);
    return m;
  };
  const hRows = rows(hCells), aRows = rows(aCells);
  const yLo = Math.min(...hRows.keys(), ...aRows.keys());
  const yHi = Math.max(...hRows.keys(), ...aRows.keys());
  console.log(`  voxel rows (grid Y up) — head cells ${hCells.length}, above cells ${aCells.length}`);
  for (let y = yHi; y >= yLo; y--) {
    console.log(`    y=${String(y).padStart(3)}  head ${String(hRows.get(y) ?? 0).padStart(4)}  above ${String(aRows.get(y) ?? 0).padStart(4)}`);
  }
  // 6-neighbour contact between the two footprints?
  let contact = 0;
  for (const c of aCells) {
    for (const [dx, dy, dz] of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]] as const) {
      if (hSet.has(`${c[0]+dx},${c[1]+dy},${c[2]+dz}`)) { contact++; break; }
    }
  }
  const shared = aCells.filter(c => hSet.has(key(c))).length;
  console.log(`  CONTACT: ${shared} shared cells, ${contact} of ${aSet.size} above-cells 6-adjacent to a head cell` +
    ` → ${shared + contact > 0 ? 'TOUCHING' : '*** FLOATING ***'}`);

  // Minimum Chebyshev separation between the two footprints (how far a bridge
  // or a snap would have to reach).
  let best = Infinity, bestPair = '';
  for (const a of aCells) for (const h of hCells) {
    const d = Math.max(Math.abs(a[0] - h[0]), Math.abs(a[1] - h[1]), Math.abs(a[2] - h[2]));
    if (d < best) { best = d; bestPair = `${a} ↔ ${h}`; }
  }
  console.log(`  min Chebyshev cell distance = ${best}  (${bestPair})`);

  // ── ASCII X/Y slice through the head centre (Z = the head's own centre row) ──
  const zc = Math.round(head.z / cell);
  const xs = [...hCells, ...aCells].filter(c => c[2] === zc).map(c => c[0]);
  const xLo = Math.min(...xs), xHi = Math.max(...xs);
  console.log(`  slice z=${zc} (x ${xLo}..${xHi}):  H=head  A=${above.part.replace(/\.dat$/, '')}  #=both`);
  for (let y = yHi; y >= yLo; y--) {
    let row = '';
    for (let x = xLo; x <= xHi; x++) {
      const h = hSet.has(`${x},${y},${zc}`), a = aSet.has(`${x},${y},${zc}`);
      row += h && a ? '#' : h ? 'H' : a ? 'A' : '.';
    }
    console.log(`    y=${String(y).padStart(3)} |${row}|`);
  }
}
