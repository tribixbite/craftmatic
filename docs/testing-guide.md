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

**Verdict (2026-09-24): use it for everything the server can observe.** On
the Pixel 8 Pro (Minecraft 1.26.51), Bedrock's GameTest framework placed
41732 with the pack's own placement code, walked all six doorways closed and
open, sat a simulated player in 11374's pinball seat, and pulsed each flipper
from the hotbar, sampling the flipper angles every tick. Every verdict went
to the content log, which adb pulls. No taps were needed after the world was
created. This replaces tap-and-screenshot rounds for placement,
doors/passability, seats, flippers and other state changes. It does not
replace the phone for touch picking, rendering, culling, form text or the
camera.

### Commands

```bash
bun scripts/_gametest_pack.ts <pack.mcaddon> --out=output/gametest/<id> [--debugger=<pc-ip>:19144]
python -u scripts/_pixel_dev_deploy.py cmgametest output/gametest/<id>/<stem>-gametest.mcaddon --mode import
# bind ONE test variant at a time: each runs `gametest runset craftmatic_gt` on load
# open world "cmgametest" (Play list, 120 ms press); the tests start 10 s after spawn
MSYS_NO_PATHCONV=1 adb exec-out cat /sdcard/Android/data/com.mojang.minecraftpe/files/games/com.mojang/logs/<newest ContentLog> | grep -a 'CMGT '
```

Under Git Bash, `adb exec-out cat /sdcard/...` without `MSYS_NO_PATHCONV=1`
reads a path that MSYS has rewritten, so every read comes back empty. A `/`
typed through `adb shell input text /` turns into `C:/Program Files/Git/`
in the same way.

The world is **cmgametest** (folder `nRnt66NBH0Y=`, flat, Creative, Beta APIs
on). Never use world 924 or any world someone plays in: an experiment cannot
be turned off, and it disables achievements.

### Results on the Pixel (evidence in `output/gametest/`)

