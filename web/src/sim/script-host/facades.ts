/**
 * The Script API's objects - `Entity`, `Player`, `Dimension`, `Block`,
 * `BlockPermutation`, the entity components, `Structure` - as FACADES over the
 * engine's state. Each facade is wrapped by `guard` (unmodelled.ts): members
 * implemented here answer as the game does; members of the real API not
 * implemented throw `UnmodelledError` and are recorded.
 *
 * Semantics follow @minecraft/server 2.9 (the version the packs declare) and
 * the quirk registry; every departure is a `# TODO(sim-api)` at its member.
 */

import { copy, lookAngles, rotateYaw, viewDirection, type Vec3 } from '../core/vec.js';
import type { SimEngine } from '../core/engine.js';
import type { Timeline } from '../core/timeline.js';
import type { SimEntity } from '../entity/entity.js';
import type { ControlState } from '../input/controls.js';
import { raycastBlocks, raycastEntities } from '../input/ray.js';
import { quirkValue } from '../quirks/registry.js';
import { setDownRider } from '../physics/systems.js';
import type { BlockStates } from '../world/block-types.js';
import type { Permutation, VoxelWorld } from '../world/voxel-world.js';
import { guard, unmodelled } from './unmodelled.js';
import { messageText } from './text.js';

/** What the facades need from the host. */
export interface FacadeHost {
  engine: SimEngine;
  timeline: Timeline;
  controls: ControlState;
  entity(sim: SimEntity): Record<string, unknown>;
  simOf(api: unknown): SimEntity | undefined;
  dimensionApi(id: string): Record<string, unknown>;
  runCommand(dimension: string, command: string, source?: SimEntity): { successCount: number };
  /** Player-only state the facades keep: slot, inventory, camera, control scheme. */
  playerState(sim: SimEntity): PlayerExtra;
  /** A permutation facade. */
  permutation(p: Permutation): Record<string, unknown>;
  /** Resolve a type and states to an interned permutation, validating as the game does. */
  resolvePermutation(typeId: string, states?: BlockStates): Permutation;
  /** Sound and particle counters (not timeline entries: they are too many). */
  stats: Map<string, number>;
}

/** A player's hands and head-up state. */
export interface PlayerExtra {
  selectedSlot: number;
  /** Hotbar and inventory item type ids by slot. */
  items: Array<string | undefined>;
  controlScheme?: string;
  /** Camera state the scripts set (`setCamera` preset and rotation), for the rider-pose checks. */
  camera: { preset?: string; rotation?: { x: number; y: number }; location?: Vec3; animation?: string; tick: number };
  permissions: Map<string, boolean>;
}

const isVec = (v: unknown): v is Vec3 => !!v && typeof v === 'object' && ['x', 'y', 'z'].every(k => typeof (v as Record<string, unknown>)[k] === 'number');

/** The error the API throws for a removed entity. */
const invalidEntity = (sim: SimEntity): Error => Object.assign(new Error(`Failed to access a member of entity ${sim.typeId} (${sim.id}): it is not valid (removed or unloaded)`), { name: 'InvalidEntityError' });

/** Entity filter of `getEntities` / `matches`. */
export function entityMatches(e: SimEntity, q: Record<string, unknown>, origin?: Vec3): boolean {
  const families = e.families();
  const typeOk = (t: unknown): boolean => typeof t !== 'string' || e.typeId === t || e.typeId === `minecraft:${t}`;
  if (q['type'] !== undefined && !typeOk(q['type'])) return false;
  if (Array.isArray(q['excludeTypes']) && (q['excludeTypes'] as string[]).some(t => e.typeId === t)) return false;
  if (Array.isArray(q['families']) && !(q['families'] as string[]).every(f => families.includes(f))) return false;
  if (Array.isArray(q['excludeFamilies']) && (q['excludeFamilies'] as string[]).some(f => families.includes(f))) return false;
  if (Array.isArray(q['tags']) && !(q['tags'] as string[]).every(t => e.tags.has(t))) return false;
  if (Array.isArray(q['excludeTags']) && (q['excludeTags'] as string[]).some(t => e.tags.has(t))) return false;
  if (typeof q['name'] === 'string' && e.nameTag !== q['name']) return false;
  const at = (q['location'] as Vec3 | undefined) ?? origin;
  if (at && (typeof q['maxDistance'] === 'number' || typeof q['minDistance'] === 'number')) {
    const d = Math.hypot(e.location.x - at.x, e.location.y - at.y, e.location.z - at.z);
    if (typeof q['maxDistance'] === 'number' && d > (q['maxDistance'] as number)) return false;
    if (typeof q['minDistance'] === 'number' && d < (q['minDistance'] as number)) return false;
  }
  if (isVec(q['volume']) && isVec(q['location'])) {
    const l = q['location'] as Vec3, v = q['volume'] as Vec3;
    if (e.location.x < l.x || e.location.x > l.x + v.x || e.location.y < l.y || e.location.y > l.y + v.y || e.location.z < l.z || e.location.z > l.z + v.z) return false;
  }
  return true;
}

