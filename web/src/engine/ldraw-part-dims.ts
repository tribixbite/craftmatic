/**
 * LDraw part bounding-box dimensions for voxelization.
 *
 * Format: [sW, sH, sL]
 *   sW  — stud width  (LDraw Z-span ÷ 20 LDU;  1 stud = 8 mm)
 *   sH  — plate height (LDraw Y-span ÷  8 LDU;  1 plate = 3.2 mm, 1 brick = 3 plates)
 *   sL  — stud length (LDraw X-span ÷ 20 LDU)
 *
 * ─── Canonical scale ────────────────────────────────────────────────────────
 *   1 Minecraft block = 1 LEGO stud pitch  = 20 LDU =  8 mm  (horizontal)
 *   1 Minecraft block = 1 LEGO plate height=  8 LDU =  3.2 mm (vertical)
 *
 *   Consequences:
 *     • 1×1×1 brick  → 1×3×1  blocks  (W × H × L)
 *     • 1×1×1 plate  → 1×1×1  blocks
 *     • 32×32 baseplate → 32×1×32 blocks
 *     • Aspect ratio: stud:plate = 8 mm : 3.2 mm = 2.5 : 1  (blocks are non-cubic)
 *
 *   DO NOT "fix" bricks to 1-block-tall — doing so would collapse multi-story
 *   builds and destroy the correct relative proportion between bricks and plates.
 *
 * ─── Lookup priority ────────────────────────────────────────────────────────
 *   DIMS (this file, hand-verified) → GENERATED_DIMS (auto from .dat geometry)
 *   → DEFAULT_DIMS [1, 1, 1]
 *
 * ─── Sources ─────────────────────────────────────────────────────────────────
 *   Dimensions verified against BrickLink Studio SplitMerge CSVs:
 *     ldraw/data/SplitMerge/brick.csv   (Y in bricks; ×3 = plates)
 *     ldraw/data/SplitMerge/plate.csv   (Y = 1 plate)
 *     ldraw/data/SplitMerge/tile.csv    (Y = 1 plate)
 *     ldraw/data/SplitMerge/slope.csv   (Y in bricks; ×3 = plates)
 */
import { GENERATED_DIMS } from './ldraw-part-dims-generated.js';

type Dims = [sW: number, sH: number, sL: number];

/** N×M standard brick (3 plates = 1 brick) */
const B = (w: number, l: number): Dims => [w, 3, l];
/** N×M plate or tile (1 plate tall) */
const P = (w: number, l: number): Dims => [w, 1, l];
/** N×M part with explicit sH plate height */
const T = (h: number, w: number, l: number): Dims => [w, h, l];

// ─── Hand-verified dimensions ─────────────────────────────────────────────────
// Organised by BrickLink/Studio category (SplitMerge CSV → source of truth).
// Convention:  B(w,l) = [w, 3, l]   P(w,l) = [w, 1, l]   T(h,w,l) = [w, h, l]

