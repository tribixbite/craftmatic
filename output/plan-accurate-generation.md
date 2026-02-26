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
- [x] Implement `CoordinateBitmap` — bit-packed 2D occupancy grid (~200x vs Set)
- [x] `scanlineFill()` — even-odd rule rasterization of polygon vertices
- [x] `projectPolygonToBlocks()` — lat/lon polygon → integer block coords
- [x] `polygonToBitmap()` — full pipeline from OSM polygon to bitmap
- [x] `classifyBitmapShape()` — quadrant fill analysis for L/T/U detection
- [x] Post-generation bitmap mask in `generateHouse()` — carves away non-polygon blocks
- [x] Edge sealing: wall blocks at cut boundaries prevent exposed room internals
- [x] 22 unit tests covering all functions + edge cases
- **Ref:** Arnis `floodfill_cache.rs:CoordinateBitmap`, `scanline_fill`
- **Files:** `src/gen/coordinate-bitmap.ts`, `src/gen/gen-house.ts`, `test/coordinate-bitmap.test.ts`

### 1.2 Multipolygon & Courtyard Support (from Arnis)
- [x] Parse OSM `type=multipolygon` relations with `inner`/`outer` member roles
- [x] Subtract inner ring areas from total footprint calculation
- [x] `subtractInnerRings()` — remove inner ring blocks from bitmap
- [x] Wired `osmPolygon` + `osmInnerPolygons` through PropertyData → GenerationOptions
- [x] Mirrored in both CLI (`src/cli.ts`) and web (`web/src/ui/import.ts`)
- **Ref:** Arnis `buildings.rs:generate_buildings` hole processing
- **Files:** `src/gen/api/osm.ts`, `web/src/ui/import-osm.ts`, `src/cli.ts`, `web/src/ui/import.ts`

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
- [x] `rotateGridCW90()` post-generation rotation — transforms positions + facing + axis props
- [x] `orientation` field on GenerationOptions (0/90/180/270° CW from default front=south)
- [x] Pipeline snaps `streetViewHeading` (fallback `solarAzimuthDegrees`) to nearest 90°
- [x] 19 tests covering facing rotation, coordinate mapping, block entities, 360° identity
- **Commit:** 530bd27
- **Files:** `src/gen/gen-utils.ts`, `src/gen/generator.ts`, `src/gen/address-pipeline.ts`, `src/types/index.ts`

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
- [x] Added `solarAzimuthDegrees` to PropertyData, wired from CLI + web
- [x] Azimuth → ridge direction mapped via orientation rotation (Phase 1.6, 530bd27)
- [x] Solar segments → roof shape already wired in pipeline
- [x] Solar pitch → roof height already wired in pipeline
- **Fields:** `solarRoofPitch`, `solarRoofSegments`, `solarAzimuthDegrees`
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
- [x] Slab: standard foundation (default)
- [x] Crawlspace: oak fence lattice on perimeter at y=0
- [ ] Basement: add underground floor with rooms (requires grid y-offset)
- [x] Pier: pillar blocks at corners/midpoints, open perimeter
- [x] `foundationType` field added to FeatureFlags, wired from Smarty assessor
- **Files:** `src/gen/gen-house.ts`, `src/gen/structures.ts`, `src/types/index.ts`

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
- [x] Pass `season` through to GenerationOptions from PropertyData
- [x] Winter: snow_block roof cap override in generator
- [ ] Fall: leaf variants, spring: flower beds (future enhancement)
- **Files:** `src/gen/address-pipeline.ts`, `src/gen/generator.ts`, `src/types/index.ts`

### 3.5 Climate-Specific Materials
- [x] `applyClimateMaterials()` — hot climates lighten wall materials, cold darken
- [x] `inferClimateZone()` — state abbreviation → cold/hot/temperate classification
- [x] Wired into wall override chain: rawWall → yearAging → climate → value
- [ ] Expand climate material maps for more block types (currently 4 hot + 4 cold)
- **Files:** `src/gen/address-pipeline.ts`

