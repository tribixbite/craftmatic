# Plan: Data-Driven Building Pipeline

## Status: Phase 1 DONE, Phase 2 DONE (9366ce5)
## Date: 2025-02-25

---

## Problem

Craftmatic routes all building generation through 10 fantasy-style presets
(medieval, gothic, colonial, etc.) selected by `yearBuilt` ranges. The style
preset controls 50+ block material fields. Even though we have an override chain
(OSM > Smarty > SV color > style default), the style preset still determines
~70% of the final materials because most real addresses lack OSM `building:colour`
and SV color extraction only covers wall/roof/trim — the remaining 47 MaterialPalette
fields (interior walls, floors, ceilings, furniture, lighting, plants, etc.) always
come from the preset.

This produces buildings that look like their preset (sandstone desert temples,
deepslate gothic castles) rather than real structures.

## Solution: Replace Style Selection with Data-Driven Material Resolution

Instead of `yearBuilt → StyleName → 50 preset blocks`, resolve each material
field independently through a priority chain of real data sources, falling back
to a **building category** palette (residential/commercial/industrial) only for
fields that no data source can fill.

### Key Insight from Arnis

Arnis (Rust, OSM→Minecraft) uses a clean two-tier system:
1. **OSM tag direct override** (always wins): `building:colour` → RGB → nearest block
2. **Category-based palette** (fallback): `BuildingCategory` → array of block options → deterministic random selection seeded by OSM element ID

No style presets. No yearBuilt→fantasy mapping. The result looks like the real world
because the palette IS the real world data.

### What We Keep

- `MaterialPalette` interface (50+ fields) — the shape is fine
- `StructuralProfile` interface — roof shape/height/plan shape
- `createPalette()` compact spec → full palette expansion
- `color-blocks.ts` RGB→block matching (upgrade to CIE-Lab)
- `coordinate-bitmap.ts` polygon→bitmap rasterization
- All 9 API data sources and their fetching/parsing code
- Room generation, structure generation, decorators
- The override chain concept in `convertToGenerationOptions()`

### What We Replace

- `STYLES` record of 10 fantasy presets → `CATEGORY_DEFAULTS` record of ~5 real-world categories
- `inferStyle(yearBuilt)` → removed entirely
- `inferStyleFromCity()` → removed entirely
- `StyleName` type union → `BuildingCategory` type union

---

## Phase 1: Material Resolution Chain (This Sprint)

### 1A. Replace StyleName with BuildingCategory

**File: `src/types/index.ts`**

```typescript
// Replace fantasy names with real-world building categories
export type BuildingCategory = 'residential' | 'commercial' | 'industrial' | 'civic' | 'historic';

// Keep StyleName as deprecated alias for backward compat in tests/UI
export type StyleName = BuildingCategory | 'fantasy' | 'medieval' | 'modern' | 'gothic'
  | 'rustic' | 'steampunk' | 'elven' | 'desert' | 'underwater' | 'colonial';
```

### 1B. Category Default Palettes

**File: `src/gen/styles.ts`** — add `CATEGORY_DEFAULTS` alongside existing `STYLES`

Five real-world category palettes using materials common to that category:
- **residential**: Oak/birch wood, white/cream walls, brick foundation, gable roof
- **commercial**: Concrete/glass, flat roof, polished floors
- **industrial**: Iron/stone, flat roof, concrete floors
- **civic**: Stone brick, slate roof, ornate pillars
- **historic**: Brick/stone, steep gable, hardwood interior

