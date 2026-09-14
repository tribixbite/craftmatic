import { describe, expect, it } from 'vitest';
import type { LdrawPartMesh, LdrawTriangle, Vec3 } from '../web/src/engine/ldraw-part-geometry.js';
import {
  LEGO_ENTITY_QUALITY, compilePartPrototype, createPrototypeCache, resolveEntityQuality, triangleBoxOverlap,
} from '../web/src/engine/ldraw-part-prototype.js';

// ─── Synthetic meshes (part-local LDU, LDraw −Y up) ───────────────────────────

const quad = (a: Vec3, b: Vec3, c: Vec3, d: Vec3, color = 16): LdrawTriangle[] => [
  { a, b, c, color }, { a, b: c, c: d, color },
];

function mesh(partId: string, triangles: LdrawTriangle[], studs: LdrawPartMesh['studs'] = []): LdrawPartMesh {
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const t of triangles) for (const v of [t.a, t.b, t.c]) for (let i = 0; i < 3; i++) {
    min[i] = Math.min(min[i]!, v[i]!); max[i] = Math.max(max[i]!, v[i]!);
  }
  return { partId, resolvedAs: partId, triangles, studs, bounds: { min, max }, unresolvedRefs: [] };
}

/** Axis-aligned box [x0,x1]×[y0,y1]×[z0,z1]; `faces` selects which of the six to emit. */
function box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, faces = 'xXyYzZ', color = 16): LdrawTriangle[] {
  const t: LdrawTriangle[] = [];
  if (faces.includes('y')) t.push(...quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], color)); // top (min Y)
  if (faces.includes('Y')) t.push(...quad([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1], color)); // bottom
  if (faces.includes('z')) t.push(...quad([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], color));
  if (faces.includes('Z')) t.push(...quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], color));
  if (faces.includes('x')) t.push(...quad([x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1], color));
  if (faces.includes('X')) t.push(...quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], color));
  return t;
}

/** 2×1 45° slope: 40 long (Z), 24 tall, 20 wide; high end at z=0, ramp down to z=40. Open bottom. */
function slope(): LdrawTriangle[] {
  const t: LdrawTriangle[] = [];
  t.push(...quad([-10, -24, 0], [10, -24, 0], [10, 0, 0], [-10, 0, 0]));            // back wall (z=0), full height
  t.push(...quad([-10, -24, 0], [10, -24, 0], [10, 0, 40], [-10, 0, 40]));          // the slanted face
  t.push({ a: [-10, -24, 0], b: [-10, 0, 0], c: [-10, 0, 40], color: 16 });       // side triangles
  t.push({ a: [10, -24, 0], b: [10, 0, 0], c: [10, 0, 40], color: 16 });
  return t;
}

/** Cylinder of radius r along X from x0 to x1 (a wheel), closed ends. */
function cylinderX(r: number, x0: number, x1: number, segments = 24): LdrawTriangle[] {
  const t: LdrawTriangle[] = [];
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2, a1 = ((i + 1) / segments) * Math.PI * 2;
    const p0: Vec3 = [x0, r * Math.cos(a0), r * Math.sin(a0)], p1: Vec3 = [x0, r * Math.cos(a1), r * Math.sin(a1)];
    const q0: Vec3 = [x1, r * Math.cos(a0), r * Math.sin(a0)], q1: Vec3 = [x1, r * Math.cos(a1), r * Math.sin(a1)];
    t.push(...quad(p0, p1, q1, q0));
    t.push({ a: [x0, 0, 0], b: p0, c: p1, color: 16 }, { a: [x1, 0, 0], b: q0, c: q1, color: 16 });
  }
  return t;
}

/** Flat wedge plate: right triangle footprint (x,z) ∈ {x≥0, z≥0, x+z≤40}, 8 tall, open bottom. */
function wedge(): LdrawTriangle[] {
  return [
    { a: [0, -8, 0], b: [40, -8, 0], c: [0, -8, 40], color: 16 },                         // top
    ...quad([0, -8, 0], [40, -8, 0], [40, 0, 0], [0, 0, 0]),                              // z=0 side
    ...quad([0, -8, 0], [0, -8, 40], [0, 0, 40], [0, 0, 0]),                              // x=0 side
    ...quad([40, -8, 0], [0, -8, 40], [0, 0, 40], [40, 0, 0]),                            // hypotenuse side
  ];
}

const Q = LEGO_ENTITY_QUALITY.balanced;
const volume = (c: { min: Vec3; max: Vec3 }): number => (c.max[0] - c.min[0]) * (c.max[1] - c.min[1]) * (c.max[2] - c.min[2]);
const aabbVolume = (p: { boundsLdu: { min: Vec3; max: Vec3 } }): number => volume(p.boundsLdu);
const inside = (c: { min: Vec3; max: Vec3 }, b: { min: Vec3; max: Vec3 }): boolean =>
  c.min.every((v, i) => v >= b.min[i]! - 1e-9) && c.max.every((v, i) => v <= b.max[i]! + 1e-9);

