/**
 * Would ROTATED facets beat axis-aligned microcells on round parts?
 *
 * The project's own ladder says axis-aligned voxels are at their asymptote on
 * 10303: uniform 4 LDU is 50.9k cuboids at IoU 0.949, 2 LDU is 142k at 0.967,
 * 1 LDU is 316k at 0.977 — 2.2x the cuboids for +0.010. The residual is
 * round-vs-square error that no grain removes, which is why round bricks read
 * as squares up close. `studCuboids` already answers this for STUDS: `facets`
 * equal rectangles fanned about the axis, each spanning the disc's diameter,
 * giving a 4*facets-sided outline from `facets` cuboids.
 *
 * This measures that construction against the real thing before any of it is
 * built into the compiler: for each round part, the six-view silhouette IoU
 * and cuboid count of the fanned representation versus the microcell
 * prototypes at 2/4/8 LDU.
 *
 * Both sides are rasterised through `silhouetteReference`, so the comparison
 * uses the SAME rule as the planner's own metric. The fanned union spans the
 * full diameter along each rectangle's length, so it shares the part's bounding
 * box and therefore its raster resolution — the bitmaps are comparable pixel
 * for pixel.
 *
 * Usage: bun scripts/_round_facet_probe.ts [part…]
 * Output: output/round-facet-probe.json (gitignored `output/`).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { setLDrawRoot } from '../web/src/engine/ldraw-geometry.ts';
import { createPartGeometryProvider, type LdrawPartMesh, type LdrawTriangle, type Vec3 } from '../web/src/engine/ldraw-part-geometry.ts';
import { createPrototypeCache, resolveEntityQuality, silhouetteReference } from '../web/src/engine/ldraw-part-prototype.ts';

setLDrawRoot('C:/git/clego/extracted/studio_release/app/ldraw');

/** Round moulds the complaint names, with the axis their disc turns about. */
const DEFAULT_PARTS: ReadonlyArray<readonly [string, 0 | 1 | 2, string]> = [
  ['3062b', 1, 'Brick 1 x 1 Round'],
  ['4073', 1, 'Plate 1 x 1 Round'],
  ['3941', 1, 'Brick 2 x 2 Round'],
  ['6143', 1, 'Brick 2 x 2 Round (open stud)'],
  ['85861', 1, 'Plate 1 x 1 Round with Open Stud'],
  ['3957', 1, 'Antenna 4H'],
  ['24869', 0, 'Wheels Roller Coaster (axle along X)'],
];

const FACET_COUNTS = [2, 3, 4, 6];
const GRAINS = [2, 4, 8];

const box = (min: Vec3, max: Vec3): LdrawTriangle[] => {
  const [x0, y0, z0] = min, [x1, y1, z1] = max;
  const v = (x: number, y: number, z: number): Vec3 => [x, y, z];
  const quad = (a: Vec3, b: Vec3, c: Vec3, d: Vec3): LdrawTriangle[] =>
    [{ a, b, c, color: 16 }, { a, b: c, c: d, color: 16 }];
  return [
    ...quad(v(x0, y0, z0), v(x1, y0, z0), v(x1, y0, z1), v(x0, y0, z1)),
    ...quad(v(x0, y1, z0), v(x1, y1, z0), v(x1, y1, z1), v(x0, y1, z1)),
    ...quad(v(x0, y0, z0), v(x1, y0, z0), v(x1, y1, z0), v(x0, y1, z0)),
    ...quad(v(x0, y0, z1), v(x1, y0, z1), v(x1, y1, z1), v(x0, y1, z1)),
    ...quad(v(x0, y0, z0), v(x0, y0, z1), v(x0, y1, z1), v(x0, y1, z0)),
    ...quad(v(x1, y0, z0), v(x1, y0, z1), v(x1, y1, z1), v(x1, y1, z0)),
  ];
};

/** Rotate a point about `axis` by `deg`, around the part-local origin `centre`. */
function rotateAbout(p: Vec3, axis: 0 | 1 | 2, deg: number, centre: Vec3): Vec3 {
  const t = deg * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
  const d: Vec3 = [p[0] - centre[0], p[1] - centre[1], p[2] - centre[2]];
  // The two coordinates the disc turns in (everything but `axis`).
  const [i, j] = axis === 0 ? [1, 2] : axis === 1 ? [0, 2] : [0, 1];
  const out: Vec3 = [...d] as Vec3;
  out[i] = d[i]! * c - d[j]! * s;
  out[j] = d[i]! * s + d[j]! * c;
  return [out[0] + centre[0], out[1] + centre[1], out[2] + centre[2]];
}

/**
 * The fanned representation: `facets` boxes, each spanning the full diameter
 * along one in-plane axis and 2*r*sin(pi/(2*facets)) across, rotated by
 * k*180/facets. Exactly what `studCuboids` emits for a stud.
 */
