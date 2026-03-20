# v300 Pipeline Rework — Design Spec

**Date**: 2026-03-19
**Status**: Approved
**Goal**: Picture-perfect voxel buildings — immediately recognizable, clean, with accurate color and form

## Problem Statement

The v200 pipeline scores 1/10 buildings at 7+ (honest human grade). Six systemic issues were traced to source code:

1. Window glazing creates swiss-cheese holes (mesh-filter.ts:902-984)
2. Height truncation from Google 3D Tiles LOD (external, unfixable for >200m)
3. Neighbor buildings included in footprint (mesh-filter.ts:3477-3616)
4. Street furniture artifacts survive isolation (mesh-filter.ts:5870-5969)
5. Uniform gray surface from zone normalization (voxelize-glb.ts:1949-2244)
6. Satellite reference misaligned with voxel orientation (iterate-grade.ts:330-360)

A seventh issue was identified during design: **fragmented alignment infrastructure** — each stage has ad-hoc rotation handling with no unified coordinate system.

## Building Set

Replace 8 of 10 buildings. Keep Flatiron (proven 8/10) and Pennzoil (proven 7/10).

Key insight: angular features (45° cuts, trapezoids, stepped setbacks) survive voxelization as clean staircases. Curves are destroyed by the cubic grid. Select buildings accordingly.

### Tier 1 — Should score 9+ (clean angular, proven patterns)

| # | Building | City | Height | Distinctive Feature |
|---|----------|------|--------|---------------------|
| 1 | Flatiron Building | NYC | 87m | Acute triangular plan |
| 2 | Pennzoil Place | Houston | 159m | Trapezoidal twin towers, angled roof |
| 3 | National Gallery East Building | Washington DC | ~23m | I.M. Pei sharp triangles and trapezoids |

### Tier 2 — Should score 7-8 (complex angular, challenging)

| # | Building | City | Height | Distinctive Feature |
|---|----------|------|--------|---------------------|
| 4 | Dallas City Hall | Dallas | 64m | 34° inverted pyramid cantilever |
| 5 | Seattle Central Library | Seattle | 57m | Diamond-grid angular overhangs |
| 6 | Boston City Hall | Boston | 50m | Brutalist deep rectangular recesses |
| 7 | Citigroup Center | NYC | 279m | 45° sloped crown (stretch height, angular crown is key test) |

### Tier 3 — Stretch goals 5-7 (hard, pushes pipeline limits)

| # | Building | City | Height | Distinctive Feature |
|---|----------|------|--------|---------------------|
| 8 | Denver Art Museum (Hamilton) | Denver | 38m | Chaotic non-orthogonal intersecting angular planes |
| 9 | USAF Academy Cadet Chapel | Colorado Springs | 46m | 17 repeated sharp triangular aluminum spires (requires resolution 2-3 — at 1 block/m, spires are ~5 blocks wide and will fuse) |
| 10 | LA City Hall | Los Angeles | 138m | Stepped "wedding cake" massing with setbacks |

All cities confirmed to have Google 3D Tiles photogrammetry coverage.

## Architecture: Unified Alignment Infrastructure

The single highest-impact change. Compute building orientation once from OSM polygon, propagate to all stages.

### BuildingAlignment Type

```typescript
interface BuildingAlignment {
  rotationDeg: number;          // CW from true north, from OSM MBR
  rotationRad: number;          // same in radians
  mbrWidth: number;             // MBR long axis (meters) = primary facade length
  mbrDepth: number;             // MBR short axis (meters) = side facade length
  primaryFaceAzimuth: number;   // compass bearing of main facade normal
  osmPolygon: {lat: number; lon: number}[];
  center: {lat: number; lon: number};
}
```

### Step A: OSM-Derived Building Orientation (PRE-CAPTURE)

**New function**: `computeBuildingAlignment(polygon, centerLat, centerLng): BuildingAlignment`

**Location**: `src/convert/mesh-filter.ts`

