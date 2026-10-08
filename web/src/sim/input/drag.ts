/**
 * Touch DRAGS: a finger moved over the screen, turned into degrees of look and
 * routed by the player's control scheme and seat (`scheme.ts`). The players
 * system applies each tick's queued drag first thing, before the move, as the
 * client sends its look with its input.
 *
 * Every applied drag is recorded (`dragRecords`) with the look before and
 * after, so an invariant can MEASURE whether a drag reached the rider's look
 * (`rider-drag-reaches-look`) instead of inferring it from the scheme.
 */

import type { SimEngine } from '../core/engine.js';
import type { SimEntity } from '../entity/entity.js';
import { quirkValue } from '../quirks/registry.js';
import type { ControlState, DragDelta } from './controls.js';
import { dragRoute, type DragRoute } from './scheme.js';

/** What the drag router needs from the script host about a player (its scheme and whether a script camera is on). */
export interface DragClient {
  scheme(player: SimEntity): string | undefined;
  scriptCamera(player: SimEntity): boolean;
}

/** One applied drag. */
export interface DragRecord {
  tick: number;
  playerId: string;
  /** The mount ridden when it was applied, if any. */
  mount?: string;
  scheme?: string;
  route: DragRoute;
  asked: DragDelta;
  /** The look before and after (degrees). */
  before: { yaw: number; pitch: number };
  after: { yaw: number; pitch: number };
}

/** A player's client camera orbit (a drag-to-camera scheme's Follow Orbit camera), degrees off the look. */
export interface CameraOrbit { yawDeg: number; pitchDeg: number }

const clients = new WeakMap<SimEngine, DragClient>();
const records = new WeakMap<SimEngine, DragRecord[]>();
const orbits = new WeakMap<SimEngine, Map<string, CameraOrbit>>();

/** A yaw into (-180, 180]. */
const wrapDeg = (a: number): number => ((a + 180) % 360 + 360) % 360 - 180;
/** Bedrock's pitch range (quirk `camera-pitch-limit`: +-90). */
const clampPitch = (p: number): number => Math.max(-90, Math.min(90, p));

/** Bind the script host's view of players (scheme, script camera) to an engine's drag router. */
export function setDragClient(engine: SimEngine, client: DragClient): void { clients.set(engine, client); }

/** Every drag applied on an engine so far, oldest first. */
export function dragRecords(engine: SimEngine): readonly DragRecord[] { return records.get(engine) ?? []; }

/** A player's client camera orbit (zero when no drag went to it). */
export function cameraOrbit(engine: SimEngine, playerId: string): CameraOrbit { return orbits.get(engine)?.get(playerId) ?? { yawDeg: 0, pitchDeg: 0 }; }

/**
 * A finger's drag in screen pixels (+x right, +y down), queued as degrees of look at the phone's touch
 * sensitivity (quirk `touch-drag-degrees-per-pixel`: the Saga's 400-px swipe turned the look 84 degrees). A
 * finger moved right turns the view right; moved down, the view looks down (ASSUMED direction for pitch).
 */
export function dragPixels(controls: ControlState, playerId: string, dx: number, dy: number): DragDelta {
  const k = quirkValue('touch-drag-degrees-per-pixel', 'degreesPerPixel');
  const d = { yawDeg: dx * k, pitchDeg: dy * k };
  controls.drag(playerId, d);
  return d;
}

/**
 * Apply a player's queued drag (the players system calls this at the start of each tick). The route comes from
 * `dragRoute`; the seat's lock is read from the mount's `minecraft:rideable`.
 */
export function applyPendingDrag(engine: SimEngine, controls: ControlState, p: SimEntity): DragRecord | undefined {
  const d = controls.takeDrag(p.id);
  if (!d || (d.yawDeg === 0 && d.pitchDeg === 0)) return undefined;
  const client = clients.get(engine);
  const mount = p.ridingOn;
  const seatLock = mount ? mount.rideable()?.seats[Math.max(0, mount.riders.indexOf(p))]?.lockRiderRotation : undefined;
  const scheme = client?.scheme(p);
  const route = dragRoute({ scheme, seatLock, riding: !!mount, scriptCamera: client?.scriptCamera(p) ?? false });
  const before = { yaw: p.rotation.y, pitch: p.rotation.x };
  if (route === 'look') p.rotation = { x: clampPitch(p.rotation.x + d.pitchDeg), y: wrapDeg(p.rotation.y + d.yawDeg) };
  else if (route === 'pitch-only') p.rotation = { x: clampPitch(p.rotation.x + d.pitchDeg), y: mount ? mount.rotation.y : p.rotation.y };
  else if (route === 'orbit') {
    const m = orbits.get(engine) ?? new Map<string, CameraOrbit>();
    orbits.set(engine, m);
    const o = m.get(p.id) ?? { yawDeg: 0, pitchDeg: 0 };
    m.set(p.id, { yawDeg: wrapDeg(o.yawDeg + d.yawDeg), pitchDeg: clampPitch(o.pitchDeg + d.pitchDeg) });
  }
  const rec: DragRecord = { tick: engine.tick, playerId: p.id, ...(mount ? { mount: mount.typeId } : {}), ...(scheme ? { scheme } : {}), route, asked: d, before, after: { yaw: p.rotation.y, pitch: p.rotation.x } };
  const list = records.get(engine) ?? [];
  list.push(rec);
  records.set(engine, list);
  return rec;
}

/** How much of a drag reached the look: the look's turn over the turn asked, 0..1 (yaw and pitch together). */
export function dragReach(r: DragRecord): number {
  const asked = Math.hypot(r.asked.yawDeg, r.asked.pitchDeg);
  if (asked < 1e-9) return 1;
  const got = Math.hypot(wrapDeg(r.after.yaw - r.before.yaw), r.after.pitch - r.before.pitch);
  return Math.min(1, got / asked);
}
