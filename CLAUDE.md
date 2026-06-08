# Craftmatic — Project Guide

Minecraft schematic toolkit **and** an LDraw (LEGO) 3D viewer, web UI in `web/`
(Vite + TypeScript + Three.js). This file is the version-controlled source of
truth for architecture + hard-won conventions. Keep it current; do not keep
durable project knowledge only in private/agent memory.

## Dev / commands
- Dev server: `bun dev:web` (port 4000). Add `--host` to expose on LAN (phone testing at the box's LAN IP:4000).
- Typecheck: `node_modules/.bin/tsc --noEmit -p web/tsconfig.json` (NOTE: several pre-existing errors in unrelated `web/src/ui/*` files; the LDraw viewer + engine modules are clean. The app builds via Vite/esbuild which doesn't type-gate.)
- Build: `bun run build:web`. Tests: `bun test` (vitest).
- Use **Chrome** for browser testing, not Edge.

## Key tabs
Generate · Import · Upload · Gallery · Comparison · Map · Tiles · **LEGO**

## Architecture (LEGO/LDraw path)
- `web/src/ui/lego.ts` — LEGO tab UI: search, auto-load chain, upload, 3D-render controls, step/explode sliders, missing-parts surfacing, **export menu** (PNG; GLB/OBJ/STL via `exporter.ts`+`viewer.exportMeshes()`; Minecraft `.schem`/`.litematic` via `voxelizeLDraw`→`BlockGrid`; parts-list **`.csv` BOM** — part/color/count from `currentBricks`). OBJ/STL bake instances (no instancing in-format) → large on big sets; GLB is the compact 3D option.
- `web/src/engine/ldraw-parser.ts` — MPD/LDR → `ParsedBrick[]` (world transform = parentRot×local + parentPos, recursive; det<0 → winding flip). `countSteps()` counts `0 STEP` at ANY depth (sets that nest steps in sub-assemblies, e.g. 31084, depend on this).
- `web/src/viewer/ldraw/` — the direct 3D renderer (modular):
  - `viewer.ts` — Three.js scene/renderer/camera, lighting, env, post FX, camera framing/transitions, explode, picking, export (`exportMeshes()`). **Global instancing**: ONE InstancedMesh per (part,color) across the WHOLE model (not per step) + ONE global edge `LineSegments2`. Instances/segments are sorted step-ascending; the step slider sets `InstancedMesh.count` / `LineSegmentsGeometry.instanceCount` to a binary-search prefix — so a 1226-step set (UCS Falcon) is ~300 meshes / ~950 draw calls, not thousands. Static shadow map (`shadowMap.autoUpdate=false`, refreshed on scene change). **On-demand rendering**: the rAF loop only composites when `needsRender` is set (or a camera anim / autoRotate / Stats overlay is active) — idle scenes cost ~0 GPU. **Any new state mutation that changes the picture MUST call `this.invalidate()`** (or `requestShadowUpdate()`, which also invalidates); camera moves auto-invalidate via the OrbitControls `change` listener. Dev-only `window.__ldrawViewer` hook for `renderer.info` metrics.
  - `parts.ts` — fetch/parse/resolve `.dat` geometry; module-level caches; `prewarmCommonParts()`; `partTextureUrls` (TEXMAP). `LDRAW_BASE = /ldraw-parts`.
  - `materials.ts` — LDraw color → THREE material (ABS / rubber / metallic / transparent / glow).
  - `types.ts` — Vec3/Triangle/Edge/PartGeom/TexturedTriangle.
- `web/src/engine/ldraw-colors.ts` — LDraw color id → hex (and → Minecraft block for voxelizer).
- Other importers: `bff-loader.ts` (BrickLink inventory → flat layout), `studio-colors.ts`, `ldd-colors.ts`.
  - `io-extractor.ts` (.io) — tries `model.ldr` → `model2.ldr` → `modelv2.ldr`, first with type-1 lines wins.
  - `zip-utils.ts` + `aes-zip.ts` — ZIP reader. Handles plain DEFLATE, legacy **ZipCrypto** (pw `soho0909`), and **WinZip AES-256** (method 99, pw `soho0909`) used by older/early-access .io exports. AES = PBKDF2-HMAC-SHA1 + pure-JS AES in little-endian CTR (Web Crypto's big-endian AES-CTR is incompatible).
  - `lxf-parser.ts` (.lxf/LDD) — applies per-part LDD→LDraw origin alignment from `web/public/ldd-part-map.json` (gen: `scripts/gen-ldd-part-map.py` from clego `ldraw.xml`, 4467 parts). Compose: `R_world=R_bone·R_align`, `t_world=R_bone·t_align+t_bone`, then Y-flip + ×25. Angles in `ldraw.xml` are RADIANS. Without this, .lxf parts float/mis-rotate.

## LDraw parts library — DEV vs PROD (critical)
The 3D renderer needs individual `.dat` geometry from `/ldraw-parts/*`.
- **DEV**: served by a Vite middleware in `web/vite.config.ts` from a local clego
  install (`C:/git/clego/extracted/studio_release/app/ldraw`, ~1.8 GB / 67k files),
  with an **upstream fallback** to `library.ldraw.org` on a local miss. A
  `FORCE_UPSTREAM` const (default `false`) bypasses local to mirror prod exactly.
- **PROD**: the Cloudflare Worker (`worker/ldraw-omr.js`) proxies `/ldraw-parts/*`
  → `library.ldraw.org/library/{official,unofficial}/*` (CORS + week edge cache,
  GET+HEAD). Routed in `wrangler.toml` (`craftmatic.click/ldraw-parts/*`).
  **Must `bunx wrangler deploy` to publish.** Without this route the deployed app
  has NO geometry and silently falls back to voxelization.
- `library.ldraw.org` serves individual parts but sends **no CORS header** — must
  be proxied; cannot fetch from the browser directly. Official layout:
  `/library/official/{parts,p,parts/s,p/48}/<stem>.dat`.
- Parts that never resolve (LSynth `lsNN.dat` flexible parts → need curve
  synthesis; a few set-custom OMR subparts like Red Baron `s100241`) are surfaced
  in the LEGO-tab status + console via `viewer.missingParts` — not silent.

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
- **Geometry is verified correct** at the fundamental level (flush controlled
  stack at exact heights; ~0 duplicate placements; ~0 isolated bricks; matches
  official box images). The historic "overlap/float/flicker" reports were the
  two rendering bugs above, not placement errors.

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
- **Geometry-contact (browser, primary)**: `viewer.auditConnectivity(resLDU=4)` voxelizes each part's triangle SURFACE, transforms per instance, unions pieces whose surfaces share/neighbour a voxel → connected components. `viewer.highlightDetached(resLDU)` recolors non-main pieces red to eyeball them. `web/src/viewer/ldraw/connectivity-audit.ts`. **It detects face contact (stud-stacking, flush) but is BLIND to clip/bar/pin/SNOT grips.** Result: traditional builds → one 100% component (21063 verified); SNOT/microscale (71043) under-counts but `highlightDetached` shows the "detached" pieces are embedded base/spires → **no floaters**.
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
