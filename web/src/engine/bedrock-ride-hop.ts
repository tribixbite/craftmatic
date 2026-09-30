/**
 * HOP: fly or drive into another mountable and you are on it.
 *
 * The user's words (2026-09-30): "If you fly or drive into another mountable
 * object like a roller coaster car or chair or slide or vehicle (not already
 * fully occupied by player(s)) you should be auto mounted to the new entity.
 * So you should be able to fly a plane into an in-motion roller coaster car
 * and be auto-mounted in the first available seat closest to the front. The
 * plane can hover where you dismounted ... If you park a car at the bottom of
 * a slide you should be able to slide into it."
 *
 * One shared piece, three parts (docs/physics-architecture.md §4.8):
 *
 *  - `hopContact` (pure): does a target's box, moving RELATIVE to the ridden
 *    vehicle over the last tick and extrapolated `HOP.LEAD_TICKS` ahead,
 *    touch the vehicle's footprint or its rider's box, expanded by
 *    `HOP.REACH_BLOCKS`? A swept test, so a coaster car passing a flown plane
 *    at a block a tick is caught, not tunnelled through; a relative speed
 *    under `HOP.MIN_CLOSING_BLOCKS_PER_S` is no hop (a car parked beside a
 *    chair stays a car).
 *  - `hopKit` (serialised into every runtime that hops: `scripts/hop.js` and
 *    `scripts/rides.js`): which entities are mountable targets (a
 *    `minecraft:rideable` of a hop namespace whose seats admit players and
 *    are not all taken by players), the front-most free seat of a TRAIN (the
 *    coaster tags its cars with a train key and a rank from the front in the
 *    direction of travel, `HOP_TAGS`), the CLAIM tag a hop leaves on the
 *    player, and the boarding itself (off the old mount, a non-player rider
 *    yields, onto the new one; back onto the old one if the new one refuses).
 *  - `hopRuntime` (`scripts/hop.js`): every tick, every player riding one of
 *    THIS pack's driveables (its `sources`, by entity identifier) is tested
 *    against the mountables around it; on a contact the player hops, and the
 *    vehicle left behind is told how to wait: a scripted aircraft HOVERS where
 *    it was left (`VEHICLE_DYNAMIC.hold`, read by `scripts/vehicles.js`), a
 *    scripted car, hover craft or boat stops, and a native mount (rotorcraft,
 *    a flyer's cloud) hovers by itself (Bedrock's hover controller holds an
 *    empty mount in place).
 *
 * WHO ACTS. Many packs run in one world, each with its own `hop.js`. Only the
 * pack that OWNS the player's current vehicle (its identifier is in that
 * pack's `sources`) handles the player, and the claim tag (a tag, so every
 * pack's scripts read it - dynamic properties are per pack) makes a second
 * copy of the same pack skip a player hopped this tick. Targets may belong to
 * any pack: boarding uses only the standard rideable component.
 *
 * SEAT ORDER. `Rideable.addRider` cannot choose a seat: Bedrock gives the new
 * rider the next seat in the definition's order, seat 0 first (quirk
 * `rider-seat-order`, assumed: the documentation says nothing and it was not
 * measured). So "the first free seat closest to the front" is chosen across
 * ENTITIES: the front-most car of a train with a free seat. Within one
 * entity the compiler lists the driver's seat first (playable-addon.ts
 * `behaviorEntity`), which is the front-most on every vehicle the compiler
 * seats: its passengers go behind the driver.
 */

import { VEHICLE_DYNAMIC } from './bedrock-vehicle.js';

