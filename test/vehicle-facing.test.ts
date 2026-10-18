import { describe, expect, it } from 'vitest';
import { inferVehicleNose, partLean } from '../web/src/engine/vehicle-facing.js';
import type { ParsedBrick } from '../web/src/engine/ldraw-parser.js';
import type { LdrawPartMesh } from '../web/src/engine/ldraw-part-geometry.js';

// Rotations (row-major, LDraw frame). yaw(θ) about Y: local −Z → world (−sin θ, 0, −cos θ).
const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const yaw180 = [-1, 0, 0, 0, 1, 0, 0, 0, -1]; // local −Z → world +Z
const yawM90 = [0, 0, -1, 0, 1, 0, 1, 0, 0];  // local −Z → world +X

/** A body of plain bricks along an axis so the footprint has a clear long side. */
const body = (axis: 'x' | 'z', length = 400, width = 120): ParsedBrick[] => {
  const out: ParsedBrick[] = [];
  for (let a = -length / 2; a <= length / 2; a += 40) for (let t = -width / 2; t <= width / 2; t += 40)
    out.push({ part: '3001.dat', color: 7, x: axis === 'x' ? a : t, y: 0, z: axis === 'x' ? t : a, rot: I });
  return out;
};
/** A quad fanned about its centre so every corner carries the same vertex weight. */
const mesh = (id: string, q: Array<[number, number, number]>): LdrawPartMesh => {
  const m: [number, number, number] = [0, 1, 2].map(i => q.reduce((a, p) => a + p[i]!, 0) / 4) as [number, number, number];
  const triangles = [0, 1, 2, 3].map(i => ({ a: q[i]!, b: q[(i + 1) % 4]!, c: m, color: 16 }));
  const min: [number, number, number] = [0, 1, 2].map(i => Math.min(...q.map(p => p[i]!))) as [number, number, number];
  const max: [number, number, number] = [0, 1, 2].map(i => Math.max(...q.map(p => p[i]!))) as [number, number, number];
  return { partId: id, resolvedAs: id, studs: [], unresolvedRefs: [], triangles, bounds: { min, max }, description: '' };
};
// A windscreen sheet whose bottom edge (y = 0, LDraw Y down) sits 30 LDU toward −Z of its top edge (y = −40).
const windscreen = mesh('3823', [[-20, -40, 0], [20, -40, 0], [20, 0, -30], [-20, 0, -30]]);
const wheelMesh = (r: number) => mesh('w', [[-r, -r, -3], [r, -r, -3], [r, r, 3], [-r, r, 3]]);

describe('partLean', () => {
  it('points from the top edge toward the bottom edge in the part frame', () => {
    const lean = partLean(windscreen)!;
    expect(lean[0]).toBeCloseTo(0);
    expect(lean[2]).toBeCloseTo(-30);
  });
  it('is null for a flat or missing part', () => {
    expect(partLean(null)).toBeNull();
    expect(partLean(mesh('t', [[0, 0, 0], [10, 0, 0], [10, 0, 10], [0, 0, 10]]))).toBeNull();
  });
});

