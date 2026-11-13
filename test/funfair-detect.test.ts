/**
 * Finding a drop tower or a sky swing in a model (engine/rides/funfair-detect.ts, BIZ-20): a tall mast of
 * support parts with a ring of rider seats around it. The kind comes from the seats (a hanging swing seat is a
 * swing; any other seat on a ring is a drop tower), the car is the ring and what carries the seats, and every
 * seat gets its own path: its pan at the foot, its pan at the top, and the mast axis at the top.
 */
import { describe, expect, it } from 'vitest';
import { FUNFAIR_DETECT, findFunfairRides } from '../web/src/engine/rides/funfair-detect.js';
import type { LdrawPartMesh, LdrawTriangle, Vec3 } from '../web/src/engine/ldraw-part-geometry.js';
import type { ParsedBrick } from '../web/src/engine/ldraw-parser.js';

const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const brick = (part: string, x: number, y: number, z: number): ParsedBrick => ({ part, color: 4, x, y, z, rot: I });

/** A mesh of one axis-aligned box (two triangles per face), LDraw frame. */
function boxMesh(partId: string, description: string, min: Vec3, max: Vec3): LdrawPartMesh {
  const triangles: LdrawTriangle[] = [];
  const quad = (a: Vec3, b: Vec3, c: Vec3, d: Vec3): void => { triangles.push({ a, b, c, color: 16 }, { a, b: c, c: d, color: 16 }); };
  const [n, x] = [min, max];
  quad([n[0], n[1], n[2]], [x[0], n[1], n[2]], [x[0], n[1], x[2]], [n[0], n[1], x[2]]);
  quad([n[0], x[1], n[2]], [x[0], x[1], n[2]], [x[0], x[1], x[2]], [n[0], x[1], x[2]]);
  quad([n[0], n[1], n[2]], [x[0], n[1], n[2]], [x[0], x[1], n[2]], [n[0], x[1], n[2]]);
  quad([n[0], n[1], x[2]], [x[0], n[1], x[2]], [x[0], x[1], x[2]], [n[0], x[1], x[2]]);
  quad([n[0], n[1], n[2]], [n[0], n[1], x[2]], [n[0], x[1], x[2]], [n[0], x[1], n[2]]);
  quad([x[0], n[1], n[2]], [x[0], n[1], x[2]], [x[0], x[1], x[2]], [x[0], x[1], n[2]]);
  return { partId, resolvedAs: partId, triangles, studs: [], bounds: { min, max }, unresolvedRefs: [], description } as LdrawPartMesh;
}

const MAST = 'Support  2 x  2 x 13 with  5 Pegholes';
const meshes = (seat: string, seatBox: [Vec3, Vec3]): Map<string, LdrawPartMesh> => new Map([
  ['91176.dat', boxMesh('91176', MAST, [-20, 0, -20], [20, 312, 20])],
  ['3958.dat', boxMesh('3958', 'Plate  6 x  6', [-60, 0, -60], [60, 8, 60])],
  ['seat.dat', boxMesh('seat', seat, seatBox[0], seatBox[1])],
]);
/** Six stacked supports at the origin: the mast, y -1872..0. */
const mast = (): ParsedBrick[] => Array.from({ length: 6 }, (_, i) => brick('91176.dat', 0, -312 * (i + 1), 0));
const AROUND: Array<[number, number]> = [[120, 0], [0, 120], [-120, 0], [0, -120]];

/** A drop tower: four ring plates round the mast at y -50 and a seat standing on each (foot at -50). */
function dropTower(): { bricks: ParsedBrick[]; meshes: Map<string, LdrawPartMesh> } {
  return {
    bricks: [...mast(), ...AROUND.flatMap(([x, z]) => [brick('3958.dat', x, -50, z), brick('seat.dat', x, -50, z)])],
    meshes: meshes('Minifig Seat  2 x  2', [[-20, -24, -20], [20, 0, 20]]),
  };
}
/** A sky swing: a canopy ring of plates at y -400 and a swing seat hanging from each (its top meeting the plate's underside, -392). */
function skySwing(): { bricks: ParsedBrick[]; meshes: Map<string, LdrawPartMesh> } {
  return {
    bricks: [...mast(), ...AROUND.flatMap(([x, z]) => [brick('3958.dat', x, -400, z), brick('seat.dat', x, -392, z)])],
    meshes: meshes('Friends Swing 2 x 6 x 5 1/3', [[-20, 0, -20], [20, 24, 20]]),
  };
}

describe('drop tower', () => {
  it('finds the mast with its ring of seats, one path per seat, and carries the ring and seats as the car', () => {
    const { bricks, meshes: m } = dropTower();
    const rides = findFunfairRides(bricks, m);
    expect(rides).toHaveLength(1);
    const ride = rides[0]!;
    expect(ride.kind).toBe('drop');
    expect(ride.seats).toHaveLength(4);
    // The car: four plates and four seats; the mast stays in the model.
    expect(ride.carBricks).toHaveLength(8);
    expect(ride.carBricks.some(b => b.part === '91176.dat')).toBe(false);
    for (const seat of ride.seats) {
      const [foot, top, axis] = seat.pathLdu as [Vec3, Vec3, Vec3];
      // The car rises until its highest part (the seat tops, -74) is `TOP_CLEAR_LDU` under the mast top (-1872).
      expect(top[1] - foot[1]).toBeCloseTo(-(1774), 3);
      expect(top[0]).toBeCloseTo(foot[0], 6);
      expect(top[2]).toBeCloseTo(foot[2], 6);
      // The axis is the mast's, at the top.
      expect(axis[0]).toBeCloseTo(0, 6); expect(axis[2]).toBeCloseTo(0, 6); expect(axis[1]).toBeCloseTo(top[1], 6);
      // The riders step off outside the ring, at its foot.
      expect(Math.hypot(seat.exitLdu[0], seat.exitLdu[2])).toBeGreaterThan(Math.hypot(foot[0], foot[2]) + 40);
    }
    expect(ride.seats.map(s => s.pathLdu[0]![0]).sort((a, b) => a - b)).toEqual([-120, 0, 0, 120]);
  });

  it('is not a ride without a tall mast or without a ring of at least two seats', () => {
    const { bricks, meshes: m } = dropTower();
    expect(findFunfairRides(bricks.filter(b => b.part !== '91176.dat' || b.y > -312 * 2), m)).toEqual([]);
    expect(findFunfairRides([...mast(), bricks.find(b => b.part === 'seat.dat')!], m)).toEqual([]);
    expect(findFunfairRides(bricks.filter(b => b.part !== 'seat.dat'), m)).toEqual([]);
    expect(FUNFAIR_DETECT.TOWER_MIN_LDU).toBeGreaterThan(312 * 2);
  });
});

describe('sky swing', () => {
  it('reads hanging swing seats on a canopy ring as a swing, the canopy and seats as the car', () => {
    const { bricks, meshes: m } = skySwing();
    const rides = findFunfairRides(bricks, m);
    expect(rides).toHaveLength(1);
    expect(rides[0]!.kind).toBe('swing');
    expect(rides[0]!.seats).toHaveLength(4);
    expect(rides[0]!.carBricks).toHaveLength(8);
    // Each seat's pan is the swing seat's own surface (the face above its underside), on the ring radius.
    for (const s of rides[0]!.seats) expect(Math.hypot(s.pathLdu[0]![0], s.pathLdu[0]![2])).toBeCloseTo(120, 6);
  });
});
