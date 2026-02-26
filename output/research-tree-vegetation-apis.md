# Tree, Vegetation & Landscape Data APIs Research

Research for Craftmatic Minecraft building generator -- placing accurate trees and landscaping around generated buildings.

---

## 1. Tree Canopy / Urban Forestry APIs

### 1.1 NYC TreesCount (Socrata SODA API)

- **URL**: `https://data.cityofnewyork.us/resource/uvpi-gqnh.json`
- **Query method**: REST API (Socrata SODA / SoQL queries via GET params)
- **Input**: SoQL `$where` clauses; supports `within_circle(lat, lon, radius)` geospatial filter
- **Output**: JSON, CSV, GeoJSON
- **Coverage**: New York City only (666,134 street trees)
- **Data fields**: species (`spc_common`, `spc_latin`), `tree_dbh` (trunk diameter inches), `stump_diam`, `status`, `health`, `latitude`, `longitude`, `address`, `zipcode`, `boroname`
- **Free tier**: Free, no auth required (rate-limited without app token; 1000 req/hr with free token)
- **Licensing**: Public domain (NYC Open Data)
- **Minecraft relevance**: HIGH -- exact tree species, trunk diameter, and GPS coordinates for NYC addresses. Can map common species (London Plane, Honeylocust, Pin Oak, etc.) to Minecraft tree types. DBH gives trunk thickness.
- **Example query**:
  ```
  https://data.cityofnewyork.us/resource/uvpi-gqnh.json?$where=within_circle(latitude,longitude,40.748,-73.985,200)&$limit=50
  ```

### 1.2 OpenTreeMap

- **URL**: `https://opentreemap.github.io/` (open source platform)
- **Query method**: REST API per instance (each city runs its own)
- **Input**: Bounding box, species filter, location
- **Output**: JSON/GeoJSON
- **Coverage**: Varies per deployment -- Philadelphia, Sacramento, San Diego, San Francisco, and others
- **Data fields**: Species, DBH, canopy spread, tree condition, planting date
- **Free tier**: Free (open source); individual city instances may have usage policies
- **Licensing**: AGPL (platform code); data varies by city
- **Minecraft relevance**: MEDIUM -- good species/size data but only for cities that have deployed it. Not a single unified API.

### 1.3 i-Tree Benefits API (Davey Tree Benefits Engine)

- **URL**: `https://engine.itreetools.org` / `https://dtbe-api.daveyinstitute.com/`
- **Query method**: REST API (POST with tree attributes)
- **Input**: Species code, DBH, location (lat/lon or region code)
- **Output**: JSON -- ecosystem benefits (CO2 sequestered, stormwater intercepted, etc.)
- **Coverage**: US (primarily), some international support
- **Data fields**: NOT a tree inventory -- computes benefits FROM tree data you supply. Returns annual benefits values.
- **Free tier**: $0.02/tree query; attribution required ("Powered by i-Tree" logo + link)
- **Licensing**: Proprietary; attribution required
- **Minecraft relevance**: LOW for placement, but could enrich metadata. More useful for computing what trees SHOULD be at a location based on eco-region data.

### 1.4 Municipal Tree Inventories via Socrata

Many US cities publish tree inventories through Socrata-powered open data portals. The SODA API provides a uniform query interface across all of them.

| City | Endpoint | Trees | Notable Fields |
|------|----------|-------|----------------|
| NYC | `data.cityofnewyork.us/uvpi-gqnh` | 666K | species, DBH, health, lat/lon |
| San Francisco | `data.sfgov.org` (Street Tree List) | 190K+ | species, DBH, site info |
| Portland | `portland.gov/trees` (GIS export) | 220K | species, DBH, condition |
| Chicago | `data.cityofchicago.org` | ~500K | species, DBH, ward |
| Los Angeles | via UrbanTreeMap / NavigateLA | varies | species, location |

