/**
 * The player sits in the driver's seat (cockpit-seat.ts), 2026-09-26.
 *
 * Before: a model smaller than the player (a display car shrunk to its real
 * length) sat the rider ON its roof like a kart; the first-person view looked
 * down on the car. Now the seat is always the driver's, a body that does not
 * fit at the placed size is hidden (vehicle-camera.js), and the wand size from
 * which it fits draws it in the seat.
 */
import { describe, expect, it } from 'vitest';
import { BlockGrid } from '../src/schem/types.js';
import { buildPlayableAddon } from '../web/src/engine/playable-addon.js';
import { extractFile } from '../web/src/engine/zip-utils.js';
import { keepsTheView, planSeat, riderOverlap, riderVisibleAt, riderVisibleSizes, seatPositionAt, SEAT_FIT_TOLERANCE, type BoxBlocks, type Vec3 } from '../web/src/engine/cockpit-seat.js';
import { SEATED_EYE_HEIGHT_BLOCKS } from '../web/src/engine/lego-scale.js';

const ab = (bytes: Uint8Array) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
const box = (min: Vec3, max: Vec3): BoxBlocks => ({ min, max });

/** A closed cabin (blocks): floor 0..0.15, walls at |x| = w, roof from `roofY` up, open fore and aft. */
const cabin = (w: number, roofY: number): BoxBlocks[] => [
  box([-w - 0.2, 0, -2], [w + 0.2, 0.15, 2]),
  box([-w - 0.2, 0, -2], [-w, roofY, 2]),
  box([w, 0, -2], [w + 0.2, roofY, 2]),
  box([-w - 0.2, roofY, -2], [w + 0.2, roofY + 0.2, 2]),
];

describe('riderOverlap / planSeat', () => {
  it('fits a seated player in a cabin with room, and not under a low roof', () => {
    const seat: Vec3 = [0, 0.2, 0];
    expect(riderOverlap(cabin(0.9, 2.2), seat)).toEqual({ head: 0, torso: 0 });
    // A roof at 1.2 blocks runs through the head (eye at 1.45) and the shoulders.
    const low = riderOverlap(cabin(0.9, 1.2), seat);
    expect(low.head).toBeGreaterThan(SEAT_FIT_TOLERANCE.head);
    // Flanks at |x| = 0.3 go through the arms (0.45 either side).
    expect(riderOverlap(cabin(0.3, 2.2), seat).torso).toBeGreaterThan(SEAT_FIT_TOLERANCE.torso);
  });

  it('counts a body sunk below the model floor as not fitting (the ground is there)', () => {
    // No boxes at all, but the seat is a block under the floor.
    expect(riderOverlap([], [0, -1, 0]).torso).toBeGreaterThan(0.9);
    expect(riderOverlap([], [0, 0.1, 0])).toEqual({ head: 0, torso: 0 });
  });

  it('finds the smallest wand size at which the body fits (the model scales, the player does not)', () => {
    // A quarter-size cabin: 0.55 blocks inside, the driver's eye 0.3 over the floor.
    const small = [box([-0.5, 0, -2], [0.5, 0.03, 2]), box([-0.5, 0, -2], [-0.3, 0.55, 2]), box([0.3, 0, -2], [0.5, 0.55, 2]), box([-0.5, 0.55, -2], [0.5, 0.6, 2])];
    const eye: Vec3 = [0, 0.3, 0];
    const plan = planSeat(small, eye, [0, eye[1] - SEATED_EYE_HEIGHT_BLOCKS, 0]);
    expect(plan.steps.map(s => s.f)).toEqual([1, 1.5, 2, 3, 4]);
    expect(plan.steps[0]!.fits).toBe(false);
    // At 400 % it is a minifig-scale cabin (eye 1.2 blocks up, roof at 2.2).
    expect(plan.fitScale).toBe(4);
    expect(riderVisibleAt(plan, 1)).toBe(false);
    expect(riderVisibleAt(plan, 3)).toBe(false);
    expect(riderVisibleAt(plan, 4)).toBe(true);
    expect(riderVisibleSizes(plan)).toEqual([4]);
    expect(riderVisibleSizes(undefined)).toBeNull();
    // Below 100 % the model is smaller than it was measured at: never drawn.
    expect(riderVisibleAt(plan, 0.5)).toBe(false);
  });

  it('keeps the rider\'s EYE on the scaled driver\'s eye at every size (the model scales, the player does not)', () => {
    const seat: Vec3 = [0.4, -0.3, 1.6];
    const at2 = seatPositionAt(seat, 2);
    expect(at2[1] + SEATED_EYE_HEIGHT_BLOCKS).toBeCloseTo((seat[1] + SEATED_EYE_HEIGHT_BLOCKS) * 2, 6);
    expect(at2[0]).toBeCloseTo(0.8);
    expect(at2[2]).toBeCloseTo(3.2);
    // A quarter-scale seat under the floor is a minifig-scale seat above it at 400 %.
    expect(seatPositionAt([0, -0.84, 0], 4)[1]).toBeCloseTo((0.41) * 4 - SEATED_EYE_HEIGHT_BLOCKS, 6);
    expect(seatPositionAt([0, -0.84, 0], 4)[1]).toBeGreaterThan(0);
  });
});

