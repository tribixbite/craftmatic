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
import { ldrawColorToBlock, LDRAW_COLOR_TO_BLOCK } from './ldraw-colors.js';
import { getPartDims, getPartShape, getPartFrameThickness, getBracketShelfDir } from './ldraw-part-dims.js';

/** LDraw units per stud pitch (horizontal cell size) */
const LDU_PER_STUD = 20;
/** LDraw units per plate height (vertical cell size) */
const LDU_PER_PLATE = 8;
/** Identity rotation (flat row-major 3×3) */
const IDENTITY = [1, 0, 0,  0, 1, 0,  0, 0, 1];

/**
 * Returns true for LDraw geometry primitives that should not be voxelized.
 *
 * LDraw primitives are sub-file geometry helpers (cylinders, rings, edges,
 * discs, stud-bases) that are used inside part .dat files to describe shape.
 * They are NOT standalone LEGO parts. When an MPD embeds custom parts that
 * themselves reference library primitives, parseLDraw includes those primitive
 * references as "leaf bricks" — but they represent internal geometry, not
 * user-placed pieces.
 *
 * Filtering them removes stray 1×1×1 blocks from models like the
 * UCS Millennium Falcon that include custom flexible-part sub-assemblies.
 *
 * Patterns filtered:
 *   N-Mtype[N]  — standard fraction-denominator primitives:
 *                 4-4cyli, 1-8edge, 4-4ring2, 2-4ndis, 1-12cyli, …
 *   stug-*      — stud geometry (stug-2x2, stug-3, …)
 *   stud[2-9]*  — numbered stud variants (stud2, stud3, stud4a, stud6, …)
 *   axl2hole    — axle hole primitive
 *   axlhol*     — axle hole variants
 *   connect*    — Technic pin connector geometry (connect.dat, connect2.dat, …)
 *   npeghol*    — notched peg hole geometry (npeghol2.dat, …)
 *   npeghole*   — notched peg hole without surface (npeghole.dat, …)
 *   logo*       — LEGO logo for studs (logo.dat, logo2.dat, …)
 *   NNNNNsNN    — LDraw sub-part files (e.g. 47996s01, 6057s04): internal geometry
 *                 sub-files for complex parts (rigging, tubes, etc.) referenced
 *                 within embedded MPD sub-models. Pattern: all-digit prefix + 's' + digits.
 */
function isLDrawPrimitive(part: string): boolean {
  const bare = part.replace(/\.dat$/i, '').toLowerCase();
  // Strip directory prefix (e.g. "48\" in hi-res primitive paths like "48\4-4edge")
  const filename = bare.replace(/^.*[/\\]/, '');
  // Standard fraction primitives: starts with digit-digit (e.g. "4-4", "1-8", "2-4", "3-8")
  // Also catches hi-res variants like "48\4-4edge", "48\4-4cyli" after prefix strip
  if (/^\d+-\d+/.test(filename)) return true;
  // Named geometry primitives (all from LDraw p/ primitives directory)
  if (bare.startsWith('stug-')) return true;
  if (bare === 'axl2hole' || bare.startsWith('axlhol')) return true;
  if (bare.startsWith('connect')) return true;     // Technic connector geometry
  if (bare.startsWith('npeghol')) return true;     // notched peg hole variants
  if (bare.startsWith('npeghole')) return true;    // npeghole.dat (without surface)
  if (bare.startsWith('logo')) return true;        // LEGO logo for studs
  // All stud variants: stud, stud2-stud9, stud10, studa, stude, etc.
  // Previous pattern stud[2-9] missed stud itself, stud10, studa, stude, etc.
  if (bare.startsWith('stud')) return true;
  // Named box/disc/knob geometry primitives — no real LEGO part uses these bare names
  if (bare === 'box' || /^box[\da-z]/.test(bare)) return true;   // box.dat, box5.dat, box2-4a.dat…
  if (bare === 'disc') return true;                               // disc.dat — flat circle
  if (bare === 'knob' || bare === 'tooth') return true;          // stud detail geometry
  // LDraw sub-part files: NNNNsNN (e.g. 47996s01, 6057s04) — internal geometry only
  if (/^\d+s\d+$/.test(bare)) return true;
  return false;
}
/** Maximum grid dimension to prevent browser freeze */
const MAX_DIM = 256;

