/**
 * LDraw part bounding box dimensions for voxelization.
 *
 * Format: [studW, heightPlates, studL]
 *   studW        — footprint studs in local X (1 stud = 20 LDU)
 *   heightPlates — height in plate units (1 plate = 8 LDU, 1 brick = 3 plates)
 *   studL        — footprint studs in local Z
 *
 * The voxelizer uses these to fill the rotated bounding box of each part
 * rather than placing a single voxel at the part's center point.
 *
 * Coverage: ~300 most common parts.  Unknown parts fall back to 1×1×1 plate.
 */

type Dims = [studW: number, hPlates: number, studL: number];

/** N×M standard brick (3-plate height = 1 brick) */
const B = (n: number, m: number): Dims => [n, 3, m];
/** N×M plate or tile (1-plate height) */
const P = (n: number, m: number): Dims => [n, 1, m];
/** N×M part with explicit plate height */
const T = (h: number, n: number, m: number): Dims => [n, h, m];

const DIMS: Record<string, Dims> = {
  // ── Standard Bricks (3 plates = 1 brick) ──────────────────────────────────
  '3001': B(2, 4),   // 2×4 Brick
  '3002': B(2, 3),   // 2×3 Brick
  '3003': B(2, 2),   // 2×2 Brick
  '3004': B(1, 2),   // 1×2 Brick
  '3005': B(1, 1),   // 1×1 Brick
  '3006': B(2, 10),  // 2×10 Brick
  '3007': B(2, 8),   // 2×8 Brick
  '3008': B(1, 8),   // 1×8 Brick
  '3009': B(1, 6),   // 1×6 Brick
  '3010': B(1, 4),   // 1×4 Brick
  '3011': B(2, 6),   // 2×6 Brick
  '3622': B(1, 3),   // 1×3 Brick
  '6111': B(1, 10),  // 1×10 Brick
  '6112': B(1, 12),  // 1×12 Brick
  '2357': B(2, 2),   // 2×2 Corner Brick
  '6215': B(2, 4),   // 2×4 Brick variant

  // ── Tall Bricks ────────────────────────────────────────────────────────────
  '3245': T(6, 1, 2),  // 1×2×2 Brick (2 bricks = 6 plates)
  '60593': T(9, 1, 4), // 1×4×3 Brick (3 bricks = 9 plates)
  '4182': T(9, 1, 2),  // 1×2×3 Brick
  '2453': T(6, 1, 2),  // 1×2×2 Brick variant
  '6510': T(6, 2, 2),  // 2×2×2 Brick
  '30145': T(6, 2, 2), // 2×2×2 Brick variant
  '98560': T(6, 1, 2), // 1×2×2 Modified Brick

  // ── Plates (1 plate = 1 height unit) ──────────────────────────────────────
  '3024': P(1, 1),   // 1×1 Plate
  '3023': P(1, 2),   // 1×2 Plate
  '3623': P(1, 3),   // 1×3 Plate
  '3710': P(1, 4),   // 1×4 Plate
  '3666': P(1, 6),   // 1×6 Plate
  '3460': P(1, 8),   // 1×8 Plate
  '4477': P(1, 10),  // 1×10 Plate
  '60479': P(1, 12), // 1×12 Plate
  '3022': P(2, 2),   // 2×2 Plate
  '3021': P(2, 3),   // 2×3 Plate
  '3020': P(2, 4),   // 2×4 Plate
  '3795': P(2, 6),   // 2×6 Plate
  '3034': P(2, 8),   // 2×8 Plate
  '3832': P(2, 10),  // 2×10 Plate
  '2445': P(2, 12),  // 2×12 Plate
  '3031': P(4, 4),   // 4×4 Plate
  '3032': P(4, 6),   // 4×6 Plate
  '3035': P(4, 8),   // 4×8 Plate
  '3030': P(4, 10),  // 4×10 Plate
  '3958': P(6, 6),   // 6×6 Plate
  '3036': P(6, 8),   // 6×8 Plate
  '3033': P(6, 10),  // 6×10 Plate
  '3028': P(6, 12),  // 6×12 Plate
  '57748': P(4, 12), // 4×12 Plate
  '728': P(6, 24),   // 6×24 Plate (Baseplate half)
  '3867': P(8, 8),   // 8×8 Plate

  // ── Tiles (same thickness as plates, no stud) ─────────────────────────────
  '3070': P(1, 1),   // 1×1 Tile
  '3069': P(1, 2),   // 1×2 Tile
  '63864': P(1, 3),  // 1×3 Tile
  '2431': P(1, 4),   // 1×4 Tile
  '6636': P(1, 6),   // 1×6 Tile
  '4162': P(1, 8),   // 1×8 Tile
  '3068': P(2, 2),   // 2×2 Tile
  '87079': P(2, 4),  // 2×4 Tile
  '69729': P(2, 6),  // 2×6 Tile
  '6934': P(2, 8),   // 2×8 Tile
  '4515': P(6, 8),   // 6×8 Tile
  '26603': P(1, 2),  // 1×2 Tile with Groove
  '26601': P(1, 1),  // 1×1 Tile with Clip
  '35787': P(2, 2),  // 2×2 Tile with Pin
  '27263': P(1, 2),  // 1×2 Tile with Center Groove

  // ── Jumper / Modified Plates ──────────────────────────────────────────────
  '3794': P(1, 2),   // 1×2 Plate with 1 Stud (Jumper)
  '87080': P(1, 2),  // 1×2 Plate with 1 Stud (Groove)
  '15573': P(1, 2),  // 1×2 Plate with 1 Stud Centered
  '11833': P(2, 4),  // 2×4 Plate with 2 Studs

  // ── Round / Cylinder Bricks ───────────────────────────────────────────────
  '3062': B(1, 1),   // 1×1 Round Brick
  '6143': B(2, 2),   // 2×2 Round Brick
  '85941': B(1, 1),  // 1×1 Round Brick (variant)
  '22885': B(1, 2),  // 1×2 Truncated Brick

  // ── Round Plates ──────────────────────────────────────────────────────────
  '4073': P(1, 1),   // 1×1 Round Plate
  '30357': P(1, 1),  // 1×1 Round Plate (variant)
  '15535': P(2, 2),  // 2×2 Round Plate
  '74611': P(4, 4),  // 4×4 Round Plate
  '18674': P(4, 4),  // 4×4 Round Plate with Pin
  '2654': P(2, 2),   // 2×2 Round Plate with Axle

  // ── Slope Bricks 45° (treated as equivalent brick height) ─────────────────
  '3040': B(1, 2),   // 45° Slope 1×2
  '3039': B(2, 2),   // 45° Slope 2×2
  '3038': B(2, 3),   // 45° Slope 2×3
  '3037': B(2, 4),   // 45° Slope 2×4
  '4871': B(2, 2),   // 45° Double Concave Slope 2×2
  '3045': B(2, 2),   // 33° Double Convex Slope 2×2
  '3046': B(2, 2),   // 33° Double Concave Slope 2×2

  // ── Inverted Slope Bricks ─────────────────────────────────────────────────
  '3665': B(1, 2),   // 45° Inverted Slope 1×2
  '3660': B(2, 2),   // 45° Inverted Slope 2×2
  '3747': B(2, 3),   // 33° Inverted Slope 2×3
  '4287': B(1, 3),   // 33° Inverted Slope 1×3
  '4286': B(1, 3),   // 33° Slope 1×3
  '4460': B(2, 3),   // 75° Slope 2×3
  '30363': B(1, 1),  // 75° Slope 1×1
  '54200': B(1, 1),  // 31° Slope 1×1 (Cheese Slope)
  '85984': B(1, 2),  // 31° Slope 1×2
  '15571': B(1, 2),  // 31° Slope 1×2 Right

  // ── Curved / Bow Slopes ───────────────────────────────────────────────────
  '25269': B(1, 3),  // Arch / Bow 1×3
  '76959': P(1, 2),  // Curved Slope 1×2 plate-height
  '99563': B(1, 2),  // Curved Slope 1×2

  // ── Wedge Plates ─────────────────────────────────────────────────────────
  '51739': P(2, 4),  // Wedge Plate 2×4 Right
  '52031': P(2, 4),  // Wedge Plate 2×4 Left
  '41769': P(2, 4),  // Wedge Plate 2×4 Left (variant)
  '41770': P(2, 4),  // Wedge Plate 2×4 Right (variant)
  '2419': P(3, 4),   // Wedge Plate 3×4 Right
  '2420': P(3, 4),   // Wedge Plate 3×4 Left
  '3584': P(4, 4),   // Wing Plate 4×4
  '4857': P(2, 8),   // Wing Plate 2×8 Right
  '62361': P(2, 6),  // Wedge Plate 2×6 Right
  '78441': P(3, 6),  // Wedge Plate 3×6 Right

  // ── Wedge Bricks ──────────────────────────────────────────────────────────
  '28625': B(1, 2),  // Wedge 1×2 Right
  '29119': B(1, 2),  // Wedge 1×2 Left
  '6564': B(1, 3),   // Wedge 1×3 Right
  '6565': B(1, 3),   // Wedge 1×3 Left
  '50373': B(2, 4),  // Wedge 2×4 Right
  '50374': B(2, 4),  // Wedge 2×4 Left

  // ── Modified Bricks (SNOT, headlight, clip, etc.) ─────────────────────────
  '3680': B(2, 2),   // 2×2 Turntable Brick Top
  '30414': B(1, 4),  // 1×4 Brick with Studs on Side
  '4733': B(1, 1),   // 1×1 Brick with 4 Studs on Side
  '87087': B(1, 1),  // 1×1 Brick with Stud on Side
  '2555': B(1, 1),   // 1×1 Brick with 1 Stud on Top (Headlight)
  '4070': B(1, 1),   // 1×1 Brick with Headlight
  '98283': B(1, 2),  // 1×2 Modified Brick with Masonry Profile
  '11212': B(2, 2),  // 2×2 Modified Brick with Studs on All Sides
  '30413': B(1, 4),  // 1×4 Brick with Studs on Side (variant)
  '6091': B(1, 2),   // 1×2 Arch Brick
  '3659': B(1, 4),   // 1×4 Arch Brick

  // ── Brackets / Modified Plates ────────────────────────────────────────────
  '99781': T(2, 1, 2),  // 1×2 Bracket - 1×2 Up
  '99780': T(2, 1, 2),  // 1×2 Bracket - 1×2 Down
  '36840': T(2, 1, 2),  // 1×2 Bracket variant
  '11476': T(2, 1, 1),  // 1×1 Bracket with 1×1 Plate - Down
  '15706': T(4, 1, 2),  // 1×2 Bracket 1×4
  '92438': T(2, 1, 4),  // 1×2 Plate with 1×4 Arm Down

  // ── Technic Bricks ────────────────────────────────────────────────────────
  '3700': B(1, 2),   // 1×2 Technic Brick with Hole
  '3701': B(1, 4),   // 1×4 Technic Brick with Holes
  '3702': B(1, 6),   // 1×6 Technic Brick with Holes
  '3703': B(1, 8),   // 1×8 Technic Brick with Holes
  '32000': B(1, 2),  // 1×2 Technic Brick with Axle Hole
  '6629': B(2, 4),   // 2×4 Technic Brick
  '2877': B(1, 2),   // 1×2 Technic Brick with 3 Holes
  '6541': B(1, 2),   // 1×2 Technic Brick with 2 Holes
  '3894': B(1, 6),   // 1×6 Technic Brick with Holes (variant)

  // ── Technic Liftarms / Beams ──────────────────────────────────────────────
  '32316': P(1, 5),  // Technic Liftarm 1×5 Straight
  '32524': P(1, 7),  // Technic Liftarm 1×7 Straight
  '32278': P(1, 15), // Technic Liftarm 1×15 Straight
  '32009': P(1, 7),  // Technic Liftarm 1×7 Bent
  '2825': P(1, 3),   // Technic Liftarm 1×3
  '41239': P(1, 13), // Technic Liftarm 1×13 Straight
  '32525': P(1, 11), // Technic Liftarm 1×11 Straight
  '32140': P(1, 5),  // Technic Liftarm 1×5 with Pin Holes

  // ── Technic Plates ────────────────────────────────────────────────────────
  '3713': P(1, 2),   // Technic Plate 1×2 with Hole
  '32028': P(1, 2),  // Technic Plate 1×2 with 2 Studs
  '3749': P(1, 4),   // Technic Plate 1×4 with Holes

  // ── Window / Door Frames ──────────────────────────────────────────────────
  '3853': T(9, 1, 4),  // Window 1×4×3 (9 plates = 3 bricks)
  '3854': T(6, 1, 4),  // Window 1×4×2 (6 plates = 2 bricks)
  '60616': T(9, 1, 4), // Door 1×4×3 Left
  '60617': T(9, 1, 4), // Door 1×4×3 Right
  '2362': T(6, 1, 2),  // Window 1×2×2 (no pane)
  '30179': T(6, 1, 2), // Window 1×2×2 variant

  // ── Arch Bricks ───────────────────────────────────────────────────────────
  '3455': B(1, 4),   // 1×4 Arch Brick
  '6182': B(1, 4),   // 1×4 Arch variant
  '30099': B(1, 3),  // 1×3 Arch Brick
  '92903': B(1, 6),  // 1×6 Arch Brick

  // ── Cylinders / Cones ─────────────────────────────────────────────────────
  '4589': B(1, 1),   // Cone 1×1 with Top Groove
  '6188': P(1, 1),   // Cone 1×1 Flat
  '3941': B(2, 2),   // Cylinder 2×2
  '48092': B(1, 1),  // Cylinder 1×1
  '11477': P(1, 2),  // Slope Curved 1×2 (Macaroni)

  // ── Dishes ────────────────────────────────────────────────────────────────
  '3960': T(2, 4, 4),  // 4×4 Dish (2 plates deep)
  '3586': T(1, 2, 2),  // 2×2 Dish
  '44375': T(3, 6, 6), // 6×6 Dish

  // ── Specialty / Compound Parts ────────────────────────────────────────────
  '24299': B(1, 1),  // 1×1 Modified Plate (used in Mona Lisa)
  '49307': P(1, 1),  // 1×1 Plate Modified (round top; used in art sets)
  '98138': P(1, 1),  // 1×1 Plate Modified with Clip (Round)
  '14417': P(1, 1),  // 1×1 Plate Modified variant
  '91988': P(1, 2),  // 1×2 Plate Modified
  '92946': P(1, 2),  // 1×2 Plate Modified w/ Ramp
  '5091': P(1, 2),   // 1×2 Grille Plate
  '5092': P(2, 2),   // 2×2 Grille Plate

  // ── Hinges ────────────────────────────────────────────────────────────────
  '3937': P(1, 2),   // Hinge Plate 1×2 with Locking
  '3938': P(1, 2),   // Hinge Plate 1×2 Bottom
  '30383': P(1, 2),  // Hinge Plate 1×2 Locking variant

  // ── Minifig (approximate footprint) ──────────────────────────────────────
  '3626': P(1, 1),   // Minifig Head
  '3838': P(1, 1),   // Minifig Neck Bracket
  '76382': T(3, 1, 2), // Minifig Hips and Legs
  '973': T(3, 1, 2), // Minifig Torso

  // ── Baseplates ────────────────────────────────────────────────────────────
  '3811': P(16, 24), // 16×24 Baseplate
  '3497': P(16, 32), // 16×32 Baseplate
  '3498': P(32, 32), // 32×32 Baseplate
  '4282': P(16, 32), // 16×32 Baseplate (variant)

  // ── Wheel / Vehicle Parts (approximate) ──────────────────────────────────
  '6014': P(2, 2),   // Wheel Centre Small
  '6015': P(2, 4),   // Wheel Centre Large
  '50951': P(2, 4),  // Wheel 2×4 Motorcycle
  '2903': P(2, 2),   // Wheel Hub Small
};

/** Strip letter-suffix variants (e.g. "3245a" → "3245") and file extension */
function normalizePartId(part: string): string {
  return part
    .replace(/\.dat$/i, '')   // remove extension
    .replace(/[a-z]+$/i, ''); // remove trailing letter variants
}

/** Fallback: 1×1 plate — one voxel for unknown geometry primitives */
const DEFAULT_DIMS: Dims = [1, 1, 1];

/** Return [studW, heightPlates, studL] for the given part filename. */
export function getPartDims(part: string): Dims {
  const id = normalizePartId(part);
  return DIMS[id] ?? DEFAULT_DIMS;
}
