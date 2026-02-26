# 3D Building Models, Footprints & Structured Data APIs

Research report for Craftmatic: generating Minecraft buildings from real-world addresses.

**Existing integrations**: OSM Overpass, Google Street View, Google Solar API, Mapbox Tilequery,
Mapillary, Smarty (SmartyStreets), Parcl Labs, satellite footprint extraction, AWS Terrarium elevation.

---

## 1. 3D Building Model APIs

### 1.1 Google Photorealistic 3D Tiles (partially integrated)

| Field | Detail |
|-------|--------|
| URL | https://developers.google.com/maps/documentation/tile/3d-tiles |
| Endpoint | `https://tile.googleapis.com/v1/3dtiles/root.json?key=API_KEY` (OGC 3D Tiles 1.1) |
| Input | Viewport-based tile loading (lat/lon via camera position) |
| Output | glTF 2.0 meshes with Draco compression, photorealistic textures |
| Coverage | Global (populated areas) |
| Pricing | Essentials: 100k root-tile requests/month free; pay-as-you-go after (tiered) |

**How it works**: Tiles are seamless terrain+building meshes -- individual buildings are NOT
separately addressable. The entire scene is a continuous textured mesh.

**Extraction methods for individual buildings**:
- **Raycast + bounding box**: Load tiles at a known lat/lon, raycast into the scene, and clip
  geometry within a radius. This gives you the mesh fragment for one building but includes
  surrounding terrain.
- **Gaussian Building Mesh (GBM)**: Research paper (arxiv:2501.00625) demonstrates a pipeline
  using Google Earth Studio orbit video + SAM2/GroundingDINO segmentation + 2D Gaussian Splatting
  to extract a clean single-building mesh from coordinates/address. Requires GPU + offline processing.
- **Blosm Blender addon**: Can import Google 3D tiles at configurable LOD and export as OBJ.
  Manual workflow, not API-automatable.

**Craftmatic integration potential**: Could extract building volume (bounding box dimensions) by
loading tiles at the target lat/lon and measuring the mesh extent above ground plane. Maps to:
`osmWidth`, `osmLength`, story count estimation. The photorealistic texture could be sampled for
wall/roof color extraction (alternative to SV analysis).

**Limitations**: Google ToS prohibit extracting/caching geometry. Mesh is fused -- isolating one
building from neighbors is non-trivial. Best used as a visual reference, not a data source.

---

### 1.2 Cesium ion 3D Tiles

| Field | Detail |
|-------|--------|
| URL | https://cesium.com/platform/cesium-ion/ |
| Endpoint | `https://api.cesium.com/v1/assets/{assetId}/endpoint` (then stream 3D Tiles) |
| Input | Asset ID + viewport (lat/lon via camera) |
| Output | B3DM/I3DM/PNTS tiles with batch tables; glTF geometry |
| Coverage | Global (via Cesium OSM Buildings); Japan 3D Buildings; custom uploads |
| Pricing | Free community tier (limited streaming); Commercial plans available |

**Key datasets**:
- **Cesium OSM Buildings** (asset 96188): 350M+ buildings worldwide, derived from OSM.
  Each building is an individual extruded polygon with per-building metadata (name, height,
  address, material type, 20k+ property types). Updated quarterly (latest: Apr 2025).
  Includes `cesium#latitude`, `cesium#longitude` for each building.
- **Japan 3D Buildings**: 23M textured/untextured buildings with height + location metadata.
- **Google Photorealistic 3D Tiles**: Can be streamed through Cesium ion as well.

**Extraction method**:
Using `3d-tiles-renderer` (already in Craftmatic):
```typescript
// Raycast to find building at coordinates
const intersects = raycaster.intersectObject(tilesGroup, true);
const { face, object } = intersects[0];
const batchidAttr = object.geometry.getAttribute('_batchid');
// Traverse to batch table
let node = object;
while (!node.batchTable) node = node.parent;
const data = node.batchTable.getDataFromId(batchidAttr.getX(face.a));
// data = { name, height, building:levels, building:material, ... }
```

