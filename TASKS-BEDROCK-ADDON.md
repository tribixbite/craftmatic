# LEGO model → Bedrock add-on — tracker

**Handoff rule:** assume a context switch after every turn. This file holds OPEN
work and the measurements a decision still needs. Completed items are deleted;
history is `git log` and `docs/bedrock-addon-guide.md`, which carries every
hard-won fact (frame, budgets, Pixel import/command/camera recipe, riding facts,
the 2026-09-15/16 rounds, the minifig rig and the building shell). Spec:
`docs/bedrock-entity-spec-2026-09-14.md`.

## State (2026-09-16, round 4 built and gated offline; device round in progress)

Commit `66b0367` + docs. Every figure is a JOINTED minifig on the canonical rig
(`engine/minifig-rig.ts`: missing arms/legs/head supplied, walk / look / sit
animations, exact torso facing); every building ships as a brick-accurate
"shell" entity over invisible `craftmatic:collider` blocks whose collision
follows the part heights (`engine/bedrock-building-shell.ts`). Offline gates:
root + web typecheck clean; vitest 1,608 passing, 26 skipped
(`output/bedrock-entity-qa/round-2026-09-16b/vitest-full.log` - the two
failures there were the two test updates since made); the four buildings and
the X-wing exported by `run-buildings`-style commands into
`output/bedrock-entity-qa/round-2026-09-16b/` (`*.summary.json`, `*.stderr.log`).

```
lego.ts ─► ui/schem-export.ts ─► Worker: schem-pipeline.ts runSchemPipeline()
   ├─ discoverPlayableComponents()   playable-components.ts  (named submodel ≥ ½ wins)
   ├─ discoverSceneActors()          bedrock-scene-actors.ts (figures / seats / door leaves)
   │    └─ applySceneDoors()         leaf cells → air, vanilla doors in the opening
   ├─ shell = scenery − vehicles − figures − door leaves   (buildingFidelity 'bricks', default)
   └─ buildPlayableAddon()           playable-addon.ts
        ├─ vehicles: compileLdrawEntityGeometry() (prepareEntityPlacements → extras → cockpit)
        ├─ figures (scene + vehicle extras): compile kind 'figure'
        │     → assembleMinifig() (minifig-rig.ts) → compile canonical bricks with rig + frame
        │     → client entity animations (walk/look/sit), exact yaw
        ├─ shell: compile 'prop' with frame −I + wholeModel → shell entity actor at yaw 0
        │     → buildColliderGrid(scenery, partBoxesLdu) → structure tiles of colliders
        │     → BP blocks/collider.json, RP blocks.json + clear tile
        └─ buildPreviewGhost() on the COLOURED scenery (unchanged)
```
CLI gates: `bun scripts/_playable_ref.ts <model> [out] --label=… [--quality=…] [--main-only] [--buildings=bricks|blocks]`;
`bun scripts/_minifig_ref.ts --label=Knight --torso=973:4 --hair=3901:0 --legs=1 --held-right=3847:71 --cape=4`
(a one-figure pack from a spec). Probe: `bun scripts/_vehicle_probe.ts <model> --label=…`.
**Use a label whose stem does not start with a digit.** Pixel helpers:
`scripts/_pixel_shot.sh`, `scripts/_pixel_cmd.sh`.

## Device round 4 (in progress, Opus subagent, brief `round-2026-09-16b/QA-BRIEF.md`)

Evidence lands in `output/bedrock-entity-qa/captures-2026-09-16d/notes.md`. Claims
the device must settle (none of these can be gated offline):
- [ ] **A** content log has zero `[error]` lines with the collider block
      (`states` `{values:{min,max}}`, `selection_box: false`, 136 permutations),
      `blocks.json`, the shared minifig animation file and the shell geometry.
- [ ] **B** the chalet shell renders (round studs, LDraw colours) and sits ON its
      colliders: walls stop the player where they are drawn (±0.5), the player
      stands on the drawn floor plate (not 0.85 above), the four vanilla doors stand
      in the shell's doorways, the interior is lit by day, no visible stutter.
- [ ] **C** figures are complete minifigs (arms + legs + head) that WALK with
      swinging legs (three rapid shots differ), read 1.8-2.0 blocks, turn the head
      toward the player; seats still seat.
- [ ] **D** at wand rotation 90° the shell still coincides with walls and doors
      (yaw sense vs `structure load … 90_degrees`).
- [ ] **E** the museum's 12-mesh shell renders whole; **F** the X-wing's rigged
      figures walk and the rider is still in the cockpit; **G** 910047 (8 figures)
      and Hogwarts place.
If B or D fails with a consistent offset, the fix is in `SHELL_FRAME` /
the shell actor position (`bedrock-building-shell.ts` header explains the frame).

## Open (not started)

- [ ] **Seated figures**: a figure found ON a seat (`SceneFigure.seated`) still
      spawns standing and walks off. Designed, not built: spawn it riding the
      seat entity (placement.js `addRider`, seat `family_types` + `craftmatic_figure`);
      the `sit` animation (legs −90°) is already in the pack and plays on `query.is_riding`
      - its leg sign is unverified.
- [ ] **The block grid is a mirror image of the LEGO model** (LDraw (x,y,z) →
      cells (x,−y,z); both frames are right-handed). Invisible on symmetric
      builds; a door hinge side or a printed sign would show it. Fixing it
      changes every schematic byte-for-byte (rule 5) - a separate decision.
      The shell is compiled to match the mirrored grid (frame −I), so it is
      consistent with today's structures either way.
- [ ] **Custom-minifig UI**: `minifigFromSpec` + `_minifig_ref.ts` exist; no LEGO-tab
      form yet (head / torso / legs / hair / held / cape pickers).
- [ ] **Door openability is under-measured** (round 3: 1 of 7 taps toggled a leaf).
      A scripted `setPermutation`/`open_bit` probe from the wand would settle it.
- [ ] **Which source the LEGO tab serves matters**: the prod index lists
      `IO/10326-noprint.io` first for 10326 and DbixConvV3 (exploded layouts) for
      many sets; consider a "compact layout" quality flag (lego-sources-guide).
- [ ] Two museum doors "no room within three blocks"; 910047 sparse (17 % fill).
- [ ] Hogwarts 76419 is microscale: its one 4-part torso group is no longer
      exported (not an NPC under `figureRole`); decide whether microfigs matter.
- [ ] **Beds / brick-built chairs** are not detected (no bed mould; chairs are bricks).
- [ ] **Door sizing**: a 1×4×6 leaf hangs 2 doors when it straddles two cells
      cleanly and 1 when its bounds read 1.36 cells.
- [ ] Repeated-part budget (76240 `70695` ×184); Tumbler 32 LDU grain reads 14.5
      wide (11.5 true); stud budget on the Milano.
- [ ] Swipe-to-look untestable over adb; `30426`/`28710`/`x346` ids with no mould;
      stale pack folders on the Pixel (`adb shell rm` denied); `_chase`/`_boom`
      orbit presets ship unused.

## Hard rules (from the spec)

1. No whole-model voxelization on the entity path; no `poly_mesh`.
2. `getPartDims()` only as an explicit, diagnosed AABB fallback.
3. No Minecraft block colours on the entity path.
4. Nothing silent: every part/print/transparency/pose/cluster/figure/door
   degradation lands in `craftmatic-diagnostics.json` and the export warning.
5. Don't touch the world-block pipeline, rideability, the DeLorean behaviour or
   the BlockGrid fallback to solve an entity-rendering problem.
6. Compile per unique part once; instance many; preserve exact source transforms.
