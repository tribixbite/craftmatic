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
| Coaster preview | the same `COASTER_PHYSICS` object | the same | Same constants; formulas mirrored, not shared (§6). |
| Pinball | 1,100 LDU/s² down the table plane | LDU in the table plane, seconds | A ball rolling on the real 8.6° playfield accelerates 2,630 LDU/s² (5/7 g sin θ; 3,680 if it slid). 1,100 is that slowed to 0.65 of real time. A game constant, not the world's gravity: it does not read the tilt and does not change with wand size. |
| Walk-preview player | 0.08 blocks/tick² with 0.98 drag | world blocks, ticks | Minecraft's own player numbers; the integrator reproduces the 1.2522-block jump in 12 ticks. |
| Figures | Bedrock's engine (entity `has_gravity`) | world | On device the engine applies Minecraft's own mob gravity. The host simulator only drops a figure 0.4 blocks a tick to the floor below: a stand-in, not gravity. |
| Vehicles | Bedrock's engine | world | Cars and boats have `has_gravity: true` (mob gravity); aircraft have none (hover). No custom physics is integrated. |

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

`tickPlayer` is Minecraft's player per tick (§3): a 0.6 × 1.8 box, gravity
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
`FIGURE_TUNING.speed` 0.06 blocks/tick (1.2 blocks/s) at 100 %, × the size
factor below 100 % (figures never grow above player size), slowed ×0.35 into
a sharp corner. `web/src/engine/figure-life-sim.ts` runs the SERIALISED
runtime on host against a stand-in world (per-axis blocking, 0.6 auto-step,
a 0.4-block/tick drop to the floor, ground friction 0.546); it answers "do
the figures roam and stay home", not Bedrock's physics. Device truth: the
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
- **Hover craft — SCRIPTED on `carStep`** with `HOVER`: the ground it rides
  is the top of whatever is under it, solid OR water, plus `RIDE_HEIGHT`; it
  glides, floats over `STEP_UP` 1.6 and sinks slowly off an edge. A title in
  `HOVER_WORDS` (75397's "Sail Barge", a speeder) makes a vehicle a hover
  craft whatever its kind (`vehicleMotionOf`).
- **Rotorcraft — native.** The vanilla Happy Ghast: `has_gravity: false`,
  hover movement and navigation, `free_camera_controlled`, `flying_speed` 0.3,
  `vertical_movement_action` +0.5 (climb) / −0.5 (descend group).
- **Car, hover craft, fixed wing and boat — SCRIPTED** (`BP/scripts/vehicles.js` in the pack,
  `scriptedVehicleRuntime`). Every native speed is `SCRIPTED_NATIVE_SPEED` (0)
  and gravity is off; the Happy Ghast rider components stay only so Jump is an
  input, not a dismount (measured: a real rider held Jump and stayed seated).
  Each tick the runtime reads the controlling rider's `inputInfo` (or the
  `FLIGHT_INPUT_EVENT` hook), probes the blocks it needs, runs the pure
  `carStep` / `flightStep` / `boatStep`, sweeps the vehicle's footprint over
  the new pose (`sweepFootprint`, below), teleports the entity (the rider rides along, as on
  the coaster) and writes pitch, bank and wheel roll to the `FLIGHT_PROPS`
  actor properties. Constants in `FLIGHT` / `BOAT` / `CAR` / `HOVER` (§9). Why: the camel boat
  over `minecraft:buoyant` crawled at 1.6-1.8 blocks/s on water whatever its
  movement, and the hover plane had no take-off, stall or landing.
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
  perimeter at ≤ 0.9 blocks spacing and up to four heights of its clear band
  (a car: above its 1.05 step to its roof; a boat: from just above the
  waterline; an aircraft: its whole airframe aloft, above its gear on the
  ground), tilted by its pitch, at every ≤ 0.8-block substep between the old
  and the new pose. A probe blocks only when it ENTERS a solid (it was clear at
  the old pose), so a vehicle placed half in a wall drives out. A blocked move
  keeps the turn if the turn alone is clear, stops the vehicle, and is a
  `blocked` / `beached` / `crash` event (its sound once per contact).
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
- The rotorcraft's driver script (`vehicleDriverRuntime`, every 2 ticks, the
  only native mount left) only measures speed (position delta, since a
  client-driven mount reports ~0 velocity), plays effects, swaps the
  climb/descend group and logs telemetry. mph = blocks/tick × 20 × 2.236936
  (1 block = 1 m).
