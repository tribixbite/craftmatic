# Pipeline Rearchitecture — Address → 3D Model + Voxel Output

**Date:** 2026-04-17
**Status:** Design (awaiting approval)
**Author:** generated via brainstorming session
**Supersedes:** `docs/superpowers/specs/2026-03-19-v300-pipeline-rework-design.md`

## Goal

From any US address, produce the highest-quality possible 3D representation of the building and its immediate scene. The primary artifact is a parametric, watertight, 3D-printable GLB. Secondary artifacts are a decorated scene GLB (building + terrain + trees + roads) and a Minecraft voxel schem/litematic. The building B-rep must support future interior floorplan subtraction without rework.

Source data: Google 3D Tiles (photogrammetry mesh), Google Street View (facade imagery), Google Static Maps (satellite), Google Solar API (footprint bbox + roof pitch), OpenStreetMap (polygon + tags), Smarty (US assessor), elevation APIs.

## Why this rework

The current pipeline treats dirty photogrammetry voxels as ground truth and runs 21 post-processing phases to patch artifacts. This plateaued at 5/20 buildings passing 9/10 on a 7-category VLM rubric; 15/20 are declared "source data limited." The ceiling is architectural, not tuning: clean source geometry must be *synthesized*, not patched. See `memory/category-grading.md` for the plateau detail.

## Decisions recorded

| # | Question | Answer |
|---|---|---|
| Q1 | Primary output | Model-first; voxel is a downstream conversion |
| Q2 | Building mesh strategy | Hybrid parametric synthesis (B). Cleaned-tiles fallback (A). Printable + interior-ready |
| Q3 | Scope | Printable building artifact + separate decorated scene artifact (D) |
| Q4 | Success metric | Objective gates (deterministic) + multi-VLM consensus (subjective polish) (B) |
| Q5 | Platform | Shared pure core; CLI + browser as thin adapters (C) |
| Architecture | Rewrite strategy | Hybrid (C): rewrite top half (~12k lines deleted, ~2.5k new), keep bottom half (voxelizer, API clients, color-blocks, schem writers) |
| Constraint | Capture strategy | **Captures** (Stages 3→4→5 — tiles, SV, satellite) are sequential, adaptive, size-variance aware, occlusion-aware. Each capture informs the next. **Metadata fetches** in Stage 1 (Solar / OSM / Smarty) are allowed to be parallel because none of them informs any other — they are pre-classification read-only API calls with no data dependency. The "do not parallelize sources" rule applies to the capture loop, not to cheap metadata fan-out |
| Constraint | Verification | Must pass objective gates **and** multi-VLM consensus before release; unanimous across Gemini + Claude + GPT-5 |

## Non-goals

- Global address support (US-only; Smarty is US-restricted, addresses outside US get partial data)
- Interior floorplan *implementation* (design must accommodate it, build comes later)
- Real-time interactive generation (batch-oriented; minutes per address acceptable)
- Global parametric library (architectural styles covered: residential / commercial / civic / industrial / historic / religious — enough for the 20 goldens; new styles added via profile entries)

---

## Architecture

### Data flow (sequential, adaptive)

```
address
  │
  ▼
┌──────────────────────────────────────────────────────┐
│ STAGE 0: GEOCODE                                     │
│   address → lat/lng, viewport hint                   │
└──────────────────────────────────────────────────────┘
  │
  ▼
┌──────────────────────────────────────────────────────┐
│ STAGE 1: COARSE CONTEXT (parallel OK — all cheap)    │
│   Solar bbox + OSM polygon+tags + Smarty assessor    │
│   → ContextDraft                                     │
└──────────────────────────────────────────────────────┘
  │
  ▼
┌──────────────────────────────────────────────────────┐
│ STAGE 2: CLASSIFY + PROFILE                          │
│   size / shape / SV-difficulty / archType            │
│   Profile table lookup                               │
│   → BuildingContext + CaptureProfile                 │
└──────────────────────────────────────────────────────┘
  │
  ▼
┌──────────────────────────────────────────────────────┐
│ STAGE 3: TILE CAPTURE                                │
│   Profile-driven radius/errorTarget/bands            │
│   Detect height-truncation and no-coverage           │
│   → TileEvidence                                     │
└──────────────────────────────────────────────────────┘
  │
  ▼
┌──────────────────────────────────────────────────────┐
│ STAGE 4: SV CAPTURE (iterative per direction)        │
│   Metadata → validate pano distance → retry offsets  │
│   Heading from actual pano position                  │
│   FOV from actual distance + facade width            │
│   Sniff vegetation% / sky% / building%               │
│   Retry ±15°/±30° on occlusion                       │
│   Assign captures to MBR facade edges                │
│   → SvEvidence[]                                     │
└──────────────────────────────────────────────────────┘
  │
  ▼
┌──────────────────────────────────────────────────────┐
│ STAGE 5: SATELLITE                                   │
│   Zoom from TileEvidence measured bbox               │
│   Tree-mask from SV canopy + OSM natural=tree        │
│   Sample roof palette with tree mask applied         │
│   → SatEvidence                                      │
└──────────────────────────────────────────────────────┘
  │
  ▼
┌──────────────────────────────────────────────────────┐
│ STAGE 6: FUSION                                      │
│   Each field has provenance + confidence             │
│   Conflict rules: tiles=mass, OSM=footprint,         │
│   SV=facade detail, satellite=roof                   │
│   → JointEvidence                                    │
└──────────────────────────────────────────────────────┘
  │
  ▼
┌──────────────────────────────────────────────────────┐
│ STAGE 7: SYNTHESIS ROUTER                            │
│   7a parametric (default) / 7b cleaned-tiles         │
│   (fallback) / 7c hybrid (iconic landmarks)          │
│   → BuildingBRep                                     │
└──────────────────────────────────────────────────────┘
  │
  ▼
┌──────────────────────────────────────────────────────┐
│ STAGE 8: EXPORT                                      │
│   8a print GLB (building only, watertight)           │
│   8b scene GLB (building + environment)              │
│   8c voxel schem/litematic (existing voxelizer.ts)   │
└──────────────────────────────────────────────────────┘
  │
  ▼
┌──────────────────────────────────────────────────────┐
│ STAGE 9: VERIFY                                      │
│   Objective gates (deterministic, must pass)         │
│   Multi-VLM consensus (Gemini+Claude+GPT-5, min ≥8)  │
│   → VerificationReport                               │
└──────────────────────────────────────────────────────┘
  │
  ▼
STAGE 10: Hook decides — block if fails, release if pass
```

### Key invariants

