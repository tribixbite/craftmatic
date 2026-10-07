# Craftmatic — product spec (from the user's own requests)

This spec states what Craftmatic must do, in the user's terms. It was compiled
on 2026-10-07 from every prompt the user typed into an agent for this project:
229 prompts from 2026-06-08 to 2026-10-07 (Claude Code 176, Codex 52,
Antigravity 1), plus 51 typed in the HotSchem repo before its Bedrock work
moved here on 2026-09-12.

**[REQUIREMENTS.md](../REQUIREMENTS.md) is the companion checklist.** It holds
one row per requirement, with:
- a status;
- the automated checks that guard it;
- the last time it was confirmed on a device;
- what is still missing.

Ids in this document (`VEH-06`, `SEAT-01`, …) refer to those rows. This
document explains what the product should be; the checklist records whether it
is.

## 1. What Craftmatic is for

1. **Any LEGO set, rendered right.** Search for a set or upload a file and
   get a near-photo-accurate, solid, brick-by-brick 3D model, with a layer
   slider. Every piece must be the right colour, shape and position. The bar is
   the box art and Mecabricks, and it is measured, not eyeballed (`VIEW-01`).
2. **Any LEGO set, playable in Minecraft Bedrock.** The set becomes an add-on
   that a five-year-old can place, explore and play with:
   - walk through its doors;
   - sit in its seats;
   - drive and fly its vehicles;
   - ride its coasters, slides and lifts;
   - meet its minifigures walking around.

   The stated top goal is "an extremely fun UX for driving LEGO vehicles in
   Bedrock" (`VEH-14`). The reference player is the user's five-year-old
   (`VIEW-18`).
3. **Also:** Java schematic export (§10), PDF-instruction reconstruction for
   sets that have no digital model (§11), and a growing corpus kept current as
   new sets release (§9).

The long-term direction is in [ROADMAP.md](../ROADMAP.md): a universal LEGO
pipeline with a physical-validity verifier, and an offline walker that grows
into its own web game engine (`SIM-04`).

## 2. Principles the user has set

- **Prefer unlocking to restricting.** Invisible geometry that lets the player
  move or interact is good. An invisible wall that blocks the player without a
  reason is a bug. When there is a trade-off, choose exploration and
  interactivity without asking (`IX-04`).
- **Minifig = player.** At 100 % a minifigure is as tall as a player, and
  anything a minifigure can use (doors, chairs, cockpits) the player can use
  too (`SCALE-01`, `SCALE-04`, `SEAT-03`). Scaling a model up never turns its
  minifigures into giants (`SCALE-03`).
- **Fidelity is not traded away.** The in-game model should look like the web
  render. Capacity or LOD work must not degrade close-up quality (`FID-01`,
  `FID-02`, `FID-03`).
- **Use the set's own parts.** The coaster rides on its own LEGO cart, not a
  fabricated stand-in (`COAST-04`). Doors are the set's own doors (`DOOR-01`).
- **Generalise.** Fix a class of defect across every set and every source
  format, not one set by hand. Check other models for the same defect
  (`IX-02`, `VIEW-17`, `PROC-14`).
- **Evidence, not claims.** "Done" means measured, rendered and looked at, or
  confirmed on the device. A green offline gate is not proof that something
  works on the phone (`PROC-06`, `DEV-02`).

## 3. Vehicles (`VEH-*`)

The player must be able to drive every car, fly every aircraft and sail every
boat in a set, and the vehicle should feel fast and fun.

- **Facing.** A mounted vehicle faces forward, with its nose ahead of the
  rider. This regressed twice (180°, then 90°), so it is checked on the device
  every round (`VEH-01`).
- **Free camera.** The camera is never locked. The rider can look around while
  driving; when they stop moving the camera, it eases back behind the nose,
  pointing the way the vehicle travels (`VEH-06`).
- **Seeing out.** The rider always sees the world outside. The body of a car
  must not block the view (`VEH-07`).
- **Steering.** A mounted vehicle can be turned, with good touch UX (`VEH-02`).
  Jump means "get off", so no control may depend on jump while mounted, and a
  boost must use something else (`VEH-03`).
- **Flight.** Flying works like a spaceship, not a flight simulator. The
  player can thrust forward and back, go straight up and down, hover, and fly
  backwards (`VEH-04`, `VEH-05`).
