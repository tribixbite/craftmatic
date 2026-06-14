# Architecture

> Craftmatic — address-to-Minecraft schematic pipeline. Fully static SPA + CLI, MIT license.

## Answers to Common Questions

| Question | Answer |
|----------|--------|
| **Schematic parser?** | Custom NBT code + `prismarine-nbt` (MIT). NOT prismarine-schematic or Nucleation. |
| **Three.js renderer?** | Custom hand-rolled scene builder with `InstancedMesh` per block type. NOT SchematicWebViewer or prismarine-viewer. |
| **What generates structures?** | Procedural TypeScript generator — 10 structure types, 11 style decorators, 30 room types. No AI API calls for generation. |
| **Address → building?** | Geocode → 20+ API enrichment (Parcl, Smarty, OSM, Mapbox, Solar, Street View, VLM, Overture, elevation, canopy, landcover, water) → `convertToGenerationOptions()` → procedural BlockGrid. |
| **Texture source?** | 334 bundled PNGs at 32×32 (Faithful 32x) + `ProceduralAtlas` fallback (10 pattern types, seeded PRNG). |
| **Backend?** | None. Fully static SPA deployed to GitHub Pages. All API calls are client-side `fetch()` from the browser. CLI runs locally via Bun. |
| **License?** | MIT (project). Textures: CC-BY-SA (Faithful 32x). |

---

## Module Layout

```
src/                              # CLI + shared generation core
├── index.ts                      # Public API re-exports
├── cli.ts                        # Commander CLI (6 commands + default)
├── nbt/
│   ├── reader.ts                 # NBT parsing via prismarine-nbt
│   └── writer.ts                 # NBT binary writer (Big Endian)
├── schem/
│   ├── types.ts                  # BlockGrid class (3D voxel grid, YZX order)
│   ├── parse.ts                  # .schem → SchematicData → BlockGrid
│   ├── write.ts                  # BlockGrid → .schem (Sponge Schematic v2)
│   └── varint.ts                 # Varint encode/decode for block palette
├── blocks/
│   ├── registry.ts               # Block state parsing + queries
│   ├── colors.ts                 # Block → RGB color map (280+ entries)
│   └── textures.ts               # Block → per-face texture names
├── gen/
│   ├── generator.ts              # Main orchestrator (10 structure types)
│   ├── gen-house.ts              # Multi-room residential (wings, sections)
│   ├── gen-decorators.ts         # 11 style-specific decorator registry
│   ├── gen-utils.ts              # Shared helpers (roof, chimney, stairs)
│   ├── rooms.ts                  # 30 room type generators
│   ├── styles.ts                 # 10 material palettes (70+ block fields each)
│   ├── structures.ts             # Voxel primitives (walls, arches, parabolas, trees)
│   ├── furniture.ts              # 19 furniture placement functions
│   ├── color-blocks.ts           # RGB → block mapping (CIE-Lab delta-E, 35 wall clusters)
│   ├── coordinate-bitmap.ts      # Polygon rasterization (winding-number scanline)
│   ├── address-pipeline.ts       # PropertyData → GenerationOptions converter
│   ├── material-resolver.ts      # Data-driven material resolution (resolvePalette)
│   ├── elevation.ts              # AWS Terrarium tile fetcher + bilinear interpolation
│   └── api/                      # External service clients (10 modules)
│       ├── geocoder.ts           # Census Bureau geocoding
│       ├── google-solar.ts       # Google Solar API (roof pitch/segments)
│       ├── google-streetview.ts  # SV metadata + image URLs (source=outdoor)
│       ├── mapbox.ts             # Mapbox building height tilequery
│       ├── mapillary.ts          # Street-level imagery + heading
│       ├── osm.ts                # Overpass API (3-server round-robin)
│       ├── parcl.ts              # Parcl Labs property data
│       ├── smarty.ts             # SmartyStreets assessor records
│       ├── streetview-analysis.ts # SV image analysis (Tier 1-3 + indoor detection)
│       └── vlm-provider.ts       # Vision LLM routing (Anthropic / OpenRouter)
├── render/
│   ├── texture-atlas.ts          # ProceduralAtlas — 334 PNG + procedural fallback
│   ├── three-scene.ts            # Three.js scene builder + serializer
│   ├── block-mesh.ts             # Block geometry (10 shape types)
│   ├── png-renderer.ts           # 2D floor plans + isometric cutaway
│   ├── export-html.ts            # Self-contained HTML export (embedded textures)
│   ├── server.ts                 # Express dev server for 3D viewer
│   └── item-sprites.ts           # 17 hand-drawn 16×16 furniture sprites
├── convert/
│   ├── schem-to-three.ts         # .schem → Three.js Object3D
│   ├── three-to-schem.ts         # Three.js → .schem via raycasting
│   ├── voxelizer.ts              # Three.js → BlockGrid (solid + surface modes, BVH)
│   ├── mesh-filter.ts            # 53 post-processing functions (cleanup, windows, etc.)
│   ├── scene-pipeline.ts         # Scene enrichment orchestrator (building + environment)
│   ├── scene-enrichment.ts       # API data aggregation (OSM, climate, landcover)
│   ├── environment-builder.ts    # Places trees, roads, fences, ground into BlockGrid
│   ├── voxel-classifier.ts       # Semantic voxel labeling (wall, roof, ground, etc.)
│   ├── class-block-map.ts        # VoxelClass → Minecraft block (by climate context)
│   ├── geo-projection.ts         # WGS84 ↔ BlockGrid coordinate conversion
│   └── multi-angle-capture.ts    # Multi-camera LOD forcing for tile coverage
└── types/
    └── index.ts                  # Shared TypeScript interfaces

web/                              # Browser SPA (Vite)
├── src/
│   ├── main.ts                   # Entry point + tab switching (data-tab attrs)
│   ├── style.css                 # Responsive dark-mode CSS (mobile-first)
│   ├── engine/
│   │   ├── schematic-handler.ts  # WASM/browser schematic operations
│   │   ├── texture-loader.ts     # Browser texture loading
│   │   ├── texture-sampler.ts    # Canvas-backed UV texture sampler (tiles pipeline)
│   │   ├── tile-capture.ts       # Mesh extraction from TilesRenderer (tiles pipeline)
│   │   └── mesh-to-grid.ts       # Browser mesh file → BlockGrid wrapper
│   ├── viewer/
│   │   ├── scene.ts              # Browser Three.js scene
│   │   ├── exporter.ts           # Client-side export (.schem, .litematic)
│   │   └── selection.ts          # Manual XZ rectangle crop (raycaster ground plane)
│   └── ui/                       # Tab modules + import enrichment
│       ├── generator.ts          # Generate tab
│       ├── import.ts             # Import tab (address pipeline orchestrator)
│       ├── upload.ts             # Upload tab (.schem file ingestion)
│       ├── gallery.ts            # Gallery tab (pre-generated examples)
│       ├── comparison.ts         # Comparison tab (14-address accuracy dashboard)
│       ├── map3d.ts              # Map 3D tab (Google 3D Tiles viewer)
│       ├── tiles.ts              # Tiles tab (3D Tiles → schematic pipeline)
│       ├── building-bounds.ts    # Solar API + OSM building size resolution
│       └── import-*.ts           # 22 API client modules (see Enrichment APIs)
├── public/                       # Static assets (textures, examples)
└── index.html                    # SPA shell

textures/blocks/                  # 334 Faithful 32×32 PNGs (CC-BY-SA)
scripts/                          # Build/regen utilities
test/                             # 31 test files, 661+ tests (Vitest)
docs/                             # Specs, references, plans
output/                           # Generated comparison data + images
```

