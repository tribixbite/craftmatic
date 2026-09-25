/**
 * The moving parts (web/src/engine/bedrock-interactives.ts): detection from
 * the LDraw description and the part's own frame, the hinge rig, the doorway
 * cut into the collider grid, the world blocks a closed leaf lays (against the
 * collider re-lay's own oracle at every size and turn), the pack assets, and
 * the serialised runtime run as the device runs it.
 */
import { describe, expect, it } from 'vitest';
import { runtimeHost } from './_ix-host.js';
import { BlockGrid } from '../src/schem/types.js';
import {
  DOORWAY_MIN_HEIGHT_LDU, INTERACTIVE_FAMILY, INTERACTIVE_PROPERTY, INTERACTIVE_SIZE_PROPERTY, INTERACTIVE_TURN_PROPERTY, hitGroupName, interactiveHitboxes, interactiveNoun, placeHitBox, separateHitboxes, worldHitBox, hitBoxesOverlap, seatHitBox, type HitBox, OPEN_DEG, discoverInteractives, interactiveAnimation, interactiveBehavior, interactiveKindOf,
  interactiveRig, interactiveRuntimeItem, ixClosedBlocks, ixWorldBlocks, linkSharedDoorways, pairDoubleDoors, passSizeFor, planInteractiveColliders,
  rotateAbout, type InteractiveRuntimeConfig, type InteractiveRuntimeItem, type IxCell, type SceneInteractive,
} from '../web/src/engine/bedrock-interactives.js';
import { colliderState, COLLIDER_BLOCK_ID, COLLIDER_HI_STATE, COLLIDER_LO_STATE } from '../web/src/engine/bedrock-building-shell.js';
import { ScaledColliderGrid, QUARTER_TURNS, type QuarterTurn, type SourceCell } from '../web/src/engine/bedrock-collider-scale.js';
import { laidColliderBlocks } from '../web/src/ui/addon-preview-data.js';
import { SIZE_STEPS } from '../web/src/engine/bedrock-placement-pack.js';
import { bedrockJsonText } from '../web/src/engine/bedrock-json.js';
import { LDU_PER_BLOCK } from '../web/src/engine/lego-scale.js';
import type { LdrawPartMesh, Vec3 } from '../web/src/engine/ldraw-part-geometry.js';
import type { ParsedBrick } from '../web/src/engine/ldraw-parser.js';
import { sceneGridPoint, type SceneGridFrame } from '../web/src/engine/bedrock-scene-actors.js';

const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const C = LDU_PER_BLOCK;
/** A yaw about LDraw Y by `deg` (row-major). */
const yawRot = (deg: number): number[] => { const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a); return [c, 0, s, 0, 1, 0, -s, 0, c]; };
/** A mesh with the given local bounds (one triangle, so it counts as resolved geometry). */
const mesh = (part: string, description: string, min: Vec3, max: Vec3): LdrawPartMesh => ({
  partId: part, resolvedAs: part, description, triangles: [{ a: min, b: max, c: [min[0], max[1], min[2]] }] as unknown as LdrawPartMesh['triangles'],
  studs: [], bounds: { min, max }, unresolvedRefs: [],
} as unknown as LdrawPartMesh);
const brick = (part: string, x: number, y: number, z: number, rot = I, color = 6): ParsedBrick => ({ part, color, x, y, z, rot });

/** Part meshes named after the real moulds they copy (bounds measured from the Studio library, 2026-09-24). */
const MESHES = new Map<string, LdrawPartMesh | null>([
  ['60623.dat', mesh('60623', 'Door  1 x  4 x  6 with 4 Panes and Stud Handle', [-4, 3, -3], [67, 137, 3])],
  ['glass.dat', mesh('glass', 'Glass for Window  1 x  4 x  6', [2, 10, -1], [60, 130, 1])],
  ['40066.dat', mesh('40066', 'Door  1 x  6 x  7 with Arch and Rounded Pillars', [-60, 0, -10], [60, 168, 10])],
  ['3821.dat', mesh('3821', 'Door  1 x  3 x  1 Right', [-15, 0, -10], [10, 24, 50])],
  ['30042.dat', mesh('30042', 'Plate  4 x  5 Trap Door', [-10, -10, -40], [109, 6, 40])],
  ['60603.dat', mesh('60603', '=Glass for Window  1 x  4 x  3 Opening', [-37, -4, -4], [37, 56, 4])],
  ['3679.dat', mesh('3679', 'Turntable  2 x  2 Plate Top', [-17.5, 0, -17.5], [17.5, 8, 17.5])],
  ['4593.dat', mesh('4593', 'Hinge Control Stick', [-4, -38, -4], [4, 4, 4])],
  ['3001.dat', mesh('3001', 'Brick  2 x  4', [-40, -24, -20], [40, 0, 20])],
  ['3005.dat', mesh('3005', 'Brick  1 x  1', [-10, -24, -10], [10, 0, 10])],
  ['wall.dat', mesh('wall', 'Brick  1 x  8 x  6', [-80, -144, -10], [80, 0, 10])],
]);

describe('interactiveKindOf', () => {
  it('reads the class from the library description, and leaves frames and inserts alone', () => {
    const cases: Array<[string, string | null]> = [
      ['Door  1 x  4 x  6 with 4 Panes and Stud Handle', 'door'],
      ['GLASS DOOR FOR FRAME 1X4X6 (Needs Work)', 'door'],
      ['Train Door  1 x  4 x  5 Left', 'door'],
      ['Door  1 x  4 x  6 Frame', null],
      ['Door Frame  4 x  4 x  6 Corner', null],
      ['Glass for Window  1 x  4 x  6', null],
      ['=Glass for Window  1 x  4 x  3 Opening', 'window'],
      ['Window  1 x  2 x  2 Shutter', 'window'],
      ['Window Shutter  1 x  2.667 x  3 without Handle', 'window'],
      ['Window  1 x  4 x  3 without Shutter Tabs', null],
      ['Window  1 x  2 x  3 Pane with Thick Corner Tabs', 'window'],
      ['Plate  4 x  5 Trap Door', 'hatch'],
      ['Plate  6 x  8 Trap Door Frame with Flat Clips', null],
      ['=Container Cupboard  2 x  3 x  2 Door', 'cabinet'],
      ['Hinge Control Stick', 'lever'],
      ['Hinge Control Stick Base', null],
      ['Turntable  2 x  2 Plate Top', 'turnable'],
      ['Turntable  2 x  2 Plate Base', null],
      ['Vehicle, Steering Wheel with 2 x 2 Center', 'turnable'],
      ['Technic Steering Wheel Hub with Brake Disc and  3 Pegholes', null],
      ['Technic Rotor  2 Blade with 4 Studs', 'turnable'],
      ['Brick  2 x  4', null],
      // A garage's roller-door segments (grouped into one sliding door), a sliding leaf, a chest lid, a cupboard drawer.
      ['Roller Door Normal', 'door'],
      ['Door Sliding Type 2', 'door'],
      ['Container Treasure Chest Lid with Flat Top', 'lid'],
      ['Container Cupboard  2 x  3 x  2 Drawer', 'drawer'],
      ['Container Drawers  4 x  4 x  4', null],
      ['Container Treasure Chest without Slots', null],
      ['Electric 9V Battery Box  4 x  8 x  2 1/3 Lid', null],
    ];
    for (const [d, k] of cases) expect(interactiveKindOf(d), d).toBe(k);
  });
});

