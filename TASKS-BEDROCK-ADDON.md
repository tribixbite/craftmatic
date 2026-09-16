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

## Awaiting the device round (2026-09-16, Opus subagent on the Pixel)

Each of these is a claim the offline gates cannot settle; the round writes
`output/bedrock-entity-qa/captures-2026-09-16/notes.md` + screenshots.
- [ ] X-wing: rider sits IN the cockpit (seat from Luke's eyes, `seatY` =
      eye − 1.25); figures and the cart stand beside it on the side the
      source put them. **Frame assumption to verify:** a render-frame offset
      lands in the world at yaw 0 as (−x, y, −z) (`extraPlacement`); the cart
      (LDraw x +413) should be on the pilot's LEFT. If it is on the right,
      flip the sign of `bx` in `extraPlacement` (one line) and re-export.
- [ ] Aircraft turn with the joystick (`player_relative` + free chase camera
      with the rider's pitch). Risk: `free_camera_controlled` may follow the
      SCRIPTED camera's facing rather than the rider's; the camera is aimed
      along the rider's exact yaw+pitch so both agree - if the plane still
      does not turn, try `minecraft:input_air_controlled` (needs the entity
      declared ≥ 1.21.90) or a script that reads `inputInfo.getMovementVector().x`
      and applies yaw.
- [ ] Milano flies nose-first (was 90° off: its wingspan is longer than its
      hull, and every plane vote measured "along the long axis").
- [ ] Scale on device: Senna ≈ 2.7 × 1.8 × 7.1 blocks; a figure NPC is
      player height; Tumbler 11.5 × 6.6 × 18.6.
- [ ] Museum: 6 doors open on tap; figures wander (`random_stroll`,
      `open_door`); the seat entity seats the player (seat position
      [0, −0.3, 0], `lock_rider_rotation: 181`).
- [ ] Content log clean for every pack (identifiers, `figureBehavior`
      components, the invisible seat's `entity_alphatest` texture).

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