1. **Resolver runs once.** `BuildingContext` is the single source of truth for dimensions, orientation, classification. No downstream module re-derives them.
2. **Captures are adaptive, not hardcoded.** SV uses actual pano position to compute heading/FOV; satellite uses measured tile bbox for zoom; tiles use profile-driven radius.
3. **Each source's capture is informed by previous results.** SV strategy adjusts if tiles showed truncation. Satellite zoom uses actual captured extent. No blind parallel fetch.
4. **Fusion is one pass.** Each evidence field gets { value, source, confidence } and downstream reads the reconciled value. No multi-step priority chain.
5. **Synthesis is parametric-first.** Tile mesh is evidence about mass, not the model.
6. **Voxelization is terminal.** One call over the B-rep. No post-processing phases.
7. **B-rep is the canonical form.** Print, scene, voxel all derive from the same B-rep. Interior floorplans (future) subtract room volumes from floor slabs.
8. **3D-print constraints enforced at export, not patched after.** Watertightness, manifoldness, wall thickness are gates, not warnings.

---

## Core datatypes

### `BuildingContext` (resolver output)

```ts
interface BuildingContext {
  center: { lat: number; lng: number };

  // Oriented footprint
  polygon: LatLon[] | null;
  polygonSource: 'osm' | 'solar-bbox' | 'inferred';
  mbr: {
    rotationDeg: number;    // primary axis rotation from north
    widthM: number;
    depthM: number;
    corners: LatLon[];      // 4 corners of the oriented rectangle
  };

  // Dimensions
  heightM: number | null;
  heightSource: 'tiles' | 'solar' | 'osm-levels' | 'smarty';
  levels: number | null;

  // Roof
  roofShape: 'flat' | 'gabled' | 'hipped' | 'pyramidal' | 'dome' | 'mansard' | 'shed' | 'complex';
  roofPitchDeg: number | null;

  // Classification (size, primary shape, SV difficulty, archType set by Stage 2 from pre-capture data.
  // `shape` may be *refined* to `tower-podium` after Stage 3 if tile heightmap reveals that massing —
  // see `refineContextWithTiles()` in `src/pipeline/context/classify.ts`. No other field is mutated
  // post-Stage 2. This is the single exception to invariant #1 and is explicitly scoped.)
  size: 'tiny' | 'small' | 'medium' | 'large' | 'skyscraper' | 'campus';
  shape: 'rect' | 'wedge' | 'U' | 'courtyard' | 'multi-wing' | 'tower-podium' | 'curved' | 'irregular';
  svDifficulty: 'dense-urban' | 'suburban' | 'rural-occluded' | 'no-coverage';
  archType: 'residential' | 'commercial' | 'civic' | 'industrial' | 'historic' | 'religious';

  // Palette hints (from OSM tags / Smarty)
  wallColourHint: string | null;
  roofColourHint: string | null;
  wallMaterialHint: string | null;
  roofMaterialHint: string | null;

  // Terrain
  groundElevationM: number;
  isSloped: boolean;        // > 3° slope across footprint
  slopeVector: { dx: number; dy: number } | null;

  // Campus detection — siblingBuildings keeps per-sibling metadata (geometry + tags)
  // so the campus classifier can evaluate the `building:part` tag condition.
  isCampus: boolean;
  siblingBuildings: Array<{
    polygon: LatLon[];
    tags: Record<string, string>;
    distanceM: number;              // edge-to-edge distance from primary
  }>;

  // Raw data (downstream reference)
  rawSolar: SolarBuildingData | null;
  rawOsm: OSMBuildingData | null;
  rawSmarty: SmartyData | null;
}
```

**Nullability rules for `BuildingContext`:**

- `polygon` is `null` when neither OSM nor Solar provides one (synthesis routes to 7b).
- `mbr` is **always non-null**. When no polygon exists, it is built from the fallback chain: geocode viewport bbox (if `locationType === 'ROOFTOP'` or `RANGE_INTERPOLATED`) → 25m×25m square centered on `center` (last resort). `mbr.corners` in the last-resort case are axis-aligned.
- `heightM` is `null` when all four sources fail (Solar + OSM `building:levels` + Smarty + tile heightmap). Synthesis routes to 7b and the printable path fails at the objective gate, which is the intended behavior.
- **Context-insufficient terminal state**: if resolver cannot produce any usable footprint (`polygon === null` AND `rawSolar?.buildingBounds === null`) AND geocode viewport is city-scale (>500m), the resolver sets `status = 'context-insufficient'` directly and the pipeline aborts before capture. This prevents the silent "25m×25m generic box" output for addresses with no data at all. The case is distinct from `needs-human-review` (which arises after full processing) and is surfaced by the stop hook separately.
- `levels` is `null` when unresolvable by fusion (OSM/Smarty/SV all fail). When `ev.levels.value` is unavailable at Stage 7a, synthesis computes `levels = round(heightM / floorHeight)` with archType-specific `floorHeight`: 3.5m civic (default), 3.0m residential, 4.0m commercial. This is a **synthesis-time** fallback, not a fusion-time one — the fusion table records `ev.levels.source === 'inferred'` and `confidence = 0.4` so downstream telemetry sees that levels were inferred rather than sourced.
- `groundElevationM`, `size`, `shape`, `svDifficulty`, `archType` are always non-null — last-resort defaults exist in the classifier (`small`, `rect`, `suburban`, `residential`).

**Primitive types** (referenced but not defined in this spec; imported from existing codebase):
- `LatLon = { lat: number; lon: number }` — from `src/gen/api/osm.ts`
- `Vec3 = THREE.Vector3` — from `three`
- `Lab = { L: number; a: number; b: number }` — from `src/gen/color-blocks.ts`
- `LocalPoint2D = { x: number; z: number }` — local flat-plane coords, x+ east, z+ south, origin at building center
- `MaterialRef = { blockName: string; glbMaterial: GltfMaterial; lab: Lab }` — new type in `src/pipeline/synthesis/brep.ts`
- `SolarBuildingData`, `OSMBuildingData`, `SmartyData` — from their respective API client modules

### `CaptureProfile`

```ts
interface CaptureProfile {
  tiles: {
    radiusM: number;
    errorTarget: number;
    verticalBands: number;
    cameraMode: 'ortho' | 'perspective' | 'street';
    expectedHeightM: number;
  };
  streetview: {
    dirCount: number;                 // 2, 4, 6, 8
    offsetM: number;
    maxPanoDistM: number;
    angleVariants: number[];          // e.g., [-30, -15, 0, 15, 30]
    minBuildingPixelRatio: number;    // 0.2 typical
    pitchDeg: number;
  };
  satellite: {
    scale: 1 | 2;
    maskTrees: boolean;
  };
}
```

Profiles live in `src/pipeline/context/profiles.json`. One base row per size class, modifier rows for SV difficulty and archType. Lookup is pure-function.

### Profile table (base rows)

