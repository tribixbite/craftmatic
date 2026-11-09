# Scenario A plan: original brick-style packs for the Minecraft Marketplace

Written 2026-11-09 by the Scenario A planner, for the user's choice of A + B + D (TASKS-BUSINESS.md). Nothing
here is legal advice. A lawyer reviews the "lawyer" items in section 9 before any paid listing. Nothing in this plan
goes outward (no publisher pitch, store upload, account sign-up or repo creation) without the user's per-instance
approval. Those steps are written as **prepared, awaiting approval**.

Read first: `CLAUDE.md`, `docs/business-scenarios.md`, `TASKS-BUSINESS.md`,
`output/business-1106/1-legality.md` and `output/business-1106/4-create-list-sell.md` (gitignored, local only).

Contents:
0. Measured baseline: what the repo has and lacks today
1. Product line: what Scenario A ships
2. Architecture: modules, boundaries, data types
3. The part mapper (`brickgen`)
4. The 20+ landmark icons
5. The other pack types, the epic coaster first
6. Our own figure
7. Marketplace readiness
8. Test strategy
9. Risks, and open questions for the user
10. Work packages
11. Parallelisation order and the file-collision map
12. REQUIREMENTS.md rows BIZ-05..BIZ-29
13. Tracker structure (`TASKS-BUSINESS.md` section)

---

## 0. Measured baseline

Everything in this section was read off the repo on 2026-11-09.

### 0.1 What exists and can be reused

| Capability | Where | Reuse |
|---|---|---|
| Address -> OSM footprint, height, levels, roof tag | `src/pipeline/context/resolver.ts:391` `resolveContext`, `:185` `resolveHeight`, `:444` `roofShapeFromTags`; `src/gen/api/osm.ts:59` `searchOSMBuilding`, `:180` `searchOSMBuildingParts`, `:255` `fetchOSMById` | Site input stage, unchanged |
| Footprint shape classification | `src/pipeline/context/classify.ts:131` `classifyShape`, `:200` `classifyArchType`, `:249` `refineContextWithTiles` | Massing stage |
| Evidence fusion with confidence | `src/pipeline/fusion/types.ts:19` `Evidence<T>`, `:38` `JointEvidence`; `reconcile.ts:507` `fuseEvidence` | Same pattern for our `SiteEvidence` |
| A building B-rep before any Minecraft block | `src/pipeline/synthesis/brep.ts:70` `BuildingBRep` (floors, walls, `RoofVolume` :39, `Feature[]` :51) | The natural branch point: brickgen consumes it |
| Mesh slicing into height bands | `src/pipeline/synthesis/slice-extract.ts` `sliceMeshAtY`, `extractBands`; `sliced-tiles.ts` | Massing from a licence-clean mesh (LiDAR, own scans) |
| Photo analysis (legacy) | `src/gen/api/streetview-analysis.ts:481` `detectStories`, `:836` `analyzeFenestration`, `:556` `classifyTexture`, `:618` `estimateRoofPitch`, `:718` `analyzeSymmetry` | Run on LICENCE-CLEAN photos only (section 3.2) |
| Lab k-means palettes | `src/pipeline/fusion/palette.ts:140` `extractPalette`, `:178` `dominantLab` | Colour stage |
| Lab nearest match template | `web/src/engine/color-utils.ts:33` `rgbToLab`, `:152` `closestBlock` | Copy the method over `LDCONFIG_RGB` |
| LDraw colours | `web/src/engine/ldconfig-colors.generated.ts:5` `LDCONFIG_RGB`, `:331` `LDCONFIG_ALPHA`; `ldraw-color-classes.json` (322 colours) | Production palette |
| Part dimensions | `web/src/engine/ldraw-part-dims.ts:590` `getPartDims`, `:897` `getPartShape`; generated table `ldraw-part-dims-generated.ts` | Vocabulary sizes |
| LDraw parse | `web/src/engine/ldraw-parser.ts:22` `ParsedBrick`, `:118` `parseLDrawDocument` | Round-trip test of our writer |
| Connectivity audit | `web/src/viewer/ldraw/connectivity-audit.ts:255` `auditConnectivity` (surface contact plus LDCad snaps; over-connects by design, header :1-70) | Cross-check of the stronger lattice verifier |
| Procedural generators (Minecraft) | `src/gen/gen-cathedral.ts` (349 lines), `gen-castle.ts`, `gen-tower.ts`, `styles.ts` | Grammar ideas only; they emit blocks |
| LDraw -> Bedrock add-on | `web/src/engine/schem-pipeline.ts:280` `runSchemPipeline` (source `kind: 'bricks'` takes `ParsedBrick[]` directly, :53); CLI `scripts/_playable_ref.ts` | Final stage, unchanged |
| Coaster path math | `web/src/engine/coaster-path.ts:215` `createCoasterRoute`, `:260` `buildCoasterPath`, `:271` `buildCoasterFrames`, `:370` `sampleCoasterPath` | Takes ANY point list; a synthetic course already exists in `test/bedrock-coaster.test.ts:1717-1730` |
| Coaster runtime | `web/src/engine/bedrock-coaster.ts` (3,809 lines): `COASTER_PHYSICS` :641, `rideSubstep` :760, `coasterTrackUps` :982, `coasterRuntimeConfig` :1503, `coasterScript` :3807; `COASTER_MAX_CARS = 8` :578 | Generated tracks plug in here |
| Rider camera | `COASTER_RIDER_VIEW.mode = 'native'` (`bedrock-coaster.ts:568`); `docs/coaster-loop-camera.md:44-125` | Long inversions and launches need new sim cases |
| Rides | `web/src/engine/bedrock-rides.ts`: kinds slide, lift, orbit; `findSlides` :299, `findLifts` :316 | Theme-park rides |
| Vehicles | `web/src/engine/bedrock-vehicle.ts`: car/boat/plane/rotor/hover/flyer (:40), `flightStep` :237, `carStep` :419, `scriptedVehicleRuntime` :1382 | Garage pack |
| Interactives | `web/src/engine/bedrock-interactives.ts`: door, gate, cabinet, window, hatch, lever, turnable, lid, drawer (:68), `MAX_INTERACTIVES = 40` (:94) | Doors and furniture pack |
| Pinball | `web/src/engine/pinball-table.ts:187` `detectPinballTable`; `pinball-physics.ts`; `bedrock-pinball.ts:380` `planPinball` | Pinball arcade |
| Figures | `web/src/engine/minifig-rig.ts:61` `FigureSystem = 'minifig' \| 'minidoll' \| 'bigfig'`; canon :156/:184/:205; bones :239; gait :1077 | Seam for our figure (section 6) |
| Placement with confirm and Undo | `web/src/engine/bedrock-placement-pack.ts:1547` `confirmPlace`; Undo record persisted per player, :1062-1096 | Needs "air only" (section 7.6) |
| Offline gates | `scripts/_mcaddon_check.py` (307 lines), `scripts/_pack_render.ts`, `scripts/_cockpit_view.ts`, `bun scripts/sim.ts` | Extended, not replaced |
| Bedrock Dedicated Server | `C:/git/bds/1.26.63.1/` (port 19150, world `cmtest` with Beta APIs; memory `reference-bedrock-test-ladder`) | Content-log gate, in a NEW world without experiments |

### 0.2 What does not exist (each is a work package)

- **No brickifier and no general LDraw writer.** Nothing turns voxels or shapes into bricks. The only `.ldr`
  emitters are a 1x1-plate mosaic (`web/src/engine/bff-loader.ts:68-81`) and LSynth sections
  (`web/src/engine/lsynth.ts:245`).
- **No RGB -> nearest LDraw colour function.**
- **No lattice-level stability check.** `src/pipeline/verify/defect.ts:83` `analyseGridConnectivity` is a voxel flood
  fill. `auditConnectivity` finds contact candidates, not load paths.
- **Photo window detection is a stub**: `src/pipeline/capture/streetview.ts:248-252` sets `windowGrid = null` and
  `cornice = false`.
- **No generated coaster track.** Routes come only from LEGO track pieces in a source model
  (`schem-pipeline.ts:556-570`). There is no launch, no mid-course block brake, no dark section and no ride lighting
  (no `launch` anywhere in `bedrock-coaster.ts`). `MAX_SPEED = 20 x pace` (`bedrock-coaster.ts:657`).
- **No track geometry for a generated route.** The 10303 loop quarter `80564` exists only inside 10303's `.io`
  (Studio-embedded); `80566` is in the unofficial library only.
- **No figure that is not LEGO's.** The three figure systems are LEGO's minifig, mini-doll and big figure.

### 0.3 Marketplace blockers, measured

| # | Blocker | Evidence |
|---|---|---|
| B1 | Vanilla texture overwrite: 17 `concrete_<colour>.png` written at vanilla paths | `web/src/engine/playable-addon.ts:2652-2657` (in the playable pack), `web/src/engine/lego-resource-pack.ts:361-366` (the stand-alone RP); colours in `lego-resource-pack.ts:11` `CONCRETE_COLORS` |
| B2 | One shared namespace `craftmatic` | `web/src/engine/mcpack.ts:41` `PACK_NAMESPACE`; a second private copy in `web/src/engine/ldraw-entity-compiler.ts:52`; 223 `craftmatic:` literals in 19 engine files; 54 more in 14 simulator files (`web/src/sim/adapters/craftmatic/*`, `web/src/sim/quirks/*`) |
| B3 | Ids not `geometry.<creator_pack>.<name>` | e.g. `bedrock-building-shell.ts:395`, `ldraw-entity-compiler.ts:3119/3141/3152`, `playable-addon.ts:1161` |
| B4 | Loose files in type folders | `playable-addon.ts:2828-2830` (`entities/`, `entity/`, `models/entity/`), `:2768` (`textures/entity/`), `:3221` (`blocks/`), `:3229` (`textures/blocks/craftmatic_collider.png`) |
| B5 | RP manifest has no `pack_scope` and no dependency on the BP | `playable-addon.ts:2626` (`rpManifest` has `header` and `modules` only); the BP depends on the RP at `:2624` |
| B6 | Block permutations over 10,000 | `web/src/engine/collider-form.ts:87-88`: 43 collider block ids (1 + 3 x 14 shapes); `:553-556`: states `lo` 0..15 and `hi` 1..16 = 256 combinations per id, **11,008 in total**. Only 136 (lo, hi) pairs are valid (`hi > lo`), so one 0..135 state gives 43 x 136 = **5,848** |
| B7 | Placement replaces blocks | `bedrock-placement-pack.ts:1553` says "Blocks in this area will be replaced."; it also adds ticking areas (`:1013-1024`), which the coop guidelines say to avoid |
| B8 | Chat spam | every wand message goes to chat with a `[Brick Wand]` prefix (`bedrock-placement-pack.ts:998`); the guideline is 28 characters or fewer, on first join only |
| B9 | Dev stamps and LEGO wording in player-facing text | `packDisplayName` / `provenanceSentence` (`web/src/engine/pipeline-version.ts:185/194`) in both manifests (`playable-addon.ts:2624-2626`); "one flat 16x16 colour swatch per LEGO colour" in the RP description; "Minifig Creator Wand" in `.lang` (`playable-addon.ts:4062`) |
| B10 | Parts can resolve from Studio's library | `web/src/engine/ldraw-geometry.ts:190-201` probes `UnOfficial/parts/...` (Studio) before the CC BY mirror; the alias ladder substitutes silently except for `datSubstitutions` (:181) |
| B11 | No LDraw attribution in a pack | no credits file is emitted |
| B12 | LEGO-derived face art can enter a build | `--faces=<dir>` in `scripts/_playable_ref.ts:98` -> `seedFaceArt` (`head-face.ts:166`) |
| B13 | Pack identity follows the label | `mcpack.ts:170` `packIdentity(stem, label)`; a Marketplace product needs frozen uuids |

### 0.4 10303 Loop Coaster, the size reference (measured)

| Metric | 10303 | Source |
|---|---|---|
| Track length | **181.6 blocks** (8,930.5 LDU of track plus the lift deck counted twice), 1,044 samples | `docs/bedrock-addon-guide.md:2163` |
| Height | about **44 blocks** (shell anchor 45 blocks over the ground track) | `docs/bedrock-addon-guide.md:1699` |
| Footprint | about **40 x 19 blocks** (2,102 x 1,026 LDU, part origins of `output/pipeline-2026-09-21/10303-embedded-preserve-candidate/10303.ldr`, at 53.3 LDU per block) | measured by the coaster research agent, 2026-11-09 |
| Inversions | 2 loops (radius 3.93 blocks) plus a past-vertical drop | `docs/physics-architecture.md:67`; `docs/bedrock-addon-guide.md:2201` |
| Train | 3 cars, 1 rider each | `docs/bedrock-addon-guide.md:2164` |
| Lift | elevator platform, 35.34 blocks of travel, 14 s | `docs/bedrock-addon-guide.md:2165-2168` |
| Speed and cycle (pace sqrt 2) | peak 28.28 blocks/s (the ceiling), cycle 54.2 s | `docs/physics-architecture.md:1427-1431` |
| Pack weight | about 62k cuboids, 14 entities | `TASKS-BEDROCK-ADDON.md:264`; `docs/bedrock-addon-guide.md:2167` |

So "at least 3x Loop" is, measured on each axis: **track >= 545 blocks, height >= 132 blocks, longest footprint
axis >= 120 blocks, inversions >= 6.** The plan targets about 3.5x to 6x on each (section 5.1).

---

## 1. Product line

Every product is our own design. There is no LEGO name, logo, set name or number, no licensed theme and no
minifigure. Working titles are placeholders until the user approves names (Q2).

| # | Product (working title) | Contents | Engine features used |
|---|---|---|---|
| P0 | **Free sampler** (shared with Scenario D) | one car, a door and window kit, a bench, one small landmark | vehicle, interactives, seats |
| P1 | **Cloudbreak Summit coaster park** | the epic coaster (section 5.1), station, artificial mountain, cloud banks, queue | generated track, launches, brakes, dark ride, rider camera |
| P2 | **Brick Landmarks**, 4-5 city packs of 4-5 icons each | 20+ icons (section 4) | static shell, walkable at large sizes, our figures as visitors |
| P3 | **Brick Garage** | 8 original vehicles: 3 cars, a truck, a hover bike, a prop plane, a jet, a speedboat; garage building with roller doors | scripted vehicles, chase and cockpit cameras, interactives |
| P4 | **Brick Arcade: Pinball** | 3 original tables (space, jungle, racing) in an arcade hall | pinball runtime |
| P5 | **Brick Home: Doors and Furniture** | about 30 placeable pieces: doors, windows, hatches, cabinets, drawers, beds, chairs, sofas, lamps, a kitchen | interactives, seats, beds |
| P6 | **Brick Funfair** (theme-park rides) | ferris wheel, carousel, drop tower, swing ride, bumper cars, slide | new multi-seat orbit ride, lift ride, cars |

