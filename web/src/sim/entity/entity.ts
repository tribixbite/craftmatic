/**
 * One entity in the simulated world: its type's EFFECTIVE components (base
 * plus the component groups its events added), its pose, velocity, riders,
 * dynamic and actor properties, tags and effects.
 *
 * Component groups follow the game, including the device-measured quirk
 * `group-removal-strips-base`: removing a group deletes its components from
 * the entity even where the base components declare them.
 *
 * Riding follows `minecraft:rideable`: a seat's position is in the entity
 * frame with +Z the nose (quirk `seat-z-is-nose`), turned by the mount's yaw;
 * a player's eye sits `eyeAboveSeatBlocks` over it (quirk
 * `rider-eye-above-seat`); `addRider` refuses in the tick either entity
 * spawned (quirk `add-rider-spawn-tick`).
 */

import { rotateYaw, type Box, type Vec3 } from '../core/vec.js';
import { quirkValue } from '../quirks/registry.js';
import { PLAYER_EYE_HEIGHT, PLAYER_HEIGHT, PLAYER_WIDTH } from '../physics/body.js';
import type { Components, EntityDefinition } from './definitions.js';
import { DynamicStore } from './dynamic-store.js';

/** One seat of a rideable, entity frame. */
export interface SeatDef { position: Vec3; lockRiderRotation?: number }

/** An active effect. */
export interface ActiveEffect { id: string; duration: number; amplifier: number; showParticles: boolean }

/** Why `addRider` refused, for the timeline. */
export type AddRiderRefusal = 'not-rideable' | 'spawn-tick' | 'family' | 'full' | 'already-riding' | 'self' | 'invalid';

let nextEntityNumber = 1;

/** The engine's entity. The script API's `Entity`/`Player` objects are facades over this. */
export class SimEntity {
  readonly id: string;
  location: Vec3;
  /** Pitch (x) and yaw (y), degrees. */
  rotation = { x: 0, y: 0 };
  velocity: Vec3 = { x: 0, y: 0, z: 0 };
  onGround = false;
  nameTag = '';
  /**
   * A Creative player flying (double-tapped Jump on the device): it hangs where
   * it is, no gravity, not pushed out of blocks. How a flying player MOVES is
   * not modelled (# TODO(sim-flight): flight speed and climb/descend); a test or
   * scenario that stands a player at an exact point in the air flies it there.
   */
  flying = false;
  /** A GameTest simulated player (`spawnSimulatedPlayer`): its facade adds the SimulatedPlayer members; its stick never reaches `inputInfo`. */
  simulated = false;
  valid = true;
  readonly tags = new Set<string>();
  /** Dynamic properties: the engine's view, with each pack's own values (`DynamicStore`, quirk `dynamic-properties-per-pack`). */
  readonly dynamic = new DynamicStore();
  readonly properties = new Map<string, number | boolean | string>();
  readonly effects = new Map<string, ActiveEffect>();
  /** Effective components: base, then each added group; removal strips per the quirk. */
  components: Components;
  readonly activeGroups: string[] = [];
  /** Riders by seat index. */
  readonly riders: Array<SimEntity | undefined> = [];
  ridingOn: SimEntity | undefined;
  /** The tick the entity was spawned or last teleported between dimensions. */
  readonly spawnTick: number;
  /** Highest point of the current fall and whether slow falling touched it (the fall invariant). */
  fall: { startY: number; slowFell: boolean } | undefined;

  constructor(readonly typeId: string, public dimension: string, at: Vec3, tick: number, readonly def: EntityDefinition | undefined, readonly isPlayer = false, id?: string) {
    this.id = id ?? (isPlayer ? `-${4294967295 - nextEntityNumber++}` : String(nextEntityNumber++ * 17 + 4294967296));
    this.location = { ...at };
    this.spawnTick = tick;
    this.components = { ...(def?.components ?? {}) };
    for (const [k, p] of Object.entries(def?.properties ?? {})) this.properties.set(k, p.default);
  }

  /** Families (`minecraft:type_family`); a player is `player`. */
  families(): string[] {
    if (this.isPlayer) return ['player', 'mob'];
    return ((this.components['minecraft:type_family'] as { family?: string[] } | undefined)?.family) ?? this.def?.families ?? [];
  }

