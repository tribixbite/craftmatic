/**
 * Safe mask application with automatic revert on over-removal.
 *
 * Snapshots all non-air blocks before running the mask operation,
 * then reverts if the result drops below a threshold fraction of
 * the original block count.
 */

import { BlockGrid } from '../schem/types.js';

/**
 * Apply a mask operation to a BlockGrid with safety rollback.
 * If the mask removes more than (1 - revertThreshold) of original blocks,
 * the grid is reverted to its pre-mask state.
 */
export function trySafeMask(
  grid: BlockGrid,
  maskFn: () => void,
  label: string,
  revertThreshold = 0.10,
): { reverted: boolean; remaining: number } {
  // Snapshot all non-air blocks
  const snapshot = new Map<string, string>();
  const { width, height, length } = grid;
  for (let y = 0; y < height; y++)
    for (let z = 0; z < length; z++)
      for (let x = 0; x < width; x++) {
        const b = grid.get(x, y, z);
        if (b !== 'minecraft:air') snapshot.set(`${x},${y},${z}`, b);
      }

  maskFn();

  const remaining = grid.countNonAir();
  if (remaining < snapshot.size * revertThreshold && snapshot.size > 0) {
    // Revert — operation was too aggressive
    for (const [key, val] of snapshot) {
      const [sx, sy, sz] = key.split(',').map(Number);
      grid.set(sx, sy, sz, val);
    }
    console.log(`${label}: reverted (${remaining} would remove ${((1 - remaining / snapshot.size) * 100).toFixed(0)}% of blocks)`);
    return { reverted: true, remaining: snapshot.size };
  }

  console.log(`${label}: ${snapshot.size - remaining} blocks removed, ${remaining} remaining`);
  return { reverted: false, remaining };
}