function facetMesh(partId: string, mesh: LdrawPartMesh, axis: 0 | 1 | 2, facets: number): LdrawPartMesh {
  const { min, max } = mesh.bounds;
  const centre: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const [i, j] = axis === 0 ? [1, 2] : axis === 1 ? [0, 2] : [0, 1];
  const r = Math.min(max[i]! - min[i]!, max[j]! - min[j]!) / 2;
  const hl = r, hw = r * Math.sin(Math.PI / (2 * facets));

  const triangles: LdrawTriangle[] = [];
  for (let k = 0; k < facets; k++) {
    const lo: Vec3 = [...centre] as Vec3, hi: Vec3 = [...centre] as Vec3;
    lo[axis] = min[axis]!; hi[axis] = max[axis]!;
    lo[i] = centre[i]! - hl; hi[i] = centre[i]! + hl;
    lo[j] = centre[j]! - hw; hi[j] = centre[j]! + hw;
    const deg = k * 180 / facets;
    for (const tri of box(lo, hi)) {
      triangles.push({
        a: rotateAbout(tri.a, axis, deg, centre),
        b: rotateAbout(tri.b, axis, deg, centre),
        c: rotateAbout(tri.c, axis, deg, centre),
        color: 16,
      });
    }
  }
  return { partId, resolvedAs: partId, triangles, studs: [], bounds: { min: [...min], max: [...max] }, unresolvedRefs: [], description: '' };
}

/** Mean six-view IoU between two silhouette references rasterised at the same resolution. */
function bitmapIoU(a: ReturnType<typeof silhouetteReference>, b: ReturnType<typeof silhouetteReference>): number {
  if (a.px !== b.px) throw new Error(`raster mismatch ${a.px} vs ${b.px}`);
  let sum = 0;
  for (let v = 0; v < a.bitmaps.length; v++) {
    const x = a.bitmaps[v]!, y = b.bitmaps[v]!;
    let inter = 0, union = 0;
    for (let n = 0; n < x.length; n++) { if (x[n]! && y[n]!) inter++; if (x[n]! || y[n]!) union++; }
    sum += union ? inter / union : 1;
  }
  return sum / a.bitmaps.length;
}

const parts = process.argv.slice(2).filter(a => !a.startsWith('--'));
const targets = parts.length
  ? parts.map(p => [p, 1, ''] as readonly [string, 0 | 1 | 2, string])
  : DEFAULT_PARTS;

const provider = createPartGeometryProvider({});
const cache = createPrototypeCache();
const base = resolveEntityQuality('balanced');
const rows: unknown[] = [];

console.log('part      label                          voxel (cuboids @ IoU)                    facets (cuboids @ IoU)');
for (const [part, axis, label] of targets) {
  const mesh = await provider.getPartMesh(`${part}.dat`);
  if (!mesh?.triangles.length) { console.log(`${part.padEnd(10)}unresolved`); continue; }
  const ref = silhouetteReference(mesh);

  const voxel: Record<string, { cuboids: number; iou: number }> = {};
  for (const grain of GRAINS) {
    const proto = cache.get(mesh, { ...base, microcellLdu: grain }, { hollow: false, decomposition: 'best-of' });
    // Rasterise the prototype's boxes the same way, so both sides use one rule.
    const asMesh: LdrawPartMesh = {
      partId: part, resolvedAs: part, studs: [], unresolvedRefs: [], description: '',
      bounds: { min: [...mesh.bounds.min], max: [...mesh.bounds.max] },
      triangles: proto.cuboids.flatMap(c => box(c.min as Vec3, c.max as Vec3)),
    };
    voxel[String(grain)] = { cuboids: proto.cuboids.length, iou: +bitmapIoU(ref, silhouetteReference(asMesh)).toFixed(4) };
  }

  const facets: Record<string, { cuboids: number; iou: number }> = {};
  for (const k of FACET_COUNTS) {
    facets[String(k)] = { cuboids: k, iou: +bitmapIoU(ref, silhouetteReference(facetMesh(part, mesh, axis, k))).toFixed(4) };
  }

  rows.push({ part, label, axis, voxel, facets });
  const vs = GRAINS.map(g => `${String(voxel[String(g)]!.cuboids).padStart(4)}@${voxel[String(g)]!.iou.toFixed(3)}`).join(' ');
  const fs = FACET_COUNTS.map(k => `${String(k).padStart(2)}@${facets[String(k)]!.iou.toFixed(3)}`).join(' ');
  console.log(`${part.padEnd(10)}${label.slice(0, 30).padEnd(31)}${vs}    ${fs}`);
}

mkdirSync('output', { recursive: true });
writeFileSync('output/round-facet-probe.json', JSON.stringify({ grains: GRAINS, facetCounts: FACET_COUNTS, rows }, null, 1));
console.log('\nvoxel columns are 2/4/8 LDU; facet columns are 2/3/4/6 rotated boxes.');
console.log('wrote output/round-facet-probe.json');