Also supports `EXT_structural_metadata` and `EXT_mesh_features` glTF extensions via plugins
`GLTFStructuralMetadataExtension` and `GLTFMeshFeaturesExtension`.

**Craftmatic mapping**:
- `height` -> story estimation (height / 3.5m)
- `building:levels` -> `osmLevels`
- `building:material` -> `osmMaterial`
- `building:colour` -> `osmBuildingColour`
- `roof:shape` -> `osmRoofShape`
- Building geometry -> footprint dimensions (`osmWidth`, `osmLength`)
- Individual building mesh -> volume-based section generation

**Recommendation**: HIGH PRIORITY. Cesium OSM Buildings provides structured per-building data
that is richer than raw Overpass queries and comes pre-tiled for efficient spatial lookup.
The free tier covers typical usage.

---

### 1.3 OSM Buildings (osmbuildings.org)

| Field | Detail |
|-------|--------|
| URL | https://osmbuildings.org/ |
| Endpoint | `https://{s}.data.osmbuildings.org/0.2/anonymous/tile/{z}/{x}/{y}.json` |
| Input | XYZ tile coordinates (zoom level 15 recommended) |
| Output | GeoJSON FeatureCollection (EPSG:4326) |
| Coverage | Global (derived from OSM) |
| Pricing | Free for reasonable usage; contact for heavy load |

**Data per building**: Footprint polygon, height, building type, and other OSM tags where available.

**How to query for a specific address**:
1. Geocode address to lat/lon
2. Convert to tile coordinates at zoom 15: `x = floor((lon+180)/360 * 2^15)`, `y = ...`
3. Fetch tile GeoJSON
4. Find building polygon containing or nearest to the point

**Craftmatic mapping**:
- Footprint polygon -> `osmWidth`, `osmLength`, `osmPolygon`, `floorPlanShape`
- Height -> story estimation
- Building type -> `propertyType`

**Comparison to existing Overpass integration**: OSM Buildings is essentially a pre-processed,
tile-served version of the same Overpass data already used. The advantage is it is faster (cached
tiles vs. ad-hoc Overpass queries) but may have less metadata (only geometry + height + type vs.
the full tag set from Overpass). **Low incremental value** given existing Overpass integration.

---

### 1.4 CityGML Open Datasets

| Field | Detail |
|-------|--------|
| URL | https://github.com/OloOcki/awesome-citygml (master list) |
| Input | Download by city/region; no real-time query API |
| Output | CityGML (XML), CityJSON, some as 3D Tiles |
| Coverage | City-specific: NYC, Berlin, Hamburg, Munich, Helsinki, Vienna, Singapore, Zurich |
| Pricing | Free (open data) |

**Key datasets**:
- **NYC**: LOD1, 4M+ objects (buildings, streets, terrain). CityGML + KML.
- **Berlin**: LOD2 (detailed roof shapes). CityGML.
- **Helsinki**: LOD2 with textures. CityGML, Shapes, KMZ, DXF.
- **OpenCityModel (US)**: 125M US buildings at LOD1 with footprint area, height, FIPS code,
  UBID. Hosted on AWS S3 (`s3://opencitymodel/`), partitioned by state/county in CityGML,
  CityJSON, and Parquet formats.

**Craftmatic mapping**:
- LOD1: Building box -> `osmWidth`, `osmLength`, height -> stories
- LOD2: Detailed roof geometry -> `osmRoofShape`, ridge lines, dormers
- Attributes: UBID (universal building ID), area, height

**Limitations**: Static datasets, not queryable by lat/lon API. Requires downloading county/city
files and doing local spatial lookup. OpenCityModel is US-only at LOD1. LOD2 is city-specific.

**Recommendation**: MEDIUM value. OpenCityModel's Parquet format could enable DuckDB spatial
queries for US buildings. LOD2 cities (Berlin, Helsinki) provide roof detail not available
elsewhere, but coverage is very limited.

---

### 1.5 Mapbox 3D Buildings

