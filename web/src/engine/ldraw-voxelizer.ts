/**
 * LDraw brick data → BlockGrid voxelization.
 *
 * Coordinate mapping (LDraw → grid):
 *   Grid X = round(brick.x / LDU_PER_STUD)    (stud pitch = 20 LDU)
 *   Grid Y = round(-brick.y / LDU_PER_PLATE)   (plate height = 8 LDU; LDraw Y is inverted)
 *   Grid Z = round(brick.z / LDU_PER_STUD)
 *
 * Using plate height (8 LDU) as the vertical unit means:
 *   - 1 plate  = 1 block tall
 *   - 1 brick  = 3 blocks tall (24 LDU / 8 = 3)
 * This gives the most faithful resolution for mixed plate/brick builds.
 */

import { BlockGrid } from '@craft/schem/types.js';
import type { ParsedBrick } from './ldraw-parser.js';
import { ldrawColorToBlock } from './ldraw-colors.js';

/** LDraw units per stud pitch (horizontal resolution) */
const LDU_PER_STUD = 20;
/** LDraw units per plate height (vertical resolution) */
const LDU_PER_PLATE = 8;
/** Maximum allowed grid dimension to prevent browser freeze */
const MAX_DIM = 256;

export interface VoxelizeResult {
  grid: BlockGrid;
  brickCount: number;
  uniqueColors: number;
  dimensions: { w: number; h: number; l: number };
  warning?: string;
}

export function voxelizeLDraw(
  bricks: ParsedBrick[],
  colorFn?: (id: number) => string,
): VoxelizeResult {
  if (bricks.length === 0) {
    const grid = new BlockGrid(1, 1, 1);
    return { grid, brickCount: 0, uniqueColors: 0, dimensions: { w: 1, h: 1, l: 1 } };
  }

  const resolveColor = colorFn ?? ldrawColorToBlock;

  // Convert to grid coordinates
  interface Voxel { gx: number; gy: number; gz: number; block: string; color: number }
  const voxels: Voxel[] = bricks.map(b => ({
    gx: Math.round(b.x / LDU_PER_STUD),
    gy: Math.round(-b.y / LDU_PER_PLATE),
    gz: Math.round(b.z / LDU_PER_STUD),
    block: resolveColor(b.color),
    color: b.color,
  }));

  // Compute axis-aligned bounding box
  let minX = voxels[0].gx, maxX = voxels[0].gx;
  let minY = voxels[0].gy, maxY = voxels[0].gy;
  let minZ = voxels[0].gz, maxZ = voxels[0].gz;
  for (const v of voxels) {
    if (v.gx < minX) minX = v.gx; if (v.gx > maxX) maxX = v.gx;
    if (v.gy < minY) minY = v.gy; if (v.gy > maxY) maxY = v.gy;
    if (v.gz < minZ) minZ = v.gz; if (v.gz > maxZ) maxZ = v.gz;
  }

  let w = maxX - minX + 1;
  let h = maxY - minY + 1;
  let l = maxZ - minZ + 1;
  let scale = 1;
  let warning: string | undefined;

  // Clamp to browser-safe dimensions
  const maxDim = Math.max(w, h, l);
  if (maxDim > MAX_DIM) {
    scale = MAX_DIM / maxDim;
    w = Math.max(1, Math.round(w * scale));
    h = Math.max(1, Math.round(h * scale));
    l = Math.max(1, Math.round(l * scale));
    warning = `Model scaled down ${(1 / scale).toFixed(1)}× to fit limits (max dim ${MAX_DIM})`;
  }

  const grid = new BlockGrid(w, h, l);
  const colors = new Set<number>();

  for (const v of voxels) {
    const x = clamp(Math.round((v.gx - minX) * scale), 0, w - 1);
    const y = clamp(Math.round((v.gy - minY) * scale), 0, h - 1);
    const z = clamp(Math.round((v.gz - minZ) * scale), 0, l - 1);
    grid.set(x, y, z, v.block);
    colors.add(v.color);
  }

  return { grid, brickCount: bricks.length, uniqueColors: colors.size, dimensions: { w, h, l }, warning };
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}
