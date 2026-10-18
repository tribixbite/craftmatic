/**
 * An OLD whole-model building shell, still standing in a saved world, is
 * turned into the lattice chunks a newer pack draws it with - by the
 * SERIALISED placement runtime on the headless simulator
 * (test/_placement-host.ts): the chunks spawn at the old root plus each
 * chunk's offset turned by the old yaw and sized by the old actor's
 * `minecraft:scale`, carry its yaw, size step, label and placement tag, the
 * old actor is removed, a reload never doubles a chunk, and Undo of the old
 * placement retires every chunk through the mapping the migration records.
 */
import { describe, expect, it } from 'vitest';
import { host } from './_placement-host.js';
import { shellBehavior } from '../web/src/engine/bedrock-building-shell.js';
import { SIZE_EVENT_PREFIX } from '../web/src/engine/bedrock-placement-pack.js';

const LEGACY = 'craftmatic:b_shellmig_shell';
const CHUNKS: Array<{ typeId: string; offset: [number, number, number] }> = [
  { typeId: 'craftmatic:b_shellmig_shell_c0_0_0', offset: [10, 20, -10] },
  { typeId: 'craftmatic:b_shellmig_shell_c1_0_0', offset: [30, 20, -10] },
  { typeId: 'craftmatic:b_shellmig_shell_cn1_n1_0', offset: [-10, 0, -10] },
];
const EXTENT = { width: 40, height: 10, length: 40 };
const TAG = 'cmu_shellmig_old1';

const spec = {
  stem: 'shellmig', label: 'Shell Migration (shellmig-1)', width: 40, height: 10, length: 40,
  tiles: [{ identifier: 'craftmatic:t0', dx: 0, dy: 0, dz: 0, width: 40, height: 10, length: 40, nonAir: 1 }],
  actors: CHUNKS.map((c, i) => ({ typeId: c.typeId, label: `Bricks ${i + 1}`, x: 20 + c.offset[0], y: c.offset[1], z: 20 + c.offset[2] })),
  shellMigrations: [{ legacyTypeId: LEGACY, chunks: CHUNKS }],
  settleTicks: 0, finalHoldTicks: 0,
};

/** The exporter's own shell documents: real `minecraft:scale` size groups, which the migration reads. */
const definitions = Object.fromEntries([LEGACY, ...CHUNKS.map(c => c.typeId)].map(id => [id, JSON.stringify(shellBehavior(id.replace(/^[^:]*:/, ''), EXTENT))]));

/** Where chunk `i` of an old actor at `at`, turned `yaw`, sized `f`, must stand: `at + f · R(yaw) · offset` (Bedrock's yaw turns +X toward +Z). */
const expectedAt = (at: { x: number; y: number; z: number }, yaw: number, f: number, i: number) => {
  const [ox, oy, oz] = CHUNKS[i]!.offset, a = yaw * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  return { x: at.x + (c * ox - s * oz) * f, y: at.y + oy * f, z: at.z + (s * ox + c * oz) * f };
};

function world(options: { loadEverywhere?: boolean; playerAt?: { x: number; y: number; z: number } } = {}) {
  const h = host(spec, { definitions, playerAt: options.playerAt ?? { x: 100, y: 64, z: 200 }, ...(options.loadEverywhere === false ? { loadEverywhere: false } : {}) });
  /** An old whole-model actor as the previous pack's placement left it: at `at`, turned, sized, tagged, labelled. */
  const oldShell = (at: { x: number; y: number; z: number }, yaw: number, pct: number) => {
    const e = h.engine.spawnEntity(LEGACY, 'overworld', at);
    e.rotation = { x: 0, y: yaw };
    e.tags.add(TAG);
    e.dynamic.set('craftmatic:label', 'Shell Migration bricks');
    if (pct !== 100) e.triggerEvent(`${SIZE_EVENT_PREFIX}${pct}`);
    return e;
  };
  const chunkRecords = () => h.spawned.filter(s => CHUNKS.some(c => c.typeId === s.typeId)).map(s => { const sim = (s as any).sim; return { typeId: s.typeId, sim, api: s.entity }; });
  const migratedKeys = (): string[] => h.world.getDynamicPropertyIds().filter((k: string) => k.includes(':migrated:'));
  const messages = (): string[] => h.player.sendMessage.mock.calls.map((c: unknown[]) => String(c[0]));
  return { h, oldShell, chunkRecords, migratedKeys, messages };
}