P1 and P6 can later be combined into a "theme-park world" product. A Marketplace *world* is a different product type
from an add-on; the publisher decides that (Q9).

---

## 2. Architecture

### 2.1 The pipeline, end to end

```
 SITE INPUTS (licence-gated)          brickgen (new: web/src/brickgen/)                     existing engine
 ──────────────────────────           ───────────────────────────────────                    ───────────────
 OSM footprint + tags ─┐                                                                      
 open LiDAR / own mesh ┼─► site/ ─► massing/ ─► features/ ─► grammar/ ─► bricker/ ─► colour/ ─► verify/ ─► emit/ ─► .ldr
 licensed photos +     │   SiteEvidence  Massing   FeatureSet   IntentLattice  BrickPlan          reports   (MPD)
   annotations         │                                                                         │
 hand measurements ────┘                                                     polish/ (ops) ◄─────┘
                                                                               │
                                                                               ▼
                                         final .ldr ─► parseLDrawDocument ─► runSchemPipeline ─► dev .mcaddon
                                                                                                     │
                                                         marketplace/ (new) ◄────────────────────────┘
                                                         rewrite ids + folders, own blocks, manifests,
                                                         lint text, credits, budgets ─► Marketplace .mcaddon
                                                                                          ─► validators, sim, BDS
```

The epic coaster and the rides add a second authoring path that bypasses the source-model detectors:

```
 CoasterDesign (elements) ─► coaster-design.ts ─► CoasterRouteInput + zones + ups ─► bedrock-coaster runtime
                                │                                       ▲
                                └─► coaster-track-mesh.ts (rail geometry chunks) ─┘
 Scenery (station, mountain, supports, clouds) ─► brickgen grammars ─► .ldr  /  own brick BLOCKS
```

### 2.2 Module boundaries

| Module | Path | Owns | May import | Must not import |
|---|---|---|---|---|
| `brickgen/types` | `web/src/brickgen/types.ts` | every data type in 2.3 | nothing | anything |
| `brickgen/site` | `web/src/brickgen/site/` | input adapters, licence gate, provenance capture | `@craft/pipeline/context/*`, `@craft/gen/api/osm` (types and pure functions) | Google fetchers (`src/pipeline/capture/tiles.ts`, `streetview.ts`, `satellite.ts`) for any commercial run |
| `brickgen/massing` | `web/src/brickgen/massing/` | footprint -> `MassVolume[]`, scale choice | `site`, `@craft/pipeline/synthesis/slice-extract` | engine |
| `brickgen/features` | `web/src/brickgen/features/` | `FeatureSet` from tags, annotations, photo measurement, mesh slices | `site`, `massing`, `@craft/gen/api/streetview-analysis` (pure analysis only) | network |
| `brickgen/grammar` | `web/src/brickgen/grammar/{wall,facade,roof,tower,spire,dome,arch,column,buttress,window,terrain,support,cloud}.ts` | `IntentLattice` cells with semantic labels | `types`, `vocab` | engine |
| `brickgen/vocab` | `web/src/brickgen/vocab/` | `BrickVocabulary`: official LDraw parts, their stud footprints, connection faces, roles, licence lines | `web/src/engine/ldraw-part-dims.ts` | Studio paths |
| `brickgen/bricker` | `web/src/brickgen/bricker/` | lattice -> `BrickPlan` (packing, bonding, slopes, special elements) | `types`, `vocab` | engine |
| `brickgen/colour` | `web/src/brickgen/colour.ts` | Lab nearest over the production palette | `ldconfig-colors.generated.ts`, `color-utils.ts` | |
| `brickgen/verify` | `web/src/brickgen/verify/` | lattice connectivity, stability, part legality, budget estimate | `types`, `vocab`, `web/src/viewer/ldraw/connectivity-audit.ts` (cross-check) | |
| `brickgen/emit` | `web/src/brickgen/emit/ldraw-writer.ts` | `BrickPlan` -> MPD text, determinism, authoring metas | `types` | |
| `brickgen/polish` | `web/src/brickgen/polish/` | `PolishOp[]` applied to a `BrickPlan`, fidelity scoring | `types`, `emit` | |
| `brickgen/provenance` | `web/src/brickgen/provenance.ts` | `ProvenanceLog` schema and writer | `types` | |
| marketplace | `web/src/engine/marketplace/{product,rewrite,blocks,manifest,text-lint,credits,budget}.ts` | the Marketplace profile, applied as a post-pass over a built file list | `zip-utils.ts`, `mcpack.ts` | the emitters' internals |
| coaster design | `web/src/engine/coaster-design.ts`, `coaster-track-mesh.ts`, `coaster-zones.ts` | element-based track, rail geometry, zones | `coaster-path.ts` | source-model detectors |
| our figure | `web/src/engine/figure-brickling.ts` (working name) | canon, bones, gait, seat offsets for `FigureSystem = 'brickling'` | `minifig-rig.ts` types | LEGO moulds |
| CLI | `scripts/brickgen.ts`, `scripts/_marketplace_pack.ts`, `scripts/_marketplace_budget.ts`, `scripts/_mctools_validate.ts`, `scripts/_cleanroom_denylist.ts`, `scripts/_cleanroom_check.ts`, `scripts/_bds_smoke.ts`, `scripts/_store_art.mjs`, `scripts/_submission_bundle.ts` | thin wrappers | everything | |

`web/tsconfig.json` today includes `../src/gen/**/*.ts` but not `../src/pipeline/**`. WP-A01 adds the pipeline's
pure modules (`context`, `fusion`, `synthesis/slice-extract`, `synthesis/brep` types) to `include`, or moves the
needed types to `src/types/`. A full `bun run typecheck:web` must stay clean.

**Why the Marketplace profile is a post-pass, not threaded through the emitters.** `playable-addon.ts` is 4,220
lines with paths and ids built inline; `PACK_NAMESPACE` is read in 19 files, and three branches touching these files
are in flight (`gen-side-1109`, `gen-view-1106`, `gen-veh-1106`). A rewriter that takes the finished file list and
rewrites ids, paths and references in one place:
- does not change dev packs at all (every existing test and device fact stays valid);
- is one module, so it collides with nothing;
- is verifiable, because a built Marketplace pack must contain zero `craftmatic` tokens and must still pass
  `_mcaddon_check.py` (which already detects dangling geometry, texture and script references) and the simulator.

Its risk is a computed id the rewriter does not see (for example `'craftmatic:' + x` inside generated scripts, or
the `craftmatic_` prefixes in family names and dynamic-property keys such as `craftmatic:label`). The guard is a
whole-archive token scan plus the sim run on the rewritten pack (WP-M01). Threading a `PackIds` value through the
emitters can follow later as a refactor (`TODO(pack-ids)`), once the in-flight branches have merged.

### 2.3 Data types (all in `web/src/brickgen/types.ts` unless noted)

```ts
/** Metres in a local east-north-up frame centred on the site; y up. */
export type Vec2m = readonly [x: number, z: number];
export type Vec3m = readonly [x: number, y: number, z: number];

/** Every input carries its licence; the gate (site/licence-gate.ts) refuses a commercial run on a forbidden one. */
export type InputLicence =
  | 'own-work' | 'public-domain' | 'cc0' | 'cc-by' | 'cc-by-sa' | 'odbl' | 'ogl-uk' | 'licence-ouverte'
  | 'us-gov' | 'dl-de-zero' | 'google-maps-content' | 'unknown';
export interface SourceRef {
  id: string;                 // stable within a design, e.g. "osm-way-<id>"
  kind: 'osm' | 'lidar' | 'mesh' | 'photo' | 'drawing' | 'measurement' | 'text';
  url?: string; retrieved: string; sha256?: string;
  licence: InputLicence; attribution?: string;
  usedFor: string[];          // "footprint", "tower height", "rose window diameter"
}

export interface SiteEvidence {
  name: string;               // working title, never a LEGO set name
  sources: SourceRef[];
  footprint: Array<{ outer: Vec2m[]; holes: Vec2m[][]; partId?: string }>;
  parts: Array<{ partId: string; baseM: number; heightM: number; roof?: RoofSpec; colourHint?: string }>;
  measurements: Array<{ what: string; valueM: number; source: string }>;  // documented dimensions
  annotations: FacadeAnnotation[];   // human/agent marks on licensed photos or drawings
  mesh?: { positions: Float32Array; indices: Uint32Array; source: string };  // licence-clean only
}
export interface FacadeAnnotation {
  source: string;             // SourceRef id of the photo or drawing
  edge: number;               // footprint edge index
  rectifiedScale: number;     // metres per pixel after rectification
  marks: Array<{ kind: FeatureKind; boxPx: [number, number, number, number]; note?: string }>;
}

export type RoofShape = 'flat' | 'gabled' | 'hipped' | 'pyramidal' | 'dome' | 'onion' | 'conical' | 'mansard' | 'shed' | 'spire';
export interface RoofSpec { shape: RoofShape; pitchDeg?: number; ridgeAxis?: 'long' | 'short'; colour?: number; overhangM?: number }

export interface MassVolume {
  id: string; outer: Vec2m[]; holes: Vec2m[][];
  baseM: number; topM: number; roof: RoofSpec;
  role: 'body' | 'tower' | 'nave' | 'aisle' | 'transept' | 'apse' | 'podium' | 'deck' | 'pier' | 'terrain';
}
export interface Massing { volumes: MassVolume[]; scale: ModelScale; boundsM: [Vec3m, Vec3m] }
/** How metres become studs. 1 stud = 20 LDU; 1 plate = 8 LDU; a brick = 3 plates. */
export interface ModelScale { studsPerMetre: number; platesPerMetre: number; reason: string }

export type FeatureKind =
  | 'window' | 'lancet' | 'rose' | 'door' | 'portal' | 'arcade' | 'column' | 'pilaster' | 'buttress'
  | 'flying-buttress' | 'cornice' | 'balustrade' | 'pinnacle' | 'gargoyle' | 'clock' | 'spire' | 'dome'
  | 'lantern' | 'battlement' | 'chimney' | 'balcony' | 'stair' | 'lattice' | 'cable' | 'statue';
export interface FeatureSpec {
  kind: FeatureKind; volume: string; edge?: number;
  /** Position along the edge and height, metres; size, metres. */
  atM: Vec3m; sizeM: Vec3m; count?: number; spacingM?: number;
  confidence: number; sources: string[];
}
export interface FeatureSet { features: FeatureSpec[]; style: StyleProfile }
export interface StyleProfile { wallColour: number; trimColour: number; roofColour: number; accentColours: number[]; era?: string }

/** The grammar's output: one cell per stud column x plate layer, with intent, before any part is chosen. */
export interface IntentLattice {
  dims: [studsX: number, plates: number, studsZ: number];
  /** Cell intent: 0 empty; otherwise an index into `labels`. */
  cells: Uint16Array;
  labels: IntentLabel[];
}
export interface IntentLabel {
  role: 'wall' | 'floor' | 'roof-slope' | 'roof-flat' | 'window' | 'arch' | 'column' | 'trim' | 'detail' | 'terrain' | 'support';
  colour: number; feature?: string;
  /** Roof slope direction (+x, -x, +z, -z) and steepness class, for the slope picker. */
  slope?: { dir: 0 | 1 | 2 | 3; rise: 1 | 2 | 3 };
  /** May be built hollow (no interior studs needed). */
  hollowOk?: boolean;
}

/** One vocabulary element: an OFFICIAL LDraw part with what the bricker needs to know. */
export interface BrickElement {
  part: string;               // "3001.dat"
  footprint: [studsX: number, studsZ: number]; heightPlates: number;
  /** Occupancy mask in stud x plate x stud, for non-cuboid parts (slopes, arches, rounds). */
  occupancy?: Uint8Array;
  connections: { studsTop: Array<[number, number]>; antiStudsBottom: Array<[number, number]>; side?: 'clip' | 'bar' | 'pin' };
  roles: IntentLabel['role'][];
  licence: string;            // the part's `0 !LICENSE` line
  author: string;             // the part's `0 Author:` line
}
export interface BrickVocabulary { elements: BrickElement[]; palette: number[]; version: string }

/** The bricker's output: parts on the stud lattice. Rotation is a quarter turn about +y (LDraw -y). */
export interface PlacedElement { part: string; colour: number; at: [sx: number, plate: number, sz: number]; turn: 0 | 1 | 2 | 3; group: string }
export interface BrickPlan { elements: PlacedElement[]; groups: Array<{ id: string; label: string }>; scale: ModelScale; metas: AuthoringMeta[] }

/** Explicit intent written into the .ldr so the add-on pipeline need not guess (registered in ldraw-directives.ts). */
export type AuthoringMeta =
  | { kind: 'FIGURE'; system: 'brickling'; at: [number, number, number]; facingDeg: number; seat?: string }
  | { kind: 'SEAT'; id: string; at: [number, number, number]; facingDeg: number }
  | { kind: 'DOOR'; group: string; hinge: [number, number, number]; axis: 'y'; openDeg: number }
  | { kind: 'SPAWN'; at: [number, number, number] }
  | { kind: 'DESIGN'; slug: string; version: string; provenance: string };

export interface VerifyReport {
  parts: number; components: number; largestPct: number;
  /** Elements with no load path to the ground through stud connections. */
  unsupported: number;
  /** Worst cantilever, in studs, beyond the allowed limit. */
  cantileverViolations: Array<{ group: string; studs: number }>;
  overlaps: number; illegalParts: string[];
  budget: { cuboidsEstimate: number; parts: number };
}

export interface PolishOp {
  op: 'remove' | 'add' | 'replace' | 'recolour' | 'regrammar';
  /** A box in lattice coordinates, or a group id. */
  where: { box?: [[number, number, number], [number, number, number]]; group?: string };
  with?: PlacedElement[] | { part?: string; colour?: number } | { grammar: string; params: Record<string, unknown> };
  why: string;                // reviewer's reason, kept for the provenance log
}

export interface ProvenanceLog {
  slug: string; title: string; created: string; designers: string[];
  statement: string;          // the independent-creation statement
  sources: SourceRef[];
  pipeline: { commit: string; brickgenVersion: string; command: string };
  polish: Array<{ op: PolishOp; by: string; at: string }>;
  clearance: CleanroomResult[];
}
export interface CleanroomResult {
  checkedAgainst: string;     // a corpus path, hashed
  partHistogramCosine: number; alignedVoxelIoU: number; verdict: 'independent' | 'review';
  by: string; at: string;     // a DIFFERENT agent than the designer
}
```

