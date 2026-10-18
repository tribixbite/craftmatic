/**
 * The client's eye: what a player SEES, tick by tick, from what the scripts
 * asked of the camera and what the client draws of the server's entities.
 *
 * The simulator models the server well; the phones kept disagreeing with it
 * on the CLIENT - a camera placed at the server's pose rode in the car ahead
 * (Pixel 2026-09-29), the cockpit eye ran over the McLaren's hood at 43 mph
 * (Saga 30k) and then trailed into its engine (Saga 30l), an animation that
 * ended early flashed the player's own view, a hand-back swung the camera to
 * the car's side (Saga 30g). This module turns the script's camera requests
 * into a DRAWN pose per tick with one state machine:
 *
 *   - entities are drawn `entityLagTicks` behind the server (quirk
 *     `client-entity-lag`: 3.5 on the Pixel, marker-measured; the Saga's is
 *     DERIVED from its cockpit brackets, `clientProfile`), read from the pose
 *     history (`draw-lag.ts`), a rider on its drawn mount's seat;
 *   - `setCamera('minecraft:free', { easeOptions })` eases from the pose
 *     drawn NOW to the target over `easeTime`, linearly; re-issued every tick
 *     with the packs' 0.1 s, the drawn camera settles `easeTime / 0.05` = 2
 *     ticks behind its moving target (quirk `camera-ease-lag`: derived from
 *     the ease rule, and it is what makes the Pixel's two readings - the
 *     eased camera on the seat at lag 1.5, the animation at 3.5 - one lag);
 *     without an ease the camera is at the target the same frame (the
 *     coaster's hand-back);
 *   - `playAnimation(spline, { totalTimeSeconds, animation })` plays from the
 *     frame it is issued: the eye along the spline at the progress keyframes'
 *     alpha (by arc length), the rotation keyframes' Euler angles interpolated
 *     LINEARLY - the yaw never the short way round, the pitch continuous past
 *     ±90 (quirk `camera-roll-animation-only`, measured 2026-09-29: a `roll`
 *     chart's flip at a loop's zenith was drawn as a 180-degree spin, an
 *     `x` of 0 -> 360 as one smooth pitch-over); a `setCamera` issued while
 *     it plays takes over on that frame (`probe3-cut*`); an animation that
 *     ENDS before the next `setCamera` shows the player's own view
 *     (`ride1-loop2-zoom-d.jpg`, quirk `camera-animation-cut`);
 *   - `clear()` returns the player's own view: its drawn head, its own look.
 *
 * The walker (package A) and the snapshots draw through `ClientView.drawn`
 * and `ClientView.drawnPose`; the client invariants (`client/invariants.ts`)
 * judge the same numbers. Attach one per simulation: `ClientView.attach`.
 */

import { ORDER, type SimEngine } from '../core/engine.js';
import type { Simulation } from '../core/simulation.js';
import type { SimEntity } from '../entity/entity.js';
import { lookAngles, rotateYaw, type Vec3 } from '../core/vec.js';
import { PLAYER_EYE_HEIGHT } from '../physics/body.js';
import { quirkValue } from '../quirks/registry.js';
import { PoseHistory, type DrawnEntityPose } from './draw-lag.js';

/** Seconds per tick. */
export const TICK_SECONDS = 0.05;

/** The phones the client model has numbers for. */
export type ClientProfileName = 'pixel' | 'saga';

/** A client's measured (or derived) numbers: how far behind the server it draws entities, and whether it plays a camera ease. */
export interface ClientProfile {
  name: ClientProfileName;
  /** Ticks the client draws every entity behind the server's pose (quirk `client-entity-lag`). */
  entityLagTicks: number;
  /**
   * How much of a `setCamera` ease the client plays: 1 honours `easeTime` (the camera settles
   * `easeTime / 0.05` ticks behind a per-tick target, quirk `camera-ease-lag`); 0 draws the camera
   * at its target on the frame (the ease is not seen).
   */
  easeFactor: number;
  /** `measured`: a marker run on that phone; `derived`: read back through this model from other measurements (ASSUMED until a marker run). */
  basis: 'measured' | 'derived';
}