export interface VoxelizeResult {
  grid: BlockGrid;
  brickCount: number;
  uniqueColors: number;
  dimensions: { w: number; h: number; l: number };
  warning?: string;
  /** Color IDs that had no mapping entry and fell back to gray */
  unmappedColors: number[];
}

export interface VoxelizeOptions {
  /**
   * When true, use 1 stud (20 LDU) for the vertical cell size instead of
   * 1 plate (8 LDU). This makes all three axes equal (cubic voxels) and
   * corrects the 2.5× vertical stretch that makes flat models like the ISD
   * look like towers. Trade-off: loses plate-level vertical detail.
   *
   * Accurate mode (default): 1 plate = 1 cell. ISD → 125×136×79
   * Cubic mode:              1 stud  = 1 cell. ISD → 125×55×79
   */
  cubicScale?: boolean;
}

export function voxelizeLDraw(
  bricks: ParsedBrick[],
  colorFn?: (id: number) => string,
  options?: VoxelizeOptions,
): VoxelizeResult {
  if (bricks.length === 0) {
    const grid = new BlockGrid(1, 1, 1);
    return { grid, brickCount: 0, uniqueColors: 0, dimensions: { w: 1, h: 1, l: 1 }, unmappedColors: [] };
  }

  const resolveColor = colorFn ?? ldrawColorToBlock;
  // Track color IDs not in the default LDraw map (may still resolve via custom colorFn).
  // We flag IDs absent from LDRAW_COLOR_TO_BLOCK when using the default resolver.
  const isDefaultFn = colorFn == null;
  const unmappedColorSet = new Set<number>();
  // In cubic mode Y uses the same pitch as X/Z (20 LDU = 1 stud), eliminating
  // the 2.5× vertical stretch. In accurate mode 1 plate (8 LDU) = 1 cell.
  const LDU_PER_Y = options?.cubicScale ? LDU_PER_STUD : LDU_PER_PLATE;
  // Ratio of horizontal stud pitch to vertical cell pitch.
  // Used to convert stud-radius → plate-radius for arch semicircle formula.
  // Accurate: 20/8 = 2.5.  Cubic: 20/20 = 1.0.
  const studToYCell = LDU_PER_STUD / LDU_PER_Y;

  // ── Expand each brick into grid cells ────────────────────────────────────

  interface Cell { gx: number; gy: number; gz: number; block: string; color: number }
  const cells: Cell[] = [];

  for (const brick of bricks) {
    // Skip LDraw geometry primitives — they describe part shape internally
    // and should not be voxelized as standalone blocks.
    if (isLDrawPrimitive(brick.part)) continue;

    const R = brick.rot ?? IDENTITY;
    const [sW, sH, sL] = getPartDims(brick.part);
    const block = resolveColor(brick.color);
    if (isDefaultFn && !(brick.color in LDRAW_COLOR_TO_BLOCK)) {
      unmappedColorSet.add(brick.color);
    }

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
    // X/Z: stud pitch (20 LDU); Y: LDU_PER_Y (plate=8 or stud=20), flipped
    const gxMin = Math.round(wxMin / LDU_PER_STUD);
    const gxMax = Math.round(wxMax / LDU_PER_STUD);
    const gyMin = Math.round(-wyMax / LDU_PER_Y);
    const gyMax = Math.round(-wyMin / LDU_PER_Y);
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

    // Frame masking: skip cells in the hollow center void of open-center Technic bricks.
    // The void is the inner rectangular region with frameThick cells removed from each
    // AABB edge in both X and Z. Works correctly for all 90° Y-rotations.
    const frameThick = shape === 'frame' ? getPartFrameThickness(brick.part) : 0;

    // Corner masking: L-shaped Technic corner bricks have two perpendicular 1-stud arms
    // meeting at one corner; the 3 remaining quadrants of the AABB are hollow.
    //
    // The inner corner of the L is at local (-lxHalf, _, -lzHalf). Its world position
    // determines which AABB corner is the "pivot". For a square part (lxHalf = lzHalf):
    //   cornerX = (R[0] + R[2]) > 0 ? gxMin : gxMax
    //   cornerZ = (R[6] + R[8]) > 0 ? gzMin : gzMax
    //
    // A cell is kept if it lies on either 1-stud-wide arm from the corner:
    //   x === cornerX  (Z-axis arm)  OR  z === cornerZ  (X-axis arm)
    let cornerX = gxMin, cornerZ = gzMin;
    const isCorner = shape === 'corner';
    if (isCorner) {
      cornerX = (R[0] + R[2]) > 0 ? gxMin : gxMax;
      cornerZ = (R[6] + R[8]) > 0 ? gzMin : gzMax;
    }

    // Bracket masking: L-shaped plate+face in the vertical plane.
    // A bracket = 1-stud-wide plate (horizontal arm, full sL span, at one Y row)
    //           + 1-stud-wide face (vertical arm, full sH span, at one horizontal edge).
    //
    // Face is at local -Z; world face direction = R*[0,0,-1] = [-R[2], _, -R[8]].
    // Plate row: at local -Y (LDraw top). world_Y = -ly/8, so local -lyHalf → world gyMax
    //   when R[4]≥0 (standard upright), gyMin when R[4]<0 (inverted).
    //
    // Keep cell if it lies on the face column OR the plate row:
    //   (bracketFaceAxis==='z' ? z===bracketFacePos : x===bracketFacePos)  OR  y===bracketPlateY
    const isBracket = shape === 'bracket';
    let bracketFaceAxis: 'x' | 'z' = 'z';
    let bracketFacePos = gzMin;
    let bracketPlateY = gyMin;
    if (isBracket && spanY > 0) {
      const faceWorldX = -R[2], faceWorldZ = -R[8];
      if (Math.abs(faceWorldZ) >= Math.abs(faceWorldX) && spanZ > 0) {
        bracketFaceAxis = 'z';
        bracketFacePos = faceWorldZ >= 0 ? gzMax : gzMin;
      } else if (spanX > 0) {
        bracketFaceAxis = 'x';
        bracketFacePos = faceWorldX >= 0 ? gxMax : gxMin;
      }
      const bracketShelfDir = getBracketShelfDir(brick.part);
      bracketPlateY = (bracketShelfDir === 'up') === (R[4] >= 0) ? gyMax : gyMin;
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
        archRPlates = archRStuds * studToYCell; // stud → Y-cell (2.5 accurate, 1.0 cubic)
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

        // Frame masking: skip cells inside the hollow center void.
        if (frameThick > 0) {
          if (x >= gxMin + frameThick && x <= gxMax - frameThick &&
              z >= gzMin + frameThick && z <= gzMax - frameThick) continue;
        }

        // Corner masking: skip cells not on either arm of the L-shape.
        // Keep cell only if it is on the X-arm (z === cornerZ) or Z-arm (x === cornerX).
        if (isCorner && x !== cornerX && z !== cornerZ) continue;

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
        for (let y = yLo; y <= yHi; y++) {
          // Bracket masking: keep only cells on the face column or the plate row.
          if (isBracket) {
            const onFace = bracketFaceAxis === 'z' ? z === bracketFacePos : x === bracketFacePos;
            if (!onFace && y !== bracketPlateY) continue;
          }
          cells.push({ gx: x, gy: y, gz: z, block, color: brick.color });
        }
      }
    }
  }

  if (cells.length === 0) {
    const grid = new BlockGrid(1, 1, 1);
    return { grid, brickCount: bricks.length, uniqueColors: 0, dimensions: { w: 1, h: 1, l: 1 }, unmappedColors: [...unmappedColorSet] };
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

  return { grid, brickCount: bricks.length, uniqueColors: colors.size, dimensions: { w, h, l }, warning, unmappedColors: [...unmappedColorSet] };
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}