---

## Data Flow

### Schematic Parse Pipeline
```
.schem file → pako gunzip → prismarine-nbt parse → SchematicData → BlockGrid
```
Custom NBT writer (Big Endian) for output — does NOT use prismarine-schematic.

### Schematic Write Pipeline
```
BlockGrid → varint-encode palette → NBT compound → pako gzip → .schem (Sponge v2)
```

### Generation Pipeline
```
GenerationOptions → calculateDimensions() → BlockGrid.create()
  → foundation → walls → floors → stairs → rooms → roof → chimney
  → style decorators (11) → landscape (trees, ground cover, water)
  → writeSchematic()
```

### Address-to-Schematic Pipeline (Import tab / CLI)
```
Street address
  → Geocode (Census Bureau)
  → Parallel enrichment:
      Parcl Labs (property meta) | Smarty (assessor records) | OSM Overpass (footprint)
      Mapbox Tilequery (height) | Google Solar (roof pitch) | Overture Maps (floors/roof)
      Google Street View (exterior photo) | Mapillary (street imagery)
      NLCD (canopy %) | USDA Hardiness (climate zone)
      Canopy Height (Meta COG) | Landcover (ESA WorldCover) | Water (OSM)
      Elevation (AWS Terrarium) | Satellite imagery (Google Static Maps)
  → SV Analysis: Tier 1 (colors) → Tier 2 (structural heuristics) → Tier 3 (VLM)
  → Indoor detection + outdoor fallback (100m/250m/500m radius)
  → PropertyData (90+ fields)
  → convertToGenerationOptions()
      Style: OSM arch → Smarty arch → VLM style → property type → city/county defaults
      Stories: Smarty > OSM levels > Mapbox height > Solar footprint > heuristic
      Dimensions: OSM footprint > satellite footprint (≥0.6 conf) > sqft estimate
      Materials: resolvePalette() priority chain per element
      Landscape: buildLandscape() from hardiness + canopy + landcover + water
  → GenerationOptions → BlockGrid → .schem + 3D viewer
```

