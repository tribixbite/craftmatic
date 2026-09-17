# LEGO model → Bedrock add-on — tracker

**Handoff rule:** assume a context switch after every turn. This file holds OPEN
work and the measurements a decision still needs. Completed items are deleted;
history is `git log` and `docs/bedrock-addon-guide.md`, which carries every
hard-won fact (frame, budgets, Pixel import/command/camera recipe, riding facts,
the 2026-09-15/16 rounds, the minifig rig, the building shell, the model scale
and the wand's size/aim). Spec: `docs/bedrock-entity-spec-2026-09-14.md`.

## State (2026-09-17, four features built and gated offline; device round running)

Commits `38ea28c`…`2b0b059`:
- **LXF placement** (`fix(lxf)`): Studio's `ldraw.xml` row applied as its INVERSE is
  now the primary correction, clego's measured table the fallback. Ground truth over
  the native `.lxf` files with an authentic `.io` (`scripts/lxf_gt_eval.py`):
  10242 Mini Cooper 89.3 → **93.6 % GEO** (exact 74 → 93 %); strict cohort (54 files, a
  Model B .lxf only against a Model B .io) weighted 60.2 → **65.7 %**, median 61.1 →
  **68.7 %**, exact mean 38.0 → 48.7 %, NO file worse by > 1 pt (`output/lxf-gt/strict-*.json`).
  Three files still < 10 % (315 European Taxie, 42039, 4x4 with Powerboat) - their .io
  is a different layout of the set, not a placement failure.
  71043 Hogwarts (the screenshots: floating window, pierced white plates in the tower)
  has 100 % `ldraw.xml` coverage, 0 flex parts, no authentic `.io` - its fix is inferred
  from the cohort; **browser verification of 71043 is the open item below**.
- **Aircraft descend** (`feat(bedrock)`): `craftmatic:descending` group (Jump's
  vertical action −0.5) toggled by the driver script while the stick is pulled BACK
  and Jump held; HUD `BACK+JUMP: DESCEND`.
- **Model scale** (`engine/addon-scale.ts`): one multiplier of the minifig scale drives
  the block/collider cell, the entity units and figure placement. `auto`: a minifig →
  1×; a figure-less display vehicle → shrunk to real length (car 4.6 / boat 9 / plane
  12 blocks, floor ¼×); else 1×. Settings popover "Model scale" with a live decision
  line; CLI `--scale=`. Mini Cooper 10242 auto → 0.38× (4.6 blocks, 7×5 bounds vs 14×9).
- **Wand rework** (`bedrock-placement-pack.ts`): "Follow my aim" carries the ghost to
  the aimed block face until pinned; "Size" cycles 150/200/300/400/25/50/75/100 % -
  every entity has `craftmatic:size_<pct>` groups (scale + collision + scaled seats),
  a brick-shell building's colliders are re-laid to size by script from a run-length
  grid in the pack (doors/lights left out off 100 %), a coloured-block export refuses
  a resized place; entity-only packs turn in 15° steps. Menu: 9 Follow my aim ·
  10 Size · (11 Turn back, entity-only) · DeLorean last.

Offline gates: root + web typecheck clean; vitest **1,627 passing, 26 skipped**
(`output/bedrock-entity-qa/round-2026-09-17/vitest-full.log`). Packs for the device
round in `output/bedrock-entity-qa/round-2026-09-17/` (`xwing`, `mini-auto`, `mini-1x`,
`chalet` `.mcaddon` + `.json` summaries); brief `QA-BRIEF.md` there.

```
lego.ts ─► ui/schem-export.ts (planAddonScale → cell + modelScale) ─► Worker: schem-pipeline.ts
   ├─ discoverPlayableComponents()   playable-components.ts  (named submodel ≥ ½ wins)
   ├─ discoverSceneActors()          bedrock-scene-actors.ts (figures / seats / door leaves)
   ├─ shell = scenery − vehicles − figures − door leaves   (buildingFidelity 'bricks', default)
   └─ buildPlayableAddon(modelScale) playable-addon.ts
        ├─ every compile at BEDROCK_UNITS_PER_LDU × modelScale; extras at LDU_PER_BLOCK / modelScale
        ├─ every behaviour wrapped by withSizeGroups() (size_25..400)
        ├─ shell → buildColliderGrid → encodeColliderRuns → PlacementColliders in the wand config
        └─ buildPlacementPackAssets(): aim / size / fine-turn runtime
```
CLI gates: `bun scripts/_playable_ref.ts <model> [out] --label=… [--quality=…] [--main-only] [--buildings=bricks|blocks] [--scale=auto|0.25..4]`;
`bun scripts/_minifig_ref.ts --label=Knight --torso=973:4 …`; `python scripts/lxf_gt_eval.py --all --variants shipped`
(strict cohort: a `[Model B]` .lxf only against a `[Model B]` .io; results `output/lxf-gt/strict-*.json`).
**A CLI label must read as the vehicle** (`--label="X-wing Starfighter 7140"`; `XWing 7140` exported a shell + figures, no plane).

## Device round 2026-09-17 — RUNNING (Opus subagent) in the NEW world "917"

The user retired the old QA world (`smUmxh2eJjw=`, too cluttered) and DELETED every
installed pack from the Pixel; "917" is flat, empty, always day. Import the three packs
fresh and activate them in 917's `world_*_packs.json` (brief section "THE WORLD IS NEW").
Claims A–E in `round-2026-09-17/QA-BRIEF.md`; evidence lands in
`output/bedrock-entity-qa/captures-2026-09-17/notes.md`. Unverified on a device until then:
- [ ] BACK+JUMP descends the X-wing (ALT falls, HUD `[DESCENDING]`); Jump alone climbs again after.
- [ ] Whether LOOK DOWN still dives under the script chase camera (the user's report says no).
- [ ] Mini Cooper at 0.38× drives, and the rider sits inside it (seat scaled in the size group / at export).
- [ ] Wand: aim-follow ghost; Size 200 % re-lays colliders (walls stop the player at 2× positions,
      plate under the feet at 2× height), figures 2× tall, shell drawn 2×; Undo restores; 50 %.
- [ ] `minecraft:scale` does not move a rider's seat (assumed; seats are scaled explicitly).
- [ ] Chalet figures 1/3/7 not walking (round 5): census after `/tp` onto open floor.
- [ ] Content log zero `[error]` with the size groups and descend events in every entity.

## Open

- [ ] **71043 in the browser**: load it in the LEGO tab on the new LXF path and screenshot the
      three views the user sent (floating window above the wall; white plates through the Grand
      Staircase tower; the tower from outside) - `scripts/_lego-probe.mjs 71043 <outDir>` against
      `bun dev:web`; compare against `%USERPROFILE%\Pictures\Screenshots` from 2026-09-17 01:18.
- [ ] LXF residuals (strict cohort `output/lxf-gt/strict-hybrid_xml_first.json`): Technic sets score
      ~41 % weighted (pins/axles stored in the other of two equivalent poses; flex parts), System
      ~65 %. Next levers: synthesise multi-bone flex parts; per-part pose symmetry in the scorer.
- [ ] Sit pose leg sign (round 5: thighs read forward, hips occluded) - still unproven.
- [ ] X-wing figures' walk cycle and a first-person rider-in-cockpit view (round 5 J.1/J.2).
- [ ] Figure height reads 2.03 blocks (hair + head stud over the 1.8 player).
- [ ] `natural_fig4` walked off the platform edge in round 4; `minecraft:home` not re-measured.
- [ ] **The block grid is a mirror image of the LEGO model** (LDraw (x,y,z) → cells (x,−y,z)).
      Invisible on symmetric builds; fixing it changes every schematic byte-for-byte (rule 5) -
      a separate decision. The shell is compiled to the mirrored grid (frame −I) so it is consistent.
- [ ] **Custom-minifig UI**: `minifigFromSpec` + `_minifig_ref.ts` exist; no LEGO-tab form yet
      (head / torso / legs / hair / held / cape pickers → a figures-only pack).
- [ ] Door openability under-measured (round 3: 1 of 7 taps toggled a leaf); a scripted
      `setPermutation`/`open_bit` probe from the wand would settle it.
- [ ] Which source the LEGO tab serves: prod index lists `IO/10326-noprint.io` first for 10326 and
      DbixConvV3 (exploded layouts) for many sets; a "compact layout" quality flag (lego-sources-guide).
- [ ] Two museum doors "no room within three blocks"; 910047 sparse (17 % fill).
- [ ] Hogwarts 76419 is microscale: its one 4-part torso group is not exported; decide on microfigs.
      (The model-scale `auto` rule keys on minifig body parts; a microfig cue - 85863 - is not read yet.)
- [ ] Beds / brick-built chairs are not detected (no bed mould; chairs are bricks).
- [ ] Door sizing: a 1×4×6 leaf hangs 2 doors when it straddles two cells and 1 at 1.36 cells;
      below ¾× model scale no leaf reaches two cells, so no doors hang (documented in the popover).
- [ ] Repeated-part budget (76240 `70695` ×184); Tumbler 32 LDU grain reads 14.5 wide (11.5 true).
- [ ] Swipe-to-look untestable over adb; `30426`/`28710`/`x346` ids with no mould; stale pack
      folders on the Pixel (`adb shell rm` denied); `_chase`/`_boom` orbit presets ship unused.

## Hard rules (from the spec)

1. No whole-model voxelization on the entity path; no `poly_mesh`.
2. `getPartDims()` only as an explicit, diagnosed AABB fallback.
3. No Minecraft block colours on the entity path.
4. Nothing silent: every part/print/transparency/pose/cluster/figure/door
   degradation lands in `craftmatic-diagnostics.json` and the export warning.
5. Don't touch the world-block pipeline, rideability, the DeLorean behaviour or
   the BlockGrid fallback to solve an entity-rendering problem.
6. Compile per unique part once; instance many; preserve exact source transforms.
