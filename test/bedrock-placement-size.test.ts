/**
 * The wand's in-game size, aim-follow preview and fine turning
 * (bedrock-placement-pack.ts), driven through the serialized runtime exactly as
 * bedrock-placement-runtime.test.ts drives the planner.
 */
import { describe, expect, it } from 'vitest';
import {
  SIZE_STEPS, buildPlacementPackAssets, colliderPairIndex, colliderPairOf, decodeColliderRuns, encodeColliderRuns, withSizeGroups,
} from '../web/src/engine/bedrock-placement-pack.js';
import { BlockGrid } from '@craft/schem/types.js';
import { host } from './_placement-host.js';

describe('withSizeGroups', () => {
  it('clamps a scaled camera radius to the range Bedrock accepts', () => {
    // Measured on a device (Bedrock 1.26.51.1): The Milano 76286 has a base
    // radius of 30, so its 300 %/400 % groups asked for 90 and 120, and the
    // world load logged two [error] lines and rejected the entity. Any base
    // above 21.3 overflows the [1, 64] range at 300 %.
    const base = { format_version: '1.26.30', 'minecraft:entity': {
      description: { identifier: 'craftmatic:plane' }, components: {} } };
    const rideable = { seat_count: 1, family_types: ['player'],
      seats: { position: [0, 1, 0], third_person_camera_radius: 30 } };
    const out = withSizeGroups(base, { width: 4, height: 2 }, rideable) as {
      'minecraft:entity': { component_groups: Record<string, Record<string, unknown>> } };
    const groups = out['minecraft:entity'].component_groups;
    const radiusOf = (pct: number): number => {
      const r = groups[`craftmatic:size_${pct}`]!['minecraft:rideable'] as
        { seats: { third_person_camera_radius: number } };
      return r.seats.third_person_camera_radius;
    };
    for (const pct of SIZE_STEPS.filter(p => p !== 100)) {
      expect(radiusOf(pct)).toBeGreaterThanOrEqual(1);
      expect(radiusOf(pct)).toBeLessThanOrEqual(64);
    }
    expect(radiusOf(300)).toBe(64);   // 90 clamped
    expect(radiusOf(400)).toBe(64);   // 120 clamped
    expect(radiusOf(50)).toBe(15);    // untouched below the ceiling
  });

  it('adds one group per step with scale, collision box and scaled seats, keeping existing groups', () => {
    const base = { format_version: '1.26.30', 'minecraft:entity': { description: { identifier: 'craftmatic:x' },
      component_groups: { 'craftmatic:descending': { 'minecraft:vertical_movement_action': { vertical_velocity: -.5 } } },
      events: { 'craftmatic:descend_on': { add: { component_groups: ['craftmatic:descending'] } } },
      components: { 'minecraft:collision_box': { width: 2, height: 1.5 } } } };
    const rideable = { seat_count: 2, seats: [{ position: [0.5, 1, -2], third_person_camera_radius: 8 }, { position: [-0.5, 1, -2] }] };
    const out = withSizeGroups(base, { width: 2, height: 1.5 }, rideable) as any;
    const e = out['minecraft:entity'];
    expect(e.component_groups['craftmatic:descending']).toBeDefined();
    expect(e.events['craftmatic:descend_on']).toBeDefined();
    expect(e.component_groups['craftmatic:size_50']).toEqual({
      'minecraft:scale': { value: 0.5 }, 'minecraft:collision_box': { width: 1, height: 0.75 },
      'minecraft:rideable': { seat_count: 2, seats: [{ position: [0.25, 0.5, -1], third_person_camera_radius: 4 }, { position: [-0.25, 0.5, -1] }] },
    });
    expect(e.component_groups['craftmatic:size_100']).toBeUndefined();
    expect(e.events['craftmatic:size_200']).toEqual({
      remove: { component_groups: SIZE_STEPS.filter(p => p !== 100 && p !== 200).map(p => `craftmatic:size_${p}`) },
      add: { component_groups: ['craftmatic:size_200'] },
    });
    expect(e.events['craftmatic:size_100']).toEqual({ remove: { component_groups: SIZE_STEPS.filter(p => p !== 100).map(p => `craftmatic:size_${p}`) } });
    // A single-seat rideable (an object, not an array) scales too.
    const single = withSizeGroups(base, { width: 1, height: 1 }, { seats: { position: [0, -0.3, 0] } }) as any;
    expect(single['minecraft:entity'].component_groups['craftmatic:size_400']['minecraft:rideable']).toEqual({ seats: { position: [0, -1.2, 0] } });
  });
});

