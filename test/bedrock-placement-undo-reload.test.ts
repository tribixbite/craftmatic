/**
 * The Brick Wand's Undo across a world reload (and a restart): the SERIALISED
 * placement runtime is booted, places a build, and the world is then REOPENED
 * - every script loaded again into a fresh context (an empty memory) over the
 * same saved world, the simulator's `reloadScripts` - with the placement's
 * entities in chunks nobody loads until the runtime's own ticking area does,
 * and must still undo it.
 *
 * On the headless simulator (test/_placement-host.ts): the world keeps what a
 * world file keeps - the player's dynamic properties, the structures saved
 * into the world, the entities with their tags - and loads only what the
 * player's simulation distance and the runtime's ticking areas load.
 */
import { describe, expect, it } from 'vitest';
import { host } from './_placement-host.js';

const spec = (actors: number) => ({
  stem: 'reload', label: 'Reload (reload-1)', width: 20, height: 4, length: 20,
  tiles: [0, 10].map((dx, i) => ({ identifier: `craftmatic:t${i}`, dx, dy: 0, dz: 0, width: 10, height: 4, length: 20, nonAir: 1 })),
  actors: Array.from({ length: actors }, (_, i) => ({ typeId: 'craftmatic:fig', label: `Figure ${i + 1}`, x: 1 + (i % 18), y: 1, z: 1 + Math.floor(i / 18) % 18 })),
  previewPoints: [{ x: 0.5, y: 0.5, z: 0.5 }], settleTicks: 0, finalHoldTicks: 0,
});

/** Far from the build: nothing of it is inside the player's simulation distance. */
const FAR_AWAY = { x: 5000, y: 20, z: 5000 };

/**
 * One world, booted once: the player at (10, 20, 30), nothing loaded but what
 * the player and the runtime load. Records the world-file side the tests read:
 * every snapshot saved (with its save mode), restored and deleted.
 */
function world(actors: number) {
  const h = host(spec(actors), { playerAt: { x: 10, y: 20, z: 30 }, loadEverywhere: false });
  const saveModes = new Map<string, unknown>(), restores: Array<{ name: string; at: any }> = [], deleted: string[] = [];
  const structures = h.world.structureManager;
  const createFromWorld = structures.createFromWorld, place = structures.place, remove = structures.delete;
  structures.createFromWorld = (...args: any[]) => { saveModes.set(args[0], args[4]?.saveMode); return createFromWorld(...args); };
  structures.place = (...args: any[]) => { restores.push({ name: args[0], at: args[2] }); return place(...args); };
  structures.delete = (name: string) => { deleted.push(name); return remove(name); };
  /** The structures saved in the world now. */
  const saved = (): string[] => structures.getWorldStructureIds();
  /** Every placement entity, with whether it has been removed and its tags. */
  const entities = () => h.spawned.filter(s => s.typeId === 'craftmatic:fig').map(s => { const sim = (s as any).sim; return { id: sim.id as string, removed: !sim.valid, tags: sim.tags as Set<string> }; });
  const messages = (): string[] => h.player.sendMessage.mock.calls.map((c: unknown[]) => String(c[0]));
  const undoKeys = (): string[] => [...h.playerProperties.keys()].filter(k => k.includes(':undo'));
  const retiredKeys = (): string[] => h.world.getDynamicPropertyIds().filter((k: string) => k.includes(':retired:'));
  const actor = (id: string): any => h.spawned.find((s: any) => s.sim?.id === id)?.entity;
  return { h, saveModes, restores, deleted, saved, entities, messages, undoKeys, retiredKeys, actor };
}

