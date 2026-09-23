# Craftmatic — Project Guide

Minecraft schematic toolkit **and** an LDraw (LEGO) 3D viewer, web UI in `web/`
(Vite + TypeScript + Three.js). This guide and the linked topic docs are the version-controlled source of
truth for architecture + hard-won conventions. Keep it current; do not keep
durable project knowledge only in private/agent memory.

## Topic guides — read when relevant

Load the relevant guide before working on its pipeline. Keep detailed findings
and conventions there; keep this file as the short project entry point.

- **PDF reconstruction:** [pipeline guide](docs/pdf-pipeline-guide.md) — PDF-only input, zero runtime VLM, extraction/placement experiments, accuracy limits, and test harnesses.
- **Minecraft exports:** [pipeline guide](docs/minecraft-pipeline-guide.md) — shared export worker, voxelization, resolution, palettes, schematic/litematic and Bedrock structures.
- **Bedrock playable add-ons:** [add-on guide](docs/bedrock-addon-guide.md) — entity geometry, vehicle controls/cameras, pack constraints, and Pixel QA.
- **LEGO/LDraw rendering:** [renderer guide](docs/lego-renderer-guide.md) — architecture, imports, rendering, colors, mesh metadata, contact checks, and download UI.
- **LEGO models and parts:** [source guide](docs/lego-sources-guide.md) — dev/prod libraries, source-quality gates, index schema, offline data, and source freshness.
- **Testing:** [testing guide](docs/testing-guide.md) — offline suites, manual validation gates, browser-automation caveats, and the two QA surfaces below.
- **Deployment:** [deployment guide](docs/deployment-guide.md) — supported host, Cloudflare Worker routes, and pending deployment requirements.

> **Where to go next** → see **[ROADMAP.md](ROADMAP.md)**: the near-term (~100h)
> priorities (tests/CI first, then the user on-ramp, mobile, MC bridge,
> reliability) and the long-term (~10k h) vision — a universal LEGO pipeline:
> buildable *from* anything, *into* anything, with a physical-validity verifier
> as the moat. Read it before planning large work; it also lists the anti-goals
> (don't micro-polish the renderer; don't re-verify settled questions).

## Dev / commands

