# LEGO model → Bedrock add-on: entity geometry pipeline (architecture + tracker)

Working tracker for finishing the playable `.mcaddon` export so the in-game
entity keeps the source model's **part geometry, exact LDraw colours and
material classes** instead of one bounding box per part. Source spec: the user's
`mcbed.md` review of 2026-09-14 (mirrored under `docs/bedrock-entity-spec-2026-09-14.md`).
Everything measured here is recorded with the command that produced it.

Status legend: `[ ]` open · `[x]` done · `[-]` deliberately not done (reason given).

## 1. Where the pipeline stands (2026-09-14, after merging `main` + `ecd2491`)

The Bedrock work lived on `main` and on `origin/feat/live-bedrock-delivery`
(Gemini 3.8 Flash, `ecd2491`, the only unmerged commit anywhere); both are now
merged into `feat/lego-set-tab` (`f3f60c8`). Baseline after the merge: root and
`web/` typecheck clean, `bun run test` 92 files / 1,484 tests green.

Flow today:

```
lego.ts ─► ui/schem-export.ts (format 'mcaddon')
        ─► Web Worker: engine/schem-pipeline.ts runSchemPipeline()
             ├─ voxelize scenery grid (unchanged, BlockGrid path)
             ├─ discoverPlayableComponents(bricks, label, mode)   (playable-components.ts)
             └─ buildPlayableAddon(grid, {components[…bricks]})   (playable-addon.ts)
                  └─ compileLdrawEntityGeometry(cid, kind, bricks) (ldraw-entity-compiler.ts)
                       └─ getPartDims(part) → ONE cube per part      ← the defect
                       └─ ldrawColorToBlock(color) → blockRgb()      ← quantised colour
```

What is right and must be kept: component discovery + provenance, the vehicle
behaviour entity (rideable, car/plane/boat, DeLorean time circuit, driver
script), display-stand filtering, cockpit/seat detection, collision-box
clamping, opaque/canopy split into separate render controllers, ≤1024 cubes per
mesh, the `meshIds`/`canopyMeshId` contract, the BlockGrid `greedyBoxes()`
fallback for components without bricks, `.mcstructure` scenery tiles, the wand.

What is wrong (measured, not assumed):

1. **Every part is its AABB.** `buildCubesFromBricks` emits
   `getPartDims(part)` as one cuboid: slopes, wheels, wedges, arches, canopies
   are all boxes. `ecd2491` added stud/tile/grille *textures* on top of the
   boxes; it did not change the geometry.
2. **Colours go through Minecraft blocks.** `ldrawColorToBlock` →
   `getBlockColor` quantises every LDraw colour to the nearest concrete/glass;
   `LDRAW_COLOR_RGB` (LDConfig, authoritative) is never used on this path.
3. **Transparency is decided by part ID.** `CANOPY_PARTS` makes any listed
   mould translucent regardless of its colour, and a translucent colour on a
   part not in the list is only caught by a hard-coded id range.
4. **The model is mirrored for one of the two facings.** `transformPoint`
   maps `(x, y, z) → (−cx, floorY−y, −cz)` for Z-longitudinal parts — a point
   inversion, det −1 — and `(cz, cy, −f·cx)` for X-longitudinal, det −f.
   Bedrock's entity frame is itself *left-handed* (Blockbench's codec mirrors
   X and negates the X/Y rotation angles on export, see §3), so one branch
   comes out correct by accident and the other is a mirror image. Nobody
   noticed because vehicles are bilaterally symmetric.
5. **Rotated parts use an Euler decomposition of the LDraw matrix conjugated
   by a Y flip only**, ignoring the axis swap/mirror the position path applies.
6. **Silent degradation.** Missing part dims fall back to 1×1×1 with no
   diagnostic; nothing in the pack says which parts were approximated.

## 2. Target architecture