| Field | Detail |
|-------|--------|
| URL | https://docs.mapbox.com/mapbox-gl-js/example/3d-buildings/ |
| Endpoint | Tilequery: `https://api.mapbox.com/v4/{tileset}/tilequery/{lon},{lat}.json` |
| Input | Lat/lon for Tilequery; viewport for vector tiles |
| Output | GeoJSON features with `height`, `extrude`, `min_height` properties |
| Coverage | Global (most metro areas have height data) |
| Pricing | 600 req/min; free tier varies by plan |

**Already partially integrated** via `import-mapbox-building.ts` which queries building height.

**Additional extractable data**:
- `fill-extrusion-height` -> building total height
- `fill-extrusion-base` -> base height (for buildings on slopes)
- Building type classification
- Footprint polygon from vector tile features

**Craftmatic mapping**: `mapboxHeight` (already used), `mapboxBuildingType` (already used).
Could additionally extract footprint polygon geometry.

---

### 1.6 HERE Platform 3D Buildings

| Field | Detail |
|-------|--------|
| URL | https://developer.here.com/documentation/vector-tiles-api/dev_guide/topics/layers-buildings-and-addresses.html |
| Endpoint | Vector Tiles API: `https://vector.hereapi.com/v2/vectortiles/base/mc/{z}/{x}/{y}/omv` |
| Input | Tile coordinates + API key |
| Output | MVT (Mapbox Vector Tiles) with building layer |
| Coverage | North America + Europe (metropolitan areas) |
| Pricing | Free tier: 250k tile requests/month |

**Building data**: Footprint polygons, `has_landmark` flag, 3D landmark models for notable
buildings. Collected via vehicle fleet with panoramic cameras + LiDAR (1.3B points/minute).

**Craftmatic mapping**: Limited -- similar to Mapbox but with less open documentation on
building attribute fields. The LiDAR-derived footprints may be more accurate than OSM in areas
with poor OSM coverage. `has_landmark` could flag notable buildings for special treatment.

**Recommendation**: LOW priority. Adds little over existing Mapbox + OSM integration.

---

## 2. Building Footprint APIs & Datasets

### 2.1 Overture Maps Foundation

| Field | Detail |
|-------|--------|
| URL | https://docs.overturemaps.org/guides/buildings/ |
| Endpoint | S3: `s3://overturemaps-us-west-2/release/` or Azure Blob |
| Input | DuckDB/Athena spatial query by bbox, or Python CLI |
| Output | GeoParquet (200 files, 230GB total for buildings) |
| Coverage | Global: **2.3 billion building footprints** |
| Pricing | Completely free, no auth required |

**Building attributes** (per schema):
- `height` (meters)
- `num_floors`, `num_floors_underground`
- `roof_shape` (e.g. "dome", "gable", "hip")
- `roof_orientation`, `roof_direction`
- `roof_height`, `min_height`
- `sources` array with dataset + confidence
- Footprint polygon geometry

**Data sources**: Merged from OSM, Esri Community Maps, Microsoft ML footprints, Google Open
Buildings. Each feature tracks its provenance.

**Query example (DuckDB)**:
```sql
SELECT id, geometry, height, num_floors, roof_shape
FROM read_parquet('s3://overturemaps-us-west-2/release/2026-02-18.0/theme=buildings/type=building/*')
WHERE bbox.xmin <= -83.05 AND bbox.xmax >= -83.04
  AND bbox.ymin <= 42.33 AND bbox.ymax <= 42.34
```

**Craftmatic mapping**:
- `height` -> story estimation
- `num_floors` -> `osmLevels`
- `roof_shape` -> `osmRoofShape`
- Footprint polygon -> `osmWidth`, `osmLength`, `osmPolygon`, `floorPlanShape`
- Sources confidence -> quality weighting

**Recommendation**: HIGH PRIORITY. Overture is the most comprehensive free building dataset,
merging the best of OSM + Microsoft + Google footprints. The DuckDB query path could run
server-side or via a lightweight proxy. This could supplement or replace raw Overpass queries
with richer, deduplicated data.

