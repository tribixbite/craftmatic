# How the rider's view goes upside down through a coaster loop

This document explains how a player riding a loop coaster (10303, 10261)
sees the loop from the seat: up the side, upside down across the top, and
back down. Bedrock's script camera API has no direct way to do this. It
explains the constraints, the design that works within them, why each part
is there, and what is still wrong.

The code is in `web/src/engine/bedrock-coaster.ts`:
- `coasterRuntime`, which is serialised into each pack as `scripts/coaster.js`;
- `planSection`, `splineAnimation` and `aimRider`;
- `coasterRiderView`, `coasterCarAttitude`, `carAnimation` and `riderViewBricks`.

Each constant's measurement is recorded where it is declared
(`COASTER_RIDER_VIEW`). Each device behaviour this relies on is a row in
`web/src/sim/quirks/registry.ts`. The ride's physics (speed, gravity, chain
lift) is described in [physics-architecture.md](physics-architecture.md); this
document covers only what the rider sees.

## 1. What Bedrock allows, and what it does not

Everything below was measured on the Pixel 8 Pro and the Saga, Minecraft
26.51 and 26.52. The probes were the `camprobe` packs kept in each round's
folder (for example `output/device-round-2026-10-20a/camprobe/`) and coaster
rides recorded on screen.

| Fact | Consequence | Quirk |
|---|---|---|
| The runtime places each car with a yaw only (`teleport` rotation x is always 0, `test/bedrock-coaster.test.ts :: inverts the cart visually at a loop apex while leaving player rotation upright`), so the seat and its rider stay upright. | The car's body is turned over by its own bones (2.3), not by rotating the entity. | — |
| `camera.setCamera` takes yaw, and a pitch within ±90 only; outside that it throws. It has no roll. | A camera set every tick can never be upside down. At best it looks straight up and then straight down. | `camera-pitch-limit` |
| Roll exists only as a `playAnimation` rotation keyframe (`rotation.z`). Keyframes must be more than 0.05 s apart, and a `LinearSpline` needs at least 3 points. | Upside down is possible only inside an animation. | `camera-roll-animation-only` |
| An animation re-sent every tick is never drawn. One uninterrupted animation is. | A loop must be sent as **one** animation, planned **before** the car enters it. | `camera-roll-animation-only` |
| Keyframe Euler angles are interpolated **linearly**, and a keyframe's pitch may run continuously past ±90 (x 0 → 360 is one smooth pitch-over). | Write a loop as one continuous pitch, not as yaw/pitch/roll in the ±90 chart. Written the ±90 way, the zenith's yaw and roll flip by about 180°, and the client draws that flip as a spin over two keyframes. | `camera-roll-animation-only` |
| A keyframe's rotation is in a **Z-mirrored** frame: `x` is the negated pitch and `y` is `180 − yaw` (the yaw `setCamera` would take). | Every keyframe is converted. Yaw ±90 is its own mirror, which is why probes along 10303's x-aligned loops missed this for a week. | `camera-keyframe-yaw-mirrored` |
| A `playAnimation` sent while the player is on their own view (no script camera set) is never drawn. | Each animation is **armed**: one un-eased `setCamera` at the animation's first view, then `playAnimation` on the next tick. | `camera-animation-needs-camera` |
| A `setCamera` sent while an animation plays takes over at once. An animation that **ends** before the next `setCamera` shows the player's own view for the gap. | The end of the hand-back is planned: the camera is cleared deliberately, not left to run out. | `camera-animation-cut` |
| The client draws entities **behind** the server: Saga 5.7 ticks on 26.52 and ~3 on 1.26.62.1, Pixel 3.5 on 26.51 and ~3 on 1.26.62.1 (camprobe marker 3.2-3.6 over two sessions, rides 3.0-3.3, round 20c; the Saga's 1.26.62 value derived, section 5). An actor property arrives **ahead** of the position sent with it: Saga 4.1 ticks (26.52), Pixel 3.3. | A camera on the server's schedule sits in the car ahead. Every pose the camera follows is shifted back to the **drawn** car, per client. | `client-entity-lag`, `property-ahead-of-position` |
| A rider's reported yaw (`getRotation`) is the client's, drawn on the drawn car and reported 7–9 ticks after the server's car yaw. | The player's head turn is measured against the car's yaw that far back, and fitted per rider. | `rider-yaw-lag` |

The table rules out the obvious design. A per-tick `setCamera` cannot roll or
pitch past ±90, and anything the server sets every tick jerks against cars the
client interpolates on its own schedule.

## 2. The design: the player's own view, and one animation per steep stretch

The shipped mode is `native` (default since 2026-10-18; `COASTER_RIDER_VIEW.mode`).

- **On near-level track no camera is set at all.** The player is in their own
  first person, drawn by the client from the drawn seat at the client's frame
  rate, and a drag turns the view immediately. That fixed the user's "super
  laggy, stutter-jerks in seats 2 and 3, lag when moving the camera by hand"
  report against the earlier per-tick `loop` mode.
- **Each fast, steep stretch** (a drop, a loop, a hard bank) is sent as **one
  `playAnimation`**, planned ahead from the ride's own arithmetic. The
  animation blends from the player's own view into the track's view, carries
  the view through the stretch (upside down where the track is), and blends
  back to the player's own view. Its first and last frames are exactly what the
  player would see without it, so neither the start nor the end cuts.

A stretch is a run of ticks where `steepPose` holds:
- the car is upside down (`up.y < 0`) at any speed; or
- it is tilted more than `steepTilt` (25°, pitch and bank together) at
  `steepSpeed` (5 blocks/s) or more.

A slow chain climb stays the player's own view to look around on. Stretches
fewer than `sectionGap` (12) ticks apart become one animation, so 10303's drop
and both loops play as one animation per lap.

### 2.1 Per tick, for each rider (`aimRider`, `native` branch)

1. **Measure the look.** The head turn is the reported yaw minus the car's yaw
   `reportLag` ticks ago, and the pitch is the player's own. Both are unclamped:
   they are the view the animation has to start and end on.
2. **If an animation is playing:**
   - If the train has left the plan, clear the camera at once. A train can leave
     the plan when it is held for the station bay or the other train, or when a
     teleport is refused. Without this check, the camera sat at the top of the
     drop while the train fell away (round 30zq).
   - At the planned end, `camera.clear()` returns the player's own view.
3. **If the previous tick armed an animation:** plan it again from this tick,
   which is the same stretch one tick later, and `playAnimation` it.
4. **Otherwise, if a steep stretch starts within 10 ticks** (`planSection`
   returns a plan): arm it with one un-eased `setCamera('minecraft:free')` at the
   plan's first eye and view, then play it on the next tick (step 3). If nothing
   steep is near, `planSection` returns `{ wait: n }` and the rider is not
   planned again for `n` ticks. A prediction costs a ride integration per
   predicted tick: in the 2026-09-25 regression, predicting 80 ticks on every
   steep tick cost a whole tick budget.

### 2.2 Planning one stretch (`planSection`)

1. **Predict the ride.** `planner.plan` runs the same `integrate`/`carPose` the
   ride itself runs, tick by tick, up to `sectionHorizon` (160) ticks. It stops
   `sectionGap` ticks after the last steep pose. Because the arithmetic is the
   ride's own, the animation and the train agree as long as nothing outside
   that arithmetic intervenes. When something does, step 2 of 2.1 hands back.
2. **Shift to the drawn car.** Animation tick *k* shows the pose of tick
   *k − animLag*. The sequence is: the rider's pose history, then this tick,
   then the predicted ticks, extended at constant velocity past the end. A
   fractional lag is interpolated. This keeps the eye on the seat the client is
   drawing, not on the server's position, which at 23 blocks/s is about a car
   length ahead.
3. **Make the views.** For each tick, `coasterRiderView(nose, up, look, …,
   'over')` gives the track's view in the `over` chart:
   - the **yaw** is the heading of the view's right axis, which holds still
     through a planar loop;
   - the **pitch** is continuous and runs on past ±90 (0 → −90 → −180 →
     −270 ≡ +90 → 0 through a loop);
   - the **roll** is a small residual, such as a helix's lean.

   The player's head turn is carried inside that frame, so "right" in a loop is
   the rider's right. The player's own view (the drawn car's yaw plus the head
   turn, and their own pitch) is blended in with a smoothstep weight
   `smooth(k/blend)·smooth((length−k)/blend)` over `blendTicks` (6) ticks at
   each end. While the track has the whole view (weight 1), the player's own
   angles are re-anchored to the chart nearest the track's. Without that, after
   the loop's 360° of pitch the blend out would spin the view back round.
4. **Write the animation** (`splineAnimation`):
   - **Position:** the eye path as a `LinearSpline`, resampled to equal arc
     steps. Progress then means the same whether the client reads alpha by arc
     length or by point index. Progress keyframes are every second tick.
   - **Rotation:** keyframes every second tick (0.1 s, over the 0.05 s minimum),
     each converted to the mirrored keyframe frame: `{ x: −pitch, y: 180 − yaw,
     z: roll }`. A fractional `rotationLead` (unset; see 6) would write each
     keyframe's view that many ticks early.

### 2.3 The car body, which an entity cannot turn over

A teleport sets the car's position and yaw only. The rest of its attitude is
drawn by its own bones:
- `wrapTrackBones` wraps every root bone of the compiled car under `track_pitch`
  → `track_roll`, pivoted at the running datum.
- `carAnimation` binds those bones to the actor properties
  `craftmatic:track_pitch` and `craftmatic:track_roll`.
- A body offset (`craftmatic:body_x|y|z`) moves the bricks so they stay on the
  rails while the entity, and with it the seat and eye, sinks to follow the car
  through the loop.

`coasterCarAttitude` takes the yaw from the axle, so it is exact on level track
and holds still through a loop. The pitch runs continuously through ±180 in the
heading's vertical plane, and the roll is what remains.

Properties reach the client **earlier** than the position they were sent with
(`property-ahead-of-position`). Each car's body pose is therefore written
`bodyLag` ticks behind its position (Saga 4.1, Pixel 3.3), interpolated, so the
drawn body turns in step with the drawn car. Before this, the rider's view
filled with their own car's bodywork through every loop on both phones (round
30zs).

