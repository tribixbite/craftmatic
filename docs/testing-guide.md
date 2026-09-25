# Testing and browser automation

Read before validating renderer, resolver, alignment, or exporter changes. PDF-specific test harness requirements are in [PDF reconstruction](pdf-pipeline-guide.md); device QA is in [Bedrock add-ons](bedrock-addon-guide.md).

[Project guide](../CLAUDE.md). Paths in code spans are relative to the repository root unless explicitly qualified.

- Build: `bun run build:web`. Tests: `bun test` (vitest). LEGO unit tests are **offline + deterministic** — `test/ldraw-parser.test.ts` (transforms/steps/primitives), `test/io-zip.test.ts` (ZipCrypto + WinZip-AES decrypt, validated against Node's own crypto as an oracle — no large `.io` fixtures), `test/lego-colors.test.ts` (the don't-conflate-colour-systems invariant), and `test/ldraw-geometry.test.ts` (**geometry regression**: `resolvePartGeometry` triangle/edge/winding/transform signature, GPU-free via a mocked `fetch` serving synthetic `.dat` — the de-risked stand-in for visual regression), and `test/ldraw-frame.test.ts` (**the LDraw → scene/grid frame is a ROTATION**: `det = +scale³·det(R)` on the viewer's instance matrix, a printed-glyph winding check from the printed side, a baked STL's facets all outward, and the grid, `SHELL_FRAME`, `yawForFacing`, Java display entities and stair facings on the same half turn about X — the reflection that mirrored every model until 2026-09-22 cannot return silently). Export-side offline suites: `test/schem-pipeline.test.ts` (the shared export module's grid path — byte-identical to a direct encode, no re-voxelization), `test/schem-settings.test.ts` (resolution planning vs the legacy ladder as an oracle), `test/light-fill.test.ts` (sealed room lit / open porch untouched), `test/palette-lint.test.ts` (every emitted block id is a real Minecraft block), `test/schem-seeded-geometry.test.ts` (the seeded resolver short-circuits fetch and matches the networked bytes; per-part progress advances; geometry is independent of fetch timing). Prefer this pattern over the network-fetching `test/lego-pipeline.test.ts` (and the flaky live-API `test/import-*` tests). Two more from the 2026-09-08 audit: `test/part-cache-revision.test.ts` (persistent-cache identity + transitive geometry invalidation, over a fake IndexedDB that survives `vi.resetModules()` — the WARM-browser path, not an incognito one) and `test/schem-real-set.test.ts` (real set through the real export pipeline; skips without the local corpus).
## Two QA surfaces built 2026-09-22 — use them before the phone

Every semantic question in the September coaster rounds cost a 20-90 minute
device round: are the riders in the car, is the station walkable, did the
treads help, is the model drawn at 60 blocks. Most were answerable offline.
These two surfaces exist to answer them in seconds. Neither replaces the
device: neither can prove Bedrock's rendering, its per-actor render cull, form
text, ride physics, rider retention or memory.

### The operator console — `bun run console` (`tools/console/`)

http://127.0.0.1:4600. **`tools/console/inventory.ts` is the cheat sheet and the
single source of truth**: 43 operations, each with what it answers, its real
argv template with options read from that script's own argument parsing, how
its output is parsed, where its evidence lands and roughly how long it takes.
A further 15 script families are listed as deliberately NOT wired, with reasons,
so the omissions are legible. Add an operation there, not in the UI.

It SPAWNS the real entry points — nothing is reimplemented — and shows the
exact command line before running, so it teaches the CLI. A test enforces that:
every declared flag must appear in the target script's source and every entry
point must exist on disk.

Select one model or a batch: the model index filtered by set, name, free text,
year, part count, source type, `asm` state, severity and tier; a pasted or
uploaded CSV; or the packs under `output/`. The match count updates before
anything runs. Results export to CSV/JSON **carrying the filter that produced
them**, so a run is reproducible. Runs stream, survive a server restart, and
are cancellable.

Two guards worth keeping: batch dispatch pauses above 85 % CPU, sampled from
`os.cpus()` because `loadavg` reads 0 on Windows (a stray load generator cost
this project a day); and anything that publishes to R2, writes the index or
touches the device is separated, requires typing the operation id, and defaults
to `--dry-run`.

Known gaps: the index's `defects` strings never carry "window" (window defects
are report-only in geograde), so window filtering must go through the census
operation; `_pixel_perf.sh ref` takes no label; browser and device operations
are wired but unexercised.

