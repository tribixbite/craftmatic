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
- `web/src/ui/lego.ts` — LEGO tab UI: search, auto-load chain, upload, 3D-render controls, step/explode sliders, missing-parts surfacing.
- `web/src/engine/ldraw-parser.ts` — MPD/LDR → `ParsedBrick[]` (world transform = parentRot×local + parentPos, recursive; det<0 → winding flip). `countSteps()` counts `0 STEP` at ANY depth (sets that nest steps in sub-assemblies, e.g. 31084, depend on this).
- `web/src/viewer/ldraw/` — the direct 3D renderer (modular):
  - `viewer.ts` — Three.js scene/renderer/camera, InstancedMesh per (part,color), step groups, lighting, env, post FX, camera framing/transitions, explode, picking.
  - `parts.ts` — fetch/parse/resolve `.dat` geometry; module-level caches; `prewarmCommonParts()`; `partTextureUrls` (TEXMAP). `LDRAW_BASE = /ldraw-parts`.
  - `materials.ts` — LDraw color → THREE material (ABS / rubber / metallic / transparent / glow).
  - `types.ts` — Vec3/Triangle/Edge/PartGeom/TexturedTriangle.
- `web/src/engine/ldraw-colors.ts` — LDraw color id → hex (and → Minecraft block for voxelizer).
- Other importers: `lxf-parser.ts` (.lxf/LDD), `io-extractor.ts` (.io, ZipCrypto pw `soho0909`), `bff-loader.ts` (BrickLink inventory → flat layout), `studio-colors.ts`, `ldd-colors.ts`.

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

## Deploy
Cloudflare: static build (`web/dist`) + Worker (`worker/ldraw-omr.js`).
`wrangler.toml` routes `/ldraw-omr/*` and `/ldraw-parts/*` to the Worker
(`/bff/*`, `/seymouria-ldr/*` are configured in the CF dashboard). Run
`bunx wrangler deploy` after changing the Worker or routes.