---

### 2.2 Microsoft Global ML Building Footprints

| Field | Detail |
|-------|--------|
| URL | https://github.com/microsoft/GlobalMLBuildingFootprints |
| Endpoint | Bulk download from S3/GitHub; indexed by `dataset-links.csv` |
| Input | Country + quadkey partition -> download GeoJSONL (.csv.gz) |
| Output | Line-delimited GeoJSON (polygon + height + confidence) |
| Coverage | Global: **999M footprints** (1.2M US heights added Feb 2026) |
| Pricing | Free (ODbL license) |

**Per-building data**:
- `geometry`: Polygon footprint
- `height`: Estimated building height in meters (-1 if unavailable)
- `confidence`: Detection confidence 0-1 (-1 for older data)

**Query approach**: Download country+quadkey partition, filter spatially in code. No real-time
API -- this is a bulk dataset.

**Craftmatic mapping**:
- Footprint polygon -> `osmWidth`, `osmLength`
- Height -> story estimation (where available)
- Confidence -> quality gating

**Recommendation**: MEDIUM. Already incorporated into Overture Maps. Direct use is mainly
for cases where Overture is not accessible or you need the raw ML footprint without OSM merging.

---

### 2.3 Google Open Buildings

| Field | Detail |
|-------|--------|
| URL | https://sites.research.google/gr/open-buildings/ |
| Endpoint | Google Earth Engine FeatureView; bulk CSV download by S2 cell |
| Input | S2 cell level 4 partition, or Earth Engine spatial filter |
| Output | CSV with WKT polygons, centroid lat/lon, area, confidence |
| Coverage | Africa, Latin America, Caribbean, South Asia, Southeast Asia: **1.8B outlines** |
| Pricing | Free |

**Per-building data**:
- Polygon footprint (WKT)
- Centroid lat/lon
- Area (sqm)
- Confidence score (0.65-1.0)
- Plus Code for center

**2.5D Temporal extension (2025)**: Annual building presence/counts/heights 2016-2023 at 4m
resolution, primarily Global South.

**Craftmatic mapping**:
- Area -> sqft estimation
- Polygon -> footprint dimensions

**Recommendation**: LOW for US-focused use. Coverage is primarily Global South. Already
incorporated into Overture Maps.

---

### 2.4 GlobalBuildingAtlas (NEW - 2025)

| Field | Detail |
|-------|--------|
| URL | https://github.com/zhu-xlab/GlobalBuildingAtlas |
| Endpoint | Bulk download from mediaTUM; indexed by 5x5 degree tiles |
| Input | Tile grid lookup via `lod1.geojson` index |
| Output | GeoJSON (polygons + LoD1 models), GeoTiff (heights) |
| Coverage | Global: **2.75 billion buildings**, 97% with height estimates |
| Pricing | Free (open data, published in ESSD 2025) |

**Per-building data**:
- GBA.Polygon: Building footprint polygon
- GBA.Height: Building height raster at high resolution (RMSE 1.5-8.9m by continent)
- GBA.LoD1: Full LoD1 3D models (extruded footprints with height)

**Craftmatic mapping**:
- Footprint polygon -> `osmWidth`, `osmLength`
- Height -> story estimation with known accuracy bounds
- LoD1 model -> direct volume for section generation

**Recommendation**: MEDIUM-HIGH. Most complete global dataset with heights. Bulk download
model means it is better for server-side preprocessing than real-time browser queries.

---

### 2.5 Regrid Parcel Data

| Field | Detail |
|-------|--------|
| URL | https://regrid.com/api |
| Endpoint | REST API with address, point, radius search |
| Input | Lat/lon (radius 0-32km), address, or parcel APN |
| Output | JSON with parcel polygon + matched building footprints |
| Coverage | US + Canada: 183M+ building footprints matched to parcels |
| Pricing | Free tier to start; premium for building footprints (`return_matched_buildings`) |

**Per-parcel data**: Parcel boundary polygon, APN, address, zoning, land use, owner info.
Premium add-on includes matched building footprints within each parcel.