### 3.6 Assessed Value → Material Quality
- [x] `applyValueTierMaterials()` — high value ($800K+) → polished variants, low (<$150K) → basic
- [x] Wired after climate materials in wall override chain
- [ ] Expand value-tier material maps beyond 4 entries each
- **Files:** `src/gen/address-pipeline.ts`

### 3.7 Lot Context Awareness
- [x] Small lot (<2500 sqft): skip trees, garden, backyard features
- [x] Large lot (>10000 sqft): force trees, garden, backyard, fence
- [ ] Setback distance adjustment based on lot size
- [ ] Attached vs detached garage based on lot width
- **Files:** `src/gen/address-pipeline.ts` (`inferFeatures()`)

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
- [x] Implemented `placeDeck()` — spruce plank deck with fence railing at back of house
- [x] Wired `hasDeck` from Smarty assessor → `features.deck` in pipeline
- **Files:** `src/gen/structures.ts`, `src/gen/gen-house.ts`, `src/gen/address-pipeline.ts`

### 4.4 Multi-Building Site Detection
- [ ] Detect multiple structures from satellite (main house + garage + shed)
- [ ] Generate each separately, connect with paths

---

## Phase 5: Advanced Data Sources & ML

> Full research: `output/plan-phase5-research.md` (40+ sources evaluated, 30 prioritized)

### 5.0 P0 — Implemented
- [x] NLCD tree canopy % (MRLC WMS GetFeatureInfo, 30m resolution, `import-nlcd.ts`)
- [x] USDA Plant Hardiness Zone (phzmapi.org/{zip}.json → tree species palette, `import-hardiness.ts`)
- [x] OSM Overpass `natural=tree` (species, height, leaf_type, round-robin, `import-osm-trees.ts`)
- [x] Overture Maps building data (PMTiles HTTP Range Requests, height/floors/roof/facade, `import-overture.ts`)
- [x] Overture floors/height wired into story estimation pipeline (after OSM levels)
- [x] Overture roof_shape added to roof shape priority chain
- [x] Hardiness zone enhances `inferClimateZone()` (zones 1-4=cold, 9+=hot)
- [x] All 4 sources have toggles, tests, JSON import/export

### 5.0 P0 — Deferred to P1 (with rationale)
- [ ] Cesium OSM Buildings — **redundant** with Overture (same upstream OSM data)
- [ ] CLIP zero-shot — too heavy for browser (~150MB model), move to serverless
- [ ] Depth Anything V3 — provides **relative** depth only, not metric height

### 5.1 P1 — Implemented
- [x] Meta/WRI 1m global canopy height via S3 COG + geotiff.js (`import-canopy-height.ts`)
- [x] ESA WorldCover 10m land cover via S3 COG + geotiff.js (`import-landcover.ts`)
- [x] OSM Overpass water features — rivers, lakes, reservoirs (`import-water.ts`)
- [x] Smarty untapped fields wired: garageSqft, fireplaceCount, totalRooms, HVAC types, totalMarketValue
- [x] heatingFuelType gas/oil/propane/wood → chimney=true in generation pipeline
- [x] Canopy height fix: EPSG:3857 Web Mercator projection for pixel lookup
- [x] All P1 sources have toggles, tests (3 each), JSON import/export

### 5.1 P1 — Remaining
- [ ] SegFormer CMP Facade parsing (12-class: window/door/balcony/pillar, browser ONNX)
- [ ] Google Solar DSM tree extraction (non-building height pixels)
- [ ] Multi-angle SV analysis (3-4 headings per building)

### 5.2 P2 — Medium Impact
- [ ] Grounding DINO window/door counting (server-side text-prompted detection)
- [ ] YOLOv8 satellite building segmentation (replace canvas-based footprint extraction)
- [ ] VGGT/MASt3R multi-view 3D reconstruction (server-side, 2-4 SV images → point cloud)
- [ ] GlobalBuildingAtlas height data (2.75B buildings, 97% with heights)
- [ ] Regrid parcel polygons (lot boundaries for yard/setback generation)
- [ ] City tree inventories via Socrata (NYC 666K, SF, Chicago, Portland)
- [ ] OpenFACADES VLM for comprehensive attribute extraction (server-side, InternVL3)