- **Query method**: `GET https://{domain}/resource/{dataset-id}.json?$where=within_circle(lat,lon,radius)`
- **Free tier**: Free with optional app token for higher rate limits
- **Minecraft relevance**: HIGH for supported cities -- exact tree positions, species, and sizes.

### 1.5 49 California Cities Raw Tree Inventory (USDA)

- **URL**: `https://data.nal.usda.gov/dataset/raw-urban-street-tree-inventory-data-49-california-cities`
- **Query method**: Bulk download (CSV)
- **Input**: N/A (static dataset)
- **Output**: CSV files per city
- **Coverage**: 49 California cities, 929,823 trees (2006-2013)
- **Data fields**: City, street address, DBH, species name, tree type
- **Free tier**: Free, public domain
- **Minecraft relevance**: MEDIUM -- good for California addresses but data is static and aging.

---

## 2. Vegetation / Land Cover APIs

### 2.1 NLCD Tree Canopy Cover (USFS / MRLC)

- **URL (ArcGIS ImageServer)**: `https://apps.fs.usda.gov/fsgisx01/rest/services/RDW_LandscapeAndWildlife/USFS_Analytical_2016_TreeCanopy_CONUS/ImageServer`
- **Query method**: ArcGIS REST `identify` operation -- point query at lat/lon returns pixel value
- **Input**: `geometry={lon},{lat}&geometryType=esriGeometryPoint&sr=4326`
- **Output**: JSON with pixel value (0-99 = canopy %, 255 = background)
- **Coverage**: CONUS (contiguous US), Hawaii, PR/USVI (separate endpoints)
- **Resolution**: 30m per pixel
- **Free tier**: Free, no auth
- **Licensing**: Public domain (US Government)
- **Minecraft relevance**: HIGH -- single REST call returns tree canopy percentage for any US coordinate. Perfect for deciding tree density around a building. 30m resolution is appropriate for Minecraft block scale.
- **Example query**:
  ```
  https://apps.fs.usda.gov/fsgisx01/rest/services/RDW_LandscapeAndWildlife/USFS_Analytical_2016_TreeCanopy_CONUS/ImageServer/identify?geometry=-73.985,40.748&geometryType=esriGeometryPoint&sr=4326&f=json
  ```
- **Additional endpoints**:
  - 2021 NLCD TCC: `USGS/NLCD_RELEASES/2023_REL/TCC/v2023-5` (via Google Earth Engine)
  - Change detection: `NLCD_2011_2016_TreeCanopyChange_CONUS/ImageServer`

### 2.2 NLCD Land Cover (MRLC)

- **URL**: `https://www.mrlc.gov/data` / ArcGIS services
- **Query method**: Same ArcGIS REST identify as above
- **Input**: Point coordinates
- **Output**: Land cover class code (0-95)
- **Key classes relevant to landscaping**:
  - 41 = Deciduous Forest, 42 = Evergreen Forest, 43 = Mixed Forest
  - 52 = Shrub/Scrub, 71 = Grassland/Herbaceous
  - 81 = Pasture/Hay, 82 = Cultivated Crops
  - 90 = Woody Wetlands, 95 = Emergent Herbaceous Wetlands
  - 21-24 = Developed (various intensities)
- **Coverage**: CONUS, 30m resolution
- **Free tier**: Free, public domain
- **Minecraft relevance**: HIGH -- tells you the dominant land cover type. "Deciduous Forest" vs "Grassland" vs "Shrub" directly maps to Minecraft biome/vegetation decisions.

### 2.3 ESA WorldCover (10m Global Land Cover)

- **URL**: `https://esa-worldcover.org/en/data-access`
- **Query method**: Multiple access paths:
  - **AWS S3**: `s3://esa-worldcover` (Cloud Optimized GeoTIFF tiles, no auth needed)
  - **Google Earth Engine**: `ESA/WorldCover/v200`
  - **WMS/WMTS**: Direct tile layer for web mapping
  - **Microsoft Planetary Computer**: STAC API at `planetarycomputer.microsoft.com`