### Render Pipeline (2D PNG)
```
BlockGrid → to3DArray() → ensureAtlas() → per-block texture lookup
  → blitTextureTile / blitTextureIso (nearest-neighbor from 32×32 atlas)
  → item sprite overlay (16×16 furniture shapes)
  → pureimage encodePNG → Buffer
```

### Render Pipeline (3D Viewer)
```
BlockGrid → serializeForViewer() → JSON → HTML template (Three.js from CDN)
  → getGeometryKind() classifies shape (10 types: cube, slab, fence, torch, etc.)
  → InstancedMesh per color+geometry group (custom batching, NOT prismarine-viewer)
  → loadBlockTexture() → Faithful 32x PNG via Vite import.meta.glob
  → Fallback: ProceduralAtlas (10 pattern generators, seeded PRNG)
  → NearestFilter for crisp pixel-art look
  → Emissive glow for light-emitting blocks
  → OrbitControls → WebGL canvas
```

### Texture Pipeline
```
textures/blocks/*.png (334 Faithful 32×32 CC-BY-SA)
  → initDefaultAtlas() loads + scales to tileSize
  → ProceduralAtlas (230+ entries: real PNG + procedural fallback)
  → getBlockTextures(blockState) → per-face names (top/bottom/north/south/east/west)
  → atlas.entries.get(textureName)?.data → 32×32 RGBA pixel array
  → item-sprites.ts: 17 hand-drawn 16×16 sprites (beds, chests, lanterns, etc.)
```

---

## Photogrammetry Pipeline (Tiles Tab + CLI Voxelizer)

Two paths convert real-world 3D data into Minecraft schematics:

- **Browser** (Tiles tab): Address → Google 3D Tiles → mesh capture → voxelize → post-process → .schem
- **CLI** (`scripts/voxelize-glb.ts`): Pre-saved GLB → voxelize → post-process → .schem

Both share the core voxelizer (`src/convert/voxelizer.ts`) and post-processing filters (`src/convert/mesh-filter.ts`).

### Photogrammetry Data Flow

```
Address Input (browser) or GLB file (CLI)
  │
  ├─── [Browser only] ──────────────────────────────────────────────────────────
  │    Geocode (Google) → lat, lng
  │    │
  │    Building Bounds (Solar API + OSM) → widthM, captureRadiusM, satelliteZoom
  │    │
  │    TilesRenderer Init (WebGL + ReorientationPlugin + GoogleCloudAuthPlugin)
  │    │
  │    Tile Mesh Capture → cylindrical XZ filter → height filter → Three.js Group
  │    │
  │    GLB Export (async, non-blocking) → POST to receiver or browser download
  │    │
  ├─── [Both paths] ────────────────────────────────────────────────────────────
  │
  Voxelizer (surface mode + BVH + texture sampler) → BlockGrid
  │
  Post-Processing Pipeline (14 steps):
  │  1. trimSparseBottomLayers         — remove residual terrain
  │  2. removeGroundPlane              — subtract foundation plane
  │  3. removeSmallComponents (≥500)   — delete photogrammetry debris
  │  4. cropToAABB                     — isolate central building (if multi-component)
  │  5. fillInteriorGaps (dilation=2)  — flood-fill sealed cavities (2 passes)
  │  6. clearOpenAirFill               — remove fills in open courtyards/stadiums
  │  7. stripVegetation                — remove tree/bush blocks (after fill uses them as walls)
  │  8. morphClose3D                   — fill 1-voxel pockmarks (dilate + erode)
  │  9. smoothSurface                  — remove 1-voxel protrusions
  │ 10. flattenFacades (snap=1)        — histogram-based wall plane snapping
  │ 11. glazeDarkWindows               — Chebyshev-1 vertical chain → gray_stained_glass
  │ 12. injectSyntheticWindows         — regular grid pattern on bright monochrome facades
  │ 13. modeFilter3D                   — 3×3×3 majority-vote smoother (glass protected)
  │ 14. constrainPalette (sky remaps)  — cyan→stone, analysis-specific corrections
  │
  ├─── [Scene Mode only] ──────────────────────────────────────────────────────
  │    extractEnvironmentPositions     — separate trees, roads, vehicles
  │    detectAndRegularizeWindows      — snap existing windows to grid + add doors
  │    replaceWithCleanFeatures        — procedural trees at detected positions
  │    expandGrid (+8m padding/side)   — enlarge for environment
  │    enrichScene:
  │      classifyGrid → GeoProjection → enrichForScene (OSM + climate APIs)
  │      → buildEnvironment (trees, roads, fences, ground)
  │      → writeWithPriority (building > fence > road > ground)
  │
  └─→ BlockGrid → onResult callback → viewer + .schem download
```

