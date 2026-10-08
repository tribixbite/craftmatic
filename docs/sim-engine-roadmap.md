# Walker / sim engine upgrade plan (planning only; main `467205df`, 2026-10-08)

Question: what can the browser walker (`web/src/ui/addon-preview.ts`,
`addon-preview-data.ts`, `engine/addon-walk.ts`, driven by
`scripts/_shoot_addon_walk.mjs`) and the headless simulator (`scripts/sim.ts`,
`web/src/sim/**`) validate today, what would they validate with the right
upgrades, and what stays on the phone whatever we build.

Evidence read: CLAUDE.md, docs/sim-engine.md, docs/testing-guide.md,
REQUIREMENTS.md (all 16 sections), TASKS-BEDROCK-ADDON.md "Start here" +
"Open" sections, docs/product-spec.md section 11, docs/bedrock-interactivity.md
"Not verified on a device", the quirk registry (51 rows), the sim's systems,
input, facades, runner, invariants, vehicle course, snapshot, the walker's tick,
input, interact, ride and camera code, round 30m's offline reports
(`output/device-round-2026-10-08m/sim-*.md`: child play 132/132, course 3/3,
regressions 25/0/0, unmodelled API: none reached).

## 0. Where the two surfaces stand, and the one structural fact

**Headless sim** (`web/src/sim`): runs the pack's scripts unmodified in one
context over the shipped world; models the player integrator, auto-jump (Java
rule, one Pixel point), tap/hold/pick at 5 blocks, seat and collision-box
scaling, dismount set-down, teleport-into-floor, hover controller + chase +
rider yaw carry, the x-mirrored block boxes, actor cull by 3-D root distance,
refused definitions. The child-play / course / regression / hop scenarios are
green on 30m and no unmodelled API member is reached, so the sim's roadmap is
no longer "implement the next member"; it is the quirk rows marked
`device-only` / `partial` / ASSUMED and the `TODO(sim-*)` list:
`sim-walk` (the child is TELEPORTED to tap spots), `sim-boat-course`,
`sim-slide`, `sim-seat`, `sim-flight`, `sim-vanilla`, `sim-gametest`,
`sim-api` (numeric enums, read-only before-events, per-pack dynamic props),
`dismount-order/floor/ref`, `cull` (3-D vs horizontal), `car-oblique-kerb`,
`footprint-cost`, `tilted-colliders`.

**Browser walker** (`ui/addon-preview.ts`): collides against the exact shipped
collider blocks with the sim's integrator (shared since the fold), but
everything above the integrator is a SECOND implementation: its own coaster
animation (`coasterRiderView`), its own pinball (`createPinballSim`), its own
door toggling (`toggleInteractive` over `interactive-walk.ts`), seats are
camera parking with "restore the saved state" dismount, figures are static,
vehicles cannot be driven at all, there is no auto-jump (space/touch jump only),
sneak is a hold not a toggle, and the HUD shows nothing the scripts say. That
is why SIM-02 is PARTIAL and why the walker could not have shown any of the
30j-30m faults (Nimbus spin, cockpit lag, double-scaled seats, dismount drop,
scheme drags): none of them is in the integrator.

**The structural fact that decides the plan:** `web/src/sim` imports nothing
from `node:` (checked: only `ArrayBuffer.isView` in mcstructure.ts), evaluates
scripts with `new Function`, and reads a pack from an `ArrayBuffer`. The
headless simulator can run in the browser today, in a Worker. So the DRY
answer to "upgrade the walker" is NOT to port features into
`addon-preview.ts`; it is to make the walker a renderer + input device over a
`Simulation` instance and delete its second implementations. Every sim
upgrade below then reaches the walker for free, and the walker becomes the
standalone engine's first client (SIM-04).

Hard lessons that shape the items (each a sim/device disagreement found only
on the phone): course met walls square-on only; `--runtime=tree` ran old
constants; offline walks jumped while touch players auto-jump; lock-181 seats
carry the look (Nimbus spin); seats and boxes double-scaled; dismount about
the seat not the origin; cockpit draw lag; `player_relative` drags turned
only the camera; the sneak TOGGLE; a stray harness tap. The pattern: the
sim modelled the SERVER well and the CLIENT (camera, draw lag, input routing,
touch semantics) not at all. Packages B and C are the client.

## 1. Prioritised items (12)

Effort S < 1 day, M 1-3 days, L 3-6 days. "Risk" = risk of FALSE CONFIDENCE:
a green result that the phone contradicts.

### Item 1 - The walker hosts the simulator (package A, walker; L; risk LOW)
Capability: a `Simulation` runs in a module Worker
(`web/src/ui/addon-sim-worker.ts`, new) from the same `.mcaddon` bytes the
walker already reads; the main thread sends `PlayerControls` + look and
receives per-tick entity poses, rider state, camera requests
(`playerState().camera`), action-bar/chat/form lines and the timeline. The
walker's three.js scene draws entities at the sim's positions
(`moveEntityHolder` already exists) and the sim's `VoxelWorld` replaces
`WalkWorld` for the player (`engine/addon-walk.ts` keeps `WalkWorld` for the
reach BFS / tread comparison, which stays pure). Delete from `addon-preview.ts`:
`updateCoasterAnimation`, `board/sit/dismount`, the pinball block, `toggleDoorLeaf`,
`toggleInteractive`, `applyRidingCamera` roll maths - the pack's own
`coaster.js`, `rides.js`, `interactives.js`, `pinball.js`, `figures.js` do it.
Validates offline: SIM-02 "figures working" (figures walk in the walker:
`figures.js` runs), SEAT-04/05 (sit by hold, sneak off, the real set-down and
the egress script: assertion = the walker's HUD shows the sim's
`no-unprotected-fall` and `player-not-in-solid` violations live), IX-01 (every
part the sim can tap), DOOR-01 (doorway lines with the real `interactives.js`),
COAST-02/07 (second train waits - watch it), VEH-13 `mainVehicleOnly` (place
with the option and count). Also PACK-05: the walker opens a WEB-exported pack
(the LEGO tab export), which no device round has ever run.
Calibrate against: nothing new - parity with the headless run is the test
(`test/addon-walk.test.ts` "parity with the reach walk on real packs" gets
a sibling "the walker's tick equals scripts/sim.ts's tick" over 10261 for 600
ticks: identical timeline).
Belongs: walker, consuming the sim unchanged. Files owned by A only.

