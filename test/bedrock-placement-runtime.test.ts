import { expect, it, vi } from 'vitest';
import { buildPlacementPackAssets } from '../web/src/engine/bedrock-placement-pack.js';

it('executes the exported wand through pin, rotate, preview, confirmed placement and undo', async () => {
  const assets = buildPlacementPackAssets({ stem: 'runtime', label: 'Runtime', width: 4, height: 2, length: 2,
    tiles: [0, 2].map((dx, i) => ({ identifier: `craftmatic:t${i}`, dx, dy: 0, dz: 0, width: 2, height: 2, length: 2, nonAir: 1 })),
    actors: [{ typeId: 'craftmatic:car', label: 'Car', x: .5, y: 1, z: 1.5 }], previewPoints: [{ x: .5, y: .5, z: 1.5 }] });
  const responses: any[] = [];
  let showCalls = 0;
  class Form {
    title() { return this; } body() { return this; } button() { return this; }
    textField(_label: string, _placeholder: string, options: any) { expect(typeof options).toBe('object'); return this; }
    async show() { showCalls++; return responses.shift() ?? { canceled: true }; }
  }
  let use: any, selectedItem: any, loaded = false, loadCalls = 0, pauseAtLoadCall = 0, resumeLoad: (() => void) | undefined;
  const intervals = new Map<number, any>();
  const commands: string[] = [], particles: any[] = [], snapshots: any[] = [], restores: any[] = [];
  const entity = { id: 'entity-1', nameTag: '', setRotation: vi.fn(), remove: vi.fn() };
  const dimension = { id: 'overworld', heightRange: { min: -64, max: 320 },
    spawnParticle: (_id: string, point: any) => particles.push(point),
    runCommand: (command: string) => { expect(loaded).toBe(true); commands.push(command); return { successCount: 1 }; },
    spawnEntity: vi.fn(() => { expect(loaded).toBe(true); return entity; }) };
  const player: any = { id: 'player', location: { x: 10, y: 20, z: 30 }, dimension, selectedSlotIndex: 0,
    getComponent: (id: string) => id === 'minecraft:inventory' ? { container: { getItem: () => selectedItem } } : undefined,
    sendMessage: vi.fn(), onScreenDisplay: { setActionBar: vi.fn() } };
  const world = { afterEvents: { itemUse: { subscribe: (fn: any) => { use = fn; } } },
    getAllPlayers: () => [player], getDimension: () => dimension, getEntity: () => entity,
    tickingAreaManager: { hasCapacity: () => true, hasTickingArea: () => loaded, removeTickingArea: () => { loaded = false; }, createTickingArea: async () => {
      loaded = true; loadCalls++;
      if (loadCalls === pauseAtLoadCall) await new Promise<void>(resolve => { resumeLoad = resolve; });
    } },
    structureManager: {
      createFromWorld: (...args: any[]) => { expect(loaded).toBe(true); snapshots.push(args); },
      get: (name: string) => { const s = snapshots.find(args => args[0] === name); return s && { size: { x: s[3].x-s[2].x+1, y: s[3].y-s[2].y+1, z: s[3].z-s[2].z+1 } }; },
      place: (...args: any[]) => { expect(loaded).toBe(true); restores.push(args); }, delete: vi.fn(),
    } };
  const system = { run: (fn: any) => fn(), runTimeout: (fn: any) => queueMicrotask(fn), runInterval: (fn: any, ticks: number) => { intervals.set(ticks, fn); } };
  const source = assets.script.replace(/^import .*;\s*$/gm, '');
  new Function('world', 'system', 'StructureSaveMode', 'ActionFormData', 'ModalFormData', source)(world, system, { Memory: 'memory' }, Form, Form);
  const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
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
  expect(particles).toContainEqual({ x: 10.5, y: 20.5, z: 30.5 });
  expect(particles.length).toBeLessThanOrEqual(197);
  responses.push({ selection: 4 }, { selection: 0 });
  use({ itemStack: { typeId: assets.itemId }, source: player }); await flush();
  expect(commands).toEqual(['structure load craftmatic:t0 10 20 30 90_degrees none', 'structure load craftmatic:t1 10 20 32 90_degrees none']);
  expect(snapshots).toHaveLength(2);
  expect(dimension.spawnEntity).toHaveBeenCalledWith('craftmatic:car', { x: 10.5, y: 21, z: 30.5 });
  expect(entity.setRotation).toHaveBeenCalledWith({ x: 0, y: 90 });
  expect(loaded).toBe(false);
  responses.push({ selection: 5 });
  use({ itemStack: { typeId: assets.itemId }, source: player }); await flush();
  expect(restores.map(args => args[2])).toEqual([{ x: 10, y: 20, z: 30 }, { x: 10, y: 20, z: 32 }]);
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
  pauseAtLoadCall = loadCalls + 3;
  responses.push({ selection: 4 }, { selection: 0 });
  use({ itemStack: { typeId: assets.itemId }, source: player }); await flush();
  expect(resumeLoad).toBeTypeOf('function');
  responses.push({ selection: 0 });
  use({ itemStack: { typeId: assets.itemId }, source: player }); await flush();
  resumeLoad!(); await flush();
  expect(dimension.spawnEntity).toHaveBeenCalledOnce();
  expect(player.sendMessage).toHaveBeenCalledWith(expect.stringContaining('Placement stopped: Canceled.'));
});