### The walkable add-on preview (LEGO tab → "Walk add-on")

A first-person walk over a generated pack, borrowing the viewer's renderer.
It is worth trusting because it collides against **the exact blocks the pack
ships**: `web/src/engine/addon-walk.ts` over the runtime's own re-laid collider
grid and the wand's own tread plan, at 20 Hz with Minecraft's numbers — a
0.6 x 1.8 box, gravity 0.08 under 0.98 drag, a 0.42 jump peaking at 1.2522,
4.317 blocks/s, and the reach walk's own 9/16 auto-step so the two models agree
by construction. Unreachable here means unreachable in game.

The key counts figures, seats, doors, track, vehicles, colliders and treads,
each with show and highlight toggles for markers and perimeter boxes, alongside
the coaster route, station, lift travel and the reachable/unreachable overlay —
that last one is what keeps costing device time. A size selector re-lays
colliders and treads so scaling's effect on walkability is visible at once.

Below 100 % the walk module refuses by design (`ScaledColliderGrid` is defined
for f >= 1); the preview falls back to free-fly and says why.

It has already earned itself twice. It settled that 10303's station IS
reachable on foot, bare, at 100 % — a device agent had concluded otherwise and
used `/tp`. And simulating a player over the grid the BFS walks found a real
bug in the BFS: it allowed a DROP into an adjacent column without checking that
column was passable, stepping through the column's own floor into the underpass
beneath. That walk decides what the walk-through recommendation reports and
where treads are laid, so it had been claiming reachability no player had.
Fixed; the two now agree on 12,112 surfaces at 400 %.

**Moving parts (2026-09-24, `docs/bedrock-interactivity.md`).** E (or the touch
Interact button) toggles the nearest door, window, hatch, lever or turnable with
the pack runtime's own rules (double doors together, a too-small opening opened
but still blocked, no closing on the player); the leaf eases about its real
hinge and closed leaves collide and draw door-blue. Whether a DOORWAY works is
not judged by eye: `bun scripts/_ix_passability.ts <pack…>` walks the 0.6 x 1.8
player through every doorway open and closed at each size and turn over the
shipped blocks (verdicts OK / SMALL / SEALED / STEP / NO-APPROACH / FAIL, exit 1
on FAIL), `bun scripts/_ix_sweep_report.ts <sweep dir> --md=…` does it for a
whole favourites sweep, `bun scripts/_ix_doorway_map.ts <pack> <i>` prints one
doorway's collider plan, and `node scripts/_shoot_addon_walk.mjs <pack> <out.png>
model doors --door=<i> [--isolate[=shell]] [--side=back] [--elev=]` shoots a
part closed, open and after a player tried to walk through. SEALED means the
MODEL closes the approach (solid behind the leaf, a drop, a false door) - look
at it before calling it a door fault; STEP means it passed at 100 % and a riser
grew past the jump at the bigger size.

## Manual gates (Chrome + the local corpus — deliberately NOT in CI)

Run these after touching the renderer, the part resolver, the LXF/alignment
path or the exporters. Each drives the REAL app in headless Chrome against
`bun dev:web`, so none of them can run on a CI box. Output lands in
`output/visual-fixtures/<date>/`.
- **`node scripts/lego-visual-fixtures.mjs`** — 4 fixtures (10316 headgear
  close-up, 71043 foundation/tower close-ups, 10182 official-OMR control, 21309
  rotated/SNOT control), each pinning its index path AND sha256/12 `hash`, the
  camera, explode 0 and all layers, with targeted numeric assertions (headgear
  seated on its head; only the 3 documented unmodelled moulds missing; assembled
  matrices restored after 0→100→0; a pinned rotation-profile baseline). **A
  corpus change FAILS the fixture** — re-baseline it deliberately, don't widen
  the tolerance. Exit non-zero names what moved.
- **`node scripts/lego-perf-baseline.mjs`** — cold/warm load, request counts,
  draw calls/triangles, heap, forced-composite time. Numbers +
  what-is-not-claimed: `docs/lego-perf-baseline-2026-09-09.md`. Works against
  prod too (`DEV_URL=https://craftmatic.click`), minus the in-page stats — the
  `window.__ldrawViewer` hook is DEV-only.
