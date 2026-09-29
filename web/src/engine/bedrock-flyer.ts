/**
 * Flyer mounts: a small sub-build a figure rides that the player can summon
 * a copy of and fly (11390's Flying Nimbus, the set's canon in set-canon.ts).
 *
 * Three pieces, host and device:
 *
 *  - `findMounts` (host): the mount is the connected cluster of parts under a
 *    FIGURE's feet that is not the main model - at most `MOUNT_MAX_PARTS`
 *    placements, mostly of the canon style's colours (set-canon.ts
 *    `MOUNT_STYLE_COLOURS`). A translucent part (a clear bar, a stand) never
 *    joins two clusters: the Nimbus may hang off the rock by a trans-clear
 *    bar in the finished-model page and is still its own object. A canon
 *    mount none is found for is returned in `missing` with the reason, so the
 *    export can say so (never silently).
 *  - `orbitPathLdu` (host): the companion's lap - a horizontal circle around
 *    the model's footprint centre, just outside its widest reach, in the
 *    model's upper third, with a gentle sinusoidal rise and fall baked into
 *    the points. The ride runtime (bedrock-rides.ts, kind `orbit`) follows
 *    the points and nothing else.
 *  - `flyerRuntime` (device, `scripts/flyer.js`): a tap on the companion
 *    figure, its cloud or its seat summons a NEW cloud (a `flyer` vehicle
 *    entity of the same geometry) beside the player and mounts them at once,
 *    with a puff and a sound; an empty summoned cloud hovers where it is and
 *    fades after `EMPTY_DESPAWN_TICKS`; at most `CLOUD_CAP` summoned clouds
 *    exist at once (the oldest fades). The companion's own cloud is a
 *    different entity type and never fades.
 *
 * The mount's flight itself is Bedrock's native hover controller, the one a
 * rotorcraft uses (playable-addon.ts `behaviorEntity`, motion `flyer`).
 */

import type { ParsedBrick } from './ldraw-parser.js';
import type { LdrawPartMesh, Vec3 } from './ldraw-part-geometry.js';
import type { SceneFigure } from './bedrock-scene-actors.js';
import { connectedClusters } from './ldraw-entity-compiler.js';
import { placementBox } from './scene-vehicles.js';
import { isMountColour, ldrawColourTranslucent, type CanonMount } from './set-canon.js';

