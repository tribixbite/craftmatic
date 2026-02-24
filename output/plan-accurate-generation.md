# Craftmatic: Accurate Generation Roadmap

## Overview

The generation pipeline collects data from 9+ APIs but only uses ~60% of it. Additionally, analysis of the Arnis OSM-to-Minecraft pipeline reveals fundamental architectural improvements needed in geometry handling, roof generation, and wall detailing. This roadmap tracks all enhancements organized by impact and effort.

## References
- `arnis_analysis.md` — Deep dive into Arnis generation pipeline (buildings.rs, floodfill, roofs)
- `craftmatic_improvements.md` — Specific implementation steps derived from Arnis patterns
- Gemini 3 Pro review feedback (grey roofs, PCA vs rotating calipers, roadmap reordering)

## Status Legend
- [ ] Not started
- [~] In progress
- [x] Complete

---

## Phase 0: Fix Satellite Footprint Extraction (Gemini Review)

Issues identified by Gemini 3 Pro review of `import-satellite-footprint.ts`:

### 0.1 Grey Roof Pavement Filter Bypass
- [x] `isPavement()` incorrectly filters out asphalt shingle roofs (common grey desaturated)
- [x] Fix: skip pavement filter when sampled roof color itself is grey
- [x] Hue bucketing instead of mean RGB for robust multi-color roof sampling
- [x] Adaptive `COLOR_THRESHOLD_SQ` based on sample variance

### 0.2 OBB Algorithm: PCA → Minimum-Area Rectangle
- [x] Replaced PCA with discrete angle search (5° coarse → 1° fine refinement)
- [x] Aligns with rectilinear building walls instead of mass distribution
- **File:** `import-satellite-footprint.ts:computeOBB()`

### 0.3 Main Thread Performance
- [x] Wrapped satellite image analysis (color, pool, footprint) in `requestAnimationFrame`
- [x] Satellite canvas shown immediately; overlays applied in next frame
- [ ] Morph ops: consider separable kernel approximation for larger radius values
- **File:** `import.ts` (satellite callback)

---

## Phase 1: Geometry & Scale Accuracy (Highest Priority)

Per Gemini review: "incorrect scale is more jarring than wrong texture" — geometry/scale items moved before material items.

### 1.1 Scanline Flood-Fill Geometry (from Arnis)
- [ ] Implement `CoordinateBitmap` — exact polygonal footprint as 2D block grid
- [ ] Convert OSM polygon vertices → scanline-filled bitmap (not bounding box)
- [ ] Enables pixel-perfect L/T/U/irregular footprints without approximation
- [ ] Replace current `floorPlanShape` heuristic with actual polygon rendering
- **Ref:** Arnis `floodfill_cache.rs:CoordinateBitmap`, `scanline_fill`
- **Files:** new `src/gen/coordinate-bitmap.ts`, modify `src/gen/structures.ts`

### 1.2 Multipolygon & Courtyard Support (from Arnis)
- [ ] Parse OSM `type=multipolygon` relations with `inner`/`outer` roles
- [ ] Subtract inner ring bitmap from outer ring before generation
- [ ] Enables courtyard buildings (apartment complexes, U-shaped structures)
- **Ref:** Arnis `buildings.rs:generate_buildings` hole processing
- **Files:** `web/src/ui/import-osm.ts`, `src/gen/api/osm.ts`

### 1.3 Solar Building Area → Floor Estimation
- [x] CLI story chain: solar footprint area / sqft → story count (between OSM+sqft and heuristic)
- **Files:** `src/cli.ts` (story estimation chain)

### 1.4 Mapbox Height → Story Fallback
- [x] Already wired in CLI: `mapboxHeight / 3.5` → story count (priority 2 after OSM levels)
- **Files:** `src/cli.ts:394-396`

### 1.5 Mapbox Building Type → Structure Type
- [x] `mapboxBuildingType` (apartments/dormitory/hotel/commercial) → effectiveMultiUnit flag
- [x] Influences floor clamping (maxFloors=8), minFloors, and forces flat roof
- **Files:** `src/gen/address-pipeline.ts` (convertToGenerationOptions)

### 1.6 Street View Facade Orientation
- [~] TODO in pipeline — requires generator support for building orientation
- [ ] Add `orientation` field to GenerationOptions + rotate door placement in generator
- **Fields:** `streetViewHeading` (collected, wiring blocked on generator)