const DIMS: Record<string, Dims> = {

  // ════════════════════════════════════════════════════════════════════════════
  // BRICKS  (standard height = 3 plates = 1 brick = 24 LDU)
  // ════════════════════════════════════════════════════════════════════════════

  // ── 1-wide bricks ────────────────────────────────────────────────────────────
  '3005':  B(1,  1),  // 1×1
  '3004':  B(1,  2),  // 1×2
  '3065':  B(1,  2),  // 1×2 (transparent variant)
  '3622':  B(1,  3),  // 1×3
  '3010':  B(1,  4),  // 1×4
  '3066':  B(1,  4),  // 1×4 (transparent variant)
  '3009':  B(1,  6),  // 1×6
  '3067':  B(1,  6),  // 1×6 (transparent variant)
  '3008':  B(1,  8),  // 1×8
  '925':   B(1,  8),  // 1×8 (old number)
  '6111':  B(1, 10),  // 1×10
  '6112':  B(1, 12),  // 1×12
  '2465':  B(1, 16),  // 1×16

  // ── 2-wide bricks ────────────────────────────────────────────────────────────
  '3003':  B(2,  2),  // 2×2
  '2357':  B(2,  2),  // 2×2 Corner Brick
  '3002':  B(2,  3),  // 2×3
  '3001':  B(2,  4),  // 2×4
  '3011':  B(2,  6),  // 2×6
  '2456':  B(2,  6),  // 2×6 (alternate number)
  '3007':  B(2,  8),  // 2×8
  '3006':  B(2, 10),  // 2×10
  '6215':  B(2,  4),  // 2×4 variant

  // ── Large bricks ─────────────────────────────────────────────────────────────
  '702':   B(4,  4),  // 4×4 Corner Brick (L-shaped; AABB approximation)
  '2356':  B(4,  6),  // 4×6
  '6212':  B(4, 10),  // 4×10
  '4202':  B(4, 12),  // 4×12
  '30400': B(4, 18),  // 4×18
  '4201':  B(8,  8),  // 8×8
  '4204':  B(8, 16),  // 8×16
  '733':   B(10, 10), // 10×10
  '700':   B(10, 20), // 10×20  (also 700a)
  '30072': B(12, 24), // 12×24

  // ── Tall bricks ──────────────────────────────────────────────────────────────
  // Height in plates: 1 brick = 3, 2 bricks = 6, 3 bricks = 9, 5 bricks = 15
  '3245':  T(6,  1,  2),  // 1×2×2  (6 plates)
  '2453':  T(6,  1,  2),  // 1×2×2  variant
  '772':   T(6,  1,  2),  // 1×2×2  variant
  '98560': T(6,  1,  2),  // 1×2×2  Modified
  '6510':  T(6,  2,  2),  // 2×2×2
  '30145': T(9,  2,  2),  // 2×2×3  (9 plates)
  '14716': T(9,  1,  1),  // 1×1×3  (9 plates)
  '22886': T(9,  1,  2),  // 1×2×3  variant
  '4182':  T(9,  1,  2),  // 1×2×3
  '60593': T(9,  1,  4),  // 1×4×3
  '49311': T(9,  1,  4),  // 1×4×3  variant
  '30144': T(9,  2,  4),  // 2×4×3
  '2454':  T(15, 1,  2),  // 1×2×5  (15 plates)
  '46212': T(15, 1,  2),  // 1×2×5  variant
  '3755':  T(15, 1,  3),  // 1×3×5
  '3754':  T(15, 1,  6),  // 1×6×5

  // ── Modified / SNOT bricks ───────────────────────────────────────────────────
  '3680':  B(2,  2),  // 2×2 Turntable Top
  '30414': B(1,  4),  // 1×4 Studs on Side
  '4733':  B(1,  1),  // 1×1 Four Studs on Side
  '87087': B(1,  1),  // 1×1 Stud on Side
  '2555':  B(1,  1),  // 1×1 Headlight
  '4070':  B(1,  1),  // 1×1 with Headlight
  '98283': B(1,  2),  // 1×2 Masonry Profile
  '11211': B(1,  2),  // 1×2 Studs on Side
  '30137': B(1,  2),  // 1×2 with Side Studs
  '30413': B(1,  4),  // 1×4 Studs on Side (variant)
  '6091':  B(1,  2),  // 1×2 Arch
  '3659':  B(1,  4),  // 1×4 Arch
  '22885': B(1,  2),  // 1×2 Truncated
  '32952': B(1,  2),  // 1×2 Side Knob
  '52107': B(1,  2),  // 1×2 variant
  '88393': T(15, 1,  1), // 1×1×5 (Modulex pillar height)

  // ════════════════════════════════════════════════════════════════════════════
  // PLATES  (1 plate = 1 height unit = 8 LDU = 3.2 mm)
  // ════════════════════════════════════════════════════════════════════════════

  // ── 1-wide plates ────────────────────────────────────────────────────────────
  '3024':  P(1,  1),  // 1×1
  '3023':  P(1,  2),  // 1×2
  '3023b': P(1,  2),  // 1×2 variant
  '3623':  P(1,  3),  // 1×3
  '3710':  P(1,  4),  // 1×4
  '78329': P(1,  5),  // 1×5
  '3666':  P(1,  6),  // 1×6
  '3460':  P(1,  8),  // 1×8
  '4477':  P(1, 10),  // 1×10
  '60479': P(1, 12),  // 1×12

  // ── 2-wide plates ────────────────────────────────────────────────────────────
  '3022':  P(2,  2),  // 2×2
  '2420':  P(2,  2),  // 2×2 Corner
  '3021':  P(2,  3),  // 2×3
  '73831': P(2,  3),  // 2×3 Corner
  '3020':  P(2,  4),  // 2×4
  '3795':  P(2,  6),  // 2×6
  '3034':  P(2,  8),  // 2×8
  '3832':  P(2, 10),  // 2×10
  '2445':  P(2, 12),  // 2×12
  '91988': P(2, 14),  // 2×14
  '4282':  P(2, 16),  // 2×16

  // ── 3-wide plates ────────────────────────────────────────────────────────────
  '11212': P(3,  3),  // 3×3
  '77844': P(3,  3),  // 3×3 Corner
  '15397': P(3,  3),  // 3×3 Cross

  // ── 4-wide plates ────────────────────────────────────────────────────────────
  '3031':  P(4,  4),  // 4×4
  '2639':  P(4,  4),  // 4×4 Corner
  '3032':  P(4,  6),  // 4×6
  '3035':  P(4,  8),  // 4×8
  '3030':  P(4, 10),  // 4×10
  '3029':  P(4, 12),  // 4×12
  '57748': P(4, 12),  // 4×12 variant

  // ── 6-wide plates ────────────────────────────────────────────────────────────
  '3958':  P(6,  6),  // 6×6
  '3036':  P(6,  8),  // 6×8
  '3033':  P(6, 10),  // 6×10
  '3028':  P(6, 12),  // 6×12
  '3456':  P(6, 14),  // 6×14
  '3027':  P(6, 16),  // 6×16
  '3026':  P(6, 24),  // 6×24

  // ── 8+-wide plates ───────────────────────────────────────────────────────────
  '3867':  P(8,  8),  // 8×8
  '41539': P(8,  8),  // 8×8 (alternate number)
  '728':   P(8, 11),  // 8×11
  '91405': P(16, 16), // 16×16

  // ── Jumper / modified plates ──────────────────────────────────────────────────
  '3794':  P(1,  2),  // 1×2 Jumper (1 centred stud)
  '87080': P(1,  2),  // 1×2 Jumper Groove
  '15573': P(1,  2),  // 1×2 Jumper Centred
  '11833': P(2,  4),  // 2×4 with 2 Studs
  '4510':  P(1,  4),  // 1×4 with 2 Studs (SNOT)
  '44568': P(1,  2),  // 1×2 SNOT variant
  '65509': P(2,  2),  // 2×2 Modified

  // ── Baseplates (1 plate tall) ─────────────────────────────────────────────────
  '3811':  P(16, 24), // 16×24
  '3497':  P(16, 32), // 16×32
  '3498':  P(32, 32), // 32×32

  // ════════════════════════════════════════════════════════════════════════════
  // TILES  (flat, no top stud; same 1-plate height as plates)
  // ════════════════════════════════════════════════════════════════════════════

  // ── 1-wide tiles ─────────────────────────────────────────────────────────────
  '3070':  P(1,  1),  // 1×1
  '3069':  P(1,  2),  // 1×2 with Groove
  '63864': P(1,  3),  // 1×3
  '2431':  P(1,  4),  // 1×4
  '6636':  P(1,  6),  // 1×6
  '4162':  P(1,  8),  // 1×8

  // ── 2-wide tiles ─────────────────────────────────────────────────────────────
  '14719': P(2,  2),  // 2×2 Corner
  '3068':  P(2,  2),  // 2×2
  '26603': P(2,  3),  // 2×3 with Groove
  '87079': P(2,  4),  // 2×4
  '69729': P(2,  6),  // 2×6
  '6934':  P(3,  6),  // 3×6   ← corrected (was P(2,8))
  '27263': P(1,  2),  // 1×2 Centre Groove

  // ── Larger tiles ─────────────────────────────────────────────────────────────
  '1751':  P(4,  4),  // 4×4
  '10202': P(6,  6),  // 6×6
  '4515':  P(6,  8),  // 6×8
  '90498': P(8, 16),  // 8×16
  '48288': P(8, 16),  // 8×16 (old part)
  '4974':  P(8, 16),  // 8×16 variant
  '26601': P(1,  1),  // 1×1 with Clip
  '35787': P(2,  2),  // 2×2 with Pin

  // ── Round tiles / dishes ──────────────────────────────────────────────────────
  '14769': P(2,  2),  // 2×2 Round Tile
  '4150':  P(2,  2),  // 2×2 Round Tile (cross stud)
  '1748':  P(2,  2),  // 2×2 Round Tile variant
  '3960':  T(2, 4,  4),  // 4×4 Dish (2 plates deep)
  '3586':  T(1, 2,  2),  // 2×2 Dish
  '44375': T(3, 6,  6),  // 6×6 Dish

  // ════════════════════════════════════════════════════════════════════════════
  // ROUND BRICKS & PLATES
  // ════════════════════════════════════════════════════════════════════════════

  '3062':  B(1,  1),  // 1×1 Round Brick
  '85941': B(1,  1),  // 1×1 Round Brick variant
  '6143':  B(2,  2),  // 2×2 Round Brick
  '3941':  B(2,  2),  // 2×2 Cylinder Brick
  '87081': B(2,  2),  // 2×2 Cylinder variant
  '4073':  P(1,  1),  // 1×1 Round Plate
  '30357': P(1,  1),  // 1×1 Round Plate variant
  '15535': P(2,  2),  // 2×2 Round Plate
  '74611': P(4,  4),  // 4×4 Round Plate
  '18674': P(4,  4),  // 4×4 Round Plate with Pin
  '2654':  P(2,  2),  // 2×2 Round Plate with Axle
  '4589':  B(1,  1),  // 1×1 Cone
  '6188':  P(1,  1),  // 1×1 Cone Flat
  '48092': B(1,  1),  // 1×1 Cylinder

  // ════════════════════════════════════════════════════════════════════════════
  // SLOPES 45°  (LEGO naming: "Slope N×M")
  // Height = 1 brick (3 plates). Slope masking applied by voxelizer.
  // ════════════════════════════════════════════════════════════════════════════

  // ── Standard 45° slopes ──────────────────────────────────────────────────────
  '54200': B(1,  1),  // 1×1  Cheese slope (31°)
  '85984': B(1,  2),  // 1×2  31° slope
  '15571': B(1,  2),  // 1×2  31° slope Right
  '3040':  B(1,  2),  // 1×2  45° slope
  '30363': B(1,  1),  // 1×1  75° slope
  '3039':  B(2,  2),  // 2×2  45° slope
  '3038':  B(2,  3),  // 2×3  45° slope
  '3037':  B(2,  4),  // 2×4  45° slope
  '23949': B(1,  6),  // 1×6  45° slope
  '4445':  B(1,  8),  // 1×8  45° slope
  '60219': B(1,  4),  // 1×4  slope (various angle)
  '22889': B(1,  2),  // 1×2  slope variant
  '79756': B(1,  4),  // 1×4  slope variant
  '5540':  B(1,  4),  // 1×4  slope variant

  // ── 33° slopes ───────────────────────────────────────────────────────────────
  '4286':  B(1,  3),  // 1×3  33° slope
  '4287':  B(1,  3),  // 1×3  33° inverted slope
  '3298':  B(1,  2),  // 1×2  33° slope
  '4161':  B(1,  3),  // 1×3  33° slope variant
  '3297':  B(1,  4),  // 1×4  33° slope

  // ── 75° slopes ───────────────────────────────────────────────────────────────
  '4460':  B(2,  3),  // 2×3  75° slope (tall)
  '3684':  T(6, 1,  2),  // 1×2×2  75° slope
  '3678':  T(3, 1,  2),  // 1×2    75° Double Concave slope

  // ── Inverted slopes ───────────────────────────────────────────────────────────
  '3665':  B(1,  2),  // 1×2  45° inverted
  '3660':  B(2,  2),  // 2×2  45° inverted
  '3747':  B(2,  3),  // 2×3  33° inverted
  '76959': B(1,  2),  // 1×2  inverted variant
  '2752':  B(1,  2),  // 1×2  inverted variant

  // ── Double / tent slopes (peak in middle) ────────────────────────────────────
  '4871':  B(2,  2),  // 2×2  Double Concave
  '3045':  B(2,  2),  // 2×2  33° Double Convex
  '3046':  B(2,  2),  // 2×2  33° Double Concave
  '3043':  B(2,  2),  // 2×2  Double 45° (tent)
  '3042':  B(1,  3),  // 1×3  Double 45° (tent)
  '3041':  B(1,  4),  // 1×4  Double 45° (tent)
  '3299':  B(2,  2),  // 2×2  Curved Double slope
  '72454': B(2,  4),  // 2×4  Double slope
  '4854':  B(2,  4),  // 2×4  Double slope variant
  '5174':  B(2,  2),  // 2×2  Double slope variant

  // ════════════════════════════════════════════════════════════════════════════
  // CURVED / BOW SLOPES
  // ════════════════════════════════════════════════════════════════════════════

  '25269': B(1,  3),  // 1×3  Arch / Bow
  '76959b':B(1,  2),  // 1×2  Curved (variant key)
  '99563': B(1,  2),  // 1×2  Curved
  '11477': P(1,  2),  // 1×2  Macaroni (plate-height curved)
  '6081':  B(1,  4),  // 1×4  Bow/Arch Slope
  '93606': B(1,  2),  // 1×2  Curved Slope
  '32803': B(1,  2),  // 1×2  Curved Slope variant
  '24309': B(1,  2),  // 1×2  Curved Slope variant
  '44126': B(1,  2),  // 1×2  Curved Slope variant
  '93273': P(2,  1),  // 1×2  Curved transposed (1-plate tall)
  '66956': B(1,  2),  // 1×2  Curved Wedge pair
  '15068': T(2, 2,  2),  // 2×2  Round Corner (Macaroni, 2 plates tall)

  // ════════════════════════════════════════════════════════════════════════════
  // WEDGE PLATES  (triangular footprint; AABB approximation)
  // ════════════════════════════════════════════════════════════════════════════

  '51739': P(2,  4),  // 2×4  Right
  '52031': P(2,  4),  // 2×4  Left
  '41769': P(2,  4),  // 2×4  Left variant
  '41770': P(2,  4),  // 2×4  Right variant
  '2419':  P(3,  4),  // 3×4  Right
  '2420b': P(3,  4),  // 3×4  Left (2420 used above for corner plate, 2420b is wedge left)
  '3584':  P(4,  4),  // 4×4  Wing
  '4857':  P(2,  8),  // 2×8  Wing Right
  '62361': P(2,  6),  // 2×6  Right
  '78441': P(3,  6),  // 3×6  Right

  // ── Wedge bricks ─────────────────────────────────────────────────────────────
  '28625': B(1,  2),  // 1×2  Wedge Right
  '29119': B(1,  2),  // 1×2  Wedge Left
  '6564':  B(1,  3),  // 1×3  Wedge Right
  '6565':  B(1,  3),  // 1×3  Wedge Left
  '50373': B(2,  4),  // 2×4  Wedge Right
  '50374': B(2,  4),  // 2×4  Wedge Left

  // ════════════════════════════════════════════════════════════════════════════
  // BRACKETS  (L-shaped; vertical face + horizontal plate)
  // ════════════════════════════════════════════════════════════════════════════

  '99781': T(2, 1,  2),  // 1×2 – 1×2  Up
  '99780': T(2, 1,  2),  // 1×2 – 1×2  Down
  '36840': T(2, 1,  2),  // 1×2 – 1×2  variant
  '36841': T(2, 1,  2),  // 1×2 – 1×2  variant
  '11476': T(2, 1,  1),  // 1×1 – 1×1  Down
  '15706': T(4, 1,  2),  // 1×2 – 1×4
  '99207': T(3, 1,  2),  // 1×2 – 2×2  Up
  '44728': T(4, 1,  2),  // 1×2 – 2×2  Down (larger)
  '92438': T(2, 1,  4),  // 1×2 Plate  with 1×4 Arm Down

  // ════════════════════════════════════════════════════════════════════════════
  // PANELS  (thin vertical walls, typically 1 stud deep)
  // ════════════════════════════════════════════════════════════════════════════

  '3853':  T(9, 1,  4),  // Window 1×4×3  (3 bricks = 9 plates)
  '3854':  T(6, 1,  4),  // Window 1×4×2
  '60616': T(9, 1,  4),  // Door   1×4×3  Left
  '60617': T(9, 1,  4),  // Door   1×4×3  Right
  '2362':  T(6, 1,  2),  // Window 1×2×2
  '30179': T(6, 1,  2),  // Window 1×2×2 variant
  '23969': T(6, 1,  2),  // Wall Panel 1×2×2 (curved)
  '15207': T(6, 1,  2),  // Wall Panel 1×2×2 flat
  '4215':  T(6, 1,  2),  // Wall Panel 1×2×2 (open stud)
  '60581': T(6, 1,  2),  // Wall Panel 1×2×2 variant

  // ════════════════════════════════════════════════════════════════════════════
  // ARCH BRICKS  (hollow curved underside)
  // ════════════════════════════════════════════════════════════════════════════

  '3455':  B(1,  4),  // 1×4  Arch
  '6182':  B(1,  4),  // 1×4  Arch variant
  '30099': B(1,  3),  // 1×3  Arch
  '92903': B(1,  6),  // 1×6  Arch

  // ════════════════════════════════════════════════════════════════════════════
  // TECHNIC BRICKS
  // ════════════════════════════════════════════════════════════════════════════

  '3700':  B(1,  2),  // 1×2  with Hole
  '3701':  B(1,  4),  // 1×4  with Holes
  '3702':  B(1,  6),  // 1×6  with Holes
  '3703':  B(1,  8),  // 1×8  with Holes
  '3894':  B(1,  6),  // 1×6  variant
  '32000': B(1,  2),  // 1×2  Axle Hole
  '6629':  B(2,  4),  // 2×4
  '2877':  B(1,  2),  // 1×2  3 Holes
  '6541':  B(1,  2),  // 1×2  2 Holes
  '32291': B(2,  4),  // 2×4  Technic Brick

  // ── Technic plates ───────────────────────────────────────────────────────────
  '3713':  P(1,  2),  // 1×2  with Hole
  '32028': P(1,  2),  // 1×2  2 Studs
  '3749':  P(1,  4),  // 1×4  with Holes

  // ── Technic liftarms (beams)  [sW=1, sH=1, sL=N]  ───────────────────────────
  // Oriented along their length axis; rotation handles real-world direction.
  '43857': P(1,  2),  // Liftarm 1×2
  '32523': P(1,  3),  // Liftarm 1×3  (straight)
  '2825':  P(1,  3),  // Liftarm 1×3  variant
  '32526': P(1,  3),  // Liftarm 1×3  variant
  '32316': P(1,  5),  // Liftarm 1×5  (straight)
  '32140': P(1,  5),  // Liftarm 1×5  with Pin Holes
  '32524': P(1,  7),  // Liftarm 1×7  (straight)
  '40490': P(1,  9),  // Liftarm 1×9  (straight)
  '32525': P(1, 11),  // Liftarm 1×11 (straight)
  '41239': P(1, 13),  // Liftarm 1×13 (straight)
  '32278': P(1, 15),  // Liftarm 1×15 (straight)

  // Bent liftarms — AABB is the bounding box of the full bent shape
  '32009': P(3,  7),  // Liftarm 1×7  Bent 53.5° (3×7 AABB)
  '32271': P(3,  9),  // Liftarm 1×9  Bent
  '32348': P(3,  7),  // Liftarm 1×7  Bent (4-hole)
  '40902': P(3, 11),  // Liftarm 1×11 Bent

  // ════════════════════════════════════════════════════════════════════════════
  // HINGES, CLIPS, SPECIALTY
  // ════════════════════════════════════════════════════════════════════════════

  '3937':  P(1,  2),  // Hinge Plate 1×2 Bottom
  '3938':  P(1,  2),  // Hinge Plate 1×2 Top
  '30383': P(1,  2),  // Hinge Plate Locking variant

  // ── Cones & cylinders ────────────────────────────────────────────────────────
  '4589':  B(1,  1),  // Cone 1×1
  '6188':  P(1,  1),  // Cone 1×1 Flat

  // ── Minifig (approximate footprint) ─────────────────────────────────────────
  '3626':  P(1,  1),  // Head
  '3838':  P(1,  1),  // Neck Bracket
  '76382': T(3, 1,  2),  // Hips and Legs
  '973':   T(3, 1,  2),  // Torso

  // ── Wheel / vehicle ──────────────────────────────────────────────────────────
  '6014':  P(2,  2),  // Wheel Centre Small
  '6015':  P(2,  4),  // Wheel Centre Large
  '50951': P(2,  4),  // Wheel 2×4 Motorcycle
  '2903':  P(2,  2),  // Wheel Hub Small

  // ── Art / specialty ──────────────────────────────────────────────────────────
  '24299': B(1,  1),  // 1×1 Modified (Mona Lisa sets)
  '49307': P(1,  1),  // 1×1 Modified Round Top
  '98138': P(1,  1),  // 1×1 Modified Clip Round
  '14417': P(1,  1),  // 1×1 Modified variant
  '5091':  P(1,  2),  // 1×2 Grille Plate
  '5092':  P(2,  2),  // 2×2 Grille Plate
};

