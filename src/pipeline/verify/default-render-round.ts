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
import type { BlockGrid } from '../../schem/types.js';

import {
  renderExterior,
  renderFrontElevation,
  renderTopDown,
  renderCutawayIso,
} from '../../render/png-renderer.js';

export function createGridRenderRound(grid: BlockGrid): RenderRoundFn {
  let cached: Uint8Array[] | null = null;
  return async (_round: number): Promise<Uint8Array[]> => {
    if (cached) return cached;
    const storyCount = Math.max(1, Math.floor(grid.height / 5));
    const [iso, front, td, cut] = await Promise.all([
      renderExterior(grid, { tile: 6 }),
      renderFrontElevation(grid, { scale: 6 }),
      renderTopDown(grid, { scale: 6 }),
      renderCutawayIso(grid, Math.floor(storyCount / 2), { tile: 6 }),
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
