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
bun scripts/sim.ts <packs> --sizes=100,150,200,300,400   # child play at those wand sizes (default 100,150)
bun scripts/sim.ts <packs> --walk                        # taps WALK the child there; lists targets unreachable on foot
bun scripts/sim-gametest.ts <pack> [--only=] [--log=]    # the pack's GameTests, offline, writing the device's CMGT lines
bun scripts/sim-gametest.ts --replay=<log> [--pack=]     # a past device GameTest log, re-derived row by row
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
Snapshots apply each entity's `minecraft:scale` to its final cubes and
bone/cube pivots through the shared `worldFaces` actor transform. Placement
and camera-to-root distance stay in world blocks. A rotated 200-percent
actor matches a model with doubled dimensions in the regression test;
this corrects the old snapshot-only 100-percent geometry limitation without
establishing native scaled culling.

## Architecture

```
web/src/sim/
  core/        vec (frame, rays, boxes) · engine (world, entities, players, systems, events)
               timeline (what the game says, with its source script) · simulation (a ready world)
  world/       voxel-world (chunked blocks, loaded area, collision query) · block-types (pack block
               JSON, permutations, vanilla shapes) · molang (permutation conditions) · nbt · mcstructure
               liquids (water as volumes: surface heights, submersion) · write-log (which blocks were written)
  entity/      definitions (entity JSON, refusals, groups, events, properties) · entity (state, riding)
               dynamic-store (dynamic properties scoped by the writing pack)
  physics/     body (THE per-tick integrator: tickPlayer, tickBody, moveBox; water) · systems (players,
               hover mounts, mobs, riders, effects, falls) · body-systems (the soft push, collidable solids)
  input/       controls (stick, jump, sneak) · touch (tap = hit, hold = interact, item use) · ray
  script-host/ host (the mock, the tick) · facades (Entity, Player, Dimension, Block, components)
               module-loader (all scripts in one context) · scheduler · commands · ui-module (forms)
               unmodelled (the honesty guard, restricted-execution mode) · api-catalog (GENERATED) · text
               enums (the typings' values) · pack-context (which pack's code runs) · gametest-module
               (@minecraft/server-gametest and the test runner)
  quirks/      registry (device-measured facts with evidence)
  scenario/    types (the step language) · runner · invariants · world-invariants · approach (where to
               stand, and the route there on foot) · report
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
               placement, for the coaster tests and replay probes) · gametest-replay (a device GameTest
               log read back and compared) · regressions-world (the regression cases that need water)
```

The runtime tests run on this engine too: `test/_sim-host.ts` (`simHost`)
loads ONE serialised runtime as a fixture pack with its definitions and
drives it tick by tick - the vehicle, rides, flyer, driver, cockpit camera,
coaster, pinball, interactives (`test/_ix-host.ts`), placement wand
(`test/_placement-host.ts`), Minifig Creator wand, figure-life and HotSchem
tests all do. There is no other mock of `@minecraft/server` in `test/` or
`scripts/` except `test/gametest-pack.test.ts`'s injected-outcome fakes (below: the GameTest module itself now runs in the simulator).

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
  reopened: fresh script context, same world), `itemIds()`; `.engine`, `.host`, `.controls`,
  `.gametests` (the GameTests the scripts registered).
- `script-host/gametest-module.ts`: `GametestRegistry`, `createGametestModule(sim, registry)`
  (the simulation registers it as `@minecraft/server-gametest`), `runGametest(sim, def, origin?)` →
  `{ id, status, message, ticks, lines }` (the CMGT lines); `adapters/craftmatic/gametest-replay.ts`:
  `parseCmgt`, `verdictRows`, `compareRows`, `isQuirkLog`, `replayMarkdown`.