---

## Phase 2: Roof & Wall Quality (Visual Impact)

### 2.1 Hip Roof with Proper Directional Stairs
- [x] Added `roofE`/`roofW` to StylePalette — east/west facing stair blocks
- [x] Hip roof uses proper E/W stairs instead of slabs for side slopes
- [x] Mansard roof updated similarly with E/W directional stairs
- [x] Roof override mechanism derives E/W from stair base block
- **Files:** `src/gen/structures.ts`, `src/gen/styles.ts`, `src/gen/generator.ts`

### 2.2 Context-Aware Stair Block Placement (from Arnis)
- [x] `hipCorner()` function appends `shape=outer_right` for corner stair pieces
- [x] All 4 corners of hip and mansard roofs use proper outer corner stairs
- [x] Eliminates gaps at roof corners where two slopes meet
- **Files:** `src/gen/structures.ts`

### 2.3 Solar API → Exact Roof Pitch & Ridge Direction
- [ ] Map Solar API azimuth to Minecraft compass direction for ridge alignment
- [ ] Use actual pitch degrees for step height: half-slabs (low), full blocks (45°), double (steep)
- [ ] Use segment count for shape: 2 segments=gable, 4=hip, 1+flat=flat
- **Fields:** `solarRoofPitch`, `solarRoofSegments` (collected, partially used)
- **Ref:** `craftmatic_improvements.md` §3A

### 2.4 Smarty Roof Type → Roof Material Variety
- [x] `mapSmartyRoofTypeToBlocks()` — tile→brick, slate→deepslate, metal→copper, asphalt→blackstone
- [x] Wired into roof material chain: OSM > Smarty roofType > SV color
- **Files:** `src/gen/address-pipeline.ts`

### 2.5 Smarty Roof Frame → Roof Shape Fallback
- [x] Already wired: `inferRoofFromSmartyFrame()` in roof shape chain
- **Files:** `src/gen/address-pipeline.ts:464`

### 2.6 Procedural Accent Banding (from Arnis)
- [x] `wallAccentFrequency` added to StylePalette (0 = off, N = every N blocks)
- [x] `exteriorWalls()` checks frequency and alternates to `wallAccent` material
- [x] Enabled for modern (5), gothic (4), medieval (5), steampunk (5)
- **Files:** `src/gen/structures.ts`, `src/gen/styles.ts`

### 2.7 OSM Material → Wall Texture
- [x] `mapOSMMaterialToWall()` — brick→bricks, stone→stone_bricks, wood→oak_planks, etc.
- [x] Wired into wall chain: Smarty exterior > OSM material > construction type > SV
- **Files:** `src/gen/address-pipeline.ts`

### 2.8 Smarty Construction Type → Wall Selection
- [x] `mapConstructionTypeToWall()` — Masonry→bricks, Concrete→smooth_stone, Steel→iron_block
- [x] Lowest priority in wall chain (before SV, after OSM material)
- **Files:** `src/gen/address-pipeline.ts`

### 2.9 Year-Based Material Aging
- [x] `applyYearBasedWallAging()` — pre-1920: stone_bricks→cracked, post-2000: stone→polished_andesite
- [x] Force `chimney: true` for pre-1920 in `inferFeatures()`
- **Files:** `src/gen/address-pipeline.ts`

---

## Phase 3: Terrain & Environment

### 3.1 Foundation Type → Basement/Crawlspace
- [ ] Slab: standard floor level
- [ ] Crawlspace: raised 2-3 blocks with lattice/fence under house
- [ ] Basement: add underground floor with rooms
- [ ] Pier: raised on pillar blocks (coastal/flood zone)
- **Fields:** `foundation` (collected, unused)

### 3.2 Mapbox LiDAR → Stepped Foundations (from Arnis-inspired)
- [ ] Query elevation for property corners
- [ ] Calculate slope gradient → stepped retaining wall foundations
- [ ] Prevents floating foundations on sloped terrain
- **Ref:** `craftmatic_improvements.md` §3B

### 3.3 Urban Density Clustering (from Arnis)
- [ ] Calculate building centroid density in spatial grid
- [ ] High density → pavement/concrete ground; Low density → grass
- [ ] Creates realistic cityscapes vs suburban lawns
- **Ref:** Arnis `urban_ground.rs:UrbanGroundComputer`

