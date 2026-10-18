/**
 * What must hold of the DRAWN picture every tick: the client invariants, judged
 * from `ClientView` (the eased or animated camera, the lagged entities), never
 * from the script's target.
 *
 *   camera-continuous   frame to frame, while the script means the view to be
 *                       continuous (a script camera on both frames, no `clear`
 *                       between), the drawn view turns at most the script's own
 *                       per-tick limit (`COASTER_RIDER_VIEW.maxTurn`, 40) and the
 *                       drawn eye never jumps more than a block relative to the
 *                       drawn seat (Saga 30g, 10303: the first-drop "entry jump",
 *                       camera under/beside the car -> behind it in ONE frame,
 *                       6/6 laps; the loop-1 "exit swing", 5/7, `_notes.txt`
 *                       item 3). The device's jump is not quantified in degrees;
 *                       the thresholds are the script's own intent and a block;
 *   camera-on-own-seat  while riding with the camera the script means at the
 *                       rider's head (a coaster car; a vehicle's cockpit view,
 *                       hotbar slot 9) and the drawn seat moving faster than
 *                       `SEAT_SPEED_FLOOR`, the drawn eye is within
 *                       `SEAT_EYE_SLACK` of the drawn seat eye ALONG THE HEADING
 *                       (the general form of the course's `cockpit-eye-on-seat`,
 *                       now from the drawn pose; Saga 30k: over the hood, 30l: in
 *                       the engine);
 *   no-own-view-flash   while riding with a script camera, the drawn view never
 *                       falls back to the player's own view (an animation that
 *                       ended before the next `setCamera`: Pixel 2026-09-29,
 *                       `ride1-loop2-zoom-d.jpg`; quirk `camera-animation-cut`)
 *                       - a dismount's release (`clear`) is not a flash.
 *
 * The render invariants (`no-visible-hatch-near`, `no-dropped-face-in-view`,
 * `lod-switch-under-cull`) are judged where a picture is taken, by the client
 * steps (`client/steps.ts`), with these ids.
 */

import type { SimEntity } from '../entity/entity.js';
import type { Invariant, InvariantContext } from '../scenario/invariants.js';
import { angleBetween, ClientView, type DrawnCamera } from './camera.js';
import { PLAYER_EYE_HEIGHT } from '../physics/body.js';

/** The client invariants' ids (a scenario lists them to run only some). */
export const CLIENT_INVARIANT_IDS = ['camera-continuous', 'camera-on-own-seat', 'no-own-view-flash'] as const;
/** The render invariants' ids (judged by the snapshot steps). */
export const RENDER_INVARIANT_IDS = ['no-visible-hatch-near', 'no-dropped-face-in-view', 'lod-switch-under-cull'] as const;

/**
 * The most the drawn view may turn in one frame while the script means continuity: the coaster camera's own
 * per-tick cap (`COASTER_RIDER_VIEW.maxTurn`, 40; test/sim-client.test.ts pins the equality - the engine core
 * does not import the adapter's runtime).
 */
export const CAMERA_MAX_TURN_DEG = 40;
/** The most the drawn eye may move in one frame beyond the drawn seat's own motion (blocks): a jump a rider sees. */
export const CAMERA_MAX_EYE_JUMP_BLOCKS = 1;
/** Blocks the drawn eye may sit off the drawn seat eye along the heading (the course's `COCKPIT_EYE_SLACK`). */
export const SEAT_EYE_SLACK = 0.5;
/** Below this drawn speed (blocks/s) a seat offset says nothing (every lag reads as zero at rest). */
export const SEAT_SPEED_FLOOR = 2;

export interface ClientInvariantOptions {
  /**
   * Whether the script means the camera at the rider's own head on this mount: the adapter knows its packs (a
   * coaster car; a scripted vehicle's cockpit view, `craftmaticSeatCamera` in adapters/craftmatic/client-steps.ts).
   * Without it, `camera-on-own-seat` judges every script camera while riding.
   */
  seatCamera?: (player: SimEntity, mount: SimEntity, ctx: InvariantContext) => boolean;
}