- **`node scripts/lego-export-validate.mjs`** — OBJ/STL/GLB byte-identity
  across explode 0→100→0, plus the OBJ bbox against 8 mm/stud. Byte identity is
  a WITHIN-run statement only: dev part resolution is nondeterministic.
- **`bunx vitest run test/schem-real-set.test.ts`** — the Minecraft half. Real
  set, real pipeline, cellLDU 20/10/8, bridging on vs off. Skips silently
  without the local corpus.
- **Kill stray dev servers first.** Three `vite` processes were running at once
  (4000/4001/4002) and `/` took 264 s to answer; after killing the extras it was
  0.1 s. A load-time or "model never finished rendering" result taken on that
  box is about the box, not the code — check
  `Get-NetTCPConnection -State Listen` and the CPU before believing one.
- **`python scripts/_mcaddon_check.py <pack>.mcaddon …`** — the cheap offline gate
  for "would Minecraft load this at all". A pack can satisfy every component count
  and warning the exporter prints and still fail silently in game: a geometry an
  entity names but the pack never defines, a texture path with no file, a
  behaviour pack that does not depend on its resource pack, a script `entry` that
  is not in the archive. Those cost a whole device round to find. Run it on every
  pack before a device round; it exits non-zero on failure. Verified 2026-09-18
  over the seven named-set packs (71043, 76435, 910004, 10326, 31201, 76405):
  8/8 valid. It does NOT check content — a pack can be structurally perfect and
  still show a headless minifig.
- **`bun scripts/_entity_color_diff.ts <before>.mcaddon <after>.mcaddon`** — the
  offline colour gate. It resolves the RGBA every cube in a pack actually
  samples (geometry -> render controller -> texture binding -> decoded PNG
  texel, six-face UVs and box UV alike) and diffs the two packs cube by cube,
  keyed by entity + bone + origin + size + rotation + pivot. Use it on any
  change to how colour reaches the geometry; a colour regression that only
  shows in game is the expensive kind. It proved the box-UV rewrite left
  79,392 cubes over 71043/76286/76435 bit-identical in colour.

## Browser-automation testing caveats (claude-in-chrome — hard-won, saves hours)