### 2.4 What is hidden from the rider

The rider would otherwise see their own body and parts of their own car from
the inside:
- **The player is invisible** while riding (one `invisibility` effect, tagged so
  that any pack's sweep can give it back).
- **The car's posed rider is hidden** for the occupant (`rider_<k>` bones scaled
  0 while `craftmatic:occupied`). Other players still see a seated minifig.
- **The car's lap bar is hidden** for the occupant (the `view` bone,
  `riderViewBricks`). It hides the parts that rise to the rider's chest, centred
  at least `minAhead` ahead of the eye, within the eye's column. On 10303 that
  is the black lap bar (part 35654). Through the loops it crossed the lower third
  of the view as a dark band. Fitting `bodyLag` to it only moved it (round
  2026-10-20b); hiding it removed it on both phones (rounds 20c, 20d). Other
  players still see it.

### 2.5 Per-client timing

`animLag` and `bodyLag` differ by phone. The runtime fingerprints each rider's
client by what the Script API reports, `graphicsMode` and
`clientSystemInfo.maxRenderDistance`, and uses the first `clientTimings` entry
that matches:

| Client | Fingerprint | `animLag` | `bodyLag` |
|---|---|---|---|
| Saga on 1.26.62.1 (default; the user's phone) | anything unmatched | 3 (5.7 on 26.52) | 4.1 (26.52; not re-measured) |
| Pixel 8 Pro on 1.26.62.1 | Deferred, render distance 24 | 2.5 (3.5 on 26.51/26.52) | 3.3 (26.52; not re-measured) |

This is a fingerprint of measured phones, not a model of the cause. An unknown
client gets the Saga's values. A pack built with `debug` logs each client's
fingerprint, so a new phone can be measured and added. The fingerprint does not
see the game's VERSION, and a Minecraft update can move a phone's lag: 1.26.62.1
moved the Saga from 5.7 to about 3 (round 2026-11-19d) and the Pixel from 3.5 to
about 2.5 (rounds 2026-11-19f and 19g), so a phone still on 26.52 now rides ~2.7 (Saga) or
~1 (Pixel) tick ahead of its seat (TODO(coaster-lag-version)).

## 3. Approaches that were tried and replaced

| Approach | What it did on the device | Replaced by |
|---|---|---|
| `clamp`: `setCamera` every tick, pitch within ±90 | Never upside down; the view swung round about 180° at every loop's side ("sideways turn in the loops") | animations |
| `roll`: one animation per loop, keyframes in the ±90 chart | A 180° spin over two keyframes at each zenith and each exit (linear Euler interpolation across the chart flip) | the `over` chart (continuous pitch) |
| `reflect`: per-tick camera with the pitch folded back past ±90 | No spin, but the world stays upright: up to the zenith and back down, never upside down | `loop` |
| `loop`: per-tick `reflect` camera plus one `over` animation per inversion | Upside down and correct, but a camera the server set every tick jerked against the client-interpolated train (worst in cars 2–3), and every drag lagged a round trip | `native` (2026-10-18) |
| `native` playing straight from the own view | The animation was not drawn; the camera stuck at the top of the drop | arming with one `setCamera` |
| Starting the animation from the **reported** yaw | A 35–45° cut at the crest of 10303's drop on both phones (the reported yaw is several ticks old) | drawn car yaw plus head turn |
| Keyframe yaw written as `setCamera` yaw | 60–120° cuts at every drop off the crest curve (the mirror) | `180 − yaw` |
| A train-wide body lag, and Pixel `animLag` 5.5 from a probe | The camera went inside the rider of the car ahead in every first loop (round 2026-10-20c) | per-car body timing; Pixel back to 3.5 |

## 4. How to check a change before the phone

- `bun run test` covers the camera's behaviour in `test/bedrock-coaster.test.ts`
  (the `native mode …`, `over mode …`, `rotationLead …` and `bodyLag …` cases)
  and `test/sim-client.test.ts`. The client model is in
  `web/src/sim/client/camera.ts`: lags, keyframe frame, arming, cut and ease.
- `bun scripts/sim.ts <packs> --scenario=regressions --new=<dir>` re-judges the
  device regressions, and a coaster ride from the simulator renders the frames
  the client model draws (`--fov=` sets the field of view).
- On the device: record the screen and count frames. Read the yaw against
  coloured marker pillars (`python -I scripts/_pillar_yaw.py`), not from log
  lines. Three rounds of lag fixes missed the keyframe mirror because they read
  logs. Record `versionName` in every round.

## 5. Open issues (COAST-06; `TASKS-BEDROCK-ADDON.md` has the current state)

- **The camera grazes the car ahead in the loops.**
  - Saga, car 2: 0.1–0.3 s translucent washes at loop entries.
  - Pixel, car 2, second loop: 0.4–1.3 s inside the rider ahead.

  10303's cars are 2.25 blocks apart, and the eye is 1.12 blocks over the seat,
  so in a loop the rider ahead is about a block from the eye. (Since then every car
  carries a posed rider. On 1.26.62.1 the Saga's grazing was the car BEHIND, from
  the lag change below.)
  The simulator does not reproduce it (2026-11-06, `output/coast06-eye-1106/`).
  The ride step now reports the eye's clearance to the car ahead and the car
  behind (`eyeInsideCoasterCars` on `EYE_CLEAR_LADDER`). At the measured
  property lead 3.3, and at 1.5, 5 and 6.6, car 2 never comes within 0.5 block
  of car 1. At lead 0 it comes within 0.2 block (18 frames), as on the phone,
  but its own body then covers the view (93 frames), which the phone stopped
  showing after round 30zs. One reading is that the client applies the ridden
  car's properties and the car ahead's with different leads. That is a guess,
  not measured.
  `animEyeBack` / `animEyeDown` move the animation's eye back along the nose or
  down along the car's up, weighted by the blend: 0 at the first and last
  keyframes. They are off (0) by default. Until the simulator reproduces the
  grazing, its numbers for them decide nothing: back 0.5 brings the eye within
  0.3 block of another car and breaks `camera-on-own-seat` (-0.54).
  To try a value on a shipped pack:
  `CRAFTMATIC_SIM_COASTER_CAMERA='{"animEyeDown":0.3}' bun scripts/sim.ts <pack>
  --scenario=coaster-camera --runtime=tree --cars=2 --client=pixel [--prop-lead=N]`.
  A ride takes about 19 minutes.
- **The Pixel's hand-back** shows a pale panel for one frame on about half the
  laps.
- **The hand-back race (fixed offline 2026-11-19).** `native` sent its clear on the
  tick of the animation's last keyframe, and the animation itself was exactly that
  long. The client plays an animation in real seconds and the server sends the clear
  on its own clock, so any tick slower than 50 ms during the ~5 s stretch lets the
  animation end first (telemetry on this Saga reads 19.8-20.2 ticks a second over
  20 s windows). Round 19d K then showed 2-4 frames of empty sky with the ground far
  below, no car in view, before the own view returned (`kride2-12fps-73s.jpg` f007).
  Reading those frames as the ARMING camera (set at the crest of the drop, so the
  view from ~33 blocks up) is an inference, not a measurement. `planSection` now
  plans `animTail` (6) ticks past the clear, as `planInversion` always did; the tail
  is the player's own view carried on. A server more than 6 ticks behind over one
  stretch (under ~18.9 ticks a second) would still lose the race.
- **1.26.62.1 changed the Saga's lag (round 2026-11-19d K, fixed offline).** On a
  pack planned at 26.52's 5.7, the drop and both loops were drawn from ~2.7 ticks
  BEHIND the drawn seat: through the drop the grey-haired rider of car 3 (the car
  behind; the round's notes read it as the car ahead) filled the lower half of the
  view at about 1.2 blocks, then the eye passed inside it as translucent washes, three
  episodes of 0.2-0.7 s a lap. On the level track the view was normal, because the
  own view is drawn from the drawn seat. The simulator reproduces this on the device's
  pack with `--client=saga-26.62`: the eye within 0.3 block of car 3 in 74 frames of
  one lap and a 2.1-block cut at the hand-back. Replaying that pack at entity lags of
  1.5, 2.5 and 3.5 (`scripts/sim.ts --entity-lag=`) draws car 3's hair at 0.16, 0.27
  and 0.85 of the frame height through the drop, against the device's 0.42. The width
  goes as one over the distance, and that puts the lag at about 3 (2.9-3.1 within the
  read). The animation has no ease, so 3 is the animation lag; the cockpit's 0.5 then
  leaves 0.75 of the 0.1 s ease played. The default `animLag` is 3. TODO(client-lag-saga):
  a marker run on 1.26.62 would turn this derivation into a measurement.
- **1.26.62.1 changed the Pixel's lag too (round 2026-11-19f K, fixed offline).**
  On the 19e pack (main 0d2fddc9), which planned the Pixel at its 26.51 marker
  reading 3.5, car 2's view passed through a rider twice a lap: in the drop into
  loop 1 (~0.9 s) and in loop 2 (~1.3 s), clear in between. Each episode is a
  yellow translucent wash (the eye passing a yellow face), then a grey head over a
  pink torso, seen from BEHIND at about a block. Car 3 rode clean. The figure
  settles whose rider it is: car 1's rider has pink hair over a yellow face (the
  view ahead on the lift), car 3's has grey hair and a pink torso. The simulator on
  the device's pack (`--client=pixel --cars=2 --entity-lag=N`, `output/pix62/` in
  the gen-pix62 worktree) draws car 1's rider filling the view at 5.3 (eye ahead)
  and car 3's rider from behind at 1 and 1.5 (eye behind), with a clear stretch
  between two episodes as on the phone at 1.5. The eye sits behind car 3's head,
  which is ~2.25 blocks behind its own seat, so the plan was about 2 ticks too
  late. Size: at the first episode's farthest point the head's drawn width is 0.45
  of the frame height at lag 1 and 1.2 at 1.5; the device's frame (`k2a.mp4`
  t 37.90) reads 0.92, or 0.87 after scaling by car 1's hair on the lift (device
  0.194, simulator 0.183 of the frame height, a view no lag moves). Interpolated in
  one over the width, that is an entity lag of 1.4. The cockpit on the same phone
  and version held its eye in the cabin at 40 mph with lag 0.5 (round 19f E),
  which needs entity lag − played ease − 1 = 0.5, so at least 1.5 with none of the
  ease played. The packs of round 19g planned the Pixel at 1.5.