/** Every tuned number of the flyer mounts, with its unit (docs/physics-architecture.md §9). */
export const FLYER = {
  /** A mount has at least this many parts (fewer is a plate the figure stands on, not a build). */
  MOUNT_MIN_PARTS: 6,
  /** A mount has at most this many parts: a cloud is a few dozen slopes; the rock and its dragon are hundreds. */
  MOUNT_MAX_PARTS: 80,
  /** At least this share of a mount's parts are in its style's colour family. */
  MOUNT_COLOUR_SHARE: 0.6,
  /** The mount's top lies within this of the figure's soles, LDU (a plate is 8; slack for a stud and a converter's rounding). */
  MOUNT_FOOT_REACH_LDU: 16,
  /** The figure's feet lie within this of a mount part's footprint, LDU (half a stud). */
  MOUNT_FOOT_MARGIN_LDU: 12,
  /** Parts closer than this touch, LDU (clustering). */
  TOUCH_LDU: 2,
  /** The orbit runs this far outside the model's widest horizontal reach (half its footprint diagonal), LDU: 3 blocks at 100 %. */
  ORBIT_MARGIN_LDU: 160,
  /** Height of the orbit's centre line over the model's underside, as a share of the model's height: the middle of its upper third, rounded down so the bob stays under the top. */
  ORBIT_HEIGHT_FRACTION: 0.8,
  /** Amplitude of the orbit's rise and fall, LDU: 0.6 blocks at 100 %. */
  ORBIT_BOB_LDU: 32,
  /** Rises and falls per lap. */
  ORBIT_BOB_PERIODS: 2,
  /** Points on the loop: 5.6 degrees a segment, so the yaw the runtime interpolates between segments never jumps. */
  ORBIT_POINTS: 64,
  /** A summoned cloud nobody rides fades after this many ticks (60 s). */
  EMPTY_DESPAWN_TICKS: 1200,
  /** Most summoned clouds in a world at once; the oldest fades when another is summoned. */
  CLOUD_CAP: 8,
  /** Ticks between two summons by one player: a tap that lands twice is one tap. */
  TAP_COOLDOWN_TICKS: 20,
  /** A summoned cloud appears this far ahead of the player, blocks. */
  SPAWN_AHEAD_BLOCKS: 1.5,
  /**
   * The `minecraft:flying_speed` a mount is written with (the rotor keeps
   * `ROTOR_FLYING_SPEED` 0.3). Bedrock's hover controller flew the Nimbus at
   * 38.3 blocks/s at 0.3 (85.7 mph HUD; Pixel, 2026-09-29), far too fast to
   * steer round a ten-block model. The response is NOT proportional: 0.09
   * measured 13.1 blocks/s, not the 11.5 proportion predicted (Pixel, CMVT
   * fast, 56 steady samples), so the two points give v ≈ 120·fs + 2.3
   * blocks/s and 0.0725 is the value for the ~11 blocks/s (25 mph) a child
   * can steer round a ten-block model. The same at every wand size, as
   * every vehicle's speeds are.
   */
  FLYING_SPEED: 0.0725,
  /** The rider's look pitch past which the driver puts the descend group in (Jump then dives), degrees down from level. */
  DIVE_PITCH_DEG: 25,
  /** The driver HUD shows the mount's name and "Jump climbs, sneak gets off" for this long after boarding, ticks (3 s). */
  RIDE_HINT_TICKS: 60,
  /** A rider who leaves a cloud with no solid block within this many blocks under their feet is given slow falling. */
  DISMOUNT_DROP_BLOCKS: 2,
  /** How long that slow falling lasts, ticks (30 s): the longest drop from the cloud's reach, with margin. */
  DISMOUNT_SLOW_FALL_TICKS: 600,
} as const;

export interface SceneMount {
  canon: CanonMount;
  /** The figure standing on it (its bricks leave the scene with the mount's). */
  figure: SceneFigure;
  /** The mount's own placements. */
  bricks: ParsedBrick[];
  /** The mount's world AABB, LDraw. */
  boxLdu: { min: Vec3; max: Vec3 };
  /** The centre of the mount's top surface, LDraw: where its rider's seat is. */
  topLdu: Vec3;
  /** Parts in the style's colour family, over all its parts. */
  colourShare: number;
}

export interface MountSearch {
  mounts: SceneMount[];
  /** Canon mounts nothing matched, each with why the nearest candidate failed. */
  missing: Array<{ canon: CanonMount; reason: string }>;
}

type Box = { min: Vec3; max: Vec3 };

/** The world AABB of every placement with geometry, minus `exclude`; null when nothing is left. */
export function modelBoxLdu(bricks: readonly ParsedBrick[], meshes: ReadonlyMap<string, LdrawPartMesh | null>, exclude: ReadonlySet<ParsedBrick> = new Set()): Box | null {
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const b of bricks) {
    const m = meshes.get(b.part);
    if (!m || !m.triangles.length || exclude.has(b)) continue;
    const box = placementBox(b, m);
    for (let i = 0; i < 3; i++) { if (box.min[i]! < min[i]!) min[i] = box.min[i]!; if (box.max[i]! > max[i]!) max[i] = box.max[i]!; }
  }
  return Number.isFinite(min[0]) ? { min, max } : null;
}

/**
 * Every canon mount that has a figure standing on it. `bricks` are the scene's
 * placements (the figures' included); `figures` the scene's upright figures.
 * One mount per canon entry, one figure per mount, in the figures' order.
 */
