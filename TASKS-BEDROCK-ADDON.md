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
  has no authentic `.io`, so it was measured with clego's geograde on the two placements
  (`output/lxf-gt/71043-probe/geograde.log`): old maths **16 floating parts / 27 unsupported
  splits / 5 sunk / 0.05 % overlap** → new maths **0 / 0 / 0 / 0.00 %** (1,047 of 5,967
  placements moved; 3794 jumpers, 2412 grilles, 2780 pins, 4162/3666 tiles, 60601 glass).
  Browser renders of the new path (`hogwarts-close-*.png` there): the Grand Staircase's
  white stairs sit under their turntable instead of piercing the floor; tower walls clean.
- **Aircraft descend** (`feat(bedrock)`): `craftmatic:descending` group (Jump's
  vertical action −0.5) toggled by the driver script while the stick is pulled BACK
  and Jump held; HUD `BACK+JUMP: DESCEND`.
- **Model scale** (`engine/addon-scale.ts`): one multiplier of the minifig scale drives
  the block/collider cell, the entity units and figure placement. `auto`: a minifig →
  1×; a figure-less display vehicle → shrunk to real length (car 4.6 / boat 9 / plane
  12 blocks, floor ¼×); else 1×. Settings popover "Model scale" with a live decision
  line; CLI `--scale=`. Mini Cooper 10242 auto → 0.38× (4.6 blocks, 7×5 bounds vs 14×9).
- **Custom-minifig UI** (`ui/minifig-builder.ts`, "🧍 Minifig" beside MC settings): torso /
  head / hair / held / cape by part id + LDraw colour, legs/hips/arms/hands colours; the
  figure is compiled on the main thread through `buildPlayableAddon` and downloaded as a
  figures-only `.mcaddon`. Headless check `node scripts/_minifig_browser_check.mjs`:
  12-part knight, 32 KB, 191 ms, zero page errors. Unverified on a device (spawn it with
  its wand, `/function b_…`).
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

## Device round 2026-09-17 — DONE, world "917" (`svO65HnoLQA=`), Bedrock **1.26.51.1**

Full verdict table, measurements and the adb-input findings:
`output/bedrock-entity-qa/captures-2026-09-17/notes.md` (shots `10-*`..`142-*`).
Settled: import/activate (no `(N)` folders, scripts load without Experimental);
BACK+JUMP **descends** (HUD `[DESCENDING]`, ALT -43→-60 in ~3.5 s); Mini Cooper at 0.38×
measures **4.55 × 2.0 blocks** and drives (103.5 mph); the whole wand rework — menu order
0–10, aim-follow ghost, size cycle 100/150/200/300/400/25/50/75, 200 % ghost `34×22×16`,
colliders re-laid at 2× (`/testforblock 0 -45 40 craftmatic:collider` found, walls stop the
player, upper floor at y −54), figures 3.9–4.1 blocks at 200 % and 0.9–1.1 at 50 %, Undo
restores terrain and removes every entity, 50 % walls still block.

### The five defects, fixed offline (`be48ee8`) — device round 2026-09-17b RUNNING (Opus subagent)
Packs rebuilt in `output/bedrock-entity-qa/round-2026-09-17b/` (same three models); brief
`QA-BRIEF.md` there; evidence lands in `captures-2026-09-17b/notes.md`. The Mini's seat clamp did
NOT fire (the 0.38× car is 2.25 blocks tall, threshold 2.0) - round b measures the CAR's own y
versus the rider's to tell a sunk vehicle from a bad seat before the threshold is changed.
- [ ] `starting_rot_x` dropped from the `fixed_boom` preset → content log must show ZERO `[error]`.
- [ ] Climb is its own group `craftmatic:climbing` (added by `minecraft:entity_spawned` and by
      `descend_off`); `descend_on` swaps it for `craftmatic:descending`. Verify: descend, release,
      Jump climbs again (ALT rises), rider stays mounted; repeat three cycles.
- [ ] A model under 2.0 blocks tall seats the rider ON it (seat y ≥ height − 0.55, `behaviorEntity`):
      the 0.38× Mini Cooper's rider should sit with legs in the roof line, not through the flank;
      measure the rider's y beside the car's y and screenshot from the side.
- [ ] Figures: collision box capped at the player's 0.6 × 1.8 and a figure spawned in a full collider
      cell is lifted to the first clear cell (`placement.js`). Verify: chalet at 100 %, census three
      times; how many of the 7 move without a `/tp`.
- [ ] Aim at the sky: the action bar now says "look at a block within 96 blocks".

### Still unverified on a device
- [ ] Whether LOOK DOWN still dives under the script chase camera — **not testable from adb**:
      look-area swipes do not register, `/rotate` does not exist in 1.26.51, and
      `/tp @s … facing …` dismounts a rider. Needs a human, or a debug command that sets pitch.
- [ ] Joystick steering on 1.26.51: the round-5 stick centre (337,550) is the LOOK area now and
      no probe found the ring. Two simultaneous touches are impossible from adb (single pointer;
      `sendevent` on `/dev/input/event2` is SELinux-denied for shell, phone unrooted). Workarounds
      that DO work are listed in the round's notes (stylus source = 2nd pointer;
      `input keyboard keyevent --duration` holds a key; SPACE dismounts a rider).
- [ ] Doors/lights left out at 200 % is confirmed only by the confirm dialog's own text.

## Open

- [ ] **71043 on the phone**: prod (craftmatic.click) still serves the OLD maths until the
      branch deploys; the user should re-check the three spots after deploy. Local A/B renders:
      `output/lxf-gt/71043-probe/hogwarts-close-*.png` (new) vs `hogwarts-old-*.png` (old).
      A/B verdict: the old render shows the stair tile piercing the tower floor and a loose black
      1×1 in mid-air, the new one neither; the two angled Dementors are IDENTICAL in both, so they
      are the source's pose, not a residual. (`scripts/_lego-probe.mjs` now takes `PROBE_VIEWS`
      JSON for close-up cameras; search mode needs the set loaded from the index, file mode
      `file:<abs path>` works for any .lxf/.ldr.)
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
- [ ] Door openability under-measured (round 3: 1 of 7 taps toggled a leaf); a scripted
      `setPermutation`/`open_bit` probe from the wand would settle it.
- [ ] Which source the LEGO tab serves: prod index lists `IO/10326-noprint.io` first for 10326 and
      DbixConvV3 (exploded layouts) for many sets; a "compact layout" quality flag (lego-sources-guide).
- [ ] Two museum doors "no room within three blocks"; 910047 sparse (17 % fill).
- [ ] Hogwarts 76419 is microscale: `auto` scale now reads its microfigure (85863) and exports at
      2× so it stands player height; its one 4-part torso group is still not an NPC (figureRole).
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