- **Round 19g bracketed the Pixel's 1.26.62 lag from the other side (2026-11-20).**
  On the 1.5 packs (gen-pix62 9c31471b) car 2 of 10303 showed car 1's rider (pink
  hair, yellow torso, the car AHEAD) from behind, swelling in the drop into loop 1
  and in loop 2, with car-colour washes after; car 3 rode clean; in 10261's car 2
  the head of the rider ahead swelled and went translucent (the eye inside it)
  twice a lap. So 3.5 put the eye behind its seat and 1.5 ahead: the lag lies
  between. Measured as the width of car 1's pink hair over the frame height
  (`output/pix62g/pinkwidth.py`, gen-pix62 worktree): the device reads 0.195 at
  the station and 0.34 in the drop (1.76 x), 0.35-0.48 in loop 2 (1.8-2.4 x). The
  simulator on the same pack (`--client=pixel --cars=2 --entity-lag=N`) draws the
  station at 0.183 and the drop at < 1.3 x / 1.70 x / 3.36 x / 8.5 x for entity lag
  1.5 / 2 / 2.5 / 3 (loop 2 1.73 / 2.09 / 2.64 / 6.1 x): one over the width puts the
  lag at 2.0 (drop) and 2.1-2.4 (loop 2). 10261 reads higher: its car 1 rides
  1.25 blocks ahead, and the black hair of its rider grew to ~0.92 of the frame
  height with the eye inside it (`darkwidth.py`), which the simulator draws at
  0.34 / 0.43 / 0.59 / 1.02 for 1.5 / 2 / 2.5 / 3: 2.9. The 19f pack bounds the
  10303 ride from above: the simulator draws its graze into car 3's rider at entity
  lag 1, 1.5 and 2 and none at 2.5, so that ride drew under ~2.3. 19f's size
  reading (1.4) took the head seen from behind as the eye fully past car 3's
  rider; at 2 the simulator's eye reaches into that head, which is what the
  device's yellow face wash just before showed. `--entity-lag` is the client's
  draw lag and `animLag` the plan's guess of it, in the same ticks: an animation
  sits `entity lag - animLag` ticks AHEAD of the drawn seat, so the 19f estimate
  was on the right side of 3.5 but short. One session's rides span ~2.0-2.9 (a
  26.52 camprobe run stepped 0.5-1.9 ticks within a run too), so the Pixel's
  `animLag` became their middle, 2.5. Round 2026-11-20 20c replaced that
  derivation with a measurement (`output/device-round-2026-11-19a/pixel-20c/notes.md`):
  a debug build (`CRAFTMATIC_COASTER_DEBUG=1`) logged that the Pixel entry matched
  and that the plan's per-tick yaws equal the server car's (no drift); a camprobe v9
  marker run read E 3.23 / 3.33 in one session and 3.59 in the next; the 2.5 plan
  drew the FRONT car's rider (10303 runs backwards: `_vehicle_3` leads) growing to
  1.2-1.6 x and 2-3 x in those two sessions, ~3.0 and ~3.3 on the simulator's scale.
  So `animLag` is 3 (`PIXEL_2662_ANIM_LAG`, quirk `client-entity-lag`
  `pixel2662Ticks`, `clientProfile('pixel-26.62')`, which with the cockpit's 0.5
  plays 1.5 ticks of the ease), the low end because the 3.5 plan (19f) rode behind.
  The spread between days is larger: 19f and 19g (2026-11-19/20) rode as ~2.0,
  20b and 20c that night as ~3.0-3.3, so no single value holds every day. Each
  car's posed rider is therefore also hidden while the camera is within
  `neighbourRiderHide` of that car's root (half a car spacing from the seat eye,
  `query.distance_from_camera > D * query.model_scale` on the `rider_k` bones):
  a miss shows the car ahead or behind without the inside of its rider's head.
  That the query follows an animated camera on the device is assumed (quirk
  `rider-hide-camera-distance`, TODO(rider-hide-device)). `bodyLag` stays 3.3, unmeasured on 1.26.62
  (TODO(body-lag-2662)).
  **Pixel round 20d (2026-11-23) refuted both as shipped:** with the timing matched (animLag 3) and
  camprobe E 3.31 in the same session, 10303 car 2 still drew the front rider at 2.2-2.9 x in every
  first drop, under the animation, and the Molang hide never fired. So a lag fit cannot close it.
  The simulator reproduces the first-drop shape only when the cars NO player rides draw their body
  pose without the property lead (`--other-prop-lead=0`: eye 0.2 from the car ahead at ride ticks
  334-423; at 1.5 it passes) - a lead per entity on 1.26.62 is the open lead (TODO(body-lag-2662)).
  Now the runtime itself hides every posed rider of the train while any of its riders is on a set
  camera, and for `NEIGHBOUR_HIDE_TAIL` ticks after (`trainOnSetCamera`, `craftmatic:rider` = the
  none variant): the server knows when it set the camera, so this needs no device query. The Molang
  hide was REMOVED after round 20e passed on the property hide (the expression ships no camera query).
- **TODO(pixel-ride-lag):** a camprobe run on 1.26.52 reads the Pixel's entity
  lag at 5.1–5.4 ticks, yet the coaster planned at 5.5 rode worse than at 3.5.
  The cause is unexplained.
- **TODO(rotation-lead):** whether a client applies an animation's rotation
  later than its position is unmeasured. `rotationLead` exists and is unset.
