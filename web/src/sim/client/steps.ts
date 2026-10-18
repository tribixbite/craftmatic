/**
 * Engine-level helpers for scenario steps that read the client's eye: a
 * per-tick trace of the drawn camera against the drawn seat (what a camera
 * step records each tick), and a frame-capture policy (every tick where the
 * view is doing something - an animation, a steep pitch, the ticks after a
 * hand-back - a sparse frame elsewhere). The craftmatic steps
 * (`adapters/craftmatic/client-steps.ts`) build on these; they know no pack.
 */

import type { SimEntity } from '../entity/entity.js';
import { ClientView, type DrawnCamera } from './camera.js';
import { cameraFrameDelta, drawnSeat, seatLead } from './invariants.js';

/** One tick of the drawn camera while riding (or walking): what a camera trace keeps. */
export interface CameraTraceRow {
  tick: number;
  mode: DrawnCamera['mode'];
  /** Blocks the drawn eye sits ahead of the drawn seat eye along the heading (undefined when not riding). */
  lead?: number;
  /** The same for the SCRIPT's target (the ease's target, the animation's sample): the lead before the client's ease. */
  targetLead?: number;
  /** The script's target against the SERVER's seat eye (this tick's pose) along the heading: minus the script's own camera lag in blocks. */
  serverLead?: number;
  /** The server's speed of the mount this tick, blocks/s. */
  serverSpeed?: number;
  /** The drawn seat's speed, blocks/s. */
  speed?: number;
  /** The frame's change against the previous: the view's turn (degrees) and the eye's jump beyond the seat's motion (blocks). */
  turnDeg: number; jumpBlocks: number;
  /** The drawn pitch (degrees; past ±90 inside an animation) and yaw. */
  pitch: number; yaw: number;
}

/** Keeps the per-tick trace of one player's drawn camera. */
export class CameraTrace {
  readonly rows: CameraTraceRow[] = [];
  private prev: { camera: DrawnCamera; seat?: { x: number; y: number; z: number } } | undefined;
  /** The tick an animation last played on, and the tick it last stopped (a hand-back or an end). */
  lastAnimTick = -Infinity; lastHandbackTick = -Infinity;
  animations = 0;

  constructor(readonly client: ClientView, readonly player: SimEntity) {}

  /** Record this tick (call after `ctx.run(1)`). */
  sample(): CameraTraceRow {
    const camera = this.client.drawn(this.player);
    const seat = drawnSeat(this.client, this.player);
    const now = { camera, ...(seat ? { seat: seat.eye } : {}) };
    const delta = this.prev ? cameraFrameDelta(this.prev, now) : { turnDeg: 0, jumpBlocks: 0 };
    const lead = seatLead(this.client, this.player, camera);
    const target = this.client.scriptTarget(this.player);
    const targetLead = target ? seatLead(this.client, this.player, target) : undefined;
    // The script's target against the server's own seat (where the camera would sit with no client lag at all).
    let serverLead: number | undefined, serverSpeed: number | undefined;
    const mount = this.player.ridingOn;
    if (target && mount && mount.valid && seat) {
      const head = this.player.headLocation();
      const last = this.client.poses.of(mount);
      const a = last[last.length - 2], b = last[last.length - 1];
      const v = a && b ? { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z } : { x: 0, y: 0, z: 0 };
      serverSpeed = Math.hypot(v.x, v.y, v.z) * 20;
      serverLead = (target.eye.x - head.x) * seat.forward.x + (target.eye.y - head.y) * seat.forward.y + (target.eye.z - head.z) * seat.forward.z;
    }
    const row: CameraTraceRow = { tick: camera.tick, mode: camera.mode, ...(lead !== undefined ? { lead } : {}), ...(targetLead !== undefined ? { targetLead } : {}), ...(serverLead !== undefined ? { serverLead } : {}), ...(serverSpeed !== undefined ? { serverSpeed } : {}), ...(seat ? { speed: seat.speed } : {}), turnDeg: delta.turnDeg, jumpBlocks: delta.jumpBlocks, pitch: camera.pitch, yaw: camera.yaw };
    if (camera.mode === 'animation') { if (this.lastAnimTick !== camera.tick - 1) this.animations++; this.lastAnimTick = camera.tick; }
    else if (this.lastAnimTick === camera.tick - 1) this.lastHandbackTick = camera.tick;
    this.rows.push(row);
    this.prev = now;
    return row;
  }

  /** Whether this tick is one a frame is worth keeping on: an animation, the ticks after a hand-back, a steep view, or every `every`-th tick. */
  interesting(row: CameraTraceRow, every = 10, afterHandback = 20): boolean {
    return row.mode === 'animation' || row.tick - this.lastHandbackTick <= afterHandback || Math.abs(row.pitch) > 25 || row.tick % every === 0;
  }

  /** The worst of the trace: the largest turn, jump and |lead| (at speed), and how many own-view frames showed while riding. */
  summary(speedFloor = 2): { ticks: number; worstTurnDeg: number; worstJumpBlocks: number; worstLead: number; worstLeadAt: number; ownFrames: number; animations: number } {
    let worstTurnDeg = 0, worstJumpBlocks = 0, worstLead = 0, worstLeadAt = -1, ownFrames = 0;
    for (const r of this.rows) {
      worstTurnDeg = Math.max(worstTurnDeg, r.turnDeg);
      worstJumpBlocks = Math.max(worstJumpBlocks, r.jumpBlocks);
      if (r.lead !== undefined && (r.speed ?? 0) >= speedFloor && Math.abs(r.lead) > Math.abs(worstLead)) { worstLead = r.lead; worstLeadAt = r.tick; }
      if (r.mode === 'own' && r.lead !== undefined) ownFrames++;
    }
    return { ticks: this.rows.length, worstTurnDeg, worstJumpBlocks, worstLead, worstLeadAt, ownFrames, animations: this.animations };
  }
}