/** Every tuned number of the hop (docs/physics-architecture.md §4.8, §9). */
export const HOP = {
  /** Slack around the vehicle's footprint and its rider's box that still counts as touching, blocks (not scaled: a player's reach, not the model's). */
  REACH_BLOCKS: 0.5,
  /** The relative motion of the last tick is carried this many ticks ahead: a car coming at a block a tick is met a little early, never missed between two ticks. */
  LEAD_TICKS: 2,
  /** The swept segment is sampled at most this far apart, blocks. */
  SAMPLE_BLOCKS: 0.25,
  /** Below this relative speed nothing hops, blocks/s: a car parked beside a chair stays a car; a walk-pace nudge (1 block/s) still hops. */
  MIN_CLOSING_BLOCKS_PER_S: 0.5,
  /** No hop in the first second aboard (a mount the player just boarded, or just hopped onto), ticks. */
  BOARD_GRACE_TICKS: 20,
  /** The mount just left is not a target for this long, ticks (5 s): a plane hovering where a coaster rider left it is not re-boarded as the car passes. */
  BACK_COOLDOWN_TICKS: 100,
  /** Mountables are looked for this far past the vehicle's own half length, blocks at 100 % (times its size). */
  SCAN_BLOCKS: 4,
  /** A slide's set-down boards a mountable whose box lies within this of the set-down point, blocks at 100 % (times the size, at least 1): a car parked at the foot. */
  SETDOWN_REACH_BLOCKS: 1.5,
  /** Cars of the touched car's train are looked for this far from it, blocks (a 7-car train of 1.7-block cars is ~12 long). */
  TRAIN_REACH_BLOCKS: 16,
  /** A target whose box the Script API does not give is taken as this half extent, blocks. */
  DEFAULT_EXTENT_BLOCKS: 0.5,
} as const;

export type HopParams = typeof HOP;

/**
 * Tags the hop reads and writes. Tags, not dynamic properties: a dynamic
 * property is visible only to the pack that wrote it, and a coaster car of one
 * pack is a target for a plane of another.
 *   claim `craftmatic_hop:<tick>:<id of the mount left>` on the player;
 *   train `craftmatic_train:<key>` and rank `craftmatic_rank:<n>` (0 the front
 *   car in the direction of travel) on each car of a coaster train.
 */
export const HOP_TAGS = { claim: 'craftmatic_hop:', train: 'craftmatic_train:', rank: 'craftmatic_rank:' } as const;

/** How a vehicle waits once its rider hopped off: hover in place (scripted aircraft), stop (scripted ground and water craft), or as Bedrock holds it (a native hover mount). */
export type HopVacate = 'hover' | 'stop' | 'native';

/** A driveable the hop runtime acts for: its footprint at size 1, blocks, and how it waits when left. */
export interface HopSource {
  /** Half its length along the nose (`ScriptedVehicleType.noseReach`). */
  halfLength: number;
  halfWidth: number;
  height: number;
  vacate: HopVacate;
}

/** A pose: position (the entity's origin, blocks) and Bedrock yaw (degrees; 0 faces +Z, 90 faces -X). */
export interface HopPose { x: number; y: number; z: number; yaw: number }

/** A world box by centre and half extents (the Script API's `Entity.getAABB()`). */
export interface HopBox { center: { x: number; y: number; z: number }; extent: { x: number; y: number; z: number } }

/** The ridden vehicle as the contact test sees it: its footprint at its current size and its rider's feet in its own frame (right, up, forward). */
export interface HopShape { halfLength: number; halfWidth: number; height: number; rider?: { r: number; u: number; f: number } }

/**
 * Whether a target touches the ridden vehicle (or its rider), from two ticks'
 * samples: the vehicle's pose and the target's box centre at the previous and
 * the current tick. The test runs in the VEHICLE's frame, where the target's
 * relative path is a segment; it is extended `LEAD_TICKS` ahead and sampled
 * every `SAMPLE_BLOCKS`, and each sample's target box (its horizontal extent
 * taken as a radius, forgiving in every heading) is compared with the
 * footprint and the rider's box grown by `REACH_BLOCKS`. `closing` is the
 * relative speed, blocks/s; `distance` how far the target's centre is now
 * (the nearest of several contacts is boarded).
 */
