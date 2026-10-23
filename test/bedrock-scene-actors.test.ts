import { describe, expect, it } from 'vitest';
import { BlockGrid } from '@craft/schem/types.js';
import { DOOR_MAX_OFF_GRID_DEG, FIGURE_UPRIGHT_MAX_TILT_DEG, applySceneDoors, discoverSceneActors, doorBlockForColor, isDoorLeafDescription, measureSceneAccess, recommendAccessScale, recommendDoorExportScale, runtimeDoorCandidates, sceneFloorPoint, actorGroundLdu, groundLiftWarning, settleLooseAccessories, sceneGridPoint, tiltDegOf, yawForFacing } from '../web/src/engine/bedrock-scene-actors.js';
import type { SceneAccessMeasurement, SceneOpening } from '../web/src/engine/bedrock-scene-actors.js';
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
// Descriptions are the library's own; the shapes are stand-ins with the right extents.
const LIBRARY: Record<string, string> = {
  '3001': ['0 Brick  2 x  4', ...box6(-40, 40, -24, 0, -20, 20)].join('\n'),
  '973': ['0 Minifig Torso', ...box6(-19, 19, -12, 32, -10, 10)].join('\n'),
  '3626': ['0 Minifig Head', ...box6(-13, 13, 0, 24, -13, 13)].join('\n'),
  '3815': ['0 Minifig Hips', ...box6(-18, 18, -11, 21, -10, 10)].join('\n'),
  '3816': ['0 Minifig Leg Left', ...box6(-19.5, -1.5, -9, 28, -11, 9)].join('\n'),
  '3817': ['0 Minifig Leg Right', ...box6(1.5, 19.5, -9, 28, -11, 9)].join('\n'),
  '4079': ['0 Minifig Seat  2 x  2', ...box6(-20, 20, -24, 0, -20, 20)].join('\n'),
  // A Studio-private hair (10303's embedded 43753): described the BrickLink way, absent from every id list.
  '43753': ['0 Minifigure, Hair Swept Back Tousled', ...box6(-17, 17, -10, 8, -17, 17)].join('\n'),
  // A held item reaching 84 LDU down from the hand: 12 LDU below the feet of a figure holding it at the hip.
  '3836': ['0 Minifig Pushbroom', ...box6(-17, 17, 0, 84, -6, 10)].join('\n'),
  // A 1×4×6 leaf: 80 wide along +X from the hinge at the origin, 144 tall (up = −Y), 6 thick.
  '60623': ['0 Door  1 x  4 x  6 with 4 Panes and Stud Handle', ...box6(0, 80, -144, 0, -3, 3)].join('\n'),
  '60596': ['0 Door  1 x  4 x  6 Frame', ...box6(-40, 40, -144, 0, -10, 10)].join('\n'),
  '3821': ['0 Door  1 x  3 x  1 Right', ...box6(-15, 10, -24, 0, -10, 50)].join('\n'),
  // Access measurement stand-ins: a 1×1 brick, a 4×12 plate, and a frame with a REAL hole (two jambs and a lintel).
  '3005': ['0 Brick  1 x  1', ...box6(-10, 10, -24, 0, -10, 10)].join('\n'),
  '3029': ['0 Plate  4 x 12', ...box6(-120, 120, -8, 0, -40, 40)].join('\n'),
  '3958': ['0 Plate  6 x  6', ...box6(-60, 60, -8, 0, -60, 60)].join('\n'),
  '60599': ['0 Door  1 x  4 x  6 Frame', ...box6(-40, -30, -144, 0, -10, 10), ...box6(30, 40, -144, 0, -10, 10), ...box6(-40, 40, -144, -120, -10, 10)].join('\n'),
};
const provider = () => createPartGeometryProvider({ fetchPartText: async id => LIBRARY[id.replace(/^.*\//, '').replace(/\.dat$/i, '')] ?? null });
const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const yaw180 = [-1, 0, 0, 0, 1, 0, 0, 0, -1];
const figure = (x: number, z: number, rot = I): ParsedBrick[] => [
  { part: '3816.dat', color: 25, x, y: 36, z, rot }, { part: '3817.dat', color: 25, x, y: 36, z, rot },
  { part: '3815.dat', color: 8, x, y: 24, z, rot }, { part: '973.dat', color: 25, x, y: -8, z, rot }, { part: '3626.dat', color: 14, x, y: -32, z, rot },
];

describe('discoverSceneActors', () => {
  it('finds figures (with their facing), free seats, occupied seats and door leaves', async () => {
    const bricks: ParsedBrick[] = [
      ...figure(0, 0),                       // standing, facing −Z
      ...figure(300, 0, yaw180),             // standing, facing +Z
      { part: '4079.dat', color: 0, x: 600, y: 0, z: 0, rot: I },       // free seat
      { part: '4079.dat', color: 0, x: 900, y: 0, z: 0, rot: I },       // taken: a figure sits on it
      ...figure(900, 0).map(b => ({ ...b, y: b.y - 8 })),
      ...figure(1800, 0).map(b => ({ ...b, color: 71 })),           // a single-colour statue: stays in the blocks
      ...figure(2100, 0).filter(b => !/381[567]/.test(b.part)),    // a bust (no legs): stays in the blocks
      { part: '60623.dat', color: 6, x: 1200, y: 0, z: 0, rot: I },     // door leaf, hinge at x=1200
      { part: '60596.dat', color: 6, x: 1240, y: 0, z: 0, rot: I },     // its frame: not a leaf
      { part: '3821.dat', color: 15, x: 1500, y: 0, z: 0, rot: I },     // a cupboard door, 24 LDU tall
      { part: '3001.dat', color: 4, x: 0, y: 100, z: 0, rot: I },
    ];
    const scene = await discoverSceneActors(bricks, provider());
    expect(scene.figures).toHaveLength(3);
    expect(scene.figures[0]!.facingLdu).toEqual([0, -1]);
    expect(scene.figures[1]!.facingLdu.map(v => Math.round(v))).toEqual([0, 1]);
    expect(scene.figures[0]!.floorLdu).toBe(64);
    expect(scene.figures[2]!.seated).toBe(true);
    expect(scene.figureBricks.size).toBe(15);
    // Both seats ship: the free one for the player, the occupied one for its sitter to ride.
    expect(scene.seats).toHaveLength(2);
    const free = scene.seats.findIndex(s => s.surfaceLdu[0] === 600);
    expect(scene.seats[free]!.surfaceLdu).toEqual([600, -8, 0]);
    expect(scene.seats[free]!.facingLdu).toEqual([0, -1]);
    expect(scene.figures[2]!.seatIndex).toBe(1 - free);
    expect(scene.figures.filter(f => f.seatIndex !== undefined)).toHaveLength(1);
    expect(scene.doors.map(d => d.part)).toEqual(['60623', '3821']);
    expect(scene.doors[0]).toMatchObject({ alongAxis: 'x', hingeAtMin: true, color: 6 });
    expect(scene.doors[0]!.minLdu).toEqual([1200, -144, -3]);
    expect(scene.doors[0]!.maxLdu).toEqual([1280, 0, 3]);
  });

  it('makes a seat where the source sat a figure down on bricks no rule reads as furniture, and nowhere a figure stands', async () => {
    // Legs turned 90 degrees at the hip: sitting. Torso at y -8, so the hips (the seat) are at y 24.
    const SIT = [1, 0, 0, 0, 0, -1, 0, 1, 0];
    const sitting = (x: number): ParsedBrick[] => figure(x, 0).map(b => /381[67]/.test(b.part) ? { ...b, rot: SIT } : b);
    const bricks: ParsedBrick[] = [
      ...sitting(0), { part: '3001.dat', color: 4, x: 0, y: 48, z: 0, rot: I },    // on a plain brick: a figure-proven seat
      ...sitting(600), { part: '4079.dat', color: 0, x: 600, y: 32, z: 0, rot: I }, // on a seat mould: it takes the mould
      ...figure(1200, 0), { part: '3001.dat', color: 4, x: 1200, y: 88, z: 0, rot: I }, // standing: no seat
    ];
    const scene = await discoverSceneActors(bricks, provider());
    expect(scene.seats.map(s => s.part).sort()).toEqual(['4079', 'figure seat']);
    const proven = scene.seats.findIndex(s => s.part === 'figure seat');
    expect(scene.seats[proven]!.surfaceLdu).toEqual([0, 24, 0]);
    expect(scene.figures.find(f => f.bricks[0]!.x === 0)!.seatIndex).toBe(proven);
    expect(scene.figures.find(f => f.bricks[0]!.x === 600)!.seatIndex).toBe(scene.seats.findIndex(s => s.part === '4079'));
    expect(scene.figures.find(f => f.bricks[0]!.x === 1200)!.seated).toBe(false);
  });

  /**
   * 10303's drop-track rider, the exact source matrices: the torso is pitched
   * nose-down (spine along +X, face toward LDraw +Y = straight down), the
   * legs are bent 90° and hang down, hair and head share the torso's matrix.
   * Head and hair 24 LDU along the spine, hips 32, legs 44 (IOModel2V2/10303.ldr).
   */
  const RIDER_ROT = [0, -1, 0, 0, 0, -1, 1, 0, 0];
  const RIDER_LEG_ROT = [0, 0, -1, 0, 1, 0, 1, 0, 0];
  const rider = (tx: number, ty: number, tz: number): ParsedBrick[] => [
    { part: '973.dat', color: 29, x: tx, y: ty, z: tz, rot: RIDER_ROT },
    { part: '3626.dat', color: 14, x: tx + 24, y: ty, z: tz, rot: RIDER_ROT },
    { part: '43753.dat', color: 72, x: tx + 24, y: ty, z: tz, rot: RIDER_ROT },
    { part: '3815.dat', color: 19, x: tx - 32, y: ty, z: tz, rot: RIDER_ROT },
    { part: '3816.dat', color: 19, x: tx - 44, y: ty, z: tz, rot: RIDER_LEG_ROT },
    { part: '3817.dat', color: 19, x: tx - 44, y: ty, z: tz, rot: RIDER_LEG_ROT },
  ];

  it('keeps a rider the source pitched nose-down in the geometry, whole (legs and hair included), and says so', async () => {
    const bricks: ParsedBrick[] = [...rider(-435, -1402, -100), ...figure(0, 0)];
    const scene = await discoverSceneActors(bricks, provider());
    // Only the standing figure walks; the rider is not an NPC and none of its six parts leave the shell.
    expect(scene.figures).toHaveLength(1);
    expect(scene.figures[0]!.tiltDeg).toBe(0);
    expect(scene.figureBricks.size).toBe(5);
    expect(scene.posedFigures).toHaveLength(1);
    expect(scene.posedFigures[0]!.tiltDeg).toBe(90);
    expect(scene.posedFigures[0]!.bricks.map(b => b.part).sort()).toEqual(['3626.dat', '3815.dat', '3816.dat', '3817.dat', '43753.dat', '973.dat']);
    for (const b of scene.posedFigures[0]!.bricks) expect(scene.figureBricks.has(b)).toBe(false);
    expect(scene.warnings).toHaveLength(1);
    expect(scene.warnings[0]).toMatch(/^1 figure the source posed off upright \(torso tilt 90°, over 30°\) stays in the build's geometry/);
  });

  it('an upright figure keeps a BrickLink-described private hair, and a held item does not lower its floor', async () => {
    const bricks: ParsedBrick[] = [
      ...figure(0, 0),
      { part: '43753.dat', color: 72, x: 0, y: -32, z: 0, rot: I },          // hair at the head's origin
      { part: '3836.dat', color: 8, x: 24, y: 20, z: -10, rot: I },          // pushbroom in the hand, reaching y 104
    ];
    const scene = await discoverSceneActors(bricks, provider());
    expect(scene.figures).toHaveLength(1);
    expect(scene.posedFigures).toHaveLength(0);
    expect(scene.warnings).toEqual([]);
    expect(scene.figureBricks.size).toBe(7);
    expect(scene.figureBricks.has(bricks[5]!)).toBe(true);
    // Feet at 64, not the broom's 104.
    expect(scene.figures[0]!.floorLdu).toBe(64);
  });

  it('a lean inside the limit is still an NPC; a yaw is no lean', async () => {
    const lean = (deg: number): number[] => { const c = Math.cos(deg * Math.PI / 180), s = Math.sin(deg * Math.PI / 180); return [1, 0, 0, 0, c, -s, 0, s, c]; };
    const scene = await discoverSceneActors([...figure(0, 0, lean(20)), ...figure(400, 0, yaw180), ...figure(800, 0, lean(FIGURE_UPRIGHT_MAX_TILT_DEG + 5))], provider());
    expect(scene.figures.map(f => f.tiltDeg)).toEqual([20, 0]);
    expect(scene.posedFigures.map(f => f.tiltDeg)).toEqual([35]);
  });

  it('tiltDegOf reads the lean off a placement matrix, scaled or mirrored', () => {
    expect(tiltDegOf(undefined)).toBe(0);
    expect(tiltDegOf(I)).toBe(0);
    expect(tiltDegOf(yaw180)).toBe(0);
    expect(tiltDegOf(RIDER_ROT)).toBe(90);
    expect(tiltDegOf([1, 0, 0, 0, -1, 0, 0, 0, -1])).toBe(180);
    expect(tiltDegOf([0.999988, 0, 0, 0, 0.999988, 0, 0, 0, 0.999988])).toBe(0);
    expect(tiltDegOf([-1, 0, 0, 0, 1, 0, 0, 0, 1])).toBe(0);
  });

  it('isDoorLeafDescription takes leaves and refuses frames, glass, sliders and stickers', () => {
    expect(isDoorLeafDescription('Door  1 x  4 x  6 with Stud Handle')).toBe(true);
    expect(isDoorLeafDescription('Door  1 x  4 x  6 Frame')).toBe(false);
    expect(isDoorLeafDescription('Glass for Door  1 x  4 x  6')).toBe(false);
    expect(isDoorLeafDescription('Door Sliding Type 2')).toBe(false);
    expect(isDoorLeafDescription('~Door  1 x  3 x  4 Right (Obsolete)')).toBe(true);
    expect(isDoorLeafDescription('GLASS DOOR FOR FRAME 1X4X6 (Needs Work)')).toBe(true);
  });

  it('reads a leaf\'s turn off the grid from its own frame, not its world AABB (76417\'s bank sits at 45 degrees)', async () => {
    const turn = (deg: number): number[] => { const c = Math.cos(deg * Math.PI / 180), s = Math.sin(deg * Math.PI / 180); return [c, 0, s, 0, 1, 0, -s, 0, c]; };
    const scene = await discoverSceneActors([
      { part: '60623.dat', color: 6, x: 0, y: 0, z: 0, rot: I },
      { part: '60623.dat', color: 6, x: 400, y: 0, z: 0, rot: turn(8.13) },
      { part: '60623.dat', color: 6, x: 800, y: 0, z: 0, rot: turn(45) },
      { part: '60623.dat', color: 6, x: 1200, y: 0, z: 0, rot: turn(90) },
    ], provider());
    expect(scene.doors.map(d => d.offGridDeg)).toEqual([0, 8.1, 45, 0]);
    expect(scene.doors.map(d => d.alongAxis)).toEqual(['x', 'x', 'x', 'z']);
    // Past the limit a square vanilla door cannot stand in the leaf's wall; the bank's 8-degree front doors still hang.
    expect(scene.doors.filter(d => d.offGridDeg! <= DOOR_MAX_OFF_GRID_DEG)).toHaveLength(3);
  });
});

describe('grid mapping', () => {
  const frame = { x: 0, y: 0, z: 0, scale: 1, cellXZ: LDU_PER_BLOCK, cellY: LDU_PER_BLOCK };
  it('sceneGridPoint maps LDraw into cells with Y and Z flipped (a half turn about X, not a mirror)', () => {
    const p = sceneGridPoint(frame, [LDU_PER_BLOCK * 2, -LDU_PER_BLOCK * 3, -LDU_PER_BLOCK]);
    expect(p[0]).toBeCloseTo(2, 9); expect(p[1]).toBeCloseTo(3, 9); expect(p[2]).toBeCloseTo(1, 9);
  });
  it('yawForFacing: −Z (the LDraw front) is 0, +Z is 180, +X is −90, −X is 90', () => {
    expect(yawForFacing([0, -1])).toBe(0);
    expect(yawForFacing([0, 1])).toBe(180);
    expect(yawForFacing([1, 0])).toBe(-90);
    expect(yawForFacing([-1, 0])).toBe(90);
  });
  it('doorBlockForColor maps LDraw tones to vanilla doors and defaults to oak', () => {
    expect(doorBlockForColor(6)).toBe('minecraft:spruce_door');
    expect(doorBlockForColor(15)).toBe('minecraft:birch_door');
    expect(doorBlockForColor(999)).toBe('minecraft:oak_door');
  });
});

describe('applySceneDoors', () => {
  const frame = { x: 0, y: 0, z: 0, scale: 1, cellXZ: LDU_PER_BLOCK, cellY: LDU_PER_BLOCK };
  const wallOf = (grid: BlockGrid): void => { for (let x = 0; x < grid.width; x++) for (let y = 0; y < grid.height; y++) grid.set(x, y, 2, 'minecraft:stone'); };
  // Grid +Z is LDraw −Z (the grid frame is a half turn about X, `sceneGridPoint`):
  // a leaf in grid cell z is authored at LDraw z = −(cell + fraction) · cell size.
  it('opens the leaf cells and hangs double doors with outer hinges in a 1.5-cell-wide leaf', () => {
    const grid = new BlockGrid(6, 6, 6);
    wallOf(grid);
    // Leaf along X from x=53 (cell 1) 80 LDU wide, 144 tall from the floor, thin in Z inside the wall at z cell 2.
    const z = -(2 * LDU_PER_BLOCK + 20);
    const stats = applySceneDoors(grid, [{ part: '60623', description: 'Door', color: 6, minLdu: [LDU_PER_BLOCK, -144, z - 3], maxLdu: [LDU_PER_BLOCK + 80, 0, z + 3], alongAxis: 'x', hingeAtMin: true }], frame);
    expect(stats).toEqual({ doors: 2, leavesCleared: 6, skippedSmall: 0, skippedOutside: 0, passageCleared: 0, unreachable: 0 });
    expect(grid.get(1, 0, 2)).toBe('minecraft:spruce_door[facing=south,half=lower,hinge=left,open=false,powered=false]');
    expect(grid.get(2, 0, 2)).toBe('minecraft:spruce_door[facing=south,half=lower,hinge=right,open=false,powered=false]');
    expect(grid.get(1, 1, 2)).toBe('minecraft:spruce_door[facing=south,half=upper,hinge=left,open=false,powered=false]');
    expect(grid.get(1, 2, 2)).toBe('minecraft:air'); // the transom above a 2.7-cell-tall doorway
    expect(grid.get(0, 0, 2)).toBe('minecraft:stone');
    expect(grid.get(3, 0, 2)).toBe('minecraft:stone');
  });
  it('a single-cell leaf along Z gets one door whose hinge follows the mould', () => {
    const grid = new BlockGrid(6, 6, 6);
    for (let z = 0; z < 6; z++) for (let y = 0; y < 6; y++) grid.set(2, y, z, 'minecraft:stone');
    const x = 2 * LDU_PER_BLOCK + 20;
    // Hinge at the LDraw min-Z end, which is the grid's max-Z (south) end: seen from the east
    // (facing east, viewer looks west), the viewer's left is south (+Z) → hinge left.
    const stats = applySceneDoors(grid, [{ part: 'd', description: 'Door', color: 15, minLdu: [x - 3, -120, -(2 * LDU_PER_BLOCK + 65)], maxLdu: [x + 3, 0, -(2 * LDU_PER_BLOCK + 5)], alongAxis: 'z', hingeAtMin: true }], frame);
    expect(stats.doors).toBe(1);
    expect(grid.get(2, 0, 2)).toBe('minecraft:birch_door[facing=east,half=lower,hinge=left,open=false,powered=false]');
    expect(grid.get(2, 1, 2)).toBe('minecraft:birch_door[facing=east,half=upper,hinge=left,open=false,powered=false]');
    expect(grid.get(2, 2, 2)).toBe('minecraft:air');
  });
  it('a 1.5-cell leaf that straddles three cells gets two doors where it covers most, and the sliver stays wall', () => {
    const grid = new BlockGrid(6, 6, 6);
    wallOf(grid);
    const z = -(2 * LDU_PER_BLOCK + 20);
    // From 0.8 to 2.3 cells: covers cell 0 by 0.2, cell 1 fully, cell 2 by 0.3 → doors in cells 1 and 2.
    const stats = applySceneDoors(grid, [{ part: 'd', description: 'Door', color: 6, minLdu: [0.8 * LDU_PER_BLOCK, -144, z - 3], maxLdu: [2.3 * LDU_PER_BLOCK, 0, z + 3], alongAxis: 'x', hingeAtMin: true }], frame);
    expect(stats.doors).toBe(2);
    expect(grid.get(0, 0, 2)).toBe('minecraft:stone');
    expect(grid.get(1, 0, 2)).toMatch(/^minecraft:spruce_door\[facing=south,half=lower,hinge=left/);
    expect(grid.get(2, 0, 2)).toMatch(/^minecraft:spruce_door\[facing=south,half=lower,hinge=right/);
    expect(grid.get(3, 0, 2)).toBe('minecraft:stone');
  });
  it('does not duplicate a doorway when an imported source contains overlapping leaves', () => {
    const grid = new BlockGrid(6, 6, 6);
    wallOf(grid);
    const z = -(2 * LDU_PER_BLOCK + 20);
    const leaf = { part: 'd', description: 'Door', color: 6, minLdu: [LDU_PER_BLOCK, -144, z - 3] as [number, number, number], maxLdu: [LDU_PER_BLOCK + 80, 0, z + 3] as [number, number, number], alongAxis: 'x' as const, hingeAtMin: true };
    const stats = applySceneDoors(grid, [leaf, { ...leaf, color: 15 }], frame);
    expect(stats.doors).toBe(2);
    // The first physical leaf owns the opening; a duplicate must not overwrite its material.
    expect(grid.get(1, 0, 2)).toMatch(/^minecraft:spruce_door/);
    expect(grid.get(2, 0, 2)).toMatch(/^minecraft:spruce_door/);
  });
  it('steps a leaf that reads one cell above the floor down onto it, and opens both cells of a wall the frame straddles', () => {
    const grid = new BlockGrid(6, 6, 6);
    // Floor at y 0; a two-cell-thick wall (cells z 2 and 3, the frame straddles their boundary) from y 2 up, so
    // the cell under the leaf's bottom cell is air; rooms either side.
    for (let x = 0; x < 6; x++) for (let z = 0; z < 6; z++) grid.set(x, 0, z, 'minecraft:stone');
    for (let x = 0; x < 6; x++) for (let y = 2; y < 6; y++) { grid.set(x, y, 2, 'minecraft:stone'); grid.set(x, y, 3, 'minecraft:stone'); }
    const zc = -3 * LDU_PER_BLOCK; // the boundary between cells 2 and 3 (LDraw −Z is grid +Z): the leaf's centre cell is 3
    const bottom = -(2 * LDU_PER_BLOCK + 8); // bottom edge reads cell 2, over air in cell 1
    const stats = applySceneDoors(grid, [{ part: 'd', description: 'Door', color: 6, minLdu: [LDU_PER_BLOCK, bottom - 144, zc - 3], maxLdu: [LDU_PER_BLOCK + 80, bottom, zc + 3], alongAxis: 'x', hingeAtMin: true, frameAcrossLdu: [zc - 10, zc + 10] }], frame);
    expect(stats.doors).toBe(2);
    // Stepped down one cell to rest on the floor.
    expect(grid.get(1, 1, 3)).toMatch(/^minecraft:spruce_door\[facing=south,half=lower/);
    expect(grid.get(1, 2, 3)).toMatch(/half=upper/);
    // The straddled cell 2 is opened over the doorway's columns and height, so the door is reachable from both rooms.
    expect(grid.get(1, 2, 2)).toBe('minecraft:air');
    expect(grid.get(2, 4, 2)).toBe('minecraft:air');
    expect(grid.get(0, 3, 2)).toBe('minecraft:stone');
    expect(grid.get(1, 0, 2)).toBe('minecraft:stone');
  });
  it('opens a passage through a two-deep facade to the nearest air, and counts a door buried in solid as unreachable', () => {
    const grid = new BlockGrid(8, 6, 8);
    for (let x = 0; x < 8; x++) for (let z = 0; z < 8; z++) grid.set(x, 0, z, 'minecraft:stone');
    // Facade three cells deep (z 2..4) from y 1 up; the door leaf sits in cell z 3; air beyond z 4 (the street) and before z 2 (the room).
    for (let x = 0; x < 8; x++) for (let y = 1; y < 6; y++) for (const z of [2, 3, 4]) grid.set(x, y, z, 'minecraft:stone');
    const zc = -(3 * LDU_PER_BLOCK + 20);
    const stats = applySceneDoors(grid, [{ part: 'd', description: 'Door', color: 6, minLdu: [LDU_PER_BLOCK, -LDU_PER_BLOCK - 144, zc - 3], maxLdu: [LDU_PER_BLOCK + 80, -LDU_PER_BLOCK, zc + 3], alongAxis: 'x', hingeAtMin: true }], frame);
    expect(stats.doors).toBe(2);
    expect(stats.unreachable).toBe(0);
    expect(stats.passageCleared).toBe(8); // cells z 2 and z 4, two columns, two heights
    expect(grid.get(1, 1, 2)).toBe('minecraft:air');
    expect(grid.get(2, 2, 4)).toBe('minecraft:air');
    expect(grid.get(1, 3, 2)).toBe('minecraft:stone'); // above the door: untouched
    // A door with solid on both sides for more than three cells is reported, not tunnelled.
    const solid = new BlockGrid(10, 6, 10);
    for (let x = 0; x < 10; x++) for (let y = 0; y < 6; y++) for (let z = 0; z < 10; z++) solid.set(x, y, z, 'minecraft:stone');
    const zs = -(5 * LDU_PER_BLOCK + 20);
    const s2 = applySceneDoors(solid, [{ part: 'd', description: 'Door', color: 6, minLdu: [4 * LDU_PER_BLOCK, -LDU_PER_BLOCK - 144, zs - 3], maxLdu: [4 * LDU_PER_BLOCK + 80, -LDU_PER_BLOCK, zs + 3], alongAxis: 'x', hingeAtMin: true }], frame);
    expect(s2.unreachable).toBe(1);
    expect(s2.passageCleared).toBe(0);
  });
  it('hangs a door on the floor row instead of in it, and treats the outside of the model as open', () => {
    // Baseplate row y 0 solid everywhere; a wall at z 4 from y 1 up (three cells of floor either side); the leaf starts 8 LDU above the plate.
    const grid = new BlockGrid(6, 6, 9);
    for (let x = 0; x < 6; x++) for (let z = 0; z < 9; z++) grid.set(x, 0, z, 'minecraft:stone');
    for (let x = 0; x < 6; x++) for (let y = 1; y < 6; y++) grid.set(x, y, 4, 'minecraft:stone');
    const zc = -(4 * LDU_PER_BLOCK + 20), bottom = -8;
    const stats = applySceneDoors(grid, [{ part: 'd', description: 'Door', color: 15, minLdu: [LDU_PER_BLOCK, bottom - 144, zc - 3], maxLdu: [LDU_PER_BLOCK + 80, bottom, zc + 3], alongAxis: 'x', hingeAtMin: true }], frame);
    expect(stats.doors).toBe(2);
    expect(stats.unreachable).toBe(0);
    expect(grid.get(1, 0, 4)).toBe('minecraft:stone'); // the floor under the door is kept
    expect(grid.get(1, 1, 4)).toMatch(/^minecraft:birch_door\[facing=south,half=lower/);
    expect(grid.get(1, 2, 4)).toMatch(/half=upper/);
    // An exterior door on the grid's edge opens onto the world beyond it.
    const edge = new BlockGrid(6, 6, 4);
    for (let x = 0; x < 6; x++) for (let z = 0; z < 4; z++) edge.set(x, 0, z, 'minecraft:stone');
    for (let x = 0; x < 6; x++) for (let y = 1; y < 6; y++) for (const z of [0, 1, 2]) edge.set(x, y, z, 'minecraft:stone');
    const ze = -20;
    const s2 = applySceneDoors(edge, [{ part: 'd', description: 'Door', color: 15, minLdu: [LDU_PER_BLOCK, bottom - 144, ze - 3], maxLdu: [LDU_PER_BLOCK + 80, bottom, ze + 3], alongAxis: 'x', hingeAtMin: true }], frame);
    expect(s2.unreachable).toBe(0);
    expect(edge.get(1, 1, 0)).toMatch(/half=lower/);
  });
  it('leaves a leaf under two cells tall alone', () => {
    const grid = new BlockGrid(4, 4, 4);
    grid.set(1, 0, 1, 'minecraft:stone');
    const stats = applySceneDoors(grid, [{ part: 'd', description: 'Door', color: 15, minLdu: [LDU_PER_BLOCK, -24, LDU_PER_BLOCK], maxLdu: [LDU_PER_BLOCK + 40, 0, LDU_PER_BLOCK + 6], alongAxis: 'x', hingeAtMin: true }], frame);
    expect(stats.skippedSmall).toBe(1);
    expect(grid.get(1, 0, 1)).toBe('minecraft:stone');
  });
  it('leaves a tall leaf under one physical block wide alone even when it straddles cells', () => {
    const grid = new BlockGrid(4, 4, 4);
    grid.set(1, 0, 1, 'minecraft:stone');
    const leaf = { part: 'd', description: 'Door', color: 15, minLdu: [0.8 * LDU_PER_BLOCK, -144, LDU_PER_BLOCK] as [number, number, number], maxLdu: [1.6 * LDU_PER_BLOCK, 0, LDU_PER_BLOCK + 6] as [number, number, number], alongAxis: 'x' as const, hingeAtMin: true };
    const hung = new Set<typeof leaf>();
    const stats = applySceneDoors(grid, [leaf], frame, hung);
    expect(stats).toMatchObject({ doors: 0, skippedSmall: 1 });
    expect(hung.has(leaf)).toBe(false);
    expect(grid.get(1, 0, 1)).toBe('minecraft:stone');
  });
});

describe('recommendDoorExportScale', () => {
  const door = (height: number) => ({ part: 'd', description: 'Door', color: 6, minLdu: [0, -height, 0] as [number, number, number], maxLdu: [80, 0, 6] as [number, number, number], alongAxis: 'x' as const, hingeAtMin: true });

  it('measures a small semantic leaf against the player/vanilla two-block clearance and rounds up to an export step', () => {
    const recommendation = recommendDoorExportScale([door(48)]);
    expect(recommendation).toMatchObject({ shortestLeafLdu: 48, recommendedScale: 3 });
    expect(recommendation!.requiredScale).toBeGreaterThan(2);
    expect(recommendation!.note).toMatch(/Brick Wand sizes can otherwise swap exact semantic leaf geometry/);
  });

  it('abstains rather than pretending a door works when the required export scale exceeds 4×', () => {
    const recommendation = recommendDoorExportScale([door(20)]);
    expect(recommendation?.recommendedScale).toBeUndefined();
    expect(recommendation?.note).toMatch(/No usable door is claimed/);
  });

  it('has no recommendation when the source has no semantic door leaf', () => {
    expect(recommendDoorExportScale([])).toBeNull();
  });

  it('retains a small real leaf for a 300% wand door rather than dropping it at 100%', () => {
    const candidates = runtimeDoorCandidates([door(48)], { x: 0, y: 0, z: 0, scale: 1, cellXZ: LDU_PER_BLOCK, cellY: LDU_PER_BLOCK });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ requiredSize: 300 });
    expect(candidates[0]!.lower).toMatchObject({ id: 'minecraft:spruce_door', states: { upper_block_bit: false, direction: 0 } });
  });

  it('preserves fractional storey elevation until after wand scaling', () => {
    const elevated = door(48);
    elevated.minLdu[1] -= 1.8 * LDU_PER_BLOCK;
    elevated.maxLdu[1] -= 1.8 * LDU_PER_BLOCK;
    const [candidate] = runtimeDoorCandidates([elevated], { x: 0, y: 0, z: 0, scale: 1, cellXZ: LDU_PER_BLOCK, cellY: LDU_PER_BLOCK });
    expect(candidate!.y).toBeCloseTo(1.8, 8);
    expect(Math.floor(candidate!.y * 3)).toBe(5);
  });
});

describe('sceneFloorPoint', () => {
  const frame = { x: 0, y: 0, z: 0, scale: 1, cellXZ: LDU_PER_BLOCK, cellY: LDU_PER_BLOCK };

  it('measures a height up from the model\'s underside, not the voxel row-0 bottom', () => {
    // A model whose underside is at LDraw y = 8 (a plate on the ground): feet on that plane are at 0, feet on the plate top (y = 0) at +0.15.
    expect(sceneFloorPoint(frame, 8, [0, 8, 0])[1]).toBeCloseTo(0, 9);
    expect(sceneFloorPoint(frame, 8, [0, 0, 0])[1]).toBeCloseTo(8 / LDU_PER_BLOCK, 9);
    // The voxel frame put the same feet a plate BELOW the pin (the chalet's −0.15).
    expect(sceneGridPoint(frame, [0, 8, 0])[1]).toBeCloseTo(-8 / LDU_PER_BLOCK, 9);
    // X and Z are the grid's (grid +Z is LDraw −Z).
    expect(sceneFloorPoint(frame, 8, [LDU_PER_BLOCK * 2, 8, -LDU_PER_BLOCK])).toEqual([2, 0, 1]);
    // No underside known: fall back to the grid mapping.
    expect(sceneFloorPoint(frame, NaN, [0, 8, 0])[1]).toBeCloseTo(-8 / LDU_PER_BLOCK, 9);
  });

  it('measures heights from the grid\'s bottom when figures stand more than half a cell under the model (42652, simulator 2026-09-30)', () => {
    // The grid (every placement, figures included) reaches 1.18 cells under the model's own underside: 42652's
    // figure line-up stands under the tree's base. The shell is laid in the grid's frame, so a slide's path and a
    // seat measured from the model's underside land 1.18 cells under the parts they belong to.
    const grid = { x: 0, y: -1.18, z: 0, scale: 1, cellXZ: LDU_PER_BLOCK, cellY: LDU_PER_BLOCK };
    const modelUnderside = 0; // LDraw y (down) of the lowest non-figure brick
    const ground = actorGroundLdu(grid, modelUnderside);
    expect(ground).toBeCloseTo(1.18 * LDU_PER_BLOCK, 9);
    // A chute's top 2 cells over the model's underside: its path now lands where the grid (and the drawn shell) put it.
    const chuteTop: [number, number, number] = [0, -2 * LDU_PER_BLOCK, 0];
    expect(sceneFloorPoint(grid, ground, chuteTop)[1]).toBeCloseTo(sceneGridPoint(grid, chuteTop)[1], 9);
    // Within half a cell (a baseplate the voxelizer rounds into row 0) the model's own underside stands.
    const plate = { x: 0, y: -8 / LDU_PER_BLOCK, z: 0, scale: 1, cellXZ: LDU_PER_BLOCK, cellY: LDU_PER_BLOCK };
    expect(actorGroundLdu(plate, 0)).toBe(0);
    expect(actorGroundLdu(frame, NaN)).toBeNaN();
  });

  it('warns of a ground lift only when there is an underside to lift (no "NaN cells" for a whole-model vehicle)', () => {
    const grid = { x: 0, y: -1.18, z: 0, scale: 1, cellXZ: LDU_PER_BLOCK, cellY: LDU_PER_BLOCK };
    expect(groundLiftWarning(grid, 0, actorGroundLdu(grid, 0))).toContain('1.18 cells over the lowest placement');
    // 7140 / 76286 / 42172 / 60221 / 10365 have no shell bricks: no underside, nothing lifted, no warning.
    expect(groundLiftWarning(grid, NaN, actorGroundLdu(grid, NaN))).toBeUndefined();
    expect(groundLiftWarning(frame, 0, actorGroundLdu(frame, 0))).toBeUndefined();
  });

  it('discoverSceneActors reports the underside of the non-figure placements', async () => {
    // A 2×4 brick at y = 0 (bottom at 0) and a figure standing 8 LDU lower on the ground beside it: the underside is the brick's.
    const scene = await discoverSceneActors([{ part: '3001.dat', color: 4, x: 0, y: 0, z: 0, rot: I }, ...figure(300, 0).map(b => ({ ...b, y: b.y + 8 }))], provider());
    expect(scene.figures).toHaveLength(1);
    expect(scene.groundLdu).toBe(0);
    expect(scene.figures[0]!.floorLdu).toBe(72);
    expect(sceneFloorPoint({ x: 0, y: 0, z: 0, scale: 1, cellXZ: LDU_PER_BLOCK, cellY: LDU_PER_BLOCK }, scene.groundLdu, [0, scene.figures[0]!.floorLdu, 0])[1]).toBeCloseTo(-72 / LDU_PER_BLOCK, 9);
  });
});

describe('measureSceneAccess / recommendAccessScale', () => {
  const brick = (part: string, x: number, y: number, z: number, rot = I): ParsedBrick => ({ part, color: 4, x, y, z, rot });
  /**
   * A wall of 1×1 bricks along X (columns at x = −110 … 110, 20 LDU thick at
   * z = 0), `rows` bricks high, with the columns in `gapColumns` left out of
   * the bottom `gapRows` rows: a doorway with a lintel above it.
   */
  const wall = (rows: number, gapColumns: number[], gapRows: number, z = 0, columns = [-110, -90, -70, -50, -30, -10, 10, 30, 50, 70, 90, 110]): ParsedBrick[] => {
    const out: ParsedBrick[] = [];
    for (let r = 0; r < rows; r++) for (const x of columns) {
      if (r < gapRows && gapColumns.includes(x)) continue;
      out.push(brick('3005.dat', x, -24 * r, z));
    }
    return out;
  };
  const meshesOf = async (bricks: ParsedBrick[]) => (await discoverSceneActors(bricks, provider())).meshes;

  it("a minifig-scale doorway (60 × 144 LDU) in a wall clears a minifig's doorway at 100 %", async () => {
    const bricks = wall(8, [-30, -10, 10], 6);
    const m = measureSceneAccess(bricks, await meshesOf(bricks));
    expect(m.cell).toEqual({ xz: 5, y: 4 });
    expect(m.openings).toHaveLength(1);
    expect(m.openings[0]).toMatchObject({ source: 'aperture', axis: 'z', widthLdu: 60, heightLdu: 144 });
    expect(m.openings[0]!.requiredScale).toBeCloseTo(Math.max(40 / 60, 96 / 144), 6);
    // The threshold sits on the ground row under the wall, centred on the gap.
    expect(m.openings[0]!.centreLdu[0]).toBeCloseTo(-10, 6);
    expect(m.openings[0]!.centreLdu[1]).toBeCloseTo(0, 6);
    const rec = recommendAccessScale(m);
    expect(rec).toMatchObject({ scale: 1, sizePct: 100, basis: 'apertures' });
    expect(rec.doorway).toMatchObject({ widthBlocks: 1.1, heightBlocks: 2.7, count: 1, passable: 1 });
    expect(rec.reason).toMatch(/^Wall openings are 1\.1×2\.7 blocks at 100 %: a player walks through as exported \(1\/1 clear the 0\.75×1\.8 a minifig needs\)/);
  });

  it('a microscale doorway (40 × 48 LDU) needs 200 %, the size at which a minifig would walk through it, and the reason says what that makes it', async () => {
    const bricks = wall(6, [-10, 10], 2);
    const rec = recommendAccessScale(measureSceneAccess(bricks, await meshesOf(bricks)));
    expect(rec).toMatchObject({ scale: 2, sizePct: 200, basis: 'apertures' });
    expect(rec.doorway).toMatchObject({ widthBlocks: 0.8, heightBlocks: 0.9, passable: 1 });
    expect(rec.doorway!.requiredScale).toBeCloseTo(96 / 48, 6);
    expect(rec.reason).toBe("Wall openings are 0.8×0.9 blocks at 100 %; 200 % makes them 1.5×1.8 (a player needs 0.75×1.8, a minifig's doorway; 1/1 clear it); floors are 1.8 blocks under the ceiling at 200 %.");
  });

  it('a one-stud, one-brick gap (20 × 24 LDU), the smallest opening counted, opens at 400 %', async () => {
    const bricks = wall(6, [-10], 1);
    const rec = recommendAccessScale(measureSceneAccess(bricks, await meshesOf(bricks)));
    expect(rec).toMatchObject({ scale: 4, sizePct: 400, basis: 'apertures' });
    expect(rec.doorway).toMatchObject({ count: 1, passable: 1 });
    expect(rec.reason).toMatch(/^Wall openings are 0\.4×0\.5 blocks at 100 %; 400 % makes them 1\.5×1\.8 /);
  });

  it('door leaves a player can use speak for the set over slits that reach its rooms: an open-backed house recommends its doors (SCALE-04)', () => {
    // Hogsmeade (76457, the user 2026-10-22): its door leaves open outside to outside, and the only "entrances"
    // were 0.3-0.7-block slits between houses - which put the wand's recommendation at 200 %.
    const op = (source: SceneOpening['source'], widthLdu: number, heightLdu: number, connects: SceneOpening['connects']): SceneOpening =>
      ({ source, axis: 'z', widthLdu, heightLdu, centreLdu: [0, 0, 0], requiredScale: Math.max(40 / widthLdu, 96 / heightLdu), connects });
    const openings = [
      op('door-leaf', 72, 134, 'outside'), op('door-leaf', 71, 134, 'outside'), op('door-leaf', 71, 134, 'outside'),
      op('aperture', 35, 192, 'entrance'), op('aperture', 20, 144, 'entrance'), op('door-leaf', 70, 134, 'blind'),
    ].sort((p, q) => p.requiredScale - q.requiredScale);
    const m = { cell: { xz: 5, y: 4 }, grid: { x: 1, y: 1, z: 1, solid: 0 }, openings, headroomLdu: 200, interiorFloorCells: 500, enclosedFloorCells: 500, topFloorLdu: null, reach: [] } as unknown as SceneAccessMeasurement;
    const rec = recommendAccessScale(m);
    expect(rec).toMatchObject({ scale: 1, sizePct: 100, basis: 'door-leaves' });
    expect(rec.doorway).toMatchObject({ count: 3, passable: 3 });
    expect(rec.reason).toMatch(/^Door leaves are 1\.3×2\.5 blocks at 100 %: a player walks through as exported/);
    // A leaf on a solid wall is never the evidence: with only that leaf, the slits decide.
    const blindOnly = { ...m, openings: openings.filter(o => o.source !== 'door-leaf' || o.connects === 'blind') } as SceneAccessMeasurement;
    expect(recommendAccessScale(blindOnly).basis).toBe('apertures');
  });

  it("doors decide over the whole model's headroom median, and the easiest ENTRANCE is a way in (SCALE-04)", () => {
    const op = (source: SceneOpening['source'], widthLdu: number, heightLdu: number, connects: SceneOpening['connects']): SceneOpening =>
      ({ source, axis: 'z', widthLdu, heightLdu, centreLdu: [0, 0, 0], requiredScale: Math.max(40 / widthLdu, 96 / heightLdu), connects });
    const base = { cell: { xz: 5, y: 4 }, grid: { x: 1, y: 1, z: 1, solid: 0 }, interiorFloorCells: 500, enclosedFloorCells: 500, topFloorLdu: null, reach: [] };
    // 60380: 1.3 x 2.5 doors, and a 0.5-block median over every enclosed floor cell (under counters, between plates).
    const doors = { ...base, openings: [op('door-leaf', 71, 134, 'entrance')], headroomLdu: 27 } as unknown as SceneAccessMeasurement;
    const rec = recommendAccessScale(doors);
    expect(rec).toMatchObject({ scale: 1, sizePct: 100, basis: 'door-leaves' });
    expect(rec.reason).toMatch(/median floor-to-ceiling over every enclosed floor is 0\.5 blocks at 100 %/);
    // Without door leaves the headroom still raises the step (a microscale interior).
    const slots = { ...base, openings: [op('aperture', 71, 134, 'entrance')], headroomLdu: 27 } as unknown as SceneAccessMeasurement;
    expect(recommendAccessScale(slots).scale).toBe(4);
    // 10303's station: two entrances wider than a minifig at 100 % among slits; the easiest entrance decides.
    const station = { ...base, headroomLdu: 200, openings: [op('aperture', 75, 396, 'entrance'), op('aperture', 112, 114, 'entrance'), op('aperture', 37, 102, 'entrance'), op('aperture', 30, 396, 'entrance'), op('aperture', 15, 54, 'entrance')] } as unknown as SceneAccessMeasurement;
    expect(recommendAccessScale(station)).toMatchObject({ scale: 1, sizePct: 100, basis: 'apertures' });
  });

  it('a solid wall has no opening and no interior: it says so instead of inventing a number', async () => {
    const bricks = wall(6, [], 0);
    const m = measureSceneAccess(bricks, await meshesOf(bricks));
    expect(m.openings).toHaveLength(0);
    expect(m.headroomLdu).toBeNull();
    const rec = recommendAccessScale(m);
    expect(rec).toMatchObject({ basis: 'none' });
    expect(rec.scale).toBeUndefined();
    expect(rec.reason).toMatch(/^No doorway or interior floor found/);
  });

  it('a semantic door leaf is the doorway: it is measured once, by its own extent, and decides the recommendation', async () => {
    // An 80-wide gap with a 1×4×6 leaf hung in it (hinge at x = −40): the aperture through the gap is the leaf's.
    const bricks = [...wall(8, [-30, -10, 10, 30], 6), { part: '60623.dat', color: 6, x: -40, y: 0, z: 0, rot: I }];
    const m = measureSceneAccess(bricks, await meshesOf(bricks));
    expect(m.openings).toHaveLength(1);
    expect(m.openings[0]).toMatchObject({ source: 'door-leaf', axis: 'z', widthLdu: 80, heightLdu: 144 });
    const rec = recommendAccessScale(m);
    expect(rec).toMatchObject({ scale: 1, sizePct: 100, basis: 'door-leaves' });
    expect(rec.reason).toMatch(/^Door leaves are 1\.5×2\.7 blocks at 100 %: a player walks through as exported \(1\/1 clear/);
  });

  it('a door leaf onto a space smaller than a room still leads somewhere; only a leaf with solid wall behind it is blind (SCALE-04)', async () => {
    // 10326 (rounds 30g/30i, walked at 100 % on the Saga): its doors open onto a passage or a 6-stud hall, which
    // the aperture rule's (2n)² room test called pockets, so all six were `blind` and the wand said 300 %.
    // A vestibule behind the leaf - side columns at x = ±50, a back wall at z = 60, a plate ceiling: a closet.
    const vestibule = [
      ...[20, 40].flatMap(z => [0, 1, 2, 3, 4, 5, 6, 7].flatMap(r => [brick('3005.dat', -50, -24 * r, z), brick('3005.dat', 50, -24 * r, z)])),
      ...wall(8, [], 0, 60, [-50, -30, -10, 10, 30, 50]),
      brick('3029.dat', 0, -192, 30),
    ];
    const leaf = { part: '60623.dat', color: 6, x: -40, y: 0, z: 0, rot: I };
    const hung = [...wall(8, [-30, -10, 10, 30], 6), leaf, ...vestibule];
    const m = measureSceneAccess(hung, await meshesOf(hung));
    const door = m.openings.find(o => o.source === 'door-leaf')!;
    expect(door.connects).not.toBe('blind');
    expect(recommendAccessScale(m)).toMatchObject({ scale: 1, sizePct: 100, basis: 'door-leaves' });
    // The same leaf flush on an uncut wall thicker than a wall's depth (solid all the way behind it) is drawn, not hung.
    const drawn = [...[0, 20, 40, 60, 80, 100, 120].flatMap(z => wall(8, [], 0, z)), { ...leaf, z: -13 }];
    const onWall = measureSceneAccess(drawn, await meshesOf(drawn)).openings.find(o => o.source === 'door-leaf');
    expect(onWall?.connects).toBe('blind');
  });

  it('a leaf wider than it is tall (a 1×3×1 cupboard door) is a hatch, never door evidence', async () => {
    const bricks = [brick('3821.dat', 0, 0, 0), brick('3001.dat', 200, 0, 0)];
    const m = measureSceneAccess(bricks, await meshesOf(bricks));
    expect(m.openings.map(o => o.source)).toEqual(['hatch-leaf']);
    const rec = recommendAccessScale(m);
    expect(rec.basis).toBe('apertures');
    // 60 × 24: a brick high, so it opens only at 400 %.
    expect(rec.scale).toBe(4);
  });

  it('the frame of a door mould keeps its hole: the aperture is measured between the jambs and under the lintel', async () => {
    // The frame (jambs 10 wide, lintel 24 deep) fills an 80-wide gap in a wall that carries on above it.
    const bricks = [...wall(8, [-30, -10, 10, 30], 6), { part: '60599.dat', color: 6, x: 0, y: 0, z: 0, rot: I }];
    const m = measureSceneAccess(bricks, await meshesOf(bricks));
    expect(m.openings).toHaveLength(1);
    expect(m.openings[0]).toMatchObject({ source: 'aperture', widthLdu: 60, heightLdu: 120 });
  });

  it('a slot far wider than it is tall (the gap under a raised plate) is not a doorway', async () => {
    // A 4×12 plate on two 1×1 bricks 220 apart: a 200 × 24 LDU slot, walled at both ends, open front and back.
    const bricks = [brick('3005.dat', -110, 0, 0), brick('3005.dat', 110, 0, 0), brick('3029.dat', 0, -24, 0)];
    const m = measureSceneAccess(bricks, await meshesOf(bricks));
    expect(m.openings).toHaveLength(0);
  });

  it('a gap that leads only into a closed niche is not a doorway (it must open up on both sides)', async () => {
    // The doorway wall, then a closet behind it: side columns at x = ±50, a back wall at z = 60, a plate ceiling over it.
    const closet = [
      ...[20, 40].flatMap(z => [0, 1, 2, 3, 4, 5].flatMap(r => [brick('3005.dat', -50, -24 * r, z), brick('3005.dat', 50, -24 * r, z)])),
      ...wall(6, [], 0, 60, [-50, -30, -10, 10, 30, 50]),
      brick('3029.dat', 0, -144, 30),
    ];
    const open = wall(8, [-30, -10, 10, 30], 6);
    const meshes = await meshesOf([...open, ...closet]);
    expect(measureSceneAccess(open, meshes).openings).toHaveLength(1);
    expect(measureSceneAccess([...open, ...closet], meshes).openings).toHaveLength(0);
  });

  it('interior headroom is the median floor-to-ceiling, and a low ceiling raises the recommended step', async () => {
    // A room: the doorway wall in front, a 4×12 plate ceiling 48 LDU up over a floor behind it (rows 0-1 open in the gap).
    // The doorway itself (40 × 48) needs 2× (200 %); the room's 48 LDU ceiling needs the same, so 200 % stands.
    const bricks = [...wall(4, [-10, 10], 2), brick('3029.dat', 0, -48, 40)];
    const m = measureSceneAccess(bricks, await meshesOf(bricks));
    expect(m.headroomLdu).toBe(48);
    expect(m.interiorFloorCells).toBeGreaterThan(0);
    const rec = recommendAccessScale(m);
    expect(rec.headroom).toMatchObject({ blocks: 0.9, scale: 2 });
    expect(rec.headroom!.requiredScale).toBeCloseTo(96 / 48, 6);
    expect(rec.scale).toBe(2);
  });

  it('excluded placements (a figure standing in the doorway) do not block it', async () => {
    const bricks = wall(8, [-30, -10, 10], 6);
    // Three columns of bricks filling the doorway: a wall again unless they are excluded.
    const blockers = [-30, -10, 10].flatMap(x => [0, 1, 2, 3, 4, 5].map(r => brick('3005.dat', x, -24 * r, 0)));
    const meshes = await meshesOf([...bricks, ...blockers]);
    expect(measureSceneAccess([...bricks, ...blockers], meshes).openings).toHaveLength(0);
    expect(measureSceneAccess([...bricks, ...blockers], meshes, { exclude: new Set(blockers) }).openings).toHaveLength(1);
  });

  /** A staircase of 1×1 bricks behind the wall: four steps of 24 LDU (0.45 blocks), one stud deep, four studs wide. */
  const stairs = (): ParsedBrick[] => [0, 1, 2, 3].flatMap(step => [-30, -10, 10, 30].flatMap(x => Array.from({ length: step + 1 }, (_, r) => brick('3005.dat', x, -24 * r, 40 + 20 * step))));

  it('the reach walk climbs a brick staircase while its risers are within a jump: through 200 %, not at 300 %', async () => {
    const bricks = [...wall(8, [-30, -10, 10], 6), ...stairs()];
    const m = measureSceneAccess(bricks, await meshesOf(bricks));
    // The highest standing surface is the wall's top (8 bricks, open sky); the stairs reach 96.
    expect(m.topFloorLdu).toBe(192);
    expect(m.reach.map(r => r.scale)).toEqual([1, 1.5, 2, 3, 4]);
    // A 24 LDU riser is 0.45 blocks at 100 %, 0.9 at 200 % (a jump), 1.35 at 300 % (a wall).
    expect(m.reach.map(r => r.highestReachedLdu)).toEqual([96, 96, 96, 0, 0]);
    expect(m.reach[0]!.reachedSurfaces).toBeGreaterThan(m.reach[3]!.reachedSurfaces / 100);
  });

  it('a microscale doorway with that staircase: the doorway wants 200 %, where the stairs still climb', async () => {
    const bricks = [...wall(6, [-10, 10], 2), ...stairs()];
    const rec = recommendAccessScale(measureSceneAccess(bricks, await meshesOf(bricks)));
    expect(rec.scale).toBe(2);
    // The stairs (96) against the wall top (144): two thirds of the height at 100 % and at 200 % (a riser is a jump there).
    expect(rec.climb).toMatchObject({ bestStep: 1, climbableAtScale: true });
    expect(rec.climb!.fraction).toBeCloseTo(96 / 144, 9);
    expect(rec.reason).not.toMatch(/reaches only/);
  });

  it('a doorway that wants 400 % with that staircase: the stairs stop at 300 %, and the reason names both', async () => {
    // A one-stud, one-brick gap (20 × 24 LDU) needs 400 %; the stairs climb through 200 % and stop at 300 %.
    const bricks = [...wall(6, [-10], 1), ...stairs()];
    const rec = recommendAccessScale(measureSceneAccess(bricks, await meshesOf(bricks)));
    expect(rec.scale).toBe(4);
    expect(rec.climb).toMatchObject({ bestStep: 1, climbableAtScale: false });
    expect(rec.climb!.fraction).toBe(0);
    expect(rec.reason).toMatch(/But at 400 % a player reaches only 0 % of the model's height \(its top floor is 2\.7 blocks up at 100 %\), against 67 % at 100 %: rises the player jumped at 100 % are above the 1\.25-block jump at 400 %\. 100 % keeps the floors but leaves doorways at 0\.4×0\.5 - under the 0\.75×1\.8 a minifig needs; the choice is between the doors and the stairs\.$/);
  });

  it('a minifig-scale doorway with the same staircase: 100 % is recommended and nothing is lost', async () => {
    const bricks = [...wall(8, [-30, -10, 10], 6), ...stairs()];
    const rec = recommendAccessScale(measureSceneAccess(bricks, await meshesOf(bricks)));
    expect(rec.scale).toBe(1);
    expect(rec.climb).toMatchObject({ fraction: 0.5, bestFraction: 0.5, climbableAtScale: true });
    expect(rec.reason).not.toMatch(/reaches only/);
  });

  it('a flat model has no floor to climb, and says nothing about stairs', async () => {
    const bricks = wall(8, [-30, -10, 10], 6);
    const m = measureSceneAccess(bricks, await meshesOf(bricks));
    // The wall top is a floor with open sky above it; nothing reaches it at any step.
    expect(m.topFloorLdu).toBe(192);
    expect(m.reach.every(r => r.highestReachedLdu === 0)).toBe(true);
    expect(recommendAccessScale(m).climb).toMatchObject({ fraction: 0, bestFraction: 0, climbableAtScale: true });
  });

  /**
   * A closed box building (SCALE-06): 1×1-brick walls eight bricks high round x, z in −110…110, a roof of four
   * 6×6 plates on them (covering −120…120), and an interior wall across its middle (z = 0) with a 40 × 144 LDU arch - the nave arcade
   * of Notre-Dame in miniature. `frontDoor` cuts the same arch into the front wall (z = −110).
   */
  const boxBuilding = (frontDoor: boolean): ParsedBrick[] => {
    const span = [-110, -90, -70, -50, -30, -10, 10, 30, 50, 70, 90, 110];
    const sides = [-90, -70, -50, -30, -10, 10, 30, 50, 70, 90];
    const out: ParsedBrick[] = [
      ...wall(8, frontDoor ? [-10, 10] : [], frontDoor ? 6 : 0, -110, span),
      ...wall(8, [], 0, 110, span),
      ...wall(8, [-10, 10], 6, 0, sides),
    ];
    for (let r = 0; r < 8; r++) for (const z of sides) out.push(brick('3005.dat', -110, -24 * r, z), brick('3005.dat', 110, -24 * r, z));
    for (const x of [-60, 60]) for (const z of [-60, 60]) out.push(brick('3958.dat', x, -192, z));
    return out;
  };

  it('an interior arcade in a closed building is no entrance: 0 entrances, and the reason says the doors are drawn, not cut', async () => {
    const bricks = boxBuilding(false);
    const m = measureSceneAccess(bricks, await meshesOf(bricks));
    expect(m.openings).toHaveLength(1);
    expect(m.openings[0]).toMatchObject({ source: 'aperture', widthLdu: 40, heightLdu: 144, connects: 'interior' });
    expect(m.enclosedFloorCells).toBeGreaterThan(1000);
    const rec = recommendAccessScale(m);
    expect(rec.openings).toEqual({ entrances: 0, interior: 1, outside: 0, blind: 0, enclosed: true });
    expect(rec.reason).toMatch(/^No entrance at any size: the model has a closed interior, but none of its 1 opening leads in from outside \(1 between its own rooms, 0 open to the outside on both sides\) - its doors are drawn, not cut\. Its openings are 0\.8×2\.7 blocks at 100 %: a player walks through as exported/);
  });

  it('the same building with its front doorway cut counts that doorway as its one entrance and recommends on it', async () => {
    const bricks = boxBuilding(true);
    const m = measureSceneAccess(bricks, await meshesOf(bricks));
    expect(m.openings.map(o => o.connects).sort()).toEqual(['entrance', 'interior']);
    const front = m.openings.find(o => o.connects === 'entrance')!;
    expect(front.centreLdu[2]).toBeCloseTo(-110, 6); // the front wall's arch, not the arcade at z = 0
    const rec = recommendAccessScale(m);
    expect(rec.openings).toMatchObject({ entrances: 1, interior: 1, enclosed: true });
    expect(rec.doorway).toMatchObject({ count: 1, passable: 1 });
    // 40 × 144 LDU: two studs, the width of a minifig's hips - the player's doorway at 100 % (SCALE-04).
    expect(rec).toMatchObject({ scale: 1, sizePct: 100 });
    expect(rec.reason).toMatch(/^Entrances are 0\.8×2\.7 blocks at 100 %: a player walks through as exported \(1\/1 clear the 0\.75×1\.8 a minifig needs\)/);
  });

  it('keeps the reach walk\'s floors at the asked scale as LDraw points (the tread planner\'s fine walk)', async () => {
    const bricks = [...wall(8, [-30, -10, 10], 6), ...stairs()];
    const meshes = await meshesOf(bricks);
    expect(measureSceneAccess(bricks, meshes).reachedFloorsLdu).toBeUndefined();
    const m = measureSceneAccess(bricks, meshes, { keepReachAt: 1 });
    const floors = m.reachedFloorsLdu!;
    expect(floors.length).toBe(m.reach[0]!.reachedSurfaces * 3);
    // The stairs' top step (4 bricks on the ground at y 0: its surface at LDraw y = -96) is among them, on its column.
    let top = Infinity;
    for (let k = 0; k < floors.length; k += 3) if (floors[k + 2]! > 90 && floors[k + 2]! < 110) top = Math.min(top, floors[k + 1]!);
    expect(top).toBe(-96);
    // A scale that is not a step is walked once more at its own (a display model exported at 0.5x).
    expect(measureSceneAccess(bricks, meshes, { keepReachAt: 0.5 }).reachedFloorsLdu!.length).toBeGreaterThan(0);
  });

  it('a forced coarser cell measures the same doorway to within a cell', async () => {
    const bricks = wall(8, [-30, -10, 10], 6);
    const m = measureSceneAccess(bricks, await meshesOf(bricks), { cell: { xz: 10, y: 8 } });
    expect(m.cell).toEqual({ xz: 10, y: 8 });
    expect(m.openings).toHaveLength(1);
    expect(Math.abs(m.openings[0]!.widthLdu - 60)).toBeLessThanOrEqual(10);
    expect(Math.abs(m.openings[0]!.heightLdu - 144)).toBeLessThanOrEqual(8);
  });

  it('coarsens the cells for a model over the cell budget and says which it used', async () => {
    const bricks = wall(8, [-30, -10, 10], 6);
    const m = measureSceneAccess(bricks, await meshesOf(bricks), { maxCells: 5_000 });
    expect(m.cell.xz).toBeGreaterThan(5);
    expect(m.cell.y).toBeGreaterThan(4);
    expect(m.grid.x * m.grid.y * m.grid.z).toBeLessThanOrEqual(5_000);
    expect(m.openings).toHaveLength(1);
  });
});

describe('the display scatter (settleLooseAccessories)', () => {
  /** A stand-in mesh: one triangle, the given local bounds (LDraw, y down). */
  const mesh = (description: string, min: [number, number, number], max: [number, number, number]) =>
    ({ partId: description, resolvedAs: description, triangles: [{}], studs: [], bounds: { min, max }, unresolvedRefs: [], description }) as never;
  const meshes = new Map<string, never>([
    ['plate.dat', mesh('Plate 4 x 4', [-40, 0, -40], [40, 8, 40])],
    ['goblet.dat', mesh('Minifig Goblet', [-6, -16, -6], [6, 0, 6])],
    ['clip.dat', mesh('Plate 1 x 1 with Clip', [-10, 0, -10], [10, 8, 10])],
  ]);
  const brick = (part: string, x: number, y: number, z: number): ParsedBrick => ({ part, color: 0, x, y, z } as ParsedBrick);
  const isAccessory = (_b: ParsedBrick, d: string): boolean => /^Minifig/.test(d);
  it('sets a goblet that touches nothing down on the plate under it, leaves a held one and a figure\'s own alone', () => {
    const plate = brick('plate.dat', 0, 0, 0); // top at y 0
    const floating = brick('goblet.dat', 10, -20, 10); // bottom at -20: 20 LDU over the plate
    const clip = brick('clip.dat', 200, 0, 0);
    const held = brick('goblet.dat', 200, -0.5, 0); // its bottom within a hair of the clip's top
    const own = brick('goblet.dat', -20, -30, -20); // a figure's goblet: excluded
    const settled = settleLooseAccessories([plate, floating, clip, held, own], meshes, new Set([own]), isAccessory);
    expect(settled).toEqual([{ part: 'goblet.dat', description: 'Minifig Goblet', dropLdu: 20 }]);
    expect(floating.y).toBe(0);
    expect(held.y).toBe(-0.5);
    expect(own.y).toBe(-30);
  });
  it('sets down a row of goblets that only touch each other (76417\'s page), not held by the model', () => {
    const plate = brick('plate.dat', 0, 0, 0);
    const row = [brick('goblet.dat', -20, -20, 0), brick('goblet.dat', -8, -20, 0), brick('goblet.dat', 4, -20, 0)];
    const settled = settleLooseAccessories([plate, ...row], meshes, new Set(), isAccessory);
    expect(settled).toHaveLength(3);
    for (const g of row) expect(g.y).toBe(0);
  });
  it('sets one with nothing under it down on the model\'s underside', () => {
    const plate = brick('plate.dat', 0, 0, 0); // underside at y 8
    const aside = brick('goblet.dat', 300, -50, 0);
    settleLooseAccessories([plate, aside], meshes, new Set(), isAccessory);
    expect(aside.y).toBe(8);
  });
});