describe('collider runs', () => {
  it('pair index round-trips every lo < hi', () => {
    const seen = new Set<number>();
    for (let lo = 0; lo < 16; lo++) for (let hi = lo + 1; hi <= 16; hi++) {
      const i = colliderPairIndex(lo, hi);
      expect(seen.has(i)).toBe(false); seen.add(i);
      expect(colliderPairOf(i)).toEqual([lo, hi]);
    }
    expect(seen.size).toBe(136);
    expect(Math.min(...seen)).toBe(1);
    expect(Math.max(...seen)).toBe(136);
  });

  it('encodes a grid as runs that decode to the same cells, doors counted as kept', () => {
    const g = new BlockGrid(3, 2, 2);
    g.set(0, 0, 0, 'craftmatic:collider[lo=0,hi=16]');
    g.set(0, 1, 0, 'craftmatic:collider[lo=0,hi=3]');
    g.set(1, 0, 1, 'minecraft:wooden_door[direction=1]');
    g.set(2, 1, 1, 'craftmatic:collider[lo=15,hi=16]');
    const r = encodeColliderRuns(g, 'craftmatic:collider');
    expect(r.colliders).toBe(3);
    expect(r.keptCells).toBe(1);
    const cells = decodeColliderRuns(r.runs);
    expect(cells.length).toBe(12);
    const at = (x: number, y: number, z: number) => cells[(x * 2 + y) * 2 + z]!;
    expect(colliderPairOf(at(0, 0, 0))).toEqual([0, 16]);
    expect(colliderPairOf(at(0, 1, 0))).toEqual([0, 3]);
    expect(at(1, 0, 1)).toBe(0);
    expect(colliderPairOf(at(2, 1, 1))).toEqual([15, 16]);
    // A run longer than 200 cells splits without loss.
    const big = new BlockGrid(30, 10, 10);
    for (let x = 0; x < 30; x++) for (let y = 0; y < 10; y++) for (let z = 0; z < 10; z++) big.set(x, y, z, 'craftmatic:collider[lo=0,hi=16]');
    const rb = encodeColliderRuns(big, 'craftmatic:collider');
    expect(decodeColliderRuns(rb.runs).length).toBe(3000);
    expect(rb.runs.length).toBe(2 * 15);
  });
});

