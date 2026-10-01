/**
 * The exported wand's planner end to end: pin, rotate, preview, a confirmed
 * placement, Undo, cancels, an area that never loads, and the lighting and
 * vehicle-control entries - the SERIALISED runtime on the headless simulator
 * (test/_placement-host.ts), with its real structure manager, ticking areas,
 * `fillBlocks` / `BlockVolume` and forms.
 *
 * Faults the device can produce are injected at the API the runtime calls
 * (and only there): a `tickingarea add` that reports no success, and probe
 * blocks that stay unloaded (`getBlock` answering undefined) for one load or
 * for every load.
 */
import { expect, it, vi } from 'vitest';
import { host } from './_placement-host.js';

it('executes the exported wand through pin, rotate, preview, confirmed placement and undo', async () => {
  // A `vehicleControls` pack imports the time machine's controls from its own module; this one reports the call.
  const h = host({ stem: 'runtime', label: 'Runtime', vehicleControls: true, width: 40, height: 100, length: 20,
    tiles: [0, 18].map((dx, i) => ({ identifier: `craftmatic:t${i}`, dx, dy: 0, dz: 0, width: 18, height: 2, length: 2, nonAir: 1 })),
    actors: [{ typeId: 'craftmatic:car', label: 'Car', x: .5, y: 1, z: 1.5 }], previewPoints: [{ x: .5, y: .5, z: 1.5 }] },
  { playerAt: { x: 10, y: 20, z: 30 }, modules: { 'scripts/time-machine.js': 'export function showTimeMachineControls(p) { console.log(`TM_CONTROLS ${p.id}`); }\n' } });
  const { assets, player, sim, responses } = h;
  const showCalls = () => h.buttons.length;
  const commands = () => h.commands;
  const areaCommands = () => h.areaCommands;
  const loaded = () => h.runtimeAreas().length > 0;
  const showTimeMachineControls = () => h.engine.timeline.of('console').map(e => e.text).filter(t => t.startsWith('TM_CONTROLS '));

  // What the runtime does in the world, and the faults injected at the API it calls.
  let loadCalls = 0, blockedLoadCall = 0, blockEveryLoad = false, addSuccessCount = 1;
  /** Commands, snapshots, restores and actor spawns made without a runtime ticking area over their target. */
  const outsideArea: string[] = [];
  const dimension = h.dimension;
  const runCommand = dimension.runCommand;
  dimension.runCommand = (command: string) => {
    if (command.startsWith('tickingarea add ')) {
      loadCalls++;
      // A command that runs but reports no successful ticking area (a full area list on the device).
      if (addSuccessCount === 0) return { successCount: 0 };
    } else if (!command.startsWith('tickingarea ')) {
      const [, , , x, , z] = command.split(' ');
      if (!h.runtimeLoads(Number(x), Number(z))) outsideArea.push(command);
    }
    return runCommand(command);
  };
  const blockProbes: any[] = [];
  const getBlock = dimension.getBlock;
  // The probe blocks of one load (or every load) never come in: the API answers undefined, as for an unloaded chunk.
  dimension.getBlock = (point: any) => { blockProbes.push(point); return !blockEveryLoad && loadCalls !== blockedLoadCall ? getBlock(point) : undefined; };
  const particles: Array<{ id: string; point: any }> = [];
  const spawnParticle = dimension.spawnParticle;
  dimension.spawnParticle = (id: string, point: any, ...rest: unknown[]) => { particles.push({ id, point }); return spawnParticle(id, point, ...rest); };
  dimension.spawnEntity = vi.fn(dimension.spawnEntity);
  h.engine.on('entitySpawn', ({ entity }) => { if (!entity.isPlayer && !h.runtimeLoads(entity.location.x, entity.location.z)) outsideArea.push(entity.typeId); });
  const snapshots: any[][] = [], restores: any[][] = [];
  const structures = h.world.structureManager;
  const createFromWorld = structures.createFromWorld, place = structures.place;
  structures.createFromWorld = (...args: any[]) => { if (!h.runtimeLoads(args[2].x, args[2].z)) outsideArea.push(`snapshot ${args[0]}`); snapshots.push(args); return createFromWorld(...args); };
  structures.place = (...args: any[]) => { if (!h.runtimeLoads(args[2].x, args[2].z)) outsideArea.push(`restore ${args[0]}`); restores.push(args); return place(...args); };
  /** The actor the placement spawned (its facade carries the host's spies). */
  const entity = () => h.spawned.find(s => s.typeId === 'craftmatic:car')!.entity;
  player.addEffect = vi.fn(player.addEffect);
  player.removeEffect = vi.fn(player.removeEffect);
  /** Hold `typeId` in the selected hotbar slot (undefined: an empty hand). */
  const hold = (typeId: string | undefined) => { h.host.playerState(sim).items[player.selectedSlotIndex] = typeId; };
  /** Look along a horizontal direction: yaw 0 faces +z, 90 faces -x. */
  const look = (yaw: number) => { sim.rotation = { x: 0, y: yaw }; };
  look(0);
  const use = async (typeId: string, turns = 60) => { h.host.deliver('itemUse', { itemStack: { typeId }, source: player }); await h.flush(turns); };
  const flush = (turns = 60) => h.flush(turns);
  const pollHeldItem = h.intervals.get(5)!, drawPreview = h.intervals.get(12)!;


  // Selecting the exact wand activates once; staying on it does not re-activate,
  // while switching away and back creates a fresh activation transition. With
  // nothing pinned an activation starts "Follow my aim" and draws no form.
  const aimStarts = () => player.sendMessage.mock.calls.filter(([m]: [string]) => m.includes('The preview follows the block you look at')).length;
  hold(assets.itemId);
  pollHeldItem(); await flush();
  expect(showCalls()).toBe(0);
  expect(aimStarts()).toBe(1);
  pollHeldItem(); await flush();
  expect(aimStarts()).toBe(1);
  hold(undefined); pollHeldItem();
  hold(assets.itemId);
  pollHeldItem(); await flush();
  expect(showCalls()).toBe(0);
  expect(aimStarts()).toBe(2);
  hold(undefined); pollHeldItem();

  // The wrong item must not open or mutate this pack's planner.
  await use('minecraft:stick');
  expect(showCalls()).toBe(0);
  expect(aimStarts()).toBe(2);
  // The first use of an unpinned wand starts the aim (no form); the second,
  // while aiming, opens the menu.
  await use(assets.itemId);
  expect(showCalls()).toBe(0);
  expect(aimStarts()).toBe(3);
  responses.push({ action: 'Pin corner at my feet' }, { action: 'Rotate' }, { canceled: true });
  await use(assets.itemId);
  expect(showCalls()).toBe(3);
  expect(commands()).toHaveLength(0);
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
  player.location = { x: -100, y: 80, z: 200 }; look(90);
  drawPreview();
  expect(particles).toEqual(firstPreview);
  player.location = { x: 10, y: 20, z: 30 };
  responses.push({ action: 'Place' }, { selection: 0 });
  await use(assets.itemId);
  expect(commands()).toEqual(['structure load craftmatic:t0 28 20 30 90_degrees none', 'structure load craftmatic:t1 28 20 48 90_degrees none']);
  expect(areaCommands().some(command => command.includes('tickingarea add 28 20 30 29 20 47'))).toBe(true);
  expect(blockProbes.some(point => point.z === 30)).toBe(true);
  expect(blockProbes.some(point => point.z === 40)).toBe(true);
  expect(snapshots).toHaveLength(2);
  expect(dimension.spawnEntity).toHaveBeenCalledWith('craftmatic:car', { x: 28.5, y: 21, z: 30.5 });
  expect(entity().setRotation).toHaveBeenCalledWith({ x: 0, y: 90 });
  // No floating name tag over a placed entity (it ran across the screen up close, round 30i);
  // the label is still there for scripts.
  expect(entity().nameTag).toBe('');
  expect(entity().getDynamicProperty('craftmatic:label')).toBe('Car');
  expect(loaded()).toBe(false);
  const successfulAddNames = areaCommands().filter(command => command.startsWith('tickingarea add ')).map(command => command.split(' ')[8]);
  const removedAreaNames = areaCommands().filter(command => command.startsWith('tickingarea remove ')).map(command => command.split(' ')[2]);
  expect(new Set(successfulAddNames).size).toBe(successfulAddNames.length);
  expect(removedAreaNames).toEqual(expect.arrayContaining(successfulAddNames));

  // Cancel before the next placement mutates anything: the previous complete
  // placement must remain the one available to Undo.
  blockedLoadCall = loadCalls + 1;
  responses.push({ action: 'Place' }, { selection: 0 });
  await use(assets.itemId);
  responses.push({ action: 'Cancel placement' });
  await use(assets.itemId);
  expect(player.sendMessage).toHaveBeenCalledWith(expect.stringContaining('Placement stopped: Canceled.'));
  blockedLoadCall = 0;
  responses.push({ action: 'Undo last placement' });
  await use(assets.itemId);
  expect(restores.map(args => args[2])).toEqual([{ x: 28, y: 20, z: 30 }, { x: 28, y: 20, z: 48 }]);
  expect(entity().remove).toHaveBeenCalledOnce();
  expect(loaded()).toBe(false);

  // A pinned origin cannot silently move to the same coordinates in another dimension.
  sim.dimension = 'minecraft:nether'; h.engine.updateLoaded();
  responses.push({ action: 'Place' }, { canceled: true });
  await use(assets.itemId);
  expect(commands()).toHaveLength(2);
  expect(player.sendMessage).toHaveBeenCalledWith(expect.stringContaining('Origin is pinned in minecraft:overworld'));
  sim.dimension = 'minecraft:overworld'; h.engine.updateLoaded();

  // Cancel while the actor's awaited chunk load is pending: no actor may spawn afterward.
  blockedLoadCall = loadCalls + 3;
  responses.push({ action: 'Place' }, { selection: 0 });
  await use(assets.itemId);
  responses.push({ action: 'Cancel placement' });
  await use(assets.itemId);
  expect(dimension.spawnEntity).toHaveBeenCalledOnce();
  expect(player.sendMessage).toHaveBeenCalledWith(expect.stringContaining('Placement stopped: Canceled.'));

  // A permanently unloaded first tile stops after the bounded 600-tick poll
  // and preserves the partial placement history produced just before it.
  blockedLoadCall = 0;
  blockEveryLoad = true;
  responses.push({ action: 'Place' }, { selection: 0 });
  await use(assets.itemId, 800);
  expect(dimension.spawnEntity).toHaveBeenCalledOnce();
  expect(loaded()).toBe(false);
  expect(player.sendMessage).toHaveBeenCalledWith(expect.stringContaining('probe 28,20,30 returned undefined'));
  blockEveryLoad = false;
  responses.push({ action: 'Undo last placement' });
  await use(assets.itemId);
  expect(restores).toHaveLength(4);
  expect(player.sendMessage).toHaveBeenCalledWith(expect.stringContaining('Undo complete.'));
  expect(player.sendMessage).not.toHaveBeenCalledWith(expect.stringContaining('Nothing to undo'));

  // A command that runs but reports no successful ticking area fails immediately
  // with an actionable diagnostic rather than entering the 600-tick poll.
  addSuccessCount = 0;
  responses.push({ action: 'Place' }, { selection: 0 });
  await use(assets.itemId);
  expect(player.sendMessage).toHaveBeenCalledWith(expect.stringContaining('tickingarea command reported successCount 0'));
  expect(dimension.spawnEntity).toHaveBeenCalledOnce();

  // Lighting is an appended player-only aid; existing menu indexes stay stable
  // and neither choice performs a dimension command or block mutation.
  const commandsBeforeLighting = commands().length, snapshotsBeforeLighting = snapshots.length;
  responses.push({ action: 'Lighting' }, { selection: 0 });
  await use(assets.itemId);
  expect(player.addEffect).toHaveBeenCalledWith('minecraft:night_vision', 12000, { showParticles: false });
  responses.push({ action: 'Lighting' }, { selection: 1 });
  await use(assets.itemId);
  expect(player.removeEffect).toHaveBeenCalledWith('minecraft:night_vision');
  expect(commands()).toHaveLength(commandsBeforeLighting);
  expect(snapshots).toHaveLength(snapshotsBeforeLighting);
  expect(showTimeMachineControls()).toEqual([]);
  responses.push({ action: 'DeLorean controls' });
  await use(assets.itemId);
  expect(showTimeMachineControls()).toEqual([`TM_CONTROLS ${player.id}`]);
  expect(commands()).toHaveLength(commandsBeforeLighting);

  // With a pin, SELECTING the wand again opens the menu instead of starting the aim.
  const showsBeforeReselect = showCalls(), aimsBeforeReselect = aimStarts();
  hold(assets.itemId); responses.push({ canceled: true });
  pollHeldItem(); await flush();
  expect(showCalls()).toBe(showsBeforeReselect + 1);
  expect(aimStarts()).toBe(aimsBeforeReselect);
  // Nothing was loaded, snapshotted, restored or spawned outside the runtime's own ticking area.
  expect(outsideArea).toEqual([]);
});