/**
 * The client profile by phone.
 *
 * The Pixel (26.51): the camprobe marker measured the entity lag (3.5, quirk `client-entity-lag`
 * `ticks`) by the animation, and the eased per-tick camera on the drawn marker at 1.5 - the ease's
 * own 2 ticks (quirk `camera-ease-lag`): both cameras on the seat, as every Pixel ride read.
 *
 * The Saga (26.52): no marker run. Its cockpit brackets (30k at camera lag 1.5: +1.5..2.5 blocks
 * ahead; 30l at 4: ~1 behind) pin only `entityLag - easeLag - 1` (the camera-first script order)
 * = 3: (6, 2) and (4, 0) fit them alike. Its coaster findings separate them: the first-drop entry
 * jump (6/6 laps) at every inversion animation's start and the loop-1 exit swing (5/7) at every
 * hand-back (30g, `_notes.txt` item 3), which the Pixel never showed, need the per-tick camera and
 * the animation to DIFFER on that phone - under (6, 2) both sit 2.5 ticks ahead of the drawn car
 * and nothing jumps; under (4, 0) the per-tick camera sits 2.5 ticks ahead, the animation 0.5,
 * and each switch is a 2-tick cut in one frame. So the Saga is read as an entity lag of 4 with
 * the ease NOT played (`sagaTicks` 4, `camera-ease-lag` `sagaFactor` 0): DERIVED, both numbers.
 */
export function clientProfile(name: ClientProfileName): ClientProfile {
  return name === 'saga'
    ? { name, entityLagTicks: quirkValue('client-entity-lag', 'sagaTicks'), easeFactor: quirkValue('camera-ease-lag', 'sagaFactor'), basis: 'derived' }
    : { name: 'pixel', entityLagTicks: quirkValue('client-entity-lag', 'ticks'), easeFactor: quirkValue('camera-ease-lag', 'pixelFactor'), basis: 'measured' };
}

/**
 * Ticks a camera eased over `easeSeconds` and re-issued every tick settles behind its moving target:
 * each tick covers `TICK / ease` of the remaining gap, so the gap settles at `ease / TICK` ticks of
 * motion (0.1 s -> 2 ticks; quirk `camera-ease-lag`). No ease, or a client that does not play it: none.
 */
export function easeSteadyLagTicks(easeSeconds: number, easeFactor = 1): number {
  const played = easeSeconds * easeFactor;
  return played > 0 ? played / TICK_SECONDS : 0;
}

/**
 * Blocks the drawn camera sits AHEAD of the drawn seat (negative: behind) for a camera placed
 * every tick on the vehicle's pose `cameraLagTicks` back, eased over `easeSeconds`, on a client
 * drawing entities `entityLagTicks` behind and playing `easeFactor` of the ease: the pose the
 * camera shows is `cameraLagTicks + easeSteadyLagTicks` old, the seat's `entityLagTicks` old; the
 * difference times the speed. The quirk `cockpit-draw-lag` brackets are re-derived with this.
 */
export function drawnCameraLead(speedBlocksPerSecond: number, cameraLagTicks: number, easeSeconds: number, client: Pick<ClientProfile, 'entityLagTicks' | 'easeFactor'>): number {
  return speedBlocksPerSecond * TICK_SECONDS * (client.entityLagTicks - cameraLagTicks - easeSteadyLagTicks(easeSeconds, client.easeFactor));
}

/** A camera request as a script made it, recorded with its tick. */
export type CameraRequest =
  | { kind: 'set'; tick: number; preset: string; location?: Vec3; rotation?: { x: number; y: number }; facing?: Vec3; easeTime: number; easeType?: string }
  | { kind: 'anim'; tick: number; points: Vec3[]; total: number; progress: Array<{ alpha: number; t: number }>; rotation: Array<{ x: number; y: number; z: number; t: number }> }
  | { kind: 'clear'; tick: number };