export function findMounts(bricks: readonly ParsedBrick[], meshes: ReadonlyMap<string, LdrawPartMesh | null>, figures: readonly SceneFigure[], canon: readonly CanonMount[], trace?: (message: string) => void): MountSearch {
  const out: MountSearch = { mounts: [], missing: [] };
  if (!canon.length) return out;
  const figureBricks = new Set<ParsedBrick>();
  for (const f of figures) for (const b of f.bricks) figureBricks.add(b);
  // The solid parts: geometry, not a figure's, not see-through (a clear bar or
  // stand between the mount and the model does not join them).
  const solid: ParsedBrick[] = [], boxes: Box[] = [];
  for (const b of bricks) {
    const m = meshes.get(b.part);
    if (!m || !m.triangles.length || figureBricks.has(b) || ldrawColourTranslucent(b.color)) continue;
    solid.push(b); boxes.push(placementBox(b, m));
  }
  const clusters = connectedClusters(boxes, FLYER.TOUCH_LDU);
  const clusterOf = new Int32Array(solid.length).fill(-1);
  clusters.forEach((members, k) => { for (const i of members) clusterOf[i] = k; });
  const largest = clusters.length ? clusters[0]!.length : 0;
  const claimed = new Set<SceneFigure>();
  for (const want of canon) {
    let found: SceneMount | undefined;
    let nearest: string | undefined;
    for (const f of figures) {
      if (claimed.has(f) || found) continue;
      const feet: Vec3 = [f.centreLdu[0], f.floorLdu, f.centreLdu[2]];
      // The part under the soles: its top (LDraw min y) at the feet, its footprint around them.
      let under = -1, underGap = Infinity;
      for (let i = 0; i < solid.length; i++) {
        const box = boxes[i]!, m = FLYER.MOUNT_FOOT_MARGIN_LDU;
        if (feet[0] < box.min[0] - m || feet[0] > box.max[0] + m || feet[2] < box.min[2] - m || feet[2] > box.max[2] + m) continue;
        const gap = Math.abs(box.min[1] - feet[1]);
        if (gap <= FLYER.MOUNT_FOOT_REACH_LDU && gap < underGap) { underGap = gap; under = i; }
      }
      if (under < 0) { nearest ??= `a figure at ${feet.map(Math.round).join(',')} stands on no solid part`; continue; }
      const k = clusterOf[under]!, members = clusters[k]!;
      const parts = members.map(i => solid[i]!);
      const share = parts.filter(b => isMountColour(want.style, b.color)).length / parts.length;
      const verdict = members.length > FLYER.MOUNT_MAX_PARTS ? `the cluster under it has ${members.length} parts (over ${FLYER.MOUNT_MAX_PARTS})`
        : members.length < FLYER.MOUNT_MIN_PARTS ? `the cluster under it has only ${members.length} part${members.length === 1 ? '' : 's'} (under ${FLYER.MOUNT_MIN_PARTS})`
        : members.length === largest && clusters.length > 1 ? `the cluster under it is the model's largest (${members.length} parts)`
        : share < FLYER.MOUNT_COLOUR_SHARE ? `only ${Math.round(share * 100)} percent of the ${members.length} parts under it are ${want.style} colours (needs ${Math.round(FLYER.MOUNT_COLOUR_SHARE * 100)})`
        : null;
      trace?.(`${want.style}: figure at ${feet.map(Math.round).join(',')} on cluster ${k} (${members.length} parts, ${Math.round(share * 100)} percent ${want.style}): ${verdict ?? 'a mount'}`);
      if (verdict) { nearest ??= `the figure at ${feet.map(Math.round).join(',')}: ${verdict}`; continue; }
      const boxLdu: Box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
      for (const i of members) for (let a = 0; a < 3; a++) { boxLdu.min[a] = Math.min(boxLdu.min[a]!, boxes[i]!.min[a]!); boxLdu.max[a] = Math.max(boxLdu.max[a]!, boxes[i]!.max[a]!); }
      found = { canon: want, figure: f, bricks: parts, boxLdu, topLdu: [(boxLdu.min[0] + boxLdu.max[0]) / 2, boxLdu.min[1], (boxLdu.min[2] + boxLdu.max[2]) / 2], colourShare: share };
      claimed.add(f);
    }
    if (found) out.mounts.push(found);
    else out.missing.push({ canon: want, reason: nearest ?? (figures.length ? 'no figure stands on a small cluster' : 'the scene has no upright figure') });
  }
  return out;
}

