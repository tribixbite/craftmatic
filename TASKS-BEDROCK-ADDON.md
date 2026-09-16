# LEGO model → Bedrock add-on — tracker

**Handoff rule:** assume a context switch after every turn. This file holds OPEN
work and the measurements a decision still needs. Completed items are deleted;
history is `git log` and `docs/bedrock-addon-guide.md`, which carries every
hard-won fact (frame, budgets, Pixel import/command/camera recipe, riding facts,
the 2026-09-15/16 rounds, the minifig rig and the building shell). Spec:
`docs/bedrock-entity-spec-2026-09-14.md`.

## State (2026-09-16, rounds 4-5 settled on the Pixel; deploying)

Commits `66b0367`…`f214b1a` (rig, shell, seated figures, shell lighting). Every figure is a JOINTED minifig on the canonical rig
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

## Device round 4 — SETTLED (2026-09-16, Pixel 8 Pro, v26.45)

Evidence + full verdict table: `output/bedrock-entity-qa/captures-2026-09-16d/notes.md`
(64 shots + `contentlog-final.txt`). Result: **A/B/C/D PASS, E/F/G PARTIAL.**
Content log **zero `[error]`** in 39,876 lines (round 3's 24 `minecraft:home` errors
are gone). Chalet `1 structure piece and 14 entities`; walls stop the player at
**offset 0.00** on both axes at 0° AND at 90°; the player stands at y 67.00 /
70.00 with the drawn plate under the feet; 4/4 doors present (one already opened
by an NPC — `behavior.open_door` confirmed); figures 7/7, jointed, legs at
different swing angles, **2.03 blocks** beside the 1.80 player; seats seat.
90° rotation is CLOCKWISE: `wx = ox + (sizeZ−1−lz)`, `wz = oz + lx`, 4/4 doors.
Museum 7/7 figures, modular 8/8, Hogwarts places.

Still open from the round:
## Device round 5 — SETTLED (2026-09-16, `captures-2026-09-16e/notes.md`, 45 shots)

Shell lighting FIXED (`f214b1a`, origin one block over the roof): museum wall
mean grey 15.5 → 114.9/255, modular 12.1 → 110.7, chalet unchanged; shell still
at collider offset 0.00 after the lift, plate under the feet (y 67.00). Chalet
`1 structure piece and 17 entities`: figures 4/5/6 sit on their seats and stay
(three censuses over 22 min identical to 2 dp), the player sits on a free seat
first try. Content log zero `[error]` (18,578 lines).

Still open from rounds 4-5:
- [ ] **Chalet figures 1/3/7 did not move in 22 min** (figure 2 did; round 3's
      figures walked 5-18 blocks / 30 s on the block version). Suspects: spawned
      inside a part-height collider cell or an interior `random_stroll` cannot path
      out of; check with a census after `/tp` onto open floor and by reading the
      collider states around their spawn cells (`/testforblock`).
- [ ] Sit pose: thighs read forward, shoe ~1 block clear of the floor; hips occluded
      by the bench in every reachable angle (leg sign not disproven, not proven).
- [ ] **F not finished**: X-wing figures' walk cycle and a rider-in-cockpit view
      (the orbit camera cannot show the seat). Both figures are rigged (arms+legs).
- [ ] Figure height reads **2.03** blocks (hair + head stud over the 1.8 player).
- [ ] `natural_fig4` walked off the platform edge in round 4; `minecraft:home`
      tethering not re-measured.
- [ ] Hogwarts was cleared from the QA world and not re-placed; museum −153/66/504,
      modular −117/66/500, chalet −132/66/480 stand there; `doDaylightCycle` is FALSE.

## Open (not started)

- [ ] **Seated figures (built after the round-4 packs, device-unverified)**: a
      figure found on a seat now spawns riding that seat's entity (`rideOf` in
      placement.js `addRider`, seat `family_types` + `craftmatic_figure`) and the
      `sit` animation plays on `query.is_riding`. To verify on the Pixel: re-export
      the chalet (`round-2026-09-16b/chalet-seated.mcaddon` is one, 9 seats, figures
      4/5/6 seated), place, census figures 4-6 sit; check the leg sign (−90° may fold
      backwards) and that a seated figure does not wander.
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
