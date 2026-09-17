/**
 * The wand's in-game size, aim-follow preview and fine turning
 * (bedrock-placement-pack.ts), driven through the serialized runtime exactly as
 * bedrock-placement-runtime.test.ts drives the planner.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  SIZE_STEPS, buildPlacementPackAssets, colliderPairIndex, colliderPairOf, decodeColliderRuns, encodeColliderRuns, withSizeGroups,
} from '../web/src/engine/bedrock-placement-pack.js';
import { BlockGrid } from '@craft/schem/types.js';

describe('withSizeGroups', () => {
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

/** Minimal script host shared by the runtime cases. */
function host(spec: Parameters<typeof buildPlacementPackAssets>[0]) {
  const assets = buildPlacementPackAssets(spec);
  const responses: any[] = [];
  const buttons: string[][] = [];
  class Form {
    labels: string[] = [];
    title() { return this; } body() { return this; } button(l: string) { this.labels.push(l); return this; } textField() { return this; }
    async show() { buttons.push(this.labels); return responses.shift() ?? { canceled: true }; }
  }
  const intervals = new Map<number, any>();
  const spawned: Array<{ typeId: string; at: any; entity: any }> = [];
  const set: Array<{ pos: any; states: any }> = [];
  const commands: string[] = [];
  const actionBars: string[] = [];
  const blocks = new Map<string, any>();
  let loaded = false;
  const makeEntity = (id: string, typeId: string) => ({ id, typeId, nameTag: '', dimension: { id: 'overworld' }, events: [] as string[], teleport: vi.fn(), setRotation: vi.fn(), remove: vi.fn(), triggerEvent(ev: string) { this.events.push(ev); }, getComponent: () => undefined });
  const dimension: any = { id: 'overworld', heightRange: { min: -64, max: 320 }, spawnParticle: vi.fn(),
    runCommand: (command: string) => {
      if (command.startsWith('tickingarea remove ')) { loaded = false; return { successCount: 1 }; }
      if (command.startsWith('tickingarea add ')) { loaded = true; return { successCount: 1 }; }
      commands.push(command); return { successCount: 1 };
    },
    fillBlocks: vi.fn(),
    getBlock: (pos: any) => {
      if (!loaded) return undefined;
      const key = `${pos.x},${pos.y},${pos.z}`;
      if (!blocks.has(key)) blocks.set(key, { typeId: 'minecraft:air', permutation: { getState: () => undefined }, setPermutation(perm: any) { this.typeId = perm.id; this.permutation = { getState: (k: string) => perm.states[k] }; set.push({ pos: { ...pos }, states: perm.states }); } });
      return blocks.get(key);
    },
    getEntities: () => [],
    spawnEntity: (typeId: string, at: any) => { const entity = makeEntity(`e${spawned.length + 1}`, typeId); spawned.push({ typeId, at, entity }); return entity; } };
  let use: any;
  let hit: any;
  const player: any = { id: 'player', location: { x: 100, y: 64, z: 200 }, dimension, selectedSlotIndex: 0,
    getBlockFromViewDirection: () => hit,
    getComponent: () => undefined, sendMessage: vi.fn(), onScreenDisplay: { setActionBar: (s: string) => actionBars.push(s) } };
  const world = { afterEvents: { itemUse: { subscribe: (fn: any) => { use = fn; } }, playerLeave: { subscribe: vi.fn() } },
    getAllPlayers: () => [player], getDimension: () => dimension,
    getEntity: (id: string) => spawned.find(s => s.entity.id === id)?.entity,
    structureManager: { createFromWorld: vi.fn(), get: () => undefined, place: vi.fn(), delete: vi.fn() } };
  const system = { run: (fn: any) => fn(), runTimeout: (fn: any) => queueMicrotask(fn), runInterval: (fn: any, ticks: number) => { intervals.set(ticks, fn); } };
  const BlockPermutation = { resolve: (id: string, states: any) => ({ id, states }) };
  const source = assets.script.replace(/^import .*;\s*$/gm, '');
  new Function('world', 'system', 'StructureSaveMode', 'BlockPermutation', 'ActionFormData', 'ModalFormData', source)(world, system, { Memory: 'memory' }, BlockPermutation, Form, Form);
  const flush = async (turns = 400) => { for (let i = 0; i < turns; i++) await Promise.resolve(); };
  const open = async (...r: any[]) => { responses.push(...r); use({ itemStack: { typeId: assets.itemId }, source: player }); await flush(); };
  return { assets, open, flush, intervals, spawned, set, commands, actionBars, player, buttons, setHit: (h: any) => { hit = h; }, blocks };
}

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
    expect(h.assets.script).toContain('import { world, system, StructureSaveMode, BlockPermutation }');
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
