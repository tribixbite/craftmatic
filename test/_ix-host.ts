/**
 * A host for the serialised moving-parts runtime (`scripts/interactives.js`),
 * run as the device runs it: a block map, entities with dynamic and actor
 * properties, a player with a head and a view direction, and the two events
 * the runtime subscribes to. Shared by the unit tests and by the CLI probes
 * that load a REAL pack's config (`scripts/_ix_tap_probe.ts`), so it depends
 * on nothing test-runner specific.
 */
import { INTERACTIVE_PROPERTY, interactivesScript, type InteractiveRuntimeConfig } from '../web/src/engine/bedrock-interactives.js';

export interface IxHostEntity {
  id: string; typeId: string; families: string[]; location: { x: number; y: number; z: number };
  angle: number | undefined; actorProps: Map<string, number>; events: string[];
  props: Map<string, unknown>;
  getDynamicProperty(k: string): unknown; setDynamicProperty(k: string, v: unknown): void;
  setProperty(k: string, v: number): void; triggerEvent(ev: string): void;
  [k: string]: unknown;
}

export function runtimeHost(cfg: InteractiveRuntimeConfig) {
  const blocks = new Map<string, { typeId: string; states: Record<string, number> }>();
  const setCollider = (x: number, y: number, z: number, lo: number, hi: number): void => { blocks.set(`${x},${y},${z}`, { typeId: cfg.colliders.block, states: { [cfg.colliders.loState]: lo, [cfg.colliders.hiState]: hi } }); };
  const blockAt = (pos: { x: number; y: number; z: number }) => {
    const key = `${pos.x},${pos.y},${pos.z}`;
    const cur = blocks.get(key) ?? { typeId: 'minecraft:air', states: {} };
    return {
      typeId: cur.typeId, isAir: cur.typeId === 'minecraft:air',
      permutation: { getState: (k: string) => cur.states[k] },
      setPermutation: (perm: { id: string; states: Record<string, number> }) => { if (perm.id === 'minecraft:air') blocks.delete(key); else blocks.set(key, { typeId: perm.id, states: { ...perm.states } }); },
    };
  };
  const entities: IxHostEntity[] = [];
  const players: any[] = [];
  const sounds: string[] = [];
  const dim: any = {
    id: 'minecraft:overworld',
    getBlock: (pos: any) => blockAt(pos),
    getEntities: (q: any) => [...entities, ...players].filter(e => (!q?.families || (e.families ?? []).some((f: string) => q.families.includes(f)))
      && (!q?.location || Math.hypot(e.location.x - q.location.x, e.location.y - q.location.y, e.location.z - q.location.z) <= (q.maxDistance ?? Infinity))),
    playSound: (id: string) => { sounds.push(id); },
  };
  const spawn = (item: number, anchor: { x: number; y: number; z: number }, f = 1, r = 0, at?: { x: number; y: number; z: number }): IxHostEntity => {
    const props = new Map<string, unknown>([['craftmatic:ix', item], ['craftmatic:ix_anchor', anchor], ['craftmatic:ix_rotation', r], ['craftmatic:ix_scale', f]]);
    const e: IxHostEntity = {
      id: `e${entities.length}`, typeId: cfg.items[item]!.type, families: [cfg.family], dimension: dim, location: at ?? { ...anchor },
      angle: undefined,
      actorProps: new Map<string, number>(), events: [],
      getDynamicProperty: (k: string) => props.get(k), setDynamicProperty: (k: string, v: unknown) => { props.set(k, v); },
      setProperty: (k: string, v: number) => { e.actorProps.set(k, v); if (k === INTERACTIVE_PROPERTY) e.angle = v; },
      triggerEvent: (ev: string) => { e.events.push(ev); },
      props,
    };
    entities.push(e);
    return e;
  };
  let tickFn: () => void = () => {};
  let interactFn: (ev: any) => void = () => {};
  let hitFn: (ev: any) => void = () => {};
  const system = { currentTick: 0, runInterval: (cb: () => void) => { tickFn = cb; }, run: (cb: () => void) => cb() };
  const world = {
    getDimension: (name: string) => (name === 'overworld' ? dim : { getEntities: () => [] }),
    afterEvents: { playerInteractWithEntity: { subscribe: (cb: any) => { interactFn = cb; } }, entityHitEntity: { subscribe: (cb: any) => { hitFn = cb; } } },
  };
  const BlockPermutation = { resolve: (id: string, states: Record<string, number> = {}) => ({ id, states }) };
  const load = (): void => {
    const script = interactivesScript(cfg).replace(/^import .*;\n/, '');
    const console = { warn: () => {} };
    new Function('world', 'system', 'BlockPermutation', 'console', script)(world, system, BlockPermutation, console);
  };
  load();
  /** What the runtime printed to the action bar, in order. */
  const bars: string[] = [];
  const teleports: Array<{ x: number; y: number; z: number }> = [];
  const player: any = {
    typeId: 'minecraft:player', id: 'p1', location: { x: 0, y: 0, z: 0 },
    onScreenDisplay: { setActionBar: (s: string) => { bars.push(s); } },
    teleport: (to: any) => { teleports.push({ ...to }); player.location = { ...to }; },
  };
  /** Aim the player: eyes at `head`, looking at `at` (a tap is the view ray, as on the device). */
  const aim = (head: { x: number; y: number; z: number }, at: { x: number; y: number; z: number }): void => {
    const d = { x: at.x - head.x, y: at.y - head.y, z: at.z - head.z }, n = Math.hypot(d.x, d.y, d.z) || 1;
    player.getHeadLocation = () => ({ ...head });
    player.getViewDirection = () => ({ x: d.x / n, y: d.y / n, z: d.z / n });
    player.location = { x: head.x, y: head.y - 1.62, z: head.z };
  };
  return {
    blocks, setCollider, spawn, sounds, player, players, entities, load, bars, teleports, aim,
    sync: () => tickFn(),
    tap: (e: any) => { system.currentTick += 10; hitFn({ damagingEntity: player, hitEntity: e }); },
    interact: (e: any) => { system.currentTick += 10; interactFn({ player, target: e }); },
    interactTwice: (e: any) => { system.currentTick += 10; interactFn({ player, target: e }); hitFn({ damagingEntity: player, hitEntity: e }); },
    lastBar: () => bars.at(-1),
  };
}
