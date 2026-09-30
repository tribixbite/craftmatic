/**
 * The placement runtime's test host, on the headless simulator
 * (`web/src/sim`): the SERIALISED runtime that ships inside a generated pack
 * runs against the simulator's `@minecraft/server` mock - its voxel world
 * (every collider form registered from the exporter's own block
 * definitions), its entities, its `fillBlocks` / `BlockVolume` / loaded-area
 * semantics and its forms - so the wand's size/aim tests and the
 * collider-scale tests exercise the code the device runs over the same world
 * model the simulator's scenarios use.
 *
 * What stays a test fixture here, on purpose:
 *   - timeouts run on the next microtask (`scheduler: 'immediate'`), so a test
 *     drives the placement with `flush()` and an interval by hand
 *     (`intervals.get(<ticks>)!()`), as the tests were written;
 *   - the actors' entity types are registered as bare definitions (the tests
 *     build the placement assets alone, not a whole pack);
 *   - every spawned entity's `teleport` / `setRotation` / `remove` are spies,
 *     its triggered events are listed on `.events` and its tags on `.tags`,
 *     and `player.sendMessage` is a spy: the assertions the tests make.
 */
import { vi } from 'vitest';
import { buildPlacementPackAssets } from '../web/src/engine/bedrock-placement-pack.js';
import { colliderBlockDefinition } from '../web/src/engine/bedrock-building-shell.js';
import { COLLIDER_KIT } from '../web/src/engine/collider-form.js';
import { SimEngine } from '../web/src/sim/core/engine.js';
import { ControlState } from '../web/src/sim/input/controls.js';
import { ScriptHost } from '../web/src/sim/script-host/host.js';
import type { FormAnswer, ShownForm } from '../web/src/sim/script-host/ui-module.js';
import type { Addon, Pack } from '../web/src/sim/pack/pack.js';
import type { SimEntity } from '../web/src/sim/entity/entity.js';
import type { TerrainGenerator } from '../web/src/sim/world/voxel-world.js';
import { SIZE_STEPS, SIZE_EVENT_PREFIX } from '../web/src/engine/bedrock-placement-pack.js';

/** The tests' world: air everywhere (a test lays what it needs with `blocks.set`). */
const AIR: TerrainGenerator = Object.assign(() => ({ typeId: 'minecraft:air' }), { verticalOnly: true });

/** A bare entity type: the size events (so the wand's resize finds them) and nothing else. */
function bareDefinition(identifier: string): string {
  const groups: Record<string, unknown> = {}, events: Record<string, unknown> = {};
  for (const pct of SIZE_STEPS) { groups[`${SIZE_EVENT_PREFIX}${pct}`] = {}; events[`${SIZE_EVENT_PREFIX}${pct}`] = { add: { component_groups: [`${SIZE_EVENT_PREFIX}${pct}`] } }; }
  return JSON.stringify({ format_version: '1.26.30', 'minecraft:entity': { description: { identifier, is_spawnable: true, is_summonable: true }, components: {}, component_groups: groups, events } });
}

