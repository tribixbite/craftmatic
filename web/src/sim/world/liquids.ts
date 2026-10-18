/**
 * Liquids as VOLUMES: a liquid block fills its cell up to a surface height,
 * so a body knows how deep it stands in water (`submersion`) and where the
 * surface is (`liquidSurfaceAbove`).
 *
 * HEIGHT (quirk `liquid-surface-height`, ASSUMED): Java Edition's fluid height
 * - a source fills 8/9 of its cell, a flowing block of level L (Bedrock's
 * `liquid_depth` 1..7) fills (8 - L)/9, a falling block (`liquid_depth` 8 or
 * more) and any liquid block with liquid over it fill the whole cell
 * (`FlowingFluid.getHeight`). The scripted vehicles read a water block's
 * surface as `y + 0.9` (bedrock-vehicle.ts `waterAt`), within a hundredth of
 * the source's 8/9; neither is measured on Bedrock.
 *
 * Pure over a `VoxelWorld`-shaped reader: no engine state.
 */

import type { Box } from '../core/vec.js';
import type { BlockShape, BlockStates } from './block-types.js';

/** What a liquid reader needs from a world: a block's shape and states by position. */
export interface LiquidWorld {
  shapeAt(x: number, y: number, z: number): BlockShape;
  permutationAt(x: number, y: number, z: number): { typeId: string; states: Readonly<BlockStates> };
}

/** The fraction of its cell a source block fills (Java's `8/9`). */
export const LIQUID_SOURCE_HEIGHT = 8 / 9;

/**
 * The liquid surface inside block (x, y, z) as a world height, or undefined when the block holds no liquid.
 * A liquid block with liquid above it is full (its surface is the cell's top).
 */
export function liquidSurface(w: LiquidWorld, x: number, y: number, z: number): number | undefined {
  const bx = Math.floor(x), by = Math.floor(y), bz = Math.floor(z);
  if (!w.shapeAt(bx, by, bz).isLiquid) return undefined;
  if (w.shapeAt(bx, by + 1, bz).isLiquid) return by + 1;
  const raw = w.permutationAt(bx, by, bz).states['liquid_depth'];
  const level = typeof raw === 'number' ? raw : Number(raw ?? 0) || 0;
  if (level >= 8) return by + 1;
  return by + (8 - Math.max(0, level)) / 9;
}

/**
 * How much of a box's HEIGHT is under a liquid surface, as a fraction 0..1: the column under the box's centre,
 * each liquid cell counted up to its surface (`liquidSurface`). Java tests the whole box against fluid shapes; the
 * centre column is a simplification that agrees for a body standing in open water and differs within half a body
 * width of a shore (`TODO(sim-water-edge)`).
 */
export function submersion(w: LiquidWorld, box: Box): number {
  const h = box.y1 - box.y0;
  if (h <= 0) return 0;
  const cx = (box.x0 + box.x1) / 2, cz = (box.z0 + box.z1) / 2;
  let wet = 0;
  for (let y = Math.floor(box.y0); y <= Math.floor(box.y1 - 1e-9); y++) {
    const top = liquidSurface(w, cx, y, cz);
    if (top === undefined) continue;
    wet += Math.max(0, Math.min(box.y1, top) - Math.max(box.y0, y));
  }
  return Math.max(0, Math.min(1, wet / h));
}

/** The highest liquid surface in the column (x, z) between `fromY` and `fromY - depth` (scanning down), or undefined. */
export function liquidSurfaceBelow(w: LiquidWorld, x: number, fromY: number, z: number, depth = 4): number | undefined {
  for (let y = Math.floor(fromY); y >= Math.floor(fromY - depth); y--) {
    const top = liquidSurface(w, x, y, z);
    if (top !== undefined) return top;
  }
  return undefined;
}
