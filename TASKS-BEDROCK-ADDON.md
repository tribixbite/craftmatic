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
| `web/src/engine/ldraw-parser.ts` | `LDrawSection`, `LDrawDocument`, `parseLDrawDocument()`, `embeddedPartTexts()`; `parseLDraw` delegates | [x] |
| `web/src/engine/ldraw-geometry.ts` | export `getDatText(id)` (seeded cache + library fetch) | [x] |
| `web/src/engine/ldraw-part-geometry.ts` | NEW — coloured local mesh resolver, stud provenance, provider | [x] |
| `web/src/engine/ldraw-part-prototype.ts` | NEW — quality profiles, microcell raster, greedy cuboids, cache, budgets | [x] |
| `web/src/engine/ldraw-entity-materials.ts` + `ldraw-color-classes.json` (`scripts/gen-ldraw-color-classes.mjs`) | NEW — `resolveLdrawEntityMaterial()`, classes from LDConfig, PBR constants | [x] |
| `web/src/engine/ldraw-entity-atlas.ts` | NEW — colour / normal / MER atlas + `texture_set.json` | [x] |
| `web/src/engine/lego-resource-pack.ts` | `encodePngRgba` / `encodePngFilteredRows` shared encoder (no behaviour change) | [x] |
| `web/src/engine/ldraw-entity-compiler.ts` | async rewrite of the internals; new frame; diagnostics; `transform` | [x] |
| `web/src/engine/playable-addon.ts` | await the compiler, write PBR assets, `capabilities`, diagnostics file, materials | [x] |
| `web/src/engine/schem-pipeline.ts` | thread `entityQuality` (provider defaults to the seeded cache) | [x] |
| `web/src/engine/schem-settings.ts`, `ui/schem-settings-panel.ts`, `ui/schem-export.ts` | "Vehicle detail" setting (balanced/high/ultra) | [x] |
| `test/ldraw-parser-document.test.ts` | sections preserved, colour-16, transform parity with `parseLDraw` | [x] |
| `test/ldraw-part-geometry.test.ts` | nested refs, quads, exact print id, cycle guard, missing part, embedded beats library | [x] |
| `test/ldraw-part-prototype.test.ts` | box = 1 cuboid; slope/cylinder/wedge ≠ AABB; bounds exact; budget; determinism | [x] |
| `test/ldraw-entity-materials.test.ts` | exact RGB, alpha classes, direct colours | [x] |
| `test/ldraw-entity-atlas.test.ts` | dimensions, palette scanline, MER/normal presence, texture_set JSON | [x] |
| `test/ldraw-entity-compiler.test.ts` | rewritten for the async API, frame handedness, stud exposure, diagnostics | [x] |
| `test/playable-addon.test.ts` | PBR files + capabilities, `entity` material, diagnostics entry | [x] |
| `test/playable-golden-models.test.ts` | 75892-1 / 10300 / 7140-1 through the real pipeline (skips without corpus) | [x] |
| `scripts/_playable_ref.ts` | CLI: model → `.mcaddon` via `runSchemPipeline`, prints diagnostics + sha256 | [x] |
| `scripts/_entity_silhouette.ts` | six-view silhouette IoU: source triangles vs emitted cuboids, PNG diffs | [x] |

## 4. Phases and tasks

### Phase A — stop losing source geometry
- [x] A1 `parseLDrawDocument()` + `embeddedPartTexts()`; `parseLDraw()` = `.bricks`. Tests.
- [x] A2 `getDatText()` export in `ldraw-geometry.ts` (no other change there).
- [x] A3 `ldraw-part-geometry.ts`: type 1/3/4 lines, colour 16 inheritance, direct colours,
      recursion/cycle guard identical to the voxelizer's, stud provenance (`studs[]`),
      resolution order embedded → library → print-base fallback (`3010p01`→`3010`,
      diagnostic) → `null`. TEXMAP `0 !:` fallback lines count as geometry.
- Exit met: every golden-model part id yields a mesh or a named unresolved entry (§6).