**Craftmatic mapping**:
- Parcel polygon -> lot boundaries (for yard/landscaping generation)
- Building footprint -> `osmWidth`, `osmLength`
- Zoning + land use -> `propertyType` inference
- Lot area -> `lotSize`

**Recommendation**: MEDIUM. Parcel boundaries are valuable for lot context (yard size, setbacks)
which is not available from building-only datasets. The free tier may be sufficient for testing.

---

### 2.6 OpenStreetMap Overpass (already integrated)

Already the primary footprint source. Provides:
- Building polygon with full tag set (levels, material, colour, roof:shape, etc.)
- Round-robin across 3 Overpass servers for reliability
- Query by bbox around geocoded coordinates

No changes needed. Overture Maps could supplement this for buildings with poor OSM coverage.

---

## 3. Building Attribute APIs

### 3.1 Smarty (SmartyStreets) -- already integrated

| Field | Detail |
|-------|--------|
| URL | https://www.smarty.com/products/us-property-data |
| Endpoint | US Street API with property enrichment |
| Coverage | US: 350+ property data points |
| Pricing | Free tier available; paid plans for volume |

**Already feeding into PropertyData**: `roofType`, `constructionType`, `foundation`, `roofFrame`,
`hasGarage`, `hasFireplace`, `hasDeck`, `smartyHasPorch`, `smartyHasPool`, `smartyHasFence`,
`drivewayType`, `assessedValue`, `exteriorType`, `architectureType`, `lotSize`.

**Untapped Smarty fields to investigate**:
- Heating/cooling type (affects chimney generation)
- Number of stories (direct, avoids inference)
- Roof material (more specific than `roofType`)
- Year remodeled (more accurate than yearBuilt for style)
- Number of units (for multi-family)
- Parking spaces (garage size)
- Window type (for window style selection)

---

### 3.2 ATTOM Data

| Field | Detail |
|-------|--------|
| URL | https://api.developer.attomdata.com/docs |
| Endpoint | `https://api.gateway.attomdata.com/propertyapi/v1.0.0/property/detail?address1=...` |
| Input | Address, APN, or FIPS+APN |
| Output | JSON with thousands of property data fields |
| Coverage | US: comprehensive |
| Pricing | Starts at $95/month; 30-day free trial |

**Key building attributes**:
- Square footage, bedrooms, bathrooms, stories
- Building class, quality grade
- Foundation type, framing type
- Exterior wall type, roof type, roof material
- Garage type + spaces
- Pool, patio, deck, porch flags
- Fireplace count
- Year built, effective year built
- Tax assessment details

**Craftmatic mapping**:
- Stories -> direct `stories` value
- Exterior wall type -> `wallOverride`
- Roof type/material -> `roofType`, `osmRoofMaterial`
- Garage type -> `hasGarage` + garage size
- Pool/patio/deck -> feature flags
- Quality grade -> detail level for generation

**Recommendation**: HIGH value but $95/month cost. Overlaps significantly with Smarty
which is already integrated. Worth evaluating if Smarty gaps are significant.

---

### 3.3 BatchData

| Field | Detail |
|-------|--------|
| URL | https://developer.batchdata.com/docs/batchdata/ |
| Endpoint | `POST /api/v1/property/search` |
| Input | Address, lat/lon, or property attributes filter |
| Output | JSON with 700-1000+ attributes per property |
| Coverage | US: 155M parcels |
| Pricing | Per-record billing; flexible plans |

**Key building attributes**: Year built, sqft, stories, bedrooms, bathrooms, property type/subtype,
building size, lot size, construction type, and hundreds more.

**Craftmatic mapping**: Similar to ATTOM. Could serve as alternative data source.

**Recommendation**: LOW incremental value over Smarty + Parcl Labs already integrated.

---

### 3.4 Parcl Labs (already integrated)

Already provides: bedrooms, bathrooms, sqft, year_built, property_type, city, state, zip,
county, owner_occupied, on_market, parcl_property_id.

