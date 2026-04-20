/**
 * Default 4-view render round — produces iso, front elevation, top-down, and
 * cutaway PNGs from a voxel `BlockGrid`. Used as the pipeline's built-in
 * `RenderRoundFn` when the caller enables consensus but doesn't supply its
 * own renderer.
 *
 * Rounds 2 and 3 return the same 4 views — re-scoring after a deterministic
 * re-render is a no-op in the current pipeline (synthesis is idempotent
 * given fixed evidence). The gate will converge or hit `needs-human-review`
 * regardless.
 */
import type { RenderRoundFn } from './consensus.js';
import { BlockGrid } from '../../schem/types.js';

import {
  renderExterior,
  renderFrontElevation,
  renderTopDown,
  renderCutawayIso,
} from '../../render/png-renderer.js';

/**
 * Shrink the grid to its non-air bounding box. The voxel export pins grid
 * height to the `maxDimension` cap (256) regardless of actual building
 * height, which makes vertical renders mostly black with the building as a
 * thin strip at the bottom — VLM scoring collapses to zeros on that input.
 */
function trimToContent(src: BlockGrid): BlockGrid {
  const W = src.width, H = src.height, L = src.length;
  let minX = W, maxX = -1, minY = H, maxY = -1, minZ = L, maxZ = -1;
  for (let y = 0; y < H; y++) {
    for (let z = 0; z < L; z++) {
      for (let x = 0; x < W; x++) {
        if (src.get(x, y, z) !== 'minecraft:air') {
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
          if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
        }
      }
    }
  }
  if (maxX < 0) return src; // empty grid — hand back untouched
  const nw = maxX - minX + 1;
  const nh = maxY - minY + 1;
  const nl = maxZ - minZ + 1;
  const dst = new BlockGrid(nw, nh, nl);
  for (let y = 0; y < nh; y++) {
    for (let z = 0; z < nl; z++) {
      for (let x = 0; x < nw; x++) {
        const b = src.get(x + minX, y + minY, z + minZ);
        if (b !== 'minecraft:air') dst.set(x, y, z, b);
      }
    }
  }
  return dst;
}

export function createGridRenderRound(grid: BlockGrid): RenderRoundFn {
  let cached: Uint8Array[] | null = null;
  return async (_round: number): Promise<Uint8Array[]> => {
    if (cached) return cached;
    const trimmed = trimToContent(grid);
    // Target ~1000px on the largest face so the VLM actually sees detail.
    // tile scales so that max(width, height, length) * tile ≈ 900.
    const maxDim = Math.max(trimmed.width, trimmed.height, trimmed.length);
    const tile = Math.max(4, Math.min(16, Math.round(900 / maxDim)));
    const storyCount = Math.max(1, Math.floor(trimmed.height / 5));
    const [iso, front, td, cut] = await Promise.all([
      renderExterior(trimmed, { tile }),
      renderFrontElevation(trimmed, { scale: tile }),
      renderTopDown(trimmed, { scale: tile }),
      renderCutawayIso(trimmed, Math.floor(storyCount / 2), { tile }),
    ]);
    cached = [
      new Uint8Array(iso),
      new Uint8Array(front),
      new Uint8Array(td),
      new Uint8Array(cut),
    ];
    return cached;
  };
}