- Dev server: `bun dev:web` (port 4000). Add `--host` to expose on LAN (phone testing at the box's LAN IP:4000).
- Typecheck: root is `bun run typecheck` (`tsc --noEmit`, the `src/` tree); the whole `web/` tree is `bun run typecheck:web` (`tsc --noEmit -p web/tsconfig.json`). **Both run in CI** (ci.yml + deploy.yml) so a careless edit can't silently compile-break. The `web` tree is currently type-clean — keep it that way (the old ~34 `ui/*` errors were fixed; the app still *builds* via Vite/esbuild without type-gating, but CI now gates it).
- Build: `bun run build:web`. Tests: **`bun run test`** (vitest — 1,634 passing,
  26 skipped as of 2026-09-17). **Not bare `bun test`**: that runs Bun's own
  runner, which globs the whole tree including copied apps under `output/`
  (2,755 tests, 74 failures that are not this code) and takes 16 minutes.
  See the [testing guide](docs/testing-guide.md) for suites and manual gates.
- **Commit before generating any add-on pack.** A pack stamps the export
  pipeline's provenance into its NAME so an older build is recognisable at a
  glance in Minecraft's pack list; built from a dirty tree it can only say
  "dirty", which makes the pack on the phone unidentifiable. This has already
  cost a device round (a stale pack folder resolved while a new one sat beside
  it). Commit, then export.
- **Answer it offline before the phone.** `bun run console` (port 4600) is the
  operator console — every runnable operation with its real arguments, over one
  model or a filtered batch; `tools/console/inventory.ts` is the cheat sheet and
  the single place to add one. The LEGO tab's **"Walk add-on"** walks a built
  pack in first person over the exact collider blocks it ships, with a key
  counting figures/seats/doors/track/vehicles/colliders/treads. Neither proves
  Bedrock's rendering, culling, form text or ride physics — those stay on the
  device. See the [testing guide](docs/testing-guide.md).
- Use **Chrome** for browser testing, not Edge.
- Run Playwright `.mjs` probes with **Node**: Bun 1.3.11 can fetch a CDP
  `/json/version` yet time out on its WebSocket connection (measured 2026-09-21).
  Node connects to the same isolated Chrome successfully. Keep bun/bunx for
  package commands; a CDP transport timeout is not evidence of a site failure.

## Key tabs

Generate · Import · Upload · Gallery · Comparison · Map · Tiles · **LEGO**

## Gotchas

- **ADB taps use raw landscape screenshot coordinates, not resized tool-view
  pixels.** Pixel capture 2244×1008 displayed at 1600×719 requires ×1.4025;
  `wm size` can remain portrait. A mis-scaled Create tap looked like ignored
  input until this was corrected (2026-09-21). Resize evidence below 2000 px.
- **A source file's OWN palette wins.** `0 !COLOUR` and LDLite `0 COLOR` define
  colour codes FOR THAT DOCUMENT, and 85 codes across the corpus are redefined
  away from the official value: code 67 is "rubber white" in the shared table
  and plain blue in the 264 bricks of 10131 that use it. The parser rewrites a
  disagreeing code to an LDraw DIRECT colour (`0x2RRGGBB`, `0x3RRGGBB` for
  alpha) on the brick, so the palette travels with the model instead of
  mutating a shared table. A definition within 8/255 of the official value is
  left alone — 32/255 when the code has a FINISH — so a chrome or rubber part
  does not flatten to ABS over a difference nobody can see. The LDLite form
  counts its fields from the END: the name may contain spaces and a flags field
  sits before the colour, so `lite[3..5]` reads `<flags> <r> <g>` at alpha 63.
- **`0 MLCAD SKIP_BEGIN` is not content to skip.** All 231 blocks in the corpus
  sit under `MLCAD FLEXHOSE`, `RUBBER_BELT` or `SPRING`: the block IS MLCad's
  written-out expansion of that generator, kept because we do not synthesise
  one. Honouring the name deleted 40,862 parts of hose. Skipping is gated on
  `IMPLEMENTED_GENERATORS` in `ldraw-parser.ts`, which is empty by design.
- **`0 BUFEXCHG <b> RETRIEVE` restores a SNAPSHOT, it does not truncate.** The
  saved state can be LONGER than the current one: OMR/358-1 stores B, builds a
  30-part sub-assembly, stores A, retrieves B to set it aside, builds something
  else, then retrieves A to bring the 30 back and drop the temporary parts.
  Implemented as a rollback length it does the opposite — loses the 30, keeps
  the 5. The other shape is OMR/8063-1, which places a pin at x=160/x=0,
  retrieves, then places the SAME pin at x=140/x=20: the first pair is the
  instruction's part-way-in preview and must go, or the Hauler ships four pins.
- **Every source directive is in a table, and the audit gates it.**
  `engine/ldraw-directives.ts` and `engine/lxfml-schema.ts` list every
  line-type-0 directive and every LXFML element/attribute with its effect,
  whether the reader acts on it, and the corpus count;
  `bun scripts/_converter_coverage_audit.ts` walks every source file INCLUDING
  `.lxf`/`.io` archives and exits 1 on anything missing from them. Add a new
  directive to the table in the same change that meets it. `viaExpansion: true`
  means "described by a meta we ignore, but written out as ordinary geometry we
  read" — LSynth, LDCad flex, MLCad hoses — and is NOT a gap.
- **Studio embedded DATs need identity AND inherited colour preserved.**
  `IsSubModel False` + `IsAssembly False` denotes a terminal mesh; `-1` means
  LDraw main colour 16. Losing either hid 10303's six loop tracks or made them
  grey. Source conversion must retain unresolved private geometry safely.
- **Match a part by `partStem()` (`engine/part-id.ts`), never by your own
  basename+lowercase.** A Studio/OMR `.mpd` embeds its parts as
  `<set> - <mould>.dat` sections, so a placed id reads `10261 - 26021`, and the
  embedded description line is a STUB repeating the mould number where the
  library gives `Train Base 4 x 5 Roller Coaster`. Both make every canonical-id
  and description match fail OPEN — no error, just "this set has no cars", which
  shipped 10261 with a fabricated grey cart and zero minifigs while the same
  set's `.ldr` shipped six of each. 10.9 % of corpus sources have this shape,
  and an MPD is the index's FIRST pick for some sets, so **a test that pins only
  the `.ldr` proves nothing about what users export** (`ce50c838`).
- **`exact-box` means "a single bbox-filling cuboid", NOT "this part is a box".**
  `compilePartPrototype` applies the label to any such cuboid, and its "reached
  only by coarsening" guard counts only its own internal loop — the grain
  planner walks its ladder by passing `microcellLdu`, so the guard never fires
  there. A 1x1 round brick is `exact-box` at 8 LDU. Reading the label as a
  perfect silhouette scored coarsening a cylinder into a cube at 1.000 against
  0.931 at 4 LDU — better AND cheaper — so round parts were coarsened first and
  read as squares up close (`0913f4f7`). Decide box-ness at the FINEST grain and
  measure everything else; `scripts/_round_part_fidelity.ts` prints the true
  per-part IoU per grain.
- **Bedrock culls an actor by its `minecraft:collision_box`, not its visible
  bounds** (`cull ≈ 64 × max(1, box diagonal)` blocks). A 0.1×0.1 shell box made
  every model vanish at 64 blocks; the box is now sized from the model extent in
  `bedrock-building-shell.ts`. The LOD hull is the SAME actor, so its switch must
  sit under that cull or it can never be seen.
- **Bedrock's form renderer deletes a bare `%`** — in-game strings spell
  "percent" (`bedrockInGameText`); the diagnostics keep the real sign.
- **A Bedrock entity identifier may not begin with a digit** (`craftmatic:10303_cart`
  is refused and the entity never exists). Most set stems are numeric, so build
  ids with `entityId(raw, prefix)`; `scripts/_mcaddon_check.py` gates it.
- **Bedrock rejects a `float` actor property written as an integer literal.**
  `"default": 0` fails with "'default' value does not match the specified type
  'float'" and drops the entity's WHOLE property component, so `query.property`
  errors every frame and `setProperty` throws far from the cause. Use
  `bedrockFloat()` from `web/src/engine/bedrock-json.ts`. Diagnose this class of
  fault from the device **content log** (`…/files/games/com.mojang/logs/`,
  newest file, grep on-device) — none of it reaches logcat.
- **PWA service worker** caches all modules and serves stale code. If changes
  don't take effect: unregister SW + clear caches, then hard reload. (See the
  snippet history; `navigator.serviceWorker.getRegistrations()...` + `caches.keys()...`.)
