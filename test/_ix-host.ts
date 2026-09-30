/**
 * A host for the serialised moving-parts runtime (`scripts/interactives.js`),
 * on the headless simulator (test/_sim-host.ts): the pack's collider kit, one
 * entity type per moving part as the exporter declares it
 * (`interactiveBehavior`: its angle / turn / size properties, its tap-box
 * groups and events), a flying Creative player whose eyes and view are its
 * own pose, and the runtime's two tap events raised the way the input module
 * raises them. Shared by the unit tests and by the CLI probes that load a REAL
 * pack's config (`scripts/_ix_tap_probe.ts`, `scripts/_ix_host_trace.ts`), so
 * it depends on nothing test-runner specific.
 *
 * What a tap is here: the engine's `entityHitEntity` on the part (a touch tap
 * Bedrock handed to that part; which box the finger landed on is the caller's
 * choice, as on the device), then the tick it is delivered in; the runtime's
 * cooldown between taps (6 ticks) is waited out after each one.
 */
import { INTERACTIVE_PROPERTY, interactiveBehavior, interactivesScript, type InteractiveRuntimeConfig, type SceneInteractive } from '../web/src/engine/bedrock-interactives.js';
import { COLLIDER_KIT } from '../web/src/engine/collider-form.js';
import { lookAt, interact as touchInteract } from '../web/src/sim/input/touch.js';
import type { SimEntity } from '../web/src/sim/entity/entity.js';
import type { EntityDefinitionSpec } from '../web/src/sim/pack/fixture.js';
import { simHost } from './_sim-host.js';

type Vec = { x: number; y: number; z: number };

/**
 * A spawned moving part: its facade (what the runtime holds) with the test's
 * readings attached - `angle` (the INTERACTIVE_PROPERTY actor property; set to
 * undefined to put it back to its declared default, the client's state before
 * any runtime wrote it), `actorProps` (every actor property), `events` (every
 * event the runtime triggered on it).
 */
export interface IxHostEntity {
  id: string; typeId: string; location: Vec;
  angle: number | undefined; actorProps: Map<string, number | boolean | string>; events: string[];
  getDynamicProperty(k: string): unknown; setDynamicProperty(k: string, v: unknown): void;
  [k: string]: unknown;
}

/** A block as the tests read it back: its type and states. */
export interface IxBlock { typeId: string; states: Record<string, string | number | boolean> }

/** Ticks the runtime ignores a second tap on the same part (its `lastUse` window). */
const TAP_COOLDOWN_TICKS = 6;
/** The runtime's sync interval (a fresh part is laid, a reloaded one re-asserted, every 10 ticks). */
const SYNC_TICKS = 10;

export interface RuntimeHostOptions {
  /** More entity types in the world (a seat a tap may be handed to), by identifier. */
  types?: Record<string, EntityDefinitionSpec | Record<string, unknown>>;
}

