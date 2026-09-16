import { describe, expect, it } from 'vitest';
import { compileLdrawEntityGeometry, figureRole, groupFigures, isFigurePart, baseMould, ldrawToRenderRotation } from '../web/src/engine/ldraw-entity-compiler.js';
import { extraPlacement, snapFacing } from '../web/src/engine/playable-addon.js';
import { createPartGeometryProvider } from '../web/src/engine/ldraw-part-geometry.js';
import { LDU_PER_BLOCK } from '../web/src/engine/lego-scale.js';
import type { ParsedBrick } from '../web/src/engine/ldraw-parser.js';

const box6 = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): string[] => {
  const q = (a: number[], b: number[], c: number[], d: number[]): string => `4 16 ${[...a, ...b, ...c, ...d].join(' ')}`;
  return [
    q([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]), q([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]),
    q([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]), q([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]),
    q([x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]), q([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]),
  ];
};
const LIBRARY: Record<string, string> = {
  '3001': ['0 Brick  2 x  4', ...box6(-40, 40, -24, 0, -20, 20)].join('\n'),
  '3005': ['0 Brick  1 x  1', ...box6(-10, 10, -24, 0, -10, 10)].join('\n'),
  '973': ['0 Minifig Torso', ...box6(-19, 19, -12, 32, -10, 10)].join('\n'),
  '973p01': ['0 Minifig Torso with Stripes Pattern', ...box6(-19, 19, -12, 32, -10, 10)].join('\n'),
  '3626': ['0 Minifig Head', ...box6(-13, 13, 0, 24, -13, 13)].join('\n'),
  '3815': ['0 Minifig Hips', ...box6(-18, 18, -11, 21, -10, 10)].join('\n'),
  '3816': ['0 Minifig Leg Left', ...box6(-19.5, -1.5, -9, 28, -11, 9)].join('\n'),
  '3817': ['0 Minifig Leg Right', ...box6(1.5, 19.5, -9, 28, -11, 9)].join('\n'),
  '56908': ['0 Wheel Rim', ...box6(-10, 10, -10, 10, -4, 4)].join('\n'),
  '3823': ['0 Windscreen', ...box6(-20, 20, -40, 0, -2, 2)].join('\n'),
};
const provider = () => createPartGeometryProvider({ fetchPartText: async id => LIBRARY[id.replace(/^.*\//, '').replace(/\.dat$/i, '')] ?? null });
const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const figure = (x: number, y: number, z: number, rot = I, torso = '973'): ParsedBrick[] => [
  { part: '3816.dat', color: 25, x, y: y + 36, z, rot }, { part: '3817.dat', color: 25, x, y: y + 36, z, rot },
  { part: '3815.dat', color: 8, x, y: y + 24, z, rot }, { part: `${torso}.dat`, color: 25, x, y: y - 8, z, rot }, { part: '3626.dat', color: 14, x, y: y - 32, z, rot },
];
/** A 20-brick body along Z, floor at y = 0 (bricks span y −24..0), z from −400 to 400. */
const body = (): ParsedBrick[] => Array.from({ length: 21 }, (_, i) => ({ part: '3001.dat', color: 4, x: 0, y: 0, z: (i - 10) * 40, rot: [0, 0, 1, 0, 1, 0, -1, 0, 0] }));

describe('part helpers', () => {
  it('baseMould strips a print suffix and keeps shape/composite suffixes', () => {
    expect(baseMould('30372p79.dat')).toBe('30372');
    expect(baseMould('3626bp03')).toBe('3626b');
    expect(baseMould('973ps1')).toBe('973');
    expect(baseMould('3829c01')).toBe('3829c01');
    expect(baseMould('4079b')).toBe('4079b');
  });
  it('isFigurePart trusts the description first and the id family second, and never takes a seat for a figure', () => {
    expect(isFigurePart('999999', 'Minifig Hair Long Wavy')).toBe(true);
    expect(isFigurePart('4079', 'Minifig Seat  2 x  2')).toBe(false);
    expect(isFigurePart('3626', '')).toBe(true);
    expect(isFigurePart('3001', 'Brick  2 x  4')).toBe(false);
    // Studio custom torsos (BrickLink Designer Program sets) carry a bl_ prefix and a _torso suffix.
    expect(isFigurePart('bl_973pb5574c01_torso', 'FILE bl_973pb5574c01_torso.dat')).toBe(true);
    expect(baseMould('bl_973pb5574c01_torso')).toBe('973'); // the print suffix goes too: the mould is the plain torso
  });
  it('snapFacing picks the nearest axis', () => {
    expect(snapFacing([0, -1])).toBe('-z');
    expect(snapFacing([0.71, -0.7])).toBe('+x');
    expect(snapFacing([-0.2, 0.98])).toBe('+z');
  });
});

describe('figureRole', () => {
  it('an NPC is a torso with another body part in more than one colour; one colour is a statue; a torso alone is partial', () => {
    const meshes = new Map();
    expect(figureRole(figure(0, 0, 0), meshes)).toBe('npc');
    expect(figureRole(figure(0, 0, 0).map(b => ({ ...b, color: 71 })), meshes)).toBe('statue');
    // No legs is still a figure: the minifig rig supplies them (the IOModel2V2 museum's figures).
    expect(figureRole(figure(0, 0, 0).filter(b => !/381[567]/.test(b.part)), meshes)).toBe('npc');
    // A torso with only a hand beside it is not a figure.
    expect(figureRole([figure(0, 0, 0)[3]!, { part: '3820.dat', color: 14, x: 20, y: 20, z: 0, rot: I }], meshes)).toBe('partial');
  });
});

describe('groupFigures', () => {
  it('groups each torso with the head and legs around it and ignores a loose accessory', async () => {
    const bricks = [...figure(0, 0, 0), ...figure(200, 0, 0), { part: '3626.dat', color: 14, x: 900, y: 0, z: 0, rot: I }];
    const meshes = new Map<string, Awaited<ReturnType<ReturnType<typeof provider>['getPartMesh']>>>();
    const p = provider();
    for (const b of bricks) if (!meshes.has(b.part)) meshes.set(b.part, await p.getPartMesh(b.part));
    const groups = groupFigures(bricks, meshes);
    expect(groups).toHaveLength(2);
    expect(groups.map(g => g.parts.length)).toEqual([5, 5]);
  });
});

describe('compileLdrawEntityGeometry extras and cockpit', () => {
  it('seats the rider on the figure inside the vehicle, drops that figure from the geometry, and offers the standing figure and the wheeled cart as extras', async () => {
    const bricks: ParsedBrick[] = [
      ...body(),
      // Driver: seated on the body (feet on its top face at y −24, so the legs touch it), facing −Z.
      ...figure(0, -88, -100),
      // A figure standing on the ground 400 LDU to the side (+X), touching nothing.
      ...figure(400, 0, 0),
      // A cart: 14 bricks on four wheels, 600 LDU behind (+Z), on the ground.
      ...Array.from({ length: 14 }, (_, i) => ({ part: '3005.dat', color: 7, x: (i % 7) * 20 - 60, y: -10, z: 700 + Math.floor(i / 7) * 20, rot: I })),
      ...[[-60, 700], [60, 700], [-60, 720], [60, 720]].map(([x, z]) => ({ part: '56908.dat', color: 0, x: x!, y: 0, z: z!, rot: I })),
      // A lone brick far away: a prop.
      { part: '3005.dat', color: 15, x: -900, y: 0, z: 0, rot: I },
    ];
    const r = await compileLdrawEntityGeometry('t', 'plane', bricks, { partGeometry: provider(), facing: '-z' });
    expect(r.diagnostics.cockpit.source).toBe('seated-figure');
    expect(r.diagnostics.driverFigureRemoved).toBe(5);
    expect(r.warnings.some(w => /seated driver figure \(5 parts\)/.test(w))).toBe(true);
    // The rider's eyes are 11 LDU above the torso origin (−88 − 8 − 11 = −107 → 107 LDU over the floor), 100 LDU forward of centre.
    expect(r.seatPosition[0]).toBe(0);
    expect(r.seatPosition[1]).toBeCloseTo(Math.max(0.3, 107 / LDU_PER_BLOCK - 1.25), 1);
    expect(r.seatPosition[2]).toBeCloseTo(-100 / LDU_PER_BLOCK, 1);
    const roles = r.extras.map(e => e.role).sort();
    expect(roles).toEqual(['figure', 'prop', 'vehicle']);
    const fig = r.extras.find(e => e.role === 'figure')!;
    expect(fig.bricks).toHaveLength(5);
    expect(fig.facingLdu).toEqual([0, -1]);
    expect(fig.floorLdu).toBe(64);
    const cart = r.extras.find(e => e.role === 'vehicle')!;
    expect(cart.wheels).toBe(4);
    expect(cart.bricks).toHaveLength(18);
    expect(r.diagnostics.extras).toEqual(r.extras.map(e => ({ role: e.role, placements: e.sourceIndices.length, reason: e.reason })));
    // Kept = the 21 body bricks only.
    expect(r.keptSourceIndices).toEqual(Array.from({ length: 21 }, (_, i) => i));
  });

  it('a printed torso still makes a figure, a windscreen mould is the cockpit when no figure or seat is present', async () => {
    const withPrint = [...body(), ...figure(0, -88, -100, I, '973p01')];
    const r = await compileLdrawEntityGeometry('t', 'car', withPrint, { partGeometry: provider(), facing: '-z' });
    expect(r.diagnostics.cockpit.source).toBe('seated-figure');
    const glass = [...body(), { part: '3823.dat', color: 47, x: 0, y: -24, z: -200, rot: I }];
    const g = await compileLdrawEntityGeometry('t', 'car', glass, { partGeometry: provider(), facing: '-z' });
    expect(g.diagnostics.cockpit.source).toBe('canopy-parts');
    expect(g.diagnostics.cockpit.detail).toMatch(/^3823 at/);
  });

  it('a figure compiles as its own entity with no rider and no driver removal', async () => {
    const r = await compileLdrawEntityGeometry('f', 'figure', figure(0, 0, 0), { partGeometry: provider(), facing: '-z' });
    expect(r.diagnostics.driverFigureRemoved).toBe(0);
    expect(r.diagnostics.cubeCount).toBeGreaterThan(0);
    expect(r.sizeBlocks.height).toBeCloseTo(96 / LDU_PER_BLOCK, 1);
    expect(r.facing).toBe('-z');
  });
});

describe('extraPlacement', () => {
  const primary = (nose: '-z' | '+x') => ({ transform: { A: ldrawToRenderRotation(nose), origin: [0, 0, 0] as [number, number, number], scale: 0.3 } }) as unknown as Parameters<typeof extraPlacement>[0];
  const extra = (centre: [number, number, number], floor: number) => ({ centreLdu: centre, floorLdu: floor } as unknown as Parameters<typeof extraPlacement>[1]);
  it('puts an object on the pilot\'s LEFT (LDraw +X for a −Z nose) on the entity\'s left in the world', () => {
    // Entity at yaw 180 faces −Z (north) in the world; its left is then west (−X).
    const p = extraPlacement(primary('-z'), extra([100, 0, 0], 0), '-z', 180);
    expect(p.dx).toBeCloseTo(-100 / LDU_PER_BLOCK, 2);
    expect(p.dz).toBeCloseTo(0, 2);
    expect(p.yaw).toBe(180);
    // At yaw 0 (facing south, +Z) the same object is east (+X).
    const q = extraPlacement(primary('-z'), extra([100, 0, 0], 0), '-z', 0);
    expect(q.dx).toBeCloseTo(100 / LDU_PER_BLOCK, 2);
    expect(q.yaw).toBe(0);
  });
  it('keeps a trailing object behind and a figure facing across the vehicle turned across it', () => {
    // An object 200 LDU behind (+Z of a −Z nose) at yaw 180 (entity faces north) is south of it (+Z).
    const p = extraPlacement(primary('-z'), extra([0, 0, 200], 0), '-z', 180);
    expect(p.dz).toBeCloseTo(200 / LDU_PER_BLOCK, 2);
    // A figure facing LDraw +X beside a −Z-nosed vehicle at yaw 180: +X in LDraw is the pilot's left = west → yaw 90.
    const f = extraPlacement(primary('-z'), extra([0, 0, 0], 0), '+x', 180);
    expect(f.yaw).toBe(90);
  });
  it('never sinks an object below the vehicle floor', () => {
    const p = extraPlacement(primary('-z'), extra([0, 40, 0], 40), '-z', 0);
    expect(p.dy).toBe(0);
  });
});
