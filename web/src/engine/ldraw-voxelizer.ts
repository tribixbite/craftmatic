/**
 * LDraw brick data → BlockGrid voxelization.
 *
 * Each part is filled as a rotated bounding box rather than a single voxel,
 * using the part's known stud footprint and height from ldraw-part-dims.ts.
 *
 * Coordinate resolution:
 *   Horizontal (X/Z): 1 cell = 1 stud pitch = 20 LDU
 *   Vertical (Y):     1 cell = 1 plate      =  8 LDU  (3 cells = 1 brick)
 *
 * Rotation is applied via the 3×3 world-space matrix stored in ParsedBrick.rot.
 * The bounding box corners (in local space) are transformed to world space,
 * the axis-aligned world bounding box is computed, and all enclosed cells filled.
 *
 * LDraw Y convention: larger Y = lower in the real world ("Y is down").
 * Grid Y increases upward: grid_y = round(-world_y / LDU_PER_PLATE).
 */

import { BlockGrid } from '@craft/schem/types.js';
import type { ParsedBrick } from './ldraw-parser.js';
import { ldrawColorToBlock } from './ldraw-colors.js';
import { getPartDims, getPartShape } from './ldraw-part-dims.js';

/** LDraw units per stud pitch (horizontal cell size) */
const LDU_PER_STUD = 20;
/** LDraw units per plate height (vertical cell size) */
const LDU_PER_PLATE = 8;
/** Identity rotation (flat row-major 3×3) */
const IDENTITY = [1, 0, 0,  0, 1, 0,  0, 0, 1];
/** Maximum grid dimension to prevent browser freeze */
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

  // ── Expand each brick into grid cells ────────────────────────────────────

  interface Cell { gx: number; gy: number; gz: number; block: string; color: number }
  const cells: Cell[] = [];

  for (const brick of bricks) {
    const R = brick.rot ?? IDENTITY;
    const [sW, sH, sL] = getPartDims(brick.part);
    const block = resolveColor(brick.color);

    // Local bounding box corners using stud-center positions.
    // X: stud centers at -(sW-1)/2 … +(sW-1)/2 studs
    // Z: stud centers at -(sL-1)/2 … +(sL-1)/2 studs
    // Y: plate centers from 0 (top plate) to (sH-1)*LDU_PER_PLATE (bottom plate)
    const lxHalf = (sW - 1) / 2 * LDU_PER_STUD;   // e.g. sW=2 → 10 LDU
    const lzHalf = (sL - 1) / 2 * LDU_PER_STUD;
    const lyBot  = (sH - 1) * LDU_PER_PLATE;       // e.g. sH=3 → 16 LDU

    // 8 corners of the local bounding box
    let wxMin = Infinity, wxMax = -Infinity;
    let wyMin = Infinity, wyMax = -Infinity;
    let wzMin = Infinity, wzMax = -Infinity;

    for (let lx = -lxHalf; lx <= lxHalf; lx += Math.max(lxHalf * 2, LDU_PER_STUD)) {
      for (let ly = 0; ly <= lyBot; ly += Math.max(lyBot, LDU_PER_PLATE)) {
        for (let lz = -lzHalf; lz <= lzHalf; lz += Math.max(lzHalf * 2, LDU_PER_STUD)) {
          const wx = R[0]*lx + R[1]*ly + R[2]*lz + brick.x;
          const wy = R[3]*lx + R[4]*ly + R[5]*lz + brick.y;
          const wz = R[6]*lx + R[7]*ly + R[8]*lz + brick.z;
          if (wx < wxMin) wxMin = wx; if (wx > wxMax) wxMax = wx;
          if (wy < wyMin) wyMin = wy; if (wy > wyMax) wyMax = wy;
          if (wz < wzMin) wzMin = wz; if (wz > wzMax) wzMax = wz;
        }
      }
    }

    // Convert world AABB to grid cells.
    // X/Z: stud pitch (20 LDU); Y: plate height (8 LDU), flipped
    const gxMin = Math.round(wxMin / LDU_PER_STUD);
    const gxMax = Math.round(wxMax / LDU_PER_STUD);
    const gyMin = Math.round(-wyMax / LDU_PER_PLATE);
    const gyMax = Math.round(-wyMin / LDU_PER_PLATE);
    const gzMin = Math.round(wzMin / LDU_PER_STUD);
    const gzMax = Math.round(wzMax / LDU_PER_STUD);

    const shape = getPartShape(brick.part);
    const spanX = gxMax - gxMin;
    const spanZ = gzMax - gzMin;
    const spanY = gyMax - gyMin;

    // Determine slope ascending axis from rotation matrix.
    // In local space, a slope ascends along -Z; world-space ascending = R*[0,0,-1].
    let slopeAxis: 'x' | 'z' | null = null;
    let slopeAscDir = 1;
    if ((shape === 'slope' || shape === 'slope_inv' || shape === 'slope_double') && spanY > 0) {
      const ascX = -R[2];  // world-X component of local -Z
      const ascZ = -R[8];  // world-Z component of local -Z
      if (Math.abs(ascX) >= Math.abs(ascZ) && spanX > 0) {
        slopeAxis = 'x';
        slopeAscDir = ascX >= 0 ? 1 : -1;
      } else if (spanZ > 0) {
        slopeAxis = 'z';
        slopeAscDir = ascZ >= 0 ? 1 : -1;
      }
    }

    for (let x = gxMin; x <= gxMax; x++) {
      for (let z = gzMin; z <= gzMax; z++) {
        let yLo = gyMin;
        let yHi = gyMax;
        if (slopeAxis !== null) {
          const t = slopeAxis === 'x'
            ? (slopeAscDir === 1 ? (x - gxMin) / spanX : (gxMax - x) / spanX)
            : (slopeAscDir === 1 ? (z - gzMin) / spanZ : (gzMax - z) / spanZ);
          if (shape === 'slope') {
            yHi = gyMin + Math.round(t * spanY);
          } else if (shape === 'slope_inv') {
            yLo = gyMax - Math.round(t * spanY);
          } else if (shape === 'slope_double') {
            yHi = gyMin + Math.round((1 - 2 * Math.abs(t - 0.5)) * spanY);
          }
        }
        for (let y = yLo; y <= yHi; y++)
          cells.push({ gx: x, gy: y, gz: z, block, color: brick.color });
      }
    }
  }

  if (cells.length === 0) {
    const grid = new BlockGrid(1, 1, 1);
    return { grid, brickCount: bricks.length, uniqueColors: 0, dimensions: { w: 1, h: 1, l: 1 } };
  }

  // ── Compute axis-aligned bounding box ─────────────────────────────────────

  let minX = cells[0].gx, maxX = cells[0].gx;
  let minY = cells[0].gy, maxY = cells[0].gy;
  let minZ = cells[0].gz, maxZ = cells[0].gz;
  for (const c of cells) {
    if (c.gx < minX) minX = c.gx; if (c.gx > maxX) maxX = c.gx;
    if (c.gy < minY) minY = c.gy; if (c.gy > maxY) maxY = c.gy;
    if (c.gz < minZ) minZ = c.gz; if (c.gz > maxZ) maxZ = c.gz;
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

  // ── Write to BlockGrid ────────────────────────────────────────────────────

  const grid = new BlockGrid(w, h, l);
  const colors = new Set<number>();

  for (const c of cells) {
    const x = clamp(Math.round((c.gx - minX) * scale), 0, w - 1);
    const y = clamp(Math.round((c.gy - minY) * scale), 0, h - 1);
    const z = clamp(Math.round((c.gz - minZ) * scale), 0, l - 1);
    grid.set(x, y, z, c.block);
    colors.add(c.color);
  }

  return { grid, brickCount: bricks.length, uniqueColors: colors.size, dimensions: { w, h, l }, warning };
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}
