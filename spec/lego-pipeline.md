# LEGO Voxelization Pipeline — Architecture Spec

> Auto-improvement loop: update this file whenever architecture or approach changes significantly.

## Pipeline Overview

```
LDraw MPD/LDR file
  → parseLDraw()          [ldraw-parser.ts]        ParsedBrick[]
  → voxelizeLDraw()       [ldraw-voxelizer.ts]     BlockGrid
  → download / render     [lego.ts / web UI]
```

## Scale Convention (CRITICAL)

| Grid unit | LDraw units | Real-world |
|-----------|------------|-----------|
| 1 cell horizontal (X/Z) | 20 LDU | 1 stud = 8mm |
| 1 cell vertical (Y)     |  8 LDU | 1 plate = 3.2mm |

**Non-cubic**: stud:plate ratio = 2.5:1. This is intentional — matches LEGO proportions.
A standard 1-brick-tall part occupies 3 vertical cells (3 plates = 1 brick = 9.6mm).

LDraw Y is **down**. Grid Y is **up**. Conversion: `grid_y = round(-ldraw_y / 8)`.

## Part Dimensions System

### Sources (priority order)
1. **`DIMS`** — hand-crafted table (~300 entries), highest accuracy, verified against geometry
2. **`GENERATED_DIMS`** — auto-generated from LDraw .dat bounding boxes (7,252 entries)
3. **`DEFAULT_DIMS`** — `[1, 1, 1]` fallback

### Part ID Normalisation (Pass 3)
`normalizePartIdLoose()` strips extension and print suffixes only (preserves letter variants).
`normalizePartId()` additionally strips trailing letters (full normalisation).
Lookup order: `DIMS[loose] → GENERATED_DIMS[loose] → DIMS[strict] → GENERATED_DIMS[strict] → DEFAULT`.
This ensures variant-specific entries (e.g. `2420b` = 3×4 wedge-left, distinct from `2420` = 2×2 corner)
are found correctly rather than falling through to the base part's dimensions.

### Format: `[sW, sH, sL]`
- `sW` = Z-span / 20 LDU  (stud width, typically shorter dimension)
- `sH` = Y-span / 8 LDU   (plate height, uses `Math.floor` to exclude stud bumps)
- `sL` = X-span / 20 LDU  (stud length, typically longer dimension)

### Generation
`bun scripts/gen-part-dims.ts` — reads all LDraw .dat files, recursively resolves sub-file
refs with full 3×3 rotation matrix transform, caches local bboxes. Uses `Math.floor` for
sH to prevent stud-bump inflation. Emits `ldraw-part-dims-generated.ts`.

## Shape System

### Types (`PartShape`)
```
box          — default solid fill (AABB)
flat         — 1-plate tall (plates, tiles) — treated as box
slope        — triangular prism, ramps upward along ascending axis   [IMPLEMENTED]
slope_inv    — inverted slope (ramps downward)                        [IMPLEMENTED]
slope_double — tent/ridge shape, peaks at center along ascending axis [IMPLEMENTED]
wedge        — triangular horizontal footprint                        [IMPLEMENTED Pass 2]
round        — elliptical horizontal footprint (inscribed ellipse)    [IMPLEMENTED Pass 3]
arch         — hollow curved underside (semicircle approximation)     [IMPLEMENTED Pass 4]
bracket      — L-shape in vertical plane (plate row + face column)    [IMPLEMENTED Pass 30]
panel        — thin vertical wall                                     (TODO)
frame        — open-center rectangle (solid border, hollow void)      [IMPLEMENTED Pass 15]
corner       — L-shaped corner: two 1-stud arms, hollow quadrant      [IMPLEMENTED Pass 18]
```