describe('the player sits in the driver\'s seat of a car too small for them', () => {
  const box6 = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): string[] => {
    const q = (a: number[], b: number[], c: number[], d: number[]): string => `4 16 ${[...a, ...b, ...c, ...d].join(' ')}`;
    return [
      q([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]), q([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]),
      q([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]), q([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]),
      q([x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]), q([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]),
    ];
  };
  // A minifig-scale cabin (LDraw, Y down): a floor plate, a seat mould on it,
  // two walls 120 LDU high, a roof plate on them and four wheels.
  const LIB: Record<string, string> = {
    floorplate: ['0 Plate 6 x 12', ...box6(-60, 60, -8, 0, -120, 120)].join('\n'),
    '4079': ['0 Minifig Seat 2 x 2', ...box6(-20, 20, -8, 0, -20, 20)].join('\n'),
    wall: ['0 Brick 1 x 12 x 5', ...box6(-10, 10, -120, 0, -120, 120)].join('\n'),
    roof: ['0 Plate 7 x 12', ...box6(-70, 70, -8, 0, -120, 120)].join('\n'),
    wheel: ['0 Wheel 18mm D. x 14mm', ...box6(-7, 7, -18, 18, -18, 18)].join('\n'),
  };
  const bricks = [
    { part: 'floorplate.dat', color: 4, x: 0, y: 0, z: 0 },
    { part: '4079.dat', color: 0, x: 0, y: -8, z: 20 },
    { part: 'wall.dat', color: 4, x: -60, y: -8, z: 0 },
    { part: 'wall.dat', color: 4, x: 60, y: -8, z: 0 },
    { part: 'roof.dat', color: 4, x: 0, y: -128, z: 0 },
    ...[[-67, -90], [67, -90], [-67, 90], [67, 90]].map(([x, z]) => ({ part: 'wheel.dat', color: 0, x: x!, y: 10, z: z! })),
  ];
  const provider = async () => {
    const { createPartGeometryProvider } = await import('../web/src/engine/ldraw-part-geometry.js');
    return createPartGeometryProvider({ fetchPartText: async id => LIB[id.replace(/^.*\//, '').replace(/\.dat$/, '')] ?? null });
  };
  const build = async (modelScale: number) => {
    const grid = new BlockGrid(4, 4, 4);
    grid.set(1, 1, 1, 'minecraft:red_concrete');
    const result = await buildPlayableAddon(grid, {
      stem: 'cabin', components: [{ id: 'car', label: 'Cabin Car', kind: 'car', grid, provenance: 'test', bricks }],
      partGeometry: await provider(), vehicleFacing: "-z", modelScale,
    });
    const buffer = ab(result.bytes);
    const read = async (n: string): Promise<string> => new TextDecoder().decode(await extractFile(buffer, n));
    const entity = JSON.parse(await read('Craftmatic_cabin_BP/entities/cabin_car.json'))['minecraft:entity'];
    const camera = await read('Craftmatic_cabin_BP/scripts/vehicle-camera.js');
    return { entity, camera };
  };

  it('at minifig scale the body fits the seat: the rider is drawn there at 100 %', async () => {
    const { entity, camera } = await build(1);
    const seats = entity.components['minecraft:rideable'].seats;
    const seat = (Array.isArray(seats) ? seats[0] : seats).position as number[];
    // Eye 51 LDU above the seat mould (at 8 LDU over the plate, the plate 28 LDU over the wheels. bottom), less the seated eye height.
    expect(seat[1]).toBeCloseTo((28 + 8 + 51) / 53.333 - SEATED_EYE_HEIGHT_BLOCKS, 1);
    expect(camera).toContain('"riderVisibleSizes":[1,1.5,2');
  });

  it('at quarter scale the seat stays in the cockpit (not on the roof) and the rider is hidden until it fits', async () => {
    const { entity, camera } = await build(0.25);
    const seats = entity.components['minecraft:rideable'].seats;
    const seat = (Array.isArray(seats) ? seats[0] : seats).position as number[];
    const roof = (28 + 128) * 0.25 / 53.333;
    // The kart rule would have put the hips at roof - 0.55 or higher; the eye
    // (seat + 1.25) is now the driver's, under the roof.
    expect(seat[1] + SEATED_EYE_HEIGHT_BLOCKS).toBeLessThan(roof);
    expect(seat[1] + SEATED_EYE_HEIGHT_BLOCKS).toBeCloseTo((28 + 8 + 51) * 0.25 / 53.333, 1);
    const sizes = JSON.parse(/"riderVisibleSizes":(\[[^\]]*\])/.exec(camera)?.[1] ?? 'null') as number[];
    const from = sizes.length ? sizes[0]! : 99;
    expect(from).toBeGreaterThan(1);
    // The camera script hides a rider below that size and lets go of the effect after.
    expect(camera).toMatch(/addEffect\(["']invisibility/);
    expect(camera).toMatch(/removeEffect\(["']invisibility/);
    // Size groups: the eye stays on the scaled driver's eye; at 400 % this quarter-scale
    // car is the minifig-scale one, and the body fits there.
    const groups = entity.component_groups;
    const at = (pct: number): number[] => { const s = groups[`craftmatic:size_${pct}`]['minecraft:rideable'].seats; return (Array.isArray(s) ? s[0] : s).position; };
    expect(at(200)[1] + SEATED_EYE_HEIGHT_BLOCKS).toBeCloseTo((seat[1] + SEATED_EYE_HEIGHT_BLOCKS) * 2, 2);
    expect(at(400)[1]).toBeGreaterThan(0);
    expect(from).toBeLessThanOrEqual(4);
  });

  it('hides a rider while the car is too small for them and shows them again at the size that fits (vehicle-camera.js)', async () => {
    const { camera } = await build(0.25);
    const sizes = JSON.parse(/"riderVisibleSizes":(\[[^\]]*\])/.exec(camera)?.[1] ?? 'null') as number[];
    const from = sizes.length ? sizes[0]! : 99;
    let scale = 1;
    let riders: unknown[] = [];
    const effects: string[] = [];
    const player = {
      id: 'p1', typeId: 'minecraft:player', selectedSlotIndex: 0,
      getRotation: () => ({ x: 0, y: 0 }),
      camera: { setCamera: () => {}, clear: () => {} },
      runCommand: () => {}, sendMessage: () => {},
      addEffect: (name: string) => { effects.push(`+${name}`); },
      removeEffect: (name: string) => { effects.push(`-${name}`); },
    };
    const vehicle = {
      typeId: 'craftmatic:cabin_car', location: { x: 0, y: 0, z: 0 },
      getRotation: () => ({ x: 0, y: 0 }), getProperty: () => 0,
      getComponent: (name: string) => name === 'minecraft:scale' ? { value: scale } : name === 'minecraft:rideable' ? { getRiders: () => riders } : undefined,
    };
    let tick: () => void = () => {};
    const world = {
      getDimension: (id: string) => ({ getEntities: () => id === 'overworld' ? [vehicle] : [] }),
      getAllPlayers: () => [player],
      afterEvents: { playerLeave: { subscribe: () => {} } },
    };
    const system = { runInterval: (fn: () => void) => { tick = fn; } };
    new Function('world', 'system', camera.replace(/^import .*;\n/, ''))(world, system);
    riders = [player];
    tick();
    expect(effects).toEqual(['+invisibility']);
    // Placed at the size the body fits: drawn again.
    scale = from;
    tick();
    expect(effects).toEqual(['+invisibility', '-invisibility']);
    // Back to 100 %, then dismount: the effect the script added goes with the ride.
    scale = 1;
    tick();
    riders = [];
    tick();
    expect(effects).toEqual(['+invisibility', '-invisibility', '+invisibility', '-invisibility']);
  });
});

describe('the seat search (a canopy is a volume, not a seat)', () => {
  it('moves a windscreen-centre seat back to where the body fits, and never moves a seat mould', () => {
    // A cabin 1.9 wide, roof at 2.1, with a dashboard filling everything forward of z = 0.2.
    const boxes = [...cabin(0.95, 2.1), box([-0.95, 0, -2], [0.95, 1.2, 0.2])];
    const eye: Vec3 = [0.3, 1.3, 0.1];
    const seat: Vec3 = [0.3, eye[1] - SEATED_EYE_HEIGHT_BLOCKS, 0.1];
    const volume = planSeat(boxes, eye, seat, 'volume');
    expect(volume.fitScale).toBe(1);
    expect(volume.moved).not.toBeNull();
    expect(volume.seat[2]).toBeGreaterThan(seat[2]);
    // The same point as a seat mould's is the seat: measured where it is.
    const mould = planSeat(boxes, eye, seat, 'seat');
    expect(mould.moved).toBeNull();
    expect(mould.seat).toEqual(seat);
    expect(mould.fitScale).not.toBe(1);
  });

  it('never walks a seat out of a roofed cabin onto an open deck behind it', () => {
    // A low roofed cabin (z -1..0.5) the body cannot fit, then an open deck behind (z 0.5..2).
    const boxes = [
      box([-1, 0, -1], [1, 0.3, 2]),
      box([-1.2, 0, -1], [-1, 1.2, 0.5]), box([1, 0, -1], [1.2, 1.2, 0.5]),
      box([-1.2, 1.2, -1], [1.2, 1.5, 0.5]),
    ];
    const seat: Vec3 = [0, 0, 0];
    const plan = planSeat(boxes, [0, SEATED_EYE_HEIGHT_BLOCKS, 0], seat, 'volume');
    // Without the cabin rule the search reaches z 0.9, over the open deck, and "fits".
    expect(plan.seat[2]).toBeLessThanOrEqual(0.5);
  });

  it('never moves a seat into the last 6 % of the model (no driver sits on a bumper)', () => {
    // A 4.1-block floor and a waist-high block over the evidence seat up to z 1.95: the
    // body is clear of it only from z ~2.03, within 0.07 of the tail (margin 0.25).
    const boxes = [box([-1, 0, -2], [1, 0.1, 2.1]), box([-1, 0.1, 0.5], [1, 1.0, 1.95])];
    const plan = planSeat(boxes, [0, 1.35, 1.2], [0, 0.1, 1.2], 'volume');
    expect(plan.moved).toBeNull();
    expect(plan.seat[2]).toBe(1.2);
  });

  it('keeps a still-hidden rider\'s eye out of the model rather than trade it for a bigger fit size', () => {
    // 1989 Batmobile (census 2026-09-26): the canopy seat had 32 % of the head in the body at 100 %;
    // a seat 0.9 back fit from 300 % with 73 %. Hidden at 100 % either way, so the view decides.
    expect(keepsTheView({ fits: false, head: 0.73 }, 0.32)).toBe(false);
    expect(keepsTheView({ fits: false, head: 0.2 }, 0.32)).toBe(true);
    // A seat the body fits at 100 % is drawn there, whatever the evidence's view was.
    expect(keepsTheView({ fits: true, head: 0.05 }, 0)).toBe(true);
  });

  it('does not draw a rider whose pelvis would stick out under the floor', () => {
    const open: BoxBlocks[] = [];
    // Hips 0.27 under the floor at 100 %; from 150 % the scaled eye lifts them clear.
    expect(planSeat(open, [0, 0.98, 0], [0, -0.27, 0]).fitScale).toBe(1.5);
    expect(planSeat(open, [0, 1.14, 0], [0, -0.11, 0]).fitScale).toBe(1);
  });
});
