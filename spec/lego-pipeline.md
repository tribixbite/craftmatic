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
slope        — triangular prism, ramps upward along ascending axis
slope_inv    — inverted slope (ramps downward)
slope_double — tent/ridge shape, peaks at center along ascending axis
wedge        — triangular horizontal footprint (TODO: masking not yet implemented)
arch         — curved underside (TODO: masking not yet implemented)
round        — circular/cylindrical (TODO: masking not yet implemented)
bracket      — L-shaped (TODO: masking not yet implemented)
panel        — thin vertical wall (TODO: masking not yet implemented)
```

### Slope Masking (implemented)
Ascending direction = `R * [0,0,-1]` where R is the brick's 3×3 rotation matrix.
- `ascX = -R[2]`, `ascZ = -R[8]`
- Dominant axis → determines t ∈ [0,1] per column
- `slope`: `yHi = gyMin + round(t * spanY)`
- `slope_inv`: `yLo = gyMax - round(t * spanY)`
- `slope_double`: `yHi = gyMin + round((1 - 2|t-0.5|) * spanY)`

### Wedge Masking (NOT YET IMPLEMENTED — HIGH PRIORITY)
Wedge plates have a triangular footprint in the horizontal plane.
The taper direction can be derived from R. Algorithm needed:
- Ascending axis in XZ plane from R (similar to slope)
- At each (gx, gz): compute horizontal t, apply linear width taper
- Width at t=0: full sW (or sL), at t=1: 1 stud

## Known Issues / Limitations

1. **Wedge masking missing** — ISD and many Star Wars sets use wedge plates extensively.
   AABB fill for wedge plates creates rectangular blobs instead of pointed shapes. HIGH IMPACT.
2. **Round masking missing** — Circular/cylindrical parts fill as rectangles.
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

1. **Wedge masking** — triangular horizontal fill, high impact for angular models (ISD)
2. **Panel/bracket masking** — thin vertical surfaces, relevant for detailed models
3. **Round/arch masking** — circular footprint approximation
4. **Color coverage audit** — check unmapped colors falling through to gray fallback
5. **DIMS coverage gaps** — identify part categories with systematic missing entries
6. **Architecture: geometry sampling** — instead of AABB, sample actual .dat vertices
   for accurate shape (major undertaking, consider as architecture review topic)
7. **Grader improvement** — higher resolution renders, better comparison prompt