  /** `minecraft:scale` (1 when absent). */
  scale(): number {
    const v = (this.components['minecraft:scale'] as { value?: number } | undefined)?.value;
    return typeof v === 'number' ? v : 1;
  }

  /**
   * The collision box the device realises, blocks (the player's own for a player): the declared
   * `minecraft:collision_box` times `minecraft:scale` (quirk `collision-box-scales-with-entity`, Saga 30l:
   * 76286's 200 % group declared 7 x 5 and the device's box was 14 x 10). Everything that reads an
   * entity's box - the tap pick, `getAABB`, a mob's sweep, the actor cull - reads this one.
   */
  collisionSize(): { width: number; height: number } {
    if (this.isPlayer) return { width: PLAYER_WIDTH, height: PLAYER_HEIGHT };
    const b = this.components['minecraft:collision_box'] as { width?: number; height?: number } | undefined;
    const k = this.scale();
    return { width: (typeof b?.width === 'number' ? b.width : 1) * k, height: (typeof b?.height === 'number' ? b.height : 1) * k };
  }

  /** The world box a ray picks: `minecraft:collision_box` about the feet (custom hit tests are the caller's). */
  aabb(): Box {
    const { width, height } = this.collisionSize(), h = width / 2, p = this.location;
    return { x0: p.x - h, y0: p.y, z0: p.z - h, x1: p.x + h, y1: p.y + height, z1: p.z + h };
  }

  /** `minecraft:physics`: whether gravity pulls it and whether it collides with blocks (Bedrock's defaults: both true). */
  physics(): { gravity: boolean; collision: boolean } {
    const p = this.components['minecraft:physics'] as { has_gravity?: boolean; has_collision?: boolean } | undefined;
    if (!p) return { gravity: false, collision: false };
    return { gravity: p.has_gravity !== false, collision: p.has_collision !== false };
  }

  /** The head: a player's eye, or the top of the box less a tenth for a mob. */
  headLocation(): Vec3 {
    if (this.isPlayer) return { x: this.location.x, y: this.location.y + PLAYER_EYE_HEIGHT, z: this.location.z };
    return { x: this.location.x, y: this.location.y + this.collisionSize().height * 0.9, z: this.location.z };
  }

  // ─── Component groups and events ───────────────────────────────────────────

  /** Apply one of the type's events. Returns the event keys the engine did not apply (reported by the caller). */
  triggerEvent(event: string): { known: boolean; unmodelled: string[] } {
    const ev = this.def?.events[event];
    if (!ev) return { known: false, unmodelled: [] };
    for (const g of ev.remove) this.removeGroup(g);
    for (const g of ev.add) this.addGroup(g);
    return { known: true, unmodelled: ev.unmodelled };
  }

  addGroup(name: string): void {
    const g = this.def?.groups[name];
    if (!g) return;
    if (!this.activeGroups.includes(name)) this.activeGroups.push(name);
    Object.assign(this.components, g);
  }

  /** Remove a group: its components go, even where the base declared them (quirk `group-removal-strips-base`). */
  removeGroup(name: string): void {
    const g = this.def?.groups[name];
    const i = this.activeGroups.indexOf(name);
    if (i >= 0) this.activeGroups.splice(i, 1);
    if (!g) return;
    for (const k of Object.keys(g)) delete this.components[k];
    // Components another still-active group declares are that group's again.
    for (const other of this.activeGroups) { const og = this.def?.groups[other]; if (og) for (const [k, v] of Object.entries(og)) if (k in g) this.components[k] = v; }
  }

  // ─── Riding ────────────────────────────────────────────────────────────────

