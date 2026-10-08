# Physics architecture

Every model in the add-on pipeline that moves something over time: the coaster
ride and its walk-preview mirror, pinball, the walk-preview player, figure
life, and the vehicles (which Bedrock's own engine moves). What each one
integrates, in what units, with which constants and why, how the pure
functions are shared between the device, the preview and the tests, and what
is known to be wrong or unproven.

**This file is gated.** `bun scripts/_physics_spec_check.ts` (and
`test/physics-spec.test.ts`, so `bun run test` and CI) fail when:

- a path written in backticks here does not exist;
- a module with an exports table below gains, loses or re-kinds an export
  that the table does not match;
- a value in the constants table differs from the code;
- a new file under `web/src/engine` or `web/src/ui` whose name looks like
  physics (`PHYSICS_NAME` in the checker: coaster, pinball, vehicle, walk,
  scale, train, ride, playable, figure-life, motion, drive, ...) is not
  classified here.

So a change to a physics constant or API is not finished until this file says
so. When the check fails, fix the SPEC if the code is right, or the code if
the spec is. `bun scripts/_physics_spec_check.ts --list <file>` prints a draft
exports table for a new module. The machine-read blocks are the tables
between `<!-- physics-spec:... -->` comments; the checker's header documents
their format.

## Contents

1. [Is the gravity right?](#1-is-the-gravity-right) — the audit's verdict
2. [Units, frames and the tick](#2-units-frames-and-the-tick)
3. [Minecraft's own physics, for reference](#3-minecrafts-own-physics-for-reference)
4. [The subsystems](#4-the-subsystems)
5. [Serialised runtimes: the rules](#5-serialised-runtimes-the-rules)
6. [Who shares what (DRY map)](#6-who-shares-what-dry-map)
7. [Adding a vehicle class or a physics module](#7-adding-a-vehicle-class-or-a-physics-module)
8. [Wand size and Froude scaling](#8-wand-size-and-froude-scaling)
9. [Constants](#9-constants)
10. [Measured facts](#10-measured-facts)
11. [Known limits](#11-known-limits)
12. [Module inventory](#12-module-inventory)

## 1. Is the gravity right?

**Yes, in each model's own frame, and now with a stated reason for its
value.** Numbers (2026-09-25):

| Model | Gravity | Frame | Physically right? |
|---|---|---|---|
| Coaster ride | 19.6 blocks/s² along the track tangent (`9.8 × pace²`, pace √2) | world blocks, real seconds | The law is right: `a = −g sin θ` for a point on frictionless rails, and a lossless run (no drag, rolling, ceiling, floor or chain) conserves `v²/2 + g h` to 1.1 % over 10303's drop and both loops, at 100 % and at 200 % (where the energy doubles, as the height does). The VALUE is 2 g: time-scaled, deliberately (below). |
| Coaster preview | the same `COASTER_PHYSICS` object | the same | Shares the pure `rideSubstep` integrator; preview route/state handling remains separate (§6). |
| Pinball | 1,100 LDU/s² down the table plane | LDU in the table plane, seconds | A ball rolling on the real 8.6° playfield accelerates 2,630 LDU/s² (5/7 g sin θ; 3,680 if it slid). 1,100 is that slowed to 0.65 of real time. A game constant, not the world's gravity: it does not read the tilt and does not change with wand size. |
| Walk-preview player | 0.08 blocks/tick² with 0.98 drag | world blocks, ticks | Minecraft's own player numbers; the integrator reproduces the 1.2522-block jump in 12 ticks. |
| Figures | Bedrock's engine (entity `has_gravity`) | world | On device the engine applies Minecraft's own mob gravity. The headless simulator runs its shared `tickBody` gravity, collision and friction; native engine behavior still needs device evidence. |
| Vehicles | the scripted runtime (cars, hover craft, boats, ships); Bedrock's engine (rotorcraft, flyers) | world blocks, seconds | Scripted vehicles have no engine gravity: `carStep` falls at `CAR.GRAVITY` 20 blocks/s² (Minecraft's own 16-32 band), a hover craft sinks at 6, a boat falls at 20; a SHIP has none at all - it hovers (spaceship controls, §4.6). Native mounts hover with no gravity. |

**Why the coaster is not at 9.8.** Real gravity was ridden on the Pixel
(2026-09-24) and read "about 50 % too slow"; pace 1.6 (25.1 blocks/s²) read
"just a touch too fast" (2026-09-25). A LEGO ride is a full-size ride in blocks
(the minifig is the player's 1.8 blocks) built with toy radii, and it sits in
a world that is itself time-scaled: Minecraft's items, minecarts and boats
fall at 16 blocks/s² (1.63 g) and its players and mobs at 32 (3.27 g).
Pace √2 puts the ride at exactly 2 g = 19.6 blocks/s², inside that band, and
has a physical reading: speeds on a loop go as `sqrt(g r)`, so doubling g on
a loop of half the real radius gives the full-size ride's speeds (Froude
similarity). 10303's loops are r = 3.93 blocks. It is 11.6 % slower than 1.6
in every speed, and 10303's cycle is 11 % longer (the dwell ticks do not
scale). It is a perceptual choice with two anchors, not a derivation from
first principles: nothing makes √2 more "correct" than 1.45. Device check
open (§11).

**What was wrong, found by this audit.**

- The coaster's `MAX_SPEED` was a literal 32 while every other speed was
  written as `× COASTER_RIDE_PACE`. It is now `20 × pace`, so a pace change is
  an exact time-scale of the whole ride.
- The two 10303 ride tests that broke at pace 1.4 ran WITHOUT the cars'
  measured wheelbase, so their yaw was the raw polyline tangent. Loop 1's
  apex has a 0.147-block piece at a fragment join running exactly along +X,
  10.6° off the helix's heading, flanked by segments 6.7° the other way, and
  whether a tick landed on it was sampling phase: the loop test read 11.2° in
  one tick at pace 1.40, 7.8 at 1.41, 9.4 at 1.60. The clamp-camera test
  swung the same way (worst 59.7 / 37.0 / 48.8° from vertical). A SLOWER ride
  failing was never about speed. With the 0.94-block chord the pack really
  ships (`liftHost(..., WHEELBASE_10303)`), the worst per-tick yaw step is
  7.3-9.2° and the camera 30-46° from vertical at EVERY pace from 1.30 to
  1.62; the thresholds were not loosened.
- The pinball comment claimed an 8.45° table and a sliding ball (3,600
  LDU/s², time ×0.55). The measured tilt is 8.6° (sin 0.15) and a ball rolls:
  2,630 LDU/s², time ×0.65.
- `addon-walk.ts` documented its jump peak as 1.2519 blocks; its own
  `JUMP_PEAK` computes 1.2522 (the wiki's figure too).

**What is still not Froude-consistent** (documented in §8 and §11, not
changed here): the ceiling, the rolling/drag losses, the chain, the brake and
the platform speed are absolute world numbers, so a ride placed at 200-400 %
is not a bigger real ride; the pinball and figure speeds do not follow
`sqrt(size)` either.

## 2. Units, frames and the tick

| Quantity | Value | Where |
|---|---|---|
| LDU | 0.4 mm of LEGO; a stud is 20 LDU, a brick 24 LDU tall | LDraw |
| Minifig height | 96 LDU = 1.8 blocks (the player) | `web/src/engine/lego-scale.ts` |
| 1 block at 100 % | 53.33 LDU = 2.67 studs = 21.3 mm of LEGO | `LDU_PER_BLOCK` |
| 1 block | 1 m (Minecraft's own convention: the wiki gives entity motion in m/tick) | minecraft.wiki |
| LEGO → world at 100 % | 1 : 46.9 (1.8 m / 38.4 mm) | derived |
| Wand size f (25-400 %) | world block = model block × f, so LEGO → world is 1 : 46.9 f | `coaster_scale` / placement property |
| Model scale (`addon-scale.ts`) | multiplies `LDU_PER_BLOCK` at EXPORT time (auto: 1× minifig sets, 2× microfigure sets, display vehicles shrunk to real length) | `planAddonScale` |
| Bedrock geometry unit | 1/16 block; 0.3 per LDU at 100 % | `BEDROCK_UNITS_PER_LDU` |
| Tick | 1/20 s. The coaster, pinball and figure runtimes run every tick, the vehicle driver every 2 ticks | `system.runInterval` |

**Frames.** LDraw is Y DOWN; every runtime works Y UP (`sceneGridPoint` /
`sceneGridVector` convert). A coaster route is in MODEL blocks (the export's
grid at 100 %); its speeds are WORLD blocks/s, and one tick advances
`speed / (20 × scale)` model blocks. Heights that enter energy are
`model height × scale`. Pinball runs in the table plane: `u` DOWN the table
toward the player, `w` across, in LDU; the ball's world pose is
`p0 + u·U + w·W` (`PinballMap`) at the placement's scale. Bedrock yaw 0 faces
+Z, +yaw turns right, +pitch looks down; the camera takes a pitch within ±90
only (`setCamera`), and roll only as an animation keyframe.

## 3. Minecraft's own physics, for reference

From minecraft.wiki, [Entity, "Motion of entities"](https://minecraft.wiki/w/Entity)
and [Jumping](https://minecraft.wiki/w/Jumping). Per tick; 1 block = 1 m.

| Entity | Gravity (blocks/tick²) | = blocks/s² | Drag (vertical / horizontal) | Terminal |
|---|---|---|---|---|
| Players, living mobs | 0.08 | 32 (3.27 g) | 0.98 / 0.91 | 3.92 blocks/tick = 78.4 blocks/s |
| Items | 0.04 | 16 (1.63 g) | 0.98 / 0.98 | 1.96 blocks/tick |
| Falling blocks, TNT | 0.04 | 16 | 0.98 | |
| Minecarts | 0.04 | 16 | 0.95 / 0.76 | |
| Boats | 0.04 | 16 | (Java: 0.90 horizontal) | |
| Arrows, tridents | 0.05 | 20 | 0.99 / 0.99 | 5.0 blocks/tick |

A player jump starts at 0.42 blocks/tick and peaks at 1.2522 blocks after 6
ticks, landing after 12 (0.6 s). Under real gravity the same peak takes
1.01 s: the player's world runs at about 1.7× real time for falls. Walking is
4.317 blocks/s (3× a real 1.4 m/s walk). `web/src/engine/addon-walk.ts`
implements exactly these numbers and `test/addon-walk.test.ts` pins them.

## 4. The subsystems

### 4.1 Coaster ride — `web/src/engine/bedrock-coaster.ts`

**Model.** The train is one scalar arc distance (its CENTRE) and one speed on
a sampled polyline; car k sits at `centre + extent/2 − k × spacing`. Per tick,
in substeps no longer than one authored sample spacing:

    a = −GRAVITY × grade − ROLLING − DRAG × v²        [world blocks/s²]
    grade = mean over the cars of the chord's y (sin θ), × direction

    n  = ceil(((max(v, inversion floor) + (GRAVITY + LIFT_ACCEL)/20) / (20 × scale)) / maxSpacing)
    dt = 0.05 / n;   v ← max(0, v + a dt);   arc ← arc + v dt / scale   (model blocks)

The integrator is semi-implicit Euler on the scalar speed, re-sampling the
grade where the train actually is each substep. Then, in order: the chain
(`grade > LIFT_GRADE` and `v < LIFT_SPEED` → accelerate at `LIFT_ACCEL` up to
`LIFT_SPEED`, only over a MEASURED drive's sprockets when the set has one),
the floor `MIN_SPEED`, the inversion floor
`INVERSION_MARGIN × sqrt(GRAVITY × r × scale × −up.y)` through a loop
(`coasterLoopRadius`, zero at vertical so it never kicks); after the
substeps, the station brake `v ≤ sqrt(2 × STATION_BRAKE × toStop × scale)`
(reaches zero exactly at the stop) and the ceiling `MAX_SPEED`, with the
tick's advance rescaled by what they removed.

**Pace.** `COASTER_RIDE_PACE` multiplies every speed and the square of it
every acceleration, so a pace change is a pure time-scale: the same ride, the
same loops made or missed, played faster or slower. `DRAG` is pace-invariant
(`DRAG × v²` scales with pace² by itself). Dwell and hold ticks are NOT
scaled; they are waiting time, not motion.

**Attitude.** Pitch and yaw from the CHORD between the car's wheel contacts
(`wheelbase`, measured from the set's wheels); yaw from the axle's heading so
it never swivels through a helical loop (`coasterCarAttitude`); roll from the
per-sample track up (`coasterTrackUps`: gravity's up where upright, the loop's
own normal through a loop, twist bounded by `TRACK_TWIST_RATE_DEG_PER_BLOCK`).

**Rider camera.** `coasterRiderView` / `coasterRiderLook`, constants in
`COASTER_RIDER_VIEW`. Default `loop`: tick by tick the `reflect` view (yaw
from the view's right axis — the car's axle — so it never re-derives a yaw
from a near-vertical nose; the pitch folded back into ±90 past vertical),
and each inversion sent as ONE camera animation that rolls, planned by
running the ride's own `integrate` / `carPose` ahead of the train
(`planInversion`); it hands back the instant the ride leaves the plan.
The prediction runs only with inverted track within reach (`planner.near`)
and stops early, so a steep drop on a route with no loop costs the ride's
own step alone: an 80-tick prediction on every steep tick overran the
device's script tick on 10261 (2026-09-25) and slowed the whole ride.
Both cameras trail the server's train so they ride the DRAWN seat (the
client draws entities interpolated behind the server; marker-measured on the
Pixel): the per-tick camera by `tickLag` (1.5) and the animation by `animLag`
(3.5), fractional ticks read between two poses. The animation is planned
`animTail` ticks past its hand-back so the per-tick camera takes over while
it still plays (an animation that ended first flashed the player's own view),
and the hand-back `setCamera` is placed at the eye the animation is showing. Its keyframes are `over` views — a
CONTINUOUS pitch past ±90 (which `playAnimation` takes and `setCamera`
refuses), the yaw of the right axis, a residual roll — because the client
interpolates keyframe Euler angles linearly: the ±90 chart's flip at the
zenith was drawn as a 180-degree spin (2026-09-29).
`clamp` (the first shipped mode) turned the yaw over at `maxTurn` a tick past
every vertical, which is what the user saw as a 90° turn on 10303's
overhanging drop and a sideways swing in the loops. Device facts and the
modes: the add-on guide, "The rider's camera follows the track".

**Wand size.** Every speed is world blocks/s and every height `× scale`, so
gravity-driven speeds grow as `sqrt(scale)` (Froude-correct) until the
absolute ceiling and losses bite (§8).

Tests: `test/bedrock-coaster.test.ts` (serialised runtime on host;
`liftHost` / `rideHost`; the 10303 and 10261 corpus rides),
`test/bedrock-coaster-path.test.ts`, `test/coaster-preview.test.ts`.
Probes: `scripts/_coaster_pace_scan.ts` (pace, size, energy), `scripts/_coaster_route_probe.ts`, `scripts/_coaster_roll_probe.ts`,
`scripts/_coaster_qa_pack.ts`. History and device rounds: the add-on guide's
coaster sections, from "Measured coaster runtime" on.

### 4.2 Coaster walk preview — `web/src/engine/coaster-preview.ts`

`stepCoasterPreviewTick` advances train 0 one tick for the LEGO tab's "Walk
add-on" (`web/src/ui/addon-preview.ts`). It takes `COASTER_PHYSICS`,
`coasterTrackUps`, `coasterLoopRadius` and `coasterCarAttitude` from
`bedrock-coaster.ts` unchanged, and integrates with the SAME speed step the
runtime serialises, `rideSubstep` (§4.1a): the numeric core is no longer
mirrored. The substep bound, station brake and lift hand-off are still the
preview's own state machine. The second train is drawn parked, and the
platform lift is a visual analogue. A railway route (`route.physics`) is
drawn parked: nobody drives a preview train.

### 4.1a Rail vehicles — the coaster engine with a driver

`rideSubstep(speed, direction, gradeArc, dt, input, P)` in
`bedrock-coaster.ts` is the one speed step every rail vehicle runs. The
runtime receives it as an argument and serialises it (§5); the preview and
the tests import it. Without `P.DRIVER` it is §4.1's integrator body in the
same floating-point order (the chain, `MIN_SPEED` and the inversion floor
included): bit-identical over 20,000 sampled states, and the shipped
10303/10261 runtimes replayed through the refactored `coasterScript` digest
identically (`scripts/_coaster_replay.ts --rebuild`).

With `P.DRIVER` (`RAIL_TRAIN_PHYSICS`, carried per route in
`CoasterRuntimeRoute.physics`) the state is a signed velocity along the arc:

    a = −GRAVITY × grade − sign(u) (ROLLING + DRAG u²) + push × TRACTION     (pushing with the motion, or from rest)
    a = … − sign(u) × BRAKE × |push|                                         (pushing against it)
    a = … − sign(u) × PARK_BRAKE                                             (nobody aboard)

`push` is the rider's stick (`inputInfo.getMovementVector().y`) against the
train's FIXED nose (its cars' authored heading), so the stick never flips at
a reversal. A route with a driver makes `coasterRuntimeConfig` set
`inputEvent` (`FLIGHT_INPUT_EVENT`, the scripted vehicles' hook): `/scriptevent
craftmatic:flight_input {"id":"<any car>","y":1,"ticks":40}` is that train's
stick for 40 ticks (no `id`: every train), and counts as a driver aboard. A
GameTest simulated player's stick never reaches `inputInfo` (Pixel,
2026-09-25), so the device's train test (`train_<id>_<n>`) drives it this way. Losses and brakes stop a train and never reverse it; from rest
only a push or a grade steeper than the rolling loss starts it, and the
runtime reverses only on a tick that begins at rest. `|u| ≤ MAX_SPEED`. No
chain, inversion floor, minimum speed or station dwell; an open end is a
buffer stop that holds the end car on the line (`cars.endInset`, half its
measured length), not a shuttle reversal. Everything else — track routing
(`coaster-track.ts`, railway profile family), car detection
(`coaster-assemblies.ts`, railway branch), attitude, boarding, the rider
camera — is the coaster's. Constants are world-absolute (a motor, not
gravity), so the wand size does not rescale them. Tests:
`test/rail-track.test.ts`; guide: "Rail vehicles on the coaster engine".

### 4.3 Pinball — `web/src/engine/pinball-physics.ts`

`createPinballSim` is the whole game physics: a disc of `ballRadius` sliding
in the table plane under `gravity` along +u, colliding with the static field
through a signed distance field (bilinear, central-difference normal,
restitution `wallBounce`), flippers as swinging capsules whose surface
velocity makes the shot (`flipperBounce`, `flipperUpSpeed`,
`flipperDownSpeed`), bumpers that kick at `bumperKick`, and a spring plunger
(`launchMax × pull`, so energy goes as pull²). Semi-implicit Euler; each tick
is split into 2..`substeps` substeps so nothing moves more than
`maxStepFraction` of the ball radius (ADAPTIVE: a slow ball takes 2), plus
a linear damping of 8 % a second.

Units are LDU and seconds, in the table's own plane, at a 0.65× time scale
(§1). The world never enters: the table is a toy played as a toy, so at 1×
(a 17-block table) the ball's along-plane acceleration is 20.6 blocks/s² and
at 400 % it is four times that, with the same game timing. The table (plane,
tilt, flippers, bumpers, SDF, plunger lane) is measured by
`detectPinballTable` / `pinballSimTable` in `web/src/engine/pinball-table.ts`;
`web/src/engine/bedrock-pinball.ts` places it, serialises `createPinballSim`
into the pack (`pinballScript`) and steps it every tick with dt 0.05. The
walk preview runs the same function (`addon-preview.ts`).

Tests: `test/pinball.test.ts`, `test/bedrock-pinball.test.ts`. Probes:
`scripts/_pinball_probe.ts`, `scripts/_pinball_zone_report.ts`. Device
notes: the add-on guide's "Pinball" section.

### 4.4 Walk-preview player — `web/src/engine/addon-walk.ts`

`tickPlayer` is Minecraft's player per tick (§3), since 2026-09-30 in the
headless simulator's body module (`web/src/sim/physics/body.ts`, generic over
any `SolidQuery`: `moveBox` is the sweep and auto-step, `tickBody` the same
for a mob moved by impulses); `addon-walk.ts` re-exports its constants and
runs it over its collider world (`WalkWorld.solidsNear`), and the simulator
runs it over its voxel world (`web/src/sim/physics/systems.ts`, docs/sim-engine.md).
It is a 0.6 × 1.8 box, gravity
0.08 with 0.98 drag, jump 0.42, walk 4.317 blocks/s (sprint ×1.3, sneak
×0.3), ground friction 0.546 (0.6 slipperiness × 0.91), air 0.91 with 0.02
air control, auto-step 9/16, collision per axis against the exact collider
blocks the pack ships at that size (`ScaledColliderGrid`). `simulateReach`
floods the surface graph with this continuous player and `compareReach`
reports every disagreement with the reach BFS (`walkScaledColliders`). Used
by the walk preview, `web/src/engine/interactive-walk.ts` (doorway
passability) and `scripts/_addon_walk.ts`. Tests: `test/addon-walk.test.ts`.

### 4.5 Figure life — `web/src/engine/bedrock-figure-life.ts`

Figures walk by VELOCITY (`applyImpulse` to a target horizontal velocity);
the engine's own collision, gravity and step-up carry it out. The planner
(`exploreWalkable`, `standFeetAt`, `pathTo`, ...) plans over the real collider
spans, never above a 0.6-block rise or below a 0.6-block drop. Speed
`FIGURE_TUNING.speed` 0.06 blocks/tick asked at 100 % (the Pixel realises
0.0415, 0.83 blocks/s: ground friction takes the rest between impulses), × the size
factor below 100 % (figures never grow above player size), slowed ×0.35 into
a sharp corner. Where each figure SPAWNS is decided at export over the same collider grid
(`resolveFigureSpawn`, called by `playable-addon.ts`): kept when its own
column carries it; set down on the surface below when it stood on no part
(LEGO's box-art line-up beside the model: 21360, 42639, 43267, 77092); moved
to the roomiest standable column within 2 cells when it stood inside a
collider column (cost = distance + 1.5 x drop + 3 x rise, at least
`minRoamCells` of room preferred). No collider is added for it. The placement
runtime's own lift (`spawnLift` mirrors it) then has nothing to do; before
this it raised such figures 1.2-2.6 blocks onto the roof above them.
`web/src/sim/adapters/craftmatic/figure-life.ts` runs the SERIALISED
runtime on the headless simulator over the pack's collider cells (the kit's
real block definitions), figures as mobs under `minecraft:physics` moved by
the simulator's one integrator (`tickBody`: gravity, the per-axis sweep, the
9/16 step, ground friction); it answers "do the figures roam and stay home"
offline. Until 2026-09-30 it ran over a stand-in world
(`engine/figure-life-sim.ts`, folded: a 0.6 auto-step, a 0.4-block/tick drop).
Device truth: the
`figures_<id>` GameTest (`web/src/engine/gametest-pack.ts`). Tests:
`test/bedrock-figure-life.test.ts`; census `scripts/_figure_roam_census.ts`.

### 4.6 Vehicles — `web/src/engine/playable-addon.ts`, `web/src/engine/bedrock-vehicle.ts`

Two kinds of vehicle, chosen by measurement (GameTest and real rides on the
Pixel, 2026-09-25; `docs/bedrock-addon-guide.md` "Vehicle operation"):

- **Car — SCRIPTED** (`carStep`, below), EVERY car since 2026-09-25: the 10300
  time machine and a grid-only car included, so no camel is left. The camel
  controller (`input_ground_controlled`) failed a real rider on the Pixel,
  2026-09-25: under `player_relative` the rider's yaw turned by itself ~36
  degrees every 4 ticks with the stick held straight and the car drove circles
  in every camera mode; under the default and `player_relative_strafe`
  schemes it drove straight but the stick's left/right slid it sideways
  without turning it; and it stopped dead on release (2.3 blocks from 43
  blocks/s). The time machine's circuits (`timeMachineRuntime`) no longer
  drive it: they set its top speed through the `VEHICLE_DYNAMIC.topSpeed`
  dynamic property (`TIME_MACHINE.TOP_MARGIN` × the armed jump speed, 88 mph
  by default), put the circuit on the HUD (`VEHICLE_DYNAMIC.hud`) and jump
  when the measured speed reaches the armed speed. The camel's tuning hooks
  (`craftmatic:vehicle_scheme`, `vehicle_camera`) went with it.
- A car with nobody aboard BRAKES (`CAR.BRAKE`) instead of coasting: an
  empty time machine got out of at 91 mph coasted 200 blocks on the Pixel.
  And no scripted vehicle moves where the block under it or at its nose is
  not loaded: it holds still (that empty car ran into unloaded terrain and
  fell 250 blocks through the ground it could not read).
- **Hover craft — SCRIPTED on `carStep`** with `HOVER`: the ground it rides
  is the top of whatever is under it, solid OR water, plus `RIDE_HEIGHT`; it
  glides, floats over `STEP_UP` 1.6 and sinks slowly off an edge. A title in
  `HOVER_WORDS` (75397's "Sail Barge", a speeder) makes a vehicle a hover
  craft whatever its kind (`vehicleMotionOf`).
- **Rotorcraft — native.** The vanilla Happy Ghast: `has_gravity: false`,
  hover movement and navigation, `free_camera_controlled`, `flying_speed` 0.3,
  `vertical_movement_action` +0.5 (climb) / −0.5 (descend group).
- **Flyer — native, the same controller** (`VehicleMotion` `flyer`; a canon
  mount, set-canon.ts: 11390's Flying Nimbus, `web/src/engine/bedrock-flyer.ts`).
  A free-flying mount: it hovers in place when idle (no gravity, no stall, no
  take-off run), moves where the rider looks, Jump climbs, back + Jump
  descends - the rotorcraft's controller, device-proven (Saga, 2026-09-29:
  orbit, summon, mount, climb ~20 blocks/s, hover, fade, cap, undo), at its
  own cruise: `FLYER.FLYING_SPEED` 0.0725 in place of the rotor's
  `ROTOR_FLYING_SPEED` 0.3, which flew the Nimbus at 38.3 blocks/s (85.7 mph
  HUD, Pixel 2026-09-29) - far too fast for a child round a ten-block model.
  The controller's speed is not proportional to the value: 0.09 measured
  13.1 blocks/s (not 11.5), so the two points fit v ≈ 120·fs + 2.3 blocks/s
  and 0.0725 is ~11 blocks/s (to be confirmed on the next round). The
  same at every wand size, as every vehicle's speeds are (§8). The
  native controller does NOT turn the look pitch into descent (26.52): the
  driver puts the descend group in while the rider looks down past
  `FLYER.DIVE_PITCH_DEG`, so look down + Jump dives, exactly as back + Jump.
  What differs is the dressing: no rotor sound, no flame, no nose dip
  (`VEHICLE_BODY_MOTION.flyer` banks a little and keeps the nose level), cloud
  puffs under it while it moves and on Jump (`FLYER_PUFF_PARTICLE`), the HUD
  word from the canon (`NIMBUS`), and a client-side idle bob on the `body`
  bone (`FLYER_BOB`: one geometry unit up and down every 3 s, Molang, no
  script). The rider sits ON it: the seat is the geometry's top surface,
  scaled with the wand's size steps like every vehicle seat. The cloud the
  player rides is SUMMONED - a tap on the companion figure, its cloud or its
  seat spawns one beside the player and mounts them (`flyerRuntime`,
  `BP/scripts/flyer.js`); an empty one fades after `FLYER.EMPTY_DESPAWN_TICKS`,
  at most `FLYER.CLOUD_CAP` exist. A rider who LEAVES a cloud in the air
  (sneak, the fade's eject, the cap) gets slow falling for
  `FLYER.DISMOUNT_SLOW_FALL_TICKS` unless a solid block lies within
  `FLYER.DISMOUNT_DROP_BLOCKS` under their feet - the Script API has no
  dismount event, so `flyer.js` polls who is aboard every 10 ticks (a sneak
  at ALT 169 dropped the Saga rider 229 blocks). Pixel re-check
  (2026-09-29, `output/nimbus-pixel-0929/`): the ride hint, the HUD speed
  (85.7 mph HUD against 85.9 true; CMVT cadence 4 ticks), the look-down dive
  (~4 blocks/s down against ~22 up) and the float-down all PASS; the
  `entity_sounds` `fly: ""` entry did NOT silence the verbose line (711
  lines; the Saga A/B of 2026-09-29/30 found the hook: a block-material
  `interactive_sounds.block_sounds.normal.events.fly: ""` in every pack with
  an entity, `flySoundEvents`, 0 lines in every window). Not
  yet on a device: the slower cruise, the hint on a remount of the same cloud
  (the driver now forgets its rider when the seat is empty), the seat retry
  at placement (`bedrock-placement-pack.ts`, `SEAT_RETRIES`).
- **Ship — SCRIPTED, spaceship controls** (`flightStep`, 2026-09-30), every
  scripted aircraft: a fixed wing, the X-wing (7140), the Milano (76286), any
  ship or spacecraft (`vehicleMotionOf`: a `plane` kind that is not a
  rotorcraft). The user: "more like spaceship less like flight simulator ...
  there should be a way to go straight up or backwards". The stick's
  forward/back is thrust along the heading, forward to `MAX_SPEED` and
  straight BACKWARDS to `REVERSE_SPEED`; hands off it stops (`BRAKE`) and
  hovers where it is - no lift, stall, glide, take-off run or landing roll.
  Left/right turns it, at rest too. Jump goes straight UP; Jump with the
  stick pulled back past `DESCEND_STICK`, or a Jump PRESSED while the
  rider's view looks down past `DIVE_PITCH_DEG` (the free look's pitch,
  `VEHICLE_DYNAMIC.lookPitch`, latched until Jump is let go), goes straight
  DOWN - the Nimbus's own "back + Jump" and "look down + Jump", since Sneak
  is the dismount and no other touch input is free. It settles on the
  ground or water under it and glides over a block's rise there; off an
  edge it hovers. With nobody aboard it brakes and sinks gently
  (`IDLE_SINK`) to the ground and parks - never onto a player under its
  footprint: it holds `PARK_CLEARANCE` over the highest head under it
  (`PLAYER_HEIGHT` tall), level, and sinks on when they walk out (the rider
  who sneaked off in the air fell straight under the X-wing and it parked ON
  the child, Saga 30j s79, CMVT 15:28:07-11); a hop's hold keeps it hovering
  (§4.8). The body pitches with its climb and dive and banks into a turn
  (attitude only). The flight model it replaced (throttle on Jump, elevator
  on the stick, stall below 7 blocks/s, a 10-blocks/s take-off run) is in
  git history at `90b6c0b0`.
- **Car, hover craft, ship and boat — SCRIPTED** (`BP/scripts/vehicles.js` in the pack,
  `scriptedVehicleRuntime`). Every native speed is `SCRIPTED_NATIVE_SPEED` (0)
  and gravity is off; the Happy Ghast rider components stay only so Jump is an
  input, not a dismount (measured: a real rider held Jump and stayed seated).
  Each tick the runtime reads the controlling rider's `inputInfo` (or the
  `FLIGHT_INPUT_EVENT` hook), probes the blocks it needs, runs the pure
  `carStep` / `flightStep` / `boatStep`, sweeps the vehicle's footprint over
  the new pose and resolves a block in the way (`sweepFootprint`, `resolveMove`, below), teleports the entity (the rider rides along, as on
  the coaster) and writes pitch, bank and wheel roll to the `FLIGHT_PROPS`
  actor properties. Constants in `FLIGHT` / `BOAT` / `CAR` / `HOVER` / `MOVE` (§9). Why: the camel boat
  over `minecraft:buoyant` crawled at 1.6-1.8 blocks/s on water whatever its
  movement, and the native hover controller gave a plane no way to be flown
  by the stick (2026-09-25; the flight model that replaced it is itself
  replaced by spaceship controls, above).
- **Blocks are solid SPANS.** A probe reads each block's solid span: a
  shell collider block's `lo..hi` sixteenths (a car drives ON a plate floor,
  not a block above it), a bottom slab's lower half, a top slab's upper
  half, a full block otherwise; plants, torches, snow layers and light
  blocks are passed. Lookups are cached per tick.
- **Swept footprint** (`sweepFootprint`, `FOOTPRINT`). Before 2026-09-25 the
  runtime probed only the centre line (the ground under the vehicle, one block
  ahead of the nose), so a wingtip, a wide hull or a car's corner went through
  a tree or a pier. Now the rectangle of the vehicle's half length and half
  width (`ScriptedVehicleType.noseReach` / `halfWidth`, from the shipped
  geometry, times the entity's `minecraft:scale`) is probed along its
  perimeter and vertically through its clear band at ≤ 0.9 blocks spacing
  (a car: above its 1.05 step to its roof; a boat: from just above the
  waterline; an aircraft: its whole airframe aloft, above its gear on the
  ground), tilted by its pitch, at every ≤ 0.8-block substep between the old
  and the new pose. A probe blocks only when it ENTERS a solid (it was clear at
  the old pose), so a vehicle placed half in a wall drives out. Only the
  boundary that enters NEW space is probed: a point moving outward
  horizontally (the bow, the outward-swinging half in a turn) at every level;
  any other point whose height changes (the tail during a forward descent, the
  whole perimeter in a straight drop, a pitching nose) only at the face that
  leads vertically - the band's floor level going down, its roof level going
  up - because the rest of its column was the vehicle's own. Skipping those
  points lets a car drop its rear into a hill it has almost cleared; probing
  them at every level cost a climbing Milano 2,376 probes a tick (8,040 at
  2x) where the leading faces need 916 (2,853). `bun scripts/_sweep_checks.ts
  [--impl=<older bedrock-vehicle.ts>]…` prints the per-tick count of fixed
  moves for any implementation; `test/bedrock-vehicle.test.ts` bounds it.
- **Never stuck** (`resolveMove`, `MOVE`, 2026-09-30: "it's too easy to get
  fully stuck in place by hills / blocks"). Until then a blocked move stopped
  the vehicle where it stood whatever the angle. Now a blocked move is tried
  again, the first clear shape taken: CLIMB (the move raised by the tick's
  climb allowance: a ship pushed into a hill or a wall lifts over it at
  `FLIGHT.AUTO_CLIMB`, ship first); DEFLECT (only when ONE half of the
  footprint - left or right of the centre line, each swept on its own - meets
  the block: a trunk met with a corner, a post with a wingtip; the move
  stepped sideways away from it by `DEFLECT_SHARE` of its length, at least
  `MIN_SIDESTEP`, forward kept, or the sidestep alone; a SHIP deflects only
  when the block is NARROW - the solid cells joined to the hit cell in its own
  plane, 8-connected, at most `NARROW_CELLS` - and lifts over everything else:
  a wall met 19 degrees off square meets one half first, and the X-wing
  "deflected" 13-50 blocks along a hill and a wall, never lifting, Saga 30j
  2026-10-07, CMVT 15:19:25-31 / 15:21:04-09 / 15:22:15-17, while the course
  met every wall square-on and passed; a ground vehicle has no lift and its
  sidestep along a wall met at an angle is its way along, so it keeps the
  halves' rule); SLIDE (one world axis
  of the move - Minecraft's walls run along the axes - or, where one EDGE of
  the footprint has more room ahead than the other (a slanted wall of
  blocks), the move turned toward it up to `GLANCE_MAX_DEG` and shortened by
  the cosine, or edged sideways off a stair corner; the speed scaled by the
  share kept: along a wall met at an angle); RISE (straight up by the climb
  allowance where it stands: the face of a wall - only while the move
  PUSHES, `MIN_PROGRESS` of travel: until 2026-10-07 a turn on the spot rose
  too, and the X-wing turned with its tail against a post climbed 4-6 blocks
  to its top, Saga 30j CMVT 15:17:11 / 15:22:49); PIVOT (a turn on the spot
  whose swing meets a block turns instead about the END that met it - the
  tail against a post stays and the nose swings); else BLOCKED, keeping the
  turn and the vertical move where they are clear on their own, a
  `blocked` / `beached` event (a soft sound once per contact; the ship's old
  `crash` explosion is gone). The order: a ship climb, deflect, rise, slide,
  pivot (over a hill or a slanted wall rather than along it); a car or hover
  craft deflect, slide, climb, rise, pivot. The HUD's "LIFTING OVER" /
  "CLIMBING" stays for 8 ticks after a climb or rise (it is written every 4;
  a rise alternating with a creep was sampled away). A car or hover craft has a climb allowance
  while the stick pushes, up to `RISE_MAX` over where its climb began, once
  per push (`climbSpent`); after a climb it HOLDS that height for up to
  `CLIMB_HOLD_TICKS` while it drives on, until its wheels find the top - so it
  climbs out of a two-block pit and onto a two-block kerb (`RISE_MAX` +
  `STEP_UP` = 2.15); a higher wall stops it, and it backs off or pivots
  (`PIVOT_RATE`: a car turns on the spot at rest). A boat deflects and slides
  only.
- **Free look on every scripted vehicle** (`web/src/engine/vehicle-free-look.ts`,
  2026-09-30: "all vehicles should allow you to move the camera around ... If
  you stop moving camera it should semi gradually automatically turn to point
  in the direction of travel"). The seat's `lock_rider_rotation` is
  `FREE_LOOK.SEAT_LOCK_DEG` (181, the component's default and "no limit"; it
  was 0, holding the rider's yaw to the seat), and the chase camera
  (`vehicleCameraRuntime`) orbits the vehicle by offsets `freeLookStep` keeps:
  a drag - the rider's reported look change, net of the vehicle's own turn
  whether the device carries the rider round with it (`RIDER_YAW_LAG_TICKS`
  late) or not - moves them; `IDLE_TICKS` after the last drag, while the
  vehicle moves faster than `MOVING_SPEED`, they ease back to the nose with
  the time constant `RECENTRE_SECONDS` (95 % in 1.8 s); at rest they hold.
  Nothing moves the player in either view, so the ease cannot fight the
  client. The cockpit view (hotbar slot 9) of a scripted vehicle is a camera
  too (`cockpitCamera`, 2026-10-07): a free camera at the driver's eye
  (`VehicleCameraConfig.eye`, the seat plan's eye in the seat frame, times
  the size) on the vehicle's pose `COCKPIT_TICK_LAG` ticks back (the client
  draws the teleported vehicle behind the server, as a coaster car), eased
  over `COCKPIT_EASE_SECONDS`, turned by the same offsets - so a drag looks
  round and the view eases back to the front in yaw AND pitch. The rider is
  made invisible while it is theirs (the camera stands in its head), and a
  switch between the views restarts the free look, so each starts on the
  nose. The chase camera never sits behind a wall: the first solid block on
  the line from the vehicle's pivot pulls it in to `CHASE_WALL_MARGIN` short
  of it (Saga 30j s68; plants, the headlight's light block, rails and the
  like are seen through, `CHASE_PASSABLE_BLOCKS`). Until then the cockpit
  view was the rider's own first person with its
  yaw eased by `setRotation`, which on the Saga (round 30j) did nothing on a
  lock-181 seat: the McLaren's view stayed 56 degrees off the nose, the
  X-wing's kept its pitch, and the chase camera came back where the cockpit's
  drag left it (quirk `rider-free-look`). The camera writes the view's pitch to the vehicle
  (`VEHICLE_DYNAMIC.lookPitch`) for the ship's "look down + Jump", and logs
  `CMCAM` lines with telemetry on. A rotorcraft or a flyer (native mounts)
  already flies where its rider looks: its view is the direction of travel,
  and its seat is `SEAT_LOCK_DEG` too since 2026-10-07 (it was 0, and on the
  Saga a drag on the Nimbus moved nothing, so its "look down + Jump" could
  not be done: quirk `native-mount-locked-look`); its cockpit view stays the
  rider's own first person. Saga 30j measured the chase drag (§11).
- **Headlights** (`HEADLIGHTS`, `isNightTime`, `headlightCell`): at night,
  with a rider, one `minecraft:light_block_14` stands `AHEAD` blocks past the
  nose, moved as the vehicle crosses cells, removed when the rider leaves, the
  vehicle parks for `PARK_TICKS` or day comes; its cell is saved in a dynamic
  property so a light left by a closed world goes on the next load. Only an
  air cell takes it. No night vision any more.
- **Drive animation** (`vehicleClientAnimation`, client Molang): wheel bones
  (`wheel_<n>`, from the compiler's `vehicleRig`) turn by the signed distance
  rolled over their radius; front wheels steer with the yaw rate; a car's body
  leans out of a turn and squats on acceleration from its own motion
  (`VEHICLE_BODY_MOTION`); a scripted vehicle's body takes its attitude from
  the properties.
- The rotorcraft's and the flyer's driver script (`vehicleDriverRuntime`,
  every 2 ticks, the native mounts) only measures speed, plays effects, swaps
  the climb/descend group (back + Jump, or a look down past
  `FLYER.DIVE_PITCH_DEG`), shows the HUD (the mount's name and hint for the
  first `FLYER.RIDE_HINT_TICKS` of a ride, then the speed line) and logs
  telemetry. The speed: a client-driven mount reports ~0 velocity and its
  server position moves in BURSTS, so the HUD reads the mean between the
  first and the last position change of the last `DRIVER_SPEED_WINDOW_TICKS`
  (a per-interval delta read up to 4x on the Saga); a step over
  `DRIVER_TELEPORT_BLOCKS` is a teleport. mph = blocks/tick × 20 × 2.236936
  (1 block = 1 m). Tests: `test/vehicle-driver.test.ts` (the serialised
  runtime on the headless simulator: the pitch dive, the hint, a bursty and a smooth
  mover, a teleport).
- The wand's size changes `minecraft:scale`, the collision box and the seats
  (`bedrock-placement-pack.ts`); the speeds are the same at every size, the
  footprint and probes scale with it. A seat is declared in the entity's
  UNSCALED frame: Bedrock multiplies a declared seat by `minecraft:scale` and
  not the rider's 1.12 eye offset (Saga 30k, 2026-10-07; quirk
  `seat-scales-with-entity`), so `rideableAtSize` writes the wanted world
  offset divided by the group's scale - written pre-scaled, 76286's rider at
  200 % sat at 2 x 2 x the 100 % offset, six blocks over the hull (SEAT-01).
- Seats are not physics but ride with it: a compiled vehicle's seat is the
  driver's eye from the source less the measured 1.12, written in the entity
  frame (nose +Z; the render seat turned half round, x AND z,
  `renderSeatToEntity`), raised or set back until the driver sees out
  (`driverSeesOut`: the horizon `AHEAD` and either side, `SIDES`), out of
  the cabin when nothing in it sees ahead (`AHEAD_FALLBACK`, the body then
  hidden at every size), eye-anchored at every wand size (`seatPositionAt`
  is the WORLD offset; the size group declares it divided by its scale), and
  the rider is made invisible at sizes where the body does not fit
  (`cockpit-seat.ts`; add-on guide "Where the player sits"). Offline the
  realised seat is judged against the drawn vehicle at every size
  (`web/src/sim/adapters/craftmatic/seat-scale.ts`, `scripts/_seat_scale_check.ts`).

Tests: `test/bedrock-vehicle.test.ts` (the steppers, the footprint, the
collision response and headlight helpers, the animation, and the serialised
runtime on the headless simulator: a car stepping round a trunk at its
corner, a ship round a post at its wingtip and over a six-high wall, straight
up and under a roof, an empty ship parking, a car out of a two-deep pit,
along an angled wall, stopped by a five-high wall and pivoting out, a
collider plate floor, a hover craft over water, headlights by night and day,
the time machine's top speed), `test/vehicle-free-look.test.ts` (the drag and
the ease, pure and the camera runtime on the simulator), the simulator's
`vehicles` course over built packs (`bun scripts/sim.ts <packs>
--scenario=vehicles`, docs/sim-engine.md), `test/playable-addon.test.ts`, `test/playable-golden-models.test.ts`,
`test/vehicle-facing.test.ts`, `test/scene-vehicles.test.ts`, and the device
course `vehicle_<id>_<n>` (with a post off the centre line inside the
footprint, and a hover craft's run over the pool) and train test
`train_<id>_<n>` (`web/src/engine/gametest-pack.ts`, `test/gametest-pack.test.ts`).

### 4.7 Slides, lifts and orbits — `web/src/engine/bedrock-rides.ts`

KINEMATIC, not dynamic: a ride carries its seat (and the player riding it,
as the coaster carries its riders, by `tryTeleport` of the ridden entity)
along a polyline the placement wrote in world coordinates. A slide speeds up
from `RIDE.SLIDE_V0` by `RIDE.SLIDE_ACCEL` to `RIDE.SLIDE_VMAX` - no friction
or gravity model, a playground chute is short and a constant pull reads as
sliding - and sets the rider down at the run-out; a lift moves its car and
seat one storey at `RIDE.LIFT_SPEED`. Speeds are blocks per second at 100 %
and multiply by the wand factor, so a ride takes the same time at every size
(a length scale without Froude scaling, like the figure walk). The path is
measured at export (the chute's bed: its top surface less the rims of its
side walls; the lift's room floors, by floor area, where the car stays in its
column), never simulated. A tap on a lift's car, or on either ride's seat,
boards it: on a touch screen a tap is a hit (`entityHitEntity`), not the
held-press interact that mounts a vanilla rideable, so the runtime seats the
tapping player itself (10788's slide boarded nobody over three taps until
2026-09-29c). The set-down (a slide's run-out end, a lift's exit) stands the
rider where the body FITS (`colliderBodyProbe.settle`, `RIDE.SETDOWN_*`,
times the size): the point itself lifted out of a floor it sits in, else the
nearest free floor in reach that the rider WALKS to from the terminal
(`routeClear`: out of what the terminal sits in, never into a wall after open
floor - a reach of 8 blocks at 400 % otherwise set riders down through walls),
else the scenery seats' last resort (`escape`, §4.8), else the planned point.
Tests: `test/bedrock-rides.test.ts` (path reading, lift detection
and the serialised runtime on the headless simulator, the tap on a seat included).

An ORBIT (kind `orbit`, 2026-09-29) is the same runtime carrying the set's
own FIGURE, not a player: a flyer mount's companion (§4.6,
`web/src/engine/bedrock-flyer.ts`) rides a figures-only seat round a closed
loop the export wrote with `orbitPathLdu` - a circle about the model's
footprint centre, `FLYER.ORBIT_MARGIN_LDU` outside half its footprint
diagonal (clear of every corner), at `FLYER.ORBIT_HEIGHT_FRACTION` of the
model's height with `FLYER.ORBIT_BOB_PERIODS` sinusoidal rises and falls of
`FLYER.ORBIT_BOB_LDU` baked into its `FLYER.ORBIT_POINTS` points - at
`RIDE.ORBIT_SPEED` (a stroll, so a child can follow it), for ever, the
mount's own entity carried alongside as a lift carries its car. It starts by
itself when its seat is found (`ORBIT_ADOPT_TICKS`), faces along the loop
(a central-difference yaw over `ORBIT_YAW_CHORD`, so 64 points never show a
kink) and turns its rider with it, and a figure knocked off is put back
(`ORBIT_RESEAT_REACH`, every `ORBIT_RESEAT_TICKS`). Nothing about it is
dynamic and it has no Froude term: the speed is world-absolute times the
wand factor like the other rides. Tests: `test/bedrock-flyer.test.ts` (the
path's radius, band, sense and closure; the runtime on the headless simulator: the
lap, the car offset, the re-seat).

### 4.8 Hop: fly or drive into another mount — `web/src/engine/bedrock-ride-hop.ts`

The user's words (2026-09-30): fly or drive into another mountable - a
coaster car, a chair, a slide's seat, a vehicle - that is not fully taken by
players, and you are on it; "fly a plane into an in-motion roller coaster car
and be auto-mounted in the first available seat closest to the front"; "park
a car at the bottom of a slide ... slide into it". A KINEMATIC contact test,
no forces: nothing is pushed, the player changes mount.

- **Contact** (`hopContact`, pure): per tick, the target's box centre is
  read in the RIDDEN vehicle's frame (right, up, forward: Bedrock yaw, 0 facing
  +Z) at the previous and the current tick, so the relative motion of both is
  one segment. The segment is carried `HOP.LEAD_TICKS` further and sampled
  every `HOP.SAMPLE_BLOCKS`; a sample inside the vehicle's footprint (half
  length and width from the pack, times its `minecraft:scale`, `0..height`)
  or the rider's box (0.6 x 1.8 at the rider's feet), each grown by
  `HOP.REACH_BLOCKS` plus the target's horizontal extent as a radius, is a
  contact. A coaster car passing a flown plane at a block a tick crosses the
  footprint between two samples and is still caught; a relative speed under
  `HOP.MIN_CLOSING_BLOCKS_PER_S` never hops, so a car parked beside a chair
  stays a car. Two samples are needed: a target first seen this tick is
  tested from the next.
- **Who acts**: `BP/scripts/hop.js` handles only a player riding one of ITS
  pack's driveables (`HopRuntimeConfig.sources`, by identifier), so of many
  packs in one world exactly one owns each hop; the claim tag
  (`HOP_TAGS.claim`, a TAG because dynamic properties are per pack) makes a
  second copy of the same pack skip that player. Targets may be any pack's
  (`HOP_TAGS` namespaces): boarding uses only the standard rideable component.
- **Guards**: nothing in the first `HOP.BOARD_GRACE_TICKS` aboard (whether
  boarded or hopped onto); never back into the mount just left for
  `HOP.BACK_COOLDOWN_TICKS`; never onto a seat a player holds (a figure's
  seat is taken: the figure is ejected, as figures.js stands one up for a
  player anyway). A refused `addRider` puts the rider back on the mount they
  left (quirk `add-rider-after-eject`, assumed).
- **Front-most seat**: `addRider` cannot choose a seat (quirk
  `rider-seat-order`, assumed), so the choice is across entities: the coaster
  tags every car with its train (`HOP_TAGS.train`, the lead car's id) and its
  rank from the front in the direction of travel (`HOP_TAGS.rank`, rewritten
  when the train reverses); a contact with any car of a train boards the
  front-most car with a free seat within `HOP.TRAIN_REACH_BLOCKS`. Within one
  entity the compiler lists the driver's seat first.
- **The vehicle left behind** (`HopSource.vacate`): a scripted ship HOVERS
  where it was left - `BP/scripts/vehicles.js` skips its integration while the
  `VEHICLE_DYNAMIC.hold` property is set, keeping its state, so a rider back
  aboard flies on from the speed it had (hands off it then brakes to a hover);
  a ship whose rider got off WITHOUT a hop sinks gently to the ground and parks
  (`FLIGHT.IDLE_SINK`); a scripted car, hover craft or boat
  stops (its speed zeroed once); a native mount (rotorcraft, a flyer's cloud)
  is held by Bedrock's hover controller (an empty Nimbus hovers, Saga
  2026-09-29) and a summoned cloud still fades after `FLYER.EMPTY_DESPAWN_TICKS`.
  Hover rather than land: the user allowed either, and a hovering plane is one
  a child can hop back into.
- **A slide's set-down** (`ridesRuntime` with the kit): the run-out's end,
  settled by `colliderBodyProbe` (§4.7: `RIDE.SETDOWN_*`, every candidate a
  `routeClear` walk from the terminal), is searched `HOP.SETDOWN_REACH_BLOCKS`
  (times the size, at least 1) for a mountable's box; the rider is boarded onto
  the nearest (front-most of its train) instead of being set down.
- **A scenery seat's set-down** (`figureLifeRuntime` with the same body probe;
  the rule a child needs: never trapped, never in a wall, never falling).
  `ColliderBodyProbe.hasWalkExit` is the egress test: a body-free point on a
  floor within one collider sixteenth (or in the air over one it falls onto
  within the drop, through a clear column: Bedrock's fallback sets the player
  0.2 over the seat and it lands a tick later), then a supported one-block
  route in one of the eight compass directions, sampled every 1/8 block, each
  sample fitting the body and stepping at most the 9/16 step. A clear endpoint
  beyond a thin wall, an unsupported gap and the body-free pocket under 10796's
  slide are not exits. In order:
  1. Bedrock's own set-down, when it has a walk exit. A player found more than
     `SEAT_EGRESS.NATIVE_REACH_BLOCKS` (times the seat's `minecraft:scale`)
     from the seat was moved on purpose (a /tp out of it) and is left alone.
  2. The nearest point within `RIDE.SETDOWN_REACH_BLOCKS` (times the seat's
     scale) of the remembered seat that has a walk exit AND that the body walks
     to from the seat (`routeClear`: out of the chair it sits in, then never
     into a wall again). `settle`'s acceptance predicate carries both tests;
     omitted, it keeps ride and doorway settling exactly as before.
  3. The last resort, `escape` (`ESCAPE`): a breadth-first flood on a
     half-block lattice from the seat, every edge a `routeClear` walk, to the
     nearest floor with a walk exit; else the model's EXTERIOR - along sixteen
     rays, ring by ring, a floor open to the sky over it, with a walk exit, at
     or under the seat's level (the lowest of its ring: the ground beside the
     model; a roof only when no ring has such a floor).
  4. Only with none of those (a void, an unloaded world) is the player put back
     on the still-free seat ("No safe place to get off here"), at most
     `SEAT_EGRESS.RESEAT_LIMIT` times within `RESEAT_WINDOW_TICKS`: a held
     Sneak dismounts again at once and would loop seat, off, seat; past the
     limit the player is left where Bedrock set it down and the content log
     says so. A transfer to another mount or dimension is never pulled back.
  Measured over the favourites' 25 scenery seats at 100-400 % (125 placements,
  `bun scripts/_seat_egress_sweep.ts <packs> --runtime=tree --sizes=100,150,200,300,400`):
  27 re-seated traps before this order, 0 after; 23 placements end more than
  3 blocks from the seat (21 of them at 200 % and up, at most 12 blocks out),
  none by a fall.
- **The new mount's runtime** sees the rider as it sees any boarding: the
  coaster starts its camera on the first tick a car reports a rider
  (`aimRider` creates the viewer, the loop animation is planned at the next
  inversion, the exit hint is the lang file's). The hop hands the chase camera
  and control scheme back at once, and `vehicle-camera.js` does not clear
  again inside the grace (it would wipe the new mount's camera).

Tests: `test/bedrock-ride-hop.test.ts` (the contact test; the serialised
`hop.js`, `vehicles.js` and `rides.js` in the headless simulator: a plane
catches a train's rear car and sits in the front one, then hovers; a riderless
ship that nobody hopped off sinks to the ground and parks; a train full of players is flown
through; a figure yields its chair; two packs owning the plane hop once; the
back-hop cooldown; a car at a slide's foot). Built packs: the simulator's
`hop` scenarios (docs/sim-engine.md).

## 5. Serialised runtimes: the rules

Each device runtime is a function turned into the pack's script text with
`Function.prototype.toString()` and evaluated with only `world` and `system`
(and the coaster's `LinearSpline`) in scope:

| Script | Built by | Functions serialised |
|---|---|---|
| `BP/scripts/coaster.js` | `coasterScript` | `coasterRuntime` (module-private), `sampleCoasterPath`, `coasterCarAttitude`, `coasterRiderView`, `coasterRiderLook` |
| pinball script | `pinballScript` | `pinballRuntime`, `createPinballSim`, `fitPinballZone` |
| `BP/scripts/figures.js` | `figureLifeScript` | `figureLifeRuntime`, `standFeetAt`, `exploreWalkable`, `pathTo`, `blockSpan`, `startCell`, `refugeCell` |
| vehicle scripts | `playable-addon.ts` | `vehicleDriverRuntime`, `vehicleCameraRuntime` (with `freeLookStep`, `freeLookStart`, `cockpitCamera`), `timeMachineRuntime` |
| `BP/scripts/vehicles.js` | `scriptedVehicleScript` | `scriptedVehicleRuntime`, `carStep`, `flightStep`, `boatStep`, `sweepFootprint`, `resolveMove`, `isNightTime`, `headlightCell` |
| `BP/scripts/rides.js` | `ridesScript` | `ridesRuntime` (module-private; slides, lifts and orbits) |
| `BP/scripts/flyer.js` | `flyerScript` | `flyerRuntime` (module-private; summons and fades the player's clouds, floats a rider who leaves one in the air) |
| `BP/scripts/hop.js` | `hopScript` | `hopRuntime` (module-private), `hopKit`, `hopContact`; `rides.js` also carries `hopKit` (a slide's set-down) |

1. A serialised function may reference NOTHING outside its own body and its
   parameters: no import, no module-level `const`, no other function of the
   file. A helper it needs is declared inside it or passed in as an argument
   (the coaster passes `sampleCoasterPath` and friends). Breaking this is a
   `ReferenceError` on the device, not at build time.
2. Every tuning value travels in the JSON `CONFIG` (`config.physics` for the
   coaster, `config.tuning` for figures, `config.sim` for pinball). So it must
   be JSON-safe: plain objects, arrays and finite numbers; no typed arrays,
   `Infinity`, `NaN`, functions or class instances.
3. A literal fallback after `??` inside a runtime serves only a test that
   hand-builds a config; every real pack carries the full object. Keep the
   fallbacks equal to the constants or delete them.
4. A value the client needs goes through an actor property; a float property
   is written with `bedrockFloat()` (an integer literal kills the whole
   component on device).
5. The host tests run the SAME serialised text as a pack entry on the
   headless simulator (`test/_sim-host.ts`: its one `@minecraft/server` mock,
   the pack's own entity and block definitions, its physics) — `liftHost` /
   `rideHost` in `test/bedrock-coaster.test.ts`, `simulateFigureLife`, the
   pinball, vehicle, rides and interactives hosts — so rule 1 is caught
   offline, and a member the runtime reaches that the simulator does not
   model fails the test (strict mode) instead of passing a fake.

## 6. Who shares what (DRY map)

| Pure function / constant | Device runtime | Walk preview | Host tests / tools |
|---|---|---|---|
| `COASTER_PHYSICS` | via `config.physics` | `stepCoasterPreviewTick` default | test assertions |
| `sampleCoasterPath` | serialised | `coaster-preview.ts` | yes |
| `coasterTrackUps`, `coasterLoopRadius` | config time (`coasterRuntimeConfig`) | yes | yes |
| `coasterCarAttitude` | serialised | yes | yes |
| `coasterRiderView`, `coasterRiderLook` | serialised | `addon-preview.ts` (board camera) | yes |
| `rideSubstep` (the rail speed step: coaster and driven train) | serialised argument of `coasterRuntime` | `stepCoasterPreviewTick` | `test/rail-track.test.ts` (bit-identical to the shipped coaster formula), `scripts/_coaster_replay.ts` |
| `RAIL_TRAIN_PHYSICS` | per route, `CoasterRuntimeRoute.physics` | via `route.physics` | `test/rail-track.test.ts` |
| `createPinballSim` | serialised | `addon-preview.ts` | `test/pinball.test.ts`, `pinball-table.ts` (lane probing) |
| figure planner functions | serialised | — | the simulator's `figure-life.ts` (adapter), census script |
| `tickPlayer`, `moveBox` (`web/src/sim/physics/body.ts`) | — (Bedrock is the player) | `addon-preview.ts` (through `addon-walk.ts`) | `interactive-walk.ts`, `scripts/_addon_walk.ts`, the headless simulator's player (`web/src/sim/physics/systems.ts`) |
| `tickBody` (`web/src/sim/physics/body.ts`) | — (Bedrock moves the mob) | — | the simulator's mobs under `minecraft:physics` (a figure walked by `applyImpulse`) |
| every serialised runtime above | serialised | — | the headless simulator runs them UNMODIFIED, all of a pack's scripts in one context, against its `@minecraft/server` mock (docs/sim-engine.md) |
| `carStep`, `flightStep`, `boatStep` (`CAR`, `HOVER`, `FLIGHT`, `BOAT` via `config.car` / `config.hover` / `config.flight` / `config.boat`) | serialised | — | `test/bedrock-vehicle.test.ts` |
| `sweepFootprint` (`FOOTPRINT`), `resolveMove` (`MOVE`), `isNightTime`, `headlightCell` (`HEADLIGHTS`) | serialised | — | `test/bedrock-vehicle.test.ts` (pure, and the runtime on the headless simulator), the simulator's `vehicles` course (`adapters/craftmatic/vehicle-course.ts`) |
| `freeLookStep`, `freeLookStart`, `cockpitCamera` (`FREE_LOOK`) | serialised into `vehicle-camera.js` | — | `test/vehicle-free-look.test.ts` (pure, and the camera runtime on the headless simulator) |
| `vehicleClientAnimation` | client Molang, not a script | — | `test/bedrock-vehicle.test.ts`, `test/bedrock-flyer.test.ts` (the flyer's bob) |
| `findMounts`, `orbitPathLdu` (`FLYER`) | export time: the orbit on the seat's `ridePath`, followed by `ridesRuntime` | — | `test/bedrock-flyer.test.ts`, `test/nimbus-fixture.test.ts` |
| `hopContact`, `hopKit` (`HOP`, `HOP_TAGS`) | serialised into `hop.js` (every driveable) and `rides.js` (a slide's set-down); the coaster writes `HOP_TAGS` on its cars; `vehicles.js` reads `VEHICLE_DYNAMIC.hold` | — | `test/bedrock-ride-hop.test.ts` (pure, and the serialised runtimes in the simulator) |

## 7. Adding a vehicle class or a physics module

1. **Decide who integrates.** If Bedrock's components can do it (a mount
   with `input_ground_controlled`, `buoyant`, hover), use them and write
   the numbers in §4.6 and the constants table. If the motion follows
   measured geometry (track, rails, a hinge), write a pure stepper.
2. **Pure core first.** Put the stepper in its own module under
   `web/src/engine/`, with its state as a plain object and every constant in
   one exported `as const` object, like `COASTER_PHYSICS`. Units in the name
   or the comment of every field (world blocks/s, model blocks, LDU, ticks).
3. **Share, do not mirror.** Pass the pure functions into the runtime as
   arguments and serialise them (§5); give the walk preview and the tests the
   same functions. A mirror is a TODO, not a design.
4. **Scale explicitly.** Say whether each constant is world-absolute (a
   machine: a chain, a motor) or model-relative (gravity-driven, Froude:
   speeds × sqrt(size), times × sqrt(size)), and apply the wand's `scale`
   accordingly. Test at 50 % and 200 %.
5. **Host test through the serialised text**, as `liftHost` does, then a
   GameTest or device round for what the host cannot see (render, cull,
   client interpolation).
6. **Document it here** (an exports table, the constants, a §4 entry) and
   run `bun scripts/_physics_spec_check.ts`; the test fails until you do.

## 8. Wand size and Froude scaling

A ride placed at size f is geometrically f × larger in world blocks. For it
to behave like a bigger real ride, speeds must grow as sqrt(f) and times as
sqrt(f) (same Froude number `v² / (g L)`), which the coaster's gravity term
does by construction. Host, 10303, pace √2, riderless, the cars' wheelbase,
6,000 ticks (`bun scripts/_coaster_pace_scan.ts stats --scale=<f>`):

| Size | Peak blocks/s | Mean moving blocks/s | Froude-ideal mean (× sqrt f) | Ticks at the ceiling | Loop-top v / sqrt(g r f) | Cycle between stops, s |
|---|---|---|---|---|---|---|
| 50 % | 23.0 | 8.92 | 7.42 | 0 | 2.39 | 30.8 |
| 100 % | 28.28 | 10.50 | 10.50 | 42 | 1.47 | 54.2 |
| 200 % | 28.28 | 11.58 | 14.85 | 120 | 1.30 | 99.5 |
| 400 % | 28.28 | 12.24 | 21.00 | 270 | 1.29 | 187.4 |

Above 100 % the absolute `MAX_SPEED` clips every drop, the train reaches the
loops with too little energy, and the inversion floor (`INVERSION_MARGIN` =
1.3) carries it over the top: that is the 1.30. Below 100 % the ride is
faster than Froude because `DRAG` is per world block, not per model block.
Scaling `DRAG` as `1/f` (what a real bigger car has: area over mass goes as
1/L) moves the 400 % mean from 12.24 to 13.82 and the 50 % loop-top ratio
from 2.39 to 1.78; the ceiling still dominates. Neither is changed yet
(§11): the ceiling exists for how teleports READ on the phone, which only a
device round can settle.

Pinball, figures and vehicles do not Froude-scale at all: the pinball game
has the same timing at every size (deliberate), figures walk at 1.2 blocks/s
× f below 100 % (Froude would be × sqrt f), vehicles keep their movement
numbers.

## 9. Constants

Every tuned number of the physics models, its value in code, and why it is
that value. The checker compares the Value column against the code at the
precision written. A `Where` with a second backticked fragment reads a
literal inside a function body (`§` marks the number).

<!-- physics-spec:constants -->
| Constant | Where | Value | Units | Why |
|---|---|---|---|---|
| `LDU_PER_MINIFIG` | `web/src/engine/lego-scale.ts` | 96 | LDU | Soles to head top of a standing minifig, measured from 3816/3815/973/3626 at their standard offsets (2026-09-15). |
| `PLAYER_HEIGHT_BLOCKS` | `web/src/engine/lego-scale.ts` | 1.8 | blocks | Minecraft player height; the minifig maps onto it. |
| `LDU_PER_BLOCK` | `web/src/engine/lego-scale.ts` | 53.33 | LDU/block | 96 / 1.8: the one LEGO-to-Minecraft scale at 100 %. |
| `BEDROCK_UNITS_PER_LDU` | `web/src/engine/lego-scale.ts` | 0.3 | geometry units/LDU | 16 units a block / 53.33. |
| `SEATED_EYE_HEIGHT_BLOCKS` | `web/src/engine/lego-scale.ts` | 1.12 | blocks | A riding player's eye above the seat, measured on the Saga (26.52): `getHeadLocation()` 1.12 over the seat position. |
| `COASTER_RIDE_PACE` | `web/src/engine/bedrock-coaster.ts` | 1.41421 | × real time | Effective gravity exactly 2 g: inside Minecraft's 1.63-3.27 g band, Froude-exact for a half-size loop; the user's reports bracketed it between 1.0 ("50 % slow") and 1.6 ("a touch too fast"). §1. |
| `COASTER_PHYSICS.GRAVITY` | `web/src/engine/bedrock-coaster.ts` | 19.6 | world blocks/s² | 9.8 × pace². Applied as −g sin θ along the chord; energy conserved to 1.1 % when lossless. |
| `COASTER_PHYSICS.ROLLING` | `web/src/engine/bedrock-coaster.ts` | 0.24 | world blocks/s² | 0.12 × pace²: a constant wheel/bearing loss (µ g with µ ≈ 1.2 %), device-tuned at pace 1. |
| `COASTER_PHYSICS.DRAG` | `web/src/engine/bedrock-coaster.ts` | 0.008 | 1/world block | Loss DRAG × v²; pace-invariant. Terminal speed on a vertical drop sqrt(g/DRAG) = 49.5 blocks/s. Not Froude-scaled (§8). |
| `COASTER_PHYSICS.MIN_SPEED` | `web/src/engine/bedrock-coaster.ts` | 1.131 | world blocks/s | 0.8 × pace: the ride may never deadlock on a grade. |
| `COASTER_PHYSICS.MAX_SPEED` | `web/src/engine/bedrock-coaster.ts` | 28.28 | world blocks/s | 20 × pace. 16 (unpaced) starved 10303's first loop; absolute in world blocks, so it binds above 100 % (§8). |
| `COASTER_PHYSICS.INVERSION_MARGIN` | `web/src/engine/bedrock-coaster.ts` | 1.3 | × sqrt(g r) | Least speed over a loop top that holds a car on real rails is sqrt(g r); 30 % margin, scaled by sqrt(−up.y) so it is zero at vertical. Never binds at 100 % (loop tops at 1.47). |
| `COASTER_PHYSICS.LIFT_GRADE` | `web/src/engine/bedrock-coaster.ts` | 0.08 | sin θ | The chain engages only above ~4.6°: never on the flat or a drop. |
| `COASTER_PHYSICS.LIFT_SPEED` | `web/src/engine/bedrock-coaster.ts` | 3.536 | world blocks/s | 2.5 × pace: chain speed; it can only carry a slower car up to it, so it cannot add ride energy above it. |
| `COASTER_PHYSICS.LIFT_ACCEL` | `web/src/engine/bedrock-coaster.ts` | 24 | world blocks/s² | 12 × pace²: how fast the chain catches a car. |
| `COASTER_PHYSICS.STATION_BRAKE` | `web/src/engine/bedrock-coaster.ts` | 7 | world blocks/s² | 3.5 × pace²: the limit curve sqrt(2 a s) reaches zero at the platform. |
| `COASTER_PHYSICS.DEPART_SPEED` | `web/src/engine/bedrock-coaster.ts` | 4.243 | world blocks/s | 3 × pace: the station drive tyres' push. |
| `COASTER_PHYSICS.DWELL_EMPTY` | `web/src/engine/bedrock-coaster.ts` | 100 | ticks | Platform dwell with nobody aboard (5 s); not paced (waiting, not motion). |
| `COASTER_PHYSICS.DWELL_LOADED` | `web/src/engine/bedrock-coaster.ts` | 60 | ticks | Dwell with a rider. |
| `COASTER_PHYSICS.BOARD_TICKS` | `web/src/engine/bedrock-coaster.ts` | 40 | ticks | A boarding player always gets 2 s before departure. |
| `COASTER_PHYSICS.PLATFORM_SPEED` | `web/src/engine/bedrock-coaster.ts` | 3.536 | world blocks/s | 2.5 × pace: 10303's elevator hoist. |
| `COASTER_PHYSICS.PLATFORM_DWELL` | `web/src/engine/bedrock-coaster.ts` | 30 | ticks | Pause before the platform rises and after it arrives. |
| `COASTER_PHYSICS.PLATFORM_CLEARANCE` | `web/src/engine/bedrock-coaster.ts` | 1 | model blocks | How far the train must be past the deck before it returns. |
| `COASTER_PHYSICS.RIDER_EYE` | `web/src/engine/bedrock-coaster.ts` | 1.12 | world blocks | Is `SEATED_EYE_HEIGHT_BLOCKS` (carried in config because the runtime cannot import). |
| `COASTER_PHYSICS.YAW_HOLD_HORIZONTAL` | `web/src/engine/bedrock-coaster.ts` | 0.2 | horizontal fraction | Below it the axle is near vertical (a car on its side) and the last yaw is held. |
| `COASTER_PHYSICS.BODY_RANGE` | `web/src/engine/bedrock-coaster.ts` | 320 | model units | Declared range of the body-offset actor properties. |
| `RAIL_TRAIN_PHYSICS.GRAVITY` | `web/src/engine/bedrock-coaster.ts` | 9.8 | world blocks/s² | Real gravity: a train set is level, nothing is time-scaled. |
| `RAIL_TRAIN_PHYSICS.ROLLING` | `web/src/engine/bedrock-coaster.ts` | 0.3 | world blocks/s² | A coasting train (stick released) sheds ~0.3-0.9 blocks/s each second: 12 → 2.2 blocks/s in 20 s on 4559's circuit. |
| `RAIL_TRAIN_PHYSICS.DRAG` | `web/src/engine/bedrock-coaster.ts` | 0.004 | 1/world block | Half the coaster's: a train is heavier for its frontal area. |
| `RAIL_TRAIN_PHYSICS.MAX_SPEED` | `web/src/engine/bedrock-coaster.ts` | 12 | world blocks/s | 1.5 × a minecart; still lets a rider read an R40 curve (15 blocks radius at minifig scale). |
| `RAIL_TRAIN_PHYSICS.DRIVER.TRACTION` | `web/src/engine/bedrock-coaster.ts` | 3 | world blocks/s² | 0 → 12 blocks/s in about 4.5 s at full stick. |
| `RAIL_TRAIN_PHYSICS.DRIVER.BRAKE` | `web/src/engine/bedrock-coaster.ts` | 6 | world blocks/s² | A full-stick stop from top speed in about 2 s. |
| `RAIL_TRAIN_PHYSICS.DRIVER.PARK_BRAKE` | `web/src/engine/bedrock-coaster.ts` | 6 | world blocks/s² | An unattended train stops and holds on any grade under 6/9.8 ≈ 0.6. |
| `COASTER_RIDER_VIEW.maxTurn` | `web/src/engine/bedrock-coaster.ts` | 40 | degrees/tick | Most the per-tick camera's yaw turns in a tick (reflect: only a rider's fast head turn reaches it; clamp: its flip over a loop's side takes 5 ticks). |
| `COASTER_RIDER_VIEW.lookYaw` | `web/src/engine/bedrock-coaster.ts` | 70 | degrees | Most a rider may look away sideways. |
| `COASTER_RIDER_VIEW.lookPitch` | `web/src/engine/bedrock-coaster.ts` | 50 | degrees | Most up or down. |
| `COASTER_RIDER_VIEW.lookLag` | `web/src/engine/bedrock-coaster.ts` | 6 | ticks | The client's rider yaw trails the car ~0.3 s on the Pixel; 6 held the look within 5°. |
| `COASTER_RIDER_VIEW.animLag` | `web/src/engine/bedrock-coaster.ts` | 3.5 | ticks | An inversion's camera animation shows the pose of tick k − 3.5 (interpolated), which is where the client DRAWS the train: measured against a marker at 10 blocks/s (Pixel 2026-09-29, `output/coaster-cam-0929/`, `camprobe`, ~97 px per block): lag 1 +213 px ahead of the marker, 2 +108, 3 +35, 4 −62, 6 −194; zero at ~3.5. Ridden by eye at 1, 3, 6 on 2026-09-25 (1 inside the car ahead's rider, 6 behind its own train). |
| `COASTER_RIDER_VIEW.handbackBlend` | `web/src/engine/bedrock-coaster.ts` | 4 | ticks | After an inversion animation hands back, the per-tick camera's lag runs from `animLag` (the pose the animation was showing) down to `tickLag` over this many ticks, so neither its eye nor its rotation jumps at the take-over. Without it the loop-2 exit on 10303 cut from looking down at the car to level ahead in one frame (Pixel, ride 3, 2026-09-29). |
| `COASTER_RIDER_VIEW.tickLag` | `web/src/engine/bedrock-coaster.ts` | 1.5 | ticks | The per-tick camera shows the pose of tick k − 1.5 (interpolated). On the server's own schedule (lag 0) the eased camera sat +163 px (1.7 blocks) ahead of the drawn marker at 10 blocks/s — at a coaster's 23 blocks/s that is the car ahead, where every ride since 2026-09-24 was viewed from; lag 2 −62, 3 −162, 4 −210. Zero at ~1.5; the ease's own trailing supplies the rest. |
| `COASTER_RIDER_VIEW.animTail` | `web/src/engine/bedrock-coaster.ts` | 6 | ticks | An inversion's animation is planned this far PAST the tick the per-tick camera takes over, so it is still playing when that `setCamera` lands. An animation that ended first left the player's own view (inside the car's cuboids) for ~2 ticks at every loop's exit (Pixel, 2026-09-29). Even, so keyframes stay 0.1 s apart. |
| `COASTER_RIDER_VIEW.ease` | `web/src/engine/bedrock-coaster.ts` | 0.1 | s | Camera ease per update. |
| `TRACK_TWIST_RATE_DEG_PER_BLOCK` | `web/src/engine/bedrock-coaster.ts` | 20 | degrees/block | Largest roll change of the track up between gravity's up and a loop's normal. |
| `COASTER_CAR_LENGTH` | `web/src/engine/bedrock-coaster.ts` | 1.25 | model blocks | The fabricated cart's drawn length. |
| `COASTER_CART_WHEELBASE` | `web/src/engine/bedrock-coaster.ts` | 1.125 | model blocks | The fabricated cart's wheel spacing (18 units). |
| `COASTER_TRAINS` | `web/src/engine/bedrock-coaster.ts` | 2 | trains | One riding, one in the loading bay. |
| `COASTER_HOLD_GAP` | `web/src/engine/bedrock-coaster.ts` | 0.5 | model blocks | Gap between the waiting train and the platform's. |
| `COASTER_DISPATCH_FRACTION` | `web/src/engine/bedrock-coaster.ts` | 0.5 | laps | The second train leaves when the first is half a lap ahead. |
| `COASTER_MAX_CARS` | `web/src/engine/bedrock-coaster.ts` | 8 | cars | Most cars one route runs. |
| loop radius cap | `web/src/engine/bedrock-coaster.ts` `const LOOP_RADIUS_MAX = §;` | 8 | model blocks | Larger "loops" are curves, not inversions. |
| level-track threshold | `web/src/engine/bedrock-coaster.ts` `const TRACK_LEVEL_MIN = §;` | 0.05 | horizontal fraction | Below it gravity's up is not a meaningful roll target (measured swings on 10303's vertical drop). |
| coaster tick | `web/src/engine/bedrock-coaster.ts` `system.runInterval(tick, §);` | 1 | ticks | The ride integrates every game tick (20 Hz). |
| pinball gravity | `web/src/engine/pinball-physics.ts` `options.gravity ?? §` | 1100 | LDU/s² along +u | Real rolling ball on the 8.6° table: 2,630; slowed to 0.65× real time so a 20 Hz frame sees the ball (§1). |
| pinball max substeps | `web/src/engine/pinball-physics.ts` `options.substeps ?? §` | 12 | per tick | Cap of the adaptive substep count. |
| pinball step fraction | `web/src/engine/pinball-physics.ts` `options.maxStepFraction ?? §` | 0.4 | ball radii | Longest move per substep; no tunnelling through walls or flipper tips. |
| wall restitution | `web/src/engine/pinball-physics.ts` `options.wallBounce ?? §` | 0.5 | ratio | Static field bounce. |
| flipper restitution | `web/src/engine/pinball-physics.ts` `options.flipperBounce ?? §` | 0.3 | ratio | Flipper contact bounce (the shot comes from the surface velocity). |
| flipper up speed | `web/src/engine/pinball-physics.ts` `options.flipperUpSpeed ?? §` | 14 | rad/s | Swing up. |
| flipper down speed | `web/src/engine/pinball-physics.ts` `options.flipperDownSpeed ?? §` | 7 | rad/s | Fall back. |
| bumper kick | `web/src/engine/pinball-physics.ts` `options.bumperKick ?? §` | 900 | LDU/s | Speed leaving a bumper. |
| plunger launch | `web/src/engine/pinball-physics.ts` `options.launchMax ?? §` | 1900 | LDU/s at full pull | Speed = launchMax × pull (spring: energy ∝ pull²). |
| plunger charge | `web/src/engine/pinball-physics.ts` `options.chargeSeconds ?? §` | 1 | s | Hold time for a full pull with `launch`. |
| pinball speed cap | `web/src/engine/pinball-physics.ts` `options.maxSpeed ?? §` | 2400 | LDU/s | Ball speed ceiling. |
| pinball damping | `web/src/engine/pinball-physics.ts` `state.vu *= 1 - § * dt` | 0.08 | 1/s | Linear rolling/air loss. |
| plunger dead pull | `web/src/engine/pinball-physics.ts` `const MIN_PULL = §;` | 0.05 | fraction | A pull under this is a release without a shot. |
| nominal tilt | `web/src/engine/pinball-table.ts` `(options.nominalTiltDeg ?? §) * Math.PI` | 6.5 | degrees | Reported for a flat model; the sim's gravity does not read it (§11). |
| pinball tick | `web/src/engine/bedrock-pinball.ts` `pull: pullNow }, §)` | 0.05 | s | One sim step per game tick. |
| `TICKS_PER_SECOND` | `web/src/sim/physics/body.ts` | 20 | ticks/s | Minecraft's tick. |
| `GRAVITY` | `web/src/sim/physics/body.ts` | 0.08 | blocks/tick² | Minecraft player gravity (§3). |
| `VERTICAL_DRAG` | `web/src/sim/physics/body.ts` | 0.98 | per tick | Minecraft player vertical drag. |
| `JUMP_VELOCITY` | `web/src/sim/physics/body.ts` | 0.42 | blocks/tick | Minecraft jump impulse. |
| `JUMP_PEAK` | `web/src/sim/physics/body.ts` | 1.2522 | blocks | Computed by the integrator; the wiki's 1.2522. |
| `TERMINAL_VELOCITY` | `web/src/sim/physics/body.ts` | 3.92 | blocks/tick | 0.08 × 0.98 / 0.02. |
| `WALK_SPEED` | `web/src/sim/physics/body.ts` | 0.21585 | blocks/tick | 4.317 blocks/s. |
| `SPRINT_FACTOR` | `web/src/sim/physics/body.ts` | 1.3 | × walk | Minecraft sprint. |
| `SNEAK_FACTOR` | `web/src/sim/physics/body.ts` | 0.3 | × walk | Minecraft sneak. |
| `GROUND_FRICTION` | `web/src/sim/physics/body.ts` | 0.546 | per tick | 0.6 block slipperiness × 0.91. |
| `AIR_FRICTION` | `web/src/sim/physics/body.ts` | 0.91 | per tick | Minecraft horizontal drag in air. |
| `AIR_ACCELERATION` | `web/src/sim/physics/body.ts` | 0.02 | blocks/tick² | In-air control. |
| `STEP_HEIGHT` | `web/src/sim/physics/body.ts` | 0.5625 | blocks | The reach BFS's quantised 0.6 step (9/16), so walker and BFS agree by construction. |
| `SLOW_FALL_GRAVITY` | `web/src/sim/physics/body.ts` | 0.01 | blocks/tick² | Slow falling's gravity while falling: a 9.8 blocks/s terminal with the 0.98 drag; the Pixel's float-down took 11 s over 89 blocks (2026-09-29, `output/nimbus-pixel-0929/`). |
| `PLAYER_EYE_HEIGHT` | `web/src/sim/physics/body.ts` | 1.62 | blocks | A standing player's eye over its feet (Minecraft's). |
| `STEP_HEIGHT_BLOCKS` | `web/src/engine/addon-scale.ts` | 0.6 | blocks | Minecraft auto-step. |
| `JUMP_HEIGHT_BLOCKS` | `web/src/engine/addon-scale.ts` | 1.25 | blocks | Minecraft jump, for reach planning. |
| `PLAYER_WIDTH_BLOCKS` | `web/src/engine/addon-scale.ts` | 0.6 | blocks | Player box width. |
| `MICROFIG_SCALE` | `web/src/engine/addon-scale.ts` | 2 | × | A 48-LDU microfigure stands player height. |
| `MIN_AUTO_SCALE` | `web/src/engine/addon-scale.ts` | 0.25 | × | Smallest auto shrink of a display vehicle. |
| `VEHICLE_TARGET_BLOCKS.car` | `web/src/engine/addon-scale.ts` | 4.6 | blocks (m) | A real car's length. |
| `VEHICLE_TARGET_BLOCKS.boat` | `web/src/engine/addon-scale.ts` | 9 | blocks (m) | A real boat's length. |
| `VEHICLE_TARGET_BLOCKS.plane` | `web/src/engine/addon-scale.ts` | 12 | blocks (m) | A real light aircraft's length. |
| `FIGURE_TUNING.speed` | `web/src/engine/bedrock-figure-life.ts` | 0.06 | blocks/tick | The velocity asked for each tick; the Pixel realises 0.0415 blocks/tick (0.83 blocks/s, GameTest gait probe 2026-09-25): a stroll, below the player's 4.3 walk. |
| `FIGURE_TUNING.turnPerTick` | `web/src/engine/bedrock-figure-life.ts` | 18 | degrees/tick | Body turn while walking. |
| `FIGURE_TUNING.maxUp` | `web/src/engine/bedrock-figure-life.ts` | 0.6 | blocks | Largest rise planned: a step, never a jump, so a figure keeps its floor. |
| `FIGURE_TUNING.maxDown` | `web/src/engine/bedrock-figure-life.ts` | 0.6 | blocks | Largest drop planned: no falls. |
| `FIGURE_TUNING.radius` | `web/src/engine/bedrock-figure-life.ts` | 7 | blocks | Stroll radius around home at 100 %. |
| `FIGURE_TUNING.band` | `web/src/engine/bedrock-figure-life.ts` | 1.2 | blocks | Height band around the home floor. |
| `FIGURE_TUNING.doorwayClearance` | `web/src/engine/bedrock-figure-life.ts` | 1.25 | blocks | Never stop this close to a door leaf. |
| `SCRIPTED_NATIVE_SPEED` | `web/src/engine/playable-addon.ts` | 0 | Bedrock movement / flying_speed | A scripted vehicle's native speeds: only the script moves it. |
| `ROTOR_FLYING_SPEED` | `web/src/engine/playable-addon.ts` | 0.3 | Bedrock flying_speed | A rotorcraft's, the Happy Ghast's controller: 38.3 blocks/s forward measured on the Nimbus at this value (Pixel 2026-09-29, CMVT fast, 85.7 mph HUD against 85.9 true) - not the "~5 blocks/s" an earlier round read off a ramped stick. |
| `FLYER.FLYING_SPEED` | `web/src/engine/bedrock-flyer.ts` | 0.0725 | Bedrock flying_speed | A flyer mount's cruise, for a five-year-old round a ten-block model. Two Pixel measurements (CMVT fast, 2026-09-29): 38.3 blocks/s at 0.3 and 13.1 at 0.09 - not proportional (11.5 predicted), so v ≈ 120·fs + 2.3 blocks/s and 0.0725 is ~11 blocks/s (25 mph). Confirm on the next round; the same at every wand size. |
| `FLIGHT.MAX_SPEED` | `web/src/engine/bedrock-vehicle.ts` | 18 | blocks/s | A ship's full forward thrust (40 mph): the old flight model's 23 cruise and 32 ceiling left a child round a ten-block model in a second; the car's 19 is a speed the same child already drives. Device feel unproven (TASKS "Spaceship controls"). |
| `FLIGHT.REVERSE_SPEED` | `web/src/engine/bedrock-vehicle.ts` | 8 | blocks/s | Straight backwards on the stick pulled back ("there should be a way to go ... backwards"). |
| `FLIGHT.ACCEL` | `web/src/engine/bedrock-vehicle.ts` | 12 | blocks/s² | 0 to full in 1.5 s. |
| `FLIGHT.BRAKE` | `web/src/engine/bedrock-vehicle.ts` | 24 | blocks/s² | Hands off (or the stick against the motion) it stops from full in 0.75 s, 6.8 blocks on, and HOVERS: no glide, no stall. At 14 the simulator's ship ran 11 blocks on after letting go - a glide, not a stop. |
| `FLIGHT.TURN_RATE` | `web/src/engine/bedrock-vehicle.ts` | 80 | degrees/s | Full stick turns it, at rest too (a pivot on the spot): a quarter turn in about a second. |
| `FLIGHT.CLIMB_SPEED` | `web/src/engine/bedrock-vehicle.ts` | 8 | blocks/s | Straight up on Jump. The Nimbus's native climb measured ~20-22 blocks/s (Saga/Pixel 2026-09-29); a ship's is slower so a tap lifts it a few blocks, not a storey. |
| `FLIGHT.DESCEND_SPEED` | `web/src/engine/bedrock-vehicle.ts` | 8 | blocks/s | Straight down on back + Jump, or a Jump pressed while the view looks down. |
| `FLIGHT.VERTICAL_ACCEL` | `web/src/engine/bedrock-vehicle.ts` | 24 | blocks/s² | Up or down reaches its speed in a third of a second and stops as fast. |
| `FLIGHT.IDLE_SINK` | `web/src/engine/bedrock-vehicle.ts` | 3 | blocks/s | Nobody aboard (a sneak off in the air): it sinks gently to the ground and parks, within reach of the child who left it. |
| `FLIGHT.AUTO_CLIMB` | `web/src/engine/bedrock-vehicle.ts` | 8 | blocks/s | A ship pushed into a hill or a wall lifts itself over it at this rate (`resolveMove` `climb` / `rise`); a rise zeroes the speed, so the next tick's creep is clear and the face is met again - about 6 blocks/s net. |
| `FLIGHT.PLAYER_HEIGHT` | `web/src/engine/bedrock-vehicle.ts` | 1.8 | blocks | A Bedrock player's height, for the head an empty ship must stay over. |
| `FLIGHT.PARK_CLEARANCE` | `web/src/engine/bedrock-vehicle.ts` | 1.5 | blocks | An empty ship sinking to park holds this far over the head of anyone under its footprint, and sinks on when they walk out: over a standing jump's 1.25, so the child under it is never hit (the X-wing parked ON the child who sneaked off it, Saga 30j s79). |
| `FLIGHT.STEP_UP` | `web/src/engine/bedrock-vehicle.ts` | 1 | blocks | Resting on the ground, it glides over a rise of a block; aloft the whole airframe must clear. |
| `FLIGHT.PITCH_MAX` | `web/src/engine/bedrock-vehicle.ts` | 20 | degrees | Most the body tips (nose up climbing, down diving or accelerating): attitude only, drawn by the animation. |
| `FLIGHT.DIVE_PITCH_DEG` | `web/src/engine/bedrock-vehicle.ts` | 25 | degrees (view pitch, + = down) | A Jump PRESSED while the rider's view looks down past this goes down until Jump is let go - the Nimbus's `FLYER.DIVE_PITCH_DEG`, the same 25 (a chase camera's line of sight is not a dive, a deliberate drag down is). |
| `FLIGHT.DESCEND_STICK` | `web/src/engine/bedrock-vehicle.ts` | -0.5 | stick deflection | Jump with the stick pulled back past half goes down (the Nimbus's back + Jump) and gives no reverse thrust while it does. |
| `FLIGHT.STICK_X_RIGHT` | `web/src/engine/bedrock-vehicle.ts` | -1 | sign | Measured: the stick pushed RIGHT reads `getMovementVector().x` = -0.46 (Pixel, 2026-09-25). |
| `CAR.MAX_SPEED` | `web/src/engine/bedrock-vehicle.ts` | 19 | blocks/s | Full stick (42 mph), what the camel gave at movement 0.45. |
| `CAR.REVERSE_SPEED` | `web/src/engine/bedrock-vehicle.ts` | 5 | blocks/s | Full reverse. |
| `CAR.ACCEL` | `web/src/engine/bedrock-vehicle.ts` | 7 | blocks/s² | 0 to full in under 3 s. |
| `CAR.BRAKE` | `web/src/engine/bedrock-vehicle.ts` | 14 | blocks/s² | Stick against the motion. |
| `CAR.COAST` | `web/src/engine/bedrock-vehicle.ts` | 2.5 | blocks/s² | Hands off: rolls on instead of the camel's dead stop. |
| `CAR.BOOST_SPEED` | `web/src/engine/bedrock-vehicle.ts` | 26 | blocks/s | Jump boost for `BOOST_SECONDS` 1.5, then `BOOST_COOLDOWN` 3. |
| `CAR.STEER_RATE` | `web/src/engine/bedrock-vehicle.ts` | 110 | degrees/s | Full lock at `STEER_FULL_SPEED` 5 blocks/s, divided by 1 + speed / `STEER_FADE` 12: about 43 degrees/s at top speed. |
| `CAR.PIVOT_RATE` | `web/src/engine/bedrock-vehicle.ts` | 45 | degrees/s | At a standstill the stick's left/right turns it on the spot, fading out by `STEER_FULL_SPEED`: a car nosed into a corner or wedged between two walls can always be turned out (2026-09-30). |
| `CAR.STEP_UP` | `web/src/engine/bedrock-vehicle.ts` | 1.05 | blocks | Highest step climbed (a full block, as the camel's 1.25 auto-step allowed); higher is a wall to scramble up (`RISE_MAX`). |
| `CAR.CLIMB_RATE` | `web/src/engine/bedrock-vehicle.ts` | 6 | blocks/s | How fast it eases up a step, and scrambles up a wall it is pushed into. |
| `CAR.RISE_MAX` | `web/src/engine/bedrock-vehicle.ts` | 1.1 | blocks | Most a car scrambles up a wall in one push; with `STEP_UP` it climbs out of a two-block pit or onto a two-block kerb (2.15). A higher wall stops it. |
| `CAR.CLIMB_HOLD_TICKS` | `web/src/engine/bedrock-vehicle.ts` | 40 | ticks | While the stick still pushes, a car that scrambled up holds that height this long (2 s) for its wheels to reach the top, its centre still over the pit. |
| `CAR.WATER_SPEED` | `web/src/engine/bedrock-vehicle.ts` | 2 | blocks/s | Crawl through water. |
| `CAR.STICK_X_RIGHT` | `web/src/engine/bedrock-vehicle.ts` | -1 | sign | Same measured sign as the aircraft's. |
| `FLIGHT.STICK_FULL` | `web/src/engine/bedrock-vehicle.ts` | 0.8 | stick deflection | Counts as full in all three models (`CAR`, `BOAT` the same): a touch stick pushed to its rim reads 0.816 on the Pixel, which held a car at 15.5 of its 19 blocks/s. |
| `BOAT.MAX_SPEED` | `web/src/engine/bedrock-vehicle.ts` | 8 | blocks/s | Full ahead; 8.0 measured in GameTest (the buoyant camel crawled at 1.8). |
| `BOAT.BOOST_SPEED` | `web/src/engine/bedrock-vehicle.ts` | 12 | blocks/s | Jump boost for `BOOST_SECONDS`, then `BOOST_COOLDOWN`. |
| `BOAT.BOOST_SECONDS` | `web/src/engine/bedrock-vehicle.ts` | 3 | s | Boost length. |
| `BOAT.BOOST_COOLDOWN` | `web/src/engine/bedrock-vehicle.ts` | 4 | s | Wait after a boost ends. |
| `BOAT.REVERSE_SPEED` | `web/src/engine/bedrock-vehicle.ts` | 2.5 | blocks/s | Full astern. |
| `BOAT.WATER_DRAG` | `web/src/engine/bedrock-vehicle.ts` | 1.2 | blocks/s² | Coast-down hands off (13.7 blocks from 8 blocks/s over 2 s measured). |
| `BOAT.TURN_RATE` | `web/src/engine/bedrock-vehicle.ts` | 50 | degrees/s | Full rudder at `RUDDER_SPEED` and above. |
| `BOAT.RUDDER_SPEED` | `web/src/engine/bedrock-vehicle.ts` | 4 | blocks/s | Speed of full rudder bite. |
| `BOAT.RUDDER_AT_REST` | `web/src/engine/bedrock-vehicle.ts` | 0.35 | fraction | Rudder bite at a standstill, so a moored boat can be pointed out. |
| `BOAT.DRAFT` | `web/src/engine/bedrock-vehicle.ts` | 0.3 | blocks | Default keel depth under the surface; the pack gives each boat 12 % of its height, 0.3-1.2 (a 3-block yacht rode visibly high at 0.3 on the Pixel). |
| aircraft climb | `web/src/engine/playable-addon.ts` `[AIRCRAFT_CLIMB_GROUP]: { 'minecraft:vertical_movement_action': { vertical_velocity: § } }` | 0.5 | Bedrock vertical velocity | ~17 blocks/s climb measured on the Pixel (1.35 climbed 206 blocks in a second). |
| `HOVER.MAX_SPEED` | `web/src/engine/bedrock-vehicle.ts` | 12 | blocks/s | A hover craft's full stick (27 mph): a heavy barge's glide, not a sports car. |
| `HOVER.ACCEL` | `web/src/engine/bedrock-vehicle.ts` | 4 | blocks/s² | 0 to full in 3 s. |
| `HOVER.COAST` | `web/src/engine/bedrock-vehicle.ts` | 1.2 | blocks/s² | Hands off it glides (a car coasts down at 2.5). |
| `HOVER.STEER_RATE` | `web/src/engine/bedrock-vehicle.ts` | 70 | degrees/s | Gentler than a car's 110. |
| `HOVER.STEP_UP` | `web/src/engine/bedrock-vehicle.ts` | 1.6 | blocks | It floats over a block and a half of rise. |
| `HOVER.PIVOT_RATE` | `web/src/engine/bedrock-vehicle.ts` | 40 | degrees/s | Turns on the spot at rest, as a car does. |
| `HOVER.RISE_MAX` | `web/src/engine/bedrock-vehicle.ts` | 1 | blocks | Most it lifts over a wall in one push (2.6 with its `STEP_UP`). |
| `HOVER.GRAVITY` | `web/src/engine/bedrock-vehicle.ts` | 6 | blocks/s² | It sinks slowly off an edge. |
| `HOVER.RIDE_HEIGHT` | `web/src/engine/bedrock-vehicle.ts` | 1 | blocks | Height above the ground or the water's surface. |
| `FOOTPRINT.SPACING` | `web/src/engine/bedrock-vehicle.ts` | 0.9 | blocks | Maximum ordinary perimeter and vertical probe spacing; covers one-block trunks and crowns. |
| `FOOTPRINT.MAX_POINTS` | `web/src/engine/bedrock-vehicle.ts` | 128 | probes | A 36-block barge's 100-block perimeter still gets 0.9 spacing. |
| `FOOTPRINT.SWEEP_STEP` | `web/src/engine/bedrock-vehicle.ts` | 0.8 | blocks | Most a probe travels between two tested poses: a 32 blocks/s aircraft moves 1.6 a tick. |
| `FOOTPRINT.MAX_SUBSTEPS` | `web/src/engine/bedrock-vehicle.ts` | 4 | poses/tick | Bounds the cost of a fast turn. |
| `MOVE.DEFLECT_SHARE` | `web/src/engine/bedrock-vehicle.ts` | 0.7 | share of the tick's move | A vehicle whose one half meets a trunk or a post steps sideways by this share of its move: round a tree hit with a corner at full speed in two ticks. |
| `MOVE.MIN_SIDESTEP` | `web/src/engine/bedrock-vehicle.ts` | 0.1 | blocks/tick | The sidestep's least size, so a car crawling into a tree still edges round it. |
| `MOVE.MIN_PROGRESS` | `web/src/engine/bedrock-vehicle.ts` | 0.002 | blocks | A retry that moves less than this is not tried. |
| `MOVE.GLANCE_STEP_DEG` | `web/src/engine/bedrock-vehicle.ts` | 20 | degrees | A slanted wall across the way (a diagonal of blocks): the move is turned toward the roomier edge in these steps. |
| `MOVE.GLANCE_MAX_DEG` | `web/src/engine/bedrock-vehicle.ts` | 60 | degrees | The most it turns (keeping cos 60 = half the push); pinned by a stair corner past that, it edges sideways by the sidestep. A wall at 30 degrees off square across a car's way stopped 10797's and 60380's cars dead until this (simulator vehicle course, 2026-09-30). |
| `MOVE.GLANCE_PROBE` | `web/src/engine/bedrock-vehicle.ts` | 1.5 | blocks | How far ahead each edge's room is probed (in quarters): a square wall leaves both edges the same room, so a car nosed into one does not crawl sideways along it. |
| `MOVE.NARROW_CELLS` | `web/src/engine/bedrock-vehicle.ts` | 12 | cells | The most solid cells joined to the hit cell (8-connected, in its own horizontal plane) a block may have for a SHIP to step round it instead of lifting over: a trunk (1), a 2x2 pillar, a 3x3 crown (9) are narrow; a wall or a hill of any shape or angle is not. Cell reads only (cached per tick), no sweep. |
| `FREE_LOOK.SEAT_LOCK_DEG` | `web/src/engine/vehicle-free-look.ts` | 181 | degrees | A scripted vehicle seat's `lock_rider_rotation`: the component's documented default and "no limit"; the coaster's seats have it and their riders look round. Was 0 (yaw held to the seat). |
| `FREE_LOOK.IDLE_TICKS` | `web/src/engine/vehicle-free-look.ts` | 20 | ticks | One second with no drag before the view starts back to the nose ("semi gradually"): a child lifting a thumb to drag again is not fought. |
| `FREE_LOOK.RECENTRE_SECONDS` | `web/src/engine/vehicle-free-look.ts` | 0.6 | s | The ease back's time constant: 63 % in 0.6 s, 95 % in 1.8 s - inside the 1-2 s the brief asked for. |
| `FREE_LOOK.MIN_STEP_DEG` | `web/src/engine/vehicle-free-look.ts` | 0.15 | degrees/tick | The ease's slowest step, so it lands on the nose instead of creeping. |
| `FREE_LOOK.MOVING_SPEED` | `web/src/engine/vehicle-free-look.ts` | 0.5 | blocks/s | Under it the vehicle is at rest and the view stays where the child left it ("while moving"). |
| `FREE_LOOK.DRAG_EPS_DEG` | `web/src/engine/vehicle-free-look.ts` | 0.4 | degrees/tick | A look change under this is noise; a drag reads ~0.21 degrees per pixel (pinball, Pixel 2026-09-25), so two pixels a tick is a drag. |
| `FREE_LOOK.PITCH_UP_MAX` | `web/src/engine/vehicle-free-look.ts` | 35 | degrees | Furthest the view is dragged up over the vehicle's own pitch: the chase boom swings under the vehicle past it. |
| `FREE_LOOK.PITCH_DOWN_MAX` | `web/src/engine/vehicle-free-look.ts` | 70 | degrees | Furthest the view is dragged down: nearly straight down on the vehicle. |
| `FREE_LOOK.RIDER_YAW_LAG_TICKS` | `web/src/engine/vehicle-free-look.ts` | 6 | ticks | A carried rider's reported yaw trails its vehicle (quirk `rider-yaw-lag`); the drag reading compares it with the vehicle's yaw that long ago. |
| `FREE_LOOK.COCKPIT_TICK_LAG` | `web/src/engine/vehicle-free-look.ts` | 1.5 | ticks | The cockpit camera shows the vehicle's pose this long ago: the client draws a teleported entity behind the server, and the coaster's per-tick camera measured 1.5 with a 0.1 s ease (`COASTER_RIDER_VIEW.tickLag`, Pixel 2026-09-25). Not yet measured on a car or ship. |
| `FREE_LOOK.COCKPIT_EASE_SECONDS` | `web/src/engine/vehicle-free-look.ts` | 0.1 | s | The cockpit camera's ease, the coaster's measured per-tick ease. |
| `FREE_LOOK.COCKPIT_HISTORY` | `web/src/engine/vehicle-free-look.ts` | 4 | ticks | Vehicle poses kept per rider for the lag (more than `COCKPIT_TICK_LAG` + 1). |
| `FREE_LOOK.COCKPIT_PITCH_MAX` | `web/src/engine/vehicle-free-look.ts` | 89 | degrees | The cockpit camera's pitch bound: `setCamera` throws past ±90 (quirk `camera-pitch-limit`). |
| `FREE_LOOK.CHASE_WALL_STEP` | `web/src/engine/vehicle-free-look.ts` | 0.25 | blocks | The chase camera marches the line from the vehicle's pivot to itself in these steps; the first solid block (not air, liquid or `CHASE_PASSABLE_BLOCKS`) pulls it in. |
| `FREE_LOOK.CHASE_WALL_MARGIN` | `web/src/engine/vehicle-free-look.ts` | 0.3 | blocks | How far short of that block the camera stops, so the near plane stays out of the wall: a ship parked tail-first by a wall put the camera behind it, the wall's texture filling the view (Saga 30j s68). |
| `HEADLIGHTS.LEVEL` | `web/src/engine/bedrock-vehicle.ts` | 14 | light level | One `minecraft:light_block_14`: bright enough to read the road ahead at night. |
| `HEADLIGHTS.AHEAD` | `web/src/engine/bedrock-vehicle.ts` | 2 | blocks | Past the nose, along the heading. |
| `HEADLIGHTS.PARK_TICKS` | `web/src/engine/bedrock-vehicle.ts` | 100 | ticks | A light switches off after 5 s parked. |
| `HEADLIGHTS.DUSK` | `web/src/engine/bedrock-vehicle.ts` | 12500 | time of day | Minecraft sunset; night until `DAWN` 23500. |
| `TIME_MACHINE.TOP_MARGIN` | `web/src/engine/playable-addon.ts` | 1.03 | × | The time machine's top speed is 3 % past its jump speed (88 mph: 40.5 blocks/s), so a full stick reaches it. |
| `TIME_MACHINE.TELEPORT_BLOCKS` | `web/src/engine/playable-addon.ts` | 10 | blocks per 2 ticks | A longer move is a teleport, not speed: 100 blocks/s, past the 150 mph slider's 67. |
| `RIDE.SLIDE_V0` | `web/src/engine/bedrock-rides.ts` | 2 | blocks/s | A slide rider leaves the top at a walk, so the start reads as a push-off. |
| `RIDE.SLIDE_ACCEL` | `web/src/engine/bedrock-rides.ts` | 6 | blocks/s² | Reaches `SLIDE_VMAX` in 1 s: a 6-brick playground chute is over in about a second, as a real one is. |
| `RIDE.SLIDE_VMAX` | `web/src/engine/bedrock-rides.ts` | 8 | blocks/s | Under a sprint (5.6) plus a jump's carry; fast enough to feel, slow enough to see the chute pass. |
| `RIDE.SLIDE_RETURN_TICKS` | `web/src/engine/bedrock-rides.ts` | 10 | ticks | The seat waits half a second at the foot, so the rider is clear before it returns to the top. |
| `RIDE.LIFT_SPEED` | `web/src/engine/bedrock-rides.ts` | 1.5 | blocks/s | A storey of a minifig dollhouse (8 bricks, 3.6 blocks) in about 2.4 s: a lift, not a launch. |
| `RIDE.ORBIT_SPEED` | `web/src/engine/bedrock-rides.ts` | 3 | blocks/s at 100 % | A companion's lap: under the player's 4.3 walk, so a child can watch it go by and follow it; a 20-block-radius lap takes ~40 s. Scaled by the wand factor like the other rides. |
| `RIDE.ORBIT_RESEAT_REACH` | `web/src/engine/bedrock-rides.ts` | 8 | blocks at 100 % | An orbit seat with nobody on it looks this far for its own figure type; the figure is unique to the mount, so the search cannot take another. |
| `RIDE.ORBIT_RESEAT_TICKS` | `web/src/engine/bedrock-rides.ts` | 40 | ticks | Two seconds between re-seat attempts: a figure a player is holding on to is not fought for every tick. |
| `RIDE.ORBIT_ADOPT_TICKS` | `web/src/engine/bedrock-rides.ts` | 20 | ticks | A placed or reloaded orbit seat is found and started within a second. |
| `RIDE.ORBIT_YAW_CHORD` | `web/src/engine/bedrock-rides.ts` | 0.5 | blocks | Half the chord the loop's yaw is read over (a central difference), so the facing turns smoothly between the 64 points instead of stepping 5.6 degrees a segment. |
| `FLYER.MOUNT_MIN_PARTS` | `web/src/engine/bedrock-flyer.ts` | 6 | parts | Fewer is a plate the figure stands on, not a build. |
| `FLYER.MOUNT_MAX_PARTS` | `web/src/engine/bedrock-flyer.ts` | 80 | parts | A cloud is a few dozen slopes; the rock and its dragon are hundreds (the fixture's cloud is 26, its pillar 268). |
| `FLYER.MOUNT_COLOUR_SHARE` | `web/src/engine/bedrock-flyer.ts` | 0.6 | fraction | At least this share of a mount's parts are in its style's colour family (a golden cloud with a few white or tan pieces passes; a grey rock with a yellow flower does not). |
| `FLYER.MOUNT_FOOT_REACH_LDU` | `web/src/engine/bedrock-flyer.ts` | 16 | LDU | The mount's top lies within this of the figure's soles: a plate is 8, with slack for a stud and a converter's rounding. |
| `FLYER.MOUNT_FOOT_MARGIN_LDU` | `web/src/engine/bedrock-flyer.ts` | 12 | LDU | The soles lie within half a stud of a mount part's footprint. |
| `FLYER.TOUCH_LDU` | `web/src/engine/bedrock-flyer.ts` | 2 | LDU | Parts closer than this touch (clustering; the rides' `TOUCH_LDU` is the same). |
| `FLYER.ORBIT_MARGIN_LDU` | `web/src/engine/bedrock-flyer.ts` | 160 | LDU | The lap runs 3 blocks (at 100 %) outside half the model's footprint diagonal: clear of every corner, close enough to read as "round the dragon". |
| `FLYER.ORBIT_HEIGHT_FRACTION` | `web/src/engine/bedrock-flyer.ts` | 0.8 | share of the model's height | The lap's centre line, in the model's upper third; with the bob below it stays under the top. |
| `FLYER.ORBIT_BOB_LDU` | `web/src/engine/bedrock-flyer.ts` | 32 | LDU | 0.6 blocks up and down at 100 %: a rise a child sees, not a swoop. |
| `FLYER.ORBIT_BOB_PERIODS` | `web/src/engine/bedrock-flyer.ts` | 2 | per lap | Two rises and falls a lap. |
| `FLYER.ORBIT_POINTS` | `web/src/engine/bedrock-flyer.ts` | 64 | points | 5.6 degrees a segment; the runtime's chord yaw makes the facing continuous over them. |
| `FLYER.EMPTY_DESPAWN_TICKS` | `web/src/engine/bedrock-flyer.ts` | 1200 | ticks | A summoned cloud nobody rides fades after 60 s: long enough to get back on after a look round, short enough that a child's twenty taps do not litter the world. |
| `FLYER.CLOUD_CAP` | `web/src/engine/bedrock-flyer.ts` | 8 | clouds | Most summoned clouds at once; the oldest fades when another is summoned. |
| `FLYER.TAP_COOLDOWN_TICKS` | `web/src/engine/bedrock-flyer.ts` | 20 | ticks | A tap that lands as both an interact and a hit, or a double tap, is one summon. |
| `FLYER.SPAWN_AHEAD_BLOCKS` | `web/src/engine/bedrock-flyer.ts` | 1.5 | blocks | The summoned cloud appears this far ahead of the player, who is mounted on it at once. |
| `FLYER.DIVE_PITCH_DEG` | `web/src/engine/bedrock-flyer.ts` | 25 | degrees (rider pitch, positive down) | Past this the driver puts the descend group in, so Jump dives: a look at the ground ahead (a chase camera's default sits near 20 down) is not a dive, a deliberate look down is. The native hover controller ignores the look pitch (Saga, 26.52, 2026-09-29). |
| `FLYER.RIDE_HINT_TICKS` | `web/src/engine/bedrock-flyer.ts` | 60 | ticks | The driver HUD opens a ride with the mount's name and "Jump climbs, look down + Jump dives, sneak gets off" for 3 s - long enough to read, short enough that the speed line is back before the first turn. A one-shot action bar at the summon was overwritten by the HUD within 4 ticks. |
| `FLYER.DISMOUNT_DROP_BLOCKS` | `web/src/engine/bedrock-flyer.ts` | 2 | blocks | A rider leaving a cloud with no solid block within this under their feet is airborne: a step off onto a roof (the seat is ~1 block over the cloud's top) is not. |
| `FLYER.DISMOUNT_SLOW_FALL_TICKS` | `web/src/engine/bedrock-flyer.ts` | 600 | ticks | 30 s of slow falling (Bedrock: ~3 blocks/s, no fall damage) covers a 90-block drop; the Saga rider fell 229 blocks from ALT 169 in one sneak, and a longer float only lands later. |
| `DRIVER_SPEED_WINDOW_TICKS` | `web/src/engine/playable-addon.ts` | 20 | ticks | The HUD speed is the mean between the first and the last position CHANGE of the last second: a native mount's server position moves in bursts (one 2-tick delta read 0 / 24.9 / 60.2 / 99.0 mph at ~10 blocks/s on the Saga), and any burst cadence up to a second averages out; a second is also how long a stop takes to read 0. |
| `DRIVER_TELEPORT_BLOCKS` | `web/src/engine/playable-addon.ts` | 5 | blocks per 2 ticks | A longer step between two samples is a teleport (the wand, a reload), not motion: 50 blocks/s, past the rotor's climb and cruise. |
| `DRIVER_ALT_SCAN_BLOCKS` | `web/src/engine/playable-addon.ts` | 64 | blocks | The native HUD's ALT is the height over the first solid or liquid block within this under the mount (`--` past it or over an unloaded block), as a ship's is: the Nimbus showed the world y (`ALT -59` on the ground, Saga 30j). |
| `RIDE.SETDOWN_LIFT_BLOCKS` | `web/src/engine/bedrock-rides.ts` | 0.05 | blocks | A ride's terminal point starts just above its nominal path endpoint before the collider probe settles the rider. |
| `RIDE.SETDOWN_REACH_BLOCKS` | `web/src/engine/bedrock-rides.ts` | 2 | blocks at 100 % | The collider probe may search this far sideways for a free standing pose, scaled with the ride but never below 100 %. 10797's nearest source-safe, representable landing is exactly 2 blocks from its chute terminal; every candidate through 1.5 blocks remains obstructed. Only a pose the rider WALKS to from the terminal counts (`routeClear`): at 400 % the reach is 8 blocks, and a point behind a wall was a set-down through it. With none, `escape` (`ESCAPE`). The scenery seats use the same reach (times the seat's scale). |
| `RIDE.SETDOWN_DROP_BLOCKS` | `web/src/engine/bedrock-rides.ts` | 3 | blocks | The collider probe may settle onto a floor this far below the terminal, within the ordinary no-damage fall range. |
| walk exit floor tolerance | `web/src/engine/collider-form.ts` `FLOOR_TOLERANCE = §,` | 0.0625 | blocks (1/16) | A body stands ON its floor within one collider sixteenth: forms and their tops are quantised to sixteenths, so a finer tolerance rejects a real floor and a coarser one accepts a hover. A body over its floor by more falls onto it (`hasWalkExit`'s `fall`). |
| walk exit distance | `web/src/engine/collider-form.ts` `EXIT_DISTANCE = §,` | 1 | blocks | The exit is a whole block of walking: a half-block diagonal fits inside a sealed one-cell pocket when the start is near a corner (10796's slide pocket); a whole cell of walking does not. |
| walk exit sample spacing | `web/src/engine/collider-form.ts` `EXIT_SAMPLE = §;` | 0.125 | blocks (1/8) | The route (and `routeClear`'s) is sampled far under the 0.6-block body width, so consecutive sampled bodies overlap and no wall, however thin, slips between two; each 1/8 rise or fall is judged against the 9/16 step on its own. |
| `ESCAPE.SEED_REACH` | `web/src/engine/collider-form.ts` | 2 | blocks (times the seat's scale) | How far from the seat the flood's seeds may lie: the set-down reach, `RIDE.SETDOWN_REACH_BLOCKS`. |
| `ESCAPE.RADIUS` | `web/src/engine/collider-form.ts` | 16 | blocks | How far the flood walks: a 4-block room at 400 %. |
| `ESCAPE.MAX_NODES` | `web/src/engine/collider-form.ts` | 600 | lattice points | The flood's cost bound (a 12 x 12-block floor at half-block spacing): it runs inside the one tick a dismount fails, its block reads memoised for that call. |
| `ESCAPE.DROP` | `web/src/engine/collider-form.ts` | 3 | blocks | A flood edge may drop this far: the rides' no-damage fall. |
| `ESCAPE.EXTERIOR_REACH` | `web/src/engine/collider-form.ts` | 64 | blocks | How far out the exterior rays look; past the half-width of every favourite at 400 % (the sweep's farthest exterior set-down was 12 blocks). |
| `ESCAPE.HEADROOM` | `web/src/engine/collider-form.ts` | 32 | blocks | An exterior floor is open to the sky up to this over the seat. |
| `ESCAPE.DEPTH` | `web/src/engine/collider-form.ts` | 96 | blocks | An exterior floor may lie this far under the seat (a 400 % balcony seat over the ground: 76417's is 30 blocks up). |
| `SEAT_EGRESS.NATIVE_REACH_BLOCKS` | `web/src/engine/bedrock-figure-life.ts` | 2 | blocks (times the seat's scale) | Bedrock sets a dismounted player one block from the seat (1.41 on a diagonal) or 0.2 over it (quirk `dismount-free-spot`); farther the tick after is a deliberate move, left alone. The 300-400 % set-down is not measured, hence the scale. |
| `SEAT_EGRESS.RESEAT_LIMIT` | `web/src/engine/bedrock-figure-life.ts` | 2 | re-seats | When nothing walkable exists the player is put back on the seat, but a held Sneak dismounts again at once: after this many re-seats in a row (within `RESEAT_WINDOW_TICKS`) the player is left where Bedrock set it down. |
| `SEAT_EGRESS.RESEAT_WINDOW_TICKS` | `web/src/engine/bedrock-figure-life.ts` | 100 | ticks | Re-seats this close together count as in a row (5 s). |
| `HOP.REACH_BLOCKS` | `web/src/engine/bedrock-ride-hop.ts` | 0.5 | blocks | Slack around the footprint and the rider's box: a child steering past a car's corner at arm's length still gets in. Not scaled: a player's reach, not the model's. |
| `HOP.LEAD_TICKS` | `web/src/engine/bedrock-ride-hop.ts` | 2 | ticks | The last tick's relative motion carried this far ahead: a train at a block a tick is met a little early (0.1 s), never missed between two ticks. |
| `HOP.SAMPLE_BLOCKS` | `web/src/engine/bedrock-ride-hop.ts` | 0.25 | blocks | The swept segment's sample spacing: under half the smallest target's box (a 0.6-block seat). |
| `HOP.MIN_CLOSING_BLOCKS_PER_S` | `web/src/engine/bedrock-ride-hop.ts` | 0.5 | blocks/s | Under this relative speed nothing hops: parked beside a chair stays in the car; a walk-pace nudge (1 block/s) hops. |
| `HOP.BOARD_GRACE_TICKS` | `web/src/engine/bedrock-ride-hop.ts` | 20 | ticks | No hop in the first second aboard: boarding a car parked by a chair, or landing in a coaster car, is not an instant second hop. |
| `HOP.BACK_COOLDOWN_TICKS` | `web/src/engine/bedrock-ride-hop.ts` | 100 | ticks | The mount just left is not a target for 5 s: a plane hovering beside the track is not re-boarded as the coaster passes it on the same lap. |
| `HOP.SCAN_BLOCKS` | `web/src/engine/bedrock-ride-hop.ts` | 4 | blocks at 100 % | Targets are queried this far past the vehicle's half length (times its size): past the reach and a lead at coaster speed. |
| `HOP.SETDOWN_REACH_BLOCKS` | `web/src/engine/bedrock-ride-hop.ts` | 1.5 | blocks at 100 % | A car's box within this of a slide's set-down takes the rider: "parked at the bottom" is a car's length off the foot at most. It bounds only the hop's search for a mountable; the set-down's own search for a standing pose is `RIDE.SETDOWN_REACH_BLOCKS` (2, §4.7). |
| `HOP.TRAIN_REACH_BLOCKS` | `web/src/engine/bedrock-ride-hop.ts` | 16 | blocks | The front-most car is looked for this far from the touched one: a seven-car train of 1.7-block cars is ~12 long. |
| `HOP.DEFAULT_EXTENT_BLOCKS` | `web/src/engine/bedrock-ride-hop.ts` | 0.5 | blocks | A target's half extent when `getAABB` gives none: a one-block seat. |
| `FLYER_BOB.AMPLITUDE_UNITS` | `web/src/engine/bedrock-vehicle.ts` | 1 | geometry units (1/16 block) | The idle bob's amplitude: visible, never enough to move the seat visibly under the rider. |
| `FLYER_BOB.DEGREES_PER_SECOND` | `web/src/engine/bedrock-vehicle.ts` | 120 | degrees/s of the sine | One breath every 3 s. |
<!-- /physics-spec:constants -->

## 10. Measured facts

All of this section's host numbers come from `scripts/_coaster_pace_scan.ts`
(modes `metrics`, `stats`, `energy`), which runs the serialised runtime over
the corpus 10303 at any pace without editing code.

**Pace, host, 10303 at 100 %** (`stats`; riderless, the cars' wheelbase,
6,000 ticks; "cycle" is the sum of the intervals between successive stops of
one train):

| Pace | g, blocks/s² | Peak blocks/s | Mean moving blocks/s | Cycle, s | Loop-top v / sqrt(g r) |
|---|---|---|---|---|---|
| 1.0 | 9.8 | 20.0 (ceiling 20) | 7.30 | 74.2 | 1.47 |
| √2 (now) | 19.6 | 28.28 | 10.50 | 54.2 | 1.47 |
| 1.6 (device, "a touch too fast") | 25.1 | 32.0 | 11.59 | 48.7 | 1.47 |

With `MAX_SPEED = 20 × pace` the three are the same ride in different time:
the loop-top ratio is identical.

**The 10303 test metrics against pace** (`metrics`, with and without
`--tangent`; where the ticks fall moves with the pace, so the scan is a phase
sweep):

| | tangent (before) | the cars' wheelbase (now) |
|---|---|---|
| worst per-tick car yaw over the loops, pace 1.30-1.62 | 7.8-11.3° (fails < 10 at 1.35, 1.40, 1.45-1.58) | 7.3-9.2° |
| clamp camera, worst ° from vertical while off the nose | 37-90° | 30-46° |
| clamp camera, worst ° off the nose | 20-48° | 16-31° |

**Energy** (`energy`, `--scale=2`). DRAG, ROLLING, ceiling, floors and chain off: `v²/2 + g h`
stays within 1.1 % over the 142-tick drop-and-two-loops run and within 0.4 %
over the shorter runs, at 100 % and 200 %.

**Device (Pixel 8 Pro).** Pace 1.0 "about 50 % too slow" (2026-09-24);
pace 1.6 rode, "just a touch TOO fast" (2026-09-25); pace √2 not yet ridden.
Camera limits (pitch ±90, roll only by animation, rider yaw lags ~6 ticks):
the add-on guide, "The rider's camera follows the track". Aircraft (the
Happy Ghast controller at `flying_speed` 0.3): ~22 blocks/s climb, ~4 down
with the descend group, 38.3 forward (the Nimbus, CMVT fast, 2026-09-29;
an earlier "~5 forward" was read off a ramped touch stick).

## 11. Known limits

- **Pace √2 is host-proved only.** # TODO: ride 10303 and 10261 on the
  Pixel at √2 and record the verdict here and in `TASKS-BEDROCK-ADDON.md`.
- **Not Froude-similar above 100 %** (§8): `MAX_SPEED`, `DRAG`, `ROLLING`,
  the chain, brake, dwell and hoist are world-absolute. # TODO: decide on
  device whether the ceiling may grow with sqrt(size) (teleport smoothness
  above ~1.4 blocks a tick is unproven), and scale `DRAG` by 1/size.
- **The car is a point mass.** No wheel inertia, no normal or lateral force:
  a car cannot derail or valley, which is why the inversion floor exists.
- **Preview state handling remains separate** (§4.2): the numeric speed step
  shares `rideSubstep`, while substep bounds, station brake and lift hand-off
  are preview-owned. Sharing the core does not prove all route transitions match.
- **Pinball gravity ignores the table's tilt** and the wand size: every
  table plays at 1,100 LDU/s². # TODO: derive it from `tiltDeg` (5/7 g sin θ
  × a fixed time scale) if a second table needs a different feel.
- **Figures walk at speed × size below 100 %**, not × sqrt(size). The
  headless simulator uses `tickBody`, rather than the retired constant-drop
  stand-in; client interpolation and native movement still need device checks.
- **Vehicle speeds are fixed numbers**, not derived from the model; they do
  not change with the wand size (the footprint and probes do: the runtime
  reads the entity's `minecraft:scale`). The swept footprint is a
  rectangle (length × width) swept at ≤ 0.9-block height intervals,
  not the model's silhouette: a car's corner is square, a wing's sweep is
  its span. Other ENTITIES are not collided with (another car, a figure);
  only blocks, the shell's collider blocks by their sixteenths included.
  (Touching another MOUNTABLE is a hop, §4.8: the player changes mount; the
  vehicles still pass through each other.)
- **The hop is offline-proved only** (§4.8): the seat order `addRider`
  gives, an `addRider` just after an `ejectRider`, what `getAABB` reports and
  whether a coaster's camera takes over cleanly mid-run are assumed (quirks
  `rider-seat-order`, `add-rider-after-eject`, `aabb-is-collision-box`).
  # TODO(hop): fly the Nimbus into 10261's moving train on a phone and read
  the seat, the camera and the cloud left hovering.
- **Milano chase free look has native evidence** (§4.6): Saga's
  `output/device-zero-plane-20261005/ContentLog-milano-controls.txt` and
  `craftmatic-milano-controls.mp4` in the fidelity worktree show a lock-181
  seat accepting horizontal drag, holding the offset at rest and easing back
  while moving. Vehicle yaw stays 150.8 degrees during the clean stationary
  drag. This does not establish pitch drag, rider-yaw lag under turning,
  other vehicle classes (quirk `rider-free-look`). Saga 30j measured the
  chase drag on 42172, 7140, the 10797 car and 60221, and that `setRotation`
  does nothing to a lock-181 rider; the cockpit camera that replaced it, the
  native mounts' lock-181 seats and pitch drag are not yet ridden.
  # TODO(free-look): ride the cockpit camera (lag 1.5 is the coaster's
  measurement, not a car's) and the Nimbus drag.
- **Never stuck is block-only and has a ceiling.** `resolveMove` steps round
  a one-sided obstacle, slides along an axis and climbs `RISE_MAX` +
  `STEP_UP` (a car: 2.15 blocks); a pit deeper than that, a wall higher, or a
  slot narrower than the vehicle still holds a car (it pivots and reverses
  out). The collider kit's trimmed forms (`craftmatic:collider_*`) read as
  full blocks here (only the base collider's `lo`/`hi` are read), so a
  thinned wall is a full one to a vehicle. Boats only deflect and slide (no
  climb; they beach). # TODO(colliders): read every form's boxes (the kit's
  `formBoxes`) in `spanOf`. A car never climbs a kerb it meets OFF square:
  its deflect and slide come before its climb, so it runs along the kerb
  (the course's `oblique` lane measures it, 62 blocks across in 10 s); only
  a square-on kerb is climbed. Device-passed as is (Saga 30j kerb, wall,
  slide-along), so left: # TODO(car-oblique-kerb).
- **Footprint sampling is not exact volume collision.** Vertical spacing now
  covers full-block crowns at every height (October 5 audit reproduced the
  old Milano's 28 clipped ticks and X-wing's 3), but sub-block slabs can still
  fit between samples, very large perimeters spread the capped horizontal
  probes, and a vertical move does not sample the footprint's entire interior.
  The full-height leading face is the price of the crown coverage: a level
  Milano cruise is 770 probes a tick (280 with the old four levels), near the
  890 a 36-block barge spent in 20-24 ms on the Pixel.
  # TODO(footprint-cost): measure tall/scaled ships' ms per tick on the phone
  (CMVT `msPerTick`); block lookups are cached per tick.
- **Headlights are one light block** ahead of the nose, placed and removed
  as the vehicle crosses cells: the light is a sphere around that cell, not
  a beam, and a solid cell ahead keeps the previous one.

## 12. Module inventory

The modules whose physics is inventoried export by export. A new export in
one of these files fails the check until its row is written.

<!-- physics-spec:exports web/src/engine/bedrock-vehicle.ts -->
| Export | Kind | Role |
|---|---|---|
| `VehicleMotion` | type | `car` / `boat` / `plane` (fixed wing) / `rotor` / `hover` / `flyer` (a canon mount: the rotor's controller dressed as a cloud, §4.6). |
| `FLYER_BOB` | const | The flyer's client-side idle bob: amplitude in geometry units and the sine's rate (§9). |
| `HOVER_WORDS` | const | Titles that float: a sail barge, a (land)speeder, a hovercraft, a podracer. |
| `vehicleMotionOf` | function | A playable kind and its title → its motion class (a hover craft or a rotorcraft by its title). |
| `VEHICLE_BODY_MOTION` | const | Lean, squat and steer gains of the Molang drive animation, per motion class. |
| `vehicleClientAnimation` | function | The drive animation (wheel spin, steer, body lean) and its client-entity script lines (§4.6). |
| `FLIGHT` | const | Every ship constant (§9: spaceship controls for every scripted aircraft); JSON-serialised into `config.flight`. |
| `FlightParams` | type | `FLIGHT` as numbers. |
| `FlightState`, `FlightInput`, `FlightTerrain` | interface | The ship's state (with its Jump latch), the rider's input (with the view's pitch) and the probed ground. |
| `FlightEvent` | type | `takeoff` / `landing`. |
| `flightStep` | function | SERIALISED. One ship step (thrust forward and back, turn at rest, straight up and down, hover, settle and park). |
| `CAR` | const | Every car constant (§9); JSON-serialised into `config.car`. |
| `CarParams` | type | `CAR` as numbers. |
| `CarState`, `CarTerrain` | interface | The car's state and the probed ground (centre, nose, tail, water). |
| `CarEvent` | type | `boost` / `landed` (a wall is the runtime's `blocked`). |
| `carStep` | function | SERIALISED. One car step (throttle, brake, reverse, steering and the pivot at rest, boost, steps, falls). |
| `BOAT` | const | Every boat constant (§9); JSON-serialised into `config.boat`. |
| `BoatParams` | type | `BOAT` as numbers (a per-type `draft` in the config overrides `DRAFT`). |
| `BoatState`, `BoatWater` | interface | The boat's state and the probed water and shore. |
| `BoatEvent` | type | `beached` / `boost` / `launched`. |
| `boatStep` | function | SERIALISED. One boat step (throttle, rudder, boost, draft, beaching). |
| `HOVER` | const | Every hover-craft constant (§9): the car's keys plus `RIDE_HEIGHT`; JSON-serialised into `config.hover`, run by `carStep`. |
| `HoverParams` | type | `HOVER` as numbers. |
| `FOOTPRINT` | const | The swept-footprint test's constants (§9); `config.footprint`. |
| `FootprintParams` | type | `FOOTPRINT` as numbers. |
| `FootprintPose`, `VehicleFootprint` | interface | A pose (position, yaw, pitch) and a footprint (half length, half width, the clear band). |
| `sweepFootprint` | function | SERIALISED. Sweeps the footprint from one pose to the next; the first probe that ENTERS a solid blocks. |
| `MOVE` | const | The collision response's constants (§9); `config.move`. |
| `MoveParams` | type | `MOVE` as numbers. |
| `MoveResolution` | type | `clear` / `climb` / `deflect` / `slide` / `rise` / `blocked`. |
| `resolveMove` | function | SERIALISED. A blocked move tried again as a climb, a sidestep round a one-sided obstacle, a slide along an axis, a rise; else blocked, keeping a clear turn and vertical move (§4.6 "Never stuck"). |
| `HEADLIGHTS` | const | The headlight's constants (§9); `config.headlights`. |
| `HeadlightParams` | type | `HEADLIGHTS` as numbers. |
| `isNightTime`, `headlightCell` | function | SERIALISED. Night by the time of day; the cell ahead of the nose the light stands in. |
| `FLIGHT_PROPS` | const | Actor property names the runtime writes and the animation reads. |
| `flightProperties` | function | Their float declarations for the entity. |
| `FLIGHT_INPUT_EVENT`, `VEHICLE_TELEMETRY_EVENT` | const | Scriptevent ids: the test/tuning input hook (scripted vehicles AND driven trains), telemetry on/off (not physics). |
| `VEHICLE_DYNAMIC` | const | Dynamic property names another runtime sets on a scripted vehicle (top speed, HUD line, the hop's hold, the view's pitch) and the headlight's saved cell. |
| `ScriptedVehicleType` | interface | One type as the runtime sees it: mode, half length, half width, height, draft, per-type car overrides. |
| `ScriptedVehicleConfig` | interface | The JSON the runtime reads. |
| `scriptedVehicleRuntime` | function | SERIALISED. Per tick: input, probes (solid spans: collider sixteenths, slabs), step, swept footprint, headlight, teleport, properties, HUD. |
| `scriptedVehicleScript` | function | Serialises the runtime, the three steppers and the helpers into `BP/scripts/vehicles.js` (§5). |
<!-- /physics-spec:exports -->

<!-- physics-spec:exports web/src/engine/vehicle-free-look.ts -->
| Export | Kind | Role |
|---|---|---|
| `FREE_LOOK` | const | Every free-look number (§9); the camera runtime's `config.freeLook`. |
| `FreeLookParams` | type | `FREE_LOOK` as numbers. |
| `FreeLookState`, `FreeLookInput` | interface | A rider's view offsets (yaw, pitch) and idle count; one tick's reading (the rider's look, the vehicle's yaw and speed). |
| `freeLookStart` | function | SERIALISED. A centred, idle view. |
| `freeLookStep` | function | SERIALISED. One tick: a drag (net of the vehicle's own turn, carried or not) moves the view; a second after the last drag, while moving, it eases back behind the nose (§4.6 "Free look"). |
| `CockpitPose` | interface | One tick of the vehicle as the cockpit camera reads it: position, yaw, nose pitch (+ down). |
| `cockpitCamera` | function | SERIALISED. The cockpit view's free camera: at the driver's eye (seat frame, scaled by the size) on the vehicle's pose `COCKPIT_TICK_LAG` ticks back, looking along heading and nose turned by the free-look offsets, pitch inside `COCKPIT_PITCH_MAX`. |
<!-- /physics-spec:exports -->

<!-- physics-spec:exports web/src/engine/lego-scale.ts -->
| Export | Kind | Role |
|---|---|---|
| `LDU_PER_MINIFIG`, `PLAYER_HEIGHT_BLOCKS`, `LDU_PER_BLOCK`, `BEDROCK_UNITS_PER_LDU`, `SEATED_EYE_HEIGHT_BLOCKS` | const | The one LEGO ↔ Minecraft scale (§2, §9). |
<!-- /physics-spec:exports -->

<!-- physics-spec:exports web/src/engine/bedrock-coaster.ts -->
| Export | Kind | Role |
|---|---|---|
| `COASTER_RIDE_PACE`, `COASTER_PHYSICS` | const | The ride's time scale and every physics constant; `COASTER_PHYSICS` is JSON-serialised into `config.physics` (§4.1, §9). |
| `CoasterPhysics` | type | Type of `COASTER_PHYSICS`. |
| `COASTER_RIDER_VIEW` | const | Rider camera defaults (§4.1). |
| `CoasterRiderViewMode` | type | `roll` / `rollover` / `clamp` / `over` / `off`. |
| `CoasterRiderViewConfig` | interface | Camera constants the runtime reads from `config.camera`. |
| `coasterRiderView` | function | SERIALISED. The rider's camera for a tick from the car's nose/up and the look offset. |
| `CoasterRiderView` | interface | Its result. |
| `coasterRiderLook` | function | SERIALISED. The rider's clamped head turn relative to the car. |
| `CoasterRiderLook` | interface | Its result. |
| `coasterCarAttitude` | function | SERIALISED. Nose + up → entity yaw and the pitch/roll bones; yaw from the axle, never swivels. |
| `CoasterCarAttitude` | interface | Its result. |
| `coasterTrackUps` | function | Config time: per-sample physical up (gravity's where upright, the loop normal through a loop, bounded twist). |
| `TRACK_TWIST_RATE_DEG_PER_BLOCK` | const | Twist bound of `coasterTrackUps`. |
| `coasterLoopRadius` | function | Median radius over inverted samples; feeds the inversion floor. |
| `coasterMaxSpacing` | function | Largest sample spacing: the substep bound. |
| `findCoasterStation` | function | The measured platform (flat, low) and its stop arc. |
| `CoasterStation` | interface | Station span and stop. |
| `COASTER_CAR_LENGTH`, `COASTER_CART_WHEELBASE` | const | The fabricated cart's length and wheelbase. |
| `minimumCoupledChord` | function | Tightest coupled-car chord on a path (overlap diagnostics). |
| `resolveCoasterCars` | function | Clamps a train to what fits the route. |
| `COASTER_TRAINS`, `COASTER_HOLD_GAP`, `COASTER_DISPATCH_FRACTION` | const | Two-train dispatch. |
| `COASTER_MAX_CARS` | const | Most cars per route. |
| `CoasterRouteCar`, `CoasterRouteChainLift`, `CoasterRoutePlatformLift`, `CoasterRoute`, `CoasterCarSlot`, `CoasterDispatch`, `CoasterRuntimeLift`, `CoasterRuntimeRoute`, `CoasterRuntimeType`, `CoasterRuntimeConfig` | interface | Pipeline → pack contract: the route as measured and the JSON the runtime reads. |
| `CoasterRouteLift` | type | Chain or platform lift. |
| `coasterRuntimeConfig` | function | Builds `CoasterRuntimeConfig` (physics, camera, routes) for the pack. |
| `coasterScript` | function | Serialises the runtime and its pure helpers into `BP/scripts/coaster.js` (§5). |
| `COASTER_FAMILY`, `RIDE_INTERACT_TEXT`, `RAIL_INTERACT_TEXT` | const | Entity family and the coaster / railway boarding prompts (not physics). |
| `rideSubstep` | function | SERIALISED. The one rail speed step: the coaster's integrator body without `DRIVER`, the driven train with it (§4.1a). |
| `RideSubstepInput` | interface | Its per-substep input: chain here, inversion floor, the driver's stick, whether anyone drives. |
| `RAIL_TRAIN_PHYSICS` | const | A driven train's constants, per route in `CoasterRuntimeRoute.physics` (§4.1a, §9). |
| `RidePhysics` | type | `COASTER_PHYSICS` widened to numbers, plus the optional `DRIVER`. |
| `RideDriverPhysics` | interface | `TRACTION`, `BRAKE`, `PARK_BRAKE`. |
| `projectArcOnPolyline` | function | Nearest arc on a polyline (geometry helper). |
| `canonicalCoasterCar` | function | A set's car in its canonical frame, with its seats and riders (not physics). |
| `CoasterVehicleType`, `CoasterVehiclePlan` | interface | One entity type per car body (not physics). |
| `planCoasterVehicles` | function | Plans those types (not physics). |
| `coasterCartAssets`, `buildCoasterRideAssets`, `coasterDiagnostics` | function | Pack assets and diagnostics (not physics). |
| `CoasterClientAnimations`, `CoasterCompiledEntity`, `CoasterRideDeps`, `CoasterRideAssets` | interface | Their types (not physics). |
| `COUNTERWEIGHT_LATERAL_MAX_LDU`, `PARKED_SIDING_FACTOR` | const | Detector thresholds for the lift counterweight and parked sidings (not physics). |
| `CoasterSceneRoutes` | interface | Routes from the detector. |
| `coasterCarWheelbaseLdu` | function | A car's wheelbase from its wheel parts: the chord the attitude uses. |
| `sceneGridVector` | function | LDraw vector → grid blocks (Y down → Y up). |
| `coasterRoutesFromAssemblies` | function | Detector output → routes (not physics). |
<!-- /physics-spec:exports -->

<!-- physics-spec:exports web/src/engine/coaster-path.ts -->
| Export | Kind | Role |
|---|---|---|
| `sampleCoasterPath` | function | SERIALISED. Position, tangent and segment at a signed arc. |
| `buildCoasterPath`, `buildCoasterFrames` | function | Polyline with cumulative arcs; parallel-transported frames. |
| `createCoasterRoute`, `normalizeCoasterDistance`, `sampleCoasterRoute`, `advanceCoasterRoute` | function | Route wrapper: wrap-around, sampling and advancing along it. |
| `stitchCoasterTrackFragments` | function | Joins mould-profile fragments into routes (track data). |
| `CoasterVec3`, `CoasterRouteKind` | type | Types. |
| `CoasterRouteInput`, `CoasterRouteSegment`, `CoasterRoute`, `CoasterPath`, `CoasterRouteSample`, `CoasterRouteAdvance`, `CoasterTrackFragment`, `CoasterTrackEndpoint`, `CoasterTrackConnection`, `CoasterTrackGraph`, `CoasterTrackStitchOptions` | interface | Types. |
<!-- /physics-spec:exports -->

<!-- physics-spec:exports web/src/engine/coaster-preview.ts -->
| Export | Kind | Role |
|---|---|---|
| `stepCoasterPreviewTick` | function | One tick of train 0 for the walk preview, sharing `rideSubstep` with preview-owned route/state handling (§4.2). |
| `initCoasterPreviewState` | function | Initial preview state at the station. |
| `coasterCarEyePoint` | function | The rider's eye for the preview's board camera. |
| `CoasterPreviewRouteInput`, `CoasterPreviewCarType`, `CoasterPreviewCarFrame`, `CoasterPreviewState`, `StepCoasterPreviewResult` | interface | Types. |
| `CoasterLiftPhase` | type | `track` / `lifting` / `delivered`. |
<!-- /physics-spec:exports -->

<!-- physics-spec:exports web/src/engine/pinball-physics.ts -->
| Export | Kind | Role |
|---|---|---|
| `createPinballSim` | function | SERIALISED. The whole pinball physics (§4.3). |
| `PinballSimTable`, `PinballSimOptions`, `PinballInput`, `PinballEvent`, `PinballState`, `PinballSim` | interface | Its table, options (every constant), input, events and state. |
| `PinballPhase` | type | `ready` / `play` / `over`. |
<!-- /physics-spec:exports -->

<!-- physics-spec:exports web/src/engine/pinball-table.ts -->
| Export | Kind | Role |
|---|---|---|
| `detectPinballTable` | function | Measures the playfield plane and tilt, flippers, bumpers, SDF and plunger lane from the parts. |
| `pinballSimTable` | function | Table → plain-JSON `PinballSimTable`. |
| `PinballFlipper`, `PinballButton`, `PinballBumper`, `PinballTable`, `PinballDetectOptions` | interface | Types. |
<!-- /physics-spec:exports -->

<!-- physics-spec:exports web/src/engine/bedrock-pinball.ts -->
| Export | Kind | Role |
|---|---|---|
| `pinballScript` | function | Serialises `pinballRuntime`, `createPinballSim`, `fitPinballZone` (§5). |
| `pinballRuntimeConfig` | function | The runtime's JSON config (sim table, plane map, zones, camera). |
| `PinballRuntimeConfig` | interface | Its type. |
| `planPinball`, `planPinballZones`, `fitPinballZone` | function | Where the table, its tap zones and pick boxes go (fit is SERIALISED). |
| `PinballMap`, `PinballFlipperPlan`, `PinballButtonPlan`, `PinballPlungerPlan`, `PinballZoneSpec`, `PinballZonePlan`, `PinballPlan` | interface | Plane map (LDU table plane → model blocks) and plan types. |
| `PINBALL_TAP_REACH`, `PLUNGER_DEPTH`, `PICK_PITCHES` | const | Zone reach (blocks), the plunger target's depth (fraction of the reach; farther than the buttons', so a button wins where the two meet on screen) and pick pitches (degrees). |
| `rotationBetween`, `flipperRig`, `moveRig` | function | Bone rigs that swing flippers about the tilted normal and move the ball/plunger. |
| `PINBALL_AXIS_SIGNS` | const | Model X/Z signs in a bone translation. |
| `PINBALL_BUTTON_TRAVEL` | const | How far a cabinet button is DRAWN pressed, × its measured stroke (a picture scale, not physics). |
| `PROP_FLIP`, `PROP_PULL`, `PROP_PRESS`, `PROP_BALL_U`, `PROP_BALL_W`, `PROP_BALL_VU`, `PROP_BALL_VW`, `PROP_BALL_SEQ`, `PROP_SX`, `PROP_SZ` | const | Actor properties the client animates from (ball position/velocity for extrapolation). |
| `BALL_INITIALIZE`, `BALL_PRE_ANIMATION` | const | The ball's client-side extrapolation clock (Molang). |
| `pinballPropBehavior`, `flipperProperties`, `flipperAnimation`, `ballProperties`, `plungerProperties`, `pressProperties`, `ballAnimation`, `plungerAnimation`, `buttonPressAnimation`, `pressFlashOverlay`, `consoleHideAnimationId`, `consoleHideAnimation`, `consoleAssets`, `pinballZoneTexture`, `zoneAssets` | function | Entity and animation assets (not physics). |
| `PINBALL_FAMILY`, `PINBALL_INTERACT_TEXT`, `PINBALL_BUTTON_FAMILY`, `PINBALL_ZONE_TEXTURE`, `PINBALL_KEY` | const | Names (not physics). |
<!-- /physics-spec:exports -->

<!-- physics-spec:exports web/src/engine/addon-walk.ts -->
| Export | Kind | Role |
|---|---|---|
| `TICKS_PER_SECOND`, `GRAVITY`, `VERTICAL_DRAG`, `JUMP_VELOCITY`, `TERMINAL_VELOCITY`, `WALK_SPEED`, `SPRINT_FACTOR`, `SNEAK_FACTOR`, `GROUND_FRICTION`, `AIR_FRICTION`, `AIR_ACCELERATION`, `STEP_HEIGHT`, `JUMP_PEAK`, `PLAYER_WIDTH`, `PLAYER_HEIGHT`, `NO_INPUT`, `playerBox` | re-export | The simulator's player physics (`web/src/sim/physics/body.ts`, §3, §9); `PlayerState`, `WalkInput` and `Box` are re-exported as types. |
| `tickPlayer` | function | One tick of the player over this module's `SolidBox`es: the simulator's `tickPlayer`, typed so a contact carries its collider `block`. |
| `spawnState` | function | Initial state. |
| `Contact`, `TickResult` | type | The simulator's `Contact` / `TickResult` over `SolidBox`. |
| `SolidBox`, `EntitySolid` | interface | Types. |
| `WalkWorld` | class | The shipped collider blocks at a size and turn, plus ground and treads. |
| `buildWalkWorld` | function | Builds it. |
| `WalkWorldOptions` | interface | Its options. |
| `TreadSource` | type | Where treads come from. |
| `modelPointToWorld`, `worldPointToModel` | function | Model blocks at 100 % ↔ walk world at size and turn. |
| `ModelPoint`, `WorldPoint` | interface | Types. |
| `simulateEdge`, `edgeMacros`, `simulateReach`, `compareReach`, `classifyDivergence`, `structuralReason`, `highestReachable`, `reachPoint`, `plannedTargets`, `routeAsModelPoints` | function | Reach parity: the continuous player against the reach BFS. |
| `Macro`, `DivergenceClass`, `TargetRefusal` | type | Types. |
| `MacroSpec`, `EdgeResult`, `SimulatedReach`, `SimulateReachOptions`, `Divergence`, `ReachComparison`, `PointReach` | interface | Types. |
<!-- /physics-spec:exports -->

<!-- physics-spec:exports web/src/sim/physics/body.ts -->
| Export | Kind | Role |
|---|---|---|
| `TICKS_PER_SECOND`, `GRAVITY`, `VERTICAL_DRAG`, `JUMP_VELOCITY`, `TERMINAL_VELOCITY`, `WALK_SPEED`, `SPRINT_FACTOR`, `SNEAK_FACTOR`, `GROUND_FRICTION`, `AIR_FRICTION`, `AIR_ACCELERATION`, `STEP_HEIGHT`, `JUMP_PEAK`, `SLOW_FALL_GRAVITY` | const | Minecraft's per-tick motion (§3, §9): the one integrator's numbers. |
| `PLAYER_WIDTH`, `PLAYER_HEIGHT`, `PLAYER_EYE_HEIGHT`, `PLAYER_DIMS` | const | The 0.6 × 1.8 box and the 1.62 eye. |
| `SolidQuery` | interface | Where the solids come from (the walk preview's collider grid, the simulator's voxels). |
| `BodyDims`, `PlayerState`, `WalkInput`, `Contact`, `TickResult`, `MoveResult` | interface | Types. |
| `NO_INPUT` | const | Idle input. |
| `playerBox` | function | A body's box on its feet. |
| `moveBox` | function | The per-axis sweep with the auto-step (and the sneak guard). |
| `tickPlayer` | function | One tick of the player: input, gravity (slow falling's when on), friction, step, collision. |
| `tickBody` | function | One tick of a mob moved by velocity alone (a figure's impulses). |
<!-- /physics-spec:exports -->

<!-- physics-spec:exports web/src/sim/physics/systems.ts -->
| Export | Kind | Role |
|---|---|---|
| `installPhysics` | function | The simulator's motion systems: players (walk, sneak-dismount, the device's push out of blocks - sideways 0.1/tick, never up, quirk `teleport-into-floor`), native hover mounts at the measured speeds, mobs under `minecraft:physics`, riders to their seats, effects; falls tracked for the invariants. |
| `setDownRider` | function | Where a PLAYER that left a seat stands (sneak, `ejectRider`): the first free floor one block from the seat entity in the device's order, else the seat point 0.2 up (quirk `dismount-free-spot`, Pixel GameTest 2026-09-30). |
| `DISMOUNT_OFFSETS` | const | That order, (dx, dz) blocks: (0,-1), (0,+1), (+1,-1), (+1,+1), (-1,+1) measured; (-1,-1), (+1,0), (-1,0) placed by guess (`TODO(dismount-order)`). |
| `DISMOUNT_FLOOR_ABOVE`, `DISMOUNT_FLOOR_BELOW` | const | The floor window about the seat entity's point, blocks (0.5, 1): +0.2 and -0.3 were taken on the device, +0.7 and -1.3 refused (`TODO(dismount-floor)`). |
| `DISMOUNT_FALLBACK_LIFT` | const | Walled in on all eight sides, the rider is put at the seat entity's point this far up (0.2, measured) and falls. |
| `isHoverMount` | function | A native hover mount: `free_camera_controlled` plus hover movement or `can_fly`. |
<!-- /physics-spec:exports -->

<!-- physics-spec:exports web/src/engine/bedrock-figure-life.ts -->
| Export | Kind | Role |
|---|---|---|
| `FIGURE_TUNING` | const | Every figure-life number (§4.5, §9). |
| `FigureTuning` | interface | Its type, with units per field. |
| `figureLifeRuntime` | function | SERIALISED. The per-tick state machine; walks by velocity. |
| `figureLifeScript` | function | Serialises it and the planner into `BP/scripts/figures.js`. |
| `standFeetAt`, `exploreWalkable`, `startCell`, `refugeCell`, `pathTo`, `blockSpan` | function | SERIALISED planner over real collider spans. |
| `resolveFigureSpawn`, `spawnLift` | function | Host only, at export: where a figure spawns (on the surface below a line-up figure, beside a collider column it stood in), and the placement runtime's spawn lift it replaces. |
| `ROOM_PROBE_CELLS` | const | Cells explored to rate a spawn spot's room (64). |
| `separateFigureSpawns` | function | Host only, at export: a standing figure a source recorded within `FIGURE_MIN_SEPARATION` of another is moved to the nearest standable column clear of every figure (76435's figures 1 and 8). |
| `FIGURE_MIN_SEPARATION` | const | 0.6 blocks: a figure's box width; closer than this two standing figures share a body. |
| `FigurePlanner`, `FigureLifeConfig`, `FigureHome`, `WalkCell`, `FigureSpawn` | interface | Types. `FigureLifeConfig.seatSafety` carries the shared measured ride set-down limits into scenery-seat-only packs too, with the escape bounds and `SEAT_EGRESS` (filled by `figureLifeScript` where a config lacks them). |
| `SEAT_EGRESS` | const | The scenery-seat watcher's own bounds (§4.8, §9): the native set-down's reach and the re-seat limit under a held Sneak. |
| `SpanLookup` | type | Collision-span lookup. |
| `FIGURE_HOME_PROPERTY` | const | Dynamic property holding a figure's home. |
| `FIGURE_SEATING_PROPERTY` | const | Dynamic property (`Date.now()` ms) the placement sets on a source-seated figure until its own seating pass is done with it; the runtime neither retakes nor reports a missing seat meanwhile (10261 spawns its kiosk figure ~2 min before the seat, Saga 2026-09-29c). |
| `FIGURE_SEATING_GRACE_MS` | const | 10 minutes: a seating mark older than this (a placement stopped by a reload) no longer holds the retake off. |
<!-- /physics-spec:exports -->

<!-- physics-spec:exports web/src/engine/bedrock-rides.ts -->
| Export | Kind | Role |
|---|---|---|
| `RIDE` | const | Every ride number: detection thresholds (LDU), the speeds, and the orbit's re-seat, adoption and yaw chord (§4.7, §9). |
| `RideKind`, `SceneRide`, `RideRuntimeConfig` | type, interface | A ride's kind (`slide`, `lift`, `orbit`), its measured path / car / stops, and the runtime's config (an orbit's own seat and rider types). |
| `isSlideDescription`, `isLiftGuideDescription`, `isLiftCarDescription`, `isLiftColumnDescription` | function | Library-description tests for a slide mould, a lift guide, an elevator platform (the car) and a part of the column it runs in (a guide or a grooved frame). |
| `slidePathLdu`, `findSlides` | function | Host only: a slide's running line from its top surface's BED (rim cells dropped). |
| `findLifts` | function | Host only: an elevator platform in its column of frames/guides, the stand point on it and a stop per room floor it can reach, with a step-off point on each floor. |
| `ridesScript` | function | SERIALISED. `BP/scripts/rides.js`: the per-tick runtime (`ridesRuntime`) that carries a seated player along a slide or lift, and a figure round an orbit, with its collider body probe. Its tests run this text on the headless simulator. |
<!-- /physics-spec:exports -->

<!-- physics-spec:exports web/src/engine/bedrock-flyer.ts -->
| Export | Kind | Role |
|---|---|---|
| `FLYER` | const | Every flyer-mount number: the detector's thresholds, the orbit's shape, the summoned clouds' fade, cap and cooldown, the flying speed, the dive pitch, the ride hint, the dismount float (§4.6, §4.7, §9). |
| `SceneMount`, `MountSearch` | interface | A found mount (its figure, bricks, box and top) and a search's result (found and missing with reasons). |
| `modelBoxLdu` | function | Host only: the world AABB of what stays, the orbit's ring. |
| `findMounts` | function | Host only: the connected cluster under a figure's feet in the canon style's colours, translucent parts never joining. |
| `orbitPathLdu` | function | Host only: the companion's closed lap (§4.7). |
| `FlyerRuntimeMount`, `FlyerRuntimeConfig` | interface | One summonable mount (its cloud type and the types a tap on which summons it) and the runtime's config. |
| `flyerScript` | function | SERIALISED. `BP/scripts/flyer.js`: the runtime (`flyerRuntime`) that summons a cloud on a tap, fades empty ones and floats down a rider who leaves one in the air. Its tests run this text on the headless simulator. |
<!-- /physics-spec:exports -->

<!-- physics-spec:exports web/src/engine/bedrock-ride-hop.ts -->
| Export | Kind | Role |
|---|---|---|
| `HOP` | const | Every hop number: the reach, the lead and its sampling, the closing speed, the grace and the back-hop cooldown, the scan, set-down and train reaches (§4.8, §9). |
| `HOP_TAGS` | const | The claim tag on a player (tick and the mount left) and a train car's train and rank tags. |
| `HopParams`, `HopVacate` | type | The constants' type; how a vehicle waits once left (`hover`, `stop`, `native`). |
| `HopSource`, `HopPose`, `HopBox`, `HopShape` | interface | A driveable's footprint and vacate rule; a pose; a world box (centre, half extents); the contact test's view of the ridden vehicle and its rider. |
| `hopContact` | function | SERIALISED. The swept relative contact test in the vehicle's frame. |
| `HopKitConfig`, `HopKit`, `HopRuntimeConfig` | interface | The kit's config (namespaces, tags, constants), the kit's API, `hop.js`'s CONFIG (this pack's sources, the hold property, the sound). |
| `hopKit` | function | SERIALISED into `hop.js` and `rides.js`: mountable targets, a train's front-most free car, the claim, the boarding. |
| `hopKitConfig`, `hopRuntimeConfig`, `hopScript` | function | The configs for a pack, and the serialisation into `BP/scripts/hop.js`: the per-tick runtime (`hopRuntime`, SERIALISED) that hops a player off this pack's driveables. Its tests run this text on the headless simulator. |
<!-- /physics-spec:exports -->

<!-- physics-spec:exports web/src/sim/adapters/craftmatic/figure-life.ts -->
| Export | Kind | Role |
|---|---|---|
| `simulateFigureLife` | function | Runs the SERIALISED figure runtime on the headless simulator over a pack's collider cells (the simulator's physics: `tickBody`). |
| `SimFigure`, `SimSeat`, `SimWorld`, `SimSample` | interface | Types. |
<!-- /physics-spec:exports -->

Files that run or host physics whose exports are not inventoried; their
physics numbers are in the constants table.

<!-- physics-spec:consumers -->
| File | What it does |
|---|---|
| `web/src/engine/playable-addon.ts` | Vehicle entity components (the vehicles' whole physics) and the serialised driver/camera runtimes (§4.6). |
| `web/src/engine/addon-scale.ts` | Export model scale (1× / 2× / fitted vehicles) and the player's step/jump/width for reach planning. |
| `web/src/engine/bedrock-collider-scale.ts` | The collider grid at another wand size and the reach BFS the walker is compared against. |
| `web/src/engine/interactive-walk.ts` | Doorway passability with the walker's `tickPlayer`. |
| `web/src/engine/gametest-pack.ts` | On-device GameTests (figures, pinball, doors): the device truth for the host models. |
| `web/src/ui/addon-preview.ts` | The walk preview: runs `stepCoasterPreviewTick`, `createPinballSim`, `tickPlayer`, the rider view. |
<!-- /physics-spec:consumers -->

Physics-named files that are not physics:

<!-- physics-spec:not-physics -->
| File | Why not |
|---|---|
| `web/src/engine/coaster-track.ts` | Extracts track centrelines from the parts (geometry). |
| `web/src/engine/coaster-assemblies.ts` | Detects cars, lifts, counterweights and chain drives (geometry). |
| `web/src/engine/playable-components.ts` | Classifies bricks into vehicle components. |
| `web/src/engine/scene-vehicles.ts` | Finds the vehicles standing in a scene (geometry: clusters, wheels, oars). |
| `web/src/engine/vehicle-facing.ts` | Infers which end of a vehicle is its nose. |
<!-- /physics-spec:not-physics -->
