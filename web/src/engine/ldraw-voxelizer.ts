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
import { getPartDims, getPartShape, getPartFrameThickness, getBracketShelfDir, hasDims } from './ldraw-part-dims.js';

/**
 * Large flat LEGO baseplates that dominate the view and obscure the model.
 * Skipped by default (skipBaseplates option). IDs are the official LDraw part numbers.
 */
const BASEPLATE_PARTS = new Set([
  '3867',  // Baseplate 32×32
  '3811',  // Baseplate 24×32
  '3807',  // Baseplate 16×24
  '3857',  // Baseplate 24×24
  '3626b', // Baseplate 50×50 (unofficial)
  '4186',  // Baseplate 48×48
  '3334',  // Baseplate 8×16
  '3958',  // Baseplate 6×12
  '2419',  // Baseplate 16×16
  '3795',  // Plate 2×6 (sometimes used as mini-base)
]);

/**
 * Technic structural parts that go INSIDE beam/liftarm holes and add noise
 * without contributing to the visual appearance. Skipped during voxelization
 * to produce cleaner output for Technic models.
 */
export const TECHNIC_INTERNAL_PARTS = new Set([
  // Pins (go inside beam holes — not visible from outside)
  '3673',   // Technic Pin
  '4274',   // Technic Pin 1/2
  '6558',   // Technic Pin with Long Friction Ridges
  '4459',   // Technic Pin with Friction Ridges
  '32054',  // Technic Pin Long with Friction Ridges
  '32556',  // Technic Pin Long with Stop Bush
  '65304',  // Technic Pin Long with 2L Friction
  '6562',   // Technic Pin Long with Friction (3L)
  '32002',  // Technic Pin 3/4
  '43093',  // Technic Axle Pin with Friction
  '6628',   // Technic Axle Pin with Friction (variant)
  '11214',  // Technic Axle+Pin 1.5L with Perpendicular Axle Connector
  // Axles (thin rods hidden inside beam holes)
  '32062',  // Technic Axle 2 Notched
  '4519',   // Technic Axle 3
  '3705',   // Technic Axle 4
  '32073',  // Technic Axle 5
  '3706',   // Technic Axle 6
  '3707',   // Technic Axle 8
  '3737',   // Technic Axle 10
  '3708',   // Technic Axle 12
  '50451',  // Technic Axle 16
  // Bushes & spacers (cylindrical — fit around axles)
  '4265c',  // Technic Bush 1/2 Smooth
  '3713b',  // Technic Bush
  '32123',  // Technic Bush 1/2 Smooth Type 2
  // Cross blocks & small connectors
  '6536',   // Technic Axle Joiner Perpendicular
  '6538b',  // Technic Axle Joiner Inline
  '6538',   // Technic Axle Joiner Inline (variant)
  '48989',  // Technic Pin Connector Hub 2 Perpendicular
  '87082',  // Technic Pin Connector Perpendicular Long
  '32034',  // Technic Angle Connector #2 (180°)
  '32192',  // Technic Angle Connector #4 (135°)
  '32014',  // Technic Angle Connector #6 (90°)
  '32184',  // Technic Cross Block 1×3 (Perpendicular Axle Hole)
  '42003',  // Technic Cross Block Double (2-hole perpendicular)
  '32015',  // Technic Angle Connector #1
  '32016',  // Technic Angle Connector #3 (157.5°)
  '32013',  // Technic Angle Connector #5 (112.5°)
  '32039',  // Technic Connector with Axle Hole
  '32449',  // Technic Connector with Pin (locking)
]);

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
  // LSynth virtual parts (hose/cable cross-sections, not real LEGO parts)
  if (/^ls\d+/.test(filename)) return true;
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
const MAX_DIM = 384; // Modern Minecraft supports builds up to 4096; 384 is a practical browser limit

export interface VoxelizeResult {
  grid: BlockGrid;
  brickCount: number;
  uniqueColors: number;
  dimensions: { w: number; h: number; l: number };
  warning?: string;
  /** Color IDs that had no mapping entry and fell back to gray */
  unmappedColors: number[];
  /** True if the model Y axis was auto-flipped to correct an upside-down orientation */
  wasFlipped?: boolean;
  /** Number of parts that had no explicit dims entry and fell back to 1×1×1 */
  fallbackPartCount: number;
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
  /**
   * When true, use plate resolution (8 LDU) for ALL axes, not just Y.
   * Gives 2.5× more horizontal detail — captures thin walls, windows,
   * and architectural features that are lost at stud resolution.
   *
   * Detail mode: 8 LDU = 1 cell in all axes. Castle → 180×102×158
   * Overrides cubicScale when set.
   */
  detailScale?: boolean;
  /**
   * If set, only include bricks with step ≤ maxStep. Used for step-by-step
   * assembly playback. Undefined = include all steps.
   */
  maxStep?: number;
  /**
   * When true, skip large LEGO baseplates (3867, 3811, 3807, 3857, 3626b…).
   * Default: true. These flat plates typically dominate the view and obscure
   * the model. Set to false to include them in the exported schematic.
   */
  skipBaseplates?: boolean;
}

