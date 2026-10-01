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
- **Physics (coaster, pinball, walker, figures, vehicles):** [physics architecture](docs/physics-architecture.md) — units and frames, every constant with its justification, the serialised-runtime rules, the DRY map, how to add a vehicle class, known limits. **Read it before touching any physics; `bun scripts/_physics_spec_check.ts` (in `bun run test`) fails when it drifts from the code** — a new export, a changed constant or an unclassified physics-named module.
- **LEGO/LDraw rendering:** [renderer guide](docs/lego-renderer-guide.md) — architecture, imports, rendering, colors, mesh metadata, contact checks, and download UI.
- **LEGO models and parts:** [source guide](docs/lego-sources-guide.md) — dev/prod libraries, source-quality gates, index schema, offline data, and source freshness.
- **Headless Bedrock simulator:** [sim engine](docs/sim-engine.md) — `bun scripts/sim.ts <packs>` loads a built `.mcaddon` as shipped, runs ALL its scripts unmodified against a `@minecraft/server` mock (unmodelled API is recorded, never passed), plays a child's session with invariants, and re-judges the device-bug regression set (`--scenario=regressions`). Run it before any phone round; a device finding comes back as a quirk row (`web/src/sim/quirks/registry.ts`) or a regression case.
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
- **A bare name can resolve to a Studio stub in ANOTHER frame, and it never
  misses.** Studio's `UnOfficial/parts/60616.dat` ("GLASS DOOR FOR FRAME
  1X4X6") has its origin at the leaf's foot; the official `60616a`/`b` and the
  frame 60596 have it at the head. The alias ladder only runs on a miss, so
  every plain-60616 door drew a door height (2.7 blocks) over its own frame -
  10326's back doors, which an access stair then climbed to (round
  2026-09-30g). `STUDIO_FRAME_REDIRECTS` (ldraw-part-aliases.ts) reads such a
  name as its official mould BEFORE any probe, in both resolvers. When a part
  sits a whole part-height off where it belongs, compare the local file's
  bounds with its official siblings' before blaming the source or a detector.
