/**
 * How MANY pieces does a source fall into, by the add-on's own rule?
 *
 * `connectedClusters` (ldraw-entity-compiler) unions placed bricks whose world
 * AABBs come within 4 LDU, and the exporter warns when anything is left outside
 * the largest group: "they are loose in the SOURCE and will look like floating
 * pieces in game". On 76417 Gringotts that warning said 1,832 placements in 72
 * pieces and the device confirmed it — the model is visibly scattered — so the
 * question is which of a set's sources is actually coherent.
 *
 * Reported per source: the largest group's share of placements, the number of
 * groups, and how much is loose. A source whose largest group is ~100 % is one
 * build; anything less is that fraction of a model plus debris.
 *
 * Usage: bun scripts/_source_connectivity.ts <model…>
 */
import { readFileSync } from 'node:fs';
import { parseLDrawDocument } from '../web/src/engine/ldraw-parser.ts';
import { setLDrawRoot } from '../web/src/engine/ldraw-geometry.ts';
import { createPartGeometryProvider, type LdrawPartMesh, type Vec3 } from '../web/src/engine/ldraw-part-geometry.ts';
import { connectedClusters } from '../web/src/engine/ldraw-entity-compiler.ts';
import { extractIoLDraw } from '../web/src/engine/io-extractor.ts';

setLDrawRoot('C:/git/clego/extracted/studio_release/app/ldraw');

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];

for (const file of process.argv.slice(2).filter(a => !a.startsWith('--'))) {
  let bricks;
  try {
    if (/\.io$/i.test(file)) {
      // A `.io` is an encrypted zip carrying LDraw; the extractor unwraps it.
      const bytes = readFileSync(file);
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      bricks = parseLDrawDocument(await extractIoLDraw(buffer)).bricks;
    } else {
      bricks = parseLDrawDocument(readFileSync(file, 'utf8')).bricks;
    }
  } catch (err) {
    console.log(`${file}\n  unreadable: ${err instanceof Error ? err.message : String(err)}`);
    continue;
  }

  const provider = createPartGeometryProvider({});
  const meshes = new Map<string, LdrawPartMesh | null>();
  await Promise.all([...new Set(bricks.map(b => b.part))].map(async part => { meshes.set(part, await provider.getPartMesh(part)); }));

  // The same world AABB the compiler builds: the rotated part bounds at the
  // placement, so a part with no geometry contributes a point rather than
  // silently joining everything.
  const boxes = bricks.map(brick => {
    const mesh = meshes.get(brick.part);
    const R = brick.rot ?? IDENTITY;
    const t: Vec3 = [brick.x, brick.y, brick.z];
    // A part with no mesh OR no bounds contributes a point, never `undefined`:
    // a hole here reaches connectedClusters and throws on `.min`.
    if (!mesh?.bounds?.min || !mesh.bounds.max) return { min: t, max: t };
    const { min, max } = mesh.bounds;
    const lo: Vec3 = [Infinity, Infinity, Infinity], hi: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const corner of [[min[0], min[1], min[2]], [max[0], min[1], min[2]], [min[0], max[1], min[2]], [max[0], max[1], min[2]],
      [min[0], min[1], max[2]], [max[0], min[1], max[2]], [min[0], max[1], max[2]], [max[0], max[1], max[2]]] as Vec3[]) {
      for (let a = 0; a < 3; a++) {
        const v = R[a * 3]! * corner[0] + R[a * 3 + 1]! * corner[1] + R[a * 3 + 2]! * corner[2] + t[a]!;
        lo[a] = Math.min(lo[a]!, v); hi[a] = Math.max(hi[a]!, v);
      }
    }
    return { min: lo, max: hi };
  });

  const groups = connectedClusters(boxes);
  const largest = groups[0]?.length ?? 0;
  const loose = bricks.length - largest;
  const share = bricks.length ? largest / bricks.length : 0;
  const sizes = groups.slice(1, 6).map(g => g.length).join(', ');
  console.log(`${file.split(/[\\/]/).slice(-2).join('/')}`);
  console.log(`  ${bricks.length} placements, ${groups.length} piece(s); largest holds ${largest} (${(share * 100).toFixed(1)} %), ${loose} loose${sizes ? `  next: ${sizes}` : ''}`);
  // Where the big pieces SIT decides what this is: two sub-builds standing
  // apart are a legitimate display, whereas pieces sharing a volume are one
  // build that came apart in conversion.
  const boxOf = (group: readonly number[]) => {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const index of group) for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a]!, boxes[index]!.min[a]!);
      hi[a] = Math.max(hi[a]!, boxes[index]!.max[a]!);
    }
    return { lo, hi };
  };
  for (const [rank, group] of groups.slice(0, 3).entries()) {
    const b = boxOf(group);
    const size = [0, 1, 2].map(a => ((b.hi[a]! - b.lo[a]!) / 20).toFixed(1)).join(' x ');
    const centre = [0, 1, 2].map(a => ((b.hi[a]! + b.lo[a]!) / 40).toFixed(1)).join(', ');
    console.log(`    piece ${rank}: ${String(group.length).padStart(5)} parts  size ${size} studs  centre (${centre})`);
  }
  if (groups.length > 1) {
    const a = boxOf(groups[0]!), b = boxOf(groups[1]!);
    const overlap = [0, 1, 2].every(k => a.lo[k]! < b.hi[k]! && b.lo[k]! < a.hi[k]!);
    console.log(`    pieces 0 and 1 ${overlap ? 'OVERLAP in space (one build come apart)' : 'stand apart (two sub-builds)'}`);
  }

  // How far the SMALL pieces sit from the nearest big one. A fragment resting
  // against a wall it merely fails to touch within 4 LDU reads as part of the
  // model; one floating studs away is what a player calls a floating piece.
  const BIG = 200;
  const big = groups.filter(g => g.length >= BIG);
  const small = groups.filter(g => g.length < BIG);
  const gap = (group: readonly number[]): number => {
    let best = Infinity;
    for (const index of group) {
      const b = boxes[index]!;
      for (const other of big) for (const j of other) {
        const o = boxes[j]!;
        let d = 0;
        for (let a = 0; a < 3; a++) d += Math.max(0, Math.max(o.min[a]! - b.max[a]!, b.min[a]! - o.max[a]!)) ** 2;
        best = Math.min(best, Math.sqrt(d));
      }
    }
    return best;
  };
  if (small.length && big.length) {
    const gaps = small.map(g => ({ n: g.length, d: gap(g) })).sort((a, b) => b.d - a.d);
    const touching = gaps.filter(g => g.d <= 20).reduce((n, g) => n + g.n, 0);
    const adrift = gaps.filter(g => g.d > 20);
    console.log(`    ${small.length} small piece(s), ${small.reduce((n, g) => n + g.length, 0)} parts: ${touching} parts sit within a stud of a big piece; ${adrift.reduce((n, g) => n + g.n, 0)} parts in ${adrift.length} piece(s) float further`);
    for (const g of adrift.slice(0, 5)) console.log(`      ${String(g.n).padStart(4)} parts ${(g.d / 20).toFixed(1)} studs clear`);
  }
}