### 3.4 Season-Aware Generation
- [ ] Pass `season` through to generation
- [ ] Winter: snow on roof, icicles; Fall: leaf variants
- **Fields:** `season` (computed, never passed)

### 3.5 Climate-Specific Materials
- [ ] Hot/dry → light blocks, terracotta, metal roof
- [ ] Cold/wet → dark wood, stone, steep roofs
- **Enhancement to:** feature inference + material selection

### 3.6 Assessed Value → Material Quality
- [ ] Low value: basic materials, minimal decoration
- [ ] High value: polished materials, ornate trim
- **Fields:** `assessedValue` (collected, unused)

### 3.7 Lot Context Awareness
- [ ] Small lot: tight setbacks, attached garage
- [ ] Large lot: long driveway, detached garage, gardens
- **Fields:** `lotSize` (partially used)

---

## Phase 4: Satellite Image Analysis

### 4.1 Building Footprint Shape Extraction
- [x] Roof color sample → binary threshold → flood fill → morph cleanup → OBB → shape
- [x] Green overlay on satellite canvas for visual feedback
- [~] OBB algorithm upgrade (PCA → minimum-area rectangle) — see Phase 0.2
- **Module:** `web/src/ui/import-satellite-footprint.ts`

### 4.2 Satellite Roof Color Segmentation
- [ ] Segment roof area from top-down satellite view
- [ ] Detect multi-section roofs (different materials on additions)

### 4.3 Deck/Patio Generation
- [ ] Implement raised wooden deck feature
- [ ] Driven by `hasDeck` from Smarty data
- **Fields:** `hasDeck` (collected, unused)

### 4.4 Multi-Building Site Detection
- [ ] Detect multiple structures from satellite (main house + garage + shed)
- [ ] Generate each separately, connect with paths

---

## Phase 5: Advanced Vision & ML (High Effort)

### 5.1 SV Tier 3 Deep Integration
- [ ] Wire `svArchitectureLabel`, `svFeatures` for architectural elements

### 5.2 Satellite Building Segmentation (ML)
- [ ] ML model for precise footprint/driveway/pool boundaries

### 5.3 Smarty Micro-Detailing (from Arnis-inspired)
- [ ] HVAC data → rooftop AC units (iron blocks + trapdoors)
- [ ] Heating type → fireplace/chimney confidence boost
- **Ref:** `craftmatic_improvements.md` §3C

---

## Data Source Coverage Matrix

| Parameter | Parcl | Smarty | OSM | Satellite | SV | Solar | Mapillary | Mapbox |
|---|---|---|---|---|---|---|---|---|
| Structure type | partial | - | tags | - | tier3 | - | - | **unused** |
| Floors/stories | stories | - | levels | - | tier2 | **unused** | - | **unused** |
| Style | year | arch | arch | - | tier3 | - | - | - |
| Width/Length | sqft | - | polygon | done | - | **unused** | - | - |
| Floor plan shape | - | - | polygon | done | tier2 | - | - | - |
| Wall material | - | exterior | **unused** | color | tier1+2 | - | - | - |
| Roof shape | - | **unused** | shape | - | tier2 | segments | - | - |
| Roof material | - | **unused** | material | - | tier1 | - | - | - |
| Roof pitch/height | - | - | - | - | tier2 | pitch | - | - |
| Door type | - | - | - | - | tier3 | - | - | - |
| Trim color | - | - | colour | - | tier1 | - | - | - |
| Window spacing | - | - | - | - | tier2 | - | - | - |
| Foundation | - | **unused** | - | - | - | - | - | - |
| Features | - | yes | - | pool | tier3 | - | yes | - |
| Orientation | - | - | - | rotation | heading | - | heading | - |
| Season | - | - | - | computed | - | - | - | - |
| Elevation | - | - | - | - | - | - | - | **unused** |

---

## Completed

### Satellite Footprint Extraction (Phase 4.1)
- [x] Color threshold + flood fill + morph cleanup + PCA OBB
- [x] Hue bucketing for robust color sampling (Gemini fix)
- [x] Grey roof pavement filter bypass (Gemini fix)
- [x] Adaptive color threshold from sample variance (Gemini fix)

### Prior Fixes
- [x] Castle type over-triggering → only explicit architecture tags
- [x] Floor count inflation → OSM levels priority + multi-unit correction
- [x] Property-type-aware style resolution
- [x] Comparison schem mismatch → LOCATIONS tier data only