### Phase B — part prototypes
- [x] B1 `LegoEntityQuality` + `LEGO_ENTITY_QUALITY`. Budgets re-tuned from the device
      run: balanced 6,144 / 128 / 4 LDU, high 12,288 / 256 / 2, ultra 24,576 / 512 / 1 (§6).
- [x] B2 microcell rasterizer on an AABB-aligned lattice at half the microcell: exact
      triangle/cell SAT surface pass (colour-tagged), FIVE-side flood fill (LDraw parts
      are open at the bottom, so a brick's cavity fills solid while a pin hole or a
      wheel bore stays open), six-side for translucent parts, 2×2×2 majority downsample.
      The spec's "3-axis ray parity" was replaced: LDraw models the inner ceiling of a
      brick, so parity leaves every brick hollow (5+ cuboids each) — measured.
- [x] B3 greedy 3D merge per colour label → `PartCuboid[]` clamped to the true AABB;
      `source` tag; `metrics` = {solidCells, aabbCells, fill, coarsened}.
- [x] B4 budgets: over `maxPartCubes` → microcell ×2 (≤3) → AABB fallback with reason;
      cache keyed by `part|resolvedAs|microcell|maxPartCubes|hollow`.
- [x] B5 compiler instances prototypes (frame recipe §2.2), per-brick rotated bones for
      non-axis-aligned placements, model-level exposed studs (spatial hash of world AABBs),
      whole-model budget by global coarsening (recorded as `modelCoarsened`).
- Exit met: slope, wheel, wedge and canopy are decompositions in the emitted `.geo.json`
      (unit tests) and on the device (§6 screenshots).

### Phase C — correct materials
- [x] C1 `resolveLdrawEntityMaterial()` — RGB from `LDRAW_COLOR_RGB` (viewer parity), else
      the generated LDConfig table; alpha/luminance/finish from LDConfig; direct colours exact.
- [x] C2 compiler palettes are `LdrawEntityMaterial[]`; translucency = `alpha < 1`;
      `CANOPY_PARTS`/`SEAT_PARTS` only steer cockpit detection.
- [x] C3 colour atlas from materials (row 0 palette scanline; tiles: plain face, stud top).
- [x] C4 opaque `entity`, translucent `entity_alphablend`; block mapping untouched.
- Exit met: `test/playable-addon.test.ts` reads LDraw red / trans-clear alpha 128 out of the pack PNGs.

### Phase D — PBR (Vibrant Visuals)
- [x] D1 normal map (stud dome on the stud-top tile), MER map from `MATERIAL_PBR`,
      `<name>.texture_set.json` beside the colour PNG, for body and canopy atlases.
- [x] D2 RP manifest `capabilities: ["pbr"]` whenever PBR assets are emitted; `pbr: false`
      keeps the classic pack byte-for-byte free of texture sets.
- [ ] D3 Verify the MER/normal response under Vibrant Visuals on a device that offers it
      (the Pixel test below ran the classic renderer; the pack loaded with the
      capability declared and no visible fault).

### Phase E — prints, diagnostics, gates
- [x] E1 exact printed-part resolution; base-mould fallback recorded (`printFallbackParts`).
- [-] E1b per-face decal baking — not done: a printed face is emitted as its own
      cuboids in the print's colour (coarse but honest); baking a decal into UV space is a
      separate texture-atlas feature.
- [x] E2 `LegoGeometryDiagnostics` on `CompiledLdrawGeometry`, warnings into
      `PlayableAddonResult.warnings`, `Craftmatic_<id>_BP/craftmatic-diagnostics.json`.
- [x] E3 `scripts/_entity_silhouette.ts` six-view IoU + PNG diffs; numbers in §6.
- [x] E4 golden-model tests (corpus-gated).
- [x] E5 UI setting "Vehicle detail" (balanced/high/ultra) threaded to the worker.
- [x] E6 Alias ladder (`partAliasCandidates`, now in `engine/ldraw-part-aliases.ts`) for
      the CLI/offline resolver, plus a prod-mirror fallback after a local-library miss;
      substitutions are reported (`substitutedParts`), never silent. 10300: 27 AABB
      placements → 0; 76240: 133 → 2 (`67687` is in no library).