Coaster design types (`web/src/engine/coaster-design.ts`):

```ts
export type CoasterElement =
  | { kind: 'station'; lengthB: number }
  | { kind: 'cable-lift' | 'chain-lift'; riseB: number; angleDeg: number; speedBps: number }
  | { kind: 'launch'; lengthB: number; toSpeedBps: number }
  | { kind: 'drop'; fallB: number; angleDeg: number; twistDeg?: number }
  | { kind: 'airtime-hill'; riseB: number; lengthB: number }
  | { kind: 'loop'; radiusB: number } | { kind: 'zero-g-roll'; lengthB: number }
  | { kind: 'corkscrew'; lengthB: number; hand: 'L' | 'R' } | { kind: 'cobra-roll'; radiusB: number }
  | { kind: 'top-hat'; heightB: number } | { kind: 'helix'; radiusB: number; turns: number; dropB: number }
  | { kind: 'turn'; radiusB: number; angleDeg: number; bankDeg?: number }
  | { kind: 'straight'; lengthB: number; slopeDeg?: number }
  | { kind: 'block-brake' | 'trim-brake'; lengthB: number; toSpeedBps?: number };
export interface CoasterZone {
  kind: 'station' | 'lift' | 'launch' | 'block-brake' | 'trim' | 'dark' | 'show' | 'tunnel' | 'cloud';
  from: number; to: number;   // arc distance, blocks
  params?: Record<string, number | string>;
}
export interface CoasterDesign {
  name: string; elements: CoasterElement[];
  /** Heartline offset above the rail, blocks; rolls are about the heartline. */
  heartlineB: number; trains: number; carsPerTrain: number;
  limits: { maxSpeedBps: number; gVertical: [min: number, max: number]; gLateral: number; maxJerk: number };
  shows: Array<{ zone: string; at: number; cue: ShowCue }>;
}
export type ShowCue =
  | { kind: 'darkness'; seconds: number } | { kind: 'fade'; colour: [number, number, number]; inS: number; holdS: number; outS: number }
  | { kind: 'light'; group: string; on: boolean } | { kind: 'sound'; id: string } | { kind: 'particles'; id: string };
export interface GeneratedCoaster {
  route: CoasterRouteInput;   // coaster-path.ts:14
  ups: CoasterVec3[];         // explicit banking, one per point (no inference from rails)
  zones: CoasterZone[];
  report: { lengthB: number; heightB: number; footprintB: [number, number]; inversions: number;
            maxG: number; minG: number; maxLateralG: number; maxSpeedBps: number; lapS: number };
}
```

Marketplace profile types (`web/src/engine/marketplace/product.ts`):

```ts
/** Frozen per product forever: a Marketplace update may never change namespace or uuids. */
export interface ProductIdentity {
  creator: string;            // e.g. "cmt" (Q1: the user picks; lowercase, no digits first)
  pack: string;               // e.g. "cloudbreak"
  namespace: string;          // `${creator}_${pack}`
  displayName: string; description: string;
  uuids: { bpHeader: string; bpData: string; bpScript: string; rpHeader: string; rpResources: string };
  version: [number, number, number];
  minEngine: [number, number, number];
  scriptModules: Array<{ module_name: '@minecraft/server' | '@minecraft/server-ui'; version: string }>;
  tier: 'low' | 'standard' | 'high';
}
export interface MarketplaceBudget {
  maxUncompressedBytes: number; maxFiles: number; maxBlockPermutations: number;
  maxBlockTexturePx: 256; maxOtherTexturePx: 2048;
  maxResidentEntities: number; maxResidentCuboids: number; maxScriptMsPerTickMedian: number;
}
```

Products live in `products/<pack>/product.json` (committed; uuids minted once by `scripts/_marketplace_pack.ts
--mint` and never again).

---

## 3. The part mapper (`brickgen`)

### 3.1 Stages

