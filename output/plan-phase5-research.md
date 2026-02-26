# Phase 5: Advanced Data Sources & ML Integration — Research Report

> Compiled 2026-02-26 from 4 parallel research agents covering HuggingFace models, 3D building APIs, tree/vegetation data, and facade parsing ML.

## Executive Summary

Craftmatic currently ingests data from 9+ APIs (OSM, Smarty, Parcl, Google SV/Solar, Mapbox, Mapillary, satellite imagery, AWS Terrarium). This research identifies **40+ additional data sources and ML models** that could improve generation accuracy across 6 categories:

| Category | Top Finding | Impact |
|----------|------------|--------|
| Building footprints | **Overture Maps** (2.3B buildings, free, structured) | Replaces/supplements Overpass |
| Building 3D data | **Cesium OSM Buildings** (350M, per-building metadata) | Structured height/material/roof per building |
| Facade analysis | **CLIP zero-shot** + **SegFormer CMP Facade** | Browser-side style/material/window detection |
| Depth/height | **Depth Anything V3** (metric depth, ONNX) | Building height from single SV image |
| Tree/vegetation | **NLCD canopy %** + **Meta 1m canopy height** | Tree density and height for any US coord |
| Landscape | **USDA Hardiness Zone** + **OSM `natural=tree`** | Species palette + individual tree positions |

---

## Priority Tiers

### P0 — High Impact, Low-Medium Effort (integrate next)

#### 1. Overture Maps Foundation
- **What**: 2.3B building footprints merged from OSM + Microsoft ML + Google + Esri
- **Fields**: `height`, `num_floors`, `roof_shape`, `roof_direction`, footprint polygon, provenance
- **Access**: DuckDB against GeoParquet on S3 (free, no auth)
- **Integration**: Lightweight server proxy or Cloudflare Worker accepting lat/lon → DuckDB spatial query
- **Value**: Fills gaps where OSM has no building; provides `roof_shape`, `num_floors` often missing from Overpass
- **Maps to**: `osmWidth/Length`, `osmLevels`, `osmRoofShape`, `osmPolygon`

#### 2. Cesium OSM Buildings (asset 96188)
- **What**: 350M+ buildings as 3D Tiles with per-building batch table metadata
- **Fields**: `height`, `building:levels`, `building:material`, `building:colour`, `roof:shape`, 20k+ property types
- **Access**: Free community tier via `3d-tiles-renderer` (already a dependency)
- **Integration**: Raycast at target lat/lon → read batch table → extract metadata
- **Value**: Structured per-building data faster than Overpass, pre-tiled for efficient spatial lookup

#### 3. NLCD Tree Canopy Cover
- **What**: Tree canopy percentage (0–99%) for any US coordinate
- **Access**: Single GET to USFS ArcGIS ImageServer — no auth, public domain
- **Endpoint**: `apps.fs.usda.gov/.../USFS_Analytical_2016_TreeCanopy_CONUS/ImageServer/identify?geometry={lon},{lat}&geometryType=esriGeometryPoint&sr=4326&f=json`
- **Resolution**: 30m per pixel
- **Maps to**: Tree density around building (20%=sparse, 60%=moderate, 90%=dense)

#### 4. OSM Overpass `natural=tree` Extension
- **What**: Individual tree positions with optional species, height, leaf_type, leaf_cycle
- **Access**: Already have Overpass round-robin — just extend the query
- **Tags**: `natural=tree`, `genus`, `species`, `height`, `circumference`, `leaf_type`
- **Maps to**: Individual tree placement positions, species → Minecraft tree type

#### 5. USDA Plant Hardiness Zone
- **What**: Climate zone by ZIP → determines which trees grow at a location
- **Access**: `https://phzmapi.org/{zipcode}.json` — free static JSON
- **Maps to**: Tree species palette selection (Zone 3=spruce/birch, Zone 7=oak/maple, Zone 10=palm/jungle)