- The automation tab runs **backgrounded → `requestAnimationFrame` is throttled/paused**. So **on-demand rendering means the canvas often has no fresh frame** and `Page.captureScreenshot` **times out — just retry it** (usually succeeds 2nd try). Continuous-render checks (live FPS) are unmeasurable here.
- **Enable the Stats checkbox to force continuous rendering** when you need reliable screenshots (it sets `animating=true`).
- **Editing `viewer.ts` triggers HMR which disposes the viewer → `window.__ldrawViewer` becomes null/stale.** After any viewer edit you MUST reload the page AND re-load the model before using the dev hook.
- **Synthetic pointer/wheel events don't reliably drive OrbitControls.** To move the camera, set it via the hook: `v.cameraAnim=null; v.controls.target.copy(...); v.camera.position...; v.controls.update(); v.composer.render()`. `v.setView('iso'|'front'|...)` works (it animates).
- **Verify the loaded model** (`window.__collect?.().length` or `viewer` brick count) — a 404'd `fetch('/inspect-X.io')` silently leaves the PRIOR model loaded (this mislabeled an audit once).
- Test models: copy `C:/git/clego/lego_sets/IO/<set>.io` → `web/public/inspect-*.io`, dispatch `change` on `#lego-mpd-input`, delete after (keep out of git). OMR `.mpd` fetch directly via `/ldraw-omr/<set>-1.mpd`.
- Dev-only `window.__ldrawViewer` is set in `viewer.ts` load() under `import.meta.env.DEV`.
- **A Playwright context MUST pass `serviceWorkers: 'block'` to load a set by SEARCH.** The PWA service worker installs on first load and then intercepts `/lego-models/*`; in a fresh automation context those fetches return `net::ERR_FAILED`, so the loader walks the entire source ladder and settles on *"No 3D model found — trying BL parts inventory"*. That reads exactly like a missing or broken index entry, and the same URL answers `200` to `curl`. `file:` mode hides it because the model never crosses the network. `scripts/_lego-probe.mjs` blocks them; any new script must too. Measured 2026-09-17, after two probe runs reported `{"error":"no viewer"}` against a set that loads fine.
- **`{"error":"no viewer","status":"1 set found"}` was a PRODUCTION STALL, not a
  broken set — root-caused and fixed 2026-09-18.** On `craftmatic.click` a cold
  set load never rendered: no failed request, no pending request, no console
  error, and **a second click on the same card always worked**. Measured:
  **7 of 18 sets** on the first pass (910047, 71043, 76435, 21063, 10341,
  76286, 31141), ~45 % of cold loads on a single-set harness, versus 1 of 18 on
  dev. It was never set-specific.

  Three separate defects wore that one signature. All three are fixed; the
  notes matter because each is a shape that will recur:
  1. **Duplicate models-index fetch → the selection cleared under the load.**
     `getModelsIndex()` memoised the RESULT, not the in-flight promise, so the
     user's search and the panel's own browse-all each downloaded the 3.8 MB
     index. The first rendered the cards, the user clicked, and the second
     finished a few hundred ms later and ran `selectedSet = null`. The load's
     `selectedSet !== set` guard then returned silently — and the source badge
     still reported the load as SUCCEEDED. Dev never saw it because the same
     file is a local read, so both "downloads" finish together. Fixed by
     sharing the in-flight promise, stamping the selection with the search
     generation (`selectionSeq`), and not firing browse-all once any search has
     started. Reproduce with `PROBE_SLOW_INDEX_MS=8000` (see below).
  2. **The geometry-repair pass re-probed throttled parts.** A part whose every
     candidate path 503s is deliberately left UNCACHED, so nothing memoised the
     failure and `repairIncompleteGeometry` — sequential, and reporting no
     progress — walked the whole candidate + alias ladder again for each one.
     That is the variant that freezes on `Loading geometry: N/N parts (100%)`
     with the badge stuck at `<src> · loading…`. Fixed by a per-load
     `transientMisses` memo in `parts.ts`; regression in
     `test/part-cache-revision.test.ts`.
  3. **`HEAD /ldraw-parts/parts/3001.dat` rejecting → silent voxel mode.**
     Chrome reports the discarded HEAD body as `net::ERR_ABORTED`; usually the
     promise still resolves, but one page load in 16 measured on prod REJECTED,
     the capability probe fell into its catch, and the whole tab rendered in
     voxel mode — no 3D viewer, and the viewer chunk never even fetched
     (`prodHookPatched: false` with no `index-*.js` in `routeEvents`). Fixed by
     probing with a GET, one retry, and saying so in the UI when it fails.

  So: never conclude "prod cannot render set X" from one probe run. Re-run with
  `bash scripts/_verify-sets-retry.sh <outDir> <rounds> <set>…`, which repeats
  only the sets that produced no positions dump.