export function voxelizeLDraw(
  bricks: ParsedBrick[],
  colorFn?: (id: number) => string,
  options?: VoxelizeOptions,
): VoxelizeResult {
  if (bricks.length === 0) {
    const grid = new BlockGrid(1, 1, 1);
    return { grid, brickCount: 0, uniqueColors: 0, dimensions: { w: 1, h: 1, l: 1 }, unmappedColors: [], fallbackPartCount: 0 };
  }

  const resolveColor = colorFn ?? ldrawColorToBlock;
  // Track color IDs not in the default LDraw map (may still resolve via custom colorFn).
  // We flag IDs absent from LDRAW_COLOR_TO_BLOCK when using the default resolver.
  const isDefaultFn = colorFn == null;
  const unmappedColorSet = new Set<number>();
  const skipBaseplates = options?.skipBaseplates !== false; // default true
  // In cubic mode Y uses the same pitch as X/Z (20 LDU = 1 stud), eliminating
  // the 2.5× vertical stretch. In accurate mode 1 plate (8 LDU) = 1 cell.
  const detail = options?.detailScale === true;
  const LDU_PER_Y = detail ? LDU_PER_PLATE : (options?.cubicScale ? LDU_PER_STUD : LDU_PER_PLATE);
  const LDU_PER_XZ = detail ? LDU_PER_PLATE : LDU_PER_STUD;
  // Ratio of horizontal stud pitch to vertical cell pitch.
  // Used to convert stud-radius → plate-radius for arch semicircle formula.
  // Accurate: 20/8 = 2.5.  Cubic: 20/20 = 1.0.
  const studToYCell = LDU_PER_STUD / LDU_PER_Y;

  // ── Orientation normalization ─────────────────────────────────────────────
  // LDraw convention: Y increases downward. Properly oriented models have
  // the floor at Y≈0 and extend into positive Y (downward bounding box).
  // Auto-flip disabled: LDraw convention is Y-down, grid conversion handles
  // the inversion (gy = -wy / LDU_PER_Y). Previous heuristic incorrectly
  // flipped models with all-negative Y (standard upward-pointing models).
  const shouldFlip = false;
  const maxStep = options?.maxStep;
  const effectiveBricks: ParsedBrick[] = (shouldFlip || maxStep != null)
    ? bricks
        .filter(b => maxStep == null || (b.step ?? 1) <= maxStep)
        .map(b => shouldFlip ? { ...b, y: -b.y } : b)
    : bricks;

  // ── Expand each brick into grid cells ────────────────────────────────────

  interface Cell { gx: number; gy: number; gz: number; block: string; color: number }
  const cells: Cell[] = [];
  let fallbackPartCount = 0;

  for (const brick of effectiveBricks) {
    // Skip LDraw geometry primitives — they describe part shape internally
    // and should not be voxelized as standalone blocks.
    if (isLDrawPrimitive(brick.part)) continue;
    // Skip large flat baseplates that dominate the 3D view (opt-out via skipBaseplates:false)
    const barePartId = brick.part.replace(/\.dat$/i, '').toLowerCase().replace(/^.*[/\\]/, '');
    if (skipBaseplates && BASEPLATE_PARTS.has(barePartId)) continue;
    // Skip Technic structural parts (pins, axles, bushes) — they go inside beam holes
    // and add noise without contributing to the visual silhouette.
    if (TECHNIC_INTERNAL_PARTS.has(barePartId)) continue;

    const R = brick.rot ?? IDENTITY;
    const [sW, sH, sL] = getPartDims(brick.part);
    if (!hasDims(brick.part) && !isLDrawPrimitive(brick.part)) fallbackPartCount++;
    const block = resolveColor(brick.color);
    if (isDefaultFn && !(brick.color in LDRAW_COLOR_TO_BLOCK)) {
      unmappedColorSet.add(brick.color);
    }

    // Peek at shape early so we know whether to use symmetric Y bounds
    const shapeEarly = getPartShape(brick.part);

    // Local bounding box corners using stud-center positions.
    // X: stud centers at -(sW-1)/2 … +(sW-1)/2 studs
    // Z: stud centers at -(sL-1)/2 … +(sL-1)/2 studs
    // Y: plate centers from 0 (top plate) to (sH-1)*LDU_PER_PLATE (bottom plate)
    // Exception — round parts (wheels, cylinders): left/right placements mirror
    // the rotation matrix sign on the Y axis (R[4]=+1 vs R[4]=-1), which causes
    // one side's bounding box to extend "downward" instead of "upward". Using
    // symmetric Y bounds (−lyHalf … +lyHalf) centres both sides identically on
    // their mounting-point Y, producing matched wheel heights on both sides.
    const lxHalf = (sW - 1) / 2 * LDU_PER_STUD;   // e.g. sW=2 → 10 LDU
    const lzHalf = (sL - 1) / 2 * LDU_PER_STUD;
    const lyBot  = (sH - 1) * LDU_PER_PLATE;       // e.g. sH=3 → 16 LDU
    const lyHalf = lyBot / 2;
    const lyStart = shapeEarly === 'round' ? -lyHalf : 0;
    const lyEnd   = shapeEarly === 'round' ?  lyHalf : lyBot;

    // 8 corners of the local bounding box
    let wxMin = Infinity, wxMax = -Infinity;
    let wyMin = Infinity, wyMax = -Infinity;
    let wzMin = Infinity, wzMax = -Infinity;

    for (let lx = -lxHalf; lx <= lxHalf; lx += Math.max(lxHalf * 2, LDU_PER_STUD)) {
      for (let ly = lyStart; ly <= lyEnd; ly += Math.max(lyBot, LDU_PER_PLATE)) {
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
    const gxMin = Math.round(wxMin / LDU_PER_XZ);
    const gxMax = Math.round(wxMax / LDU_PER_XZ);
    const gyMin = Math.round(-wyMax / LDU_PER_Y);
    const gyMax = Math.round(-wyMin / LDU_PER_Y);
    const gzMin = Math.round(wzMin / LDU_PER_XZ);
    const gzMax = Math.round(wzMax / LDU_PER_XZ);

    // ── Thin-beam line rasterization ──────────────────────────────────────────
    // For elongated thin parts (sH=1, one horizontal dim=1, other ≥4), the AABB
    // fill creates huge solid rectangles when rotated at non-axis-aligned angles.
    // Instead, trace the beam's center axis as a line through grid space and fill
    // only cells along the line. This produces a thin diagonal strip rather than
    // a solid rectangle.
    const maxHoriz = Math.max(sW, sL);
    const minHoriz = Math.min(sW, sL);
    const isElongatedThin = sH <= 1 && minHoriz <= 1 && maxHoriz >= 3;
    if (isElongatedThin && shapeEarly !== 'round') {
      // The beam's long axis is local Z if sL>sW, else local X.
      const halfLen = (maxHoriz - 1) / 2 * LDU_PER_STUD;
      const useZ = sL >= sW;
      // Endpoints of the beam in local space
      const e0x = useZ ? 0 : -halfLen, e0y = 0, e0z = useZ ? -halfLen : 0;
      const e1x = useZ ? 0 :  halfLen, e1y = 0, e1z = useZ ?  halfLen : 0;
      // Transform to world space
      const w0x = R[0]*e0x + R[1]*e0y + R[2]*e0z + brick.x;
      const w0y = R[3]*e0x + R[4]*e0y + R[5]*e0z + brick.y;
      const w0z = R[6]*e0x + R[7]*e0y + R[8]*e0z + brick.z;
      const w1x = R[0]*e1x + R[1]*e1y + R[2]*e1z + brick.x;
      const w1y = R[3]*e1x + R[4]*e1y + R[5]*e1z + brick.y;
      const w1z = R[6]*e1x + R[7]*e1y + R[8]*e1z + brick.z;
      // Convert to grid coordinates
      const g0x = w0x / LDU_PER_XZ, g0y = -w0y / LDU_PER_Y, g0z = w0z / LDU_PER_XZ;
      const g1x = w1x / LDU_PER_XZ, g1y = -w1y / LDU_PER_Y, g1z = w1z / LDU_PER_XZ;
      // Rasterize line: step along the longest axis, compute the other two
      const steps = Math.max(1, Math.round(Math.max(
        Math.abs(g1x - g0x), Math.abs(g1y - g0y), Math.abs(g1z - g0z)
      )));
      for (let i = 0; i <= steps; i++) {
        const t = steps > 0 ? i / steps : 0;
        const gx = Math.round(g0x + t * (g1x - g0x));
        const gy = Math.round(g0y + t * (g1y - g0y));
        const gz = Math.round(g0z + t * (g1z - g0z));
        cells.push({ gx, gy, gz, block, color: brick.color });
      }
      continue; // skip normal AABB fill
    }

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

    // Round masking: elliptical footprint for cylindrical/round parts.
    // Detects the hub axis (shortest world span) and masks the perpendicular plane:
    //   spanY shortest → hub along Y → mask in XZ (horizontal disc, vertical cylinder)
    //   spanX shortest → hub along X → mask in YZ (vehicle tire / end-on wheel)
    //   spanZ shortest → hub along Z → mask in XY (cylinder facing front/back)
    // Tie-breaker: prefer XZ (default for most horizontal studs/round plates).
    let roundCx = 0, roundCy = 0, roundCz = 0;
    let roundRx = 1, roundRy = 1, roundRz = 1;
    let roundMaskPlane: 'xz' | 'yz' | 'xy' | null = null;
    if (shape === 'round') {
      if (spanX < spanY && spanX < spanZ && (spanY > 1 || spanZ > 1)) {
        // Hub along X → circular in YZ (e.g., vehicle tires, axle-mounted wheels)
        roundMaskPlane = 'yz';
        roundCy = (gyMin + gyMax) / 2;
        roundCz = (gzMin + gzMax) / 2;
        roundRy = (spanY + 1) / 2;
        roundRz = (spanZ + 1) / 2;
      } else if (spanZ < spanX && spanZ < spanY && (spanX > 1 || spanY > 1)) {
        // Hub along Z → circular in XY (e.g., end-on engine cylinders)
        roundMaskPlane = 'xy';
        roundCx = (gxMin + gxMax) / 2;
        roundCy = (gyMin + gyMax) / 2;
        roundRx = (spanX + 1) / 2;
        roundRy = (spanY + 1) / 2;
      } else if (spanX > 1 || spanZ > 1) {
        // Hub along Y (default) → circular in XZ
        roundMaskPlane = 'xz';
        roundCx = (gxMin + gxMax) / 2;
        roundCz = (gzMin + gzMax) / 2;
        roundRx = (spanX + 1) / 2;
        roundRz = (spanZ + 1) / 2;
      }
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
        // Round masking XZ: skip cells outside inscribed ellipse in horizontal plane.
        if (roundMaskPlane === 'xz') {
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
          // Round masking YZ: skip cells outside inscribed ellipse in YZ plane (hub along X).
          if (roundMaskPlane === 'yz') {
            const dy = (y - roundCy) / roundRy;
            const dz = (z - roundCz) / roundRz;
            if (dy * dy + dz * dz > 1) continue;
          }
          // Round masking XY: skip cells outside inscribed ellipse in XY plane (hub along Z).
          if (roundMaskPlane === 'xy') {
            const dx = (x - roundCx) / roundRx;
            const dy = (y - roundCy) / roundRy;
            if (dx * dx + dy * dy > 1) continue;
          }
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
    return { grid, brickCount: bricks.length, uniqueColors: 0, dimensions: { w: 1, h: 1, l: 1 }, unmappedColors: [...unmappedColorSet], wasFlipped: shouldFlip, fallbackPartCount };
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

  if (fallbackPartCount > 0) {
    console.warn(`[voxelizer] ${fallbackPartCount} parts fell back to 1×1×1 (unknown dims)`);
  }
  return { grid, brickCount: bricks.length, uniqueColors: colors.size, dimensions: { w, h, l }, warning, unmappedColors: [...unmappedColorSet], wasFlipped: shouldFlip, fallbackPartCount };
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

// ─── Post-processing helpers ──────────────────────────────────────────────────

/**
 * Fill vertical air gaps that are completely bounded (solid below AND above).
 * Uses majority colour from the column as fill. maxGap=Infinity fills all
 * bounded voids regardless of size, making hollow-shell LEGO models look solid.
 */
export function solidifyColumns(grid: BlockGrid, maxGap = 1000): number {
  const { width: GW, height: GH, length: GL } = grid;
  let filled = 0;
  for (let x = 0; x < GW; x++) {
    for (let z = 0; z < GL; z++) {
      const colorCount = new Map<string, number>();
      for (let y = 0; y < GH; y++) {
        const b = grid.get(x, y, z);
        if (b !== 'minecraft:air') colorCount.set(b, (colorCount.get(b) ?? 0) + 1);
      }
      if (colorCount.size === 0) continue;
      let fillColor = 'minecraft:gray_concrete';
      let best = 0;
      for (const [col, cnt] of colorCount) { if (cnt > best) { best = cnt; fillColor = col; } }

      let hadSolid = false;
      let runStart = -1;
      for (let y = 0; y < GH; y++) {
        const isSolid = grid.get(x, y, z) !== 'minecraft:air';
        if (isSolid) {
          if (runStart >= 0 && hadSolid) {
            const runLen = y - runStart;
            if (runLen <= maxGap) {
              for (let fy = runStart; fy < y; fy++) { grid.set(x, fy, z, fillColor); filled++; }
            }
          }
          hadSolid = true;
          runStart = -1;
        } else if (hadSolid && runStart < 0) {
          runStart = y;
        }
      }
    }
  }
  return filled;
}

/**
 * Fill horizontal air gaps up to 2 cells wide (X and Z) that are flanked on
 * both sides by non-air. Fixes lattice/rounding artefacts on flat surfaces.
 */
export function fillSingleVoxelGaps(grid: BlockGrid): number {
  const { width: GW, height: GH, length: GL } = grid;
  let filled = 0;
  for (let y = 0; y < GH; y++) {
    for (let z = 0; z < GL; z++) {
      for (let x = 1; x < GW - 1; x++) {
        if (grid.get(x, y, z) === 'minecraft:air') {
          const l = grid.get(x - 1, y, z);
          const r = grid.get(x + 1, y, z);
          if (l !== 'minecraft:air' && r !== 'minecraft:air') {
            grid.set(x, y, z, l); filled++;
          } else if (x + 2 < GW && l !== 'minecraft:air' && r === 'minecraft:air') {
            const r2 = grid.get(x + 2, y, z);
            if (r2 !== 'minecraft:air') {
              grid.set(x, y, z, l); filled++;
              if (grid.get(x + 1, y, z) === 'minecraft:air') { grid.set(x + 1, y, z, l); filled++; }
            }
          }
        }
      }
    }
    for (let x = 0; x < GW; x++) {
      for (let z = 1; z < GL - 1; z++) {
        if (grid.get(x, y, z) === 'minecraft:air') {
          const f = grid.get(x, y, z - 1);
          const b = grid.get(x, y, z + 1);
          if (f !== 'minecraft:air' && b !== 'minecraft:air') {
            grid.set(x, y, z, f); filled++;
          } else if (z + 2 < GL && f !== 'minecraft:air' && b === 'minecraft:air') {
            const b2 = grid.get(x, y, z + 2);
            if (b2 !== 'minecraft:air') {
              grid.set(x, y, z, f); filled++;
              if (grid.get(x, y, z + 1) === 'minecraft:air') { grid.set(x, y, z + 1, f); filled++; }
            }
          }
        }
      }
    }
  }
  return filled;
}

/**
 * Remove small disconnected clusters, keeping only the largest connected component.
 * Uses flood-fill to label connected regions; removes clusters smaller than 10%
 * of the largest component. Returns the number of cells cleared.
 */
export function keepLargestComponent(grid: BlockGrid): number {
  const { width: W, height: H, length: L } = grid;
  const HL = H * L;
  const label = new Int32Array(W * HL).fill(-1);
  let numComp = 0;
  const sizes: number[] = [];

  for (let x0 = 0; x0 < W; x0++) {
    for (let y0 = 0; y0 < H; y0++) {
      for (let z0 = 0; z0 < L; z0++) {
        const i0 = x0 * HL + y0 * L + z0;
        if (label[i0] >= 0 || grid.get(x0, y0, z0) === 'minecraft:air') continue;
        const id = numComp++;
        let size = 0;
        const stack = [x0, y0, z0];
        label[i0] = id;
        while (stack.length > 0) {
          const z = stack.pop()!, y = stack.pop()!, x = stack.pop()!;
          size++;
          for (const [nx, ny, nz] of [[x+1,y,z],[x-1,y,z],[x,y+1,z],[x,y-1,z],[x,y,z+1],[x,y,z-1]] as [number,number,number][]) {
            if (nx < 0 || nx >= W || ny < 0 || ny >= H || nz < 0 || nz >= L) continue;
            const ni = nx * HL + ny * L + nz;
            if (label[ni] >= 0 || grid.get(nx, ny, nz) === 'minecraft:air') continue;
            label[ni] = id;
            stack.push(nx, ny, nz);
          }
        }
        sizes.push(size);
      }
    }
  }
  if (numComp <= 1) return 0;

  const maxSize = Math.max(...sizes);
  const threshold = Math.max(10, Math.round(maxSize * 0.10));

  let cleared = 0;
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
      for (let z = 0; z < L; z++) {
        const li = label[x * HL + y * L + z];
        if (li >= 0 && sizes[li]! < threshold) {
          grid.set(x, y, z, 'minecraft:air');
          cleared++;
        }
      }
    }
  }
  return cleared;
}
