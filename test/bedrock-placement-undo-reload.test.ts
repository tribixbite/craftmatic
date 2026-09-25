/**
 * The Brick Wand's Undo across a world reload (and a restart): the SERIALISED
 * placement runtime is booted, places a build, and is then booted AGAIN over
 * the same saved world - a fresh script with an empty memory, entities in
 * unloaded chunks until a ticking area loads them - and must still undo it.
 */
import { describe, expect, it, vi } from 'vitest';
import { buildPlacementPackAssets } from '../web/src/engine/bedrock-placement-pack.js';

/** What the world file keeps across a reload: player properties, saved structures, entities (with tags). */
function savedWorld() {
  const playerProperties = new Map<string, unknown>();
  const structures = new Map<string, { from: any; to: any; saveMode: unknown }>();
  const entities = new Map<string, any>();
  const restores: any[] = [];
  const deleted: string[] = [];
  return { playerProperties, structures, entities, restores, deleted };
}

/** Boot the pack's runtime over `saved` as a fresh script (the state a reload leaves). */
function boot(assets: ReturnType<typeof buildPlacementPackAssets>, saved: ReturnType<typeof savedWorld>, idPad = '', turns = 3000) {
  const responses: any[] = [];
  class Form {
    title() { return this; } body() { return this; } button() { return this; } textField() { return this; }
    async show() { return responses.shift() ?? { canceled: true }; }
  }
  let use: any, loaded = false, spawnedCount = saved.entities.size;
  const dimension: any = {
    id: 'overworld', heightRange: { min: -64, max: 320 }, spawnParticle: vi.fn(),
    runCommand: (command: string) => {
      if (command.startsWith('tickingarea remove ')) { loaded = false; return { successCount: 1 }; }
      if (command.startsWith('tickingarea add ')) { loaded = true; return { successCount: 1 }; }
      return { successCount: 1 };
    },
    getBlock: () => (loaded ? { typeId: 'minecraft:air' } : undefined),
    // Only loaded chunks answer: after a reload nothing is loaded until the runtime loads it.
    getEntities: (q?: { tags?: string[] }) => (loaded ? [...saved.entities.values()].filter(e => !e.removed && (!q?.tags || q.tags.every((t: string) => e.tags.has(t)))) : []),
    spawnEntity: (typeId: string, at: any) => {
      const id = `${idPad}${++spawnedCount}`;
      const tags = new Set<string>();
      const e: any = { id, typeId, at, nameTag: '', tags, removed: false, setRotation: vi.fn(), triggerEvent: vi.fn(), setDynamicProperty: vi.fn(), getComponent: () => undefined,
        addTag: (t: string) => { tags.add(t); return true; }, remove: () => { e.removed = true; } };
      saved.entities.set(id, e);
      return e;
    },
  };
  const player: any = { id: 'player-1', location: { x: 10, y: 20, z: 30 }, dimension, selectedSlotIndex: 0,
    getComponent: () => undefined, sendMessage: vi.fn(), onScreenDisplay: { setActionBar: vi.fn() },
    getDynamicProperty: (k: string) => saved.playerProperties.get(k),
    setDynamicProperty: (k: string, v: unknown) => { if (v === undefined) saved.playerProperties.delete(k); else saved.playerProperties.set(k, v); } };
  const world = {
    afterEvents: { itemUse: { subscribe: (fn: any) => { use = fn; } } },
    getAllPlayers: () => [player], getDimension: () => dimension,
    // A fresh session's getEntity sees only entities in loaded chunks; `loadedIds` models what the player stands near.
    getEntity: (id: string) => { const e = saved.entities.get(id); return e && !e.removed && (loaded || boot.nearby.has(id)) ? e : undefined; },
    structureManager: {
      createFromWorld: (name: string, _dim: unknown, from: any, to: any, options: any) => { saved.structures.set(name, { from, to, saveMode: options.saveMode }); },
      get: (name: string) => { const s = saved.structures.get(name); return s && { size: { x: s.to.x - s.from.x + 1, y: s.to.y - s.from.y + 1, z: s.to.z - s.from.z + 1 } }; },
      place: (name: string, _dim: unknown, at: any) => { saved.restores.push({ name, at }); },
      delete: (name: string) => { saved.deleted.push(name); saved.structures.delete(name); },
    },
  };
  const system = { run: (fn: any) => fn(), runTimeout: (fn: any) => queueMicrotask(fn), runInterval: vi.fn() };
  const source = assets.script.replace(/^import .*;\s*$/gm, '');
  new Function('world', 'system', 'StructureSaveMode', 'BlockPermutation', 'BlockVolume', 'ActionFormData', 'ModalFormData', source)(
    world, system, { Memory: 'memory', World: 'world' }, { resolve: (id: string, states: any) => ({ id, states }) }, class {}, Form, Form);
  const flush = async () => { for (let i = 0; i < turns; i++) await Promise.resolve(); };
  const open = async (...r: any[]) => { responses.push(...r); use({ itemStack: { typeId: assets.itemId }, source: player }); await flush(); };
  return { open, player, messages: () => player.sendMessage.mock.calls.map((c: unknown[]) => String(c[0])) };
}
boot.nearby = new Set<string>();