### Slope Masking (implemented)
Ascending direction = `R * [0,0,-1]` where R is the brick's 3×3 rotation matrix.
- `ascX = -R[2]`, `ascZ = -R[8]`
- Dominant axis → determines t ∈ [0,1] per column
- `slope`: `yHi = gyMin + round(t * spanY)`
- `slope_inv`: `yLo = gyMax - round(t * spanY)`
- `slope_double`: `yHi = gyMin + round((1 - 2|t-0.5|) * spanY)`

### Wedge Masking (implemented — Pass 2)
Wedge plates have a triangular footprint in the horizontal plane.
- Taper axis = longer horizontal span (spanX≥spanZ → X, else Z)
- Narrow-end direction = world projection of local +X = [R[0], _, R[6]]
- At each (gx, gz): compute t along taper axis ∈ [0,1]
- `allowedCells = max(1, round((1-t) * totalPerpCells))`; trim symmetrically from both ends
- Width at t=0: full perpendicular span; at t=1: 1 cell

### Round Masking (implemented — Pass 3)
Cylindrical/round parts use an inscribed **ellipse** footprint (handles non-square parts):
- `rx = (spanX+1)/2`, `rz = (spanZ+1)/2`; center at `(gxMin+gxMax)/2, (gzMin+gzMax)/2`
- Cell (gx, gz) included if `((gx-cx)/rx)² + ((gz-cz)/rz)² ≤ 1`
- No-op for 1×1 and 2×2 (all cells within ellipse); effective from 4×4+ (cuts corners)
- Applied only when `spanX > 1 || spanZ > 1` to avoid edge cases with flat parts

### Arch Masking (implemented — Pass 4)
Arch parts have a semicircular hollow underside. Pillar columns at each end are solid.
- Span axis = longer horizontal span (spanZ≥spanX → Z, else X)
- Inner span = span − 2 (one pillar column at each end); skip masking if inner span < 2
- `archRStuds = inner_span / 2`, `archRPlates = archRStuds * 2.5` (stud→plate ratio)
- For each column in inner span: `dNorm = |pos − center| / archRStuds`
- Raise `yLo` to `gyMin + round(archRPlates * sqrt(1 − dNorm²))` — hollow below arch curve
- Only activates when `spanY > 2` (avoids flat/degenerate arches)

### Corner Masking (implemented — Pass 18)
L-shaped Technic corner bricks: two perpendicular 1-stud arms meeting at one corner.
- Inner corner at local `(-lxHalf, _, -lzHalf)` → world: `cornerX = (R[0]+R[2])>0 ? gxMin : gxMax`, `cornerZ = (R[6]+R[8])>0 ? gzMin : gzMax`
- Skip cell if `x ≠ cornerX AND z ≠ cornerZ` (only keep cells on either arm)
- For a 5×5 corner: keeps 9 cells/layer out of 25 (64% savings per layer)
- Parts: `32555` (5×5 Corner, Falcon ×16)

### Bracket Masking (implemented — Pass 30)
Bracket parts are thin L-shapes in the **vertical plane**: a horizontal plate arm (full sL span,
1 plate tall) plus a perpendicular vertical face arm (full sH span, 1 stud wide at one end).
- Face is at local −Z: world face direction = R×[0,0,−1]; dominant axis gives `bracketFaceAxis`
  and `bracketFacePos = (faceWorldAxis >= 0) ? axisMax : axisMin`
- Plate row: `bracketPlateY = (shelfDir === 'up') === (R[4] >= 0) ? gyMax : gyMin`
  where `shelfDir` comes from `getBracketShelfDir()` (Pass 28: `'up'` for 99781/99207/36840/15706, `'down'` for 99780/44728/36841/11476/92438)
- Keep cell if it lies on the face column OR the plate row
- Activates only when `spanY > 0`; handles both Z-facing and X-facing orientations
- Parts: `99207` (Bracket 1×2−2×2 Up, Saturn V ×46), `99781`/`99780` (Saturn V ×40 each), `44728` (ISD+Falcon ×16)
- Impact: Saturn V −71, Falcon −105 blocks