const round = (v: number): number => Math.round(v * 100) / 100;
const pt = (p: { x: number; y: number; z: number }): { x: number; y: number; z: number } => ({ x: round(p.x), y: round(p.y), z: round(p.z) });

/** One frame's change of the drawn camera against the previous: the view's turn (degrees) and the eye's jump beyond the drawn seat's own motion (blocks). */
export function cameraFrameDelta(prev: { camera: DrawnCamera; seat?: { x: number; y: number; z: number } }, now: { camera: DrawnCamera; seat?: { x: number; y: number; z: number } }): { turnDeg: number; jumpBlocks: number } {
  const turnDeg = angleBetween(prev.camera.dir, now.camera.dir);
  const dEye = { x: now.camera.eye.x - prev.camera.eye.x, y: now.camera.eye.y - prev.camera.eye.y, z: now.camera.eye.z - prev.camera.eye.z };
  const dSeat = now.seat && prev.seat ? { x: now.seat.x - prev.seat.x, y: now.seat.y - prev.seat.y, z: now.seat.z - prev.seat.z } : { x: 0, y: 0, z: 0 };
  return { turnDeg, jumpBlocks: Math.hypot(dEye.x - dSeat.x, dEye.y - dSeat.y, dEye.z - dSeat.z) };
}

/** The drawn seat eye of a riding player and the drawn heading of its mount (unit, horizontal where the mount is level). */
export function drawnSeat(client: ClientView, player: SimEntity): { eye: { x: number; y: number; z: number }; forward: { x: number; y: number; z: number }; speed: number } | undefined {
  const mount = player.ridingOn;
  if (!mount || !mount.valid) return undefined;
  const feet = client.drawnPose(player);
  const eye = { x: feet.x, y: feet.y + PLAYER_EYE_HEIGHT, z: feet.z };
  const v = client.drawnVelocity(mount);
  const speed = Math.hypot(v.x, v.y, v.z) * 20;
  let forward = { x: v.x, y: v.y, z: v.z };
  const l = Math.hypot(forward.x, forward.y, forward.z);
  if (l > 1e-6) forward = { x: forward.x / l, y: forward.y / l, z: forward.z / l };
  else { const yaw = client.drawnPose(mount).yaw * Math.PI / 180; forward = { x: -Math.sin(yaw), y: 0, z: Math.cos(yaw) }; }
  return { eye, forward, speed };
}

/** Blocks the drawn camera eye sits ahead (+) of the drawn seat eye along the mount's drawn heading. */
export function seatLead(client: ClientView, player: SimEntity, camera: DrawnCamera): number | undefined {
  const s = drawnSeat(client, player);
  if (!s) return undefined;
  return (camera.eye.x - s.eye.x) * s.forward.x + (camera.eye.y - s.eye.y) * s.forward.y + (camera.eye.z - s.eye.z) * s.forward.z;
}

/**
 * Whether the script meant two consecutive frames to be continuous: a script camera on both, and the script's OWN
 * target (`scriptTarget`) neither turned past the cap nor jumped past a block against the seat - a view the script
 * switched on purpose (chase to cockpit, a `clear`) is a cut by design, a hand-back it planned to meet is not.
 */
export function scriptMeansContinuity(prevTarget: DrawnCamera | undefined, target: DrawnCamera | undefined, prevSeat?: { x: number; y: number; z: number }, seat?: { x: number; y: number; z: number }): boolean {
  if (!prevTarget || !target) return false;
  const d = cameraFrameDelta({ camera: prevTarget, ...(prevSeat ? { seat: prevSeat } : {}) }, { camera: target, ...(seat ? { seat } : {}) });
  return d.turnDeg <= CAMERA_MAX_TURN_DEG + 1e-6 && d.jumpBlocks <= CAMERA_MAX_EYE_JUMP_BLOCKS + 1e-6;
}

