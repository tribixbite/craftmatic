# LEGO viewer — load-time & reliability task list (2026-08-29)

Written after code inspection of `web/src/viewer/ldraw/viewer.ts` (load(),
buildStepGroup(), getSharedGeom()), `web/src/viewer/ldraw/parts.ts`,
`web/src/ui/lego.ts` (voxelizeAndDisplay, getModelsIndex), and
`web/public/sw.js`. Baseline = what shipped 2026-08-29: batched
`/ldraw-parts/_batch`, same-origin brotli models/index, async time-sliced
buildStepGroup, parallel single-attempt miss probing, mecabricks-variant
base fallback. Measured after those: UCS Falcon ~97 s cold / ~31 s warm.

Sizes: S ≤ ½ day · M ≈ 1-2 days · L ≥ 3 days. Ordered by user impact.

## Priority order (both areas merged)

1. R1 real WebGL context-loss recovery (S/M) — turns dead pages into a 2 s blip
2. R2 global error boundary + in-app retry (S) — no more browser error page
3. P1 raise part-fetch concurrency (S) — biggest remaining cold-load lever
4. P2 progressive first paint (M) — perceived load time cut drastically
5. R3 pre-allocation memory guard + auto-degrade (M) — prevents the OOM kills
6. P3 persist converted geometry in IDB (M) — warm loads ~2× faster
7. P4 per-set parts manifest (M) — removes candidate probing entirely
8. R4 SW versioning + update prompt (S)
9. P5 worker-side normals (M/L) — only after P3; may become unnecessary
10. P6 edge-buffer memory diet (M)
11. P7 index off the main thread (S)
12. R5 crash breadcrumb log (S)

---

## Area 1 — load time

### P1. Raise the top-level part-fetch concurrency (S)
`viewer.ts` load(), line ~495: `CONCURRENCY = 12` was tuned to protect
library.ldraw.org from probe bursts. With `/ldraw-parts/_batch` that limit
now STARVES the batcher: at most 12 parts enqueue per 20 ms window, so
batches go out ~¼ full (measured 200 batch requests on a cold Falcon where
~40 would do) and total fetch wall-time ≈ (uniqueParts/12) × RTT instead of
(uniqueParts/48) × RTT. Change: `CONCURRENCY = 48` when batching is enabled
(export a `isBatchingEnabled()` from parts.ts), keep 12 as the fallback
value. Also consider raising `BATCH_MAX` 48 → 64 (the worker already accepts
64). Expected: cold fetch phase roughly 2-3× faster; one-line risk.

### P2. Progressive first paint — show the model while it builds (M)
`viewer.ts` buildStepGroup() already yields every 24 ms but adds ALL meshes
to a detached group that only hits the scene after the FULL build (and the
warp overlay owns the frame until load() ends). Change: add the group to the
scene up front, `this.invalidate()` every yield slice, and end the warp when
the first ~25 % of buckets are built (keep a small corner progress chip for
the rest); shadow-map refresh + SAO stay deferred to build end. Expected:
user sees the model assembling seconds in — on a Falcon the perceived wait
drops from ~90 s to ~15 s even though total time is unchanged. Care:
applyStepVisibility/step slider must stay disabled until sort-finalized.

### P3. Persist CONVERTED geometry, not just .dat text, in IndexedDB (M)
`parts.ts` caches raw .dat TEXT in IDB; every load still re-parses text →
triangle soup and getSharedGeom() re-runs mergeVertices + toCreasedNormals
per unique part on the main thread (the dominant build-phase CPU: ~1-4 ms
small parts, 30-80 ms big panels/baseplates, × ~400 unique parts). Change: a
second IDB store `geom-v1` keyed by (partId, geomKey) holding the post-
crease `position`+`normal` Float32Arrays (structured-clonable); getSharedGeom
checks it before converting, writes after. Bump key on crease-angle changes.
Expected: warm-load build phase ~2× faster (Falcon ~31 s → ~15-20 s);
storage cost ~30-80 MB for a heavy user — add an LRU cap like the text store.

### P4. Per-set parts manifest — skip candidate paths entirely (M)
Even batched, the client submits 3-8 candidate names per part because it
cannot know the resolving directory. The corpus already has the ground truth:
`output/_ldraw_r2_done.txt` (48,903 keys). Change: publish it to R2 as a
compact `ldraw-manifest.json` ({stem: dir} — ~300 KB brotli), fetch+IDB-cache
it once per session in parts.ts, and resolve each part to its EXACT path
(batch shrinks to 1 name/part; misses skip straight to the upstream volley).
Expected: batch payloads ~4× smaller, ~0 wasted R2 gets, missing-part
detection instant. Also fixes the "one 503 poisons a name" class since fewer
requests fly. Worker change optional (manifest is a static R2 object).

### P5. Move mergeVertices/toCreasedNormals into a Web Worker (M/L)
Only if P3 leaves the build phase dominant on cold loads. `viewer.ts`
getSharedGeom() is pure array-in/array-out — a worker (pattern exists in
`web/src/engine/voxelize-worker.ts`) can convert parts in parallel with the
fetch phase and transfer buffers back. Complexity: worker lifecycle +
ordering with the LRU cache; time-slicing already removed the jank, so this
buys wall-time only. Expected: cold build phase overlapped into fetch phase
(≈ free on multi-core), but re-evaluate after P3/P1 land.