```
LDraw / MPD / Studio .io text
   │  parseLDrawDocument()            ldraw-parser.ts   (bricks + every 0 FILE section)
   ▼
ParsedBrick[] (placement truth, unchanged)          embedded .dat sections
   │                                                       │
   │   createPartGeometryProvider()  ldraw-part-geometry.ts ◄┘
   │      resolve exact .dat → local-space coloured triangles
   │      (embedded section → seeded/fetched library text → print-base fallback → unresolved)
   ▼
compilePartPrototype(mesh, quality)   ldraw-part-prototype.ts   (cached per part id + quality)
   │   microcell rasterization of the STUD-STRIPPED solid → greedy cuboids per colour
   │   exact box parts come out as ONE cuboid; slopes/wheels/canopies as stair-steps
   │   over budget → coarser microcell → AABB fallback (always a diagnostic)
   ▼
instantiate per brick                ldraw-entity-compiler.ts
   │   world = A·(R_brick·p + t): axis-aligned when A·R·A⁻¹ is a signed permutation,
   │   otherwise ONE bone per brick, pivot = brick origin, Euler ZYX with Bedrock signs
   │   exposed studs added from model-level occupancy (a stud under another part is dropped)
   ▼
opaque cubes ─── translucent cubes (by MATERIAL alpha, never by part id)
   │
   ▼  chunk ≤1024 / bounds / seat / collision (kept)
buildPlayableAddon()                 playable-addon.ts
   │   materials → colour atlas + normal + MER + texture_set.json, manifest capabilities:["pbr"]
   │   opaque mesh material `entity`, translucent `entity_alphablend`
   ▼
.mcaddon  (+ craftmatic-diagnostics.json in the BP)
```

Scale is unchanged: `BEDROCK_UNITS_PER_LDU = 3.2/20` (20 LDU = 1 stud = 3.2
units = 0.2 blocks; 16 units = 1 block).

### 2.1 Reuse decisions (deviations from the spec, with reasons)

- **One `.dat` text cache, not two.** The Worker already receives every part
  text the viewer loaded (`SchemWorkerInput.datTexts` → `seedDatTexts()` in
  `engine/ldraw-geometry.ts`, incl. MPD inlines and `.io` `CustomParts/`). The
  new provider fetches through that module's exported `getDatText()` so the
  entity path is zero-network in the browser exactly like the `.schem` path. The
  triangle resolver is NOT shared: the voxelizer's discards colour and stud
  provenance, both of which the entity path needs.
- **Studs are geometry, not texture, but only where visible.** Stud primitives
  (`stud*.dat`) are stripped from every prototype so a plain brick is one exact
  cuboid; the resolver records each top-stud reference (centre, up, radius), and
  the compiler emits a stud cuboid only where the model-level occupancy above it
  is empty. The old per-part "covered brick" AABB overlap test and the stud/tile/
  grille *texture* channels go away with it (a tile has no stud primitives, so it
  needs no special case).
- **Analytic templates (spec §7B) are deferred.** At the balanced profile's 4 LDU
  microcell a 45° slope is a 6-step stair, a wheel ~10 cuboids; the generic path
  meets the spec's exit condition and every template would be a second code path
  to keep correct. Revisit only if the silhouette gate or the budget says so.