const spec = (actors: number) => ({
  stem: 'reload', label: 'Reload (reload-1)', width: 20, height: 4, length: 20,
  tiles: [0, 10].map((dx, i) => ({ identifier: `craftmatic:t${i}`, dx, dy: 0, dz: 0, width: 10, height: 4, length: 20, nonAir: 1 })),
  actors: Array.from({ length: actors }, (_, i) => ({ typeId: 'craftmatic:fig', label: `Figure ${i + 1}`, x: 1 + (i % 18), y: 1, z: 1 + Math.floor(i / 18) % 18 })),
  previewPoints: [{ x: 0.5, y: 0.5, z: 0.5 }], settleTicks: 0, finalHoldTicks: 0,
});

describe('Brick Wand Undo survives a world reload', () => {
  it('places, reloads (fresh script, nothing loaded), and Undo restores every snapshot and removes every entity by its tag', async () => {
    const assets = buildPlacementPackAssets(spec(3));
    const saved = savedWorld();
    const first = boot(assets, saved);
    await first.open({ selection: 1 }, { canceled: true }); // pin the corner at the player's feet
    await first.open({ selection: 5 }, { selection: 0 }); // Place... -> confirm
    expect(first.messages().some(m => m.includes('Placed Reload'))).toBe(true);
    // Snapshots are kept in the WORLD, not the script's memory.
    expect(saved.structures.size).toBe(2);
    for (const s of saved.structures.values()) expect(s.saveMode).toBe('world');
    const live = [...saved.entities.values()];
    expect(live).toHaveLength(3);
    // Every spawned entity carries the placement's tag.
    const tag = [...live[0]!.tags][0]!;
    expect(tag).toMatch(/^cmu_/);
    for (const e of live) expect(e.tags.has(tag)).toBe(true);
    expect([...saved.playerProperties.keys()].some(k => k.endsWith(':undo'))).toBe(true);

    // The reload: a new script, an empty `histories`, and the entities in unloaded chunks.
    boot.nearby.clear();
    const second = boot(assets, saved);
    await second.open({ selection: 6 }); // Undo last placement
    expect(second.messages().some(m => m.includes('Nothing to undo'))).toBe(false);
    expect(second.messages().some(m => m.includes('Undo complete.'))).toBe(true);
    expect(saved.restores.map(r => r.at)).toEqual([{ x: 10, y: 20, z: 30 }, { x: 20, y: 20, z: 30 }]);
    expect(saved.structures.size).toBe(0);
    for (const e of live) expect(e.removed).toBe(true);
    // The record is gone with it: a second Undo has nothing to do.
    expect([...saved.playerProperties.keys()].some(k => k.includes(':undo'))).toBe(false);
    await second.open({ selection: 6 });
    expect(second.messages().at(-1)).toContain('Nothing to undo');
  });

  it('after a reload, placing again retires the previous placement (its entities by tag, its snapshots) instead of orphaning it', async () => {
    const assets = buildPlacementPackAssets(spec(2));
    const saved = savedWorld();
    const first = boot(assets, saved);
    await first.open({ selection: 1 }, { canceled: true });
    await first.open({ selection: 5 }, { selection: 0 });
    const old = [...saved.entities.values()];
    const oldSnapshots = [...saved.structures.keys()];
    const second = boot(assets, saved);
    await second.open({ selection: 1 }, { canceled: true });
    await second.open({ selection: 5 }, { selection: 0 });
    for (const e of old) expect(e.removed).toBe(true);
    for (const name of oldSnapshots) expect(saved.deleted).toContain(name);
    // The new placement is the one Undo now reverts.
    const fresh = [...saved.entities.values()].filter(e => !e.removed);
    expect(fresh).toHaveLength(2);
    await second.open({ selection: 6 });
    for (const e of fresh) expect(e.removed).toBe(true);
  });

  it('splits a record larger than one dynamic property (32,767 characters) over numbered keys and reads it back whole', async () => {
    // 700 entities with 60-character ids: a ~44,000-character record.
    const assets = buildPlacementPackAssets(spec(700));
    const saved = savedWorld();
    const first = boot(assets, saved, 'x'.repeat(56), 200000);
    await first.open({ selection: 1 }, { canceled: true });
    await first.open({ selection: 5 }, { selection: 0 });
    const keys = [...saved.playerProperties.keys()].filter(k => k.includes(':undo'));
    expect(keys.length).toBeGreaterThan(1);
    for (const k of keys) expect(String(saved.playerProperties.get(k)).length).toBeLessThanOrEqual(32767);
    // Nothing is near after the reload; the sweep finds every one by tag.
    const second = boot(assets, saved);
    await second.open({ selection: 6 });
    expect([...saved.entities.values()].every(e => e.removed)).toBe(true);
    expect([...saved.playerProperties.keys()].filter(k => k.includes(':undo'))).toHaveLength(0);
  });
});
