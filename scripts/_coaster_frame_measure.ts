/**
 * Measure `bl_80566.dat` (RAIL 13X13X3 1/3, 1/4 CIRCLE) in its own frame and
 * test whether 76417's seven placements of it, plus its 25059 straight and
 * 80562 4x4, form a contiguous helix.
 *
 * This is the derivation behind `FRAME_ALIASES` in `engine/coaster-track.ts`:
 * re-run it to re-measure an alias offset, or to measure a new `bl_*` part.
 *
 * Part 1 reads the DAT's triangles directly (it references only
 * `stud.dat`, which is ignored — studs are not rail), reports the bbox, fits
 * the arc centre from the two end-connector planes and prints the radius
 * histogram of the rail vertices so the rail faces show as peaks. Part 2 builds
 * the end-datum points from that measurement, transforms them by each
 * placement, sorts the quarters by height and prints the end-to-end gaps.
 *
 * Usage: bun scripts/_coaster_frame_measure.ts <model.ldr> [more.ldr …]
 */
import { readFileSync } from 'node:fs';
import { parseLDrawDocument, type ParsedBrick } from '../web/src/engine/ldraw-parser.ts';
import { partStem } from '../web/src/engine/part-id.ts';
import { coasterTrackProfile } from '../web/src/engine/coaster-track.ts';

type V3 = [number, number, number];
const DAT = 'C:/git/clego/extracted/studio_release/app/ldraw/UnOfficial/parts/bl_80566.dat';

// ---------- Part 1: the mould in its own frame ----------
const verts: V3[] = [];
for (const line of readFileSync(DAT, 'latin1').split(/\r?\n/)) {
  const t = line.trim().split(/\s+/);
  if (t[0] === '3' || t[0] === '4') {
    const n = t[0] === '3' ? 3 : 4;
    for (let i = 0; i < n; i++) verts.push([+t[2 + 3 * i]!, +t[3 + 3 * i]!, +t[4 + 3 * i]!]);
  }
}
const lo: V3 = [Infinity, Infinity, Infinity], hi: V3 = [-Infinity, -Infinity, -Infinity];
for (const v of verts) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a]!, v[a]!) as never; hi[a] = Math.max(hi[a]!, v[a]!) as never; }
console.log(`bl_80566: ${verts.length} triangle vertices; bbox x ${lo[0]}..${hi[0]}  y ${lo[1]}..${hi[1]}  z ${lo[2]}..${hi[2]}`);

// End planes: the low end is the face at max/min z, the high end at min/max x.
// Decide which by the stud positions in the DAT: low studs at z=-410.6 (min z),
// high studs at x=-126.8 (min x).
const zEnd = lo[2], xEnd = lo[0];
const lowFace = verts.filter(v => Math.abs(v[2] - zEnd) < .5);
const highFace = verts.filter(v => Math.abs(v[0] - xEnd) < .5);
const span = (list: V3[], a: number) => `${Math.min(...list.map(v => v[a]!))}..${Math.max(...list.map(v => v[a]!))}`;
console.log(`low end face (z=${zEnd}): ${lowFace.length} verts, x ${span(lowFace, 0)}  y ${span(lowFace, 1)}`);
console.log(`high end face (x=${xEnd}): ${highFace.length} verts, z ${span(highFace, 2)}  y ${span(highFace, 1)}`);

// Arc centre: tangent at the low end is along z, at the high end along x, so the
// centre has z = zEnd and x = xEnd. Print the radius histogram in 1 LDU bins.
const cx = xEnd, cz = zEnd;
const hist = new Map<number, number>();
for (const v of verts) {
  const r = Math.round(Math.hypot(v[0] - cx, v[2] - cz));
  hist.set(r, (hist.get(r) ?? 0) + 1);
}
const top = [...hist].sort((a, b) => b[1] - a[1]).slice(0, 12).sort((a, b) => a[0] - b[0]);
console.log(`radius histogram about centre (x=${cx}, z=${cz}), top bins: ${top.map(([r, n]) => `${r}:${n}`).join('  ')}`);