- `world/liquids.ts`: `liquidSurface`, `submersion`, `liquidSurfaceBelow`; `physics/body-systems.ts`:
  `installBodySystems`, `pushBodies`, `pushableByEntity`, `isCollidable`, `collidableSolids`,
  `bodyFluid`; `scenario/approach.ts`: `walkRoute(engine, dim, from, goal, refused?)`, `walkEdgeKey`;
  `scenario/runner.ts`: `RunOptions.approach` (`teleport` | `walk`), `tapReachOf(state)`.
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
  physics' `SolidQuery`, collidable entities included through `entitySolids`), `submersion`
  (liquids), `overlapping`, `supportBelow`, `onWrite`, `writes` (a `WriteLog`: one bit per block); `flatTerrain(groundY)` (the
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
export the mock lacks is importable (as on the device) and throws when used.
The generator (2026-10-08) also records each enum's VALUES - a numeric enum
(`InputPermissionCategory.Camera` is 1) hands scripts numbers, a string enum
its ids (`EntityComponentTypes.Rideable` is `"minecraft:rideable"`) - and the
members the typings mark "can't be called / edited in restricted-execution
mode" (`restricted`): a BEFORE-event callback runs in that mode on the device
("Event callbacks are executed in read-only mode"), so in one a restricted
member throws (`executionMode`, quirk `restricted-execution-before-events`);
a script defers the change with `system.run`. Its third input is the
`@minecraft/server-gametest` typings (1.0.0-beta.1.26.52-stable):

```
bun scripts/_sim_api_catalog.ts <server/index.d.ts> <server-ui/index.d.ts> <server-gametest/index.d.ts>
```

**Dynamic properties are scoped by the writing pack** (quirk
`dynamic-properties-per-pack`): each pack's module is evaluated, and every
callback it hands `system` or a `world` / `system` event signal runs, as that
pack's code (`script-host/pack-context.ts`; an `await` continuation is read
off the stack's `pack://<uuid>/` frame), and a script reads and writes its own
pack's values (`entity/dynamic-store.ts`): another pack's reads undefined, as
on the device. The engine's own view (`SimEntity.dynamic` as a Map) holds the
last value any pack wrote, so adapters and test hosts still read and seed it.

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

**Walking there** (`--walk`, `RunOptions.approach: 'walk'`; `TODO(sim-walk)`
closed 2026-10-08): the child is WALKED to the spot instead of teleported.
`walkRoute` plans over the world's collision - stand points per column (the
centre, then the quarter points: a clearance band can take a column's
centre), rises within auto-jump's 1.2, drops within 3, the player's box
passing between two columns at the higher floor (two thin bands on a shared
face are a wall, not a gap: 10326's Door 1 stair) - and `walkTo` walks it
with `tickPlayer` and auto-jump on; an edge the walk could not take (auto-jump
refused a rise the plan allowed: a band in the cell over a step) is refused
on the next plan. A target no spot of which is reachable on foot is recorded
(`state.tapReach`, the report's "Tap targets unreachable on foot" section:
`tap-target-unreachable-on-foot`) and the child is then put on the spot, so
the tap is still tried - never a failure (IX-04: invisible geometry may
unlock, never restrict; the model's own geometry may hide a part from feet).
The world invariant `no-entity-overlap` (`scenario/world-invariants.ts`) runs
with the core ones: a mob never interpenetrates a `minecraft:is_collidable`
entity.

Core invariants (`scenario/invariants.ts`): `player-not-in-solid` (2 ticks'
grace for a teleport's set-down), `no-unprotected-fall` (over 3 blocks
without slow falling), `nothing-below-ground` (fell through the world),
`rider-drag-reaches-look` (a riding player held in `player_relative` or
`camera_relative`, whose drag turns only the camera: the Nimbus, Saga 30k;
quirk `control-scheme-drag-to-camera`), `no-script-error`, `no-content-log-error` (refused definitions),
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
record), `rideSlide`, `rideLift`, `driveVehicle` (which also checks the
mounted driver's seat - the declared seat times the vehicle's scale, quirk
`seat-scales-with-entity` - is in or on the drawn vehicle: `seat-on-vehicle`),
`seatsEverySize` (every rideable's seat at every wand step from the JSON
alone, `adapters/craftmatic/seat-scale.ts`; the child-play scenario
`seats-every-size`; it also judges every sized entity's collision box as the
device realises it - declared x scale, quirk `collision-box-scales-with-entity`
- against the 100 % box scaled once: `collision-box-scale`), `driveUnderFixture`, `flyMount`,
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
blocks resize; `--sizes=` names others: COL-01 / SCALE-05 ask 200, 300 and
400 too) and turns 0 and 90 - tap every moving part (from another spot
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
`aabb-is-collision-box` and `dynamic-properties-per-pack` (since 2026-10-08
the simulator scopes dynamic properties by pack as the device does; the hop
uses tags for anything another pack reads, and still passes: round 30m's
10261 + Nimbus + 42639, `output/engine-d-20261008/hop.md`).

## The vehicle course (`adapters/craftmatic/vehicle-course.ts`)

`bun scripts/sim.ts <packs> --scenario=vehicles [--md=] [--json=]`: every
SCRIPTED car, hover craft and ship of each pack (read from its
`scripts/vehicles.js` config) is spawned on the superflat ground away from
the model, the child seated on it, and driven into eight obstacles, each in
its own lane, holding the stick FORWARD and nothing else for up to 10 s - a
one-block step, a hill (a block every two, four high), a two-block kerb, a
three-block wall, a trunk met with the footprint's corner, a three-block
wall at 30 degrees, a two-deep and a three-deep pit (2026-09-30, "it's too
easy to get fully stuck in place by hills / blocks"), and - since the Saga's
round 30j (2026-10-07) - the `oblique` lane: a two-high hill met 19 degrees
off square (`OBSTACLE_SKEW_DEG`), long toward the side a sidestep runs to.
Every other lane meets its wall square-on, where both halves of the
footprint block and the response rises; off square one half meets it first,
and the device's X-wing "deflected" 13-50 blocks along a hill and a wall
and never lifted while the course said 8/8. A lane's obstacle starts 4
blocks past the TURNED footprint's reach (a wide ship's near corner reaches
past its nose: the Milano was spawned a block into the hill before that).
A ship runs the course a second time holding Jump too (the old flight
model's throttle; the new one's "up"). Per obstacle: passed, ticks, ticks
pushing without moving, the height reached, ticks the vehicle's clear band
went INTO a block (the band the runtime sweeps: over a car's step, a ship's
whole airframe; 0.1 block of slack, `CLIP_SLACK`), how far it went ACROSS
the lane beyond its heading's own drift (`side`: a run along a wall shows
here), and after a stop whether backing off, turning on the spot and
driving away moved it 3 blocks. Then `shipControls` (straight up, hover,
forward, straight back, a turn on the spot, back + Jump down, a drag down
then Jump down), `cameraRecentre` (a 90-degree drag at rest, 2 s at rest,
3 s driving: the camera's offset from the nose, read from the free camera's
location and facing point), and the two 30j checks: `turnAgainstPost` (the
ship parked with its tail against a post, the stick held right 2 s: it must
not rise, may pivot, never enters the post) and `parkOverRider` (Jump 2 s,
sneak off: the child falls straight under the hull; the empty ship must
hold over the child's head and park once the child walks out). Every
scripted car, hover craft and ship then runs `dismountEverySize` (SEAT-05):
spawned on the flat world at 100, 200 and 400 % by its own size event, the
child seated, the device's sneak (the engine's set-down about the seat, quirk
`dismount-near-seat`) and whatever `vehicles.js` does after it; the child
must end outside the hull (`dismount-in-hull`) with no fall past 3 blocks
(the core `no-unprotected-fall`; Pixel 30l: ~9 blocks off the 200 % Milano).