- **Verified on production after the deploy (2026-09-18, build `f2f6e4b7`,
  entry chunk `index-DP71rJ7m.js`): 66 cold loads, 0 stalls.** 48 single-set
  cold runs over 8 sets plus the full 18-set review, every one a fresh browser
  context, every one reporting `indexRequests: 1`. Against the ~45 % baseline,
  0 of 66 is conclusive (0.55^66). The 18-set review matched
  `output/verify-prod-18` exactly on every tracked field — placements, meshes,
  missing parts, arm counts and ids, arm→torso LDU, isolated placements, status
  tail — and the source each set actually loaded (observed badge) equalled the
  source predicted from the index.
  - `indexRequests` is now reported on EVERY run, counted from the browser's
    own request stream, so the fix's direct signature is observable on
    production and not only under `PROBE_SLOW_INDEX_MS`.
  - Residual, not a stall: one 10303 run in six rendered 3,814 instances
    instead of 3,816 with an identical missing-parts list, on a load whose
    part fetches were 182 × 503. Two instances were lost on that throttled load.
    Offline fault injection now confirms one silent-loss mechanism: when every
    candidate path for a child subpart 503s, a parent with its own triangles is
    non-empty, so `repairIncompleteGeometry` intentionally does not re-probe it
    inside the same throttle window. The partial parent used to remain cached
    across the next load, preventing recovery, while the transient child was
    absent from the unresolved-subpart diagnostic. The next-load reset now
    invalidates the transient child's assembled ancestor closure, and the
    affected load reports the transient subpart gap. The focused regression is
    in `test/part-cache-revision.test.ts`. This does **not** prove those exact
    two 10303 instances used this mechanism—the production run did not capture
    the failed stems/dependency paths—so the historical attribution remains
    observational rather than causal.
- **The probe can inject production's timing on dev**, which is the only way to
  regression-test the class above without a deploy:
  - `PROBE_SLOW_INDEX_MS=8000` — holds every DUPLICATE `/lego-models-index.json`
    fetch until just after the set card is clicked (and delays the catalog and
    the model file, so the race has a window to land in). The result reports
    `indexFetches`: a build that shares one in-flight fetch records **1**.
  - `PROBE_FAULT_503=<pct>` — answers a deterministic slice of part stems with
    `503` on every candidate path, and drops them from the `_batch` answer, i.e.
    exactly what the worker does for an upstream-throttled part.
  - `PROBE_MODEL_MS` — the model-render ceiling (default 240 s). A stall hunt
    wants it short; a mega-set capture run wants it long.
  Every run now also reports `statusTimeline` (status/badge/stage transitions,
  timestamped) and, on a stall, a `stall` block with the viewer's internal load
  stage, its stale-bail count, and the requests still in flight.
- **A probe run that reports `no-card (cards=48)` was a HARNESS race, not an app
  failure.** The search button is created ENABLED, so waiting for "enabled"
  passes in the window before `ensureCatalog().then()` fires browse-all; the
  typed search then clicks a button browse-all disables microseconds later, and
  a click on a disabled button is a silent no-op. Browse-all paints its own 48
  cards and the probe blames the app. Measured 2026-09-18: 1 cold production run
  in 36. The probe now waits for evidence that the panel's own search EXISTS
  (button seen disabled, or cards on screen) before trusting "enabled", and a
  search-stage failure writes a `<set>-probe.json` with the status line, badge,
  card texts, index-fetch outcomes and in-flight requests instead of exiting
  bare — that run left nothing behind to diagnose.
- **Three benign artifacts appear on EVERY production page load.** All three
  were mis-read as the cause of the stall above; none of them is.
  `net::ERR_ADDRESS_INVALID` is Cloudflare's analytics beacon (the probe already
  filters it). `net::ERR_ABORTED …/ldraw-parts/parts/3001.dat` is the panel's own
  `HEAD` capability probe (`web/src/ui/lego.ts`): Chrome reports the discarded
  body as a request failure while `fetch()` still resolves `ok` — measured
  10/10 on prod AND 3/3 on dev, with direct-render enabled every time. The two
  `404`s are `/lego-thumbs/<set>-1.jpg`: those 23,711 thumbnails are 8.5 GB and
  git-ignored, so they exist in dev and never deploy; the `onerror` handler falls
  back to the Rebrickable CDN url.