describe('sliding parts and lids (drawers, roller and sliding doors, chest lids)', () => {
  const M = new Map<string, LdrawPartMesh | null>([
    ['4218b.dat', mesh('4218b', 'Roller Door Normal', [-85, -4, -4], [85, 24, 4])],
    ['4536.dat', mesh('4536', 'Container Cupboard  2 x  3 x  2 Drawer', [-26, 0, -24], [26, 18, 16])],
    ['92410.dat', mesh('92410', 'Container Cupboard  2 x  3 x  2 with Hollow Studs', [-30, -2, 0], [30, 48, 40])],
    ['4738b.dat', mesh('4738b', 'Container Treasure Chest without Slots', [-52, -2, -20], [52, 32, 20])],
    ['80835.dat', mesh('80835', 'Container Treasure Chest Lid with Flat Top', [-40, 0, -20], [40, 17, 20])],
  ]);
  it('groups a stack of roller-door segments into ONE door that slides up by its height (42670\'s garage), and leaves flat or lone segments static', () => {
    const segs = [0, 28, 56, 84].map(y => brick('4218b.dat', 100, y, 50));
    // A second garage door beside it: a stack of its own.
    const other = [0, 28, 56].map(y => brick('4218b.dat', 300, y, 50));
    // 42639's sun deck: segments laid flat side by side; 42670's lone handle segment: trim.
    const flat = [0, 20, 40].map(x => brick('4218b.dat', 600 + x, -200, 50, [0, 0, 1, -1, 0, 0, 0, -1, 0]));
    const lone = brick('4218b.dat', 900, 0, 50);
    const found = discoverInteractives([...segs, ...other, ...flat, lone], M);
    expect(found.items).toHaveLength(2);
    expect(found.skipped.filter(sk => /laid flat/.test(sk.reason))).toHaveLength(3);
    expect(found.skipped.filter(sk => /too few for a doorway/.test(sk.reason))).toHaveLength(1);
    const d = found.items.find(i => i.bricks.length === 4)!;
    expect(d.kind).toBe('door');
    expect(d.slide).toBe(true);
    expect(d.axisLdu).toEqual([0, -1, 0]);
    expect(d.angleDeg).toBeCloseTo(112, 1);
    expect(d.openingLdu).toEqual({ width: 170, height: 112 });
    expect(interactiveNoun(d)).toBe('Garage door');
    // Its open tap boxes are the closed ones moved up by the stack's height.
    const hit = interactiveHitboxes(d, p => sceneGridPoint(frame, p));
    expect(hit.open[0]!.pivot[1] - hit.closed[0]!.pivot[1]).toBeCloseTo(112 / C, 2);
  });
  it('slides a drawer out of its cupboard, the way that is free', () => {
    // The cupboard body stands behind the drawer (+Z): it slides out along -Z.
    const drawer = brick('4536.dat', 0, 0, 0), body = brick('92410.dat', 0, -20, 20);
    const found = discoverInteractives([drawer, body], M);
    const d = found.items.find(i => i.kind === 'drawer')!;
    expect(d.slide).toBe(true);
    expect(d.axisLdu[2]).toBeCloseTo(-1, 6);
    expect(d.angleDeg).toBeCloseTo(24, 1);
  });
  it('turns a free rotor, and leaves one set into the surrounding bricks static (decoration)', () => {
    const R = new Map<string, LdrawPartMesh | null>([
      ['32124.dat', mesh('32124', 'Technic Rotor  2 Blade with 4 Studs', [-40, -4, -40], [40, 4, 40])],
      ['slab.dat', mesh('slab', 'Plate  8 x  8', [-80, -2, -80], [80, 2, 80])],
    ]);
    const free = discoverInteractives([brick('32124.dat', 0, 0, 0)], R);
    expect(free.items.map(i => i.kind)).toEqual(['turnable']);
    // A slab in the rotor's own plane: turning it would sweep through the slab.
    const set = discoverInteractives([brick('32124.dat', 0, 0, 0), brick('slab.dat', 0, 0, 90), brick('slab.dat', 0, 0, -90)], R);
    expect(set.items).toHaveLength(0);
    expect(set.skipped[0]?.reason).toMatch(/decoration/);
  });
  it('hinges a treasure chest lid on the chest\'s own hinge pins and lifts its free edge', () => {
    const body = brick('4738b.dat', 0, 0, 0), lid = brick('80835.dat', 0, -19, 0);
    const found = discoverInteractives([body, lid], M);
    const d = found.items.find(i => i.kind === 'lid')!;
    expect(d.pivotLdu).toEqual([0, 3, 18]);
    expect(Math.abs(d.axisLdu[0])).toBeCloseTo(1, 6);
    // The front (free) edge rises when it opens (LDraw Y is down).
    const front: Vec3 = [0, -19, -20];
    expect(rotateAbout(front, d.pivotLdu, d.axisLdu, d.angleDeg)[1]).toBeLessThan(front[1]);
  });
});

describe('discoverInteractives', () => {
  it('hinges a door leaf at its origin end, takes its glass along, and swings it away from what stands on one side', () => {
    const leaf = brick('60623.dat', 0, 0, 0);
    // The glass insert rides in the leaf; a wall stands on the leaf's -z side where it would swing with +90.
    const glass = brick('glass.dat', 0, 0, 0, I, 47);
    const obstacle = brick('wall.dat', 40, 144, -50);
    const found = discoverInteractives([leaf, glass, obstacle], MESHES);
    expect(found.items).toHaveLength(1);
    const d = found.items[0]!;
    expect(d.kind).toBe('door');
    expect(d.bricks).toEqual([leaf, glass]);
    // The hinge line: the leaf's up axis through its origin end (local x -4), mid-thickness.
    expect(Math.abs(d.axisLdu[1])).toBeCloseTo(1, 6);
    expect(d.pivotLdu[0]).toBeCloseTo(-4, 6);
    expect(d.pivotLdu[2]).toBeCloseTo(0, 6);
    expect(Math.abs(d.angleDeg)).toBe(OPEN_DEG.door);
    // Swung open, the free edge must land on the +z side, away from the wall.
    const free = rotateAbout([67, 70, 0], d.pivotLdu, d.axisLdu, d.angleDeg);
    expect(free[2]).toBeGreaterThan(40);
    expect(d.openingLdu).toEqual({ width: 71, height: 134 });
    expect(d.offGridDeg).toBe(0);
    // The entity origin: the closed assembly's bottom centre (LDraw Y down: the largest y).
    expect(d.anchorLdu[1]).toBe(137);
  });

  it('keeps a 45-degree leaf a working door, and says how far off the grid it is', () => {
    const found = discoverInteractives([brick('60623.dat', 0, 0, 0, yawRot(45))], MESHES);
    expect(found.items[0]).toMatchObject({ kind: 'door', offGridDeg: 45 });
    expect(Math.abs(found.items[0]!.axisLdu[1])).toBeCloseTo(1, 6);
  });

  it('leaves a part whose origin names no hinge (an arch, a centred pane) static, and calls a short leaf a cupboard', () => {
    const found = discoverInteractives([brick('40066.dat', 0, 0, 0), brick('3821.dat', 300, 0, 0)], MESHES);
    expect(found.skipped.map(s => s.part)).toEqual(['40066']);
    expect(found.items.map(i => i.kind)).toEqual(['cabinet']);
    expect(24).toBeLessThan(DOORWAY_MIN_HEIGHT_LDU);
  });

  it('hinges a trap door on its clip edge and lifts its free edge UP; hangs an opening casement from its top', () => {
    const found = discoverInteractives([brick('30042.dat', 0, 0, 0), brick('60603.dat', 400, -200, 0)], MESHES);
    const [hatch, casement] = found.items;
    expect(hatch!.kind).toBe('hatch');
    expect(Math.abs(hatch!.axisLdu[2])).toBeCloseTo(1, 6);
    expect(hatch!.pivotLdu[0]).toBeCloseTo(-10, 6);
    const free = rotateAbout([109, 0, 0], hatch!.pivotLdu, hatch!.axisLdu, hatch!.angleDeg);
    expect(free[1]).toBeLessThan(-80); // LDraw -Y is up
    expect(hatch!.openingLdu).toEqual({ width: 80, height: 119 });
    expect(casement!.kind).toBe('window');
    expect(Math.abs(casement!.axisLdu[0])).toBeCloseTo(1, 6);
    expect(casement!.pivotLdu[1]).toBeCloseTo(-200 - 4, 6);
  });

  it('spins a turntable top about its up axis with the load stacked on it, and a lever about its local X', () => {
    const top = brick('3679.dat', 0, 0, 0);
    const load = brick('3005.dat', 0, 0, 0); // a 1x1 brick on the top (its box sits above the plate: y -24..0)
    const beside = brick('3001.dat', 200, 0, 0); // touches nothing on the table
    const stick = brick('4593.dat', 0, 0, 300, yawRot(90));
    const found = discoverInteractives([top, load, beside, stick], MESHES);
    const turn = found.items.find(i => i.kind === 'turnable')!;
    expect(turn.bricks).toEqual([top, load]);
    expect(Math.abs(turn.axisLdu[1])).toBeCloseTo(1, 6);
    expect(turn.pivotLdu[0]).toBeCloseTo(0, 6);
    const lever = found.items.find(i => i.kind === 'lever')!;
    // Local X turned 90 degrees about Y is world -Z.
    expect(Math.abs(lever.axisLdu[2])).toBeCloseTo(1, 6);
  });

  it('never takes an excluded placement (a figure, a vehicle) and keeps doorways first under the cap', () => {
    const leaf = brick('60623.dat', 0, 0, 0);
    expect(discoverInteractives([leaf], MESHES, { exclude: new Set([leaf]) }).items).toHaveLength(0);
    const many = [brick('60603.dat', 0, 0, 0), brick('60603.dat', 200, 0, 0), leaf];
    const capped = discoverInteractives(many, MESHES, { max: 1 });
    expect(capped.items.map(i => i.kind)).toEqual(['door']);
    expect(capped.skipped.filter(s => /cap/.test(s.reason))).toHaveLength(2);
    expect(capped.warnings[0]).toMatch(/2 interactive parts over the 1-part cap/);
  });
});

