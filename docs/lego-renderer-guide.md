# LEGO rendering and import pipeline

Read before changing LDraw/Studio/LXF import, rendering, colors, mesh metadata, contact checks, or shared download UI. Also consult [model sources](lego-sources-guide.md) and [testing](testing-guide.md).

[Project guide](../CLAUDE.md). Paths in code spans are relative to the repository root unless explicitly qualified.

## InstancedMesh metadata contract (probes depend on it)

Each brick mesh carries `partName`, `brickColor`, `meshKind`
(`main`/`color`/`texture`) and, on exactly ONE mesh per (part, colour) bucket,
`primary: true`. Keep them: without part identity an offline probe can measure
where things are but never what they are, and **`primary` is what makes
placements countable** — a multi-coloured part emits several meshes over the
SAME matrices, so summing every instance over-counts (10182: 2,432 instances
for 2,417 placements). `mirrorOf` marks the floor-reflection clones; skip those.
## Architecture (LEGO/LDraw path)

- `web/src/ui/lego.ts` — LEGO tab UI: search, auto-load chain, upload, 3D-render controls, step/explode sliders, missing-parts surfacing, **export menu** (PNG; GLB/OBJ/STL via `exporter.ts`+`viewer.exportMeshes()`; Minecraft `.schem`/`.litematic`/build guide via the SHARED `ui/schem-export.ts` (S4 — same module the Upload tab uses), with the `⚙ MC settings` popover next to the Download select; parts-list **`.csv` BOM** — part/color/count from `currentBricks`). OBJ/STL bake instances (no instancing in-format) → large on big sets; GLB is the compact 3D option. The slider row label is a **Step⟷Layer toggle**: layer mode slices by quantized plate height (`viewer.setSliderMode('layer')`) and is the DEFAULT for models without STEP meta (most Studio .io exports — 71043 has 5,936 bricks and ONE step); step mode is default when real steps exist.
- `web/src/engine/ldraw-parser.ts` — MPD/LDR → `ParsedBrick[]` (world transform = parentRot×local + parentPos, recursive; det<0 → winding flip). `countSteps()` counts `0 STEP` at ANY depth (sets that nest steps in sub-assemblies, e.g. 31084, depend on this).
- `web/src/viewer/ldraw/` — the direct 3D renderer (modular):
  - `viewer.ts` — Three.js scene/renderer/camera, lighting, env, post FX, camera framing/transitions, explode, picking, export (`exportMeshes()`). **Global instancing**: ONE InstancedMesh per (part,color) across the WHOLE model (not per step) + ONE global edge `LineSegments2`. Instances/segments are sorted step-ascending; the step slider sets `InstancedMesh.count` / `LineSegmentsGeometry.instanceCount` to a binary-search prefix — so a 1226-step set (UCS Falcon) is ~300 meshes / ~950 draw calls, not thousands. Static shadow map (`shadowMap.autoUpdate=false`, refreshed on scene change). **On-demand rendering**: the rAF loop only composites when `needsRender` is set (or a camera anim / autoRotate / Stats overlay is active) — idle scenes cost ~0 GPU. **Any new state mutation that changes the picture MUST call `this.invalidate()`** (or `requestShadowUpdate()`, which also invalidates); camera moves auto-invalidate via the OrbitControls `change` listener. Dev-only `window.__ldrawViewer` hook for `renderer.info` metrics.
  - `parts.ts` — fetch/parse/resolve `.dat` geometry; module-level caches **plus a persistent IndexedDB .dat-text cache** (`craftmatic-ldraw` db; positive results only — repeat sessions load big sets with ~zero part fetches; **prod 10316: cold 19.25 s → warm 2.68 s**); `prewarmCommonParts()`; `partTextureUrls` (TEXMAP); `preloadDatTexts()` (archive-bundled parts, model-specific, cleared by `clearMpdInlines`); `unresolvedDatNames` → `viewer.unresolvedSubparts` (sub-file refs that resolved nowhere = silent holes, surfaced in status). Candidate-path order is name-shape-aware (`looksLikePrimitive` → `p/` first) with a **`p/48/` hi-res alias tail** for bare primitive refs that only exist as 48-variants (e.g. `1-12ring14`). `LDRAW_BASE = /ldraw-parts`.
    - **Cache identity is tied to the DEPLOYED library revision (2026-09-09,
      audit P1 #6).** `IDB_VERSION_KEY` is now only the cache FORMAT version;
      the real identity is `GET /ldraw-parts/_rev` → `{rev}`, written into R2 as
      `ldraw/_rev.json` by `scripts/sync-ldraw-r2.mjs` and served by the worker
      (dev: a constant `dev-local-1` from the vite middleware, because dev's
      library is a frozen snapshot plus per-miss fallbacks and has no honest
      content revision). `rev` is a **content hash** of the mirrored file set,
      NOT the run time — the sync is weekly and usually a no-op, and a timestamp
      would evict every visitor's whole part cache every week for nothing. The
      stamp is published ONLY after a complete, fully successful run. A KNOWN,
      different revision clears the store once; an UNKNOWN one (no endpoint,
      404, offline, malformed, timeout) never invalidates and never records —
      guessing "changed" on a blip would re-download the library on the worst
      connections. (A canary set of part texts was rejected: a canary only
      detects changes to the canary, and the corrected part is exactly the one
      it doesn't contain.) `primePartCache()` runs the probe at app idle;
      `partCacheRevision()` feeds the diagnostics bundle (`library: null` means
      "could not be established", not "unversioned").
    - **Geometry invalidation is TRANSITIVE and RETURNS what it dropped.**
      `resolvePartGeometry` FLATTENS a child's triangles into its parent, so
      dropping only the child leaves every parent holding the old definition —
      a real leak, because a `.io`'s `CustomParts/` ships the exact primitives
      its modified parts need, names shared library parts also reference.
      `geomDependents` records the reverse edges; `invalidatePartGeom` walks
      them. **Any caller that invalidates in order to REBUILD must re-resolve
      the whole returned set** — the viewer's repair pass re-resolved only the
      empty parts it named, left the invalidated ancestors with no geometry at
      all, and that reported 71043's `90398` (25 placements) as missing.
  - `materials.ts` — LDraw color → THREE material (ABS / rubber / metallic / transparent / glow).
  - `types.ts` — Vec3/Triangle/Edge/PartGeom/TexturedTriangle.
- `web/src/engine/ldraw-colors.ts` — LDraw color id → hex (and → Minecraft block for voxelizer).
- Other importers: `bff-loader.ts` (BrickLink inventory → flat layout), `studio-colors.ts`, `ldd-colors.ts`.
  - `io-extractor.ts` (.io) — `extractIoModel()` returns `{text, customParts, sourceEntry, colorSpace, colorSpaceReason}` (see "Color systems" — the colour table MUST follow `colorSpace`, not the file extension): tries `model.ldr` → `model2.ldr` → `modelv2.ldr` (first with type-1 lines wins) AND pulls every **`CustomParts/**/*.dat`** from the archive (Studio's user-modified `m<hash>_<date>_<time>.dat` parts + the exact primitives they need). Without CustomParts, big Technic sets silently lose pieces (42110 was missing 24). They flow `lego.ts currentCustomParts` → `viewer.load(opts.datFiles)` → `preloadDatTexts`.
  - `zip-utils.ts` + `aes-zip.ts` — ZIP reader. Handles plain DEFLATE, legacy **ZipCrypto** (pw `soho0909`), and **WinZip AES-256** (method 99, pw `soho0909`) used by older/early-access .io exports. AES = PBKDF2-HMAC-SHA1 + pure-JS AES in little-endian CTR (Web Crypto's big-endian AES-CTR is incompatible).
  - `lxf-parser.ts` (.lxf/LDD) — **TWO alignment tables, Studio's `ldraw.xml` FIRST (2026-09-17), measured second.** `parseBoneTransform` (LXFML column-major→row-major) and `axisAngleToMatrix` are unchanged.
    - **`F = diag(1,−1,−1)`, NOT `diag(1,−1,1)`.** The old value has **det = −1** — a reflection, so every `.lxf` model was MIRRORED and every chiral part (slopes, wedges, curved shells) landed in a physically wrong slot. LDD (Y-up) and LDraw (Y-down) are BOTH right-handed, so the map between them is a 180° rotation about X. `FRAME_SIGN` is exported and a test pins `det = +1`. Do not "simplify" it back to a Y-flip.
    - **`/ldd-part-map.json` is PRIMARY** (Studio's own `ldraw.xml` columns, 4,467 designs, `scripts/gen-ldd-part-map.py`) and the source of the LDraw FILENAME (60583 → 60583b.dat). **Its row is the transform that carries the LDraw origin onto the LDD origin, so `composeLxfPlacement` applies its INVERSE** in LDD space: `R_world = R_bone·R_alignᵀ`, `t_world = t_bone − R_world·t_align`, then the change of basis. Applied FORWARD (what shipped 2026-09-09..17 as the fallback, and before that as the only path) the same columns score 13 % GEO; the 2026-09-09 conclusion that "the ldraw.xml columns do not reproduce Studio's own placements" was a direction error, not a data limit. Angles are RADIANS.
    - **`/ldd-measured-align.json` is the FALLBACK** (`scripts/gen-ldd-measured-align.py` from clego `dbix_part_align.json`, 1,841 designs): clego's per-design correction voted against authentic Studio placements over 207 DBIX dumps, already in LDU and in the flipped basis (`composeLxfMeasured`, post-flip). Its votes are quantised (1/20 rotations, 1 LDU), so it is less exact than the inverse columns; it serves the designs Studio's table does not name.
    - **THIRD case: the MINI-DOLL slot correction** (`MINIDOLL_SLOT_CORRECTION`, ported from clego `dbix_figure_align.py` / `DBIX_SOLVER.md` §11). A LEGO Friends doll rendered with a broken skeleton — hips at the TORSO'S OWN ORIGIN, head 50 LDU up instead of 33.20, arms at 20 instead of 11.00 — because **neither table has a usable doll row**: the measured table has none and never will (no ground-truth set contains a mini-doll torso, so the learner never saw one), and the five doll moulds Studio's table names (`20380`, `21630`, `21634`, `25727` legs, `88286` hair) are ALL-ZERO rows. LDD gives the torso and the hips the SAME bone (its torso origin is the waist plane). The six rows are measured on both sides — the library's own doll composites vs the modal LDD offset — anchored on the legs, and reproduce the authentic joints (head 33.20, arm 11.00, hips 29.42, hips→legs 47.48). **Order: it applies AFTER both tables and only where the row that named the file corrects NOTHING** (`isIdentityPartAlign` / `isIdentityMeasuredAlign`), so the filename ladder is untouched, a part with a real `ldraw.xml` row cannot move, and an authored doll row would win (counted as `miniDollDeferredToTable`). **Keyed by SLOT, not part id**: `classifyMiniDollPart` (in `minifig-rig.ts`, beside the minifig classifier and sharing its helpers) runs over the LDraw library at build time — `bun scripts/gen-minidoll-slots.ts` → `minidoll-slots-generated.ts`, 725 moulds — because the loader has no descriptions at parse time. `doll_hips_legs`, `doll_torso_arms` (12.8 LDU below the plain torso) and `doll_body` deliberately get NO row: LDD never emits those moulds, so there is no LDD side to measure. A/B: `buildLxfPlacements(..., { miniDoll: false })`, `bun scripts/minidoll-joint-eval.ts --dir <lxf|lxfml dir>`, `python scripts/lxf_gt_eval.py --no-minidoll`.
      **Measured 2026-09-19** over clego's 2,302 LXFML dumps (305 have a doll, 3,410 placements corrected): torso→arm **20.18 → 11.00** (n=1,318), torso→hips **2.31 → 29.42** (n=651), hips→legs **58.59 → 47.48** (n=589) — median absolute error 9.18→0.00, 27.11→0.00, 11.11→0.02 LDU. 21 of 769 changed per-file joint medians got worse and every one is the spare-part confound (a file with fewer legs than hips pairs across figures; the before AND after numbers are both nowhere near the authentic value). torso→head barely measures: those sets' doll HEAD design ids resolve to no LDraw part at all, so only 21 pairs exist and they pair across figures. **Ground truth is unmoved and that is measured, not argued**: `lxf_gt_eval.py --all` gives 65.73 % weighted / 68.66 % median GEO before AND after, byte-identical on all 54 sets (only `seconds` differs), because **none of the 54 contains a doll part** — the same cohort fact that left the learned table empty. On the 1,776 native `.lxf` files only **14** hold any doll mould at all (hair only, 17 placements, no doll body anywhere in the corpus). 13 corpus placements DEFER: design `80911` (`bl_80911.dat`, a doll hair) has a measured row of (1085, 23, -310) LDU — a bad learned vote the loader has no magnitude bound to reject.
    - **LDD writes a mould-VARIANT suffix: `designID="1006030;I"`.** `normalizeDesignId` splits it off. Before that the id went to both tables and to the part library verbatim, so every part of an LXFML dump that carries suffixes (4,111 of 41732's ids) missed everything and the model came up EMPTY (“37 pieces of 13 part types not in library”, 0×0 studs). Native `.lxf` files written by LDD carry no suffix, which is why the whole native corpus never showed it — and why the mini-doll fix could not fire on the only files that HAVE dolls until this was fixed.
    - **Ground-truth harness: `scripts/lxf_gt_eval.py`** — every native `.lxf` in clego whose set has an authentic (non-laundered, `io_authenticity.json` verdict `studio`) `.io`: **91 files**, none of them the DBIX dumps the measured table was learned from. Scored with clego's `dbix_gt_compare` (GEO = world-space geometry within 3 LDU; exact = same pose within 1.5 LDU). `--variants` sweeps the composition conventions (forward/inverse × left/right × LDD/LDraw side × bone transposed) so a hypothesis is measured, never argued; `--dump` writes the placement as `.ldr`. Probe on 10242 Mini Cooper (1,076 parts): shipped-measured 89.3 % GEO / 74.4 % exact · inverse ldraw.xml **93.6 % / 93.2 %** · forward ldraw.xml 13.3 % · no correction 8.6 % · bone transposed 48 %. Whole-cohort figures: `output/lxf-gt/all-*.json` (see TASKS-BEDROCK-ADDON.md for the numbers of the run that shipped this).
    - **Coverage is not the failure mode.** 71043 Hogwarts had **100.00 % coverage** (5,967/5,967 placements, 310/310 design ids, 0 multi-bone parts) while rendering with floating and pierced pieces; it has no authentic `.io` of its own (both `.io` files are laundered repacks). Measured instead with clego's `geograde` on the two placements: forward-applied columns **16 floating / 27 split / 5 sunk / 0.05 % overlap**, inverse **0 / 0 / 0 / 0.00 %** (`output/lxf-gt/71043-probe/geograde.log`). Measure entry CORRECTNESS against ground truth, not entry presence.
    - `loadPartMap`/`loadMeasuredAlign` share a generic loader: schema-validated rows (bad rows dropped AND counted), transient failures retried (404/410 definitive), **a failure is never cached** (the old `{}`-forever bug — audit P1 #3), separate cache slots so one table's failure can't break the other. `parseLxfWithDiagnostics` returns `LxfDiagnostics` (per-table state/source/version/entries/rejected + Studio vs measured vs unaligned placement counts + skips); `describeLxfDiagnostics` turns it into the user-facing line. Tests: `test/lxf-alignment.test.ts` (maths), `test/lxf-part-map.test.ts` (loading + coverage + precedence, incl. the REAL shipped tables).
    - Still true: a `<Brick>` may hold MULTIPLE `<Part>` assemblies (hinge 73983 = 2430+2429), each with its own designID/materials/Bone — iterate every Part or halves vanish. A flex part's extra `<Bone>`s (segments) are still not synthesised: the first bone places the whole part (`multiBoneParts` in the diagnostics).
    - **Honest limit:** the remaining misses on the cohort are dominated by Technic sets (pins/axles whose `.io` stores the other of two equivalent poses, and flex parts) and by sets whose `.io` parks a sub-model elsewhere. An authentic Studio `.io` of a set is still exact and still preferred.
## LSynth flexible parts (hoses / tubes / cables) — VERIFIED already-handled + synth fallback

- **Reality (measured across the whole corpus):** flexible parts already render.
  OMR ships them **pre-synthesized** (`0 SYNTH SYNTHESIZED BEGIN…END` blocks of
  placed `<set> - LSxx.dat` segment sub-parts, all inline-defined as
  `Unofficial_Part` from primitives) — 72/72 SYNTH files are pre-synthesized,
  0 need runtime synthesis (42006, 8272 verified: 0 missing). Studio `.io` bakes
  flex into CustomParts meshes (handled). `lsNN.dat` are NOT in the LDraw library
  (404) — they only ever appear inline-defined. So the old "LSynth surfaces as
  missing" note was imprecise; in practice it doesn't.
- **`ls<NN>` segment parts** (ls50, ls51 …) ship with the LSynth TOOL, not the
  LDraw library — files authored with LSynth reference them externally with
  matrices that stretch a unit-height segment along the hose path (8010 Darth
  Vader places 181 of them; they rendered as 181 missing pieces). `parts.ts`
  now synthesizes a placeholder on a definitive miss of `/^ls\d{1,3}$/`:
  cylinder y∈[0,1], radius 4.5 LDU (mirrors the one bundled example ls10.dat).
- **The one gap (uploads):** a hand-authored / editor-exported file with an
  UNsynthesized `0 SYNTH BEGIN <type> <colour>` + constraints + `0 SYNTH END`
  (no geometry between). `web/src/engine/lsynth.ts` `synthesizeLSynth(text)` is a
  pure TEXT→TEXT pass run before `parseLDraw` (both `.io` and `.ldr/.mpd` paths,
  via `maybeSynthesize` in lego.ts): each unsynthesized TUBE block (hose/
  pneumatic/ribbed/cable/flex — NOT band/chain/tread) → a swept round tube
  (centripetal Catmull-Rom spline through constraint positions + rotation-
  minimizing frame, radius by type) emitted as an inline `0 FILE lsynth-N.dat`
  tagged `Unofficial_Part` (so the parser emits it as a TERMINAL brick, not an
  empty assembly) referenced at identity. Already-synthesized / non-tube blocks
  pass through untouched — can't break working files. Tests: `test/lsynth.test.ts`.

## The LDraw → scene frame is a ROTATION, not a Y flip (2026-09-22, breaking)

- **The finding.** LDraw is right-handed with +Y down; three.js is right-handed
  with +Y up. The viewer converted between them by negating Y alone,
  `diag(s, −s, s)`, which has determinant −1: a reflection. Every model was
  rendered as its mirror image — invisible on symmetric builds, visible on
  text and chiral layouts. The user saw it on 10261's `COASTER` sign reading
  backwards against the box art; measured objectively on the printed
  `3069bp82` (TICKET) tile: `det(placement R) = 0.9996`, `det(instance
  matrix) = −0.9996`, and **932 of 932 glyph triangles reversed their apparent
  winding** from the printed side. `exporter.ts` bakes those matrices, so
  every GLB/OBJ/STL/3MF was mirrored too — an STL printed chirally wrong with
  inward-facing normals.
- **The fix.** The frame is `diag(1, −1, −1)`, a half turn about X — the map
  between two right-handed frames, the convention `lxf-parser.ts`
  `FRAME_SIGN` and `ldraw-entity-compiler.ts` `ldrawToRenderRotation('+z')`
  already used. It lives in ONE module, `web/src/viewer/ldraw/frame.ts`
  (`ldrawInstanceMatrix`, `pushLdrawPointToScene`); `viewer.ts` builds every
  instance matrix and every edge segment through it. LDraw −Z (the model's
  front) is now scene +Z, so the pre-heuristic `frontDir` default `(0, 0, 1)`
  IS the LDraw front. **Never write an inline `-scale * R[3]` again** — go
  through `frame.ts`, and `test/ldraw-frame.test.ts` pins `det = +scale³ ·
  det(R)` (a mirrored sub-part keeps its own `det(R) = −1`, nothing else
  flips), the printed-glyph winding from the printed side, and a baked STL's
  facets all pointing outward.
- **The same reflection ran through the whole project** and was replaced
  everywhere at once (a half-flipped tree would be worse than either state):
  the block grid (`ldraw-geometry.ts` `rasterizeTriangles`, the fallback
  AABB, `bridgePartContacts`, the legacy `ldraw-voxelizer.ts` and its
  direction-dependent slope/wedge/corner/bracket masks), `block-shapes.ts`
  stair facings (an LDraw +Z rise now faces north), `bedrock-scene-actors.ts`
  `sceneGridPoint` / `yawForFacing` / door hinges, `bedrock-coaster.ts`
  `sceneGridVector`, `playable-addon.ts` `componentLayout` actor yaws and the
  grid-fallback geometry/seat authoring, `display-entities.ts` (Java
  `block_display` positions and the quaternion conjugation), and the building
  shell, whose `SHELL_FRAME = −I` existed only to land on the mirrored grid
  and is now `ldrawToRenderRotation('-z')` (det +1). Details and what it
  invalidated on the device: [Bedrock guide](bedrock-addon-guide.md), "The
  grid was a mirror" (2026-09-22).
- **Users with older files.** Every export made before this change is the
  model's mirror image; a new export of the same model will not overlay a
  placement made from an old file. `bedrock-export-notes.ts` says so in every
  Bedrock export's notes (`FRAME_CHANGE_NOTE`) and `craftmatic-provenance.json`
  now carries `frame: "x180"` (`pipeline-version.ts` `LDRAW_WORLD_FRAME`); a
  pack without that field is a mirrored one.
- **Unchanged on purpose:** the floor-reflection clones (`mirror.scale.set(1,
  −1, 1)`) are a deliberate mirror; the Bedrock vehicle and figure entities
  were already compiled through proper rotations (Pixel-proven) and keep their
  in-game chirality; the LXF import was fixed the same way on 2026-09-17.

## Renderer conventions (hard-won — do not regress)

- **NO `logarithmicDepthBuffer`.** It forces per-fragment depth writes that
  z-fight with InstancedMesh (used for every brick) and on near-coincident
  surfaces (stud-in-tube, coplanar faces) → flicker + interiors bleeding through
  walls. Use standard depth with a tuned near/far: `near = maxDim*0.01`,
  `far = (fitDist+maxDim)*8` (model-scale → ample 24-bit precision).
- **Transient part-fetch failures must NOT be cached as null.** `fetchDatText`
  retries each path 3× w/ backoff (8 s timeout) and only caches null on a
  definitive miss (all paths returned real HTTP responses). A load spike or
  flaky network otherwise permanently drops parts → missing connectors →
  supported parts appear to FLOAT. (Don't load many heavy models simultaneously
  in dev — it overwhelms the server and triggers this.)
- **Color pipeline** (matches box-art saturation): `THREE.NeutralToneMapping`
  (Khronos PBR Neutral) @ exposure 1.0 — preserves saturation where ACES shifts
  hues. **Dark** studio environment (`0x0a0a0e` surround + a few HDR emissive
  softbox panels), NOT a near-white blob (a white env floods diffuse onto every
  surface and washes dark colors grey). ONE physically-consistent ABS material
  for all opaque colors (roughness 0.36, no clearcoat, envMapIntensity 1.0) — no
  per-color "lum-gate" (that made dark bricks matte, light bricks glossy = wrong).
  Direct lights are neutral-temp; generous diffuse fill restores saturation.
- **Creased normals**: `toCreasedNormals(geom, 38°)` — smooth studs/cylinders,
  crisp brick edges (not blanket `computeVertexNormals`, which melts corners).
- **Studio floor look (2026-08-21)**: radial light-pool floor texture (bright
  pool ≈1.5×maxDim under the model → dark edges; the pool must occupy only the
  central ~15% of the canvas because the plane spans 10×maxDim), slightly
  transparent floor (opacity 0.8) + **fake-mirror reflection**: mirrored
  InstancedMeshes under the floor SHARING geometry AND instanceMatrix buffers
  (explode/step/resort follow for free), faded cloned materials registered in
  `allMeshMaterials`, `userData.mirrorOf` → applyStepVisibility reads the
  SOURCE mesh's step arrays (they're replaced on resort — read through the
  reference). Gated to ≤200 meshes; hidden while the verify-highlight is
  active. Transparent-pass back-to-front sorting draws reflections before the
  floor — don't make the floor opaque or reflections vanish.
- **Load cancellation**: `viewer.load()` carries a monotonic `loadSeq`; every
  awaited stage bails when a newer load starts. UI paths capture `loadEpoch`
  and skip stale status/progress writes. Rapid set-switching must always
  settle on the LAST selection.
- **ABS specularIntensity 0.45** (materials.ts, calibrated 2026-08-23 by
  pixel-sampling sand green on 21327 against #A0BCAC): full dielectric F0 laid
  a broad white specular on every mid-tone face and HALVED the chroma (colors
  read pale). Tone mapping measured innocent. Light levels re-tuned to match
  (amb 0.4 / hemi 0.34 / key 2.9 / fill 0.5 / env 0.8) — re-calibrate BOTH
  together or colors drift.
- **The vignette's `darkness` is NOT a strength — it is the COLOUR TARGET's
  complement** (fixed 2026-09-09; this was the user-reported "glare/brightness
  that looks like fog"). VignetteShader is
  `mix(texel.rgb, vec3(1.0 - darkness), dot(uv,uv))`, so `darkness: 0.8` dragged
  every pixel toward LINEAR 0.2 — which OutputPass tone-maps and sRGB-encodes to
  a **~124/255 mid grey** — and `offset: 1.2` gave the corners 72% of it. That is
  a grey veil over the whole frame, not a vignette, and being achromatic it
  DESATURATED everything. Measured (4 sets, identical cameras): it lifted mean
  frame luminance 14-18 and the darkest 1% by 3-13, and moved brick pixels up to
  50/255. Now `darkness 1.0` (target pure black ⇒ the pass is a plain multiply,
  `mix(c,0,t) === c*(1-t)`, so it can only darken and preserves chromaticity
  exactly) + `offset 0.95`. Saturation recovered ×1.23 with hue drift 0.15°.
  **Never raise `darkness` below 1.0 to "soften" the vignette** — that is the
  bug; soften with `offset`.
- **SAO's `saoScale`/`saoKernelRadius` must be SIZE-INVARIANT** (fixed
  2026-09-09). SAOShader uses `scale` only as `scale / cameraFar`, and occlusion
  grows as that ratio shrinks; `cameraFar = (fitDist+maxDim)*8` and the framing
  distance are both linear in maxDim, so the well-conditioned value is a
  CONSTANT. Deriving it from `maxDim` inverted that — the smaller the set, the
  heavier the smear — and SAO only runs on ≤80-mesh scenes, i.e. exactly the
  small sets. `saoKernelRadius` is in SCREEN PIXELS (shader divides by target
  size) so it must not carry world units either. Now `scale 13`, `kernel 24`:
  the pass's effect on brick pixels fell 59.7→17.4 / 52.2→16.4 / 26.0→12.6 mean
  on three small sets and p99 rose (highlights had been crushed).
- **`scene.fog` (FogExp2 at `0.15/maxDim`) is deliberate and stays.** It reads
  as a candidate for "haze" but measured only −2 to −4.7 luminance on bricks and
  it DARKENS rather than glares. It is what fades the 10×maxDim floor plane into
  the background; removing it would expose a hard floor horizon.
- **Diagnose look regressions with `scripts/renderer-pass-isolation.mjs`**
  before touching any constant — it captures one camera with exactly one pass
  disabled at a time, raycasts each sample back to its brick (so a sample knows
  its LDraw colour and camera distance, which is what separates a
  distance-dependent wash from a uniform lift), and `scripts/_calib_table.ts`
  turns two runs into a hue/chroma calibration table. `legacy-*` variants
  restore old parameter values at runtime for a same-session cost comparison.
- **Hyperspace warp loader** (`warp-loader.ts`): full-panel starfield + big
  percent + real part geometries as flying debris, owns the render loop while
  `warp.running` (composer skipped — the model scene is mid-build). begin()
  replaces any previous run; load()'s finally ends it only when
  `seq === loadSeq` (a newer load owns the overlay otherwise).
- **Export filenames are `<Name≤12>-<setNumber>` (2026-09-08).**
  `web/src/engine/export-name.ts` `modelExportStem()` builds every LEGO-tab
  download name: the model name first (whole words, no spaces, ≤12 chars), then
  the set number with the `-1` primary-variant suffix dropped —
  `Colosseum-10276.schem`. The old stems were the internal loader label and
  leaked the SOURCE into the user's Downloads folder (`10276-1-omr.schem`,
  `21063-1-io.schem`), which says nothing about the model and made two exports of
  one set look like different things. A NON-`-1` variant is kept (a different
  physical release). Degrades: name+number → number → name → the uploaded file's
  own name → `model`. Applies to every format (schem/litematic/guide/mcpack, GLB/
  OBJ/STL/3MF, CSV, PNG, turntable) so one model gives one family of filenames;
  `runMinecraftExport` re-sanitizes the stem so no caller can put a path
  separator in a download name. Tests: `test/export-name.test.ts`.
- **Export progress is a FIXED banner** (`web/src/ui/export-progress.ts`, S2):
  `beginExportProgress(title)` → `update(phase, pct?)` / `done()` / `fail()`.
  `#lego-status` stays the log (it scrolls out of view — that's why exports
  looked hung); the banner is the live surface, wired into schem/litematic/
  guide/GLB/OBJ/STL/3MF (CSV is instant). It sits at `#nav`'s measured bottom
  so it never covers the tab bar, and toggles `style.display` (never
  `[hidden]` — a `display:` rule would override the attribute).
  **Every phase must report honestly (2026-09-02).** `prefetchPartGeometry`
  streams REAL `resolved/total` progress (it used to post a single `0` and sit
  there for the whole download — minutes of "loading part geometry 0%", which
  reads as a hang), and the worker's 80 ms progress throttle now ALWAYS posts a
  phase CHANGE: throttling one left the banner showing the previous phase's
  name and percentage. Omit `pct` for genuinely unknown work — the bar goes
  indeterminate, which is honest; a stale number is not.
- **All materials are `DoubleSide`** (LDraw `.dat` winding is unreliable), so
  triangle winding is **shading-irrelevant** — Three flips the normal per
  `gl_FrontFacing`. Consequence: `resolvePartGeometry`'s cache keys by part id
  and IGNORES its `invertWinding` arg (so a part used both normally and mirrored
  shares one winding) — a latent correctness bug with **zero visual impact under
  DoubleSide**. Don't "fix" it for shading. It ONLY becomes real if someone
  adopts FrontSide/BFC culling for perf — then key the cache by winding first.
- **`preserveDrawingBuffer` stays OFF** — it forces tiled mobile GPUs to copy the
  framebuffer every frame. `captureScreenshot()`/`captureScreenshotAt()` render
  explicitly before `toDataURL()`, which is the correct capture pattern.
- **Mobile profile** (`IS_MOBILE`: touch + short edge <900px): pixel ratio ≤1.5,
  shadow map 1024², SAO skipped (SAOPass re-renders the scene for depth+normals).
- **Adaptive edge LOD** (`EDGE_SEGMENT_BUDGET`, desktop 3.5M / mobile 1.2M): the
  global edge `LineSegments2` is collected per-brick; if total segments exceed
  the budget the WHOLE model's edges are dropped (`edgesDroppedForSize` → LEGO
  status note). Do NOT reinstate the old `segCount < 2_000_000` HARD cap — it
  truncated edges mid-model (hero sets like 71043 Hogwarts, ~2.65M segments, got
  partial/inconsistent outlines). 3.5M gives Hogwarts + all normal/flagship sets
  FULL consistent edges; only the 2 mega-sets whose edge buffers ≈200MB (UCS
  Falcon ~3.8M, Colosseum ~4.5M) drop them — memory-responsible AND sub-pixel at
  full view. Mobile drops earlier (fat lines are costly there).
- **Geometry is verified correct** at the fundamental level (flush controlled
  stack at exact heights; ~0 duplicate placements; ~0 isolated bricks; matches
  official box images). The historic "overlap/float/flicker" reports were the
  two rendering bugs above, not placement errors.
- **Renderer verified solid on the heaviest sets (2026-06, don't re-investigate):**
  UCS Falcon 75192 (7552 bricks, ~6.9M mesh tris) renders correct + recognizable
  at 97fps desktop, 0 missing; Colosseum 9060, Hogwarts 5936 likewise. **Printed
  parts render** (minifig faces, printed tiles, multi-colour prints resolve via
  the `colorTris` path — TEXMAP is only a subset). No correctness/fidelity gap.
  The remaining renderer gap is mobile triangle/LOD for UCS-class sets (the edge
  LOD above is a first lever; deeper mesh LOD needs a device to validate fps).

## Color systems (don't conflate)

- **LDraw** ids (0=Black, 1=Blue, 15=White) — `.mpd`/`.ldr`.
- **Studio/BL** ids (1=White, 7=Blue, 11=Black) — `.io` model2.ldr.
- **LDD material** ids — `.lxf`. See clego `StudioColorDefinition.txt`, `ldraw.xml`.
- **`.io` colour space is per-FILE, never per-extension** (backlog S1, fixed
  2026-09-01). Studio ships the SAME model twice: `model.ldr` in **LDraw** ids
  and `model2.ldr` in **Studio/BL** ids. `extractIoModel` returns the first
  entry with type-1 lines, so MODERN exports resolve to `model.ldr` — but
  `lego.ts` used to hard-wire `colorFn = studioColorToBlock` for every `.io`.
  Reading LDraw ids through the BL table sent LDraw 15 (White) to Studio 15
  (Trans-Light Blue): 21063's 939 white castle-wall bricks exported as
  `light_blue_stained_glass`, LDraw 71/28/19 as magenta/orange/yellow-glass
  terrain (~37% of blocks translucent). `extractIoModel` now returns
  `{sourceEntry, colorSpace, colorSpaceReason}` via `detectIoColorSpace()`,
  which PROVES the pairing by histogram (BL→LDraw-mapping model2's counts must
  reproduce model.ldr's — 100% vs 5% literal on 21063) and falls back to the
  per-entry convention for single-entry archives. `web/src/engine/bl-ldraw-map.ts`
  is generated by `scripts/gen-bl-ldraw-map.py`. Tests: `test/io-colorspace.test.ts`.
  **Why the existing round-trip tests missed it:** exporting AND re-importing
  through the same wrong table is self-consistent — only an EXTERNAL viewer
  (schemat.io) or a palette assertion catches a colour-space error.
- Unmapped ids in BOTH resolvers fall back to `gray_concrete` (never a loud
  magenta) and `console.warn` once per id — don't make the fallback colourful.
## Connectivity / "are pieces floating?" verification

It is a **contact-candidate heuristic, never a certificate** (audit 2026-09-08
P1 #5). The UI control is "**Contact check**"; the old "✓ Verified: all N pieces
form one connected structure" copy is gone and must not come back — a voxel
proximity test with a 4 LDU tolerance cannot certify assembly, and the tolerance
makes "one component" the WEAKER claim (it over-connects). All user-facing
wording lives in `web/src/ui/contact-check-status.ts` and is unit-tested against
that claim boundary (`test/contact-check-status.test.ts`); every message
discloses tolerance, snap-table coverage %, pieces with no resolved geometry,
and placements that never rendered so the audit never saw them.
- **The hybrid IS fused now** (`auditConnectivity`): surface contact ∪ LDCad
  attachment points. `web/src/viewer/ldraw/attachment-snaps.ts` (GENERATED by
  `scripts/gen-attachment-snaps.py`, 413 parts / 1,116 connectors) covers the
  blind classes — clip-bearing parts, bars/pins/axles, minifig heads + headgear,
  small stud families. Coverage is deliberately partial, so the report carries
  `piecesWithSnaps` / `snapOnlyUnions` and the UI states the % rather than
  implying completeness (measured: 10365 25%, 42007 54%). Matching thresholds
  are inherited from `scripts/ldcad_connectivity.py` (CELL 20, TOL 8 LDU,
  |cos| > 0.95, radius slack 1.5); `SNAP_GEN` is skipped — matching it needs
  group ids the table doesn't carry and a groupless match would invent unions.
- **Detached ≠ suspicious**: groups are split with geograde's calibrated rules
  into `airborne` (nothing within 12 LDU below AND >48 LDU above the model
  floor) and `grounded` (resting on something — minifigs, accessories, stands,
  second models). It is a geometry guess about intent and the copy says so.
- **`expand_grid` gotcha (fixed 2026-09-09)**: LDCad also emits a **3-axis**
  grid form (`1 C 2 C 2 0 80 60`, 13 lines in the shipped library). The old
  2-axis-only parser raised `ValueError` on the third spec's `C` and took the
  whole part's snaps down with it. Derive the axis count as `(len - nC) / 2`.
- Engine detail: the LEGO tab's checkbox runs `viewer.highlightDetached(4)`;
  unchecking calls
  `clearDetachedHighlight()` (restores stashed material colors + instance
  colors + edge overlay + prior status). Engine: `viewer.auditConnectivity(resLDU=4)`
  voxelizes each part's triangle SURFACE, transforms per instance, unions pieces
  whose surfaces share/neighbour a voxel → connected components (typed
  `ConnectivityReport`, offline-tested in `test/connectivity-audit.test.ts`).
  `web/src/viewer/ldraw/connectivity-audit.ts`. **It detects face contact
  (stud-stacking, flush) but is BLIND to clip/bar/pin/SNOT grips.** Result:
  traditional builds → one 100% component (21063 .io verified, incl. via the UI
  control); SNOT/microscale (71043) under-counts but the highlight shows the
  "detached" pieces are embedded base/spires → **no floaters**. It's genuinely
  useful on RECONSTRUCTED models: the 21063 dbix_recon LDR shows 87% / 409
  detached — real placement gaps in the reconstruction, not audit noise.
  **Highlight gotchas (hard-won)**: (1) `instanceColor` MULTIPLIES
  `material.color` — force materials white (stash/restore) or red-on-green
  renders black; (2) the global edge `LineSegments2` keeps original per-segment
  colors and is dense enough to visually MASK the recolor entirely — hide it
  while highlighted.
- **LDCad snaps (offline, supplement)**: `scripts/ldcad_connectivity.py <model.io|.ldr>` uses the real LDCad shadow library to match male/female SNAP_CYL/CLP/FGR/GEN connectors. **COMPLETE but proven insufficient ALONE** — even 21063 (geometry-proven 100%) only reaches 69% via snaps, because LEGO joints are dominated by clutch/tile/flush contacts snaps don't encode. It is also the offline reference the browser table is generated from (above).
- **Settled findings**: 21063 fully connected; **71043 has no floating pieces** (verified geometrically + visually). Don't re-litigate.

## 10303 lift hand-off is a brick-built platform, not a track mould (2026-09-21)

- A user report of "the top piece of the track is missing" on the deployed 10303
  was measured against prod and the source and is **not a render or source
  defect**. Prod loaded `IOModel2V2/10303.ldr` at hash `df3b47c3c9f2`, 3,808
  bricks, `missing: []`, `unresolvedSubparts: []`, no track-mould request failed
  (the only 503/404s were minifig prints resolved via aliases). All 42 track
  placements (39 of the nine loop/ramp moulds + 3 x `26022`) are identical
  between the archive's `model2.ldr` and the published file; the three `80566`
  position differences are the documented `!ORIGIN_FIX` re-basing.
- The course's high end is the `80566` tip at model LDU
  `[-781.8, -2014.26, -579.71]`, heading +X, hanging in mid-air at the tower.
  That is the design: the lift is a **brick-built platform** (42 members, all
  tilted 4.1 degrees about Z, x -759..-422, z -600..-560, parked at the base
  y -170..-84) riding the tower's front column on 6 x `55981` + 8 x `4185`
  wheels. Cars roll off the station straight (which descends toward the tower)
  onto it; raised ~1,860 LDU its -X end meets the `80566` tip and the cars
  roll downhill through the U-turn into the vertical drop.
- The seven vertically stacked `25059` (x -578, z -260, y -4..-2244) are the
  **counterweight's guide**, not a car path: a dark-blue `26021` chassis with
  4 x `24869` wheels rides them, parked at the top while the platform is down.
  The ~390 LDU between that guide's top and the course's high end is
  therefore not a track gap and no rail belongs there; the "authored transfer
  mechanism" the route extraction asks for is the platform's translation.
  Regression: `test/coaster-track.test.ts` ("published 10303 route").
