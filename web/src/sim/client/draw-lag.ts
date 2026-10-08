/**
 * What the client DRAWS of the server's entities: every entity's pose a few
 * ticks back. The Bedrock client interpolates entity movement behind the
 * server (quirk `client-entity-lag`: marker-measured ~3.5 ticks on the Pixel,
 * `camprobe`, 2026-09-29), so a camera placed by a script at the server's
 * pose of THIS tick sits ahead of the seat the player sees. The engine keeps
 * a short history of every entity's pose and reads a drawn pose at a
 * fractional tick, interpolated between the two server ticks around it (yaw
 * the short way round), as the client does.
 *
 * Pure bookkeeping: the lag itself is a client profile's number
 * (`client/camera.ts`), applied by whoever reads the history.
 */

import type { SimEngine } from '../core/engine.js';
import type { SimEntity } from '../entity/entity.js';

/** One entity's pose as the server had it at a tick (world blocks, Bedrock yaw/pitch, `minecraft:scale`). */
export interface DrawnEntityPose { tick: number; x: number; y: number; z: number; yaw: number; pitch: number; scale: number }

const wrap = (a: number): number => ((a + 180) % 360 + 360) % 360 - 180;

/** Ticks of history kept per entity: more than any lag a profile reads back (the Saga's derived 6 plus a blend). */
export const POSE_HISTORY_TICKS = 16;

/**
 * A ring buffer of every entity's recent poses, filled once a tick AFTER the
 * scripts have moved everything (the client observes the server's tick end).
 */
export class PoseHistory {
  private readonly by = new Map<string, DrawnEntityPose[]>();

  constructor(readonly keep = POSE_HISTORY_TICKS) {}

  /** Record every valid entity's pose at the engine's current tick; forget entities that are gone. */
  record(engine: SimEngine): void {
    const tick = engine.tick;
    for (const id of this.by.keys()) if (!engine.entities.has(id)) this.by.delete(id);
    for (const e of engine.entities.values()) {
      if (!e.valid) { this.by.delete(e.id); continue; }
      let list = this.by.get(e.id);
      if (!list) this.by.set(e.id, list = []);
      list.push({ tick, x: e.location.x, y: e.location.y, z: e.location.z, yaw: e.rotation.y, pitch: e.rotation.x, scale: e.scale() });
      if (list.length > this.keep) list.shift();
    }
  }

  /** The poses kept for an entity, oldest first (empty when it was never recorded). */
  of(e: SimEntity): readonly DrawnEntityPose[] { return this.by.get(e.id) ?? []; }

  /**
   * The pose at a fractional tick: interpolated between the recorded ticks either side of it, the oldest
   * kept when `tick` is before the history, the newest when after. Undefined for an entity never recorded.
   */
  at(e: SimEntity, tick: number): DrawnEntityPose | undefined {
    const list = this.by.get(e.id);
    if (!list || !list.length) return undefined;
    const first = list[0]!, last = list[list.length - 1]!;
    if (tick <= first.tick) return { ...first, tick };
    if (tick >= last.tick) return { ...last, tick };
    // Poses are one tick apart, so the index pair is arithmetic; a gap (an entity unloaded for a while) is bridged linearly.
    let i = 0;
    while (i < list.length - 2 && list[i + 1]!.tick <= tick) i++;
    const a = list[i]!, b = list[i + 1]!;
    const f = b.tick === a.tick ? 0 : (tick - a.tick) / (b.tick - a.tick);
    return {
      tick, x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f,
      yaw: a.yaw + wrap(b.yaw - a.yaw) * f, pitch: a.pitch + (b.pitch - a.pitch) * f, scale: a.scale + (b.scale - a.scale) * f,
    };
  }

  /** The pose `lag` ticks before `now` (a fractional lag reads between two ticks). */
  lagged(e: SimEntity, now: number, lag: number): DrawnEntityPose | undefined { return this.at(e, now - lag); }

  /** The entity's drawn velocity (blocks per tick) at a fractional tick: the pose a tick later less the pose there. */
  velocityAt(e: SimEntity, tick: number): { x: number; y: number; z: number } | undefined {
    const a = this.at(e, tick - 0.5), b = this.at(e, tick + 0.5);
    if (!a || !b || b.tick === a.tick) return undefined;
    return { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
  }
}
