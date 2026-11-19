import { describe, expect, it } from 'vitest';
import {
  atRest, coasterRestingPoses, firstRestingPoses, liftCarRestingPoses, separateEntitiesFromNeighbours, shippedGeometryEntry,
  type PlacedEntity, type ShippedGeometry,
} from '../web/src/engine/cross-entity-coplanar.js';
import { visibleCoplanarHits, worldFaces, type AuditActor } from '../web/src/engine/bedrock-geometry-faces.js';

/** One-bone, one-colour geometry documents as the compiler ships them (one geometry per colour). */
const geometry = (colorId: number, cube: { origin: number[]; size: number[] }): ShippedGeometry => ({
  value: { 'minecraft:geometry': [{ bones: [{ name: 'root', pivot: [0, 0, 0], cubes: [{ ...cube, uv: [0, 0] }] }] }] },
  meshes: [{ material: { colorId, alpha: 1 } }],
});
/** A red 1-block shell and a blue car sunk into it so both tops share the plane y = 16 units: the shape of a car on a platform. */
const SHELL = 'craftmatic:t_shell', CAR = 'craftmatic:t_coaster_vehicle_1';
const fixtures = (): Map<string, ShippedGeometry> => new Map([
  [SHELL, geometry(4, { origin: [-8, 0, -8], size: [16, 16, 16] })],
  [CAR, geometry(1, { origin: [-4, 8, -4], size: [8, 8, 8] })],
]);
/** Hits between the two entities, each placed at the given point (model blocks). */
function hitsBetween(geos: Map<string, ShippedGeometry>, carAt: { x: number; y: number; z: number; yaw: number }): number {
  const actor = (typeId: string, at: { x: number; y: number; z: number }, yawDeg: number): AuditActor => ({ typeId, kind: 'placed', entry: shippedGeometryEntry(geos.get(typeId)!).entry, at, yawDeg });
  const actors = [actor(SHELL, { x: 0, y: 0, z: 0 }, 0), actor(CAR, carAt, carAt.yaw)];
  return visibleCoplanarHits(worldFaces(actors)).filter(h => h.a.actor !== h.b.actor).length;
}
// The car's record is the station point (where the wand writes every car of a train); it PARKS on the shell.
const placements: PlacedEntity[] = [
  { typeId: SHELL, x: 0, y: 0, z: 0 },
  { typeId: CAR, x: 40, y: 0, z: 40, coasterRouteIndex: 0, coasterCarIndex: 0 },
];
const parked = [{ route: 0, index: 0, datum: [0, 0, 0], yaw: 0, pitch: 0, roll: 0 }];

describe('coplanar faces of MOVING actors (A-17, TODO(a17-moving))', () => {
  it('separates a parked coaster car where the runtime parks it, not at its record', () => {
    // Without a resting pose the car is left out and its top still shares the shell's plane where it parks.
    const before = fixtures();
    const skipped = separateEntitiesFromNeighbours(placements, before, t => t === SHELL);
    expect(skipped.skippedMoving).toEqual([CAR]);
    expect(hitsBetween(before, { x: 0, y: 0, z: 0, yaw: 0 })).toBeGreaterThan(0);
    // With the parked pose it is separated there: no hit left, and its top moved out by the rule's 1/107 block only.
    const after = fixtures();
    const r = separateEntitiesFromNeighbours(placements, after, t => t === SHELL, coasterRestingPoses(parked));
    expect(r.skippedMoving).toEqual([]);
    expect(r.restedAway).toEqual({ [CAR]: 1 });
    expect(r.changed).toEqual([CAR]);
    expect(hitsBetween(after, { x: 0, y: 0, z: 0, yaw: 0 })).toBe(0);
    const cube = ((after.get(CAR)!.value as any)['minecraft:geometry'][0].bones[0].cubes[0]) as { origin: number[]; size: number[] };
    const top = cube.origin[1]! + cube.size[1]!;
    expect(top).toBeGreaterThan(16);
    expect(top - 16).toBeLessThanOrEqual(16 / 107 + 0.01);
    // The shell, which every neighbour shares, is never moved.
    expect((after.get(SHELL)!.value as any)['minecraft:geometry'][0].bones[0].cubes[0]).toMatchObject({ origin: [-8, 0, -8], size: [16, 16, 16] });
  });

  it('leaves a car parked pitched or rolled out (its bones turn every face off the axes)', () => {
    const tilted = coasterRestingPoses([{ ...parked[0]!, pitch: 3 }]);
    const r = separateEntitiesFromNeighbours(placements, fixtures(), t => t === SHELL, tilted);
    expect(r.skippedMoving).toEqual([CAR]);
    expect(r.changed).toEqual([]);
  });

  it('places a lift car at every stop it rests at: record plus the stop offset along its ride path', () => {
    const rides = [{ kind: 'slide' }, { kind: 'lift', carType: CAR, startStop: 1 }];
    const paths = new Map<number, Array<[number, number, number]>>([[1, [[5, 9, 5], [5, 1, 5], [5, 5, 5]]]]);
    const lift = liftCarRestingPoses(rides, paths);
    const car: PlacedEntity = { typeId: CAR, x: 4, y: 1.5, z: 4, yaw: 0, ride: 1 };
    expect(atRest(car, lift)?.map(p => [p.x, p.y, p.z])).toEqual([[4, 9.5, 4], [4, 1.5, 4], [4, 5.5, 4]]);
    // Another ride's car, or a ride that is not a lift, has no resting pose: it stays out.
    expect(atRest({ ...car, ride: 0 }, lift)).toBeNull();
    expect(atRest({ ...car, typeId: 'craftmatic:other' }, lift)).toBeNull();
    // A lift platform or counterweight (route, no car index) rests at its record.
    expect(atRest({ typeId: 'craftmatic:t_coaster_lift_1', x: 1, y: 2, z: 3, coasterRouteIndex: 0 })).toHaveLength(1);
    // The lookups chain: the first that knows a placement wins.
    const both = firstRestingPoses(coasterRestingPoses(parked), lift);
    expect(atRest(car, both)).toHaveLength(3);
    expect(atRest(placements[1]!, both)?.[0]).toMatchObject({ x: 0, y: 0, z: 0 });
  });
});