**Untapped capabilities**: Property search by physical characteristics, historical sales data,
rental event history. The V2 search endpoint supports filtering by building attributes.

---

### 3.5 Shovels (Building Permits)

| Field | Detail |
|-------|--------|
| URL | https://www.shovels.ai/api |
| Endpoint | Geo-based permit search by zip, city, county, or address |
| Input | Address or geographic area |
| Output | JSON with permit details, work types, values |
| Coverage | US municipalities (varies by county) |
| Pricing | Contact for pricing |

**Permit data includes**: Work type (roofing, HVAC, solar, addition, new construction),
permit value, status, filing date, contractor info.

**Craftmatic mapping**:
- Recent permits -> detect renovations/additions that may change building appearance
- Roofing permits -> newer roof material (overrides assessor data)
- Addition permits -> modified footprint
- Solar permits -> `hasSolarPanels` feature flag

**Recommendation**: LOW priority. Niche data that rarely changes generation output.

---

### 3.6 Municipal Open Data Portals

Many cities publish building permit data through open APIs:
- **NYC DOB NOW**: Construction permits, applications, violations
- **Chicago Open Data**: Permits from 2006+
- **Austin Open Data**: Issued construction permits
- **Seattle Open Data**: Building permits with project descriptions
- **HUD**: Residential construction permits by county

Available via Socrata APIs (data.gov ecosystem). Free but city-specific.

---

## 4. Street-Level Feature Detection

### 4.1 Mapillary API v4 (partially integrated)

| Field | Detail |
|-------|--------|
| URL | https://www.mapillary.com/developer/api-documentation |
| Endpoint | `https://graph.mapillary.com/{image_id}?fields=detections` |
| Input | Image ID, or spatial search by bbox/point |
| Output | JSON with detection value + base64-encoded segmentation polygon |
| Coverage | Global (crowdsourced; dense in Europe, variable elsewhere) |
| Pricing | Free with API token |

**Already integrated**: Image URL, heading, capture date, driveway/fence map features.

**Detection classes relevant to buildings** (from Mapillary Vistas, 124 classes):
- **construction** (root category): `building`, `wall`, `fence`, `guard-rail`, `bridge`, `tunnel`
- **object**: `street-light`, `utility-pole`, `traffic-sign`, `bench`, `trash-can`
- Segmentation: Per-pixel labels for `building`, `wall`, `fence`, `terrain`, `vegetation`, `sky`

**NOT available via API** (Vistas dataset only, not served through detections endpoint):
- Individual window/door detection
- Facade material classification
- Architectural style labels

**Additional untapped API features**:
- `object_detections` on images: Get all detected objects in a specific image
- Map features spatial query: Find all detected objects near a point
- Sequence traversal: Walk along a street to get multiple views of a building

**Craftmatic mapping**:
- Building segmentation mask -> facade area estimation
- Wall/fence detection near address -> `smartyHasFence`
- Vegetation density -> landscaping features
- Multiple images -> multi-view color sampling (supplement SV analysis)

**Recommendation**: MEDIUM. The segmentation data could improve facade analysis, but Mapillary
coverage is inconsistent compared to Google Street View. Best as supplementary data.

---

### 4.2 Google Street View Metadata (partially integrated)

| Field | Detail |
|-------|--------|
| URL | https://developers.google.com/maps/documentation/streetview/metadata |
| Endpoint | `https://maps.googleapis.com/maps/api/streetview/metadata?location={lat},{lng}&key=KEY` |
| Input | Lat/lon or address + API key |
| Output | JSON: { pano_id, date, location: {lat, lng}, copyright, status } |
| Pricing | Metadata requests are FREE (no quota consumed) |

**Already integrated**: `streetViewDate`, `streetViewHeading`, SV image fetching for color
extraction.

**Untapped capabilities**:
- **Panorama tiles**: Full 360 panorama at multiple resolutions via tile endpoint
- **Historical imagery**: Multiple panos at same location from different dates
- **Adjacent panos**: Walk the street to get side/rear views of a building
- **Depth map**: Some SV locations include depth information (not publicly documented API)