/** A camera pose: the eye and Bedrock's angles (yaw 0 faces +Z, +pitch looks down; the pitch may run past ±90 inside an animation; +roll rolls the view left). */
export interface CameraPose { eye: Vec3; yaw: number; pitch: number; roll: number }

/** What the player sees this tick. */
export type DrawnMode = 'own' | 'free' | 'animation';

export interface DrawnCamera extends CameraPose {
  mode: DrawnMode;
  /** The view direction and up vector (unit). */
  dir: Vec3; up: Vec3;
  tick: number;
  /** The preset of a non-free `setCamera` (a first/third-person preset is the player's own eye here). */
  preset?: string;
}

const DEG = Math.PI / 180;
const wrap = (a: number): number => ((a + 180) % 360 + 360) % 360 - 180;

/**
 * The view (direction, up) of a camera rotation, the roll's sign as measured on the Pixel (+roll rolls
 * the view left; `rollFrame` of the coaster tests). The pitch is taken literally past ±90: an animation's
 * continuous pitch turns the view over.
 */
export function cameraFrame(yawDeg: number, pitchDeg: number, rollDeg: number): { dir: Vec3; up: Vec3 } {
  const y = yawDeg * DEG, p = pitchDeg * DEG, r = rollDeg * DEG;
  const dir = { x: -Math.sin(y) * Math.cos(p), y: -Math.sin(p), z: Math.cos(y) * Math.cos(p) };
  const u0 = { x: -Math.sin(y) * Math.sin(p), y: Math.cos(p), z: Math.cos(y) * Math.sin(p) };
  const r0 = { x: -Math.cos(y), y: 0, z: -Math.sin(y) };
  return { dir, up: { x: Math.cos(r) * u0.x - Math.sin(r) * r0.x, y: Math.cos(r) * u0.y - Math.sin(r) * r0.y, z: Math.cos(r) * u0.z - Math.sin(r) * r0.z } };
}

/** Degrees between two directions. */
export function angleBetween(a: Vec3, b: Vec3): number {
  const la = Math.hypot(a.x, a.y, a.z) || 1, lb = Math.hypot(b.x, b.y, b.z) || 1;
  return Math.acos(Math.max(-1, Math.min(1, (a.x * b.x + a.y * b.y + a.z * b.z) / (la * lb)))) / DEG;
}

/** A linear step of fraction `k` from one pose toward another: the eye and pitch straight, the yaw the short way round, the roll straight. */
export function lerpPose(a: CameraPose, b: CameraPose, k: number): CameraPose {
  return {
    eye: { x: a.eye.x + (b.eye.x - a.eye.x) * k, y: a.eye.y + (b.eye.y - a.eye.y) * k, z: a.eye.z + (b.eye.z - a.eye.z) * k },
    yaw: a.yaw + wrap(b.yaw - a.yaw) * k, pitch: a.pitch + (b.pitch - a.pitch) * k, roll: a.roll + (b.roll - a.roll) * k,
  };
}

/** A `playAnimation` as the client plays it: the spline's cumulative arcs for the alpha, the keyframes by time. */
interface PlayingAnimation {
  start: number;
  total: number;
  points: Vec3[];
  arcs: number[];
  progress: Array<{ alpha: number; t: number }>;
  rotation: Array<{ x: number; y: number; z: number; t: number }>;
}

/** Linear interpolation of a keyed value at time `t` (clamped to the first and last keys). */
function keyed<T>(keys: readonly T[], t: number, timeOf: (k: T) => number, mix: (a: T, b: T, f: number) => T): T | undefined {
  if (!keys.length) return undefined;
  if (t <= timeOf(keys[0]!)) return keys[0];
  const last = keys[keys.length - 1]!;
  if (t >= timeOf(last)) return last;
  let i = 0;
  while (i < keys.length - 2 && timeOf(keys[i + 1]!) <= t) i++;
  const a = keys[i]!, b = keys[i + 1]!;
  const span = timeOf(b) - timeOf(a);
  return mix(a, b, span > 0 ? (t - timeOf(a)) / span : 0);
}

