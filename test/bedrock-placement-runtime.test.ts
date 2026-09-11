import { expect, it, vi } from 'vitest';
import { buildPlacementPackAssets } from '../web/src/engine/bedrock-placement-pack.js';

it('executes the exported wand through pin, rotate, preview, confirmed placement and undo', async () => {
  const assets = buildPlacementPackAssets({ stem: 'runtime', label: 'Runtime', vehicleControls: true, width: 40, height: 100, length: 20,
    tiles: [0, 18].map((dx, i) => ({ identifier: `craftmatic:t${i}`, dx, dy: 0, dz: 0, width: 18, height: 2, length: 2, nonAir: 1 })),
    actors: [{ typeId: 'craftmatic:car', label: 'Car', x: .5, y: 1, z: 1.5 }], previewPoints: [{ x: .5, y: .5, z: 1.5 }] });
  const responses: any[] = [];
  let showCalls = 0;
  class Form {
    title() { return this; } body() { return this; } button() { return this; }
    textField(_label: string, _placeholder: string, options: any) { expect(typeof options).toBe('object'); return this; }
    async show() { showCalls++; return responses.shift() ?? { canceled: true }; }
  }
  let use: any, selectedItem: any, loaded = false, loadCalls = 0, blockedLoadCall = 0, blockEveryLoad = false, addSuccessCount = 1;
  const intervals = new Map<number, any>();
  const commands: string[] = [], areaCommands: string[] = [], blockProbes: any[] = [], particles: Array<{ id: string; point: any }> = [], snapshots: any[] = [], restores: any[] = [];
  const entity = { id: 'entity-1', nameTag: '', setRotation: vi.fn(), remove: vi.fn() };
  const dimension = { id: 'overworld', heightRange: { min: -64, max: 320 },
    spawnParticle: (id: string, point: any) => particles.push({ id, point }),
    runCommand: (command: string) => {
      if (command.startsWith('tickingarea remove ')) { areaCommands.push(command); loaded = false; return { successCount: 1 }; }
      if (command.startsWith('tickingarea add ')) { areaCommands.push(command); loaded = addSuccessCount > 0; loadCalls++; return { successCount: addSuccessCount }; }
      expect(loaded).toBe(true); commands.push(command); return { successCount: 1 };
    },
    getBlock: (point: any) => { blockProbes.push(point); return loaded && !blockEveryLoad && loadCalls !== blockedLoadCall ? { typeId: 'minecraft:air' } : undefined; },
    spawnEntity: vi.fn(() => { expect(loaded).toBe(true); return entity; }) };
  let view = { x: 0, y: 0, z: 1 };
  const player: any = { id: 'player', location: { x: 10, y: 20, z: 30 }, dimension, selectedSlotIndex: 0, getViewDirection: () => view,
    getComponent: (id: string) => id === 'minecraft:inventory' ? { container: { getItem: () => selectedItem } } : undefined,
    addEffect: vi.fn(), removeEffect: vi.fn(), sendMessage: vi.fn(), onScreenDisplay: { setActionBar: vi.fn() } };
  const world = { afterEvents: { itemUse: { subscribe: (fn: any) => { use = fn; } } },
    getAllPlayers: () => [player], getDimension: () => dimension, getEntity: () => entity,
    structureManager: {
      createFromWorld: (...args: any[]) => { expect(loaded).toBe(true); snapshots.push(args); },
      get: (name: string) => { const s = snapshots.find(args => args[0] === name); return s && { size: { x: s[3].x-s[2].x+1, y: s[3].y-s[2].y+1, z: s[3].z-s[2].z+1 } }; },
      place: (...args: any[]) => { expect(loaded).toBe(true); restores.push(args); }, delete: vi.fn(),
    } };
  const system = { run: (fn: any) => fn(), runTimeout: (fn: any) => queueMicrotask(fn), runInterval: (fn: any, ticks: number) => { intervals.set(ticks, fn); } };
  const source = assets.script.replace(/^import .*;\s*$/gm, '');
  const showTimeMachineControls = vi.fn(async () => {});
  new Function('world', 'system', 'StructureSaveMode', 'ActionFormData', 'ModalFormData', 'showTimeMachineControls', source)(world, system, { Memory: 'memory' }, Form, Form, showTimeMachineControls);
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
  // Every marker is full-size at the pinned, rotated placement. Looking in a
  // different direction must not move this world-space preview.
  expect(particles).toContainEqual({ id: 'minecraft:villager_happy', point: { x: 28.5, y: 20.5, z: 30.5 } });
  expect(particles).toContainEqual({ id: 'minecraft:endrod', point: { x: 10, y: 20, z: 30 } });
  expect(particles).toContainEqual({ id: 'minecraft:endrod', point: { x: 30, y: 120, z: 70 } });
  expect(particles.filter(({ id, point }) => id === 'minecraft:endrod' && point.x === 10 && point.z === 30)).toHaveLength(12);
  expect(particles).toContainEqual({ id: 'minecraft:redstone_ore_dust_particle', point: { x: 16, y: 20, z: 30 } });
  expect(particles).toContainEqual({ id: 'minecraft:water_splash_particle_manual', point: { x: 10, y: 20, z: 36 } });
  expect(particles).toContainEqual({ id: 'minecraft:totem_particle', point: { x: 32, y: 21, z: 50 } });
  expect(particles.every(({ id }) => !id.includes('flame'))).toBe(true);
  expect(particles.length).toBeLessThanOrEqual(320);
  const firstPreview = structuredClone(particles);
  particles.length = 0;
  player.location = { x: -100, y: 80, z: 200 }; view = { x: -1, y: 0, z: 0 };
  drawPreview();
  expect(particles).toEqual(firstPreview);
  player.location = { x: 10, y: 20, z: 30 };
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
  const successfulAddNames = areaCommands.filter(command => command.startsWith('tickingarea add ')).map(command => command.split(' ')[8]);
  const removedAreaNames = areaCommands.filter(command => command.startsWith('tickingarea remove ')).map(command => command.split(' ')[2]);
  expect(new Set(successfulAddNames).size).toBe(successfulAddNames.length);
  expect(removedAreaNames).toEqual(expect.arrayContaining(successfulAddNames));

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
  expect(player.sendMessage).toHaveBeenCalledWith(expect.stringContaining('probe 28,20,30 returned undefined'));
  blockEveryLoad = false;
  responses.push({ selection: 5 });
  use({ itemStack: { typeId: assets.itemId }, source: player }); await flush();
  expect(restores).toHaveLength(4);
  expect(player.sendMessage).toHaveBeenCalledWith(expect.stringContaining('Undo complete.'));
  expect(player.sendMessage).not.toHaveBeenCalledWith(expect.stringContaining('Nothing to undo'));

  // A command that runs but reports no successful ticking area fails immediately
  // with an actionable diagnostic rather than entering the 600-tick poll.
  addSuccessCount = 0;
  responses.push({ selection: 4 }, { selection: 0 });
  use({ itemStack: { typeId: assets.itemId }, source: player }); await flush();
  expect(player.sendMessage).toHaveBeenCalledWith(expect.stringContaining('tickingarea command reported successCount 0'));
  expect(dimension.spawnEntity).toHaveBeenCalledOnce();

  // Lighting is an appended player-only aid; existing menu indexes stay stable
  // and neither choice performs a dimension command or block mutation.
  const commandsBeforeLighting = commands.length, snapshotsBeforeLighting = snapshots.length;
  responses.push({ selection: 7 }, { selection: 0 });
  use({ itemStack: { typeId: assets.itemId }, source: player }); await flush();
  expect(player.addEffect).toHaveBeenCalledWith('minecraft:night_vision', 12000, { showParticles: false });
  responses.push({ selection: 7 }, { selection: 1 });
  use({ itemStack: { typeId: assets.itemId }, source: player }); await flush();
  expect(player.removeEffect).toHaveBeenCalledWith('minecraft:night_vision');
  expect(commands).toHaveLength(commandsBeforeLighting);
  expect(snapshots).toHaveLength(snapshotsBeforeLighting);
  expect(showTimeMachineControls).not.toHaveBeenCalled();
  responses.push({ selection: 8 });
  use({ itemStack: { typeId: assets.itemId }, source: player }); await flush();
  expect(showTimeMachineControls).toHaveBeenCalledExactlyOnceWith(player);
  expect(commands).toHaveLength(commandsBeforeLighting);
});
