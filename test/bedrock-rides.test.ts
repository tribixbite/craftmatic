/**
 * Slides and lifts (engine/bedrock-rides.ts): the chute is read from a part's
 * top surface, a lift from its guides, car and floors, and the runtime carries
 * a seated player along the world path the placement wrote and sets them down.
 */
import { describe, expect, it } from 'vitest';
import { RIDE, _ridesRuntimeForTests, findLifts, findSlides, isLiftCarDescription, isLiftColumnDescription, isLiftGuideDescription, isSlideDescription, ridesScript, slidePathLdu } from '../web/src/engine/bedrock-rides.js';
import { isSwingSeat, isFurnitureSeat } from '../web/src/engine/bedrock-scene-actors.js';
import { isVehicleAndPlaceLabel, isWholeVehicleLabel } from '../web/src/engine/playable-components.js';
import type { LdrawPartMesh, LdrawTriangle, Vec3 } from '../web/src/engine/ldraw-part-geometry.js';
import type { ParsedBrick } from '../web/src/engine/ldraw-parser.js';

const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const brick = (part: string, x = 0, y = 0, z = 0): ParsedBrick => ({ part, color: 4, x, y, z, rot: I });

/** A mesh of axis-aligned boxes (two triangles per face), LDraw frame. */
function boxMesh(partId: string, description: string, boxes: Array<{ min: Vec3; max: Vec3 }>): LdrawPartMesh {
  const triangles: LdrawTriangle[] = [];
  const quad = (a: Vec3, b: Vec3, c: Vec3, d: Vec3): void => { triangles.push({ a, b, c, color: 16 }, { a, b: c, c: d, color: 16 }); };
  for (const { min: n, max: x } of boxes) {
    quad([n[0], n[1], n[2]], [x[0], n[1], n[2]], [x[0], n[1], x[2]], [n[0], n[1], x[2]]); // top (LDraw -Y)
    quad([n[0], x[1], n[2]], [x[0], x[1], n[2]], [x[0], x[1], x[2]], [n[0], x[1], x[2]]); // bottom
    quad([n[0], n[1], n[2]], [x[0], n[1], n[2]], [x[0], x[1], n[2]], [n[0], x[1], n[2]]);
    quad([n[0], n[1], x[2]], [x[0], n[1], x[2]], [x[0], x[1], x[2]], [n[0], x[1], x[2]]);
    quad([n[0], n[1], n[2]], [n[0], n[1], x[2]], [n[0], x[1], x[2]], [n[0], x[1], n[2]]);
    quad([x[0], n[1], n[2]], [x[0], n[1], x[2]], [x[0], x[1], x[2]], [x[0], x[1], n[2]]);
  }
  const min: Vec3 = [Math.min(...boxes.map(b => b.min[0])), Math.min(...boxes.map(b => b.min[1])), Math.min(...boxes.map(b => b.min[2]))];
  const max: Vec3 = [Math.max(...boxes.map(b => b.max[0])), Math.max(...boxes.map(b => b.max[1])), Math.max(...boxes.map(b => b.max[2]))];
  return { partId, resolvedAs: partId, triangles, studs: [], bounds: { min, max }, unresolvedRefs: [], description } as LdrawPartMesh;
}

/** A straight chute falling 96 LDU over 160 along +X: ten 16-LDU steps. */
function stairSlide(): LdrawPartMesh {
  const steps = Array.from({ length: 10 }, (_, i) => ({ min: [i * 16, -96 + i * 9.6, 0] as Vec3, max: [(i + 1) * 16, 0, 40] as Vec3 }));
  return boxMesh('27976', 'Slide  4 x  6 x  6', steps);
}