### P6. Edge-geometry memory diet (M)
buildStepGroup collects `segPos`/`segColor` as PLAIN JS number arrays (8 B
per element ×6 per segment → a 2.5 M-segment set peaks ~120 MB in JS arrays
before the Float32Array copy, ~360 MB total transient) — this is the
build-phase OOM suspect on mobile. Change: collect directly into growable
Float32Array chunks (or pre-count segments per part: `geom.edges.length` is
known before the loop); drop `segColor` to a Uint16Array of color ids and
tint at copy time. Consider a `THREE.LineSegments` (GL_LINES, 1-px) fallback
under memory pressure instead of dropping edges entirely (ties into R3).
Expected: ~3× lower transient memory; mega-set mobile loads stop dying.

### P7. Parse the 2.4 MB index off the main thread (S)
`lego.ts` getModelsIndex() does `r.json()` on the main thread (~100-500 ms
jank at first search on mobile). Change: fetch in a tiny worker or use
`response.body` streaming + `JSON.parse` in a worker; or simply defer —
kick the fetch at tab-open (it already fires at line ~1031 lazily) so the
parse happens before the user's first click. Low impact, cheap.

### P8. prewarmCommonParts timing (S)
`lego.ts` line ~235 fires prewarm on 3D-toggle init — it now goes through
the batcher (1 request for ~40 parts) which is nearly free; verify it fires
on TAB OPEN (not first load) so the common-part batch is IDB-warm before
the first model. One-line move; micro.

---

## Area 2 — reliability ("this page failed to load" / dead viewer)

### R1. Real WebGL context-loss recovery (S/M)
`viewer.ts` ~line 432: `webglcontextlost` only cancels the rAF and
`webglcontextrestored` only restarts it — after a genuine loss the WebGL
resources (programs, composer/SAO render targets, shadow maps, env PMREM)
are gone; the restored context renders black, and when the browser does NOT
restore (GPU OOM eviction — the common case after big-set loads) the panel
is permanently dead. Change: on `contextrestored`, dispose + rebuild the
renderer/composer/env (extract the setup from `create()` into
`initRenderer()`), re-add the model group (geometry/materials live in JS
heap and survive), `requestShadowUpdate()`. If no restore within ~4 s, tear
down and show the R2 error card with a "Reload viewer" button that
re-creates the viewer and calls `load(currentBricks)` (lego.ts already keeps
`currentBricks`). Expected: the most common hard-death becomes a 2 s blip.

### R2. Global error boundary with in-app retry (S)
No `window.onerror`/`unhandledrejection` handlers exist anywhere in web/src
(verified by grep). A thrown error during load leaves the warp overlay
spinning forever; an OOM/renderer kill shows the browser's own error page.
Change (`web/src/main.ts` + a small `web/src/ui/error-boundary.ts`):
register both handlers; on error during a LEGO load, end the warp overlay,
show a dismissible card ("Something broke rendering this model — Retry /
Report") wired to re-run the last load; log via R5. Also wrap
`voxelizeAndDisplay`'s direct-render try/catch (lego.ts ~1769) to end the
warp in `finally` — today a throw after `warp.begin()` strands the overlay.
Expected: users never meet a dead page for JS-level failures.

### R3. Memory guard: estimate before allocating, degrade instead of dying (M)
The browser error page ("Aw, Snap"-class) on big sets is OOM, not JS. All
the big allocations are PREDICTABLE before they happen: triangle count ×
48 B (positions+normals), segment count × ~56 B (LineSegments2 instanced
buffers), ×2 when mirror reflections clone materials. Change: in load()
after the prefetch phase, sum `geom.tris.length`/`geom.edges.length` ×
instance counts (already computed for the edge budget), compare against a
budget derived from `navigator.deviceMemory`/`performance.memory` (fallback
1 GB mobile / 3 GB desktop): over-budget → progressively disable (1) mirror
reflections, (2) edges (existing edgesDroppedForSize path), (3) SAO +
shadow-map, (4) halve pixel ratio, and surface what was degraded in the
status line. Expected: mega sets on phones render reduced instead of
killing the tab. Pairs with P6.

### R4. Service-worker versioning + update prompt (S)
`web/public/sw.js` is network-first with skipWaiting/clients.claim (good —
verified), but `CACHE_NAME = 'craftmatic-v1'` is a constant: the offline
fallback can serve an OLD `index.html` referencing hash-named assets that no
longer exist (→ "failed to load" when flaky-offline), and cached entries
never invalidate. Change: stamp CACHE_NAME with the build hash at build time
(vite define / a generated `sw-version.js` import), pre-cache the built
asset manifest instead of just `./`, and post a message to clients on
activate so the app can show "Updated — reload" toast. Expected: eliminates
the stale-shell/purged-asset mismatch class after deploys.

### R5. Crash breadcrumbs for the next session (S)
Nothing records why a session died. Change: a 20-line module that writes a
rolling breadcrumb (`localStorage['craftmatic-crumb']`: last action, set
number, phase, timestamp) at load-phase transitions (lego.ts newLoadEpoch,
viewer.ts load() stages) plus R2's error payloads; on next boot, if the
previous crumb shows a mid-load death, console.warn it and offer "resume
last set?" — and it gives us user-reportable evidence. Expected: converts
"it crashed sometime" reports into actionable phase-tagged data.

### R6. Watchdog for a stuck warp overlay (S)
The warp owns the panel while `warp.running`; any silent stall (network
hang beyond timeouts, a bug in a load stage) leaves an infinite starfield
with no escape. Change (`warp-loader.ts` + viewer load()): if no
setProgress() call for 45 s, surface a "Still working… / Cancel" button on
the overlay that bumps loadSeq (cancels the load) and restores the previous
scene. Expected: no un-dismissable loading screens.