- The wand's size changes `minecraft:scale`, the collision box and the seats
  (`bedrock-placement-pack.ts`); the speeds are the same at every size, the
  footprint and probes scale with it.

Tests: `test/bedrock-vehicle.test.ts` (the steppers, the footprint and
headlight helpers, the animation, and the serialised runtime on a fake world:
a trunk at a car's corner, a post at a wingtip, a collider plate floor, a
hover craft over water, headlights by night and day, the time machine's top
speed), `test/playable-addon.test.ts`, `test/playable-golden-models.test.ts`,
`test/vehicle-facing.test.ts`, `test/scene-vehicles.test.ts`, and the device
course `vehicle_<id>_<n>` (with a post off the centre line inside the
footprint, and a hover craft's run over the pool) and train test
`train_<id>_<n>` (`web/src/engine/gametest-pack.ts`, `test/gametest-pack.test.ts`).

## 5. Serialised runtimes: the rules

Each device runtime is a function turned into the pack's script text with
`Function.prototype.toString()` and evaluated with only `world` and `system`
(and the coaster's `LinearSpline`) in scope:

| Script | Built by | Functions serialised |
|---|---|---|
| `BP/scripts/coaster.js` | `coasterScript` | `coasterRuntime` (module-private), `sampleCoasterPath`, `coasterCarAttitude`, `coasterRiderView`, `coasterRiderLook` |
| pinball script | `pinballScript` | `pinballRuntime`, `createPinballSim`, `fitPinballZone` |
| `BP/scripts/figures.js` | `figureLifeScript` | `figureLifeRuntime`, `standFeetAt`, `exploreWalkable`, `pathTo`, `blockSpan`, `startCell`, `refugeCell` |
| vehicle scripts | `playable-addon.ts` | `vehicleDriverRuntime`, `vehicleCameraRuntime`, `timeMachineRuntime` |
| `BP/scripts/vehicles.js` | `scriptedVehicleScript` | `scriptedVehicleRuntime`, `carStep`, `flightStep`, `boatStep`, `sweepFootprint`, `isNightTime`, `headlightCell` |

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
5. The host tests run the SAME serialised text with `new Function('world',
   'system', script)` against fake entities — `liftHost` / `rideHost` in
   `test/bedrock-coaster.test.ts`, `simulateFigureLife`, the pinball runtime
   via `_pinballRuntimeForTests` — so rule 1 is caught offline.

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
| figure planner functions | serialised | — | `figure-life-sim.ts`, census script |
| `tickPlayer` | — (Bedrock is the player) | `addon-preview.ts` | `interactive-walk.ts`, `scripts/_addon_walk.ts` |
| `carStep`, `flightStep`, `boatStep` (`CAR`, `HOVER`, `FLIGHT`, `BOAT` via `config.car` / `config.hover` / `config.flight` / `config.boat`) | serialised | — | `test/bedrock-vehicle.test.ts` |
| `sweepFootprint` (`FOOTPRINT`), `isNightTime`, `headlightCell` (`HEADLIGHTS`) | serialised | — | `test/bedrock-vehicle.test.ts` (pure, and the runtime on a fake world) |
| `vehicleClientAnimation` | client Molang, not a script | — | `test/bedrock-vehicle.test.ts` |

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
| `SEATED_EYE_HEIGHT_BLOCKS` | `web/src/engine/lego-scale.ts` | 1.25 | blocks | A riding player's eye above the seat. |
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
| `COASTER_PHYSICS.RIDER_EYE` | `web/src/engine/bedrock-coaster.ts` | 1.25 | world blocks | Must equal `SEATED_EYE_HEIGHT_BLOCKS` (carried in config because the runtime cannot import). |
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
| `TICKS_PER_SECOND` | `web/src/engine/addon-walk.ts` | 20 | ticks/s | Minecraft's tick. |
| `GRAVITY` | `web/src/engine/addon-walk.ts` | 0.08 | blocks/tick² | Minecraft player gravity (§3). |
| `VERTICAL_DRAG` | `web/src/engine/addon-walk.ts` | 0.98 | per tick | Minecraft player vertical drag. |
| `JUMP_VELOCITY` | `web/src/engine/addon-walk.ts` | 0.42 | blocks/tick | Minecraft jump impulse. |
| `JUMP_PEAK` | `web/src/engine/addon-walk.ts` | 1.2522 | blocks | Computed by the integrator; the wiki's 1.2522. |
| `TERMINAL_VELOCITY` | `web/src/engine/addon-walk.ts` | 3.92 | blocks/tick | 0.08 × 0.98 / 0.02. |
| `WALK_SPEED` | `web/src/engine/addon-walk.ts` | 0.21585 | blocks/tick | 4.317 blocks/s. |
| `SPRINT_FACTOR` | `web/src/engine/addon-walk.ts` | 1.3 | × walk | Minecraft sprint. |
| `SNEAK_FACTOR` | `web/src/engine/addon-walk.ts` | 0.3 | × walk | Minecraft sneak. |
| `GROUND_FRICTION` | `web/src/engine/addon-walk.ts` | 0.546 | per tick | 0.6 block slipperiness × 0.91. |
| `AIR_FRICTION` | `web/src/engine/addon-walk.ts` | 0.91 | per tick | Minecraft horizontal drag in air. |
| `AIR_ACCELERATION` | `web/src/engine/addon-walk.ts` | 0.02 | blocks/tick² | In-air control. |
| `STEP_HEIGHT` | `web/src/engine/addon-walk.ts` | 0.5625 | blocks | The reach BFS's quantised 0.6 step (9/16), so walker and BFS agree by construction. |
| `STEP_HEIGHT_BLOCKS` | `web/src/engine/addon-scale.ts` | 0.6 | blocks | Minecraft auto-step. |
| `JUMP_HEIGHT_BLOCKS` | `web/src/engine/addon-scale.ts` | 1.25 | blocks | Minecraft jump, for reach planning. |
| `PLAYER_WIDTH_BLOCKS` | `web/src/engine/addon-scale.ts` | 0.6 | blocks | Player box width. |
| `MICROFIG_SCALE` | `web/src/engine/addon-scale.ts` | 2 | × | A 48-LDU microfigure stands player height. |
| `MIN_AUTO_SCALE` | `web/src/engine/addon-scale.ts` | 0.25 | × | Smallest auto shrink of a display vehicle. |
| `VEHICLE_TARGET_BLOCKS.car` | `web/src/engine/addon-scale.ts` | 4.6 | blocks (m) | A real car's length. |
| `VEHICLE_TARGET_BLOCKS.boat` | `web/src/engine/addon-scale.ts` | 9 | blocks (m) | A real boat's length. |
| `VEHICLE_TARGET_BLOCKS.plane` | `web/src/engine/addon-scale.ts` | 12 | blocks (m) | A real light aircraft's length. |
| `FIGURE_TUNING.speed` | `web/src/engine/bedrock-figure-life.ts` | 0.06 | blocks/tick | 1.2 blocks/s: a stroll, below the player's 4.3 walk. |
| `FIGURE_TUNING.turnPerTick` | `web/src/engine/bedrock-figure-life.ts` | 18 | degrees/tick | Body turn while walking. |
| `FIGURE_TUNING.maxUp` | `web/src/engine/bedrock-figure-life.ts` | 0.6 | blocks | Largest rise planned: a step, never a jump, so a figure keeps its floor. |
| `FIGURE_TUNING.maxDown` | `web/src/engine/bedrock-figure-life.ts` | 0.6 | blocks | Largest drop planned: no falls. |
| `FIGURE_TUNING.radius` | `web/src/engine/bedrock-figure-life.ts` | 7 | blocks | Stroll radius around home at 100 %. |
| `FIGURE_TUNING.band` | `web/src/engine/bedrock-figure-life.ts` | 1.2 | blocks | Height band around the home floor. |
| `FIGURE_TUNING.doorwayClearance` | `web/src/engine/bedrock-figure-life.ts` | 1.25 | blocks | Never stop this close to a door leaf. |
| sim ground friction | `web/src/engine/figure-life-sim.ts` `e.v.x *= §;` | 0.546 | per tick | Minecraft ground friction (as the walker). |
| sim drop per tick | `web/src/engine/figure-life-sim.ts` `e.location.y - §)` | 0.4 | blocks/tick | Stand-in fall to the floor below; not gravity. |
| `SCRIPTED_NATIVE_SPEED` | `web/src/engine/playable-addon.ts` | 0 | Bedrock movement / flying_speed | A scripted vehicle's native speeds: only the script moves it. |
| rotorcraft flying speed | `web/src/engine/playable-addon.ts` `'minecraft:flying_speed': { value: § }` | 0.3 | Bedrock flying_speed | Happy Ghast's, scaled: ~5 blocks/s forward measured. |
| `FLIGHT.ROTATE_SPEED` | `web/src/engine/bedrock-vehicle.ts` | 10 | blocks/s | Take-off speed; about 15 blocks of run at full power on the device (Milano GameTest). |
| `FLIGHT.STALL_SPEED` | `web/src/engine/bedrock-vehicle.ts` | 7 | blocks/s | Below it the wing sinks and the nose drops. |
| `FLIGHT.MAX_SPEED` | `web/src/engine/bedrock-vehicle.ts` | 32 | blocks/s | Airspeed ceiling. |
| `FLIGHT.THRUST` | `web/src/engine/bedrock-vehicle.ts` | 10 | blocks/s² at full throttle | With `DRAG`: 30 blocks/s at full power, 23.2 at cruise (23.2 read by a real rider on the Pixel). |
| `FLIGHT.DRAG` | `web/src/engine/bedrock-vehicle.ts` | 0.0111 | 1/block | Quadratic drag. |
| `FLIGHT.CRUISE_THROTTLE` | `web/src/engine/bedrock-vehicle.ts` | 0.6 | fraction | Engine power hands off, aloft: nobody holds Jump to stay up. |
| `FLIGHT.APPROACH_THROTTLE` | `web/src/engine/bedrock-vehicle.ts` | 0.25 | fraction | Within `APPROACH_HEIGHT` of the ground: pushing the nose down lands rather than speeds up. |
| `FLIGHT.APPROACH_HEIGHT` | `web/src/engine/bedrock-vehicle.ts` | 6 | blocks | Height under which approach power applies. |
| `FLIGHT.PITCH_RATE` | `web/src/engine/bedrock-vehicle.ts` | 45 | degrees/s | Elevator authority at full stick. |
| `FLIGHT.PITCH_MAX` | `web/src/engine/bedrock-vehicle.ts` | 40 | degrees | Steepest climb or dive. |
| `FLIGHT.TURN_RATE` | `web/src/engine/bedrock-vehicle.ts` | 55 | degrees/s | Full-stick turn at or above take-off speed (162 degrees in 3 s measured). |
| `FLIGHT.AUTO_BRAKE` | `web/src/engine/bedrock-vehicle.ts` | 5 | blocks/s² | Wheel brakes on the ground with the throttle released. |
| `FLIGHT.HARD_LANDING` | `web/src/engine/bedrock-vehicle.ts` | 8 | blocks/s down | Touch-down sink rate that counts as a hard landing (speed × 0.4). |
| `FLIGHT.STICK_X_RIGHT` | `web/src/engine/bedrock-vehicle.ts` | -1 | sign | Measured: the stick pushed RIGHT reads `getMovementVector().x` = -0.46 (Pixel, 2026-09-25). |
| `CAR.MAX_SPEED` | `web/src/engine/bedrock-vehicle.ts` | 19 | blocks/s | Full stick (42 mph), what the camel gave at movement 0.45. |
| `CAR.REVERSE_SPEED` | `web/src/engine/bedrock-vehicle.ts` | 5 | blocks/s | Full reverse. |
| `CAR.ACCEL` | `web/src/engine/bedrock-vehicle.ts` | 7 | blocks/s² | 0 to full in under 3 s. |
| `CAR.BRAKE` | `web/src/engine/bedrock-vehicle.ts` | 14 | blocks/s² | Stick against the motion. |
| `CAR.COAST` | `web/src/engine/bedrock-vehicle.ts` | 2.5 | blocks/s² | Hands off: rolls on instead of the camel's dead stop. |
| `CAR.BOOST_SPEED` | `web/src/engine/bedrock-vehicle.ts` | 26 | blocks/s | Jump boost for `BOOST_SECONDS` 1.5, then `BOOST_COOLDOWN` 3. |
| `CAR.STEER_RATE` | `web/src/engine/bedrock-vehicle.ts` | 110 | degrees/s | Full lock at `STEER_FULL_SPEED` 5 blocks/s, divided by 1 + speed / `STEER_FADE` 12: about 43 degrees/s at top speed. |
| `CAR.STEP_UP` | `web/src/engine/bedrock-vehicle.ts` | 1.05 | blocks | Highest step climbed (a full block, as the camel's 1.25 auto-step allowed); higher is a wall. |
| `CAR.CLIMB_RATE` | `web/src/engine/bedrock-vehicle.ts` | 6 | blocks/s | How fast it eases up a step. |
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
| `HOVER.GRAVITY` | `web/src/engine/bedrock-vehicle.ts` | 6 | blocks/s² | It sinks slowly off an edge. |
| `HOVER.RIDE_HEIGHT` | `web/src/engine/bedrock-vehicle.ts` | 1 | blocks | Height above the ground or the water's surface. |
| `FOOTPRINT.SPACING` | `web/src/engine/bedrock-vehicle.ts` | 0.9 | blocks | Most two perimeter probes are apart: under one block, so a one-block trunk cannot slip between them. |
| `FOOTPRINT.MAX_POINTS` | `web/src/engine/bedrock-vehicle.ts` | 128 | probes | A 36-block barge's 100-block perimeter still gets 0.9 spacing. |
| `FOOTPRINT.MAX_LEVELS` | `web/src/engine/bedrock-vehicle.ts` | 4 | heights | Heights tested between the band's `lo` and `hi`. |
| `FOOTPRINT.SWEEP_STEP` | `web/src/engine/bedrock-vehicle.ts` | 0.8 | blocks | Most a probe travels between two tested poses: a 32 blocks/s aircraft moves 1.6 a tick. |
| `FOOTPRINT.MAX_SUBSTEPS` | `web/src/engine/bedrock-vehicle.ts` | 4 | poses/tick | Bounds the cost of a fast turn. |
| `HEADLIGHTS.LEVEL` | `web/src/engine/bedrock-vehicle.ts` | 14 | light level | One `minecraft:light_block_14`: bright enough to read the road ahead at night. |
| `HEADLIGHTS.AHEAD` | `web/src/engine/bedrock-vehicle.ts` | 2 | blocks | Past the nose, along the heading. |
| `HEADLIGHTS.PARK_TICKS` | `web/src/engine/bedrock-vehicle.ts` | 100 | ticks | A light switches off after 5 s parked. |
| `HEADLIGHTS.DUSK` | `web/src/engine/bedrock-vehicle.ts` | 12500 | time of day | Minecraft sunset; night until `DAWN` 23500. |
| `TIME_MACHINE.TOP_MARGIN` | `web/src/engine/playable-addon.ts` | 1.03 | × | The time machine's top speed is 3 % past its jump speed (88 mph: 40.5 blocks/s), so a full stick reaches it. |
| `TIME_MACHINE.TELEPORT_BLOCKS` | `web/src/engine/playable-addon.ts` | 10 | blocks per 2 ticks | A longer move is a teleport, not speed: 100 blocks/s, past the 150 mph slider's 67. |
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
the add-on guide, "The rider's camera follows the track". Aircraft ~17
blocks/s climb, ~5 forward.

## 11. Known limits

- **Pace √2 is host-proved only.** # TODO: ride 10303 and 10261 on the
  Pixel at √2 and record the verdict here and in `TASKS-BEDROCK-ADDON.md`.
- **Not Froude-similar above 100 %** (§8): `MAX_SPEED`, `DRAG`, `ROLLING`,
  the chain, brake, dwell and hoist are world-absolute. # TODO: decide on
  device whether the ceiling may grow with sqrt(size) (teleport smoothness
  above ~1.4 blocks a tick is unproven), and scale `DRAG` by 1/size.
- **The car is a point mass.** No wheel inertia, no normal or lateral force:
  a car cannot derail or valley, which is why the inversion floor exists.
- **The preview mirrors the integrator** (§4.2) instead of sharing it.
- **Pinball gravity ignores the table's tilt** and the wand size: every
  table plays at 1,100 LDU/s². # TODO: derive it from `tiltDeg` (5/7 g sin θ
  × a fixed time scale) if a second table needs a different feel.
- **Figures walk at speed × size below 100 %**, not × sqrt(size); the
  host simulator's gravity is a constant 0.4-block/tick drop.
- **Vehicle speeds are fixed numbers**, not derived from the model; they do
  not change with the wand size (the footprint and probes do: the runtime
  reads the entity's `minecraft:scale`). The swept footprint is a
  rectangle (length × width) swept at up to `FOOTPRINT.MAX_LEVELS` heights,
  not the model's silhouette: a car's corner is square, a wing's sweep is
  its span. Other ENTITIES are not collided with (another car, a figure);
  only blocks, the shell's collider blocks by their sixteenths included.
- **Headlights are one light block** ahead of the nose, placed and removed
  as the vehicle crosses cells: the light is a sphere around that cell, not
  a beam, and a solid cell ahead keeps the previous one.

## 12. Module inventory

The modules whose physics is inventoried export by export. A new export in
one of these files fails the check until its row is written.

<!-- physics-spec:exports web/src/engine/bedrock-vehicle.ts -->
| Export | Kind | Role |
|---|---|---|
| `VehicleMotion` | type | `car` / `boat` / `plane` (fixed wing) / `rotor` / `hover`. |
| `HOVER_WORDS` | const | Titles that float: a sail barge, a (land)speeder, a hovercraft, a podracer. |
| `vehicleMotionOf` | function | A playable kind and its title → its motion class (a hover craft or a rotorcraft by its title). |
| `VEHICLE_BODY_MOTION` | const | Lean, squat and steer gains of the Molang drive animation, per motion class. |
| `vehicleClientAnimation` | function | The drive animation (wheel spin, steer, body lean) and its client-entity script lines (§4.6). |
| `FLIGHT` | const | Every fixed-wing constant (§9); JSON-serialised into `config.flight`. |
| `FlightParams` | type | Type of `FLIGHT`. |
| `FlightState`, `FlightInput`, `FlightTerrain` | interface | The fixed wing's state, the rider's input and the probed ground. |
| `FlightEvent` | type | `takeoff` / `landing` / `hard_landing` / `crash` / `stall`. |
| `flightStep` | function | SERIALISED. One fixed-wing step (throttle, elevator, turn, stall, landing). |
| `CAR` | const | Every car constant (§9); JSON-serialised into `config.car`. |
| `CarParams` | type | `CAR` as numbers. |
| `CarState`, `CarTerrain` | interface | The car's state and the probed ground (centre, nose, tail, walls, water). |
| `CarEvent` | type | `blocked` / `boost` / `landed`. |
| `carStep` | function | SERIALISED. One car step (throttle, brake, reverse, steering, boost, steps, walls, falls). |
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
| `HEADLIGHTS` | const | The headlight's constants (§9); `config.headlights`. |
| `HeadlightParams` | type | `HEADLIGHTS` as numbers. |
| `isNightTime`, `headlightCell` | function | SERIALISED. Night by the time of day; the cell ahead of the nose the light stands in. |
| `FLIGHT_PROPS` | const | Actor property names the runtime writes and the animation reads. |
| `flightProperties` | function | Their float declarations for the entity. |
| `FLIGHT_INPUT_EVENT`, `VEHICLE_TELEMETRY_EVENT` | const | Scriptevent ids: the test/tuning input hook (scripted vehicles AND driven trains), telemetry on/off (not physics). |
| `VEHICLE_DYNAMIC` | const | Dynamic property names another runtime sets on a scripted vehicle (top speed, HUD line) and the headlight's saved cell. |
| `ScriptedVehicleType` | interface | One type as the runtime sees it: mode, half length, half width, height, draft, per-type car overrides. |
| `ScriptedVehicleConfig` | interface | The JSON the runtime reads. |
| `scriptedVehicleRuntime` | function | SERIALISED. Per tick: input, probes (solid spans: collider sixteenths, slabs), step, swept footprint, headlight, teleport, properties, HUD. |
| `scriptedVehicleScript` | function | Serialises the runtime, the three steppers and the helpers into `BP/scripts/vehicles.js` (§5). |
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
| `stepCoasterPreviewTick` | function | One tick of train 0 for the walk preview: MIRRORS the runtime integrator (§4.2). |
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
| `_pinballRuntimeForTests` | re-export | The runtime, for the host test. |
| `planPinball`, `planPinballZones`, `fitPinballZone` | function | Where the table, its tap zones and pick boxes go (fit is SERIALISED). |
| `PinballMap`, `PinballFlipperPlan`, `PinballButtonPlan`, `PinballPlungerPlan`, `PinballZoneSpec`, `PinballZonePlan`, `PinballPlan` | interface | Plane map (LDU table plane → model blocks) and plan types. |
| `PINBALL_TAP_REACH`, `PLUNGER_DEPTH`, `PICK_PITCHES` | const | Zone reach (blocks), the plunger target's depth (fraction of the reach; farther than the buttons', so a button wins where the two meet on screen) and pick pitches (degrees). |
| `rotationBetween`, `flipperRig`, `moveRig` | function | Bone rigs that swing flippers about the tilted normal and move the ball/plunger. |
| `PINBALL_AXIS_SIGNS` | const | Model X/Z signs in a bone translation. |
| `PROP_FLIP`, `PROP_PULL`, `PROP_PRESS`, `PROP_BALL_U`, `PROP_BALL_W`, `PROP_BALL_VU`, `PROP_BALL_VW`, `PROP_BALL_SEQ`, `PROP_SX`, `PROP_SZ` | const | Actor properties the client animates from (ball position/velocity for extrapolation). |
| `BALL_INITIALIZE`, `BALL_PRE_ANIMATION` | const | The ball's client-side extrapolation clock (Molang). |
| `pinballPropBehavior`, `flipperProperties`, `flipperAnimation`, `ballProperties`, `plungerProperties`, `pressProperties`, `ballAnimation`, `plungerAnimation`, `buttonPressAnimation`, `consoleHideAnimationId`, `consoleHideAnimation`, `consoleAssets`, `pinballZoneTexture`, `zoneAssets` | function | Entity and animation assets (not physics). |
| `PINBALL_FAMILY`, `PINBALL_INTERACT_TEXT`, `PINBALL_BUTTON_FAMILY`, `PINBALL_ZONE_TEXTURE`, `PINBALL_KEY` | const | Names (not physics). |
<!-- /physics-spec:exports -->

<!-- physics-spec:exports web/src/engine/addon-walk.ts -->
| Export | Kind | Role |
|---|---|---|
| `TICKS_PER_SECOND`, `GRAVITY`, `VERTICAL_DRAG`, `JUMP_VELOCITY`, `TERMINAL_VELOCITY`, `WALK_SPEED`, `SPRINT_FACTOR`, `SNEAK_FACTOR`, `GROUND_FRICTION`, `AIR_FRICTION`, `AIR_ACCELERATION`, `STEP_HEIGHT`, `JUMP_PEAK` | const | Minecraft's player physics (§3, §9). |
| `PLAYER_WIDTH`, `PLAYER_HEIGHT` | const | The 0.6 × 1.8 box. |
| `tickPlayer` | function | One tick of the player: input, gravity, friction, step, per-axis collision. |
| `spawnState`, `playerBox` | function | Initial state; the player's box. |
| `NO_INPUT` | const | Idle input. |
| `PlayerState`, `WalkInput`, `Contact`, `TickResult`, `Box`, `SolidBox`, `EntitySolid` | interface | Types. |
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

<!-- physics-spec:exports web/src/engine/bedrock-figure-life.ts -->
| Export | Kind | Role |
|---|---|---|
| `FIGURE_TUNING` | const | Every figure-life number (§4.5, §9). |
| `FigureTuning` | interface | Its type, with units per field. |
| `figureLifeRuntime` | function | SERIALISED. The per-tick state machine; walks by velocity. |
| `figureLifeScript` | function | Serialises it and the planner into `BP/scripts/figures.js`. |
| `standFeetAt`, `exploreWalkable`, `startCell`, `refugeCell`, `pathTo`, `blockSpan` | function | SERIALISED planner over real collider spans. |
| `FigurePlanner`, `FigureLifeConfig`, `FigureHome`, `WalkCell` | interface | Types. |
| `SpanLookup` | type | Collision-span lookup. |
| `FIGURE_HOME_PROPERTY` | const | Dynamic property holding a figure's home. |
<!-- /physics-spec:exports -->

<!-- physics-spec:exports web/src/engine/figure-life-sim.ts -->
| Export | Kind | Role |
|---|---|---|
| `simulateFigureLife` | function | Runs the SERIALISED figure runtime on host over a collider grid (stand-in collision and fall). |
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