- **Diagnostics JSON is always written** (spec says "optionally in development
  builds"): it is ~1 KB and it is the only way a user report can name the part
  that degraded.
- **Handedness is fixed as part of the rewrite** (§1 item 4), because the new
  instancing has to define the frame precisely anyway.

### 2.2 Frame and rotation recipe (derived from Blockbench's Bedrock codec)

Blockbench (`js/formats/bedrock/bedrock.js`) is the reference implementation
of how the game reads a `.geo.json`. On export it writes
`origin.x = −(from.x + size.x)`, `pivot.x = −pivot.x`, `rotation = (−rx, −ry, rz)`,
and its meshes use three.js Euler order `'ZYX'` (`M = Rz·Ry·Rx`). So:

1. Work in a right-handed **render frame R**: Y up, nose → −Z, model's right → +X.
   LDraw is right-handed with Y down; the map is a proper rotation `A` (det +1):
   nose +Z → `A = diag(1,−1,−1)`; nose −Z → `diag(−1,−1,1)`;
   nose +X → `[[0,0,−1],[0,−1,0],[−1,0,0]]`; nose −X → `[[0,0,1],[0,−1,0],[1,0,0]]`.
2. A local point `p` of a brick `(R, t)` lands at `A(Rp + t) = (A R A⁻¹)(A p) + A t`.
   Cuboids are compiled in part-local LDraw space and mapped by `A` (still
   axis-aligned); the per-brick rotation in R is `M = A R A⁻¹`.
3. If `M` is a signed permutation, transform the boxes directly into the body
   bone. Otherwise emit a bone with `pivot = A t`, Euler `(a, b, c)` from
   `M = Rz(c)·Ry(b)·Rx(a)`.
4. JSON: box `origin = (−max.x, min.y, min.z)`, `size = max − min`;
   bone `pivot = (−p.x, p.y, p.z)`, `rotation = (−a, −b, c)`.

**Calibration model (in-game proof):** an 8×8 plate with one red 1×1 brick at
LDraw +X and one blue at the nose. Rendered on the Pixel, the red brick must sit
on the *right* of the entity when viewed from behind (its +X side) and the blue
brick at the nose. Recorded under §6.

## 3. File map

| File | Role | Status |
|---|---|---|
| `web/src/engine/ldraw-parser.ts` | `LDrawSection`, `LDrawDocument`, `parseLDrawDocument()`, `embeddedPartTexts()`; `parseLDraw` delegates | [ ] |
| `web/src/engine/ldraw-geometry.ts` | export `getDatText(id)` (seeded cache + library fetch) | [ ] |
| `web/src/engine/ldraw-part-geometry.ts` | NEW — coloured local mesh resolver, stud provenance, provider | [ ] |
| `web/src/engine/ldraw-part-prototype.ts` | NEW — quality profiles, microcell raster, greedy cuboids, cache, budgets | [ ] |
| `web/src/engine/ldraw-entity-materials.ts` | NEW — `resolveLdrawEntityMaterial()`, material classes, PBR constants | [ ] |
| `web/src/engine/ldraw-entity-atlas.ts` | NEW — colour / normal / MER atlas + `texture_set.json` | [ ] |
| `web/src/engine/lego-resource-pack.ts` | export the PNG encoder for reuse (no behaviour change) | [ ] |
| `web/src/engine/ldraw-entity-compiler.ts` | async rewrite of the internals; new frame; diagnostics | [ ] |
| `web/src/engine/playable-addon.ts` | await the compiler, write PBR assets, `capabilities`, diagnostics file, materials | [ ] |
| `web/src/engine/schem-pipeline.ts` | build the provider, thread `entityQuality` | [ ] |
| `web/src/engine/schem-settings.ts`, `ui/schem-settings-panel.ts`, `ui/schem-export.ts` | "Add-on detail" setting (balanced/high/ultra) | [ ] |
| `test/ldraw-parser-document.test.ts` | sections preserved, colour-16, transform parity with `parseLDraw` | [ ] |
| `test/ldraw-part-geometry.test.ts` | nested refs, quads, exact print id, cycle guard, missing part, embedded beats library | [ ] |
| `test/ldraw-part-prototype.test.ts` | box = 1 cuboid; slope/cylinder/wedge ≠ AABB; bounds within 1 LDU; budget; determinism | [ ] |
| `test/ldraw-entity-materials.test.ts` | exact RGB, alpha classes, direct colours | [ ] |
| `test/ldraw-entity-atlas.test.ts` | dimensions, palette scanline, MER/normal presence, texture_set JSON | [ ] |
| `test/ldraw-entity-compiler.test.ts` | rewritten for the async API, frame handedness, stud exposure, diagnostics | [ ] |
| `test/playable-addon.test.ts` | PBR files + capabilities, `entity` material, diagnostics entry | [ ] |
| `test/playable-golden-models.test.ts` | 75892-1 / 10300 / 7140-1 through the real pipeline (skips without corpus) | [ ] |
| `scripts/_playable_ref.ts` | CLI: model → `.mcaddon` via `runSchemPipeline`, prints diagnostics + sha256 | [ ] |
| `scripts/_entity_silhouette.ts` | six-view silhouette IoU: source triangles vs emitted cuboids | [ ] |

## 4. Phases and tasks

### Phase A — stop losing source geometry
- [ ] A1 `parseLDrawDocument()` + `embeddedPartTexts()`; `parseLDraw()` = `.bricks`. Tests.
- [ ] A2 `getDatText()` export in `ldraw-geometry.ts` (no other change there).
- [ ] A3 `ldraw-part-geometry.ts`: type 1/3/4 lines, colour 16 inheritance, direct colours,
      recursion/cycle guard identical to the voxelizer's, stud provenance
      (`source: 'stud'`, `studs[]`), resolution order embedded → library → print-base
      fallback (`3010p01`→`3010`, diagnostic) → `null`. Tests with synthetic `.dat` text.
- Exit: every part id of the golden models yields a mesh or an explicit unresolved entry.

### Phase B — part prototypes
- [ ] B1 `LegoEntityQuality` + `LEGO_ENTITY_QUALITY` (balanced 4096/128/4 LDU, high 8192/256/2, ultra 16384/512/1, chunk 1024).
- [ ] B2 microcell rasterizer on an AABB-aligned lattice: surface pass (triangle
      AABB cells, colour-tagged) + interior fill by 3-axis ray parity majority.
- [ ] B3 greedy 3D merge per colour label → `PartCuboid[]` in LDU; `source` tag;
      `error` = {cells, aabbCells, fill}.
- [ ] B4 budgets: over `maxPartCubes` → microcell ×2 (≤3 times) → AABB fallback with reason.
      Prototype cache keyed by `part|microcell|maxPartCubes`.
- [ ] B5 replace `getPartDims` cube generation in the compiler with instantiated prototypes
      (frame recipe §2.2), per-brick rotated bones, model-level exposed studs.
- Exit: `3040b`, a wheel, a wedge and `84954` are not single AABBs in the emitted `.geo.json`.

### Phase C — correct materials
- [ ] C1 `resolveLdrawEntityMaterial()` — exact `LDRAW_COLOR_RGB`, direct `0x2RRGGBB` /
      `0x3RRGGBB`, classes abs/transparent/rubber/chrome/metallic/pearl/glow, alpha by class.
- [ ] C2 compiler: palettes become `LdrawEntityMaterial[]`; translucency = `alpha < 1`;
      `CANOPY_PARTS`/`SEAT_PARTS` stay for cockpit detection only.
- [ ] C3 colour atlas from materials (row 0 palette scanline kept; tiles: plain face, stud top).
- [ ] C4 `playable-addon.ts`: opaque `entity`, translucent `entity_alphablend`; block mapping untouched for `.schem`/`.mcpack`.
- Exit: every solid entity colour in the pack PNG equals LDConfig RGB.

### Phase D — PBR (Vibrant Visuals)
- [ ] D1 normal map (stud ring on the stud-top tile, 1 px edge bevel), MER map from the
      centralised class table, `<name>.texture_set.json` beside the colour PNG.
- [ ] D2 RP manifest `capabilities: ["pbr"]` when PBR assets are emitted; classic path unchanged.
- Exit: pack loads with and without Vibrant Visuals; the material classes read differently under VV.

### Phase E — prints, diagnostics, gates
- [ ] E1 exact printed-part resolution with `printFallbackParts` diagnostic.
- [ ] E2 `LegoGeometryDiagnostics` on `CompiledLdrawGeometry`, high-value warnings into
      `PlayableAddonResult.warnings`, `Craftmatic_<id>_BP/craftmatic-diagnostics.json`.
- [ ] E3 `scripts/_entity_silhouette.ts` six-view IoU; record numbers per golden model here.
- [ ] E4 golden-model tests (corpus-gated).
- [ ] E5 UI setting "Add-on detail" (balanced/high/ultra) threaded to the worker.

### Phase F — in-game verification (Pixel 8 Pro, retail Bedrock 1.26.45)
- [ ] F1 calibration add-on (§2.2) → handedness proof screenshot.
- [ ] F2 golden model add-on imported, both packs enabled in the QA world, entity summoned,
      Content Log clean, opaque + translucent rendering screenshot, ride/drive check.
- [ ] F3 Vibrant Visuals on/off comparison if the device offers it.
- [ ] F4 leave the phone in the user's original world.

## 5. Hard rules carried from the spec

1. No whole-model voxelization on the entity path; no `poly_mesh`.
2. `getPartDims()` only as an explicit, diagnosed AABB fallback.
3. No Minecraft block colours on the entity path.
4. Nothing silent: every part/print/transparency degradation lands in diagnostics.
5. Don't touch the world-block pipeline, `discoverPlayableComponents`, rideability,
   DeLorean behaviour or the BlockGrid fallback to solve an entity-rendering problem.
6. Compile per unique part once; instance many; preserve exact source transforms.

## 6. Measurements and decisions log

(filled in as work lands — command, numbers, verdict)