describe('Brick Wand Undo survives a world reload', () => {
  it('places, reloads (fresh script, nothing loaded), and Undo restores every snapshot and removes every entity by its tag', async () => {
    const w = world(3);
    const { h } = w;
    await h.open({ action: 'Pin corner at my feet' }, { canceled: true }); // pin the corner at the player's feet
    await h.open({ action: 'Place' }, { selection: 0 }); // Place... -> confirm
    expect(w.messages().some(m => m.includes('Placed Reload'))).toBe(true);
    // Snapshots are kept in the WORLD, not the script's memory.
    expect(w.saved()).toHaveLength(2);
    for (const name of w.saved()) expect(w.saveModes.get(name)).toBe('World');
    const live = w.entities();
    expect(live).toHaveLength(3);
    // Every spawned entity carries the placement's tag.
    const tag = [...live[0]!.tags][0]!;
    expect(tag).toMatch(/^cmu_/);
    for (const e of live) expect(e.tags.has(tag)).toBe(true);
    expect(w.undoKeys().length).toBeGreaterThan(0);

    // The reload: a new script, an empty `histories`, and the entities in unloaded chunks (the player is far away).
    h.player.location = FAR_AWAY;
    expect(h.runtimeAreas()).toHaveLength(0);
    expect(h.world.getEntity(live[0]!.id)).toBeUndefined();
    h.reload();
    const before = w.messages().length;
    await h.open({ action: 'Undo last placement' }); // Undo last placement
    const second = w.messages().slice(before);
    expect(second.some(m => m.includes('Nothing to undo'))).toBe(false);
    expect(second.some(m => m.includes('Undo complete.'))).toBe(true);
    expect(w.restores.map(r => r.at)).toEqual([{ x: 10, y: 20, z: 30 }, { x: 20, y: 20, z: 30 }]);
    expect(w.saved()).toHaveLength(0);
    for (const e of w.entities()) expect(e.removed).toBe(true);
    // The record is gone with it: a second Undo has nothing to do.
    expect(w.undoKeys()).toHaveLength(0);
    await h.open({ action: 'Undo last placement' });
    expect(w.messages().at(-1)).toContain('Nothing to undo');
  });

  it('after a reload, placing again retires the previous placement (its entities by tag, its snapshots) instead of orphaning it', async () => {
    const w = world(2);
    const { h } = w;
    await h.open({ action: 'Pin corner at my feet' }, { canceled: true });
    await h.open({ action: 'Place' }, { selection: 0 });
    const old = w.entities().map(e => e.id);
    const oldSnapshots = w.saved();
    // A while later (the scripts' clock moves on: a new placement's tag and snapshot names are new), the world is reopened.
    h.engine.runSync(40);
    h.reload();
    await h.open({ action: 'Pin corner at my feet' }, { canceled: true });
    await h.open({ action: 'Place' }, { selection: 0 });
    for (const id of old) expect(w.entities().find(e => e.id === id)!.removed).toBe(true);
    for (const name of oldSnapshots) expect(w.deleted).toContain(name);
    // The new placement is the one Undo now reverts.
    const fresh = w.entities().filter(e => !e.removed);
    expect(fresh).toHaveLength(2);
    await h.open({ action: 'Undo last placement' });
    for (const e of fresh) expect(w.entities().find(x => x.id === e.id)!.removed).toBe(true);
  });

  it('persists deferred Undo cleanup across a reload, then removes the flown-away actor when its chunk really loads', async () => {
    const w = world(1);
    const { h } = w;
    await h.open({ action: 'Pin corner at my feet' }, { canceled: true });
    await h.open({ action: 'Place' }, { selection: 0 });
    const old = w.entities()[0]!;
    w.actor(old.id).teleport(FAR_AWAY);
    h.engine.updateLoaded();
    expect(h.world.getEntity(old.id)).toBeUndefined();

    await h.open({ action: 'Undo last placement' });
    expect(w.messages().at(-1)).toContain('pending cleanup when its chunk loads');
    expect(w.entities().find(e => e.id === old.id)!.removed).toBe(false);
    expect(w.retiredKeys()).toHaveLength(1);
    expect(w.undoKeys()).toHaveLength(0);

    // A fresh script must not read world properties during module evaluation:
    // Bedrock can reject them that early. Permit reads only before the first
    // scheduled turn; that turn reconstructs the tombstone, then the player's
    // real loaded radius produces entityLoad at the remote chunk.
    const getIds = h.world.getDynamicPropertyIds.bind(h.world), get = h.world.getDynamicProperty.bind(h.world);
    let worldReady = false;
    h.world.getDynamicPropertyIds = () => { if (!worldReady) throw new Error('world dynamic properties are not ready'); return getIds(); };
    h.world.getDynamicProperty = (key: string) => { if (!worldReady) throw new Error('world dynamic properties are not ready'); return get(key); };
    h.reload();
    worldReady = true;
    await h.flush();
    h.player.location = FAR_AWAY;
    h.engine.runSync(2);
    expect(w.entities().find(e => e.id === old.id)!.removed).toBe(true);
    expect(w.retiredKeys()).toHaveLength(0);
  });

  it('defers a flown-away old actor on re-place while preserving the active replacement through unload/load', async () => {
    const w = world(1);
    const { h } = w;
    await h.open({ action: 'Pin corner at my feet' }, { canceled: true });
    await h.open({ action: 'Place' }, { selection: 0 });
    const old = w.entities()[0]!;
    w.actor(old.id).teleport(FAR_AWAY);
    h.engine.updateLoaded();

    h.engine.runSync(40); // make the replacement's placement tag distinct
    await h.open({ action: 'Pin corner at my feet' }, { canceled: true });
    await h.open({ action: 'Place' }, { selection: 0 });
    const active = w.entities().find(e => e.id !== old.id && !e.removed)!;
    expect(w.entities().find(e => e.id === old.id)!.removed).toBe(false);
    expect(w.retiredKeys()).toHaveLength(1);

    h.reload();
    await h.flush();
    // The active replacement is loaded during the startup sweep and has a
    // different, non-retired tag, so it must survive.
    expect(w.entities().find(e => e.id === active.id)!.removed).toBe(false);
    h.player.location = FAR_AWAY;
    h.engine.runSync(2);
    expect(w.entities().find(e => e.id === old.id)!.removed).toBe(true);
    expect(w.retiredKeys()).toHaveLength(0);

    // Loading the active actor again also leaves it alone.
    h.player.location = { x: 10, y: 20, z: 30 };
    h.engine.runSync(2);
    expect(w.entities().find(e => e.id === active.id)!.removed).toBe(false);
  });

  it('splits large Undo and deferred-retirement records over 32,767-character properties and reads them back whole', async () => {
    // The record lists every spawned entity's id; the simulator's ids are the device's short
    // numeric strings, so 2,600 entities make a ~34,000-character record (the fake world padded 700 ids to 60 characters).
    const w = world(2600);
    const { h } = w;
    await h.open({ action: 'Pin corner at my feet' }, { canceled: true });
    await h.open({ action: 'Place' }, { selection: 0 });
    await h.flushUntil(() => w.messages().some(m => m.includes('Placed Reload')));
    const keys = w.undoKeys();
    expect(keys.length).toBeGreaterThan(1);
    for (const k of keys) expect(String(h.playerProperties.get(k)).length).toBeLessThanOrEqual(32767);

    // Move every actor beyond the placement box and unload that chunk. Undo
    // cannot see them, so its durable retirement record is also larger than a
    // single dynamic property.
    for (const e of w.entities()) w.actor(e.id).teleport(FAR_AWAY);
    h.engine.updateLoaded();
    h.reload();
    await h.open({ action: 'Undo last placement' });
    await h.flushUntil(() => w.messages().some(m => m.includes('Undo complete')));
    expect(w.entities().every(e => !e.removed)).toBe(true);
    expect(w.undoKeys()).toHaveLength(0);
    const retired = w.retiredKeys();
    expect(retired.length).toBeGreaterThan(1);
    for (const k of retired) expect(String(h.world.getDynamicProperty(k)).length).toBeLessThanOrEqual(32767);

    // The chunked record survives another script reload; loading the remote
    // chunk removes all 2,600 actors and clears every retirement chunk.
    h.reload();
    await h.flush();
    h.player.location = FAR_AWAY;
    h.engine.runSync(2);
    expect(w.entities().every(e => e.removed)).toBe(true);
    expect(w.retiredKeys()).toHaveLength(0);
  });
});
