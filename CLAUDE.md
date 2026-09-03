# Craftmatic — Project Guide

Minecraft schematic toolkit **and** an LDraw (LEGO) 3D viewer, web UI in `web/`
(Vite + TypeScript + Three.js). This file is the version-controlled source of
truth for architecture + hard-won conventions. Keep it current; do not keep
durable project knowledge only in private/agent memory.

> **Where to go next** → see **[ROADMAP.md](ROADMAP.md)**: the near-term (~100h)
> priorities (tests/CI first, then the user on-ramp, mobile, MC bridge,
> reliability) and the long-term (~10k h) vision — a universal LEGO pipeline:
> buildable *from* anything, *into* anything, with a physical-validity verifier
> as the moat. Read it before planning large work; it also lists the anti-goals
> (don't micro-polish the renderer; don't re-verify settled questions).

## Dev / commands
- Dev server: `bun dev:web` (port 4000). Add `--host` to expose on LAN (phone testing at the box's LAN IP:4000).
- Typecheck: root is `bun run typecheck` (`tsc --noEmit`, the `src/` tree); the whole `web/` tree is `bun run typecheck:web` (`tsc --noEmit -p web/tsconfig.json`). **Both run in CI** (ci.yml + deploy.yml) so a careless edit can't silently compile-break. The `web` tree is currently type-clean — keep it that way (the old ~34 `ui/*` errors were fixed; the app still *builds* via Vite/esbuild without type-gating, but CI now gates it).
- Build: `bun run build:web`. Tests: `bun test` (vitest). LEGO unit tests are **offline + deterministic** — `test/ldraw-parser.test.ts` (transforms/steps/primitives), `test/io-zip.test.ts` (ZipCrypto + WinZip-AES decrypt, validated against Node's own crypto as an oracle — no large `.io` fixtures), `test/lego-colors.test.ts` (the don't-conflate-colour-systems invariant), and `test/ldraw-geometry.test.ts` (**geometry regression**: `resolvePartGeometry` triangle/edge/winding/transform signature, GPU-free via a mocked `fetch` serving synthetic `.dat` — the de-risked stand-in for visual regression). Export-side offline suites: `test/schem-pipeline.test.ts` (the shared export module's grid path — byte-identical to a direct encode, no re-voxelization), `test/schem-settings.test.ts` (resolution planning vs the legacy ladder as an oracle), `test/light-fill.test.ts` (sealed room lit / open porch untouched), `test/palette-lint.test.ts` (every emitted block id is a real Minecraft block), `test/schem-seeded-geometry.test.ts` (the seeded resolver short-circuits fetch and matches the networked bytes; per-part progress advances; geometry is independent of fetch timing). Prefer this pattern over the network-fetching `test/lego-pipeline.test.ts` (and the flaky live-API `test/import-*` tests).
- Use **Chrome** for browser testing, not Edge.

## Key tabs
Generate · Import · Upload · Gallery · Comparison · Map · Tiles · **LEGO**

## Architecture (LEGO/LDraw path)
- `web/src/ui/lego.ts` — LEGO tab UI: search, auto-load chain, upload, 3D-render controls, step/explode sliders, missing-parts surfacing, **export menu** (PNG; GLB/OBJ/STL via `exporter.ts`+`viewer.exportMeshes()`; Minecraft `.schem`/`.litematic`/build guide via the SHARED `ui/schem-export.ts` (S4 — same module the Upload tab uses), with the `⚙ MC settings` popover next to the Download select; parts-list **`.csv` BOM** — part/color/count from `currentBricks`). OBJ/STL bake instances (no instancing in-format) → large on big sets; GLB is the compact 3D option. The slider row label is a **Step⟷Layer toggle**: layer mode slices by quantized plate height (`viewer.setSliderMode('layer')`) and is the DEFAULT for models without STEP meta (most Studio .io exports — 71043 has 5,936 bricks and ONE step); step mode is default when real steps exist.
- `web/src/engine/ldraw-parser.ts` — MPD/LDR → `ParsedBrick[]` (world transform = parentRot×local + parentPos, recursive; det<0 → winding flip). `countSteps()` counts `0 STEP` at ANY depth (sets that nest steps in sub-assemblies, e.g. 31084, depend on this).
- `web/src/viewer/ldraw/` — the direct 3D renderer (modular):
  - `viewer.ts` — Three.js scene/renderer/camera, lighting, env, post FX, camera framing/transitions, explode, picking, export (`exportMeshes()`). **Global instancing**: ONE InstancedMesh per (part,color) across the WHOLE model (not per step) + ONE global edge `LineSegments2`. Instances/segments are sorted step-ascending; the step slider sets `InstancedMesh.count` / `LineSegmentsGeometry.instanceCount` to a binary-search prefix — so a 1226-step set (UCS Falcon) is ~300 meshes / ~950 draw calls, not thousands. Static shadow map (`shadowMap.autoUpdate=false`, refreshed on scene change). **On-demand rendering**: the rAF loop only composites when `needsRender` is set (or a camera anim / autoRotate / Stats overlay is active) — idle scenes cost ~0 GPU. **Any new state mutation that changes the picture MUST call `this.invalidate()`** (or `requestShadowUpdate()`, which also invalidates); camera moves auto-invalidate via the OrbitControls `change` listener. Dev-only `window.__ldrawViewer` hook for `renderer.info` metrics.
  - `parts.ts` — fetch/parse/resolve `.dat` geometry; module-level caches **plus a persistent IndexedDB .dat-text cache** (`craftmatic-ldraw` db; positive results only — repeat sessions load big sets with ~zero part fetches; bump `IDB_VERSION_KEY` to invalidate); `prewarmCommonParts()`; `partTextureUrls` (TEXMAP); `preloadDatTexts()` (archive-bundled parts, model-specific, cleared by `clearMpdInlines`); `unresolvedDatNames` → `viewer.unresolvedSubparts` (sub-file refs that resolved nowhere = silent holes, surfaced in status). Candidate-path order is name-shape-aware (`looksLikePrimitive` → `p/` first) with a **`p/48/` hi-res alias tail** for bare primitive refs that only exist as 48-variants (e.g. `1-12ring14`). `LDRAW_BASE = /ldraw-parts`.
  - `materials.ts` — LDraw color → THREE material (ABS / rubber / metallic / transparent / glow).
  - `types.ts` — Vec3/Triangle/Edge/PartGeom/TexturedTriangle.
- `web/src/engine/ldraw-colors.ts` — LDraw color id → hex (and → Minecraft block for voxelizer).
- Other importers: `bff-loader.ts` (BrickLink inventory → flat layout), `studio-colors.ts`, `ldd-colors.ts`.
  - `io-extractor.ts` (.io) — `extractIoModel()` returns `{text, customParts, sourceEntry, colorSpace, colorSpaceReason}` (see "Color systems" — the colour table MUST follow `colorSpace`, not the file extension): tries `model.ldr` → `model2.ldr` → `modelv2.ldr` (first with type-1 lines wins) AND pulls every **`CustomParts/**/*.dat`** from the archive (Studio's user-modified `m<hash>_<date>_<time>.dat` parts + the exact primitives they need). Without CustomParts, big Technic sets silently lose pieces (42110 was missing 24). They flow `lego.ts currentCustomParts` → `viewer.load(opts.datFiles)` → `preloadDatTexts`.
  - `zip-utils.ts` + `aes-zip.ts` — ZIP reader. Handles plain DEFLATE, legacy **ZipCrypto** (pw `soho0909`), and **WinZip AES-256** (method 99, pw `soho0909`) used by older/early-access .io exports. AES = PBKDF2-HMAC-SHA1 + pure-JS AES in little-endian CTR (Web Crypto's big-endian AES-CTR is incompatible).
  - `lxf-parser.ts` (.lxf/LDD) — applies per-part LDD→LDraw origin alignment from `web/public/ldd-part-map.json` (gen: `scripts/gen-ldd-part-map.py` from clego `ldraw.xml`, 4467 parts). The intricate transform math is extracted into pure, unit-tested functions: `parseBoneTransform` (LXFML column-major→row-major), `axisAngleToMatrix`, `composeLxfPlacement` (`R_world=R_bone·R_align`, `t_world=R_bone·t_align+t_bone`, then F=diag(1,−1,1) conjugation + ×25). Angles in `ldraw.xml` are RADIANS (verified: clego's `convert_lxf.py` has a latent bug here — `math.radians()` on the already-radian value, treating π/2 as 1.57° — so OUR handling is more correct). A `<Brick>` may hold MULTIPLE `<Part>` assemblies (e.g. hinge 73983 = parts 2430+2429), each with its own designID/materials/Bone — the parser iterates every Part (not just the first), or assembly halves vanish. **Known limitation (verified, not a bug):** alignment is exact for simple/axis-aligned builds (Tree ✓) but IMPERFECT for complex models with many angled/curved parts (vehicles splay) — our output matches clego's `convert_lxf.py` reference exactly (426/487 exact rotations, 0 transposed) and that reference renders the SAME splay, so it's an inherent limit of free LDD→LDraw alignment, shared with the state-of-the-art tool, NOT a cheap fix. The Studio `.io` of the same set renders correctly (different/better alignment source) — the UI says so on big `.lxf` loads. Don't sink hours out-engineering LDD alignment without ground-truth LDD-aligned placements to test against.

## LDraw parts library — DEV vs PROD (critical)
The 3D renderer needs individual `.dat` geometry from `/ldraw-parts/*`.
- **DEV**: served by a Vite middleware in `web/vite.config.ts` from a local clego
  install (`C:/git/clego/extracted/studio_release/app/ldraw`, ~1.8 GB / 67k files),
  falling back on a local miss to the **prod worker's R2 mirror**
  (`craftmatic.click/ldraw-parts`) and only then to `library.ldraw.org`. The
  local install is a frozen Studio snapshot (**LDraw release 207**: 12,136
  official parts vs upstream's 24,737), so every mould released since 2020
  misses locally — going to the mirror first keeps dev coverage equal to prod
  without paying library.ldraw.org's throttling. A
  `FORCE_UPSTREAM` const (default `false`) bypasses local to mirror prod exactly.
  The fallback only caches a null on a DEFINITIVE upstream 404 (thrown fetches —
  throttling during a load burst — retry instead; concurrency capped at 6).
  Caching nulls on transient failures turned existing parts (73111 …) into
  permanently missing pieces for the whole dev session — don't reintroduce.
- **PROD**: the Cloudflare Worker (`worker/ldraw-omr.js`) serves `/ldraw-parts/*`
  **R2-FIRST** from the `lego-models` bucket (keys `ldraw/<relpath>`, LOWERCASED
  — R2 keys are case-sensitive and `normId()` lowercases every request; mirror
  maintained by `scripts/sync-ldraw-r2.mjs`), falling back to
  `library.ldraw.org/library/{official,unofficial}/*` for unsynced keys.
  Routed in `wrangler.toml` (`craftmatic.click/ldraw-parts/*`) with the R2
  binding `MODELS`. **Must `bunx wrangler deploy` to publish.** Without this
  route the deployed app has NO geometry and silently falls back to voxelization.
  **Why R2-first (prod incident 2026-08-17):** library.ldraw.org rate-limits
  cold big-set bursts (even `stud.dat` 503'd); worse, the worker's old blanket
  `cacheTtl+cacheEverything` EDGE-CACHED those failures for a week, so
  thousands of real parts read "missing". Rules now: `cacheTtlByStatus`
  (successes 1w, 404s 5min, errors 0), upstream throttle → 503 `no-store`
  (never a cacheable 404), one in-worker retry; client treats only 404/410 as
  definitive (`parts.ts`), and part-prefetch concurrency is 12.
- **Keeping the mirror CURRENT (2026-09-02).** The original seed was uploaded
  from the Studio-bundled library, i.e. LDraw release **207** — so R2 was five
  years stale and ~18k modern parts existed only behind the throttled upstream
  fallback. `scripts/sync-ldraw-r2.mjs` was rewritten to pull the **upstream
  release archives** (`updates/complete.zip` + `unofficial/ldrawunf.zip`) and
  upload a **stateless delta**: the R2 list API returns each object's etag
  (= content MD5 for single-shot PUTs), so new/changed files are computed by
  comparison — no done-file, no committed manifest, a missed run self-heals.
  New files upload first (a hole in the render beats a relicensed header).
  Uploads go through the **R2 REST API** with `CLOUDFLARE_API_TOKEN` (the
  deploy secret already has R2 write), ~300-600 files/min; keys present only in
  R2 are never deleted. `.github/workflows/sync-ldraw-r2.yml` runs it weekly.
  Verify coverage without a browser: `node scripts/check-missing-parts.mjs
  --recent 10` (or `<set> …`), which replays the client's candidate paths +
  alias ladder against prod or a local library.
- **Design-id ≠ LDraw part name.** Mecabricks-lineage models write LEGO's
  CURRENT design id; LDraw names a mould by its first/BrickLink-canonical
  number and never renames it. For re-tooled families the two share no digits
  (`42923`→`63868`, `44860`→`60897`, `26169`→`4865b`), so nothing resolves and
  no suffix rule can help — the mapping is DATA, in
  `web/src/engine/ldraw-part-aliases.ts` (every entry verified against the
  target `.dat`'s own description). Above it, `partAliasCandidates()` in
  `parts.ts` strips ONE suffix group per hop — lettered mould revisions
  (`6538c`→`6538`), decorations/versions (`3626d1024`, `30367v2`), prints
  (`98138pb042`→`98138`) — and chains (`u9132v1d1`→`u9132v1`→`u9132`).
  Measured over 6,325 tier-1 corpus `.ldr` files: 1,323 of 2,639 orphaned names
  = 20,289 of 39,081 placements recovered. Every candidate is verified against
  the library before use and the hop only runs after a DEFINITIVE miss, so a
  bad guess costs a lookup, not a wrong render. **The base must end in a digit**
  — without that guard the print rule shreds primitives (`stud4`→`stu`), which
  would substitute nonsense inside every part referencing them (test pins it).
  Substitutions are recorded in `substitutedDatNames` → `viewer.substitutedParts`
  → a LEGO-status note, so a near-mould swap is never silent. Tests:
  `test/part-alias.test.ts`.
- **Genuinely unmodelled molds are a real category — document, don't guess.**
  10316 Rivendell's remainder after the above: `20926`/`20932` (dual-moulded
  "2K" minifig leg halves — LDraw has only the obsolete single legs 3817/3816,
  whose headers carry `!HELP Move down 12 units to align with hips`, i.e. a
  DIFFERENT origin, so substituting misplaces them) and `1000341` (a
  Mecabricks-INTERNAL id for one sword blade off the 37341 sprue; a bbox sweep
  of every minifig/weapon part found no match within ±2.5 LDU). 3 pieces total.
  A misplaced piece is worse than a visible hole — leave them missing.
- `library.ldraw.org` serves individual parts but sends **no CORS header** — must
  be proxied; cannot fetch from the browser directly. Official layout:
  `/library/official/{parts,p,parts/s,p/48}/<stem>.dat`.
- **Batched part fetch (2026-08-29)**: `parts.ts` micro-batches concurrent
  `fetchDatText` calls (20 ms window / 48 names) into ONE
  `/ldraw-parts/_batch?files=…` request (worker: ≤64 R2 keys in parallel,
  official+unofficial checked per name; dev: vite middleware mirror).
  Measured: cold UCS Falcon fetch phase was 4+ min via per-path probing
  (429 parts × ≤8 candidates × retries, 10-29 s single-part stalls);
  Concorde cold in dev = 5 batch requests, 0 individual, 4.3 s. Endpoint
  failure ×2 disables batching for the session (falls back to probing).
- **Models + index are SAME-ORIGIN through the worker** (2026-08-29):
  `/lego-models/*` and `/lego-models-index.json` routes → R2 binding. The raw
  `pub-*.r2.dev` domain serves bytes UNCOMPRESSED and off-zone; the worker
  path gets edge brotli/gzip (index 2.4 MB → 331 KB, .ldr ~5×) + edge cache.
  `MODELS_BASE = '/lego-models'` in both dev and prod; r2.dev is only the
  index fallback. **`buildStepGroup` is async + time-sliced** (yields ~24 ms,
  bails on stale loads, streams "placing bricks / building meshes / building
  edge outlines" into the warp overlay) — it used to freeze the main thread
  after the fetch hit 100% (Page-Unresponsive kills = the "crash between
  100% and display" class).
- Parts that never resolve (a few set-custom OMR subparts like Red Baron
  `s100241`) are surfaced in the LEGO-tab status + console via
  `viewer.missingParts` — not silent. Sub-file refs that resolve nowhere (parent
  still renders, with small gaps) are surfaced separately via
  `viewer.unresolvedSubparts`.

## Source-quality gating (visual-QA 2026-07-20 — the renderer was never the problem)
A 12-set visual QA (real WebGL captures, `output/visual-qa-*/`) showed every
"broken-looking" render traced to **LXF-lineage source data**, not the renderer:
`Author: convert_lxf.py` LDRs carry raw LDD material-id colors + no per-part
alignment (10255 → stacked buildings, 1924 → exploded ferry decks, 8849 →
ghost tires). Pipeline defenses (classifier extracted to
`web/src/engine/source-quality.ts`, offline-tested in
`test/source-quality.test.ts`; `lego.ts` imports + wires the warnings):
- **`0 !LINEAGE <tool> <good|partial>` is the CANONICAL stamp** (clego
  converters emit it since 2026-08-28) and takes precedence over all legacy
  sniffs — the v2 DBIX reconverter's files also start with `0 LEGO DBIX v2`,
  which the legacy regex alone would misread as the warn-class. `good`→good,
  `partial`→approximate. Companion markers: `0 DBIX MULTIMODEL UNPLACED`
  (synthetic side-by-side layout → approximate + explicit caveat) and
  `0 DBIX FLOATING CLUSTER n=<k> gap_ldu=<g>` (authored mid-air parts, e.g.
  60502's airplane — informational note so users don't report it as a bug).
- `reconstructionQuality()` legacy sniffs: `convert_lxf.py` / `DBIX_LXFML`
  headers → 'broken'; un-stamped `0 LEGO DBIX` / `download_dbix_lxfml.py` →
  **'dbix'** (= legacy v1 conversions: dropped parts + lost sub-assembly
  transforms; superseded by `dbix_conv_v2` for ~2.1k sets). `sourceCaveat()`
  maps class+markers → the user-facing warning at every load path.
  NOTE (corrected 2026-08-28): the earlier claim that 72153's upstream LXFML
  "lacks the separation" was WRONG (a double-counted bone probe) — the clego
  v2 reconverter recovers all three Pokémon properly separated; genuine
  multi-model collapse exists in only 5 sets, marked MULTIMODEL UNPLACED.
  TASKS-FROM-CRAFTMATIC items #1–#6 are all DONE upstream (v2 sources:
  `dbix_conv_v2` 2,119 · `io_model2_v2` 790 · authentic `io` 896 entries).
  (A color-palette fingerprint was tried and REMOVED — dead code:
  `LDRAW_COLOR_RGB` already contains the extended ids like 10047/10070, so
  table-membership can't discriminate; origin-collision and volume-per-brick
  collapse metrics also proven non-discriminating. Don't re-add.)
- **Indexed auto-load iterates sources**: broken entries throw → next indexed
  source → classic OMR chain. 8849 now lands on its official OMR file (solid
  tires) instead of the gated conversion. Explicit source-picker choices pass
  `allowBroken` and load anyway, labelled.
- **`currentSourceWarning`** (reset by `newLoadEpoch()`): load paths set it and
  `voxelizeAndDisplay` appends it to the FINAL status — a plain setStatus()
  before display is silently clobbered by the render-success status (this hid
  every quality warning until the visual QA caught it).
- **Load-epoch token**: every load initiator (upload / indexed / OMR chain)
  bumps `loadEpoch` and bails at await-points if stale — a slow earlier load
  can no longer overwrite the user's newer selection. autoLoadFromOMR also
  falls through on transient OMR fetch errors (used to rethrow → skipped both
  fallbacks and stranded the button disabled) and re-enables its button in
  `finally`.
- **Known residual (data-bound, needs upstream index metadata)**: laundered
  conversions with no headers — 10255's ".io" is convert_lxf output repacked
  (all 3 entries identical, LDD colors) and its `Reconstructed/*_reconstructed
  .ldr` mirrors it. Text-level detection is impossible client-side; the model
  index (clego-generated) needs lineage/authenticity ranking.

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
- **Hyperspace warp loader** (`warp-loader.ts`): full-panel starfield + big
  percent + real part geometries as flying debris, owns the render loop while
  `warp.running` (composer skipped — the model scene is mid-build). begin()
  replaces any previous run; load()'s finally ends it only when
  `seq === loadSeq` (a newer load owns the overlay otherwise).
- **Minecraft exports are proportion-exact + high-res** (2026-08-23): schem/
  litematic pick the finest UNIFORM cubic cell from [4,5,8,10,20] LDU fitting
  max(w,l)≤640, h≤320, ≤30M cells (cellLDU 4 = 5 cells/stud, 2/plate — 4
  divides both 20 and 8, so NO 2.5× vertical stretch), geometry-voxelized
  with a bbox fallback + fillSingleVoxelGaps (no keepLargestComponent —
  minifigs are real separate components). The build guide stays at 1
  cell/stud. GLB/OBJ/STL were verified axis-exact already (STL bbox matches
  studs×8mm per axis to the decimal).
- **Minecraft export runs in a Web Worker + the OOM cause (S3, 2026-09-01).**
  `web/src/engine/schem-worker.ts` runs voxelize → fillSingleVoxelGaps → NBT →
  gzip off the main thread and streams `{phase, pct}` to the banner;
  `runSchemExportWorker` (now in `ui/schem-export.ts`, see S4 below) falls back
  to the identical inline path if a Worker can't be constructed. **`vite.config.ts` must keep
  `worker: { format: 'es' }`** — the rollup default (`iife`) can't code-split,
  which the worker's graph needs. MEASURED before→after (21063 .io, cellLDU 4,
  7.47M-cell grid): voxelize 85.5 s → 5.9 s, peak RSS 935 → 490 MB; at the
  30M-cell cap the NBT encode alone was **1.33 GB RSS for a 0.2 MB file** →
  338 MB. Three causes, all fixed, all output-preserving:
  1. **`number[]` byte accumulation** (the OOM): `encodeBlockData` and both NBT
     writers pushed every output byte into a JS array (+783 MB / +325 MB at
     30M cells). Now `web/src/engine/byte-writer.ts` (growable Uint8Array) and
     an exact-size two-pass varint encoder. Encoders moved to
     `web/src/engine/schem-encode.ts` (no THREE/DOM, so the worker can import
     them); `exporter.ts` re-exports them.
  2. **object-per-cell accumulator** in `ldraw-geometry.ts` — 1.60M
     `{gx,gy,gz,block,color}` objects ≈ 98 MB; now chunked parallel
     Int32/Uint16 arrays (14 B/cell) with interned block strings.
  3. **O(rays × triangles) sweep** (the 85 s): each sweep now has a
     per-triangle bbox bucket index (CSR). Provably equivalent — Möller-
     Trumbore's u/v test already rejects rays outside the projected bbox, and
     `parityFill` sorts hits so visit order can't matter.
  **Byte-identity is the gate, and it passed**: `scripts/_schem_ref.ts` on
  21063 gives the same sha256 before and after (CLI/filesystem = deterministic).
  Do NOT compare browser exports for identity — the dev `/ldraw-parts` upstream
  fallback makes part resolution nondeterministic (two runs of the SAME code
  differed by 570 blocks). Profilers: `scripts/_schem_profile.ts` (full path),
  `scripts/_schem_encode_profile.ts` (encode at the 30M cap).
- **ONE shared Minecraft-export module for every tab (S4, 2026-09-01).**
  `web/src/ui/schem-export.ts` `runMinecraftExport()` is the ONLY path that
  encodes a .schem/.litematic for a user download; it owns resolution planning,
  the Worker (+ identical inline fallback via the same function), the progress
  banner, the build-guide hand-off and the download. Two sources:
  `{kind:'bricks'}` (LEGO tab → voxelize → fillSingleVoxelGaps → encode) and
  `{kind:'grid'}` (Upload tab / generator / gallery inline+overlay viewers →
  encode ONLY; an uploaded schematic is already blocks, re-voxelizing or
  gap-filling it would be lossy). The work itself lives in
  `web/src/engine/schem-pipeline.ts` (`runSchemPipeline`), which
  `schem-worker.ts` is now just message plumbing around. `main.ts`'s old
  `exportSchem/exportLitematic` dropdown calls are gone; those exporter.ts
  helpers remain only for the dev/batch surfaces (tiles batch, comparison).
  - **User settings** (`⚙ MC settings` popover, `ui/schem-settings-panel.ts`,
    persisted in `localStorage['craftmatic.mcExportSettings']`, read at export
    time so both tabs always agree): **Resolution** (Auto = the shipped ladder,
    or 1 / 2.5 / 5 blocks per stud; an over-cap explicit choice is coarsened
    back to the auto pick and the status says so), **Block mapping profile**
    (`engine/block-profiles.ts` — ONE real profile; the seam exists so a second
    mapping table is a data addition. Don't add placeholder profiles), and
    **Light enclosed interiors** (OFF by default). Pure planning lives in
    `engine/schem-settings.ts` (`planResolution`, `spanOfBricks`, `describePlan`).
    The dims preview and the caps both use the BRICK-ORIGIN span + 80 LDU pad —
    it understates a tiny model's real extent (unchanged pre-S4 behaviour).
  - **Light fill** (`engine/light-fill.ts`): flood air inward from the grid
    boundary → everything unreached is an enclosed pocket → pockets ≥ 8 cells
    get glowstone on their FLOOR, one per `spacing`³ (6) bucket. A room with a
    doorway is reachable from outside, so it stays dark by design. Runs after
    fillSingleVoxelGaps, only when the flag is on.
  - **The export REUSES the viewer's part geometry — zero network (S6,
    2026-09-02).** The export resolver (`engine/ldraw-geometry.ts`) keeps its
    own `.dat` text cache, a different module from the viewer's
    (`viewer/ldraw/parts.ts`) and, in the worker, a different THREAD — so
    exporting the model already on screen re-downloaded its whole part library.
    `schem-export.ts` now snapshots the viewer's cache (`collectDatTexts()` —
    library fetches + the IndexedDB warm cache + MPD inlines + archive
    `CustomParts/`, `null` = definitive miss) and ships it as
    `SchemWorkerInput.datTexts`; `runSchemPipeline` calls `seedDatTexts()`
    before voxelizing. Texts in, triangles out — the resolver is untouched, and
    anything absent from the seed still fetches (with progress). Measured in
    Chrome on 21063: **53 `/ldraw-parts` requests during load, 0 during
    export** (with 3D Render OFF, i.e. nothing pre-loaded: 866 during export,
    as designed). Bonus: `.io` CustomParts exist only in the archive and used to
    hit the AABB box fallback in the export — they now voxelize for real.
    Tests: `test/schem-seeded-geometry.test.ts`.
  - **Geometry resolution was TIMING-DEPENDENT until 2026-09-02 — don't
    reintroduce.** `resolvePartTriangles` publishes a part's triangle array into
    `partGeomCache` before its sub-file refs are appended (the cycle guard), and
    the cache was checked BEFORE `geomInFlight` — so a parent could bake in a
    half-assembled child, and which caller lost the race depended purely on
    fetch timing. The same model voxelized to 1,184,777 cells over the network
    and 1,174,763 over a warm cache, with 4,474 cells of real geometry lost even
    cold. In-flight is now checked first; only a genuine reference CYCLE (an
    explicit ancestor set threaded through the recursion) may read the partial
    array. `viewer/ldraw/parts.ts` has the same shape and papers over it with
    `invalidatePartGeom` — if you touch either resolver, keep the ordering.
  - **Byte-identity is the gate.** With defaults (auto / default profile /
    light fill OFF) the bricks path is the pre-S4 sequence exactly:
    `scripts/_schem_ref.ts` (driving the REAL shared pipeline) on 21063 gives
    sha256 `d158beb…f3fd7`, 1,189,251 non-air. **Re-derived 2026-09-02** (was
    `52d2211…4be6b` / 1,184,777) by the race fix above — the old hash was
    reproducible only because the CLI's timing was. The seeded browser export is
    that grid **+16 cells** (1,189,267, confirmed in Chrome): the viewer's
    candidate-path list has the `p/48/` hi-res alias tail, so it resolves 7
    primitives (`1-12ring14`, `4-4aring`, …) that the bare export resolver
    misses. Nothing else differs — a seed built from the EXPORT resolver's own
    picks reproduces `d158beb…` exactly. `test/schem-pipeline.test.ts` proves
    the grid path is `bytes === encodeSchemBytes(grid)`.
- **External-viewer gate (S5, 2026-09-01)** — our importer round-trips whatever
  we write, so a palette/colour-space mistake is invisible internally (that's
  how S1 hid). Two halves:
  1. **Palette lint, offline** — `engine/palette-lint.ts` +
     `engine/mc-block-registry.json` (curated, verified Java 1.20 ids: the
     16-colour families + solids + light sources). `test/palette-lint.test.ts`
     asserts every value in BOTH colour tables, the fallbacks, the profile light
     blocks and a REAL exported .schem's `Palette` are `minecraft:<known id>`.
     A new block means adding it to the JSON deliberately.
  2. **schemat.io, scripted + manual** — `node scripts/schem-external-check.mjs`
     (node, NOT bun: `chromium.launch` hangs under bun here; `channel:'chrome'`)
     exports 21063 through the shared pipeline, checks the baseline sha256,
     uploads it to schemat.io/view and screenshots to `output/schem-backlog/`.
     Verified 2026-09-01: white castle, solid walls, green/brown base — no
     translucent walls, no magenta terrain. NOT in CI (third-party site).
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

## Gotchas
- **PWA service worker** caches all modules and serves stale code. If changes
  don't take effect: unregister SW + clear caches, then hard reload. (See the
  snippet history; `navigator.serviceWorker.getRegistrations()...` + `caches.keys()...`.)
- **`[hidden]` + `display:flex` trap**: rows with `class="lego-scale-row"` (which
  sets `display:flex`) override the `hidden` attribute. Toggle `style.display`,
  not just `.hidden` (bit the help overlay AND the step/explode rows).
- LDraw Y is down; the viewer handles the handedness. Model-aware F/B/L/R
  orientation is derived from the longest horizontal axis + brick mass.

## Connectivity / "are pieces floating?" verification
Two tools answer "is every piece connected, or do some float?":
- **Geometry-contact (browser, primary — now USER-FACING)**: the LEGO tab's
  **Verify checkbox** runs `viewer.highlightDetached(4)` and reports in
  `#lego-status` (✓-success for one component; % + red highlight + honest
  clip/pin-false-positive caveat otherwise); unchecking calls
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
- **LDCad snaps (offline, supplement)**: `scripts/ldcad_connectivity.py <model.io|.ldr>` uses the real LDCad shadow library to match male/female SNAP_CYL/CLP/FGR/GEN connectors. **COMPLETE but proven insufficient ALONE** — even 21063 (geometry-proven 100%) only reaches 69% via snaps, because LEGO joints are dominated by clutch/tile/flush contacts snaps don't encode. The true certifier is the HYBRID (geometry OR snap); not yet fused.
- **Settled findings**: 21063 fully connected; **71043 has no floating pieces** (verified geometrically + visually). Don't re-litigate.

## Offline reference data (for the analysis scripts; in `C:/git/clego`, dev-only)
- **LDraw part library** (real `.dat` geometry): `extracted/studio_release/app/ldraw` (`parts/`, `p/`, `p/48/`, `parts/s/`).
- **LDCad shadow library** (SNAP metadata, 4255 `.dat`): `ldcad/unpacked/offLib/offLibShadow.csl` (a zip). Acquired from melkert.net LDCad 1.7 `shadow.sf` (zip → `offLibShadow.csl` zip). Snap format: `0 !LDCAD SNAP_CYL [gender=M|F] [secs=R <radius> <len>] [pos=...] [ori=...] [grid=...]`. Studs y=0 (M), anti-studs y=24 (F) in part space.
- **Mecabricks parts**: `mecabricks_parts/geometries` (810 high-fidelity meshes) + `configs` (857; `geometry.extras.knobs`=studs, `tubes`=anti-studs, 456 populated). NOT used — LDraw already covers all parts; Mecabricks is a higher-fidelity SUBSET in ~2.5×-LDU Y-up coords. Only worth it for Mecabricks-grade fidelity (big lift, partial coverage).
- `.io` AES decrypt (for offline model loading): WinZip AES-256, pw `soho0909`, PBKDF2-HMAC-SHA1 1000 iters, little-endian CTR (see `scripts/ldcad_connectivity.py` `read_io`).

## Browser-automation testing caveats (claude-in-chrome — hard-won, saves hours)
- The automation tab runs **backgrounded → `requestAnimationFrame` is throttled/paused**. So **on-demand rendering means the canvas often has no fresh frame** and `Page.captureScreenshot` **times out — just retry it** (usually succeeds 2nd try). Continuous-render checks (live FPS) are unmeasurable here.
- **Enable the Stats checkbox to force continuous rendering** when you need reliable screenshots (it sets `animating=true`).
- **Editing `viewer.ts` triggers HMR which disposes the viewer → `window.__ldrawViewer` becomes null/stale.** After any viewer edit you MUST reload the page AND re-load the model before using the dev hook.
- **Synthetic pointer/wheel events don't reliably drive OrbitControls.** To move the camera, set it via the hook: `v.cameraAnim=null; v.controls.target.copy(...); v.camera.position...; v.controls.update(); v.composer.render()`. `v.setView('iso'|'front'|...)` works (it animates).
- **Verify the loaded model** (`window.__collect?.().length` or `viewer` brick count) — a 404'd `fetch('/inspect-X.io')` silently leaves the PRIOR model loaded (this mislabeled an audit once).
- Test models: copy `C:/git/clego/lego_sets/IO/<set>.io` → `web/public/inspect-*.io`, dispatch `change` on `#lego-mpd-input`, delete after (keep out of git). OMR `.mpd` fetch directly via `/ldraw-omr/<set>-1.mpd`.
- Dev-only `window.__ldrawViewer` is set in `viewer.ts` load() under `import.meta.env.DEV`.

## Autonomous improvement loop
`scripts/renderer-improve-loop.mjs` is a Stop hook (in `.claude/settings.json`) that, when `.claude/improve-loop-state.json` has `"active": true`, blocks stop + re-injects a "find/implement/validate/commit the next improvement" directive (50-pass cap). Currently `active:false`. Re-arm: set `active:true, pass:0`.

## Deploy
Cloudflare: static build (`web/dist`) + Worker (`worker/ldraw-omr.js`).
`wrangler.toml` routes `/ldraw-omr/*`, `/ldraw-parts/*`, `/lego-models/*`,
`/lego-models-index.json` AND (since 2026-09-02) `/bff/*` + `/seymouria-ldr/*`
to the Worker. Those last two used to live only in the CF dashboard and were
**not in effect** — `craftmatic.click/bff/inventory/21063-1` returned GitHub
Pages' 404, so the LEGO tab's last-resort source was dead in prod while fine in
dev. Declare routes in `wrangler.toml`, never only in the dashboard. Run
`bunx wrangler deploy` after changing the Worker or routes.

## Source freshness (new sets over time)
Two halves, split by what can run without the local corpus. See
`clego/SOURCES.md` for the full channel audit.
- **CI** — `.github/workflows/refresh-sources.yml`, weekly: `prebuild:lego`
  (Rebrickable → `lego-catalog.json`, gitignored, so a new set is searchable),
  `prebuild:omr` / `prebuild:seymouria`, then `scripts/source-freshness.ts`,
  which measures the gap the catalog refresh CANNOT close: fresh catalog ∖
  published model index = sourceless, intersected with the live DBIX skulist +
  OMR list = *harvestable today*. Commits `source-freshness.json` (timestamped,
  so it always commits — that push is what triggers `deploy.yml` and gets the
  fresh catalog to prod).
- **Local** — `clego/discovery/refresh_local.py --run`: refresh `sets.csv`,
  diff the DBIX skulist and harvest+convert what's new, geograde it, rebuild
  `lego-models-index.json` FRESH, publish scoped to R2 (`sync_models_r2.py
  --only`; an unscoped sync uploads another agent's in-progress corpus).
- **Why it exists (40975-1)**: the catalog refreshes every deploy, the model
  index is generated by hand from a 1.8 GB local corpus, so a 2026 set was
  searchable with zero sources — and its DBIX model had existed upstream all
  along (the harvest was 92 SKUs stale). Search freshness ≠ model freshness.
