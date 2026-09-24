/**
 * The moving parts (web/src/engine/bedrock-interactives.ts): detection from
 * the LDraw description and the part's own frame, the hinge rig, the doorway
 * cut into the collider grid, the world blocks a closed leaf lays (against the
 * collider re-lay's own oracle at every size and turn), the pack assets, and
 * the serialised runtime run as the device runs it.
 */
import { describe, expect, it, vi } from 'vitest';
import { BlockGrid } from '../src/schem/types.js';
import {
  DOORWAY_MIN_HEIGHT_LDU, INTERACTIVE_FAMILY, INTERACTIVE_PROPERTY, OPEN_DEG, discoverInteractives, interactiveAnimation, interactiveBehavior, interactiveKindOf,
  interactiveRig, interactiveRuntimeItem, interactivesScript, ixClosedBlocks, ixWorldBlocks, linkSharedDoorways, passSizeFor, planInteractiveColliders,
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
import type { SceneGridFrame } from '../web/src/engine/bedrock-scene-actors.js';

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
      ['Roller Door Normal', null],
    ];
    for (const [d, k] of cases) expect(interactiveKindOf(d), d).toBe(k);
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
    expect(rig.bones.map(b => b.name)).toEqual(['ix_tilt', 'ix_spin', 'ix_untilt']);
    expect(rig.boneOf).toEqual(['ix_untilt', 'ix_untilt', 'ix_untilt']);
    const t = rig.bones[0]!.rotation!, u = rig.bones[2]!.rotation!;
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

/** Runtime items for two leaves of a double door in a 1-thick wall, plus a turnable, as the pack ships them. */
function doubleDoorConfig(passSize = 100): InteractiveRuntimeConfig {
  const g = wallGrid();
  const left = leafAt(2.25, 1.5, 5.5), right = leafAt(3.75, 1.5, 5.5);
  const plans = planInteractiveColliders(g, [left, right], frame);
  const items: InteractiveRuntimeItem[] = [
    { ...interactiveRuntimeItem(left, 'craftmatic:x_door_1', 'Door 1', plans[0]!), passSize },
    { ...interactiveRuntimeItem(right, 'craftmatic:x_door_2', 'Door 2', plans[1]!), angle: -90, passSize },
    interactiveRuntimeItem({ ...left, kind: 'turnable', angleDeg: 90, leaf: undefined, openingLdu: undefined }, 'craftmatic:x_turnable_1', 'Turnable 1', null),
  ];
  linkSharedDoorways(items);
  return { family: INTERACTIVE_FAMILY, property: INTERACTIVE_PROPERTY, label: 'Test', dims: { width: 12, height: 6, length: 10 }, colliders: { block: COLLIDER_BLOCK_ID, loState: COLLIDER_LO_STATE, hiState: COLLIDER_HI_STATE }, items };
}

describe('linkSharedDoorways and ixClosedBlocks', () => {
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
    const behavior = interactiveBehavior('craftmatic:x_door_1', it0) as { 'minecraft:entity': { description: { properties: Record<string, unknown> }; components: Record<string, unknown> } };
    const text = bedrockJsonText(behavior);
    expect(text).toContain('"default":0.0');
    expect(text).not.toContain('minecraft:pushable"');
    const c = behavior['minecraft:entity'].components;
    expect(c['minecraft:type_family']).toEqual({ family: [INTERACTIVE_FAMILY, 'craftmatic_ix_door'] });
    expect(c['minecraft:interact']).toEqual({ interactions: [{ interact_text: 'action.interact.craftmatic_open', swing: true }] });
    expect((c['minecraft:collision_box'] as { width: number }).width).toBeCloseTo(2.25, 3);
  });
  it('eases the spin bone in the client toward the property over the swing time', () => {
    const anim = interactiveAnimation('craftmatic:x_door_1', 225);
    expect(JSON.stringify(anim.file)).toContain('"rotation":[0,"-v.ix_angle",0]');
    expect(anim.initialize).toEqual([`v.ix_angle = q.property('${INTERACTIVE_PROPERTY}');`]);
    expect(anim.preAnimation[0]).toContain('q.delta_time * 225');
  });
});

// ─── The serialised runtime, run as the device runs it ───────────────────────

