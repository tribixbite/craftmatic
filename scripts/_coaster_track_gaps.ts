/**
 * Per-join gap of a source's coaster track, by the engine's own profiles:
 * for every recognised track placement, transform the profile's two rail
 * endpoints to world space and print the distance to the nearest endpoint of
 * any OTHER track placement. A contiguous run shows one small number per
 * internal join and two large ones (the free ends).
 *
 * Usage: bun scripts/_coaster_track_gaps.ts <model.ldr>
 */
import { readFileSync } from 'node:fs';
import { parseLDrawDocument, type ParsedBrick } from '../web/src/engine/ldraw-parser.ts';
import { coasterTrackProfile } from '../web/src/engine/coaster-track.ts';
import { partStem } from '../web/src/engine/part-id.ts';

type V3 = [number, number, number];
const T = (b: ParsedBrick, p: readonly number[]): V3 => {
  const r = b.rot ?? [1, 0, 0, 0, 1, 0, 0, 0, 1];
  return [
    b.x + r[0]! * p[0]! + r[1]! * p[1]! + r[2]! * p[2]!,
    b.y + r[3]! * p[0]! + r[4]! * p[1]! + r[5]! * p[2]!,
    b.z + r[6]! * p[0]! + r[7]! * p[1]! + r[8]! * p[2]!,
  ];
};
const dist = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const fmt = (p: V3) => `(${p.map(v => +v.toFixed(1)).join(', ')})`;

const file = process.argv[2]!;
const bricks = parseLDrawDocument(readFileSync(file, 'latin1')).bricks;
const ends: { id: string; which: 'A' | 'B'; p: V3; y: number }[] = [];
bricks.forEach((b, i) => {
  const prof = coasterTrackProfile(b.part);
  if (!prof) return;
  ends.push({ id: `${prof.partId}#${i}`, which: 'A', p: T(b, prof.railSamples[0]!), y: b.y });
  ends.push({ id: `${prof.partId}#${i}`, which: 'B', p: T(b, prof.railSamples.at(-1)!), y: b.y });
});
console.log(`${file}: ${ends.length / 2} track placements`);
for (const e of ends.sort((a, b) => b.y - a.y)) {
  let best = Infinity, who = '';
  for (const o of ends) if (o.id !== e.id) { const d = dist(e.p, o.p); if (d < best) { best = d; who = `${o.id}${o.which}`; } }
  console.log(`  ${e.id.padEnd(12)}${e.which} ${fmt(e.p).padEnd(28)} nearest ${who.padEnd(14)} ${best.toFixed(2).padStart(8)} LDU`);
}
// Where the cart's wheels sit relative to the running line of the piece under them.
const wheels = bricks.filter(b => partStem(b.part) === '24869');
for (const w of wheels) {
  let best = Infinity, tag = '';
  for (const b of bricks) {
    const prof = coasterTrackProfile(b.part);
    if (!prof) continue;
    for (const s of prof.samples) { const d = dist([w.x, w.y, w.z], T(b, s)); if (d < best) { best = d; tag = prof.partId; } }
  }
  console.log(`  wheel 24869 at (${w.x}, ${w.y}, ${w.z}): ${best.toFixed(1)} LDU from the ${tag} running line`);
}
