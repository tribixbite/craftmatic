# LEGO model → Bedrock add-on — tracker

**Handoff rule:** assume a context switch after every turn. This file holds OPEN
work and the measurements a decision still needs. Completed items are deleted;
history is `git log` and `docs/bedrock-addon-guide.md`, which carries every
hard-won fact (frame, budgets, Pixel import/command/camera recipe, riding facts,
the 2026-09-15 and 2026-09-16 rounds). Spec: `docs/bedrock-entity-spec-2026-09-14.md`.

## State (2026-09-16, built and gated offline; device round in progress)

Everything LEGO in Bedrock is now at ONE scale (`engine/lego-scale.ts`): a
minifig is player height, 1 block = 53.33 LDU (was 1 block = 5 studs, 1.8×
too small). Vehicles seat the rider on the driver figure (removed from the
geometry), the objects found beside a vehicle are separate entities (figures
wander, a wheeled object rides, a wheel-less one is a prop), a building's
figures walk, its seats sit, its door leaves are vanilla doors, and every
vehicle - aircraft included - turns with the joystick under a script chase
camera. Offline gates on the eight models (`output/bedrock-entity-qa/round-2026-09-16/`,
`run-exports.sh`, `*.summary.json`, `sil-*/`): root + web typecheck clean,
vitest 1,589 passing, 26 skipped (`vitest-final.log`); prod smoke 13/13 after deploy, silhouette `IoU kept` X-wing 0.953,
Milano 0.962, Senna 0.991 (the `full` scores dropped on purpose: the extras
are no longer in the vehicle's geometry).

```
lego.ts ─► ui/schem-export.ts ─► Worker: schem-pipeline.ts runSchemPipeline()
   ├─ discoverPlayableComponents()   playable-components.ts  (named submodel ≥ ½ wins)
   ├─ discoverSceneActors()          bedrock-scene-actors.ts (figures / seats / door leaves in the scenery)
   │    └─ applySceneDoors()         leaf cells → air, vanilla doors in the opening
   └─ buildPlayableAddon()           playable-addon.ts       (behaviour, presets, scripts, atlases, ghost, seats, figure NPCs)
        ├─ compileLdrawEntityGeometry()  ldraw-entity-compiler.ts
        │    prepareEntityPlacements: level → meshes → connected clusters → classify extras
        │    (figure / vehicle / prop) → stand rules → inferVehicleNose (vehicle-facing.ts)
        │    → findCockpit (seated figure > seat > steering wheel > canopy mould > big glass
        │    > default) → driver figure removed → prototypes → instance → cull → studs → recentre
        ├─ extraPlacement()              secondary entities placed in the vehicle's frame
        └─ buildPreviewGhost()           bedrock-preview-entity.ts
```
CLI gate: `bun scripts/_playable_ref.ts <model> [out] --label=… [--quality=…] [--main-only] [--resolution=auto|minifig]`.
Evidence probe: `bun scripts/_vehicle_probe.ts <model> --label=… [--extremes=1] [--glass=1]`
prints clusters, extras, facing votes and the cockpit exactly as the compiler
sees them. Silhouette: `bun scripts/_entity_silhouette.ts <model> --label=… --out=<dir>`
(side view: nose on the LEFT). **Use a label whose stem does not start with a
digit.** Pixel helpers: `scripts/_pixel_shot.sh`, `scripts/_pixel_cmd.sh`.

## Device rounds (2026-09-16)

Round 1 (`captures-2026-09-16/`) settled: rider IN the X-wing cockpit; both
planes nose-first; Senna 2.70 × 2.01 × 7.12 blocks; the cart on the pilot's
LEFT (the `extraPlacement` frame holds); the seat entity seats. Round 2
(`captures-2026-09-16b/`, 75 shots) settled the fixes: figures parse and the
wand places every actor; the joystick TURNS the Senna and the X-wing (0.00
blocks of strafe over three trials, heading +69°); figures stroll 10-18
blocks / 30 s and stand 1.96 blocks (hair and head stud over the 96 LDU
bare figure; accepted). Round 2 also found: 5 of 6 museum doors entombed and
the Winter Chalet a floating sparse slab - both from the **DbixConvV3
sources, which are exploded instruction layouts** (chalet 125 × 116 studs
there, 41 × 18 in its `.io`; museum 114 studs wide vs 48). Fixed since: door
leaves hang ON the floor row (an 8 LDU baseplate makes its cell solid), a
passage is opened to the nearest air within three cells, the outside of the
model counts as open, `GLASS DOOR FOR FRAME` (60616's unofficial file) is a
leaf, `bl_…_torso` Studio ids are figures, figures are tethered
(`minecraft:home` radius 12). Buildings now export from `IOModel2V2/10326-noprint.ldr`,
`IO/910004.io`, `IO/910047.io` (`run-buildings.sh`): museum 6 doors / 9
figures / 1 seat (2 doors still "no room within three blocks"), chalet 4
doors / 7 figures / 6 seats, 910047 8 figures. Round 3 (Opus subagent,
`captures-2026-09-16c/`) re-tests them:
- [ ] Museum and chalet place as recognisable buildings; doors rest on
      blocks, are reachable and open; figures stay within ~12 blocks; seats
      seat; 910047's 8 figures walk.
- [ ] **Which source the LEGO tab serves matters**: the prod index lists
      `IO/10326-noprint.io` first for 10326 (79 studs wide - sub-builds beside
      each other) and DbixConvV3 for many sets. An exported building is only
      as good as the layout of the source the user loaded; consider a
      "compact layout" quality flag in the index (lego-sources-guide).
- [ ] Tumbler at 32 LDU grain reads 14.5 blocks wide (true 11.5) with blobs
      where the rear tyres are: the repeated-part budget item below.

## Open (not started)

- [ ] **Beds / brick-built chairs**: LDraw has no bed mould and modular
      buildings build chairs from bricks; only seat moulds (4079 family,
      "Seat"/"Chair"/"Bench" descriptions) are sittable. A bed heuristic
      (2×4+ plate with a 1×2 slope "pillow") is not designed.
- [ ] **Door sizing**: a 1×4×6 leaf (80 LDU = 1.5 cells) hangs 2 doors when
      it straddles two cells cleanly and 1 when its bounds read 1.36 cells
      (`60616a`: bounds −6.5..66); the museum got single doors in 1.4-cell
      openings. Decide whether a 1×4 leaf should always be a double door.
- [ ] **Repeated-part budget** (76240: `70695` ×184 at 16 LDU); stud budget
      on the Milano (716 exposed studs omitted at balanced).
- [ ] Swipe-to-look untestable over adb; `30426`/`28710`/`x346` part ids
      with no LDraw mould; Molang `.r/.g/.b` errors seen once in the content
      log UI; Vibrant Visuals never seen on a device that renders it; stale
      pack folders on the Pixel (`adb shell rm` denied).
- [ ] The `_chase`/`_boom` orbit presets still ship but nothing applies
      them unless the free camera is refused.

## Hard rules (from the spec)

1. No whole-model voxelization on the entity path; no `poly_mesh`.
2. `getPartDims()` only as an explicit, diagnosed AABB fallback.
3. No Minecraft block colours on the entity path.
4. Nothing silent: every part/print/transparency/pose/cluster/figure/door
   degradation lands in `craftmatic-diagnostics.json` and the export warning.
5. Don't touch the world-block pipeline, rideability, the DeLorean behaviour or
   the BlockGrid fallback to solve an entity-rendering problem.
6. Compile per unique part once; instance many; preserve exact source transforms.