export function hopContact(shape: HopShape, prev: HopPose, now: HopPose, targetPrev: { x: number; y: number; z: number }, target: HopBox, P: HopParams): { hit: boolean; closing: number; distance: number } {
  // The rider's box: a player is 0.6 wide and 1.8 tall (vanilla). Declared here: the function is serialised whole.
  const RIDER_HALF = 0.3, RIDER_HEIGHT = 1.8;
  const local = (pose: HopPose, p: { x: number; y: number; z: number }): { r: number; u: number; f: number } => {
    const a = pose.yaw * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    const dx = p.x - pose.x, dz = p.z - pose.z;
    return { r: dx * c + dz * s, u: p.y - pose.y, f: -dx * s + dz * c };
  };
  const a = local(prev, targetPrev), b = local(now, target.center);
  const d = { r: b.r - a.r, u: b.u - a.u, f: b.f - a.f };
  const step = Math.hypot(d.r, d.u, d.f);
  const closing = step * 20;
  const distance = Math.hypot(b.r, b.u, b.f);
  if (closing < P.MIN_CLOSING_BLOCKS_PER_S) return { hit: false, closing, distance };
  const ext = Math.hypot(target.extent.x, target.extent.z), ey = target.extent.y, k = P.REACH_BLOCKS;
  const inside = (q: { r: number; u: number; f: number }): boolean => {
    if (Math.abs(q.r) <= shape.halfWidth + ext + k && Math.abs(q.f) <= shape.halfLength + ext + k && q.u - ey <= shape.height + k && q.u + ey >= -k) return true;
    const rd = shape.rider;
    return !!rd && Math.abs(q.r - rd.r) <= RIDER_HALF + ext + k && Math.abs(q.f - rd.f) <= RIDER_HALF + ext + k && q.u - ey <= rd.u + RIDER_HEIGHT + k && q.u + ey >= rd.u - k;
  };
  const span = 1 + P.LEAD_TICKS;
  const n = Math.min(64, Math.max(1, Math.ceil(step * span / P.SAMPLE_BLOCKS)));
  for (let i = 0; i <= n; i++) {
    const t = span * i / n;
    if (inside({ r: a.r + d.r * t, u: a.u + d.u * t, f: a.f + d.f * t })) return { hit: true, closing, distance };
  }
  return { hit: false, closing, distance };
}

/** The kit's config: namespaces a target may belong to, the tags, the constants. */
export interface HopKitConfig {
  /** Entity namespaces a target may belong to (`craftmatic`): vanilla rideables are left alone. */
  namespaces: string[];
  tags: typeof HOP_TAGS;
  constants: HopParams;
}

/** What the kit gives a runtime (see `hopKit`). */
export interface HopKit {
  /** Seats a player could take: seats not taken by a player (a figure yields its seat), or 0 (no rideable for players, or all taken by players). */
  takeable(e: any): number;
  /** The entity's world box, or a default box about its origin. */
  boxOf(e: any): HopBox;
  /** Mountable targets within `radius` of `at` in `dim`, less the ids in `exclude`. */
  candidates(dim: any, at: { x: number; y: number; z: number }, radius: number, exclude: ReadonlySet<string>): any[];
  /** The front-most car with a takeable seat of the touched target's train (the target itself when it is in none). */
  front(target: any, exclude: ReadonlySet<string>): any;
  /** The nearest mountable whose box lies within `reach` of `at` (a slide's set-down), front-most of its train. */
  nearestAt(dim: any, at: { x: number; y: number; z: number }, reach: number, exclude: ReadonlySet<string>): any;
  /** The player's last hop: its tick and the id of the mount it left ('' for none), or undefined. */
  claimOf(player: any): { tick: number; from: string } | undefined;
  /** Put `player` on `target` (off `from` first, when riding it); true when seated on the target. */
  board(player: any, target: any, from?: any): boolean;
}

/**
 * The kit. Serialised whole (`.toString()`) into each runtime that hops, so it
 * may use only its argument and the Script API globals (`system`).
 */
