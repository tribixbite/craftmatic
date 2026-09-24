# Bedrock interactivity: doors, windows, hatches, seats and turnables

The user's brief (2026-09-24): *"a polished door system so all set doors look
like the source model but actually function in MC (opening and closing,
ensuring the player can physically get past when open — this is CRUCIAL)"*,
and *"a full basic interactivity system: sit on furniture, open doors and
applicable windows, turn any turnable mechanisms"*.

Code: `web/src/engine/bedrock-interactives.ts` (detection, rig, collider plan,
runtime), `web/src/engine/interactive-walk.ts` (the passability harness),
`web/src/engine/playable-addon.ts` (pack assembly), `web/src/engine/schem-pipeline.ts`
(where the scene is read), the Walk add-on (`web/src/ui/addon-preview*.ts`).

## One model for every class

A moving part is **its exact LEGO geometry, a hinge, an angle, and (for a
doorway) the collider cells its closed leaf fills**. Nothing is a vanilla block
standing in for a LEGO part any more: a vanilla door is 1 x 2 blocks, 76417's
bank doors are 1.1 x 2.7, and the gap showed.

| class | detected by (LDraw description) | moves | hinge / axis | angle | collision |
|---|---|---|---|---|---|
| door | `Door …` leaf (`isDoorLeafDescription`), `Train Door …`, `GLASS DOOR FOR FRAME` (60616), at least 72 LDU tall | the leaf + what sits inside its own box (glass insert, handle, sticker) | the leaf's up axis through its origin end | ±90° (the side the sweep finds clear) | doorway: closed cells laid, opened when passable |
| gate | `Gate …`, `Fence Gate …`, `Door … Gate` | as door | as door | ±90° | doorway (no headroom rule: a gate has no lintel) |
| cabinet | a door leaf under 72 LDU (1 x 3 x 1 car / cupboard door), `Container Cupboard/Box … Door` | the leaf | as door | ±100° | static (its closed box stays a collider) |
| window | `Glass for Window … Opening` (top-hung casement), `Window … Shutter`, `Window … Pane` | the pane / shutter | casement: the in-plane edge its origin marks (the top, on 60603); shutter / pane: its up axis at the origin end | ±60° | static |
| hatch | `… Trap Door` (not `… Frame`), `Hatch …` | the plate | the horizontal edge its origin marks | 90°, free edge UP | doorway in a floor: closed cells laid, opened when 1 x 1 block |
| lever | `Hinge Control Stick`, `… Lever` (not base/pattern) | the stick | local X through its origin (the ball joint) | 35° flip | static |
| turnable | `Turntable … Top`, `… Steering Wheel` (not hubs/holders), `Technic Rotor`, `Propeller`, `Ship's Wheel` | the part (a turntable top also carries what is stacked on it within 1.5x its radius, at most 60 parts) | a turntable's up axis; otherwise the axis the part is most round about, the thinnest on a tie; through its box centre | 90° per tap | static |
| seat | 4079 family + `Seat/Chair/Bench` (`isSeat`); library furniture `Chair/Bench/Stool/Toilet/Throne/Sofa/Couch/Armchair` incl. Fabuland (`isFurnitureSeat`) | — | — | — | the invisible rideable seat entity (the same one the Brick Wand's "Add seat here" uses); a figure the source sat there rides it |

Detection runs on the SCENERY's placements only (`discoverInteractives` with
`exclude: movable`): figures, vehicles, coaster cars and pinball parts are not
scenery. **Technic gears are deliberately not turnables** (they are mechanism
internals: 10261 has 30 of them inside its lift); sliding and roller doors are
not modelled; LEGO's modern chairs are brick-built and have no mould (mark them
with the wand).

### The hinge comes from the part's own frame

Every LDraw leaf mould puts its origin on the hinge line — measured on the door
moulds in 2026-09 and on 30042 (trap door), 60603 (opening casement), 3582
(shutter) for this work. So the rule is per class, in the part's local frame:
the leaf's width axis is its wider horizontal axis, the hinge is the end the
origin sits at, and the hinge LINE is the up axis (a hatch: the other
horizontal axis; a casement: the in-plane axis the origin is not off-centre
along). World pivot and axis are the local ones through the placement's
matrix, so a leaf turned 45 degrees (76417's two bank-hall doors) or 8 degrees
(its front doors) works exactly like a square one.

**A mould whose origin is centred names no hinge** and stays static, reported
in the pack warnings: 40066 (`Door 1 x 6 x 7 with Arch and Rounded Pillars` —
its box is an arch with pillars, not a leaf), 92099 (`Plate 4 x 6 Trap Door
with Bars`), 30059 (container box door) and 38320 (a fixed lattice pane). A
leaf lying on its side is static too.

### Which way it swings

`discoverInteractives` samples the leaf's mid-plane (35/65/95 % along, 20/50/80 %
up), turns the samples ±angle about the hinge and counts how many land inside
another part's box. The side with fewer hits wins (a hatch always lifts its free
edge up). The counts are in the pack diagnostics (`sweepHits`).