/** Apply `closest` / `farthest` to a filtered list. */
export function sortQuery(list: SimEntity[], q: Record<string, unknown>): SimEntity[] {
  const at = q['location'] as Vec3 | undefined;
  if (!at) return list;
  const d = (e: SimEntity): number => Math.hypot(e.location.x - at.x, e.location.y - at.y, e.location.z - at.z);
  if (typeof q['closest'] === 'number') return [...list].sort((a, b) => d(a) - d(b)).slice(0, q['closest'] as number);
  if (typeof q['farthest'] === 'number') return [...list].sort((a, b) => d(b) - d(a)).slice(0, q['farthest'] as number);
  return list;
}

// ─── Entity and Player ───────────────────────────────────────────────────────

/** Build the facade of an engine entity (the host caches it: one object per entity, as scripts compare them). */
export function entityFacade(host: FacadeHost, sim: SimEntity): Record<string, unknown> {
  const { engine, timeline } = host;
  const live = (): SimEntity => { if (!sim.valid) throw invalidEntity(sim); return sim; };
  const world = (): VoxelWorld => engine.dimension(sim.dimension);
  const f: Record<string, unknown> = {
    get id() { return sim.id; },
    get typeId() { return sim.typeId; },
    get isValid() { return sim.valid && engine.isEntityLoaded(sim); },
    get location() { return copy(live().location); },
    get dimension() { return host.dimensionApi(live().dimension); },
    get nameTag() { return live().nameTag; },
    set nameTag(v: string) { live().nameTag = String(v); },
    get isSneaking() { return sim.isPlayer ? host.controls.get(sim.id).sneak : false; },
    set isSneaking(_v: boolean) { throw unmodelled(timeline, 'Entity.isSneaking (set)'); },
    get isOnGround() { return live().onGround; },
    get isFalling() { return !live().onGround && live().velocity.y < 0; },
    get isInWater() { return world().shapeAt(sim.location.x, sim.location.y, sim.location.z).isLiquid; },
    get isClimbing() { return false; },
    get isSprinting() { return sim.isPlayer ? host.controls.get(sim.id).sprint : false; },
    get isSwimming() { return false; },
    get isSleeping() { return false; },
    get localizationKey() { return `entity.${sim.typeId.replace(/^minecraft:/, '')}.name`; },
    getRotation: () => ({ ...live().rotation }),
    setRotation: (r: { x?: number; y?: number }) => { const s = live(); s.rotation = { x: r.x ?? s.rotation.x, y: r.y ?? s.rotation.y }; },
    teleport: (loc: Vec3, opts?: Record<string, unknown>) => { teleport(host, live(), loc, opts); },
    tryTeleport: (loc: Vec3, opts?: Record<string, unknown>) => {
      const s = live();
      if (opts?.['checkForBlocks']) {
        const { width, height } = s.collisionSize(), h = width / 2;
        const target = opts['dimension'] ? String((opts['dimension'] as { id: string }).id) : s.dimension;
        const w = engine.dimension(target);
        if (!w.isLoaded(loc.x, loc.z)) return false;
        if (w.overlapping({ x0: loc.x - h, y0: loc.y, z0: loc.z - h, x1: loc.x + h, y1: loc.y + height, z1: loc.z + h })) return false;
      }
      teleport(host, s, loc, opts);
      return true;
    },
    remove: () => { engine.removeEntity(live()); },
    kill: () => { engine.removeEntity(live()); return true; },
    getComponent: (name: string) => componentFacade(host, live(), name),
    hasComponent: (name: string) => { const id = name.includes(':') ? name : `minecraft:${name}`; return id in live().components || (sim.isPlayer && ['minecraft:inventory', 'minecraft:riding'].includes(id)); },
    addTag: (t: string) => { const had = live().tags.has(t); sim.tags.add(t); return !had; },
    removeTag: (t: string) => live().tags.delete(t),
    hasTag: (t: string) => live().tags.has(t),
    getTags: () => [...live().tags],
    getDynamicProperty: (k: string) => { const v = live().dynamic.get(k); return v && typeof v === 'object' ? { ...(v as object) } : v; },
    setDynamicProperty: (k: string, v?: unknown) => { setDynamic(timeline, live().dynamic, k, v); },
    getDynamicPropertyIds: () => [...live().dynamic.keys()],
    clearDynamicProperties: () => { live().dynamic.clear(); },
    getProperty: (k: string) => {
      const s = live();
      if (s.def?.propertiesRefused) return undefined;
      if (!s.def?.properties[k]) throw new Error(`Entity ${s.typeId} has no property ${k}`);
      return s.properties.get(k);
    },
    setProperty: (k: string, v: number | boolean | string) => { setActorProperty(live(), k, v); },
    resetProperty: (k: string) => { const s = live(); const d = s.def?.properties[k]; if (!d) throw new Error(`Entity ${s.typeId} has no property ${k}`); s.properties.set(k, d.default); return d.default; },
    triggerEvent: (ev: string) => {
      const s = live();
      const r = s.triggerEvent(ev);
      if (!r.known) timeline.add('note', `triggerEvent ${ev}: ${s.typeId} has no such event`, withSource(timeline));
      for (const k of r.unmodelled) timeline.unmodelled(`entity-event:${k}`, timeline.callerSource());
    },
    getVelocity: () => copy(live().velocity),
    applyImpulse: (v: Vec3) => { const s = live(); s.velocity = { x: s.velocity.x + v.x, y: s.velocity.y + v.y, z: s.velocity.z + v.z }; },
    clearVelocity: () => { live().velocity = { x: 0, y: 0, z: 0 }; },
    addEffect: (id: string | { id: string }, duration: number, opts?: { amplifier?: number; showParticles?: boolean }) => {
      const s = live(), key = normaliseEffect(typeof id === 'string' ? id : id.id);
      s.effects.set(key, { id: key, duration: Math.max(1, Math.floor(duration)), amplifier: opts?.amplifier ?? 0, showParticles: opts?.showParticles ?? true });
      return effectFacade(host, s, key);
    },
    removeEffect: (id: string) => live().effects.delete(normaliseEffect(id)),
    getEffect: (id: string) => (live().effects.has(normaliseEffect(id)) ? effectFacade(host, sim, normaliseEffect(id)) : undefined),
    getEffects: () => [...live().effects.keys()].map(k => effectFacade(host, sim, k)),
    getHeadLocation: () => live().headLocation(),
    getViewDirection: () => viewDirection(live().rotation.y, live().rotation.x),
    lookAt: (t: Vec3) => { const s = live(); const h = s.headLocation(); const a = lookAngles({ x: t.x - h.x, y: t.y - h.y, z: t.z - h.z }); s.rotation = { x: a.pitch, y: a.yaw }; },
    playAnimation: (name: string) => { timeline.add('event', `playAnimation ${name}`, { ...withSource(timeline), target: sim.id }); },
    runCommand: (cmd: string) => host.runCommand(live().dimension, cmd, sim),
    matches: (q: Record<string, unknown>) => entityMatches(live(), q ?? {}),
    getAABB: () => { const b = live().aabb(); return { center: { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2, z: (b.z0 + b.z1) / 2 }, extent: { x: (b.x1 - b.x0) / 2, y: (b.y1 - b.y0) / 2, z: (b.z1 - b.z0) / 2 } }; },
    getBlockFromViewDirection: (opts?: { maxDistance?: number; includePassableBlocks?: boolean; includeLiquidBlocks?: boolean }) => {
      const s = live(), head = s.headLocation(), dir = viewDirection(s.rotation.y, s.rotation.x);
      const hit = raycastBlocks(world(), head, dir, opts?.maxDistance ?? 128, { includePassable: opts?.includePassableBlocks === true, includeLiquid: opts?.includeLiquidBlocks === true });
      if (!hit) return undefined;
      return { block: blockFacade(host, s.dimension, hit.x, hit.y, hit.z), face: hit.face, faceLocation: { x: hit.point.x - hit.x, y: hit.point.y - hit.y, z: hit.point.z - hit.z } };
    },
    getEntitiesFromViewDirection: (opts?: { maxDistance?: number }) => {
      const s = live(), head = s.headLocation(), dir = viewDirection(s.rotation.y, s.rotation.x);
      return raycastEntities(engine.loadedEntities(s.dimension), head, dir, opts?.maxDistance ?? 16, s).map(h => ({ entity: host.entity(h.entity), distance: h.distance }));
    },
  };
  // A player adds its own members; property descriptors are copied (not values) so the getters stay live.
  return guard(defineAccessors(f, sim.isPlayer ? playerMembers(host, sim, live) : {}), sim.isPlayer ? 'Player' : 'Entity', timeline);
}