### Module Reference

| Module | Path | Lines | Key Exports |
|--------|------|-------|-------------|
| **Tiles tab** | `web/src/ui/tiles.ts` | ~990 | `initTiles()`, `TilesResultMeta` |
| **Tile capture** | `web/src/engine/tile-capture.ts` | ~300 | `captureTileMeshes()` → `CaptureResult` |
| **Texture sampler (browser)** | `web/src/engine/texture-sampler.ts` | 44 | `createCanvasTextureSampler()` |
| **Building bounds** | `web/src/ui/building-bounds.ts` | ~200 | `resolveBuildingBounds()` → `BuildingBounds` |
| **Manual selection** | `web/src/viewer/selection.ts` | ~150 | `enableSelection()` → `SelectionBounds` |
| **Voxelizer** | `src/convert/voxelizer.ts` | ~800 | `threeToGrid()`, `threeToGridAsync()`, `createDataTextureSampler()` |
| **Post-processing** | `src/convert/mesh-filter.ts` | ~6000 | 53 exported functions (see below) |
| **Scene pipeline** | `src/convert/scene-pipeline.ts` | ~490 | `enrichScene()`, `expandGrid()` |
| **Scene enrichment** | `src/convert/scene-enrichment.ts` | ~800 | `enrichForScene()` → `SceneEnrichment` |
| **Environment builder** | `src/convert/environment-builder.ts` | ~660 | `buildEnvironment()` → `EnvironmentStats` |
| **Voxel classifier** | `src/convert/voxel-classifier.ts` | ~500 | `classifyGrid()` → `ClassifiedGrid`, `VoxelClass` enum |
| **Class-block map** | `src/convert/class-block-map.ts` | ~240 | `resolveBlock()` |
| **Geo projection** | `src/convert/geo-projection.ts` | ~140 | `GeoProjection` (WGS84 ↔ grid XZ) |
| **Multi-angle capture** | `src/convert/multi-angle-capture.ts` | ~240 | `positionCameraForAngle()` |
| **Color matching** | `src/gen/color-blocks.ts` | ~400 | `rgbToWallBlock()` (CIE-Lab delta-E, 35 clusters) |
| **CLI voxelizer** | `scripts/voxelize-glb.ts` | ~2560 | `main()` CLI entry point |

### Voxelization Modes

| Mode | Algorithm | Best For | Technique |
|------|-----------|----------|-----------|
| **solid** | Odd-even ray test | Watertight meshes (OBJ, STL uploads) | 3 perpendicular rays, count intersections before point |
| **surface** | BVH closest-point proximity | Open surfaces (3D Tiles photogrammetry) | Fill voxel if mesh surface within 0.75/resolution distance |

Both modes use CIE-Lab perceptual color matching (`rgbToWallBlock`) with position-based seed for deterministic variation across the 35 wall clusters.

### Texture Sampling

| Sampler | Environment | Technique |
|---------|-------------|-----------|
| `createCanvasTextureSampler()` | Browser | OffscreenCanvas per texture, `getImageData()` point sampling |
| `createDataTextureSampler()` | CLI (Node/Bun) | Direct typed array pixel access, dominant-color (mode) bucketing, gamma correction, selective desaturation, black-point lift |

The CLI sampler is substantially more sophisticated: it uses 8-bucket luminance mode sampling over a 49×49 kernel to extract the dominant surface color, avoiding mean-averaging artifacts where windows/shadows pull wall colors toward gray.

### Window Detection

Three complementary approaches detect/create windows:

1. **glazeDarkWindows** — Finds dark exterior blocks (`gray_concrete`, `polished_deepslate`, `brown_concrete`, `black_concrete`, `deepslate`) on facades. Groups into vertical chains via Chebyshev-1 union-find. Chains with ≥3 members and ≥2-block vertical span are glazed to `gray_stained_glass`. Cap: ≤30% of facade area.

2. **injectSyntheticWindows** — For bright monochrome facades where glazeDarkWindows found nothing (<0.5% non-air). Detects floor height via autocorrelation of Y-layer density, places windows in regular grid at scale-aware spacing. Only modifies the dominant facade material (>40% of facade).

3. **detectAndRegularizeWindows** (scene mode) — Projects each facade (N/S/E/W) to 2D bitmap. Connected components of glass/dark blocks identify window clusters. If ≥3 found, snaps to regular grid (median spacing). Also places doors on ground level.