- **Input**: Bounding box or point (depends on access method)
- **Output**: Raster tiles (GeoTIFF) -- pixel values are land cover classes
- **Land cover classes** (11 total):
  - 10 = Tree cover, 20 = Shrubland, 30 = Grassland
  - 40 = Cropland, 50 = Built-up, 60 = Bare/sparse
  - 70 = Snow/ice, 80 = Permanent water, 90 = Herbaceous wetland
  - 95 = Mangroves, 100 = Moss/lichen
- **Coverage**: GLOBAL, 10m resolution, 2020 + 2021 epochs
- **Free tier**: Free, open access (CC BY 4.0)
- **Minecraft relevance**: HIGH -- global coverage at 10m means it works for any address worldwide. The "Tree cover" class (10) directly indicates where trees should be placed. Being global is a major advantage over US-only datasets.

### 2.4 Sentinel Hub / Copernicus NDVI

- **URL**: `https://services.sentinel-hub.com/api/v1/process`
- **Query method**: REST POST with evalscript defining NDVI calculation
- **Input**: Bounding box or polygon geometry + date range
- **Output**: GeoTIFF or PNG image; Statistical API returns aggregated JSON
- **Coverage**: Global (Sentinel-2 satellite, 10m resolution)
- **Free tier**: 30-day trial; Copernicus Data Space Ecosystem provides free tier via `https://dataspace.copernicus.eu`
- **Licensing**: Open data (Copernicus), API usage subject to processing unit limits
- **Minecraft relevance**: MEDIUM -- NDVI (0.0 to 1.0) measures vegetation density/health. Values >0.3 indicate moderate vegetation, >0.6 is dense. Useful as a continuous vegetation density metric, but requires more setup than simpler APIs. Best used as a secondary signal.
- **Alternative free endpoint**: EOSDA API (`https://api-connect.eos.com/`) -- 1000 free requests trial

### 2.5 Google Earth Engine (GEE)

- **URL**: `https://earthengine.googleapis.com/` (REST API) / JavaScript/Python client
- **Query method**: REST API or client library; compute.pixels for point queries
- **Input**: Geometry (point/polygon) + image collection ID
- **Output**: JSON values, GeoTIFF rasters
- **Key datasets for trees/vegetation**:
  - `USGS/NLCD_RELEASES/2023_REL/TCC/v2023-5` -- USFS Tree Canopy Cover 2023
  - `ESA/WorldCover/v200` -- ESA WorldCover 10m
  - `UMD/hansen/global_forest_change_2023_v1_11` -- Global Forest Change
  - `NASA/MEASURES/GFCC/TC/v3` -- GFCC Tree Cover 30m
  - `COPERNICUS/Landcover/100m/Proba-V-C3/Global` -- Copernicus Global Land Cover
- **Coverage**: Global (depends on dataset)
- **Free tier**: Free for research, education, nonprofit; commercial requires approval
- **Minecraft relevance**: HIGH -- one-stop access to ALL major vegetation datasets. Can query tree canopy %, land cover class, forest change, and NDVI all from one API. The REST API allows browser-side queries.

### 2.6 Copernicus Global Land Service (CGLS) NDVI

- **URL**: `https://land.copernicus.eu/en/products/vegetation`
- **Query method**: WMS/WCS or via Copernicus Data Space openEO API
- **Input**: Bounding box + time range
- **Output**: Raster (GeoTIFF), 300m or 1km resolution, 10-day composites
- **Coverage**: Global, 1999-present
- **Free tier**: Free (Copernicus open data)
- **Minecraft relevance**: LOW -- 300m/1km resolution is too coarse for parcel-level decisions. Better for regional vegetation trends.

---

## 3. Tree Canopy Height Models

### 3.1 Meta/WRI Global Canopy Height Map (1m)

