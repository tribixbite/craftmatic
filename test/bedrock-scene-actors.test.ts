import { describe, expect, it } from 'vitest';
import { BlockGrid } from '@craft/schem/types.js';
import { applySceneDoors, discoverSceneActors, doorBlockForColor, isDoorLeafDescription, sceneGridPoint, yawForFacing } from '../web/src/engine/bedrock-scene-actors.js';
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
  // A 1×4×6 leaf: 80 wide along +X from the hinge at the origin, 144 tall (up = −Y), 6 thick.
  '60623': ['0 Door  1 x  4 x  6 with 4 Panes and Stud Handle', ...box6(0, 80, -144, 0, -3, 3)].join('\n'),
  '60596': ['0 Door  1 x  4 x  6 Frame', ...box6(-40, 40, -144, 0, -10, 10)].join('\n'),
  '3821': ['0 Door  1 x  3 x  1 Right', ...box6(-15, 10, -24, 0, -10, 50)].join('\n'),
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
    expect(scene.seats).toHaveLength(1);
    expect(scene.seats[0]!.surfaceLdu).toEqual([600, -8, 0]);
    expect(scene.seats[0]!.facingLdu).toEqual([0, -1]);
    expect(scene.doors.map(d => d.part)).toEqual(['60623', '3821']);
    expect(scene.doors[0]).toMatchObject({ alongAxis: 'x', hingeAtMin: true, color: 6 });
    expect(scene.doors[0]!.minLdu).toEqual([1200, -144, -3]);
    expect(scene.doors[0]!.maxLdu).toEqual([1280, 0, 3]);
  });

  it('isDoorLeafDescription takes leaves and refuses frames, glass, sliders and stickers', () => {
    expect(isDoorLeafDescription('Door  1 x  4 x  6 with Stud Handle')).toBe(true);
    expect(isDoorLeafDescription('Door  1 x  4 x  6 Frame')).toBe(false);
    expect(isDoorLeafDescription('Glass for Door  1 x  4 x  6')).toBe(false);
    expect(isDoorLeafDescription('Door Sliding Type 2')).toBe(false);
    expect(isDoorLeafDescription('~Door  1 x  3 x  4 Right (Obsolete)')).toBe(true);
  });
});

describe('grid mapping', () => {
  const frame = { x: 0, y: 0, z: 0, scale: 1, cellXZ: LDU_PER_BLOCK, cellY: LDU_PER_BLOCK };
  it('sceneGridPoint maps LDraw into cells with Y flipped', () => {
    const p = sceneGridPoint(frame, [LDU_PER_BLOCK * 2, -LDU_PER_BLOCK * 3, LDU_PER_BLOCK]);
    expect(p[0]).toBeCloseTo(2, 9); expect(p[1]).toBeCloseTo(3, 9); expect(p[2]).toBeCloseTo(1, 9);
  });
  it('yawForFacing: −Z is 180, +Z is 0, +X is −90, −X is 90', () => {
    expect(yawForFacing([0, -1])).toBe(180);
    expect(yawForFacing([0, 1])).toBe(0);
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
  it('opens the leaf cells and hangs double doors with outer hinges in a 1.5-cell-wide leaf', () => {
    const grid = new BlockGrid(6, 6, 6);
    wallOf(grid);
    // Leaf along X from x=53 (cell 1) 80 LDU wide, 144 tall from the floor, thin in Z inside the wall at z cell 2.
    const z = 2 * LDU_PER_BLOCK + 20;
    const stats = applySceneDoors(grid, [{ part: '60623', description: 'Door', color: 6, minLdu: [LDU_PER_BLOCK, -144, z - 3], maxLdu: [LDU_PER_BLOCK + 80, 0, z + 3], alongAxis: 'x', hingeAtMin: true }], frame);
    expect(stats).toEqual({ doors: 2, leavesCleared: 6, skippedSmall: 0, skippedOutside: 0 });
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
    // Hinge at the max-Z end: seen from the east (facing east, viewer looks west), the viewer's left is south (+Z) → hinge left.
    const stats = applySceneDoors(grid, [{ part: 'd', description: 'Door', color: 15, minLdu: [x - 3, -120, 2 * LDU_PER_BLOCK + 5], maxLdu: [x + 3, 0, 2 * LDU_PER_BLOCK + 45], alongAxis: 'z', hingeAtMin: false }], frame);
    expect(stats.doors).toBe(1);
    expect(grid.get(2, 0, 2)).toBe('minecraft:birch_door[facing=east,half=lower,hinge=left,open=false,powered=false]');
    expect(grid.get(2, 1, 2)).toBe('minecraft:birch_door[facing=east,half=upper,hinge=left,open=false,powered=false]');
    expect(grid.get(2, 2, 2)).toBe('minecraft:air');
  });
  it('a 1.5-cell leaf that straddles three cells gets two doors where it covers most, and the sliver stays wall', () => {
    const grid = new BlockGrid(6, 6, 6);
    wallOf(grid);
    const z = 2 * LDU_PER_BLOCK + 20;
    // From 0.8 to 2.3 cells: covers cell 0 by 0.2, cell 1 fully, cell 2 by 0.3 → doors in cells 1 and 2.
    const stats = applySceneDoors(grid, [{ part: 'd', description: 'Door', color: 6, minLdu: [0.8 * LDU_PER_BLOCK, -144, z - 3], maxLdu: [2.3 * LDU_PER_BLOCK, 0, z + 3], alongAxis: 'x', hingeAtMin: true }], frame);
    expect(stats.doors).toBe(2);
    expect(grid.get(0, 0, 2)).toBe('minecraft:stone');
    expect(grid.get(1, 0, 2)).toMatch(/^minecraft:spruce_door\[facing=south,half=lower,hinge=left/);
    expect(grid.get(2, 0, 2)).toMatch(/^minecraft:spruce_door\[facing=south,half=lower,hinge=right/);
    expect(grid.get(3, 0, 2)).toBe('minecraft:stone');
  });
  it('leaves a leaf under two cells tall alone', () => {
    const grid = new BlockGrid(4, 4, 4);
    grid.set(1, 0, 1, 'minecraft:stone');
    const stats = applySceneDoors(grid, [{ part: 'd', description: 'Door', color: 15, minLdu: [LDU_PER_BLOCK, -24, LDU_PER_BLOCK], maxLdu: [LDU_PER_BLOCK + 40, 0, LDU_PER_BLOCK + 6], alongAxis: 'x', hingeAtMin: true }], frame);
    expect(stats.skippedSmall).toBe(1);
    expect(grid.get(1, 0, 1)).toBe('minecraft:stone');
  });
});