describe('triangleBoxOverlap', () => {
  it('detects crossing, touching and separated triangles', () => {
    expect(triangleBoxOverlap(-5, -5, 0, 5, -5, 0, 0, 5, 0, 1, 1, 1)).toBe(true);   // plane through the box
    expect(triangleBoxOverlap(-5, -5, 3, 5, -5, 3, 0, 5, 3, 1, 1, 1)).toBe(false);  // parallel plane outside
    expect(triangleBoxOverlap(-5, -5, 1, 5, -5, 1, 0, 5, 1, 1, 1, 1)).toBe(true);   // touching the face
    expect(triangleBoxOverlap(2, 2, 2, 3, 2, 2, 2, 3, 2, 1, 1, 1)).toBe(false);     // small triangle away
    expect(triangleBoxOverlap(1.5, 1.5, 0, 3, -3, 0, -3, 3, 0, 1, 1, 1)).toBe(true); // big triangle around a corner
  });
});

describe('compilePartPrototype', () => {
  it('compiles a closed box to exactly one cuboid equal to its AABB', () => {
    const p = compilePartPrototype(mesh('box', box(-10, 10, -24, 0, -10, 10)), Q);
    expect(p.source).toBe('exact-box');
    expect(p.cuboids).toEqual([{ min: [-10, -24, -10], max: [10, 0, 10], color: 16 }]);
    expect(p.metrics.fill).toBe(1);
  });

  it('fills an OPEN-BOTTOM box solid (LDraw parts have no underside face)', () => {
    const p = compilePartPrototype(mesh('brick', box(-20, 20, -24, 0, -10, 10, 'xXyzZ')), Q);
    expect(p.source).toBe('exact-box');
    expect(p.cuboids).toHaveLength(1);
  });

  it('keeps a through-hole open: a bore reachable from a side is air', () => {
    // A 40×40×40 block with a 12-wide square tunnel along X, open at both ends.
    const t: LdrawTriangle[] = [
      ...box(-20, 20, -40, 0, -20, 20, 'yYzZ'),
      // x faces with the tunnel cut out are approximated by four quads each
      ...quad([-20, -40, -20], [-20, -40, 20], [-20, -26, 20], [-20, -26, -20]), ...quad([-20, -14, -20], [-20, -14, 20], [-20, 0, 20], [-20, 0, -20]),
      ...quad([-20, -26, -20], [-20, -26, -6], [-20, -14, -6], [-20, -14, -20]), ...quad([-20, -26, 6], [-20, -26, 20], [-20, -14, 20], [-20, -14, 6]),
      ...quad([20, -40, -20], [20, -40, 20], [20, -26, 20], [20, -26, -20]), ...quad([20, -14, -20], [20, -14, 20], [20, 0, 20], [20, 0, -20]),
      ...quad([20, -26, -20], [20, -26, -6], [20, -14, -6], [20, -14, -20]), ...quad([20, -26, 6], [20, -26, 20], [20, -14, 20], [20, -14, 6]),
      // tunnel walls
      ...box(-20, 20, -26, -14, -6, 6, 'yYzZ'),
    ];
    const p = compilePartPrototype(mesh('tunnel', t), Q);
    expect(p.source).toBe('mesh-decomposition');
    const solid = p.cuboids.reduce((n, c) => n + volume(c), 0);
    // The 12-LDU bore quantises to 8 LDU at a 4-LDU microcell (a half-covered
    // cell is solid), so the air is 8×8×40 of 40×40×40: 4 % of the volume.
    expect(solid).toBe(aabbVolume(p) - 8 * 8 * 40);
    // …and the tunnel runs the whole length: no cuboid crosses the bore.
    for (const c of p.cuboids) {
      const crossesBore = c.min[1] < -14 && c.max[1] > -26 && c.min[2] < 6 && c.max[2] > -6;
      if (crossesBore) expect(c.min[1] >= -22 || c.max[1] <= -18 || c.min[2] >= -2 || c.max[2] <= 2).toBe(true);
    }
  });

  it('decomposes a 45° slope into a stair, not its AABB', () => {
    const p = compilePartPrototype(mesh('slope', slope()), Q);
    expect(p.source).toBe('mesh-decomposition');
    expect(p.cuboids.length).toBeGreaterThan(3);
    for (const c of p.cuboids) expect(inside(c, p.boundsLdu)).toBe(true);
    expect(p.cuboids.some(c => volume(c) === aabbVolume(p))).toBe(false);
    const fill = p.cuboids.reduce((n, c) => n + volume(c), 0) / aabbVolume(p);
    expect(fill).toBeGreaterThan(0.4);
    expect(fill).toBeLessThan(0.65);
    expect(p.boundsLdu).toEqual({ min: [-10, -24, 0], max: [10, 0, 40] });
  });

  it('decomposes a wheel (cylinder) into a round-ish stack, bounds exact', () => {
    const p = compilePartPrototype(mesh('wheel', cylinderX(24, -12, 12)), Q);
    expect(p.source).toBe('mesh-decomposition');
    expect(p.cuboids.length).toBeGreaterThan(4);
    expect(p.cuboids.length).toBeLessThanOrEqual(Q.maxPartCubes);
    const fill = p.cuboids.reduce((n, c) => n + volume(c), 0) / aabbVolume(p);
    expect(fill).toBeGreaterThan(0.7);
    expect(fill).toBeLessThan(0.9);
    expect(p.boundsLdu.min[1]).toBeCloseTo(-24, 6);
    expect(p.boundsLdu.max[2]).toBeCloseTo(24, 6);
  });

  it('decomposes a triangular wedge plate', () => {
    const p = compilePartPrototype(mesh('wedge', wedge()), Q);
    expect(p.source).toBe('mesh-decomposition');
    const fill = p.cuboids.reduce((n, c) => n + volume(c), 0) / aabbVolume(p);
    expect(fill).toBeGreaterThan(0.45);
    expect(fill).toBeLessThan(0.65);
  });

  it('keeps a translucent part as a shell when hollow', () => {
    const solid = compilePartPrototype(mesh('canopy', box(-20, 20, -24, 0, -20, 20, 'xXyzZ')), Q);
    const shell = compilePartPrototype(mesh('canopy', box(-20, 20, -24, 0, -20, 20, 'xXyzZ')), Q, { hollow: true });
    expect(solid.cuboids).toHaveLength(1);
    expect(shell.hollow).toBe(true);
    expect(shell.cuboids.length).toBeGreaterThan(1);
    expect(shell.metrics.fill).toBeLessThan(0.6);
  });

  it('gives a printed face its own cuboids in the explicit colour', () => {
    const t = [...box(-10, 10, -24, 0, -10, 10), ...quad([-8, -20, -10], [8, -20, -10], [8, -4, -10], [-8, -4, -10], 4)];
    const p = compilePartPrototype(mesh('printed', t), Q);
    const colors = new Set(p.cuboids.map(c => c.color));
    expect(colors.has(4)).toBe(true);
    expect(colors.has(16)).toBe(true);
    const red = p.cuboids.filter(c => c.color === 4);
    // The print sits on the z=-10 face only.
    for (const c of red) expect(c.min[2]).toBe(-10);
  });

  it('respects the part budget by coarsening, then falls back to the AABB with a reason', () => {
    const wheel = mesh('wheel', cylinderX(24, -12, 12));
    const tight = compilePartPrototype(wheel, { ...Q, maxPartCubes: 6 });
    expect(tight.metrics.coarsened).toBeGreaterThan(0);
    expect(tight.cuboids.length).toBeLessThanOrEqual(6);
    const impossible = compilePartPrototype(wheel, { ...Q, maxPartCubes: 1 });
    expect(impossible.source).toBe('aabb-fallback');
    expect(impossible.cuboids).toHaveLength(1);
    expect(impossible.cuboids[0]!.min).toEqual(wheel.bounds.min);
  });

  it('passes studs through and reports an empty part explicitly', () => {
    const stud = { center: [0, -24, 0] as Vec3, up: [0, -1, 0] as Vec3, radius: 6, height: 4 };
    const p = compilePartPrototype(mesh('brick', box(-10, 10, -24, 0, -10, 10), [stud]), Q);
    expect(p.studs).toEqual([stud]);
    const empty = compilePartPrototype({ ...mesh('nothing', []), bounds: { min: [0, 0, 0], max: [0, 0, 0] } }, Q);
    expect(empty.source).toBe('empty');
    expect(empty.cuboids).toEqual([]);
  });

  it('is deterministic and the cache instances once per (part, quality, hollow)', () => {
    const a = compilePartPrototype(mesh('slope', slope()), Q);
    const b = compilePartPrototype(mesh('slope', slope()), Q);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const cache = createPrototypeCache();
    const m = mesh('slope', slope());
    const first = cache.get(m, Q);
    expect(cache.get(m, Q)).toBe(first);
    expect(cache.get(m, Q, { hollow: true })).not.toBe(first);
    expect(cache.get(m, LEGO_ENTITY_QUALITY.high)).not.toBe(first);
    expect(cache.size).toBe(3);
    expect(cache.hits).toBe(1);
  });

  it('resolves quality names and partial overrides', () => {
    expect(resolveEntityQuality()).toEqual(LEGO_ENTITY_QUALITY.balanced);
    expect(resolveEntityQuality('ultra').microcellLdu).toBe(1);
    expect(resolveEntityQuality({ maxModelCubes: 99 })).toEqual({ ...LEGO_ENTITY_QUALITY.balanced, maxModelCubes: 99 });
  });
});
