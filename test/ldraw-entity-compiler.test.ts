import { describe, expect, it } from 'vitest';
import { compileLdrawEntityGeometry, eulerZYX, ldrawToRenderRotation } from '../web/src/engine/ldraw-entity-compiler.js';
import { createPartGeometryProvider } from '../web/src/engine/ldraw-part-geometry.js';
import { LDRAW_COLOR_RGB } from '../web/src/engine/ldraw-colors.js';
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
};
const provider = () => createPartGeometryProvider({ fetchPartText: async id => LIBRARY[id.replace(/^.*\//, '')] ?? null });

type Geo = { 'minecraft:geometry': Array<{ description: { identifier: string; texture_width: number; texture_height: number }; bones: Array<{ name: string; pivot: number[]; rotation?: number[]; cubes: Array<{ origin: number[]; size: number[]; uv: Record<string, { uv: number[] }> }> }> }> };
const allCubes = (g: Geo) => g['minecraft:geometry'].flatMap(m => m.bones.flatMap(b => b.cubes.map(c => ({ ...c, bone: b.name, mesh: m.description.identifier }))));

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

describe('compileLdrawEntityGeometry', () => {
  it('instances a box part as ONE cuboid of exact size with exact LDraw colour', async () => {
    const bricks: ParsedBrick[] = [{ part: '3001.dat', color: 4, x: 0, y: 0, z: 0 }];
    const r = await compileLdrawEntityGeometry('t', 'car', bricks, { partGeometry: provider(), facing: '+z' });
    const cubes = allCubes(r.value as Geo).filter(c => c.uv.up!.uv[0] === 0); // body cubes (studs use the stud tile on 'up')
    expect(cubes).toHaveLength(1);
    // 80×24×40 LDU → 12.8 × 3.84 × 6.4 units, floor at y=0, centred in X/Z.
    expect(cubes[0]!.size).toEqual([12.8, 3.84, 6.4]);
    expect(cubes[0]!.origin).toEqual([-6.4, 0, -3.2]);
    expect(r.materials).toHaveLength(1);
    const hex = '#' + r.materials[0]!.rgb.map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();
    expect(hex).toBe(LDRAW_COLOR_RGB[4]);
    expect(r.diagnostics).toMatchObject({ sourcePartCount: 1, uniquePartCount: 1, resolvedPartCount: 1, unresolvedParts: [], aabbFallbackParts: [], studCubeCount: 8 });
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
    const body = allCubes(r.value as Geo).filter(c => c.uv.up!.uv[0] === 0);
    const byRow = new Map(r.materials.map((m, i) => [i, m.colorId]));
    const rowOf = (c: { uv: Record<string, { uv: number[] }> }) => (c.uv.north!.uv[1]! - 1) / 16;
    const red = body.find(c => byRow.get(rowOf(c)) === 4)!;
    const blue = body.find(c => byRow.get(rowOf(c)) === 1)!;
    const white = body.find(c => byRow.get(rowOf(c)) === 15)!;
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
    const body = allCubes(r.value as Geo).filter(c => c.uv.up!.uv[0] === 0);
    const rowOf = (c: { uv: Record<string, { uv: number[] }> }) => (c.uv.north!.uv[1]! - 1) / 16;
    const idOf = (c: { uv: Record<string, { uv: number[] }> }) => r.materials[rowOf(c)]!.colorId;
    const blue = body.find(c => idOf(c) === 1)!, white = body.find(c => idOf(c) === 15)!, red = body.find(c => idOf(c) === 4)!;
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
    expect(r.diagnostics.studCubeCount).toBe(2);
    const studs = allCubes(r.value as Geo).filter(c => c.uv.up!.uv[0] === 16);
    expect(studs).toHaveLength(2);
    // A stud is a 12×4×12 LDU box: 1.92 × 0.64 × 1.92 units.
    expect(studs[0]!.size).toEqual([1.92, 0.64, 1.92]);
    const rows = studs.map(s => (s.uv.up!.uv[1]! - 1) / 16).map(i => r.materials[i]!.colorId).sort();
    expect(rows).toEqual([1, 14]);
  });

  it('does not reduce a slope to its bounding box and stays within the part budget', async () => {
    const bricks: ParsedBrick[] = [{ part: '3040b.dat', color: 2, x: 0, y: 0, z: 0 }];
    const r = await compileLdrawEntityGeometry('t', 'car', bricks, { partGeometry: provider(), facing: '+z' });
    const cubes = allCubes(r.value as Geo);
    expect(cubes.length).toBeGreaterThan(3);
    expect(cubes.length).toBeLessThanOrEqual(r.diagnostics.quality.maxPartCubes);
    const vol = cubes.reduce((n, c) => n + c.size[0]! * c.size[1]! * c.size[2]!, 0);
    const aabb = 20 * 24 * 40 * Math.pow(0.16, 3);
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
    const bone = geo['minecraft:geometry'][0]!.bones.find(b => b.name !== 'body')!;
    expect(bone).toBeDefined();
    expect(bone.rotation).toBeDefined();
    // A yaw about LDraw Y (down) of +30° is a yaw about render Y (up) of −30°;
    // Bedrock negates X and Y angles in the JSON → +30 on the Y channel.
    expect(bone.rotation![0]).toBeCloseTo(0, 1);
    expect(Math.abs(bone.rotation![1]!)).toBeCloseTo(30, 1);
    expect(bone.rotation![2]).toBeCloseTo(0, 1);
    // The bone's cube is the unrotated box at the part origin, in the same JSON frame.
    const cube = bone.cubes.find(c => c.uv.up!.uv[0] === 0)!;
    expect(cube.size).toEqual([3.2, 3.84, 3.2]);
    // Pivot (mirrored X) is the part origin: the cube is centred on it in X/Z.
    expect(cube.origin[0]! + cube.size[0]! / 2).toBeCloseTo(bone.pivot[0]!, 2);
    expect(cube.origin[2]! + cube.size[2]! / 2).toBeCloseTo(bone.pivot[2]!, 2);
  });

  it('routes translucent MATERIALS to the canopy mesh and keeps canopy moulds opaque when their colour is', async () => {
    const bricks: ParsedBrick[] = [
      { part: '3001.dat', color: 0, x: 0, y: 0, z: 0 },
      { part: '3823.dat', color: 47, x: 0, y: -24, z: 0 },   // trans-clear windscreen → translucent mesh
      { part: '3823.dat', color: 4, x: 0, y: -24, z: 60 },   // a red "windscreen" → opaque
    ];
    const r = await compileLdrawEntityGeometry('t', 'plane', bricks, { partGeometry: provider() });
    expect(r.canopyMeshId).toBe('geometry.craftmatic.t_canopy');
    expect(r.meshIds).toContain('geometry.craftmatic.t_canopy');
    expect(r.canopyMaterials.map(m => m.colorId)).toEqual([47]);
    expect(r.materials.map(m => m.colorId).sort()).toEqual([0, 4]);
    expect(r.diagnostics.translucentCubeCount).toBeGreaterThan(0);
    expect(r.seatPosition[1]).toBeGreaterThan(0);
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
});