describe('inferVehicleNose', () => {
  it('honours an explicit nose without voting', () => {
    const d = inferVehicleNose(body('z'), 'car', { explicit: '+x' });
    expect(d).toMatchObject({ nose: '+x', axis: 'x', sign: 1, source: 'explicit', votes: [] });
  });

  it('falls back to the LDraw convention (front toward the negative end of the long axis) with no evidence', () => {
    expect(inferVehicleNose(body('z'), 'car')).toMatchObject({ nose: '-z', axis: 'z', source: 'convention' });
    expect(inferVehicleNose(body('x'), 'plane')).toMatchObject({ nose: '-x', axis: 'x', source: 'convention' });
  });

  it('a seat facing +X on an X-long car puts the nose at +X', () => {
    const bricks = [...body('x'), { part: '4079.dat', color: 0, x: 0, y: -24, z: 0, rot: yawM90 }];
    const d = inferVehicleNose(bricks, 'car');
    expect(d).toMatchObject({ nose: '+x', axis: 'x', sign: 1, source: 'inferred', agreement: 1 });
    expect(d.votes.map(v => v.signal)).toEqual(['driver:seat']);
  });

  it('a display figure posed at an angle, or standing outside the footprint, does not vote', () => {
    const diagonal = [0.7071, 0, 0.7071, 0, 1, 0, -0.7071, 0, 0.7071];
    const posed = [...body('z'), { part: '973.dat', color: 4, x: 0, y: -24, z: 0, rot: diagonal }];
    expect(inferVehicleNose(posed, 'car').votes).toEqual([]);
    const beside = [...body('z'), { part: '973.dat', color: 4, x: 400, y: -24, z: 0, rot: yaw180 }];
    expect(inferVehicleNose(beside, 'car').votes).toEqual([]);
  });

  it('tail lights (trans-red) at one end put the nose at the other end', () => {
    const bricks = [...body('z'), { part: '3005.dat', color: 36, x: -40, y: -24, z: 200, rot: I }, { part: '3005.dat', color: 36, x: 40, y: -24, z: 200, rot: I }];
    const d = inferVehicleNose(bricks, 'car');
    expect(d.nose).toBe('-z');
    expect(d.votes[0]).toMatchObject({ signal: 'tail lights', z: -2 });
  });

  it('the end with more wheels, or larger wheels, is the rear', () => {
    const wheel = (x: number, z: number, part = 'wheel_a.dat'): ParsedBrick => ({ part, color: 0, x, y: 0, z, rot: I });
    const isWheel = (b: ParsedBrick) => b.part.startsWith('wheel');
    const four = [...body('z'), wheel(-80, -150), wheel(80, -150), wheel(-80, 150), wheel(80, 150), wheel(-80, 190), wheel(80, 190)];
    expect(inferVehicleNose(four, 'car', { isWheel }).nose).toBe('-z');
    const meshes = new Map<string, LdrawPartMesh | null>([['wheel_a.dat', wheelMesh(30)], ['wheel_b.dat', wheelMesh(50)]]);
    const big = [...body('z'), wheel(-80, -150), wheel(80, -150), wheel(-80, 150, 'wheel_b.dat'), wheel(80, 150, 'wheel_b.dat')];
    const d = inferVehicleNose(big, 'car', { isWheel, meshes });
    expect(d.nose).toBe('-z');
    expect(d.votes[0]!.detail).toContain('radius');
    // Symmetric wheelbase: abstain, convention decides.
    const sym = [...body('z'), wheel(-80, -150), wheel(80, -150), wheel(-80, 150), wheel(80, 150)];
    expect(inferVehicleNose(sym, 'car', { isWheel }).source).toBe('convention');
  });

  it('a windscreen leaning toward +Z (rotated 180°) makes +Z the nose', () => {
    const meshes = new Map<string, LdrawPartMesh | null>([['3823.dat', windscreen]]);
    const bricks = [...body('z'), { part: '3823.dat', color: 47, x: 0, y: -24, z: 60, rot: yaw180 }, { part: '3823.dat', color: 47, x: 0, y: -24, z: 100, rot: yaw180 }];
    const d = inferVehicleNose(bricks, 'car', { meshes });
    expect(d.nose).toBe('+z');
    expect(d.votes[0]).toMatchObject({ signal: 'windscreen lean' });
  });

  it('a plane takes its canopy end and its narrow end as the nose', () => {
    // Fuselage along X with wide "wings" at the +X end and a canopy toward −X.
    const bricks: ParsedBrick[] = [...body('x', 600, 40)];
    for (let z = -200; z <= 200; z += 40) bricks.push({ part: '3001.dat', color: 7, x: 260, y: 0, z, rot: I });
    bricks.push({ part: '3005.dat', color: 47, x: -220, y: -24, z: 0, rot: I });
    const d = inferVehicleNose(bricks, 'plane');
    expect(d).toMatchObject({ nose: '-x', axis: 'x', source: 'inferred' });
    expect(d.votes.map(v => v.signal).sort()).toEqual(['canopy position', 'narrow end x']);
  });

  it('a rear window behind the exhausts does not turn the plane round (the Milano)', () => {
    // 76286's shape, measured on the Saga (probe 2026-09-28): the pointed nose is at
    // the narrow end, trans-light-blue engine rings sit aft of centre, and a
    // windscreen mould (84954) sits further aft still, as a rear window. Its
    // canopy vote loses to the engines and the narrow end; the nose stays −Z.
    const bricks: ParsedBrick[] = [...body('z', 600, 80)];
    for (let x = -300; x <= 300; x += 40) bricks.push({ part: '3001.dat', color: 7, x, y: 0, z: 260, rot: I });
    bricks.push(
      { part: '6141.dat', color: 43, x: -40, y: -24, z: 180, rot: I }, { part: '6141.dat', color: 43, x: 40, y: -24, z: 180, rot: I },
      { part: '84954.dat', color: 47, x: 0, y: -40, z: 290, rot: I },
    );
    const meshes = new Map([['84954.dat', { ...mesh('84954', [[-30, -60, 0], [30, -60, 0], [30, 0, -40], [-30, 0, -40]]), description: 'Windscreen  3 x  4 x  3' }]]);
    const d = inferVehicleNose(bricks, 'plane', { meshes });
    expect(d.nose).toBe('-z');
    expect(d.votes.map(v => v.signal)).toContain('engine glow');
  });

  it('exhausts behind the canopy still vote for the other end', () => {
    const bricks: ParsedBrick[] = [...body('z', 600, 80)];
    bricks.push(
      { part: '3005.dat', color: 47, x: 0, y: -24, z: -200, rot: I },
      { part: '6141.dat', color: 43, x: -40, y: 0, z: 290, rot: I }, { part: '6141.dat', color: 43, x: 40, y: 0, z: 290, rot: I },
    );
    const d = inferVehicleNose(bricks, 'plane');
    expect(d.nose).toBe('-z');
    expect(d.votes.map(v => v.signal)).toContain('engine glow');
  });

  it('a helicopter-shaped plane (narrow tail boom, canopy at the front) still picks the canopy end', () => {
    const bricks: ParsedBrick[] = [];
    for (let x = -300; x <= 0; x += 40) for (let z = -60; z <= 60; z += 40) bricks.push({ part: '3001.dat', color: 7, x, y: 0, z, rot: I });
    for (let x = 40; x <= 300; x += 40) for (const z of [0, 40]) bricks.push({ part: '3001.dat', color: 7, x, y: 0, z, rot: I });
    bricks.push({ part: '3005.dat', color: 47, x: -260, y: -24, z: 0, rot: I }, { part: '3005.dat', color: 47, x: -260, y: -24, z: 40, rot: I });
    const d = inferVehicleNose(bricks, 'plane');
    expect(d.nose).toBe('-x');
    expect(d.agreement).toBeLessThan(1); // the narrow-end rule voted for the boom; the canopy outweighed it
  });

  it('votes decide the axis when the footprint is nearly square', () => {
    // A square body with a pilot facing −Z: the nose is −Z even though X is marginally longer.
    const bricks = [...body('x', 400, 380), { part: '973.dat', color: 4, x: 0, y: -24, z: 0, rot: I }];
    const d = inferVehicleNose(bricks, 'plane');
    expect(d).toMatchObject({ nose: '-z', axis: 'z' });
  });

  it('reports the disagreement when evidence conflicts', () => {
    const meshes = new Map<string, LdrawPartMesh | null>([['3823.dat', windscreen]]);
    const bricks = [...body('z'), { part: '4079.dat', color: 0, x: 0, y: -24, z: 0, rot: I },
      { part: '3823.dat', color: 47, x: 0, y: -24, z: 60, rot: yaw180 }];
    const d = inferVehicleNose(bricks, 'car', { meshes });
    expect(d.nose).toBe('-z'); // the seat (weight 3) beats one windscreen (weight 1)
    expect(d.agreement).toBeLessThan(1);
    expect(d.agreement).toBeGreaterThan(0.5);
  });
});