/** Whether the drawn camera has reached its script target: within the eye-jump threshold and the turn cap of it (the arrival of an ease is over). */
export function cameraArrived(camera: DrawnCamera, target: DrawnCamera | undefined): boolean {
  if (!target) return false;
  const d = cameraFrameDelta({ camera }, { camera: target });
  return d.jumpBlocks <= CAMERA_MAX_EYE_JUMP_BLOCKS + 1e-6 && d.turnDeg <= CAMERA_MAX_TURN_DEG + 1e-6;
}

/**
 * The judgement: what the CLIENT adds frame to frame beyond the script's own target motion. A chase camera's
 * orbit or recentre moves its target a block a frame and the drawn camera follows it: the script means that. A
 * jump the drawn eye makes that the target did not (an ease restarted from a stale pose: the coaster hand-back's
 * fall-back; a cut the client made) is the client's. Inside an animation the drawn pose IS the keyframes'
 * interpolation, so its per-frame turn is judged against the cap outright (the 2026-09-29 spin lived in the
 * keyframes). Until the drawn camera first reaches its target after a script camera begins (`cameraArrived`) the
 * frames are its arrival from wherever the player was looking (a chase boom 48 blocks out on the Milano eases out
 * over ~10 frames: the device's first mount does the same), judged by nothing.
 */
function cameraContinuous(): Invariant {
  let prev: { camera: DrawnCamera; target: DrawnCamera | undefined; seat?: { x: number; y: number; z: number } } | undefined;
  let arrived = false;
  return {
    id: 'camera-continuous', description: `Frame to frame, the client adds no turn over ${CAMERA_MAX_TURN_DEG} degrees and no eye jump over ${CAMERA_MAX_EYE_JUMP_BLOCKS} block (against the drawn seat) beyond the script's own target motion, once the drawn camera has arrived at a script camera; an animation's own per-frame turn stays under the cap.`,
    tick(ctx) {
      const client = ClientView.of(ctx.engine);
      if (!client) return;
      const p = ctx.player;
      const camera = client.drawn(p), target = client.scriptTarget(p);
      const seat = drawnSeat(client, p)?.eye;
      const now = { camera, target, ...(seat ? { seat } : {}) };
      if (camera.mode === 'own' || !prev || prev.camera.mode === 'own') arrived = false;
      else if (!arrived) arrived = cameraArrived(camera, target);
      else if (prev.target && target) {
        const drawn = cameraFrameDelta(prev, now);
        const meant = cameraFrameDelta({ camera: prev.target, ...(prev.seat ? { seat: prev.seat } : {}) }, { camera: target, ...(seat ? { seat } : {}) });
        const excessTurn = drawn.turnDeg - meant.turnDeg, excessJump = drawn.jumpBlocks - meant.jumpBlocks;
        if (camera.mode === 'animation' && drawn.turnDeg > CAMERA_MAX_TURN_DEG + 1e-6) ctx.report({ invariant: 'camera-continuous', message: `the animation turned the view ${round(drawn.turnDeg)} degrees in one frame (cap ${CAMERA_MAX_TURN_DEG}: a chart flip drawn as a spin)`, evidence: { turnDeg: round(drawn.turnDeg), mode: camera.mode, eye: pt(camera.eye), profile: client.profile.name } });
        else if (excessTurn > CAMERA_MAX_TURN_DEG + 1e-6) ctx.report({ invariant: 'camera-continuous', message: `the drawn view turned ${round(drawn.turnDeg)} degrees in one frame (${prev.camera.mode} -> ${camera.mode}) where the script's own target turned ${round(meant.turnDeg)} (cap ${CAMERA_MAX_TURN_DEG} beyond the target)`, evidence: { turnDeg: round(drawn.turnDeg), targetTurnDeg: round(meant.turnDeg), from: prev.camera.mode, to: camera.mode, eye: pt(camera.eye), profile: client.profile.name } });
        if (excessJump > CAMERA_MAX_EYE_JUMP_BLOCKS + 1e-6) ctx.report({ invariant: 'camera-continuous', message: `the drawn eye jumped ${round(drawn.jumpBlocks)} blocks against the drawn seat in one frame (${prev.camera.mode} -> ${camera.mode}) where the script's own target moved ${round(meant.jumpBlocks)}`, evidence: { jumpBlocks: round(drawn.jumpBlocks), targetJumpBlocks: round(meant.jumpBlocks), from: prev.camera.mode, to: camera.mode, eye: pt(camera.eye), previous: pt(prev.camera.eye), profile: client.profile.name } });
      }
      prev = now;
    },
  };
}

