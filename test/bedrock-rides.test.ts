/**
 * Slides and lifts (engine/bedrock-rides.ts): the chute is read from a part's
 * top surface, a lift from its guides, car and floors, and the runtime carries
 * a seated player along the world path the placement wrote and sets them down.
 */
import { describe, expect, it } from 'vitest';
import { RIDE, _ridesRuntimeForTests, findLifts, findSlides, isLiftGuideDescription, isSlideDescription, ridesScript, slidePathLdu } from '../web/src/engine/bedrock-rides.js';
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

  it('a flat part called a slide is not a ride', () => {
    const flat = boxMesh('x', 'Slide  2 x  2 Flat', [{ min: [0, -8, 0], max: [40, 0, 40] }]);
    expect(slidePathLdu(brick('x.dat'), flat)).toBeNull();
    expect(findSlides([brick('x.dat')], new Map([['x.dat', flat]]))).toEqual([]);
  });
});

describe('lifts', () => {
  /** Two 312-LDU supports, a car on top of them, and three storeys of tiles at the shaft's side. */
  function dollhouse(): { bricks: ParsedBrick[]; meshes: Map<string, LdrawPartMesh> } {
    const meshes = new Map<string, LdrawPartMesh>();
    meshes.set('91176.dat', boxMesh('91176', 'Support  2 x  2 x 13 with  5 Pegholes', [{ min: [-20, 0, -20], max: [20, 312, 20] }]));
    meshes.set('3002.dat', boxMesh('3002', 'Brick  2 x  3', [{ min: [-30, 0, -20], max: [30, 24, 20] }]));
    meshes.set('3795.dat', boxMesh('3795', 'Plate  2 x  6', [{ min: [-60, 0, -20], max: [60, 8, 20] }]));
    meshes.set('3069a.dat', boxMesh('3069a', 'Tile  1 x  2', [{ min: [-10, 0, -20], max: [10, 8, 20] }]));
    const bricks: ParsedBrick[] = [
      brick('91176.dat', 380, -424, 20), brick('91176.dat', 460, -424, 20),
      // The car: a plate on the supports' tops and two bricks on it.
      brick('3795.dat', 420, -432, 20), brick('3002.dat', 400, -456, 20), brick('3002.dat', 440, -456, 20),
    ];
    // Storeys at y -16, -192, -384, -576: three tiles each beside the shaft (x 510..530).
    for (const y of [-16, -192, -384, -576]) for (const z of [-20, 20, 60]) bricks.push(brick('3069a.dat', 520, y, z));
    return { bricks, meshes };
  }

  it('finds the car between the guides and a stop at every storey', () => {
    const { bricks, meshes } = dollhouse();
    const lifts = findLifts(bricks, meshes);
    expect(lifts).toHaveLength(1);
    const lift = lifts[0]!;
    expect(lift.kind).toBe('lift');
    expect(lift.carBricks).toHaveLength(3);
    expect(lift.pathLdu).toHaveLength(4);
    // Lowest first, and the car keeps its height over each storey (its floor is 40 over -384).
    expect(lift.pathLdu.map(p => Math.round(p[1]))).toEqual([-56, -232, -424, -616]);
    expect(lift.startStop).toBe(2);
    // Exits step past the shaft into the room at +X.
    for (const e of lift.exitsLdu!) expect(e[0]).toBeGreaterThan(480);
    expect(isLiftGuideDescription('Support  2 x  2 x 13 with  5 Pegholes')).toBe(true);
  });

  it('a single post is not a shaft', () => {
    const { bricks, meshes } = dollhouse();
    expect(findLifts(bricks.filter((b, i) => !(b.part === '91176.dat' && i === 1)), meshes)).toEqual([]);
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
