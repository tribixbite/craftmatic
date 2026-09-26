import { describe, expect, it, vi } from 'vitest';
import { buildPlacementPackAssets } from '../web/src/engine/bedrock-placement-pack.js';
import { host } from './_placement-host.js';

/**
 * The wand's ghost preview and progress bar, driven through the serialized
 * runtime exactly as bedrock-placement-runtime.test.ts drives the planner.
 */
it('spawns a ghost at the rotated footprint centre, turns it with the rotation, removes it on hide and place, and reports progress on the action bar', async () => {
  const assets = buildPlacementPackAssets({ stem: 'ghosted', label: 'Ghosted', width: 40, height: 10, length: 20,
    tiles: [{ identifier: 'craftmatic:t0', dx: 0, dy: 0, dz: 0, width: 40, height: 10, length: 20, nonAir: 5 }],
    actors: [{ typeId: 'craftmatic:car', label: 'Car', x: 20, y: 1, z: 10 }],
    preview: { typeId: 'craftmatic:ghosted_preview' }, settleTicks: 3, finalHoldTicks: 5 });
  expect(assets.script).toContain('"preview":{"typeId":"craftmatic:ghosted_preview"}');
  expect(assets.script).toContain('"settleTicks":3');

  const responses: any[] = [];
  class Form { title() { return this; } body() { return this; } button() { return this; } textField() { return this; } async show() { return responses.shift() ?? { canceled: true }; } }
  const intervals = new Map<number, any>();
  const spawned: Array<{ typeId: string; at: any; entity: any }> = [];
  const removed: string[] = [];
  const commands: string[] = [];
  const actionBars: string[] = [];
  const timeouts: number[] = [];
  let loaded = false;
  const makeEntity = (id: string, typeId: string) => ({ id, typeId, nameTag: '', dimension: { id: 'overworld' }, teleport: vi.fn(), setRotation: vi.fn(), remove: () => removed.push(id) });
  const dimension: any = { id: 'overworld', heightRange: { min: -64, max: 320 }, spawnParticle: vi.fn(),
    runCommand: (command: string) => {
      if (command.startsWith('tickingarea remove ')) { loaded = false; return { successCount: 1 }; }
      if (command.startsWith('tickingarea add ')) { loaded = true; return { successCount: 1 }; }
      expect(loaded).toBe(true); commands.push(command); return { successCount: 1 };
    },
    getBlock: () => loaded ? { typeId: 'minecraft:air' } : undefined,
    getEntities: () => [],
    spawnEntity: (typeId: string, at: any) => { if (typeId !== 'craftmatic:ghosted_preview') expect(loaded).toBe(true); const entity = makeEntity(`e${spawned.length + 1}`, typeId); spawned.push({ typeId, at, entity }); return entity; } };
  let use: any;
  const player: any = { id: 'player', location: { x: 100, y: 64, z: 200 }, dimension, selectedSlotIndex: 0,
    getComponent: () => undefined, sendMessage: vi.fn(), onScreenDisplay: { setActionBar: (s: string) => actionBars.push(s) } };
  const world = { afterEvents: { itemUse: { subscribe: (fn: any) => { use = fn; } }, playerLeave: { subscribe: vi.fn() } },
    getAllPlayers: () => [player], getDimension: () => dimension,
    getEntity: (id: string) => removed.includes(id) ? undefined : spawned.find(s => s.entity.id === id)?.entity,
    structureManager: { createFromWorld: vi.fn(), get: () => undefined, place: vi.fn(), delete: vi.fn() } };
  const system = { run: (fn: any) => fn(), runTimeout: (fn: any, ticks: number) => { timeouts.push(ticks); queueMicrotask(fn); }, runInterval: (fn: any, ticks: number) => { intervals.set(ticks, fn); } };
  const source = assets.script.replace(/^import .*;\s*$/gm, '');
  new Function('world', 'system', 'StructureSaveMode', 'ActionFormData', 'ModalFormData', source)(world, system, { Memory: 'memory', World: 'world' }, Form, Form);
  const flush = async (turns = 80) => { for (let i = 0; i < turns; i++) await Promise.resolve(); };
  const drawPreview = intervals.get(12);
  expect(world.afterEvents.playerLeave.subscribe).toHaveBeenCalled();

  // Pin the corner at the feet: the ghost appears at the footprint centre (20, 0, 10) from the pin, yaw 0.
  responses.push({ selection: 1 }, { canceled: true });
  use({ itemStack: { typeId: assets.itemId }, source: player }); await flush();
  drawPreview();
  expect(spawned).toHaveLength(1);
  expect(spawned[0]).toMatchObject({ typeId: 'craftmatic:ghosted_preview', at: { x: 120, y: 64, z: 210 } });
  expect(spawned[0]!.entity.teleport).toHaveBeenCalledWith({ x: 120, y: 64, z: 210 }, { rotation: { x: 0, y: 0 } });
  // No particle sample points once a ghost ships (the outline and the +Y axis marker at the pin stay).
  expect(dimension.spawnParticle.mock.calls.some((c: any[]) => c[0] === 'minecraft:villager_happy' && (c[1].x !== 100 || c[1].z !== 200))).toBe(false);
  expect(dimension.spawnParticle.mock.calls.some((c: any[]) => c[0] === 'minecraft:endrod')).toBe(true);

  // Rotate → 90°: the same ghost is moved to the rotated centre (length − z, x) = (10, 20) and turned.
  responses.push({ selection: 3 }, { canceled: true });
  use({ itemStack: { typeId: assets.itemId }, source: player }); await flush();
  drawPreview();
  expect(spawned).toHaveLength(1);
  expect(spawned[0]!.entity.teleport).toHaveBeenLastCalledWith({ x: 110, y: 64, z: 220 }, { rotation: { x: 0, y: 90 } });
  // "Pin centred on me" puts the rotated footprint centre (10, 20 at 90°) on the player: anchor = feet − centre.
  responses.push({ selection: 0 }, { canceled: true });
  use({ itemStack: { typeId: assets.itemId }, source: player }); await flush();
  drawPreview();
  expect(spawned[0]!.entity.teleport).toHaveBeenLastCalledWith({ x: 100, y: 64, z: 200 }, { rotation: { x: 0, y: 90 } });
  responses.push({ selection: 1 }, { canceled: true });
  use({ itemStack: { typeId: assets.itemId }, source: player }); await flush();

  // Hide preview removes it; showing it again spawns a fresh one.
  responses.push({ selection: 7 });
  use({ itemStack: { typeId: assets.itemId }, source: player }); await flush();
  expect(removed).toEqual(['e1']);
  drawPreview();
  expect(spawned).toHaveLength(1);
  responses.push({ selection: 4 });
  use({ itemStack: { typeId: assets.itemId }, source: player }); await flush();
  drawPreview();
  expect(spawned).toHaveLength(2);

  // Place: the ghost goes away before the first tile, the bar runs 0 → 100 %, the area is held after the last piece.
  responses.push({ selection: 5 }, { selection: 0 });
  use({ itemStack: { typeId: assets.itemId }, source: player }); await flush(200);
  expect(removed).toEqual(['e1', 'e2']);
  expect(commands).toEqual(['structure load craftmatic:t0 100 64 200 90_degrees none']);
  expect(spawned.filter(s => s.typeId === 'craftmatic:car')).toHaveLength(1);
  expect(actionBars.some(s => s.includes('▱') && s.includes(' 0 percent ') && s.includes('loading area for piece 1/1'))).toBe(true);
  expect(actionBars.some(s => s.includes('50 percent') && s.includes('piece 1/1 placed'))).toBe(true);
  expect(actionBars.some(s => s.includes('100 percent') && s.includes('done'))).toBe(true);
  expect(timeouts).toContain(3);
  expect(timeouts).toContain(5);
  expect(player.sendMessage).toHaveBeenCalledWith(expect.stringContaining('Placing Ghosted: 1 structure piece and 1 entity.'));
  expect(player.sendMessage).toHaveBeenCalledWith(expect.stringContaining('Placed Ghosted.'));
  expect(loaded).toBe(false);
  // Placement cleared the preview: nothing is respawned afterwards.
  drawPreview();
  expect(spawned.filter(s => s.typeId === 'craftmatic:ghosted_preview')).toHaveLength(2);
});