| size | tile radius | errorTarget | bands | SV dirs | SV offset | maxPanoDist | sat scale |
|---|---|---|---|---|---|---|---|
| tiny (<15m) | 25 | 4.0 | 1 | 2 | 15 | 40 | 1 |
| small (15–50m) | 40 | 2.0 | 1 | 4 | 30 | 80 | 1 |
| medium (50–150m) | 80 | 1.5 | 2 | 6 | 60 | 150 | 1 |
| large (150–300m) | 130 | 1.0 | 3 | 8 | 90 | 200 | 2 |
| skyscraper (300m+) | 150 | 1.0 | 4 | 8 | 120 | 300 | 2 |
| campus | 150 | 1.5 | 2 | 8 | 100 | 200 | 2 |

**Modifier semantics** — modifiers are applied after base-row lookup. Each operation type is explicit:

- `/=`, `*=` — scale numeric field (e.g., `offsetM /= 2`)
- `+=` on arrays — concat + dedup (e.g., `angleVariants += [-45, 45]`)
- `=` — override (e.g., `minBuildingPixelRatio = 0.15`, `maskTrees = true`)

Modifier rows:

- `dense-urban`: `streetview.offsetM /= 2`, `streetview.angleVariants += [-45, 45]`
- `suburban`: identity (default)
- `rural-occluded`: `streetview.angleVariants += [-60, 60]`, `streetview.minBuildingPixelRatio = 0.15`, `satellite.maskTrees = true`
- `no-coverage`: `streetview.dirCount = 0` (skip Stage 4 entirely); palette from satellite + OSM only. Fusion confidence on wallPalette drops to 0.5 since no SV data.

**Classifier rule for `size: 'campus'`:** triggered when `siblingBuildings.length >= 2` AND at least two siblings have `distanceM ≤ 30` AND at least one sibling has `tags['building:part']` set. Otherwise use max-dimension buckets. Campus always uses the `campus` row regardless of max-dimension.

### `TileEvidence`

```ts
interface TileEvidence {
  glbPath: string;
  heightmap: Float32Array;
  heightmapDim: { w: number; l: number };
  measuredBbox: { min: Vec3; max: Vec3 };    // actual captured extent
  truncated: boolean;                         // captured height < 0.6 × expected
  meshCount: number;
  noCoverage: boolean;                        // < 3 meshes
}
```

### `SvEvidence`

```ts
interface SvFacadeEvidence {
  facadeEdge: number;                 // which MBR edge (0-3)
  imagePath: string;
  panoId: string;
  panoDistM: number;                  // actual distance to center
  headingDeg: number;                 // bearing pano → center
  fovDeg: number;
  pitchDeg: number;
  sniff: { sky: number; veg: number; building: number }; // 0-1 ratios
  palette: { wall: Lab; trim: Lab; accent: Lab | null };
  windowGrid: { rows: number; cols: number; confidence: number } | null;
  cornice: boolean;
  occlusion: 'none' | 'trees' | 'adjacent-building' | 'poles';
  // Per-facade confidence (0-1). Fused later.
  confidence: number;
}

type SvEvidence = SvFacadeEvidence[];  // one per captured facade

/**
 * Occlusion classification rule (deterministic, computed from `sniff` + heading variance):
 *   - building% ≥ minBuildingPixelRatio AND veg% < 0.15        → 'none'
 *   - veg% ≥ 0.30                                               → 'trees'
 *   - best-variant differs from primary heading by ≥ 20° AND
 *     both sniffs show building% > 0.25                         → 'adjacent-building'
 *     (the adjacent building was blocking the primary view, a
 *     heading shift cleared it)
 *   - Otherwise                                                  → 'poles'
 *     (thin vertical obstructions, street furniture, low veg)
 */
```

### `SatEvidence`

```ts
interface SatEvidence {
  imagePath: string;
  hiresImagePath: string | null;
  zoom: number;
  treeMask: Uint8Array;               // 1 where canopy detected
  treeMaskDim: { w: number; h: number };
  roofPalette: { primary: Lab; secondary: Lab | null };
  // Shadow azimuth — consumed by environment/scene.ts to orient sun direction
  // in the exported scene GLB (more realistic rendering). Not consumed by the
  // building mesh itself. Dropping to `| null` allowed; downstream treats null
  // as "no sun hint, use default azimuth 135°".
  shadowAzimuthDeg: number | null;
}
```

### `JointEvidence` (fusion output)

```ts
interface Evidence<T> {
  value: T;
  source: 'tiles' | 'osm' | 'solar' | 'sv' | 'sat' | 'smarty' | 'inferred';
  confidence: number;                  // 0-1
}

interface JointEvidence {
  footprint: Evidence<LatLon[]>;
  heightM: Evidence<number>;
  levels: Evidence<number>;
  wallPalette: Evidence<Lab[]>;        // up to 3 dominant colors
  roofPalette: Evidence<Lab[]>;
  roofShape: Evidence<BuildingContext['roofShape']>;
  // Per-facade window grid evidence — each facade has its own confidence.
  // Array index matches MBR facade edge index (0-3). Entry is null if that
  // facade was not captured or window detection failed.
  windowGrid: (Evidence<{ rows: number; cols: number }> | null)[];
  cornice: Evidence<boolean>;
  entry: Evidence<{ edge: number; offsetAlongEdge: number }>;
  trees: { position: LatLon; radiusM: number; source: 'osm' | 'sv' | 'sat' }[];
  roads: { polyline: LatLon[]; width: number; type: string }[];
}
```

### `BuildingBRep` (synthesis output)

```ts
interface BuildingBRep {
  origin: { lat: number; lng: number };
  rotationDeg: number;

  floors: FloorSlab[];                 // one per level
  walls: Wall[];                       // extrusions per facade per floor
  roof: RoofVolume;                    // separate CSG volume
  details: Feature[];                  // windows, doors, cornices, setbacks
  // NB: 'balcony' is reserved in the Feature kind union but no generator in
  // this spec emits one. Add generator + OSM/SV source in a follow-up spec.

  // CSG operations future-ready
  voids?: Volume[];                    // interior (future floorplan subtract)

  // Materials (resolved to Minecraft blocks + GLB PBR)
  materials: {
    wall: MaterialRef;
    trim: MaterialRef;
    roof: MaterialRef;
    window: MaterialRef;
  };
}

interface FloorSlab {
  level: number;
  elevationM: number;
  thicknessM: number;
  polygon: LocalPoint2D[];             // in local (origin-relative, rotation-aligned) coords
}

interface Wall {
  level: number;
  facadeEdge: number;
  start: LocalPoint2D;
  end: LocalPoint2D;
  heightM: number;
  thicknessM: number;
  material: 'wall' | 'trim';
}

interface RoofVolume {
  type: 'flat' | 'gabled' | 'hipped' | 'pyramidal' | 'dome' | 'mansard' | 'shed';
  baseZ: number;
  peakZ: number;
  pitchDeg: number;
  params: Record<string, number>;      // shape-specific
}

interface Feature {
  kind: 'window' | 'door' | 'cornice' | 'setback' | 'balcony';
  facadeEdge: number;
  level: number;
  offsetAlongEdge: number;
  widthM: number;
  heightM: number;
  depthM: number;                      // inset for windows (always ≥ min-wall-thickness)
}
```