describe('slides', () => {
  it('reads a playground slide by its description only', () => {
    expect(isSlideDescription('Slide  6 x  6 x  6 Quarter Turn Left Down Going')).toBe(true);
    expect(isSlideDescription('~Slide  7 x 12 x  6.333 Half Turn')).toBe(true);
    expect(isSlideDescription('Slope Brick 45  2 x  2')).toBe(false);
  });

  it('runs the chute from its top to its foot, then a run-out along the last direction', () => {
    const path = slidePathLdu(brick('27976.dat'), stairSlide())!;
    expect(path.length).toBeGreaterThanOrEqual(5);
    // Top first (LDraw Y down: smallest y), then non-increasing height.
    for (let i = 1; i < path.length; i++) expect(path[i]![1]).toBeGreaterThanOrEqual(path[i - 1]![1] - 1e-9);
    // Descending along +X.
    expect(path[path.length - 2]![0]).toBeGreaterThan(path[0]![0]);
    const [a, z] = [path[path.length - 2]!, path[path.length - 1]!];
    expect(z[0] - a[0]).toBeCloseTo(RIDE.SLIDE_RUNOUT_LDU, 0);
  });

  it('runs on the chute bed, not along the tops of its side walls (10788)', () => {
    // A U-section chute: a bed falling 54 LDU along +X between walls standing 30 LDU over it,
    // as 27976's rails do. Reading the walls too started 10788's rider 30 LDU over the bed.
    const boxes = Array.from({ length: 10 }, (_, i) => [
      { min: [i * 16, -60 + i * 6, 8] as Vec3, max: [(i + 1) * 16, 0, 32] as Vec3 },
      { min: [i * 16, -90 + i * 6, 0] as Vec3, max: [(i + 1) * 16, 0, 8] as Vec3 },
      { min: [i * 16, -90 + i * 6, 32] as Vec3, max: [(i + 1) * 16, 0, 40] as Vec3 },
    ]).flat();
    const path = slidePathLdu(brick('27976.dat'), boxMesh('27976', 'Slide  4 x  6 x  6', boxes))!;
    // Every point of the running line is on the bed: between the walls, at the bed's height there.
    for (const q of path.slice(0, -1)) {
      expect(q[2]).toBeGreaterThan(8);
      expect(q[2]).toBeLessThan(32);
      const i = Math.min(9, Math.max(0, Math.floor(q[0] / 16)));
      expect(Math.abs(q[1] - (-60 + i * 6))).toBeLessThanOrEqual(6);
    }
    expect(path[0]![1]).toBeGreaterThan(-66);
  });

  it('a flat part called a slide is not a ride', () => {
    const flat = boxMesh('x', 'Slide  2 x  2 Flat', [{ min: [0, -8, 0], max: [40, 0, 40] }]);
    expect(slidePathLdu(brick('x.dat'), flat)).toBeNull();
    expect(findSlides([brick('x.dat')], new Map([['x.dat', flat]]))).toEqual([]);
  });
});

