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
bun scripts/sim.ts <packs> --scenario=my-scenarios.ts    # your own scenarios
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
  adapters/craftmatic/
               pack-facts · wand (place, undo) · play (rides, vehicles, flyers, doorways, figures)
               child-play (the generated scenarios) · regressions (the device-bug set)
               appearance (the pack's drawn geometry) · drawn · snapshot
```

**Dependency rule.** Nothing under `web/src/sim` imports `web/src/ui` or the
DOM. The core (everything outside `adapters/`) imports nothing of craftmatic
except two generic utilities it has not yet taken over (`engine/zip-utils.ts`;
`TODO(standalone)` in `pack/pack.ts`). The adapter may import craftmatic's
engine (`bedrock-placement-pack`, `bedrock-interactives`, `cockpit-seat`,
`bedrock-geometry-faces`, `interactive-walk`). The walk preview now imports
FROM the simulator (`addon-walk.ts` re-exports the integrator,
`ui/addon-appearance.ts` and `ui/addon-preview-data.ts` re-export the moved
readers), not the other way round.

**The tick.** `SimEngine.step()` runs its systems in order: loading (the
chunk columns around players and inside ticking areas) → players → hover
mounts → mobs → riders → effects → scripts (after-events, then due
`run`/`runTimeout`/`runInterval` callbacks and jobs, then every promise the
tick started). A new behaviour is a new system (`engine.addSystem`), never an
edit of the loop.

### Public APIs, by module

- `core/simulation.ts` `Simulation`: `loadAddon(addon)`, `loadAddonBytes(bytes)`,
  `addPlayer(name, at, items)`, `run(ticks)`, `itemIds()`; `.engine`, `.host`, `.controls`.
- `core/engine.ts` `SimEngine`: `loadAddon`, `addSystem`, `on`/`emit` (engine events:
  `entityHitEntity`, `playerInteractWithEntity`, `itemUse`, `scriptEventReceive`,
  `entitySpawn`, `entityRemove`, `landed`, `dismounted`), `step`/`run`, `dimension(id)`,
  `spawnEntity`, `addPlayer`, `removeEntity`, `loadedEntities`; `.timeline`, `.structures`.
- `core/timeline.ts` `Timeline`: `add`, `of(kind)`, `callerSource()`, `unmodelled(member)`,
  `unmodelledRanking()`.
- `world/voxel-world.ts` `VoxelWorld`: `permutationAt`, `setPermutation`, `shapeAt`,
  `isLoaded`, `solidsNear` (the physics' `SolidQuery`), `overlapping`, `supportBelow`, `onWrite`;
  `flatTerrain(groundY)` (the QA worlds' superflat, standing height -60).
- `world/block-types.ts` `BlockTypes`: `addDefinition(path, json)`, `shape(typeId, states)`.
- `entity/definitions.ts` `EntityDefinitions`: `load(path, text)` (refusing as the game does);
  `entity/entity.ts` `SimEntity`: `triggerEvent`, `addGroup`/`removeGroup`, `rideable()`,
  `addRider`, `removeRider`, `seatWorld`, `placeRiders`, `collisionSize`, `aabb`, `physics`.
- `physics/body.ts`: `tickPlayer`, `tickBody`, `moveBox`, the constants (physics spec §12).
- `input/touch.ts`: `tap`, `interact`, `pick`, `lookAt`, `aimPoint`, `useItem`;
  `input/ray.ts`: `raycastBlocks`, `raycastEntities`, `pickBoxes`.
- `script-host/host.ts` `ScriptHost`: `loadScripts(addon)`, `builtin(name)`, `deliver`,
  `before`, `entity(sim)`, `simOf(api)`, `resolvePermutation`, `playerState`; `.chooser`
  (answers forms), `.scheduler`, `.stats` (sounds and particles).
- `scenario/runner.ts`: `runScenario(scenario, addons, options)` → `ScenarioResult`;
  `CORE_HANDLERS`, `findEntity`. `scenario/report.ts`: `markdownReport`,
  `regressionMarkdown`, `unmodelledTotals`.
- `quirks/registry.ts`: `quirk(id)`, `quirkValue(id, key)`, `allQuirks()`, `deviceOnly(area)`.
- `render/rasterizer.ts`: `rasterize(quads, paint, camera)`.
- `adapters/craftmatic`: `readCraftmaticPack`, `wandHandlers`, `playHandlers`,
  `craftmaticHandlers`, `childPlay`, `childPlayScenarios`, `REGRESSIONS`,
  `packAppearance`, `drawnBoxes`, `forwardViewWorld`, `firstPersonSnapshot`, `renderActors`.

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
replaced a line within a second, unless the player got off something in
between). A step may `quiet([...])` invariants while it does something they
would flag on purpose (a device line that starts in the air).

Craftmatic steps (`adapters/craftmatic`): `place` / `undo` (the wand, read
like a child reads it; Undo checks the placement's box block for block and
every entity the placement tagged), `tapInteractives`, `doorwayLines`,
`rideSlide`, `rideLift`, `driveVehicle`, `driveUnderFixture`, `flyMount`,
`figuresLive`, `visitSeatedFigures`, `snapshot`.

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
Undo.

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
never figures. Above 100 % the slack widens horizontally by the re-lay's shift
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

`bun scripts/sim.ts --scenario=regressions --new=<current builds>`, run at
`671f0f3c` over packs built from `449abd0e` (`output/sim-regress-449abd0e/`):

| case | pack the device ran | current tree |
|---|---|---|
| 10788 slide rides on its rails (29b) | reproduced: the seat 0.253 over the drawn chute (limit 0.2) | passes: 0.159 |
| 10788 lift car is the shaft cap, rider not carried past the floors (29b) | reproduced: set down under a floor, dropped 1.71 (since the x mirror, 2026-09-30: set down inside `collider_c2`/`collider_w2` on every trip) | passes |
| 10797 car under an overhang falls through the world (29b) | NOT reproduced (see limits) | passes |
| 10797 driver's eye in the bodywork, 0 of 15 rays (29b) | reproduced: 0 of 15 | passes |
| 10788 slide seat: a tap boards nothing (29c) | reproduced | passes |
| Nimbus: sneak off at altitude drops the player (0929) | reproduced: 70.55 blocks without slow falling | passes (slow falling) |
| Nimbus: summon hint overwritten by the driver HUD (0929) | reproduced: after 3 ticks | passes |
| 10326 Door 1 from the porch drops at the door plane (29d) | reproduced, the MODEL's | reproduced, the model's (as expected) |
| 910004 Door 3 walk-out stops before the doorway (29d) | reproduced, the MODEL's | reproduced, the model's (as expected) |
| 10261 spurious FIGURE_RETAKE_NO_SEAT during placement (29d) | reproduced | passes |

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
- **Performance** is not the device's: a tick is as fast as the host runs it.

## Folding the older hosts in

The doorway merge (`c4c34b1c`) freed the files another agent held, so these
are the next folds, each a `TODO(sim-fold)`. Done 2026-09-30: the device
lines take the harness's doorway (`doorwayGeometry`, exported) and its jump
rule; the walker itself is still two (the harness's `tickPlayer` over
`WalkWorld`, the simulator's over the voxel world).

- `web/src/engine/interactive-walk.ts` walks doorways over `WalkWorld` (the
  shipped grid re-laid by its own arithmetic); the simulator walks the same
  lines over the world the RUNTIME laid (`doorwayLines`). The harness's
  verdicts (`walkThroughDoorway`) and the simulator's device lines should
  share one walker and one world.
- `web/src/engine/figure-life-sim.ts` runs `figures.js` over a stand-in world
  (a constant 0.4-block/tick drop); the simulator runs it with the pack's
  placement, seats and physics (`figuresLive`).
- The test hosts `test/_ix-host.ts` and the ones inside
  `test/bedrock-{vehicle,rides,flyer,coaster}.test.ts` each fake a slice of
  the API; `test/_placement-host.ts` now runs on the simulator (its fixtures
  documented at its head) and is the pattern for the rest.

## Towards a standalone engine

The seams are already the engine's: a world of voxels with block types from
data, entities from data with component groups and events, one integrator
for every body, systems in an ordered loop, a scripting host over a typed API
surface, input as data, and scenarios as data. What stays to make it its own
package: take over the zip reader and the few geometry helpers the adapter
borrows (`TODO(standalone)`), add a renderer that draws the voxel world (the
rasteriser draws entity geometry only), and move craftmatic's adapter out to
the application that uses it.