export function hopKit(config: HopKitConfig): HopKit {
  const T = config.tags, K = config.constants;
  const prefixes = config.namespaces.map(n => `${n}:`);
  const ours = (e: any): boolean => { try { const id = String(e.typeId); return prefixes.some(p => id.startsWith(p)); } catch { return false; } };
  const riders = (e: any): any[] => { try { return e.getComponent('minecraft:rideable')?.getRiders?.() ?? []; } catch { return []; } };
  const takeable = (e: any): number => {
    let r: any;
    try { r = e.getComponent('minecraft:rideable'); } catch { return 0; }
    if (!r) return 0;
    let families: string[] = [];
    try { families = r.getFamilyTypes?.() ?? []; } catch { families = []; }
    if (families.length && !families.includes('player')) return 0;
    const count = Number(r.seatCount) || 0;
    const players = riders(e).filter((x: any) => x?.typeId === 'minecraft:player').length;
    return Math.max(0, count - players);
  };
  const boxOf = (e: any): HopBox => {
    try {
      const b = e.getAABB();
      if (b && b.center && b.extent && [b.center.x, b.center.y, b.center.z, b.extent.x, b.extent.y, b.extent.z].every((v: number) => Number.isFinite(v))) return { center: { ...b.center }, extent: { ...b.extent } };
    } catch { /* no AABB in this API: the default box */ }
    const l = e.location, h = K.DEFAULT_EXTENT_BLOCKS;
    return { center: { x: l.x, y: l.y + h, z: l.z }, extent: { x: h, y: h, z: h } };
  };
  const candidates = (dim: any, at: { x: number; y: number; z: number }, radius: number, exclude: ReadonlySet<string>): any[] => {
    let list: any[] = [];
    try { list = dim.getEntities({ location: at, maxDistance: radius }); } catch { return []; }
    return list.filter((e: any) => { try { return e.typeId !== 'minecraft:player' && !exclude.has(e.id) && ours(e) && takeable(e) > 0; } catch { return false; } });
  };
  const tagValue = (e: any, prefix: string): string | undefined => {
    let tags: string[] = [];
    try { tags = e.getTags(); } catch { return undefined; }
    const t = tags.find(x => x.startsWith(prefix));
    return t === undefined ? undefined : t.slice(prefix.length);
  };
  const front = (target: any, exclude: ReadonlySet<string>): any => {
    const train = tagValue(target, T.train);
    if (train === undefined) return target;
    let mates: any[] = [];
    try { mates = target.dimension.getEntities({ location: target.location, maxDistance: K.TRAIN_REACH_BLOCKS, tags: [T.train + train] }); } catch { return target; }
    const rank = (e: any): number => { const v = Number(tagValue(e, T.rank)); return Number.isFinite(v) ? v : 1e9; };
    const free = mates.filter((e: any) => !exclude.has(e.id) && takeable(e) > 0).sort((a: any, b: any) => rank(a) - rank(b));
    return free[0] ?? target;
  };
  /** Distance from a point to a box (0 inside). */
  const toBox = (p: { x: number; y: number; z: number }, b: HopBox): number => {
    const dx = Math.max(0, Math.abs(p.x - b.center.x) - b.extent.x), dy = Math.max(0, Math.abs(p.y - b.center.y) - b.extent.y), dz = Math.max(0, Math.abs(p.z - b.center.z) - b.extent.z);
    return Math.hypot(dx, dy, dz);
  };
  const nearestAt = (dim: any, at: { x: number; y: number; z: number }, reach: number, exclude: ReadonlySet<string>): any => {
    let best: any, bestD = Infinity;
    // The query is by ORIGIN; a long car's origin may lie a few blocks from its nearest face.
    for (const e of candidates(dim, at, reach + K.SCAN_BLOCKS + K.TRAIN_REACH_BLOCKS / 2, exclude)) {
      const d = toBox(at, boxOf(e));
      if (d <= reach && d < bestD) { best = e; bestD = d; }
    }
    return best ? front(best, exclude) : undefined;
  };
  const claimOf = (player: any): { tick: number; from: string } | undefined => {
    const v = tagValue(player, T.claim);
    if (v === undefined) return undefined;
    const i = v.indexOf(':'), tick = Number(i < 0 ? v : v.slice(0, i));
    return Number.isFinite(tick) ? { tick, from: i < 0 ? '' : v.slice(i + 1) } : undefined;
  };
  const board = (player: any, target: any, from?: any): boolean => {
    let now = 0;
    try { now = Number(system.currentTick) || 0; } catch { now = 0; }
    // The claim first: another copy of this pack's runtime reads it later in this same tick and skips the player.
    try { for (const t of player.getTags()) if (t.startsWith(T.claim)) player.removeTag(t); } catch { /* no tags */ }
    try { player.addTag(`${T.claim}${now}:${from ? from.id : ''}`); } catch { /* unclaimed: the grace still holds this runtime */ }
    const fromRide = from ? (() => { try { return from.getComponent('minecraft:rideable'); } catch { return undefined; } })() : undefined;
    try { fromRide?.ejectRider?.(player); } catch { /* already off */ }
    let ride: any;
    try { ride = target.getComponent('minecraft:rideable'); } catch { ride = undefined; }
    if (!ride) { try { fromRide?.addRider?.(player); } catch { /* left */ } return false; }
    // A figure on the seat yields it to the player (figures.js stands a seated figure up for a nearby player anyway).
    try {
      const on: any[] = ride.getRiders?.() ?? [];
      if (on.length >= (Number(ride.seatCount) || 0)) { const figure = on.find((x: any) => x?.typeId !== 'minecraft:player'); if (figure) ride.ejectRider(figure); }
    } catch { /* keep them */ }
    let ok = false;
    try { ok = ride.addRider(player) === true; } catch { ok = false; }
    // Refused (a device that will not take a rider just ejected, say): back on the mount it left, never dropped mid-air.
    if (!ok) { try { fromRide?.addRider?.(player); } catch { /* left */ } }
    return ok;
  };
  return { takeable, boxOf, candidates, front, nearestAt, claimOf, board };
}