### Frame Masking (implemented — Pass 15)
Open-center Technic bricks (rectangular frames with hollow center voids):
- `frameThick` = border width in stud cells (stored in `PART_FRAME_THICKNESS` table)
- Skip cell `(x, z)` if `x ∈ [gxMin+t, gxMax-t]` AND `z ∈ [gzMin+t, gzMax-t]`
- Works for all 90° Y-rotations (world-space AABB stays axis-aligned)
- Parts: `40345` (6×8 Open 4×6, ISD ×6), `32531` (4×6 Open 2×4, Falcon ×16)
- Impact: ISD −1,097, Falcon −943 blocks

## Primitive Filtering (implemented — Pass 8)

LDraw `.dat` files use "primitive" geometry sub-files (cylinders, rings, edges, discs)
as internal building blocks. MPD files may embed custom parts that reference these library
primitives; parseLDraw emits each unresolved primitive as a "leaf brick" at its world
position. These should NOT be voxelized.

`isLDrawPrimitive(part)` in `ldraw-voxelizer.ts` strips any directory prefix (`48\`, `8\`, etc.)
from the part name before pattern matching, then skips parts matching:
- `/^\d+-\d+/` — standard fraction primitives: `4-4cyli`, `1-8edge`, `4-4ring2`, etc.
  Also catches hi-res variants in `p/48/`: `48\4-4edge`, `48\4-4cyli` (fixed Pass 23)
- `stug-*` — stud geometry primitives
- `axl2hole`, `axlhol*` — axle hole primitives
- `connect*` — Technic connector geometry (connect.dat, connect2.dat, …)
- `npeghol*`, `npeghole*` — notched peg hole geometry primitives
- `logo*` — LEGO logo for studs (logo.dat, logo2.dat, …)
- `stud[2-9]*` — numbered stud variants (stud2–stud9)
- `/^\d+s\d+$/` — LDraw sub-part files (e.g. `47996s01`, `6057s04`)

Impact (Pass 8): ISD −9,333 blocks (−6.4%), Falcon −1,927 blocks (−2.5%).
Impact (Pass 6 — normalization fix + expanded filter): Falcon −6,599 (−8.7%), ISD −1,005 (−0.7%)
Impact (Pass 23 — hi-res `48\*` prefix fix): Falcon ~−16 blocks (server noise; expected ~−88)
Impact (Pass 27 — stud/box/disc/knob/tooth filter): Saturn V −71, Falcon −173 blocks

### Part ID Normalisation Bug (fixed Pass 6)

`normalizePartIdLoose` had print-suffix regex too greedy: `/p[a-z0-9]{2,}$/` ate `peghol2`
from `npeghol2`, reducing it to `n` → `''` → hit `GENERATED_DIMS[''] = [3,6,4]` artefact.
Fix: require digit before `p` — `([0-9])p[a-z0-9]{2,}$` → `$1`. Also added `!strict` guard
in `getPartDims` to prevent empty-key lookups.

## Architectural Ceiling (Pass 30 Assessment)

The pipeline is near its practical ceiling for AABB + shape-masking on the benchmark models.
All major shape types are implemented. Further masking improvements have zero measured block
count impact because in dense assemblies (3,000–5,000 bricks) masked cells are already occupied
by adjacent parts. Full geometry sampling from LDraw .dat files would break through this ceiling
but is not viable for browser runtime (~200MB library + complex recursive resolution).

**Block count journey**: Falcon 78,109 (Pass 0 baseline) → 69,027 (Pass 30) = **−11.6%**

## Known Issues / Limitations

1. **Round masking coverage** — Pass 5 expanded SHAPES 'round' table with 20+ large dish/barrel/hemisphere parts. Falcon now saves -606 blocks. Remaining gap: any new sets with rare round parts not yet listed.
2. **LDraw color 16 (Main Color)** — Fixed in Pass 9. Color 16 = "inherit from parent reference context". `expandSection` now propagates `parentColor` through the recursion stack; color-16 parts inside colored submodels resolve to the correct parent color instead of `gray_concrete`.
3. **Transparent color IDs** — Fixed in Pass 7 (IDs 33–44, 114, 117). The LDraw color system has some unofficial/deprecated IDs (48, 49, 113) with uncertain mappings. Color 142 in older files may be "Trans-Fluorescent Green" but in current LDConfig is "Pearl Light Gold" — version ambiguity.
3. **Anti-stud inflation** — Parts with tubes underneath may have extra downward extent.
   Currently mitigated by `Math.floor` for sH in gen script.
4. **Grader ceiling** — Haiku visual-grade consistently returns 72/100 regardless of
   incremental improvements. The grader measures rough shape match; fine improvements
   are below its sensitivity threshold. Score is a rough signal only.
5. **Saturn V render too thin** — At 13 studs wide × 256 plates tall, the orthographic
   front/side panels are ~9px wide — too narrow for meaningful visual grading.
6. **Falcon flexible-part sub-assemblies** — Custom parts like `47996s01.dat` (Boat
   Rigging sub-part, × 32) and `6057s04.dat` (× 16) are now filtered by the sub-part
   rule (`/^\d+s\d+$/`). The rigging geometry is omitted rather than approximated.

## Files

| File | Role |
|------|------|
| `web/src/engine/ldraw-parser.ts` | MPD/LDR → ParsedBrick[] |
| `web/src/engine/ldraw-voxelizer.ts` | ParsedBrick[] → BlockGrid, shape masking |
| `web/src/engine/ldraw-part-dims.ts` | Dims lookup + shape lookup + DIMS table |
| `web/src/engine/ldraw-part-dims-generated.ts` | AUTO-GENERATED, 7,252 entries |
| `web/src/engine/ldraw-colors.ts` | LDraw color ID → Minecraft block |
| `scripts/gen-part-dims.ts` | Generates ldraw-part-dims-generated.ts |
| `scripts/visual-grade.ts` | Visual quality grader (Claude Haiku vision) |
| `spec/lego-pipeline.md` | This file |
| `spec/improvement-log.md` | Per-pass improvement log |

## Improvement Priorities (ordered by estimated impact)

1. ~~**Wedge masking**~~ — DONE (Pass 1 initial, Pass 2 axis fix + missing wedge parts added)
2. ~~**Round masking**~~ — DONE (Pass 3 ellipse footprint; Pass 5 large dish/barrel/hemisphere coverage)
3. ~~**Arch masking**~~ — DONE (Pass 4, semicircle hollow underside)
4. ~~**DIMS coverage + primitive filtering**~~ — DONE (Pass 8: filter N-M primitives, add 6141/85861/4592/etc.)
5. ~~**Color coverage audit**~~ — DONE (Pass 7: fixed 10 wrong transparent color mappings; Pass 9: color 16 inheritance)
6. ~~**Bracket masking**~~ — DONE (Pass 30: L-shape in vertical plane, plate row + face column)
7. **Flexible-part sub-assemblies** — add dims for `47996s01`, `6057s04` etc. (Falcon rigging)
8. **Slope coverage expansion** — audit box-shaped parts that might be slopes/curved
9. **Architecture: geometry sampling** — sample actual .dat vertices (major undertaking)
10. **Grader improvement** — higher resolution renders, better comparison prompt

## Block Count Benchmarks (latest)

| Set | Bricks | Blocks | Dims | Score |
|-----|--------|--------|------|-------|
| 21309-1 Saturn V | 1,845 | 11,918 | 13×256×16 | 72/100 |
| 10030-1 ISD | 3,037 | 138,458 | 125×136×79 | 72/100 |
| 10179-1 Falcon | 5,335 | 69,005 | 76×86×112 | 72/100 |
