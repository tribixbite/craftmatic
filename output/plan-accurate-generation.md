# Craftmatic: Accurate Generation Roadmap

## Overview

The generation pipeline collects data from 9+ APIs but only uses ~60% of it. This roadmap tracks enhancements to improve structure accuracy and quality by wiring unused data into generation decisions and adding new analysis capabilities.

## Status Legend

- [ ] Not started
- [~] In progress
- [x] Complete

---

## Phase 1: Wire Unused Collected Data (Low Effort, High Impact)

### 1.1 OSM Material → Wall Texture
- [ ] Use `osmMaterial` (brick, stone, wood, concrete) in `convertToGenerationOptions()`
- [ ] Map to specific Minecraft block states (brick_block, cobblestone, oak_planks, etc.)
- [ ] Priority: after Smarty exterior, before satellite color
- **Fields:** `osmMaterial` (collected in `import-osm.ts`, unused in `import-convert.ts`)

### 1.2 Smarty Roof Type → Roof Material Variety
- [ ] Use `roofType` (tile, slate, metal, asphalt, shake) for roof block palette
- [ ] Map: tile→terracotta, slate→deepslate_tiles, metal→iron_block, asphalt→gray_concrete
- [ ] Currently all roofs in a style use same material regardless of actual roof
- **Fields:** `roofType` (collected in `import-smarty.ts`, unused)

### 1.3 Smarty Roof Frame → Roof Shape Fallback
- [ ] Use `roofFrame` (Gable, Hip, Flat, Gambrel, Mansard) as fallback when OSM missing
- [ ] Insert into priority chain: OSM > Smarty roofFrame > Solar segments > style default
- **Fields:** `roofFrame` (collected in `import-smarty.ts`, unused)

### 1.4 Smarty Construction Type → Wall Selection
- [ ] Use `constructionType` (Frame, Masonry, Concrete, Steel) to influence material
- [ ] Frame→wood planks, Masonry→brick/stone, Concrete→concrete, Steel→iron
- [ ] Priority: below Smarty exterior type, above satellite color
- **Fields:** `constructionType` (collected in `import-smarty.ts`, unused)

### 1.5 Foundation Type → Basement/Crawlspace
- [ ] Use `foundation` (Slab, Crawl Space, Basement, Pier) to affect generation
- [ ] Slab: no basement, standard floor level
- [ ] Crawlspace: raised 2-3 blocks with lattice/fence under house
- [ ] Basement: add underground floor with rooms (storage, laundry, study)
- [ ] Pier: raised on pillar blocks (coastal/flood zone)
- **Fields:** `foundation` (collected in `import-smarty.ts`, unused)

### 1.6 Solar Building Area → Floor Estimation
- [ ] Use `solarBuildingArea` to refine `estimateStoriesFromFootprint()`
- [ ] When OSM footprint missing, solar area / sqft gives better story count
- **Fields:** `solarBuildingArea`, `solarRoofArea` (collected in `import-solar.ts`, unused)

### 1.7 Mapbox Height → Story Fallback
- [ ] Use `mapboxHeight` (meters) as fallback for OSM levels
- [ ] Convert: height / 3.0 = approximate stories
- **Fields:** `mapboxHeight` (collected in `import-mapbox.ts`, unused)

### 1.8 Mapbox Building Type → Structure Type
- [ ] Use `mapboxBuildingType` (house, apartments, commercial, industrial)
- [ ] Apartments → force multi-unit dimensions + flat roof
- [ ] Commercial → marketplace type
- **Fields:** `mapboxBuildingType` (collected in `import-mapbox.ts`, unused)

---

## Phase 2: Satellite Image Analysis (Medium Effort, High Impact)

### 2.1 Building Footprint Shape Extraction
- [~] Analyze satellite tiles to extract actual building footprint polygon
- [ ] Segment building from surrounding terrain using color/edge detection
- [ ] Detect L-shape, T-shape, U-shape, irregular polygons
- [ ] Extract footprint dimensions (width × length) from bounding box
- [ ] Feed into `floorPlanShape` with higher confidence than OSM polygon analysis
- [ ] Extract building orientation (rotation angle) from longest axis
- **New module:** `web/src/ui/import-satellite-footprint.ts`
- **Approach:** Canvas-based image processing — threshold roof color, morphological cleanup, contour detection, minimum bounding rectangle

### 2.2 Satellite Roof Color Segmentation
- [ ] Segment roof area from satellite tile (top-down view)
- [ ] Extract dominant roof color more accurately than side-view SV
- [ ] Detect multi-section roofs (different materials on additions)
- **Enhancement to:** `import-satellite.ts`

### 2.3 Street View Facade Orientation
- [ ] Use `streetViewHeading` (0-360°) to orient front door toward street
- [ ] Currently front door placement is arbitrary within footprint
- [ ] Map heading to cardinal direction for block placement
- **Fields:** `streetViewHeading` (collected, unused in generation)