  /** `minecraft:rideable`, or undefined. */
  rideable(): { seatCount: number; seats: SeatDef[]; familyTypes: string[]; crouchingSkipInteract: boolean; interactText?: string } | undefined {
    const r = this.components['minecraft:rideable'] as { seat_count?: number; seats?: unknown; family_types?: string[]; crouching_skip_interact?: boolean; interact_text?: string } | undefined;
    if (!r) return undefined;
    const raw = Array.isArray(r.seats) ? r.seats : r.seats ? [r.seats] : [];
    const seats: SeatDef[] = raw.map(s => {
      const p = (s as { position?: number[] }).position ?? [0, 0, 0];
      const lock = (s as { lock_rider_rotation?: number }).lock_rider_rotation;
      return { position: { x: p[0] ?? 0, y: p[1] ?? 0, z: p[2] ?? 0 }, ...(typeof lock === 'number' ? { lockRiderRotation: lock } : {}) };
    });
    return { seatCount: r.seat_count ?? Math.max(1, seats.length), seats, familyTypes: r.family_types ?? [], crouchingSkipInteract: r.crouching_skip_interact !== false, ...(r.interact_text ? { interactText: r.interact_text } : {}) };
  }

  /** Current riders, seat order. */
  riderList(): SimEntity[] { return this.riders.filter((r): r is SimEntity => !!r && r.valid); }

  /** Seat a rider, as `Rideable.addRider` does: true when seated. */
  addRider(rider: SimEntity, tick: number): { ok: true } | { ok: false; why: AddRiderRefusal } {
    const r = this.rideable();
    if (!this.valid || !rider.valid) return { ok: false, why: 'invalid' };
    if (!r) return { ok: false, why: 'not-rideable' };
    if (rider === this) return { ok: false, why: 'self' };
    if (tick <= this.spawnTick || tick <= rider.spawnTick) return { ok: false, why: 'spawn-tick' };
    if (r.familyTypes.length && !rider.families().some(f => r.familyTypes.includes(f))) return { ok: false, why: 'family' };
    if (rider.ridingOn) { if (rider.ridingOn === this) return { ok: true }; return { ok: false, why: 'already-riding' }; }
    let seat = -1;
    for (let i = 0; i < r.seatCount; i++) if (!this.riders[i] || !this.riders[i]!.valid) { seat = i; break; }
    if (seat < 0) return { ok: false, why: 'full' };
    this.riders[seat] = rider;
    rider.ridingOn = this;
    rider.velocity = { x: 0, y: 0, z: 0 };
    rider.fall = undefined;
    this.placeRider(seat);
    return { ok: true };
  }

  /** Remove a rider (dismount). */
  removeRider(rider: SimEntity): boolean {
    const i = this.riders.indexOf(rider);
    if (i < 0) return false;
    this.riders[i] = undefined;
    rider.ridingOn = undefined;
    return true;
  }

  /**
   * A seat's position in the world: the declared seat times `minecraft:scale`
   * (quirk `seat-scales-with-entity`, Saga 30k: a 200 % group's seat written
   * pre-scaled put the rider at 2 x 2 x the 100 % offset), turned by the yaw.
   */
  seatWorld(seat: number): Vec3 {
    const r = this.rideable();
    const d = r?.seats[Math.min(seat, Math.max(0, (r?.seats.length ?? 1) - 1))]?.position ?? { x: 0, y: 0, z: 0 };
    const k = this.scale();
    const o = rotateYaw({ x: d.x * k, y: d.y * k, z: d.z * k }, this.rotation.y);
    return { x: this.location.x + o.x, y: this.location.y + o.y, z: this.location.z + o.z };
  }

  /**
   * Put the rider in seat `seat` where the game draws it: a player's eye
   * `eyeAboveSeatBlocks` over the seat (so its feet are that less its eye
   * height), a mob's feet on the seat.
   * # TODO(sim-seat): a mob rider's own ride offset is not modelled.
   */
  placeRider(seat: number): void {
    const rider = this.riders[seat];
    if (!rider) return;
    const p = this.seatWorld(seat);
    const dy = rider.isPlayer ? quirkValue('rider-eye-above-seat', 'eyeAboveSeatBlocks') - PLAYER_EYE_HEIGHT : 0;
    rider.location = { x: p.x, y: p.y + dy, z: p.z };
    rider.dimension = this.dimension;
    const lock = this.rideable()?.seats[seat]?.lockRiderRotation;
    if (lock !== undefined && !rider.isPlayer) rider.rotation.y = this.rotation.y;
  }

  /** Every rider to its seat (after the mount moved). */
  placeRiders(): void { for (let i = 0; i < this.riders.length; i++) if (this.riders[i]?.valid) this.placeRider(i); }
}