### Phase F — in-game verification (Pixel 8 Pro, retail Bedrock 1.26.45)
- [x] F1 calibration add-on → handedness proof (§6).
- [x] F2 three golden add-ons imported, activated, summoned and photographed; Mount
      prompt appears on all three; riding not exercised this session.
- [x] F5 (2026-09-15) DeLorean, Senna, 76240 Tumbler and 76286 Milano ridden on the
      Pixel: chase camera on mount / cleared on dismount, steering under it, HUD
      speed, translucent windshield, studs, free-camera views from above (§6).
- [-] F3 Vibrant Visuals comparison — the phone ran the classic renderer; see D3.
- [x] F4 phone left in the world the user had open (the QA "My World"), with the four
      packs activated and the summoned entities in place.

### Follow-ups worth doing
- 76240 and 76286 clear the 0.95 silhouette gate on NO profile (0.85 / 0.88 at `high`,
  §6): both are 2,000+-part posed models that the budget coarsens to 16 / 8 LDU. The
  `heaviestParts` diagnostic names where the cuboids go (76240: `70695` ×184 = 920);
  a per-part prototype simplification for such repeated small parts, or an `ultra`
  default for models over ~1,500 parts, is the next lever.
- The 76240 index source (`MecabricksLDR/76240.ldr`) carries 135 unknown parts and a
  19.4° display pose; the local `IO/76240-1.io` is the better source and is what the
  LEGO tab loads when the user uploads it.
- Move the app's colour table to the generated LDConfig values in one deliberate step
  (viewer + entity together), see `ldraw-entity-materials.ts` header.
- A real Vibrant Visuals device check (D3).

## 5. Hard rules carried from the spec

1. No whole-model voxelization on the entity path; no `poly_mesh`.
2. `getPartDims()` only as an explicit, diagnosed AABB fallback.
3. No Minecraft block colours on the entity path.
4. Nothing silent: every part/print/transparency degradation lands in diagnostics.
5. Don't touch the world-block pipeline, `discoverPlayableComponents`, rideability,
   DeLorean behaviour or the BlockGrid fallback to solve an entity-rendering problem.
6. Compile per unique part once; instance many; preserve exact source transforms.

## 6. Measurements and decisions log

### 2026-09-14 — pipeline landed (commits `e405be4`, `1fbeebc`)