/**
 * The companion's closed lap around the model, LDraw points. A circle about
 * the model box's footprint centre with radius half the footprint diagonal
 * plus `ORBIT_MARGIN_LDU` (clear of every corner), at
 * `ORBIT_HEIGHT_FRACTION` of the model's height over its underside, with
 * `ORBIT_BOB_PERIODS` sinusoidal rises and falls of `ORBIT_BOB_LDU` per lap.
 * The first point is the one nearest `mountLdu` (the mount's source position),
 * so the companion starts its lap where its cloud stood. The runtime closes
 * the loop from the last point back to the first.
 */
export function orbitPathLdu(modelBox: Box, mountLdu: Vec3, P: typeof FLYER = FLYER): Vec3[] {
  const cx = (modelBox.min[0] + modelBox.max[0]) / 2, cz = (modelBox.min[2] + modelBox.max[2]) / 2;
  const r = Math.hypot((modelBox.max[0] - modelBox.min[0]) / 2, (modelBox.max[2] - modelBox.min[2]) / 2) + P.ORBIT_MARGIN_LDU;
  // LDraw y is down: the underside is max y, the top min y; the centre line sits `ORBIT_HEIGHT_FRACTION` of the height up from the underside.
  const y0 = modelBox.max[1] - P.ORBIT_HEIGHT_FRACTION * (modelBox.max[1] - modelBox.min[1]);
  const theta0 = Math.atan2(mountLdu[2] - cz, mountLdu[0] - cx);
  const out: Vec3[] = [];
  for (let k = 0; k < P.ORBIT_POINTS; k++) {
    const t = k / P.ORBIT_POINTS, theta = theta0 + 2 * Math.PI * t;
    out.push([cx + r * Math.cos(theta), y0 - P.ORBIT_BOB_LDU * Math.sin(2 * Math.PI * P.ORBIT_BOB_PERIODS * t), cz + r * Math.sin(theta)]);
  }
  return out;
}

// ─── Runtime ─────────────────────────────────────────────────────────────────

export interface FlyerRuntimeMount {
  /** The summoned mount's entity type: a `flyer` vehicle of the mount's geometry. */
  cloudType: string;
  /** A tap on an entity of one of these types summons a cloud: the companion figure, its cloud and its seat. */
  summonTypes: string[];
  /** The companion seat type; its `craftmatic:ride_scale` is the placed size a summoned cloud copies. */
  seatType?: string;
  /** The mount's name (ASCII, `bedrockInGameText`): the README's and the diagnostics'; the HUD word is the driver's `hud`. */
  label: string;
}

export interface FlyerRuntimeConfig {
  mounts: FlyerRuntimeMount[];
  /** The wand's size steps and the event that selects each (bedrock-placement-pack.ts). */
  sizeEvents: Array<{ pct: number; event: string }>;
  /** Vanilla particle and sounds of a summon and a fade. */
  particle: string;
  spawnSound: string;
  fadeSound: string;
  constants: Pick<typeof FLYER, 'EMPTY_DESPAWN_TICKS' | 'CLOUD_CAP' | 'TAP_COOLDOWN_TICKS' | 'SPAWN_AHEAD_BLOCKS' | 'DISMOUNT_DROP_BLOCKS' | 'DISMOUNT_SLOW_FALL_TICKS'>;
}

declare const world: any;
declare const system: any;

/**
 * The summon-and-fade runtime. Serialised whole into `scripts/flyer.js`
 * (`flyerScript`), so it may use only its argument and the Script API globals.
 */
