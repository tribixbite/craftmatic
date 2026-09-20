import { describe, expect, it } from 'vitest';
import { BEDROCK_UNITS_PER_LDU, compileLdrawEntityGeometry, cullHiddenCuboids, cullHiddenCuboidsWithinBudget, CULL_CELL_LADDER, CULL_GRID_CELL_BUDGET, detachedClusters, eulerZYX, ldrawToRenderRotation, levelModel, mergeAlignedCuboids, snapSignedPermutation } from '../web/src/engine/ldraw-entity-compiler.js';
import { createPartGeometryProvider } from '../web/src/engine/ldraw-part-geometry.js';
import { LDRAW_COLOR_RGB } from '../web/src/engine/ldraw-colors.js';
import { SIZE_STEPS } from '../web/src/engine/bedrock-placement-pack.js';
import type { CompiledMesh } from '../web/src/engine/ldraw-entity-compiler.js';
import type { ParsedBrick } from '../web/src/engine/ldraw-parser.js';

// ─── A tiny synthetic library ─────────────────────────────────────────────────

const box6 = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, faces = 'xXyzZ'): string[] => {
  const q = (a: number[], b: number[], c: number[], d: number[]): string => `4 16 ${[...a, ...b, ...c, ...d].join(' ')}`;
  const out: string[] = [];
  if (faces.includes('y')) out.push(q([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]));
  if (faces.includes('Y')) out.push(q([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]));
  if (faces.includes('z')) out.push(q([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]));
  if (faces.includes('Z')) out.push(q([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]));
  if (faces.includes('x')) out.push(q([x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]));
  if (faces.includes('X')) out.push(q([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]));
  return out;
};
const LIBRARY: Record<string, string> = {
  // 1×1 brick: 20×24×20 with one top stud.
  '3005': ['0 Brick 1 x 1', ...box6(-10, 10, -24, 0, -10, 10), '1 16 0 -24 0 1 0 0 0 1 0 0 0 1 stud.dat'].join('\n'),
  // 2×4 brick: 80 long in X, 8 studs.
  '3001': ['0 Brick 2 x 4', ...box6(-40, 40, -24, 0, -20, 20),
    ...[-30, -10, 10, 30].flatMap(x => [-10, 10].map(z => `1 16 ${x} -24 ${z} 1 0 0 0 1 0 0 0 1 stud.dat`))].join('\n'),
  // 2×1 45° slope: back wall at z=-20 full height, ramp down to z=+20. Open bottom.
  '3040b': ['0 Slope Brick 45 2 x 1',
    '4 16 -10 -24 -20 10 -24 -20 10 0 -20 -10 0 -20',
    '4 16 -10 -24 -20 10 -24 -20 10 0 20 -10 0 20',
    '3 16 -10 -24 -20 -10 0 -20 -10 0 20',
    '3 16 10 -24 -20 10 0 -20 10 0 20'].join('\n'),
  // A 2-wide "windscreen": a thin vertical sheet.
  '3823': ['0 Windscreen', ...box6(-20, 20, -40, 0, -2, 2, 'xXyYzZ')].join('\n'),
  // 1x1x5 brick: 120 LDU tall, so one placement can span the wheel line.
  '2453': ['0 Brick 1 x 1 x 5', ...box6(-10, 10, -120, 0, -10, 10)].join('\n'),
  // A wheel rim the compiler recognises by id (WHEEL_PARTS): a flat 20 x 20 x 8 box.
  '56908': ['0 Wheel Rim', ...box6(-10, 10, -10, 10, -4, 4, 'xXyYzZ')].join('\n'),
  // A canopy the compiler recognises by DESCRIPTION (isCanopyMould): the plane rules key on it.
  '2507': ['0 Windscreen 10 x 4 x 2.333 Canopy', ...box6(-40, 40, -24, 0, -20, 20)].join('\n'),
};
const provider = () => createPartGeometryProvider({ fetchPartText: async id => LIBRARY[id.replace(/^.*\//, '')] ?? null });

type Geo = { 'minecraft:geometry': Array<{ description: { identifier: string; texture_width: number; texture_height: number }; bones: Array<{ name: string; pivot: number[]; rotation?: number[]; cubes: Array<{ origin: number[]; size: number[]; pivot?: number[]; rotation?: number[]; uv: [number, number] }> }> }> };
type Cube = { origin: number[]; size: number[]; pivot?: number[]; rotation?: number[]; uv: [number, number] };
const allCubes = (g: Geo) => g['minecraft:geometry'].flatMap(m => m.bones.flatMap(b => b.cubes.map(c => ({ ...(c as Cube), bone: b.name, mesh: m.description.identifier }))));
/**
 * The LDraw colour a cube renders as. Cubes carry BOX UV into a flat swatch, so
 * the colour is a property of the GEOMETRY the cube sits in, not of its UVs.
 */
const colorOf = (r: { meshes: CompiledMesh[] }, c: { mesh: string }): number => r.meshes.find(m => m.id === c.mesh)!.material.colorId;
// A stud cuboid is 4 LDU (1.2 units at 0.3 units/LDU) tall and no wider than the 12 LDU disc; nothing in the synthetic library is that thin.
const isStud = (c: { size: number[] }) => Math.abs(c.size[1]! - 1.2) < 1e-9 && Math.max(c.size[0]!, c.size[2]!) <= 3.6 + 1e-9;
const bodyCubes = (g: Geo) => allCubes(g).filter(c => !isStud(c));
const studCubes = (g: Geo) => allCubes(g).filter(isStud);

describe('frame helpers', () => {
  it('ldrawToRenderRotation is a proper rotation (det +1) for every nose', () => {
    for (const nose of ['+x', '-x', '+z', '-z'] as const) {
      const m = ldrawToRenderRotation(nose);
      const det = m[0]! * (m[4]! * m[8]! - m[5]! * m[7]!) - m[1]! * (m[3]! * m[8]! - m[5]! * m[6]!) + m[2]! * (m[3]! * m[7]! - m[4]! * m[6]!);
      expect(det).toBeCloseTo(1, 9);
      // LDraw "up" (−Y) always lands on render +Y; the nose lands on render −Z.
      expect([m[1], m[4], m[7]]).toEqual([0, -1, 0].map(v => v * 1));
      const noseVec = nose === '+x' ? [1, 0, 0] : nose === '-x' ? [-1, 0, 0] : nose === '+z' ? [0, 0, 1] : [0, 0, -1];
      const out = [0, 1, 2].map(r => m[r * 3]! * noseVec[0]! + m[r * 3 + 1]! * noseVec[1]! + m[r * 3 + 2]! * noseVec[2]!);
      expect(out).toEqual([0, 0, -1]);
    }
  });

  it('eulerZYX recomposes to the input matrix (M = Rz·Ry·Rx)', () => {
    const rx = (a: number) => [1, 0, 0, 0, Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a)];
    const ry = (a: number) => [Math.cos(a), 0, Math.sin(a), 0, 1, 0, -Math.sin(a), 0, Math.cos(a)];
    const rz = (a: number) => [Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a), 0, 0, 0, 1];
    const mul = (a: number[], b: number[]) => [0, 1, 2].flatMap(r => [0, 1, 2].map(c => a[r * 3]! * b[c]! + a[r * 3 + 1]! * b[3 + c]! + a[r * 3 + 2]! * b[6 + c]!));
    for (const [a, b, c] of [[20, -35, 50], [0, 0, 90], [-80, 10, 0], [45, 0, 0], [0, 89.9, 0]]) {
      const d = Math.PI / 180;
      const M = mul(mul(rz(c! * d), ry(b! * d)), rx(a! * d));
      const [ea, eb, ec] = eulerZYX(M);
      const back = mul(mul(rz(ec * d), ry(eb * d)), rx(ea * d));
      for (let i = 0; i < 9; i++) expect(back[i]).toBeCloseTo(M[i]!, 3);
    }
  });
});

describe('snapSignedPermutation', () => {
  it('snaps near-axis matrices and rejects real rotations', () => {
    expect(snapSignedPermutation([0.9999, 0.0001, 0, -0.0001, 0.9999, 0, 0, 0, 1.0001])).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    expect(snapSignedPermutation([0, 0, -1, 0, 1, 0, 1, 0, 0])).toEqual([0, 0, -1, 0, 1, 0, 1, 0, 0]);
    const a = 5 * Math.PI / 180;
    expect(snapSignedPermutation([Math.cos(a), 0, Math.sin(a), 0, 1, 0, -Math.sin(a), 0, Math.cos(a)])).toBeNull();
    // Two rows claiming the same column is not a permutation.
    expect(snapSignedPermutation([1, 0, 0, 1, 0, 0, 0, 0, 1])).toBeNull();
  });
});

describe('compileLdrawEntityGeometry', () => {
  it('instances a box part as ONE cuboid of exact size with exact LDraw colour', async () => {
    const bricks: ParsedBrick[] = [{ part: '3001.dat', color: 4, x: 0, y: 0, z: 0 }];
    const r = await compileLdrawEntityGeometry('t', 'car', bricks, { partGeometry: provider(), facing: '+z' });
    const cubes = bodyCubes(r.value as Geo);
    expect(cubes).toHaveLength(1);
    // 80×24×40 LDU → 24 × 7.2 × 12 units (0.3 units/LDU), floor at y=0, centred in X/Z.
    expect(cubes[0]!.size).toEqual([24, 7.2, 12]);
    expect(cubes[0]!.origin).toEqual([-12, 0, -6]);
    expect(r.materials).toHaveLength(1);
    const hex = '#' + r.materials[0]!.rgb.map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();
    expect(hex).toBe(LDRAW_COLOR_RGB[4]);
    // Eight exposed studs × four facets each.
    expect(r.diagnostics).toMatchObject({ sourcePartCount: 1, uniquePartCount: 1, resolvedPartCount: 1, unresolvedParts: [], aabbFallbackParts: [], studCubeCount: 32, studFacets: 4, rotatedBoneCount: 0, leveled: null, cockpit: { source: 'default-cabin' } });
    expect(r.meshIds).toEqual(['geometry.craftmatic.t_mesh_0']);
  });

  it('places the model in a right-handed frame: LDraw +X is the entity\'s right, nose to −Z, mirrored into JSON', async () => {
    // A 2×4 brick at the origin, a 1×1 brick at LDraw +X, another at the nose (+Z).
    const bricks: ParsedBrick[] = [
      { part: '3001.dat', color: 15, x: 0, y: 0, z: 0 },
      { part: '3005.dat', color: 4, x: 100, y: 0, z: 0 },   // right
      { part: '3005.dat', color: 1, x: 0, y: 0, z: 100 },   // nose
    ];
    const r = await compileLdrawEntityGeometry('t', 'car', bricks, { partGeometry: provider(), facing: '+z' });
    const body = bodyCubes(r.value as Geo);
    const red = body.find(c => colorOf(r, c) === 4)!;
    const blue = body.find(c => colorOf(r, c) === 1)!;
    const white = body.find(c => colorOf(r, c) === 15)!;
    // Render frame: red at +X → JSON origin.x is NEGATIVE (mirror) and less than the white brick's.
    expect(red.origin[0]! + red.size[0]! / 2).toBeLessThan(white.origin[0]! + white.size[0]! / 2);
    // Nose (+Z LDraw) → −Z in JSON.
    expect(blue.origin[2]! + blue.size[2]! / 2).toBeLessThan(white.origin[2]! + white.size[2]! / 2);
    // Everything sits on the floor.
    expect(Math.min(...body.map(c => c.origin[1]!))).toBe(0);
  });

  it('keeps the same physical layout for an X-longitudinal car (nose +X → −Z)', async () => {
    const bricks: ParsedBrick[] = [
      { part: '3001.dat', color: 15, x: 0, y: 0, z: 0 },
      { part: '3005.dat', color: 1, x: 100, y: 0, z: 0 },   // nose at +X
      { part: '3005.dat', color: 4, x: 0, y: 0, z: -100 },  // LDraw −Z: with nose +X, the right side is −Z? no — right = nose × up
    ];
    const r = await compileLdrawEntityGeometry('t', 'car', bricks, { partGeometry: provider(), facing: '+x' });
    const body = bodyCubes(r.value as Geo);
    const blue = body.find(c => colorOf(r, c) === 1)!, white = body.find(c => colorOf(r, c) === 15)!, red = body.find(c => colorOf(r, c) === 4)!;
    expect(blue.origin[2]! + blue.size[2]! / 2).toBeLessThan(white.origin[2]! + white.size[2]! / 2);
    // For nose +X in LDraw (Y down), the model's right-hand side is LDraw −Z:
    // right = nose × up = (+X) × (−Y) = −Z. So the red brick is on the right → JSON −X.
    expect(red.origin[0]! + red.size[0]! / 2).toBeLessThan(white.origin[0]! + white.size[0]! / 2);
  });

  it('emits studs only where nothing sits on them', async () => {
    const bricks: ParsedBrick[] = [
      { part: '3005.dat', color: 4, x: 0, y: 0, z: 0 },
      { part: '3005.dat', color: 1, x: 0, y: -24, z: 0 }, // stacked on top: covers the red stud
      { part: '3005.dat', color: 14, x: 40, y: 0, z: 0 }, // free-standing: exposed
    ];
    const r = await compileLdrawEntityGeometry('t', 'car', bricks, { partGeometry: provider(), facing: '+z' });
    // Two exposed studs, four facets each; the covered red stud is gone.
    expect(r.diagnostics.studCubeCount).toBe(8);
    const studs = studCubes(r.value as Geo);
    expect(studs).toHaveLength(8);
    expect([...new Set(studs.map(s => colorOf(r, s)))].sort()).toEqual([1, 14]);
  });

  it('fans each exposed stud into rotated facets whose corners lie on the stud circle', async () => {
    const bricks: ParsedBrick[] = [{ part: '3005.dat', color: 4, x: 0, y: 0, z: 0 }];
    const r = await compileLdrawEntityGeometry('t', 'car', bricks, { partGeometry: provider(), facing: '+z' });
    const studs = studCubes(r.value as Geo);
    expect(studs).toHaveLength(4);
    // Facet: 2·6·cos(22.5°) = 11.09 LDU long, 2·6·sin(22.5°) = 4.59 LDU wide, 4 LDU tall → units ×0.3.
    for (const c of studs) expect(c.size).toEqual([1.38, 1.2, 3.33]); // long side along Z before rotation
    const rotations = studs.map(c => c.rotation?.[1] ?? 0).sort((a, b) => a - b);
    // Bedrock's frame negates the Y angle: 0, −45, −90, −135.
    expect(rotations).toEqual([-135, -90, -45, 0]);
    // Every rotated facet pivots on the stud axis, on the brick's top face.
    const pivots = studs.filter(c => c.rotation).map(c => c.pivot!.join(','));
    expect(new Set(pivots).size).toBe(1);
    expect(studs.find(c => c.rotation)!.pivot).toEqual([0, 7.2, 0]);
    // One flat colour on every face (box UV into the stud's own swatch), so the
    // coplanar facet tops cannot z-fight and all four sit in one geometry.
    for (const c of studs) expect(c.uv).toEqual([0, 0]);
    expect(new Set(studs.map(c => c.mesh)).size).toBe(1);
  });

  it('snaps float-noise rotations to the exact axis frame instead of spending a bone', async () => {
    const bricks: ParsedBrick[] = [
      { part: '3001.dat', color: 4, x: 0, y: 0, z: 0, rot: [0.9999, 0.0001, 0, -0.0001, 0.9999, 0, 0, 0, 1.0001] },
      { part: '3005.dat', color: 1, x: 100, y: 0, z: 0, rot: [0, 0, 1, 0, 1, 0, -1, 0, 0.0002] },
    ];
    const r = await compileLdrawEntityGeometry('t', 'car', bricks, { partGeometry: provider(), facing: '+z' });
    expect(r.diagnostics.rotatedBoneCount).toBe(0);
    expect(bodyCubes(r.value as Geo).every(c => c.bone === 'body')).toBe(true);
  });

  it('levels a posed source: a 19°-yawed model comes out axis-aligned with the pose recorded', async () => {
    const yaw = 19 * Math.PI / 180, c = Math.cos(yaw), s = Math.sin(yaw);
    const rot = [c, 0, s, 0, 1, 0, -s, 0, c];
    // Twelve 1×1 bricks in a row along the model's own X, then the whole row turned by the pose.
    const bricks: ParsedBrick[] = Array.from({ length: 12 }, (_, i) => {
      const x = i * 20 - 110, z = 0;
      return { part: '3005.dat', color: 4, x: c * x + s * z, y: 0, z: -s * x + c * z, rot: [...rot] };
    });
    const r = await compileLdrawEntityGeometry('t', 'car', bricks, { partGeometry: provider(), facing: '+x' });
    expect(r.diagnostics.leveled).toMatchObject({ alignedBefore: 0, alignedAfter: 12 });
    expect(r.diagnostics.leveled!.angleDeg).toBeCloseTo(19, 1);
    expect(r.diagnostics.rotatedBoneCount).toBe(0);
    expect(r.transform.level).toBeDefined();
    // Nose +X → the row runs along JSON Z; twelve same-colour face-adjacent bricks merge into ONE box spanning them.
    const body = bodyCubes(r.value as Geo);
    expect(body).toHaveLength(1);
    expect(r.diagnostics.mergedCubes).toBe(11);
    expect(body[0]!.size[2]).toBeCloseTo(12 * 6, 1);
    expect(body[0]!.size[0]).toBeCloseTo(6, 1);
  });

  it('drops separate objects beside the vehicle on real part bounds, keeps what touches or sits inside it', async () => {
    // A 20-brick row (touching end to end), a stacked brick on it, a 3-brick "driver" standing far away, a lone brick far away.
    const row: ParsedBrick[] = Array.from({ length: 20 }, (_, i) => ({ part: '3001.dat', color: 4, x: i * 80, y: 0, z: 0 }));
    const seated: ParsedBrick = { part: '3005.dat', color: 1, x: 0, y: -24, z: 0 };
    const driver: ParsedBrick[] = [0, -24, -48].map(y => ({ part: '3005.dat', color: 14, x: 5000, y, z: 0 }));
    const lone: ParsedBrick = { part: '3005.dat', color: 15, x: -3000, y: 0, z: 0 };
    const r = await compileLdrawEntityGeometry('t', 'car', [...row, seated, ...driver, lone], { partGeometry: provider(), facing: '+x' });
    expect(r.diagnostics.detached).toEqual({ placements: 4, groups: 2 });
    // The 20 red bricks merge into one box; the blue seated brick stays its own.
    expect(bodyCubes(r.value as Geo)).toHaveLength(2);
    expect(r.diagnostics.mergedCubes).toBe(19);
    expect(r.warnings.some(w => /4 placements in 2 separate objects/.test(w))).toBe(true);
    // A piece floating INSIDE the body (between two decks that do not touch each other) is kept:
    // it is a source defect to render as-is, not a separate object.
    const upper: ParsedBrick[] = row.map(b => ({ ...b, y: -72 }));
    const floating: ParsedBrick = { part: '3005.dat', color: 15, x: 800, y: -34, z: 0 };
    const r2 = await compileLdrawEntityGeometry('t', 'car', [...row, ...upper, floating], { partGeometry: provider(), facing: '+x' });
    expect(r2.diagnostics.detached).toEqual({ placements: 0, groups: 0 });
    expect(bodyCubes(r2.value as Geo)).toHaveLength(3); // lower row, upper row, the floating white brick
  });

  it('detachedClusters keeps two similar-sized vehicles', () => {
    const box = (x: number): { min: [number, number, number]; max: [number, number, number] } => ({ min: [x - 40, -24, -20], max: [x + 40, 0, 20] });
    const boxes = [...Array.from({ length: 20 }, (_, i) => box(i * 80)), ...Array.from({ length: 16 }, (_, i) => box(9000 + i * 80))];
    const r = detachedClusters(boxes);
    expect(r.clusters).toBe(2);
    expect(r.drop.size).toBe(0);
  });

  it('culls a cuboid buried on every side, but not one behind glass or beside a rotated box', () => {
    type B = { min: [number, number, number]; max: [number, number, number]; translucent: boolean; aligned: boolean };
    const box = (x: number, y: number, z: number, extra: Partial<B> = {}): B => ({ min: [x, y, z], max: [x + 20, y + 20, z + 20], translucent: false, aligned: true, ...extra });
    // A 3×3×3 block of 20-LDU cubes: only the centre one is hidden.
    const block: B[] = [];
    for (let x = 0; x < 3; x++) for (let y = 0; y < 3; y++) for (let z = 0; z < 3; z++) block.push(box(x * 20, y * 20, z * 20));
    const centre = block.findIndex(b => b.min[0] === 20 && b.min[1] === 20 && b.min[2] === 20);
    expect([...cullHiddenCuboids(block, 4)]).toEqual([centre]);
    // The cube above the centre made of glass: the centre is visible through it.
    const glass = block.map((b, i) => (b.min[0] === 20 && b.min[1] === 40 && b.min[2] === 20 ? { ...b, translucent: true } : b));
    expect(cullHiddenCuboids(glass, 4).size).toBe(0);
    // The cube above the centre inside a rotated bone: its box is an over-estimate, so it never occludes.
    const rotated = block.map(b => (b.min[0] === 20 && b.min[1] === 40 && b.min[2] === 20 ? { ...b, aligned: false } : b));
    expect(cullHiddenCuboids(rotated, 4).size).toBe(0);
  });

  // The 40 M occupancy-grid budget: coarsen, never bail silently.
  type CullBox = { min: [number, number, number]; max: [number, number, number]; translucent: boolean; aligned: boolean };
  /** A 3x3x3 block of `size`-LDU cubes: only the centre one is enclosed. */
  const cullBlock = (size: number): { boxes: CullBox[]; centre: number } => {
    const boxes: CullBox[] = [];
    for (let x = 0; x < 3; x++) for (let y = 0; y < 3; y++) for (let z = 0; z < 3; z++)
      boxes.push({ min: [x * size, y * size, z * size], max: [(x + 1) * size, (y + 1) * size, (z + 1) * size], translucent: false, aligned: true });
    return { boxes, centre: boxes.findIndex(b => b.min[0] === size && b.min[1] === size && b.min[2] === size) };
  };
  const gridCellsAt = (extentLdu: number, cell: number): number => Math.pow(Math.ceil(extentLdu / cell) + 2, 3);

  it('keeps the requested cell, and the exact prior result, for a model whose grid fits the budget', () => {
    const { boxes, centre } = cullBlock(20);
    const r = cullHiddenCuboidsWithinBudget(boxes, 4);
    expect(r.cellLdu).toBe(4);
    expect(r.coarsened).toBe(false);
    expect(r.skipped).toBe(false);
    expect([...r.hidden]).toEqual([centre]);
    expect([...r.hidden]).toEqual([...cullHiddenCuboids(boxes, 4)]);
  });

  it('coarsens the occupancy cell instead of bailing when the grid exceeds the budget, and still culls the enclosed cuboid', () => {
    // 3 x 480 LDU per axis: 362^3 = 47.4 M cells at 4 LDU (over budget), 242^3 = 14.2 M at 6 LDU.
    const { boxes, centre } = cullBlock(480);
    expect(gridCellsAt(1440, 4)).toBeGreaterThan(CULL_GRID_CELL_BUDGET);
    expect(gridCellsAt(1440, 6)).toBeLessThan(CULL_GRID_CELL_BUDGET);
    const r = cullHiddenCuboidsWithinBudget(boxes, 4);
    expect(r.cellLdu).toBe(6);
    expect(r.coarsened).toBe(true);
    expect(r.skipped).toBe(false);
    expect([...r.hidden]).toEqual([centre]);
    // The old code returned an empty set here - the culler never ran on the largest golden model.
    expect(cullHiddenCuboids(boxes, 4).size).toBe(0);
  });

  it('reports the cull cell it used in the compile diagnostics', async () => {
    const bricks: ParsedBrick[] = [{ part: '3001.dat', color: 4, x: 0, y: 0, z: 0 }, { part: '3001.dat', color: 4, x: 0, y: -24, z: 0 }];
    const r = await compileLdrawEntityGeometry('t', 'car', bricks, { partGeometry: provider(), facing: '+z' });
    expect(r.diagnostics.hiddenCull.cellLdu).toBe(Math.min(4, r.diagnostics.quality.microcellLdu));
    expect(r.diagnostics.hiddenCull.requestedCellLdu).toBe(r.diagnostics.hiddenCull.cellLdu);
    expect(r.diagnostics.hiddenCull.coarsened).toBe(false);
    expect(r.diagnostics.hiddenCull.skipped).toBe(false);
    expect(r.diagnostics.hiddenCull.gridCells).toBeGreaterThan(0);
  });

  it('skips the cull, and says so, only when even the coarsest allowed cell does not fit', () => {
    const coarsest = CULL_CELL_LADDER[CULL_CELL_LADDER.length - 1]!;
    expect(coarsest).toBe(12); // never 16: at 16 LDU the cull removes visible material (3 studs)
    const { boxes } = cullBlock(1400);
    expect(gridCellsAt(4200, coarsest)).toBeGreaterThan(CULL_GRID_CELL_BUDGET);
    const r = cullHiddenCuboidsWithinBudget(boxes, 4);
    expect(r.skipped).toBe(true);
    expect(r.hidden.size).toBe(0);
    expect(r.cellLdu).toBe(coarsest);
  });

  it('levelModel leaves an already level model alone', () => {
    const bricks: ParsedBrick[] = Array.from({ length: 10 }, (_, i) => ({ part: '3005.dat', color: 4, x: i * 20, y: 0, z: 0 }));
    const r = levelModel(bricks);
    expect(r.rotation).toBeNull();
    expect(r.bricks).toBe(bricks);
  });

  it('does not reduce a slope to its bounding box and stays within the part budget', async () => {
    const bricks: ParsedBrick[] = [{ part: '3040b.dat', color: 2, x: 0, y: 0, z: 0 }];
    const r = await compileLdrawEntityGeometry('t', 'car', bricks, { partGeometry: provider(), facing: '+z' });
    const cubes = allCubes(r.value as Geo);
    expect(cubes.length).toBeGreaterThan(3);
    expect(cubes.length).toBeLessThanOrEqual(r.diagnostics.quality.maxPartCubes);
    const vol = cubes.reduce((n, c) => n + c.size[0]! * c.size[1]! * c.size[2]!, 0);
    const aabb = 20 * 24 * 40 * Math.pow(BEDROCK_UNITS_PER_LDU, 3);
    expect(vol / aabb).toBeGreaterThan(0.4);
    expect(vol / aabb).toBeLessThan(0.65);
    expect(r.diagnostics.aabbFallbackParts).toEqual([]);
  });

  it('puts a rotated part in its own bone with a ZYX Euler, Bedrock signs, pivot at the part origin', async () => {
    const a = 30 * Math.PI / 180;
    // Rotation about LDraw Y by 30°.
    const rot = [Math.cos(a), 0, Math.sin(a), 0, 1, 0, -Math.sin(a), 0, Math.cos(a)];
    const bricks: ParsedBrick[] = [
      { part: '3001.dat', color: 15, x: 0, y: 0, z: 0 },
      { part: '3005.dat', color: 4, x: 60, y: 0, z: 0, rot },
    ];
    const r = await compileLdrawEntityGeometry('t', 'car', bricks, { partGeometry: provider(), facing: '+z' });
    expect(r.diagnostics.rotatedBoneCount).toBe(1);
    const geo = r.value as Geo;
    // The rotated part is red and the body white, so they are now separate
    // geometries: the bone lives in whichever one holds its cubes.
    const bone = geo['minecraft:geometry'].flatMap(m => m.bones).find(b => b.name !== 'body' && b.cubes.length)!;
    expect(bone).toBeDefined();
    expect(bone.rotation).toBeDefined();
    // A yaw about LDraw Y (down) of +30° is a yaw about render Y (up) of −30°;
    // Bedrock negates X and Y angles in the JSON → +30 on the Y channel.
    expect(bone.rotation![0]).toBeCloseTo(0, 1);
    expect(Math.abs(bone.rotation![1]!)).toBeCloseTo(30, 1);
    expect(bone.rotation![2]).toBeCloseTo(0, 1);
    // The bone's cube is the unrotated box at the part origin, in the same JSON frame.
    const cube = bone.cubes[0]!;
    expect(cube.size).toEqual([6, 7.2, 6]);
    // Pivot (mirrored X) is the part origin: the cube is centred on it in X/Z.
    expect(cube.origin[0]! + cube.size[0]! / 2).toBeCloseTo(bone.pivot[0]!, 2);
    expect(cube.origin[2]! + cube.size[2]! / 2).toBeCloseTo(bone.pivot[2]!, 2);
  });

  it('routes translucent MATERIALS to their own alpha-blended meshes and keeps canopy moulds opaque when their colour is', async () => {
    const bricks: ParsedBrick[] = [
      { part: '3001.dat', color: 0, x: 0, y: 0, z: 0 },
      { part: '3823.dat', color: 47, x: 0, y: -24, z: 0 },   // trans-clear windscreen → translucent mesh
      { part: '3823.dat', color: 4, x: 0, y: -24, z: 60 },   // a red "windscreen" → opaque
    ];
    const r = await compileLdrawEntityGeometry('t', 'plane', bricks, { partGeometry: provider() });
    expect(r.meshes.filter(m => m.translucent).map(m => m.material.colorId)).toEqual([47]);
    expect([...new Set(r.meshes.filter(m => !m.translucent).map(m => m.material.colorId))].sort()).toEqual([0, 4]);
    // Alpha-blended geometry draws after every opaque one.
    expect(r.meshes.findIndex(m => m.translucent)).toBe(r.meshes.length - 1);
    expect(r.canopyMaterials.map(m => m.colorId)).toEqual([47]);
    expect(r.materials.map(m => m.colorId).sort()).toEqual([0, 4]);
    expect(r.diagnostics.translucentCubeCount).toBeGreaterThan(0);
    expect(r.seatPosition[1]).toBeGreaterThan(0);
  });

  it('gives every geometry ONE colour, box UV at the swatch origin, and the colour of the brick each cube came from', async () => {
    // Box UV maps all six faces of a cube from one origin, so the colour has to
    // be a property of the geometry. This is the gate on that: no cube may
    // carry a UV that could reach another colour, and no brick may change
    // colour on the way into the pack.
    const bricks: ParsedBrick[] = [
      { part: '3001.dat', color: 15, x: 0, y: 0, z: 0 },
      { part: '3005.dat', color: 4, x: 100, y: 0, z: 0 },
      { part: '3005.dat', color: 1, x: 200, y: 0, z: 0 },
      { part: '3823.dat', color: 47, x: 0, y: -24, z: 0 },   // trans-clear
    ];
    const r = await compileLdrawEntityGeometry('t', 'car', bricks, { partGeometry: provider(), facing: '+z' });
    const geo = r.value as Geo;
    expect([...new Set(r.meshes.map(m => m.material.colorId))].sort((a, b) => a - b)).toEqual([1, 4, 15, 47]);
    expect(r.meshes).toHaveLength(4);
    for (const m of geo['minecraft:geometry']) {
      // The swatch is uniform, so the declared texture space only sets where a
      // cross wraps, never which colour it lands on.
      expect(m.description.texture_width).toBe(16);
      expect(m.description.texture_height).toBe(16);
    }
    const cubes = allCubes(geo);
    for (const c of cubes) expect(c.uv).toEqual([0, 0]);
    // Every cube of a geometry belongs to that geometry's one colour.
    expect(new Set(cubes.map(c => `${c.mesh}`)).size).toBe(r.meshes.length);
    // LDraw +X is mirrored into JSON −X, so the three opaque bricks come out in
    // the reverse order — each still wearing its own colour.
    const meanX = (id: number): number => {
      const own = cubes.filter(c => colorOf(r, c) === id);
      expect(own.length).toBeGreaterThan(0);
      return own.reduce((n, c) => n + c.origin[0]! + c.size[0]! / 2, 0) / own.length;
    };
    expect(meanX(15)).toBeGreaterThan(meanX(4));
    expect(meanX(4)).toBeGreaterThan(meanX(1));
    expect(r.meshes.find(m => m.material.colorId === 47)!.translucent).toBe(true);
    expect(r.meshes.filter(m => m.material.colorId !== 47).every(m => !m.translucent)).toBe(true);
    // Fanned studs keep their highlight-free flat tile; nothing was dropped.
    expect(r.diagnostics.studTopTilesDropped).toBe(0);
  });

  it('reports the square-peg studs whose stud-top highlight box UV cannot address', async () => {
    const bricks: ParsedBrick[] = [{ part: '3005.dat', color: 4, x: 0, y: 0, z: 0 }];
    const r = await compileLdrawEntityGeometry('t', 'car', bricks, { partGeometry: provider(), facing: '+z', quality: { studFacets: 1 } });
    expect(r.diagnostics.studFacets).toBe(1);
    expect(r.diagnostics.studCubeCount).toBe(1);
    expect(r.diagnostics.studTopTilesDropped).toBe(1);
    expect(r.warnings.some(w => /stud-top highlight/.test(w))).toBe(true);
  });

  it('falls back to the dims-table box for an unresolved part and says so', async () => {
    const bricks: ParsedBrick[] = [
      { part: '3001.dat', color: 4, x: 0, y: 0, z: 0 },
      { part: '99999.dat', color: 1, x: 100, y: 0, z: 0 },
    ];
    const r = await compileLdrawEntityGeometry('t', 'car', bricks, { partGeometry: provider(), facing: '+z' });
    expect(r.diagnostics.unresolvedParts).toEqual(['99999']);
    expect(r.diagnostics.aabbFallbackParts).toEqual([{ part: '99999', count: 1, reason: 'no geometry resolved' }]);
    expect(r.warnings.some(w => /bounding box/.test(w))).toBe(true);
  });

  it('chunks meshes at the quality\'s cube limit and reports counts', async () => {
    const bricks: ParsedBrick[] = [];
    for (let i = 0; i < 12; i++) bricks.push({ part: '3005.dat', color: i % 3, x: i * 40, y: 0, z: 0 });
    const r = await compileLdrawEntityGeometry('t', 'car', bricks, { partGeometry: provider(), facing: '+z', quality: { meshChunkCubes: 5, maxStudCubes: 0 } });
    // 12 body cubes / 5 per mesh → 3 meshes; studs omitted by budget.
    expect(r.meshIds).toHaveLength(3);
    expect(r.diagnostics.cubeCount).toBe(12);
    expect(r.diagnostics.studsOmitted).toBe(12);
    expect(r.warnings.some(w => /stud budget/.test(w))).toBe(true);
    expect(r.diagnostics.prototypeCacheHits).toBe(11);
  });

  // Bedrock frustum-culls an entity against the box its GEOMETRY declares, and
  // `minecraft:scale` (the wand's 25 %…400 % size steps) does not resize that
  // box. A box sized for 100 % made whole sets vanish the moment the camera
  // tilted far enough to push it out of the frustum, worst on scaled-up
  // placements. Each chunk must carry the WHOLE model's box too: a chunk holds
  // an arbitrary slice of the cube list, so a per-chunk box would let the game
  // cull half a castle away.
  it('declares a culling box that holds the whole model at the LARGEST size step, on every mesh', async () => {
    const bricks: ParsedBrick[] = [];
    for (let i = 0; i < 12; i++) bricks.push({ part: '3001.dat', color: i % 3, x: i * 80, y: 0, z: i * 40 });
    const r = await compileLdrawEntityGeometry('t', 'car', bricks, { partGeometry: provider(), facing: '+z', quality: { meshChunkCubes: 5, maxStudCubes: 0 } });
    const geo = r.value as Geo & { 'minecraft:geometry': Array<{ description: { visible_bounds_width: number; visible_bounds_height: number; visible_bounds_offset: number[] } }> };
    expect(geo['minecraft:geometry'].length).toBeGreaterThan(1);
    // The model's own AABB in blocks (16 model units per block), over every mesh.
    const cubes = allCubes(geo);
    const lo = [0, 1, 2].map(i => Math.min(...cubes.map(c => Math.min(c.origin[i]!, c.origin[i]! + c.size[i]!))) / 16);
    const hi = [0, 1, 2].map(i => Math.max(...cubes.map(c => Math.max(c.origin[i]!, c.origin[i]! + c.size[i]!))) / 16);
    expect(hi[0]! - lo[0]!).toBeGreaterThan(1); // a real extent, not a point
    const f = Math.max(...SIZE_STEPS) / 100;
    for (const mesh of geo['minecraft:geometry']) {
      const d = mesh.description, half = d.visible_bounds_width / 2, oy = d.visible_bounds_offset[1]!;
      for (const i of [0, 2]) {
        expect([d.identifier, i, lo[i]! * f >= -half]).toEqual([d.identifier, i, true]);
        expect([d.identifier, i, hi[i]! * f <= half]).toEqual([d.identifier, i, true]);
      }
      expect([d.identifier, lo[1]! * f >= oy - d.visible_bounds_height / 2]).toEqual([d.identifier, true]);
      expect([d.identifier, hi[1]! * f <= oy + d.visible_bounds_height / 2]).toEqual([d.identifier, true]);
    }
  });
});

describe('mergeAlignedCuboids', () => {
  const mat = (id: number) => ({ colorId: id } as any);
  const box = (min: [number, number, number], max: [number, number, number], extra: Partial<Parameters<typeof mergeAlignedCuboids>[0][number]> = {}) =>
    ({ min, max, material: mat(4), bone: 'body', aligned: true, ...extra });
  it('merges a row of three same-colour boxes into one and keeps an L-shape as two', () => {
    const row = [box([0, 0, 0], [10, 10, 10]), box([10, 0, 0], [20, 10, 10]), box([20, 0, 0], [30, 10, 10])];
    const r = mergeAlignedCuboids(row);
    expect(r.merged).toBe(2);
    expect(r.cuboids).toHaveLength(1);
    expect(r.cuboids[0]!.min).toEqual([0, 0, 0]);
    expect(r.cuboids[0]!.max).toEqual([30, 10, 10]);
    const ell = [box([0, 0, 0], [10, 10, 10]), box([10, 0, 0], [20, 10, 10]), box([0, 10, 0], [10, 20, 10])];
    const e = mergeAlignedCuboids(ell);
    expect(e.cuboids).toHaveLength(2);
  });
  it('merges across two axes when a 2×2 slab is built from four boxes', () => {
    const quad = [box([0, 0, 0], [10, 10, 10]), box([10, 0, 0], [20, 10, 10]), box([0, 0, 10], [10, 10, 20]), box([10, 0, 10], [20, 10, 20])];
    const r = mergeAlignedCuboids(quad);
    expect(r.cuboids).toHaveLength(1);
    expect(r.cuboids[0]!.max).toEqual([20, 10, 20]);
  });
  it('never merges different colours, studs, rotated cubes, rotated-bone cuboids, or boxes that only touch at an edge', () => {
    const cases = [
      [box([0, 0, 0], [10, 10, 10]), box([10, 0, 0], [20, 10, 10], { material: mat(1) })],
      [box([0, 0, 0], [10, 10, 10]), box([10, 0, 0], [20, 10, 10], { studTop: true })],
      [box([0, 0, 0], [10, 10, 10]), box([10, 0, 0], [20, 10, 10], { rotation: [0, 45, 0], pivot: [15, 5, 5] })],
      [box([0, 0, 0], [10, 10, 10]), box([10, 0, 0], [20, 10, 10], { aligned: false, bone: 'r1' })],
      [box([0, 0, 0], [10, 10, 10]), box([10, 10, 0], [20, 20, 10])],
      [box([0, 0, 0], [10, 10, 10]), box([10, 0, 0], [20, 10, 12])],
    ];
    for (const c of cases) { const r = mergeAlignedCuboids(c); expect(r.merged).toBe(0); expect(r.cuboids).toHaveLength(2); }
  });
});

describe('display-stand drop is reported and the kept placements are indexed', () => {
  it('a car keeps its wheel envelope and reports the base plate and figures it left out', async () => {
    // A 6-brick body with four "wheels" (part names the compiler recognises by substring), plus a base
    // plate 200 LDU below the wheel line and a figure standing 400 LDU beside the car.
    // Body bricks rest on the wheel line (their boxes span y −24..0; the wheel rims span −10..10, so they touch).
    const body: ParsedBrick[] = Array.from({ length: 6 }, (_, i) => ({ part: '3001.dat', color: 4, x: i * 80, y: 0, z: 0 }));
    const wheels: ParsedBrick[] = [[0, -22], [400, -22], [0, 22], [400, 22]].map(([x, z]) => ({ part: '56908.dat', color: 0, x: x!, y: 0, z: z! }));
    const plate: ParsedBrick[] = Array.from({ length: 5 }, (_, i) => ({ part: '3001.dat', color: 7, x: i * 80, y: 200, z: 0 }));
    const figure: ParsedBrick = { part: '3005.dat', color: 14, x: 200, y: 0, z: 500 };
    const bricks = [...body, ...wheels, ...plate, figure];
    const r = await compileLdrawEntityGeometry('t', 'car', bricks, { partGeometry: provider(), facing: '+x' });
    // The plate touches the wheels, so the wheel-envelope rule drops it; the lone brick never touched the car, so it is a separate object (a prop), not stand.
    expect(r.diagnostics.displayDropped).toEqual({ placements: 5, rule: 'wheel-envelope' });
    expect(r.diagnostics.detached).toEqual({ placements: 1, groups: 1 });
    expect(r.diagnostics.extras).toEqual([{ role: 'prop', placements: 1, reason: '1 part, no wheels or seat' }, { role: 'prop', placements: 5, reason: 'display stand (wheel-envelope)' }]);
    expect(r.warnings.some(w => /5 placements left out as a display stand/.test(w))).toBe(true);
    // Kept = the six body bricks and four wheels, by their input indices.
    expect(r.keptSourceIndices).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('keeps bodywork that overhangs the wheels - only the height test says "display stand"', async () => {
    // The rule used to demand every placement's ORIGIN sit within 120 LDU of the
    // outermost wheel CENTRES. A real car's nose and tail reach much further
    // (10337: 183 LDU past the front hubs), so its bumpers and its rear wing
    // went out as "stand" and the wing's plates were left floating in game.
    const body: ParsedBrick[] = Array.from({ length: 6 }, (_, i) => ({ part: '3001.dat', color: 4, x: i * 80, y: 0, z: 0 }));
    const wheels: ParsedBrick[] = [[0, -22], [400, -22], [0, 22], [400, 22]].map(([x, z]) => ({ part: '56908.dat', color: 0, x: x!, y: 0, z: z! }));
    // Two more body bricks reaching 160 LDU past the front wheel centres.
    const nose: ParsedBrick[] = [480, 560].map(x => ({ part: '3001.dat', color: 4, x, y: 0, z: 0 }));
    const plate: ParsedBrick[] = Array.from({ length: 5 }, (_, i) => ({ part: '3001.dat', color: 7, x: i * 80, y: 200, z: 0 }));
    const r = await compileLdrawEntityGeometry('t', 'car', [...body, ...wheels, ...nose, ...plate], { partGeometry: provider(), facing: '+x' });
    expect(r.diagnostics.displayDropped).toEqual({ placements: 5, rule: 'wheel-envelope' });
    // The overhanging bodywork (input indices 10, 11) survives.
    expect(r.keptSourceIndices).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(r.diagnostics.orphans).toEqual({ clusters: 0, placements: 0 });
  });
  it('puts back the placements a display-stand drop would have left hanging in mid-air', async () => {
    const body: ParsedBrick[] = Array.from({ length: 6 }, (_, i) => ({ part: '3001.dat', color: 4, x: i * 80, y: 0, z: 0 }));
    const wheels: ParsedBrick[] = [[0, -22], [400, -22], [0, 22], [400, 22]].map(([x, z]) => ({ part: '56908.dat', color: 0, x: x!, y: 0, z: z! }));
    // A 120 LDU post hanging off the body, below the wheel line (dropped), and a
    // tip halfway down it that is ABOVE the line (kept) and touches nothing else.
    const post: ParsedBrick = { part: '2453.dat', color: 0, x: 400, y: 120, z: 0 };
    const tip: ParsedBrick = { part: '3005.dat', color: 4, x: 415, y: 96, z: 0 };
    const plate: ParsedBrick[] = Array.from({ length: 5 }, (_, i) => ({ part: '3001.dat', color: 7, x: i * 80, y: 200, z: 0 }));
    const r = await compileLdrawEntityGeometry('t', 'car', [...body, ...wheels, post, tip, ...plate], { partGeometry: provider(), facing: '+x' });
    // The post came back so the tip still hangs on something; only the plate went.
    expect(r.diagnostics.strandedRepaired).toBe(1);
    expect(r.diagnostics.displayDropped).toEqual({ placements: 5, rule: 'wheel-envelope' });
    expect(r.diagnostics.orphans).toEqual({ clusters: 0, placements: 0 });
  });
  it('a plane stand takes its mast with it: parts hanging off the stand below the hull go out too', async () => {
    // The Milano (76286) on the Pixel, world 919, 2026-09-19: the stand drop left
    // two Technic beams under the hull, the render frame grounded the model on
    // them, and the ship hovered a mast high on a thin stalk. Here: a 20-brick
    // hull with a canopy on top, a 3-brick stand 264 LDU down, a 120-tall beam on
    // the stand that the height rule already drops (its foot is 240 > canopy+250
    // = 226) and a second beam between it and the hull whose foot (120) is INSIDE
    // the height line but which hangs 120 LDU under the hull's underside (0).
    // Test parts have their origin at the bottom face (box6 y = -h..0).
    const hull: ParsedBrick[] = Array.from({ length: 20 }, (_, i) => ({ part: '3001.dat', color: 4, x: (i % 10) * 80, y: 0, z: i < 10 ? -20 : 20 }));
    const canopy: ParsedBrick = { part: '2507.dat', color: 47, x: 320, y: -24, z: 0 };
    const stand: ParsedBrick[] = [0, 80, 160].map(x => ({ part: '3001.dat', color: 7, x, y: 264, z: 0 }));
    const upperBeam: ParsedBrick = { part: '2453.dat', color: 0, x: 80, y: 240, z: 0 };
    const lowerBeam: ParsedBrick = { part: '2453.dat', color: 0, x: 80, y: 120, z: 0 };
    // A fitting on the lower beam's side (the mast's pin): it touches nothing else,
    // so once the beam goes it would be stranded - and must go with the mast
    // rather than bridge the mast back in through the stranded-piece repair.
    const pin: ParsedBrick = { part: '3005.dat', color: 0, x: 100, y: 60, z: 0 };
    const r = await compileLdrawEntityGeometry('t', 'plane', [...hull, canopy, ...stand, upperBeam, lowerBeam, pin], { partGeometry: provider(), facing: '+x' });
    expect(r.diagnostics.displayDropped).toEqual({ placements: 6, rule: 'stand-below-canopy' });
    expect(r.diagnostics.standContinued).toBe(2);
    expect(r.diagnostics.strandedRepaired).toBe(0);
    expect(r.diagnostics.orphans).toEqual({ clusters: 0, placements: 0 });
    // Everything that is hull or canopy stays; the hull's own underside IS the envelope, so no hull brick is claimed.
    expect(r.keptSourceIndices).toEqual(Array.from({ length: 21 }, (_, i) => i));
    expect(r.warnings.some(w => /2 placements hanging off the display stand below the hull/.test(w))).toBe(true);
  });
});