describe('lifts', () => {
  const PLATFORM = 'Brick  2 x  4 x  5 with Hole for Worm Screw  6L, Runners for Channels and Elevator Platform';
  /**
   * 10788's shaft, measured from its DbixConvV3 source: an elevator platform
   * (a 120-LDU runner block behind a 16-LDU platform) at the foot of four
   * stacked grooved door frames, and a room floor (a 2/3 brick) either side at
   * every storey: tops -16, -208, -400 and the attic's -592.
   */
  function dollhouse(): { bricks: ParsedBrick[]; meshes: Map<string, LdrawPartMesh> } {
    const meshes = new Map<string, LdrawPartMesh>();
    meshes.set('3863.dat', boxMesh('3863', PLATFORM, [{ min: [-50, -120, 18], max: [50, 0, 58] }, { min: [-50, -16, -50], max: [50, 0, 18] }]));
    meshes.set('bl_3417.dat', boxMesh('bl_3417', 'FRAME 3X6X6, W/ REDUCED KNOBS, CUT OUT', [{ min: [-60, -148, -30], max: [60, 0, 30] }]));
    meshes.set('2629.dat', boxMesh('2629', 'Brick, Modified 8 x 16 x 2/3 with 1 x 4 Indentations', [{ min: [0, -16, -60], max: [320, 0, 100] }]));
    meshes.set('2629l.dat', boxMesh('2629l', 'Brick, Modified 8 x 16 x 2/3 with 1 x 4 Indentations', [{ min: [-320, -16, -60], max: [0, 0, 100] }]));
    const bricks: ParsedBrick[] = [brick('3863.dat', 420, 0, -80)];
    for (const y of [0, -144, -288, -432]) bricks.push(brick('bl_3417.dat', 420, y, -30));
    for (const y of [0, -192, -384, -576]) bricks.push(brick('2629.dat', 480, y, 0), brick('2629l.dat', 360, y, 0));
    return { bricks, meshes };
  }

  it('finds the elevator platform in its column of frames and a stop at every floor it can reach', () => {
    const { bricks, meshes } = dollhouse();
    const lifts = findLifts(bricks, meshes);
    expect(lifts).toHaveLength(1);
    const lift = lifts[0]!;
    expect(lift.kind).toBe('lift');
    expect(lift.part).toBe('3863');
    // The car is the platform alone: the frames are the shaft and stay in the building.
    expect(lift.carBricks!.map(b => b.part)).toEqual(['3863.dat']);
    // Stops at the room floors (lowest first); the attic (-592) would take the runner block past the top frame.
    expect(lift.pathLdu.map(p => Math.round(p[1]))).toEqual([-16, -208, -400]);
    expect(lift.startStop).toBe(0);
    // The rider stands on the platform (its 16-LDU top, in front of the runner block), not on the block.
    for (const p of lift.pathLdu) { expect(p[0]).toBeCloseTo(420, 0); expect(p[2]).toBeLessThan(-80 + 18); expect(p[2]).toBeGreaterThan(-80 - 50); }
    // Each exit is on that storey's room floor, beside the shaft, inside the floor (not at its edge).
    lift.exitsLdu!.forEach((e, i) => {
      expect(e[1]).toBeCloseTo(lift.pathLdu[i]![1], 0);
      expect(e[0] > 480 || e[0] < 360).toBe(true);
      expect(e[2]).toBeGreaterThanOrEqual(-60 + RIDE.LIFT_EXIT_INSET_LDU);
    });
    expect(isLiftCarDescription(PLATFORM)).toBe(true);
    expect(isLiftCarDescription('Brick  2 x  4 x  5 with Platform and Hole for Worm Screw')).toBe(true);
    expect(isLiftColumnDescription('Door Frame  3 x  6 x  6 with Inside Grooves')).toBe(true);
    expect(isLiftGuideDescription('Support  2 x  2 x 13 with  5 Pegholes')).toBe(true);
    // Frame members are not guides (10303's Technic beams, 10341's girder tower: sweep 2026-09-26).
    expect(isLiftGuideDescription('Technic Beam 11')).toBe(false);
    expect(isLiftGuideDescription('Support  2 x  2 x 10 Girder Triangular  3 Sections with Axlehole')).toBe(false);
  });

  it('steps the rider off where the room floor has standing room, past furniture beside the shaft', () => {
    const { bricks, meshes } = dollhouse();
    // A 2 x 4 brick (a cabinet) on the ground floor right beside the shaft, as in 10788's right room.
    meshes.set('3001.dat', boxMesh('3001', 'Brick  2 x  4', [{ min: [-20, -24, -40], max: [20, 0, 40] }]));
    bricks.push(brick('3001.dat', 520, -16, 0));
    const lift = findLifts(bricks, meshes)[0]!;
    const e = lift.exitsLdu![0]!;
    const inside = e[0] > 500 - RIDE.LIFT_EXIT_INSET_LDU && e[0] < 540 + RIDE.LIFT_EXIT_INSET_LDU && e[2] > -40 - RIDE.LIFT_EXIT_INSET_LDU && e[2] < 40 + RIDE.LIFT_EXIT_INSET_LDU;
    expect(inside).toBe(false);
    expect(e[1]).toBeCloseTo(-16, 0);
  });

  it('a cap standing on supports is not a lift, and neither is a platform with no column', () => {
    // Before 2026-09-29 a lift was "a car on two supports": 10788's only such car was the top of
    // its shaft's back wall, which then flew over the roof while the platform stood still.
    const meshes = new Map<string, LdrawPartMesh>();
    meshes.set('91176.dat', boxMesh('91176', 'Support  2 x  2 x 13 with  5 Pegholes', [{ min: [-20, 0, -20], max: [20, 312, 20] }]));
    meshes.set('3002.dat', boxMesh('3002', 'Brick  2 x  3', [{ min: [-30, 0, -20], max: [30, 24, 20] }]));
    meshes.set('3863.dat', boxMesh('3863', PLATFORM, [{ min: [-50, -120, 18], max: [50, 0, 58] }, { min: [-50, -16, -50], max: [50, 0, 18] }]));
    const cap = [brick('91176.dat', 380, -424, 20), brick('91176.dat', 460, -424, 20), brick('3002.dat', 400, -456, 20), brick('3002.dat', 440, -456, 20)];
    expect(findLifts(cap, meshes)).toEqual([]);
    expect(findLifts([brick('3863.dat', 420, 0, -80)], meshes)).toEqual([]);
  });
});

