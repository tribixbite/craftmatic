/**
 * Widening a model's grid past its edges, per horizontal side.
 *
 * Two callers widen a grid: the scene pipeline (`schem-pipeline.ts`), for a door's access stair or a border step
 * (`accessMarginFor`, `borderMarginFor`), before anything is placed on it; and the add-on builder
 * (`playable-addon.ts`), for a vehicle-only pack whose display line-up stands beside the vehicle past the grid.
 */
import { BlockGrid } from '@craft/schem/types.js';

/** Whole blocks added to each horizontal side of a grid. */
export interface GridMargin { x0: number; x1: number; z0: number; z1: number }

/** No widening. */
export const NO_GRID_MARGIN: Readonly<GridMargin> = Object.freeze({ x0: 0, x1: 0, z0: 0, z1: 0 });

/** Whether a margin widens any side. */
export function isGridMargin(m: GridMargin): boolean {
  return m.x0 > 0 || m.x1 > 0 || m.z0 > 0 || m.z1 > 0;
}

/**
 * The grid widened by `m` blocks per side, every cell and block entity moved `m.x0` / `m.z0` in. The caller moves
 * whatever is measured on the grid's frame by the same amount (the voxelizer's `gridOrigin`, or the actors), so
 * nothing moves in the world relative to the model.
 */
export function padGridXZ(grid: BlockGrid, m: GridMargin): BlockGrid {
  const out = new BlockGrid(grid.width + m.x0 + m.x1, grid.height, grid.length + m.z0 + m.z1);
  for (let y = 0; y < grid.height; y++) for (let z = 0; z < grid.length; z++) for (let x = 0; x < grid.width; x++) {
    const state = grid.get(x, y, z);
    if (state !== 'minecraft:air') out.set(x + m.x0, y, z + m.z0, state);
  }
  for (const be of grid.blockEntities) out.blockEntities.push({ ...be, pos: [be.pos[0] + m.x0, be.pos[1], be.pos[2] + m.z0] });
  return out;
}

/** A horizontal footprint in grid blocks: its centre and half extents. */
export interface Footprint { x: number; z: number; halfX: number; halfZ: number }

/**
 * The smallest whole-block margin that puts every footprint inside a `width` x `length` grid. A footprint already
 * inside asks for nothing; 1e-6 of slack keeps a footprint flush with an edge from asking for a whole block.
 */
export function marginToHold(footprints: readonly Footprint[], dims: { width: number; length: number }): GridMargin {
  const need = (v: number): number => (v > 1e-6 ? Math.ceil(v - 1e-6) : 0);
  let x0 = 0, x1 = 0, z0 = 0, z1 = 0;
  for (const f of footprints) {
    x0 = Math.max(x0, need(-(f.x - f.halfX)));
    x1 = Math.max(x1, need(f.x + f.halfX - dims.width));
    z0 = Math.max(z0, need(-(f.z - f.halfZ)));
    z1 = Math.max(z1, need(f.z + f.halfZ - dims.length));
  }
  return { x0, x1, z0, z1 };
}