**Golden models through the real pipeline** (`bun scripts/_playable_ref.ts <model> --label=…`,
local library = Studio's LDraw release 207, balanced profile):

| Model | Bricks | Unique parts | Cuboids (studs) | Rotated bones | Coarsened → cell | Fallbacks |
|---|---|---|---|---|---|---|
| 75892 McLaren Senna (OMR) | 227 | 90 | 2,309 (33) | 7 | 0 → 4 LDU | 0 |
| 7140 X-wing (OMR) | 340 | 104 | 1,748 (194) | 75 | 1 → 8 LDU | 0 |
| 10300 Time Machine (io_model2 v2) | 1,906 | 252 | 2,985 (293) | 551 | 2 → 16 LDU | 8 parts / 27 placements |

The 10300 fallbacks are moulds newer than the local release-207 snapshot
(`6538c`, `4085d`, `6628a`, `x346`, `4589b`, `54930c02`) plus two Studio custom
`m…` parts the flattened `.ldr` cannot carry; in the browser the seeded viewer
cache resolves the first group. Two prints fell back to their base mould
(`2958pb041`, `3069bpb0855`). Every one is named in
`craftmatic-diagnostics.json` and in the export warning.

**Six-view silhouette IoU** (`bun scripts/_entity_silhouette.ts <model> --quality=…`,
512 px, source triangles incl. studs vs emitted cuboids with bone rotations applied):

| Model | balanced (4,096) | high (8,192) | ultra (16,384) |
|---|---|---|---|
| 75892 | **0.971** (2,309 cubes, 4 LDU) | 0.985 (5,907, 2 LDU) | 0.987 (12,924, 1 LDU) |
| 7140 | 0.942 (1,748, 8 LDU; front/back 0.92) | **0.967** (4,681, 4 LDU) | 0.981 (14,196, 2 LDU) |
| 10300 | 0.954 (2,985, 16 LDU; left/right 0.942) | **0.962** (5,401, 8 LDU) | 0.969 (14,434, 4 LDU) |
| calibration (6 parts) | 0.996 | — | — |

Verdict: with the spec's 4,096 balanced budget the ≥ 0.95 gate held only for the
227-part Senna — the cube budget, not the microcell, was what coarsened the two
bigger models. The old greedy path shipped 6,823 cuboids for the Batmobile and it
rendered on the Pixel, and the three new entities rendered without visible
stutter, so the profiles were **re-tuned to balanced 6,144 / high 12,288 / ultra
24,576** (`LEGO_ENTITY_QUALITY`). Re-measured at the new balanced budget:

| Model | cubes | cell | mean IoU | lowest view |
|---|---|---|---|---|
| 75892 | 2,309 | 4 LDU | 0.971 | 0.963 (iso) |
| 7140 | 4,339 | 4 LDU (no coarsening) | 0.964 | 0.952 (front/back) |
| 10300 | 5,401 | 8 LDU (one coarsening) | 0.962 | 0.953 (left/right) |

All three now clear the gate at the default profile. Frame timing could not be
measured: `dumpsys gfxinfo` sees only the UI surface (260 frames in two
minutes), not Bedrock's own renderer.

**In-game (Pixel 8 Pro, Bedrock 1.26.45, QA world `smUmxh2eJjw=`, classic renderer)** —
evidence under `output/bedrock-entity-qa/` (downscaled captures `p27`…`p38`):
- Calibration model (`craftmatic:calibration_car`, summoned at −134 80 193, fell to
  y=64): light-grey 8×8 plate with visible studs, white 2×4 with eight studs, blue
  1×1 at the far end (LDraw +Z → nose, entity faces south), red 1×1 with the yellow
  1×1 stacked on it on the entity's RIGHT (LDraw +X), the red stud hidden under the
  yellow, the 30°-yawed green slope as a rotated stair in the near-left corner.
  **Handedness, rotated bone, stud exposure and colours all confirmed.**
- 75892 Senna (2,309 cuboids): low body, rear wing, round wheels with rims, orange
  trim, dark windscreen; recognisable from behind and the side.
- 7140 X-wing (1,748 cuboids at 8 LDU — exported before the re-tune): S-foils with
  red stripes, engine cans, R2 unit, and the orange pilot minifig visible THROUGH
  the trans-black canopy (translucent mesh on `entity_alphablend`, opaque on `entity`).
- 10300 Time Machine (2,985 cuboids at 16 LDU — before the re-tune): body, gull-wing
  door line, wheels, tail lights; still a DeLorean at the coarsest grain.
- All three show the touch "Mount" prompt (rideable + collision box intact); riding
  was not exercised this session.
- **Content Log clean**: Settings → Creator has "Show content log UI on error during
  load" enabled and nothing appeared when the world loaded with all four packs; the
  "Content log history → View" button is disabled, i.e. the history is empty at GUI
  log level *Warn*. (The content-log FILE is off on this device, so there is no text
  log to quote — enable "Enable content log file" if a pack ever misbehaves.)
- Pack import needed no manual pack activation UI: `content://` intent + list edit
  with the app stopped.

**Vitest**: 7 new files, all green; suite 96 files / 1,528 tests (the two
`import-nlcd` failures are the live NLCD API, unrelated). Golden-model test
`test/playable-golden-models.test.ts` passes in 4.8 s against the corpus.

**Bedrock handling facts learned on the Pixel 8 Pro (1.26.45)**:
- A `file://` VIEW intent is delivered but imports nothing under scoped storage;
  `content://com.android.externalstorage.documents/document/primary%3ADownload%2F<name>.mcaddon`
  with `--grant-read-uri-permission` imports ("Import started…", pack folders
  `behavior_packs/<first 10 chars of name>`).
- `world_behavior_packs.json` / `world_resource_packs.json` edits only stick when
  the game is fully stopped (`am force-stop`) first — with the app merely at the
  main menu it rewrites both files from memory on the next world open.
- `input text` into Chat and Commands: sometimes the field keeps a `/` after a
  command, sometimes `Enter` closes the chat screen; re-open chat, focus, Ctrl+A,
  Del, then type the full `/command` — that sequence has been reliable.

### 2026-09-15 — Pixel report fixes (commits `cb6ab9b`, `adf2534`, `600fa29`)

Reported from the phone: mounted DeLorean shows nothing and cannot steer; the Senna
seat lands on a black-and-white structure outside the car; studs are square; models
have floating / missing pieces; windshield status unknown. Each was measured first.

| Report | Cause | Fix | Verified |
|---|---|---|---|
| Blind, unsteerable DeLorean | first-person rider sits inside opaque cabin cuboids | per-vehicle `follow_orbit` preset (`cameras/presets/<cid>_chase.json`) applied by `scripts/vehicle-camera.js` on mount, cleared on dismount; default control scheme keeps look-to-steer | `sv1.jpg`: Senna 126 blocks in 5.5 s, HUD 56.7 mph; `tmv1.jpg` DeLorean HUD 8.8 mph |
| Senna seat outside the car | 75892 OMR root places `Car.ldr` beside `Wind Tunnel.ldr`/`Pilot.ldr`; seat = mean of ALL bricks | `dominantNamedGroup`: a vehicle-named submodel holding ≥ ½ the placements is the vehicle (190 of 227); flattened sources drop clusters that do not touch the vehicle on REAL part bounds (`detachedClusters`) | seat source `seat-parts` at [−0.16, 6.56, 6.37] units; `senna-thirdperson.jpg` |
| Square studs | one axis-aligned cuboid per stud | fan of 4 rotated cuboids per exposed stud, corners on the stud circle (3 → 1 under budget) | `cal-round*.jpg`, `senna-round.jpg` |
| Missing pieces | CLI/Worker resolver had no alias ladder and no mirror fallback (local library is release 207) | shared `partAliasCandidates` + `craftmatic.click/ldraw-parts` fallback; substitutions in diagnostics | 10300 27 → 0 box placements, 76240 133 → 2 |
| Floating pieces | Mecabricks display pose (76240 19.4°, 76286 7.2°) put every brick in its own bone; driver/stand beside vehicle | `levelModel` (histogram pose removal, 66 → 1,171 aligned on 76240) + float-noise snap; detached-cluster drop | 76240 rotated bones 2,063 → 1,024 |
| Windshield | — (material alpha path was already correct) | none | `tm-windshield2.jpg`: translucent sheet, interior visible |
| HUD 0.0 mph while driving | rider-driven vehicle is client-authoritative, `getVelocity()` ≈ 0 | `riddenVelocity`: max(reported, position delta) | `sv1.jpg` |

**Silhouette IoU** (`_entity_silhouette.ts`, six views, level applied): 75892 0.982 (balanced,
was 0.971) · 10300 0.951 (balanced) · 76240 **0.855** (high, 9,634 cubes at 16 LDU) ·
76286 **0.876** (high, 8,539 at 8 LDU). The two posed 2,000-part models do not clear the
gate; they render and drive (`free-tumbler-*.jpg`, `free-milano-80.jpg`, `milano-flying.jpg`).

**Not a bug (measured):** "entities vanish when viewed from above" was the test method —
after an elevated `/tp` the player falls back to the ground before the capture. The free
camera preset shows all four vehicles from above (`free-*.jpg`). `follow_orbit` has no
block collision: a 10-block boom behind a car at a hillside put the camera inside the hill,
so the boom is `longest + 2.5` blocks with the pivot at roof height.

**Tests**: 1,546 passing / 26 skipped; the two `import-nlcd` failures are the live API.
New: `test/ldraw-geometry-alias.test.ts`; compiler tests for facets, snapping, levelling,
detached clusters, hidden-cuboid culling; component tests for the named-submodel rule.
Evidence: `output/bedrock-entity-qa/captures-2026-09-15/`.