/** `Object.assign` flattens getters into values; copy property descriptors instead. */
function defineAccessors(base: Record<string, unknown>, extra: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const src of [base, extra]) for (const k of Object.keys(src)) Object.defineProperty(out, k, { ...Object.getOwnPropertyDescriptor(src, k)!, configurable: true, enumerable: true });
  return out;
}

const withSource = (timeline: Timeline): { source?: string } => { const s = timeline.callerSource(); return s ? { source: s } : {}; };

function normaliseEffect(id: string): string { return id.startsWith('minecraft:') ? id : `minecraft:${id}`; }

function effectFacade(host: FacadeHost, sim: SimEntity, key: string): Record<string, unknown> {
  const fx = (): { duration: number; amplifier: number } => sim.effects.get(key) ?? { duration: 0, amplifier: 0 };
  return guard({ get typeId() { return key; }, get duration() { return fx().duration; }, get amplifier() { return fx().amplifier; }, get displayName() { return key; }, get isValid() { return sim.effects.has(key); } }, 'Effect', host.timeline);
}

/** Dynamic property write: the API's value types and the string limit (quirk `dynamic-property-string-limit`). */
function setDynamic(timeline: Timeline, store: Map<string, unknown>, key: string, value: unknown): void {
  if (value === undefined) { store.delete(key); return; }
  if (typeof value === 'string' && value.length > quirkValue('dynamic-property-string-limit', 'maxChars')) {
    timeline.add('note', `setDynamicProperty ${key}: ${value.length} characters exceeds the limit`, withSource(timeline));
    throw new Error(`Dynamic property ${key} string is too long (${value.length} > ${quirkValue('dynamic-property-string-limit', 'maxChars')})`);
  }
  if (!(typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || isVec(value))) throw new TypeError(`Dynamic property ${key}: unsupported value type ${typeof value}`);
  store.set(key, isVec(value) ? copy(value) : value);
}