### 2.4 Deck/Patio Generation
- [ ] Implement deck room type or exterior feature
- [ ] Raised wooden deck on rear or side of house
- [ ] Driven by `hasDeck` from Smarty assessor data
- **Fields:** `hasDeck` (collected in `import-smarty.ts`, unused; feature generator missing)

---

## Phase 3: Environmental & Context (Lower Priority)

### 3.1 Season-Aware Generation
- [ ] Pass `season` field through to generation options
- [ ] Winter: snow layer on roof blocks, icicle decorations, frosted windows
- [ ] Summer: flower pots, open shutters, bright palette
- [ ] Fall: leaf variations, harvest decorations
- **Fields:** `season` (computed in satellite module, never passed to generation)

### 3.2 Assessed Value → Material Quality
- [ ] Use `assessedValue` from Smarty to influence material tier
- [ ] Low value: basic wood/cobblestone, minimal decoration
- [ ] High value: polished materials, more ornate trim, larger windows
- **Fields:** `assessedValue` (collected in `import-smarty.ts`, unused)

### 3.3 Climate-Specific Materials
- [ ] Infer climate zone from lat/state
- [ ] Hot/dry → light blocks, terracotta, sandstone, metal roof
- [ ] Cold/wet → dark wood, stone, steep roofs, chimneys
- [ ] Tropical → raised foundation, wide overhangs, light materials
- **Enhancement to:** feature inference + material selection

### 3.4 Lot Context Awareness
- [ ] Use `lotSize` more aggressively for spatial layout
- [ ] Small lot (<3000sqft): tight setbacks, no side yard, attached garage
- [ ] Large lot (>10000sqft): long driveway, detached garage, gardens
- [ ] Drive companion structure placement distances
- **Fields:** `lotSize` (partially used for feature flags, not layout)

---

## Phase 4: Advanced Vision & ML (High Effort)

### 4.1 SV Tier 3 Deep Integration
- [ ] Wire `svArchitectureLabel` into style resolution with higher priority
- [ ] Use `svFeatures` for specific architectural elements (bay windows, turrets, dormers)
- [ ] Extract window count/pattern for authentic fenestration
- **Requires:** Vision model integration (optional dependency)

### 4.2 Satellite Building Segmentation (ML)
- [ ] Use ML model to precisely segment building footprint from satellite
- [ ] Detect building vs driveway vs pool vs vegetation boundaries
- [ ] Generate accurate site plan from segmentation mask
- **Requires:** ONNX runtime or external ML service

### 4.3 Multi-Building Site Detection
- [ ] Detect multiple structures on lot from satellite (main house + garage + shed)
- [ ] Generate each structure separately with appropriate type
- [ ] Connect with paths matching satellite-visible walkways
- **Requires:** Building segmentation (4.2)

---

## Data Source Coverage Matrix

| Generation Parameter | Parcl | Smarty | OSM | Satellite | SV | Solar | Mapillary | Mapbox |
|---|---|---|---|---|---|---|---|---|
| Structure type | partial | - | tags | - | tier3 | - | - | **unused** |
| Floors/stories | stories | - | levels | - | tier2 | **unused** | - | **unused** |
| Style | year | arch | arch | - | tier3 | - | - | - |
| Width/Length | sqft | - | polygon | **TODO** | - | **unused** | - | - |
| Floor plan shape | - | - | polygon | **TODO** | tier2 | - | - | - |
| Wall material | - | exterior | **unused** | color | tier1+2 | - | - | - |
| Roof shape | - | **unused** | shape | - | tier2 | segments | - | - |
| Roof material | - | **unused** | material | - | tier1 | - | - | - |
| Roof pitch/height | - | - | - | - | tier2 | pitch | - | - |
| Door type | - | - | - | - | tier3 | - | - | - |
| Trim color | - | - | colour | - | tier1 | - | - | - |
| Window spacing | - | - | - | - | tier2 | - | - | - |
| Foundation | - | **unused** | - | - | - | - | - | - |
| Features (pool etc) | - | yes | - | pool | tier3 | - | yes | - |
| Orientation | - | - | - | **TODO** | heading | - | heading | - |
| Season | - | - | - | computed | - | - | - | - |

**Bold unused** = data collected but not wired into generation
**TODO** = enhancement planned in this roadmap

---

## Previously Completed Fixes

### Castle Type Over-Triggering (FIXED)
- [x] Removed `sqft > 5000 → castle` rule
- [x] Castle only triggers for explicit architecture tags (castle, chateau, fortress, keep)
- [x] Large buildings generate as houses with appropriate scale

### Floor Count Inflation (FIXED)
- [x] OSM `building:levels` takes priority over sqft-derived estimate
- [x] Multi-unit correction divides Parcl total sqft by estimated unit count
- [x] Added `estimateStoriesFromFootprint()` with 80% efficiency factor

### Property-Type-Aware Style Resolution (FIXED)
- [x] Added propertyType as style signal before county/year fallback
- [x] Multi-family → modern/desert, Townhouse → gothic/modern by era

### Comparison Schem Mismatch (FIXED)
- [x] `generateForTier()` now always uses LOCATIONS tier data
- [x] Removed comparison-data.json genOptions path that caused style mismatch
