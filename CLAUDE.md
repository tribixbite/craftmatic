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
- Build: `bun run build:web`. Tests: `bun test` (vitest). LEGO unit tests are **offline + deterministic** — `test/ldraw-parser.test.ts` (transforms/steps/primitives), `test/io-zip.test.ts` (ZipCrypto + WinZip-AES decrypt, validated against Node's own crypto as an oracle — no large `.io` fixtures), `test/lego-colors.test.ts` (the don't-conflate-colour-systems invariant), and `test/ldraw-geometry.test.ts` (**geometry regression**: `resolvePartGeometry` triangle/edge/winding/transform signature, GPU-free via a mocked `fetch` serving synthetic `.dat` — the de-risked stand-in for visual regression). Prefer this pattern over the network-fetching `test/lego-pipeline.test.ts` (and the flaky live-API `test/import-*` tests).
- Use **Chrome** for browser testing, not Edge.

## Key tabs
Generate · Import · Upload · Gallery · Comparison · Map · Tiles · **LEGO**

## Architecture (LEGO/LDraw path)
- `web/src/ui/lego.ts` — LEGO tab UI: search, auto-load chain, upload, 3D-render controls, step/explode sliders, missing-parts surfacing, **export menu** (PNG; GLB/OBJ/STL via `exporter.ts`+`viewer.exportMeshes()`; Minecraft `.schem`/`.litematic` via `voxelizeLDraw`→`BlockGrid`; parts-list **`.csv` BOM** — part/color/count from `currentBricks`). OBJ/STL bake instances (no instancing in-format) → large on big sets; GLB is the compact 3D option. The slider row label is a **Step⟷Layer toggle**: layer mode slices by quantized plate height (`viewer.setSliderMode('layer')`) and is the DEFAULT for models without STEP meta (most Studio .io exports — 71043 has 5,936 bricks and ONE step); step mode is default when real steps exist.
- `web/src/engine/ldraw-parser.ts` — MPD/LDR → `ParsedBrick[]` (world transform = parentRot×local + parentPos, recursive; det<0 → winding flip). `countSteps()` counts `0 STEP` at ANY depth (sets that nest steps in sub-assemblies, e.g. 31084, depend on this).
- `web/src/viewer/ldraw/` — the direct 3D renderer (modular):
  - `viewer.ts` — Three.js scene/renderer/camera, lighting, env, post FX, camera framing/transitions, explode, picking, export (`exportMeshes()`). **Global instancing**: ONE InstancedMesh per (part,color) across the WHOLE model (not per step) + ONE global edge `LineSegments2`. Instances/segments are sorted step-ascending; the step slider sets `InstancedMesh.count` / `LineSegmentsGeometry.instanceCount` to a binary-search prefix — so a 1226-step set (UCS Falcon) is ~300 meshes / ~950 draw calls, not thousands. Static shadow map (`shadowMap.autoUpdate=false`, refreshed on scene change). **On-demand rendering**: the rAF loop only composites when `needsRender` is set (or a camera anim / autoRotate / Stats overlay is active) — idle scenes cost ~0 GPU. **Any new state mutation that changes the picture MUST call `this.invalidate()`** (or `requestShadowUpdate()`, which also invalidates); camera moves auto-invalidate via the OrbitControls `change` listener. Dev-only `window.__ldrawViewer` hook for `renderer.info` metrics.
  - `parts.ts` — fetch/parse/resolve `.dat` geometry; module-level caches **plus a persistent IndexedDB .dat-text cache** (`craftmatic-ldraw` db; positive results only — repeat sessions load big sets with ~zero part fetches; bump `IDB_VERSION_KEY` to invalidate); `prewarmCommonParts()`; `partTextureUrls` (TEXMAP); `preloadDatTexts()` (archive-bundled parts, model-specific, cleared by `clearMpdInlines`); `unresolvedDatNames` → `viewer.unresolvedSubparts` (sub-file refs that resolved nowhere = silent holes, surfaced in status). Candidate-path order is name-shape-aware (`looksLikePrimitive` → `p/` first) with a **`p/48/` hi-res alias tail** for bare primitive refs that only exist as 48-variants (e.g. `1-12ring14`). `LDRAW_BASE = /ldraw-parts`.
  - `materials.ts` — LDraw color → THREE material (ABS / rubber / metallic / transparent / glow).
  - `types.ts` — Vec3/Triangle/Edge/PartGeom/TexturedTriangle.