/** Actor property write, type-checked against the declaration (and refused when the component was dropped). */
function setActorProperty(sim: SimEntity, key: string, value: number | boolean | string): void {
  if (sim.def?.propertiesRefused) throw new Error(`Entity ${sim.typeId} has no property component (it was refused at load): cannot set ${key}`);
  const d = sim.def?.properties[key];
  if (!d) throw new Error(`Entity ${sim.typeId} has no property ${key}`);
  if ((d.type === 'float' || d.type === 'int') && (typeof value !== 'number' || !Number.isFinite(value))) throw new TypeError(`Property ${key} is ${d.type}; got ${typeof value}`);
  if (d.type === 'int' && !Number.isInteger(value)) throw new TypeError(`Property ${key} is int; got ${value}`);
  if (d.type === 'bool' && typeof value !== 'boolean') throw new TypeError(`Property ${key} is bool; got ${typeof value}`);
  if (d.type === 'enum' && (typeof value !== 'string' || (d.values && !d.values.includes(value)))) throw new TypeError(`Property ${key} is enum; got ${String(value)}`);
  // # TODO(sim-api): out-of-range numbers are clamped here; the device's behaviour (clamp or throw) is not measured.
  const v = typeof value === 'number' && d.range ? Math.max(d.range[0], Math.min(d.range[1], value)) : value;
  sim.properties.set(key, v);
}