All three accept a `resolution` parameter and scale their spatial thresholds (MIN_Y, floor period, horizontal spacing) proportionally.

### Building Bounds Resolution

Priority chain for determining building size and optimal capture parameters:

| Priority | Source | Data | Confidence |
|----------|--------|------|------------|
| 1 | Google Solar API | ML-detected bounding box | 0.9 |
| 2 | OSM building footprint | Community-verified polygon | 0.8 |
| 3 | Geocode bounds | Property parcel (ROOFTOP level) | 0.6 |
| 4 | Solar footprint area | Area with assumed aspect ratio | 0.5 |
| 5 | Default | 25m × 25m | 0.2 |

Output: `captureRadiusM` (diagonal × 0.75 + 10m buffer), `satelliteZoom` (fit building at ~60% of 640px image).

### Scene Enrichment Data Sources

| Source | Module | Data |
|--------|--------|------|
| OSM Overpass (3-server round-robin) | `scene-enrichment.ts` | Roads (width, surface), paths, fences (material), water features |
| ESA WorldCover (S3 COG) | `scene-enrichment.ts` | Ground cover class → grass/forest/desert/urban |
| USDA Hardiness Zone (inferred from lat) | `scene-enrichment.ts` | Climate zone → tree species palette |
| OSM tree nodes | `scene-enrichment.ts` | Individual tree positions, species, height, leaf type |
| Photogrammetry detection | `mesh-filter.ts` | `extractEnvironmentPositions()` — trees, roads, vehicles from tile geometry |

### Voxel Classification (VoxelClass)

Semantic roles assigned to every voxel for priority-aware environment writes:

| Class | Priority | Examples |
|-------|----------|----------|
| `BUILDING_WALL` | 100 | Concrete, brick, stone |
| `BUILDING_ROOF` | 90 | Roof slabs, shingles |
| `BUILDING_WINDOW` | 85 | Stained glass |
| `BUILDING_DOOR` | 85 | Door blocks |
| `BUILDING_TRIM` | 80 | Decorative elements |
| `FENCE` | 50 | Oak fence, iron bars |
| `VEHICLE` | 45 | Detected cars/trucks |
| `GROUND_ROAD` | 40 | Gray concrete |
| `GROUND_SIDEWALK` | 35 | Smooth stone slab |
| `GROUND_GRASS` | 20 | Grass block, podzol |
| `VEGETATION_TREE` | 15 | Leaves, logs |
| `AIR` | 0 | Empty space |

Higher priority wins in conflicts — building voxels are never overwritten by environment.

### Coordinate Systems

```
Geographic (WGS84):     Grid (BlockGrid):        Minecraft:
  +lat = north            +X = east                +X = east
  +lng = east             +Y = up                  +Y = up
  height = meters         +Z = south               +Z = south
                          origin = grid center
```

`GeoProjection` handles conversion using equirectangular approximation (accurate to <1m for radii <500m). The calibration offset from `alignOSMToFootprint()` corrects photogrammetry geocoding drift (~1-20 blocks).

### Key Parameters

| Parameter | Default | Range | Effect |
|-----------|---------|-------|--------|
| Resolution | 3 block/m | 1-4 | Voxel density. 3 ≈ 1 ft/block — best for architectural detail |
| Capture radius | 30m (auto) | 20-150m | Sphere around geocoded center. Auto-set from building bounds |
| Error target | 4.0+ | 4-20 | TilesRenderer LOD. Scales with radius to prevent GPU OOM |
| Surface threshold | 0.75/res | — | Max distance from mesh surface to fill voxel |
| Glaze cap | 30% | — | Max fraction of facade that can be glazed as windows |
| Component min | 500 | — | Min voxels to survive component cleanup |
| Flatten snap | 1 | — | Max blocks a facade voxel can be snapped to dominant plane |

### CLI Voxelizer (`scripts/voxelize-glb.ts`)

Standalone converter with extensive flags:

```bash
bun scripts/voxelize-glb.ts <input.glb> --auto [-o /absolute/path/out.schem]
  --resolution N       # blocks/m (default: 1)
  --mode surface|solid # voxelization algorithm
  --coords LAT,LNG    # enable OSM footprint masking
  --mask-dilate N      # masking tolerance (0=tight, 2=loose)
  --enrich             # scene enrichment (requires --coords)
  --no-glaze           # skip window glazing
  --gamma N            # texture brightness correction
  --kernel N           # texture sampling kernel radius
  --desaturate N       # color desaturation factor
```