- `web/src/engine/ldraw-colors.ts` — LDraw color id → hex (and → Minecraft block for voxelizer).
- Other importers: `bff-loader.ts` (BrickLink inventory → flat layout), `studio-colors.ts`, `ldd-colors.ts`.
  - `io-extractor.ts` (.io) — `extractIoModel()` returns `{text, customParts}`: tries `model.ldr` → `model2.ldr` → `modelv2.ldr` (first with type-1 lines wins) AND pulls every **`CustomParts/**/*.dat`** from the archive (Studio's user-modified `m<hash>_<date>_<time>.dat` parts + the exact primitives they need). Without CustomParts, big Technic sets silently lose pieces (42110 was missing 24). They flow `lego.ts currentCustomParts` → `viewer.load(opts.datFiles)` → `preloadDatTexts`.
  - `zip-utils.ts` + `aes-zip.ts` — ZIP reader. Handles plain DEFLATE, legacy **ZipCrypto** (pw `soho0909`), and **WinZip AES-256** (method 99, pw `soho0909`) used by older/early-access .io exports. AES = PBKDF2-HMAC-SHA1 + pure-JS AES in little-endian CTR (Web Crypto's big-endian AES-CTR is incompatible).
  - `lxf-parser.ts` (.lxf/LDD) — applies per-part LDD→LDraw origin alignment from `web/public/ldd-part-map.json` (gen: `scripts/gen-ldd-part-map.py` from clego `ldraw.xml`, 4467 parts). The intricate transform math is extracted into pure, unit-tested functions: `parseBoneTransform` (LXFML column-major→row-major), `axisAngleToMatrix`, `composeLxfPlacement` (`R_world=R_bone·R_align`, `t_world=R_bone·t_align+t_bone`, then F=diag(1,−1,1) conjugation + ×25). Angles in `ldraw.xml` are RADIANS (verified: clego's `convert_lxf.py` has a latent bug here — `math.radians()` on the already-radian value, treating π/2 as 1.57° — so OUR handling is more correct). A `<Brick>` may hold MULTIPLE `<Part>` assemblies (e.g. hinge 73983 = parts 2430+2429), each with its own designID/materials/Bone — the parser iterates every Part (not just the first), or assembly halves vanish. **Known limitation (verified, not a bug):** alignment is exact for simple/axis-aligned builds (Tree ✓) but IMPERFECT for complex models with many angled/curved parts (vehicles splay) — our output matches clego's `convert_lxf.py` reference exactly (426/487 exact rotations, 0 transposed) and that reference renders the SAME splay, so it's an inherent limit of free LDD→LDraw alignment, shared with the state-of-the-art tool, NOT a cheap fix. The Studio `.io` of the same set renders correctly (different/better alignment source) — the UI says so on big `.lxf` loads. Don't sink hours out-engineering LDD alignment without ground-truth LDD-aligned placements to test against.

## LDraw parts library — DEV vs PROD (critical)
The 3D renderer needs individual `.dat` geometry from `/ldraw-parts/*`.
- **DEV**: served by a Vite middleware in `web/vite.config.ts` from a local clego
  install (`C:/git/clego/extracted/studio_release/app/ldraw`, ~1.8 GB / 67k files),
  with an **upstream fallback** to `library.ldraw.org` on a local miss. A
  `FORCE_UPSTREAM` const (default `false`) bypasses local to mirror prod exactly.
  The fallback only caches a null on a DEFINITIVE upstream 404 (thrown fetches —
  throttling during a load burst — retry instead; concurrency capped at 6).
  Caching nulls on transient failures turned existing parts (73111 …) into
  permanently missing pieces for the whole dev session — don't reintroduce.
- **PROD**: the Cloudflare Worker (`worker/ldraw-omr.js`) proxies `/ldraw-parts/*`
  → `library.ldraw.org/library/{official,unofficial}/*` (CORS + week edge cache,
  GET+HEAD). Routed in `wrangler.toml` (`craftmatic.click/ldraw-parts/*`).
  **Must `bunx wrangler deploy` to publish.** Without this route the deployed app
  has NO geometry and silently falls back to voxelization.
- `library.ldraw.org` serves individual parts but sends **no CORS header** — must
  be proxied; cannot fetch from the browser directly. Official layout:
  `/library/official/{parts,p,parts/s,p/48}/<stem>.dat`.
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
ghost tires). Pipeline defenses now in `lego.ts`:
- `reconstructionQuality()` flags `convert_lxf.py` AND `DBIX_LXFML` headers as
  'broken'. (A color-palette fingerprint was tried and REMOVED — dead code:
  `LDRAW_COLOR_RGB` already contains the extended ids like 10047/10070, so
  table-membership can't discriminate. Don't re-add.)
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
`wrangler.toml` routes `/ldraw-omr/*` and `/ldraw-parts/*` to the Worker
(`/bff/*`, `/seymouria-ldr/*` are configured in the CF dashboard). Run
`bunx wrangler deploy` after changing the Worker or routes.