/**
 * The pose an animation shows `t` seconds in: the eye on the spline at the progress alpha (the
 * coaster resamples its spline to equal arc steps, so alpha by arc and by point index agree there;
 * arc is taken), the rotation keyframes' Euler angles interpolated LINEARLY (no short way round:
 * measured, a chart flip is drawn as a spin), x the NEGATED pitch, y the yaw, z the roll.
 */
export function sampleAnimation(anim: Pick<PlayingAnimation, 'points' | 'arcs' | 'progress' | 'rotation'>, t: number): CameraPose {
  const prog = keyed(anim.progress, t, k => k.t, (a, b, f) => ({ alpha: a.alpha + (b.alpha - a.alpha) * f, t }));
  const alpha = Math.max(0, Math.min(1, prog?.alpha ?? 0));
  const totalArc = anim.arcs[anim.arcs.length - 1] ?? 0;
  let eye: Vec3 = anim.points[0] ?? { x: 0, y: 0, z: 0 };
  if (anim.points.length > 1 && totalArc > 0) {
    const want = alpha * totalArc;
    let k = 1;
    while (k < anim.arcs.length - 1 && anim.arcs[k]! < want) k++;
    const a = anim.points[k - 1]!, b = anim.points[k]!;
    const f = (want - anim.arcs[k - 1]!) / Math.max(1e-9, anim.arcs[k]! - anim.arcs[k - 1]!);
    eye = { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f };
  }
  const rot = keyed(anim.rotation, t, k => k.t, (a, b, f) => ({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f, t }));
  return { eye, yaw: rot?.y ?? 0, pitch: -(rot?.x ?? 0), roll: rot?.z ?? 0 };
}

/** The camera state of one player on the client. */
class PlayerCamera {
  mode: DrawnMode = 'own';
  /** The drawn pose while `free` or `animation`. */
  pose: CameraPose = { eye: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, roll: 0 };
  ease: { to: CameraPose; remaining: number } | undefined;
  anim: PlayingAnimation | undefined;
  preset: string | undefined;
  /** Requests made this tick, applied at the client's frame for it. */
  pending: CameraRequest[] = [];
  /** The last requests, newest last (a probe reads them). */
  readonly log: CameraRequest[] = [];
  /** The tick of the last request that gave the script a camera (`set`/`anim`), for the flash rule. */
  lastScriptCameraTick = -Infinity;
  /** The tick the animation playing last ended on its own (an own-view flash on a riding player). */
  animationEndedTick = -Infinity;
  /** The pose the SCRIPT asked for this frame (the ease's target, the animation's sample, the instant set): what it means the view to be. */
  target: CameraPose | undefined;

  record(r: CameraRequest): void {
    this.pending.push(r);
    this.log.push(r);
    if (this.log.length > 600) this.log.shift();
  }

  /** One client frame: advance the ease or the animation by a tick, then apply this tick's requests. */
  advance(now: number, own: () => CameraPose, easeFactor = 1): void {
    if (this.mode === 'free' && this.ease) {
      const k = Math.min(1, TICK_SECONDS / Math.max(1e-9, this.ease.remaining));
      this.pose = lerpPose(this.pose, this.ease.to, k);
      this.ease.remaining -= TICK_SECONDS;
      if (this.ease.remaining <= 1e-9) this.ease = undefined;
    } else if (this.mode === 'animation' && this.anim) {
      const t = (now - this.anim.start) * TICK_SECONDS;
      if (t > this.anim.total + 1e-9) {
        // The animation ran out before any script camera replaced it: the player's own view (measured, Pixel 2026-09-29).
        this.mode = 'own'; this.anim = undefined; this.animationEndedTick = now; this.target = undefined;
      } else { this.pose = sampleAnimation(this.anim, t); this.target = this.pose; }
    }
    for (const r of this.pending) this.apply(r, now, own, easeFactor);
    this.pending = [];
  }