- **Never stuck, never through walls.** A vehicle climbs or slides off small
  obstacles and never gets pinned by hills or blocks. It also never passes
  through solid model geometry (`VEH-08`).
- **Durable.** Vehicles do not vanish when they crash (`VEH-10`).
- **Mounting what you hit.** Driving or flying into a free seat (a coaster car,
  chair or slide) mounts the player in the front-most free seat. The vehicle
  left behind hovers or lands (`VEH-12`).
- **Main vehicle only.** The pipeline detects a set's primary vehicle, and the
  UI offers to place only that vehicle (`VEH-13`).
- **Set-specific behaviour.** Behaviours unique to a set, such as the
  DeLorean's time jump or Batcave screens, are welcome extras (`VEH-11`,
  `VEH-15`).

## 4. Seats and cockpits (`SEAT-*`)

- **In the seat.** The player sits IN the cockpit or seat, never on top of the
  vehicle, outside it, or sideways. This was reported 8 times, the most of any
  in-game defect (`SEAT-01`). The driver's eye must see out (`VEH-07`).
- **Every seat.** Any seat a minifigure could use can be used by the player:
  cockpits, chairs, beds and benches (`SEAT-03`, `SEAT-04`).
- **Getting off.** Leaving a seat puts the player on walkable floor: never
  inside a wall, never falling, never trapped in the seat (see `SEAT-05` in the
  checklist).

## 5. Doors, interactivity and collision (`DOOR-*`, `IX-*`, `COL-*`)

- **Doors.** Doors look like the model's own doors, open and close, and the
  player can physically walk through an open doorway. The user marked this
  CRUCIAL. A door fits its frame at the model's scale (`DOOR-01`, `DOOR-02`).
- **Other interactions.** Windows, hatches, levers and turnable mechanisms
  work. Elevators lift, and slides carry the rider down the drawn chute
  (`IX-01`, `IX-03`). All of this comes from an automated pipeline, not
  per-set hand work (`IX-02`).
- **Colliders.** The collision shape matches the drawn model at every scale.
  There are no invisible floors, walls or planes, and tests cover 100 to 400 %
  (`COL-01`). Clearance is widened only where the gain is certain (`COL-02`).
- **Visibility.** A placed model never vanishes as the camera turns (`COL-03`).

## 6. Scale and the brick wand (`SCALE-*`, `WAND-*`)

- **No commands needed.** A held "brick wand" item places a set: no slash
  commands, everything through in-game UI (`WAND-02`). On first use it goes
  straight to "follow my aim". The menu appears once there is a preview, with
  Place at the top (`WAND-03`).
- **Preview.** The preview shows the model's real shape and rotation, and the
  model can be rotated and resized in game (`WAND-01`). A placed model appears
  at once, or a progress indicator shows (`WAND-04`).
- **Scale choice.** The suggested scale makes doors real doors; icons and
  architecture sets often need 150 to 400 %. The player can override the
  suggestion in the wand (`SCALE-02`). Scaling must never break up and down
  movement (`SCALE-05`).
- **Minifig creator wand.** A separate wand builds a custom minifigure in game
  (`WAND-06`).

## 7. Figures (`FIG-*`)

- **Complete figures.** Head, torso, arms, legs, hair and accessories are all
  present and attached. Hair never floats (`FIG-02`, `FIG-03`). Faces are
  accurate, with no missing, mangled or unclosed faces (`FIG-04`). Prints and
  colours are right (`FIG-06`).
- **Behaviour.** Figures stand where the set puts them: seated riders seated,
  goblins behind the counters (`FIG-05`). They walk around with decent AI and
  never float (`FIG-01`). Mini-dolls are figures too.

## 8. Coasters, rides and pinball (`COAST-*`, `PIN-*`)

- **Rideable track.** The coaster's track is complete and rideable, using the
  set's own cars (`COAST-01`, `COAST-04`). The physics is real: slow up the
  lift, fast after the crest, and a pause at the station. The tested gravity
  sets the speed (`COAST-02`, `COAST-03`).
- **No impossible motion.** Cars never tip, swivel or blip in ways the track
  could not cause (`COAST-05`).
- **Rider camera.** The camera follows the track through upside-down loops,
  without being fully locked, without stutter, and without a sudden sideways
  turn (`COAST-06`). This was reported 7 times.
- **Second car.** A second car waits in the station and leaves when the first
  is halfway round (`COAST-07`).
