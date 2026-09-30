/**
 * Rays through the world: which block a look selects, and which entity a tap
 * picks.
 *
 * A block is SELECTED by its selection boxes; one with `selection_box: false`
 * (every collider form) is passed (quirk `no-selection-box-passes-taps`), so a
 * tap reaches an entity standing inside a collider. An entity is picked by its
 * `minecraft:custom_hit_test` boxes when it declares them (square footprints
 * centred on a pivot, world axes: Bedrock never turns them), else by its
 * collision box. A block selected nearer than an entity hides the entity.
 */

import { rayBox, type Box, type Vec3 } from '../core/vec.js';
import type { VoxelWorld } from '../world/voxel-world.js';
import type { SimEntity } from '../entity/entity.js';

/** A block hit: the block, the face entered and the point on it. */
export interface BlockHit { x: number; y: number; z: number; face: 'Up' | 'Down' | 'North' | 'South' | 'East' | 'West'; point: Vec3; distance: number }

export interface BlockRayOptions {
  /** Count blocks without collision (flowers, torches) as hits. Default false (the API's default). */
  includePassable?: boolean;
  /** Count liquids. Default false. */
  includeLiquid?: boolean;
  /** Test collision boxes instead of selection boxes (a body's line of sight rather than a pick). */
  useCollision?: boolean;
}

const faceOf = (p: Vec3, b: Box): BlockHit['face'] => {
  const d: Array<[number, BlockHit['face']]> = [[Math.abs(p.y - b.y1), 'Up'], [Math.abs(p.y - b.y0), 'Down'], [Math.abs(p.z - b.z0), 'North'], [Math.abs(p.z - b.z1), 'South'], [Math.abs(p.x - b.x1), 'East'], [Math.abs(p.x - b.x0), 'West']];
  let best = d[0]!;
  for (const c of d) if (c[0] < best[0]) best = c;
  return best[1];
};

/**
 * The first block a ray selects within `maxDistance`, or undefined (nothing,
 * or the ray reached an unloaded column first). Walks the voxels the ray
 * crosses (Amanatides-Woo) and tests each block's boxes.
 */
export function raycastBlocks(world: VoxelWorld, origin: Vec3, dir: Vec3, maxDistance: number, options: BlockRayOptions = {}): BlockHit | undefined {
  const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
  const d = { x: dir.x / len, y: dir.y / len, z: dir.z / len };
  let x = Math.floor(origin.x), y = Math.floor(origin.y), z = Math.floor(origin.z);
  const step = { x: Math.sign(d.x), y: Math.sign(d.y), z: Math.sign(d.z) };
  const next = (o: number, v: number, s: number, c: number): number => (s > 0 ? (c + 1 - o) / v : s < 0 ? (c - o) / v : Infinity);
  let tx = next(origin.x, d.x, step.x, x), ty = next(origin.y, d.y, step.y, y), tz = next(origin.z, d.z, step.z, z);
  const dx = step.x ? Math.abs(1 / d.x) : Infinity, dy = step.y ? Math.abs(1 / d.y) : Infinity, dz = step.z ? Math.abs(1 / d.z) : Infinity;
  for (let guard = 0; guard < 4096; guard++) {
    if (!world.isLoaded(x, z)) return undefined;
    const p = world.permutationAt(x, y, z);
    if (p.id !== 0) {
      const shape = world.types.shape(p.typeId, p.states);
      const skip = (shape.isLiquid && !options.includeLiquid) || (!options.includePassable && !shape.collision.length && !shape.isLiquid);
      if (!skip) {
        const boxes = options.useCollision ? shape.collision : shape.selection;
        let best: { t: number; box: Box } | undefined;
        for (const b of boxes) {
          const wb = { x0: x + b.x0, y0: y + b.y0, z0: z + b.z0, x1: x + b.x1, y1: y + b.y1, z1: z + b.z1 };
          const t = rayBox(origin, d, wb, maxDistance);
          if (t !== undefined && (!best || t < best.t)) best = { t, box: wb };
        }
        if (best) {
          const point = { x: origin.x + d.x * best.t, y: origin.y + d.y * best.t, z: origin.z + d.z * best.t };
          return { x, y, z, face: faceOf(point, best.box), point, distance: best.t };
        }
      }
    }
    const t = Math.min(tx, ty, tz);
    if (t > maxDistance) return undefined;
    if (t === tx) { x += step.x; tx += dx; } else if (t === ty) { y += step.y; ty += dy; } else { z += step.z; tz += dz; }
  }
  return undefined;
}

/** The boxes a ray can pick an entity by: its custom hit test, else its collision box. */
export function pickBoxes(e: SimEntity): Box[] {
  const hit = e.components['minecraft:custom_hit_test'] as { hitboxes?: Array<{ width?: number; height?: number; pivot?: number[] }> } | undefined;
  if (hit?.hitboxes?.length) {
    return hit.hitboxes.map(h => {
      const w = (h.width ?? 1) / 2, hh = (h.height ?? 1) / 2, p = h.pivot ?? [0, 0, 0];
      const c = { x: e.location.x + (p[0] ?? 0), y: e.location.y + (p[1] ?? 0), z: e.location.z + (p[2] ?? 0) };
      return { x0: c.x - w, y0: c.y - hh, z0: c.z - w, x1: c.x + w, y1: c.y + hh, z1: c.z + w };
    });
  }
  return [e.aabb()];
}

/** An entity along a ray. */
export interface EntityHit { entity: SimEntity; distance: number }

/** Every entity a ray crosses within `maxDistance`, nearest first. */
export function raycastEntities(candidates: readonly SimEntity[], origin: Vec3, dir: Vec3, maxDistance: number, exclude?: SimEntity): EntityHit[] {
  const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
  const d = { x: dir.x / len, y: dir.y / len, z: dir.z / len };
  const out: EntityHit[] = [];
  for (const e of candidates) {
    if (e === exclude || !e.valid) continue;
    let best: number | undefined;
    for (const b of pickBoxes(e)) { const t = rayBox(origin, d, b, maxDistance); if (t !== undefined && (best === undefined || t < best)) best = t; }
    if (best !== undefined) out.push({ entity: e, distance: best });
  }
  return out.sort((a, b) => a.distance - b.distance);
}