#### 6. CLIP Zero-Shot Classification (Browser)
- **Model**: `openai/clip-vit-base-patch32` → ONNX via `Xenova/clip-vit-base-patch32`
- **Downloads**: 18.3M | License: MIT
- **Use cases**: Architectural style, wall material, roof type — all via text prompts, no training
- **Browser**: Proven via Transformers.js + ONNX
- **Prompts**: "Victorian building", "brick facade", "gable roof", etc.
- **Expected accuracy**: 60–75% style, 50–70% material (supplement, don't replace, existing pipeline)

#### 7. Depth Anything V3 Metric (Browser)
- **Model**: `depth-anything/DA3METRIC-LARGE` (Apache 2.0, 517K downloads)
- **ONNX**: `onnx-community/depth-anything-v3-small` (browser), `-base`, `-large`
- **Output**: Metric depth map in actual meters from single RGB image
- **Use**: SV image → metric depth → building height → floor count
- **Algorithm**: depth at roof edge − depth at ground plane → height in meters ÷ 3.5m = floors

### P1 — High Impact, Moderate Effort

#### 8. Meta/WRI 1m Global Canopy Height
- **What**: Pixel value = tree height in meters, 1m resolution, global
- **Access**: AWS S3 COG tiles (free, CC BY 4.0, no auth)
- **S3**: `s3://dataforgood-fb-data/forests/v1/alsgedi_global_v6_float/chm/`
- **Maps to**: Individual tree heights → Minecraft block heights (1 block ≈ 1m)

#### 9. ESA WorldCover (Global Land Cover)
- **What**: 10m resolution, 11 land cover classes including "Tree cover"
- **Access**: AWS S3 COG tiles (free, CC BY 4.0)
- **Value**: Global coverage — works for non-US addresses (unlike NLCD)
- **Maps to**: Ground cover type (grass/dirt/sand), tree density, water features

#### 10. SegFormer CMP Facade Parsing
- **Model**: `Xpitfire/segformer-finetuned-segments-cmp-facade` (MIT, SegFormer-B0)
- **Classes**: 12 — facade, molding, cornice, pillar, window, door, sill, blind, balcony, shop, deco, background
- **Browser**: ~3.7M params, ONNX-convertible, Transformers.js ready
- **Use**: Count windows per floor, detect doors, identify architectural elements
- **Maps to**: `svWindowsPerFloor`, door type, symmetry, balcony presence

#### 11. Google Solar DSM Tree Extraction
- **What**: Already integrated Solar API returns DSM that includes tree canopy
- **Enhancement**: Parse DSM raster for non-building height pixels = trees around building
- **Maps to**: Tree positions + heights in immediate building vicinity

#### 12. Smarty Untapped Fields
- **What**: Existing Smarty integration has unused fields
- **Fields to add**: heating/cooling type (chimney), parking spaces (garage size), window type, year remodeled, number of units
- **Effort**: Very low — already have API call, just map more response fields

#### 13. NHD Water Features
- **What**: Comprehensive US streams, rivers, lakes, ponds
- **Access**: ArcGIS REST `identify` at `hydro.nationalmap.gov` — free, no auth
- **Maps to**: Nearby water feature placement, waterfront property detection

#### 14. Multi-Angle SV Analysis
- **What**: Fetch 3–4 SV images at different headings for same building
- **Access**: Existing Google SV API key
- **Value**: Front + side facades for more complete color extraction, structure analysis
- **Maps to**: Side wall material, chimney visibility, window pattern on non-primary facade

### P2 — Medium Impact or Higher Effort

#### 15. Grounding DINO (Server-Side Window/Door Detection)
- **Model**: `IDEA-Research/grounding-dino-tiny` (Apache 2.0, 463K downloads)
- **Use**: Text-prompted "window" / "door" → bounding boxes with counts
- **Size**: ~172M params — heavy for browser, better as server-side fallback
- **Maps to**: `svWindowsPerFloor` (precise count), door style, garage door detection

#### 16. YOLOv8 Building Segmentation (Browser)
- **Model**: `keremberke/yolov8m-building-segmentation`
- **Use**: Replace canvas-based satellite footprint extraction with ML model
- **Browser**: ONNX/TFJS convertible
- **Maps to**: `satFootprintWidth/Length/Confidence` (more accurate than current threshold + flood fill)

#### 17. VGGT / MASt3R Multi-View 3D
- **Model**: `facebook/VGGT-1B` (317K downloads, CVPR 2025) or `naver/MASt3R`
- **Use**: 2–4 SV images → 3D point cloud of building
- **Output**: Actual building geometry (dimensions, roof shape, facade depth)
- **Requires**: Server-side GPU inference
- **Maps to**: All dimension fields, roof pitch, facade depth profile

#### 18. GlobalBuildingAtlas
- **What**: 2.75B buildings globally with height estimates (97% coverage)
- **Access**: Bulk download from mediaTUM, 5×5° tiles
- **Value**: Most complete global height dataset (RMSE 1.5–8.9m)
- **Maps to**: `overtureHeight`, story estimation

#### 19. Regrid Parcel Data
- **What**: Parcel boundary polygons (lot boundaries, zoning, land use)
- **Access**: REST API with free tier
- **Value**: Only source for lot boundaries → yard/setback generation
- **Maps to**: `parcelPolygon`, `lotSize`, `zoning`

#### 20. NYC/City Tree Inventories (Socrata)
- **What**: Exact tree species + DBH + GPS for supported cities
- **Cities**: NYC (666K), SF, Chicago, Portland, LA
- **Access**: Socrata SODA API — free, `within_circle(lat,lon,radius)` filter
- **Maps to**: Individual tree placement with real species

#### 21. OpenFACADES VLM (Server-Side)
- **Model**: `seshing/openfacades-internvl3-2b` (InternVL3 fine-tuned, Apache 2.0)
- **Use**: Comprehensive building attribute extraction from SV panoramas
- **Output**: Style, materials, stories, age — free-text descriptions
- **Requires**: Server-side GPU (2B params)
- **Maps to**: Style, wall material, roof material, stories, architectural elements

### P3 — Research Stage / High Effort

#### 22. RoofNet (Multimodal Roof Classification)
- Paper: 2505.19358 (2025) — satellite + text for roof material + shape + solar panels + HVAC
- Not yet released as model on HF

#### 23. Mask-to-Height (YOLOv11 Joint Segmentation + Height)
- Paper: 2510.27224 — single model for footprint + height from satellite
- Dataset: `MElHuseyni/building_height_estimation`

#### 24. Pix2Poly (Vector Polygon Footprints)
- Paper: 2412.07899 — transformer outputs polygon vertices directly (no raster→vector)

#### 25. Texture2LoD3 (Full Facade→CityGML Pipeline)
- Paper: 2504.05249 — panoramic image → facade segmentation → LoD3 geometry

#### 26. CityDreamer (Contextual City Generation)
- Model: `hzxie/city-dreamer` — OSM layout → unbounded 3D city (NeRF)

#### 27. Point2Building (LiDAR → 3D Mesh)
- Paper: 2403.02136 — autoregressive LiDAR point cloud → polygonal building mesh

#### 28. SfM/Photogrammetry Pipeline
- COLMAP/OpenSfM/Meshroom from multi-angle SV images
- Requires server-side GPU, minutes per building

#### 29. deepforest-tree (HF Model)
- Model: `weecology/deepforest-tree` (79.9K downloads, MIT)
- Individual tree crown detection from aerial imagery + species classification

#### 30. USGS 3DEP LiDAR
- 90%+ CONUS coverage, vegetation class codes (3/4/5) give exact tree positions + heights
- Requires LAS point cloud processing

---

## Species-to-Minecraft Mapping

| Hardiness Zone | Common Trees | Minecraft Type |
|---------------|-------------|----------------|
| 2–3 (very cold) | White Spruce, Paper Birch, Balsam Fir | Spruce, Birch |
| 4–5 (cold) | Sugar Maple, Red Oak, White Pine | Oak, Birch, Spruce |
| 6–7 (moderate) | Red Maple, Pin Oak, Dogwood | Oak, Birch |
| 8–9 (warm) | Live Oak, Magnolia, Crape Myrtle | Oak, Dark Oak, Jungle |
| 10+ (tropical) | Royal Palm, Coconut, Banyan | Jungle, Acacia |
| Desert/arid | Palo Verde, Joshua Tree, Mesquite | Acacia, Dead Bush |

| OSM genus | Minecraft |
|-----------|-----------|
| Quercus (Oak) | Oak |
| Acer (Maple) | Oak |
| Betula (Birch) | Birch |
| Picea/Abies (Spruce/Fir) | Spruce |
| Pinus (Pine) | Spruce (2×2) |
| Prunus (Cherry) | Cherry Blossom |
| Palm/Washingtonia | Jungle (single trunk) |

---

## Browser-Ready ML Models

| Model | Task | ONNX Repo | Size | License |
|-------|------|-----------|------|---------|
| CLIP ViT-B/32 | Zero-shot classify | Xenova/clip-vit-base-patch32 | ~338MB | MIT |
| Depth Anything V3 Small | Metric depth | onnx-community/depth-anything-v3-small | ~98MB | Apache-2.0 |
| SegFormer-B0 ADE20K | Scene segmentation | Xenova/segformer-b0-finetuned-ade-512-512 | ~15MB | NVIDIA |
| SegFormer-B0 CMP Facade | Facade parsing | (convert from Xpitfire/) | ~15MB | MIT |
| YOLOv8n Building Seg | Satellite footprint | (convert from keremberke/) | ~25MB | — |
| ViT Roof Classifier | Roof type | (convert from Prahas10/) | ~330MB | Apache-2.0 |

---

## Recommended Integration Architecture

```
Address/Coordinates
    │
    ├─► [Overture Maps proxy]─────► height, floors, roof_shape, footprint polygon
    │
    ├─► [Existing Overpass]───────► building tags, `natural=tree` nodes
    │
    ├─► [NLCD Canopy %]──────────► tree density (0-99%)
    │
    ├─► [Hardiness Zone]──────────► tree species palette
    │
    ├─► [Meta Canopy Height]──────► individual tree heights (meters)
    │
    ├─► [Google Solar DSM]────────► tree positions around building
    │
    ├─► [NHD Water]───────────────► nearby water features
    │
    ├─► [ESA WorldCover]──────────► ground cover type (global fallback)
    │
    ├─► [Depth Anything V3]───────► building height from SV image (browser)
    │
    ├─► [CLIP zero-shot]──────────► style + material classification (browser)
    │
    └─► [SegFormer facade]────────► window count, door position (browser)
         │
         ▼
    PropertyData → GenerationOptions → Minecraft World
```

---

## What NOT to Pursue

| Source | Reason |
|--------|--------|
| Google Open Buildings | Global South only; already merged into Overture |
| KartaView | Less coverage than Mapillary, no building detections |
| Mapillary window/door detection | Vistas classes exist but NOT exposed via API |
| Browser-side photogrammetry | Requires GPU + minutes of processing |
| CGLS NDVI 300m | Too coarse for parcel-level decisions |
| HERE 3D buildings | Minimal incremental value over Mapbox + OSM |
| BatchData property API | Low incremental value over Smarty + Parcl |

---

## New PropertyData Fields (Proposed)

```typescript
// From Overture Maps / Cesium
overtureHeight?: number;
undergroundFloors?: number;
roofHeight?: number;        // height above wall plate
roofDirection?: number;     // degrees
footprintSource?: { dataset: string; confidence: number };

// From Regrid
parcelPolygon?: { lat: number; lon: number }[];
zoning?: string;

// From enhanced Smarty
effectiveYearBuilt?: number;
heatingType?: string;
parkingSpaces?: number;
windowType?: string;

// From ML models (browser-side)
clipStyle?: string;         // CLIP zero-shot style label
clipMaterial?: string;      // CLIP zero-shot wall material
depthBuildingHeight?: number; // Depth Anything metric height
facadeWindowCount?: number; // SegFormer window detection count
facadeElements?: string[];  // detected architectural elements

// From vegetation APIs
canopyCoverPct?: number;    // NLCD 0-99%
hardinessZone?: string;     // e.g. "7b"
nearbyTrees?: { lat: number; lon: number; species?: string; height?: number }[];
landCoverClass?: string;    // ESA WorldCover class
nearbyWater?: { type: string; distance: number }[];
```

---

## Detailed Sub-Reports

- `output/ml-building-research.md` — HuggingFace models for 3D reconstruction, depth, footprints
- `output/ml-models-research.md` — Facade parsing, style/material classification, roof type ML
- `output/research-tree-vegetation-apis.md` — Tree canopy, forestry, vegetation, landscape APIs
- `output/research-3d-building-apis.md` — 3D building tiles, footprints, attribute APIs, SfM