// Rail top height at each end: within +-6 LDU of the end plane, the highest
// vertices (min y) at every radius peak.
const railTop = (face: V3[]) => Math.min(...face.map(v => v[1]));
console.log(`rail/plate top at low end y=${railTop(lowFace)}, high end y=${railTop(highFace)}; rise = ${railTop(lowFace) - railTop(highFace)} LDU`);
// Height profile along the arc: min y of vertices per 10-degree sector, on the outer rail radius band.
const sectors: number[][] = Array.from({ length: 9 }, () => []);
for (const v of verts) {
  const r = Math.hypot(v[0] - cx, v[2] - cz);
  if (r < 200 || r > 250) continue;
  const ang = Math.atan2(v[2] - cz, v[0] - cx) * 180 / Math.PI; // 0 = +x (high end), 90 = +z (low end)
  const k = Math.min(8, Math.max(0, Math.floor(ang / 10)));
  sectors[k]!.push(v[1]);
}
console.log('min y (highest vertex) per 10-degree sector from +x (high end) to +z (low end), r 200..250: ' +
  sectors.map((s, k) => `${k * 10}:${s.length ? Math.min(...s) : 'n/a'}`).join(' '));

// ---------- Part 2: placements ----------
const T = (b: ParsedBrick, p: V3): V3 => {
  const r = b.rot ?? [1, 0, 0, 0, 1, 0, 0, 0, 1];
  return [
    b.x + r[0]! * p[0] + r[1]! * p[1] + r[2]! * p[2],
    b.y + r[3]! * p[0] + r[4]! * p[1] + r[5]! * p[2],
    b.z + r[6]! * p[0] + r[7]! * p[1] + r[8]! * p[2],
  ];
};
const dist = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const fmt = (p: V3) => `(${p.map(v => +v.toFixed(1)).join(', ')})`;

// End datum points in the part frame: centre-line of the rail at each end plane, on the plate top.
const rMid = (Math.min(...lowFace.map(v => v[0])) + Math.max(...lowFace.map(v => v[0]))) / 2 - cx;
const lowDatum: V3 = [cx + rMid, railTop(lowFace), zEnd];
const highDatum: V3 = [xEnd, railTop(highFace), cz + rMid];
console.log(`centre-line radius ${rMid}; low datum ${fmt(lowDatum)}, high datum ${fmt(highDatum)}`);

for (const file of process.argv.slice(2)) {
  const label = file.replace(/.*lego_sets[/\\]/, '');
  const bricks = parseLDrawDocument(readFileSync(file, 'latin1')).bricks;
  const quarters = bricks.filter(b => partStem(b.part) === 'bl_80566');
  console.log(`\n=== ${label}: ${quarters.length} x bl_80566 ===`);
  const ends = quarters.map(b => ({ b, low: T(b, lowDatum), high: T(b, highDatum) }));
  for (const e of ends) console.log(`  at (${e.b.x}, ${e.b.y}, ${e.b.z}) low ${fmt(e.low)} -> high ${fmt(e.high)}`);
  // Greedy chain: for every high end, the nearest low end of another quarter.
  console.log('  each quarter\'s HIGH end -> nearest other quarter\'s LOW end (LDU):');
  for (const e of ends) {
    let best = Infinity, who = -1;
    ends.forEach((o, i) => { if (o !== e) { const d = dist(e.high, o.low); if (d < best) { best = d; who = i; } } });
    console.log(`    y=${e.b.y.toFixed(0).padStart(5)} high ${fmt(e.high)} -> #${who} (y=${ends[who]?.b.y.toFixed(0)}) gap ${best.toFixed(1)}`);
  }
  // Straights with engine profiles: 25059 and 80562.
  for (const b of bricks) {
    const s = partStem(b.part);
    if (s !== '25059' && s !== '80562') continue;
    const p = coasterTrackProfile(b.part)!;
    const a = T(b, p.railSamples[0] as V3), z = T(b, p.railSamples.at(-1) as V3);
    const near = (pt: V3) => {
      let best = Infinity, tag = '';
      for (const e of ends) {
        if (dist(pt, e.low) < best) { best = dist(pt, e.low); tag = `low@y${e.b.y.toFixed(0)}`; }
        if (dist(pt, e.high) < best) { best = dist(pt, e.high); tag = `high@y${e.b.y.toFixed(0)}`; }
      }
      return `${tag} ${best.toFixed(1)}`;
    };
    console.log(`  ${s} at (${b.x}, ${b.y}, ${b.z}): rail ends ${fmt(a)} [nearest ${near(a)}]  ${fmt(z)} [nearest ${near(z)}]`);
  }
  const cart = bricks.find(b => partStem(b.part) === '26021');
  if (cart) console.log(`  cart 26021 at (${cart.x}, ${cart.y}, ${cart.z})`);
}