/**
 * Device round 2026-09-26a (Saga, 10261): after an Undo a white see-through
 * ghost stood beside the player. A preview shown before the Undo survived it -
 * the Undo only hid the ghost while it ran - and the next redraw spawned it
 * again. Undo and putting the wand away now END the preview, and removal also
 * sweeps by the player's ghost tag, so a ghost whose id lookup fails is not orphaned.
 */
describe('the ghost never outlives an Undo or the wand', () => {
  const tile = { identifier: 'craftmatic:t0', dx: 0, dy: 0, dz: 0, width: 4, height: 2, length: 2, nonAir: 3 };
  const spec = { stem: 'ghosted', label: 'Ghosted', width: 4, height: 2, length: 2, tiles: [tile], actors: [], preview: { typeId: 'craftmatic:ghosted_preview' }, settleTicks: 1, finalHoldTicks: 1 };
  const ghosts = (h: ReturnType<typeof host>) => h.spawned.filter(s => s.typeId === 'craftmatic:ghosted_preview');
  /** Live ghosts: spawned and not removed. */
  const live = (h: ReturnType<typeof host>) => ghosts(h).filter(s => !s.entity.remove.mock.calls.length);

  it('an Undo removes a ghost shown before it, and the next redraw does not bring it back', async () => {
    const h = host(spec);
    const draw = h.intervals.get(12)!;
    await h.open({ selection: 1 }, { canceled: true }); // pin at the feet
    await h.open({ selection: 5 }, { selection: 0 }); // place
    await h.flush(400);
    expect(h.player.sendMessage).toHaveBeenCalledWith(expect.stringContaining('Placed Ghosted.'));
    // Look at the preview again after placing (the Saga's sequence), then Undo.
    await h.open({ selection: 4 });
    draw();
    expect(live(h)).toHaveLength(1);
    await h.open({ selection: 6 });
    await h.flush(400);
    expect(h.player.sendMessage).toHaveBeenCalledWith(expect.stringContaining('Undo complete'));
    expect(live(h)).toHaveLength(0);
    draw(); draw();
    expect(live(h)).toHaveLength(0);
    expect(ghosts(h)).toHaveLength(1); // nothing respawned
  });

  it('putting the wand away removes the ghost and stops following the aim; the pin is kept', async () => {
    const h = host(spec);
    const draw = h.intervals.get(12)!, aim = h.intervals.get(4)!, hold = h.intervals.get(5)!;
    let inHand: { typeId: string } | undefined = { typeId: h.assets.itemId };
    h.player.getComponent = (name: string) => name === 'minecraft:inventory' ? { container: { getItem: () => inHand } } : undefined;
    hold(); await h.flush(); // selecting the wand opens it (its menu is cancelled here)
    h.setHit({ block: { location: { x: 10, y: 70, z: 20 } }, face: 'Up' });
    await h.open({ selection: 9 }); // follow my aim
    aim(); draw();
    expect(live(h)).toHaveLength(1);
    const ghost = live(h)[0]!.entity;
    expect(ghost.tags).toEqual([`cmg_${h.assets.shortAlias}_player`]);
    inHand = { typeId: 'minecraft:stick' };
    hold();
    expect(live(h)).toHaveLength(0);
    // It stays gone, and the aim no longer moves a preview.
    const teleports = ghost.teleport.mock.calls.length;
    h.setHit({ block: { location: { x: 40, y: 70, z: 40 } }, face: 'Up' });
    aim(); draw();
    expect(live(h)).toHaveLength(0);
    expect(ghost.teleport.mock.calls.length).toBe(teleports);
    // Selecting the wand again and asking for the preview shows it at the kept pin.
    inHand = { typeId: h.assets.itemId };
    hold(); await h.flush();
    await h.open({ selection: 4 });
    draw();
    expect(live(h)).toHaveLength(1);
    expect(live(h)[0]!.entity.teleport).toHaveBeenLastCalledWith({ x: 10, y: 71, z: 20 }, { rotation: { x: 0, y: 0 } });
  });

  it('a ghost the id lookup misses is still removed by its tag', async () => {
    const h = host(spec);
    const draw = h.intervals.get(12)!;
    await h.open({ selection: 1 }, { canceled: true });
    draw();
    const g = live(h)[0]!.entity;
    // The id no longer resolves (as a stale id does), but the entity is still in the world with its tag.
    h.world.getEntity = () => undefined;
    h.player.dimension.getEntities = (q: { type?: string; tags?: string[] }) =>
      ghosts(h).map(s => s.entity).filter((e: any) => !e.remove.mock.calls.length && (!q.type || e.typeId === q.type) && (q.tags ?? []).every((t: string) => e.tags.includes(t)));
    await h.open({ selection: 7 }); // hide preview
    expect(g.remove).toHaveBeenCalled();
  });
});