---

## Module layout

```
src/pipeline/                    ← NEW, pure core
  context/
    resolver.ts                  ← Stages 0-1
    classify.ts                  ← Stage 2 initial classifiers (size/shape/SV/arch)
                                   + `refineContextWithTiles()` post-Stage-3 refinement
                                   (brands RefinedBuildingContext)
    profile.ts                   ← Stage 2 profile lookup
    profiles.json                ← Profile table data
    types.ts                     ← BuildingContext, RefinedBuildingContext (branded), CaptureProfile
  capture/
    tiles.ts                     ← Stage 3 (pure capture; BVH + DRACO setup extracted from tiles-headless)
    streetview.ts                ← Stage 4 iterative capture
    sv-sniff.ts                  ← Per-image vegetation/sky/building detector
    satellite.ts                 ← Stage 5
    terrain.ts                   ← Elevation + heightmap extraction
    types.ts
  fusion/
    reconcile.ts                 ← Stage 6 main
    occlusion.ts                 ← SV occlusion classifier
    shadow.ts                    ← Satellite shadow analysis
    palette.ts                   ← Wall/roof palette fusion (Lab + K-means)
    windows.ts                   ← Window grid extraction from SV
    types.ts
  synthesis/
    router.ts                    ← Stage 7 routing decision
    parametric.ts                ← Stage 7a
    cleaned-tiles.ts             ← Stage 7b (watertight repair)
    hybrid.ts                    ← Stage 7c
    brep.ts                      ← BuildingBRep datatype + CSG helpers
    features.ts                  ← Window grid, cornice, door, setback generators
    roofs.ts                     ← Roof volume generators by shape
    types.ts
  environment/
    trees.ts                     ← Tree placement from JointEvidence
    roads.ts                     ← OSM roads → 3D strips
    terrain-mesh.ts              ← Heightmap → scene ground
    scene.ts                     ← Assembly
  export/
    glb-print.ts                 ← Stage 8a
    glb-scene.ts                 ← Stage 8b
    voxel.ts                     ← Stage 8c (thin wrapper over existing voxelizer.ts)
    glb-writer.ts                ← Shared glTF 2.0 writer (extracted from tiles-headless.ts inline code)
  verify/
    objective.ts                 ← Deterministic gates
    consensus.ts                 ← Multi-VLM polish scoring
    report.ts
  pipeline.ts                    ← Top-level orchestrator

src/gen/api/                     ← KEPT (pure API clients)
src/gen/color-blocks.ts          ← KEPT (CIE-Lab + WALL_CLUSTERS)
src/convert/voxelizer.ts         ← KEPT (BVH + CIE-Lab)
src/convert/building-alignment.ts ← KEPT (MBR)
src/convert/geo-projection.ts    ← KEPT
src/convert/class-block-map.ts   ← KEPT
src/schem/                       ← KEPT (NBT + litematic + schem writers)
src/grade/vlm-consensus.ts       ← NEW (multi-model wrapper)
src/grade/prompts.ts             ← KEPT (trimmed)

scripts/
  build.ts                       ← NEW: entry point  `bun scripts/build.ts <address> --out out/`
  iterate.ts                     ← NEW: objective + consensus driver
  _legacy/                       ← OLD tiles-headless.ts, voxelize-glb.ts, iterate-*.ts, fetch-reference-data.ts

web/src/ui/tiles.ts              ← REWRITTEN (see notes below)

.claude/hooks/
  check-pipeline-state.sh        ← NEW (replaces the 3 old hooks)

DELETE:
  src/convert/pipeline.ts        ~1150 lines
  src/convert/mesh-filter.ts     ~165 lines
  src/convert/mesh-filter/*.ts   ~8830 lines
  src/convert/voxel-classifier.ts ~524 lines  (the ~30 useful lines — `writeWithPriority`, `VoxelClass` enum for building/environment priority — are re-implemented in `src/pipeline/export/voxel.ts` as ~40 lines. Net reduction: ~484 lines, not 524.)
  src/convert/scene-pipeline.ts  ~517 lines
  src/convert/semantic-palette.ts ~465 lines (concept re-implemented in fusion/palette.ts)
  src/convert/scene-enrichment.ts ~791 lines (rewritten in environment/)
  src/convert/osm-infrastructure.ts ~315 lines (rewritten in environment/roads.ts)
  src/grade/defect-score.ts, category-score.ts etc.  (replaced by verify/)
  scripts/iterate-category-grade.ts, iterate-grade.ts, fetch-reference-data.ts (archived to _legacy/)
  .claude/hooks/check-category-state.sh, check-iterate-state.sh, check-scene-completion.sh
```

**Net**: delete ~12,000 lines of bandaid; keep ~7,600 lines of quality code; add ~2,500 lines of clean core.

**`web/src/ui/tiles.ts` rewrite scope.** The existing file is not thin — it handles tile loading (rAF throttling workarounds for Android Edge), Web Worker voxelization (`voxelize-worker.ts`), Canvas2D texture rasterization, manual XZ selection via raycaster, and an upload UI. The rewrite moves:

- **Pure core** (absorbed into `src/pipeline/capture/tiles.ts`): tile-loading stats + stable-frame detection, mesh extraction, heightmap rasterization
- **Pure core** (absorbed into `src/pipeline/export/voxel.ts`): voxelization dispatch; the Web Worker is kept in `web/src/workers/voxelize-worker.ts` and wraps `src/pipeline/export/voxel.ts` via a shared interface
- **Browser-only concerns** (stays in `web/src/ui/tiles.ts`): DOM/Canvas, rAF workarounds, upload UI, manual selection raycaster, pure-core driver (lifecycle only)

Migration step 14 is where this absorption happens. The file is expected to shrink from ~1,800 lines to ~300 lines (pure UI + driver), with the substantial logic living in the pure core.

---

## Stage specifications

### Stage 0 — Geocode

- Use existing `src/gen/api/geocoder.ts`
- Require `locationType === 'ROOFTOP'` or `RANGE_INTERPOLATED`; warn on lower-precision results
- Output: `{ lat, lng, placeId, viewport, bounds, locationType }`

### Stage 1 — Coarse Context

- Parallel OK (all three queries are independent and tiny):
  - Solar Building Insights (`querySolarBuildingInsights`)
  - OSM Overpass + spatial footprint query + tag extract + `building:part` sibling scan for campus detection
  - Smarty (US-only via API client)
- Output: `ContextDraft` — union of all fields above without classification yet

### Stage 2 — Classify + Profile