- **`/ldraw-parts/*` behaves differently on prod and it is expected.** Printed and
  unofficial parts that are not in the R2 mirror are relayed to
  `library.ldraw.org`, which throttles a cold big-set load; the worker relays
  that as `503 no-store` so the client retries instead of caching a miss.
  Measured on a 10303 prod load: 91 of 200 individual part fetches returned 503
  and the model still rendered all 3,808 placements. Dev serves those from disk,
  so a dev run never sees them.

## In-game automated tests (GameTest)

**Verdict (2026-09-24): use it — for everything the server can observe.**
Bedrock's GameTest framework runs on the Pixel, driven from adb with no taps
beyond world creation, and reports through the content log, which adb pulls.
It replaces the tap-and-screenshot rounds for placement, doors/passability,
seats and state changes; it does not replace the device for touch picking,
rendering, culling, form text or the camera.

**What was measured on the Pixel 8 Pro (Minecraft 1.26.51, run 1, evidence in
`output/gametest/41732/device/`):**

- A world made in the UI with experiments OFF, then its `level.dat` rewritten
  IN PLACE over adb with `experiments.gametest = 1` + `commandsEnabled = 1`
  (`scripts/_leveldat_experiments.py`, which refuses to write unless nbtlib
  round-trips the original byte-for-byte), shows the **Experimental** badge
  (`play-list-experimental-badge.jpg`) and loads `@minecraft/server-gametest`
  1.0.0-beta. A UI-created Creative world had `commandsEnabled = 0`; the flip
  enabled it. Minecraft must be stopped while the file is written.
- The test pack auto-ran on world load: `player.runCommand('gametest runset
  craftmatic_gt')` → successCount 1; tests placed their structure, spawned
  simulated players and wrote `CMGT …` lines to the content log
  (`contentlog-run1.txt`). A test's own pass/fail message goes to CHAT only,
  never to the content log — report every verdict yourself with
  `console.warn` (it is kept at any log level).
- **A pack without `@minecraft/server-gametest` sees `undefined` in
  `world.getAllPlayers()` for every simulated player.** The model pack's
  placement loops threw `cannot read property 'id' of undefined` 845 times in
  two minutes and its hook could not find the test player by name, so the doors
  test timed out before placing. The test variant now declares the module too;
  the shipped placement runtime should also skip `undefined` players
  (not done: that file belongs to other in-flight work).
- Relative `y = 0` of the test read `minecraft:air`, not the arena's floor
  layer, and the smoke player moved 1.04 blocks in 60 ticks. The runtime now
  finds the floor by scanning for the smooth stone and logs the column; run 2
  (packs built, below) is what confirms the fix. **Run 2 was not done**: a
  second device session took the phone at 21:00 and this work stopped rather
  than contend for it.

**What GameTest can do for us** (`@minecraft/server-gametest` 1.0.0-beta is the
only version 1.26.5x ships; typings:
`https://unpkg.com/@minecraft/server-gametest@1.0.0-beta.1.26.51-stable/index.d.ts`;
its peer range accepts stable `@minecraft/server` 2.x, and Mojang's own
creator-tools pack pairs stable server 2.7.0 with it):

- `register`/`registerAsync(class, name, fn)` + `.structureName()`,
  `.maxTicks()`, `.tag()`, `.batch()`; `/gametest run <class:name>`,
  `runset <tag>`, `clearall`, `stopall`. Each test needs a structure
  (default `<class>:<name>` → `structures/<class>/<name>.mcstructure`); we
  generate an arena (smooth-stone floor + air) with `mcstructure-encode.ts`.
  One structure caps at 64 x 384 x 64, so the arena caps a model at 58 x 58
  footprint (TODO: tile or use `structureLocation` for bigger sets).
- `test.spawnSimulatedPlayer` (also module-level `spawnSimulatedPlayer` outside
  a test): `moveToLocation`/`navigateToLocation` (walks with real collision —
  **passability**), `interactWithEntity`/`attackEntity` (the server-side
  interaction our door/seat/pinball scripts subscribe to), `jump`, `lookAt*`,
  `useItem*`, `setItem`/`selectedSlotIndex` (the pinball hotbar flippers),
  `chat`, `teleport`; assertions `assertEntityPresent`, `assertBlockState`,
  `assertCanReachLocation`, `succeedWhen`, `until`, `idle(ticks)`.