/** Teleport semantics: a riding player is dismounted (quirk `tp-dismounts`); a ridden entity carries its riders. */
export function teleport(host: FacadeHost, sim: SimEntity, loc: Vec3, opts?: Record<string, unknown>): void {
  if (!isVec(loc) || ![loc.x, loc.y, loc.z].every(Number.isFinite)) throw new TypeError('teleport: location must be a finite Vector3');
  if (sim.ridingOn && sim.isPlayer) {
    const mount = sim.ridingOn;
    mount.removeRider(sim);
    host.engine.emit('dismounted', { rider: sim, mount, cause: 'teleport' });
  }
  if (opts?.['dimension']) sim.dimension = host.engine.dimension(String((opts['dimension'] as { id: string }).id)).id;
  sim.location = copy(loc);
  if (opts?.['rotation']) { const r = opts['rotation'] as { x?: number; y?: number }; sim.rotation = { x: r.x ?? sim.rotation.x, y: r.y ?? sim.rotation.y }; }
  if (opts?.['facingLocation']) {
    const t = opts['facingLocation'] as Vec3, h = sim.headLocation();
    const a = lookAngles({ x: t.x - h.x, y: t.y - h.y, z: t.z - h.z });
    sim.rotation = { x: sim.isPlayer ? a.pitch : 0, y: a.yaw };
  }
  if (!opts?.['keepVelocity']) sim.velocity = { x: 0, y: 0, z: 0 };
  sim.fall = undefined;
  sim.placeRiders();
}

/** Player-only members. */
function playerMembers(host: FacadeHost, sim: SimEntity, _live: () => SimEntity): Record<string, unknown> {
  const { timeline, controls } = host;
  const st = (): PlayerExtra => host.playerState(sim);
  const screen = guard({
    setActionBar: (t: unknown) => { timeline.add('actionbar', messageText(t), { ...withSource(timeline), target: sim.nameTag }); },
    setTitle: (t: unknown, o?: { subtitle?: unknown }) => { timeline.add('title', messageText(t) + (o?.subtitle ? ` / ${messageText(o.subtitle)}` : ''), { ...withSource(timeline), target: sim.nameTag }); },
    updateSubtitle: (t: unknown) => { timeline.add('title', `/ ${messageText(t)}`, { ...withSource(timeline), target: sim.nameTag }); },
    get isValid() { return sim.valid; },
  }, 'ScreenDisplay', timeline);
  const camera = guard({
    setCamera: (preset: string, opts?: { rotation?: { x: number; y: number }; location?: Vec3; facingLocation?: Vec3 }) => {
      if (opts?.rotation && Math.abs(opts.rotation.x) > 90) throw new RangeError(`setCamera: pitch ${opts.rotation.x} outside ±90`); // quirk camera-pitch-limit
      const c = st().camera;
      c.preset = preset; c.tick = host.engine.tick;
      if (opts?.rotation) c.rotation = { ...opts.rotation };
      if (opts?.location) c.location = copy(opts.location);
    },
    clear: () => { const c = st().camera; delete c.preset; delete c.rotation; delete c.location; delete c.animation; c.tick = host.engine.tick; },
    fade: () => { timeline.add('event', 'camera.fade', { ...withSource(timeline), target: sim.nameTag }); },
    playAnimation: (_spline: unknown, opts?: { totalTimeSeconds?: number }) => { const c = st().camera; c.animation = `spline ${opts?.totalTimeSeconds ?? '?'}s`; c.tick = host.engine.tick; },
    get isValid() { return sim.valid; },
  }, 'Camera', timeline);
  const inputInfo = guard({
    getMovementVector: () => { const c = controls.get(sim.id); return { x: c.strafe, y: c.forward }; },
    getButtonState: (b: string) => { const c = controls.get(sim.id); return (b === 'Jump' ? c.jump : b === 'Sneak' ? c.sneak : false) ? 'Pressed' : 'Released'; },
    get lastInputModeUsed() { return 'Touch'; },
    get touchOnlyAffectsHotbar() { return false; },
  }, 'InputInfo', timeline);
  const inputPermissions = guard({
    setPermissionCategory: (cat: number | string, enabled: boolean) => { st().permissions.set(String(cat), enabled); },
    isPermissionCategoryEnabled: (cat: number | string) => st().permissions.get(String(cat)) ?? true,
  }, 'PlayerInputPermissions', timeline);
  return {
    get name() { return sim.nameTag; },
    get onScreenDisplay() { return screen; },
    get camera() { return camera; },
    get inputInfo() { return inputInfo; },
    get inputPermissions() { return inputPermissions; },
    get selectedSlotIndex() { return st().selectedSlot; },
    set selectedSlotIndex(v: number) { st().selectedSlot = v; },
    get isFlying() { return false; },
    get isGliding() { return false; },
    get isJumping() { return controls.get(sim.id).jump; },
    get isEmoting() { return false; },
    sendMessage: (m: unknown) => { timeline.add('chat', messageText(m), { ...withSource(timeline), target: sim.nameTag }); },
    playSound: (id: string) => { host.stats.set(`sound ${id}`, (host.stats.get(`sound ${id}`) ?? 0) + 1); },
    spawnParticle: (id: string) => { host.stats.set(`particle ${id}`, (host.stats.get(`particle ${id}`) ?? 0) + 1); },
    getGameMode: () => 'Creative',
    getControlScheme: () => st().controlScheme,
    setControlScheme: (s?: string) => { if (s === undefined) delete st().controlScheme; else st().controlScheme = s; },
  };
}

