# Pipeline Research: Real-World-Accurate 3D Voxel Building Generation

## Date: 2025-02-25
## Status: Research Complete

---

## 1. Executive Summary

Craftmatic currently maps 9 API data sources through 10 hardcoded fantasy-style presets (medieval, gothic, colonial, etc.) selected by yearBuilt ranges. This approach is fundamentally wrong for real-world accuracy. This document synthesizes research from recent papers (2024-2025), available APIs/datasets, open-source tools, and architectural analysis from Gemini 2.5 Pro to define the ideal pipeline for generating voxel buildings that actually resemble their real-world counterparts.

The core recommendation is a **tiered pipeline** that replaces style presets with data-driven geometry and materials:

- **Tier 0** (instant, free): Footprint extrusion from Overture/OSM/GlobalBuildingAtlas with height data
- **Tier 1** (seconds, existing APIs): Facade parsing + procedural detailing from Street View imagery
- **Tier 2** (seconds, existing APIs): Precise roof geometry from Solar API / LiDAR
- **Tier 3** (minutes, server-side): Full photogrammetric reconstruction from multi-view imagery

---

## 2. State of the Art in Automatic 3D Building Reconstruction

### 2.1 Levels of Detail (LOD) Framework

The CityGML standard defines building detail levels that map well to our pipeline tiers:

| Level | Description | Equivalent |
|-------|-------------|------------|
| LOD0 | 2D footprint | Our current OSM polygon |
| LOD1 | Flat-roofed block extrusion | Tier 0 target |
| LOD2 | Detailed roof shapes + facade textures | Tier 1-2 target |
| LOD3 | Windows, doors, architectural details | Tier 1-2 target |
| LOD4 | Interior rooms, furniture | Existing room generation |

### 2.2 Key Papers and Methods (2024-2025)

**Gaussian Building Mesh (GBM) - January 2025**
- Paper: https://arxiv.org/abs/2501.00625
- Pipeline: Google Earth Studio orbit capture -> SAM2 + GroundingDINO segmentation -> 2D Gaussian Splatting -> textured mesh extraction
- Achieves per-building 3D mesh from address alone
- Moving masking before GS training gives 5x speedup
- Limitation: Requires Google Earth Studio (not API-accessible), GPU-intensive training

**Voxel Depth-Constrained LOD2 Modeling - 2025**
- Paper: https://link.springer.com/article/10.1007/s44212-025-00090-y
- Novel voxel depth-constrained LOD2 modeling based on City3D pipeline
- Directly relevant to our voxel output format

**CM2LoD3: Reconstructing LoD3 Building Models - 2025**
- Paper: https://arxiv.org/html/2508.15672
- Uses semantic conflict maps to reconstruct LOD3 models with windows, doors, balconies
- Combines multiple data sources for facade element placement

**Digital Twin Buildings Framework - February 2025**
- Paper: https://arxiv.org/html/2502.05769v2
- Multi-agent LLM + Gaussian Splatting + Google Maps Platform APIs
- Address/postal code -> 3D model + visual descriptions
- Directly parallels our address-driven approach

**YOLOv9 Window-to-Wall Ratio - 2025**
- Paper: https://link.springer.com/article/10.1007/s12273-025-1301-3
- Automatic facade stitching from Google Street View + YOLOv9 detection
- 94% of facades within +/-5% of ground truth for window-to-wall ratio
- Directly applicable to our fenestration density measurement

**Depth Anything V2 - NeurIPS 2024**
- Repository: https://github.com/DepthAnything/Depth-Anything-V2
- SOTA monocular depth estimation, 10x faster than diffusion-based methods
- Models: 25M params (small) to 1.3B params (giant)
- Runs in browser via Transformers.js + WebGPU
- Video Depth Anything (Jan 2025) handles temporal consistency

### 2.3 What OSM 3D Renderers Do That We Don't

