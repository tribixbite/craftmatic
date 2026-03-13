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
bracket      — L-shaped                                               (TODO)
panel        — thin vertical wall                                     (TODO)
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

## Known Issues / Limitations

1. **Round masking low impact so far** — Most round parts in test sets are 1×1/2×2 so masking is no-op. Large round plates (4150, etc.) would benefit if present in these sets.
3. **Anti-stud inflation** — Parts with tubes underneath may have extra downward extent.
   Currently mitigated by `Math.floor` for sH in gen script.
4. **Grader ceiling** — Haiku visual-grade consistently returns 72/100 regardless of
   incremental improvements. The grader measures rough shape match; fine improvements
   are below its sensitivity threshold. Score is a rough signal only.
5. **Saturn V render too thin** — At 13 studs wide × 256 plates tall, the orthographic
   front/side panels are ~9px wide — too narrow for meaningful visual grading.

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

1. ~~**Wedge masking**~~ — DONE (Pass 2)
2. ~~**Round masking**~~ — DONE (Pass 3, ellipse inscribed footprint)
3. ~~**Arch masking**~~ — DONE (Pass 4, semicircle hollow underside)
4. **DIMS coverage gaps** — identify parts falling through to [1,1,1] default in test models
5. **Color coverage audit** — check unmapped colors falling through to gray fallback
6. **Panel/bracket masking** — thin vertical surfaces (low priority for large-scale models)
7. **Architecture: geometry sampling** — sample actual .dat vertices (major undertaking)
8. **Grader improvement** — higher resolution renders, better comparison prompt