export function host(spec: Parameters<typeof buildPlacementPackAssets>[0]) {
  const assets = buildPlacementPackAssets(spec);
  const enc = new TextEncoder();
  // The pack the simulator loads: the placement script as the entry, every collider form, the actors' types.
  const files = new Map<string, Uint8Array>([['scripts/placement.js', enc.encode(assets.script)]]);
  for (let v = 0; v < COLLIDER_KIT.VARIANTS.length; v++) files.set(`blocks/collider_${v}.json`, enc.encode(JSON.stringify(colliderBlockDefinition(v))));
  const types = new Set([...(spec.actors ?? []).map(a => a.typeId), ...(spec.preview ? [spec.preview.typeId] : []), ...(spec.manualSeatTypeId ? [spec.manualSeatTypeId] : [])]);
  for (const t of types) files.set(`entities/${t.replace(/[^a-z0-9_]/gi, '_')}.json`, enc.encode(bareDefinition(t)));
  const pack: Pack = { kind: 'behavior', folder: 'placement_test_BP', name: 'placement test', uuid: '', version: [], scriptEntry: 'scripts/placement.js', scriptModules: {}, files };
  const addon: Addon = { source: 'test', packs: [pack] };

  const responses: any[] = [];
  const buttons: string[][] = [];
  const chooser = (form: ShownForm): FormAnswer => {
    buttons.push(form.buttons);
    const r = responses.shift() ?? { canceled: true };
    // `{ action: 'Place' }` picks the button whose label starts with it, so a
    // test names what it presses instead of depending on the menu's order.
    if (r.action !== undefined) {
      if (!form.buttons.some(l => l.startsWith(r.action))) throw new Error(`no "${r.action}" button in [${form.buttons.join(' | ')}]`);
      return { button: form.buttons.findIndex(l => l.startsWith(r.action)) };
    }
    if (r.canceled) return { cancel: true };
    if (r.formValues) return { values: r.formValues };
    return { button: r.selection ?? 0 };
  };
  const engine = new SimEngine({ terrain: AIR });
  const sh = new ScriptHost(engine, new ControlState(), { scheduler: 'immediate', chooser });
  engine.loadAddon(addon);
  // The tests' tiles carry no blocks (the assets alone ship no .mcstructure): each loads as an empty structure.
  for (const t of spec.tiles) engine.structures.set(t.identifier, { size: { x: t.width, y: t.height, z: t.length }, palette: [], indices: new Int32Array(t.width * t.height * t.length).fill(-1), extra: new Int32Array(0) });
  const sim = engine.addPlayer('Player', 'overworld', { x: 100, y: 64, z: 200 }, 'player');
  const world: any = sh.builtin('@minecraft/server')!['world'];
  const player: any = sh.entity(sim);
  // The tests move the player by assigning `location` (the API's is read-only).
  Object.defineProperty(player, 'location', { configurable: true, enumerable: true, get: () => ({ ...sim.location }), set: (v: { x: number; y: number; z: number }) => { sim.location = { ...v }; engine.updateLoaded(); } });
  player.sendMessage = vi.fn(player.sendMessage);
  let hit: any;
  player.getBlockFromViewDirection = () => hit;
  // Everything the tests aim at is loaded (the old host spawned anywhere): one ticking area over the tests' whole world.
  engine.tickingAreas.set('test-world', { name: 'test-world', dimension: 'minecraft:overworld', x0: -1024, z0: -1024, x1: 1024, z1: 1024 });
  engine.updateLoaded();

  // What the tests read back.
  const spawned: Array<{ typeId: string; at: any; entity: any }> = [];
  engine.on('entitySpawn', ({ entity }: { entity: SimEntity }) => {
    if (entity.isPlayer) return;
    const e: any = sh.entity(entity);
    e.events = [] as string[];
    const trigger = e.triggerEvent;
    e.triggerEvent = (ev: string) => { e.events.push(ev); return trigger(ev); };
    e.teleport = vi.fn(e.teleport);
    e.setRotation = vi.fn(e.setRotation);
    e.remove = vi.fn(e.remove);
    Object.defineProperty(e, 'tags', { configurable: true, get: () => [...entity.tags] });
    // A failed assertion prints its values: a removed entity's getters throw (as the API's do), so print a summary.
    e.toJSON = () => ({ id: entity.id, typeId: entity.typeId, valid: entity.valid });
    // `entity` is not enumerable: a deep comparison of two records (`not.toBe` computes one for its hint) would
    // otherwise walk a removed entity's getters, which throw as the API's do.
    const record = { typeId: entity.typeId, at: { ...entity.location } } as { typeId: string; at: any; entity: any };
    Object.defineProperty(record, 'entity', { value: e, enumerable: false });
    spawned.push(record);
  });
  const set: Array<{ pos: any; states: any }> = [];
  const w = engine.dimension('overworld');
  w.onWrite = (x, y, z, p) => { set.push({ pos: { x, y, z }, states: p.states }); };
  const dimension: any = sh.dimensionApi('overworld');
  const fills: Array<{ from: any; to: any; block: string; options?: unknown }> = [];
  const fill = dimension.fillBlocks;
  dimension.fillBlocks = (volume: any, block: string, options?: unknown) => {
    const r = fill(volume, block, options);
    fills.push({ from: { ...volume.from }, to: { ...volume.to }, block, options });
    return r;
  };
  sh.loadScripts(addon);

  /** The blocks the runtime (or the test) set, as the old host's Map: `"x,y,z"` → a block with `typeId` and `permutation.getState`. */
  const blocks = {
    get: (k: string) => {
      if (!w.writes.has(k)) return undefined;
      const [x, y, z] = k.split(',').map(Number) as [number, number, number];
      const p = w.permutationAt(x, y, z);
      return p.id === 0 ? undefined : { typeId: p.typeId, states: p.states, isAir: false, permutation: { getState: (s: string) => p.states[s] } };
    },
    has: (k: string) => blocks.get(k) !== undefined,
    /** Lay a block: a test's stand-in `{ typeId, permutation.getState }` becomes the real permutation (its collider states read back). */
    set: (k: string, b: { typeId: string; states?: Record<string, number>; permutation?: { getState(s: string): unknown } }) => {
      const [x, y, z] = k.split(',').map(Number) as [number, number, number];
      const states: Record<string, number> = { ...(b.states ?? {}) };
      if (/^craftmatic:collider/.test(b.typeId) && b.permutation) for (const s of ['craftmatic:lo', 'craftmatic:hi']) { const v = b.permutation.getState(s); if (typeof v === 'number') states[s] = v; }
      w.setPermutation(x, y, z, sh.resolvePermutation(b.typeId, states));
      return blocks;
    },
    delete: (k: string) => { const [x, y, z] = k.split(',').map(Number) as [number, number, number]; w.setPermutation(x, y, z, sh.resolvePermutation('minecraft:air')); return true; },
    *entries() { for (const k of w.writes.keys()) { const b = blocks.get(k); if (b) yield [k, b] as [string, NonNullable<ReturnType<typeof blocks.get>>]; } },
    *keys() { for (const [k] of blocks.entries()) yield k; },
    *values() { for (const [, b] of blocks.entries()) yield b; },
    [Symbol.iterator]() { return blocks.entries(); },
    forEach(fn: (b: NonNullable<ReturnType<typeof blocks.get>>, k: string) => void) { for (const [k, b] of blocks.entries()) fn(b, k); },
    get size() { return [...blocks.entries()].length; },
  };
  const commands = (): string[] => engine.timeline.of('command').map(e => e.text).filter(c => !/^tickingarea /.test(c));
  const actionBars = (): string[] => engine.timeline.of('actionbar').map(e => e.text);
  const intervals = new Map<number, () => void>();
  for (const r of sh.scheduler.intervals()) intervals.set(r.every, r.fn);

  const flush = async (turns = 400) => { for (let i = 0; i < turns; i++) await Promise.resolve(); };
  /** Use the wand once, answering nothing: the first use of a fresh wand starts "Follow my aim". */
  const useWand = async () => { sh.deliver('itemUse', { itemStack: { typeId: assets.itemId }, source: player }); await flush(); };
  /**
   * Open the wand's MENU and answer its forms with `r`. A fresh wand's first
   * use shows no menu (it starts following the aim), so when that use drew no
   * form the wand is used once more - as a player would - to reach the menu.
   */
  const open = async (...r: any[]) => {
    const shown = buttons.length;
    responses.push(...r);
    await useWand();
    if (r.length && buttons.length === shown) await useWand();
  };
  return {
    assets, world, open, use: useWand, flush, intervals, spawned, set, player, buttons, blocks, fills, engine, host: sh,
    get commands() { return commands(); },
    get actionBars() { return actionBars(); },
    playerProperties: sim.dynamic,
    setHit: (h: any) => { hit = h; },
  };
}