- **A quarter of Studio's `UnOfficial/parts` files start with `0 FILE
  <name>.dat`; the description is the SECOND line.** 5,605 of 22,692. Read
  the first line and Hagrid's `Torso Large`, the `Arm Large with Pin` arms,
  the goblins' `93230p04` ear-hair and every mini-doll hair are `FILE …` to
  every classifier — which is why they fell out of their figures into the
  building shell (2026-09-24). `descriptionOf` skips the header; anything
  else that reads a part's first line must too.
- **Mini-dolls lost parts in the CONVERSION, not the rig.** LDD renumbered the
  doll moulds (28649 male head, 35582 trousers, 35678-35680 girl torso and
  arms) and no table mapped them, so 52 sets had headless or torso-less dolls;
  clego `DOLL_ROWS` maps them now, and an unresolved LDD id of a million or
  more is counted as a STICKER, silently (1015151, the 2023 legs). A doll
  head's LDraw origin is its CROWN (turn it at the neck), a doll print's id is
  Rebrickable's `92198pr<N>`, and a doll's mould is re-measured against LDraw's
  composites (`_doll_proportions.ts`) before any canon changes.
- **A "posed rider aboard" count is CARS with riders, and a car used to keep
  only `seats[0]`.** The regenerated 76417 seats Harry and Hagrid in one
  cart; Hagrid's bricks left the shell as car members and were emitted
  nowhere, silently. `canonicalCoasterCar` now carries every seat's rider
  (the first as the player's hidden variant, the rest in the body). When a
  figure is missing from a pack, count where every source placement WENT —
  shell, NPC, car, rider — before reading the classifier.
- **A head's print id rides on a META line, never in its part name.** A
  decorated LXFML head with no LDraw print is written as the plain mould
  preceded by `0 !CRAFTMATIC HEAD_PRINT 3626pb<N>` (`ldd-print-map.json` `n:`
  rows); the parser attaches it to the next type-1 line
  (`ParsedBrick.headPrint`) and face art keys on it. An invented part name
  (`3626cpb3484.dat`, tried first) exists in no library: clego's geograde and
  any stock LDraw tool count it missing (76417: unknown placements 18 -> 31).
  A real print (`3626cp1t`, `92198p18`) is placed by name from `e:`/`d:` rows.
- **Tests and CLI builds read clego's `ldraw_ref/` before the prod mirror**
  (`CRAFTMATIC_LDRAW_REF`, set by `vitest.config.ts` and `_playable_ref.ts`
  when the folder exists). Prod rate-limited this machine (HTTP 429) for 90+
  minutes on 2026-09-25 and every test needing a post-2020 part failed; a
  pack built then would have drawn those parts as older moulds. **Everything
  the mirror serves is also local**, so with `ldraw_ref/` present the suite
  runs OFFLINE (`CRAFTMATIC_LDRAW_MIRROR=off`). If a test only passes with the
  network, the local LOOKUP is wrong, not the library: on 2026-09-26 it skipped
  Studio's `UnOfficial/parts/s/` and a null mirror skipped `ldraw_ref/`.
- **A CLI build must ask the mirror for the EXACT part before a local alias.**
  The local library is the 2020 Studio snapshot; its alias ladder turned
  upstream-only prints (`3626cp1t`, every `92198p*`) into their plain mould
  and the pack shipped blank heads. Fixed in `ldraw-geometry.ts` (`e09a0fa9`);
  keep that order.
- **`_favorites_export_sweep.ts` spawns one export PROCESS per set**, so each
  set runs the tree as it is when that set starts: editing the pipeline while
  a sweep runs mixes old and new builds (a 2026-09-30 "before" sweep carried
  the new stair code in its later sets). Take a baseline from a clean
  tree - an archive of the base commit in its own folder with its own
  `bun install` - and do not touch pipeline sources until a sweep finishes.
- **A grid may be widened past the model** (`accessMarginFor`, `padGridXZ`):
  a door hung over the ground near the edge gets room for an access stair, the
  grid and the voxelizer's origin move together before anything is placed, and
  the model sits the margin further in from the pinned corner. Read `dims` /
  `accessMargin` from the pack, never assume the grid is the model's bounds.
- **Build packs one at a time and read `substitutedParts` / `unresolvedParts`.**
  Parallel CLI exports drew the 429 above and shipped parts as aliases or
  AABBs without failing. Without `ldraw_ref/`, point the CLI at a running dev
  server: `CRAFTMATIC_LDRAW_MIRROR=http://localhost:4000/ldraw-parts` (every
  process) or `_playable_ref.ts --mirror=`.
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
  sit under that cull or it can never be seen. **On 26.51/26.52 a bigger box
  buys nothing past ~72 blocks**: every actor (the 2.1-block-needle 76417
  shell, doors, figures, vanilla mobs) stopped drawing at 71-73 blocks on both
  the Pixel and the Saga (round 2026-09-26a, `output/device-round-2026-09-26a/pixel/cull_*.png`).
  The LOD plan caps the cull at `ACTOR_DRAW_CEILING_BLOCKS` (70), so a large
  shell's hull is dropped rather than planned at ~120 where nothing draws; the
  needle is kept (harmless; 200-400 % unmeasured, `TODO(cull)`).