**Algorithm**: Minimum Area Bounding Rectangle via edge-aligned sweep on convex hull:
1. **Project lat/lon to local meters** using the same conversion as `maskToFootprint()` (mesh-filter.ts:3494-3495): `x = (lon - centerLng) * 111320 * cos(centerLat * Math.PI / 180)`, `z = (centerLat - lat) * 111320`. The `cos()` input must be radians (note the `* Math.PI / 180` — omitting this severely distorts the MBR aspect ratio at non-equatorial latitudes).
2. Compute convex hull of projected polygon vertices (Andrew's monotone chain, O(n log n))
3. For each edge of the convex hull:
   - Compute angle of edge relative to north
   - Rotate all polygon points by negative of that angle
   - Compute axis-aligned bounding box area
4. Edge producing minimum area → `rotationDeg` = angle of that edge
5. MBR long axis = `mbrWidth`, short axis = `mbrDepth`
6. Primary facade normal = perpendicular to MBR long axis

This replaces the OBB angular sweep in `analyzeGrid()` (mesh-filter.ts:4797-4831) which runs too late (post-voxelization) and discards the rotation angle.

### Step B: Camera Alignment to Building Faces (CAPTURE)

**File**: `src/convert/multi-angle-capture.ts`

Rotate the 4 facade capture angles by `rotationDeg`:
```
angle[0] = rotationDeg + 0°    (primary facade face-on)
angle[1] = rotationDeg + 90°   (right side face-on)
angle[2] = rotationDeg + 180°  (rear face-on)
angle[3] = rotationDeg + 270°  (left side face-on)
angle[4] = nadir (-90° pitch)  (roof, unchanged)
```

Face-on views load highest LOD tiles from Google 3D Tiles (minimizing Screen Space Error).

### Step C: Precise Mesh Rotation (POST-CAPTURE, PRE-VOXELIZATION)

**File**: `scripts/voxelize-glb.ts` (reorientToENU, lines 594-734)

When `BuildingAlignment` is provided:
1. Keep PCA vertical alignment (corrects ECEF tilt to Y-up)
2. Replace angular sweep + 90° snap with exact `-rotationRad` rotation around Y-axis
3. Result: primary facade faces -Z, width along X, perfectly axis-aligned

When no alignment is provided (standalone voxelization without OSM), fall back to existing ENU behavior.

### Step D: OSM Mask Without Rotation Guessing

**File**: `src/convert/mesh-filter.ts` (maskToFootprint, lines 3477-3616)

Since mesh is pre-rotated by exact OSM-derived angle, polygon and grid are rotationally aligned. `alignOSMToFootprint()` only needs a small XZ translation search (±10 blocks for GPS drift). Rotation mismatch failure mode eliminated.

### Step E: Satellite Image Alignment (GRADING)

**File**: `scripts/iterate-grade.ts`

1. Fetch north-up satellite image at 1.5x padding (room for rotation clipping)
2. Canvas-rotate by `-rotationDeg` to match voxel grid orientation
3. Draw OSM polygon outline (2px cyan stroke) on rotated satellite — tells VLM exactly which building to evaluate
4. Dynamic zoom: `zoom = Math.floor(22 - Math.log2(mbrWidth / 10))` — building fills ~60% of frame

### Step F: Front Elevation Consistency

**File**: `src/render/png-renderer.ts`

Since primary facade is always at -Z after alignment, front elevation always renders the south face (the architecturally significant facade). No longest-axis guessing.

### Data Flow

```
OSM query → computeBuildingAlignment() → BuildingAlignment
                                              │
              ┌──────────────────────────────┼──────────────────────┐
              ▼                              ▼                      ▼
    tiles-headless.ts             voxelize-glb.ts             iterate-grade.ts
    (cameras aligned to faces)    (mesh rotated precisely)    (satellite rotated + overlay)
                                       │
                                 maskToFootprint()
                                 (translation-only search)
                                       │
                                 renderFrontElevation()
                                 (always -Z = primary facade)
```

## Processing Pipeline Changes

### Change 1: Disable Window Glazing (DEFAULT OFF)

**File**: `scripts/voxelize-glb.ts:1929`

Gate `glazeDarkWindows()` behind `--glaze` flag (default: off). Currently always runs and creates swiss-cheese on dark-facade buildings. Raw photogrammetry colors already produce appropriate dark blocks (gray_concrete, deepslate) for windows — no transparency needed.

Rationale: The DARK_BLOCKS set (mesh-filter.ts:910-916, lum 25-58) is too broad — it matches dark building materials (Chrysler stone, Ansonia Beaux-Arts facade) not just windows. The 30% cap helps but leaves scattered holes. Disabling is the simplest fix with the highest impact.

### Change 2: Hybrid Surface Color (Replace Zone Normalization)

**File**: `scripts/voxelize-glb.ts:1949-2244`

Replace the 5-zone facade system with a hybrid approach:

**A. Gamma correction instead of 1.5x linear multiply**
- Change the `gamma` CLI default from `0.85` to `0.7` in `scripts/voxelize-glb.ts:213`. This is the effective default — the CLI always passes an explicit value to `createDataTextureSampler()` in `src/convert/voxelizer.ts`, so changing the function's internal default (1.0) would have no effect.
- The existing `--gamma` CLI flag (voxelize-glb.ts:264) continues to work for per-building override.
- Remove the post-hoc 1.5x linear brightness boost in zone normalization (voxelize-glb.ts:2036-2051). The gamma correction replaces this — gamma=0.7 lifts shadows without clipping highlights or destroying saturation the way linear multiply does.

**B. Raw colors for wall/facade voxels**
- Map gamma-corrected RGB to nearest Minecraft block via CIELAB ΔE distance
- Preserves building-specific brick, steel, glass, stone, terracotta tones
- Uses existing `rgbToWallBlock()` infrastructure but without forcing to zone palette

**C. Structural zones for roof + ground only**
- Roof: satellite-derived color (existing `roofDom` detection logic, proven)
- Ground/foundation band: bottom 2m forced to sandstone/stone (anchoring)
- No cornice band, no corner trim, no floor bands — these add uniformity that destroys character

**D. Reduce facade homogenization (don't remove entirely)**
- Skip `homogenizeFacadesByFace()` (voxelize-glb.ts:2361) — it collapses facade color variation
- **Keep `modeFilter3D()` but reduce to 1 pass** (currently runs multiple passes). Without any spatial consensus, photogrammetry baked-in shadows, reflections, and sensor noise cause a single concrete wall to map to a chaotic mix of `stone`, `andesite`, `cyan_terracotta` (sky reflection), `gray_concrete` — the "confetti" problem. One pass of mode filtering provides enough consensus to avoid this while preserving intentional material variation.
- `roofDom` is still computed (needed for roof zone) but `wallDom`/`groundDom`/`bandBlock`/`trimBlock` variables are no longer used to remap wall blocks. The palette cleanup pass (voxelize-glb.ts:2367-2379) that uses these zone variables is skipped.
- Cornice generation and floor banding logic (which depend on `bandBlock`/`trimBlock`) are removed — these forced artificial uniformity

### Change 3: 3D Sever-and-Keep-Largest (Pole Removal)

**File**: `src/convert/mesh-filter.ts` — new function

**New function**: `severStreetFurniture(grid, resolution): number`

Algorithm (operates after OSM mask, before fill):

**Pre-step: Build footprint protection mask.** Rasterize the **translated** OSM polygon (the polygon after `alignOSMToFootprint()` has applied its `dx, dz` offset to correct for GPS drift) to a 2D XZ bitmap at the grid's resolution. Using the raw OSM coordinates would offset the mask from the actual voxel footprint, potentially exposing building edges to erosion while protecting empty street. All voxels whose XZ position falls inside this translated bitmap are marked "protected" and exempt from erosion. This prevents eroding the Flatiron's 1-2 block wide acute tip (which IS the building, not a pole) and other narrow but legitimate building features at street level.

1. **Targeted 3D erosion** of bottom `Math.round(15 * resolution)` layers (street level) with radius=1
   - Only erodes voxels OUTSIDE the OSM footprint protection mask
   - Severs 1-block connections between poles/lampposts and the building
   - Building voxels within the OSM polygon are untouched — preserves the Flatiron tip, narrow building wings, etc.
2. **3D connected component labeling** on entire grid (existing `labelConnectedComponents()`)
3. **Keep largest component** by volume — delete all others (severed poles, trees, floating noise)
4. **Targeted 3D dilation** of bottom `Math.round(15 * resolution)` layers with radius=1
   - Restores original building footprint at street level
   - Poles are already gone — dilation only expands the surviving main building

Replaces: `isolatePrimaryBuilding()` annexRadius=2 approach which keeps poles touching AABB.

**Edge case**: If no OSM polygon is available (no `BuildingAlignment`), fall back to aspect-ratio filtering: delete components where `height / max(width, depth) > 8` (very tall and very thin = pole, not building).

### Change 4: Orthographic Camera + Nadir Roof Pass

**File**: `scripts/tiles-headless.ts`

Replace perspective camera with orthographic for all facade captures:
- Eliminates frustum clipping (perspective at (0,8,8) clips above ~50m)
- Ensures 1:1 screen-pixel to voxel mapping regardless of depth

**Orthographic frustum sizing**:
```typescript
const maxDim = Math.max(alignment.mbrWidth, alignment.mbrDepth, buildingHeight);
const halfExtent = maxDim * 0.7; // 40% padding for surrounding context
camera = new THREE.OrthographicCamera(-halfExtent, halfExtent, halfExtent, -halfExtent, 1, maxDim * 4);
// Position: 1.5x maxDim along each facade normal (from BuildingAlignment)
const camDist = maxDim * 1.5;
```

**Wiring to BuildingAlignment**: `tiles-headless.ts` currently has no OSM querying or `--coords` flag — this is new code to add. Import `searchOSMBuilding()` from `src/gen/api/osm.js` and `computeBuildingAlignment()` from `src/convert/mesh-filter.ts`. After geocoding, query OSM for the building polygon, compute alignment, and pass `alignment.rotationDeg` to `positionCameraForAngle()` to orient facade captures to building faces (Step B above).

Nadir capture pass (replaces existing `FIVE_ANGLE_PRESET[0]` in multi-angle-capture.ts:36-40 which is already top-down orthographic, but uses new orthographic frustum sizing above instead of the current fixed camera setup):
- Camera pitch = -90°, orthographic with dynamic frustum from building dimensions
- Captures roof textures at maximum resolution (no oblique stretching)
- Critical for buildings where the roof IS the identity (e.g., stepped setbacks)

**Orthographic LOD gotcha**: `3d-tiles-renderer` calculates SSE differently for orthographic cameras (uniform distance across projection). This may load very low-resolution textures compared to perspective. Lower `tiles.errorTarget` from `2.0` to `0.5` specifically for orthographic passes in `tiles-headless.ts` to force high-LOD textures.

Capture radius: AABB + 15m buffer (tight). Don't capture extra context — let OSM mask do isolation.

## Rendering Pipeline Changes

### Change 5: Directional Shadows via DDA Raycast

**File**: `src/render/png-renderer.ts`

For each visible surface block in isometric and front elevation renders:
1. Cast ray along light direction vector `[1, 1, 1]` (45° azimuth, 45° elevation — standard isometric sun)
2. **Offset ray origin** by +1 block along the exposed face's normal direction to avoid self-intersection (without this, the DDA immediately hits the origin block itself)
3. Step through grid using 3D DDA (Digital Differential Analyzer) — trivial in voxel grid
4. If ray hits solid block before exiting grid → darken origin block by 40%
5. Combine with base block color

**Important**: Shadow darkening is render-only (applied to final RGB pixels in png-renderer.ts). Do NOT change Minecraft block IDs based on shadow state — that would create permanent dark stripes in the schematic.

This defines massing, reveals setbacks, and makes facade recesses visible — currently impossible because everything is flat-lit.

### Change 6: Pseudo Ambient Occlusion

**File**: `src/render/png-renderer.ts`

Reuse and tune the existing `getAO()` function (png-renderer.ts:373-383) which already checks 10 neighbors (cardinals + diagonals) for volumetric AO. The proposed 6-cardinal-neighbor approach is flawed — a voxel in a flat wall has exactly 1 exposed face, same as an inside corner, making them indistinguishable.

Tune the existing `getAO()` multiplier for stronger effect:
- Current: subtle darkening that's barely visible
- Target: 15-25% darkening in recessed areas (Boston City Hall's deep voids, window recesses)
- Multiply AO result with directional shadow result for compound shading

### Change 7: Second Isometric Angle

**File**: `src/render/png-renderer.ts`

Add `renderCutawayIsoBackLeft()` — based on the existing `renderCutawayIso()` (png-renderer.ts:447) but with reversed iteration order: `z = 0 ... l-1` and `x = w-1 ... 0` (instead of `z = l-1 ... 0`, `x = 0 ... w-1`), with the isometric projection origin shifted to the opposite corner. A single isometric view hides 50% of the building where artifacts cluster. `renderExterior()` (line 1391) can also be used as an alternative base if occlusion depth sorting is needed.

In the grading composite: include both iso views.

## Grading Pipeline Changes

### Change 8: Binary Defect Checklist

**File**: `scripts/iterate-grade.ts`

Replace numeric A/B/C/D subscores with binary defect detection:

```json
{
  "height_truncated": false,
  "facade_holes_visible": false,
  "floating_artifacts": false,
  "neighbor_buildings_merged": false,
  "footprint_wrong_shape": false,
  "false_positives_merged": false,
  "building_recognizable": true,
  "proportions_correct": true,
  "surface_detail_visible": true
}
```

**Deterministic scoring** in TypeScript (not VLM):
```typescript
let score = 10;
if (defects.height_truncated) score -= 3;
if (defects.facade_holes_visible) score -= 2;
if (defects.floating_artifacts) score -= 2;
if (defects.neighbor_buildings_merged) score -= 2;
if (defects.footprint_wrong_shape) score -= 2;
if (defects.false_positives_merged) score -= 2;
if (!defects.building_recognizable) score -= 3;
if (!defects.proportions_correct) score -= 1;
if (!defects.surface_detail_visible) score -= 1;
score = Math.max(0, score);
```

Binary yes/no classification is far more stable than numeric scoring — eliminates the ±4 variance per run. This completely replaces the existing `STRUCTURED_PROMPT` (iterate-grade.ts:224-281) — the old A/B/C/D subscore rubric is removed, not kept as fallback.

### Change 9: Switch to gemini-2.5-pro

More reliable spatial reasoning than flash. Use with lower temperature (0.0) for maximum consistency with the binary checklist.

### Change 10: 5 Separate Images (No Composite)

Send 5 individual images instead of baking a 4-panel composite:
1. Satellite reference (rotated + OSM polygon overlay)
2. Top-down voxel
3. Front elevation voxel
4. Isometric front-right voxel
5. Isometric back-left voxel (new)

Individual images preserve full resolution per view. Gemini 2.5 Pro handles multi-image natively.

### Change 11: Dynamic Satellite Zoom

Replace hardcoded `satZoom` per building with:
```typescript
const zoom = Math.min(20, Math.floor(22 - Math.log2(alignment.mbrWidth / 10)));
```

Capped at zoom 20 (Google Static Maps maximum). Building fills ~60% of frame regardless of size. No manual tuning.

## File Modifications Summary

| File | Changes |
|------|---------|
| `src/convert/mesh-filter.ts` | `computeBuildingAlignment()` (new), `severStreetFurniture()` (new), OBB sweep outputs angle |
| `scripts/voxelize-glb.ts` | Disable glazing default, hybrid color (gamma + raw), reorientToENU accepts alignment, remove zone normalization for walls |
| `src/convert/multi-angle-capture.ts` | Camera angles from `BuildingAlignment`, add nadir pass |
| `scripts/tiles-headless.ts` | Orthographic camera, tight radius, accept alignment param |
| `src/render/png-renderer.ts` | DDA shadows, pseudo-AO, second iso angle |
| `scripts/iterate-grade.ts` | Binary defect checklist, 5 images, dynamic zoom, satellite rotation + OSM overlay, building set |
| `src/convert/voxelizer.ts` | No changes needed (gamma passed from CLI) |

## Backward Compatibility

- Standalone `voxelize-glb.ts` (no `--coords`) falls back to existing ENU behavior
- `--glaze` flag re-enables window glazing if needed for specific buildings
- `--zone-normalize` flag (new, to be added) re-enables 5-zone facade if needed
- New rendering features (shadows, AO) enabled by default but can be disabled per render call

## Success Criteria

- Tier 1 buildings (Flatiron, Pennzoil, NGA East): 9-10/10
- Tier 2 buildings (Dallas, Seattle, Boston, Citigroup): 7-9/10
- Tier 3 buildings (Denver, Chapel, LA City Hall): 5-8/10
- Target: **7/10 buildings at 7+** (honest human grade, not VLM inflated)
- VLM-to-human grade gap: < 0.5 (currently +1.5)

## Execution Order

| Step | Component | Effort | Dependencies |
|------|-----------|--------|--------------|
| 1 | `computeBuildingAlignment()` | 1hr | None — pure algorithm |
| 2 | Gamma correction in texture sampler | 30min | None |
| 3 | Disable glazing default + hybrid color | 2hr | Step 2 |
| 4 | `severStreetFurniture()` | 1hr | None |
| 5 | DDA shadows + pseudo-AO | 2hr | None |
| 6 | Second iso angle | 30min | None |
| 7 | Wire alignment into reorientToENU | 1hr | Step 1 |
| 8 | Wire alignment into multi-angle-capture | 1hr | Steps 1, 7 |
| 9 | Orthographic camera + nadir pass | 1hr | Step 8 |
| 10 | Satellite rotation + OSM overlay | 1hr | Step 1 |
| 11 | Binary defect checklist + 5 images | 2hr | Steps 5, 6 |
| 12 | Dynamic satellite zoom | 30min | Step 1 |
| 13 | Capture 3 Tier 1 GLBs + grade | 2hr | Steps 1-12 |
| 14 | Capture 4 Tier 2 GLBs + grade | 3hr | Step 13 |
| 15 | Capture 3 Tier 3 GLBs + grade | 2hr | Step 14 |
| 16 | Iterate on failures | 3hr | Step 15 |

Steps 1-6 can be parallelized (no dependencies between them).
