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

    // Determine wedge taper axis from rotation matrix.
    // Wedge plates have a triangular horizontal footprint: full width at the base
    // (t=0) tapering to 1 stud at the tip (t=1).
    // LDraw wedge plates taper along their LOCAL X axis (length dimension).
    // Taper axis = the longer horizontal world-space span (handles 90° rotations).
    // Narrow-end direction = world projection of local +X = [R[0], _, R[6]].
    let wedgeTaperAxis: 'x' | 'z' | null = null;
    let wedgeTaperDir = 1;
    if (shape === 'wedge') {
      const tipX = R[0];   // world-X component of local +X
      const tipZ = R[6];   // world-Z component of local +X
      if (spanX >= spanZ && spanX > 0) {
        wedgeTaperAxis = 'x';
        wedgeTaperDir = tipX >= 0 ? 1 : -1;
      } else if (spanZ > 0) {
        wedgeTaperAxis = 'z';
        wedgeTaperDir = tipZ >= 0 ? 1 : -1;
      }
    }

    // Round masking: elliptical horizontal footprint for cylindrical/round parts.
    // Include cell (gx, gz) only if inside the inscribed ellipse of the AABB:
    //   ((x - cx)/rx)² + ((z - cz)/rz)² ≤ 1
    // Half-radii: rx = (spanX+1)/2, rz = (spanZ+1)/2.
    // Applied when the footprint is at least 3 cells in either direction (spanX>1
    // or spanZ>1); smaller footprints (1×1, 2×2) fill completely within the ellipse.
    let roundCx = 0, roundCz = 0, roundRx = 1, roundRz = 1;
    const isRound = shape === 'round' && (spanX > 1 || spanZ > 1);
    if (isRound) {
      roundCx = (gxMin + gxMax) / 2;
      roundCz = (gzMin + gzMax) / 2;
      roundRx = (spanX + 1) / 2;
      roundRz = (spanZ + 1) / 2;
    }

    // Arch masking: hollow out the curved underside of arch-shaped parts.
    // An arch has solid pillar columns at both span-ends and a semicircular cavity
    // below the crown spanning the inner portion. The cavity height at each span
    // position follows a semicircle: h(d) = archRPlates * sqrt(1 − (d/archRStuds)²),
    // where d is distance from the span center and archRStuds = inner_span/2 studs.
    // The 2.5:1 stud:plate aspect ratio converts radii between axes.
    // Only activated for arches taller than 2 plates (spanY > 2) with inner span ≥ 2.
    let archSpanAxis: 'x' | 'z' | null = null;
    let archCenter = 0, archRStuds = 0, archRPlates = 0;
    let archInnerStart = 0, archInnerEnd = 0;
    if (shape === 'arch' && spanY > 2) {
      // Pick the longer horizontal span as the arch axis.
      if (spanZ >= spanX && spanZ >= 2) {
        archSpanAxis = 'z';
        archCenter     = (gzMin + gzMax) / 2;
        archInnerStart = gzMin + 1;
        archInnerEnd   = gzMax - 1;
      } else if (spanX >= 2) {
        archSpanAxis = 'x';
        archCenter     = (gxMin + gxMax) / 2;
        archInnerStart = gxMin + 1;
        archInnerEnd   = gxMax - 1;
      }
      if (archSpanAxis !== null && archInnerEnd > archInnerStart) {
        archRStuds  = (archInnerEnd - archInnerStart) / 2;
        archRPlates = archRStuds * 2.5; // stud → plate (20 LDU / 8 LDU = 2.5)
      } else {
        archSpanAxis = null; // inner span too narrow, skip masking
      }
    }

    for (let x = gxMin; x <= gxMax; x++) {
      for (let z = gzMin; z <= gzMax; z++) {
        // Round masking: skip cells outside the inscribed ellipse.
        if (isRound) {
          const dx = (x - roundCx) / roundRx;
          const dz = (z - roundCz) / roundRz;
          if (dx * dx + dz * dz > 1) continue;
        }

        // Wedge masking: skip cells outside triangular horizontal footprint.
        if (wedgeTaperAxis !== null) {
          let t: number;
          let posPerp: number, perpMin: number, perpMax: number;
          if (wedgeTaperAxis === 'x') {
            t = wedgeTaperDir >= 0
              ? (x - gxMin) / Math.max(spanX, 1)
              : (gxMax - x) / Math.max(spanX, 1);
            posPerp = z; perpMin = gzMin; perpMax = gzMax;
          } else {
            t = wedgeTaperDir >= 0
              ? (z - gzMin) / Math.max(spanZ, 1)
              : (gzMax - z) / Math.max(spanZ, 1);
            posPerp = x; perpMin = gxMin; perpMax = gxMax;
          }
          // Number of cells to keep in perpendicular direction at position t:
          //   t=0 → all cells (spanPerp+1), t=1 → 1 cell
          const spanPerp = perpMax - perpMin;
          const totalCells = spanPerp + 1;
          const allowedCells = Math.max(1, Math.round((1 - t) * totalCells));
          const trimTotal = totalCells - allowedCells;
          const trimMin = Math.floor(trimTotal / 2);
          const trimMax = Math.ceil(trimTotal / 2);
          if (posPerp < perpMin + trimMin || posPerp > perpMax - trimMax) continue;
        }

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
        // Arch masking: raise yLo to hollow out the semicircular cavity below the crown.
        // Pillar columns (outside inner span) remain fully solid.
        if (archSpanAxis !== null) {
          const spanPos = archSpanAxis === 'z' ? z : x;
          if (spanPos >= archInnerStart && spanPos <= archInnerEnd) {
            const d = Math.abs(spanPos - archCenter);
            // Normalised distance from center (0 = center, 1 = pillar edge)
            const dNorm = archRStuds > 0 ? d / archRStuds : 1;
            if (dNorm < 1) {
              // Height of the hollow ceiling at this column (semicircle formula)
              const hollowH = Math.round(archRPlates * Math.sqrt(1 - dNorm * dNorm));
              yLo = Math.min(gyMax, gyMin + hollowH);
            }
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