describe('wand runtime: size, aim and turning', () => {
  const tile = { identifier: 'craftmatic:t0', dx: 0, dy: 0, dz: 0, width: 4, height: 2, length: 2, nonAir: 4 };

  it('cycles the size, scales actor positions about the pin, fires the size event and re-lays colliders at 200 %', async () => {
    // A 4×2×2 collider grid: a floor plate (lo 0, hi 4) under a full block.
    const g = new BlockGrid(4, 2, 2);
    for (let x = 0; x < 4; x++) for (let z = 0; z < 2; z++) { g.set(x, 0, z, 'craftmatic:collider[lo=0,hi=4]'); g.set(x, 1, z, 'craftmatic:collider[lo=0,hi=16]'); }
    const runs = encodeColliderRuns(g, 'craftmatic:collider');
    const h = host({ stem: 'sized', label: 'Sized', width: 4, height: 2, length: 2, tiles: [tile],
      actors: [{ typeId: 'craftmatic:fig', label: 'Figure', x: 1, y: 2, z: 1, yaw: 45 }],
      colliders: { width: 4, height: 2, length: 2, block: 'craftmatic:collider', loState: 'craftmatic:lo', hiState: 'craftmatic:hi', runs: runs.runs, keptCells: 0 },
      settleTicks: 1, finalHoldTicks: 1 });
    expect(h.assets.script).toContain('"sizes":[25,50,75,100,150,200,300,400]');
    expect(h.assets.script).toContain('import { world, system, StructureSaveMode, BlockPermutation, BlockVolume }');
    // Pin the corner at the feet, then cycle Size → 150 → 200.
    await h.open({ selection: 1 }, { canceled: true });
    await h.open({ selection: 10 }, { canceled: true });
    await h.open({ selection: 10 }, { canceled: true });
    expect(h.buttons.at(-1)!.some(l => l.startsWith('Size 200% → 300%'))).toBe(true);
    // Place at 200 %: no structure command; colliders re-laid over the 8×4×4 footprint.
    await h.open({ selection: 5 }, { selection: 0 });
    await h.flush(2000);
    expect(h.commands.filter(c => c.startsWith('structure load'))).toHaveLength(0);
    expect(h.player.sendMessage).toHaveBeenCalledWith(expect.stringContaining('Placed Sized.'));
    // The floor plate (0..4/16 of a cell) at 2× covers half of the bottom world row: lo 0, hi 8.
    const plate = h.set.filter(s => s.pos.y === 64);
    expect(plate.length).toBe(8 * 4);
    expect(plate.every(s => s.states['craftmatic:lo'] === 0 && s.states['craftmatic:hi'] === 8)).toBe(true);
    // The full block above spans two world rows, both full.
    expect(h.set.filter(s => s.pos.y === 66 && s.states['craftmatic:hi'] === 16)).toHaveLength(32);
    expect(h.set.filter(s => s.pos.y === 67 && s.states['craftmatic:hi'] === 16)).toHaveLength(32);
    expect(h.set.some(s => s.pos.y === 65)).toBe(false);
    // The figure stands at twice its model offset from the pin, with the size event fired.
    const fig = h.spawned.find(s => s.typeId === 'craftmatic:fig')!;
    expect(fig.at).toEqual({ x: 102, y: 68, z: 202 });
    expect(fig.entity.events).toEqual(['craftmatic:size_200']);
    expect(fig.entity.setRotation).toHaveBeenCalledWith({ x: 0, y: 45 });
  });

  it('shows the exact leaf at 100%, swaps to a measured door at 300%, then restores the leaf at 100%', async () => {
    const g = new BlockGrid(4, 3, 2);
    for (let x = 0; x < 4; x++) for (let z = 0; z < 2; z++) for (let y = 0; y < 3; y++) g.set(x, y, z, 'craftmatic:collider[lo=0,hi=16]');
    const runs = encodeColliderRuns(g, 'craftmatic:collider');
    const h = host({ stem: 'runtime-door', label: 'Runtime door', width: 4, height: 3, length: 2, tiles: [tile],
      actors: [{ typeId: 'craftmatic:runtime_door_leaf_1', label: 'Runtime door leaf', x: 1, y: 2, z: 1, maxSizeExclusive: 300, doorCandidateIndex: 0, hideAt100: false }],
      colliders: { width: 4, height: 3, length: 2, block: 'craftmatic:collider', loState: 'craftmatic:lo', hiState: 'craftmatic:hi', runs: runs.runs, keptCells: 0 },
      runtimeDoorCandidates: [{ x: 1, y: 1.8, z: 1, requiredSize: 300, lower: { id: 'minecraft:wooden_door', states: { direction: 0, upper_block_bit: false } }, upper: { id: 'minecraft:wooden_door', states: { direction: 0, upper_block_bit: true } } }], settleTicks: 1, finalHoldTicks: 1 });
    await h.open({ selection: 1 }, { canceled: true });
    expect(h.buttons.at(-1)).toContain('Use next door size 300%');
    await h.open({ selection: 5 }, { selection: 0 });
    await h.flush(2000);
    const baseLeaf = h.spawned.find(s => s.typeId === 'craftmatic:runtime_door_leaf_1')!;
    expect(baseLeaf.at).toEqual({ x: 101, y: 66, z: 201 });
    expect(h.set.filter(s => s.states?.upper_block_bit !== undefined)).toHaveLength(0);
    await h.open({ selection: 3 }, { canceled: true }); // 90°: direction must turn with the model.
    for (let i = 0; i < 3; i++) await h.open({ selection: 10 }, { canceled: true }); // 100 → 300
    await h.open({ selection: 11 });
    h.blocks.set('103,63,203', { typeId: 'minecraft:stone', isAir: false, permutation: { getState: () => undefined }, setPermutation() {} });
    await h.open({ selection: 5 }, { selection: 0 });
    await h.flush(2000);
    expect(h.spawned.filter(s => s.typeId === 'craftmatic:runtime_door_leaf_1')).toHaveLength(1);
    expect(baseLeaf.entity.remove).toHaveBeenCalledOnce();
    expect(h.set.filter(s => s.states?.upper_block_bit === false)).toHaveLength(1);
    expect(h.set.filter(s => s.states?.upper_block_bit === true)).toHaveLength(1);
    expect(h.set.find(s => s.states?.upper_block_bit === false)?.states.direction).toBe(1);
    expect(h.set.find(s => s.states?.upper_block_bit === false)?.pos.y).toBe(69); // 64 + floor(1.8 × 3), never 64 + floor(1.8) × 3.
    // cycle 300 → 400 → 25 → 50 → 75 → 100 and place once more; the
    // original-size candidate must still be hung exactly once, not duplicated.
    for (let i = 0; i < 5; i++) await h.open({ selection: 10 }, { canceled: true });
    expect(h.buttons.at(-1)!.some(l => l.startsWith('Size 100%'))).toBe(true);
    await h.open({ selection: 5 }, { selection: 0 });
    await h.flush(2000);
    // At 100% this genuinely short source leaf is again below the two-block
    // clearance, so it does not leave a second, stale vanilla door behind.
    expect(h.set.filter(s => s.states?.upper_block_bit === false)).toHaveLength(1);
    const restoredLeaf = h.spawned.filter(s => s.typeId === 'craftmatic:runtime_door_leaf_1').at(-1)!;
    expect(restoredLeaf).not.toBe(baseLeaf);
    expect(restoredLeaf.at).toEqual({ x: 101, y: 66, z: 201 });
    expect(restoredLeaf.entity.events).toEqual([]);
  });

  it('chooses the smallest pending door threshold and refuses an unsupported resized opening', async () => {
    const g = new BlockGrid(3, 3, 3);
    for (let x = 0; x < 3; x++) for (let z = 0; z < 3; z++) for (let y = 0; y < 3; y++) g.set(x, y, z, 'craftmatic:collider[lo=0,hi=16]');
    const runs = encodeColliderRuns(g, 'craftmatic:collider');
    const door = (requiredSize: number) => ({ x: 1, y: 0, z: 1, requiredSize, lower: { id: 'minecraft:wooden_door', states: { direction: 0, upper_block_bit: false } }, upper: { id: 'minecraft:wooden_door', states: { direction: 0, upper_block_bit: true } } });
    const h = host({ stem: 'door-order', label: 'Door order', width: 3, height: 3, length: 3, tiles: [tile],
      actors: [{ typeId: 'craftmatic:door_order_leaf', label: 'Fallback leaf', x: 1, y: 2, z: 1, maxSizeExclusive: 150, doorCandidateIndex: 1, hideAt100: false }],
      colliders: { width: 3, height: 3, length: 3, block: 'craftmatic:collider', loState: 'craftmatic:lo', hiState: 'craftmatic:hi', runs: runs.runs, keptCells: 0 },
      runtimeDoorCandidates: [door(300), door(150)], settleTicks: 1, finalHoldTicks: 1 });
    await h.open({ selection: 1 }, { canceled: true });
    expect(h.buttons.at(-1)).toContain('Use next door size 150%');
    await h.open({ selection: 11 });
    await h.open({ selection: 5 }, { selection: 0 });
    await h.flush(1000);
    expect(h.set.some(s => s.states?.upper_block_bit !== undefined)).toBe(false);
    expect(h.player.sendMessage).toHaveBeenCalledWith(expect.stringContaining('no solid support exists below the resized opening'));
    const fallback = h.spawned.find(s => s.typeId === 'craftmatic:door_order_leaf')!;
    expect(fallback.entity.events).toEqual(['craftmatic:size_150']);
  });

  it('persists one explicit marked chair anchor, follows a 400% quarter turn, and removes it through the management action', async () => {
    const chairGrid = new BlockGrid(4, 3, 2), chairRuns = encodeColliderRuns(chairGrid, 'craftmatic:collider');
    const h = host({ stem: 'marked-chair', label: 'Marked chair', width: 4, height: 3, length: 2, tiles: [tile],
      colliders: { width: 4, height: 3, length: 2, block: 'craftmatic:collider', loState: 'craftmatic:lo', hiState: 'craftmatic:hi', runs: chairRuns.runs, keptCells: 0 },
      manualSeatTypeId: 'craftmatic:marked_chair_manual_seat', settleTicks: 1, finalHoldTicks: 1 });
    await h.open({ selection: 1 }, { canceled: true });
    h.player.location = { x: 101, y: 65, z: 201 };
    await h.open({ selection: 11 });
    expect([...h.playerProperties.values()].join('')).toContain('anchors');
    await h.open({ selection: 3 }, { canceled: true }); // 90°
    for (let i = 0; i < 4; i++) await h.open({ selection: 10 }, { canceled: true }); // 100 → 400
    await h.open({ selection: 5 }, { selection: 0 });
    await h.flush(1000);
    const seat = h.spawned.find(s => s.typeId === 'craftmatic:marked_chair_manual_seat')!;
    expect(seat.at).toEqual({ x: 104, y: 68, z: 204 });
    expect(seat.entity.events).toEqual(['craftmatic:size_400']);
    // The same model-local anchor is rejected, then Manage removes both the
    // persisted anchor and its live entity rather than leaving a stale seat.
    h.player.location = { x: 104, y: 68, z: 204 };
    await h.open({ selection: 11 });
    expect(h.player.sendMessage).toHaveBeenCalledWith(expect.stringContaining('already marked'));
    await h.open({ selection: 12 }, { selection: 0 }, { canceled: true });
    expect([...h.playerProperties.values()].join('')).not.toContain('"x"');
  });

  it('lifts a figure spawned inside a full collider cell to the first clear cell, and says so when the aim finds no block', async () => {
    const g = new BlockGrid(2, 3, 2);
    for (let x = 0; x < 2; x++) for (let z = 0; z < 2; z++) { g.set(x, 0, z, 'craftmatic:collider[lo=0,hi=16]'); g.set(x, 1, z, 'craftmatic:collider[lo=0,hi=16]'); }
    const runs = encodeColliderRuns(g, 'craftmatic:collider');
    const h = host({ stem: 'lifted', label: 'Lifted', width: 2, height: 3, length: 2, tiles: [{ ...tile, width: 2, height: 3, length: 2 }],
      actors: [{ typeId: 'craftmatic:lifted_fig1', label: 'Figure', x: 0.5, y: 0, z: 0.5 }],
      colliders: { width: 2, height: 3, length: 2, block: 'craftmatic:collider', loState: 'craftmatic:lo', hiState: 'craftmatic:hi', runs: runs.runs, keptCells: 0 },
      settleTicks: 1, finalHoldTicks: 1 });
    // The world has a FLOOR plate collider (0..3/16) at the pin's y - not a wall - and a full
    // wall collider at y+1 and y+2 where the figure's head would be; y+3/y+4 are clear.
    const collider = (lo: number, hi: number) => ({ typeId: 'craftmatic:collider', permutation: { getState: (k: string) => (k === 'craftmatic:hi' ? hi : lo) }, setPermutation() {} });
    h.blocks.set('100,64,200', collider(0, 3));
    h.blocks.set('100,65,200', collider(0, 16));
    h.blocks.set('100,66,200', collider(0, 16));
    await h.open({ selection: 1 }, { canceled: true });
    await h.open({ selection: 5 }, { selection: 0 });
    await h.flush(600);
    const fig = h.spawned.find(s => s.typeId === 'craftmatic:lifted_fig1')!;
    expect(fig.at.y).toBe(67);
    // Aim with nothing in view: the action bar says why instead of silently doing nothing.
    h.setHit(undefined);
    await h.open({ selection: 9 });
    h.intervals.get(4)!();
    expect(h.actionBars.at(-1)).toMatch(/look at a block/);
  });

  it('refuses a resized placement of coloured blocks and says why', async () => {
    const h = host({ stem: 'blocks', label: 'Blocks', width: 4, height: 2, length: 2, tiles: [tile], actors: [] });
    await h.open({ selection: 1 }, { canceled: true });
    await h.open({ selection: 10 }, { canceled: true });
    expect(h.buttons.at(-1)!.some(l => l.includes('(entities only)'))).toBe(true);
    await h.open({ selection: 5 }, { canceled: true });
    expect(h.player.sendMessage).toHaveBeenCalledWith(expect.stringContaining('cannot be resized in game'));
    expect(h.commands).toHaveLength(0);
  });

  it('follows the aimed block until pinned, and the ghost takes the size', async () => {
    const h = host({ stem: 'aimed', label: 'Aimed', width: 4, height: 2, length: 2, tiles: [tile], actors: [], preview: { typeId: 'craftmatic:aimed_preview' } });
    h.setHit({ block: { location: { x: 10, y: 70, z: 20 } }, face: 'Up' });
    await h.open({ selection: 9 });
    expect(h.player.sendMessage).toHaveBeenCalledWith(expect.stringContaining('follows the block you look at'));
    const aim = h.intervals.get(4)!, draw = h.intervals.get(12)!;
    aim(); draw();
    // Footprint centre (2, 1) lands on the top face of the hit block: anchor = floor(10.5−2, 71, 20.5−1) = (8, 71, 19), centre (10, 71, 20).
    const ghost = h.spawned.find(s => s.typeId === 'craftmatic:aimed_preview')!;
    expect(ghost.entity.teleport).toHaveBeenLastCalledWith({ x: 10, y: 71, z: 20 }, { rotation: { x: 0, y: 0 } });
    expect(h.actionBars.some(s => s.startsWith('AIMING'))).toBe(true);
    // Look elsewhere: it follows; hit the east face: it lands beside the block.
    h.setHit({ block: { location: { x: 30, y: 70, z: 20 } }, face: 'East' });
    aim();
    expect(ghost.entity.teleport).toHaveBeenLastCalledWith({ x: 31, y: 70, z: 20 }, { rotation: { x: 0, y: 0 } });
    // Size → 150 % (the first step after 100): the ghost gets the event and the centre offset grows with it.
    await h.open({ selection: 10 }, { canceled: true });
    aim(); draw();
    expect(ghost.entity.events).toEqual(['craftmatic:size_150']);
    // Pin centred on me stops following.
    h.player.location = { x: 0, y: 64, z: 0 };
    await h.open({ selection: 0 }, { canceled: true });
    h.setHit({ block: { location: { x: 90, y: 70, z: 90 } }, face: 'Up' });
    aim(); draw();
    // At 150 % the centre offset is (3, 1.5): anchor floor(−3, 64, −1.5) = (−3, 64, −2), centre (0, 64, −0.5).
    expect(ghost.entity.teleport).toHaveBeenLastCalledWith({ x: 0, y: 64, z: -0.5 }, { rotation: { x: 0, y: 0 } });
    expect(h.actionBars.at(-1)).toMatch(/^PINNED PREVIEW/);
    expect(h.actionBars.at(-1)).toContain('150%');
  });

  it('an entity-only pack turns in 15° steps both ways and places the actor on the turned footprint', async () => {
    const h = host({ stem: 'turned', label: 'Turned', width: 4, height: 2, length: 2, tiles: [],
      actors: [{ typeId: 'craftmatic:car', label: 'Car', x: 4, y: 0, z: 1, yaw: 0 }], settleTicks: 1, finalHoldTicks: 1 });
    await h.open({ selection: 1 }, { canceled: true });
    await h.open({ selection: 3 }, { canceled: true });   // 0 → 15
    expect(h.buttons.at(-1)!.some(l => l.startsWith('Rotate → 30°'))).toBe(true);
    expect(h.buttons.at(-1)!.some(l => l.startsWith('Turn back ← 0°'))).toBe(true);
    await h.open({ selection: 11 }, { canceled: true });  // 15 → 0
    expect(h.buttons.at(-1)!.some(l => l.startsWith('Rotate → 15°'))).toBe(true);
    await h.open({ selection: 11 }, { canceled: true });  // 0 → 345
    expect(h.buttons.at(-1)!.some(l => l.startsWith('Rotate → 0°'))).toBe(true);
    await h.open({ selection: 3 }, { canceled: true });   // 345 → 0
    await h.open({ selection: 3 }, { canceled: true });   // 0 → 15
    await h.open({ selection: 5 }, { selection: 0 });
    await h.flush(2000);
    const car = h.spawned.find(s => s.typeId === 'craftmatic:car')!;
    expect(car.entity.setRotation).toHaveBeenCalledWith({ x: 0, y: 15 });
    // The point (4, 1) on a 4×2 footprint turned 15° about its centre (2, 1): x = W'/2 + 2cos15, z = L'/2 + 2sin15.
    const a = 15 * Math.PI / 180, w = Math.ceil(4 * Math.cos(a) + 2 * Math.sin(a)), l = Math.ceil(4 * Math.sin(a) + 2 * Math.cos(a));
    expect(car.at.x).toBeCloseTo(100 + w / 2 + 2 * Math.cos(a), 5);
    expect(car.at.z).toBeCloseTo(200 + l / 2 + 2 * Math.sin(a), 5);
  });
});