// ─── Components ──────────────────────────────────────────────────────────────

/** `getComponent`: the modelled components; a component the entity has but the simulator does not model is Unmodelled. */
function componentFacade(host: FacadeHost, sim: SimEntity, name: string): unknown {
  const { timeline, engine } = host;
  const id = name.includes(':') ? name : `minecraft:${name}`;
  if (id === 'minecraft:rideable') {
    if (!sim.rideable()) return undefined;
    return guard({
      get seatCount() { return sim.rideable()?.seatCount ?? 0; },
      get crouchingSkipInteract() { return sim.rideable()?.crouchingSkipInteract ?? true; },
      get interactText() { return sim.rideable()?.interactText ?? ''; },
      get typeId() { return 'minecraft:rideable'; },
      get isValid() { return sim.valid; },
      get entity() { return host.entity(sim); },
      addRider: (rider: unknown) => {
        const r = host.simOf(rider);
        if (!r) throw new TypeError('addRider: not an entity');
        const out = sim.addRider(r, engine.tick);
        if (!out.ok) timeline.add('event', `addRider refused (${out.why}): ${r.typeId} on ${sim.typeId}`, withSource(timeline));
        return out.ok;
      },
      // An ejected PLAYER is set down where the device sets it (quirk `dismount-free-spot`); a mob's spot is not measured.
      ejectRider: (rider: unknown) => { const r = host.simOf(rider); if (r && sim.removeRider(r)) { if (r.isPlayer) setDownRider(r, sim, engine.dimension(sim.dimension)); engine.emit('dismounted', { rider: r, mount: sim, cause: 'script' }); } },
      ejectRiders: () => { for (const r of sim.riderList()) { sim.removeRider(r); if (r.isPlayer) setDownRider(r, sim, engine.dimension(sim.dimension)); engine.emit('dismounted', { rider: r, mount: sim, cause: 'script' }); } },
      getRiders: () => sim.riderList().map(r => host.entity(r)),
      getFamilyTypes: () => [...(sim.rideable()?.familyTypes ?? [])],
      getSeats: () => (sim.rideable()?.seats ?? []).map(s => ({ position: copy(s.position), lockRiderRotation: s.lockRiderRotation ?? 0 })),
    }, 'EntityRideableComponent', timeline);
  }
  if (id === 'minecraft:riding') {
    if (!sim.ridingOn) return undefined;
    return guard({ get entityRidingOn() { return sim.ridingOn ? host.entity(sim.ridingOn) : undefined; }, get typeId() { return 'minecraft:riding'; }, get isValid() { return sim.valid; } }, 'EntityRidingComponent', timeline);
  }
  if (id === 'minecraft:scale') {
    if (!('minecraft:scale' in sim.components)) return undefined;
    return guard({ get value() { return sim.scale(); }, get typeId() { return 'minecraft:scale'; }, get isValid() { return sim.valid; } }, 'EntityScaleComponent', timeline);
  }
  if (id === 'minecraft:type_family') {
    return guard({ hasTypeFamily: (f: string) => sim.families().includes(f), getTypeFamilies: () => sim.families(), get typeId() { return 'minecraft:type_family'; }, get isValid() { return sim.valid; } }, 'EntityTypeFamilyComponent', timeline);
  }
  if (id === 'minecraft:inventory' && sim.isPlayer) {
    const st = host.playerState(sim);
    const container = guard({
      get size() { return 36; },
      get emptySlotsCount() { return st.items.filter(i => !i).length; },
      get isValid() { return sim.valid; },
      getItem: (slot: number) => (st.items[slot] ? guard({ get typeId() { return st.items[slot]; }, get amount() { return 1; } }, 'ItemStack', timeline) : undefined),
      setItem: (slot: number, item?: { typeId?: string }) => { st.items[slot] = item?.typeId; },
    }, 'Container', timeline);
    return guard({ get container() { return container; }, get typeId() { return 'minecraft:inventory'; }, get isValid() { return sim.valid; } }, 'EntityInventoryComponent', timeline);
  }
  if (id in sim.components) throw unmodelled(timeline, `Entity.getComponent(${id})`);
  return undefined;
}