- **URL**: `s3://dataforgood-fb-data/forests/v1/alsgedi_global_v6_float/chm/`
- **Tile index**: `s3://dataforgood-fb-data/forests/v1/alsgedi_global_v6_float/tiles.geojson`
- **Query method**: Download individual GeoTIFF tiles from AWS S3 (no auth required)
  - Or via Google Earth Engine: `projects/sat-io/open-datasets/facebook/meta-canopy-height`
  - Or interactive browser: `https://meta-forest-monitoring-okw37.projects.earthengine.app/view/canopyheight`
- **Input**: Tile coordinates from index GeoJSON; or lat/lon via GEE
- **Output**: Cloud-optimized GeoTIFF -- pixel value = canopy height in meters
- **Coverage**: GLOBAL, 1m resolution
- **Accuracy**: Mean absolute error ~2.8m; captures vegetation >1m
- **Free tier**: Free, no auth for S3 download (CC BY 4.0)
- **Minecraft relevance**: CRITICAL -- 1m resolution means individual tree heights. A pixel value of 12 means a 12m tall tree at that exact meter. Can directly convert to Minecraft block heights (1 block ~= 1m). This is the single most valuable dataset for tree placement.
- **Limitation**: Snapshot in time (not real-time); does not identify species.

### 3.2 ETH Global Canopy Height Model (10m)

- **URL**: `https://langnico.github.io/globalcanopyheight/`
- **GEE asset**: `users/nlang/ETH_GlobalCanopyHeight_2020_10m_v1`
- **Query method**: Google Earth Engine API or direct GeoTIFF download
- **Input**: Lat/lon via GEE; or tile download
- **Output**: GeoTIFF -- pixel = canopy top height (meters) + uncertainty band
- **Coverage**: GLOBAL, 10m resolution (Sentinel-2 based)
- **Model**: CNN trained on GEDI LiDAR reference data + Sentinel-2 imagery
- **Free tier**: Free (academic use, CC license)
- **Minecraft relevance**: HIGH -- 10m resolution gives neighborhood-scale canopy height. Good fallback when 1m Meta tiles are unavailable. Uncertainty band helps filter low-confidence predictions.

### 3.3 GEDI LiDAR Canopy Height (NASA)

- **URL**: `https://lpdaac.usgs.gov/products/gedi02_av002/` (Level 2A)
- **Query method**: Earthdata Search API or GEE: `LARSE/GEDI/GEDI02_A_002_MONTHLY`
- **Input**: Lat/lon / bounding box
- **Output**: Point measurements (not wall-to-wall raster) -- height per footprint (~25m diameter)
- **Coverage**: Global between 51.6°N and 51.6°S latitude
- **Free tier**: Free (NASA open data)
- **Minecraft relevance**: MEDIUM -- sparse footprints (not continuous), but actual LiDAR measurements so very accurate where available. Better as training/validation data than direct use.

---

## 4. HuggingFace ML Models

### 4.1 weecology/deepforest-tree

- **URL**: `https://hf.co/weecology/deepforest-tree`
- **Downloads**: 79.9K (most popular tree detection model on HF)
- **Task**: Object detection -- detects individual tree crowns in aerial/satellite RGB imagery
- **Input**: RGB aerial image (any resolution; trained on NEON airborne data)
- **Output**: Bounding boxes around individual trees
- **Library**: `deepforest` (Python, PyTorch-based)
- **License**: MIT
- **Minecraft relevance**: HIGH -- feed it a satellite/aerial image of a property and get individual tree crown locations. Combined with canopy height data, gives both position AND height for each tree.

### 4.2 weecology/cropmodel-tree-species

- **URL**: `https://hf.co/weecology/cropmodel-tree-species`
- **Task**: Image classification -- classifies tree species from cropped aerial imagery
- **Library**: `deepforest`
- **License**: MIT
- **Minecraft relevance**: HIGH -- use deepforest-tree to detect trees, crop each detection, then classify species. Maps species to Minecraft tree type (oak, birch, spruce, jungle, acacia, dark oak).