| run | what | result |
|---|---|---|
| `41732/` | world created in the UI with experiments off, then `level.dat` rewritten in place (`scripts/_leveldat_experiments.py`) | "Experimental" badge on the Play list; `gametest` + `commandsEnabled` survive the game's own saves (`41732-run2/device/level.dat.before-run2`). The UI created a Creative world with commands **off**. |
| `41732-run3/` | tests in a SEPARATE pack | a simulated player is `undefined` in the model pack's `getAllPlayers()` (`undefinedPlayers: 2`), even though that pack declared `server-gametest`. Door interactions from the simulated player never reached the model pack |
| `41732-run5/` | tests INSIDE the model pack | floor found at relative y 1; placement through the hook: 16/16 actors; **6/6 doorways as the offline walk predicts**. Doors 1, 2, 4, 5 and 6 are blocked closed and walkable open. Door 3 (SEALED): the open walk drops 3.25 blocks off the far side (`fell`) |
| `11374-run1/` | pinball seat + flippers | `interactWithEntity(seat)` **seats** the player (the engine's rideable, no script). The runtime tags the player and parks the hotbar on slot 4 immediately. Slot 3: left flipper at 35.0° for 6 ticks, then 15°, then 0°. Slot 5: right flipper 180° for 7 ticks. Tap-zone hit: right flipper 180° for 6 ticks. Slot re-parked to 4 each time. In chat: "All required tests passed" |
| pinball `7234854a` (2026-09-25, `output/pb0924f/device/gt-contentlog-1.txt` in the pinball worktree) | seat, flippers, flipper targets, plunger | Right flipper now reads **−35.04** (the ±180 seam fix, `71c98317`). Each flipper target moves only its own flipper (`targetHits` [[0,35],[35,0]]). The plunger target's pull rises 0.04 a tick to 0.79 over 20 ticks, and after the second hit the ball offset `craftmatic:bu` reaches −665 LDU (up the lane). PASS. The same log held 11,969 "unknown variable" Molang errors: the ball's variables were not declared in `initialize` (fixed in `af917a0f`). |

Findings a device round would not have reached:

- **The tests must ship inside the model's own behaviour pack.** Only the
  pack that spawned a simulated player can see it. `scripts/_gametest_pack.ts`
  therefore emits one test variant of the model pack. It keeps the model's
  files and adds new uuids, a build-time version (so a rebuild re-imports),
  `@minecraft/server-gametest` 1.0.0-beta, a `craftmatic_gt:place` hook
  injected into `placement.js`, and `scripts/gametest.js` with its arena
  `.mcstructure`. The hook refuses to build if the runtime changed shape.
  Main's `.filter(Boolean)` on player loops (`197fc454`) stopped the crashes
  in every other pack.
- **A simulated player's `interactWithEntity` on a door raised no
  `playerInteractWithEntity` event** (0 events on every doorway). Its
  `attackEntity` raised `entityHitEntity` (1 per doorway), and that toggled
  every leaf. A real touch was not measured, so the open question in
  `docs/bedrock-interactivity.md` stays open for the interact route. The hit
  route works.
- **Double doors move together.** Opening Door 2 also opened Door 4, so each
  doorway is closed first before its own walk.
- **The right flipper's property read 180** during a pulse while the left
  read 35: the unwrapped swing crossed the ±180 seam and was clamped. Fixed
  in `71c98317`. The 2026-09-25 run reads −35 and shows the flip on screen.
- **Two test variants bound in one world break each other.** On 2026-09-25 a
  21360 figures variant and the 11374 pinball variant were bound together in
  `cmgametest`. Both placement hooks answered, and the pinball placement came
  back `actorsFound 0` (`seat: false`). Bind exactly one variant per run.
- A test's own pass/fail message goes to chat only, not to the content log.
  The runtime writes one `CMGT <TAG> {json}` line per result with
  `console.warn`, followed by about 18 KiB of padding so the block-buffered
  log flushes. The padding also scrolls through the on-screen log UI.
- `SimulatedPlayer.moveToLocation` takes **test-relative** coordinates; a
  world position sent the walker to origin + position. A structure's
  layer 0 lands at relative y 1.

### What GameTest can and cannot do for us

`@minecraft/server-gametest` 1.0.0-beta is the only version 1.26.5x ships.
Typings:
`https://unpkg.com/@minecraft/server-gametest@1.0.0-beta.1.26.51-stable/index.d.ts`.
It pairs with a stable `@minecraft/server`: its peer range accepts 2.x, and
Mojang's creator-tools pack pairs it with stable 2.7.0.

What it can do:

- Register tests: `register`/`registerAsync` with `.structureName`,
  `.maxTicks`, `.tag` and `.batch`.
- Run them: `/gametest runset <tag>`, `run`, `clearall`. `player.runCommand`
  works from a script.
- Each test needs a structure; we generate the arena with
  `mcstructure-encode.ts`. One structure caps a model at 58 x 58 blocks
  (TODO: tile it).
- Drive simulated players: move with real collision, `interactWithEntity`
  (mounts rideables), `attackEntity`, `selectedSlotIndex`, `jump`, `useItem*`
  and `teleport`.

What it cannot prove, so keep screenshots for these:

- Touch picking.
- The camera, and pitch on the phone.
- `server-ui` forms: a simulated player cannot answer them, which is why the
  Brick Wand is bypassed.
- Anything drawn: culling, textures, LOD.
- Whether a real tap raises `playerInteractWithEntity`.

### Other creator tooling

- **Content log file + UI:** on; they carry the results above.
- **Script watchdog slow/spike warnings:** turn them ON in Settings → Creator.
  They write to the same log, and GameTest runs are the right moment to catch
  the per-tick `getEntities` loops.
- **`/script profiler`, `/script diagnostics`, `/script debugger connect`:**
  not usable from our scripts. Run from the dimension and as the real player,
  every one returned successCount 0 (`11374-run1/device/contentlog-run1.txt`),
  and a PC listener on 19144 received no connection. Typed in chat on the
  phone, `/script profiler start` / `stop` gave no chat output and left no
  `.cpuprofile` under `/sdcard/Android/data/com.mojang.minecraftpe/files`.
  Mojang's docs describe these for Windows and dedicated servers. Treat them
  as unavailable on the Pixel until a Creator toggle (script debugger /
  diagnostics) is tried.
- **VS Code debugger** (Mojang's "Minecraft Bedrock Edition Debugger", port
  19144): not reachable from the phone as above. Not worth pursuing for
  regression tests: GameTest plus `CMGT` log lines covers them.

### Next tests

- **Seats in a building:** mount via `interactWithEntity`, then assert the
  rider.
- **Coaster:** mount the car and assert the rider's position along the track
  over N ticks.
- **Pinball:** rerun `pinball_arcade_11374` on the current build (`2e249b7f`)
  with only its variant bound (the 2026-09-25 rerun collided with another
  variant).
- **Wand sizes:** the same doors test at 200 % (`size` in the place message).