describe('ride runtime', () => {
  /** A fake Script API world with one player sitting on one seat. */
  function world(path: Array<{ x: number; y: number; z: number }>, kind: 'slide' | 'lift', extra: Record<string, unknown> = {}) {
    const props = new Map<string, unknown>([['craftmatic:ride', 0], ['craftmatic:ride_scale', 1], ['craftmatic:ride_path', JSON.stringify(path)], ...Object.entries(extra)]);
    const seat: any = {
      id: 'seat1', typeId: 'craftmatic:t_ride', isValid: true, location: { ...path[0]! }, dimension: { getEntities: () => [] },
      getDynamicProperty: (k: string) => props.get(k), setDynamicProperty: (k: string, v: unknown) => props.set(k, v),
      tryTeleport(p: any) { this.location = { ...p }; return true; },
    };
    const player: any = { location: { ...path[0]! }, riding: seat, onScreenDisplay: { setActionBar: () => {} },
      getComponent: (n: string) => n === 'minecraft:riding' && player.riding ? { entityRidingOn: player.riding } : undefined,
      teleport(p: any) { this.location = { ...p }; } };
    seat.getComponent = (n: string) => n === 'minecraft:rideable' ? { getRiders: () => player.riding ? [player] : [], ejectRiders: () => { player.riding = undefined; } } : undefined;
    let tick = 0; let loop: () => void = () => {};
    (globalThis as any).world = { getAllPlayers: () => [player] };
    (globalThis as any).system = { get currentTick() { return tick; }, runInterval: (f: () => void) => { loop = f; } };
    _ridesRuntimeForTests({ seatType: 'craftmatic:t_ride', rides: [{ kind }], constants: RIDE });
    return { seat, player, props, run: (n: number) => { for (let i = 0; i < n; i++) { tick++; loop(); } } };
  }

  it('slides the rider to the foot, sets them down there and returns the seat to the top', () => {
    const path = [{ x: 0, y: 5, z: 0 }, { x: 4, y: 2, z: 0 }, { x: 6, y: 1, z: 0 }];
    const w = world(path, 'slide');
    w.run(1);
    expect(w.seat.location.x).toBeGreaterThan(0);
    w.run(200);
    expect(w.player.riding).toBeUndefined();
    expect(w.player.location.x).toBeCloseTo(6, 5);
    expect(w.seat.location).toEqual(path[0]);
  });

  it('a lift goes to the next storey, sets the rider on that floor and stays there', () => {
    const path = [{ x: 0, y: 0, z: 0 }, { x: 0, y: 4, z: 0 }, { x: 0, y: 8, z: 0 }];
    const exits = [{ x: 2, y: -0.5, z: 0 }, { x: 2, y: 3.5, z: 0 }, { x: 2, y: 7.5, z: 0 }];
    const w = world(path, 'lift', { 'craftmatic:ride_exits': JSON.stringify(exits), 'craftmatic:ride_stop': 1 });
    w.seat.location = { ...path[1]! };
    w.run(400);
    expect(w.player.riding).toBeUndefined();
    expect(w.player.location.y).toBeCloseTo(7.55, 5);
    expect(w.seat.location.y).toBeCloseTo(8, 5);
    expect(w.props.get('craftmatic:ride_stop')).toBe(2);
  });

  it('a tap on the car of a lift boards its seat (the seat is invisible; the car is what a child sees)', () => {
    const path = [{ x: 0, y: 0, z: 0 }, { x: 0, y: 4, z: 0 }];
    const props = new Map<string, unknown>([['craftmatic:ride', 0], ['craftmatic:ride_scale', 1], ['craftmatic:ride_path', JSON.stringify(path)], ['craftmatic:ride_exits', JSON.stringify(path)]]);
    const riders: any[] = [];
    const dim: any = {};
    const seat: any = { id: 'seat1', typeId: 'craftmatic:t_ride', isValid: true, location: { ...path[0]! }, dimension: dim,
      getDynamicProperty: (k: string) => props.get(k), setDynamicProperty: (k: string, v: unknown) => props.set(k, v), tryTeleport() { return true; },
      getComponent: (n: string) => (n === 'minecraft:rideable' ? { getRiders: () => riders, addRider: (e: any) => { riders.push(e); return true; }, ejectRiders: () => { riders.length = 0; } } : undefined) };
    const car: any = { id: 'car1', typeId: 'craftmatic:t_car', location: { x: 0, y: 0, z: 0.3 }, dimension: dim, getDynamicProperty: (k: string) => (k === 'craftmatic:ride' ? 0 : undefined) };
    dim.getEntities = (q: { type?: string }) => (q.type === 'craftmatic:t_ride' ? [seat] : q.type === 'craftmatic:t_car' ? [car] : []);
    const player: any = { typeId: 'minecraft:player', location: { x: 1, y: 0, z: 0 }, onScreenDisplay: { setActionBar: () => {} }, getComponent: () => undefined, runCommand: () => {} };
    const subs: Record<string, (ev: any) => void> = {};
    (globalThis as any).world = { getAllPlayers: () => [player], afterEvents: {
      playerInteractWithEntity: { subscribe: (f: any) => { subs.interact = f; } }, entityHitEntity: { subscribe: (f: any) => { subs.hit = f; } } } };
    (globalThis as any).system = { currentTick: 0, runInterval: () => {} };
    _ridesRuntimeForTests({ seatType: 'craftmatic:t_ride', rides: [{ kind: 'lift', carType: 'craftmatic:t_car' }], constants: RIDE });
    subs.hit!({ damagingEntity: player, hitEntity: car });
    expect(riders).toEqual([player]);
    // A tap on anything else boards nothing; a second tap does not add the rider twice.
    subs.interact!({ player, target: { typeId: 'minecraft:cow', dimension: dim, location: car.location } });
    subs.interact!({ player, target: car });
    expect(riders).toEqual([player]);
  });

  it('serialises into a module that names only Script API globals', () => {
    const src = ridesScript({ seatType: 'x:y', rides: [{ kind: 'slide' }], constants: RIDE });
    expect(src).toMatch(/^import \{ world, system \} from '@minecraft\/server';/);
    expect(() => new Function('world', 'system', src.replace(/^import.*\n/, ''))).not.toThrow();
  });
});

describe('scene classification added for the Gabby sets', () => {
  it('a title that joins a vehicle to a place is a scene, not one craft', () => {
    expect(isVehicleAndPlaceLabel("Gabby & MerCat's Ship & Spa (10786-1)")).toBe(true);
    expect(isWholeVehicleLabel("Gabby & MerCat's Ship & Spa (10786-1)")).toBe(false);
    expect(isWholeVehicleLabel('Beach Buggy (31000-1)')).toBe(true);
    expect(isWholeVehicleLabel('Pirate Ship (10365-1)')).toBe(true);
  });

  it('a playground swing is a seat', () => {
    expect(isSwingSeat('Friends Swing 2 x 6 x 5 1/3')).toBe(true);
    expect(isFurnitureSeat('Friends Swing Seat')).toBe(true);
    expect(isSwingSeat('Swing Arm 1 x 4')).toBe(false);
  });
});