- **`[hidden]` + `display:flex` trap**: rows with `class="lego-scale-row"` (which
  sets `display:flex`) override the `hidden` attribute. Toggle `style.display`,
  not just `.hidden` (bit the help overlay AND the step/explode rows).
- LDraw Y is down; the viewer handles the handedness. Model-aware F/B/L/R
  orientation is derived from the longest horizontal axis + brick mass.
- **Anything that memoises a RESULT but not the in-flight PROMISE has a
  duplicate-fetch race.** `getModelsIndex()` did, and it cost ~45 % of cold
  production set loads: two overlapping searches each downloaded the 3.8 MB
  index, and the later one's clean-up cleared `selectedSet` under the model
  load the user had just started — silently, with the source badge still
  reporting success. Invisible on dev, where the same file is a local read.
  Root causes and the reproduction recipe: [testing guide](docs/testing-guide.md).
- **clego publisher now validates its CLI** (`c8bd5ce6`, 2026-09-20): `--help`,
  `--status`, and `--dry-run` do not upload; unknown options fail. Use
  `--only-file <listing> --no-index` for corpus-only publication. Failed or
  concurrently rewritten models block index publication. Older checkouts
  lacked argument parsing and could start a full upload on `--help`.
- **A load path may never abandon itself silently.** Every staleness guard in
  `lego.ts`/`viewer.ts` goes through a reporter that names it, the phases after
  the part prefetch report stages, and a 20 s no-progress watchdog rewrites the
  source badge. If you add an early `return` to a load path, wire it in.

## Autonomous improvement loop

`scripts/renderer-improve-loop.mjs` is a Stop hook (in `.claude/settings.json`) that, when `.claude/improve-loop-state.json` has `"active": true`, blocks stop + re-injects a "find/implement/validate/commit the next improvement" directive (50-pass cap). Currently `active:false`. Re-arm: set `active:true, pass:0`.