describe('long-axis rule for cars and boats', () => {
  it('keeps a boat nose on its long axis when a skipper standing across the deck outvotes the wheel (60221)', () => {
    const hull = body('z', 400, 120);
    const skipper: ParsedBrick[] = [
      { part: '973.dat', color: 1, x: 0, y: -40, z: 40, rot: yawM90 },
      { part: '3815.dat', color: 1, x: 0, y: -8, z: 40, rot: yawM90 },
      { part: '3626.dat', color: 14, x: 0, y: -64, z: 40, rot: yawM90 },
    ];
    // Across, the skipper says +X; along, only a steering wheel at the -Z end.
    const d = inferVehicleNose([...hull, ...skipper, { part: '3829c01.dat', color: 0, x: 0, y: -24, z: -120, rot: I }], 'boat');
    expect(d.axis).toBe('z');
  });
  it('does not force an aircraft onto its long axis (a wingspan can be the long side)', () => {
    const wings = body('x', 600, 120);
    const pilot: ParsedBrick = { part: '973.dat', color: 1, x: 0, y: -40, z: 0, rot: I };
    expect(inferVehicleNose([...wings, pilot, { ...pilot, part: '3815.dat', y: -8 }], 'plane').axis).toBe('z');
  });
});

describe('boats', () => {
  it('points a sailing ship away from its helm, reads its clear lamps as stern lanterns, and its pointed end as the bow', () => {
    // A hull along z: wide (160) from z -120 to +200, narrowing to a 40-wide bow at z -200.
    const hull: ParsedBrick[] = [];
    for (let z = -120; z <= 200; z += 40) for (let x = -80; x <= 80; x += 40) hull.push({ part: '3001.dat', color: 6, x, y: 0, z, rot: I });
    for (let z = -200; z < -120; z += 40) for (const x of [-20, 20]) hull.push({ part: '3001.dat', color: 6, x, y: 0, z, rot: I });
    // The helm on the quarterdeck and two clear lanterns at the stern (+z).
    const helm: ParsedBrick = { part: '4790b.dat', color: 6, x: 0, y: -60, z: 140, rot: I };
    const lanterns: ParsedBrick[] = [{ part: '3062b.dat', color: 47, x: -60, y: -80, z: 200, rot: I }, { part: '3062b.dat', color: 47, x: 60, y: -80, z: 200, rot: I }];
    const meshes = new Map<string, LdrawPartMesh | null>([
      ['3062b.dat', { ...mesh('3062b', [[-10, 0, -10], [10, 0, -10], [10, 0, 10], [-10, 0, 10]]), description: 'Brick  1 x  1 Round with Hollow Stud' }],
      ['4790b.dat', { ...mesh('4790b', [[-50, 0, -50], [50, 0, -50], [50, 0, 50], [-50, 0, 50]]), description: 'Boat Ship Wheel' }],
    ]);
    const decision = inferVehicleNose([...hull, helm, ...lanterns], 'boat', { meshes });
    expect(decision.nose).toBe('-z');
    expect(decision.votes.map(v => v.signal)).toEqual(expect.arrayContaining(['helm', 'narrow end z']));
    expect(decision.votes.map(v => v.signal)).not.toContain('headlights');
    // The same lamps on a car are headlights and point it the other way.
    expect(inferVehicleNose([...hull, ...lanterns], 'car', { meshes }).nose).toBe('+z');
  });
});