- **Size**: `max(widthM, depthM)` → bucket (table)
- **Shape (initial, from polygon only)**:
  - `vertexCount` ≤ 4 and aspect ratio 0.8-1.2 → `rect`
  - `vertexCount` ≤ 4 and aspect < 0.4 or > 2.5 → `rect` (elongated)
  - Triangle-like (3 effective vertices after simplification) → `wedge`
  - Concavity analysis: inner rings → `courtyard`; one major concavity → `U`; three+ wings → `multi-wing`
  - Vertex count ≥ 12 and smooth curvature → `curved`
  - Otherwise → `irregular`
- **Shape refinement (post-Stage 3, via `refineContextWithTiles()`):**
  - If heightmap max-height column exists only near polygon centroid AND surrounding cells are ≤ 50% of centroid max-height → `tower-podium` (overrides initial classification)
  - This is the **only** field mutated after Stage 2. Called as `const ctx2 = refineContextWithTiles(ctx, tiles);` in the orchestrator. The router reads `ctx2.shape`, never `ctx.shape`.
- **SV difficulty**: OSM `landuse` around point, OSM `natural=tree` density, OSM road class nearest
  - Residential w/ trees → `rural-occluded` or `suburban`
  - CBD / downtown → `dense-urban`
  - No SV metadata within 100m of center → `no-coverage`
- **archType**: primary OSM tag cascade (`building=` value, `historic=*`, `tourism=*`, `amenity=*`) + Smarty `use` + heuristics
- Lookup profile in table; apply modifiers; return frozen `{ context, profile }`

### Stage 3 — Tile Capture

- Extracted from existing `scripts/tiles-headless.ts` capture loop
- DRACO setup, polyfills moved to `src/pipeline/capture/tiles-deps.ts`
- Camera strategy from profile:
  - `ortho` for complex footprints (U, multi-wing, courtyard)
  - `perspective` for skyscrapers (vertical bands)
  - `street` for tiny/residential
- Multi-angle capture with MBR-aligned bearings (not cardinals) when polygon available
- Vertical bands from profile `verticalBands`
- After capture:
  - Extract heightmap (existing logic from tiles-headless.ts)
  - Measure actual bounding box
  - `truncated` if `measuredBbox.y < 0.6 × context.heightM`
  - `noCoverage` if `meshCount < 3`
- Output GLB via extracted glTF 2.0 writer (`src/pipeline/export/glb-writer.ts`)

### Stage 4 — SV Capture (iterative)

Per direction in `profile.streetview.dirCount` (directions distributed along MBR edges, not arbitrary cardinals):

1. **Metadata probe**
   - Query SV Metadata API at offset point (profile.offsetM meters along direction from center)
   - If `status != OK`, retry at `0.5×` offset, then `1.5×` offset
   - If all 3 fail: mark direction `no-pano`, continue

2. **Pano validation**
   - If `panoDistM > profile.maxPanoDistM`: pano is too far; mark direction `too-distant`, continue

3. **Compute framing**
   - `heading = bearing(pano → center)`
   - `facadeWidth = relevant MBR edge length` (pick the edge whose normal is closest to `heading`)
   - `fov = clamp(60, 2 × atan2(facadeWidth × 0.65, panoDistM) × 180/π, 110)`
   - `pitch = profile.pitchDeg`, scaled by (context.heightM / panoDistM) heuristic

4. **Fetch and sniff primary image**
   - Fetch SV image at computed heading/fov/pitch
   - Sniff (`src/pipeline/capture/sv-sniff.ts`):
     - `sky%`: blue-white ratio in top 30%
     - `veg%`: green-brown ratio (HSV-based) in middle 70%
     - `building%`: 1 - sky% - veg% (approximation; refined by edge density)
   - If `building% ≥ profile.minBuildingPixelRatio`: accept

5. **Retry on occlusion**
   - If occluded: try each heading in `profile.angleVariants` (±15°, ±30°, maybe ±45° for dense-urban)
   - Pick the variant with highest `building%`
   - If no variant clears threshold: keep best effort, mark `occlusion` field accordingly

6. **Post-processing per facade**
   - Extract palette (wall, trim, accent) via K-means in Lab space, zone-sampled (bottom 60% for wall, top 20% for trim)
   - Detect window grid: Hough lines + regular horizontal banding → (rows, cols, confidence)
   - Detect cornice: horizontal dark band at top 10-15% of facade
   - Assign to MBR edge (nearest facade normal to heading)

Output: `SvFacadeEvidence[]`, one entry per successfully captured facade; missing facades are fine (fusion handles gaps).

### Stage 5 — Satellite

- Zoom from `TileEvidence.measuredBbox` (satellite-zoom.ts util, passes in measured extent)
- Scale from profile (`2` for large/skyscraper/when canopy expected)
- Tree mask construction:
  - Input: satellite image + `sv.occlusion` signal + OSM `natural=tree` nearby
  - Green-cluster detection (HSV thresholds) excluding roof-similar greens
  - Dilate mask by 2px for margin
- Roof palette: K-means in Lab on unmasked pixels within inner 70% of image
- Shadow detection: if ground-level dark blob consistently on one side, estimate azimuth

Output: `SatEvidence`.

### Stage 6 — Fusion

For each evidence field, apply conflict rules:

| Field | Primary | Secondary | Tertiary |
|---|---|---|---|
| Footprint | OSM polygon | Tile boundary-silhouette | Solar bbox rectangle |
| Height | Tiles (non-truncated) | Solar | OSM `building:levels × 3.5m` |
| Levels | OSM `building:levels` | Smarty | SV window-grid row count |
| Wall palette | SV (K-means) | Tile texture median | OSM `building:colour` |
| Roof palette | Satellite (tree-masked) | Tile texture top-slice | OSM `roof:colour` |
| Roof shape | OSM `roof:shape` | Solar pitch heuristic | archType default |
| Window grid | SV extraction | Procedural from levels | None |
| Entry edge | OSM `entrance` node nearest facade | SV door detection | Street-facing edge |
| Trees | OSM + SV occlusion + sat mask (union & dedup by position) | — | — |
| Roads | OSM (primary highway, residential, footway) | — | — |