- **Shared engine.** One track and car engine serves every coaster and train
  (`COAST-08`). It is documented in a physics spec that cannot go stale
  (`COAST-09`).
- **Pinball (11374).** The set is playable:
  - left half of the screen = left flipper, right half = right flipper, with
    large buttons;
  - pulling the plunger back further gives a stronger launch;
  - a closer camera, with no overlay artefacts (`PIN-*`).

## 9. In-game rendering, performance and packaging (`FID-*`, `PERF-*`, `PACK-*`)

- **Rendering.** Studs are round. Each colour shows as itself. There is no
  tearing, no strobing colours and no vertical lines. The LOD switch happens
  far away (`FID-*`).
- **Capacity.**
  - More than about 10 high-quality sets must not run Minecraft out of memory
    (`PERF-01`).
  - The intended architecture is a shared LEGO part library plus small
    per-set instructions (`PERF-02`).
  - Measure the real device ceiling (`PERF-03`).
- **Packaging.**
  - The pack name shows the export pipeline's version (`PACK-01`). Commit
    before generating packs (`PACK-02`).
  - A device round is handed over as ONE zip, with paths and hashes
    (`PACK-03`).
  - Opening a newer `.mcaddon` updates the installed pack (`PACK-04`).
  - The web app exports a working add-on from every source format, on the
    live site (`PACK-05`).

## 10. Web viewer, sources, schematics and PDF (`VIEW-*`, `SRC-*`, `SCHEM-*`, `PDF-*`)

- **Viewer.** Parts never float, overlap, explode or appear misoriented, and
  none are missing. This was the most repeated viewer complaint, at 12 asks
  (`VIEW-02`, `VIEW-03`).
  - Search covers names, multiple terms, sort and filters (`VIEW-11`).
  - Only one model loads at a time (`VIEW-08`).
  - Mobile quality matches desktop (`VIEW-10`).
  - Models are never mirrored relative to the box art (`VIEW-06`).
- **Sources.** Search every channel exhaustively for missing models
  (`SRC-01`) and onboard new sets end to end (`SRC-02`). Never overwrite a
  better production source with a reconstruction (`SRC-05`).
- **Schematics.** Resolution is high and the axes undistorted. The full block
  vocabulary is used: stairs, slabs, doors and so on. Colours are correct in
  external viewers, and file names look like `Colosseum-10276.schem`
  (`SCHEM-*`).
- **PDF reconstruction.** The pipeline is deterministic and code-only. A VLM
  helps build and verify it but never runs at runtime (`PDF-02`). The
  placement-accuracy target is 90 to 95 % or better (`PDF-04`).

## 11. Offline QA before the phone (`SIM-*`, `CON-*`)

- **Walker.** A web walker lets anyone walk, interact with and inspect a built
  add-on. It shows what the pack looks like in game, with toggleable collider
  and overlay views (`SIM-01`, `SIM-02`).
- **Simulator.** The headless simulator runs the shipped scripts and replaces
  most phone rounds (`SIM-03`).
- **Operator console.** It exposes every pack, grading and check operation,
  for one set or a batch, and is reachable from a phone on the LAN (`CON-*`).

## 12. How agents work on this project (`PROC-*`, `DEV-*`)

These rules live in CLAUDE.md and the user's global instructions. They are
listed here so the spec is complete.

- **Trackers and checklist.** Trackers and docs must let a fresh session
  resume after every turn. Prune; don't append (`PROC-01`). Every request goes
  into REQUIREMENTS.md (`PROC-15`).
- **Models.**
  - Fable for hard planning and architecture.
  - Opus for code.
  - Sonnet for adb and log reading, never for audits or edits (`PROC-02`).
- **Device work.**
  - adb goes through a subagent (`PROC-03`).
  - Test in the fresh world the user names, with only the packs under test
    (`DEV-01`).
  - Verify on the device yourself (`DEV-02`).
  - Leave the phone as you found it.
- **Working style.**
  - Work autonomously and don't stop early (`PROC-04`).
  - Audit work handed over by another agent before trusting it (`PROC-05`).
  - Look at the render yourself (`PROC-06`).
  - Push craftmatic freely (`PROC-07`).
  - Never run a recursive delete without approval (`PROC-11`).
- **Order of attack.** Use the 40 favourite sets as the priority population
  (`DEV-04`). Sweep them offline before any device round (`DEV-05`).
