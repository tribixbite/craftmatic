# The headless Bedrock simulator (`web/src/sim`)

A simulator that loads a built `.mcaddon` **exactly as shipped**, runs its
behaviour-pack scripts **unmodified** - every script of the pack in one
context - against one mock of the `@minecraft/server` API, over the pack's own
world (its `.mcstructure`, its collider block forms, its entity definitions),
drives a player with the touch semantics the phones measured, and runs
scenarios with invariants checked every tick. Its purpose: most add-on bugs
are caught in seconds on this machine instead of an adb round on a phone.

It is written as an ENGINE from day one. The user's direction (2026-09-29):
"Keep it modular and DRY. Eventually when enough aspects are built this will
become its own standalone game engine for a web-app next gen reimagining of
minecraft." The core knows nothing about craftmatic; everything
craftmatic-specific lives in `web/src/sim/adapters/craftmatic/`.

```
bun scripts/sim.ts <pack.mcaddon | dir>…                 # child play over every pack
bun scripts/sim.ts <packs> --md=out.md --json=out.json   # with reports
bun scripts/sim.ts <packs> --shots=<dir>                 # plus first-person PNGs
bun scripts/sim.ts --scenario=regressions --new=<dir>    # the device-bug regression set
bun scripts/sim.ts <packs> --scenario=vehicles             # every scripted vehicle on the stuck course + controls + free look
bun scripts/sim.ts <packs> --scenario=my-scenarios.ts    # your own scenarios
bun scripts/sim.ts --scenario=hop --coaster=<10261> --flyer=<nimbus> [--car=<42639>|same] [--slide=<10788>]
                                                         # several packs in ONE world: the hop
```

## Where it sits: the tiers of evidence

| tier | tool | answers | cost |
|---|---|---|---|
| 1. validators | `_mcaddon_check.py`, `_ix_passability.ts`, `_render_fault_audit.ts`, the physics spec check | is the pack well-formed; is the MODEL passable over its shipped collider grid | seconds, per pack |
| 2. **simulator** | `scripts/sim.ts` | do the pack's SCRIPTS do the right thing when a child plays: place, tap, ride, drive, fly, walk the doors, let figures live, Undo - with every runtime running together | ~1-10 s per pack |
| 3. GameTest | `web/src/engine/gametest-pack.ts` on the Pixel | the real engine's physics, spawning and scripting, unattended | a device session |
| 4. short tap round | adb on the phones | what only a person sees: rendering, culling, form text, camera feel | a device round |

Run the simulator before building a round. A finding it cannot settle (a
quirk marked `device-only`, an `unknown` scenario) is what the GameTest or
the tap round is for, and the round's findings come back as quirks and
regression scenarios (below).

First-person raster snapshots use the exporter's measured collision-box
draw-distance policy and full 3-D eye-to-actor-root distance. Horizontal
distance alone is wrong for tall shells whose roots sit above their roofs.
This policy remains an estimate from the documented 100% device measurements;
it does not prove scaled actor visibility or reproduce every graphics setting.
The interactive Walker's full model view is a separate rendering surface.

## Architecture

```
web/src/sim/
  core/        vec (frame, rays, boxes) · engine (world, entities, players, systems, events)
               timeline (what the game says, with its source script) · simulation (a ready world)
  world/       voxel-world (chunked blocks, loaded area, collision query) · block-types (pack block
               JSON, permutations, vanilla shapes) · molang (permutation conditions) · nbt · mcstructure
  entity/      definitions (entity JSON, refusals, groups, events, properties) · entity (state, riding)
  physics/     body (THE per-tick integrator: tickPlayer, tickBody, moveBox) · systems (players,
               hover mounts, mobs, riders, effects, falls)
  input/       controls (stick, jump, sneak) · touch (tap = hit, hold = interact, item use) · ray
  script-host/ host (the mock, the tick) · facades (Entity, Player, Dimension, Block, components)
               module-loader (all scripts in one context) · scheduler · commands · ui-module (forms)
               unmodelled (the honesty guard) · api-catalog (GENERATED) · text
  quirks/      registry (device-measured facts with evidence)
  scenario/    types (the step language) · runner · invariants · approach (where to stand) · report
  render/      rasterizer (z-buffered quads → RGB)
  pack/        pack (.mcaddon → packs) · json (literal-preserving JSON) · script-config (CONFIG reader)
               fixture (a pack built in memory: one runtime and its definitions, for tests and probes)
  adapters/craftmatic/
               pack-facts · wand (place, undo) · play (rides, vehicles, flyers, doorways, figures)
               child-play (the generated scenarios) · regressions (the device-bug set)
               hop (several packs in one world: fly or drive into another mount)
               appearance (the pack's drawn geometry) · drawn · snapshot
               fixture (the collider kit's shipped block JSON) · figure-life (figures.js over a
               pack's collider cells: the roam census) · coaster (a coaster config's entities and
               placement, for the coaster tests and replay probes)
```