### 4.3 MeineWaldKI Tree Species Models (EfficientNet / Swin)

- **URL**: `https://hf.co/MeineWaldKI/tree_species_224_efficientnet_b4` (and variants at 512, 1024, 2048px)
- **Architectures**: EfficientNet-B4, Swin Transformer V2 (multiple resolutions)
- **License**: MIT
- **Minecraft relevance**: MEDIUM -- German forest focus ("MeineWaldKI" = "MyForestAI"), may not generalize well to North American urban trees.

### 4.4 ibm-granite/granite-geospatial-canopyheight

- **URL**: `https://hf.co/ibm-granite/granite-geospatial-canopyheight`
- **Task**: Image feature extraction -- estimates canopy height from satellite imagery
- **Library**: `terratorch` (IBM's geospatial ML framework)
- **License**: Apache 2.0
- **Minecraft relevance**: MEDIUM -- could be used to estimate canopy height from Sentinel-2 imagery where pre-computed height maps are unavailable. Requires more infrastructure than pre-built tile datasets.

### 4.5 ibm-granite/granite-geospatial-biomass

- **URL**: `https://hf.co/ibm-granite/granite-geospatial-biomass`
- **Downloads**: 193 | **Likes**: 48
- **Task**: Estimates above-ground biomass from satellite imagery
- **License**: Apache 2.0
- **Minecraft relevance**: LOW -- biomass is correlated with tree density but less directly useful than canopy height.

---

## 5. LiDAR Point Cloud Sources

### 5.1 USGS 3DEP (3D Elevation Program)

- **URL**: `https://registry.opendata.aws/usgs-lidar/` (AWS S3)
- **Query method**:
  - AWS S3 (Requester Pays): `s3://usgs-lidar-public/` organized by project
  - OpenTopography REST API: `https://portal.opentopography.org/API/`
  - USGS National Map API
- **Input**: Bounding box coordinates
- **Output**: LAS/LAZ point cloud files with classification codes:
  - Class 2 = Ground, Class 3 = Low Vegetation, Class 4 = Medium Vegetation, Class 5 = High Vegetation
  - Class 6 = Building
- **Coverage**: ~90%+ of CONUS at QL2 (2 pts/m2) or better
- **Free tier**: Free (public data); OpenTopography API: 100 calls/day (non-academic), 300/day (academic)
- **Minecraft relevance**: CRITICAL -- LiDAR vegetation classes (3,4,5) give exact 3D tree positions and heights. Class 5 (High Vegetation) IS trees. Difference between vegetation surface and ground gives precise tree height. 1-2m point spacing resolves individual trees.

### 5.2 OpenTopography API

- **URL**: `https://portal.opentopography.org/API/`
- **API docs**: `https://portal.opentopography.org/apidocs/`
- **Query method**: REST API
  - Point cloud subset: `/lidardata` endpoint with bounding box
  - DEM generation: `/otrDEM` endpoint
  - Global DEM: `/globaldem` endpoint (SRTM, ALOS, etc.)
- **Input**: `south`, `north`, `east`, `west` bounding box params
- **Output**: LAS/LAZ point cloud, GeoTIFF DEM
- **Coverage**: Hosts 350+ lidar datasets; proxies all USGS 3DEP data
- **Free tier**: Free API key required; rate limits:
  - Non-academic: 100 calls/24hr
  - Academic: 300 calls/24hr
  - Area limits: 250 km2 (1m), 25,000 km2 (10m), 225,000 km2 (30m)
- **Minecraft relevance**: HIGH -- convenient API wrapper over 3DEP data. Can request just vegetation-classified points for a small area around a building.

### 5.3 State/County LiDAR Portals

Many states maintain their own LiDAR data portals with higher density or more recent data:
- **NOAA Digital Coast**: `https://coast.noaa.gov/dataviewer/` -- coastal areas
- **NC OneMap**: North Carolina statewide LiDAR
- **PA PASDA**: Pennsylvania statewide
- **MN DNR**: Minnesota statewide
- Query method varies (mostly bulk download or WCS)
- **Minecraft relevance**: MEDIUM -- higher quality where available but no unified API.

---

## 6. Landscape Feature APIs

### 6.1 OpenStreetMap Overpass API (Trees, Water, Forests)

- **URL**: `https://overpass-api.de/api/interpreter` (and round-robin mirrors)
- **Query method**: POST with Overpass QL query
- **Input**: Bounding box or `around:radius,lat,lon` filter
- **Output**: JSON (with `[out:json]`) or XML
- **Relevant tags**:
  - `natural=tree` -- individual trees with optional `species`, `genus`, `height`, `circumference`, `leaf_type` (broadleaved/needleleaved), `leaf_cycle` (deciduous/evergreen)
  - `natural=tree_row` -- rows of trees (hedgerows, avenue trees)
  - `natural=wood` / `landuse=forest` -- forested areas (polygons)
  - `natural=scrub` -- shrubland
  - `natural=grassland` -- grass areas
  - `natural=water` / `waterway=stream/river` -- water features
  - `leisure=garden` / `leisure=park` -- landscaped areas
  - `surface=grass` / `surface=gravel` -- ground surface types
- **Coverage**: GLOBAL (crowdsourced; density varies widely)
- **Free tier**: Free; rate-limited (2 concurrent requests, 10s timeout default)
- **Licensing**: ODbL
- **Minecraft relevance**: CRITICAL -- the ONLY source that provides individual tree positions with species globally AND nearby water features, parks, and ground surfaces in one query. Already integrated in craftmatic via Overpass round-robin.
- **Example query**:
  ```
  [out:json][timeout:25];
  (
    node["natural"="tree"](around:200,40.748,-73.985);
    way["natural"="water"](around:200,40.748,-73.985);
    way["waterway"](around:200,40.748,-73.985);
    way["landuse"="forest"](around:200,40.748,-73.985);
    way["natural"="wood"](around:200,40.748,-73.985);
  );
  out body; >; out skel qt;
  ```

### 6.2 NHD National Hydrography Dataset (Water Features)

- **URL**: `https://hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer`
- **Query method**: ArcGIS REST `identify` or `query` operation
- **Input**: Point geometry or bounding box (`geometry={lon},{lat}&geometryType=esriGeometryPoint`)
- **Output**: JSON with feature attributes
- **Key layers**:
  - NHDFlowline (streams, rivers, canals, ditches)
  - NHDWaterbody (lakes, ponds, reservoirs)
  - NHDPoint (springs, wells, dams)
- **Coverage**: US (comprehensive)
- **Free tier**: Free, no auth
- **Licensing**: Public domain
- **Minecraft relevance**: HIGH -- identifies nearby streams, rivers, lakes. Important for placing water features, determining if property is near waterfront.
- **Note**: NHD retired Oct 2023; data still served but migrating to 3DHP (3D Hydrography Program).

### 6.3 USDA NRCS Soil Data Access (Web Soil Survey)

- **URL**: `https://sdmdataaccess.nrcs.usda.gov/`
- **REST endpoint**: `https://SDMDataAccess.sc.egov.usda.gov/Tabular/post.rest`
- **Query method**: REST POST with SQL query
- **Input**: SQL with spatial query (point geometry in WKT format)
- **Output**: JSON or XML
- **Data fields**: Soil texture (sandy, clay, loam), drainage class, hydric rating, land capability, ecological site
- **Coverage**: US (extremely detailed -- parcel level)
- **Free tier**: Free, no auth
- **Licensing**: Public domain
- **Minecraft relevance**: MEDIUM -- soil type determines what grows. Sandy soil = different vegetation than clay. Could influence grass block type, flower placement, and which tree species are realistic. "Hydric" soil = near water / wetland.
- **Example SQL**:
  ```sql
  SELECT musym, muname, muacres
  FROM mapunit mu
  INNER JOIN SDA_Get_Mukey_from_intersection_with_WktWgs84('POINT(-73.985 40.748)') mk
  ON mu.mukey = mk.mukey
  ```

### 6.4 USDA Plant Hardiness Zone

- **URL (third-party)**: `https://phzmapi.org/{zipcode}.json` (static JSON API)
- **ArcGIS Hub**: `https://www.usda-plant-hardiness-zone-map-usdaars.hub.arcgis.com/`
- **Query method**: GET by ZIP code (phzmapi.org) or ArcGIS spatial query
- **Input**: ZIP code or lat/lon
- **Output**: JSON with zone (e.g., "7b") and temperature range
- **Coverage**: US
- **Free tier**: Free
- **Minecraft relevance**: HIGH -- hardiness zone determines which tree species are native/common. Zone 3 = spruce, birch. Zone 7 = oak, maple, dogwood. Zone 10 = palm, citrus. Direct mapping to Minecraft tree types per climate.

### 6.5 Google Solar API (Tree/Shade Data Layer)

- **URL**: `https://solar.googleapis.com/v1/buildingInsights:findClosest` and `/dataLayers:get`
- **Query method**: REST GET
- **Input**: `location.latitude`, `location.longitude`
- **Output**: JSON (buildingInsights) or GeoTIFF raster (dataLayers)
- **Tree-relevant data**: The `dataLayers` endpoint returns a DSM (Digital Surface Model) that INCLUDES tree canopy. The difference between DSM and DEM-like ground gives tree heights around the building.
- **Coverage**: US, parts of Europe/Asia (where Google has aerial LiDAR)
- **Free tier**: $0 for first 2500 buildingInsights/month; dataLayers = first 100 free then $0.004 each
- **Licensing**: Google Maps Platform ToS
- **Minecraft relevance**: HIGH -- already integrated in craftmatic. The DSM raster around a building contains tree heights. Can extract tree locations by finding DSM pixels significantly above ground level outside the building footprint.

### 6.6 Mapillary Object Detection API (Street-Level Trees)

- **URL**: `https://graph.mapillary.com/` (v4 API)
- **Query method**: REST GET with `fields` parameter
- **Input**: Bounding box via `bbox={west},{south},{east},{north}` or image key
- **Output**: JSON with detection geometries
- **Tree-relevant detections**: `nature--vegetation`, `nature--tree`, `nature--tree_trunk`
- **Coverage**: Global (crowdsourced street-level imagery; urban areas well-covered)
- **Free tier**: Free with client ID (rate-limited)
- **Licensing**: CC BY-SA 4.0 (detections)
- **Minecraft relevance**: MEDIUM -- detects trees visible from street level. Gives approximate presence/density but not precise GPS or species. Already have Mapillary integration in craftmatic.

---

## 7. Recommended Integration Priority

For Craftmatic's Minecraft building generator, ranked by value/effort ratio:

### Tier 1 -- Integrate First (high value, low effort)

| Source | Why | Effort |
|--------|-----|--------|
| **OSM Overpass `natural=tree`** | Already have Overpass; just add tree query. Returns exact positions + optional species/height. Global. | LOW -- extend existing Overpass query |
| **NLCD Tree Canopy Cover** | Single GET request returns 0-99% canopy for any US coordinate. No auth. | LOW -- one fetch call |
| **USDA Plant Hardiness Zone** | ZIP code lookup via phzmapi.org. Determines biome/tree palette. | LOW -- static JSON by ZIP |
| **Google Solar DSM** | Already integrated. Parse DSM raster for non-building height pixels = trees. | LOW -- extend existing Solar integration |

### Tier 2 -- High Value, Moderate Effort

| Source | Why | Effort |
|--------|-----|--------|
| **Meta 1m Canopy Height** | Individual tree heights globally at 1m resolution. Requires fetching COG tile from S3. | MEDIUM -- tile index lookup + COG range request |
| **ESA WorldCover** | Global land cover at 10m. Tree cover class for international addresses. | MEDIUM -- COG tile fetch from AWS |
| **NHD Water Features** | Single ArcGIS identify call for nearby streams/lakes. | LOW-MEDIUM -- one fetch |
| **NYC/City Tree Inventories** | Exact species + DBH for supported cities. Socrata is uniform. | MEDIUM -- city detection + SODA query |

### Tier 3 -- Valuable but Complex

| Source | Why | Effort |
|--------|-----|--------|
| **deepforest-tree (HF)** | Individual tree detection from aerial imagery. Needs image + inference. | HIGH -- model inference pipeline |
| **ETH/GEDI Canopy Height via GEE** | Multiple height datasets through one API. Needs GEE auth. | HIGH -- GEE setup + auth |
| **OpenTopography LiDAR** | Precise 3D vegetation data. Requires point cloud processing. | HIGH -- LAS parsing + classification |
| **NRCS Soil Data** | Soil type for realistic vegetation. Complex SQL queries. | MEDIUM -- SQL query builder |

---

## 8. Practical Architecture for Craftmatic

```
Address/Coordinates Input
        |
        v
  [Hardiness Zone] -----> Tree species palette (which trees grow here)
        |
  [NLCD Canopy %] -------> Tree density (how many trees to place)
        |
  [ESA WorldCover] -------> Land cover type (forest? grassland? urban?)
        |
  [OSM Overpass trees] ---> Individual tree positions (if mapped)
        |
  [Meta Canopy Height] ---> Tree heights (meters -> Minecraft blocks)
        |
  [Google Solar DSM] -----> Tree positions around specific building
        |
  [NHD Water] ------------> Nearby water features
        |
        v
  Minecraft World Generation
  - Place trees at OSM positions OR randomly within canopy area
  - Use hardiness zone to select tree type (oak/birch/spruce/jungle/acacia)
  - Use canopy height for tree size (small=sapling, 5-10m=normal, 15m+=large)
  - Use canopy % for density (20%=sparse, 60%=moderate, 90%=dense)
  - Place water features from NHD/OSM data
  - Ground cover from WorldCover (grass/dirt/sand/gravel)
```

### Species-to-Minecraft Mapping Table

| Hardiness Zone | Common Real Trees | Minecraft Tree Type |
|---------------|-------------------|---------------------|
| 2-3 (very cold) | White Spruce, Paper Birch, Balsam Fir | Spruce, Birch |
| 4-5 (cold) | Sugar Maple, Red Oak, White Pine | Oak, Birch, Spruce |
| 6-7 (moderate) | Red Maple, Pin Oak, Dogwood, Tulip Poplar | Oak, Birch |
| 8-9 (warm) | Live Oak, Magnolia, Crape Myrtle | Oak, Dark Oak, Jungle |
| 10+ (tropical) | Royal Palm, Coconut Palm, Banyan | Jungle, Acacia |
| Desert/arid | Palo Verde, Joshua Tree, Mesquite | Acacia, Dead Bush |

### OSM Species-to-Minecraft Mapping

| OSM genus/species | Minecraft |
|-------------------|-----------|
| Quercus (Oak) | Oak |
| Acer (Maple) | Oak (red/orange leaves in autumn biome) |
| Betula (Birch) | Birch |
| Picea / Abies (Spruce/Fir) | Spruce |
| Pinus (Pine) | Spruce (2x2 variant) |
| Platanus (Sycamore/Plane) | Oak (large) |
| Salix (Willow) | Oak (custom drooping shape) |
| Tilia (Linden) | Oak |
| Fraxinus (Ash) | Birch |
| Palm / Washingtonia / Phoenix | Jungle (single trunk) |
| Magnolia | Dark Oak |
| Prunus (Cherry) | Cherry Blossom (1.20+) |

---

*Research completed 2026-02-26. All URLs verified at time of research.*