describe('interactiveRig', () => {
  it('cancels to identity at zero spin: tilt then un-tilt', () => {
    const rig = interactiveRig(3, [1, 2, 3], [0, 0, 1]);
    expect(rig.bones.map(b => b.name)).toEqual(['ix_root', 'ix_tilt', 'ix_spin', 'ix_untilt']);
    expect(rig.bones[1]!.parent).toBe('ix_root');
    expect(rig.boneOf).toEqual(['ix_untilt', 'ix_untilt', 'ix_untilt']);
    const t = rig.bones[1]!.rotation!, u = rig.bones[3]!.rotation!;
    const m = (a: number[], b: number[]) => [0, 1, 2].flatMap(r => [0, 1, 2].map(c => a[r * 3]! * b[c]! + a[r * 3 + 1]! * b[3 + c]! + a[r * 3 + 2]! * b[6 + c]!));
    m(t, u).forEach((v, i) => expect(v).toBeCloseTo(I[i]!, 9));
    // The tilt takes LDraw up (-Y) onto the axis.
    expect(t[2]! * 0 + t[1]! * -1).toBeCloseTo(0, 9);
    expect(t[7]! * -1).toBeCloseTo(1, 9);
  });
});

describe('ixWorldBlocks', () => {
  const dims = { width: 7, height: 6, length: 5 };
  const cells: IxCell[] = [[1, 1, 2, 0, 16], [1, 2, 2, 0, 9], [2, 1, 2, 3, 16], [6, 0, 4, 0, 16], [0, 5, 0, 12, 16]];
  const asSource = (c: IxCell[]): SourceCell[] => c.map(([x, y, z, lo, hi]) => ({ x, y, z, lo, hi }));
  it('lays exactly what the collider re-lay lays, at every wand size and quarter turn', () => {
    for (const pct of SIZE_STEPS) for (const r of QUARTER_TURNS) {
      const mine = ixWorldBlocks(cells, dims, pct / 100, r);
      const oracle = laidColliderBlocks(asSource(cells), dims, pct, r, []).blocks;
      const theirs = new Map(oracle.map(b => [`${b.x},${b.y},${b.z}`, [b.lo, b.hi]]));
      expect(new Map([...mine].sort()), `${pct} % turn ${r}`).toEqual(new Map([...theirs].sort()));
    }
  });
  it('agrees with the walk world (ScaledColliderGrid) from 100 % up', () => {
    for (const pct of SIZE_STEPS.filter(p => p >= 100)) for (const r of QUARTER_TURNS) {
      const grid = new ScaledColliderGrid(asSource(cells), dims, pct / 100, r as QuarterTurn);
      const mine = ixWorldBlocks(cells, dims, pct / 100, r);
      for (const [key, [lo, hi]] of mine) {
        const [x, y, z] = key.split(',').map(Number) as [number, number, number];
        expect(grid.blockAt(x, z, y), `${key} at ${pct}/${r}`).toMatchObject({ lo, hi });
      }
    }
  });
});

/** A 12 x 6 x 10 collider grid: a floor (row 0) and a wall along x at z = `wallZ` .. `wallZ + depth - 1`, rows 1..4. */
function wallGrid(wallZ = 5, depth = 1): BlockGrid {
  const g = new BlockGrid(12, 6, 10);
  for (let x = 0; x < 12; x++) for (let z = 0; z < 10; z++) g.set(x, 0, z, colliderState(0, 16));
  for (let x = 0; x < 12; x++) for (let z = wallZ; z < wallZ + depth; z++) for (let y = 1; y <= 4; y++) g.set(x, y, z, colliderState(0, 16));
  return g;
}
/** The grid frame at minifig scale, origin at LDraw 0: grid (x, y, z) = LDraw (x, -y, -z) / C. */
const frame: SceneGridFrame = { x: 0, y: 0, z: 0, scale: 1, cellXZ: C, cellY: C };
/** A door leaf standing on the floor (grid y 1) at grid x `x0`..`x0 + width`, mid-plane at grid z `zc`. */
function leafAt(x0: number, width: number, zc: number, height = 2.6): SceneInteractive {
  const corner: Vec3 = [x0 * C, -C, -zc * C];
  return {
    kind: 'door', part: 'test', description: 'Door', bricks: [], pivotLdu: corner, axisLdu: [0, 1, 0], angleDeg: 90,
    leaf: { corner, along: [width * C, 0, 0], up: [0, -height * C, 0], normal: [0, 0, 1], thicknessLdu: 6 },
    anchorLdu: [(x0 + width / 2) * C, -C, -zc * C],
    boundsLdu: { min: [x0 * C, -(1 + height) * C, -zc * C - 3], max: [(x0 + width) * C, -C, -zc * C + 3] },
    openingLdu: { width: width * C, height: height * C }, offGridDeg: 0,
  };
}