The runtime tests run on this engine too: `test/_sim-host.ts` (`simHost`)
loads ONE serialised runtime as a fixture pack with its definitions and
drives it tick by tick - the vehicle, rides, flyer, driver, cockpit camera,
coaster, pinball, interactives (`test/_ix-host.ts`), placement wand
(`test/_placement-host.ts`), Minifig Creator wand, figure-life and HotSchem
tests all do. There is no other mock of `@minecraft/server` in `test/` or
`scripts/` except the GameTest harness's (below, `TODO(sim-gametest)`).

**Dependency rule.** Nothing under `web/src/sim` imports `web/src/ui` or the
DOM. The core (everything outside `adapters/`) imports nothing of craftmatic
except two generic utilities it has not yet taken over (`engine/zip-utils.ts`;
`TODO(standalone)` in `pack/pack.ts`). The adapter may import craftmatic's
engine (`bedrock-placement-pack`, `bedrock-interactives`, `cockpit-seat`,
`bedrock-geometry-faces`, `interactive-walk`). The walk preview now imports
FROM the simulator (`addon-walk.ts` re-exports the integrator,
`ui/addon-appearance.ts` and `ui/addon-preview-data.ts` re-export the moved
readers), not the other way round.

**One collider world.** The doorway harness and the walk preview
(`engine/addon-walk.ts` `WalkWorld`) keep the re-laid grid in a `VoxelWorld`
whose terrain IS that grid (materialised section by section as a walk first
reads it) over the ground below the pin plane, with the collider kit's own
block JSON (`colliderBlockDefinition`, now in `engine/collider-form.ts`) read
by `BlockTypes` - so a form's boxes come from one reader of one definition
for the harness, the preview and the simulator, and `solidsNear` is the
voxel world's. The harness's jump rule (`jumpHelps` / `boxFree` in
`interactive-walk.ts`, over any `SolidQuery`) is the one the device lines
use. What differs is the CONTENT, on purpose: the harness walks the grid the
shipped arithmetic re-lays, the simulator the blocks the runtime laid; a
disagreement between them is a pack fault.

**The tick.** `SimEngine.step()` runs its systems in order: loading (the
chunk columns around players and inside ticking areas) → players → hover
mounts → mobs → riders → effects → scripts (after-events, then due
`run`/`runTimeout`/`runInterval` callbacks and jobs, then every promise the
tick started). A new behaviour is a new system (`engine.addSystem`), never an
edit of the loop.

### Public APIs, by module

- `core/simulation.ts` `Simulation`: `loadAddon(addon)`, `loadAddonBytes(bytes)`,
  `addPlayer(name, at, items)`, `run(ticks)`, `runSync(ticks)`, `reloadScripts()` (a world
  reopened: fresh script context, same world), `itemIds()`; `.engine`, `.host`, `.controls`.
- `core/engine.ts` `SimEngine`: `loadAddon`, `addSystem`, `on`/`emit` (engine events:
  `entityHitEntity`, `playerInteractWithEntity`, `itemUse`, `scriptEventReceive`,
  `entitySpawn`, `entityRemove`, `entityLoad`, `landed`, `dismounted`), `step`/`run`,
  `stepSync`/`runSync` (no await per tick: synchronous runtimes), `dimension(id)`,
  `spawnEntity(type, dim, at, id?)`, `addPlayer`, `removeEntity`, `loadedEntities`;
  `.timeline`, `.structures`.
- `core/timeline.ts` `Timeline`: `add`, `of(kind)`, `callerSource()`, `unmodelled(member)`,
  `unmodelledRanking()`.