Violations: `vehicle-not-stuck` (a ship must pass everything; a car or hover
craft all but the three-block wall, the three-deep pit and the oblique
kerb - a car's deflect and slide come before its climb, so it runs along a
kerb met off square: measured, `TODO(car-oblique-kerb)`), `vehicle-escapes`,
`vehicle-no-clip`, `ship-slides-along` (a ship ran 10+ blocks across a lane
along an obstacle's face instead of lifting over it, passed or not: the
old pack "passed" the oblique lane by running 84 blocks round the hill's
end), `ship-turn-climbs`, `ship-parks-on-player`, `ship-parks`, `dismount-in-hull`,
`ship-controls`, `free-look` (also: the chase camera must open behind the
nose when the child climbed on looking at the vehicle's face and the seat
turned them 4 ticks later, quirk `mount-snaps-rider-yaw`),
`cockpit-eye-on-seat` (hotbar slot 9 at full stick: the camera's target
within half a block, along the heading, of the eye on the pose the runtime
saw `cockpit-draw-lag` ticks back - where the device draws the seat; Saga
30k at 1.5 drew it ahead, 30l at 4 behind: 3). A NATIVE mount's drag
steering is the regression `nimbus-spin-30l` (`dragMount`: one swipe at
rest, then hands off; `mount-steer-stops` when the mount still turns a
second later, `mount-steer-by-drag` when its turn is not the swipe's). `bun scripts/_course_trace.ts <pack>
--obstacle=<lane> [--runtime=tree] [--every=4]` prints one lane's per-tick
positions relative to the obstacle, for a diagnosis. The course quiets
`player-not-in-solid` and `nothing-below-ground` while the child rides (a low
car's seated rider has its feet under the road; the pits are dug under the
flat world on purpose) and judges the vehicle by its own band instead.
Boats run the water lanes instead ("Water: the boat lanes", below); native
mounts (the simulator's hover controller is a stand-in) are left out.

### Water: the boat lanes (2026-10-08, `TODO(sim-boat-course)` closed)

Water is a VOLUME (`world/liquids.ts`: a source fills 8/9 of its cell, quirk
`liquid-surface-height`) and a body in it moves by Java's water rules (quirk
`liquid-motion`, ASSUMED: physics spec §4.4b). Every scripted BOAT runs
`boatCourse` in pools as deep as its draft needs, the surface 1.11 under the
shore as in the GameTest arena (`GT_VEHICLE_LAYOUT`), stick forward up to
`COURSE_PUSH_TICKS`: `water-flat` (it makes 20 blocks and stays on its
waterline: `boat-not-afloat`), `water-bank` (a bank met bow-on: it stops at
the waterline and backs off - `boat-climbs-bank`, `vehicle-escapes`),
`water-shallow` (a one-block channel: measured, how deep the keel would sit
in the bed), `water-wall` (a pier post met 19 degrees off square: never
through it, `vehicle-no-clip`). Then `waterEgress` (SEAT-05 "water": a sneak
on open water and with a bank a block beside the hull at 100/200/400 %; never
under the hull, `water-egress-under-hull`; where the child ended is
recorded), and the free look and the cockpit eye on a pool. `boatFloat`
measures the DRAWN hull against the surface (regression `ship-floats-29b`).
Round 30m (`output/engine-d-20261008/boats.md`): 60221 and 10786 pass
THROUGH a pier post met off square (32 and 22 ticks of band in the post: the
sweep blocks once, `resolveMove` steps aside, and the post then sits inside
the footprint where the enter-only probes never see it); 10365 stops and
backs off; the egress swims the child beside the hull even with a bank a
block away.

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
three trips.

**A recorded HUD cell is replayed at its FLOOR, from every legal spot.**
`tapPartFrom` with `recordedCell` taps from every legal standing spot in the
recorded block cell whose feet are within `FLOOR_LEVEL_TOLERANCE` (2/16) of
the recorded height - the exact point first when it is legal - with the
recorded aim, and the part must move from a strict majority of them. A spot
higher in the same cell (on a rim, a step, 10326's handrail band 0.68 up) is
a different pose, never the device's: picking the best one there made the
case pass from a pose the device never had. With no floor-level legal spot
the exact point is replayed (inside a collider, as the device stood on the
old pack); a tap that moves the part from there proves nothing, so the
judge returns `untested` and the verdict is NOT TESTED.

**Verdicts** (`regressionVerdict`, pure and unit-tested): OK / FAIL when the
old pack reproduced; NOT TESTED - failing the run - when a side could not
run, a judge said the device's conditions could not be set up, or the old
pack did not reproduce without the case knowing why. A case that records
WHY the simulator cannot reproduce it (`knownUnreproduced` + `limits`) is
KNOWN-UNREPRODUCED when the current pack passes the scenario: printed apart
(a line of its own and a banner over the markdown table) and not failing
the run by itself; its current pack failing is still a FAIL.

**`--runtime=tree`** runs the CURRENT pack's figures/rides/vehicles scripts
as this tree builds them from the pack's own CONFIG
(`adapters/craftmatic/runtime-swap.ts`); the old side always runs as the
device ran it. It measures a runtime fix on the packs a round used without
re-exporting them (which changes the world too); a fix in the export
pipeline still needs fresh packs. A vehicle CONFIG's constant sections
(`flight`, `boat`, `car`, `hover`, `footprint`, `move`, `headlights`) are
topped up with this tree's constants for every key the pack predates (the
pack's own values stay): the runtime reads its constants from the CONFIG,
so a new key is `undefined` in an old pack's - `MOVE.NARROW_CELLS` was, and
the swapped X-wing still ran along the oblique hill the unit-test harness
(whose config is the tree's) rose at, until the top-up (2026-10-07).

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
| 7140 X-wing slides along a 2-high hill met 19 degrees off square, never lifts (30j, VEH-08) | reproduced: `ship-slides-along`, 83.7 blocks across, rose 0, "passed" round the hill's end in 162 ticks | passes (`--runtime=tree` on the same pack): rose 2, 0 across, over in 57 ticks (`output/vehicle-fix-20261007/`) |
| 7140 X-wing turning on the spot with its tail against a post rises 4-6 blocks (30j) | reproduced: rose 6 | passes: rose 0, pivoted 88 degrees, 0 ticks in the post |
| 7140 X-wing: sneak off in the air, the empty ship parks ON the child under it (30j) | reproduced: hull base at the child's feet (-1.8 over the head) | passes: holds 1.5 over the child's head, parks on the ground once the child walks out |

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
`TODO(sim-slide)`). The archived Saga 10797 frames and subagent transcript
recover the car route and swipes: mounted HUD 6986,-60,7017, then
6986,-61,7018 and 6992,-63,7022; the car later reached 6992,-104,7021.
The replay uses the archived pack's collider structure and aligns the rider
with the car before the recorded forward/diagonal inputs. Neither ideal
20 Hz timing nor shorter holds matching the observed movement reproduce
the fall. The native mounted pose and tick cadence remain unknown; this
case is **KNOWN-UNREPRODUCED**, not evidence that the simulator catches the
bug. After the route the car is driven under the host test's overhang
(`driveUnderFixture`, a row of the pack's own collider blocks 1.25 over the
road), so the current pack is still checked against the geometry that pins
the fix. Exact archive and transcript paths are in the regression case's
evidence.

`door3-tap-10326` is **NOT TESTED** on the current 10326 build (278adbf5):
the recorded cell has no legal standing spot at its floor (0 of 100 points
on a 0.1 grid at heights 0 to 0.25; every legal spot is on the band 0.875
up), so the device's pose cannot be stood in - the band that refused the
device's tap is still a collider over that floor. A shell fix, not a replay
change, closes it.

## Scenery-seat egress sweep (`scripts/_seat_egress_sweep.ts`)

`bun scripts/_seat_egress_sweep.ts <packs | dir> [--runtime=pack|tree]
[--sizes=100,150,200,300,400] [--json=] [--md=]` places each pack at each
size and, for EVERY scenery seat (figures.js `seatTypes`), mounts the player
(`addRider`), presses Sneak up to three times and judges: OK (off, and a
forward walk of 8 ticks gets a block in one of four headings), RESEATED or
STUCK (a trap), FELL (a landing fall over 3 blocks). Each row records how far
from the seat the player ended (`shift`). Exit 1 on any trap or fall. The
seats' set-down order is physics spec §4.8.

## Not modelled (yet), and honest limits

- **Rendering, culling, cameras** are device-only (quirk registry); snapshots
  draw geometry and apply the ~70-block draw ceiling only.
- **Vanilla blocks** are a small table (terrain, lights, doors by facing, open
  bit and hinge - quirk `vanilla-door-shape` -, straight stairs, slabs,
  carpets, plants, liquids); others are full cubes and counted
  (`BlockTypes.unknownVanilla`). Water is a volume with Java's swimming rules
  (quirk `liquid-motion`, assumed) but does not FLOW.
- **Entity AI** (navigation, behaviours) is not run; only what scripts do and
  `minecraft:physics` gravity/collision. Two pushable bodies (players, the
  figures' `pushable_by_entity`) push apart softly (quirk `entity-push-soft`,
  Java's rule, assumed until the `quirk_push` GameTest runs); a
  `minecraft:is_collidable` entity is solid to mobs (quirk
  `entity-collidable-solid`); every other pair passes through, as on the
  device (no pack ships a collidable entity).
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
- **An entity's collision box is the declared box times its scale**
  (quirk `collision-box-scales-with-entity`, Saga 30l volume tests): the tap
  pick, `getAABB`, a mob's sweep and the snapshot's actor cull all read the
  realised box (`SimEntity.collisionSize`). A pack built before 2026-10-08
  (size groups writing the box pre-scaled) shows f² x the 100 % box, as the
  phone did.
- **Block collision boxes are read MIRRORED in x**, as the device reads them
  (quirk `block-collision-x-mirrored`, Pixel GameTest 2026-09-30): a pack
  built before the fix to `collisionBox` shows its x-banded clearance forms on
  the half of the block the phone put them on, not where the kit meant.
- **Dismount spot** (quirk `dismount-free-spot`, `setDownRider` in
  `physics/systems.ts`): a player that gets off is set on the floor one block
  from the seat ENTITY, trying world (0,-1), (0,+1), (+1,-1), (+1,+1),
  (-1,+1) in that order, a floor within about +0.5 / -1 of the seat entity;
  with none free, at the seat's point 0.2 up. The search runs about
  `dismountReference`: the rider's seat raised to the seat entity's point,
  which IS the entity's point on every measured scenery seat and the seat
  itself high in a big hull (quirk `dismount-near-seat`, Pixel 30l: off the
  200 % Milano the player fell ~9 blocks from the seat, not from the ground
  at the origin; the order about a vehicle seat is assumed). Measured for `ejectRider` and
  `/ride stop_riding` (identical); the rest of the order and the exact floor
  window are guesses (`TODO(dismount-order)`, `TODO(dismount-floor)`); a real
  sneak cannot be sent by a simulated player; a mob rider is left where it
  sat.
- **Before-events** run read-only (the typings' restricted members throw;
  the exception's wording is remembered, not captured); **enums** carry the
  typings' values.
- **Timing of deferred calls** follows Microsoft's contract, not a device
  probe: a `system.run` from an event handler runs at the end of the same
  tick, from other code in the next (`Scheduler.inEventHandler`); a
  `runTimeout` counts its delay from the same point. `world.afterEvents.worldLoad`
  fires once in the first script tick after the scripts load (and again
  after a reload).
- **Dynamic properties are scoped by pack**, as on the device (quirk
  `dynamic-properties-per-pack`, from the Script API docs, not device-measured).
- **`getAABB` of a turned entity** is the unturned box (quirk
  `aabb-axis-aligned-when-yawed`, assumed until the `quirk_aabb` GameTest runs).
- **A seated player's reported feet** are 1.62 under its eye here and 1.52 on
  the device (quirk `rider-location-under-head`, found by the GameTest replay;
  not applied: the eye every seat check reads is right).
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
read), each commented where it is done. A rider's client-lagged yaw IS
modelled since 2026-10-08 (quirk `rider-yaw-lag`, the `riders` system: a
player on a non-zero-lock seat is turned by the vehicle's turn of 6 ticks
ago), and so is the hover controller's chase of the look (`hover-turn-chase`,
the `mounts` system): together they reproduce the Nimbus's spin.

## The GameTest and the simulator: one scenario definition

Since 2026-10-08 the simulation provides `@minecraft/server-gametest`
(`script-host/gametest-module.ts`; `TODO(sim-gametest)` closed): the SAME test
definitions the Pixel runs - a GameTest variant's `scripts/gametest.js`
(`web/src/engine/gametest-pack.ts`), the quirk probe (`scripts/_gametest_quirks.ts`) -
register as they do on the device and run offline:

- `register` / `registerAsync(class, name, fn)` and the builder (`maxTicks`
  and `structureName` applied; `tag`, `padding`, `batch`, ... recorded);
- a `Test`: `idle` (the scheduler resolves it), `succeed`, `fail`, `failIf`,
  `getDimension`, `worldLocation`, `worldBlockLocation`, `relativeLocation`,
  `relativeBlockLocation`, `getBlock`, `getTestDirection`, `setBlockType`,
  `setBlockPermutation`, `spawn`, `spawnSimulatedPlayer`,
  `removeSimulatedPlayer`, `isCompleted`, `print`;
- a `SimulatedPlayer` (the player facade with its members, quirk
  `gametest-simulated-player`): `attackEntity` (a hit, reach-free),
  `attack` (7 blocks in Creative, 3 in Survival), `interactWithEntity` (mounts
  a rideable; on anything else returns true and raises nothing, as the Pixel
  did on six door leaves), `interact` (5 blocks), `lookAtEntity`,
  `lookAtLocation`, `moveToLocation` / `moveRelative` / `stopMoving` (steering
  the controls at test-RELATIVE targets; it walks straight, no navigation),
  `jump` (none while riding), `rotateBody`, `isSneaking` (no dismount); its
  stick never reaches `inputInfo`.

`runGametest` lays the test's structure (layer 0 at relative y 1, as the Pixel
measured), keeps the arena loaded and ticks to a verdict. The CLI:

```
bun scripts/sim-gametest.ts <pack.mcaddon> [--tag=craftmatic_gt] [--only=<test>] [--log=<cmgt.log>] [--md=] [--json=]
bun scripts/sim-gametest.ts --replay=<cmgt.log | ContentLog.txt> [--pack=<variant or model pack>] [--md=]
```

A model pack is built into its variant by `scripts/_gametest_pack.ts` first;
each test runs in a fresh world. `--replay` re-derives a past device run's
VERDICT rows (a doorway's closed/open outcome and how it opened, a part's
angles, a seat, a figure's summary, a vehicle's checks, a quirk subject's
rest position) and lists each differing field: a finding - a quirk row to add
or correct - never a test to tune. Results (`output/engine-d-20261008/`):
the Pixel's 41732 doors run 5 re-derives 26 of 26 fields; the quirk probe's
runs 1-3 (on the packs those runs used) 39/42, 47/89 and 62/65 - every
eject dismount spot and every collider band matches; the mob lift on teleport
(known), a 0.08-block push-out drift, a seated player's reported feet
(`rider-location-under-head`), `/ride ... stop_riding` (not modelled) and the
probe's health reads (`Entity.getComponent(minecraft:health)`, not modelled)
do not. The quirk probe gained `quirk_push` and `quirk_aabb` (not yet run on
a phone); their expected log is `output/engine-d-20261008/quirk-probe/expected-cmgt.log`.

What stays a hand-made fake: `test/gametest-pack.test.ts`'s injected-outcome
cases (a door that does not open, a vehicle that does not move) - the
simulator runs the real runtime and cannot be told to misbehave there
(`test/sim-gametest.test.ts` runs the real one).

## Towards a standalone engine

The seams are already the engine's: a world of voxels with block types from
data, entities from data with component groups and events, one integrator
for every body, systems in an ordered loop, a scripting host over a typed API
surface, input as data, and scenarios as data. What stays to make it its own
package: take over the zip reader and the few geometry helpers the adapter
borrows (`TODO(standalone)`), add a renderer that draws the voxel world (the
rasteriser draws entity geometry only), and move craftmatic's adapter out to
the application that uses it.