The CLI uses `createDataTextureSampler()` (raw typed-array access) instead of the browser's Canvas-backed sampler. It also supports OSM footprint masking via `--coords`, which queries Overpass for the building polygon and masks the voxelization to only include blocks within the footprint.

### Technology Stack

| Component | Package | Purpose |
|-----------|---------|---------|
| Tile loading | `3d-tiles-renderer` ^0.4.21 | Google 3D Tiles traversal + LOD management |
| Auth | `GoogleCloudAuthPlugin` | Google Maps API key → tile bearer tokens |
| Positioning | `ReorientationPlugin` | Lat/lng → tile scene origin |
| Decompression | `DRACOLoader` | Google tiles use Draco mesh compression |
| BVH | `three-mesh-bvh` | O(log n) closest-point queries for surface voxelization |
| 3D engine | `three` ^0.172.0 | Scene graph, geometry, materials, raycasting |
| Terrain | `geotiff` ^3.0.3 | ESA WorldCover + Meta canopy height COG tiles |

### Cesium Evaluation (2026-03-15)

Cesium JS was evaluated and **rejected** for this pipeline:
- OSM Buildings are extruded boxes (no textures/detail) — worse geometry than Google tiles
- CesiumJS has no API to extract mesh vertex data — blocks our voxelizer
- Cannot run headless (requires full DOM) — breaks CLI mode
- 23-75 MB bundle vs 3.1 MB for `3d-tiles-renderer`
- `3d-tiles-renderer` already supports Cesium Ion auth (`CesiumIonAuthPlugin`) and `EXT_mesh_features` if needed in the future

---

## Key Classes

### BlockGrid (`src/schem/types.ts`)
Central data structure: 3D voxel grid stored as `string[]` in YZX order.

- `get(x, y, z)` / `set(x, y, z, blockState)` — single block access
- `fill(x1, y1, z1, x2, y2, z2, blockState)` — volume fill
- `walls(x1, y1, z1, x2, y2, z2, blockState)` — hollow box
- `addChest(x, y, z, facing, items)` — chest with inventory
- `encodeBlockData()` → varint-encoded `Uint8Array`
- `to3DArray()` → `string[][][]` indexed as `[y][z][x]`

### StylePalette / MaterialPalette (`src/gen/styles.ts`)
70+ field interfaces defining blocks for every building element: walls, floors, ceilings, stairs, roof, timber, glass, doors, fence, path, lighting, etc. `MaterialPalette` is the data-driven subset; `StructuralProfile` covers dimensional preferences.

### PropertyData (`src/gen/address-pipeline.ts`)
90+ field interface aggregating all enrichment sources. Feeds into `convertToGenerationOptions()` which resolves conflicts via priority chains.

### GenerationOptions (`src/types/index.ts`)
Generation input: structure type, dimensions, style, floors, rooms, roof shape, resolved palette, landscape data, features (pool/garage/deck/porch/fence).

---

## Structure Types (10)

| Type | Description |
|------|-------------|
| `house` | Multi-room residential, wing sections, BuildingSection[] for compound layouts |
| `tower` | Tall fortified structure, tapering floors |
| `castle` | Large medieval compound with courtyard |
| `dungeon` | Underground multi-level complex |
| `ship` | Naval vessel with hull + mast |
| `cathedral` | Nave + aisles → rose window → apse → bell tower → flying buttresses |
| `bridge` | Parabolic arch → deck + railings → end towers → water indicator |
| `windmill` | Circular base → tapering floors → blade structure → conical roof |
| `marketplace` | Perimeter wall → stall grid → central well → covered walkway |
| `village` | Sub-structure generation → pasteGrid composition → path network → trees |

## Style Presets (10)

| Style | Key Materials | Roof |
|-------|--------------|------|
| `fantasy` | White concrete, dark oak | Gambrel |
| `medieval` | Stone bricks, oak | Gable |
| `modern` | Concrete, light palette | Flat |
| `gothic` | Dark stone, purple accents | Pointed arch |
| `rustic` | Spruce/oak, natural colors | Hip |
| `steampunk` | Iron, copper tones | Industrial |
| `elven` | Birch, light palette | Nature-inspired |
| `desert` | Sandstone, clay | Flat + parapets |
| `underwater` | Prismarine, sea lanterns | Aquatic dome |
| `colonial` | Brick, white trim | Symmetrical gable |

For real addresses (`style='auto'`), `resolvePalette()` bypasses these presets entirely, using data-driven materials from the enrichment pipeline.

## Decorators (11)

Style-specific post-processing applied to generated buildings:
`fantasy-cottage`, `victorian-turret`, `bay-windows`, `modern-carport`, `modern-facade`,
`medieval-manor`, `rustic-cabin` (water-aware dock), `colonial-facade`, `gothic-victorian`,
`roof-dormers` (universal fallback), `steampunk-workshop`.