- **Every rideable needs `action.hint.exit.<namespace>:<name>` in every
  `.lang`**, or the raw key shows under the hotbar while riding (Saga, 76457's
  Bed). Written from the emitted behaviour files (`rideableExitHintLines`);
  `scripts/_mcaddon_check.py` gates it.
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
- **A FULL collider cell's top is not a floor, and the passage is measured
  from the DOORWAY's floor** (Saga round 2026-09-29c). A threshold tread laid
  on a wall's rim before clearance trimmed the wall away hung 0.9 block over
  the plate (10326 Door 1, where the walk stood on it; the device's fall
  there is the MODEL's - the door hangs 2.6 over the base plate at the
  model's edge, the threshold was never cut); the row-based passage rule
  cleared a floor LEVEL with a leaf hung 14/16 up its row (41732 Door 3's
  stoop, 10022's sill). Treads and stairs read `standingTop16`, the passage
  a band over the doorway's floor, and an approach must CONTINUE (a
  one-column alcove is SEALED: 910004 Door 3). `_ix_passability.ts` walks
  the device's line through EACH leaf column and prints `HOLE` where the
  feet fall past the jump; a line starts only where the player's box is free
  (dropped blindly it fell through a step and printed 19-block holes), and
  the walks jump only where a jump helps. docs/bedrock-interactivity.md
  "The doorway's floor, a floor's top, and the device's line".
- **A Bedrock camera cannot roll per tick** (Pixel, 26.51): `setCamera` takes
  yaw and a pitch within ±90 only (outside throws); roll exists only as
  `playAnimation` keyframe `rotation.z`, keyframes must be >0.05 s apart, a
  `LinearSpline` needs 3 points, a keyframe's `x` is the NEGATED pitch, and
  an animation re-issued every tick is never drawn — ONE uninterrupted
  animation does roll, so a coaster loop is sent whole, planned ahead.
  **Keyframe Euler angles are interpolated LINEARLY and `x` takes a
  CONTINUOUS pitch past ±90** (x 0 → 360 is one smooth pitch-over,
  2026-09-29): write a loop as one chart (`over`: continuous pitch, the right
  axis's yaw, residual roll), never as (yaw, ±90 pitch, roll) — its flip at
  the zenith was drawn as a 180-degree spin over two ticks ("sideways
  loops"). A `setCamera` issued while an animation plays takes over at once;
  an animation that ENDS before the next `setCamera` flashes the player's
  own view, so plan it past the hand-back (`animTail`). **The client draws
  entities ~3.5 ticks behind the server**: a camera on the server's schedule
  sits 1.7 blocks ahead of the drawn seat at 10 blocks/s (in the car ahead
  at coaster speed), so both cameras show a PAST pose (`tickLag` 1.5 with
  the 0.1 s ease, `animLag` 3.5; marker-measured, `camprobe`).
  The "Experimental Creator Camera Features" experiment changes none of this.
  A rider's reported yaw is the CLIENT's and trails its vehicle ~6 ticks.
  Details: the add-on guide's "The rider's camera follows the track".
- **An unloaded block is not air.** `dim.getBlock` returns `undefined` outside
  the loaded/simulated area; a runtime that reads that as "no ground" lets an
  entity fall through the world (an empty scripted car coasted off and fell
  250 blocks, Pixel 2026-09-25). Hold still instead (`scriptedVehicleRuntime`).
  The same limit ends a GameTest: a vehicle flown ~100 blocks from the arena
  stops being readable ("Entity being invalid"), so keep test courses near.
- **A `minecraft:rideable` seat's +Z is the entity's NOSE; the compiler's
  render frame has the nose at -Z.** Every compiled vehicle seat was mirrored
  along its length until 2026-09-26 (the X-wing's pilot sat over its nose),
  and ACROSS it until 2026-09-30 (60380's driver sat outside its cab wall):
  the geometry is drawn at (-x, y, -z) of the render frame, so a seat turns
  half round, x AND z (`renderSeatToEntity`). Every seat's eye must see out
  (`driverSeesOut`: the horizon `AHEAD`, and no panel within a block beside
  the face, `SIDES`); where nothing in the cabin sees ahead the eye leaves it
  and the body is hidden (`AHEAD_FALLBACK`) - the hotbar-9 view is the
  rider's own first person, so eye and seat move together. `bun scripts/_cockpit_view.ts
  <packs> --out=<dir>` renders the hotbar-9 view offline. A car's wheel eye is
  aft along the VEHICLE, never along the mould's axes (42639's turned
  `16091`). A riding player's eye is 1.12 above its seat
  (measured), and removing a component group removes its components even where
  the base declares them (a `size_100` that only removed groups left vehicles
  unrideable). Seats: `cockpit-seat.ts`, add-on guide "Where the player sits".
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
- **A pack's uuid follows its LABEL** (`packIdentity(stem, label)`), so a CLI
  build must use the LEGO tab's label (`Name (set-1)`) or it becomes a second
  pack beside the old one; both define the same entity/item ids and the
  older can override the newer ("overridden by a pack higher in the pack
  stack"). Deploy a round with `--exclusive` so the world binds only it.
- **Update a phone's packs with `python -u scripts/_pixel_dev_deploy.py <world>
  <pack.mcaddon>...`** — Minecraft storage is external, but `games/com.mojang/**`
  is `drwxr-s---`: adb can OVERWRITE existing files (the world's
  `world_*_packs.json`) yet cannot create or move anything, so development-pack
  installs need root. On a ROOTED phone (the Saga, `192.168.1.243:5555`,
  auto-detected by `su -c id`) the script stages under `/data/local/tmp`,
  `cp -r`s into `development_*_packs` in place and restores the app's owner,
  mode and SELinux label read LIVE (the app uid changes on reinstall); on
  the Saga a plain `input tap` is ignored, use `input swipe x y x y 90`. The script imports each pack through the VIEW intent,
  then force-stops Minecraft and rebinds the world to the new versions in
  place (verified with `exec-out cat`; an `adb pull` right after the rewrite
  can return 0 bytes). A listing of a folder the running game writes can be
  stale: an early "no log, no packs" reading cost a day of guessing.
- **Bedrock rejects a `float` actor property written as an integer literal.**
  `"default": 0` fails with "'default' value does not match the specified type
  'float'" and drops the entity's WHOLE property component, so `query.property`
  errors every frame and `setProperty` throws far from the cause. Use
  `bedrockFloat()` from `web/src/engine/bedrock-json.ts`. Diagnose this class of
  fault from the device **content log** (`…/files/games/com.mojang/logs/`,
  newest file, grep on-device) — none of it reaches logcat.
- **The content log's verbose `No sound found for block type 'normal' and
  event type 'fly'` is resolved through `interactive_sounds.block_sounds.<material>`,
  and per-entity entries do nothing.** Any entity moved through the air (not
  only a hovering one) raises it, 355 lines a minute in flight. The RP
  `block_sounds.normal` with vanilla's events verbatim + `"fly": ""` read 0 in
  every Saga window; `entity_sounds` / `interactive_sounds.entity_sounds`
  entries, even naming a real silent sound, changed nothing (2026-09-29/30,
  `flySoundEvents`, quirk `fly-sound-block-normal`).
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
- **A set the models index holds but Rebrickable does not list yet was
  unreachable** (2026-09-29): the LEGO tab searched only `lego-catalog.json`,
  which trails a release by days, so a model published the hour it appeared
  could not be selected. `mergeIndexSets` (engine/lego-catalog.ts) tops the
  catalog up from the index on every search and `?tab=lego&set=<num>` deep-
  links a set. Onboarding one announced set end to end (11390 is the standing
  test subject): clego `discovery/new_set.py <sku> --run` then
  `bun scripts/new-set.ts <sku> --commit --browser`, chained hourly by
  `scripts/new-set-watch.ps1`; the sources guide, "Onboarding ONE announced set".
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
- **A collider is a FORM, not always a whole block** (clearance, 2026-09-25,
  `engine/collider-form.ts` + `collider-clearance.ts`, docs/bedrock-interactivity.md
  "Clearance"). Walls are pulled back to their own geometry as 43 block ids
  `craftmatic:collider[_<w|f|c><shape>]`, each with the same `lo`/`hi`
  states; a run value is `v·136 + pair`. Anything that reads or lays
  colliders goes through the kit (`cover`, `formBoxes`, `cellPieces`, `lay`) -
  checking `typeId === 'craftmatic:collider'` misses 42 of them, and reading a
  form's `hi` as its top is wrong for a floor + wall form (its wall runs to
  the block top). A trim ships only past the certain test (subset, superset
  of the geometry, not at a leaf's plane, floors keep their top - except a
  wall's top whose rim overhangs open air and is no door's landing - the leak
  flood); judge it with `_clearance_report.ts` and `_walk_line.ts`, never by eye.
- **Bedrock MIRRORS a custom block's `collision_box` in x** (Pixel GameTest
  2026-09-30, `scripts/_gametest_quirks.ts` quirk_bands): origin x -8 is the
  block's HIGH-x side; y and z are as written. A box meant for world x
  [x0, x1] (sixteenths) is declared at origin x `8 - x1` (`collisionBox` in
  bedrock-building-shell.ts). Every pack built before that fix carries its
  x-banded clearance forms (`_w1`..`_w7`, x-shaped `_f`/`_c`) on the wrong
  half of the block; the simulator reads JSON the way the device does
  (quirk `block-collision-x-mirrored`).
- **Every turned part's colliders are laid from its own box; a yaw-turned
  part also keeps the bounding-box corners that are STEPS** (`isTiltedBox`,
  `yawStepKept`, `buildColliderGrid`, 2026-09-30). The AABB of 10326's
  handrail (tilted 42.7 degrees) was an invisible band at head height; the
  AABB corners of 76417's turned baseplate were an invisible floor over a
  17-block drop outside Gate 1 (Saga 30i). A yaw corner stays only where its
  top is within a jump of what is DRAWN under it (or the ground): 76435's
  climb is such corners. Losing reach under this rule means the old route
  walked over nothing drawn - check with `output/device-round-2026-09-30i/saga/tools/drawn_at.ts` (main checkout) before restoring it.
  A doorway side over a drop no stair serves (> 4 blocks) gets an invisible
  guard (`planDropGuards`); the sim attributes a stop on it to the model.
  The sim reads a turned drawn cube by its shape (`drawnReaches` /
  `drawnTopOver`), never its corner box. Before reading a device finding at
  a `/tp` spot, check whether the spot is inside a collider (`_ix_tap_probe
  --clipped`, the sim's `tapPartFrom` refusal record names the cell).
- **A doorway a minifig uses is the player's at 100 %** (2026-09-29): its
  `passSize` is a minifig's envelope (40 x 96 LDU at the model's scale), not
  a 1 x 2-block hole. To ask why a doorway is not walkable, run
  `bun scripts/_ix_sealed_causes.ts <packs> <geometry> --drawn` (geometry from
  `_favorites_export_sweep.ts --geometry`); judge the MODEL over the drawn
  cuboids - clearance's layers are one box per sixteenth per cell and fill a
  doorway cell between its two jambs. A minifig is 1 stud deep, the player
  0.6: a door onto furniture a stud away is the model's, not a bug.
- **Reading a built pack's geometry: ONE rotation convention and a Z mirror.**
  JSON angles turn JSON coordinates by `Rz(−rz)·Ry(ry)·Rx(−rx)` and the world
  is the JSON frame mirrored in Z (`pivotRotation`/`worldFaces` in
  `engine/bedrock-geometry-faces.ts`). The Walk preview and the LOD hull each
  had another convention until 2026-09-25 (parts at the wrong angle, doors two
  blocks off their doorways). Anything new that reads `.geo.json` calls these.
  **An actor's yaw is Bedrock's** (+X turns toward +Z, as `rotatePlacementPoint`
  turns the colliders) = three.js `rotation.y` by the NEGATED angle; `worldFaces`
  takes the Bedrock yaw and negates it. Until 2026-09-30 it (and the walk
  preview's holders) did not: a shell placed at 90 degrees drew 1.9 % of its
  colliders near geometry, 99.8 % negated (`output/sim-triage-0930/probes/yaw-check.ts`).
- **Heights of what stands or sits on a model are measured from the frame the
  shell is laid in** (`actorGroundLdu`): the voxel grid holds figures too, so a
  figure line-up standing under the model's base (42652, 1.18 cells) lifts the
  shell off the grid's bottom, and a slide measured from the model's own
  underside ran 1.1 blocks under its drawn chute (2026-09-30).
- **A rotated bone's cuboid is stored UNROTATED at its pivot.** Its `min`/`max`
  are not where it is drawn (`drawn` holds that). Bounds read from the stored
  boxes put 10365's origin 2.86 blocks under its drawn keel and the ship
  hovered over the water (2026-09-28). The vertical bounds read `drawn`; x/z
  still read the stored boxes on purpose (drawn ones pulled figures off their
  feet). `bun scripts/_drawn_floor.ts <pack> [filter] [--world]` prints the
  drawn span per entity; `--world` adds the placement, so two builds can be
  proved to draw every actor in the same place.
- **A vehicle's facing is settled on the device, not from a review's wording.**
  The Milano's "windscreen in front" (a review) was a different mould; its
  84954 is a REAR window, and flipping its nose on that reading turned it
  round (b733c029, undone). The Saga probe (nose position, chase camera)
  decided it. Measure the nose in the world before changing a facing.
- **Bedrock floors a box-UV cube's DECLARED size and does not draw a side
  face whose height floors to 0** (Pixel probe 2026-09-29: a 3 x 0.6 x 0.6
  cube had no front face, 0.6 x 3 x 0.6 did). At 0.3 units/LDU a figure's
  2 LDU grain is 0.6 units, so every figure showed its white body through its
  print and the sky through its hair - the "unclosed faces" report. EVERY
  entity (figures since 2026-09-29; shells, vehicles, props since 2026-10-01,
  after 42172's body showed its wheels through yellow/black streaks, 22 % of
  its surface dropped) declares every cube under one unit as size + 2 with
  `inflate: -1` (`boxUvSafeCube`, same drawn box). Read a shipped cube's box
  through `drawnCubeBox` (bedrock-geometry-faces.ts), never `origin`/`size`.
  Offline the device rule is `UvFloorModel` `v`: `bun scripts/_box_uv_loss.ts
  <packs>` per entity, `_pack_render.ts --uvfloor=v` draws what the phone draws.
- **A placed entity carries NO name tag** (round 30i): Bedrock draws a
  looked-at tag at a fixed world size, so up close it ran across the screen.
  The label is the dynamic property `craftmatic:label`. **A brick separator
  (4654/630/96874) is dropped from every export** (`build-tools.ts`): 868 DBIX
  sources place one beside the model.
- **Two colours on one plane hatch on the device.** Every entity passes
  `separateCoplanarFaces` at export (winner pushed out 1/107 block);
  `bun scripts/_render_fault_audit.ts <pack>` counts what is left and
  `bun scripts/_pack_render.ts` renders a pack offline. BrickLink names hair
  `MINI WIG …`: hair on either rig, never a held item.
- **An LXFML's top-level `<Step>` is the finished-model page.** Its DIRECT
  `<Explode>` children place every sub-build and figure (76417: bank, dragon,
  cart, 13 figures); explodes inside nested sub-builds are diagrams. Nested
  explodes are in their PARENT's frame. `_lxfml_assemble.ts --root-step`
  (`composeRootStep`); the seating heuristic cannot place a figure indoors.
  **It is NOT safe to apply globally**: the page moves parts in 397 of 2,322
  DBIX LXFMLs, and over those it is mixed (floating and side-model down,
  overlap and sunk up); pages also scatter loose display accessories. clego
  applies its port (`lxfml_root_step.py`) only to the 73 stems in
  `dbix_root_step_accepted.json` that passed the strict A/B (2026-09-24,
  `output/generalize-0924/`). Only the refID schema has frame pairs; the uuid
  schema's root explodes (663 sets) are DISPLAY poses, not the assembly —
  measured 2026-09-25: applying them took a 44-set trial's floating parts
  1,034 -> 2,674, and every authentic `.io` checked (76316, 60472, 11200)
  matches the UNapplied layout. Do not apply them.
- **A mini-doll is minifig-scale evidence, and "Ship & Spa" is a scene.**
  Without the mini-doll cue (`addon-scale.ts`) every Friends/Gabby set read
  "no minifig" and a vehicle word in its title shrank the whole set as a
  display vehicle (10786: 0.49x, props dropped). A title joining a vehicle to
  a place (`isVehicleAndPlaceLabel`) is a scene whose boat/car is found in it.
- **Slides and lifts are rides** (`engine/bedrock-rides.ts`): a seat carried
  along a WORLD path the placement wrote (`PlacementActor.ridePath`). A new
  ride kind adds a path, never its own teleport loop. A runtime that puts a
  player somewhere (a ride's set-down, a door's step-out) goes through
  `colliderBodyProbe` (collider-form.ts): planned points sat 0.2-0.34 inside
  floor slabs and the player fell through (2026-09-30).
- **A touch tap is `entityHitEntity`; only a press held ~0.5 s is the
  interact that mounts a vanilla rideable.** Any seat a child TAPS needs a
  hit handler that calls `addRider` (rides `board()`): 10788's slide seat
  boarded nobody over three taps while `/ride` on it ran the chute (Pixel
  29c). Collider blocks have `selection_box: false`, so a tap's ray passes
  them - a seat inside a collider is reachable and `playerInteractWithBlock`
  never fires for one; do not reach for a block handler.
- **An LDraw part's origin is its TOP stud plane; the body runs to +Y (down).**
  A brick placed at y sits in [y, y+24], a plate in [y, y+8]; a brick ON a
  surface at s has its origin at s − 24. `54200` (Slope 31 1×1×⅔) is the
  exception in the cloud family: origin at its BOTTOM, body −15.6..0. The
  library's mesh bounds exclude studs, and `6141`'s mesh is only 3 LDU tall.
  A fixture authored with "origin at the bottom" overlapped its base by a
  plate and read `groundLdu` 16 (2026-09-29, `_nimbus_fixture_gen.ts`);
  check `placementBox` before trusting any hand-placed y. Per-set hints
  (mounts, later seats/facing/scale) go in `engine/set-canon.ts`, never in a
  title regex.
- **A load path may never abandon itself silently.** Every staleness guard in
  `lego.ts`/`viewer.ts` goes through a reporter that names it, the phases after
  the part prefetch report stages, and a 20 s no-progress watchdog rewrites the
  source badge. If you add an early `return` to a load path, wire it in.

## Autonomous improvement loop

`scripts/renderer-improve-loop.mjs` is a Stop hook (in `.claude/settings.json`) that, when `.claude/improve-loop-state.json` has `"active": true`, blocks stop + re-injects a "find/implement/validate/commit the next improvement" directive (50-pass cap). Currently `active:false`. Re-arm: set `active:true, pass:0`.