export function runtimeHost(cfg: InteractiveRuntimeConfig, options: RuntimeHostOptions = {}) {
  // One type per moving part, as the exporter writes it (the first item of a type gives its kind and tap boxes).
  const entities: Record<string, EntityDefinitionSpec | Record<string, unknown>> = { ...(options.types ?? {}) };
  for (const it of cfg.items) {
    if (entities[it.type]) continue;
    const hit = { closed: it.hit?.c ?? [], open: it.hit?.o ?? [] };
    entities[it.type] = interactiveBehavior(it.type, { kind: it.kind } as SceneInteractive, hit) as Record<string, unknown>;
  }
  // The world the tests use spans the origin and (100, 64, 200); a smaller loaded square keeps a tick cheap.
  const h = simHost({ script: interactivesScript(cfg), entities, colliders: true, loadRadius: 256 });
  const dim = h.dimension();

  /** Every sound the runtime played, in order. */
  const sounds: string[] = [];
  const playSound = dim.playSound;
  dim.playSound = (id: string, ...rest: unknown[]) => { sounds.push(id); return playSound(id, ...rest); };

  // The player: a Creative player flying (it hangs where a test stands it), far from the parts until aimed.
  const psim = h.addPlayer('Player', { x: 0.5, y: 0, z: 0.5 });
  psim.flying = true;
  const player = h.api(psim);
  // A test stands the player by assigning `location` (the API's is read-only).
  Object.defineProperty(player, 'location', { configurable: true, enumerable: true, get: () => ({ ...psim.location }), set: (v: Vec) => { psim.location = { ...v }; h.engine.updateLoaded(); } });
  /** Every point the runtime stepped the player to. */
  const teleports: Vec[] = [];
  const teleport = player.teleport;
  player.teleport = (to: Vec, opts?: unknown) => { teleports.push({ ...to }); return teleport(to, opts); };

  /** Lay a collider (variant `v` is a clearance form, collider-form.ts; 0 or absent: the full collider). */
  const setCollider = (x: number, y: number, z: number, lo: number, hi: number, v = 0): void => {
    h.setBlock(x, y, z, v ? COLLIDER_KIT.VARIANTS[v]!.id : cfg.colliders.block, { [cfg.colliders.loState]: lo, [cfg.colliders.hiState]: hi });
  };

  /** The blocks written in the world (runtime or test), `"x,y,z"` → type and states; air is absent. */
  const read = (): Map<string, IxBlock> => {
    const out = new Map<string, IxBlock>();
    for (const [k, p] of h.writes()) if (p.typeId !== 'minecraft:air') out.set(k, { typeId: p.typeId, states: { ...p.states } });
    return out;
  };
  const at = (k: string): [number, number, number] => k.split(',').map(Number) as [number, number, number];
  const blocks = {
    get: (k: string): IxBlock | undefined => read().get(k),
    has: (k: string): boolean => read().has(k),
    /** Lay a block: a player's own (`minecraft:stone`), or a collider with its states. */
    set: (k: string, b: IxBlock) => { const [x, y, z] = at(k); h.setBlock(x, y, z, b.typeId, b.states); return blocks; },
    delete: (k: string): boolean => { const [x, y, z] = at(k); const had = read().has(k); h.setBlock(x, y, z, 'minecraft:air'); return had; },
    entries: () => read().entries(),
    keys: () => read().keys(),
    values: () => read().values(),
    forEach: (fn: (b: IxBlock, k: string) => void) => { for (const [k, b] of read()) fn(b, k); },
    [Symbol.iterator]: () => read().entries(),
    get size(): number { return read().size; },
  };

  const spawn = (item: number, anchor: Vec, f = 1, r = 0, where?: Vec): IxHostEntity => {
    const e = h.spawn(cfg.items[item]!.type, where ?? anchor, { dynamic: { 'craftmatic:ix': item, 'craftmatic:ix_anchor': { ...anchor }, 'craftmatic:ix_rotation': r, 'craftmatic:ix_scale': f } });
    return partRecord(e);
  };
  /** The facade of a part with the readings a test asserts on. */
  const partRecord = (e: SimEntity): IxHostEntity => {
    const api = h.api(e);
    if (api.events) return api as IxHostEntity;
    const events: string[] = [];
    const trigger = api.triggerEvent;
    api.triggerEvent = (ev: string) => { events.push(ev); return trigger(ev); };
    Object.defineProperty(api, 'events', { configurable: true, value: events });
    Object.defineProperty(api, 'actorProps', { configurable: true, value: e.properties });
    Object.defineProperty(api, 'angle', {
      configurable: true,
      get: () => e.properties.get(INTERACTIVE_PROPERTY) as number | undefined,
      set: (v: number | undefined) => { const d = e.def?.properties[INTERACTIVE_PROPERTY]?.default; e.properties.set(INTERACTIVE_PROPERTY, v ?? (d as number)); },
    });
    return api as IxHostEntity;
  };

  /** Stand the player with its eyes at `head`, looking at `at` (the camera; a tap's finger is the caller's). */
  const aim = (head: Vec, target: Vec): void => {
    psim.location = { x: head.x, y: head.y - 1.62, z: head.z };
    lookAt(psim, target);
    h.engine.updateLoaded();
  };
  const simOf = (e: unknown): SimEntity => { const s = h.simOf(e); if (!s) throw new Error('not an entity of this host'); return s; };
  /** Deliver what the events raised, then wait out the tap cooldown. */
  const settle = (): void => { h.run(1); h.run(TAP_COOLDOWN_TICKS - 1); };
  return {
    host: h, blocks, setCollider, spawn, sounds, player, playerSim: psim, teleports, aim,
    /** Reopen the world: the runtime loaded again into a fresh context over the same blocks and entities. */
    load: (): void => { h.reload(); },
    /** Run the runtime's sync pass once (a sync interval's worth of ticks). */
    sync: (): void => { h.run(SYNC_TICKS); },
    /** Every action-bar line the player was shown. */
    get bars(): string[] { return h.lines('actionbar', 'Player'); },
    /** A touch tap on the part: a hit (quirk `tap-is-hit`). */
    tap: (e: unknown): void => { h.engine.emit('entityHitEntity', { damagingEntity: psim, hitEntity: simOf(e) }); settle(); },
    /** A held press on the part: the interact (quirk `hold-is-interact`), before-event first. */
    interact: (e: unknown): void => { touchInteract(h.engine, psim, simOf(e), (p, t) => h.host.before('playerInteractWithEntity', { player: h.api(p), target: h.api(t) })); settle(); },
    /** A tap Bedrock reported twice in one tick: the interact and the hit. */
    interactTwice: (e: unknown): void => {
      touchInteract(h.engine, psim, simOf(e), (p, t) => h.host.before('playerInteractWithEntity', { player: h.api(p), target: h.api(t) }));
      h.engine.emit('entityHitEntity', { damagingEntity: psim, hitEntity: simOf(e) });
      settle();
    },
    lastBar: (): string | undefined => h.lines('actionbar', 'Player').at(-1),
  };
}