---

## Enrichment APIs (Import Tab)

All calls are client-side `fetch()` from the browser. No backend proxy. API keys stored in `localStorage`.

| Module | API / Source | Data |
|--------|-------------|------|
| `import-geocoder.ts` | Census Bureau Nominatim | Lat/lng from address |
| `import-parcl.ts` | Parcl Labs | Property value, county, state, beds, baths, sqft |
| `import-smarty.ts` | SmartyStreets | Assessor records (19-61 fields: year, type, garage, pool, etc.) |
| `import-osm.ts` | Overpass (3-server RR) | Building footprint, levels, roof shape, material, colour |
| `import-osm-trees.ts` | Overpass | Nearby tree species, height, leaf type |
| `import-mapbox-building.ts` | Mapbox Tilequery | Building height in meters |
| `import-overture.ts` | Overture Maps PMTiles (AWS S3) | Floors, height, roof shape, facade material |
| `import-streetview.ts` | Google Street View | Panorama metadata, heading, image URL |
| `import-sv-analysis.ts` | Canvas2D + VLM (Anthropic/OpenRouter) | Wall/roof/trim colors, structural heuristics, style classification |
| `import-mapillary.ts` | Mapillary | Street-level imagery + heading alignment |
| `import-satellite.ts` | Google Static Maps | Aerial imagery |
| `import-satellite-footprint.ts` | Image analysis (Canvas2D) | Roof footprint extraction (flood fill + PCA OBB) |
| `import-color.ts` | Satellite image | Dominant building color |
| `import-elevation.ts` | AWS Terrarium tiles | Terrain elevation + slope |
| `import-nlcd.ts` | MRLC WMS | Tree canopy % (NLCD 2021) |
| `import-hardiness.ts` | phzmapi.org | USDA hardiness zone → tree species palette |
| `import-canopy-height.ts` | Meta/WRI S3 COG | 1m canopy height via GeoTIFF |
| `import-landcover.ts` | ESA WorldCover S3 COG | 10m land cover class |
| `import-water.ts` | Overpass | Nearby water features (rivers, lakes) |
| `import-geometry.ts` | Local computation | Polygon analysis + bitmap rasterization |
| `import-floorplan.ts` | Image analysis | Floor plan shape classification |

### Street View Analysis Tiers

| Tier | Method | Data Extracted |
|------|--------|---------------|
| 1 — Colors | Canvas2D pixel sampling | Wall/roof/trim block colors (CIE-Lab matching) |
| 2 — Structure | Heuristic image analysis | Story count, texture class, roof pitch, symmetry, fenestration, setback |
| 3 — Vision | VLM API (Anthropic Claude / OpenRouter) | Architecture style, wall/roof material, door style, features, color descriptions |

Indoor panorama detection uses multi-factor scoring: sky presence, foliage (trees ≠ ceiling), road/pavement in bottom zone. Falls back to wider radius (100m/250m/500m) when indoor detected.

---

## CLI Commands

```bash
craftmatic [file]           # Auto-render or launch web UI
craftmatic info <file>      # Print schematic metadata (dimensions, block count, palette)
craftmatic render <file>    # Generate 2D PNG floor plans + isometric views
craftmatic view <file>      # Launch Express dev server with 3D viewer
craftmatic export <file>    # Export self-contained HTML with embedded textures
craftmatic gen [type]       # Generate structure (-a address, -s style, -f floors, etc.)
craftmatic atlas [output]   # Generate texture atlas debug image
```

The `gen --address` flag runs the full enrichment pipeline (same as Import tab) via CLI.

---

## Web SPA Tabs (7)

| Tab | Module | Purpose |
|-----|--------|---------|
| Generate | `generator.ts` | Manual building creation (style, floors, rooms, decorators) |
| Import | `import.ts` | Address → enriched PropertyData → auto-generation |
| Upload | `upload.ts` | .schem file ingestion + viewer |
| Gallery | `gallery.ts` | Pre-generated example buildings |
| Comparison | `comparison.ts` | 14-address accuracy dashboard (generated vs. photo) |
| Map 3D | `map3d.ts` | Google 3D Tiles photogrammetry viewer |
| Tiles | `tiles.ts` | 3D Tiles → voxelized Minecraft schematic (photogrammetry pipeline) |

SPA routing: vanilla `data-tab` attributes, no framework. Tab switching in `main.ts`.
Dark mode, mobile-first responsive CSS.

---

## Export Formats

