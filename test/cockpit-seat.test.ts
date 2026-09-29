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
import { RIDER_EYE_ABOVE_SEAT, VIEW, eyeOverlap, forwardClear, forwardView, keepsTheView, planSeat, riderOverlap, riderVisibleAt, riderVisibleSizes, seatPositionAt, SEAT_FIT_TOLERANCE, type BoxBlocks, type Vec3 } from '../web/src/engine/cockpit-seat.js';

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
    const plan = planSeat(small, eye, [0, eye[1] - RIDER_EYE_ABOVE_SEAT, 0]);
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
    expect(at2[1] + RIDER_EYE_ABOVE_SEAT).toBeCloseTo((seat[1] + RIDER_EYE_ABOVE_SEAT) * 2, 6);
    expect(at2[0]).toBeCloseTo(0.8);
    expect(at2[2]).toBeCloseTo(3.2);
    // A quarter-scale seat under the floor is a minifig-scale seat above it at 400 %.
    expect(seatPositionAt([0, 0.41 - RIDER_EYE_ABOVE_SEAT, 0], 4)[1]).toBeCloseTo((0.41) * 4 - RIDER_EYE_ABOVE_SEAT, 6);
    expect(seatPositionAt([0, 0.41 - RIDER_EYE_ABOVE_SEAT, 0], 4)[1]).toBeGreaterThan(0);
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
    expect(seat[1]).toBeCloseTo((28 + 8 + 51) / 53.333 - RIDER_EYE_ABOVE_SEAT, 1);
    expect(camera).toContain('"riderVisibleSizes":[1,1.5,2');
  });

  it('at quarter scale the seat stays in the cockpit (not on the roof) and the rider is hidden until it fits', async () => {
    const { entity, camera } = await build(0.25);
    const seats = entity.components['minecraft:rideable'].seats;
    const seat = (Array.isArray(seats) ? seats[0] : seats).position as number[];
    const roof = (28 + 128) * 0.25 / 53.333;
    // The kart rule would have put the hips at roof - 0.55 or higher; the eye
    // (seat + 1.25) is now the driver's, under the roof.
    expect(seat[1] + RIDER_EYE_ABOVE_SEAT).toBeLessThan(roof);
    expect(seat[1] + RIDER_EYE_ABOVE_SEAT).toBeCloseTo((28 + 8 + 51) * 0.25 / 53.333, 1);
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
    expect(at(200)[1] + RIDER_EYE_ABOVE_SEAT).toBeCloseTo((seat[1] + RIDER_EYE_ABOVE_SEAT) * 2, 2);
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

describe('glass is a shell', () => {
  it('does not count a canopy\'s translucent cuboids against the rider (76286\'s pilot)', () => {
    // A canopy filling the space around the head and chest, as a curved canopy mould's cuboids do.
    const canopy: BoxBlocks = { min: [-0.6, 0.3, -0.6], max: [0.6, 1.6, 0.6], glass: true };
    expect(riderOverlap([canopy], [0, 0, 0])).toEqual({ head: 0, torso: 0 });
    expect(riderOverlap([{ ...canopy, glass: false }], [0, 0, 0]).head).toBeGreaterThan(0.9);
  });
});

describe('the cockpit evidence', () => {
  it('never reads a clear engine cylinder as glass (42172 seated its driver in the engine bay)', async () => {
    const { findCockpit } = await import('../web/src/engine/ldraw-entity-compiler.js');
    const mesh = (description: string, size: number) => ({
      partId: description, resolvedAs: description, studs: [], unresolvedRefs: [], description,
      triangles: [{ a: [0, 0, 0], b: [size, 0, 0], c: [0, -size, size], color: 16 }],
      bounds: { min: [0, -size, 0], max: [size, 0, size] },
    }) as never;
    const meshes = new Map([['cyl.dat', mesh('Technic Engine Cylinder Head with Bottom Slots', 60)], ['body.dat', mesh('Brick 2 x 4', 40)]]);
    const placed = [
      { part: 'body.dat', color: 4, x: -200, y: 0, z: 0 }, { part: 'body.dat', color: 4, x: 200, y: 0, z: 0 },
      // The clear cylinders sit behind the middle; the nose is -x.
      { part: 'cyl.dat', color: 47, x: 100, y: -40, z: 0 },
    ];
    const cockpit = findCockpit(placed as never, meshes, { nose: '-x', isXLongitudinal: true, forwardSign: -1, spanX: 400, spanZ: 40 });
    expect(cockpit.source).toBe('default-cabin');
    // The same part in a glass description is still glass.
    const glassMeshes = new Map([['cyl.dat', mesh('Glass for Window 1 x 4 x 3', 60)], ['body.dat', mesh('Brick 2 x 4', 40)]]);
    expect(findCockpit(placed as never, glassMeshes, { nose: '-x', isXLongitudinal: true, forwardSign: -1, spanX: 400, spanZ: 40 }).source).toBe('translucent-canopy');
  });

  // A hull 400 long along x (nose -x), a figure kit, a steering stand and a ship's wheel.
  const boxMesh = (description: string, min: [number, number, number], max: [number, number, number]) => ({
    partId: description, resolvedAs: description, studs: [], unresolvedRefs: [], description,
    triangles: [{ a: min, b: max, c: [min[0], max[1], max[2]], color: 16 }], bounds: { min, max },
  }) as never;
  const KIT = new Map([
    ['hull.dat', boxMesh('Boat Hull 8 x 20', [-200, 0, -40], [200, 60, 40])],
    ['deck.dat', boxMesh('Plate  2 x  4', [-40, 0, -20], [40, 8, 20])],
    ['973.dat', boxMesh('Minifig Torso', [-19, -12, -10], [19, 32, 10])],
    ['3626c.dat', boxMesh('Minifig Head with Closed Hollow Stud', [-13, 0, -13], [13, 24, 13])],
    ['3815.dat', boxMesh('Minifig Hips', [-18, -11, -10], [18, 21, 10])],
    ['3816.dat', boxMesh('Minifig Leg Right', [-19.5, -9, -11], [-1.5, 28, 9])],
    ['3817.dat', boxMesh('Minifig Leg Left', [1.5, -9, -11], [19.5, 28, 9])],
    ['3829c01.dat', boxMesh('Car Steering Stand and Wheel (Complete)', [-10, -20, -10], [10, 0, 10])],
    ['4790b.dat', boxMesh('Boat Ship Wheel', [-52, 0, -52], [52, 40, 52])],
  ]);
  const SIT = [1, 0, 0, 0, 0, -1, 0, 1, 0];
  /** A minifig with its torso origin at (x, y, z); `bust`: torso and head only (a figurehead). */
  const fig = (x: number, y: number, z: number, opts: { sitting?: boolean; bust?: boolean } = {}) => [
    { part: '973.dat', color: 4, x, y, z }, { part: '3626c.dat', color: 14, x, y: y - 24, z },
    ...(opts.bust ? [] : [
      { part: '3815.dat', color: 1, x, y: y + 32, z },
      { part: '3816.dat', color: 1, x, y: y + 44, z, ...(opts.sitting ? { rot: SIT } : {}) },
      { part: '3817.dat', color: 1, x, y: y + 44, z, ...(opts.sitting ? { rot: SIT } : {}) },
    ]),
  ];
  const hull = [{ part: 'hull.dat', color: 4, x: 0, y: 0, z: 0 }, { part: 'deck.dat', color: 4, x: -210, y: -150, z: 0 }, { part: 'deck.dat', color: 4, x: 210, y: -150, z: 0 }, { part: 'deck.dat', color: 4, x: 0, y: -150, z: 40 }, { part: 'deck.dat', color: 4, x: 0, y: -150, z: -40 }];
  const frame = { nose: '-x' as const, isXLongitudinal: true, forwardSign: -1, spanX: 420, spanZ: 80 };

  it('drives a boat from its ship\'s wheel, standing aft of it; a figurehead (a bust) never drives', async () => {
    const { findCockpit } = await import('../web/src/engine/ldraw-entity-compiler.js');
    const placed = [...hull, ...fig(-150, -120, 0, { bust: true }), { part: '4790b.dat', color: 6, x: 120, y: -60, z: 0 }];
    const cockpit = findCockpit(placed as never, KIT, { ...frame, kind: 'boat' });
    expect(cockpit.source).toBe('steering-wheel');
    // Aft of the wheel (+x on a -x nose) by 30, 35 over its hub.
    expect(cockpit.eyeLdu).toEqual([150, -95, 0]);
    expect(cockpit.driverParts).toEqual([]);
  });

  it('seats a boat\'s driver at the stern when nothing steers it, and never under its hull', async () => {
    const { findCockpit } = await import('../web/src/engine/ldraw-entity-compiler.js');
    // Two seated figures on deck; a steering stand stowed UNDER the hull (60221's scooter).
    const placed = [...hull, ...fig(-120, -120, 0, { sitting: true }), ...fig(120, -120, 0, { sitting: true }), { part: '3829c01.dat', color: 0, x: 0, y: 100, z: 0 }];
    const boat = findCockpit(placed as never, KIT, { ...frame, kind: 'boat' });
    expect(boat.source).toBe('seated-figure');
    expect(boat.detail).toMatch(/torso 973 at 120,/);
    // The same model as a car: the stand is not under a hull there, and a figure far from it is a passenger.
    const car = findCockpit(placed as never, KIT, { ...frame, kind: 'car' });
    expect(car.source).toBe('steering-wheel');
  });

  it('gives a car\'s controls to the figure at the wheel, not the one in the back', async () => {
    const { findCockpit } = await import('../web/src/engine/ldraw-entity-compiler.js');
    const placed = [...hull, { part: '3829c01.dat', color: 0, x: -100, y: -80, z: 0 }, ...fig(-70, -120, 0, { sitting: true }), ...fig(140, -120, 0, { sitting: true })];
    const cockpit = findCockpit(placed as never, KIT, { ...frame, kind: 'car' });
    expect(cockpit.source).toBe('seated-figure');
    expect(cockpit.detail).toMatch(/torso 973 at -70,/);
  });
});

describe('the seat search (a canopy is a volume, not a seat)', () => {
  it('moves a windscreen-centre seat back to where the body fits, and never moves a seat mould', () => {
    // A cabin 1.9 wide, roof at 2.1, with a dashboard filling everything forward of z = 0.2.
    const boxes = [...cabin(0.95, 2.1), box([-0.95, 0, -2], [0.95, 1.2, 0.2])];
    const eye: Vec3 = [0.3, 1.3, 0.1];
    const seat: Vec3 = [0.3, eye[1] - RIDER_EYE_ABOVE_SEAT, 0.1];
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
    const plan = planSeat(boxes, [0, RIDER_EYE_ABOVE_SEAT, 0], seat, 'volume');
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

  it('moves a hidden rider\'s eye out of the body into the cabin air, and never out through the roof', () => {
    // 42172 on the Saga: the canopy-centre eye sat inside the body; the cockpit view was dark cuboids.
    const boxes = [box([-1, 0, -2], [1, 0.1, 2]), box([-1, 0.1, -2], [1, 1.0, 0.3]), box([-1.2, 1.3, -2], [1.2, 1.5, 2])];
    const plan = planSeat(boxes, [0, 0.8, 0], [0, 0.8 - RIDER_EYE_ABOVE_SEAT, 0], 'seat');
    expect(plan.fitScale).not.toBe(1);
    expect(plan.eyeMoved).not.toBeNull();
    expect(eyeOverlap(boxes, plan.eye)).toBe(0);
    // Still under the roof (1.3), not over it.
    expect(plan.eye[1]).toBeLessThan(1.3);
    expect(plan.seat[1]).toBeCloseTo(plan.eye[1] - RIDER_EYE_ABOVE_SEAT, 6);
  });

  it('gives a hidden rider a view out ahead: over the dashboard, through glass', () => {
    // A dashboard up to 1.0 in front (z < -0.3), a sloped windscreen whose bounding box fills the cabin
    // ahead (glass), a roof at 1.6. The eye at 0.8 looks into the dash; at 1.1+ it looks out.
    const boxes: BoxBlocks[] = [
      box([-1, 0, -2], [1, 0.1, 2]), box([-1, 0.1, -2], [1, 1.0, -0.3]),
      { min: [-1, 1.0, -1.2], max: [1, 1.6, 0.2], glass: true }, box([-1.2, 1.6, -2], [1.2, 1.8, 2]),
      // Something the body cannot fit past at any size: a bar through the torso.
      box([-1, 0.2, -0.3], [1, 0.5, 0.3]),
    ];
    expect(forwardClear(boxes, [0, 0.8, 0])).toBe(false);
    expect(forwardClear(boxes, [0, 1.2, 0])).toBe(true);
    const plan = planSeat(boxes, [0, 0.8, 0], [0, 0.8 - RIDER_EYE_ABOVE_SEAT, 0], 'seat');
    expect(plan.eyeMoved).not.toBeNull();
    expect(forwardClear(boxes, plan.eye)).toBe(true);
    // The glass's box does not count as solid for the eye.
    expect(eyeOverlap(boxes, plan.eye)).toBe(0);
    expect(plan.eye[1]).toBeLessThan(1.6);
  });

  it('does not draw a rider whose pelvis would stick out under the floor', () => {
    const open: BoxBlocks[] = [];
    // Hips 0.27 under the floor at 100 %; from 150 % the scaled eye lifts them clear.
    expect(planSeat(open, [0, 0.98, 0], [0, -0.27, 0]).fitScale).toBe(1.5);
    expect(planSeat(open, [0, 1.14, 0], [0, -0.11, 0]).fitScale).toBe(1);
  });
});

describe('a guessed seat (no cockpit evidence) is judged by what its eye sees', () => {
  /**
   * A doll-scale truck, 3 blocks long (nose at -Z): a closed cab 1.3 tall at the front with walls
   * and a roof round the default-cabin eye, and a flat bed 0.9 tall behind it. The guessed eye sits
   * inside the cab under its roof - the Saga's view from 10797's cat bus was a wall of colour.
   */
  const dollTruck: BoxBlocks[] = [
    box([-0.6, 0, -1.5], [0.6, 0.3, 1.5]), // chassis
    box([-0.6, 0.3, -1.5], [0.6, 0.9, -1.3]), // cab front wall (dash)
    box([-0.6, 0.3, -1.5], [-0.45, 1.3, 0]), // cab left wall
    box([0.45, 0.3, -1.5], [0.6, 1.3, 0]), // cab right wall
    box([-0.6, 1.3, -1.5], [0.6, 1.45, 0]), // cab roof
    box([-0.6, 0.3, 0], [0.6, 0.9, 1.5]), // bed
  ];

  it('scores the forward view: all clear over the model, none from inside a closed box', () => {
    expect(forwardView(dollTruck, [0, 2.4, 1])).toBe(1);
    expect(forwardView([box([-1, 0, -1], [1, 2, 1])], [0, 1, 0])).toBe(0);
    // Glass does not block the view.
    expect(forwardView([{ min: [-1, 0, -1], max: [1, 2, -0.5], glass: true }], [0, 1, 0])).toBe(1);
  });

  it('moves a seat whose view is blocked to the nearest surface with a clear view, body drawn', () => {
    const eye: Vec3 = [0, 1.2, -0.8];
    const plan = planSeat(dollTruck, eye, [0, eye[1] - RIDER_EYE_ABOVE_SEAT, eye[2]], 'none');
    expect(plan.view!.before).toBeLessThan(VIEW.minClear);
    expect(plan.view!.after).toBeGreaterThanOrEqual(VIEW.minClear);
    expect(forwardView(dollTruck, plan.eye)).toBeGreaterThanOrEqual(VIEW.minClear);
    // The hips rest on a surface of the model (its bed or its roof), and the body is drawn at 100 %.
    const surface = plan.seat[1] + 0.3;
    expect(dollTruck.some(b => Math.abs(b.max[1] - surface) < 0.02)).toBe(true);
    expect(plan.steps[0]!.fits).toBe(true);
  });

  it('leaves a guessed seat alone when it already sees out, and never searches a seat with evidence', () => {
    const open = planSeat(dollTruck, [0, 1.6, 0.5], [0, 1.6 - RIDER_EYE_ABOVE_SEAT, 0.5], 'none');
    expect(open.view).toEqual({ before: 1, after: 1 });
    expect(open.moved).toBeNull();
    const figure = planSeat(dollTruck, [0, 1.2, -0.8], [0, 1.2 - RIDER_EYE_ABOVE_SEAT, -0.8], 'seat');
    expect(figure.view).toBeUndefined();
    expect(figure.seat).toEqual([0, 1.2 - RIDER_EYE_ABOVE_SEAT, -0.8]);
  });
});