### Item 2 - Drive, fly and ride in the walker with touch controls (A; M; risk MEDIUM)
Capability: on-screen stick + Jump + Sneak TOGGLE (the touch default) + a drag
surface, mapped to `ControlState.set` and to the look through package C's
scheme router (until C lands: direct look, as the sim does now). Hotbar slots
1/9 switch chase/cockpit as the pack does (`selectedSlot`). The chase and
cockpit cameras are the SCRIPT's `setCamera` requests, drawn through package
B's client camera model (eased 0.1 s, 3.5-tick entity lag) - until B lands,
drawn raw with a banner "camera: raw". `_shoot_addon_walk.mjs` gets modes
`drive` (spawn on the course lane `--obstacle=`), `fly`, `ride`, each writing
a PNG strip every N ticks (the device round's frame sheets, offline).
Validates: VEH-02/03/04/05 checklist points 1-10 by eye on a screen (today
"never on a phone" for up/back/hover on 4 of 7 vehicles), VEH-06 free look
(watch the orbit hold and ease), VEH-14 the user's own verdict without a
phone (he can play it on the LAN from his phone: CON-02's `--host`),
VEH-16 "never inside geometry" visually, SEAT-01 "sits IN the cockpit" from
the drawn seat (`seatWorld` of the sim).
Calibrate: Saga 30j/30k/30l recordings (`output/device-round-2026-10-07{j,k,l}/saga/rec/*.mp4`,
`frames/*-sheet.jpg`): the offline strip of the same manoeuvre must match
frame for frame at the strip's cadence before the walker's picture is
trusted for a NEW manoeuvre.
Belongs: walker. Risk MEDIUM because a camera that looks right in three.js
with raw `setCamera` is exactly what hid the cockpit lag; the banner stays
until B's model is in.

### Item 3 - Client camera model: easing, splines, draw lag (package B, sim; M; risk MEDIUM)
Capability: `web/src/sim/client/camera.ts` (new): a per-player CLIENT state
that turns the script's camera requests into a drawn pose per tick -
`setCamera minecraft:free` eased over `easeOptions` (0.1 s linear is what the
packs send), `playAnimation` spline sampling with the `over` chart and linear
Euler interpolation (quirk `camera-roll-animation-only`: the rule is known,
only the roll is undrawable - the ANGLES are computable), the hand-back
(`animTail`), and a ring buffer of entity poses so the drawn seat is the pose
`client-entity-lag` 3.5 ticks back (quirk `cockpit-draw-lag` 3). Snapshot
(`adapters/craftmatic/snapshot.ts`) renders from the DRAWN camera and draws
entities at their DRAWN (lagged) poses.
New invariants (registered by B's own module, `sim/client/invariants.ts`):
`camera-continuous` (frame-to-frame view change <= X deg while the script
intends continuity; X from the Saga 30g loop-1 exit swing 5/7 laps and the
first-drop one-frame jump 6/6 - COAST-06's open items), `camera-on-own-seat`
(the drawn eye within 0.5 block of the drawn seat at speed - the general form
of `cockpit-eye-on-seat`, now from the drawn pose rather than a lag
arithmetic), `no-own-view-flash` (an animation that ends before the next
`setCamera` shows the player's own view: COAST-06 "(b) no own-view flash").
Validates: COAST-06 (all three device findings become assertions over 10261
and 10303 laps; status PARTIAL -> DONE-OFFLINE with `sim:coaster-camera`),
VEH-06 cockpit at speed on every vehicle at every size (the 30l fault reproduced
at lag 4 and absent at 3 by the DRAWN picture, not by `cockpitLagFromLead`),
the hop's "no head in view" (VEH-12: `hop-invisibility-handoff` becomes a
rendered check: no face of the rider's own geometry in the drawn frame).
Calibrate: `output/coaster-cam-0929/` ride2/ride3/ride4 frames (Pixel), Saga
30g loop frames, Saga 30k `r19-cmp.jpg`/`r20-strip.jpg` and 30l
`frames/r17-mcl-ck-sheet.jpg` f007-f011 (the two cockpit brackets), the
camprobe marker measurement (`tickLag` 1.5 / `animLag` 3.5). The model must
reproduce BOTH cockpit brackets and the coaster's 1.5 from one state machine;
if it needs two numbers, the quirk rows stay separate and say so.
Quirk rows: `camera-roll-animation-only` device-only -> partial (angles
modelled, pixels not), `client-entity-lag` device-only -> modelled,
`cockpit-draw-lag` gains "drawn pose" evidence.
Belongs: sim; the walker draws through the same module (A consumes).

### Item 4 - Render rules the phone applies, in the snapshot (B, sim; M; risk LOW)
Capability: the rasteriser (`sim/render/rasterizer.ts`) takes a face filter
and a conflict policy; the snapshot applies (a) `UvFloorModel` `v`
(`engine/figure-holes.ts`, already the Pixel rule used by
`_pack_render.ts --uvfloor=v`) so dropped faces are not drawn - quirk
`box-uv-sub-unit-faces` device-only -> modelled; (b) coplanar detection at
draw time: two faces of different colour within 1/107 block on one plane
covering the same pixel are painted as HATCH (a flagged pixel), so the output
of a child-play `snapshot` step carries `hatchPixels` and
`hatchShareOfImage` - quirk `coplanar-hatching` device-only -> partial
(visible-from-here count; the device's winner is unknowable); (c) the LOD
switch: evaluate each entity's render-controller distance rule
(`bedrock-lod-hull.ts` `switchDistance`) from the DRAWN camera and draw the
hull geometry past it, so a snapshot sequence walking away from 10261 at 200 %
shows full -> hull -> gone at the planned distances; (d) `TODO(cull)`: keep
3-D distance but ALSO compute the horizontal reading and report both when they
disagree by more than a chunk (an explicit "unsettled" note instead of a
silent choice).
New invariants: `no-visible-hatch-near` (hatch pixels within 8 blocks of the
eye over child-play's standing spots and ride seats = 0 for the SAME actor;
cross-actor pairs reported, as `_render_fault_audit.ts` counts them),
`lod-switch-under-cull` (the hull is drawn at least once before the actor
culls, per entity above the hull threshold), `no-dropped-face-in-view` (the
UvFloor loss within 8 blocks of the eye is 0 % of the silhouette).
Validates: FID-01 (42172 striping: the Pixel 30j "solid from 7 angles" becomes
7 offline snapshots with `hatchPixels` = 0 and UvFloor loss = 0), FID-03
(strobing/tearing/partial spawning: lattice chunks all drawn at each distance
step; `lod-switch-under-cull`), FID-05 (translucent glass drawn translucent in
the snapshot), COL-03 (chunks + base at 200 % drawn from 78-83 blocks, as 30j
measured; 300/400 % predicted and labelled "predicted, not measured").
Calibrate: Pixel 2026-09-29 box-UV probe (CLAUDE.md), Pixel 30j 42172 shots
(`output/device-round-2026-10-07j/pixel/`), round 26a `cull_*.png`, Saga
2026-09-25 `b6c1c882` no-hatching round, 30j 10261 200 % "12 chunks + base,
78-83 blocks". The hatch rule's winner is NOT modelled: a hatch pixel means
"the device will fight here", never "the device draws colour X".
Belongs: sim (`_pack_render.ts` and the walker's three.js get the same
filter from `figure-holes.ts`; the walker gets a `uvfloor` legend toggle via A).

### Item 5 - Drag routing by control scheme, the sneak toggle, mount snap, native bursts (package C, sim; M; risk MEDIUM)
Capability: `sim/input/scheme.ts` (new): a per-player scheme (`default`,
`player_relative`, `camera_relative`, set by the `controlscheme` command the
host already parses) and a `drag` input (`sim/input/drag.ts`): under the
default scheme a drag turns the player's yaw/pitch; under the other two it
turns only a client camera orbit and NOT the rider (quirk
`control-scheme-drag-to-camera` modelled -> the invariant
`rider-drag-reaches-look` becomes a measurement, not a rule check); on a
lock-0 seat the drag is held to the seat (pinball). `ControlState` gets
`sneakToggle` (touch semantics: sneak stays on until pressed again; the
dismount is the rising edge as now) so child-play's doorway lines run once
with sneak left ON after every seat exit (the 10326 Door 3 finding, Pixel 30j;
`SNEAK-STOP` exists only in `_ix_passability.ts` today). `SimEntity.addRider`
turns the rider's yaw onto the heading over `mount-snaps-rider-yaw`'s 4-12
ticks (the course's emulation in `cameraRecentre` is deleted). The hover
mount's server position moves in `native-mount-bursts` 4-tick bursts
(partial -> modelled), so the driver HUD's burst averaging is exercised.
New steps (registered by C in `adapters/craftmatic/input-probe.ts`, new):
`drag {dx, dy, ticks}`, `sneakToggle`, `tapScreen {u, v}` (item 6).
Validates: VEH-06's open cells (cars, boats, cockpit view, PITCH drag; the
yaw-lag carry on every vehicle: assertion = after one drag at rest the
vehicle's `yaw` never moves (scripted) and the view holds; while driving
`yawOff` eases to 0 within 2 s), FIG-08 (the Nimbus: one swipe turns the view
and the cloud STOPS - regression `nimbus-spin-30l` re-judged with a real drag
instead of a set look; look-down 52 deg + Jump descends), DOOR-01 at every
doorway with sneak on, SEAT-05 "never trapped" with sneak left on after the
exit, WAND-03 (a hotbar switch is `selectedSlot`, the Pixel's "crosshair tap
never fires itemUse" stays device-only).
Calibrate: Saga 30k item 6 (drags inert in `player_relative`, read in default:
`ContentLog-30k-live.txt` CMVT 19:08-19:11), Saga 30l item 6 (`riderPitch`
-36 -> 14 -> 52, `descending` true), Saga 30k CMCAM first samples (the snap
values -180/-90/0), 30l `nimyaw.py` (0.144/tick, 45-deg lead), Pixel 30j
Door 3 sneak stop at 0.24. Pitch drag on a scripted vehicle is still
UNMEASURED: the sim applies the yaw rule to pitch and the quirk row says so.
Quirk rows: `control-scheme-drag-to-camera` modelled (routing), `rider-free-look`
partial (pitch assumed), `mount-snaps-rider-yaw` modelled, `native-mount-bursts`
modelled, new `touch-sneak-toggle` (evidence: Pixel 30j item 3, round 30k
"Sneak OFF and ON").
Belongs: sim; the walker's touch layer (A) sends `drag`/`sneakToggle`.

### Item 6 - Screen-space touch pick and device-script replay (C, sim; S-M; risk MEDIUM)
Capability: `tapScreen {u, v}`: the pick ray from the DRAWN camera (chase or
cockpit when a script camera is active; the eye otherwise) through a screen
point of a phone-shaped viewport (2244 x 1008, the Pixel; Saga 2400 x 1080),
hitting entities' REALISED boxes (`collisionSize`, quirk
`collision-box-scales-with-entity`) and `selection_box` blocks, reach 5 (the
`tap-is-hit` value). A replay step `deviceScript {file}` reads an adb round's
command log (`output/device-round-2026-10-07k/pixel/tools/cmd.sh` and the
`*-walkstart.txt` of 30m: `input tap x y`, `input swipe`, `/tp`, hold
durations) into steps, so a round's EXACT finger sequence runs offline first -
the stray harness Exit tap (30k, Gate 1 throw-out) would have shown as
"tap at (x,y) toggled Gate 1" before the phone did.
Validates: DOOR-01/IX-01 "tap occlusion" (910004 Door 4 toggling Window 3:
assertion = the first box on the screen ray is the intended part from each
approach spot; a report row per part whose box is occluded from its approach),
`door3-tap-10326` from the recorded HUD cell with the recorded AIM (the replay
is already the cell, now the pick is the camera's), PIN-02 (a tap on the
left/right half of the screen works that flipper - today the sim taps hotbar
slots), WAND-01 aim-follow (the ghost follows the screen-centre ray).
Calibrate: Pixel GameTest 2026-09-30 quirk_reach (server 7/3/5 blocks),
pinball rounds 3/4 (`pb0924f/device`), Saga 30i Door 3 tap at 1.9 blocks,
30k Gate 1 stray tap. The PHONE's pick (what the client sends) is not
measurable (quirk gap stays); the screen ray is the server-side model of it
and must stay inside the Creative 7.
Belongs: sim; the walker's pointer events map to `tapScreen` (A).

### Item 7 - Per-tick cost model (C, sim; S; risk LOW as a WARNING, HIGH as a gate)
Capability: `script-host/host.ts` counts facade calls per tick per script
(`getEntities`, `getBlock`, `runCommand`, `fillBlocks`, `setBlock`,
`teleport`) and reads the runtime's own `sweepChecks` telemetry; a cost table
`sim/quirks/cost.ts` (new) maps counts to ms from the measured points: 770
checks = 14.5 ms (Pixel 30j), 13.4 ms (Saga 30l), 890 = 20-24 ms (Pixel
09-25, barge), Milano 26-30 ms while lifting (Saga 30k). Reported per
scenario as `predictedMsPerTick` p50/p95; an invariant `tick-budget` WARNS
over 25 ms and never fails (the mapping is two points per device).
Validates: VEH-16 `TODO(footprint-cost)` trend (a change that doubles probes
is seen before a build), PERF-* "ms/tick" rows get a predicted column, the
barge turn (TASKS "36-block barge ~14 ms"), COL-01's "10261 placement.js
518 -> 982 kB (load time unmeasured)" gets a load-tick count.
Calibrate: the four points above; add one Saga/Pixel measurement per round
(`/scriptevent craftmatic:vehicle_telemetry fast` already prints `sweepChecks`
and the watchdog's ms). Risk: a cost model with two points per device is a
trend detector, never a pass; the doc must say "predicted".
Belongs: sim.

### Item 8 - Water: buoyancy, a boat lane, the floating ship (package D, sim; M; risk MEDIUM)
Capability: `VoxelWorld` liquids become volumes with a surface height;
`physics/body.ts` `tickBody` gets buoyancy + liquid drag for a body whose
`minecraft:buoyant` / the scripted boat model's waterline applies; the vehicle
course (`adapters/craftmatic/vehicle-course.ts`) gets lanes `water-flat`,
`water-bank` (drive out onto a 1-block bank), `water-shallow` (a 1-deep
channel), `water-wall` (a pier post met off square) - `TODO(sim-boat-course)`.
Validates: VEH-09 "no boat lane" (DONE-OFFLINE for boats: 60221, 10365,
910047, 31109), SEAT-05 "water" egress (`vehicleEgress` water case:
assertion = a sneak off a boat sets the child on the bank or swimming, never
under the hull), COAST-10 n/a. 10365 "floats" (Pixel+Saga 29b) becomes a
regression case `ship-floats-29b`.
Calibrate: Pixel+Saga 29b (10365 floats, waterline), Saga 10-05 GPT-6
recordings are UNTRUSTED and do not count. Buoyancy numbers come from the
boat model's own constants (`bedrock-vehicle.ts` boat), which the DEVICE
accepted in 29b; a native `minecraft:buoyant` body has no measurement and
its row must be ASSUMED.
Belongs: sim; the walker gets water drawn (A) only after D lands.

### Item 9 - Bodies that meet: entity-entity collision, trimmed forms for mobs, vanilla door states (D, sim; M; risk LOW)
Capability: `physics/systems.ts` entities system (D owns the `entities` and a
new `pushes` system; C owns `players`/`mounts`/`riders`) sweeps mobs and
vehicles against each other's realised boxes (figures stop at a parked car,
a figure in a doorway blocks the door's step-out); `TODO(colliders)` /
`blockSpan`: the figure planner and the vehicle sweep read a clearance form's
real boxes through the kit (`cellPieces`) instead of the base `lo`/`hi` -
this is a PACK-side change in `bedrock-figure-life.ts`/`bedrock-vehicle.ts`
runtimes, so D measures it with `--runtime=tree` first; `TODO(sim-vanilla)`:
vanilla door panel side from `direction`/`open_bit`/`door_hinge_bit`
(the runtime door candidates above 100 %), slabs/stairs shapes.
Validates: FIG-01 "figures stuck in 1-4 cells" (31141, 910049, 76269: the
census with real forms), DOOR-02 the wand's vanilla door offer at 300 %
(21060/76419: `doorwayLines` through a vanilla door), VEH-16 a car meeting a
figure (new invariant `no-entity-overlap` for solid pairs), IX-03 the lift
car carrying a figure that stands on it.
Calibrate: Pixel GameTest 09-25 figures (0 leave), round 29c walking figures;
entity-entity collision on Bedrock for CUSTOM entities without
`minecraft:pushable` is itself unmeasured (format 1.26.30 dropped it;
`pushable_by_block` only) - a GameTest probe `quirk_push` (two custom
entities walked into each other, a player walked into a figure) is the
calibration this item needs BEFORE its invariant counts.
Belongs: sim.

### Item 10 - The GameTest module in the sim: one scenario definition (D, sim; L; risk LOW)
Capability: `script-host/gametest-module.ts` (new): `@minecraft/server-gametest`
as the catalogue lists it - `registerAsync`, the builder, `Test` (`idle`,
`succeed`, `fail`, `getDimension`, `worldLocation`, `worldBlockLocation`,
`relativeLocation`, `getBlock`, `getTestDirection`, `spawnSimulatedPlayer`)
and `SimulatedPlayer` (`attackEntity` = tap, `interactWithEntity` = hold,
`lookAtEntity`, `moveToLocation`/`moveRelative`/`stopMoving` steering the
controls, `jump`, `rotateBody`, `setRotation`); `scripts/sim-gametest.ts`
(new) builds the GameTest variant with `_gametest_pack.ts`'s builder and runs
every test by name, writing the same `CMGT` lines the phone writes.
Validates: PACK-08 "sim and GameTest do not share scenarios" (closed), DOOR-01
"GameTest walk of the newly passable doors not run" (80049 Doors 1-2, 42670
Door 1, 10326 Doors 1-2, 11371 Doors 2-4/7, 21318 Door 1, 31141 Door 4, 41732
Door 3, 910004 Door 3, 910049 Gate 1: run offline NOW, and the device run
later compares line by line), FIG-01 figures_<id> at 200 %, WAND-06
`creator_wand_<id>`, FIG-08 `flyer_<id>`, PIN-01 `pinball_arcade_11374` -
each listed in REQUIREMENTS as "never run on the Pixel": the offline run gives
the expected CMGT log, the Pixel run (when re-paired) a diff instead of a
reading.
Calibrate: `output/gametest/` and `output/gametest-quirks-0930/run{1,2,3}/cmgt.log`
(every past Pixel run replays offline and must produce the same verdict lines
where the sim claims the fact is modelled; a mismatch is a new quirk row, not a
tuned test).
Belongs: sim. Replaces the last hand-rolled mock (`test/gametest-pack.test.ts`).

### Item 11 - Walk to the tap, don't teleport (D, sim; M; risk LOW)
Capability: `scenario/approach.ts` plans a route over the collider world
(the `WalkWorld` reach graph is already in `engine/addon-walk.ts`:
`simulateReach`/`reachPoint`; D wraps it over `VoxelWorld`) and `reachFor`
WALKS the child there with the real integrator and auto-jump ON (touch
default), only teleporting when the scenario says `teleport`. `TODO(sim-walk)`.
A tap target the child cannot WALK to from the placement's spawn becomes
`tap-target-unreachable-on-foot` (reported, not failed - the exploration rule
IX-04).
Validates: IX-04 gets its first automated guard (invisible geometry may
unlock, never restrict: every target reachable with the old teleport and
unreachable on foot is listed per pack), COL-01 300/400 % "never walked on
device" (the child-play at 300/400 % walks every doorway and seat from the
ground; today the sim child-play places at 100/150 only), SCALE-05
up/down movement at 200-400 %.
Calibrate: Pixel 30k/30l lift-hill climbs (pin + 28.2 with auto-jump, the
top with the lane pass), Pixel 30m `*-walkstart.txt` lanes (in progress).
Belongs: sim; the walker shows the planned route (A: it already draws routes).

### Item 12 - Per-pack dynamic properties, rotated `getAABB`, numeric enums, read-only before-events (D, sim; S; risk LOW)
Capability: `script-host/facades.ts`: dynamic properties keyed by the writing
pack's header uuid (quirk `dynamic-properties-per-pack` partial -> modelled:
a cross-pack read returns undefined as on the device, and the hop's tag path
is exercised for real); `getAABB` of a yawed entity (the realised box is
axis-aligned on the device for `collision_box`; a GameTest probe `quirk_aabb`
settles the rotated case - until then ASSUMED and the row says so); numeric
enums from the catalogue; before-event handlers that mutate throw as the
device does (`TODO(sim-api)` x3).
Validates: VEH-12 hop across packs with the honest property boundary, PACK-08
API fidelity, every `sim:` guard's claim that "unmodelled is never pass".
Calibrate: Script API docs for the property boundary (not device-measured);
the rest from the generated catalogue.
Belongs: sim.

Not taken (and why): a voxel-world renderer for the standalone engine
(SIM-04) - A's Worker split IS the seam; the renderer stays three.js in the
walker until the adapter moves out. Boats' native `minecraft:buoyant` -
unmeasured. Entity AI/navigation - the packs use none.

## 2. Work packages (parallel worktrees, disjoint files)

Rule for every package: never a recursive delete, no `git rm` (plain `rm`),
commit before any pack export, `--runtime=tree` only with the top-up
(`runtime-swap.ts` fills missing CONFIG keys - verify the key you add is in
the top-up list), and every new fact is a quirk row with evidence BEFORE the
module reads it. Each package adds its guards to `REQUIREMENTS.md` rows
listed below and leaves other rows alone (D edits the ledger last, after
merge, to avoid conflicts on the one file: A/B/C put their row edits in their
PR description and D applies them in one commit).

### Package A - "One engine": the walker hosts the simulator (items 1, 2)
Owns (exclusively): `web/src/ui/addon-preview.ts`, `web/src/ui/addon-preview-data.ts`,
`web/src/ui/addon-appearance.ts`, `web/src/ui/addon-reach-worker.ts`,
`web/src/ui/addon-sim-worker.ts` (new), `web/src/ui/addon-sim-client.ts`
(new: the message protocol + pose interpolation), `web/src/ui/lego.ts` (the
"Walk add-on" button only), `web/src/engine/addon-walk.ts`,
`scripts/_shoot_addon_walk.mjs`, `test/addon-walk.test.ts`,
`test/addon-preview-data.test.ts`, `docs/testing-guide.md` section "The
walkable add-on preview". MUST NOT edit anything under `web/src/sim/` (it
consumes `Simulation`, `ControlState`, `playerState().camera`, the timeline);
a missing sim hook is a one-line request to C (input) or B (camera), not a
local patch.
Worker boundary: `Simulation.loadAddonBytes(bytes)` in the Worker; the main
thread posts `{controls, look, drag, tapScreen, slot}` per frame and receives
`{tick, entities: [{id, typeId, x, y, z, yaw, pitch, scale, riders}], player,
camera, lines, violations}`; the walker interpolates between the last two
ticks (it already has `prevState/state` alpha blending).
Commands (round 30m packs, `P=C:/git/craftmatic/output/device-round-2026-10-08m/packs-6a8c7121`):
```
bun dev:web --host                                  # LAN phone play: Saga/Pixel open http://<lan-ip>:4000?tab=lego
node scripts/_shoot_addon_walk.mjs $P/42172-mclaren-p1.mcaddon out/a/mcl.png model drive --obstacle=kerb2 --strip=10
node scripts/_shoot_addon_walk.mjs $P/7140-xwing-fighter.mcaddon out/a/xw.png model fly --sequence=up,hover,back,down --strip=10
node scripts/_shoot_addon_walk.mjs $P/10261-roller-coaster.mcaddon out/a/10261.png model ride --ride-wait=2500
node scripts/_shoot_addon_walk.mjs $P/76417-gringotts-wizarding-bank-collectors-edition.mcaddon out/a/fig.png model figures-live --ticks=6000
node scripts/_shoot_addon_walk.mjs $P/10326-natural-history-museum.mcaddon out/a/d3.png model doors --door=2 --sneak=on
bun run test test/addon-walk.test.ts test/addon-preview-data.test.ts   # includes the new "walker tick == sim tick over 10261, 600 ticks" parity
```
Evidence: `output/walker-engine-<sha>/` with the strips + the parity JSON.
Ledger rows: SIM-01 (guard: parity test; device cell: Chrome capture date),
SIM-02 PARTIAL -> DONE-OFFLINE (gap "figures static" removed; new gap: "camera
drawn raw until B"), SIM-04 OPEN -> PARTIAL (the Worker seam), CON-02 (the
LAN command documented), VEH-14 device cell: "user played on the walker from
the phone <date>" when he does, PACK-05 (a web-exported pack walked).

### Package B - "The client's eye": camera model + render rules in the snapshot (items 3, 4)
Owns: `web/src/sim/client/**` (new: `camera.ts`, `draw-lag.ts`,
`invariants.ts`, `steps.ts`), `web/src/sim/render/rasterizer.ts`,
`web/src/sim/adapters/craftmatic/snapshot.ts`,
`web/src/sim/adapters/craftmatic/appearance.ts`, `drawn.ts`,
`web/src/sim/adapters/craftmatic/coaster.ts` (camera probes),
`scripts/_pack_render.ts`, `scripts/_cockpit_view.ts`, `scripts/_coaster_cam_probe.ts`,
`scripts/_box_uv_loss.ts`, `scripts/_render_fault_audit.ts`,
`web/src/engine/bedrock-lod-hull.ts` (export of the switch rule only),
`web/src/engine/figure-holes.ts` (export of `UvFloorModel` only),
`test/sim-engine.test.ts` describe "first-person entity snapshots" block ONLY
(B adds a new file `test/sim-client.test.ts` for everything else),
`test/bedrock-coaster.test.ts` camera tests, quirk rows
`camera-roll-animation-only`, `client-entity-lag`, `cockpit-draw-lag`,
`box-uv-sub-unit-faces`, `coplanar-hatching`, `actor-draw-ceiling`,
`cull-by-collision-box` (C owns the registry FILE; B sends its row text to C
or lands first - decide at kickoff: B edits `registry.ts` rows listed here
ONLY, C the others; both append new ids at the end of `QuirkId` in separate
hunks).
Reads (no edit): `vehicle-free-look.ts`, `bedrock-coaster.ts`, `playerState().camera`
from `host.ts`.
Commands:
```
bun scripts/sim.ts $P/10261-roller-coaster.mcaddon $P/10303-loop-coaster.mcaddon --scenario=coaster-camera --frames=out/b/cam --md=out/b/cam.md
   # new scenario: 3 laps each, frames every tick through each inversion; invariants camera-continuous, no-own-view-flash, camera-on-own-seat
bun scripts/sim.ts $P/42172-mclaren-p1.mcaddon $P/7140-xwing-fighter.mcaddon $P/76286-the-milano-spaceship.mcaddon --scenario=vehicles --frames=out/b/cockpit
   # cockpitEye now judged from the DRAWN pose; --lag=1.5,3,4 prints the lead per lag to re-derive the 30k/30l brackets
bun scripts/sim.ts $P --shots=out/b/shots --uvfloor=v --hatch --lod         # child-play pictures with the device rules; hatchPixels/lodSwitch per shot
bun scripts/_pack_render.ts $P/42172-mclaren-p1.mcaddon --out=out/b/mcl-7.png --uvfloor=v --hatch --views=7   # the Pixel 30j "7 angles" offline
bun scripts/_pack_render.ts $P/10261-roller-coaster.mcaddon --out=out/b/lod.png --size=200 --walk-away=40..120 --lod
bun scripts/_box_uv_loss.ts $P --uvfloor=v --json=out/b/uv.json
bun run test test/sim-client.test.ts test/bedrock-coaster.test.ts test/sim-engine.test.ts
```
Ledger rows: COAST-06 PARTIAL -> DONE-OFFLINE (guards `sim:coaster-camera`,
`test/sim-client.test.ts :: reproduces the 30g loop-1 exit swing at the old
hand-back and not with handbackBlend`), VEH-06 gap cell ("cockpit lag
offline-verified by the drawn pose"), VEH-12 (hop head-in-view rendered),
FID-01/FID-03 (guards `sim:no-visible-hatch-near`, `sim:lod-switch-under-cull`;
status stays PARTIAL - the device winner is unknowable), COL-03 gap ("300/400 %
predicted by the switch rule, unmeasured"), FID-05 (translucent snapshot).

### Package C - "The client's hand": input routing, touch, sneak toggle, cost (items 5, 6, 7)
Owns: `web/src/sim/input/**` (`controls.ts`, `touch.ts`, `ray.ts`, new
`scheme.ts`, `drag.ts`, `screen.ts`), `web/src/sim/physics/systems.ts`
`players`/`mounts`/`riders` systems only (D owns `entities` + its new
`pushes`; both edit the file - split it first: C moves the three systems into
`physics/player-systems.ts`, D keeps `systems.ts` for bodies; do this split as
C's FIRST commit before D starts, or D starts from it), `web/src/sim/entity/entity.ts`
`addRider` snap only (one hunk), `web/src/sim/scenario/invariants.ts`,
`web/src/sim/scenario/types.ts` (controls fields only), `web/src/sim/script-host/host.ts`
(cost counters), `web/src/sim/script-host/commands.ts` (`controlscheme`),
`web/src/sim/quirks/registry.ts` (file owner; B's rows as above),
`web/src/sim/quirks/cost.ts` (new), `web/src/sim/adapters/craftmatic/input-probe.ts`
(new: the drag/snap/burst/sneak scenarios and the `deviceScript` replay),
`web/src/sim/adapters/craftmatic/regressions.ts` (re-judge `nimbus-spin-30l`,
`gate1-throwout-76417` with real drags/taps), `scripts/sim.ts` (flags
`--scenario=input`, `--cost`, `--device-script=`), `scripts/_ix_tap_probe.ts`,
`test/sim-engine.test.ts` describe "the script host" + "a native hover mount"
blocks, new `test/sim-input.test.ts`, `docs/sim-engine.md` sections "Core
invariants", "The vehicle course" (the `cameraRecentre` emulation note), new
"Input".
Commands:
```
bun scripts/sim.ts $P/nimbus-fixture.mcaddon $P/42172-mclaren-p1.mcaddon $P/7140-xwing-fighter.mcaddon $P/60221-diving-yacht.mcaddon $P/10797-gabbys-party-room.mcaddon --scenario=input --md=out/c/input.md
   # per vehicle: drag at rest (vehicle yaw constant, view moves), drag while driving (eases 2 s), pitch drag + Jump on the Nimbus (descends), scheme forced player_relative (fails rider-drag-reaches-look), mount snap (chase opens behind the nose)
bun scripts/sim.ts --scenario=regressions --new=$P --only=nimbus-spin --md=out/c/nimbus.md     # now by a real swipe
bun scripts/sim.ts $P --scenario=child-play --sneak-toggle --md=out/c/sneak.md                # doorway lines with sneak left on after each seat exit (expect 10326 Door 3 SNEAK-STOP on the pre-fill packs, OK on 30m)
bun scripts/sim.ts $P/76417-gringotts-wizarding-bank-collectors-edition.mcaddon --scenario=input --device-script=output/device-round-2026-10-07k/pixel/tools/cmd.sh --md=out/c/replay-gate1.md   # the stray Exit tap, offline
bun scripts/sim.ts $P --scenario=vehicles --cost --md=out/c/cost.md                          # predictedMsPerTick p50/p95 per vehicle; Milano cruise must print ~14 ms
bun scripts/sim.ts $P/10326-natural-history-museum.mcaddon $P/910004-winter-chalet.mcaddon --scenario=input --only=tap-occlusion --md=out/c/occl.md
bun run test test/sim-input.test.ts test/sim-engine.test.ts test/vehicle-free-look.test.ts
```
Device probes C needs (one GameTest/tap round, when a phone is free):
pitch drag on a scripted vehicle's 181 seat (CMCAM `riderPitch`), the sneak
toggle's effect on `isSneaking` as seen by scripts, `/controlscheme` read-back.
Ledger rows: VEH-06 gap (cars/boats/pitch drag now sim-covered; "device-unverified"
stays), FIG-08 (guard `sim:nimbus-spin-30l` by real drag), DOOR-01 and
SEAT-05 (guard `sim:child-play --sneak-toggle`), IX-01 "tap occlusion" (guard
`sim:tap-occlusion`), PIN-02 (screen-half taps), VEH-16 gap ("ms/tick
predicted; 2 calibration points per phone"), DEV-02 (device-script replay
before a round, `rule:scripts/sim.ts --device-script`).

### Package D - "The world": water, bodies, GameTest, walking, API fidelity (items 8-12)
Owns: `web/src/sim/world/**`, `web/src/sim/physics/body.ts`,
`web/src/sim/physics/systems.ts` (bodies; after C's split), `web/src/sim/entity/definitions.ts`,
`web/src/sim/entity/entity.ts` (all but `addRider`), `web/src/sim/script-host/facades.ts`,
`module-loader.ts`, `api-catalog.ts`, `gametest-module.ts` (new),
`web/src/sim/scenario/approach.ts`, `runner.ts`, `report.ts`,
`web/src/sim/adapters/craftmatic/vehicle-course.ts` (water lanes),
`play.ts`, `child-play.ts` (300/400 % placements, walking approach),
`figure-life.ts`, `hop.ts`, `scripts/sim-gametest.ts` (new),
`scripts/_gametest_pack.ts`, `scripts/_gametest_quirks.ts` (the `quirk_push`,
`quirk_aabb` probes), `web/src/engine/gametest-pack.ts` (the TODO: move the
place hook into the shipped runtime), `test/gametest-pack.test.ts`,
`test/gametest-creator-wand.test.ts`, new `test/sim-world.test.ts`,
`test/sim-gametest.test.ts`, `REQUIREMENTS.md` (applies every package's row
edits after merge), `docs/sim-engine.md` all sections not C's.
Pack-side runtime files D may touch for `blockSpan` (item 9) with
`--runtime=tree` measurement first: `web/src/engine/bedrock-figure-life.ts`,
`bedrock-vehicle.ts` `sweepFootprint` cell reader ONLY (coordinate with no one:
no other package edits them).
Commands:
```
bun scripts/sim.ts $P/60221-diving-yacht.mcaddon $P/10365-captain-jack-sparrows-pirate-ship.mcaddon $P/10786-gabby-and-mercats-ship-and-spa.mcaddon --scenario=vehicles --only=boat --md=out/d/boats.md   # water lanes; today: NOT TESTED (no boat selected)
bun scripts/sim.ts $P --scenario=child-play --sizes=100,150,200,300,400 --walk --md=out/d/walk.md       # walking approach, 300/400 % placed; tap-target-unreachable-on-foot per pack
bun scripts/sim.ts $P --scenario=child-play --runtime=tree --md=out/d/blockspan.md                      # figures/vehicles reading real forms: 31141/910049/76269 roam cells before/after
bun scripts/sim-gametest.ts $P/10326-natural-history-museum.mcaddon --tag=craftmatic_gt --log=out/d/10326-cmgt.log   # the device's CMGT lines, offline
bun scripts/sim-gametest.ts $P/76417-gringotts-wizarding-bank-collectors-edition.mcaddon --only=doors --log=out/d/76417-cmgt.log
bun scripts/sim-gametest.ts --replay=output/gametest-quirks-0930/run2/cmgt.log --pack=$P/10326-natural-history-museum.mcaddon   # every past verdict line re-derived; mismatches listed
bun scripts/sim.ts --scenario=hop --coaster=$P/10261-roller-coaster.mcaddon --flyer=$P/nimbus-fixture.mcaddon --car=$P/42639-andreas-modern-mansion.mcaddon --md=out/d/hop.md   # with per-pack dynamic properties: must still pass 3/3 via tags
bun run test test/sim-world.test.ts test/sim-gametest.test.ts test/bedrock-ride-hop.test.ts test/bedrock-figure-life.test.ts
```
Ledger rows: VEH-09 (boat lane; status stays PARTIAL until a boat round),
SEAT-05 water egress, FIG-01 (roam cells with real forms), IX-04 OPEN guard
(`sim:tap-target-unreachable-on-foot` report), COL-01/SCALE-05 300/400 %
child-play (guard `sim:child-play --sizes=300,400`), DOOR-01 "GameTest walk
not run" -> "run offline <date>, device pending", PACK-08 (`TODO(sim-gametest)`
closed; guard `test/sim-gametest.test.ts`), VEH-12 (property boundary),
WAND-06 / FIG-08 / PIN-01 (their GameTests run offline; device cells unchanged).

Merge order: C's split commit first (systems.ts), then A/B/C/D in parallel;
A merges last (it consumes B's camera and C's drag API; until then A ships
with the "camera: raw" / "drag: direct" banners). D applies the ledger edits.

## 3. What stays device-only, even after every item above

- **The phone's own touch pick** (what the client sends from a finger on a
  2244 x 1008 screen, `custom_hit_test` by a real finger, the pinball
  ~100 ms round trip): the sim's screen ray is the server's view of it; the
  client's hit test is closed code. Quirk `tap-is-hit` keeps its gap.
- **Pixels**: textures and Vibrant Visuals/Fancy lighting, which colour WINS
  a coplanar fight, font rendering and form LAYOUT (only `%` deletion is a
  known rule), the actor draw ceiling on a NEW client version, fps, VRAM/OOM
  (PERF-01: the 480k budget is a measured point, not a model). Item 4 counts
  where a fight or a dropped face is; it cannot say what the eye sees.
- **Client timing numbers**: 3.5 / 3 / 1.5 / 6-8 ticks and the 0.1 s ease
  are MEASUREMENTS the client model replays; a game update changes them
  silently. Every round keeps one marker measurement (camprobe) to re-pin.
- **Native internals**: the hover controller's burst cadence beyond the
  measured 4 ticks, `third_person_camera_radius`, which seat a second rider
  takes (`rider-seat-order` needs a second REAL player), the unmeasured
  dismount order spots, a float property's integer RANGE, pushability of
  custom entities (item 9 needs the probe first), the mob lift on teleport.
- **Sound** (`fly-sound-block-normal` and whether a pack's `normal` merges or
  replaces vanilla's), haptics, the chat keyboard's Exit-tap race.
- **Pack delivery UX**: PACK-04 (Bedrock keeps the first folder), the pack
  list's stamp text, world bindings, the import intent - all outside any
  script.
- **The user's verdicts**: VEH-14 "extremely fun", COAST-03 the square-root-2
  pace, SEAT-01 "reads as on top" for the AHEAD_FALLBACK boats - the walker
  (item 2) lets him judge from his phone on the LAN without an adb round,
  which is the cheapest device evidence there is, but it is still his eye.
- **Model geometry verdicts**: 26/83 doorways not OK at 100 % are the model's
  ("report, do not hack"); no engine upgrade changes the reading.
- **Memory of the sim itself**: `_seat_egress_sweep.ts` at 64 GB
  (`TODO(seat-sweep-memory)`) is a tooling bug, not a modelling gap; fix it
  in whichever package touches rides first (D), per pack and size.

## 4. Order of value, if only one package can start

C (input + sneak toggle + replay + cost) first: it is the smallest, it
closes the class of fault that produced 5 of the last 6 device findings, and
its `deviceScript` replay would have caught the stray Exit tap. Then B (the
drawn camera: COAST-06, VEH-06, FID-01/03 all wait on it). Then A (the walker
becomes the client of both, and the user can play without adb). D last, in
pieces: item 11 (walking) and item 10 (GameTest) are the ones that raise
offline coverage of rows marked "never run on the Pixel".