describe('planInteractiveColliders', () => {
  it('cuts a 1.5-block leaf two columns wide and records its closed cells with the leaf\'s own height', () => {
    const g = wallGrid();
    const [plan] = planInteractiveColliders(g, [leafAt(3.25, 1.5, 5.5)], frame);
    expect(plan!.blocking.map(c => `${c[0]},${c[1]},${c[2]}`).sort()).toEqual(['3,1,5', '3,2,5', '3,3,5', '4,1,5', '4,2,5', '4,3,5'].sort());
    // Rows 1 and 2 full; the leaf tops out at 3.6: row 3 is 0..10/16.
    expect(plan!.blocking.find(c => c[0] === 3 && c[1] === 3)).toEqual([3, 3, 5, 0, 10]);
    for (const [x, y, z] of plan!.blocking) expect(g.get(x, y, z)).toBe(y === 3 ? colliderState(10, 16) : 'minecraft:air');
    // Only the leaf's span is opened: the wall's share of the top row, above the leaf, stays (a gap there
    // would be taller than the player over a closed door at 400 %).
    // The wall beside and above the leaf stays.
    expect(g.get(2, 1, 5)).toBe(colliderState(0, 16));
    expect(g.get(3, 4, 5)).toBe(colliderState(0, 16));
    expect(plan!.passageCleared).toBe(0);
    // The static cells around it are known to the runtime (the wall beside it and the floor under it).
    expect(plan!.neighbours.some(c => c[0] === 2 && c[1] === 1 && c[2] === 5)).toBe(true);
    expect(plan!.neighbours.some(c => c[0] === 3 && c[1] === 0 && c[2] === 5)).toBe(true);
  });

  it('opens the passage through a wall three cells deep, and nothing past the first standable column', () => {
    const g = wallGrid(4, 3); // wall at z 4, 5, 6
    const [plan] = planInteractiveColliders(g, [leafAt(3.25, 1.5, 5.5)], frame);
    expect(plan!.passageCleared).toBeGreaterThan(0);
    for (const z of [4, 6]) for (const x of [3, 4]) for (const y of [1, 2]) expect(g.get(x, y, z), `${x},${y},${z}`).toBe('minecraft:air');
    // Past the wall the floor was already standable: row 0 is untouched everywhere.
    for (let z = 0; z < 10; z++) expect(g.get(3, 0, z)).toBe(colliderState(0, 16));
  });

  it('finds a passable size from the opening and says when none reaches the player\'s passage', () => {
    expect(passSizeFor('door', { width: 80, height: 144 })).toBe(100);
    expect(passSizeFor('door', { width: 40, height: 72 })).toBe(150);
    expect(passSizeFor('door', { width: 13, height: 20 })).toBe(0);
    expect(passSizeFor('hatch', { width: 80, height: 40 })).toBe(150);
    expect(passSizeFor('hatch', { width: 80, height: 20 })).toBe(300);
    expect(passSizeFor('gate', { width: 60, height: 20 })).toBe(100);
  });
});