- **What it cannot prove**: touch picking (which entity a finger hits — the
  pinball zones needed rendered geometry to be tappable), the camera,
  `setRotation` pitch on a phone, form (`server-ui`) answers — a simulated
  player cannot answer a form, which is why the Brick Wand is bypassed — and
  anything drawn (culling, textures, LOD). Keep screenshots for those.

**The prototype** (`web/src/engine/gametest-pack.ts`,
`scripts/_gametest_pack.ts`, `test/gametest-pack.test.ts`):

```bash
bun scripts/_gametest_pack.ts <pack.mcaddon> --out=output/gametest/<id> [--debugger=<pc-ip>:19144]
python -u scripts/_pixel_dev_deploy.py cmgametest output/gametest/<id>/*-gt-variant.mcaddon output/gametest/<id>/*-gametests.mcaddon --mode import
# open world "cmgametest" (Play list, 120 ms press); the tests run 10 s after spawn
MSYS_NO_PATHCONV=1 adb exec-out cat /sdcard/Android/data/com.mojang.minecraftpe/files/games/com.mojang/logs/<newest ContentLog> | grep -a 'CMGT '
```

It emits a **variant** of the model's behaviour pack (new uuids, build-time
version so a rebuild re-imports, `@minecraft/server-gametest` declared, and a
`craftmatic_gt:place` scriptevent hook injected into `placement.js` that calls
the pack's OWN `place()` for a named player — the injection throws if the
runtime's shape changed) and a **GameTest pack** with two tests:
`craftmatic_gt:smoke` (spawn + walk) and `craftmatic_gt:doors_<id>` (place the
model at 100 %, then for every doorway: walk it closed, `interactWithEntity`
the leaf, read the leaf's `craftmatic:angle` actor property, walk it open).
Each doorway's start/end and expected outcome come from the offline walk
(`interactive-walk.ts`), so a device row is also a check of that harness; one
`CMGT DOOR {…}` line per doorway, `CMGT SUMMARY` at the end, then ~18 KiB of
padding so the block-buffered log flushes. It also answers the open question
in `docs/bedrock-interactivity.md`: whether `playerInteractWithEntity` fires
for an entity with only `minecraft:interact` (`interactReturned` +
`angleAfterInteract`). A `craftmatic_gt:probe` scriptevent (and one automatic
pass after the run) tries `script profiler start/stop`, `script diagnostics
startcapture/stopcapture` and `script debugger connect <host> <port>` from a
script and logs whether each is allowed — unmeasured, run 1 ended before it.

Use the dedicated world **cmgametest** (folder `nRnt66NBH0Y=`, flat,
Creative, Beta APIs on) — never world 924 or any play world: an experiment
cannot be turned off and disables achievements.

**Other creator tooling:**

- Content log file + UI: already on; the file is the channel above.
- **Turn on the script watchdog's slow/spike warnings** (Settings → Creator):
  they land in the same content log, cost nothing, and would have flagged the
  per-tick `getEntities` loops that the profiler guide warns about.
- Script profiler: `/script profiler stop` writes a `.cpuprofile` (Mojang's
  docs: the logs folder; community reports: `<world>/profiling/`); both are
  adb-readable. Open it in VS Code or Chrome DevTools. Useful for the pinball
  and coaster tick loops.
- VS Code debugger (Mojang's "Minecraft Bedrock Edition Debugger", launch
  `mode: "listen"`, port 19144; the phone runs `/script debugger connect
  <pc-ip> 19144`). Over the LAN this needs the PC's firewall open for inbound
  19144 and the unminified source for breakpoints. Useful for a live bug on the
  device, not for regression testing; untested on the Pixel.
- Client diagnostics (`/script diagnostics startcapture`): unmeasured.
