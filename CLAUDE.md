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
  **The stamp is computed when the dev server STARTS**, so a server left running
  across a commit keeps reporting the tree as it was — after the 2026-09-23
  renormalisation it read `a54a6068+dirty, 21 files` against a clean tree. Check
  the `[pipeline-stamp]` line in the server's own log and restart it before
  exporting; `bun scripts/pipeline-stamp.ts` prints the true current stamp.
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
- **Line endings are LF, enforced by `.gitattributes`, and the mixed-file trap
  is CLOSED here.** The repo carried 252 CRLF and 14 mixed files until
  2026-09-23; a mixed file turned any ordinary edit into a whole-file diff,
  because the Edit tool, `sed -i` under MSYS and Python's `write_text` all
  rewrite every line of one. `* text=auto eol=lf` normalises on add, so it
  cannot recur whatever a machine's `core.autocrlf` says, and the Edit/Write
  tools are now safe on every file in this repo. The renormalisation is
  verifiable: `git diff --ignore-cr-at-eol` across it shows only
  `.gitattributes` itself. Keep new files LF; do not reintroduce a CRLF file.
- **Studio ships TWO LDraw mapping tables and the newer one is the real one.**
  `ldraw.xml` (4,390 design ids, Sep 2025) sits beside `ldraw_lxfv56.xml`
  (5,406 ids, Feb 2026, 1,007 found ONLY there), and the second is what Studio
  itself uses to import an LXF. `gen-ldd-part-map.py` read only the first for
  months, so every design named only in the second placed at its raw LDD
  origin. That is invisible on a part whose rotation is identity and fatal on a
  spiral, where each piece carries a different rotation and the missing `R·e`
  displaces every one differently — it is why no coaster's track routed. When a
  placement is wrong for a whole class of part, check BOTH tables name it
  before assuming the source is bad. **A row's `type` is an LDD MATERIAL id**
  (`80133` has identical rows for materials 21, 24 and 5), not a direction;
  only `to_lego` is reverse — 95 ids exist only as material rows. Since
  2026-09-23 every converter reads both tables: this repo's generator, and
  clego's `reconvert_dbix.py` / `convert_lxf.py` / `download_dbix_lxfml.py`
  through `fill_from_lxfv56`, applied INVERSE as `lxf-parser.ts` applies every
  Studio row.
- **`bl_<id>.dat` is the same LEGO design in a DIFFERENT origin frame.** Studio
  ships BrickLink copies beside the upstream part (header `BL_Item_No`) and
  sources place either name, so `partStem` gives `bl_80566` and every match
  against `80566` fails open — seven of 76417's nine rail pieces were simply
  invisible to routing. Matching the id alone is not enough either: the two
  meshes bound identically (274.0 x 98.0 x 274.0 LDU) but sit 137/80/420.6 LDU
  apart. `FRAME_ALIASES` in `engine/coaster-track.ts` carries measured
  translations; `bun scripts/_coaster_frame_measure.ts` derives a new one and
  `_coaster_mould_audit.ts` exits 1 on any placed id whose design IS profiled
  under a sibling name.
- **A quarter of Studio's `UnOfficial/parts` files start with `0 FILE
  <name>.dat`; the description is the SECOND line.** 5,605 of 22,692. Read
  the first line and Hagrid's `Torso Large`, the `Arm Large with Pin` arms,
  the goblins' `93230p04` ear-hair and every mini-doll hair are `FILE …` to
  every classifier — which is why they fell out of their figures into the
  building shell (2026-09-24). `descriptionOf` skips the header; anything
  else that reads a part's first line must too.
- **A "posed rider aboard" count is CARS with riders, and a car used to keep
  only `seats[0]`.** The regenerated 76417 seats Harry and Hagrid in one
  cart; Hagrid's bricks left the shell as car members and were emitted
  nowhere, silently. `canonicalCoasterCar` now carries every seat's rider
  (the first as the player's hidden variant, the rest in the body). When a
  figure is missing from a pack, count where every source placement WENT —
  shell, NPC, car, rider — before reading the classifier.
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
- **Doors, windows, hatches, levers and turnables are hinged ENTITIES of the
  exact parts** (`engine/bedrock-interactives.ts`, design in
  `docs/bedrock-interactivity.md`); vanilla doors survive only in the
  coloured-block export. A leaf mould's ORIGIN marks its hinge — a centred
  origin (40066's arch, 92099, 38320's fixed pane) is not a leaf and stays
  static. A doorway is cut into the COLLIDER grid to the leaf's own span only:
  clearing the lintel's share of the top row, or leaving a gap under a leaf hung
  above its floor, is a hole the wand's size multiplies — at 300-400 % players
  walked over and under closed doors. Judge any change with
  `bun scripts/_ix_passability.ts` / `_ix_sweep_report.ts`, never by eye.
- **Bedrock's form renderer deletes a bare `%`** — in-game strings spell
  "percent" (`bedrockInGameText`); the diagnostics keep the real sign.
- **A Bedrock entity identifier may not begin with a digit** (`craftmatic:10303_cart`
  is refused and the entity never exists). Most set stems are numeric, so build
  ids with `entityId(raw, prefix)`; `scripts/_mcaddon_check.py` gates it.
- **Format 1.26.30 dropped `minecraft:pushable`; an entity that declares it
  does not exist.** The whole definition fails to parse and every spawn says
  "not a valid entity type" — pinball's flippers, ball and tap zones shipped
  twice like that and "nothing moved" (2026-09-24). Use
  `minecraft:pushable_by_block`; `scripts/_mcaddon_check.py` gates
  `DROPPED_COMPONENTS`.
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
- **The voxel grid is HALF A BLOCK off the entity world.** The voxelizer
  centres cell `i` on `i` (it holds grid coordinates [i − ½, i + ½), kept on
  purpose, see `parityFill`), while the structure lays voxel `i` at world block
  [i, i + 1) and every entity (shell, figures, doors) is placed by
  `sceneGridPoint`. Anything that reads the voxel grid as "what is at world
  block i" is half a block wrong in all three axes: the shell's colliders were
  (76417: 1,070 of 3,535 collider blocks held nothing, an invisible plane over
  the bank floor), and are now laid from the shell's own part boxes
  (`buildColliderGrid`). Derive world-block facts from geometry, not voxels.
- **An LXFML's top-level `<Step>` is the finished-model page.** Its DIRECT
  `<Explode>` children place every sub-build and figure (76417: bank, dragon,
  cart, 13 figures); explodes inside nested sub-builds are diagrams. Nested
  explodes are in their PARENT's frame. `_lxfml_assemble.ts --root-step`
  (`composeRootStep`); the seating heuristic cannot place a figure indoors.
- **A load path may never abandon itself silently.** Every staleness guard in
  `lego.ts`/`viewer.ts` goes through a reporter that names it, the phases after
  the part prefetch report stages, and a 20 s no-progress watchdog rewrites the
  source badge. If you add an early `return` to a load path, wire it in.

## Autonomous improvement loop

`scripts/renderer-improve-loop.mjs` is a Stop hook (in `.claude/settings.json`) that, when `.claude/improve-loop-state.json` has `"active": true`, blocks stop + re-injects a "find/implement/validate/commit the next improvement" directive (50-pass cap). Currently `active:false`. Re-arm: set `active:true, pass:0`.