describe('an old whole-model shell migrates into lattice chunks', () => {
  it.each([
    { yaw: 0, pct: 100 }, { yaw: 90, pct: 100 }, { yaw: 0, pct: 200 }, { yaw: 90, pct: 200 },
  ])('spawns every chunk at the old root plus its turned, sized offset (yaw $yaw, $pct percent) and removes the old actor', async ({ yaw, pct }) => {
    const w = world();
    const at = { x: 120, y: 64, z: 220 };
    const old = w.oldShell(at, yaw, pct);
    expect(old.scale()).toBe(pct / 100);
    // The old actor is already standing when the (new) pack's script starts: the startup scan finds it.
    w.h.reload();
    await w.h.flush();
    const chunks = w.chunkRecords();
    expect(chunks.map(c => c.typeId).sort()).toEqual(CHUNKS.map(c => c.typeId).sort());
    for (const [i, chunk] of CHUNKS.entries()) {
      const spawned = chunks.find(c => c.typeId === chunk.typeId)!;
      const want = expectedAt(at, yaw, pct / 100, i);
      expect(spawned.sim.location.x).toBeCloseTo(want.x, 6);
      expect(spawned.sim.location.y).toBeCloseTo(want.y, 6);
      expect(spawned.sim.location.z).toBeCloseTo(want.z, 6);
      expect(spawned.sim.rotation.y).toBe(yaw);
      expect(spawned.sim.tags.has(TAG)).toBe(true);
      expect(spawned.sim.dynamic.get('craftmatic:label')).toBe('Shell Migration bricks');
      // The same size step, through the same event the wand uses, so the chunk's own `minecraft:scale` matches.
      expect(spawned.sim.scale()).toBe(pct / 100);
      expect(spawned.api.events).toEqual(pct === 100 ? [] : [`${SIZE_EVENT_PREFIX}${pct}`]);
    }
    expect(old.valid).toBe(false);
    // The mapping Undo reads: old actor id -> every chunk id.
    const keys = w.migratedKeys();
    expect(keys).toEqual([`craftmatic:${w.h.assets.shortAlias}:migrated:${old.id}`]);
    expect(JSON.parse(String(w.h.world.getDynamicProperty(keys[0]))).sort()).toEqual(chunks.map(c => c.sim.id).sort());
  });

  it('migrates an old actor the moment it loads (entityLoad) and a summoned one on spawn', async () => {
    const w = world({ loadEverywhere: false, playerAt: { x: 100, y: 64, z: 200 } });
    const far = { x: 5000, y: 64, z: 5000 };
    const old = w.oldShell(far, 0, 100);
    w.h.engine.updateLoaded();
    expect(w.h.world.getEntity(old.id)).toBeUndefined();
    w.h.reload();
    await w.h.flush();
    // Unloaded: nothing to migrate yet.
    expect(w.chunkRecords()).toHaveLength(0);
    expect(old.valid).toBe(true);
    w.h.player.location = far;
    w.h.engine.runSync(2);
    expect(w.chunkRecords()).toHaveLength(CHUNKS.length);
    expect(old.valid).toBe(false);

    // A spawn egg or /summon of the old type is migrated as it appears.
    const summoned = w.h.dimension.spawnEntity(LEGACY, { x: 5010, y: 64, z: 5010 });
    await w.h.flush();
    w.h.engine.runSync(2);
    expect(w.chunkRecords()).toHaveLength(CHUNKS.length * 2);
    expect(w.h.world.getEntity(summoned.id)).toBeUndefined();
  });

  it('never doubles a chunk: a reload after migration spawns nothing, and one interrupted mid-way finishes only the missing chunks', async () => {
    const w = world();
    const at = { x: 120, y: 64, z: 220 };
    w.oldShell(at, 0, 100);
    w.h.reload();
    await w.h.flush();
    expect(w.chunkRecords()).toHaveLength(CHUNKS.length);
    w.h.reload();
    await w.h.flush();
    w.h.reload();
    await w.h.flush();
    expect(w.chunkRecords()).toHaveLength(CHUNKS.length);

    // A script that spawned the first chunk and died before removing the old
    // actor left its progress ON the actor; the next start spawns the rest only.
    const partial = w.oldShell({ x: 300, y: 64, z: 300 }, 0, 100);
    const first = w.h.engine.spawnEntity(CHUNKS[0]!.typeId, 'overworld', expectedAt({ x: 300, y: 64, z: 300 }, 0, 1, 0));
    first.tags.add(TAG);
    partial.dynamic.set('craftmatic:shell_migrated', JSON.stringify([first.id]));
    w.h.reload();
    await w.h.flush();
    expect(w.chunkRecords()).toHaveLength(CHUNKS.length * 2);
    expect(w.chunkRecords().filter(c => c.sim.location.x >= 280).map(c => c.typeId).sort()).toEqual(CHUNKS.map(c => c.typeId).sort());
    expect(partial.valid).toBe(false);
    const mapping = JSON.parse(String(w.h.world.getDynamicProperty(`craftmatic:${w.h.assets.shortAlias}:migrated:${partial.id}`)));
    expect(mapping).toContain(first.id);
    expect(mapping).toHaveLength(CHUNKS.length);
  });

  it('Undo of the old placement retires every chunk through the recorded mapping, with nothing left pending', async () => {
    const w = world();
    const at = { x: 120, y: 64, z: 220 };
    const old = w.oldShell(at, 90, 200);
    w.h.reload();
    await w.h.flush();
    const chunks = w.chunkRecords();
    expect(chunks).toHaveLength(CHUNKS.length);
    // The previous pack's Undo record, as the player's dynamic properties keep it: the OLD actor's id, the placement's tag.
    const record = { v: 1, dimension: 'overworld', backups: [], entities: [old.id], bounds: { from: { x: 100, y: 64, z: 200 }, to: { x: 180, y: 84, z: 280 } }, tag: TAG };
    w.h.playerProperties.set(`craftmatic:${w.h.assets.itemId.replace(/^craftmatic:/, '').replace(/_brick_wand$/, '')}:undo`, `1:${JSON.stringify(record)}`);
    await w.h.open({ action: 'Undo last placement' });
    await w.h.flush();
    expect(w.messages().at(-1)).toBe('§b[Brick Wand]§r §aUndo complete.');
    for (const c of chunks) expect(c.sim.valid).toBe(false);
    expect(w.migratedKeys()).toHaveLength(0);
    expect(w.h.world.getDynamicPropertyIds().filter((k: string) => k.includes(':retired:'))).toHaveLength(0);
  });
});