  /** Apply one request on the frame `now` (a script's request lands on the frame of its own tick; a test's made between ticks on the next). */
  private apply(r: CameraRequest, now: number, own: () => CameraPose, easeFactor: number): void {
    if (r.kind === 'clear') { this.mode = 'own'; this.ease = undefined; this.anim = undefined; this.preset = undefined; this.target = undefined; return; }
    this.lastScriptCameraTick = r.tick;
    if (r.kind === 'anim') {
      const arcs = [0];
      for (let k = 1; k < r.points.length; k++) { const a = r.points[k - 1]!, b = r.points[k]!; arcs.push(arcs[k - 1]! + Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)); }
      this.anim = { start: now, total: r.total, points: r.points, arcs, progress: r.progress, rotation: r.rotation };
      this.mode = 'animation'; this.ease = undefined; this.preset = undefined;
      this.pose = sampleAnimation(this.anim, 0);
      this.target = this.pose;
      return;
    }
    if (r.preset !== 'minecraft:free') {
      // A first/third-person preset: the player's own eye (no pack uses one; recorded, drawn as the own view).
      this.mode = 'own'; this.ease = undefined; this.anim = undefined; this.preset = r.preset; this.target = undefined;
      return;
    }
    const from = this.mode === 'own' ? own() : this.pose;
    const eye = r.location ?? from.eye;
    let yaw = from.yaw, pitch = from.pitch;
    if (r.rotation) { yaw = r.rotation.y; pitch = r.rotation.x; }
    else if (r.facing) { const a = lookAngles({ x: r.facing.x - eye.x, y: r.facing.y - eye.y, z: r.facing.z - eye.z }); yaw = a.yaw; pitch = a.pitch; }
    const target: CameraPose = { eye: { ...eye }, yaw, pitch, roll: 0 };
    // A `setCamera` while an animation plays cuts it on this frame (measured, `probe3-cut*`).
    this.anim = undefined; this.preset = undefined;
    // The ease the CLIENT plays: the request's time scaled by the profile (a client that does not play it draws the target at once).
    const ease = r.easeTime * easeFactor;
    if (ease > 0) { this.pose = from; this.ease = { to: target, remaining: ease }; }
    else { this.pose = target; this.ease = undefined; }
    this.target = target;
    this.mode = 'free';
  }
}

const BY_ENGINE = new WeakMap<SimEngine, ClientView>();

/**
 * The client of one simulated world: the drawn poses of every entity and
 * every watched player's camera, advanced once a tick after the scripts.
 */
export class ClientView {
  readonly poses = new PoseHistory();
  private readonly cameras = new Map<SimEntity, PlayerCamera>();
  private readonly watched = new WeakSet<SimEntity>();
  /** The engine's tick the client last drew. */
  tick = 0;

  private constructor(readonly sim: Simulation, readonly profile: ClientProfile) {
    sim.engine.addSystem({ name: 'client', order: ORDER.observers, tick: () => this.frame() });
    for (const p of sim.engine.players) this.watch(p);
  }

  /** The client attached to a simulation (one per world; a second attach returns the first, whatever its profile). */
  static attach(sim: Simulation, profile: ClientProfile | ClientProfileName = 'pixel'): ClientView {
    const have = BY_ENGINE.get(sim.engine);
    if (have) return have;
    const view = new ClientView(sim, typeof profile === 'string' ? clientProfile(profile) : profile);
    BY_ENGINE.set(sim.engine, view);
    return view;
  }

  /** The client attached to an engine, if any. */
  static of(engine: SimEngine): ClientView | undefined { return BY_ENGINE.get(engine); }