1. **site/**: build `SiteEvidence`.
   - **OSM**: `fetchOSMById` / `searchOSMBuildingParts` (`src/gen/api/osm.ts:255/:180`) with the `ApiCache`
     (`src/pipeline/cache/api-cache.ts`) in offline-replay mode for tests. `building:part` heights, `roof:shape`,
     `roof:height`, `building:colour`. Attribution "(c) OpenStreetMap contributors", ODbL.
   - **Open elevation and 3D data** (licence recorded per tile): IGN LiDAR HD for France (Licence Ouverte 2.0),
     Environment Agency LiDAR for England (OGL), USGS 3DEP for the US (public domain), NRW and Berlin 3D city models
     for Germany (dl-de/zero-2-0), PLATEAU for Japan (CC BY 4.0), AHN for the Netherlands (CC0). Each one's licence
     must be re-read at use time and recorded; this list is the starting set, not a verdict.
   - **Drawings**: HABS/HAER/HALS measured drawings (Library of Congress, public domain) for US buildings; 19th-century
     published drawings (Viollet-le-Duc's *Dictionnaire raisonne*, public domain) for French Gothic.
   - **Photos**: own photos; Wikimedia Commons files whose licence is PD, CC0 or CC BY (CC BY-SA allowed for
     measurement only, recorded; never reproduced in store art); museum open-access collections (Paris Musees,
     Smithsonian Open Access, CC0).
   - **Hand measurements**: documented dimensions (length, tower height, spire height) with their source.
   - **The licence gate** (`site/licence-gate.ts`) fails a commercial run on `google-maps-content` or `unknown`.
     Google Maps Platform Terms 3.2.3(c), "No Creating Content From Google Maps Content", forbid creating content,
     including 3D building models, from Google content (cloud.google.com/maps-platform/terms, opened 2026-11-09).
     So the existing Google tiles, Street View and satellite fetchers (`src/pipeline/capture/tiles.ts:82`,
     `streetview.ts:330`, `satellite.ts:194`) stay available for LOCAL comparison only, are never a design input
     for a shipped pack, and are excluded from the module's imports (2.2).
2. **massing/**: footprint polygons + part heights -> `MassVolume[]`.
   - Simplify each polygon (`classifyShape` style Douglas-Peucker) and snap edges to the stud grid at the chosen
     scale; keep angles that are multiples of 90 degrees exactly and approximate others with stepped walls or
     turntable-rotated sub-models (a group with `turn` other than a quarter is a `TODO(non-orthogonal)` in v1).
   - **Scale choice** (`massing/scale.ts`): each product sets a target. Landmarks default to "architecture scale",
     about 1 stud per metre (1:125), clamped so the estimated cuboids fit the tier budget (`verify/budget.ts`). A
     walk-in model (garage, home, funfair) uses figure scale, with the doorway envelope from our figure (section 6).
   - From a licence-clean mesh: `sliceMeshAtY` bands -> per-band polygons -> volumes (the sliced-tiles method,
     `src/pipeline/synthesis/sliced-tiles.ts`).
3. **features/**: `FeatureSet`.
   - From tags (`roof:shape`, `building:levels`, `tower:type`, `man_made`).
   - From **annotations** on licensed photos and drawings: a reviewer (agent or the user) marks windows, portals,
     rose windows, buttresses and towers on a rectified image (`features/annotate.ts` reads a JSON sidecar; a small
     page in the web UI can write it later, `TODO(annotate-ui)`). This is the reliable path in v1, because photo
     window detection is a stub today (`streetview.ts:248`).
   - From automatic analysis of licensed photos: `analyzeFenestration`, `detectStories`, `analyzeSymmetry`
     (`src/gen/api/streetview-analysis.ts`), recorded with confidence; an annotation always wins.
   - Style: wall, trim and roof colours by `extractPalette` over the licensed photos, mapped to the production
     palette.
4. **grammar/**: `IntentLattice`. One grammar per feature kind, each a pure function
   `(volume, features, scale, vocab) => lattice patch`. Wall (with bays, string courses, plinth), facade openings
   (rectangular, round-arch, lancet, rose), roofs (gabled, hipped, pyramidal, conical, dome, onion, mansard, spire),
   towers (square, octagonal, round), buttresses and flying buttresses, columns and colonnades, battlements, clock
   faces, lattice girders (for iron towers and bridges), cables (suspension), terrain (rock, grass, water), coaster
   supports and cloud banks.
5. **bricker/**: `IntentLattice` -> `BrickPlan`.
   - Choose the largest legal element per run (1xN plates and bricks up to 1x8, 2xN up to 2x10), with a running bond
     so seams never align across consecutive layers (connectivity by construction).
   - Slopes for `roof-slope` cells by direction and rise class (slope 45 2x1, 2x2; slope 33 3x1, 3x2; curved
     slopes), inverted slopes under overhangs, arches for `arch`, round bricks and cones for `column` and spires,
     window and door frames sized to the opening when the vocabulary has one, otherwise plate-built openings.
   - Hollow interiors where `hollowOk` (fewer parts and cuboids).
6. **colour/**: Lab nearest over a production palette (solid, common colours only; transparent colours only for
   windows), from `LDCONFIG_RGB` (`ldconfig-colors.generated.ts:5`) with `LDCONFIG_ALPHA` (:331).
7. **verify/** (gate; WP-A04):
   - **Stud-lattice connectivity**: union every pair of elements where one's studs meet the other's anti-studs;
     report components (target: 1).
   - **Stability**: every element needs a load path to the ground through connections; cantilever limits per
     element type (default 4 studs of unsupported overhang per plate layer; arches and slopes count as supported
     by their own occupancy). Report `unsupported` and `cantileverViolations`.
   - **Overlaps**: no two occupancies share a cell.
   - **Legality**: every part is in the vocabulary, every vocabulary part is an official LDraw part with a CC BY
     `!LICENSE` line, no `logo` stud primitives, no Studio-only or `bl_` names.
   - **Cross-check**: `auditConnectivity` on the emitted `ParsedBrick[]` must agree (it over-connects, so it may
     only report the same or fewer components).
8. **emit/**: `BrickPlan` -> MPD. One `0 FILE` per group (tower, nave, roof...), deterministic ordering (sort by
   group, then y, z, x), LF endings, `0 Author:` our studio name, `0 !LICENSE` our own licence line (Q1), and the
   authoring metas. New metas (`!CRAFTMATIC FIGURE`, `SEAT`, `DOOR`, `SPAWN`, `DESIGN`) are registered in
   `web/src/engine/ldraw-directives.ts` in the same change (CLAUDE.md rule) and read by `ldraw-parser.ts`, so the
   add-on pipeline uses explicit intent instead of the title regexes and part detectors.
9. **polish/**: `PolishOp[]` in `designs/<slug>/polish.ops.json`, applied after generation, so regeneration never
   loses a manual edit. Every op carries a `why`. A fidelity score (`polish/fidelity.ts`) renders the model from the
   viewpoint of each licensed reference elevation (orthographic, the web viewer's renderer through headless Chrome,
   Node per CLAUDE.md) and measures silhouette IoU and mean colour difference (CIEDE2000). Polish is "manual"
   because a reviewer chooses every op; the score keeps it honest (the user's rule: measured, never eyeballed).

### 3.2 Inputs the mapper accepts

| Input | v1 | Commercial use |
|---|---|---|
| OSM footprint and tags | yes | yes, with ODbL attribution in the pack credits |
| Open LiDAR / open 3D city model tile | yes | yes, per its licence, recorded |
| Own mesh or scan (GLB/OBJ via `web/src/engine/mesh-to-grid.ts:30` loader) | yes | yes if own work or CC0/PD |
| Licensed photos + annotations | yes | yes for measurement; the photo itself never ships |
| Google 3D tiles, Street View, satellite | local comparison only | **no** (Maps Platform Terms 3.2.3(c)) |
| A LEGO set file or any MOC of the same subject | **never** for a landmark (clean room) | no |

### 3.3 Clean room

The local corpus (`C:/git/clego/lego_sets/`) holds LEGO's own landmark sets. A designer agent that opens one
contaminates the design.
- `scripts/_cleanroom_denylist.ts <keywords>` lists every corpus path whose title or index entry matches a
  landmark (for example "notre", "eiffel", "neuschwanstein"). Every designer brief includes that list as "never
  open".
- `scripts/_cleanroom_check.ts <design.ldr>` is run by a DIFFERENT agent after the design is final. It computes the
  part-histogram cosine and the best aligned voxel IoU against each denylisted file and writes the numbers into
  the provenance log's `clearance`. A high score is a flag for the user and the lawyer, not an automatic pass or
  fail; the designer never sees the compared file.
- User MOC files of a landmark (found online) are never used for an icon either. User MOCs serve only Scenario B
  tests and non-landmark mapper evaluation, gitignored, with their source and licence recorded.

### 3.4 Where designs live (decision Q3)

The repo `tribixbite/craftmatic` is **public** (`gh repo view`: `PUBLIC`). Committing the final `.ldr` of a paid
pack there would publish it. Default proposal: a separate local git repo `C:/git/craftmatic-designs` (designs,
polish ops, provenance logs, product identities of unreleased packs), read through `CRAFTMATIC_DESIGNS`. It is not
pushed anywhere until the user approves (creating a private GitHub repo is an outward step). The public repo keeps
the engine, small synthetic fixtures and the free sampler's designs.

---

## 4. The 20+ landmark icons

### 4.1 Rights screen applied to every landmark

1. The building itself: designed or built long enough ago that no copyright subsists (the architect died more than
   70 years ago or the building is ancient). In the US, buildings constructed before 1 December 1990 carry no
   architectural-work copyright, and 17 U.S.C. 120(a) allows pictorial representations of a building visible from
   a public place (`1-legality.md` line 51).
2. Lighting designs: the illuminated Eiffel Tower is protected (SETE: "The Eiffel Tower's lighting is protected:
   golden illumination, twinkling lights, the beacon, and event lighting", `1-legality.md` line 49). So: daytime
   look only, no golden floodlight scheme, no sparkle, no beacon. The same rule applies to any landmark with a
   designed lighting scheme.
3. Trade marks on names and images:
   - The Empire State Building licenses its name and image (esbnyc.com licensing page);
   - the Sydney Opera House requires a licence for commercial use of its image (sydneyoperahouse.com brand-use
     FAQ);
   - "Neuschwanstein" is a registered EU trade mark of the Free State of Bavaria (CJEU C-488/16 P, 2018);
   - the Golden Gate Bridge district uses its mark on souvenirs (WIPO D2003-0157).

   Rule: player-facing titles are descriptive ("Gothic Cathedral of Paris", "Alpine Swan Castle") unless the lawyer
   clears the proper name (Q6).
4. State heritage-image laws:
   - Italy's Cultural Heritage Code arts. 107-108 charge for commercial reproduction of state cultural heritage
     (the Ravensburger / Vitruvian Man litigation, Harvard ILJ 2025);
   - France's Code du patrimoine L621-42 requires authorisation for commercial use of the image of the *domaines
     nationaux* (Chambord, the Louvre and Tuileries, Pau, the Chateau d'Angers, the Elysee, the Palais du Rhin; the
     list grows by decree, R621-98, check it at the time);
   - Greece charges fees for commercial images of state monuments (WIPO Lex GR266, Ministerial Decision on fees,
     Law 3028/2002).

   Rule: those sites go on the hold list until the lawyer answers.
5. The design: independent (section 3.3), with a provenance log.

All the citations above were opened on 2026-11-09 through web search. They are research leads for the lawyer, not
conclusions.

### 4.2 The proposed 20 (Notre-Dame first)

Source columns name data CLASSES to fetch and record. No OSM ids or file names are invented here; WP-L00
looks each one up and records it in the provenance log.

| # | Landmark (working title) | Built / architect | Inputs to fetch | Rights notes |
|---|---|---|---|---|
| 1 | **Notre-Dame de Paris** ("Gothic Cathedral of Paris") | 1163-1345; spire by Viollet-le-Duc (d. 1879), rebuilt to his design 2019-2024 | OSM ways and `building:part`s; IGN LiDAR HD tiles; Viollet-le-Duc's *Dictionnaire* plates (PD); Paris Musees CC0 images; Commons PD/CC BY photos; documented dimensions (length, towers, spire) | none known; avoid LEGO 21061 and any brick model of it (clean room) |
| 2 | Eiffel Tower ("Iron Lattice Tower") | 1889, Eiffel (d. 1923) | OSM; IGN LiDAR HD; published elevation drawings (PD); Commons | **daytime look only; no illumination scheme**; SETE marks on the name: descriptive title unless cleared |
| 3 | Arc de Triomphe | 1806-1836 | OSM; IGN LiDAR HD; Commons | none known (not a domaine national) |
| 4 | Sacre-Coeur | 1875-1914, Abadie (d. 1884) | OSM; IGN LiDAR HD; Commons | none known |
| 5 | Elizabeth Tower and a section of the Palace of Westminster | 1843-1870, Barry (d. 1860), Pugin (d. 1852) | OSM; EA LiDAR (OGL); Commons; Historic England list entry text | no Parliamentary portcullis emblem |
| 6 | Tower Bridge | 1886-1894, Jones (d. 1887), Wolfe Barry (d. 1918) | OSM; EA LiDAR; Commons | check marks on the name (Q6) |
| 7 | St Paul's Cathedral | 1675-1710, Wren (d. 1723) | OSM; EA LiDAR; Commons | none known |
| 8 | The White Tower (Tower of London) | 1078 | OSM; EA LiDAR; Commons | none known |
| 9 | Statue of Liberty and pedestal | 1886, Bartholdi (d. 1904), Hunt (d. 1895) | OSM; USGS 3DEP; NPS/HABS drawings; NPS photos (PD) | model the New York statue, not a replica (cf. *Davidson v. United States*, the Las Vegas replica case) |
| 10 | United States Capitol | 1793-1868 | OSM; 3DEP; HABS; Architect of the Capitol photos (PD) | none known |
| 11 | Independence Hall | 1753 | OSM; 3DEP; HABS drawings | none known |
| 12 | Lincoln Memorial | 1914-1922, Bacon (d. 1924); statue French (d. 1931) | OSM; 3DEP; HABS; NPS | none known |
| 13 | Washington Monument | 1848-1884 | OSM; 3DEP; HABS | none known |
| 14 | Brandenburg Gate | 1788-1791, Langhans | OSM; Berlin 3D model (dl-de/zero); Commons | none known (German panorama freedom, s. 59 UrhG) |
| 15 | Cologne Cathedral | 1248-1880 | OSM; NRW 3D/LiDAR (dl-de/zero); Commons | none known |
| 16 | Neuschwanstein ("Alpine Swan Castle") | 1869-1886 | OSM; Bavarian open geodata (licence to confirm); Commons | **EU trade mark on the name**: descriptive title |
| 17 | St Basil's Cathedral | 1555-1561 | OSM; Commons | none known |
| 18 | Himeji Castle | 1609 | OSM; PLATEAU if covered (CC BY 4.0; to confirm); Commons | none known |
| 19 | Taj Mahal | 1632-1653 | OSM; Commons | none known for the mausoleum (the Mumbai Taj hotel's marks are a different building) |
| 20 | Hagia Sophia | 537 | OSM; Commons | none known |
| 21 | Temple of Heaven, Hall of Prayer | 1420 (rebuilt 1890) | OSM; Commons | descriptive title |
| 22 | Kinderdijk windmill (one mill) | 1738-1740 | OSM; AHN (CC0); Commons | none known |

Reserves: Westminster Abbey, Mont-Saint-Michel (descriptive title), Stonehenge, Cathedral of Florence (Italy: hold).

**Hold list** (state image laws, pending the lawyer): Leaning Tower of Pisa and the Colosseum (Italy), the Parthenon
(Greece), the Giza pyramids (Egypt), Chichen Itza (Mexico), the Alhambra.

**Excluded** (living copyright or active image licensing): Sydney Opera House, Atomium, Louvre Pyramid, Burj
Khalifa, Christ the Redeemer, Space Needle, Empire State Building, Chrysler Building, Golden Gate Bridge (unless
cleared), Sagrada Familia (post-1926 work and marks), Chateau de Chambord and the Louvre palace (domaines
nationaux), CN Tower, Petronas Towers, Marina Bay Sands.

### 4.3 Per-icon deliverables

Under `$CRAFTMATIC_DESIGNS/landmarks/<slug>/`:
- `site.json`: `SiteEvidence` (with `SourceRef` licences);
- `design.json`: scale, grammar parameters, palette;
- `generated.ldr`: the reproducible output;
- `polish.ops.json`;
- `final.ldr`;
- `provenance.json`, plus `provenance.md` rendered from it;
- `fidelity.json`: silhouette IoU and colour difference per reference view;
- `verify.json`: `VerifyReport`;
- `renders/`: gitignored, under 2000 px a side.

Each icon is accepted when:
1. verify passes: 1 component, 0 unsupported, 0 overlaps, 0 illegal parts;
2. fidelity: silhouette IoU >= 0.85 against the front and side reference elevations, and mean colour difference
   below a threshold set by WP-A11 on the Notre-Dame pilot;
3. the budget fits the product tier;
4. the Marketplace pack of the icon passes every gate in section 7;
5. clearance has been run and recorded by a second agent.

---

## 5. The other pack types

### 5.1 Cloudbreak Summit, the epic coaster (P1)

**Genre references only**: an indoor dark coaster in an artificial mountain, a mine-train theme, neon racing, a huge
steel hyper coaster. No Disney, Warner or Six Flags names, characters, logos, ride names or likenesses; no
recognisable ride layout copied from a real park.

**Targets** (each one at least 3x 10303, section 0.4):

| Metric | 10303 | Cloudbreak target | Ratio |
|---|---|---|---|
| Track length | 181.6 blocks | 900-1,200 blocks | 5-6.6x |
| Height (station to crest) | ~44 blocks | 140-150 blocks | 3.2-3.4x |
| Longest footprint axis | ~40 blocks | 160-200 blocks | 4-5x |
| Inversions | 2 | 6-7 | 3-3.5x |
| Cars | 3 x 1 rider | 2 trains x 6 cars x 2 riders | 8x riders |
| Cycle | 54.2 s | 150-200 s | |

**Layout sketch** (WP-C07 designs it):
1. Station inside the mountain's base: dim light, mine-train props.
2. **Dark section 1**, inside the artificial mountain: a slow dark ride through a mine with lantern cues, then a
   space-themed star field (emissive particles and panels), and a blackout (`minecraft:darkness` plus a camera
   fade) just before an LSM **launch** out of the mountain face.
3. **Neon racing section**: a launched straight under emissive neon arches (chequered and stripe accents, original
   art), an overbanked turn, a zero-g roll and a corkscrew.
4. **Cable lift to the clouds**: about 145 blocks at about 8 blocks/s (about 18 s). Our own cloud banks surround
   the crest (white and light-grey brick clusters as blocks plus soft entity puffs), so the descent "starts in the
   clouds" whatever the game's cloud layer. Also check the crest against the real cloud layer: Bedrock draws
   clouds at about y 192 (UNVERIFIED; measure in the first device round, Q8). With ground at about y 64 a crest at
   about y 210 clears it, and both are under the 319 build limit, which the placement checks already
   (`bedrock-placement-pack.ts:1388`).
5. **Hyper drop**: 140 blocks at 80-85 degrees, with a past-vertical lip like 10303's.
6. Airtime hills, a cobra roll, a helix, mid-course **block brakes** (two trains), then a trim before re-entering
   the mountain.
7. **Dark section 2**: a final helix in the dark, then the brake run and the station.

**Engine work:**
- **Generated track** (WP-C01, C02): `CoasterDesign` -> points every 0.4 blocks or less (the 25 LDU sample rule,
  `coaster-track.ts:48`) via clothoid transitions, with heartline rolls and explicit `ups` in place of
  `coasterTrackUps` inference. A validator checks closure (position, tangent and up continuous at the station),
  vertical g within [-1.0, +4.5], lateral g <= 1.5, jerk, clearance to scenery and world height.
- **Rail geometry** (WP-C03): brick-styled rails (round bars and studded ties, our own geometry; no LEGO coaster
  track mould is needed or used), emitted as entity geometry chunks laid on the same lattice idea as the static
  shell (`STATIC_SHELL_RADIUS_LIMIT_BLOCKS = 70 - 16`, `bedrock-building-shell.ts:72`). Every chunk root must be
  within draw reach of its cubes. Each actor stops drawing at about 72 blocks (CLAUDE.md, rounds 2026-09-26a), so
  a rider at the crest sees only the track within that radius. Alternative to evaluate: rails as custom block
  geometry, which the chunk renderer draws to render distance. It costs block permutations and texture budget;
  WP-C03 measures both options offline and records the choice.
- **Zones** (WP-C04): launch (target speed over a length), cable lift (holds a speed above the chain lift's
  `LIFT_SPEED`), block brakes and a block-section dispatcher for two trains (`COASTER_TRAINS`/`COASTER_HOLD_GAP`
  exist, `bedrock-coaster.ts:183/185`), trims, and a per-route `maxSpeedBps` in place of the global `MAX_SPEED`
  (:657). At pace sqrt 2 a 140-block drop reaches the drag terminal speed of about 49 blocks/s (`GRAVITY 19.6`,
  `DRAG 0.008`). WP-C04 measures in the simulator whether rider teleports and chunk loading hold at 35-45 blocks/s
  and sets the cap (Q10).
- **Show cues** (WP-C05): darkness and blindness effects, `camera.fade`, light blocks placed only into AIR inside
  the mountain (removed by Undo), emissive entity materials for neon (`entity_emissive_alpha` already exists,
  `playable-addon.ts:1508`), and our own namespaced sounds and particles. Every cue is scheduled by arc distance.
- **Rider camera** (WP-C07): long chains of steep stretches merge into one long animation under the `native` plan
  (merge window 12 ticks, look-ahead 160 ticks). New sim cases cover a 6-inversion sequence, a launch at speed and
  a 140-block drop, run with `--scenario=coaster-camera --client=both`.
- **Scenery** (WP-C06):
  - the artificial mountain as OUR OWN brick BLOCKS (hollow shell, stud textures on our own namespaced blocks;
    blocks are not culled at 72 blocks and cost no cuboid budget);
  - station, queue, supports (brickgen `support` grammar: columns from round bricks and lattice beams), neon arches
    and cloud banks as entities or blocks per budget.

### 5.2 Brick Garage (P3)

8 original vehicles designed with brickgen's vehicle grammar (chassis, wheels, cabin, wings), then polished, plus a
garage with roller doors. It reuses the scripted vehicles, the chase and cockpit cameras and `driverSeesOut`.
`!CRAFTMATIC SEAT` metas pin the seats, so the title regexes are not involved. It is blocked until the in-flight
seat and vehicle branches (`gen-side-1109`, `gen-view-1106`, `gen-veh-1106`) merge, because they edit
`cockpit-seat.ts` and `scene-vehicles.ts`.

### 5.3 Brick Arcade: Pinball (P4)

3 original tables designed as LDraw models that `detectPinballTable` (`pinball-table.ts:187`) reads (playfield
tilt, walls, flippers, ball, launch lane), plus an arcade hall with our figures. WP-P02 first checks that every
pinball element the detector keys on (ball `52629`, flipper and bumper moulds) is an official CC BY LDraw part; any
that is not becomes a design constraint, or a new detector key on an authoring meta.

### 5.4 Brick Home: Doors and Furniture (P5)

About 30 pieces as one placeable catalogue (a "kit" placement menu). It reuses `bedrock-interactives.ts` kinds and
seats and beds. The 40-interactive cap (`MAX_INTERACTIVES`, :94) applies per placement, not per pack. Each piece
gets `!CRAFTMATIC DOOR`/`SEAT` metas where its hinge or seat is explicit.

### 5.5 Brick Funfair (P6)

- Ferris wheel and carousel: a new **multi-seat orbit** ride kind (the `orbit` ride exists for the flyer, one seat).
- Drop tower: the lift ride with a free-fall profile.
- Swing ride: orbit with a radius that grows with speed.
- Bumper cars: scripted cars in an arena with soft collisions.
- Slide: the existing slide ride.
- The new kinds follow the rule "a new ride kind adds a path, never its own teleport loop" (CLAUDE.md, rides).

---

## 6. Our own figure

**Goal:** a brick-built figure whose proportions are clearly not a minifigure's (the minifigure's sculpture
copyright and 3D trade marks, EU General Court T-297/22 and T-298/22), and not any other brand's figure either
(Mega, KRE-O, Cobi, and LEGO's BrickHeadz big-square-head look). It must fit the existing walk, seat and rider
code.

**Design brief** (WP-F01 makes 3 candidates; the user picks, Q4):
- built only from generic official LDraw parts (round bricks, plates, slopes, cones, domes), no minifig moulds and
  no minifig-like head, hands or hips;
- a different silhouette: for example a rounded 2x2 head on a 3-stud-wide torso, round 1x1 limbs and plate feet;
- a working height of about 120-140 LDU (minifig: 96, `lego-scale.ts:15`);
- a measurable distinctness gate: normalise both to the same height, then
  - front and side silhouette IoU against the minifig composite must be below 0.6;
  - head-to-height and shoulder-to-height ratios must differ by at least 25 %.

  `test/figure-brickling.test.ts` asserts these numbers. They are evidence for the lawyer, not proof.

**Integration** (WP-F02, F03), using the seam the figure research found:
- Add `'brickling'` to `FigureSystem` (`minifig-rig.ts:61`) with its own canon (neck, shoulders, hips) beside
  `MINIFIG_CANON` (:156), `BRICKLING_BONES` with the bone names the animations target (`body, head, arm_right/left,
  leg_right/left`, as `MINIFIG_BONES` :239), a gait from its own leg length (`MINIFIG_GAIT` :1077 derives from
  `MINIFIG_FEET_Y` :169), seat offsets (`SEAT_BELOW_TORSO_LDU` :689) and walk and sit animations.
- Our designs place figures by `!CRAFTMATIC FIGURE` metas. `compileLdrawEntityGeometry(cid, 'figure', bricks,
  { rig })` takes a rig already (`ldraw-entity-compiler.ts:2314`), so no part-classifier change is needed.
- Scale: `addon-scale.ts` gets a `brickling` cue (from the meta) so `planAddonScale` (:139) scales a model to our
  figure. `LDU_PER_MINIFIG` (`lego-scale.ts:15`) becomes a per-system value.
- Replace the minifig constants found in the code:
  - `DOORWAY_PASS_WIDTH_LDU`/`HEIGHT` (`addon-scale.ts:224-225`, used by `bedrock-interactives.ts:1796`);
  - the hard-coded 24/33.2 head offsets (`bedrock-scene-actors.ts:890`);
  - `SEATED_EYE_ABOVE_PAN_LDU = 43` (`ldraw-entity-compiler.ts:1436`);
  - `FIGURE_SEAT_MATCH_LDU` (`bedrock-scene-actors.ts:346`).

  Each becomes a per-system value; the minifig keeps its measured numbers.
- Keep the measured device facts: the player's seated eye 1.12 blocks over the seat (`lego-scale.ts:29`), figures
  capped at player size (`playable-addon.ts:938-951`), and the seat rider offset -0.3 (`:1035`).
- Face: our own original face texture set (drawn by us, a few expressions), no LEGO-render art (`head-face.ts` is
  bypassed because the head is not a head mould). The Marketplace profile refuses `--faces`.
- The minifig creator wand (`bedrock-minifig-wand.ts`) is excluded from Marketplace packs. A "figure creator" for
  our figure is a later item (`TODO(brickling-creator)`).

---

## 7. Marketplace readiness

All of this ships as the Marketplace profile (`web/src/engine/marketplace/`), applied by
`scripts/_marketplace_pack.ts <design.ldr | dev.mcaddon> --product=products/<pack>/product.json`. Dev packs and the
phone workflow keep working unchanged.

### 7.1 Namespace and identifiers (B2, B3; WP-M01)
- `<creator>_<pack>:` for every entity, block, item, particle, lang key, tag, scoreboard objective, dynamic-property
  key and script event. `geometry.<creator>_<pack>.<name>`, `animation.<creator>_<pack>.…`,
  `controller.animation.<creator>_<pack>.…` and `controller.render.<creator>_<pack>.…`.
- The rewriter maps every id found in JSON (entities, client entities, geometry, animations, render controllers,
  blocks, items, `terrain_texture.json`, `item_texture.json`, `sounds.json`), `.lang` keys, `.mcfunction` files
  and the generated scripts. In the scripts it rewrites only string literals and the namespace prefix constants
  (`SCREEN_TYPE` and similar, `playable-addon.ts:4099`).
- Guard: after the rewrite, zero `craftmatic` tokens in the archive (case-insensitive, excluding the credits file's
  tool name). `bun scripts/sim.ts <rewritten pack>` passes the same scenarios as the dev pack.
- The simulator reads the namespace from the pack, not from `craftmatic:` literals (B2's 54 sim literals,
  WP-M14).

### 7.2 Folder layout (B4; WP-M02)
`<type>/<creator>/<pack>/…` for textures, sounds, functions, loot tables and trading; content type folders such as
`entities/`, `entity/`, `models/entity/`, `animations/`, `render_controllers/` and `blocks/` get
`<creator>_<pack>/` subfolders (CADDONREQ101/104/111). References are rewritten in the same pass.

### 7.3 No vanilla overrides (B1, B6; WP-M03)
- Remove the 17 `textures/blocks/concrete_*.png` files (`playable-addon.ts:2652-2657`) in the Marketplace profile,
  and stop shipping `lego-resource-pack.ts`'s RP (:361) as a product.
- Where the studded look on blocks is wanted (scenery, the mountain, cloud banks, the brick-block building mode),
  ship our own blocks `<ns>:brick_<colour>` (and `<ns>:plate_<colour>` if the budget allows) with our own textures
  under `textures/<creator>/<pack>/blocks/`.
- Permutation budget: one block id per colour without states is 1 permutation each. Re-encode the collider
  `lo`/`hi` states as one `pair` state of 0..135 (`collider-form.ts:553-556`, B6: 11,008 -> 5,848), or as
  `lo`/`hi` with only valid permutations declared. Either way, the dev pack's device-proven behaviour must not
  change, and `addon-walk.ts` and the simulator read the same definition (collider-form.ts header note).
- Guard: no file at any vanilla path (a vanilla-path list from the samples or the MCTools "Vanilla Duplicates"
  suite), and the summed permutations stay at or below 10,000.

### 7.4 Manifests (B5, B13; WP-M04)
- RP header `pack_scope: "world"`; the RP depends on the BP header uuid and the BP on the RP; no dependency on any
  outside pack.
- Frozen uuids from `product.json` (never `packIdentity`).
- `min_engine_version` on both packs.
- Script modules at the latest stable `@minecraft/server`/`server-ui` at build time (the research saw 2.11.0 and
  2.3.0 on 2026-10-27; the packs use 2.9.0 and 2.1.0, `playable-addon.ts:2624`).
- No `-beta`, no experiments, no `runtime_identifier`, no `minecraft:` ids.
- `capabilities: ['pbr']` stays conditional (`playable-addon.ts:4105`).

### 7.5 Validator (WP-M05)
- `scripts/_mctools_validate.ts`: runs Microsoft's Minecraft Creator Tools validator, `@minecraft/creator-tools`
  (`mct validate <folder>`, learn.microsoft.com MCTools overview), through `bunx` on the unpacked BP and RP. It
  parses the report and exits 1 on any Error. Warnings are listed in the submission bundle.
- `scripts/_mcaddon_check.py` gains a `--marketplace` mode that reimplements the Error rules the tests need offline
  (CADDONREQ160-169, CADDONIREQ100-170, folder rules, vanilla paths, permutations, texture sizes), so CI does not
  depend on downloading MCTools.

### 7.6 Budgets for low-end devices (WP-M06)
- `scripts/_marketplace_budget.ts <pack>` reports and gates:
  - uncompressed size (Microsoft's guideline is 25 MB or less and 3,500 files or fewer);
  - block permutations (10,000 or fewer);
  - texture sizes (256 for blocks and items, 2048 for everything else);
  - resident entities and cuboids after placement (read from the placement plan the sim builds);
  - median script time per tick (sim `--cost`, `scripts/_sim_script_cost.ts`).

- Proposed tiers, to be tuned by the first measurements (Q10):

  | Tier | Resident cuboids | Resident entities | Script median | Uncompressed |
  |---|---|---|---|---|
  | `low` | 30k | 60 | 2 ms | 15 MB |
  | `standard` | 60k (about 10303) | 120 | 4 ms | 25 MB |
  | `high` | 120k | 200 | 6 ms | 25 MB |

  The phone heap cost is about 3.3-4.6 KB per cube (`TASKS-BEDROCK-ADDON.md:263-264`). At 60k cubes that is about
  200-280 MB of native heap.
- Performance rules (already true in dev packs, kept as gates): one shared roster (`scripts/roster.js`), no per-tick
  `getEntities`/`getAllPlayers`, LOD hulls on.

### 7.7 Placement into air only, with a prompt and an Undo (B7, B8; WP-M07)
- **Preflight**: scan the footprint, including the size the player chose. Count non-air blocks that are not this
  pack's own (the scan at `bedrock-placement-pack.ts:1839` already tells ours from the world's).
  - With any foreign block, the prompt says how many and where, and offers "Find a clear spot nearby" (search
    outward for a clear footprint at the same height), "Move" or "Cancel".
  - It never replaces anything.
  - The text "Blocks in this area will be replaced." (:1553) goes away in the Marketplace profile.
- **Undo**: it exists and persists across a reload (:1062-1096). Add a guard that Undo removes every block and
  entity the placement added, and leaves the world byte-identical in the sim (`test/bedrock-placement-undo-reload.test.ts`
  extended).
- **Ticking areas**: the guidelines say to avoid them. Load the build area by player proximity in steps, or keep
  the existing temporary areas with guaranteed removal, decided with the publisher (Q9). Either way, a guard that
  no ticking area survives a placement or an Undo.
- **Onboarding**: a guide book given once per player (an original book: what the pack does, how to place, Undo,
  credits page). Chat lines of 28 characters or fewer, only on first join. Everything else uses forms or the
  action bar. Today's `[Brick Wand]` chat prefix (:998) becomes action-bar text in the Marketplace profile.

### 7.8 Player-facing names and text (B9; WP-M08)
- Product names, item and entity names from `product.json` and the design's labels, localised `.lang` (`en_US`
  first; others are a publisher question, Q9).
- **Text lint** (`marketplace/text-lint.ts`) over manifests, `.lang`, form and action-bar strings in the scripts,
  the guide book and the store text. It rejects:
  - "LEGO", "minifig"/"minifigure", "Duplo", "Technic", "Brickheadz", "Studio", "BrickLink";
  - set-number patterns (`\b\d{4,6}(-\d)?\b` in names);
  - licensed theme names (a maintained list);
  - dev stamps (`packDisplayName` output, commit hashes, dates);
  - "craftmatic" outside the credits;
  - strong language (SHARING101).
- Renames: "Brick Wand" can stay (generic) if the lawyer agrees; "Minifig Creator Wand" is removed.

### 7.9 LDraw attribution and no Studio-only meshes (B10, B11, B12; WP-M09, M10)
- **Library mode `official`** (`ldraw-geometry.ts`): resolve parts ONLY from `ldraw_ref/official/` (and optionally
  `ldraw_ref/unofficial/` when its file carries a CC BY `!LICENSE` line). No Studio `UnOfficial/` tree, no embedded
  `.io` parts, no `bl_` copies and no alias substitution (`datSubstitutions` must stay empty). Every unresolved part
  fails the export, with the list. It is set by `CRAFTMATIC_LDRAW_LIBRARY=official` or the profile.
- **Credits** (`marketplace/credits.ts`): `CREDITS.txt` in both packs plus a credits page in the guide book. It
  holds:
  - "Brick part shapes from the LDraw Parts Library (ldraw.org), licensed CC BY 2.0 / CC BY 4.0 by their authors";
  - the per-part author list from each `.dat`'s `0 Author:` and `0 !LICENSE` lines (every subfile and primitive
    reached);
  - "(c) OpenStreetMap contributors (ODbL)" when a design used OSM;
  - each other `SourceRef` attribution the licence requires.

  Wording for the lawyer (Q6).
- **No LEGO face art**: `--faces` refused, `headPrint` metas refused.
- **No logo studs**: refuse any `logo*.dat` primitive or `stud-logo*` reached through a part.

### 7.10 Store art and screenshots (WP-S01)
- **Offline art**:
  - web-viewer renders of the LDraw designs through headless Chrome (Node, per CLAUDE.md), at the publisher's
    sizes (unpublished; Q9);
  - `_pack_render.ts --views=8` contact sheets;
  - `_cockpit_view.ts` cockpit pictures;
  - coaster POV frames from `--scenario=coaster-camera --frames`.
- **In-game screenshots, key art, panorama and trailer** need a Minecraft client. The PC's client is the user's and
  the phones are off-limits for this work, so these are a **prepared shot list awaiting the user's approval** of a
  capture session.
- No LEGO marks, no box-art likeness, no licensed characters; AI-made or AI-modified art carries a disclaimer where a
  platform requires it (CurseForge).

### 7.11 Submission bundle, prepared and NOT submitted (WP-S02)
`scripts/_submission_bundle.ts <pack>` writes `output/marketplace-bundles/<pack>-<commit>/` (gitignored) with:
- the `.mcaddon` and the unpacked BP/RP;
- the MCTools report (0 Errors);
- the `_mcaddon_check --marketplace` and budget reports;
- the sim report and the BDS content-log capture;
- provenance logs, clearance results and credits;
- the store text (title, description, keywords, `en_US`), the art and the shot list;
- the device test matrix (pending device rounds);
- a README stating "prepared, awaiting approval; not submitted".

Then a zip with its sha256 (memory `feedback-share-as-zip`, `feedback-hand-over-the-artifacts`).

---

## 8. Test strategy

### 8.1 Fail-first unit tests
Every work package names its first failing test (section 10). It must fail for the right reason first: an assertion
on the missing behaviour, never a missing-import crash. Run one file with `bunx vitest run <file>`, the suite with
`bun run test` (never bare `bun test`).

### 8.2 Offline LDraw vocabulary for CI
CI has no LDraw library, so corpus-gated tests skip there (`test/playable-golden-models.test.ts:21-23`).
- WP-A01 vendors the brick vocabulary's official parts and every subfile and primitive they reach, from
  `C:/git/clego/ldraw_ref/official/`, into `test/fixtures/ldraw-vocab/`. Parts are CC BY, so redistribution is
  allowed with attribution: the folder gets `LICENSE.md` with the per-file authors, generated by
  `scripts/_vendor_ldraw_vocab.ts`.
- Tests point the library at that folder (`setLDrawRoot`), so the brickgen -> `runSchemPipeline` -> Marketplace
  chain runs on CI.

### 8.3 Golden models
- **Synthetic sites, committed** (`test/fixtures/brickgen/`): a box house, an L-plan, a round tower, a cruciform
  church, a courtyard (polygon with a hole) and a stepped tower. Each has an expected `VerifyReport` (1 component,
  0 unsupported) and pinned counts within a tolerance band, plus a byte-identical `.ldr` determinism check.
- **Real sites, local**: OSM extracts replayed from `ApiCache` (`output/api-cache/<slug>/`), gitignored. They can
  be committed later with an ODbL notice if the user wants them on CI.
- **Our designs**: once final, the free sampler's designs are committed as goldens through the whole chain
  (brickgen -> pack -> Marketplace rewrite -> gates). Paid designs are goldens in the private designs repo (3.4),
  with the same tests skipped when `CRAFTMATIC_DESIGNS` is absent, marked ` (designs)` in the ledger the way
  ` (corpus)` is.

### 8.4 Simulator (`bun scripts/sim.ts`)
- Every Marketplace pack runs `child-play`, `vehicles`, `hop`, `walk-away` and `regressions` as the dev pack does.
- New `--scenario=marketplace` (WP-T02):
  - placing on a cluttered spot refuses or relocates, and never replaces a block;
  - Undo restores the world exactly;
  - the guide book is given once per player;
  - chat lines are 28 characters or fewer;
  - no ticking area remains;
  - two players place, ride and undo without cross-talk.
- New coaster metrics (WP-C04): lap time, max and min vertical g, lateral g, peak speed, the time spent in darkness
  zones, block-brake holds with two trains, and a launch that reaches its target speed.
- New figure cases (WP-F03): our figure walks through a doorway sized for it, sits, rides, and is never stuck; the
  `figure-life` invariants hold.

### 8.5 Offline renders
- `_pack_render.ts --views=8 --uvfloor=v --hatch --lod`: contact sheets per icon. `--hatch` counts must be 0 after
  `separateCoplanarFaces`, and `--uvfloor` dropped faces must be 0.
- `_pack_render.ts --walk-away=20..120:20` for the coaster and the large icons (draw reach).
- `_cockpit_view.ts` for every garage vehicle and every coaster seat.
- All PNGs under 2000 px a side and under 4 MB.

### 8.6 Bedrock Dedicated Server (WP-T01)
- `C:/git/bds/1.26.63.1/`. Copy the server into a NEW folder per run (never clean an old one; no recursive
  delete), with a NEW world that has no experiments and no Beta APIs. That proves the pack needs none.
- `scripts/_bds_smoke.ts <pack>`:
  1. installs the pack into the new world's `development_*_packs` and binds it;
  2. starts the server;
  3. runs the placement function and a `scriptevent`-driven smoke (place, ride one lap headless with a simulated
     rider if the server allows, Undo);
  4. reads the console content log;
  5. exits 1 on any error or warning from the pack.

  This is the first real check of the simulator's API fidelity on these packs.
- It never touches the user's Minecraft client or worlds.

### 8.7 Device rounds (later, with the user's approval)
- Pixel and Saga rounds follow `.claude/skills/bedrock-device-round.md`. This plan schedules none.
- Ledger rows stay `DONE-OFFLINE` until a device round (REQUIREMENTS rule 2).

### 8.8 Real user inputs (local only)
- For Scenario B and for mapper evaluation on ordinary buildings:
  - photos of real brick builds and buildings;
  - user MOC files found online.
- They go in `output/biz-inputs/<source-slug>/` (gitignored), each with `SOURCE.md` recording the URL, author,
  licence and download date. They are never shipped, never redistributed and never used for an icon (3.3).

---

## 9. Risks and open questions

### 9.1 Risks
| Risk | Effect | Mitigation |
|---|---|---|
| A computed id escapes the namespace rewriter | the pack breaks or collides | whole-archive token scan, plus the sim and BDS on the rewritten pack |
| The namespace or uuids change after release | broken worlds; Mojang forbids it | `product.json` frozen and minted once; a test that fails if a committed identity changes |
| The bricker's output looks like a voxel mosaic, not a buildable model | weak product | element vocabulary with slopes, arches, rounds; polish ops; measured fidelity; the Notre-Dame pilot sets the bar before batch work |
| Stability rules too strict or too loose | ugly or "impossible" models | rules calibrated on synthetic goldens and the pilot; the `auditConnectivity` cross-check |
| 3x coaster too heavy for phones | lag, cull, memory | blocks for scenery, chunked rails, the tier budget, the sim `--cost` gate |
| Hyper-coaster speed vs chunk loading | the train pauses (`unloaded block is not air`), or the rider sees unloaded terrain | cap from measurement (WP-C04); keep the ride inside about 200 x 200 blocks |
| Rider camera with many inversions | the camera grazes cars (open issue, `docs/coaster-loop-camera.md` section 5) | sim `coaster-camera` cases first; one car per train has priority |
| Clean-room contamination | the design is no longer independent | denylist in every brief; clearance by a second agent; provenance log |
| Store art needs an in-game client | bundle incomplete | shot list prepared, awaiting the user's capture approval |
| In-flight branches on seats and vehicles | merge conflicts | P3 (garage) waits; A avoids `cockpit-seat.ts` and `scene-vehicles.ts` until merged |
| MCTools rules change | a late validator failure | pin the MCTools version per release; rerun at submission |
| Public repo | paid designs leak | private designs repo (Q3) |

### 9.2 Open questions for the user
1. **Q1 Creator code and studio name.** The `<creator>` part of every namespace (for example `cmt`), the studio
   name in `0 Author:` and the licence line on our own `.ldr` files. The namespace can never change after release.
2. **Q2 Product names.** Working titles in section 1 and the coaster name "Cloudbreak Summit", plus a trade-mark
   search before use.
3. **Q3 Where designs live.** A private local repo `C:/git/craftmatic-designs` (default), and whether to create a
   private GitHub remote (an outward step).
4. **Q4 Our figure.** Pick one of three candidates from WP-F01, and its name (working name "Brickling").
5. **Q5 Who polishes.** Agents with measured fidelity (default), the user in LDCad/Studio (exported as `.ldr`;
   the official-library gate catches Studio-only parts), or a commissioned designer.
6. **Q6 For the lawyer** (adding to `1-legality.md` section 6.2):
   - descriptive vs proper landmark names (Eiffel, Neuschwanstein, Tower Bridge);
   - the Eiffel daytime-only rule;
   - the hold list (Italy, Greece, Egypt, Mexico);
   - whether a generic studded look on our own blocks is safe;
   - figure distinctness evidence;
   - the credits wording for LDraw CC BY and OSM ODbL inside a Marketplace pack;
   - whether "Brick Wand" is fine.
7. **Q7 Approve the landmark list** (section 4.2), the hold list and the exclusions.
8. **Q8 First device round** after the Marketplace profile lands: to measure the cloud height, coaster speed, budgets
   and the content log on both phones (needs explicit approval, with the phones' current state checked first).
9. **Q9 Publisher questions** (prepared, not sent): store-art sizes, panorama and trailer specs, ticking-area
   policy, camera API use (`setCamera`, `playAnimation`), localisation, world vs add-on product type, tier and
   device-memory restrictions.
10. **Q10 Budget tiers and coaster pace**: approve the tier numbers in 7.6 after the first measurements; pace 1.0
    vs sqrt 2 for Cloudbreak.
11. **Q11 Sounds.** Original sound effects for the coaster and arcade: made by us (synthesised), CC0 libraries
    (recorded), or none.

---

## 10. Work packages

Each package is sized for one subagent in one worktree `.worktrees/biz-a-<id>` on branch `biz-a/<id>`. Every brief
must repeat the binding rules from `brief-common.md`:
- fail-first TDD;
- conventional commits ending "— Opus 5.5", no Co-Authored-By, never the word "Claude";
- merge, never rebase;
- **never a recursive delete** (no `rm -rf`, `rm -r`, `Remove-Item -Recurse`, `rmdir /s`, `find -delete` or
  `git worktree remove`, even in temp dirs; use a new directory name instead);
- no `git reset`/`revert`/`stash`;
- no phones, no adb, no Minecraft client;
- screenshots under 2000 px and under 4 MB;
- the clean-room denylist for any landmark work;
- typecheck (`bun run typecheck`, `bun run typecheck:web`) and `bun run test` before every commit;
- the REQUIREMENTS id in every commit message;
- commit before generating any pack.

### Phase 0: foundations (all parallel)

**WP-A00 Tracker, ledger rows, clean-room tooling** (BIZ-06, BIZ-29)
- Goal: the ledger rows, the `TASKS-BUSINESS.md` section, the denylist and provenance tooling.
- Files: `REQUIREMENTS.md` (section 17), `TASKS-BUSINESS.md`, `scripts/_cleanroom_denylist.ts`,
  `web/src/brickgen/provenance.ts`, `test/brickgen-provenance.test.ts`.
- First failing test: `test/brickgen-provenance.test.ts :: a provenance log without a clearance entry fails validation`.
- Accept: the ledger test passes with 25 new OPEN rows; the denylist lists the corpus's landmark sets for
  "notre dame"; the provenance schema round-trips.
- Deps: none.

**WP-A01 Types, vocabulary, vendored LDraw subset** (BIZ-05, BIZ-07)
- Goal: `types.ts` (section 2.3), `vocab/` with about 80 official elements (bricks and plates 1x1-2x10, slopes,
  inverted slopes, curved slopes, arches 1x3-1x12, round bricks and plates, cones, domes, windows and frames,
  doors, tiles, brackets, lattice and fence parts, bars), each with occupancy and connections read from the part's
  geometry and its `!LICENSE`/`Author` lines; the vendored fixture folder.
- Files: `web/src/brickgen/types.ts`, `web/src/brickgen/vocab/*`, `scripts/_vendor_ldraw_vocab.ts`,
  `test/fixtures/ldraw-vocab/**`, `test/brickgen-vocab.test.ts`, `web/tsconfig.json` (include).
- First failing test: `test/brickgen-vocab.test.ts :: every vocabulary element is an official LDraw part with a CC BY licence line`.
- Accept: 0 elements from Studio or `bl_`; occupancy of a 45-degree slope matches its geometry; the fixture folder
  holds every reached subfile; `typecheck:web` is clean.
- Deps: none.

**WP-A02 LDraw colour mapper**
- Goal: `nearestLdrawColour(rgb, palette)` over the production palette (Lab, CIEDE2000), excluding transparents
  unless asked.
- Files: `web/src/brickgen/colour.ts`, `test/brickgen-colour.test.ts`.
- First failing test: `:: pure white maps to LDraw 15 and a sandstone tan maps to 19`.
- Accept: every production colour maps to itself; deterministic ties.
- Deps: none.

**WP-A03 LDraw writer and authoring metas** (BIZ-09)
- Goal: `BrickPlan` -> MPD (deterministic, LF, groups as `0 FILE`), the new `!CRAFTMATIC` metas registered in
  `ldraw-directives.ts`, parsed by `ldraw-parser.ts`, and audited by `_converter_coverage_audit.ts`.
- Files: `web/src/brickgen/emit/ldraw-writer.ts`, `web/src/engine/ldraw-directives.ts`,
  `web/src/engine/ldraw-parser.ts`, `test/brickgen-ldraw-writer.test.ts`.
- First failing test: `:: a written plan parses back through parseLDrawDocument to the same parts, colours and positions`.
- Accept: byte-identical output for the same plan; quarter turns as exact matrices; metas survive the round trip;
  the coverage audit passes.
- Deps: A01 (types).

**WP-A04 Lattice connectivity and stability verifier** (BIZ-08)
- Goal: section 3.1 step 7.
- Files: `web/src/brickgen/verify/{connect,stability,overlap,legality,budget}.ts`, `test/brickgen-verify.test.ts`.
- First failing test: `:: a 1x4 plate bridging two towers by one stud each is connected; the same plate one plate higher is two components`.
- Accept: cantilever limits per element class; an `auditConnectivity` cross-check helper; budget estimate within
  15 % of the real compiled cuboid count on 3 goldens (measured).
- Deps: A01.

**WP-M01 Product identity and namespace rewriter** (BIZ-22)
- Goal: `product.json`, uuid mint, rewrite of every id (section 7.1).
- Files: `web/src/engine/marketplace/{product,rewrite}.ts`, `scripts/_marketplace_pack.ts`,
  `test/marketplace-rewrite.test.ts`.
- First failing test: `:: a rewritten pack contains no craftmatic token and every geometry an entity names is defined`.
- Accept: the scan is clean on packs built from 3 test models (the existing synthetic-brick fixtures in
  `test/playable-addon.test.ts`); `_mcaddon_check.py` passes on the output; the uuids are frozen.
- Deps: none.

**WP-M05 Validator gate** (BIZ-24)
- Goal: section 7.5.
- Files: `scripts/_mctools_validate.ts`, `scripts/_mcaddon_check.py` (`--marketplace`),
  `test/marketplace-check.test.ts` (runs the Python check on fixture zips).
- First failing test: `:: the marketplace check rejects an RP without pack_scope and a texture at a vanilla path`.
- Accept: the current dev pack fails with exactly B1, B4, B5 and B6 listed; MCTools runs via `bunx` (the version
  pinned) on one pack, with the report saved.
- Deps: none.

**WP-M06 Budget gate** (BIZ-25)
- Goal: section 7.6.
- Files: `scripts/_marketplace_budget.ts`, `web/src/engine/marketplace/budget.ts`, `test/marketplace-budget.test.ts`.
- First failing test: `:: block permutations are summed over every custom block and states product`.
- Accept: it reports 11,008 on today's collider set; the tiers are configurable; JSON output for the bundle.
- Deps: none.

**WP-C01 Coaster design -> path** (BIZ-13)
- Goal: elements -> `GeneratedCoaster` (points, ups, zones, report) with the validator (closure, g, jerk, world
  height).
- Files: `web/src/engine/coaster-design.ts`, `test/coaster-design.test.ts`.
- First failing test: `:: a station-lift-drop-loop-brake circuit closes with continuous position, tangent and up`.
- Accept: a loop of radius r reports one inversion; an airtime hill's crest g is below 0; the report of a 3x
  design exceeds 10303 on every axis of section 0.4.
- Deps: none (pure math over `coaster-path.ts` types).

**WP-F01 Figure design study** (BIZ-21)
- Goal: 3 candidate figures as LDraw models from generic parts, the distinctness metric, renders for the user.
- Files: `web/src/engine/figure-brickling.ts` (canon draft), `test/fixtures/figures/*.ldr`,
  `scripts/_figure_distinctness.ts`, `test/figure-brickling.test.ts`.
- First failing test: `:: the candidate's normalised front silhouette IoU against the minifig composite is below 0.6`.
- Accept: 3 candidates pass the metric; contact sheets in `output/biz-a/figures/`; Q4 asked.
- Deps: none.

### Phase 1: the mapper (after A01; parallel by folder)

**WP-A05 Massing from footprint** (BIZ-05)
- Goal: OSM or polygon -> `MassVolume[]`; stud snapping; scale choice by the budget.
- Files: `web/src/brickgen/site/{osm,licence-gate}.ts`, `web/src/brickgen/massing/*`, `test/brickgen-massing.test.ts`.
- First failing test: `:: a 20 x 10 m rectangle at 1 stud per metre becomes a 20 x 10 stud volume with edges on the grid`.
- Accept: polygons with holes; `building:part` heights; the licence gate refuses `google-maps-content`.
- Deps: A01.

**WP-A06 Bricker** (BIZ-05)
- Goal: lattice -> plan with running bond, largest-element packing, hollow interiors.
- Files: `web/src/brickgen/bricker/*`, `test/brickgen-bricker.test.ts`.
- First failing test: `:: a 6 x 6 x 9-plate solid wall lattice bricks to one connected component with no aligned seams in consecutive layers`.
- Accept: goldens (box house, L-plan, courtyard) verify at 1 component, 0 unsupported; part count within the bands.
- Deps: A01, A04.

**WP-A07 Roof and tower grammars**
- Goal: gabled, hipped, pyramidal, conical, dome, onion, spire, mansard; square, octagonal and round towers.
- Files: `web/src/brickgen/grammar/{roof,tower,spire,dome}.ts`, `test/brickgen-grammar-roof.test.ts`.
- First failing test: `:: a gabled roof over a 10-stud span at 45 degrees uses slope elements on both faces and closes at the ridge`.
- Accept: every roof golden verifies; slopes face outward (the occupancy direction test).
- Deps: A01, A06 (the slope picker contract).

**WP-A08 Facade grammars**
- Goal: bays, string courses, rectangular, round-arch and lancet openings, rose windows, buttresses and flying
  buttresses, columns and colonnades, battlements, clock faces, lattice girders, cables.
- Files: `web/src/brickgen/grammar/{wall,facade,window,arch,column,buttress,lattice}.ts`,
  `test/brickgen-grammar-facade.test.ts`.
- First failing test: `:: a 3-bay facade with lancet windows leaves 3 openings of the requested size and stays one component`.
- Accept: the cruciform-church golden verifies; openings match the requested size within 1 stud and 1 plate.
- Deps: A01, A06.

**WP-A09 Features from inputs**
- Goal: tags, annotations (JSON sidecar format), licensed-photo analysis, mesh slices -> `FeatureSet`, with
  confidence.
- Files: `web/src/brickgen/features/*`, `test/brickgen-features.test.ts`.
- First failing test: `:: an annotation marking a rose window on edge 0 yields one rose FeatureSpec at the marked height`.
- Accept: an annotation beats photo analysis; every feature cites a `SourceRef`.
- Deps: A05.

**WP-A10 brickgen CLI and orchestration**
- Goal: `bun scripts/brickgen.ts <site.json> --design=<design.json> --out=<dir>` -> `generated.ldr`, `verify.json`,
  and optionally a dev `.mcaddon` via `runSchemPipeline`.
- Files: `scripts/brickgen.ts`, `web/src/brickgen/index.ts`, `test/brickgen-pipeline.test.ts`.
- First failing test: `:: the cruciform golden runs site to .ldr to a playable pack offline against the vendored vocabulary`.
- Accept: runs on CI; prints the verify summary; refuses to emit on a verify failure unless `--allow-unverified`.
- Deps: A02-A09.

**WP-A11 Polish ops and fidelity**
- Goal: section 3.1 step 9; the fidelity renderer (headless Chrome via Node) and the metric; thresholds calibrated
  on the pilot.
- Files: `web/src/brickgen/polish/*`, `scripts/_brickgen_fidelity.mjs`, `test/brickgen-polish.test.ts`.
- First failing test: `:: replaying polish ops on a regenerated plan reproduces final.ldr byte for byte`.
- Accept: an op that targets a vanished group is reported, never silently dropped.
- Deps: A03, A10.

### Phase 1: Marketplace profile (serial chains; see section 11)

**WP-M02 Folder layout** (BIZ-22)
- Goal: section 7.2 inside the rewriter.
- Files: `web/src/engine/marketplace/rewrite.ts`, `test/marketplace-rewrite.test.ts`.
- First failing test: `:: no file sits loose in a content type folder after the rewrite`.
- Accept: `_mcaddon_check --marketplace` reports no folder rule errors.
- Deps: M01.

**WP-M03 Own brick blocks, no vanilla overrides, permutation fix** (BIZ-23)
- Goal: section 7.3.
- Files: `web/src/engine/marketplace/blocks.ts`, `web/src/engine/collider-form.ts`, `web/src/engine/playable-addon.ts`
  (:2652-2657, behind the profile), `test/marketplace-blocks.test.ts`, `test/collider-form*.test.ts`.
- First failing test: `:: a marketplace pack ships no file at a vanilla texture path and its block permutations total at most 10000`.
- Accept: the dev pack is unchanged byte for byte except the collider state encoding, if chosen; the sim
  `regressions` set passes on the dev pack.
- Deps: M01.

**WP-M04 Manifests and onboarding book** (BIZ-23, BIZ-26)
- Goal: section 7.4 plus the guide book item.
- Files: `web/src/engine/marketplace/manifest.ts`, `test/marketplace-manifest.test.ts`.
- First failing test: `:: the RP manifest has pack_scope world and depends on the BP header uuid`.
- Accept: the latest stable script modules resolved at build time from a pinned table (no network at build).
- Deps: M01.

**WP-M07 Air-only placement, prompt, Undo, no chat spam** (BIZ-26)
- Goal: section 7.7.
- Files: `web/src/engine/bedrock-placement-pack.ts` (profile-gated), `test/bedrock-placement-air-only.test.ts`,
  `test/bedrock-placement-undo-reload.test.ts`.
- First failing test: `:: placing over one foreign block refuses and offers a clear spot; nothing is replaced`.
- Accept: Undo restores the sim world exactly; no ticking area left; chat lines of 28 characters or fewer on first
  join only.
- Deps: M01 (the namespace for the dynamic-property keys).

**WP-M08 Player-facing text and the lint** (BIZ-27)
- Goal: section 7.8.
- Files: `web/src/engine/marketplace/text-lint.ts`, `web/src/engine/pipeline-version.ts` (profile-aware
  `packDisplayName`), `test/marketplace-text-lint.test.ts`.
- First failing test: `:: the lint rejects a manifest name containing a set number and the word minifig`.
- Accept: the lint scans scripts' string literals too; 0 findings on a Marketplace pack.
- Deps: M01.

**WP-M09 Credits** (BIZ-27)
- Goal: section 7.9 credits.
- Files: `web/src/engine/marketplace/credits.ts`, `test/marketplace-credits.test.ts`.
- First failing test: `:: every part file reached by the pack's geometry appears in CREDITS.txt with its author and licence`.
- Accept: OSM attribution present when a `SourceRef` is `odbl`.
- Deps: M01, M10.

**WP-M10 Official-only library mode** (BIZ-07)
- Goal: section 7.9 library mode; refuse `--faces`, head prints and logo studs.
- Files: `web/src/engine/ldraw-geometry.ts`, `test/ldraw-library-official.test.ts`.
- First failing test: `:: in official mode a part present only in Studio's UnOfficial tree fails the export with its name`.
- Accept: `datSubstitutions` empty; the default (dev) mode unchanged.
- Deps: none (one file; schedule outside other `ldraw-geometry.ts` work).

**WP-M14 Simulator namespace-awareness** (BIZ-29)
- Goal: replace the 54 `craftmatic:` literals in `web/src/sim/` with the pack's namespace.
- Files: `web/src/sim/adapters/craftmatic/*`, `web/src/sim/quirks/*`, `test/sim-namespace.test.ts`.
- First failing test: `:: child-play runs on a pack whose namespace is cmt_test`.
- Accept: all sim scenarios unchanged on dev packs.
- Deps: M01.

**WP-M15 Stable Script API audit** (BIZ-24)
- Goal: type-check every generated script against the stable `@minecraft/server` and `server-ui` `.d.ts` (vendored
  typings, `// @ts-check` over the emitted JS).
- Files: `scripts/_script_api_audit.ts`, `test/script-api-stable.test.ts`.
- First failing test: `:: an emitted script calling a beta-only API fails the audit`.
- Accept: the list of APIs used, with their stability, goes into the bundle.
- Deps: none.

**WP-T01 BDS smoke gate** (BIZ-29)
- Goal: section 8.6.
- Files: `scripts/_bds_smoke.ts`, `docs/testing-guide.md` (one section).
- First failing test: `test/bds-smoke-parse.test.ts :: the content-log parser flags a pack warning line and ignores vanilla noise` (the live run is a manual `gate:`).
- Accept: one Marketplace pack loads in a fresh non-experimental world with 0 pack errors and warnings, log saved.
- Deps: M01-M04.

**WP-T02 Marketplace sim scenario** (BIZ-26, BIZ-29)
- Goal: section 8.4 `--scenario=marketplace`.
- Files: `web/src/sim/adapters/craftmatic/marketplace.ts`, `scripts/sim.ts`, `test/sim-marketplace.test.ts`.
- First failing test: `:: the marketplace scenario fails a pack whose placement replaces a block`.
- Accept: two-player case included.
- Deps: M07, M14.

### Phase 2: figure, coaster, packs

**WP-F02 Figure system integration** (BIZ-21)
- Goal: section 6 integration.
- Files: `web/src/engine/minifig-rig.ts`, `figure-brickling.ts`, `addon-scale.ts`, `lego-scale.ts`,
  `bedrock-scene-actors.ts` (:346, :890), `ldraw-entity-compiler.ts` (:1436), `bedrock-interactives.ts` (:1796),
  `test/figure-brickling.test.ts`.
- First failing test: `:: a model with a brickling FIGURE meta scales so the figure is the player's height and its doorway pass size is the brickling envelope`.
- Accept: every minifig test unchanged; the per-system constants table is documented in
  `docs/physics-architecture.md` (the spec check `_physics_spec_check.ts` passes).
- Deps: F01 (the user's pick), A03 (metas).

**WP-F03 Figure animations and sim cases**
- Goal: walk and sit animations for the brickling bones; sim walking, seating and riding.
- Files: `web/src/engine/minifig-rig.ts` (client animations per system, :1132), `web/src/sim/adapters/craftmatic/figure-life.ts`,
  `test/bedrock-figure-life.test.ts`.
- First failing test: `:: a brickling figure walks through its own doorway and sits on a SEAT meta without clipping`.
- Deps: F02, M14.

**WP-C02 Generated route into the pipeline**
- Goal: a `CoasterDesign` file feeds `coasterRuntimeConfig` with explicit ups and zones; the cars come from our own
  car design (brickgen vehicle grammar or a hand LDraw car), not from 26021.
- Files: `web/src/engine/schem-pipeline.ts` (:556-620), `web/src/engine/bedrock-coaster.ts` (route assembly),
  `test/coaster-generated-route.test.ts`.
- First failing test: `:: a pack built from a CoasterDesign carries its route with the design's length and ups`.
- Deps: C01.

**WP-C03 Rail geometry**
- Goal: rails and ties from the route, chunked within draw reach; the offline comparison of entities vs custom
  block geometry.
- Files: `web/src/engine/coaster-track-mesh.ts`, `test/coaster-track-mesh.test.ts`.
- First failing test: `:: every rail chunk's root lies within STATIC_SHELL_RADIUS_LIMIT_BLOCKS of each of its cubes`.
- Accept: `_pack_render.ts --walk-away` shows continuous rail; the decision is recorded in
  `docs/bedrock-addon-guide.md`.
- Deps: C01.

**WP-C04 Zones: launch, cable lift, block brakes, speed cap, sim metrics**
- Goal: section 5.1 zones.
- Files: `web/src/engine/bedrock-coaster.ts` (`COASTER_PHYSICS` :641, `rideSubstep` :760), `coaster-zones.ts`,
  `web/src/sim/adapters/craftmatic/coaster.ts`, `test/coaster-zones.test.ts`.
- First failing test: `:: a launch zone takes a train from 2 to 30 blocks/s within its length`.
- Accept: two trains never share a block section (sim); the measured speed cap recorded in
  `docs/physics-architecture.md` (the spec check passes).
- Deps: C02.

**WP-C05 Dark sections and show cues**
- Goal: darkness, fade, light blocks into air, emissive neon materials, our own sounds and particles, by arc
  distance.
- Files: `coaster-zones.ts`, `bedrock-coaster.ts` (cue runner), `test/coaster-show.test.ts`.
- First failing test: `:: entering a dark zone applies darkness to every rider once and removes it on exit`.
- Accept: Undo removes every light block; no cue touches a non-rider.
- Deps: C04.

**WP-C06 Coaster scenery grammars**
- Goal: the artificial mountain (hollow, our brick blocks), cloud banks, station, queue, supports, neon arches.
- Files: `web/src/brickgen/grammar/{terrain,cloud,support}.ts`, `web/src/engine/marketplace/blocks.ts` (block
  palette), `test/brickgen-grammar-scenery.test.ts`.
- First failing test: `:: supports reach the ground from every track sample above 4 blocks and never cross the rider envelope`.
- Deps: A06, C01, M03.

**WP-C07 Cloudbreak design, polish and camera**
- Goal: the P1 pack to section 5.1's targets, polished; the camera sim cases.
- Files: `$CRAFTMATIC_DESIGNS/rides/cloudbreak/*`, sim case file.
- First failing test: `:: the Cloudbreak report exceeds 3x 10303 on length, height, footprint and inversions` (designs-gated).
- Accept: every gate in section 7; `coaster-camera --client=both` passes; renders reviewed.
- Deps: C02-C06, M01-M10.

**WP-L00 Landmark source discovery** (BIZ-11, BIZ-12)
- Goal: for each of the 22, fetch and record the inputs (OSM ids, LiDAR tiles, drawings, photos with licences,
  documented dimensions) into `site.json` drafts; apply the rights screen; mark hold or exclude.
- Files: `$CRAFTMATIC_DESIGNS/landmarks/*/site.json`, `output/biz-a/landmark-sources.md`.
- First failing test: `test/brickgen-site-schema.test.ts :: every landmark site.json validates and every source has a licence`.
- Deps: A00, A05 (the schema).

**WP-L01 Notre-Dame pilot** (BIZ-10)
- Goal: the first icon end to end, which also calibrates the fidelity thresholds and the stability rules.
- Files: `$CRAFTMATIC_DESIGNS/landmarks/notre-dame-paris/*`.
- First failing test: `:: the Notre-Dame design verifies at 1 component and its front silhouette IoU is at least 0.85` (designs-gated).
- Accept: section 4.3; the clearance run by a second agent; a Marketplace pack passing every gate.
- Deps: A10, A11, L00, M01-M10.

**WP-L02..L05 Icon batches** (BIZ-11)
- 4-5 icons each, grouped by city so one agent learns one style:
  - Paris: Eiffel, Arc, Sacre-Coeur;
  - London: Elizabeth Tower, Tower Bridge, St Paul's, the White Tower;
  - United States: Liberty, Capitol, Independence Hall, Lincoln Memorial, Washington Monument;
  - Europe and Asia: Brandenburg Gate, Cologne, Alpine castle, St Basil's, Himeji, Taj Mahal, Hagia Sophia,
    Temple of Heaven, Kinderdijk.
- Each batch adds the grammars it needs (lattice girders for Eiffel; onion domes for St Basil's) in a separate
  grammar file.
- Deps: L01.

**WP-P01 Brick Garage** (BIZ-17)
- Goal: P3.
- Files: vehicle grammar `web/src/brickgen/grammar/vehicle.ts`, designs.
- First failing test: `:: a generated car has 4 wheels on axles, a SEAT meta and passes driverSeesOut`.
- Deps: F02, M*, the in-flight seat and vehicle branches merged.

**WP-P02 Pinball Arcade** (BIZ-18)
- Goal: P4, with the official-part check first.
- First failing test: `:: every part detectPinballTable keys on is an official LDraw part`.
- Deps: M*, F02.

**WP-P03 Doors and Furniture** (BIZ-19)
- Goal: P5, with a kit placement menu.
- First failing test: `:: a kit pack places one chosen piece and Undo removes only it`.
- Deps: M07, F02.

**WP-P04 Funfair rides** (BIZ-20)
- Goal: P6, the multi-seat orbit ride and the drop tower.
- Files: `web/src/engine/bedrock-rides.ts`, `test/bedrock-rides-orbit.test.ts`.
- First failing test: `:: a 12-seat orbit ride carries 12 riders on one path with equal spacing`.
- Deps: M*, F02.

**WP-S01 Store art pipeline** (BIZ-28)
- Goal: section 7.10 offline art plus the shot list.
- Files: `scripts/_store_art.mjs`, `test/store-art-size.test.ts`.
- First failing test: `:: every generated image is under 2000 px a side and 4 MB`.
- Deps: A10.

**WP-S02 Submission bundle** (BIZ-28)
- Goal: section 7.11.
- Files: `scripts/_submission_bundle.ts`, `test/submission-bundle.test.ts`.
- First failing test: `:: the bundle refuses to assemble without a 0-error MCTools report`.
- Deps: M05, M06, T01, S01.

---

## 11. Parallelisation order and the file-collision map

### 11.1 Waves
| Wave | Runs at once | Why they cannot collide |
|---|---|---|
| 1 | A00, A01, A02, M01, M05, M06, M10, M15, C01, F01 | each owns new files; M10 is the only edit to `ldraw-geometry.ts`; A00 is the only edit to `REQUIREMENTS.md`/`TASKS-BUSINESS.md` |
| 2 | A03, A04, A05, M02, M03, M04, M08, M14, C03 | A03 owns `ldraw-directives.ts` + `ldraw-parser.ts`; M02 owns `marketplace/rewrite.ts`; M03 owns `collider-form.ts` and the `playable-addon.ts` texture block; M04 owns `marketplace/manifest.ts`; M08 owns `pipeline-version.ts`; M14 owns `web/src/sim/` |
| 3 | A06, A09, M07, M09, C02, T01 | A06 `bricker/`; A09 `features/`; M07 `bedrock-placement-pack.ts`; C02 `schem-pipeline.ts` + coaster route assembly |
| 4 | A07, A08, F02, C04, T02, L00 | A07 and A08 write different grammar files; F02 owns the figure files; C04 owns `bedrock-coaster.ts` physics; T02 owns `sim/adapters/.../marketplace.ts` |
| 5 | A10, F03, C05, C06 | |
| 6 | A11, S01, L01 (pilot) | the pilot needs everything above |
| 7 | L02-L05, C07, P02, P03, P04, S02 | designs live in the designs repo; P04 owns `bedrock-rides.ts` |
| 8 | P01 garage | after the in-flight seat and vehicle branches merge |

### 11.2 Serial chains (never two at once)
- `web/src/engine/playable-addon.ts`: M03 -> M04 (if it needs a hook) -> F02 (figure caps) -> C02 (if it needs a
  hook). Prefer profile hooks in `marketplace/*` so these stay small.
- `web/src/engine/bedrock-coaster.ts`: C02 -> C04 -> C05.
- `web/src/sim/**`: M14 -> T02 -> F03 -> C04's `coaster.ts` adapter.
- `web/src/engine/minifig-rig.ts`: F02 -> F03.
- `web/src/engine/ldraw-directives.ts` and `ldraw-parser.ts`: A03 only (other packages request metas through it).
- `REQUIREMENTS.md` and `TASKS-BUSINESS.md`: one writer per wave; each package appends its own subsection
  (TASKS-BEDROCK-ADDON's rule).
- Do not touch `cockpit-seat.ts` or `scene-vehicles.ts` until `gen-side-1109`, `gen-view-1106` and
  `gen-veh-1106` merge.

### 11.3 Merging
- Each package merges into `main` with a merge commit after its gate passes in its worktree.
- The orchestrator runs `bun run test`, both typechecks and `bun scripts/sim.ts --scenario=regressions` on `main`
  after each wave.
- No pack is generated from a dirty tree (CLAUDE.md): commit, restart any dev server (the stamp is computed at
  start), then export.

---

## 12. REQUIREMENTS.md rows (section 17; A takes BIZ-05..BIZ-29, B and D take BIZ-30 upward)

All start `OPEN`, guards `none`, device `—`. Add them in WP-A00, quoting the user's 2026-11-09 words.

| id | requirement | implementation (planned) | gap |
|---|---|---|---|
| `BIZ-05` | Part mapper: real-building inputs (footprint, licensed photos, optional 3D) -> ORIGINAL LDraw model, modular stages | `web/src/brickgen/*`, `scripts/brickgen.ts` (WP-A01..A10) | not started |
| `BIZ-06` | Input licence gate and per-design provenance log; clean room against LEGO's landmark sets; no Google Maps content in shipped designs | `site/licence-gate.ts`, `provenance.ts`, `_cleanroom_*` (WP-A00, A05) | not started |
| `BIZ-07` | Only official CC BY LDraw parts; no Studio-only meshes, aliases, logo studs or LEGO face art in a shipped pack | `vocab/`, `ldraw-geometry.ts` official mode (WP-A01, M10) | B10, B12 |
| `BIZ-08` | Generated models are connected and stable (stud-lattice load paths, cantilevers, overlaps) | `brickgen/verify/*` (WP-A04) | no lattice verifier |
| `BIZ-09` | Deterministic LDraw writer, authoring metas, and polish ops that survive regeneration | `emit/ldraw-writer.ts`, `polish/*` (WP-A03, A11) | no writer |
| `BIZ-10` | Notre-Dame icon, our own design from the real building, polished, provenance-logged (first icon) | `$CRAFTMATIC_DESIGNS/landmarks/notre-dame-paris` (WP-L01) | not started |
| `BIZ-11` | At least 19 more landmark icons, generated then manually polished | WP-L02..L05 | not started |
| `BIZ-12` | Landmark rights screen: lighting designs (Eiffel night lighting), name trade marks, state heritage-image laws; hold and exclusion lists | section 4.1-4.2, WP-L00 | lawyer review |
| `BIZ-13` | Epic original roller coaster at least 3x 10303 Loop (track, height, footprint, inversions), descent starting in the clouds | `coaster-design.ts`, `coaster-track-mesh.ts` (WP-C01..C03, C07) | no generated track |
| `BIZ-14` | Coaster launches, cable lift, block brakes, hyper drop with a measured speed cap | `coaster-zones.ts`, `bedrock-coaster.ts` (WP-C04) | none of these exist |
| `BIZ-15` | Dark indoor segment inside an artificial mountain (darkness, lighting cues, genre-only mine and space theme) | WP-C05, C06 | no dark zones |
| `BIZ-16` | Neon racing styling (emissive materials, original art) | WP-C05, C06 | not started |
| `BIZ-17` | Vehicle garage pack, our own vehicles, drive and fly with cameras | WP-P01 | waits on the in-flight seat and vehicle branches |
| `BIZ-18` | Pinball arcade pack, our own tables | WP-P02 | official-part check pending |
| `BIZ-19` | Doors and furniture pack, our own pieces | WP-P03 | not started |
| `BIZ-20` | Funfair / theme-park ride pack (multi-seat orbit, drop tower, swings, bumper cars) | WP-P04 | no multi-seat orbit ride |
| `BIZ-21` | Our own figure, not a minifigure (distinctness measured), compatible with walk, seat and ride code | `figure-brickling.ts` (WP-F01..F03) | only LEGO figure systems |
| `BIZ-22` | Per-pack `<creator>_<pack>:` namespace, `<creator>_<pack>` ids and `<type>/<creator>/<pack>/` folders, frozen identity | `marketplace/{product,rewrite}.ts` (WP-M01, M02) | B2, B3, B4, B13 |
| `BIZ-23` | No vanilla texture overrides (own brick blocks); RP `pack_scope: world`; RP<->BP dependencies; latest stable modules | WP-M03, M04 | B1, B5, B6 |
| `BIZ-24` | Microsoft add-on validator at 0 Errors plus the offline `--marketplace` check; stable-only Script API | WP-M05, M15 | not run yet |
| `BIZ-25` | Low-end device budgets: size, files, permutations, textures, entities, cuboids, script time | WP-M06 | permutations 11,008 today |
| `BIZ-26` | Placement into air only, with a prompt, an Undo, no leftover ticking areas, guide book, chat of 28 characters or fewer | WP-M04, M07, T02 | B7, B8 |
| `BIZ-27` | Player-facing names without LEGO words, set numbers or dev stamps; LDraw and OSM attribution shipped | WP-M08, M09 | B9, B11 |
| `BIZ-28` | Store art and screenshots; submission bundle prepared, NOT submitted | WP-S01, S02 | in-game capture needs the user's approval |
| `BIZ-29` | Scenario A test strategy: vendored LDraw vocabulary, golden models, sim `marketplace` scenario, BDS content-log gate | WP-A01, M14, T01, T02 | not started |

---

## 13. Tracker structure (`TASKS-BUSINESS.md` section, added by WP-A00)

```markdown
## Scenario A: original packs (BIZ-05..BIZ-29) — plan docs/plans/business-A-original-packs.md

### Start here
- STATE <date>: wave <n> running. Worktrees: .worktrees/biz-a-<id> (branch biz-a/<id>), one line each: owner,
  status, last commit, gate result.
- Designs repo: C:/git/craftmatic-designs (CRAFTMATIC_DESIGNS); not pushed (Q3).
- Exact commands:
  - bun run test; bun run typecheck; bun run typecheck:web
  - bun scripts/brickgen.ts <site.json> --design=<design.json> --out=<dir>
  - bun scripts/_marketplace_pack.ts <dev.mcaddon> --product=products/<pack>/product.json --out=<dir>
  - python scripts/_mcaddon_check.py --marketplace <pack>; bun scripts/_mctools_validate.ts <pack>
  - bun scripts/_marketplace_budget.ts <pack> --tier=standard
  - bun scripts/sim.ts <pack> --scenario=marketplace; --scenario=regressions --new=<dir>
  - bun scripts/_bds_smoke.ts <pack>
- Evidence paths: output/biz-a/<wp>/ (gitignored), bundles in output/marketplace-bundles/.

### Open questions (Q1..Q11) — asked <date>, answers here when given

### Waves (section 11) — one line per WP: id, BIZ id, status, branch, blocking dependency

### Measurements a decision still needs
- block permutations after M03; tier numbers after M06; coaster speed cap after C04; rail entities vs blocks after
  C03; fidelity thresholds after L01.

### Icons — one line per landmark: slug, status (sources/generated/polished/cleared/packed), fidelity, verify, rights note

### Prepared, awaiting approval (never done without the user)
- publisher applications (Waypoint, Pathway, Blocklab); store submission; CurseForge/itch pages; device rounds;
  in-game capture session; private GitHub repo for designs; any account sign-up.
```

Prune completed lines as packages merge; history lives in `git log` (the global tracker rule).