### 5.3 P3 — Research Stage
- [ ] RoofNet multimodal roof classification (satellite + text, paper 2505.19358)
- [ ] Mask-to-Height joint footprint + height (YOLOv11, paper 2510.27224)
- [ ] Pix2Poly vector polygon footprints (transformer, paper 2412.07899)
- [ ] Texture2LoD3 facade→CityGML (paper 2504.05249)
- [ ] SfM/photogrammetry from multi-angle SV (COLMAP/OpenSfM, server GPU)
- [ ] HVAC data → rooftop AC units (iron blocks + trapdoors)
- [ ] Heating type → fireplace/chimney confidence boost
- **Ref:** `output/plan-phase5-research.md`, `craftmatic_improvements.md` §3C

---

## Data Source Coverage Matrix

| Parameter | Parcl | Smarty | OSM | Satellite | SV | Solar | Mapillary | Mapbox | **Overture** | **ML/Browser** | **Vegetation** |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Structure type | partial | - | tags | - | tier3 | - | - | done | tags | CLIP | - |
| Floors/stories | stories | - | levels | - | tier2 | done | - | done | `num_floors` | DA3 depth | - |
| Style | year | arch | arch | - | tier3 | - | - | - | - | CLIP | - |
| Width/Length | sqft | - | polygon | done | - | done | - | - | polygon | YOLOv8 | - |
| Floor plan shape | - | - | polygon | done | tier2 | - | - | - | polygon | - | - |
| Wall material | - | exterior | done | color | tier1+2 | - | - | - | - | CLIP/SegFormer | - |
| Roof shape | - | done | shape | - | tier2 | segments | - | - | `roof_shape` | CLIP | - |
| Roof material | - | done | material | - | tier1 | - | - | - | - | CLIP | - |
| Roof pitch/height | - | - | - | - | tier2 | pitch | - | - | `roof_height` | DA3 depth | - |
| Door type | - | - | - | - | tier3 | - | - | - | - | SegFormer | - |
| Trim color | - | - | colour | - | tier1 | - | - | - | - | - | - |
| Window spacing | - | - | - | - | done | - | - | - | - | SegFormer/GDINO | - |
| Foundation | - | done | - | - | - | - | - | - | - | - | - |
| Features | - | yes | - | pool | tier3 | - | yes | - | - | - | - |
| Orientation | - | - | - | rotation | done | done | heading | - | - | - | - |
| Season | - | - | - | computed | - | - | - | - | - | - | - |
| Elevation | - | - | - | - | - | - | - | done | - | - | Terrarium |
| Tree density | - | - | - | - | - | DSM | - | - | - | deepforest | **NLCD** |
| Tree species | - | - | `natural=tree` | - | - | - | - | - | - | - | **Hardiness** |
| Tree height | - | - | height tag | - | - | DSM | - | - | - | - | **Meta 1m** |
| Ground cover | - | - | surface | - | - | - | - | - | - | - | **WorldCover** |
| Water features | - | - | waterway | - | - | - | - | - | - | - | **NHD** |
| Lot boundary | - | lotSize | - | - | - | - | - | - | - | - | Regrid |

---

## Completed

### Satellite Footprint Extraction (Phase 4.1)
- [x] Color threshold + flood fill + morph cleanup + PCA OBB
- [x] Hue bucketing for robust color sampling (Gemini fix)
- [x] Grey roof pavement filter bypass (Gemini fix)
- [x] Adaptive color threshold from sample variance (Gemini fix)

### Phase 3+4: Foundation, Season, Deck
- [x] Foundation types: crawlspace (fence lattice), pier (pillar posts), slab (default)
- [x] Season wiring: PropertyData → GenerationOptions, snow → snow_block roof cap
- [x] Deck generation: `placeDeck()` spruce plank deck with fence railing
- [x] `foundationType` and `deck` added to FeatureFlags, wired from Smarty assessor

### Prior Fixes
- [x] Castle type over-triggering → only explicit architecture tags
- [x] Floor count inflation → OSM levels priority + multi-unit correction
- [x] Property-type-aware style resolution
- [x] Comparison schem mismatch → LOCATIONS tier data only