| Format | Module | Description |
|--------|--------|-------------|
| `.schem` | `schem/write.ts` | Sponge Schematic v2 (NBT, gzip). Compatible with WorldEdit, Litematica, etc. |
| `.html` | `export-html.ts` | Self-contained Three.js viewer with base64-embedded textures |
| `.png` | `png-renderer.ts` | 2D floor plans + isometric cutaway renders (via pureimage) |
| 3D viewer | `three-scene.ts` | Interactive browser-based Three.js scene (not a file export) |

---

## Dependencies

### Runtime
| Package | Version | Purpose |
|---------|---------|---------|
| `prismarine-nbt` | ^2.7.0 | NBT parsing (MIT) |
| `pako` | ^2.1.0 | zlib compress/decompress |
| `three` | ^0.172.0 | 3D scene construction |
| `3d-tiles-renderer` | ^0.4.21 | Google Photogrammetry 3D Tiles |
| `three-mesh-bvh` | ^0.9.0 | BVH acceleration for surface voxelization |
| `pureimage` | ^0.4.18 | Pure-JS PNG encoding (no native deps) |
| `commander` | ^13.1.0 | CLI argument parsing |
| `express` | ^4.21.2 | Dev server for 3D viewer |
| `chalk` | ^5.4.1 | CLI colors |
| `ora` | ^8.2.0 | CLI progress spinners |
| `pmtiles` | ^4.4.0 | Overture Maps PMTiles HTTP range requests |
| `@mapbox/vector-tile` | ^2.0.4 | Mapbox vector tile decoding |
| `pbf` | ^4.0.1 | Protobuf decoding for vector tiles |
| `geotiff` | ^3.0.3 | GeoTIFF COG reading (canopy height, landcover) |

### Optional
| Package | Purpose |
|---------|---------|
| `sharp` | Fast PNG encoding (ARM64 optional, pureimage fallback) |

### Dev
| Package | Purpose |
|---------|---------|
| `typescript` ^5.7.3 | Type checking |
| `vite` ^7.3.1 | Web build + dev server |
| `vitest` ^3.0.5 | Test runner (661+ tests, 31 files) |

---

## Material Resolution (`resolvePalette`)

For real addresses (`style='auto'`), materials are resolved per-element via priority chains:

```
Wall:  OSM building:colour → SV wall color → OSM material → Smarty constructionType → category default
Roof:  OSM roof:colour → SV roof color → OSM roof:material → Smarty roofFrame → Solar pitch → category default
Trim:  SV trim color → style-coordinated trim
Door:  VLM doorStyle → style default
```

5 building categories (residential, commercial, industrial, civic, historic) provide fallback palettes. CIE-Lab delta-E color matching maps real-world RGB to nearest Minecraft block from 35 wall clusters.

---

## Comparison Infrastructure

14 real US addresses evaluated across 4 tiers:
- **Tier 1 (noapi)**: Sqft + beds/baths only
- **Tier 2 (someapis)**: + OSM footprint + Mapbox height
- **Tier 3 (allapis)**: + Solar + SV colors + Smarty assessor
- **Tier 4 (enriched)**: + VLM style + Overture + environmental

Scripts: `gen-comparison.ts` (data), `render-comparison-images.ts` (PNG renders).
Web dashboard: side-by-side generated vs. Google Street View photo.
Current accuracy: ~9.1/10 average (Phase 6).

---

## Key Design Decisions

1. **No backend**: All API calls are direct from browser via `fetch()`. This eliminates server costs and simplifies deployment (GitHub Pages). Trade-off: API keys are in localStorage, visible to client-side code.

2. **Custom NBT, not prismarine-schematic**: The project only needs Sponge v2 `.schem` read/write. `prismarine-nbt` handles the binary NBT layer; custom varint + palette encoding handles the schematic-specific format. This avoids a heavier dependency for a format we fully control.

3. **Custom Three.js renderer, not SchematicWebViewer**: Hand-rolled scene builder uses `InstancedMesh` batching per block type+geometry for performance. 10 geometry classifications (cube, slab, fence, torch, stairs, trapdoor, wall, pane, carpet, rod). This gives full control over texture loading, emissive lighting, and viewer serialization.

4. **Procedural generation, not AI/LLM for buildings**: Structure generation is deterministic TypeScript code with seeded PRNG. VLM (Tier 3) is only used for *classifying* Street View photos (style, materials), never for generating geometry.

5. **Faithful 32x textures + procedural fallback**: 334 real PNGs provide crisp block textures. ProceduralAtlas fills gaps with 10 pattern generators (solid, noise, grain, brick, speckle, plank, checkerboard, cross, dots, shelf) using seeded mulberry32 PRNG for determinism.

6. **Data-driven materials for real addresses**: `resolvePalette()` replaces style presets when processing actual property data. Fantasy presets (`medieval`, `gothic`, etc.) are still used in the Generate tab for creative builds.