// ─── ID Normalisation ─────────────────────────────────────────────────────────

/**
 * Loose normalization: strips `.dat` extension and print suffixes (e.g. `p01`),
 * but preserves trailing letter variants (`a`, `b`, `c`).
 * Used for first-pass lookup so that variant-specific dims are respected
 * (e.g. `2420b` is a 3×4 wedge plate, distinct from `2420` the 2×2 corner plate).
 */
function normalizePartIdLoose(part: string): string {
  return part
    .replace(/\.dat$/i, '')           // remove extension
    .replace(/p[a-z0-9]{2,}$/i, ''); // print suffix: p01, pb01, pf01 …
}

/**
 * Full normalization: also strips trailing letter variants.
 * Used as fallback when the exact variant has no entry.
 */
function normalizePartId(part: string): string {
  return normalizePartIdLoose(part).replace(/[a-z]+$/i, '');
}

/** Fallback: 1×1×1 plate */
const DEFAULT_DIMS: Dims = [1, 1, 1];

/** Return [sW, sH, sL] for a part filename or bare part ID. */
export function getPartDims(part: string): Dims {
  const loose  = normalizePartIdLoose(part);
  const strict = normalizePartId(part);
  // Try letter-variant specific entry first (e.g. '2420b'), then base number.
  if (loose !== strict) {
    return DIMS[loose]
      ?? (GENERATED_DIMS[loose] as Dims | undefined)
      ?? DIMS[strict]
      ?? (GENERATED_DIMS[strict] as Dims | undefined)
      ?? DEFAULT_DIMS;
  }
  return DIMS[strict] ?? (GENERATED_DIMS[strict] as Dims | undefined) ?? DEFAULT_DIMS;
}