function cameraOnOwnSeat(options: ClientInvariantOptions): Invariant {
  const reported = new Set<SimEntity>();
  return {
    id: 'camera-on-own-seat', description: `A script camera meant at the rider's head is drawn within ${SEAT_EYE_SLACK} block of the drawn seat eye along the heading while the seat moves faster than ${SEAT_SPEED_FLOOR} blocks/s.`,
    tick(ctx) {
      const client = ClientView.of(ctx.engine);
      if (!client) return;
      const p = ctx.player, mount = p.ridingOn;
      if (!mount || !mount.valid) return;
      const meant = options.seatCamera ? options.seatCamera(p, mount, ctx) : true;
      if (!meant || reported.has(mount)) return;
      const camera = client.drawn(p);
      if (camera.mode === 'own') return;
      const s = drawnSeat(client, p);
      const lead = seatLead(client, p, camera);
      if (!s || lead === undefined || s.speed < SEAT_SPEED_FLOOR) return;
      if (Math.abs(lead) > SEAT_EYE_SLACK) {
        reported.add(mount);
        ctx.report({ invariant: 'camera-on-own-seat', message: `the drawn ${camera.mode} camera sits ${round(lead)} blocks ${lead > 0 ? 'AHEAD of' : 'behind'} the drawn seat eye of ${mount.typeId} at ${round(s.speed)} blocks/s (client ${client.profile.name}, entity lag ${client.profile.entityLagTicks})`, evidence: { lead: round(lead), speed: round(s.speed), mode: camera.mode, eye: pt(camera.eye), seatEye: pt(s.eye), profile: client.profile.name } });
      }
    },
  };
}

function noOwnViewFlash(): Invariant {
  const reported = new Set<SimEntity>();
  let prevMode: DrawnCamera['mode'] | undefined, prevMount: SimEntity | undefined;
  return {
    id: 'no-own-view-flash', description: 'While riding with a script camera the drawn view never falls back to the player\'s own view (an animation that ended before the next setCamera).',
    tick(ctx) {
      const client = ClientView.of(ctx.engine);
      if (!client) return;
      const p = ctx.player, mount = p.ridingOn;
      const camera = client.drawn(p);
      // A flash: the view was the script's on the previous frame, is the player's own now, the player still rides the
      // same mount, and the script did not release it (an animation ran out, `animationEndedTick`).
      if (mount && mount.valid && mount === prevMount && prevMode && prevMode !== 'own' && camera.mode === 'own' && client.animationEndedTick(p) === ctx.engine.tick && !reported.has(mount)) {
        reported.add(mount);
        ctx.report({ invariant: 'no-own-view-flash', message: `the camera animation ended before the next setCamera: the rider's own view showed on ${mount.typeId} (client ${client.profile.name})`, evidence: { mount: mount.typeId, eye: pt(camera.eye), lastScriptCameraTick: client.lastScriptCameraTick(p) } });
      }
      prevMode = camera.mode; prevMount = mount && mount.valid ? mount : undefined;
    },
  };
}

/** The client invariants, for `runScenario`'s `invariants` option (the client itself is attached in `prepare`: `attachClient`). */
export function clientInvariants(options: ClientInvariantOptions = {}): Invariant[] {
  return [cameraContinuous(), cameraOnOwnSeat(options), noOwnViewFlash()];
}