// ─── Blocks ──────────────────────────────────────────────────────────────────

/** A `Block` facade at a position (undefined when the position is not loaded: quirk `unloaded-block-undefined`). */
export function blockFacade(host: FacadeHost, dimension: string, x: number, y: number, z: number): Record<string, unknown> | undefined {
  const { engine, timeline } = host;
  const w = engine.dimension(dimension);
  x = Math.floor(x); y = Math.floor(y); z = Math.floor(z);
  if (!w.isLoaded(x, z) || y < w.heightRange.min || y >= w.heightRange.max) return undefined;
  const perm = (): Permutation => w.permutationAt(x, y, z);
  const rel = (dx: number, dy: number, dz: number): Record<string, unknown> | undefined => blockFacade(host, dimension, x + dx, y + dy, z + dz);
  const setPerm = (p: Permutation): void => {
    if (!w.isLoaded(x, z)) throw Object.assign(new Error(`Block at ${x},${y},${z} is not loaded`), { name: 'LocationInUnloadedChunkError' });
    w.setPermutation(x, y, z, p);
  };
  return guard({
    get typeId() { return perm().typeId; },
    get permutation() { return host.permutation(perm()); },
    get location() { return { x, y, z }; },
    get x() { return x; }, get y() { return y; }, get z() { return z; },
    get dimension() { return host.dimensionApi(dimension); },
    get isAir() { return w.shapeAt(x, y, z).isAir; },
    get isLiquid() { return w.shapeAt(x, y, z).isLiquid; },
    get isValid() { return w.isLoaded(x, z); },
    get isWaterlogged() { return false; },
    setPermutation: (p: unknown) => { const pp = (p as { __perm?: Permutation })?.__perm; if (!pp) throw new TypeError('setPermutation: not a BlockPermutation'); setPerm(pp); },
    setType: (t: string | { id: string }) => { setPerm(host.resolvePermutation(typeof t === 'string' ? t : t.id)); },
    above: (n = 1) => rel(0, n, 0), below: (n = 1) => rel(0, -n, 0),
    north: (n = 1) => rel(0, 0, -n), south: (n = 1) => rel(0, 0, n), east: (n = 1) => rel(n, 0, 0), west: (n = 1) => rel(-n, 0, 0),
    offset: (o: Vec3) => rel(o.x, o.y, o.z),
    center: () => ({ x: x + 0.5, y: y + 0.5, z: z + 0.5 }),
    bottomCenter: () => ({ x: x + 0.5, y, z: z + 0.5 }),
    matches: (name: string, states?: BlockStates) => { const p = perm(); return (p.typeId === name || p.typeId === `minecraft:${name}`) && Object.entries(states ?? {}).every(([k, v]) => p.states[k] === v); },
    getTags: () => [], hasTag: () => false,
  }, 'Block', timeline);
}

/** A `BlockPermutation` facade over an interned permutation. */
export function permutationFacade(host: FacadeHost, p: Permutation): Record<string, unknown> {
  return guard({
    __perm: p,
    get type() { return { id: p.typeId }; },
    get localizationKey() { return `tile.${p.typeId}.name`; },
    getState: (k: string) => p.states[k],
    getAllStates: () => ({ ...p.states }),
    withState: (k: string, v: string | number | boolean) => host.permutation(host.resolvePermutation(p.typeId, { ...p.states, [k]: v })),
    matches: (name: string, states?: BlockStates) => (p.typeId === name || p.typeId === `minecraft:${name}`) && Object.entries(states ?? {}).every(([k, v]) => p.states[k] === v),
    getTags: () => [], hasTag: () => false,
  }, 'BlockPermutation', host.timeline);
}

/** Direction helpers re-exported for the host's own rays. */
export { rotateYaw };