**Craftmatic mapping**:
- Historical dates -> track building changes over time
- Adjacent panos -> multi-angle facade analysis
- Full panorama -> rear/side view of building for more complete color extraction

---

### 4.3 KartaView (formerly OpenStreetCam)

| Field | Detail |
|-------|--------|
| URL | https://kartaview.org/ |
| API docs | https://api.openstreetcam.org/api/doc.html |
| Input | Bbox or GPS track query |
| Output | Image URLs + GPS metadata |
| Coverage | Global (crowdsourced, less dense than Mapillary) |
| Pricing | Free |

**Detection capabilities**: Signs, lanes, road curvature. Building-specific detections are NOT
exposed via the API.

**Recommendation**: VERY LOW. Less coverage and fewer features than Mapillary.

---

### 4.4 OpenFACADES (research, 2025)

Research framework (arxiv:2504.02866) for architectural attribute enrichment from street view:
- Zero-shot facade segmentation (windows, doors, balconies, columns)
- Material classification from street-level images
- Style labeling (Victorian, Colonial, Modern, etc.)

Not a production API, but the approach could be implemented client-side with lightweight models.

---

## 5. Photogrammetry / Structure from Motion

### 5.1 COLMAP

| Field | Detail |
|-------|--------|
| URL | https://colmap.github.io/ |
| Input | Multiple images of same scene |
| Output | Sparse point cloud -> dense point cloud -> mesh (Poisson/Delaunay) |
| License | BSD (open source) |
| Requires | GPU (CUDA), significant compute time |

**Pipeline**: Image loading -> feature extraction (SIFT) -> feature matching -> SfM
(incremental) -> multi-view stereo -> depth fusion -> surface reconstruction.

**Can it reconstruct a building from SV images?** YES, with caveats:
- Need 5-20+ images with sufficient overlap (30-60%)
- Google SV provides multiple headings per pano, and adjacent panos along streets
- Quality depends on coverage: front facade will be good, rear/sides may be sparse
- Street-level images have limited elevation angles -- roofs will be poorly reconstructed

**Feasibility for Craftmatic**: Could extract facade depth profile + window positions from
front-view reconstruction. NOT practical for real-time browser use -- requires server-side
GPU processing taking minutes per building.

---

### 5.2 OpenSfM

| Field | Detail |
|-------|--------|
| URL | https://opensfm.org/ |
| Input | Directory of images with EXIF GPS data |
| Output | Sparse reconstruction (cameras + point cloud), optional dense mesh |
| License | BSD (open source, Python + C++) |

**Advantages over COLMAP**: Python API, easier integration, used by OpenDroneMap.
**Disadvantages**: Less accurate dense reconstruction than COLMAP.

Street View images contain GPS metadata which OpenSfM can use for initialization, potentially
making reconstruction faster than pure COLMAP.

---

### 5.3 Meshroom (AliceVision)

| Field | Detail |
|-------|--------|
| URL | https://alicevision.org/ |
| Input | Multiple images |
| Output | Textured 3D mesh |
| License | MPL2 (open source) |
| Requires | NVIDIA GPU |

Similar capabilities to COLMAP with a GUI-based pipeline. Node-based workflow is harder to
automate than COLMAP/OpenSfM CLIs.

---

### 5.4 Photogrammetry Summary for Craftmatic

**Practical approach**: Use Google Earth Studio (free) to capture an orbital video of a building
at known coordinates, then run GBM (Gaussian Building Mesh) pipeline to extract a clean 3D mesh.
This gives:
- Accurate building dimensions (width, length, height)
- Roof shape and pitch
- Wall/roof material appearance

**Server-side batch pipeline**: For each address, queue a photogrammetry job that:
1. Fetches 8-16 SV images at varying headings
2. Runs lightweight SfM (OpenSfM) for camera poses
3. Extracts building facade plane + depth
4. Maps to PropertyData: dimensions, roof pitch, window positions

**Browser-side**: NOT feasible. These tools require GPU compute and produce multi-GB
intermediate data.

