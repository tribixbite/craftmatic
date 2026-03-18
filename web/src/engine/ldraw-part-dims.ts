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
  '3680':  P(2,  2),  // 2×2 Turntable Base (plate-height, 1 plate tall; Pass 20 fix: was B(2,2) incorrectly brick-tall)
  '30414': B(1,  4),  // 1×4 Studs on Side
  '4733':  B(1,  1),  // 1×1 Four Studs on Side
  '87087': B(1,  1),  // 1×1 Stud on Side
  '2555':  T(2,  1,  1),  // 1×1 Tile with Clip — Pass 22: was B(1,1)=[1,3,1] wrong; actual height is 2 plates (tile+clip)
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
  '2817':  P(2,  2),  // 2×2 with Holes (Technic) — GENERATED [2,3,2] inflated by stug; plate is 1 plate tall (Pass 29)
  '2397':  T(2,  7,  2),  // Plate 2×2 with Angled Bars — bars extend 7 studs in Z; GENERATED [8,3,3] was inflated (Pass 26)
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
  '4510':  P(1,  8),  // 1×8 with Door Rail  (Pass 14: was P(1,4) — wrong; 4510.dat = Plate 1×8 with Door Rail)
  '44568': P(1,  4),  // Hinge Plate 1×4 Locking (Pass 26 fix: was P(1,2); actual X-span=80 LDU=4 studs)
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
  '44375': T(2, 6,  6),  // 6×6 Dish (2 plates deep; Pass 25 fix: was T(3,…); gen=[6,2,6] confirms sH=2)

  // ════════════════════════════════════════════════════════════════════════════
  // ROUND BRICKS & PLATES
  // ════════════════════════════════════════════════════════════════════════════

  '3062':  B(1,  1),  // 1×1 Round Brick
  '85941': B(1,  1),  // 1×1 Round Brick variant
  '6143':  B(2,  2),  // 2×2 Round Brick
  '3941':  B(2,  2),  // 2×2 Cylinder Brick
  '87081': B(2,  2),  // 2×2 Cylinder variant
  '4073':  P(1,  1),  // 1×1 Round Plate
  '30357': P(3,  3),  // 3×3 Corner Round Plate  (Pass 14: was P(2,2) — wrong; 30357.dat = Plate 3×3 Corner Round)
  '6141':  P(1,  1),  // 1×1 Round Plate (hollow stud)     — top-3 DEFAULT fallback
  '85861': P(1,  1),  // 1×1 Round Plate with Open Stud    — top-3 DEFAULT fallback
  '30057': P(1,  1),  // 1×1 Round Plate (alias)           — commonly missing
  '33291': P(1,  1),  // 1×1 Round Plate with Tabs
  '24246': P(1,  1),  // 1×1 Tile with Rounded End
  '4592':  P(1,  1),  // Hinge Control Stick Base          — top-2 DEFAULT fallback (ISD/Falcon)
  '15535': P(2,  2),  // 2×2 Round Plate
  '74611': P(4,  4),  // 4×4 Round Plate
  '18674': P(2,  2),  // 2×2 Round Tile with Open Stud — Pass 22: was P(4,4)=[4,1,4] wrong; actual is 2×2
  '2654':  P(2,  2),  // 2×2 Round Plate with Axle
  '4589':  B(1,  1),  // 1×1 Cone
  '6188':  P(1,  1),  // 1×1 Cone Flat
  '48092': B(4,  4),  // 4×4 Round Corner Brick  (Pass 14: was B(1,1) wrong; 48092.dat = Brick 4×4 Round Corner)

  // ════════════════════════════════════════════════════════════════════════════
  // SLOPES 45°  (LEGO naming: "Slope N×M")
  // Height = 1 brick (3 plates). Slope masking applied by voxelizer.
  // ════════════════════════════════════════════════════════════════════════════

  // ── Standard 45° slopes ──────────────────────────────────────────────────────
  '54200': B(1,  1),  // 1×1  Cheese slope (31°)
  '85984': P(1,  2),  // 1×2  30° slope tile — Pass 22: was B(1,2)=[1,3,2] wrong; actual height is 1 plate (Slope 30 1×2 ×2/3)
  '15571': B(1,  2),  // 1×2  31° slope Right
  '3040':  B(1,  2),  // 1×2  45° slope
  '30363': B(4,  2),  // 4×2  Slope Brick 18°  (Pass 14: was B(1,1) wrong; 30363.dat = Slope Brick 18 4×2)
  '3039':  B(2,  2),  // 2×2  45° slope
  '3038':  B(2,  3),  // 2×3  45° slope
  '3037':  B(2,  4),  // 2×4  45° slope
  '23949': B(1,  6),  // 1×6  45° slope
  '4445':  B(2,  8),  // 2×8  45° slope (Pass 23 fix: part is 2 studs wide; Falcon ×8)
  '60219': B(1,  4),  // 1×4  slope (various angle)
  '22889': B(1,  2),  // 1×2  slope variant
  '79756': B(1,  4),  // 1×4  slope variant
  '5540':  B(1,  4),  // 1×4  slope variant

  // ── 33° slopes ───────────────────────────────────────────────────────────────
  '4286':  B(1,  3),  // 1×3  33° slope
  '4287':  B(1,  3),  // 1×3  33° inverted slope
  '3298':  B(3,  2),  // 3×2  33° slope (Pass 20 fix: part is 3 studs wide, not 1; matches 30363.dat 'Slope Brick 33 3×2')
  '4161':  B(3,  3),  // 3×3  33° slope variant (Pass 20 fix: part is 3 studs wide; '4161.dat = Slope Brick 33 3×3')
  '3297':  B(3,  4),  // 3×4  33° slope (Pass 20 fix: part is 3 studs wide; '3297.dat = Slope Brick 33 3×4')

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
  '3042':  T(5, 2,  3),  // 2×3  Double 45° tent (Pass 20 fix: was B(1,3); 3042.dat = Slope 45 2×3 Double; sH=5 per geometry)
  '3041':  T(5, 2,  4),  // 2×4  Double 45° tent (Pass 20 fix: was B(1,4); 3041.dat = Slope 45 2×4 Double; sH=5 per geometry)
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
  '24309': B(3,  2),  // 3×2  Curved Slope (Pass 20 fix: was B(1,2); 24309.dat = Slope Brick Curved 3×2; ×65 in Saturn V!)
  '44126': B(1,  2),  // 1×2  Curved Slope variant
  '93273': T(7,  4,  1), // 4×1 Curved Double — 4 Z-studs, dome peaks ~7 plates (Pass 24: was P(2,1); GENERATED=[4,7,1])
  '66956': B(1,  2),  // 1×2  Curved Wedge pair
  '15068': B(2,  2),  // 2×2  Round Corner slope (Pass 23 fix: 1 brick tall, not 2 plates; ×33 Saturn V)

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
  '6564':  B(3,  2),  // 2×3  Wedge Right (Pass 25 fix: was B(1,3)=[1,3,3] → wedge masking was no-op; B(3,2)=[3,3,2] activates triangular footprint; Falcon ×21)
  '6565':  B(3,  2),  // 2×3  Wedge Left  (Pass 25 fix: was B(1,3)=[1,3,3] → same; Falcon ×21)
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
  '3702':  B(1,  8),  // 1×8  with Holes  (Pass 14: was B(1,6) — wrong; 3702.dat = Technic Brick 1×8)
  '3703':  B(1, 16),  // 1×16 with Holes  (Pass 14: was B(1,8) — wrong; 3703.dat = Technic Brick 1×16)
  '3894':  B(1,  6),  // 1×6  variant
  '32000': B(1,  2),  // 1×2  Axle Hole
  '6629':  B(2,  4),  // 2×4
  '2877':  B(1,  2),  // 1×2  3 Holes
  '6541':  B(1,  1),  // 1×1  with Hole — Pass 22: was B(1,2)=[1,3,2] wrong; actual is 1×1 (Technic Brick 1×1 with Hole)
  '32291': B(2,  4),  // 2×4  Technic Brick

  // ── Technic plates ───────────────────────────────────────────────────────────
  '3713':  P(1,  2),  // 1×2  with Hole
  '32028': P(1,  2),  // 1×2  2 Studs
  '3749':  P(1,  4),  // 1×4  with Holes
  '3709b': P(2,  4),  // 2×4  with Holes (Pass 29: was DEFAULT [1,1,1]; Falcon ×41)

  // ── Technic liftarms (beams)  [sW=1, sH=1, sL=N]  ───────────────────────────
  // Oriented along their length axis; rotation handles real-world direction.
  '43857': P(1,  2),  // Liftarm 1×2
  '32523': P(1,  3),  // Liftarm 1×3  (straight)
  '2825':  P(1,  3),  // Liftarm 1×3  variant
  '32526': P(1,  3),  // Liftarm 1×3  variant
  '32316': P(1,  5),  // Liftarm 1×5  (straight)
  '32140': T(2, 4,  2),  // Technic Liftarm Bent 90 2×4 (Pass 20 fix: was P(1,5) wrong ID; 32140.dat = Technic Beam 2×4 Liftarm Bent 90; AABB 4W×2H×2L)
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
  // Large tires/rims: placed with 90° rotation in models (hub along local Z in model space).
  // After voxelizer X-Z swap + that rotation, sW maps to tire-diameter world-cells,
  // sH maps to tire-height Y-cells, sL maps to hub-width world-cells.
  '32019': [7, 16, 4],  // Tyre 20/64×37 S — Technic vehicles; diameter ≈7 cells, hub ≈4 cells
  '86652': [4, 5, 4],   // Wheel Rim 18×37 — sits inside 32019; diameter ~84 LDU = 4 studs
  // Propeller: hub along local Z, blades in local XY plane, placed with identity rotation.
  // After voxelizer X-Z swap, sW→world-X (blade span), sH→world-Y (blade span), sL→world-Z (hub).
  '2742':  [15, 35, 3], // Propellor 3 Blade 15 Diameter — 15-stud disc in XY, 3-stud hub in Z

  // ── Art / specialty ──────────────────────────────────────────────────────────
  '24299': B(1,  1),  // 1×1 Modified (Mona Lisa sets)
  '49307': P(1,  1),  // 1×1 Modified Round Top
  '98138': P(1,  1),  // 1×1 Modified Clip Round
  '14417': P(1,  2),  // Plate 1×2 with Ball Joint — plate body is 1×2, ball extends bbox
  '5091':  P(1,  2),  // 1×2 Grille Plate
  '5092':  P(2,  2),  // 2×2 Grille Plate
};