Each field stores chosen `value`, `source`, `confidence` (computed from rule's confidence table).

Palette reconciliation: when SV and OSM tag agree within delta-E 10, confidence = 1.0. When they disagree > delta-E 20, log warning, use SV value, downgrade confidence to 0.6.

**Note on Stage 4 zone-sampling framing:** The "bottom 60% for wall, top 20% for trim" rule (Stage 4 step 6) is applied **after** masking out sky and vegetation pixels via the cheap HSV threshold reused from sniff. Tower shots where sky fills the top and podium fills the bottom still yield meaningful wall/trim samples because the zones refer to the masked building region, not the raw image.

### Stage 7 — Synthesis Router

```ts
// Branded refined type — compiler catches consumers reading raw `ctx` where
// `ctx2` is required. The refinement function produces this type; the router
// only accepts this type. No accidental "forgot to refine" bugs.
type RefinedBuildingContext = BuildingContext & { readonly __refined: true };

function routeSynthesis(
  ctx: RefinedBuildingContext,   // must be post-refineContextWithTiles()
  ev: JointEvidence,
  tiles: TileEvidence,
): SynthesisPath {
  const iconic = ctx.rawOsm?.tags?.tourism === 'attraction'
              || ctx.rawOsm?.tags?.historic === 'monument'
              || ctx.rawOsm?.tags?.heritage != null;
  if (iconic && !tiles.noCoverage) return '7c-hybrid';
  if (ctx.shape === 'curved' || ctx.shape === 'irregular') return '7b-cleaned-tiles';
  if (tiles.truncated && ctx.size === 'skyscraper' && ctx.polygon) return '7a-parametric';  // synth from polygon, ignore truncated mesh
  if (!ctx.polygon) return '7b-cleaned-tiles';
  return '7a-parametric';
}
```

**Orchestrator call shape:**

```ts
// src/pipeline/pipeline.ts
const ctx1 = await resolveContext(address, apiKey);    // Stage 0-2 initial
const profile = lookupProfile(ctx1);                    // Stage 2 profile
const tiles = await captureTiles(ctx1, profile);        // Stage 3
const ctx2 = refineContextWithTiles(ctx1, tiles);       // post-3 refinement → RefinedBuildingContext
const sv = await captureStreetView(ctx2, profile);      // Stage 4
const sat = await captureSatellite(ctx2, tiles, sv, profile);  // Stage 5
const joint = fuseEvidence(ctx2, tiles, sv, sat);       // Stage 6
const path = routeSynthesis(ctx2, joint, tiles);        // Stage 7 router
const brep = await synthesize(path, ctx2, joint, tiles);
// ... export + verify
```

### Stage 7a — Parametric Synthesis

Deterministic generator from `JointEvidence`:

1. **Footprint polygon** — from `ev.footprint.value`, simplified (Douglas-Peucker 0.5m tolerance), rotated into local frame aligned with MBR
2. **Floor slabs** — `N = ev.levels.value` slabs, each at `elevationM = N × floorHeight`, `thicknessM = 0.3`. `floorHeight = ev.heightM.value / N` clamped [2.5, 5.0]
3. **Walls** — extrude each polygon edge from floor to ceiling per level. `thicknessM = 0.3`
4. **Roof** — from `ev.roofShape.value`:
   - `flat` — horizontal lid, slight parapet (0.5m)
   - `gabled` — ridge along long axis, pitch from Solar or default 30°
   - `hipped` — ridge shortened, all four sides sloped
   - `pyramidal` — apex at centroid
   - `dome` — half-sphere fitted to footprint's inscribed circle
   - `mansard` — two-tier slope, steep bottom + shallow top
   - `shed` — single slope
5. **Details**:
   - Window grid from `ev.windowGrid.value[facade]`: regular rectangular grid on each facade, insets by `windowDepthM = 0.08m`
   - Cornice from `ev.cornice.value`: horizontal band at top of each facade, depth 0.15m, height 0.5m
   - Entry door from `ev.entry.value`: at ground level, offset along specified edge
6. **Materials**:
   - Wall material from `ev.wallPalette`
   - Trim + roof from respective evidence
   - Window material = glass (transparent in GLB; glass block in voxel)

Output is a `BuildingBRep`. CSG operations produce the watertight mesh at export time.

### Stage 7b — Cleaned Tiles (fallback)

1. Clip `TileEvidence.glb` to OSM polygon boundary (hard clip) if polygon available; otherwise clip to `ctx.mbr.corners` rectangle.
2. Repair walls: for each XZ column in the captured extent, fill holes vertically — from min Y of that column up to its max Y, any missing voxel/triangle gap is closed by extending the nearest horizontal face to its vertical neighbor. Implementation uses a marching-squares pass per vertical slab.
3. Close bottom: extend vertical walls down to ground elevation (`ctx.groundElevationM`) with a flat base cap.
4. Close top if truncated: if `truncated` and `ctx.heightM` known:
   - Take the **topmost complete horizontal cross-section** (highest Y where ≥ 80% of columns have geometry). This is the `template cross-section`.
   - Extrude the template cross-section upward from `template.y` to `ctx.heightM`, with a linear Y taper of 0-2% applied to XZ so the extrusion matches tapered skyscraper silhouettes.
   - Texturing: sample a 1m-tall horizontal band from the `template.y - 2m` region of the captured mesh, tile it vertically on the extruded surface. No color interpolation — the band texture is repeated. This is cheap and realistic; VLM review will flag if it looks fake.
5. Output is a triangle mesh (non-B-rep). Watertightness is enforced by the repair+close passes; objective gate confirms.

This path produces a printable mesh but lacks the clean feature detail of parametric. Objective gates still apply.

### Stage 7c — Hybrid (iconic landmarks)

- Use parametric mass (floors, walls extruded from polygon)
- Use photogrammetry textures from tiles for facade detail (baked into texture atlases)
- Roof and details from tiles directly (since these are usually why the building is iconic)

Not an MVP priority; spec'd for future step.

### Stage 8 — Export

**8a Print GLB:**
- CSG evaluate `BuildingBRep` into triangle mesh
- Union all volumes (floors, walls, roof, features)
- Subtract window-inset volumes (creates recessed windows). The inset volume is bounded — it does not cut through the entire wall. Inset depth is 0.08m; wall thickness is 0.3m, leaving 0.22m of sealed wall behind the inset (2.2mm at 1:100 print scale, above the 0.8mm gate).
- Produce **two mesh groups** in the glTF output:
  - `group_structural` — the building volume, required to be watertight + manifold. The objective gates at Stage 9 check this group ONLY.
  - `group_fixtures` — optional non-structural meshes (transparent windowpane planes, decorative items). Not subject to watertight/manifold gates; can have thin features.
- Watertightness + manifold + self-intersect checks run on `group_structural`. Abort on failure.
- Optional plinth (separate `group_plinth`): extrude footprint by 5mm thickness, 2cm wider. Also gated for watertightness independently.
- Export as glTF 2.0 binary with the groups as named scene nodes so slicers (Prusa, Cura) can accept/reject the fixtures group.

**8b Scene GLB:**
- 8a output (but without plinth)
- Terrain mesh from `TileEvidence.heightmap` with satellite texture
- Tree instances from `JointEvidence.trees`
- Roads as flat polygon strips from OSM
- Not required to be watertight
- Export as glTF 2.0 binary

**8c Voxel:**
- Run `voxelizer.ts` on the B-rep's evaluated mesh (from 8a pipeline)
- Existing CIE-Lab matching via `color-blocks.ts`
- Scene voxelization (optional): environment at priority 0, building at priority 1 (existing `writeWithPriority` pattern, kept from voxel-classifier but in a simpler form)
- Export as .schem + .litematic

### Stage 9 — Verify

**Objective gates** (deterministic, must pass, evaluated on `group_structural` unless noted):

| # | Gate | Check | Threshold |
|---|------|-------|-----------|
| 1 | Footprint IoU | Shapely-style polygon IoU of top-down silhouette vs OSM polygon | ≥ 0.85 |
| 2 | Height error | `\|synth.height - ev.heightM\| / ev.heightM` | ≤ 0.10 |
| 3 | Watertight | Count of boundary edges (edges with ≠ 2 incident faces) | = 0 |
| 4 | Manifold | Every edge has ≤ 2 incident faces AND every vertex has one connected edge-loop (fan property) | true |
| 5 | Self-intersect | AABB-tree accelerated triangle-triangle intersection test. **Exhaustive** (no sampling). Uses three-mesh-bvh. | = 0 |
| 6 | Min wall thickness | Ray-marching from each surface triangle centroid along `-normal`, first inside-hit distance is wall thickness. Minimum across sampled triangles (1 per 5cm² surface area). At 1:100 print scale (real mm = mesh m × 10) | ≥ 0.8mm (= 0.08m real) |
| 7 | Voxel occupancy (building only) | Non-empty voxel count | ≥ 1 AND ≤ 500,000 |
| 8 | Plinth watertight (if exported) | Same check as Gate 3 on `group_plinth` | = 0 (skipped if no plinth) |

**Rationale for thresholds:**
- **IoU ≥ 0.85**: prior pipeline averaged 0.89 on passing buildings and 0.72 on failing; 0.85 is the meaningful boundary.
- **Height error ≤ 10%**: matches typical Solar API uncertainty; tighter threshold would fail truncated skyscrapers where Solar is the authoritative height.
- **Self-intersect exhaustive, not sampled**: sampling can miss thin intersections that would print as tangled strings. BVH makes it O(n log n) instead of O(n²), tractable for meshes up to ~500K triangles.
- **Voxel ≤ 500K**: mobile Minecraft clients choke above ~500K blocks in a single schematic; also matches Litematica plugin's practical ceiling.

**Note on watertight/windows interaction**: See Stage 8a — the inset windows are bounded cavities, not through-holes, so they do not open the building volume. Windowpane planes (if exported) live in `group_fixtures` and are explicitly outside the watertight gate.

**Subjective consensus** (after objective pass):

- Render 4 views via Three.js headless: front-MBR, 3/4 aerial, top-down, isometric
- Views + reference SV/sat images submitted to:
  - **Gemini 2.5 Pro** (via `src/gen/api/gemini.ts`)
  - **Claude** (via `mcp__pal__consensus` or `mcp__pal__chat` — single-call)
  - **GPT-5** (via `mcp__pal__chat` — single-call)
- Prompt: "Score this synthesized model against the reference images on {color, features, massing, overall}, 0-10."
- Each returns four scores.
- `min = min(model × dimension)` = the minimum score across all 12 (3 models × 4 dimensions)
- `median = median(model × dimension)`
- `spread = max(model × dimension) - min(model × dimension)` computed per dimension (report max spread across dimensions)
- **Release gate**: `median ≥ 8.5` AND `min ≥ 7` AND `max spread per dimension ≤ 2`
- **Rationale for thresholds**:
  - `median ≥ 8.5`: A median of 8.5 across 12 scores means typical rating is high; matches the user's "looks great" bar.
  - `min ≥ 7`: no single dimension×model is catastrophically bad. A 6 from any model on any dimension indicates a real defect worth fixing, not model bias.
  - `spread ≤ 2`: filters cases where one model outlies (e.g., Gemini rates photogrammetry highly, Claude penalizes it). The gate shouldn't release on a single model's outlier optimism; conversely, a single model's outlier pessimism shouldn't block release if the other two agree.
  - Prior pipeline's single-Gemini plateau was `~8/10 avg across 7 categories`. New gate is measurably stricter (median ≥ 8.5) but not catastrophically so (min ≥ 7 allows one weak dimension per model).
- **Loop termination (prevents infinite re-voting):**
  - Round 1: vote once.
  - If spread > 2 on any dimension: Round 2 re-renders with rotated view angles (45° rotation of the 3/4 view + alternate isometric quadrant), re-votes.
  - If spread > 2 persists: Round 3 re-renders at higher resolution (4K) to rule out rasterization artifacts, re-votes.
  - After Round 3: **terminal state**. The verification result is `status: 'needs-human-review'` with `consensus`, `spread`, and all per-model scores recorded. This is neither pass nor fail — it's a third state. The stop hook (Stage 10) treats `needs-human-review` as non-blocking (exits 0) and the address is listed in a daily summary for manual look. This prevents the hook from re-triggering the consensus loop forever.

### Stage 10 — Stop hook

`.claude/hooks/check-pipeline-state.sh` reads `output/pipeline-state.json`. Canonical state record shape:

```json
{
  "version": "v400",
  "addresses": {
    "flatiron": {
      "objective": {
        "footprintIoU": 0.91,
        "heightErr": 0.04,
        "watertight": true,
        "manifold": true,
        "selfIntersect": 0,
        "minWallThicknessMm": 2.2,
        "voxelCount": 48000,
        "plinthWatertight": true,
        "pass": true
      },
      "consensus": {
        "rounds": 1,
        "gemini": { "color": 9, "features": 8, "massing": 9, "overall": 9 },
        "claude": { "color": 8, "features": 8, "massing": 9, "overall": 8 },
        "gpt5":   { "color": 9, "features": 9, "massing": 9, "overall": 9 },
        "min": 8,
        "median": 8.75,
        "spread": 1,
        "pass": true
      },
      "status": "pass",
      "lastRun": "2026-04-17T12:00:00Z"
    }
  }
}
```

`status` is the canonical field the hook reads. Values: `pass | fail-objective | fail-consensus | needs-human-review | context-insufficient`.

- `pass` — objective and consensus both pass
- `fail-objective` — at least one objective gate failed
- `fail-consensus` — objective passed, consensus `min < 8` or `spread > 2` (still re-runnable)
- `needs-human-review` — consensus loop exhausted (3 rounds), disagreement unresolved
- `context-insufficient` — resolver could not produce a usable `mbr` (no polygon, no Solar bbox, no usable geocode viewport). Terminal; no amount of re-capture fixes it
- `objective.pass` and `consensus.pass` are derived booleans (convenience for log inspection); the hook MUST branch on `status`, not on the derived booleans, to avoid divergence

**Hook logic (ordered, terminal states first):**

```
for each address:
  1. stop_hook_active flag → exit 0 (prevent re-entry loop)
  2. status === 'needs-human-review' → exit 0 non-silently, log dissent summary to stderr
  3. status === 'context-insufficient' → exit 0 non-silently, log to stderr, recommend manual OSM trace
  4. status === 'fail-objective' → BLOCK with "EXECUTE NOW: rebuild {slug} — {failing_gate} (threshold={t}, got={v})"
  5. status === 'fail-consensus' → BLOCK with "EXECUTE NOW: improve {slug} on {worst_dim} (score={s})"
  6. status === 'pass' → continue to next address (exit 0 silently when all addresses processed)
```

The terminal-states-first ordering means no interdependent rule guards. Each rule is independent and the ordering captures "skip" semantics naturally.

---

## Golden test set

Initial 5 (cover size/shape space):

| # | key | location | size | shape | path | notes |
|---|---|---|---|---|---|---|
| 1 | flatiron | NYC | medium | wedge | 7a parametric | canonical parametric happy path |
| 2 | guggenheim | NYC | medium | curved | 7c hybrid | iconic, curved, tests cleaned-tiles as fallback |
| 3 | pennzoil | Houston | large | tower-podium | 7a parametric (despite truncation) | tests height extrapolation |
| 4 | geisel | UCSD | medium | multi-wing | 7b cleaned-tiles | tests complex shape fallback |
| 5 | 240-highland | Newton MA | small | rect | 7a parametric | suburban residential, gabled roof |

After MVP (step 12): expand to all 20 existing + the 10 planned new locations.

---

## Migration plan

Each step is one commit/PR, feature-gated. Old entry points (`scripts/voxelize-glb.ts`, `scripts/tiles-headless.ts`) stay functional until step 14.

1. **Scaffold** — `src/pipeline/` directory skeleton with types files and empty stubs. `bunx tsc --noEmit` clean.
2. **Resolver** — Stages 0-2. Pure functions + profile table JSON + classifier. Tests against 5 goldens: correct `BuildingContext` + `CaptureProfile` output.
3. **Tile capture** — Stage 3, extracted from `tiles-headless.ts` into pure core. Preserves existing behavior. Legacy script becomes a thin wrapper. **Plumbing cost**: the extraction must keep the legacy script functional until step 14, so the pure-core module is initially required to expose exactly the behaviors the legacy script relies on (DRACO setup, polyfill hooks, GLB writer). Extra wrapper surface is temporary and deleted in step 15.
4. **SV capture** — Stage 4 iterative loop. Can unit-test the sniff function independently. Mock API responses in tests.
5. **Satellite** — Stage 5. Tree-mask unit tests with synthetic inputs.
6. **Fusion** — Stage 6. Deterministic; unit tests per conflict rule.
7. **Parametric synthesis** — Stage 7a. Hardest step. Unit-test each roof shape generator, each feature generator independently. Integration test: 5 goldens → B-rep whose polygon matches OSM.
8. **Cleaned-tiles fallback** — Stage 7b. Watertight repair + top extrapolation.
9. **Export GLBs** — Stages 8a/b. Watertight/manifold checks built in.
10. **Voxel export** — Stage 8c, wrapping existing voxelizer.ts.
11. **Objective verification** — Stage 9 objective gates.
12. **VLM consensus** — Stage 9 subjective + multi-model wiring.
13. **New hook + iterate.ts + state file** — Stage 10. Old hooks archived, not deleted (recoverable).
14. **Browser adapter** — `web/src/ui/tiles.ts` rewritten as thin adapter over `src/pipeline/`.
15. **Cleanup** — delete old `pipeline.ts`, `mesh-filter/`, `voxel-classifier.ts`, `scene-pipeline.ts`, `scene-enrichment.ts`, `osm-infrastructure.ts`, `semantic-palette.ts`, old grade modules, old scripts to `_legacy/`, old hooks to archive.

Rollback: each step is self-contained. Steps 1-12 leave old pipeline functional. Steps 13-15 are the "flip switch" steps.

---

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Parametric fails on buildings with weird shapes not in the shape taxonomy | Router falls back to cleaned-tiles (7b). Adding a new shape class is one classifier update + optional parametric generator |
| VLM consensus never converges (models always disagree) | Spread >2 for 3 rounds → surface dissent to human; don't block forever |
| Tile capture on large skyscrapers stays truncated | Design accepts this: parametric path uses polygon + Solar height, ignores truncated mesh for 7a. 7b extrapolates |
| Termux/ARM GPU issues reoccur with new browser adapter | Adapter is optional; CLI works fully independently. Browser is feature-gated and can lag |
| API costs balloon | Multi-VLM consensus only runs after objective pass. Each address graded 1× unless explicitly re-run. Consensus budget per month is monitorable |
| Interior floorplan support breaks the B-rep design | `voids?: Volume[]` field on BuildingBRep reserves the slot. Floors as separate slabs means floor-level subtract is natural. Validated by example in spec |
| Scope explosion during implementation | Each of the 15 migration steps is independently shippable. Stop at any step if urgency shifts |

---

## Success criteria

MVP (end of step 12):
- 5 goldens all pass all objective gates
- 4 of 5 goldens pass consensus gate (`median ≥ 8.5 AND min ≥ 7 AND spread ≤ 2`)
- Building print GLB opens in Prusa / Cura without warnings
- Building voxel schem for 5 goldens is visually on par or better than existing output. **The 7-category rubric (old pipeline) is NOT used for MVP grading** — the new 4-dimension VLM consensus (color / features / massing / overall) is the canonical subjective metric from step 12 onward. Side-by-side comparison against old schems is advisory only, for sanity checks during migration
- **Verification is driven manually at MVP** — `scripts/build.ts <address>` runs the pipeline, writes `output/pipeline-state.json`, and prints status per address. Automated hook-driven iteration is step 13 work. MVP success is evaluated by running `bun scripts/build.ts` against the 5 goldens and reading the resulting state file

Full (end of step 15):
- All 20 existing buildings pass objective gates
- Median consensus score ≥ 8.5, minimum ≥ 8.0
- Pipeline handles the 10 new planned locations (e.g., Fallingwater, Chrysler, Space Needle) end-to-end
- Old pipeline files deleted; repo is ~10K lines lighter
- Single entry: `bun scripts/build.ts <address>` produces all artifacts

---

## Open questions (for implementation, not design)

None blocking. Items below are implementation-time decisions that should not stop the design.

- CSG library choice — roll our own vs. depend on `manifold-3d` or `three-bvh-csg`. Both work; will pick during step 7a based on bundle size.
- Tree instance LOD — per-tree mesh vs. instanced billboard. Scene GLB quality impact; decide during step 8b.
- Smarty fallback for non-US — parcel-area inference from OSM + Solar. Implement only if non-US support requested.