Each palette field has 2-4 options. Selection uses deterministic RNG seeded by
address hash (like arnis's `element_rng(id)` pattern).

### 1C. Data-Driven Material Resolver

**File: `src/gen/material-resolver.ts`** (new)

Core function: `resolvepalette(prop: PropertyData, category: BuildingCategory, seed: number): StylePalette`

For each MaterialPalette field, resolve through this chain:
1. **Observed color** (SV wall_color / roof_color / trim_color → `rgbToBlock()`)
2. **OSM tag** (`building:colour`, `building:material`, `roof:colour`, `roof:material`)
3. **Assessor data** (Smarty `constructionType`, `exteriorType`, `roofType`)
4. **Category default** with deterministic random selection from options array

Fields that can be resolved from color/OSM/assessor: wall, wallAccent, roofN-W, roofCap,
foundation, window, pillar, door, floor (ground/upper), ceiling.

Fields that always come from category default: furniture (chairs, tables, candles),
interior decoration (carpet, plants, bed), lighting (lanterns, torches).

### 1D. CIE-Lab Color Distance

**File: `src/gen/color-blocks.ts`** — upgrade `colorDistSq()` to CIE-Lab delta-E

The arnis research + pipeline research both identify CIE-Lab as perceptually superior
to RGB Euclidean distance. Implement `rgb_to_lab()` and `delta_e_76()` (simplest
delta-E formula, sufficient for block matching).

### 1E. Wire Resolver into Pipeline

**File: `src/gen/address-pipeline.ts`**

Replace the current flow:
```
inferStyle(yearBuilt) → getStyle(styleName) → apply overrides on top
```
With:
```
inferCategory(propertyType, tags) → resolvePalette(prop, category, seed)
```

The `convertToGenerationOptions()` function simplifies significantly — all material
resolution moves into `resolvePalette()`, removing the per-field override chain
that's scattered across 80 lines.

---

## Phase 2: Expanded Block Palettes (Next Sprint)

### 2A. Arnis-Style DEFINED_COLORS Table

**File: `src/gen/color-blocks.ts`**

Arnis maps each reference color to 2-6 block options, then picks randomly from
the options. This gives visual variety even for similar-colored buildings.
Expand `WALL_PALETTE` to include multiple block options per color cluster:

```typescript
// Current: single block per color
{ block: 'minecraft:bricks', rgb: [150, 97, 83] }

// New: multiple options per color cluster, random selection
{ rgb: [150, 97, 83], options: [
  'minecraft:bricks',
  'minecraft:terracotta',
  'minecraft:red_nether_bricks',
]}
```

### 2B. Construction Type → Block Palette

Map Smarty `constructionType` directly to wall block options (skip style entirely):

| constructionType | Blocks |
|-----------------|--------|
| frame | oak_planks, birch_planks, spruce_planks |
| masonry | bricks, stone_bricks, terracotta |
| steel | iron_block, light_gray_concrete |
| concrete | gray_concrete, stone, smooth_stone |
| log | spruce_log, oak_log, dark_oak_log |
| adobe | terracotta, sandstone |

### 2C. OSM building:material Direct Mapping

Already partially implemented in `import-osm.ts`. Expand the mapping table and
integrate into the resolver chain.

---

## Phase 3: Geometry Improvements

### 3A. Solar API → Real Roof Planes

Currently: Solar API pitch → `roofHeightOverride` (single number).
Target: Solar API segments → actual sloped plane voxelization.

Each Solar segment has: azimuth (compass direction), pitch (degrees), area (sqm),
center point (lat/lng), bounding box. Convert each segment to a 3D plane, then
voxelize the intersection of all planes to produce the actual roof shape.

### 3B. Overture Maps Footprint Source

Add Overture Maps as a footprint source alongside OSM. Overture conflates
OSM + Microsoft ML + Meta footprints → 2.5B+ buildings. Fetch via
GeoParquet tiles or PMTiles HTTP range requests.

Priority chain: OSM (has tags) > Overture (wider coverage) > satellite > sqft estimate

### 3C. Improved Polygon Rasterization

From arnis: multi-seed BFS flood fill with `FloodBitmap` (1 bit/coord) for
arbitrary polygon shapes. Our current `coordinate-bitmap.ts` uses a basic
scanline approach. Consider upgrading to winding-number point-in-polygon
for better handling of complex concave shapes.

---

## Phase 4: Browser-Side ML (Future)

### 4A. Transformers.js + WebGPU Setup
### 4B. SAM2 Material Segmentation from SV
### 4C. YOLOv9 Window/Door Detection
### 4D. Depth Anything V2 Facade Depth

---

## Implementation Order (Phase 1)

| Step | File | What | Status |
|------|------|------|--------|
| 1 | `src/gen/color-blocks.ts` | Add CIE-Lab conversion + delta-E distance | DONE |
| 2 | `src/gen/material-resolver.ts` | Category defaults in resolver (not styles.ts) | DONE |
| 3 | `src/gen/material-resolver.ts` | `resolvePalette()` + `inferCategory()` | DONE |
| 4 | `src/types/index.ts` | Add `BuildingCategory` type + `resolvedPalette` field | DONE |
| 5 | `src/gen/address-pipeline.ts` | Wire resolver when `style='auto'` | DONE |
| 6 | `src/gen/generator.ts` | Use `resolvedPalette` directly when present | DONE |
| 7 | Tests | Update override tests for resolved palette path | DONE |
| 8 | Web UI | Update style selector dropdown, colonial preset | DONE |
| 9 | `src/gen/color-blocks.ts` | Multi-option WALL_CLUSTERS (arnis DEFINED_COLORS) | DONE |
| 10 | `src/gen/api/elevation.ts` | AWS Terrarium elevation tile fetcher | DONE |
| 11 | `src/cli.ts` | Wire footprintSlope() for hillside height correction | DONE |

## Arnis Patterns to Adopt

These patterns from the arnis codebase improve real-world accuracy:

| Pattern | Arnis Implementation | Craftmatic Adaptation |
|---------|---------------------|----------------------|
| **Per-element deterministic RNG** | `ChaCha8` seeded by OSM element ID | Seed `mulberry32` by address hash |
| **Color → block with options array** | `DEFINED_COLORS` table, 2-6 blocks per color, random pick | Expand `WALL_PALETTE` entries to arrays |
| **Category-based fallback** | 20 `BuildingCategory` enums → palette arrays | 5 real-world categories |
| **OSM `building:colour` priority** | Always overrides category palette | Already in override chain, ensure it wins |
| **Outward wall normal for decorations** | Perpendicular to segment direction, centroid dot product | Useful when we support polygon walls |
| **`building:part` suppression** | Relation parts suppress outline way | Support multi-part buildings from OSM |
| **Horizontal window bands** | Full-width glass rows for commercial | Add as commercial category feature |
| **Terrain-aware foundations** | Walls extend down to ground level per column | Relevant for hillside buildings |
| **Skyscraper proportion detection** | `height >= 160 AND height >= 2× longest_side` | Add dimension heuristic for highrise |

## Verification

1. `bunx tsc --noEmit` — no type errors
2. `bun run test` — all 602+ tests pass
3. Re-generate comparison buildings — colors should match SV imagery more closely
4. LA building (Glendower Ave) should no longer be a sandstone temple
5. Style dropdown in web UI shows categories instead of fantasy names

## Compromises

- Fantasy presets (medieval, gothic, etc.) remain available for the Generate tab's
  creative mode. They're just no longer used for real-address generation.
- Interior furniture/decoration still comes from category defaults since no API
  provides interior data. This is acceptable — interiors are never compared to reality.
- CIE-Lab is more expensive than RGB Euclidean (~3× CPU per comparison). With 20
  palette entries this is negligible.