/** A leaf's closed mid-plane in model blocks (what playable-addon.ts ships as `item.leaf`). */
function leafModel(it: SceneInteractive): InteractiveRuntimeItem['leaf'] {
  const l = it.leaf!, g = (p: Vec3) => sceneGridPoint(frame, p);
  const c = g(l.corner), a = g(add3(l.corner, l.along)), u = g(add3(l.corner, l.up)), n = g(add3(l.corner, l.normal.map(v => v * C) as Vec3));
  const d = (p: Vec3) => [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
  return { c: [...c], a: d(a), u: d(u), n: d(n), t: l.thicknessLdu / C };
}
const add3 = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

/** `leafAt` hinged at its RIGHT end (x0 + width), swinging the other way: the right leaf of a double door. */
function leafAtRight(x0: number, width: number, zc: number, height = 2.6): SceneInteractive {
  const l = leafAt(x0, width, zc, height);
  const corner: Vec3 = [(x0 + width) * C, -C, -zc * C];
  return { ...l, pivotLdu: corner, angleDeg: -90, leaf: { ...l.leaf!, corner, along: [-width * C, 0, 0] } };
}

/** Runtime items for two leaves of a double door in a 1-thick wall (hinged at each jamb), plus a turnable, as the pack ships them. */
function doubleDoorConfig(passSize = 100, sideBySide = false): InteractiveRuntimeConfig {
  const g = wallGrid();
  // `sideBySide`: two doors in adjacent openings, both hinged on the left (76457's Door 1 and Door 2).
  const left = leafAt(2.25, 1.5, 5.5), right = sideBySide ? leafAt(3.75, 1.5, 5.5) : leafAtRight(3.75, 1.5, 5.5);
  const plans = planInteractiveColliders(g, [left, right], frame);
  const items: InteractiveRuntimeItem[] = [
    { ...interactiveRuntimeItem(left, 'craftmatic:x_door_1', 'Door 1', plans[0]!), passSize, leaf: leafModel(left) },
    { ...interactiveRuntimeItem(right, 'craftmatic:x_door_2', 'Door 2', plans[1]!), angle: sideBySide ? 90 : -90, passSize, leaf: leafModel(right) },
    interactiveRuntimeItem({ ...left, kind: 'turnable', angleDeg: 90, leaf: undefined, openingLdu: undefined }, 'craftmatic:x_turnable_1', 'Turnable 1', null),
  ];
  linkSharedDoorways(items);
  pairDoubleDoors(items);
  return { family: INTERACTIVE_FAMILY, property: INTERACTIVE_PROPERTY, label: 'Test', dims: { width: 12, height: 6, length: 10 }, colliders: { block: COLLIDER_BLOCK_ID, loState: COLLIDER_LO_STATE, hiState: COLLIDER_HI_STATE }, items, turnProperty: INTERACTIVE_TURN_PROPERTY, sizeProperty: INTERACTIVE_SIZE_PROPERTY };
}

describe('linkSharedDoorways, pairDoubleDoors and ixClosedBlocks', () => {
  it('pairs the two leaves of a double door (hinged at each jamb), not two doors hung side by side', () => {
    const pair = doubleDoorConfig();
    expect(pair.items[0]!.pairs).toEqual([1]);
    expect(pair.items[1]!.pairs).toEqual([0]);
    // 76457's Door 1 and Door 2 (device 2026-09-24e): the doorways touch, but each is its own door.
    const side = doubleDoorConfig(100, true);
    expect(side.items[0]!.shares).toEqual([1]);
    expect(side.items[0]!.pairs).toBeUndefined();
    expect(side.items[1]!.pairs).toBeUndefined();
    // A double door the source left OPEN (76269): both leaves swung to the same side, hinges the two widths apart.
    const leafItem = (hx: number, a: number[]): InteractiveRuntimeItem => ({ ...side.items[0]!, shares: [], pairs: undefined, leaf: { c: [hx, 1, 5], a, u: [0, 2.5, 0], n: [a[2]!, 0, -a[0]!], t: 0.1 } });
    const open = [leafItem(2, [0.1, 0, 1.3]), leafItem(4.6, [-0.1, 0, 1.3])];
    open[0]!.shares = [1]; open[1]!.shares = [0];
    pairDoubleDoors(open);
    expect(open[0]!.pairs).toEqual([1]);
    // Two leaves meeting at a corner (10326): one's closed cells stand a step along the other's normal, so
    // neither doorway passes unless both open - one entrance, moved together.
    const corner = [
      { ...leafItem(2, [-1.3, 0, 0]), blocking: [[1, 1, 5, 0, 16], [2, 1, 5, 0, 16]] as IxCell[] },
      { ...leafItem(2.2, [0, 0, 1.3]), leaf: { c: [2.2, 1, 5.4], a: [0, 0, 1.3], u: [0, 2.5, 0], n: [1, 0, 0], t: 0.1 }, blocking: [[2, 1, 6, 0, 16], [2, 1, 7, 0, 16]] as IxCell[] },
    ];
    corner[0]!.shares = [1]; corner[1]!.shares = [0];
    pairDoubleDoors(corner);
    expect(corner[0]!.pairs).toEqual([1]);
    // Two doors in line a pier apart, each hinged on its left: neither meets, nor spans, nor stands in the other's path.
    const apart = [
      { ...leafItem(2, [1.3, 0, 0]), blocking: [[2, 1, 5, 0, 16], [3, 1, 5, 0, 16]] as IxCell[] },
      { ...leafItem(4, [1.3, 0, 0]), blocking: [[4, 1, 5, 0, 16], [5, 1, 5, 0, 16]] as IxCell[] },
    ];
    apart[0]!.shares = [1]; apart[1]!.shares = [0];
    pairDoubleDoors(apart);
    expect(apart[0]!.pairs).toBeUndefined();
  });
  it('links the two leaves of a double door, and lays a shared cell while either is closed', () => {
    const cfg = doubleDoorConfig();
    expect(cfg.items[0]!.shares).toEqual([1]);
    expect(cfg.items[1]!.shares).toEqual([0]);
    const dims = cfg.dims;
    const shared = '3,1,5';
    expect(ixClosedBlocks(cfg.items, dims, 1, 0, () => false).get(shared)).toEqual([0, 16]);
    expect(ixClosedBlocks(cfg.items, dims, 1, 0, i => i === 0).get(shared)).toEqual([0, 16]);
    expect(ixClosedBlocks(cfg.items, dims, 1, 0, () => true).size).toBe(0);
    // Too small to pass at this size: it stays laid even open.
    const small = doubleDoorConfig(200);
    expect(ixClosedBlocks(small.items, dims, 1, 0, () => true).size).toBeGreaterThan(0);
    expect(ixClosedBlocks(small.items, dims, 2, 0, () => true).size).toBe(0);
  });
});

describe('interactive entity assets', () => {
  const it0: SceneInteractive = leafAt(2, 1.5, 5.5);
  it('declares a float angle property (a float literal), a tap box, an interact button and no dropped component', () => {
    const hit = interactiveHitboxes(it0, p => sceneGridPoint(frame, p));
    const behavior = interactiveBehavior('craftmatic:x_door_1', it0, hit) as { 'minecraft:entity': { description: { properties: Record<string, unknown> }; components: Record<string, unknown>; component_groups: Record<string, any>; events: Record<string, any> } };
    const text = bedrockJsonText(behavior);
    expect(text).toContain('"default":0.0');
    expect(text).not.toContain('minecraft:pushable"');
    const c = behavior['minecraft:entity'].components;
    expect(c['minecraft:type_family']).toEqual({ family: [INTERACTIVE_FAMILY, 'craftmatic_ix_door'] });
    expect(c['minecraft:interact']).toEqual({ interactions: [{ interact_text: 'action.interact.craftmatic_open', swing: true }] });
    // The collision box is a thin needle (it only sets the render cull); taps land on the shaped hit boxes.
    expect((c['minecraft:collision_box'] as { width: number }).width).toBe(0.25);
    expect((c['minecraft:custom_hit_test'] as { hitboxes: HitBox[] }).hitboxes).toEqual(hit.closed);
    expect(c['minecraft:scale']).toBeUndefined();
    const groups = behavior['minecraft:entity'].component_groups;
    expect(Object.keys(groups)).toHaveLength(4 * SIZE_STEPS.length * 2);
    expect(groups[hitGroupName(90, 200, true)]['minecraft:custom_hit_test'].hitboxes).toEqual(hit.open.map(b => placeHitBox(b, 90, 2)));
    // The wand's size event selects the turn-0 closed boxes until the runtime syncs.
    expect(behavior['minecraft:entity'].events['craftmatic:size_200'].add.component_groups).toEqual([hitGroupName(0, 200, false)]);
    for (const name of ['craftmatic:turn', 'craftmatic:size']) expect(behavior['minecraft:entity'].description.properties[name]).toBeTruthy();
  });
  it('eases the spin bone in the client toward the property over the swing time', () => {
    const anim = interactiveAnimation('craftmatic:x_door_1', 225);
    expect(JSON.stringify(anim.file)).toContain('"rotation":[0,"-v.ix_angle",0]');
    expect(anim.initialize).toEqual([`v.ix_angle = q.property('${INTERACTIVE_PROPERTY}');`]);
    expect(anim.preAnimation[0]).toContain('q.delta_time * 225');
  });
});

// ─── The serialised runtime, run as the device runs it ───────────────────────

describe('interactives runtime (scripts/interactives.js)', () => {
  const anchor = { x: 100, y: 64, z: 200 };
  const keysOf = (cfg: InteractiveRuntimeConfig, i: number, f = 1, r = 0) => [...ixWorldBlocks(cfg.items[i]!.blocking, cfg.dims, f, r).keys()].map(k => { const [x, y, z] = k.split(',').map(Number) as [number, number, number]; return `${anchor.x + x},${anchor.y + y},${anchor.z + z}`; });
  it('lays a freshly placed door closed, opens both leaves of a double door on one tap, restores the static state and plays the door sound', () => {
    const cfg = doubleDoorConfig();
    const h = runtimeHost(cfg);
    const a = h.spawn(0, anchor), b = h.spawn(1, anchor);
    h.sync();
    for (const k of [...keysOf(cfg, 0), ...keysOf(cfg, 1)]) expect(h.blocks.get(k)?.typeId, k).toBe(COLLIDER_BLOCK_ID);
    expect(a.getDynamicProperty('craftmatic:ix_ready')).toBe(true);
    expect(a.angle).toBe(0);
    h.tap(a);
    expect(a.getDynamicProperty('craftmatic:ix_open')).toBe(true);
    expect(b.getDynamicProperty('craftmatic:ix_open')).toBe(true);
    expect(a.angle).toBe(90);
    expect(b.angle).toBe(-90);
    for (const k of [...keysOf(cfg, 0), ...keysOf(cfg, 1)]) expect(h.blocks.has(k), k).toBe(false);
    expect(h.sounds).toEqual(['random.door_open']);
    h.tap(b);
    for (const k of keysOf(cfg, 0)) expect(h.blocks.get(k)?.typeId).toBe(COLLIDER_BLOCK_ID);
    expect(a.angle).toBe(0);
    expect(h.sounds.at(-1)).toBe('random.door_close');
  });

  it('ignores a tap that reaches the part through a wall of the pack\'s colliders (they have no selection box), and says so', () => {
    const cfg = doubleDoorConfig();
    // One tap box, 0.3 wide and 2.5 tall, standing on the entity's origin.
    cfg.items[0]!.hit = { c: [{ width: 0.3, height: 2.5, pivot: [0, 1.25, 0] }], o: [{ width: 0.3, height: 2.5, pivot: [0, 1.25, 0] }] };
    const h = runtimeHost(cfg);
    const a = h.spawn(0, anchor, 1, 0, { x: 103, y: 65, z: 205.5 });
    h.sync();
    h.aim({ x: 103.5, y: 66.6, z: 199.5 }, { x: 103, y: 66.25, z: 205.5 });
    // A wall across the whole line of sight (three cells wide, the part's height).
    for (const x of [102, 103, 104]) for (const y of [65, 66, 67]) h.setCollider(x, y, 202, 0, 16);
    h.tap(a);
    expect(a.getDynamicProperty('craftmatic:ix_open')).toBeUndefined();
    expect(h.lastBar()).toMatch(/door 1 is behind a wall from here/);
    // A floor plate under the line of sight is not a wall.
    for (const x of [102, 103, 104]) for (const y of [65, 66, 67]) h.setCollider(x, y, 202, 0, 3);
    h.tap(a);
    expect(a.getDynamicProperty('craftmatic:ix_open')).toBe(true);
  });

  it('judges a tap by the line of sight to the part, not by where the camera looks (a touch tap), and not by the cell the part itself pokes into', () => {
    const cfg = doubleDoorConfig();
    cfg.items[0]!.hit = { c: [{ width: 0.3, height: 2.5, pivot: [0, 1.25, 0] }], o: [{ width: 0.3, height: 2.5, pivot: [0, 1.25, 0] }] };
    const h = runtimeHost(cfg);
    const a = h.spawn(0, anchor, 1, 0, { x: 103, y: 65, z: 205.5 });
    h.sync();
    // The camera looks at a wall to the side; the finger is on the door, which the eyes see clearly (device 2026-09-24e, 76457's Door 1).
    h.setCollider(99, 66, 199, 0, 16);
    Object.assign(h.player, { getHeadLocation: () => ({ x: 103.5, y: 66.6, z: 199.5 }), getViewDirection: () => ({ x: -1, y: 0, z: 0 }) });
    h.tap(a);
    expect(a.getDynamicProperty('craftmatic:ix_open')).toBe(true);
    // The frame's cell the (skewed) leaf reaches into is full, right in front of the leaf: not a wall in front of it.
    const h2 = runtimeHost(cfg);
    const b = h2.spawn(0, anchor, 1, 0, { x: 103, y: 65, z: 205.5 });
    h2.sync();
    for (const y of [65, 66, 67]) h2.setCollider(103, y, 205, 0, 16);
    h2.aim({ x: 103.5, y: 66.6, z: 201.5 }, { x: 103, y: 66.25, z: 205.5 });
    h2.tap(b);
    expect(b.getDynamicProperty('craftmatic:ix_open')).toBe(true);
  });

  it('moves the two leaves of a double door together, and never a door hung beside another', () => {
    const side = doubleDoorConfig(100, true);
    const h = runtimeHost(side);
    const a = h.spawn(0, anchor), b = h.spawn(1, anchor);
    h.sync();
    h.tap(b);
    expect(b.getDynamicProperty('craftmatic:ix_open')).toBe(true);
    expect(a.getDynamicProperty('craftmatic:ix_open')).toBeUndefined();
    expect(a.angle).toBe(0);
    h.tap(a);
    expect(a.getDynamicProperty('craftmatic:ix_open')).toBe(true);
    expect(a.angle).toBe(90);
    // Closing one keeps the other open, and the shared cells follow each leaf's own state.
    h.tap(b);
    expect(b.getDynamicProperty('craftmatic:ix_open')).toBe(false);
    expect(a.getDynamicProperty('craftmatic:ix_open')).toBe(true);
  });

  it('shuts a window, lid or cupboard past a player standing at it: only a doorway refuses to close on someone', () => {
    const cfg = doubleDoorConfig();
    // Door 1 as a window: the same leaf, no doorway cells.
    cfg.items[0] = { ...cfg.items[0]!, kind: 'window', blocking: [], neighbours: [], shares: [], pairs: undefined };
    const h = runtimeHost(cfg);
    const a = h.spawn(0, anchor);
    h.sync();
    h.tap(a);
    expect(a.getDynamicProperty('craftmatic:ix_open')).toBe(true);
    // Standing right on the closed pane's plane (GameTest 2026-09-25: a lid never closed on the player beside it).
    h.player.location = { x: anchor.x + 3, y: anchor.y + 1, z: 205.5 };
    h.players.push(h.player);
    h.tap(a);
    expect(a.getDynamicProperty('craftmatic:ix_open')).toBe(false);
  });

  it('counts a tap reported twice (hit and interact in one tick) once', () => {
    const cfg = doubleDoorConfig();
    const h = runtimeHost(cfg);
    const a = h.spawn(0, anchor);
    h.sync();
    h.interactTwice(a);
    expect(a.getDynamicProperty('craftmatic:ix_open')).toBe(true);
  });

  it('will not close on a player standing IN the leaf, closes past one beside it and steps them out, and never overwrites a block the player built there', () => {
    const cfg = doubleDoorConfig();
    const h = runtimeHost(cfg);
    const a = h.spawn(0, anchor);
    h.sync();
    h.tap(a);
    const [k0] = keysOf(cfg, 0);
    const [x, y, z] = k0!.split(',').map(Number) as [number, number, number];
    // The leaf's mid-plane is at grid z 5.5 (world z 205.5): standing on it refuses the close.
    h.player.location = { x: x + 0.5, y, z: 205.5 };
    h.players.push(h.player);
    h.tap(a);
    expect(a.getDynamicProperty('craftmatic:ix_open')).toBe(true);
    expect(h.lastBar()).toMatch(/standing in the door 1/);
    // Inside the doorway's block but clear of the leaf (device 2026-09-24d: "outside the leaves"): it closes, and the player is stepped out of the block.
    h.player.location = { x: x + 0.5, y, z: z + 0.12 };
    h.tap(a);
    expect(a.getDynamicProperty('craftmatic:ix_open')).toBe(false);
    expect(h.teleports.length).toBeGreaterThan(0);
    expect(h.player.location.z).toBeLessThanOrEqual(z - 0.3 + 1e-9);
    h.tap(a);
    h.players.length = 0;
    h.blocks.set(k0!, { typeId: 'minecraft:stone', states: {} });
    h.tap(a);
    expect(h.blocks.get(k0!)?.typeId).toBe('minecraft:stone');
  });

  it('keeps a too-small doorway blocked when it opens, and says which size passes', () => {
    const cfg = doubleDoorConfig(200);
    const h = runtimeHost(cfg);
    const a = h.spawn(0, anchor);
    h.sync();
    h.tap(a);
    expect(a.angle).toBe(90);
    for (const k of keysOf(cfg, 0)) expect(h.blocks.get(k)?.typeId).toBe(COLLIDER_BLOCK_ID);
    expect(h.lastBar()).toMatch(/too small to walk through at 100 percent\. Place the build at 200 percent or larger/);
  });

  it('maps the doorway with the placement\'s own size and turn', () => {
    const cfg = doubleDoorConfig();
    const h = runtimeHost(cfg);
    const a = h.spawn(0, anchor, 2, 90);
    h.sync();
    const closed = keysOf(cfg, 0, 2, 90);
    expect(closed.length).toBeGreaterThan(keysOf(cfg, 0).length);
    for (const k of closed) expect(h.blocks.get(k)?.typeId, k).toBe(COLLIDER_BLOCK_ID);
    // The rig's root carries the turn and the size; the tap boxes follow them.
    expect(a.actorProps.get(INTERACTIVE_TURN_PROPERTY)).toBe(90);
    expect(a.actorProps.get(INTERACTIVE_SIZE_PROPERTY)).toBe(2);
    expect(a.events.at(-1)).toBe(hitGroupName(90, 200, false));
    h.tap(a);
    for (const k of closed) expect(h.blocks.has(k), k).toBe(false);
    expect(a.events.at(-1)).toBe(hitGroupName(90, 200, true));
  });

  it('turns a turnable a step per tap and keeps the angle', () => {
    const cfg = doubleDoorConfig();
    const h = runtimeHost(cfg);
    const t = h.spawn(2, anchor);
    h.sync();
    h.tap(t); h.tap(t); h.tap(t);
    expect(t.angle).toBe(270);
    expect(t.getDynamicProperty('craftmatic:ix_angle')).toBe(270);
    expect(h.sounds).toEqual(['random.click', 'random.click', 'random.click']);
  });

  it('survives a script reload: an open door stays open, its colliders untouched, its angle re-asserted', () => {
    const cfg = doubleDoorConfig();
    const h = runtimeHost(cfg);
    const a = h.spawn(0, anchor), t = h.spawn(2, anchor);
    h.sync();
    h.tap(a); h.tap(t);
    const before = new Map(h.blocks);
    a.angle = undefined; t.angle = undefined;
    h.load(); // a new runtime over the same world
    h.sync();
    expect(new Map(h.blocks)).toEqual(before);
    expect(a.angle).toBe(90);
    expect(t.angle).toBe(90);
  });
});

describe('the passability walk (engine/interactive-walk.ts)', () => {
  /** A pack over `wallGrid` with one door cut in it; `passSize` as the pack would ship it. */
  async function wallPack(passSize: number, width = 1.5) {
    const g = wallGrid();
    const leaf = leafAt(3.25, width, 5.5);
    const [plan] = planInteractiveColliders(g, [leaf], frame);
    const item = { ...interactiveRuntimeItem(leaf, 'craftmatic:x_door_1', 'Door 1', plan!), passSize, normal: [0, 0, 1] as [number, number, number] };
    const cells: SourceCell[] = [];
    for (let x = 0; x < g.width; x++) for (let y = 0; y < g.height; y++) for (let z = 0; z < g.length; z++) {
      const m = /\[lo=(\d+),hi=(\d+)\]$/.exec(g.get(x, y, z));
      if (m) cells.push({ x, y, z, lo: Number(m[1]), hi: Number(m[2]) });
    }
    const cfg: InteractiveRuntimeConfig = { family: INTERACTIVE_FAMILY, property: INTERACTIVE_PROPERTY, label: 'Wall', dims: { width: g.width, height: g.height, length: g.length }, colliders: { block: COLLIDER_BLOCK_ID, loState: COLLIDER_LO_STATE, hiState: COLLIDER_HI_STATE }, items: [item], turnProperty: INTERACTIVE_TURN_PROPERTY, sizeProperty: INTERACTIVE_SIZE_PROPERTY };
    return { cells, dims: cfg.dims, interactives: cfg };
  }
  it('walks a player through the open doorway, never through the closed one, at every quarter turn', async () => {
    const { walkThroughDoorway, verdictOf } = await import('../web/src/engine/interactive-walk.js');
    const pack = await wallPack(100);
    for (const r of QUARTER_TURNS) for (const size of [100, 200]) {
      const open = walkThroughDoorway(pack, 0, size, r, true), closed = walkThroughDoorway(pack, 0, size, r, false);
      expect(open.outcome, `open at ${size} % turn ${r}`).toBe('passed');
      expect(closed.outcome, `closed at ${size} % turn ${r}`).not.toBe('passed');
      expect(verdictOf(open, closed)).toBe('OK');
    }
  });
  it('keeps a doorway too small at this size blocked when open (SMALL), and lets it pass from its passable size', async () => {
    const { walkThroughDoorway, verdictOf } = await import('../web/src/engine/interactive-walk.js');
    const pack = await wallPack(200);
    const small = verdictOf(walkThroughDoorway(pack, 0, 100, 0, true), walkThroughDoorway(pack, 0, 100, 0, false));
    expect(small).toBe('SMALL');
    const big = verdictOf(walkThroughDoorway(pack, 0, 200, 0, true), walkThroughDoorway(pack, 0, 200, 0, false));
    expect(big).toBe('OK');
  });
});

describe('tap boxes (minecraft:custom_hit_test)', () => {
  const toModel = (p: Vec3): Vec3 => sceneGridPoint(frame, p);
  it('follow a leaf in narrow stretches, closed and swung open, and never reach past it', () => {
    const leaf = leafAt(3.25, 1.5, 5.5);
    const hit = interactiveHitboxes(leaf, toModel);
    const origin = toModel(leaf.anchorLdu);
    expect(hit.closed).toHaveLength(4);
    for (const b of hit.closed) {
      expect(b.width).toBeLessThanOrEqual(0.4);
      const w = worldHitBox(origin, b);
      // Inside the leaf's own span: x 3.25..4.75, height 1..3.6, and on its plane (z 5.5).
      expect(w.x0).toBeGreaterThanOrEqual(3.25 - 1e-3); expect(w.x1).toBeLessThanOrEqual(4.75 + 1e-3);
      expect(w.z0).toBeLessThan(5.5); expect(w.z1).toBeGreaterThan(5.5);
      expect(w.y0).toBeCloseTo(1, 3); expect(w.y1).toBeCloseTo(3.6, 3);
    }
    // Open (+90 about the up axis at x 3.25): the boxes lie along the normal from the hinge.
    const open = hit.open.map(b => worldHitBox(origin, b));
    expect(Math.min(...open.map(w => w.x0))).toBeGreaterThan(3.25 - 0.3);
    expect(Math.max(...open.map(w => w.x1))).toBeLessThan(3.25 + 0.3);
  });
  it('turn and scale with the placement', () => {
    const b: HitBox = { width: 0.4, height: 2, pivot: [1, 1, 0.5] };
    expect(placeHitBox(b, 90, 2)).toEqual({ width: 0.8, height: 4, pivot: [-1, 2, 2] });
    expect(placeHitBox(b, 180, 1).pivot).toEqual([-1, 1, -0.5]);
    expect(placeHitBox(b, 270, 1).pivot).toEqual([0.5, 1, -1]);
  });
  it('are shrunk off a seat and off a neighbouring part until nothing overlaps', () => {
    const a = leafAt(3.25, 1.5, 5.5), b = leafAt(4.9, 1.2, 5.6);
    const parts = [a, b].map(it => ({ origin: toModel(it.anchorLdu), hit: interactiveHitboxes(it, toModel) }));
    const seat = [3.6, 1.2, 5.4];
    const res = separateHitboxes(parts, [seat]);
    expect(res.shrunk + res.dropped).toBeGreaterThan(0);
    const boxes = parts.map(p => [...p.hit.closed, ...p.hit.open].map(x => worldHitBox(p.origin, x)));
    for (const x of boxes[0]!) for (const y of boxes[1]!) expect(hitBoxesOverlap(x, y)).toBe(false);
    for (const list of boxes) for (const x of list) expect(hitBoxesOverlap(x, seatHitBox(seat))).toBe(false);
  });
  it('empties one of two coincident parts (it stays static) rather than let them share a tap, and a part on a seat', () => {
    const a = leafAt(3.25, 1.5, 5.5), b = leafAt(3.25, 1.5, 5.5);
    const parts = [a, b].map(it => ({ origin: toModel(it.anchorLdu), hit: interactiveHitboxes(it, toModel) }));
    separateHitboxes(parts);
    expect(parts.filter(p => p.hit.closed.length && p.hit.open.length)).toHaveLength(1);
    const c = { origin: toModel(a.anchorLdu), hit: interactiveHitboxes(a, toModel) };
    separateHitboxes([c], [[4, 1, 5.5]]);
    for (const x of [...c.hit.closed, ...c.hit.open]) expect(hitBoxesOverlap(worldHitBox(c.origin, x), seatHitBox([4, 1, 5.5]))).toBe(false);
  });
  it('names a barred door a gate and a short leaf a cupboard', () => {
    expect(interactiveNoun({ kind: 'door', description: 'Door 1 x 4 x 6 Barred' })).toBe('Gate');
    expect(interactiveNoun({ kind: 'door', description: 'Door  1 x  4 x  6 with 4 Panes and Stud Handle' })).toBe('Door');
    expect(interactiveNoun({ kind: 'cabinet', description: 'Door  1 x  3 x  1 Right' })).toBe('Cupboard');
  });
});

describe('furniture seats', () => {
  it('sits on a library chair, bench or stool mould on its PAN (not its backrest), not only on the minifig seat', async () => {
    const { isFurnitureSeat, discoverSceneActors } = await import('../web/src/engine/bedrock-scene-actors.js');
    expect(isFurnitureSeat('Fabuland Chair')).toBe(true);
    expect(isFurnitureSeat('Fabuland Bench')).toBe(true);
    expect(isFurnitureSeat('HOLDER FOR CHAIR 20MM (Needs Work)')).toBe(false);
    expect(isFurnitureSeat('Brick  2 x  4')).toBe(false);
    // A chair: the pan at y 0 over the whole footprint, a backrest rising 40 LDU at the back edge with a rail on top.
    const chair = {
      ...mesh('4222a', 'Fabuland Chair', [-20, -40, -20], [20, 24, 20]),
      triangles: [
        { a: [-20, 0, -20], b: [20, 0, -20], c: [20, 0, 20], color: 16 }, { a: [-20, 0, -20], b: [20, 0, 20], c: [-20, 0, 20], color: 16 },
        { a: [-20, 0, 20], b: [20, 0, 20], c: [20, -40, 20], color: 16 },
        { a: [-20, -40, 16], b: [20, -40, 16], c: [20, -40, 20], color: 16 }, { a: [-20, -40, 16], b: [20, -40, 20], c: [-20, -40, 20], color: 16 },
        { a: [-20, 24, -20], b: [20, 24, -20], c: [20, 24, 20], color: 16 },
      ],
    } as unknown as LdrawPartMesh;
    const meshes = new Map([['4222a.dat', chair]]);
    const provider = { getPartMesh: async (p: string) => meshes.get(p) ?? null } as unknown as Parameters<typeof discoverSceneActors>[1];
    const scene = await discoverSceneActors([brick('4222a.dat', 100, 0, 50)], provider);
    expect(scene.seats).toHaveLength(1);
    // The pan (y 0), not the backrest's top (y -40): a chair's box top is its back (device 2026-09-24e seat audit).
    expect(scene.seats[0]!.surfaceLdu).toEqual([100, 0, 50]);
  });

  it('finds brick-built benches (on legs), chairs (a backrest along a long side) and beds (a headboard), and not a counter or a low block', async () => {
    const { brickBuiltFurniture } = await import('../web/src/engine/bedrock-scene-actors.js');
    const meshes = new Map<string, LdrawPartMesh>([
      ['3958.dat', mesh('3958', 'Plate  6 x  6', [-60, 0, -60], [60, 8, 60])],
      ['floor.dat', mesh('floor', 'Plate 16 x 16', [-160, 0, -160], [160, 8, 160])],
      ['2431.dat', mesh('2431', 'Tile  1 x  4 with Groove', [-40, 0, -10], [40, 8, 10])],
      ['3005.dat', mesh('3005', 'Brick  1 x  1', [-10, 0, -10], [10, 24, 10])],
      ['3010.dat', mesh('3010', 'Brick  1 x  4', [-40, 0, -10], [40, 24, 10])],
      ['3009.dat', mesh('3009', 'Brick  1 x  6', [-60, 0, -10], [60, 24, 10])],
      ['bed.dat', mesh('bed', 'Tile  4 x  6', [-40, 0, -60], [40, 8, 60])],
      ['b16.dat', mesh('b16', 'Brick  2 x  4 x  2/3', [-40, 0, -20], [40, 16, 20])],
      ['3001.dat', mesh('3001', 'Brick  2 x  4', [-40, 0, -20], [40, 24, 20])],
    ]);
    const floor = brick('floor.dat', 0, 0, 0);
    // A bench: a 1 x 4 tile on two 1 x 1 bricks at its ends (24 LDU over the floor).
    const bench = [brick('2431.dat', 0, -32, 0), brick('3005.dat', -30, -24, 0), brick('3005.dat', 30, -24, 0)];
    const b = brickBuiltFurniture([floor, ...bench], meshes, new Set());
    expect(b.map(s2 => s2.part)).toEqual(['bench', 'bench']);
    expect(b[0]!.surfaceLdu[1]).toBe(-32);
    // A sofa: the same seat on a solid 1 x 4 brick, a 1 x 4 brick backrest rising 24 along its +Z side: it faces -Z.
    const sofa = [brick('2431.dat', 0, -32, 0), brick('3010.dat', 0, -24, 0), brick('3010.dat', 0, -56, 20)];
    const c = brickBuiltFurniture([floor, ...sofa], meshes, new Set());
    expect(c[0]!.part).toBe('chair');
    expect(c[0]!.facingLdu).toEqual([0, -1]);
    // Without the backrest the solid block is not furniture (a step, a low wall).
    expect(brickBuiltFurniture([floor, sofa[0]!, sofa[1]!], meshes, new Set())).toHaveLength(0);
    // A counter: the surface continues into a brick top at its height.
    expect(brickBuiltFurniture([floor, ...bench, brick('3009.dat', 100, -32, 0)], meshes, new Set())).toHaveLength(0);
    // A bed: a 4 x 6 mattress 24 LDU up on 2 x 4 x 2/3 bricks, a 1 x 4 brick headboard rising 24 across one short end.
    const bed = [brick('bed.dat', 0, -24, 0), brick('b16.dat', 0, -16, -40), brick('b16.dat', 0, -16, 40), brick('3010.dat', 0, -48, 70)];
    const d = brickBuiltFurniture([floor, ...bed], meshes, new Set());
    expect(d.map(s2 => s2.part)).toEqual(['bed']);
  });

  it('finds a brick-built stool (a 2 x 2 tile on a narrow column), and not a tile lying on the floor or part of a counter', async () => {
    const { brickBuiltStools, isStoolTop } = await import('../web/src/engine/bedrock-scene-actors.js');
    expect(isStoolTop('Tile  2 x  2 with Studs on Edge')).toBe(true);
    expect(isStoolTop('Tile  2 x  2 Round with Round Underside Stud')).toBe(true);
    expect(isStoolTop('Tile  2 x  4')).toBe(false);
    const meshes = new Map<string, LdrawPartMesh>([
      ['33909.dat', mesh('33909', 'Tile  2 x  2 with Studs on Edge', [-20, 0, -20], [20, 8, 20])],
      ['4032b.dat', mesh('4032b', 'Plate  2 x  2 Round with Axlehole Type 2', [-20, 0, -20], [20, 8, 20])],
      ['3958.dat', mesh('3958', 'Plate  6 x  6', [-60, 0, -60], [60, 8, 60])],
      ['3068b.dat', mesh('3068b', 'Tile  2 x  2 with Groove', [-20, 0, -20], [20, 8, 20])],
      ['3001.dat', mesh('3001', 'Brick  2 x  4', [-40, 0, -20], [40, 24, 20])],
    ]);
    // 76457's dark-red stool: a studs-on-edge tile on a round plate standing on the model's underside, a table beside it.
    const floor = brick('3958.dat', 0, 0, 0);
    const stoolTop = brick('33909.dat', 0, -16, 0), stoolFoot = brick('4032b.dat', 0, -8, 0);
    const table = brick('3001.dat', 0, -32, -60);
    const found = brickBuiltStools([floor, stoolFoot, stoolTop, table], meshes, new Set());
    expect(found).toHaveLength(1);
    expect(found[0]!.surfaceLdu).toEqual([0, -16, 0]);
    // It faces the table (LDraw -Z).
    expect(found[0]!.facingLdu[1]).toBeLessThan(-0.9);
    // A tile lying straight on the floor plate is floor decoration.
    expect(brickBuiltStools([floor, brick('3068b.dat', 0, -8, 0)], meshes, new Set())).toHaveLength(0);
    // A tile flush with a brick beside it is a counter top.
    expect(brickBuiltStools([floor, stoolFoot, stoolTop, brick('3001.dat', 60, -16, 0)], meshes, new Set())).toHaveLength(0);
    // No head room: something two plates over it.
    expect(brickBuiltStools([floor, stoolFoot, stoolTop, brick('3001.dat', 0, -56, 0)], meshes, new Set())).toHaveLength(0);
  });
});

describe('placement writes what the runtime reads', () => {
  it('stamps an interactive actor with its item, the anchor, the turn and the size', async () => {
    const { host } = await import('./_placement-host.js');
    const h = host({ stem: 'ix', label: 'ix', width: 4, height: 4, length: 4, tiles: [], actors: [{ typeId: 'craftmatic:x_door_1', label: 'door', x: 1, y: 0, z: 1, yaw: 0, interactive: 3 }], settleTicks: 1, finalHoldTicks: 1 });
    await h.open({ selection: 1 }, { canceled: true }); // pin the corner at the player's feet (100, 64, 200)
    await h.open({ selection: 5 }, { selection: 0 });
    await h.flush(2000);
    const door = h.spawned.find(s => s.typeId === 'craftmatic:x_door_1')!;
    expect(door.entity.getDynamicProperty('craftmatic:ix')).toBe(3);
    expect(door.entity.getDynamicProperty('craftmatic:ix_anchor')).toEqual({ x: 100, y: 64, z: 200 });
    expect(door.entity.getDynamicProperty('craftmatic:ix_rotation')).toBe(0);
    expect(door.entity.getDynamicProperty('craftmatic:ix_scale')).toBe(1);
  });
});