// ─── Shape types ─────────────────────────────────────────────────────────────
/**
 * Geometric shape category for each part.
 *
 * Used by the voxelizer to apply non-rectangular fill patterns:
 *   • 'slope'        – ascending ramp; staircase fill  (high end at local -Z)
 *   • 'slope_double' – tent/ridge; fill peaks in middle
 *   • all others     – full AABB box fill (default)
 */
export type PartShape =
  | 'box'           // Solid rectangular fill  (default)
  | 'flat'          // Plate/tile: 1 plate tall, solid fill
  | 'slope'         // One-directional 45°/33° ramp
  | 'slope_inv'     // Inverted/under slope (box fill for now)
  | 'slope_double'  // Tent/ridge: peak in middle
  | 'wedge'         // Triangular horizontal footprint
  | 'arch'          // Arch/bow: hollow curved underside
  | 'round'         // Circular/cylindrical footprint
  | 'bracket'       // L-shaped bracket
  | 'panel';        // Thin vertical wall

// Non-'box' shape overrides. All unlisted parts default to 'box'.
const PART_SHAPES: Readonly<Record<string, PartShape>> = {

  // ── Flat ─────────────────────────────────────────────────────────────────────
  '3024':'flat','3023':'flat','3623':'flat','3710':'flat','78329':'flat',
  '3666':'flat','3460':'flat','4477':'flat','60479':'flat',
  '3022':'flat','3021':'flat','3020':'flat','3795':'flat',
  '3034':'flat','3832':'flat','2445':'flat','91988':'flat','4282':'flat',
  '11212':'flat','77844':'flat','73831':'flat','15397':'flat',
  '3031':'flat','2639':'flat','3032':'flat','3035':'flat','3030':'flat',
  '3029':'flat','57748':'flat',
  '3958':'flat','3036':'flat','3033':'flat','3028':'flat','3456':'flat',
  '3027':'flat','3026':'flat',
  '3867':'flat','41539':'flat','728':'flat','91405':'flat',
  '3811':'flat','3497':'flat','3498':'flat',
  '2420':'flat',
  // Jumper / modified plates
  '3794':'flat','87080':'flat','15573':'flat','11833':'flat',
  '4510':'flat','44568':'flat','65509':'flat',
  // Tiles
  '3070':'flat','3069':'flat','63864':'flat','2431':'flat',
  '6636':'flat','4162':'flat',
  '14719':'flat','3068':'flat','26603':'flat','87079':'flat',
  '69729':'flat','6934':'flat','27263':'flat',
  '1751':'flat','10202':'flat','4515':'flat','90498':'flat',
  '48288':'flat','4974':'flat','26601':'flat','35787':'flat',

  // ── Slopes ───────────────────────────────────────────────────────────────────
  '3040':'slope','85984':'slope','15571':'slope','54200':'slope',
  '3039':'slope','3038':'slope','3037':'slope',
  '23949':'slope','4445':'slope',
  '30363':'slope','60219':'slope','22889':'slope',
  '79756':'slope','5540':'slope',
  '4286':'slope','3298':'slope','4161':'slope','3297':'slope',
  '4460':'slope','3684':'slope','3678':'slope',

  '3665':'slope_inv','3660':'slope_inv','3747':'slope_inv',
  '76959':'slope_inv','2752':'slope_inv','4287':'slope_inv',

  '4871':'slope_double','3045':'slope_double','3046':'slope_double',
  '3043':'slope_double','3042':'slope_double','3041':'slope_double',
  '3299':'slope_double','72454':'slope_double',
  '4854':'slope_double','5174':'slope_double',

  // ── Curved slopes ────────────────────────────────────────────────────────────
  '25269':'arch','6081':'arch','93606':'slope','99563':'slope',
  '11477':'slope','32803':'slope','24309':'slope','44126':'slope',
  '93273':'slope','66956':'slope','15068':'slope',

  // ── Wedges ───────────────────────────────────────────────────────────────────
  // True triangular footprint wedge plates/bricks:
  '51739':'wedge','52031':'wedge','41769':'wedge','41770':'wedge',
  '2419':'wedge','2420b':'wedge','3584':'wedge','4857':'wedge',
  '62361':'wedge','78441':'wedge',
  '28625':'wedge','29119':'wedge','6564':'wedge','6565':'wedge',
  '50373':'wedge','50374':'wedge',
  // 14719 (2×2 Corner Tile) is genuinely triangular — wedge masking is correct.
  // 77844/73831/2639 are L-shaped corner PLATES — NOT triangular. Use flat.
  '14719':'wedge',
  // Large wedge plates critical to ISD and Falcon hull shape (missing from earlier table):
  '30355':'wedge','30356':'wedge',  // Wedge Plate 6×12 Right/Left  [12,1,6]
  '43722':'wedge','43723':'wedge',  // Wedge Plate 3×2 Right/Left   [3,1,2]

  // ── Round ────────────────────────────────────────────────────────────────────
  '3062':'round','85941':'round','6143':'round',
  '3941':'round','87081':'round',
  '4073':'round','30357':'round','15535':'round',
  '74611':'round','18674':'round','2654':'round',
  '4589':'round','6188':'round','48092':'round',
  '3960':'round','3586':'round','44375':'round',
  '14769':'round','4150':'round','1748':'round',

  // ── Arch ─────────────────────────────────────────────────────────────────────
  '3455':'arch','6182':'arch','30099':'arch','92903':'arch',
  '3659':'arch','6091':'arch',

  // ── Brackets ─────────────────────────────────────────────────────────────────
  '99781':'bracket','99780':'bracket','36840':'bracket','36841':'bracket',
  '11476':'bracket','15706':'bracket','92438':'bracket',
  '99207':'bracket','44728':'bracket',

  // ── Panels ───────────────────────────────────────────────────────────────────
  '3853':'panel','3854':'panel','60616':'panel','60617':'panel',
  '2362':'panel','30179':'panel',
  '23969':'panel','15207':'panel','4215':'panel','60581':'panel',
};

/** Return the shape category for a part filename or bare part ID. */
export function getPartShape(part: string): PartShape {
  const loose  = normalizePartIdLoose(part);
  const strict = normalizePartId(part);
  if (loose !== strict) {
    return PART_SHAPES[loose] ?? PART_SHAPES[strict] ?? 'box';
  }
  return PART_SHAPES[strict] ?? 'box';
}