---

## 6. Integration Priority Matrix

| Source | Value for Craftmatic | Implementation Effort | Cost | Priority |
|--------|--------------------|-----------------------|------|----------|
| Overture Maps (DuckDB) | Very High | Medium (server proxy) | Free | **P0** |
| Cesium OSM Buildings | High | Low (already have 3d-tiles-renderer) | Free | **P0** |
| Google Solar API | Already integrated | -- | Free tier | Done |
| Smarty untapped fields | Medium | Very Low (already integrated) | Existing | **P1** |
| GlobalBuildingAtlas | Medium-High | Medium (bulk download) | Free | **P1** |
| OpenCityModel (US LOD1) | Medium | Medium (S3 + DuckDB) | Free | **P2** |
| ATTOM Data | High | Medium | $95/mo | **P2** |
| Regrid parcels | Medium | Low | Free tier | **P2** |
| Mapillary segmentation | Medium | Low (extend existing) | Free | **P2** |
| SV multi-angle analysis | Medium | Medium | Existing key | **P2** |
| SfM reconstruction | High | Very High (server GPU) | GPU cost | **P3** |
| CityGML LOD2 cities | Medium | High (per-city ETL) | Free | **P3** |
| Shovels permits | Low | Low | Paid | **P3** |
| HERE 3D buildings | Low | Medium | Free tier | **P3** |

---

## 7. Recommended New PropertyData Fields

Based on this research, the following new fields could enhance generation accuracy:

```typescript
// ─── From Overture Maps / Cesium OSM Buildings ─────────────────────────
/** Building height in meters from authoritative source (Overture/Cesium) */
overtureHeight?: number;
/** Number of underground floors (Overture) */
undergroundFloors?: number;
/** Roof height above wall plate in meters */
roofHeight?: number;
/** Roof orientation/direction in degrees */
roofDirection?: number;
/** Data source provenance + confidence for footprint */
footprintSource?: { dataset: string; confidence: number };

// ─── From Regrid Parcel Data ───────────────────────────────────────────
/** Parcel boundary polygon (for yard/setback generation) */
parcelPolygon?: { lat: number; lon: number }[];
/** Zoning classification */
zoning?: string;
/** Land use code */
landUse?: string;

// ─── From ATTOM / Enhanced Smarty ──────────────────────────────────────
/** Building quality grade (1-6 scale) */
qualityGrade?: number;
/** Effective year built (accounts for major renovation) */
effectiveYearBuilt?: number;
/** Number of parking spaces */
parkingSpaces?: number;
/** Heating/cooling system type (affects chimney) */
heatingType?: string;
/** Window type description */
windowType?: string;

// ─── From SfM / Enhanced SV Analysis ───────────────────────────────────
/** Facade depth profile from multi-view analysis */
facadeDepthProfile?: number[];
/** Window positions from facade analysis [x, y, width, height][] */
windowPositions?: [number, number, number, number][];
/** Detected architectural elements (columns, balconies, dormers) */
architecturalElements?: string[];
```

---

## 8. Recommended Next Steps

1. **Overture Maps proxy**: Build a lightweight server endpoint (or Cloudflare Worker) that
   accepts lat/lon + radius and returns building features via DuckDB query against Overture
   GeoParquet on S3. This replaces/supplements Overpass with richer data.

2. **Cesium OSM Buildings integration**: Use existing `3d-tiles-renderer` to load Cesium OSM
   Buildings tileset (asset 96188), raycast at target coordinates, and extract per-building
   metadata. This provides structured building attributes without Overpass latency.

3. **Smarty field expansion**: Audit all available Smarty property fields and map additional
   ones to PropertyData (heating type, parking, window type, year remodeled).

4. **Multi-angle SV analysis**: Fetch 3-4 SV images at different headings for the same building
   to get front + side views. Extract colors and structural features from multiple angles.

5. **Overture fallback chain**: When OSM Overpass returns no building at coordinates, fall back
   to Overture Maps which includes Microsoft + Google ML footprints for areas with poor OSM
   coverage.