**OSM2World** (https://osm2world.org/):
- Reads 250+ OSM keys/tags
- Generates LOD-appropriate geometry from tags like `roof:shape`, `building:material`, `building:colour`
- Outputs glTF, OBJ, POV formats
- Key insight: They use OSM's rich tag vocabulary directly, not style presets

**Streets GL** (open-source F4Map alternative):
- Real-time 3D OSM rendering in WebGL
- Uses building:levels for height, roof:shape for geometry
- Demonstrates that OSM tags alone can produce reasonable 3D buildings

**What they do that we don't:** They treat each building as a unique entity defined by its actual attributes, not as an instance of a preset style. Our system should do the same.

---

## 3. Data Sources We Haven't Considered

### 3.1 FREE Global Building Datasets

**GlobalBuildingAtlas (2025)** -- HIGHEST PRIORITY NEW SOURCE
- Repository: https://github.com/zhu-xlab/GlobalBuildingAtlas
- 2.75 billion buildings worldwide with height predictions
- 97%+ height completeness, RMSE 1.5-8.9m by continent
- Includes pre-built LOD1 3D models in GeoJSON
- Available via WFS for direct API access from QGIS/web apps
- License: ODbL (polygons), CC BY-NC 4.0 (heights/LOD1)
- Published in Earth System Science Data journal

**Overture Maps Foundation**
- Docs: https://docs.overturemaps.org/guides/buildings/
- Backed by Microsoft, Amazon, Meta, and others
- 2.5B+ building features with standardized schema
- Includes building heights for 6M+ buildings in major US cities
- Cloud-optimized Parquet files on AWS
- Conflates OSM, Microsoft, Meta footprints with priority to OSM edits
- License: CDLA Permissive v2 / ODbL for OSM-derived data

**Microsoft Global ML Building Footprints**
- Repository: https://github.com/microsoft/GlobalMLBuildingFootprints
- 1.4 billion buildings from Bing Maps imagery (2014-2024)
- Free (ODbL license)
- US-specific dataset: https://github.com/microsoft/USBuildingFootprints

**Google Open Buildings 2.5D Temporal**
- Site: https://sites.research.google/gr/open-buildings/temporal/
- Annual building presence + heights from 2016-2023
- Coverage: Africa, South Asia, SE Asia, Latin America, Caribbean (~58M sq km)
- Height MAE: 1.5m (less than one story)
- Free via Google Earth Engine
- Limitation: Does NOT cover US/Europe

**Combined VIDA Dataset**
- Source: https://source.coop/vida/google-microsoft-osm-open-buildings
- Merges Google V3 + Microsoft + OSM: 2.7 billion footprints
- Cloud-native formats: GeoParquet, FlatGeobuf, PMTiles

### 3.2 FREE US LiDAR Data

**USGS 3DEP LiDAR**
- AWS: https://registry.opendata.aws/usgs-lidar/
- Entwine Point Tiles format on S3 (Requester Pays)
- Covers most of contiguous US + Hawaii + territories
- 8-year collection cycle, public domain
- Jupyter notebook workflows: https://github.com/OpenTopography/OT_3DEP_Workflows
- Automated building classification using transformers: https://pubs.usgs.gov/publication/70258364

### 3.3 Commercial Parcel Data

**Regrid**
- API: https://regrid.com/api
- 159M parcels across 3,229 US counties
- 187M building footprints matched to parcels
- Building footprints WITH height (max, min, median, roof slope, story count)
- Has free tier for API access; enterprise starts at $80K/year
- Most comprehensive US parcel + building data available

**LightBox SmartParcels**
- Site: https://www.lightboxre.com/product/smartparcels/
- 3,000+ county coverage, normalized schema
- Bulk data, real-time API, or visualization interface

### 3.4 Imagery Sources Not Currently Used

**Mapillary NeRFs (launched March 2024)**
- Blog: https://blog.mapillary.com/update/2024/03/11/Mapillary-NeRF.html
- Photorealistic 3D reconstruction from user-uploaded street photos
- Currently view-only on web app (no extraction API yet)
- Demonstrates feasibility of per-building 3D from street imagery

**Google Earth Engine / Copernicus Sentinel-2**
- Free satellite imagery at 10m resolution, ~5-day revisit
- Used by Google Open Buildings for height estimation
- Could run custom building segmentation models

**County GIS Portals (Free, Varies)**
- Data.gov: https://catalog.data.gov/dataset?tags=parcels
- Many individual counties publish detailed building outlines
- Coverage is spotty; no uniform API

---

## 4. Processing Pipelines for Each Data Type

### 4.1 Footprint + Height -> LOD1 Voxel Block

```
Address -> Geocode (lat/lng)
  -> Spatial query: Overture Maps / GlobalBuildingAtlas / OSM
  -> Get: footprint polygon + height
  -> Extrude polygon to height
  -> Voxelize extruded box at 1-block resolution
```

**Tools:** Overture API (Parquet on S3), OSM Overpass (existing), GlobalBuildingAtlas WFS
**Voxelization:** Ray-casting or mesh winding number test for each candidate voxel position
**Cost:** Free
**Browser-compatible:** Yes (fetch + geometry math)

### 4.2 Street View -> Facade Detailing

```
Building centroid + heading -> Google Street View images (4 sides)
  -> YOLOv9 / SAM2: detect windows, doors, balconies (bounding boxes)
  -> Classify materials: brick, wood, glass, concrete, stucco, stone
  -> Extract colors: dominant wall/roof/trim palette (existing SV analysis)
  -> Project 2D detections onto 3D facade planes
  -> Place voxel features at projected positions
```

**Key insight from Gemini analysis:** Do NOT attempt 3D reconstruction from monocular depth maps. Instead, use facade parsing for **procedural detailing** -- detect WHERE elements are and WHAT materials are used, then place them on the already-known geometry. This is far more reliable.

**Tools:** Transformers.js (SAM2, YOLO), existing SV Image Analysis module
**Cost:** Google Street View API cost (existing)
**Browser-compatible:** Yes, with WebGPU (SAM2 and depth models run in-browser via ONNX Runtime Web)

### 4.3 Solar API -> Roof Geometry

```
Building lat/lng -> Google Solar API
  -> Get: roof segments (pitch, azimuth, area), overall footprint area
  -> For each segment: generate sloped roof plane
  -> Fuse roof planes with wall extrusions
  -> Voxelize roof at 1-block resolution (half-slab placement for slopes)
```

**Current state:** We already have Solar API integration. The gap is converting segment data into actual roof geometry instead of picking from 5 presets.

**Tools:** Existing Solar API module, custom roof plane -> voxel converter
**Cost:** Solar API quota (existing)
**Browser-compatible:** Yes

### 4.4 LiDAR Point Cloud -> Building Mesh -> Voxel

```
Building bbox -> USGS 3DEP Entwine Point Tiles (AWS S3)
  -> Filter: building classification (class 6)
  -> Segment: individual building from point cloud
  -> Surface reconstruction: Poisson / Alpha shapes
  -> Voxelize resulting mesh
```

**Tools:** PDAL (server-side), Open3D (Python, server-side), potree.js (browser point cloud viewer)
**Cost:** AWS Requester Pays (~$0.01/GB transferred)
**Browser-compatible:** No -- LiDAR processing requires server. Could pre-process and cache results.
**Coverage:** ~75% of US land area currently covered

### 4.5 3D Tiles -> Per-Building Extraction -> Voxel

```
Building lat/lng -> Google Photorealistic 3D Tiles
  -> Render in 3d-tiles-renderer (existing)
  -> Extract mesh tiles intersecting building bbox
  -> Clip to building footprint polygon
  -> Decimate / simplify mesh
  -> Voxelize with color-to-block material mapping
```

**Challenge:** Google's 3D Tiles TOS prohibits extraction/downloading of tile geometry for offline use. The tiles are a continuous mesh, not per-building objects. Clipping requires knowing the exact building boundary. This approach is technically feasible but likely violates TOS.

**Alternative:** Use the 3D tile render as visual reference only, not as geometry source.

### 4.6 Multi-View -> Photogrammetric Reconstruction -> Voxel

```
Building address -> Google Earth Studio orbit (or multiple SV images)
  -> COLMAP / GLOMAP: Structure from Motion + Multi-View Stereo
  -> Dense point cloud -> Poisson surface reconstruction
  -> Textured mesh -> Voxelize with material mapping
```

**Tools:** COLMAP (https://github.com/colmap/colmap), GLOMAP (1-2 orders of magnitude faster)
**Cost:** Compute-intensive, requires GPU server
**Browser-compatible:** No -- server-side only
**Quality:** Highest fidelity, but requires 20-50+ images with good coverage

---

## 5. The Ideal End-to-End Pipeline

### 5.1 Replace Style Presets with Data-Driven Materials

**Current (broken):**
```
yearBuilt -> style preset -> hardcoded materials
yearBuilt < 1700 -> "medieval" -> stone walls, dark wood, etc.
```

**Proposed:**
```
Street View image -> material classification -> actual materials
  + SV color extraction -> actual dominant colors
  + OSM building:material tag -> verified material type
  + Smarty construction_type field -> structural material
  = Data-driven MaterialPalette with real RGB values
```

The material palette should be assembled from **observed data**, not inferred from year:

| Priority | Source | What It Provides |
|----------|--------|-----------------|
| 1 | SV Image Analysis (existing) | Actual wall/roof/trim RGB colors |
| 2 | SAM2 material segmentation | Material type classification (brick/wood/glass/concrete/stone/stucco) |
| 3 | OSM building:material | Verified material tag |
| 4 | Smarty construction_type | Structural material from assessor records |
| 5 | Claude Vision (opt-in) | Detailed architecture label + feature checklist |
| 6 | Fallback heuristic | Region + era + property type -> likely material |

### 5.2 Replace Preset Geometry with Actual Footprints

**Current (broken):**
```
sqft -> approximate rectangle
propertyType -> L/T/U shape guess
```

**Proposed priority chain:**
```
1. OSM building footprint polygon (exact vertices) -- EXISTING
2. Overture Maps footprint polygon -- NEW, 2.5B buildings
3. GlobalBuildingAtlas footprint -- NEW, 2.75B buildings
4. Microsoft/Google ML footprint -- NEW, combined 2.7B
5. Satellite footprint extraction (existing SAM-based) -- EXISTING
6. Solar API footprint area -> rectangle approximation -- EXISTING
7. Smarty sqft -> rectangle estimate -- EXISTING (last resort)
```

### 5.3 Replace Preset Roofs with Actual Roof Geometry

**Current (broken):**
```
style preset -> pick from 5 roof types (flat, gable, hip, gambrel, shed)
```

**Proposed:**
```
1. Google Solar API roof segments (pitch, azimuth, area) -- EXISTING
   -> Convert segments to sloped planes
   -> Fuse with wall geometry
2. OSM roof:shape tag (gabled, hipped, flat, etc.) -- EXISTING
   -> Use as constraint/validation
3. LiDAR point cloud roof extraction -- NEW (server-side)
   -> Surface reconstruction from classified points
4. Depth estimation from aerial/satellite view -- FUTURE
   -> Depth Anything V2 on overhead imagery
```

### 5.4 Replace Procedural Windows with Detected Placements

**Current (broken):**
```
fenestration density -> place window every N blocks
```

**Proposed:**
```
1. YOLOv9 / SAM2 facade parsing on Street View images
   -> Detect window/door bounding boxes in image space
   -> Project onto 3D facade plane using SV camera parameters
   -> Place voxel windows at projected 3D positions
2. Claude Vision feature checklist (opt-in)
   -> Window style, count, symmetry pattern
3. Smarty assessor data
   -> Window count (some counties), door count
4. Fenestration density fallback (existing)
   -> Use only when no imagery available
```

---

## 6. What Can Run In-Browser vs Server-Side

### 6.1 Browser-Compatible (Client-Side)

| Task | Tool | Requirements |
|------|------|-------------|
| Footprint fetch | Overture Parquet / OSM Overpass | HTTP fetch |
| Polygon extrusion | Custom TypeScript | Geometry math |
| Voxelization | Custom TypeScript + Three.js | Ray casting |
| SV image fetch | Google Street View API | HTTP fetch |
| Color extraction | Existing SV analysis | Canvas API |
| Depth estimation | Depth Anything V2 Small (25M) | Transformers.js + WebGPU |
| Image segmentation | SAM2 (tiny) | Transformers.js + WebGPU |
| Object detection | YOLOv8/v9 (small) | ONNX Runtime Web + WebGPU |
| Material classification | Custom CNN (small) | ONNX Runtime Web |
| Roof from Solar API | Existing + geometry | Trig math |

**Key enabler:** ONNX Runtime Web with WebGPU (https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html) enables running ML models in-browser with 20x speedup over CPU WASM. Transformers.js v3+ supports SAM2, Depth Anything V2, and YOLO models with WebGPU backend. Browser support: Chrome 113+, Edge 113+, Firefox 141+ (Windows).

### 6.2 Server-Side Only

| Task | Tool | Why |
|------|------|-----|
| LiDAR point cloud processing | PDAL + Open3D | Large data (GB), CPU/GPU intensive |
| Full photogrammetric reconstruction | COLMAP / GLOMAP | GPU required, minutes per building |
| Gaussian Splatting training | 2DGS / 3DGS | GPU required, minutes per building |
| Large model inference | Depth Anything V2 Giant (1.3B) | Memory exceeds browser limits |
| Pre-computation batch jobs | Custom pipeline | Economies of scale |

### 6.3 Hybrid Approach

For Tiers 0-2, **everything runs in the browser**. The user's GPU handles ML inference via WebGPU. This means no server costs for the common case.

For Tier 3, a **lightweight server/serverless function** handles heavy reconstruction. This could be:
- A GPU-enabled cloud function (AWS Lambda with GPU, Google Cloud Run with GPU)
- A self-hosted server with consumer GPU
- A pre-computation batch that processes popular addresses and caches results

---

## 7. Feasibility Assessment

### 7.1 Quick Wins (1-2 Weeks)

**A. Add Overture Maps / GlobalBuildingAtlas as footprint source (3-5 days)**
- Impact: Massive increase in footprint availability beyond OSM
- How: Fetch GeoParquet or WFS by lat/lng bbox, parse polygon + height
- Cost: Free
- Difficulty: Medium (new data format parsing)

**B. Convert Solar API segments to actual roof planes (3-5 days)**
- Impact: Replace 5 preset roof shapes with data-driven roof geometry
- How: For each Solar segment, compute 3D plane from pitch + azimuth + area, voxelize
- Cost: Free (already have Solar API)
- Difficulty: Medium (geometry math)

**C. Replace style-to-material mapping with image-derived materials (2-3 days)**
- Impact: Buildings get their ACTUAL colors instead of style-preset colors
- How: Use existing SV color extraction (wall_color, roof_color, trim_color) directly as MaterialPalette instead of routing through style presets
- Cost: Free
- Difficulty: Low (rewire existing data flow)

**D. Use OSM building:material and building:colour tags directly (1-2 days)**
- Impact: When OSM has material data, use it verbatim
- How: Map OSM material strings to Minecraft block types
- Cost: Free
- Difficulty: Low

**E. Smarty construction_type -> material mapping (1 day)**
- Impact: Assessor-verified material type for US buildings
- How: Map construction_type values (frame, masonry, steel, concrete) to block palettes
- Cost: Free (already have Smarty API)
- Difficulty: Low

### 7.2 Medium-Term (1-3 Months)

**F. In-browser facade parsing with YOLOv9/SAM2 (2-4 weeks)**
- Impact: Actual window/door placement instead of procedural
- How: Load ONNX model via Transformers.js, detect facade elements in SV image, project onto 3D
- Cost: Free (models are open source)
- Difficulty: High (model integration, 2D->3D projection)

**G. Depth Anything V2 for facade depth analysis (2-3 weeks)**
- Impact: Better understanding of facade geometry (recesses, projections, porches)
- How: Run small model in browser via WebGPU, extract depth discontinuities
- Cost: Free
- Difficulty: High (depth map interpretation)

**H. USGS 3DEP LiDAR roof extraction (3-4 weeks)**
- Impact: Sub-meter roof accuracy for covered US areas
- How: Server-side PDAL pipeline, cache results, serve pre-computed roof meshes
- Cost: Low (AWS Requester Pays ~$0.01/GB)
- Difficulty: High (point cloud processing infrastructure)

### 7.3 Long-Term (3-6 Months)

**I. Full photogrammetric pipeline for premium buildings (2-3 months)**
- Impact: Photorealistic-quality voxel models
- How: COLMAP/GLOMAP on multi-view imagery, mesh extraction, voxelization
- Cost: GPU compute costs
- Difficulty: Very high (infrastructure, automation, quality control)

**J. Custom facade parsing model trained on building photos (2-3 months)**
- Impact: Higher accuracy than generic object detection
- How: Fine-tune YOLOv9 on building facade dataset (several exist in literature)
- Cost: GPU training costs
- Difficulty: Very high (ML training pipeline)

**K. Gaussian Splatting per-building extraction (3-6 months)**
- Impact: Highest fidelity 3D models from any imagery
- How: Implement GBM-style pipeline with automation
- Cost: Significant GPU compute
- Difficulty: Very high (research-grade)

---

## 8. Voxelization Strategy

### 8.1 Mesh-to-Voxel Algorithm

The voxelization process for converting real-world geometry to Minecraft-style blocks:

1. **Bounding box**: Compute axis-aligned bounding box of building mesh
2. **Grid setup**: Create 3D grid at chosen resolution (1 voxel = 1 Minecraft block = ~1 meter)
3. **Surface voxelization**: For each mesh triangle:
   - Compute triangle bounding box in grid coordinates
   - For each voxel in that box, test triangle-voxel intersection
   - Mark intersecting voxels as surface
4. **Fill interior**: Use flood fill from exterior to mark interior voxels
5. **Material assignment**: For each surface voxel:
   - Compute barycentric coordinates within source triangle
   - Interpolate UV coordinates
   - Sample texture color at UV position
   - Convert sRGB to CIE-Lab color space
   - Find closest Minecraft block by minimum delta-E

### 8.2 Block Material Mapping

Convert detected real-world materials to Minecraft block types:

| Real Material | Minecraft Block Candidates |
|---------------|---------------------------|
| Red brick | Brick Block, Terracotta (red/orange) |
| Yellow brick | Sandstone, Yellow Terracotta |
| Wood siding | Oak/Spruce/Birch/Dark Oak Planks |
| Concrete | Stone, Smooth Stone, Light Gray Concrete |
| Stucco/plaster | White/Light Gray Concrete, Quartz |
| Glass | Glass Pane, Tinted Glass |
| Stone/granite | Cobblestone, Stone Bricks, Granite |
| Metal/steel | Iron Block, Light Gray Concrete |
| Vinyl siding | White/colored Concrete variants |
| Asphalt shingle | Gray/Black Concrete, Coal Block |
| Clay/terra cotta roof | Terracotta variants |
| Metal roof | Iron Block, Copper Block |
| Slate roof | Deepslate variants |

Color matching should use CIE-Lab delta-E comparison (not RGB Euclidean distance) because Lab perceptually matches human color perception. The voxelizer at https://github.com/TwentyFiveSoftware/voxelizer implements exactly this approach.

### 8.3 Resolution Considerations

At 1 block = 1 meter:
- A 2000 sqft ranch house (~15m x 12m x 5m) = ~900 surface voxels
- A 3-story Victorian (~12m x 10m x 12m) = ~1500 surface voxels
- Manageable for real-time rendering in Three.js with greedy meshing

---

## 9. Recommended Architecture

### 9.1 Data Ingestion Layer (Replaces Style Preset Lookup)

```
AddressInput
  |
  v
GeocoderService (existing)
  |
  v
BuildingDataAggregator (NEW -- replaces style lookup)
  |-- FootprintResolver: OSM > Overture > GlobalBuildingAtlas > Microsoft ML > satellite extraction > sqft estimate
  |-- HeightResolver: LiDAR (Mapbox) > GlobalBuildingAtlas > OSM levels > Smarty stories > Sobel count
  |-- MaterialResolver: SV color > SAM2 material > OSM tag > Smarty construction > region heuristic
  |-- RoofResolver: Solar API segments > OSM roof:shape > LiDAR > heuristic
  |-- FacadeResolver: YOLOv9 windows/doors > Claude Vision > Smarty counts > density formula
  |
  v
BuildingProfile (data-driven, NOT style-driven)
  { footprint: Polygon, height: number, materials: MaterialPalette,
    roofSegments: RoofPlane[], facadeElements: FacadeElement[],
    colors: { wall: RGB, roof: RGB, trim: RGB } }
```

### 9.2 Geometry Generation Layer

```
BuildingProfile
  |
  v
GeometryBuilder
  |-- FootprintExtruder: polygon + height -> wall mesh
  |-- RoofGenerator: RoofPlane[] -> roof mesh (from Solar API data, not presets)
  |-- FacadeDetailer: FacadeElement[] + wall mesh -> windowed/doored mesh
  |-- FoundationGenerator: Smarty foundation_type -> base geometry
  |
  v
BuildingMesh (Three.js BufferGeometry, textured)
```

### 9.3 Voxelization Layer

```
BuildingMesh
  |
  v
MeshVoxelizer
  |-- SurfaceVoxelizer: triangle-voxel intersection test
  |-- InteriorFiller: flood fill
  |-- MaterialMapper: texture sample -> CIE-Lab -> closest MC block
  |-- RoomCarver: interior layout from Smarty room data (existing)
  |
  v
VoxelGrid (existing format, ready for Three.js / .schematic export)
```

### 9.4 Tier Progression

| Tier | Time | Cost | What Runs | Accuracy |
|------|------|------|-----------|----------|
| 0 | <1s | Free | Footprint extrusion + flat roof + heuristic materials | LOD1 |
| 1 | 2-5s | SV API | + SV facade parsing + real colors + window placement | LOD2-3 |
| 2 | 3-8s | SV + Solar | + Solar roof geometry + Smarty detailed fields | LOD2-3+ |
| 3 | 30-120s | Server GPU | + Photogrammetric reconstruction + voxelization | LOD3-4 |

---

## 10. Critical Analysis (from Gemini 2.5 Pro)

Gemini raised several important cautions:

1. **Do NOT use monocular depth for 3D reconstruction.** Single-view depth maps from Street View are riddled with occlusions (trees, cars, pedestrians) and perspective distortion. Use depth estimation for **facade analysis** (detecting recesses, porches, projections) but not for building geometry extraction. The geometry should come from footprint + height + roof data.

2. **Facade parsing should drive procedural detailing, not reconstruction.** Detect WHERE elements are in 2D, project onto the already-known 3D geometry, then place voxel features at those positions. This is far more robust than attempting to reconstruct 3D from images.

3. **Data conflation is a real challenge.** OSM, Overture, and Microsoft footprints will not align perfectly. Need a clear priority chain and spatial matching strategy. Recommendation: Use Overture as the entity ID backbone (since they already conflate OSM + Microsoft + Meta), then enrich with other sources.

4. **Roof-wall fusion is non-trivial.** Stitching detailed roof meshes onto extruded walls requires handling vertical walls, overhangs, and complex intersections. The Solar API "simplified" mesh may not align perfectly with the footprint.

5. **Google 3D Tiles extraction likely violates TOS.** Use the 3D tile render as visual reference only, not as a geometry source. The GBM paper uses Google Earth Studio screenshots (which may be permitted under fair use for research), not direct tile extraction.

6. **Gaussian Splatting is a rendering technique, not a modeling technique.** While meshes can be extracted from GS representations, the resulting topology is noisy. For clean voxelizable geometry, traditional photogrammetry (COLMAP/GLOMAP) produces better mesh quality.

---

## 11. Implementation Priority

### Phase 1: Foundation (Weeks 1-2) -- Quick Wins
1. Wire existing SV color extraction directly to MaterialPalette (bypass style presets)
2. Map OSM building:material + Smarty construction_type to block palettes
3. Add Overture Maps as a footprint source alongside OSM
4. Convert Solar API segments to actual roof planes

### Phase 2: Intelligence (Weeks 3-6)
5. Integrate Transformers.js with WebGPU for in-browser ML
6. Add SAM2 material segmentation from SV images
7. Add YOLOv9 window/door detection with 2D->3D projection
8. Implement CIE-Lab color-to-block mapping

### Phase 3: Precision (Weeks 7-12)
9. USGS 3DEP LiDAR roof extraction (server-side)
10. GlobalBuildingAtlas integration for height data
11. Multi-view facade stitching for full building coverage
12. Depth Anything V2 for facade depth analysis

### Phase 4: Premium (Months 4-6)
13. COLMAP photogrammetric pipeline (server-side)
14. Automated Google Earth orbit capture
15. Pre-computation cache for popular addresses
16. Custom facade parsing model training

---

## 12. Key URLs and Resources

### Datasets (Free)
- GlobalBuildingAtlas: https://github.com/zhu-xlab/GlobalBuildingAtlas
- Overture Maps: https://docs.overturemaps.org/guides/buildings/
- Microsoft Footprints: https://github.com/microsoft/GlobalMLBuildingFootprints
- VIDA Combined Dataset: https://source.coop/vida/google-microsoft-osm-open-buildings
- USGS 3DEP LiDAR: https://registry.opendata.aws/usgs-lidar/
- Google Open Buildings 2.5D: https://sites.research.google/gr/open-buildings/temporal/

### ML Models (Open Source, Browser-Compatible)
- Transformers.js: https://huggingface.co/docs/transformers.js
- Depth Anything V2: https://github.com/DepthAnything/Depth-Anything-V2
- SAM2: https://github.com/facebookresearch/sam2
- ONNX Runtime Web: https://onnxruntime.ai/docs/tutorials/web/

### Tools (Open Source, Server-Side)
- COLMAP: https://github.com/colmap/colmap
- GLOMAP: https://github.com/colmap/glomap
- Open3D: https://www.open3d.org/docs/release/tutorial/geometry/voxelization.html
- PDAL: https://pdal.io/
- OSM2World: https://osm2world.org/

### Voxelization
- Voxelizer (Minecraft plugin): https://github.com/TwentyFiveSoftware/voxelizer
- Three.js voxel tutorial: https://tympanus.net/codrops/2023/03/28/turning-3d-models-to-voxel-art-with-three-js/
- Bloxelizer: https://bloxelizer.com/

### Papers
- GBM (2025): https://arxiv.org/abs/2501.00625
- Digital Twin Buildings (2025): https://arxiv.org/html/2502.05769v2
- CM2LoD3 (2025): https://arxiv.org/html/2508.15672
- Voxel LOD2 (2025): https://link.springer.com/article/10.1007/s44212-025-00090-y
- YOLOv9 WWR (2025): https://link.springer.com/article/10.1007/s12273-025-1301-3
- SAM Building Segmentation: https://www.mdpi.com/2072-4292/16/14/2661
- 3D from Single SV: https://ual.sg/publication/2022-jag-3-d-svi/

---

## 13. Compromises and Open Questions

1. **Google 3D Tiles extraction**: Technically possible but likely TOS-violating. Defer unless Google releases a per-building extraction API.
2. **Mapillary NeRFs**: Currently view-only, no extraction API. Monitor for API release.
3. **US-only vs Global**: Most of our rich data sources (Smarty, Solar API, USGS LiDAR) are US-only. Overture + GlobalBuildingAtlas provide global footprints, but facade details depend on SV/Mapillary coverage.
4. **WebGPU browser support**: Chrome/Edge are ready. Firefox 141+ on Windows only. Safari is experimental. Need WASM fallback for unsupported browsers (slower but functional).
5. **Model size vs accuracy**: Depth Anything V2 Small (25M) runs in-browser but is less accurate than Large (335M). Need to benchmark quality vs latency tradeoff.
6. **Roof-wall fusion geometry**: No off-the-shelf solution for clean watertight mesh fusion in TypeScript/browser. Will need custom implementation.
7. **Rate limits**: Adding Overture + GlobalBuildingAtlas queries on top of existing 9 APIs increases total API calls per building. Need request waterfall optimization.