/** `scripts/hop.js` CONFIG. */
export interface HopRuntimeConfig {
  /** THIS pack's driveables by entity identifier: only a player riding one of these is handled here. */
  sources: Record<string, HopSource>;
  kit: HopKitConfig;
  /** The dynamic property `scripts/vehicles.js` reads to hover a scripted aircraft in place (`VEHICLE_DYNAMIC.hold`). */
  holdProperty: string;
  /** The sound a hop plays at the new mount (vanilla id). */
  sound: string;
}

declare const world: any;
declare const system: any;

/**
 * The hop runtime (`scripts/hop.js`). Serialised whole, so it may use only its
 * arguments and the Script API globals.
 */
function hopRuntime(config: HopRuntimeConfig, makeKit: typeof hopKit, contact: typeof hopContact): void {
  const K = config.kit.constants;
  const kit = makeKit(config.kit);
  interface Rec { vehicle: string; since: number; prev?: HopPose; targets: Map<string, { x: number; y: number; z: number }> }
  const recs = new Map<string, Rec>();
  const sizeOf = (e: any): number => { try { const s = Number(e.getComponent('minecraft:scale')?.value); return Number.isFinite(s) && s > 0 ? s : 1; } catch { return 1; } };
  /** How the vehicle left behind waits (see the module header). */
  const vacate = (v: any, src: HopSource): void => {
    if (src.vacate === 'native') return;
    try { v.setDynamicProperty(config.holdProperty, true); } catch { /* gone */ }
  };
  system.runInterval(() => {
    let now = 0;
    try { now = Number(system.currentTick) || 0; } catch { return; }
    let players: any[] = [];
    try { players = world.getAllPlayers(); } catch { return; }
    const present = new Set<string>();
    for (const p of players) {
      if (!p) continue;
      let pid: string;
      try { pid = p.id; } catch { continue; }
      present.add(pid);
      let v: any;
      try { v = p.getComponent('minecraft:riding')?.entityRidingOn; } catch { v = undefined; }
      const src: HopSource | undefined = v ? config.sources[v.typeId] : undefined;
      // Not on one of THIS pack's driveables: another pack's runtime (or none) owns the player.
      if (!v || !src) { recs.delete(pid); continue; }
      let pose: HopPose, riderAt: { x: number; y: number; z: number };
      try { const l = v.location; pose = { x: l.x, y: l.y, z: l.z, yaw: v.getRotation().y }; riderAt = p.location; } catch { continue; }
      let rec = recs.get(pid);
      if (!rec || rec.vehicle !== v.id) recs.set(pid, rec = { vehicle: v.id, since: now, targets: new Map() });
      const prev = rec.prev;
      rec.prev = pose;
      const claim = kit.claimOf(p);
      const settling = now - rec.since < K.BOARD_GRACE_TICKS || (claim !== undefined && now - claim.tick < K.BOARD_GRACE_TICKS);
      const f = sizeOf(v);
      const a = pose.yaw * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
      const dx = riderAt.x - pose.x, dz = riderAt.z - pose.z;
      const shape = { halfLength: src.halfLength * f, halfWidth: src.halfWidth * f, height: src.height * f, rider: { r: dx * c + dz * s, u: riderAt.y - pose.y, f: -dx * s + dz * c } };
      const exclude = new Set<string>([v.id]);
      if (claim && claim.from && now - claim.tick < K.BACK_COOLDOWN_TICKS) exclude.add(claim.from);
      const list = kit.candidates(v.dimension, { x: pose.x, y: pose.y, z: pose.z }, shape.halfLength + K.SCAN_BLOCKS * Math.max(1, f), exclude);
      const seen = new Map<string, { x: number; y: number; z: number }>();
      const hits: Array<{ e: any; d: number }> = [];
      for (const e of list) {
        const box = kit.boxOf(e);
        seen.set(e.id, box.center);
        const last = rec.targets.get(e.id);
        // Two samples make a relative motion: a target first seen this tick is tested from the next.
        if (settling || !prev || !last) continue;
        const r = contact(shape, prev, pose, last, box, K);
        if (r.hit) hits.push({ e, d: r.distance });
      }
      rec.targets = seen;
      if (!hits.length) continue;
      hits.sort((x, y) => x.d - y.d);
      const target = kit.front(hits[0]!.e, exclude);
      if (!kit.board(p, target, v)) continue;
      vacate(v, src);
      // The chase camera and control scheme are this pack's (scripts/vehicle-camera.js); hand the view back
      // now, so the new mount's own camera (a coaster's, a car's) is the one that follows. The camera script
      // reads the claim and does not clear it again over the new mount's camera.
      try { p.camera.clear(); } catch { /* no camera */ }
      try { p.runCommand('controlscheme @s clear'); } catch { /* no scheme */ }
      try { target.dimension.playSound(config.sound, target.location, { volume: 0.8, pitch: 1.3 }); } catch { /* no sound */ }
      recs.delete(pid);
    }
    for (const id of [...recs.keys()]) if (!present.has(id)) recs.delete(id);
  }, 1);
}

export { hopRuntime as _hopRuntimeForTests };

/** The hop kit's config for a pack. */
export function hopKitConfig(namespace: string): HopKitConfig {
  return { namespaces: [namespace], tags: HOP_TAGS, constants: HOP };
}

/** `scripts/hop.js` CONFIG for a pack's driveables. */
export function hopRuntimeConfig(namespace: string, sources: Record<string, HopSource>): HopRuntimeConfig {
  return { sources, kit: hopKitConfig(namespace), holdProperty: VEHICLE_DYNAMIC.hold, sound: 'note.chime' };
}

/** `scripts/hop.js`: the config, the kit and the contact test with their own text. */
export function hopScript(config: HopRuntimeConfig): string {
  return `import { world, system } from '@minecraft/server';\nconst CONFIG = ${JSON.stringify(config)};\n(${hopRuntime.toString()})(CONFIG, ${hopKit.toString()}, ${hopContact.toString()});\n`;
}