- `world/voxel-world.ts` `VoxelWorld`: `rawId`, `permutationAt`, `setPermutation`, `shapeOf(id)`,
  `shapeAt`, `isLoaded`, `setAllLoaded` (a world with no loading rule), `solidsNear` (the
  physics' `SolidQuery`), `overlapping`, `supportBelow`, `onWrite`; `flatTerrain(groundY)` (the
  QA worlds' superflat, standing height -60); a `TerrainGenerator` may be `verticalOnly` or
  `materialiseOnRead` (a world read from another model, filled a section at a time).
- `pack/fixture.ts`: `fixturePack`, `fixtureAddon`, `entityDefinition`, `entityFilePath`.
- `world/block-types.ts` `BlockTypes`: `addDefinition(path, json)`, `shape(typeId, states)`.
- `entity/definitions.ts` `EntityDefinitions`: `load(path, text)` (refusing as the game does);
  `entity/entity.ts` `SimEntity`: `triggerEvent`, `addGroup`/`removeGroup`, `rideable()`,
  `addRider`, `removeRider`, `seatWorld`, `placeRiders`, `collisionSize`, `aabb`, `physics`.
- `physics/body.ts`: `tickPlayer`, `tickBody`, `moveBox`, the constants (physics spec §12).
- `input/touch.ts`: `tap`, `interact`, `pick`, `lookAt`, `aimPoint`, `useItem`;
  `input/ray.ts`: `raycastBlocks`, `raycastEntities`, `pickBoxes`.
- `script-host/host.ts` `ScriptHost`: `loadScripts(addon)`, `reloadScripts(addons)`,
  `builtin(name)`, `deliver`, `before`, `entity(sim)`, `simOf(api)`, `dimensionApi(id)`,
  `resolvePermutation`, `playerState`, `scriptNow()` (a script's `Date.now()`); `.chooser`
  (answers forms), `.scheduler`, `.stats` (sounds and particles); options `scheduler`
  (`ticks` / `immediate`), `seed`, `timeOfDay`, `chooser`, `wrapMath` (instrument the
  scripts' `Math`), `absentExports` (exports an older client lacks).
- `scenario/runner.ts`: `runScenario(scenario, addons, options)` → `ScenarioResult`;
  `CORE_HANDLERS`, `findEntity`. `scenario/report.ts`: `markdownReport`,
  `regressionMarkdown`, `unmodelledTotals`.
- `quirks/registry.ts`: `quirk(id)`, `quirkValue(id, key)`, `allQuirks()`, `deviceOnly(area)`.
- `render/rasterizer.ts`: `rasterize(quads, paint, camera)`.
- `adapters/craftmatic`: `readCraftmaticPack`, `wandHandlers`, `playHandlers`,
  `craftmaticHandlers`, `childPlay`, `childPlayScenarios`, `REGRESSIONS`,
  `hopHandlers`, `hopCases`,
  `packAppearance`, `drawnBoxes`, `forwardViewWorld`, `firstPersonSnapshot`, `renderActors`,
  `colliderKitFiles`, `simulateFigureLife`, `coasterEntityTypes`, `coasterPlacementEntities`,
  `coasterScriptConfig`.
- `test/_sim-host.ts` (tests and probes): `simHost(options)` → spawn, addPlayer, seat,
  controls, setBlock/fill, run/runAsync/runUntil, reload, lines, errors; strict by default (a
  script error, an unmodelled member or a refused definition throws).

## Scripts: one context, unmodified

`ModuleLoader` evaluates the manifest's entry (`scripts/main.js`) and, through
it, every script it imports, each ONCE, in import order, in ONE context - so
two runtimes that write the same action bar or read each other's entities
meet as on the device (the Nimbus hint that `vehicle-driver.js` overwrote four
ticks after `flyer.js` showed it is caught only this way). The only rewrite is
of the `import`/`export` statements. Every module carries
`//# sourceURL=pack://<pack>/<path>`, so every line the game says and every
unmodelled call is attributed to the script whose code made it.

Determinism: a script sees the real globals except `Math` (seeded `random`),
`Date` (the engine clock: a fixed epoch + 50 ms per tick) and `console`
(captured to the timeline). The same pack and scenario give the same trace.

## The mock, and why "unmodelled" is never "pass"

Every object handed to a script is a facade wrapped by `guard`
(`script-host/unmodelled.ts`). A member the mock implements answers as the
game does. A member the REAL API has but the mock does not implement throws
`UnmodelledError` and is recorded - even when the script catches the throw,
the record stands. A name the real API lacks reads `undefined`, as on the
device (a feature probe `entity.newThing?.()` is not reported).

Which names are real comes from `script-host/api-catalog.ts`, GENERATED from
the published typings of the versions the packs declare:

```
# unpack @minecraft/server 2.9.0 and @minecraft/server-ui 2.1.0 from the npm registry, then
bun scripts/_sim_api_catalog.ts <server/index.d.ts> <server-ui/index.d.ts>
```

Regenerate it when the packs' manifests move to a new module version. An
export the mock lacks is importable (as on the device) and throws when used;
the catalog's enums are provided as name → name (`TODO(sim-api)`: numeric enums).

A scenario that reached any unmodelled member ends `unknown`, never `pass`.
The run's **unmodelled ranking** (the markdown report's last table) is the
simulator's roadmap: implement the most-used member first.

## The quirk registry

`quirks/registry.ts` holds every device-measured fact the engine applies, as
`{ id, rule, evidence, appliesTo, simulated, values?, gap? }` - the evidence is
a round folder, a commit or a doc section with its date. Modules read their
numbers from it (`quirkValue('hover-controller-speed', ...)`) and name the
quirk they apply in a comment. `simulated` is `modelled`, `partial` (with its
`gap` stated) or `device-only`: camera roll by animation only, the client's
3.5-tick entity lag, box-UV faces that floor to nothing, coplanar hatching -
things this engine cannot show. A scenario that depends on one reports it
rather than passing it.

Adding a fact: a row with its evidence, then the module reads it. Changing a
number because a round re-measured it: change the row and its evidence, run
`bun run test` (the regression set re-judges every case).

## Scenarios

A scenario is data (`scenario/types.ts`): a list of steps and the invariants
to check each tick (default: all core ones).

Core steps: `wait`, `teleport`, `look`, `walkLine` (a straight walk with
`maxDrop` / `arriveWithin` checks), `tap`, `hold`, `rideUntil`, `drive`,
`sneak`, `jumpHold`, `useItem`, `expect` (any check of your own). A `tap` or
`hold` first stands the player where a tap would pick the target
(`scenario/approach.ts`); no such spot is a `tap-target-reachable` violation.

Core invariants (`scenario/invariants.ts`): `player-not-in-solid` (2 ticks'
grace for a teleport's set-down), `no-unprotected-fall` (over 3 blocks
without slow falling), `nothing-below-ground` (fell through the world),
`no-script-error`, `no-content-log-error` (refused definitions),
`no-unexpected-line` (chat / action bar / console lines that read as faults,
unless the scenario allows them), `actionbar-not-stolen` (another script
replaced a line within a second, unless the player got off something, or
changed mount, in between - a line shown in the tick of the change is the
old mount's). A step may `quiet([...])` invariants while it does something they
would flag on purpose (a device line that starts in the air).

Craftmatic steps (`adapters/craftmatic`): `place` / `undo` (the wand, read
like a child reads it; Undo checks the placement's box block for block and
every entity the placement tagged), `tapInteractives`, `doorwayLines`,
`tapPartFrom` (a device round's tap replayed: `{ label, feet, at }` in blocks
from the placement's anchor, the device's pinned corner; a tap that does not
move the part is a `tap-in-plain-view` violation carrying the refusal
record), `rideSlide`, `rideLift`, `driveVehicle`, `driveUnderFixture`, `flyMount`,
`figuresLive`, `visitSeatedFigures`, `snapshot`;
the hop's (`adapters/craftmatic/hop.ts`): `mountSpawned`, `fillTrain`,
`flyIntoTrain`, `slideIntoParked`.

### Adding a scenario

```ts
// my-scenarios.ts - run with: bun scripts/sim.ts <packs> --scenario=my-scenarios.ts
import type { Scenario } from '../web/src/sim/scenario/types.ts';
import type { CraftmaticPack } from '../web/src/sim/adapters/craftmatic/pack-facts.ts';

export function scenarios(pack: CraftmaticPack): Scenario[] {
  return [{
    name: 'first-door-at-200',
    steps: [
      { kind: 'place', size: 200, rotation: 90 },
      { kind: 'doorwayLines', only: [0] },
      { kind: 'expect', label: 'door-open', check: ctx => ctx.find({ where: e => e.dynamic.get('craftmatic:ix') === 0 })?.dynamic.get('craftmatic:ix_open') === true ? undefined : 'Door 1 did not open' },
      { kind: 'undo' },
    ],
  }];
}
```

A device bug becomes a REGRESSION CASE (`adapters/craftmatic/regressions.ts`):
its evidence, the pack the device ran, the stem of a current build, the
scenario and a `judge` that says whether a result shows the fault. The case
must reproduce on the old pack and pass (or reproduce, attributed to the
model) on a current build; one that cannot reproduce says what the engine
lacks in `limits`, and is never tuned to the answer.

## Child play (`adapters/craftmatic/child-play.ts`)

For every craftmatic pack: `place-<size>-<turn>` at 100 % and 150 % (when its
blocks resize) and turns 0 and 90 - tap every moving part (from another spot
when the part refuses a tap from behind its wall), walk every doorway's device
lines from both sides, Undo; and `play-100-0` - ride every ride by a tap,
drive every vehicle 30 s (under the model's overhangs, then a course) and sneak
off, summon and fly a flyer mount and sneak off in the air, let the figures
live 5 simulated minutes, visit the seated ones (they yield and retake),
Undo. A flyer's cloud is a vehicle type the placement never places (it is
summoned), so it is flown by `flyMount` and not driven; a figure on a mount
(the companion on its orbit, a seated figure) is where its mount takes it
and is left out of `figures-stay` (both fixed 2026-09-30: the Nimbus
fixture's play had stopped at "no craftmatic:dragonball_cloud" and then
flagged the orbit running outside the model).

**Doorway attribution.** The lines walk the HARNESS's doorway
(`doorwayGeometry` in interactive-walk.ts: the columns of the leaf's closed
blocks at the size and turn, the doorway's floor the lowest closed bottom, the
walk's normal) and jump where a jump helps (the harness's `jumpHelps` rule: blocked
at the feet a short reach ahead, free a jump up). A device line (the harness's
start, and a "porch" start 2.5 blocks out at the doorway's height - the
device's teleport into the air) that falls past a jump at the leaf, or stops
before crossing, is attributed: the MODEL's when the model draws no floor at
the doorway's level where the feet lost it (a fall), or draws geometry within a
collider's superset slack of the box (a stop); otherwise the PACK's (its
colliders disagree with what the model draws). What "the model draws" means
for the colliders: the static actors AND every moving part that is not a
passage (window, cabinet, lever, turnable, hinged section) at its closed pose,
never figures; a turned cube is read by its own shape (`DrawnBox.solid`,
`drawnReaches` / `drawnTopOver`), not its corner box, which holds air beside
it (a baseplate turned 45 degrees is a diamond in a square, 2026-09-30). Above 100 % the slack widens horizontally by the re-lay's shift
(`relayRounding`: a column belongs to the cell holding its centre, half a block
at 150 %), and a fall where the drawn floor itself ends within that shift is
the model's edge moved (RELAY). A stop the pack is blamed for is a violation
only when NO line from that side of the doorway crosses: a child steers through
a doorway, and the harness judges passability by a route and holes by its
lines. A tread (`bedrock-collider-scale.ts`) in the way is named as such.

Triage of the first favourites run (2026-09-30, 66 raw doorway findings on
the `449abd0e` packs; each change applied on top of the one before, so a count
is what that change removed in this order): jumping where a jump helps 12
(treads and risers a child hops: all four of 10326's at 150/90), the moving
parts' closed geometry 3 (41395's hinged section), the per-side judgement 31
(edge columns and porch starts of doorways another column crosses), the
re-lay's shift 19 (the doorways among them the harness calls SEALED at 100 %
too: 11371 Doors 1/8, 21318 Door 2, 75397 and 80049's gates, 910004 Doors 2/4),
the harness's doorway geometry 1 (60380 Door 1: its leaf hangs DOWN from the
corner the lines read as its floor). None was a pack fault.

## Hop: several packs in one world (`adapters/craftmatic/hop.ts`)

The hop (web/src/engine/bedrock-ride-hop.ts, physics spec §4.8) is a
behaviour BETWEEN packs - a flyer of one pack flown into a coaster of
another - so its scenarios load several add-ons into one world, every script
of every pack running, as on a phone with a few packs active:

| scenario | packs | checks |
|---|---|---|
| `hop-flyer-into-coaster` | 10261, the Nimbus fixture, 42639 (a third pack with its own `hop.js`) | the 10261 train's lead car's path is recorded for a lap, the fastest point picked; on the next pass the cloud is set 7 blocks off the track and flown onto it timed to meet a car BEHIND the lead: `hop-boards` (on a coaster car), `hop-front-most` (no free car ahead of it), `hop-once` (one hop sound), `hop-camera` (the coaster's camera within 10 ticks), `hop-source-waits` (the cloud still where it was left 2 s later), and the child still aboard 10 s on |
| `hop-coaster-full` | 10261, the Nimbus fixture | a player in every car (`fillTrain`), the same fly-in: `hop-no-full` (nobody hops, nobody is moved) |
| `hop-slide-into-car` | 10788 + 42639, or 10797 alone (`--car=same`: the set's own car) | the car parked a block past the slide's set-down: `hop-slide-into-car` (the rider ends in the car), then drives ahead and in reverse (a note: 10788's slide ends on an upper floor, where 42639's car cannot move; 10797's car drove off 11 blocks) |

The pure contact test and the runtimes on small hand-built packs (a scripted
plane catching a train's rear car and sitting in its front one, hovering where
left; a full train; a figure yielding its chair; two packs owning the plane;
the back-hop cooldown; a car at a slide's foot) are `test/bedrock-ride-hop.test.ts`.
The assumed device facts are quirks `rider-seat-order`, `add-rider-after-eject`,
`aabb-is-collision-box` and `dynamic-properties-per-pack` (the simulator shares
one dynamic-property map between packs; the hop uses tags for anything another
pack reads, so it does not depend on that gap).

## The vehicle course (`adapters/craftmatic/vehicle-course.ts`)

`bun scripts/sim.ts <packs> --scenario=vehicles [--md=] [--json=]`: every
SCRIPTED car, hover craft and ship of each pack (read from its
`scripts/vehicles.js` config) is spawned on the superflat ground away from
the model, the child seated on it, and driven into eight obstacles, each in
its own lane, holding the stick FORWARD and nothing else for up to 10 s - a
one-block step, a hill (a block every two, four high), a two-block kerb, a
three-block wall, a trunk met with the footprint's corner, a three-block
wall at 30 degrees, a two-deep and a three-deep pit (2026-09-30, "it's too
easy to get fully stuck in place by hills / blocks"). A ship runs the course
a second time holding Jump too (the old flight model's throttle; the new
one's "up"). Per obstacle: passed, ticks, ticks pushing without moving, the
height reached, ticks the vehicle's clear band went INTO a block (the band
the runtime sweeps: over a car's step, a ship's whole airframe; 0.1 block of
slack, `CLIP_SLACK`), and after a stop whether backing off, turning on the
spot and driving away moved it 3 blocks. Then `shipControls` (straight up,
hover, forward, straight back, a turn on the spot, back + Jump down, a drag
down then Jump down) and `cameraRecentre` (a 90-degree drag at rest, 2 s at
rest, 3 s driving: the camera's offset from the nose, read from the free
camera's location and facing point).

Violations: `vehicle-not-stuck` (a ship must pass everything; a car or hover
craft all but the three-block wall and the three-deep pit), `vehicle-escapes`,
`vehicle-no-clip`, `ship-controls`, `free-look`. The course quiets
`player-not-in-solid` and `nothing-below-ground` while the child rides (a low
car's seated rider has its feet under the road; the pits are dug under the
flat world on purpose) and judges the vehicle by its own band instead.
Boats (no water lane yet, `TODO(sim-boat-course)`) and native mounts (the
simulator's hover controller is a stand-in) are left out.

What it cannot show: whether a DRAG on the device turns the rider's look on
a lock-181 seat, whether the engine turns a scripted vehicle toward that look,
and how late a carried rider's yaw is (quirk `rider-free-look`): the camera
step moves the rider's look as a drag would and the simulator neither
carries nor turns.

## Calibrating from a device round

A round's telemetry comes back into the engine three ways:

1. **A measured number** (a speed, a lag, a reach) changes its quirk row and
   evidence; everything that reads it follows.
2. **A behaviour the engine did not have** becomes a system or a facade member
   (and the unmodelled ranking tells which first); a regression case pins it.
3. **A bug** becomes a regression case with the round's evidence path; the
   round's own pack is its `oldPack`.

The content log's refusals are already engine behaviour (`entity/definitions.ts`):
a new refusal the log shows becomes a check there.

## Acceptance: the 2026-09-29 regression set

Replay corrections (2026-10-05): `gabby-lift-cap` targets the visible lift
car, as normal child-play does; its invisible internal seat is not a legal
touch target. The old pack still fails boarding and the new car carries all
three trips. `door3-tap-10326` reconstructs the nearest legal standing pose
within the recorded HUD block cell, preserving the original aim point; the
former guessed fractional pose intersected real geometry in the newer
pack. The chosen pose is recorded in the result. If no legal pose exists,
the original supplied point remains the replay. Neither change suppresses
the player-in-solid or tap invariants. An unreproduced old symptom is NOT
TESTED and makes the CLI exit nonzero, regardless of the new pack's result.

`bun scripts/sim.ts --scenario=regressions --new=<current builds>`, run at
`671f0f3c` over packs built from `449abd0e` (`output/sim-regress-449abd0e/`):

| case | pack the device ran | current tree |
|---|---|---|
| 10788 slide rides on its rails (29b) | reproduced: the seat 0.253 over the drawn chute (limit 0.2) | passes: 0.159 |
| 10788 lift car is the shaft cap, rider not carried past the floors (29b) | reproduced: set down under a floor, dropped 1.71 (since the x mirror, 2026-09-30: set down inside `collider_c2`/`collider_w2` on every trip) | passes |
| 10797 car under an overhang falls through the world (29b) | NOT reproduced (see limits) | passes |
| 10797 driver's eye in the bodywork, 0 of 15 rays (29b) | reproduced: 0 of 15 | passes |
| 42639 cockpit view two thirds its own body (30f) | reproduced: horizon 0 of 6 (2 of 15 of the wider fan) | passes: 6 of 6 (`9759f0bf`, `output/cockpit-0930/`) |
| 42639 side panel covers the left ~35 % (30g) | reproduced: sides left 4 of 28 | passes: 28 of 28 (`8aa1425c`, `output/cockpit-fallback-0930/`) |
| 76286 cockpit view inside the hull (30g) | reproduced: horizon 0 of 6 | passes: 6 of 6, the eye over the hull |
| 10788 slide seat: a tap boards nothing (29c) | reproduced | passes |
| Nimbus: sneak off at altitude drops the player (0929) | reproduced: 70.55 blocks without slow falling | passes (slow falling) |
| Nimbus: summon hint overwritten by the driver HUD (0929) | reproduced: after 3 ticks | passes |
| 10326 Door 1 from the porch drops at the door plane (29d) | reproduced, the MODEL's | reproduced, the model's (as expected) |
| 910004 Door 3 walk-out stops before the doorway (29d) | reproduced, the MODEL's | reproduced, the model's (as expected) |
| 10326 Door 3 tap from 1.9 blocks refused "behind a wall" (30h) | reproduced: the line cut in the eyes' own cell, `collider_w10` (a tilted handrail's bounding box) | passes (`99f5090d`: a form the player stands in is not between) |
| 10261 spurious FIGURE_RETAKE_NO_SEAT during placement (29d) | reproduced | passes |

**The driver's view** (`driveVehicle`'s `driver-sees-ahead`) is the
compiler's own seat rule, `driverSeesOut` in `cockpit-seat.ts`: the level
and +5 degree rays straight ahead and 15 degrees either side must leave the
drawn vehicle (`AHEAD`), and 90 % of each side's rays 20-50 degrees off the
nose must meet nothing within a block (`SIDES`, since 2026-09-30). Until 2026-09-30 the guard asked 90 % of the wider 15-ray `VIEW`
fan, which a real bonnet fails (42172: 6 of 15, device-good) and which the
compiler applied to guessed seats only - so a set's own seat was placed by
no view rule and the guard's failures on it were read as its blind spot.
Now every seat is placed by `AHEAD` and judged by it; the wider fan is
reported in the step's note. `bun scripts/_cockpit_view.ts <packs> --out=<dir>`
renders each vehicle's hotbar-9 view offline and prints both scores.

Limits of this set: the slide's margin is small (the drawn slope is coarse;
`TODO(sim-slide)`); where the Saga's 10797 car met its overhang is not
recorded, and neither the model's own overhangs nor a fixture with the host
test's geometry made the old runtime fall - the old ground scan's failing
branch needs a geometry the simulator has not been given.

## Not modelled (yet), and honest limits

- **Rendering, culling, cameras** are device-only (quirk registry); snapshots
  draw geometry and apply the ~70-block draw ceiling only.
- **Vanilla blocks** are a small table (terrain, lights, doors as panels,
  slabs, carpets, plants, liquids); others are full cubes and counted
  (`BlockTypes.unknownVanilla`). Water has no buoyancy or flow.
- **Entity AI** (navigation, behaviours) is not run; only what scripts do and
  `minecraft:physics` gravity/collision. Entities do not collide with each other.
- **Native controllers**: only the hover controller (rotorcraft, flyer) is
  modelled; its server position moves every tick (the device's bursts are not).
- **Riding**: a mob rider's own ride offset is not applied (`TODO(sim-seat)`);
  a player's teleport while riding dismounts (measured for `/tp`, assumed for
  the script call).
- **Touch reach**: the pick is 5 blocks. The Pixel GameTest of 2026-09-30
  (`scripts/_gametest_quirks.ts`, quirk_reach) measured the SERVER's reach for
  a simulated player: a hit (`attack()`) to ~7 blocks in Creative and ~3 in
  Survival, the interact that mounts a seat to ~5 in both; how far a phone's
  own touch pick reaches is not measurable by GameTest, so 5 stays (inside the
  Creative 7). The hold time (10 ticks) is from the pinball rounds. The
  approach (`scenario/approach.ts`) tries every floor from 3 blocks over the
  pick point to 3 under the eye level, aiming from each spot at the pick box
  nearest its eye; after a refusal ("behind a wall") the child steps IN FRONT
  of the part (spots with nothing solid on the line of sight first). Before
  2026-09-30 it tried three floor heights under eye level and found no spot
  for parts lying on the floor (21 of the favourites' tap findings).
- **A player teleported inside a block** falls THROUGH it to the surface
  under its feet and is pushed sideways at 0.1 block/tick toward the nearest
  free side while it overlaps (quirk `teleport-into-floor`, measured by the
  Pixel GameTest of 2026-09-30: never lifted; a 3 x 3 pad gives no push). The
  2-tick pause before the fall is not modelled. A MOB in the same place is
  lifted onto the top on the device; the engine does not lift it. The
  `player-not-in-solid` invariant still reports a player left inside a block
  past its 2-tick grace: on the device that player is falling.
- **Block collision boxes are read MIRRORED in x**, as the device reads them
  (quirk `block-collision-x-mirrored`, Pixel GameTest 2026-09-30): a pack
  built before the fix to `collisionBox` shows its x-banded clearance forms on
  the half of the block the phone put them on, not where the kit meant.
- **Dismount spot** (quirk `dismount-free-spot`, `setDownRider` in
  `physics/systems.ts`): a player that gets off is set on the floor one block
  from the seat ENTITY, trying world (0,-1), (0,+1), (+1,-1), (+1,+1),
  (-1,+1) in that order, a floor within about +0.5 / -1 of the seat entity;
  with none free, at the seat's point 0.2 up. Measured for `ejectRider` and
  `/ride stop_riding` (identical); the rest of the order and the exact floor
  window are guesses (`TODO(dismount-order)`, `TODO(dismount-floor)`); a real
  sneak cannot be sent by a simulated player; a mob rider is left where it
  sat.
- **Before-events** do not enforce the read-only restriction scripts meet on
  the device; **numeric enums** are names.
- **Timing of deferred calls** follows Microsoft's contract, not a device
  probe: a `system.run` from an event handler runs at the end of the same
  tick, from other code in the next (`Scheduler.inEventHandler`); a
  `runTimeout` counts its delay from the same point. `world.afterEvents.worldLoad`
  fires once in the first script tick after the scripts load (and again
  after a reload).
- **Dynamic properties are shared between packs** here; on the device each
  pack sees only its own (quirk `dynamic-properties-per-pack`). A script that
  reads another pack's property works here and not there.
- **Performance** is not the device's: a tick is as fast as the host runs it.

## The older hosts, folded (2026-09-30)

Every hand-rolled `@minecraft/server` mock of the runtime tests now runs on
this engine (`test/_sim-host.ts`): the vehicle, rides, flyer, driver, cockpit
camera, coaster (and the coaster replay / pace / camera probes), pinball,
interactives (`test/_ix-host.ts` and its probes), placement wand (runtime,
ghost, undo across a reload), Minifig Creator wand and HotSchem tests. The
figure census (`engine/figure-life-sim.ts`, a stand-in world with a constant
0.4-block/tick drop) is `adapters/craftmatic/figure-life.ts` on the
simulator's mob physics. The doorway harness shares the collider world and
the jump rule (above, "One collider world"). What a fold still stubs on
purpose is fault injection at the API (a refused teleport, an unloaded block
read, a rider's client-lagged yaw - quirk `rider-yaw-lag` is device-only),
each commented where it is done.

## The GameTest and the simulator: one scenario definition (`TODO(sim-gametest)`)

The one mock left is the GameTest harness's: `test/gametest-pack.test.ts`
fakes `@minecraft/server-gametest` (and the slice of `@minecraft/server` its
runtime touches) to test the harness's decisions with outcomes the test
chooses; `test/gametest-creator-wand.test.ts` runs its wand on the simulator
but still hands the GameTest a hand-made `Test` (real ticks behind `idle`, a
real player behind `spawnSimulatedPlayer`). Running the SAME definitions here and on the Pixel needs the
simulator to provide that module, which the fold did not leave cheap:

- `registerAsync(class, name, fn)` and its builder (`maxTicks`,
  `structureName`, `padding`, `tag`, ... recorded, not applied), and a runner
  that builds the test's arena and runs one test by name;
- a `Test`: `idle(ticks)` (a promise the scheduler resolves), `succeed`,
  `fail`, `getDimension`, `worldLocation`, `worldBlockLocation`,
  `relativeLocation`, `getBlock`, `getTestDirection`,
  `spawnSimulatedPlayer(location, name, gameMode)`;
- a `SimulatedPlayer` (a sim player) with `attackEntity` (a tap:
  `entityHitEntity`), `interactWithEntity` (`input/touch.ts` `interact`),
  `lookAtEntity`, `moveToLocation` / `moveRelative` / `stopMoving` (steering
  the controls at a point: the simulator has no navigation), `jump`,
  `rotateBody`, `setRotation`.

`web/src/engine/gametest-pack.ts` uses `idle` 74 times, `fail` 20,
`succeed` 11, `teleport` 10, `lookAtEntity` / `attackEntity` /
`getDimension` 7 each, `worldLocation` / `interactWithEntity` 6,
`worldBlockLocation` / `spawnSimulatedPlayer` 5, `moveToLocation` /
`stopMoving` / `jump` 3, `moveRelative` / `relativeLocation` /
`getTestDirection` 2, `rotateBody` 1. With them, `bun scripts/sim.ts` runs a
GameTest pack (`scripts/_gametest_pack.ts`) as the Pixel does, the four fake
harnesses of `gametest-pack.test.ts` become simulator worlds, and a device
finding can land as a GameTest and a regression case written once.

## Towards a standalone engine

The seams are already the engine's: a world of voxels with block types from
data, entities from data with component groups and events, one integrator
for every body, systems in an ordered loop, a scripting host over a typed API
surface, input as data, and scenarios as data. What stays to make it its own
package: take over the zip reader and the few geometry helpers the adapter
borrows (`TODO(standalone)`), add a renderer that draws the voxel world (the
rasteriser draws entity geometry only), and move craftmatic's adapter out to
the application that uses it.