function flyerRuntime(config: FlyerRuntimeConfig): void {
  const K = config.constants;
  const BORN = 'craftmatic:cloud_born';
  const lastTap = new Map<string, number>();
  const emptySince = new Map<string, number>();
  const now = (): number => { try { return Number(system.currentTick) || 0; } catch { return 0; } };
  const puff = (dim: any, at: any, n: number): void => {
    for (let i = 0; i < n; i++) {
      try { dim.spawnParticle(config.particle, { x: at.x + (Math.random() - 0.5) * 1.4, y: at.y + Math.random() * 0.8, z: at.z + (Math.random() - 0.5) * 1.4 }); } catch { /* no particle: silent */ }
    }
  };
  const sound = (dim: any, at: any, id: string): void => { try { dim.playSound(id, at, { volume: 0.8, pitch: 1.1 }); } catch { /* no sound */ } };
  const riders = (e: any): any[] => { try { return e.getComponent('minecraft:rideable')?.getRiders?.() ?? []; } catch { return []; } };
  const clouds = (dim: any, cloudType: string): any[] => { try { return dim.getEntities({ type: cloudType }); } catch { return []; } };
  const born = (e: any): number => { try { const v = e.getDynamicProperty(BORN); return typeof v === 'number' ? v : 0; } catch { return 0; } };
  const cloudTypes = new Set(config.mounts.map(m => m.cloudType));
  const ridingCloud = (p: any): boolean => { try { return cloudTypes.has(p.getComponent('minecraft:riding')?.entityRidingOn?.typeId); } catch { return false; } };
  /** The placed size at the companion's seat nearest `at` (1 when there is none). */
  const sizeNear = (dim: any, seatType: string | undefined, at: any): number => {
    if (!seatType) return 1;
    try {
      const seat = dim.getEntities({ type: seatType, location: at, maxDistance: 12 })[0];
      const f = seat?.getDynamicProperty('craftmatic:ride_scale');
      return typeof f === 'number' && f > 0 ? f : 1;
    } catch { return 1; }
  };
  const fade = (e: any): void => {
    try {
      const dim = e.dimension, at = e.location;
      try { e.getComponent('minecraft:rideable')?.ejectRiders?.(); } catch { /* none */ }
      puff(dim, at, 6); sound(dim, at, config.fadeSound);
      e.remove();
    } catch { /* gone */ }
    emptySince.delete(e.id);
  };
  const summon = (player: any, target: any): void => {
    if (!player || !target || player.typeId !== 'minecraft:player') return;
    const mount = config.mounts.find(m => m.summonTypes.includes(target.typeId));
    if (!mount) return;
    const t = now();
    if ((lastTap.get(player.id) ?? -1e9) + K.TAP_COOLDOWN_TICKS > t) return;
    lastTap.set(player.id, t);
    if (ridingCloud(player)) return; // already aboard one: the tap is a wave, not another cloud
    let dim: any, loc: any, yaw = 0;
    try { dim = player.dimension; loc = player.location; yaw = player.getRotation().y; } catch { return; }
    const rad = yaw * Math.PI / 180;
    const at = { x: loc.x - Math.sin(rad) * K.SPAWN_AHEAD_BLOCKS, y: loc.y, z: loc.z + Math.cos(rad) * K.SPAWN_AHEAD_BLOCKS };
    // The cap: the oldest summoned clouds fade first, ridden or not.
    const all = clouds(dim, mount.cloudType).sort((a: any, b: any) => born(a) - born(b));
    while (all.length >= K.CLOUD_CAP) fade(all.shift());
    let cloud: any;
    try { cloud = dim.spawnEntity(mount.cloudType, at); } catch { return; }
    try { cloud.setRotation({ x: 0, y: yaw }); } catch { /* keeps spawn yaw */ }
    try { cloud.setDynamicProperty(BORN, t); } catch { /* unsorted in the cap */ }
    const pct = Math.round(sizeNear(dim, mount.seatType, target.location) * 100);
    const step = config.sizeEvents.find(s => s.pct === pct);
    if (step && pct !== 100) { try { cloud.triggerEvent(step.event); } catch { /* stays 100 */ } }
    puff(dim, at, 8); sound(dim, at, config.spawnSound);
    const board = (): boolean => { try { return cloud.getComponent('minecraft:rideable')?.addRider?.(player) === true; } catch { return false; } };
    if (!board()) { try { system.runTimeout(() => { board(); }, 2); } catch { /* the player taps the cloud */ } }
    // The mount's name and its hint are the driver HUD's for the first seconds of the
    // ride (vehicle-driver.js, `FLYER.RIDE_HINT_TICKS`): a one-shot action bar here
    // was overwritten by that HUD within 4 ticks (Saga, 2026-09-29).
  };
  try { world.afterEvents.playerInteractWithEntity.subscribe((ev: any) => summon(ev.player, ev.target)); } catch { /* no event */ }
  try { world.afterEvents.entityHitEntity.subscribe((ev: any) => { if (ev.damagingEntity?.typeId === 'minecraft:player') summon(ev.damagingEntity, ev.hitEntity); }); } catch { /* no event */ }
  /** Whether a solid block lies within `DISMOUNT_DROP_BLOCKS` under the feet at `loc` (an unloaded block counts as none: the effect is harmless on the ground). */
  const groundUnder = (dim: any, loc: any): boolean => {
    const x = Math.floor(loc.x), z = Math.floor(loc.z), feet = Math.floor(loc.y);
    for (let dy = 0; dy <= K.DISMOUNT_DROP_BLOCKS; dy++) {
      try {
        const b = dim.getBlock({ x, y: feet - dy, z });
        if (b && !b.isAir && !b.isLiquid) return true;
      } catch { /* unloaded: no ground known */ }
    }
    return false;
  };
  // Who is aboard a summoned cloud, so a rider who leaves one (sneak, the fade's eject,
  // the cap) is seen the next interval. The Script API has no dismount event
  // (@minecraft/server 2.9.0: WorldAfterEvents lists none), so the riders are polled.
  const aboard = new Map<string, any>();
  const floatDown = (player: any): void => {
    let dim: any, loc: any;
    try { dim = player.dimension; loc = player.location; } catch { return; }
    if (groundUnder(dim, loc)) return;
    // Sneak at altitude dropped a rider 229 blocks (Saga, 2026-09-29): slow falling for
    // `DISMOUNT_SLOW_FALL_TICKS` floats them down with no fall damage.
    try { player.addEffect('slow_falling', K.DISMOUNT_SLOW_FALL_TICKS, { amplifier: 0, showParticles: false }); } catch { /* no effect */ }
    try { player.onScreenDisplay.setActionBar('Floating down'); } catch { /* no HUD */ }
  };
  // Empty summoned clouds fade after `EMPTY_DESPAWN_TICKS` without a rider (a reload starts the count again).
  system.runInterval(() => {
    const t = now();
    const dims = new Map<string, any>();
    const players: any[] = [];
    try { for (const p of world.getAllPlayers()) if (p) { players.push(p); dims.set(p.dimension.id, p.dimension); } } catch { /* none */ }
    const present = new Set<string>();
    for (const p of players) {
      let id: string;
      try { id = p.id; } catch { continue; }
      present.add(id);
      if (ridingCloud(p)) aboard.set(id, p);
      else if (aboard.delete(id)) floatDown(p);
    }
    for (const id of [...aboard.keys()]) if (!present.has(id)) aboard.delete(id);
    const seen = new Set<string>();
    for (const dim of dims.values()) for (const type of cloudTypes) for (const c of clouds(dim, type)) {
      seen.add(c.id);
      if (riders(c).length) { emptySince.delete(c.id); continue; }
      const since = emptySince.get(c.id);
      if (since === undefined) emptySince.set(c.id, t);
      else if (t - since >= K.EMPTY_DESPAWN_TICKS) fade(c);
    }
    for (const id of [...emptySince.keys()]) if (!seen.has(id)) emptySince.delete(id);
  }, 10);
}

export { flyerRuntime as _flyerRuntimeForTests };

/** `scripts/flyer.js`: the config and the runtime. */
export function flyerScript(config: FlyerRuntimeConfig): string {
  return `import { world, system } from '@minecraft/server';\nconst CONFIG = ${JSON.stringify(config)};\n(${flyerRuntime.toString()})(CONFIG);\n`;
}