## How it becomes an entity

One entity type per part (`x_<id>_<kind>_<n>`), compiled by the same compiler
as the shell (`compileLdrawEntityGeometry`, `wholeModel`, the shell's frame and
quality) with:

- **a three-bone rig at the hinge** (`interactiveRig`): `ix_tilt` turns LDraw up
  onto the hinge axis, `ix_spin` is the animated bone, `ix_untilt` turns back;
  every placement hangs on `ix_untilt`. At zero spin the chain is the identity,
  so the part is exactly where the model put it. This is the pinball flipper's
  chain (`flipperRig`), whose sign was proven on the Pixel: a positive value is
  a right-handed turn about the axis in the LDraw frame (the grid frame is a
  proper rotation of it).
- **one float actor property**, `craftmatic:angle`, built with
  `floatActorProperty` (an integer literal loses the whole property component on
  the device). The runtime writes the target angle once per toggle; the client
  eases to it in Molang so the swing is per-frame smooth and takes
  `SWING_SECONDS` (0.4 s): `scripts.initialize` sets `v.ix_angle` from the
  property, `pre_animation` moves it by at most `rate x q.delta_time`, and the
  animation turns `ix_spin` by `-v.ix_angle` (the geometry writer's own sign).
- **a behaviour** with `minecraft:interact` (a touch screen shows "Open /
  close", "Turn" or "Use"), no gravity, no collision, no damage, no
  `minecraft:pushable` (format 1.26.30 dropped it and the entity would not
  exist), size groups for the wand, and a collision box that is the TAP box:
  centred on the closed part's bottom, 1.5 x its widest horizontal extent (so a
  leaf swung open about its edge is still under a finger), as tall as the part.
  Bedrock picks a tap by that box and only on an entity that renders cubes
  (pinball device rounds, 2026-09-24); the part's own cubes are those.
- **the entity origin** at the closed assembly's bottom centre (`originLdu`), so
  it stands in the cleared doorway, lit like the air around it.

## How interaction works

`scripts/interactives.js` (`interactivesRuntime`, serialised with `.toString()`):

- A tap (`world.afterEvents.entityHitEntity` from a player) or an interact
  (`playerInteractWithEntity`) toggles the part; a second event for the same
  entity within 6 ticks is the same tap reported twice.
- Doors, gates, hatches, cabinets, windows open and close; a **double door's
  leaves move together** (leaves whose closed cells share or touch a cell:
  `linkSharedDoorways` → `shares`). Levers flip; turnables turn a step.
- Sounds: `random.door_open` / `random.door_close`, `random.click` for levers
  and turnables.
- **State persists**: the placement writes `craftmatic:ix` (item),
  `craftmatic:ix_anchor`, `craftmatic:ix_rotation`, `craftmatic:ix_scale` on
  each spawned part; the runtime keeps `craftmatic:ix_open` / `craftmatic:ix_angle`
  and `craftmatic:ix_ready`. A sync pass every 10 ticks lays a freshly placed
  doorway closed and, once per session, re-asserts each part's angle from its
  dynamic properties (so a reloaded world shows open doors open).

## How collision follows the state

The shell's collider grid is laid from the shell's own geometry
(`buildColliderGrid`). A doorway's leaf is not in the shell, but its FRAME is,
and a 20 LDU frame straddling a cell boundary fills whole cells. So:

1. **The cut** (`planInteractiveColliders`, on the COLLIDER grid — the voxel grid
   is half a block off the entity world): the leaf's cells are the columns its
   mid-plane crosses between 15 % and 85 % of its width (a 1.5-block leaf clears
   two, a 1.1-block one clears one; the sliver past the leaf stays wall) times
   the rows its box spans. They become air, and are recorded with the leaf's own
   lo/hi sixteenths as the doorway's **blocking** cells. A door or gate also
   opens the **passage**: along the leaf's normal, both ways, up to three cells,
   until a column a player can stand in (its floor row at most a 9/16 step, the
   row above free, the next free below its middle).
2. **Closed**: the runtime lays the blocking cells as `craftmatic:collider`
   blocks over the static state around them (the doorway's **neighbour** cells,
   ±3 cells, shipped with it), with `ixWorldBlocks` — exactly the collider
   re-lay's arithmetic (`placeColliders`: the turned cell, the world columns it
   owns at that size, the rows its sixteenth span crosses, a shared block's min
   lo / max hi) — so it is right at every wand size and quarter turn.
3. **Open**: the blocks go back to the static state (usually air). The swung
   leaf lays nothing: it stands against the wall, and the passage must be clear.