function runtimeHost(cfg: InteractiveRuntimeConfig) {
  const blocks = new Map<string, { typeId: string; states: Record<string, number> }>();
  const setCollider = (x: number, y: number, z: number, lo: number, hi: number): void => { blocks.set(`${x},${y},${z}`, { typeId: cfg.colliders.block, states: { [cfg.colliders.loState]: lo, [cfg.colliders.hiState]: hi } }); };
  const blockAt = (pos: { x: number; y: number; z: number }) => {
    const key = `${pos.x},${pos.y},${pos.z}`;
    const cur = blocks.get(key) ?? { typeId: 'minecraft:air', states: {} };
    return {
      typeId: cur.typeId, isAir: cur.typeId === 'minecraft:air',
      permutation: { getState: (k: string) => cur.states[k] },
      setPermutation: (perm: { id: string; states: Record<string, number> }) => { if (perm.id === 'minecraft:air') blocks.delete(key); else blocks.set(key, { typeId: perm.id, states: { ...perm.states } }); },
    };
  };
  const entities: any[] = [];
  const players: any[] = [];
  const sounds: string[] = [];
  const dim: any = {
    id: 'minecraft:overworld',
    getBlock: (pos: any) => blockAt(pos),
    getEntities: (q: any) => [...entities, ...players].filter(e => (!q?.families || (e.families ?? []).some((f: string) => q.families.includes(f)))
      && (!q?.location || Math.hypot(e.location.x - q.location.x, e.location.y - q.location.y, e.location.z - q.location.z) <= (q.maxDistance ?? Infinity))),
    playSound: (id: string) => { sounds.push(id); },
  };
  const spawn = (item: number, anchor: { x: number; y: number; z: number }, f = 1, r = 0, at?: { x: number; y: number; z: number }) => {
    const props = new Map<string, unknown>([['craftmatic:ix', item], ['craftmatic:ix_anchor', anchor], ['craftmatic:ix_rotation', r], ['craftmatic:ix_scale', f]]);
    const e = {
      id: `e${entities.length}`, typeId: cfg.items[item]!.type, families: [cfg.family], dimension: dim, location: at ?? { ...anchor },
      angle: undefined as number | undefined,
      getDynamicProperty: (k: string) => props.get(k), setDynamicProperty: (k: string, v: unknown) => { props.set(k, v); },
      setProperty: vi.fn(function (this: any, _k: string, v: number) { e.angle = v; }),
      props,
    };
    entities.push(e);
    return e;
  };
  let tickFn: () => void = () => {};
  let interactFn: (ev: any) => void = () => {};
  let hitFn: (ev: any) => void = () => {};
  const system = { currentTick: 0, runInterval: (cb: () => void) => { tickFn = cb; }, run: (cb: () => void) => cb() };
  const world = {
    getDimension: (name: string) => (name === 'overworld' ? dim : { getEntities: () => [] }),
    afterEvents: { playerInteractWithEntity: { subscribe: (cb: any) => { interactFn = cb; } }, entityHitEntity: { subscribe: (cb: any) => { hitFn = cb; } } },
  };
  const BlockPermutation = { resolve: (id: string, states: Record<string, number> = {}) => ({ id, states }) };
  const load = (): void => {
    const script = interactivesScript(cfg).replace(/^import .*;\n/, '');
    const console = { warn: () => {} };
    new Function('world', 'system', 'BlockPermutation', 'console', script)(world, system, BlockPermutation, console);
  };
  load();
  const player = { typeId: 'minecraft:player', id: 'p1', location: { x: 0, y: 0, z: 0 }, onScreenDisplay: { setActionBar: vi.fn() } };
  return {
    blocks, setCollider, spawn, sounds, player, players, load,
    sync: () => tickFn(),
    tap: (e: any) => { system.currentTick += 10; hitFn({ damagingEntity: player, hitEntity: e }); },
    interact: (e: any) => { system.currentTick += 10; interactFn({ player, target: e }); },
    interactTwice: (e: any) => { system.currentTick += 10; interactFn({ player, target: e }); hitFn({ damagingEntity: player, hitEntity: e }); },
    lastBar: () => player.onScreenDisplay.setActionBar.mock.calls.at(-1)?.[0] as string | undefined,
  };
}

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

  it('counts a tap reported twice (hit and interact in one tick) once', () => {
    const cfg = doubleDoorConfig();
    const h = runtimeHost(cfg);
    const a = h.spawn(0, anchor);
    h.sync();
    h.interactTwice(a);
    expect(a.getDynamicProperty('craftmatic:ix_open')).toBe(true);
  });

  it('will not close on a player standing in the doorway, and never overwrites a block the player built there', () => {
    const cfg = doubleDoorConfig();
    const h = runtimeHost(cfg);
    const a = h.spawn(0, anchor);
    h.sync();
    h.tap(a);
    const [k0] = keysOf(cfg, 0);
    const [x, y, z] = k0!.split(',').map(Number) as [number, number, number];
    h.player.location = { x: x + 0.5, y, z: z + 0.5 };
    h.players.push(h.player);
    h.tap(a);
    expect(a.getDynamicProperty('craftmatic:ix_open')).toBe(true);
    expect(h.lastBar()).toMatch(/standing in the door 1/);
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
    h.tap(a);
    for (const k of closed) expect(h.blocks.has(k), k).toBe(false);
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

describe('furniture seats', () => {
  it('sits on a library chair, bench or stool mould at the top of its own box, not only on the minifig seat', async () => {
    const { isFurnitureSeat, discoverSceneActors } = await import('../web/src/engine/bedrock-scene-actors.js');
    expect(isFurnitureSeat('Fabuland Chair')).toBe(true);
    expect(isFurnitureSeat('Fabuland Bench')).toBe(true);
    expect(isFurnitureSeat('HOLDER FOR CHAIR 20MM (Needs Work)')).toBe(false);
    expect(isFurnitureSeat('Brick  2 x  4')).toBe(false);
    const meshes = new Map([['4222a.dat', mesh('4222a', 'Fabuland Chair', [-20, -40, -20], [20, 0, 20])]]);
    const provider = { getPartMesh: async (p: string) => meshes.get(p) ?? null } as unknown as Parameters<typeof discoverSceneActors>[1];
    const scene = await discoverSceneActors([brick('4222a.dat', 100, 0, 50)], provider);
    expect(scene.seats).toHaveLength(1);
    expect(scene.seats[0]!.surfaceLdu).toEqual([100, -40, 50]);
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
