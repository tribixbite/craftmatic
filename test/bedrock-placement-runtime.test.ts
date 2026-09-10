import { expect, it, vi } from 'vitest';
import { buildPlacementPackAssets } from '../web/src/engine/bedrock-placement-pack.js';

it('executes the exported wand through pin, rotate, preview, confirmed placement and undo', async () => {
  const assets = buildPlacementPackAssets({ stem: 'runtime', label: 'Runtime', width: 40, height: 100, length: 20,
    tiles: [0, 18].map((dx, i) => ({ identifier: `craftmatic:t${i}`, dx, dy: 0, dz: 0, width: 18, height: 2, length: 2, nonAir: 1 })),
    actors: [{ typeId: 'craftmatic:car', label: 'Car', x: .5, y: 1, z: 1.5 }], previewPoints: [{ x: .5, y: .5, z: 1.5 }] });
  const responses: any[] = [];
  let showCalls = 0;
  class Form {
    title() { return this; } body() { return this; } button() { return this; }
    textField(_label: string, _placeholder: string, options: any) { expect(typeof options).toBe('object'); return this; }
    async show() { showCalls++; return responses.shift() ?? { canceled: true }; }
  }
  let use: any, selectedItem: any, loaded = false, loadCalls = 0, blockedLoadCall = 0, blockEveryLoad = false;
  const intervals = new Map<number, any>();
  const commands: string[] = [], areaCommands: string[] = [], blockProbes: any[] = [], particles: any[] = [], snapshots: any[] = [], restores: any[] = [];
  const entity = { id: 'entity-1', nameTag: '', setRotation: vi.fn(), remove: vi.fn() };
  const dimension = { id: 'overworld', heightRange: { min: -64, max: 320 },
    spawnParticle: (_id: string, point: any) => particles.push(point),
    runCommand: (command: string) => {
      if (command.startsWith('tickingarea remove ')) { areaCommands.push(command); loaded = false; return { successCount: 1 }; }
      if (command.startsWith('tickingarea add ')) { areaCommands.push(command); loaded = true; loadCalls++; return { successCount: 1 }; }
      expect(loaded).toBe(true); commands.push(command); return { successCount: 1 };
    },
    getBlock: (point: any) => { blockProbes.push(point); return loaded && !blockEveryLoad && loadCalls !== blockedLoadCall ? { typeId: 'minecraft:air' } : undefined; },
    spawnEntity: vi.fn(() => { expect(loaded).toBe(true); return entity; }) };
  const player: any = { id: 'player', location: { x: 10, y: 20, z: 30 }, dimension, selectedSlotIndex: 0,
    getComponent: (id: string) => id === 'minecraft:inventory' ? { container: { getItem: () => selectedItem } } : undefined,
    sendMessage: vi.fn(), onScreenDisplay: { setActionBar: vi.fn() } };
  const world = { afterEvents: { itemUse: { subscribe: (fn: any) => { use = fn; } } },
    getAllPlayers: () => [player], getDimension: () => dimension, getEntity: () => entity,
    structureManager: {
      createFromWorld: (...args: any[]) => { expect(loaded).toBe(true); snapshots.push(args); },
      get: (name: string) => { const s = snapshots.find(args => args[0] === name); return s && { size: { x: s[3].x-s[2].x+1, y: s[3].y-s[2].y+1, z: s[3].z-s[2].z+1 } }; },
      place: (...args: any[]) => { expect(loaded).toBe(true); restores.push(args); }, delete: vi.fn(),
    } };
  const system = { run: (fn: any) => fn(), runTimeout: (fn: any) => queueMicrotask(fn), runInterval: (fn: any, ticks: number) => { intervals.set(ticks, fn); } };
  const source = assets.script.replace(/^import .*;\s*$/gm, '');
  new Function('world', 'system', 'StructureSaveMode', 'ActionFormData', 'ModalFormData', source)(world, system, { Memory: 'memory' }, Form, Form);
  const flush = async (turns = 60) => { for (let i = 0; i < turns; i++) await Promise.resolve(); };
  const pollHeldItem = intervals.get(5), drawPreview = intervals.get(12);

  // Selecting the exact wand opens once; staying on it does not reopen, while
  // switching away and back creates a fresh activation transition.
  selectedItem = { typeId: assets.itemId }; responses.push({ canceled: true });
  pollHeldItem(); await flush();
  expect(showCalls).toBe(1);
  pollHeldItem(); await flush();
  expect(showCalls).toBe(1);
  selectedItem = undefined; pollHeldItem();
  selectedItem = { typeId: assets.itemId }; responses.push({ canceled: true });
  pollHeldItem(); await flush();
  expect(showCalls).toBe(2);
  selectedItem = undefined; pollHeldItem();

  // The wrong item must not open or mutate this pack's planner.
  use({ itemStack: { typeId: 'minecraft:stick' }, source: player });
  responses.push({ selection: 0 }, { selection: 2 }, { canceled: true });
  use({ itemStack: { typeId: assets.itemId }, source: player }); await flush();
  expect(commands).toHaveLength(0);
  drawPreview();
  // The rotated point cloud is scaled to an eight-block miniature ten blocks
  // ahead (fallback +Z view), while the full-size outline remains at the pin.
  expect(particles.some(q => Math.abs(q.x - 10.68) < 1e-6 && Math.abs(q.y - 20.54) < 1e-6 && Math.abs(q.z - 38.44) < 1e-6)).toBe(true);
  expect(particles.some(q => Math.abs(q.x - 10.8) < 1e-6 && q.y === 29 && q.z === 40)).toBe(true);
  expect(particles.some(q => Math.abs(q.x - 11.8) < 1e-6 && q.y === 29 && q.z === 40)).toBe(true);
  expect(particles).toContainEqual({ x: 10, y: 20, z: 30 });
  expect(particles).toContainEqual({ x: 30, y: 120, z: 70 });
  expect(particles.length).toBeLessThanOrEqual(360);
  responses.push({ selection: 4 }, { selection: 0 });
  use({ itemStack: { typeId: assets.itemId }, source: player }); await flush();
  expect(commands).toEqual(['structure load craftmatic:t0 28 20 30 90_degrees none', 'structure load craftmatic:t1 28 20 48 90_degrees none']);
  expect(areaCommands.some(command => command.includes('tickingarea add 28 20 30 29 20 47'))).toBe(true);
  expect(blockProbes.some(point => point.z === 30)).toBe(true);
  expect(blockProbes.some(point => point.z === 40)).toBe(true);
  expect(snapshots).toHaveLength(2);
  expect(dimension.spawnEntity).toHaveBeenCalledWith('craftmatic:car', { x: 28.5, y: 21, z: 30.5 });
  expect(entity.setRotation).toHaveBeenCalledWith({ x: 0, y: 90 });
  expect(loaded).toBe(false);

  // Cancel before the next placement mutates anything: the previous complete
  // placement must remain the one available to Undo.
  blockedLoadCall = loadCalls + 1;
  responses.push({ selection: 4 }, { selection: 0 });
  use({ itemStack: { typeId: assets.itemId }, source: player }); await flush();
  responses.push({ selection: 0 });
  use({ itemStack: { typeId: assets.itemId }, source: player }); await flush();
  expect(player.sendMessage).toHaveBeenCalledWith(expect.stringContaining('Placement stopped: Canceled.'));
  blockedLoadCall = 0;
  responses.push({ selection: 5 });
  use({ itemStack: { typeId: assets.itemId }, source: player }); await flush();
  expect(restores.map(args => args[2])).toEqual([{ x: 28, y: 20, z: 30 }, { x: 28, y: 20, z: 48 }]);
  expect(entity.remove).toHaveBeenCalledOnce();
  expect(loaded).toBe(false);

  // A pinned origin cannot silently move to the same coordinates in another dimension.
  const nether = { ...dimension, id: 'nether' };
  player.dimension = nether;
  responses.push({ selection: 4 }, { canceled: true });
  use({ itemStack: { typeId: assets.itemId }, source: player }); await flush();
  expect(commands).toHaveLength(2);
  expect(player.sendMessage).toHaveBeenCalledWith(expect.stringContaining('Origin is pinned in overworld'));
  player.dimension = dimension;

  // Cancel while the actor's awaited chunk load is pending: no actor may spawn afterward.
  blockedLoadCall = loadCalls + 3;
  responses.push({ selection: 4 }, { selection: 0 });
  use({ itemStack: { typeId: assets.itemId }, source: player }); await flush();
  responses.push({ selection: 0 });
  use({ itemStack: { typeId: assets.itemId }, source: player }); await flush();
  expect(dimension.spawnEntity).toHaveBeenCalledOnce();
  expect(player.sendMessage).toHaveBeenCalledWith(expect.stringContaining('Placement stopped: Canceled.'));

  // A permanently unloaded first tile stops after the bounded 600-tick poll
  // and preserves the partial placement history produced just before it.
  blockedLoadCall = 0;
  blockEveryLoad = true;
  responses.push({ selection: 4 }, { selection: 0 });
  use({ itemStack: { typeId: assets.itemId }, source: player }); await flush(800);
  expect(dimension.spawnEntity).toHaveBeenCalledOnce();
  expect(loaded).toBe(false);
  expect(player.sendMessage).toHaveBeenCalledWith(expect.stringContaining('Timed out waiting for the build area to load.'));
  blockEveryLoad = false;
  responses.push({ selection: 5 });
  use({ itemStack: { typeId: assets.itemId }, source: player }); await flush();
  expect(restores).toHaveLength(4);
  expect(player.sendMessage).toHaveBeenCalledWith(expect.stringContaining('Undo complete.'));
  expect(player.sendMessage).not.toHaveBeenCalledWith(expect.stringContaining('Nothing to undo'));
});