  /**
   * Record a player's camera requests: the facade the scripts hold (`player.camera`) is wrapped, as the
   * camera probes wrap it, so every `setCamera`, `playAnimation` and `clear` is seen with its arguments.
   */
  watch(player: SimEntity): void {
    if (this.watched.has(player) || !player.isPlayer) return;
    this.watched.add(player);
    const cam = this.camera(player);
    const api = this.sim.host.entity(player) as { camera: Record<string, unknown> };
    const facade = api.camera;
    const setCamera = facade['setCamera'] as (preset: string, opts?: Record<string, unknown>) => unknown;
    const playAnimation = facade['playAnimation'] as (spline: unknown, opts?: Record<string, unknown>) => unknown;
    const clear = facade['clear'] as () => unknown;
    const tick = (): number => this.sim.engine.tick;
    facade['setCamera'] = (preset: string, opts?: Record<string, unknown>) => {
      const r = setCamera(preset, opts); // validates as the game does (the pitch limit) before anything is recorded
      const ease = opts?.['easeOptions'] as { easeTime?: number; easeType?: string } | undefined;
      const loc = opts?.['location'] as Vec3 | undefined, rot = opts?.['rotation'] as { x: number; y: number } | undefined, facing = opts?.['facingLocation'] as Vec3 | undefined;
      cam.record({ kind: 'set', tick: tick(), preset, ...(loc ? { location: { x: loc.x, y: loc.y, z: loc.z } } : {}), ...(rot ? { rotation: { x: rot.x, y: rot.y } } : {}), ...(facing ? { facing: { x: facing.x, y: facing.y, z: facing.z } } : {}), easeTime: Math.max(0, Number(ease?.easeTime ?? 0)), ...(ease?.easeType ? { easeType: String(ease.easeType) } : {}) });
      return r;
    };
    facade['playAnimation'] = (spline: unknown, opts?: Record<string, unknown>) => {
      const r = playAnimation(spline, opts);
      const points = ((spline as { controlPoints?: unknown[] } | undefined)?.controlPoints ?? []).filter((p): p is Vec3 => !!p && typeof (p as Vec3).x === 'number').map(p => ({ x: p.x, y: p.y, z: p.z }));
      const anim = opts?.['animation'] as { progressKeyFrames?: Array<{ alpha?: number; timeSeconds?: number }>; rotationKeyFrames?: Array<{ rotation?: { x?: number; y?: number; z?: number }; timeSeconds?: number }> } | undefined;
      cam.record({
        kind: 'anim', tick: tick(), points, total: Number(opts?.['totalTimeSeconds'] ?? 0),
        progress: (anim?.progressKeyFrames ?? []).map(k => ({ alpha: Number(k.alpha ?? 0), t: Number(k.timeSeconds ?? 0) })),
        rotation: (anim?.rotationKeyFrames ?? []).map(k => ({ x: Number(k.rotation?.x ?? 0), y: Number(k.rotation?.y ?? 0), z: Number(k.rotation?.z ?? 0), t: Number(k.timeSeconds ?? 0) })),
      });
      return r;
    };
    facade['clear'] = () => { const r = clear(); cam.record({ kind: 'clear', tick: tick() }); return r; };
  }

  private camera(player: SimEntity): PlayerCamera {
    let c = this.cameras.get(player);
    if (!c) this.cameras.set(player, c = new PlayerCamera());
    return c;
  }

  /** The client's frame for the tick just simulated: poses recorded, every watched player's camera advanced. */
  private frame(): void {
    const engine = this.sim.engine;
    this.tick = engine.tick;
    this.poses.record(engine);
    for (const p of engine.players) if (p.valid) this.watch(p);
    for (const [p, cam] of this.cameras) if (p.valid) cam.advance(this.tick, () => this.ownPose(p), this.profile.easeFactor);
  }