4. It never overwrites a block that is not a collider (the player built there),
   and refuses to close on a player or a figure standing in the doorway.

Windows, cabinets, levers and turnables are not passages: their closed part
boxes stay in the static colliders, so a closed-up window is still a wall.

## The scale rule

A player needs a clear opening **1 block wide and 2 high** (`PASSAGE_WIDTH_BLOCKS`
x `PASSAGE_HEIGHT_BLOCKS`; a hatch is a hole: 1 x 1). Each doorway ships its
**`passSize`**: the first wand size (100/150/200/300/400 %) at which its opening
clears that; 0 when none does. Below it the leaf still swings open but its
colliders stay (the runtime says *"This opening is 0.8 x 1.4 blocks at 100
percent: too small to walk through at 100 percent. Place the build at 200
percent or larger to pass."*). The pack warnings carry one line per set
(*"Doorways passable (a player needs 1 x 2 blocks): 4 from 100 %, 2 from
200 %"*), the diagnostics carry every part's opening and `passSize`, and the
Walk add-on's legend says how many are passable at the chosen size.

## Proving it offline

- `test/bedrock-interactives.test.ts`: classification, hinge and swing side on
  the real moulds' bounds, the rig's identity at rest, `ixWorldBlocks` against
  the re-lay oracle (`laidColliderBlocks`) at every size and turn and against the
  walk world, the cut and the passage, `passSize`, double-door linking, the
  entity assets (float literal, interact, Molang easing), the placement stamping
  the dynamic properties, and **the serialised runtime run as the device runs
  it**: laid closed on sync, both leaves open on one tap, the static state
  restored, a doubled tap counted once, no closing on a player, a player's
  block never overwritten, a too-small doorway kept blocked with the message,
  mapping at 200 % turned 90°, a turnable's steps, and a script reload.
- `test/interactive-passability.test.ts`: builds 31141, 42663 and 76417 as the
  CLI does and walks a 0.6 x 1.8 player (the walk module's per-tick Minecraft
  physics) through every doorway at 100 and 200 %, turned 0 and 90: open passes
  where `passSize` allows, closed never does.
- `bun scripts/_ix_passability.ts <pack…> [--sizes=] [--rotations=] [--json=]`:
  the same walk over any built pack, one verdict per doorway (OK, SMALL, SEALED,
  NO-APPROACH, FAIL; exit 1 on FAIL). `bun scripts/_ix_report.ts <pack>` lists
  the parts; `bun scripts/_ix_doorway_map.ts <pack> <i>` draws one doorway's
  collider plan.
- The Walk add-on: E (or the touch Interact button) toggles the nearest part
  with the runtime's rules, the leaf swings about its real hinge over 0.4 s, the
  closed leaves' colliders are drawn (door-blue) and collided with.
  `node scripts/_shoot_addon_walk.mjs <pack> <out.png> model doors --door=<n>`
  shoots a part closed, open, and after a walking player tried to pass.

## Not verified on a device

Everything above is offline. Unproven in Minecraft: the Molang easing
(`q.delta_time` in `pre_animation`), that a tap picks the part through the tap
box while it is swung open, the interact button text, the sounds, and that
`playerInteractWithEntity` fires for an entity with only `minecraft:interact`.
The swing SIGN follows the pinball flipper's device-proven convention.

## Measured on the favourites (2026-09-24)

`bun scripts/_favorites_export_sweep.ts` at `bce8bacc`: **40/40 exported, 0
problems**; then `bun scripts/_ix_sweep_report.ts <sweep dir> --md=...` walked every
doorway at 100 % (turn 0) and at its passable size. **72 doorways, 0 FAIL**: 35
walked through open and blocked closed at 100 %, 1 too small at 100 % (SMALL,
kept blocked) and walked through at its 150 %, **36 SEALED**. Totals: 72 doors,
12 cabinets, 67 windows, 11 levers, 86 turnables, 40 seats (0 gates and 0 hatches:
the favourites have no fence gate, and their two trap doors are 92099, whose
centred origin names no hinge).

SEALED is the one number to read carefully. It means the doorway opens (leaf
swings, its cells clear) but one side has no floor a player can stand on along
the straight corridor through it: 76417's 4-pane shop door stands at the edge of
the bank platform over a drop; 42663's van door opens onto furniture; most of the
rest (21318's tree house, 11371, 41395) open onto rooms the shipped COLLIDER grid
has filled, because a collider cell is a whole block whenever any geometry
reaches it and a minifig room is 2-3 blocks wide with furniture in it. Carving
those rooms would let the player walk through LEGO walls and furniture; the fix
is finer colliders, not a bigger doorway cut (open in `TASKS-BEDROCK-ADDON.md`).

| set | door | gate | hatch | cabinet | window | lever | turnable | seats | doorways | OK @100 % | SMALL | SEALED | STEP | NO-APPROACH | FAIL | passable from |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 10261 | 0 | 0 | 0 | 4 | 0 | 1 | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | - |
| 10303 | 0 | 0 | 0 | 0 | 0 | 0 | 7 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | - |
| 10326 | 6 | 0 | 0 | 0 | 1 | 2 | 1 | 1 | 6 | 3 | 0 | 3 | 0 | 0 | 0 | 100 % |
| 10337 | 0 | 0 | 0 | 0 | 0 | 0 | 3 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | - |
| 10341 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | - |
| 10354 | 0 | 0 | 0 | 2 | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | - |
| 10365 | 0 | 0 | 0 | 0 | 0 | 0 | 4 | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | - |
| 11371 | 8 | 0 | 0 | 0 | 2 | 1 | 2 | 1 | 8 | 1 | 0 | 7 | 0 | 0 | 0 | 100 % |
| 11374 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | - |
| 21061 | 0 | 0 | 0 | 0 | 0 | 0 | 4 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | - |
| 21063 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | - |
| 21318 | 3 | 0 | 0 | 0 | 0 | 0 | 4 | 0 | 3 | 0 | 0 | 3 | 0 | 0 | 0 | 100 % |
| 21360 | 0 | 0 | 0 | 0 | 0 | 0 | 2 | 4 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | - |
| 31141 | 5 | 0 | 0 | 0 | 2 | 3 | 1 | 2 | 5 | 4 | 0 | 1 | 0 | 0 | 0 | 100 % |
| 41395 | 2 | 0 | 0 | 1 | 1 | 1 | 1 | 0 | 2 | 0 | 0 | 2 | 0 | 0 | 0 | 100 % |
| 41703 | 1 | 0 | 0 | 0 | 8 | 1 | 1 | 0 | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 100 % |
| 41732 | 6 | 0 | 0 | 0 | 2 | 0 | 0 | 0 | 6 | 5 | 0 | 1 | 0 | 0 | 0 | 100 % |
| 42172 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | - |
| 42639 | 2 | 0 | 0 | 0 | 0 | 0 | 1 | 0 | 2 | 1 | 0 | 1 | 0 | 0 | 0 | 100 % |
| 42652 | 1 | 0 | 0 | 0 | 4 | 1 | 8 | 0 | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 100 % |
| 42663 | 1 | 0 | 0 | 1 | 1 | 0 | 0 | 0 | 1 | 0 | 0 | 1 | 0 | 0 | 0 | 100 % |
| 42670 | 6 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 6 | 2 | 1 | 3 | 0 | 0 | 0 | 100 %, 150 % |
| 43267 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | - |
| 60380 | 3 | 0 | 0 | 2 | 13 | 0 | 1 | 2 | 3 | 1 | 0 | 2 | 0 | 0 | 0 | 100 % |
| 60446 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | - |
| 71040 | 2 | 0 | 0 | 0 | 0 | 0 | 5 | 0 | 2 | 0 | 0 | 2 | 0 | 0 | 0 | 100 % |
| 71043 | 0 | 0 | 0 | 0 | 0 | 0 | 17 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | - |
| 75397 | 1 | 0 | 0 | 1 | 0 | 0 | 5 | 1 | 1 | 0 | 0 | 1 | 0 | 0 | 0 | 100 % |
| 76269 | 3 | 0 | 0 | 1 | 12 | 0 | 0 | 4 | 3 | 2 | 0 | 1 | 0 | 0 | 0 | 100 % |
| 76286 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | - |
| 76417 | 4 | 0 | 0 | 0 | 4 | 0 | 0 | 0 | 4 | 3 | 0 | 1 | 0 | 0 | 0 | 100 % |
| 76419 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | - |
| 76435 | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 3 | 2 | 1 | 0 | 1 | 0 | 0 | 0 | 100 % |
| 76457 | 6 | 0 | 0 | 0 | 3 | 0 | 2 | 4 | 6 | 6 | 0 | 0 | 0 | 0 | 0 | 100 % |
| 77092 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | - |
| 80049 | 1 | 0 | 0 | 0 | 4 | 0 | 0 | 2 | 1 | 0 | 0 | 1 | 0 | 0 | 0 | 100 % |
| 910004 | 3 | 0 | 0 | 0 | 8 | 0 | 0 | 9 | 3 | 1 | 0 | 2 | 0 | 0 | 0 | 100 % |
| 910032 | 5 | 0 | 0 | 0 | 0 | 0 | 10 | 4 | 5 | 3 | 0 | 2 | 0 | 0 | 0 | 100 % |
| 910047 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | - |
| 910049 | 1 | 0 | 0 | 0 | 0 | 0 | 3 | 0 | 1 | 0 | 0 | 1 | 0 | 0 | 0 | 100 % |