// ─── ID Normalisation ─────────────────────────────────────────────────────────

/**
 * Loose normalization: strips `.dat` extension and print suffixes (e.g. `p01`),
 * but preserves trailing letter variants (`a`, `b`, `c`).
 * Used for first-pass lookup so that variant-specific dims are respected
 * (e.g. `2420b` is a 3×4 wedge plate, distinct from `2420` the 2×2 corner plate).
 *
 * Print suffix rule: strip `p` + 2+ alphanumeric chars at end ONLY when
 * preceded by a digit — e.g. `3010p01` → `3010`, `6143pb01` → `6143`.
 * This prevents stripping from alphabetical primitive names like `npeghol2`
 * (old regex would eat `peghol2`, leaving `n`, then `getPartDims` would
 * fall through to the spurious `GENERATED_DIMS['']` catch-all entry).
 */
function normalizePartIdLoose(part: string): string {
  return part
    .replace(/\.dat$/i, '')                  // remove extension
    .replace(/([0-9])p[a-z0-9]{2,}$/i, '$1'); // print suffix: 3010p01→3010, 6143pb01→6143
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
  // Guard: empty keys produce false hits (GENERATED_DIMS[''] is a gen artefact)
  if (!strict) return DEFAULT_DIMS;
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
  | 'panel'         // Thin vertical wall
  | 'frame'         // Rectangular frame: solid border, hollow center void
  | 'corner';       // L-shaped corner: two perpendicular 1-stud arms, hollow opposite quadrant

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
  // Pass 21: grille tiles and large tiles-with-studs (already sH=1; correctness labels)
  '2412b':'flat',    // Tile 1×2 Grille with Groove — Saturn V ×104
  '6179':'flat',     // Tile 4×4 with Studs on Edge — ISD ×10
  '6180':'flat',     // Tile 4×6 with Studs on Edges — ISD ×10
  '6178':'flat',     // Tile 6×12 with Studs on Edges — ISD ×2

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
  '93273':'slope_double','66956':'slope','15068':'slope', // 93273=Slope Curved 4×1 Double (Pass 24: slope→slope_double)
  // Pass 4: additional curved/angled slope parts
  '50950':'slope',   // Slope Brick Curved 3×1
  '47457':'slope',   // Slope Brick Curved 2×2×2/3 Triple
  '92946':'slope',   // Slope Plate 45 2×1
  '15672':'slope',   // Slope Plate 45 2×1 (alt number)
  // Pass 10: high-volume slope parts found in ISD/Falcon audit
  '30249':'slope',   // Slope Brick 55 1×6×5  (×6 in ISD, tallVol=540)
  '3048b':'slope',   // Slope Brick 45 1×2 Triple  (×10 in ISD)
  // Pass 11: additional slope shapes — large footprints with good masking geometry
  '30182':'slope',        // Slope Brick 45 4×4 [4,3,4] — solid diagonal ramp
  '30602':'slope',        // Slope Brick Curved Top 2×2×1 [2,3,2]
  '2875':'slope',         // Slope Brick 45 2×6×0.667 [2,3,6]
  '11290':'slope_double', // Slope Brick Curved 2×8×2 Double [2,6,8] — tent spans 8 Z-cells
  '11301':'slope_inv',    // Slope Brick Curved 2×8×2 Inverted Double [2,6,8]

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
  '54383':'wedge','54384':'wedge',  // Wedge Plate 6×3 Right/Left   [6,1,3]  (114× in Falcon)
  // Pass 4: additional wedge bricks
  '93348':'wedge',   // Wedge 4×4 with Stud Notches         [4,4,4]
  '41747':'wedge',   // Wedge 2×6 Double Right               [6,3,2]
  '41748':'wedge',   // Wedge 2×6 Double Left                [6,3,2]
  // Pass 10: wedge bricks found in Falcon audit
  '41767':'wedge',   // Wedge 4×2 Right  (×3 in Falcon)
  '41768':'wedge',   // Wedge 4×2 Left   (×3 in Falcon)
  '47753':'wedge',   // Wedge 4×4 Triple Curved without Studs  (×2 in Falcon)
  // Pass 13: Wing plates (triangular footprint in horizontal plane)
  '3934':'wedge',    // Wing 4×8 Right  [8,1,4] — ×7 in ISD
  '3933':'wedge',    // Wing 4×8 Left   [8,1,4] — ×7 in ISD
  '47398':'wedge',   // Wing 3×12 Right [12,1,3] — ×4 in Falcon
  '47397':'wedge',   // Wing 3×12 Left  [12,1,3] — ×4 in Falcon
  '43719':'wedge',   // Wing 4×4 with 2×2 Cutout [4,1,4] — ×3 in Falcon
  '90194':'wedge',   // Wing 3×4 with 1×2 Cutout [3,1,4] — ×2 in Falcon
  '2625':'wedge',    // Boat Bow Plate 6×7 [7,1,6] — ISD ×6; triangular hull plate (~-20 cells/part)
  // Pass 13: slope parts
  '3676':'slope_double', // Slope Brick 45 2×2 Inverted Double Convex [2,3,2] — ×2 in ISD

  // ── Round ────────────────────────────────────────────────────────────────────
  // 1×1 and 2×2 round parts (masking no-op but shape tag used for consistency)
  '3062':'round','85941':'round','6143':'round',
  '3941':'round','87081':'round',
  '4073':'round','30357':'round','6141':'round','85861':'round',
  '30057':'round','33291':'round','15535':'round',
  '74611':'round','18674':'round','2654':'round',
  '4589':'round','6188':'round','48092':'round',
  // 4×4 round parts (inscribed-circle masking cuts 4 corner cells)
  '30565':'round',                           // Plate 4×4 Corner Round [4,1,4] — Falcon ×12; 4 corner cells cut/layer
  '3960':'round','3586':'round','44375':'round',
  '30065':'round','56641':'round',  // Dish 4×4 Inverted variants
  '14769':'round','4150':'round','1748':'round',
  // Large round/dish parts with significant corner savings (Pass 5)
  '3961':'round','18859':'round',            // Dish 8×8 Inverted (cuts ~12 cells/layer)
  '4285a':'round','4285b':'round',           // Dish 6×6 Inverted Webbed (cuts 4 cells/layer)
  '45729':'round','18675':'round',           // Dish 6×6 Inverted variants
  '30234':'round','44375a':'round','44375b':'round', // Dish 6×6 more variants
  '50990a':'round','50990b':'round','51373':'round', // Dish 10×10 Inverted (cuts ~30 cells/layer)
  '98606':'round',                           // Dish 9×9 Inverted
  '6942':'round',                            // Dish 5×5
  '30208':'round','98107':'round',           // Hemisphere 4×4 / 11×11
  '4424':'round','64951':'round','30139':'round', // Barrel 4.5×4.5 variants
  '6222':'round',                            // Brick 4×4 Round with Holes
  '3943b':'round','3943a':'round',           // Cone 4×4×2 (cuts 4 corner cells/layer)
  '4285c':'round',                           // Dish 6×6 additional variant
  '6106':'round',                            // Plate, Round 6×6 with Hole (Falcon dish base, 32×)
  // Pass 4: additional round parts present in Saturn V and other sets
  '30562':'round',   // Panel 4×4×6 Corner Round (quarter-cylinder hull section, [4,18,4])
  '60474':'round',   // Plate 4×4 Round with Hole and Snapstud
  '4032a':'round','4032b':'round',           // Plate 2×2 Round with Axlehole
  '43898':'round','44882':'round',           // Dish 3×3 Inverted
  '98100':'round',   // Cone 2×2 Truncated
  '59900':'round',   // Cone 1×1 with Stop
  // Pass 6 (arch review): large cylindrical parts used as engine/column elements
  '2573':'round',    // Wheel 48×76 with Tread on Sidewall — ISD engine cylinders ×3; [10,25,6]
                     // cuts ~12 cells/layer × 25 layers = 300 cells per instance, ×3 = 900 saved
  '32019':'round',   // Tyre 20/64×37 S — Technic vehicles; circular cross-section in side view
  '86652':'round',   // Wheel Rim 18×37 — circular cross-section; inside Tyre 32019
  '2742':'round',    // Propellor 3 Blade 15 Diameter — 3-blade disc in XY plane (hub along Z)
  '30332':'round',   // Propellor 3 Blade 9 Diameter — tail rotor; hub along Z, disc in XY
  // Pass 12: cones and round plates found in Saturn V audit
  '48310':'round',   // Cone 8×4×6 Half — Saturn V ×2; cuts corners per layer
  '6233':'round',    // Cone 3×3×2 — Saturn V ×6
  '22888':'round',   // Plate 4×8 Round Semicircle — Saturn V ×8; ellipse footprint

  // ── Arch ─────────────────────────────────────────────────────────────────────
  '3455':'arch','6182':'arch','30099':'arch','92903':'arch',
  '3659':'arch','6091':'arch',
  // Pass 4: additional arch parts
  '6005':'arch',     // Arch 1×3×2 with Curved Top
  // Pass 12: additional arch found in Falcon audit
  '3308':'arch',     // Arch 1×8×2 Obsolete — Falcon ×16; hollow underside
  // Pass 21: arch family sweep — parts matching arch AABB but missing from table
  '3307':'arch',     // Arch 1×6×2 with Thick Top and Reinforced Underside — Falcon ×4
  '12939':'arch',    // Arch 1×6×2 with Very Thin Top
  '15254':'arch',    // Arch 1×6×2 with Thin Top
  '6183':'arch',     // Arch 1×6×2 with Curved Top
  '6060':'arch',     // Arch 1×6×3 1/3 with Curved Top
  '16577':'arch',    // Arch 1×8×2 Raised
  '88292':'arch',    // Arch 1×3×2
  '6108':'arch',     // Arch 1×12×3 (wide span → deeper arch savings)

  // ── Brackets ─────────────────────────────────────────────────────────────────
  '99781':'bracket','99780':'bracket','36840':'bracket','36841':'bracket',
  '11476':'bracket','15706':'bracket','92438':'bracket',
  '99207':'bracket','44728':'bracket',
  '92411':'bracket',                   // Bracket 1×2 − 2×2 (alias, same geometry as 99207)
  '3956':'bracket',                    // Bracket 2×2 − 2×2 Up (wider face arm)
  '11215':'bracket',                   // Bracket 5×2 (wide arm bracket)
  '18671':'bracket',                   // Bracket 3×2 (medium wide arm)
  '41682':'bracket',                   // Bracket 2×2 − 1×2 Up Centred
  '98287':'bracket',                   // Bracket 3×4 − 3×4 Up
  '4585':'bracket',                    // Bracket 2×1 − 2×1 Up Centred
  '5090':'bracket',                    // Bracket 1×6 − 2×6 Up
  '7452':'bracket',                    // Bracket 1×2 − 2×4 Up
  '2422':'bracket',                    // Bracket 2×2 − 1×4

  // ── Panels ───────────────────────────────────────────────────────────────────
  '3853':'panel','3854':'panel','60616':'panel','60617':'panel',
  '2362':'panel','30179':'panel',
  '23969':'panel','15207':'panel','4215':'panel','60581':'panel',
  // Pass 21: panel correctness labels for high-volume parts in benchmark sets
  '4865a':'panel',   // Panel 1×2×1 with Square Corners — ISD ×140
  '4864b':'panel',   // Panel 1×2×2 with Hollow Studs — Falcon ×4

  // ── Frames (open-center rectangular Technic bricks) ──────────────────────────
  // Pass 15: hollow rectangular frames — border is solid, center void is empty.
  // Saves ~50% of cells vs box fill. Border thickness stored in PART_FRAME_THICKNESS.
  '40345':'frame',   // Technic Brick 6×8 with Open Center 4×6 — ISD ×6; inner void [4×6]
  '32531':'frame',   // Technic Brick 4×6 with Open Center 2×4 — Falcon ×16; inner void [2×4]
  // Pass 17: additional open-center Technic bricks (aliases + smaller sizes)
  '32532':'frame',   // Technic Brick 6×8 with Open Center 4×6 (alt ID) — Falcon ×2
  '40344':'frame',   // =Technic Brick 4×6 with Open Center 2×4 (alt ID) — ISD ×3
  '32324':'frame',   // Technic Brick 4×4 with Open Centre 2×2 — ISD ×9; inner void [2×2]
  '43123':'frame',   // Technic Brick 4×6 with Open Center 2×4 Dual Pins on End [4,3,7]
  '52668':'frame',   // Technic Brick 6×8 with Open Center 4×6 Dual Pins on Ends [7,3,10]

  // ── Corners (L-shaped Technic corner bricks) ─────────────────────────────────
  // Pass 18: two perpendicular arms meeting at one corner; hollow opposite quadrant.
  // Inner corner = local (-lxHalf, -lzHalf); arm width = 1 stud cell.
  '32555':'corner',  // Technic Brick 5×5 Corner with Holes — Falcon ×16, ISD ×n; [5,3,5]
  // Pass 24: additional L-shaped Technic liftarms
  '32140':'corner',  // Technic Beam 2×4 Liftarm Bent 90 — Falcon ×21; [4,2,2]; saves 6 cells/inst
  // Pass 35: more Bent 90 liftarm corners
  '32056':'corner',  // Technic Beam 3×3 Liftarm Bent 90 (thin) [3,1,3]
  '32249':'corner',  // Technic Beam 3×3 Liftarm Bent 90 Quarter Circle [3,1,3]
  '32526':'corner',  // Technic Beam 3×5 Bent 90 [5,2,3]
  // ── Minifig parts (Pass 35) ───────────────────────────────────────────────
  // Add round shape for head; other minifig parts keep default rectangular bbox
  '3626':'round',    // Minifig Head [1,3,1] — round cylinder, not square

  // ── Additional slopes (Pass 18) ───────────────────────────────────────────────
  '6239':'slope',    // Tail Shuttle 2×6×4 — Saturn V ×4; fins taper from base to tip [6,11,2]

  // ── Additional round parts (Pass 18) ─────────────────────────────────────────
  '24593':'round',   // Cylinder Half 2×4×2 with 1×2 Cutout — Saturn V ×2; [3,6,5]

  // ── Additional flat parts (Pass 18) ───────────────────────────────────────────
  '6205':'flat',     // Tile 6×16 with Studs on 3 Edges — ISD ×8; [6,1,16]
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

// ─── Frame Thickness ─────────────────────────────────────────────────────────

/**
 * Border width (in stud cells) for 'frame'-shaped parts.
 * The void is the inner rectangular region with this many cells removed from
 * each edge of the AABB footprint. Both X and Z borders are the same width.
 *
 * For a 6×8 outer frame with 4×6 inner void: border = 1 stud on all sides.
 */
const PART_FRAME_THICKNESS: Readonly<Record<string, number>> = {
  '40345': 1,  // Technic Brick 6×8 with Open Center 4×6
  '32531': 1,  // Technic Brick 4×6 with Open Center 2×4
  '32532': 1,  // Technic Brick 6×8 with Open Center 4×6 (alt ID)
  '40344': 1,  // =Technic Brick 4×6 with Open Center 2×4 (alt ID)
  '32324': 1,  // Technic Brick 4×4 with Open Centre 2×2
  '43123': 1,  // Technic Brick 4×6 with Open Center 2×4 Dual Pins on End
  '52668': 1,  // Technic Brick 6×8 with Open Center 4×6 Dual Pins on Ends
};

/** Return the frame border thickness (in stud cells) for a 'frame' part, or 0 if unknown. */
export function getPartFrameThickness(part: string): number {
  const loose  = normalizePartIdLoose(part);
  const strict = normalizePartId(part);
  return PART_FRAME_THICKNESS[loose] ?? PART_FRAME_THICKNESS[strict] ?? 0;
}

// ─── Bracket Shelf Direction ──────────────────────────────────────────────────

/**
 * For 'bracket'-shaped parts, whether the horizontal shelf faces up or down
 * in the part's default LDraw orientation.
 *   'up'   — shelf is at the top of the part (highest grid-Y cell)
 *   'down' — shelf is at the bottom of the part (lowest grid-Y cell)
 */
const BRACKET_SHELF_DIR: Readonly<Record<string, 'up' | 'down'>> = {
  '99781': 'up',    // Bracket 1×2 – 1×2 Up
  '99207': 'up',    // Bracket 1×2 – 2×2 Up
  '36840': 'up',    // Bracket 1×2 – 1×2 Up variant
  '15706': 'up',    // Bracket 1×2 – 1×4 Up
  '92411': 'up',    // Bracket 1×2 − 2×2 (same geometry as 99207 Up)
  '3956':  'up',    // Bracket 2×2 − 2×2 Up
  '11215': 'up',    // Bracket 5×2
  '18671': 'up',    // Bracket 3×2
  '41682': 'up',    // Bracket 2×2 − 1×2 Up Centred
  '98287': 'up',    // Bracket 3×4 − 3×4 Up
  '4585':  'up',    // Bracket 2×1 − 2×1 Up Centred
  '5090':  'up',    // Bracket 1×6 − 2×6 Up
  '7452':  'up',    // Bracket 1×2 − 2×4 Up
  '2422':  'up',    // Bracket 2×2 − 1×4 (no Up/Down in name; default up)
  '99780': 'down',  // Bracket 1×2 – 1×2 Down
  '44728': 'down',  // Bracket 1×2 – 2×2 Down
  '36841': 'down',  // Bracket 1×2 – 1×2 Down variant
  '11476': 'down',  // Bracket 1×1 – 1×1 Down
  '92438': 'down',  // Bracket 1×2 Plate with 1×4 Arm Down
};

/** Return whether the bracket shelf faces 'up' or 'down' in default orientation. */
export function getBracketShelfDir(part: string): 'up' | 'down' {
  const loose  = normalizePartIdLoose(part);
  const strict = normalizePartId(part);
  return BRACKET_SHELF_DIR[loose] ?? BRACKET_SHELF_DIR[strict] ?? 'up';
}