  /** The pose the client draws an entity at NOW: `entityLagTicks` behind the server; a rider on its drawn mount's seat; a walking player where it is. */
  drawnPose(e: SimEntity): DrawnEntityPose {
    const now = this.tick;
    const mount = e.ridingOn;
    if (mount && mount.valid) {
      const mp = this.drawnPose(mount);
      const r = mount.rideable();
      const i = Math.max(0, mount.riders.indexOf(e));
      const d = r?.seats[Math.min(i, Math.max(0, (r?.seats.length ?? 1) - 1))]?.position ?? { x: 0, y: 0, z: 0 };
      const o = rotateYaw({ x: d.x * mp.scale, y: d.y * mp.scale, z: d.z * mp.scale }, mp.yaw);
      const dy = e.isPlayer ? quirkValue('rider-eye-above-seat', 'eyeAboveSeatBlocks') - PLAYER_EYE_HEIGHT : 0;
      return { tick: now, x: mp.x + o.x, y: mp.y + o.y + dy, z: mp.z + o.z, yaw: e.rotation.y, pitch: e.rotation.x, scale: e.scale() };
    }
    if (e.isPlayer) return { tick: now, x: e.location.x, y: e.location.y, z: e.location.z, yaw: e.rotation.y, pitch: e.rotation.x, scale: 1 };
    return this.poses.lagged(e, now, this.profile.entityLagTicks) ?? { tick: now, x: e.location.x, y: e.location.y, z: e.location.z, yaw: e.rotation.y, pitch: e.rotation.x, scale: e.scale() };
  }

  /** The drawn velocity (blocks per tick) of an entity's drawn pose: the drawn mount's for a rider, the lagged history's otherwise. */
  drawnVelocity(e: SimEntity): Vec3 {
    const mount = e.ridingOn;
    if (mount && mount.valid) return this.drawnVelocity(mount);
    if (e.isPlayer) return { ...e.velocity };
    return this.poses.velocityAt(e, this.tick - this.profile.entityLagTicks) ?? { x: 0, y: 0, z: 0 };
  }

  /** A player's drawn head: its drawn feet plus the eye height (a rider's seat eye on the drawn mount). */
  drawnHead(player: SimEntity): Vec3 {
    const p = this.drawnPose(player);
    return { x: p.x, y: p.y + PLAYER_EYE_HEIGHT, z: p.z };
  }

  /** The player's own view: from its drawn head along its own look (client-authoritative; the carried rider yaw is the server's `riders` system's). */
  ownPose(player: SimEntity): CameraPose {
    return { eye: this.drawnHead(player), yaw: player.rotation.y, pitch: player.rotation.x, roll: 0 };
  }

  /** What the player sees this tick. */
  drawn(player: SimEntity): DrawnCamera {
    const cam = this.camera(player);
    const pose = cam.mode === 'own' ? this.ownPose(player) : cam.pose;
    const { dir, up } = cameraFrame(pose.yaw, pose.pitch, pose.roll);
    return { mode: cam.mode, ...pose, eye: { ...pose.eye }, dir, up, tick: this.tick, ...(cam.preset ? { preset: cam.preset } : {}) };
  }

  /**
   * What the SCRIPT means the view to be this frame (the ease's target, the animation's sample): a jump here is the
   * script's own cut (a view switched); a jump in `drawn` with none here is the client's (the hand-back's ease).
   */
  scriptTarget(player: SimEntity): DrawnCamera | undefined {
    const cam = this.camera(player);
    if (cam.mode === 'own' || !cam.target) return undefined;
    const t = cam.target;
    const { dir, up } = cameraFrame(t.yaw, t.pitch, t.roll);
    return { mode: cam.mode, ...t, eye: { ...t.eye }, dir, up, tick: this.tick };
  }

  /** The tick of the last request that gave the player a script camera, -Infinity for none. */
  lastScriptCameraTick(player: SimEntity): number { return this.camera(player).lastScriptCameraTick; }

  /** The tick an animation last ran out on its own (the player's own view showed), -Infinity for never. */
  animationEndedTick(player: SimEntity): number { return this.camera(player).animationEndedTick; }

  /** Whether an animation is playing for the player. */
  animating(player: SimEntity): boolean { return this.camera(player).mode === 'animation'; }

  /** The player's recent camera requests, oldest first. */
  requests(player: SimEntity): readonly CameraRequest[] { return this.camera(player).log; }
}

/** Attach the client to a simulation and watch a player: the scenario runner's `prepare` hook. */
export function attachClient(sim: Simulation, player: SimEntity, profile: ClientProfile | ClientProfileName = 'pixel'): ClientView {
  const view = ClientView.attach(sim, profile);
  view.watch(player);
  return view;
}
