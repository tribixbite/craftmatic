# Bedrock interactivity: doors, windows, hatches, seats and turnables

The user's brief (2026-09-24): *"a polished door system so all set doors look
like the source model but actually function in MC (opening and closing,
ensuring the player can physically get past when open — this is CRUCIAL)"*,
and *"a full basic interactivity system: sit on furniture, open doors and
applicable windows, turn any turnable mechanisms"*.

Code: `web/src/engine/interactivity-stage.ts` (the ONE stage that decides and
reports every candidate), `web/src/engine/bedrock-interactives.ts` (detection,
rig, collider plan, runtime), `web/src/engine/bedrock-scene-actors.ts` (seats,
stools, brick-built furniture), `web/src/engine/interactive-walk.ts` (the
passability harness), `web/src/engine/gametest-pack.ts` (in-game tests),
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
| lid | `Container … Lid`, `Minifig Coffin … Lid`, `CHEST LID` (not battery-box lids) | the lid | a treasure chest's hinge pins when a chest body is under it (4738a/b: local (±40, 3, 18)), else its own +Z top edge | 100°, free edge UP | static |
| drawer | `Container … Drawer` (not `Drawers`, the body) | the drawer | SLIDES along its depth (local Z), the way that is free of the cupboard | 0.6 x its depth | static |
| garage door | a STACK of upright `Roller Door …` segments (same column, each within 32 LDU of the next, 72+ LDU tall) | the whole stack | SLIDES up by its height | its height | doorway |
| sliding door | `Door … Sliding` | the leaf | SLIDES along its width, the free way | its width | doorway |
| window | `Glass for Window … Opening` (top-hung casement), `Window … Shutter`, `Window … Pane` | the pane / shutter | casement: the in-plane edge its origin marks (the top, on 60603); shutter / pane: its up axis at the origin end | ±60° | static |
| hatch | `… Trap Door` (not `… Frame`), `Hatch …` | the plate | the horizontal edge its origin marks | 90°, free edge UP | doorway in a floor: closed cells laid, opened when 1 x 1 block |
| lever | `Hinge Control Stick`, `… Lever` (not base/pattern) | the stick | local X through its origin (the ball joint) | 35° flip | static |
| turnable | `Turntable … Top`, `… Steering Wheel` (not hubs/holders), `Technic Rotor`, `Propeller`, `Ship's Wheel` | the part (a turntable top also carries what is stacked on it within 1.5x its radius, at most 60 parts) | a turntable's up axis; otherwise the axis the part is most round about, the thinnest on a tie; through its box centre | 90° per tap | static |
| seat | 4079 family + `Seat/Chair/Bench` (`isSeat`); library furniture `Chair/Bench/Stool/Toilet/Throne/Sofa/Couch/Armchair` incl. Fabuland (`isFurnitureSeat`), seated on its PAN (`seatPanLocalY`); brick-built stools (`brickBuiltStools`) and benches, chairs, sofas (`brickBuiltFurniture`, below) | — | — | — | the invisible rideable seat entity (the same one the Brick Wand's "Add seat here" uses); a figure the source sat there rides it |
| bed | brick-built: a bed-sized mattress with a headboard (`brickBuiltFurniture`) | — | — | — | a seat on the mattress (Bedrock cannot lay the player down) |

A sliding part is the same rig with the spin bone MOVED along the axis
instead of turned about it (`interactiveAnimation(…, slideUnitsPerLdu)`: the
property is the distance in LDU). Its tap boxes follow it out
(`movedOpen`), and the Walk add-on moves it the same way. **The slide
direction on the device is derived, not yet seen** (a TODO in the code).

A retired mould (`~Moved to 3068b`) is classified by the wording of the part
it moved to (`movedDescription` / `classifiedDescription`): 910032's dining
chairs sit on `3068` tiles whose own description is the stub. Figures keep
reading the stub (`mouldFamilyId` takes the target ID from it).

Detection runs on the SCENERY's placements only: figures, vehicles, coaster
cars and pinball parts are owned by their own entities and reported as such.
**Technic gears are deliberately not turnables** (they are mechanism internals:
10261 has 30 of them inside its lift). Roller-door segments laid flat side by
side are a slatted roof or deck (42639's sun deck), and one or two on their
own are trim (42670's lone handle segment); both stay static, and say so.

### The stage and its report

`interactivityStage` (`engine/interactivity-stage.ts`) is the one place that
decides. It runs discovery, shapes every part's tap boxes and keeps them clear
of the seats and of each other, and reports EVERY placement whose description
names something a player would expect to use (`movableClassOf`: a door, gate,
window, hatch, cupboard, lid, drawer, seat, bed, lever or turnable) with its
verdict:

- `found` - it moves, or it is a seat;
- `static` - matched but left in the shell, with the rule that kept it (a
  centred origin names no hinge; a leaf lying on its side; a tap box that
  cannot be kept clear; a roller segment laid flat);
- `rides` - carried by another part's entity (a glass insert, a handle);
- `excluded` - owned by a vehicle, figure, ride car or pinball table;
- `unhandled` - no rule moves it yet: the list the next rule is written from.

Container bodies (a cupboard's, a chest's), window frames, rails, bases,
headgear, wheel hubs and a stroller seat are fixtures and not listed. Every
rule is a description, a part's own frame or the model's geometry - never a
set number. The report ships in `craftmatic-diagnostics.json` as
`interactivity`, one line of it goes to the pack warnings
(`interactivitySummary`), and `bun scripts/_ix_audit_report.ts <dir>` prints
it over built packs.

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
  exist), and **tap boxes that follow the part's own shape**
  (`minecraft:custom_hit_test`, `interactiveHitboxes`): a leaf is cut into
  stretches of at most 0.45 block along its width, each boxed by its own extent
  (full height; a hatch or casement into a grid), closed AND swung open - the
  runtime swaps the set with the state, so a finger on the open leaf closes it.
  Turnables and levers are one box. Before compiling, `separateHitboxes` shrinks
  any box that overlaps a seat's box or another part's box in either state.
  The first build used the collision box as the tap box (square, 1.5 x the
  leaf's width): on the device (2026-09-24d) 76457's window box took three
  taps meant for the chair beside it and a tap at a window opened the door
  next to it. The collision box is now a 0.25-wide needle as tall as the tap
  boxes: it only sets the render cull (64 x its diagonal, at least 64 blocks).
  Bedrock picks only an entity that renders cubes (pinball device rounds); the
  part's own cubes are those.
- **yaw 0, turned and scaled by its root bone.** Bedrock never rotates
  `custom_hit_test` boxes (they are world-aligned), so a part is spawned at
  yaw 0 and the placement's quarter turn and wand size ride on actor
  properties (`craftmatic:turn`, `craftmatic:size`) that the rig's `ix_root`
  bone follows; the tap boxes for each turn x size x state are component
  groups (`craftmatic:ixh_<turn>_<size>_<c|o>`) the runtime selects. The
  root's sign follows the flipper convention: body yaw θ is a right-handed
  turn of −θ about up, a channel value of +θ.
- **the entity origin** at the closed assembly's bottom centre (`originLdu`), so
  it stands in the cleared doorway, lit like the air around it.

## How interaction works

`scripts/interactives.js` (`interactivesRuntime`, serialised with `.toString()`):

- A tap (`world.afterEvents.entityHitEntity` from a player) or an interact
  (`playerInteractWithEntity`) toggles the part; a second event for the same
  entity within 6 ticks is the same tap reported twice.
- Doors, gates, hatches, cabinets, windows open and close; a **double door's
  leaves move together** (`pairDoubleDoors` → `pairs`: same kind, heights
  overlapping, and either parallel with the free edges within 0.35 block, or
  the hinges the two leaves' widths apart - which still finds a double door
  the source left open, 76269's - or one leaf's closed cells a step along the
  other's normal, where neither passes unless both open: 10326's two leaves
  meeting at a corner). Doorways
  whose closed cells merely share or touch a cell (`linkSharedDoorways` →
  `shares`) keep a shared cell laid while either is closed, but move on their
  own: the first build moved every touching pair together, so 76457's Door 1
  swung whenever Door 2, hung beside it on the same side, was tapped (device
  2026-09-24e). Over the favourites 20 doorways touch another; 16 are halves of
  one entrance, 4 move on their own (76457's Door 1 and 2, 42670's two
  staggered doors);
  `bun scripts/_ix_pairs_report.ts <dir> [--recompute]` lists them. Levers
  flip; turnables turn a step.
- Sounds: `random.door_open` / `random.door_close`, `random.click` for levers
  and turnables.
- **Taps through walls are ignored, and say so**: collider blocks have no
  selection box, so a tap aimed at a wall used to reach a door in the next
  room (76417's shop door through the bank-hall wall, device 2026-09-24d). The
  runtime refuses a tap when a wall-height collider stands on EVERY line of
  sight from the player's eyes to the part's current tap boxes (each box's
  centre and its point nearest the eyes; the item ships its boxes as `hit`).
  It is a line of sight, not the camera's view ray: on a touch screen the
  finger is not where the camera looks, and the first filter (the view ray,
  0.75 block margin) refused 76457's Door 1 from where the player stood.
  A collider cell the part's own boxes reach into (a window in its wall cell,
  a leaf 9 degrees off the grid poking into its frame's cell) and the
  doorway's own closed cells are not a wall, nor is the last 0.3 block of a
  line. A refused tap says *"The door 1 is behind a wall from here - step in
  front of it"*: a tap that does nothing reads as a broken part.
- **Reach**: Minecraft hands a tap on an entity to the script only within
  the player's reach - about 3 blocks on the Pixel (device 2026-09-24e: a door
  from 6.5 blocks and a turned door from 3.5 did nothing). Nothing reaches the
  script beyond that, so the pack says where to stand in the wand menu
  (`INTERACTIVE_REACH_NOTE`). A window 5 blocks up is out of reach from the
  street: tap it from the room behind it.
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
4. It never overwrites a block that is not a collider (the player built there).
   It refuses to close only on a player or figure standing IN THE CLOSED LEAF
   (its slab, sampled every 0.15 block) - the first build refused anyone in
   the doorway's whole blocks, and 76417's front doors stayed open for a player
   standing just outside them (device 2026-09-24d). Anyone else inside the
   doorway's blocks is stepped out along the leaf's normal to their own side.
5. **A raised threshold gets a tread.** A leaf standing on a plate or two over
   the floors either side is a rise past the 9/16 auto-step: walking at
   41732's shop door the device player stopped short. A half-way tread is laid
   on the floor beside it, both ways (`thresholdTreads` in the diagnostics), and
   the passability test now requires every OK doorway at 100 % to be walked
   through without a jump.

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

## Clearance: colliders pulled back to the geometry

The user's brief (2026-09-25): *"at minifig = player height scale most
hallways and rooms are too narrow or low for the player to fit … offset
virtual boundaries by maybe 1/4 to 1/2 block … it must never be applied
incorrectly (reducing movement space), only when certain … not just walls,
too-low ceilings too."*

Why rooms are full. A collider is one block; `buildColliderGrid` makes a cell
a collider whenever any geometry reaches into it, and before this change its
collision box was always the WHOLE footprint (only the height was measured,
`lo..hi` sixteenths). A 1-stud wall is 20 LDU = 0.38 block, and where it
straddles a cell boundary it fills two whole blocks; a minifig room is 5-8
studs (1.9-3 blocks) wide, so its walls take most of it. That is what the 36
SEALED doorways of the 40-set audit open onto.

### What a collider may be (Bedrock, researched 2026-09-25)

- A custom block's `minecraft:collision_box` may be any box inside the block:
  origin (-8, 0, -8) to (8, 16, 8) in pixels, so narrower than a block
  horizontally (Microsoft Learn, *Block Components - minecraft:collision_box*;
  stable since 1.19.50). Since 1.26.0 it may also be an ARRAY of up to 16
  boxes, stable, no experiment (same page).
- A block state has at most 16 values; a block at most 65,536 permutations,
  and a world *should* stay under 65,536 custom permutations in total
  (bedrock.dev, *Block States* / *Block Permutations*). The permutation list is
  a Molang condition per entry, so a block's cost is (registered states) x
  (entries).

So clearance ships as THINNER colliders, never missing ones. One state per
shape would multiply the collider's 256 registered permutations by the shape
count and its 136 condition entries by the same, so each shape is its own
block id, each with the same `lo` / `hi` states and 136 entries
(`craftmatic:collider` itself is unchanged, and stays the full-footprint form).

### The forms

A collider cell is one of (`collider-clearance.ts`, `COLLIDER_VARIANTS`):

- **full** `lo..hi` over the whole footprint (the old collider, variant 0);
- **wall** `lo..hi` over a SHAPE: a band a quarter-block multiple wide along x
  or z - `[0,4] [0,8] [0,12] [4,16] [8,16] [12,16] [4,12]` sixteenths, 14
  shapes, closed under the wand's quarter turns;
- **floor + wall**: full `lo..hi` and the shape from `hi` to the top of the
  block - a wall standing on the floor plate in the same block row;
- **wall + ceiling**: the shape from the bottom of the block to `lo` and full
  `lo..hi` - a wall's top under the ceiling plate in the same row.

43 blocks, 5,848 condition entries in all (the old block had 136). The two
split forms use the 1.26.0 array. `colliderCover` turns any set of boxes in a
block into the form of least volume that CONTAINS them all; the re-lay at
another wand size and turn, the doorway runtime, the Walk add-on, the walk
harness and the build all use that one function (plain JavaScript, serialised
into the runtime like `ixWorldBlocks`).

### Computing the free space

`buildColliderGrid` keeps, per collider cell, the part boxes clipped to it
(sixteenths, rounded outward - the same membership and rounding as the cell's
own `lo..hi`). Clearance runs AFTER the doorway cut (`planInteractiveColliders`
sees only full cells, as before) and then refreshes every doorway's neighbour
cells, which now carry their form. For each cell it proposes
`colliderCover(its geometry)`; nothing else. So:

- **a wall is pulled back to its own geometry, away from the free side** -
  the direction comes from where the geometry is, never from a guess;
- **floors stay**: a cell whose top is a standing surface (1.5 blocks free
  above it in the column) may only take a form whose top sixteenth is still
  the full footprint (a floor band or a ceiling band that IS the floor above);
  a phantom ledge a player stood on is never taken away;
- **ceilings**: a column whose clear height over a floor is at least a
  sneaking player (1.5) but under a standing one (1.8) has the ceiling cell's
  `lo` raised to 1.8 over the floor, at most 5/16, only when the cell keeps
  at least 2/16 of collider above and its form is full; the head goes into
  the visible ceiling slab by at most 0.3 block, never through it.

### The certain test

A proposal is APPLIED only when every rule holds, and each refusal is logged
with its reason (`craftmatic-diagnostics.json`, `clearance`):

1. **Subset** - the new form's boxes lie inside the old full cell: a trim
   never turns free space solid (checked per cell, and again for every world
   block the re-lay produces at every wand size).
2. **Superset of the geometry** - the form contains every part box in the cell
   (a wall trim), or it is the ceiling rule. So wherever the visible model is
   continuous the colliders are continuous.
3. **Not at a door** - no cell a closed leaf's box reaches (the frame's sliver
   past the leaf, the leaf's own cells, the cells the doorway cut touched) is
   trimmed: `door-leaf` / `door-cut`.
4. **Floors stay** - above: `walkable-top`.
5. **No leak** (the global check). Three worlds are flooded at quarter-block
   resolution from outside the model with a flying, SNEAKING player 0.5 block
   wide (narrower than the real 0.6, so a leak is found sooner): the part
   geometry with every closed leaf, the colliders BEFORE clearance with the
   closed doorways laid, and the colliders AFTER. A block the after-flood
   reaches that neither other flood reaches is a leak - into a sealed vault, a
   room behind a closed door, through a gap the model does not have. Every
   applied trim within one block of a leak is refused (`leak`) and the check
   runs again; if it has not converged in 8 rounds every trim is refused.

With rule 2 the after-world contains the geometry world, so the flood can only
find a leak through a bug or through the ceiling rule; with rule 5 neither
ships.

### The calculator

`bun scripts/_clearance_report.ts <sweep dir> [--sizes=100,150,200,300,400]`:
per set, the player-reachable standing area (a 0.6 x 1.8 player walked on foot
from outside, quarter-block steps at 100 %, with doors open), the rooms that
area reaches, and the doorway verdicts, from the pack's colliders AS SHIPPED
and with clearance undone (every form read as the full cell it came from), at
100 % and at each wand size. `_ix_sweep_report.ts` gives the doorway verdicts
alone.

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
- `test/interactive-passability.test.ts`: builds 31141, 10022, 76417, 76457
  and 41732 as the CLI does, audits their shipped tap boxes (no two parts'
  boxes overlap in any state, none covers a seat) and and walks a 0.6 x 1.8 player (the walk module's per-tick Minecraft
  physics) through every doorway at 100 and 200 %, turned 0 and 90: open passes
  where `passSize` allows, closed never does.
- `bun scripts/_ix_passability.ts <pack…> [--sizes=] [--rotations=] [--json=]`:
  the same walk over any built pack, one verdict per doorway (OK, SMALL, SEALED,
  NO-APPROACH, FAIL; exit 1 on FAIL). `bun scripts/_ix_report.ts <pack>` lists
  the parts; `bun scripts/_ix_doorway_map.ts <pack> <i>` draws one doorway's
  collider plan; `bun scripts/_ix_hitbox_audit.ts <pack | dir>` audits the
  shipped tap boxes (exit 1 on any overlap).
- `bun scripts/_ix_tap_probe.ts <pack | dir> [--trace=<label>]`
  (`test/_ix-tap-audit.ts`): lays the pack's colliders in the runtime host,
  and from every spot a player can stand within 3 blocks of a part, with no
  other part's box or seat in front, taps each of its closed boxes through the
  REAL runtime. Exit 1 when a reachable part refuses every tap; `--trace`
  prints each spot. The passability test runs it over its five sets.
  `bun scripts/_ix_host_trace.ts <pack> <label> <feet x,y,z>` taps one part
  from one spot with every part spawned (double-door partners included) and
  prints what the runtime did.
- Seats: `bun scripts/_seat_scan.ts <ldr…> | --sweep <summary.json> [--why]`
  lists every seat and stool with a stool's column; `--why` says why each 2 x 2
  tile is or is not a stool. `bun scripts/_ix_seat_support.ts <pack | dir>`
  prints each shipped seat over the collider under it.
- The wand's door count is the walk's: the pack walks every doorway at 100 %
  at export and says *"Doorways a player walks through at 100 percent over this
  pack's own blocks: 5 of 6. Door 3 opens onto the model's own solid geometry
  or a drop"* in the wand menu. The access recommendation's "6/6 clear the 1x2
  passage" (41732) counts openings big enough, not doorways reachable.
- The Walk add-on: E (or the touch Interact button) toggles the nearest part
  with the runtime's rules, the leaf swings about its real hinge over 0.4 s, the
  closed leaves' colliders are drawn (door-blue) and collided with.
  `node scripts/_shoot_addon_walk.mjs <pack> <out.png> model doors --door=<n>`
  shoots a part closed, open, and after a walking player tried to pass.

## Brick-built seats

LEGO's modern furniture has no seat mould. `brickBuiltStools` seats a 2 x 2
tile (`isStoolTop`: plain, round, grooved or with studs on edge) that stands
upright on a column no wider than itself, 6 to 32 LDU over its floor (a plate
to a brick and a third; 4079's pan is 16), with nothing else at its height
touching it (a counter or a table top), two bricks of head room, and facing the
nearest higher part beside it (a table). The floor is the first part wider than
the tile under the column, a layer where other parts stand flush beside it, or
the model's underside within a plate. A tile lying straight on a wide part is
floor decoration. 76457's dark-red stool by Window 3 (a studs-on-edge tile on a
2 x 2 round plate, on the grass: the room has no floor of its own) had no seat;
the seat the device found "3.75 blocks up" was the upstairs chair right above
it, correctly on its own pan (4079b at LDraw y -188 on the first floor). Now
the stool has its own seat on its top, and 76457's two dark-green brick-built
chairs upstairs (a studs-on-edge tile on two 1 x 2 plates) get one too.

A library chair's box top is its backrest (4222a Fabuland chair: 40 LDU over
the pan), so furniture moulds now sit on the pan a vertical line down the
middle meets (`seatPanLocalY`). The 4079 family keeps `origin - 8`: its pan is
at the origin and the extra plate is the stud a minifig sits over.

`brickBuiltFurniture` generalises the stool to benches, chairs, sofas and
beds. The seat is a flat surface of plates or tiles - one part, or several
side by side at one height (a two-tile mattress, a sofa seat of two plates) -
1-2 studs by 2-6 (a seat) or 2-4 by 4-8 (a bed), 12-32 LDU over its floor
(8-32 for a bed), with no counter continuing it. It is a BENCH on legs (what
holds it up covers under 70 % of its footprint), a CHAIR or SOFA with a
backrest rising 20-60 LDU along a long side (facing away from it; head room is
checked only over the backrest half, since a dining chair is tucked under its
table's edge), a BED with a headboard rising 8-60 LDU at a short end. A long
bench or sofa gets one seat per two studs, up to three. What it cannot see: a
seat whose surface is a slope or a brick top, a mattress with no headboard
(42663's camper beds), furniture inside a closed wall, a seat under something
over its whole surface. The favourites' counts and the misses are in the
40-set table below; `bun scripts/_seat_scan.ts <ldr> --why` says why each
surface is or is not furniture.

## Not verified on a device

Device round 2026-09-24d (packs at 8346fb29): doors render as LEGO, open and
close on tap, walk-through confirmed (76457 doors, 76417's front double doors
and 45-degree barred door). Device round 2026-09-24e (packs at 1e33902c):
76417's front doors open, close and block both ways; the through-wall filter
worked there; 41732's doors 4 and 5 walk both ways and the wand reads 5 of 6;
76457's Doors 2-5 and Gate 1 open and close, a 90-degree placement's Door 3
works. Fixed since, unproven on the device: the line-of-sight tap filter and
its message, double doors paired only when they are one (76457's Door 1), the
stool seat, the reach note. The GameTest round (2026-09-25, below) proved on
the device, server side, that every moving part of the 37 testable favourites
toggles on a hit and every seat (moulded, stool, bench, chair, bed) mounts.
Still unproven: `custom_hit_test` picking by a real finger (and that `pivot` is
the box centre), how a sliding part (drawer, garage door) LOOKS as it slides
(the direction is derived), the root-bone scale at a non-100 % size, the
occupant step-out and the threshold treads.

## The 40-set audit (2026-09-25)

Every favourite set, exported from its index first pick through the one
interactivity stage (`bun scripts/_favorites_export_sweep.ts` at `7867a80f`),
against what a person saw in renders of the same source (four agents, 4-18
views each, `output/interactivity-0924/audit-visual/<set>.json`; sightings
marked low-confidence are listed there but not counted here). **found** is
the stage's own report (`interactivity` in the pack diagnostics; a
`container` is a cupboard door, lid or drawer). **missed** is what was seen
and not found; **found more** is what was found and not seen - a hidden
interior, a part the renders did not show as movable, or a false positive
(see below). **doorways** is the offline walk at 100 % (turn 0) and at the
recommended size. **GameTest** is the in-game run on the Pixel.
`bun scripts/_ix_audit_table.ts <sweep dir> --walk=<json>
--gametest=<dir>,<dir>` regenerates it (a later directory's log wins).

| set | found | seen in renders (brick-built) | missed | found more | doorways walked | GameTest |
|---|---|---|---|---|---|---|
| 10261 | 4 container, 4 seat, 1 lever | 3 seat, 1 mechanism | 1 mechanism | 4 container, 1 seat, 1 lever | no doorways | parts+seats 9/9, figures 5/7 moved |
| 10303 | 2 seat, 4 turnable | 3 seat, 1 mechanism (1) | 1 seat, 1 mechanism | 4 turnable | no doorways | parts+seats 6/6, figures 7/8 moved |
| 10326 | 6 door, 1 window, 1 seat, 2 lever, 1 turnable | 3 door, 1 seat (1), 1 turnable (1), 1 mechanism (1) | 1 mechanism | 3 door, 1 window, 2 lever | 3/6 at 100 % | doors 4/4, parts+seats 7/7, figures 6/7 moved |
| 10337 | 1 turnable | 2 door (2), 1 hatch (1), 2 seat (2) | 2 door, 1 hatch, 2 seat | 1 turnable | no doorways | not run |
| 10341 | 1 turnable | 1 mechanism (1) | 1 mechanism | 1 turnable | no doorways | parts+seats 1/1 |
| 10354 | 2 window, 3 container | 1 door (1), 1 mechanism (1) | 1 door, 1 mechanism | 2 window, 3 container | no doorways | parts+seats 5/5, figures 8/9 moved |
| 10365 | 1 container, 2 seat, 1 turnable | 10 mechanism (1) | 10 mechanism | 1 container, 2 seat, 1 turnable | no doorways | parts+seats 3/3, figures 6/8 moved |
| 11371 | 8 door, 2 window, 3 seat, 1 lever | 5 door, 1 container (1) | 1 container | 3 door, 2 window, 3 seat, 1 lever | 1/8 at 100 % | doors 7/7, parts+seats 7/7, figures 5/7 moved |
| 11374 | - | 5 lever (2), 2 turnable, 3 mechanism (3) | 5 lever, 2 turnable, 3 mechanism | - | no doorways | pinball pass |
| 21061 | - | 3 door (3) | 3 door | - | no doorways | not run |
| 21063 | - | 1 gate (1) | 1 gate | - | no doorways | not run |
| 21318 | 3 door, 1 turnable | 2 door, 4 seat (4), 1 lever (1), 1 mechanism (1) | 4 seat, 1 lever, 1 mechanism | 1 door, 1 turnable | 0/3 at 100 % | doors 2/2, parts+seats 1/1, figures 3/4 moved |
| 21360 | 4 seat, 1 turnable | 3 seat (3), 2 mechanism (2) | 2 mechanism | 1 seat, 1 turnable | no doorways | parts+seats 5/5, figures 9/9 moved |
| 31141 | 5 door, 2 window, 3 seat, 3 lever, 1 turnable | 3 door, 5 seat (3), 2 turnable | 2 seat, 1 turnable | 2 door, 2 window, 3 lever | 4/5 at 100 % | doors 5/5, parts+seats 9/9, figures 2/6 moved |
| 41395 | 2 door, 1 window, 1 container, 1 lever, 1 turnable | 3 door (2), 1 turnable, 2 mechanism (1) | 1 door, 2 mechanism | 1 window, 1 container, 1 lever | 0/2 at 100 % | doors 1/2, parts+seats 4/4, figures 3/3 moved (failed: Door 1) |
| 41703 | 1 door, 8 window, 1 container, 5 seat, 1 lever | 1 door, 1 window, 1 container, 1 seat, 2 turnable, 2 mechanism (1) | 2 turnable, 2 mechanism | 7 window, 4 seat, 1 lever | 1/1 at 100 % | doors 1/1, parts+seats 15/15, figures 3/4 moved |
| 41732 | 6 door, 2 window, 9 seat | 2 door, 2 container (2), 8 seat (5) | 2 container | 4 door, 2 window, 1 seat | 5/6 at 100 % | doors 6/6, parts+seats 11/11, figures 6/7 moved |
| 42172 | 1 turnable | 2 door (2), 1 turnable, 1 mechanism (1) | 2 door, 1 mechanism | - | no doorways | parts+seats 1/1 |
| 42639 | 2 door, 3 seat, 1 turnable | 1 door, 1 gate (1), 2 container (2), 2 seat (2), 3 bed (3) | 1 gate, 2 container, 3 bed | 1 door, 1 seat, 1 turnable | 1/2 at 100 % | doors 2/2, parts+seats 4/4, figures 6/8 moved |
| 42652 | 1 door, 4 window, 1 lever, 1 turnable | 2 door (1), 2 seat (2), 1 bed (1), 1 mechanism | 1 door, 2 seat, 1 bed, 1 mechanism | 4 window, 1 lever, 1 turnable | 1/1 at 100 % | doors 1/1, parts+seats 6/6, figures 4/4 moved |
| 42663 | 1 door, 1 window, 2 container, 1 turnable | 1 door, 2 seat, 3 bed (3), 2 mechanism (2) | 2 seat, 3 bed, 2 mechanism | 1 window, 2 container, 1 turnable | 0/1 at 100 % | doors 1/1, parts+seats 4/4, figures 2/3 moved |
| 42670 | 7 door, 2 container, 1 lever | 3 door, 1 gate, 6 seat (4), 1 mechanism | 1 gate, 6 seat, 1 mechanism | 4 door, 2 container, 1 lever | 3/7 at 100 % | doors 4/5, parts+seats 5/5, figures 4/7 moved (failed: Door 4) |
| 43267 | 2 container, 5 seat, 1 turnable | 3 container (1), 1 bed (1), 1 mechanism | 1 container, 1 bed, 1 mechanism | 5 seat, 1 turnable | no doorways | parts+seats 8/8, figures 4/5 moved |
| 60380 | 3 door, 13 window, 2 container, 8 seat, 2 turnable | 3 door, 7 seat (7), 3 mechanism (2) | 3 mechanism | 13 window, 2 container, 1 seat, 2 turnable | 1/3 at 100 % | doors 2/2, parts+seats 26/26, figures 11/14 moved |
| 60446 | 4 seat | 4 hatch (2), 2 seat, 1 mechanism | 4 hatch, 1 mechanism | 2 seat | no doorways | parts+seats 4/4, figures 1/3 moved |
| 71040 | 2 door, 2 container, 1 seat, 5 turnable | 3 door, 1 window, 1 container (1), 1 bed (1), 1 lever, 1 mechanism (1) | 1 door, 1 window, 1 bed, 1 lever, 1 mechanism | 1 container, 1 seat, 5 turnable | 0/2 at 100 % | doors 1/1, parts+seats 8/9, figures 0/2 moved, 1 in a wall (failed: Door 1) |
| 71043 | 9 turnable | 1 door, 4 seat (4), 1 bed (1), 2 mechanism (2) | 1 door, 4 seat, 1 bed, 2 mechanism | 9 turnable | no doorways | parts+seats 9/9, figures 3/4 moved |
| 75397 | 1 door, 3 container, 1 seat, 5 turnable | 2 turnable, 4 mechanism (4) | 4 mechanism | 1 door, 3 container, 1 seat, 3 turnable | 0/1 at 100 % | doors 1/1, parts+seats 6/6, figures 5/6 moved |
| 76269 | 3 door, 12 window, 3 container, 10 seat | 1 door, 1 mechanism (1) | 1 mechanism | 2 door, 12 window, 3 container, 10 seat | 2/3 at 100 % | doors 3/3, parts+seats 25/25, figures 13/20 moved |
| 76286 | - | 1 hatch, 2 seat (2), 2 mechanism (2) | 1 hatch, 2 seat, 2 mechanism | - | no doorways | figures 4/4 moved |
| 76417 | 4 door, 4 window, 1 container, 1 seat, 2 bed | 4 door, 3 container, 1 seat (1), 1 lever, 1 mechanism (1) | 2 container, 1 lever, 1 mechanism | 4 window, 2 bed | 3/4 at 100 % | doors 3/3, parts+seats 9/9, figures 9/11 moved |
| 76419 | 1 seat | 2 gate (2), 1 mechanism (1) | 2 gate, 1 mechanism | 1 seat | no doorways | parts+seats 1/1 |
| 76435 | 2 door, 7 seat | 3 door (1), 1 seat | 1 door | 6 seat | 1/2 at 100 % | doors 2/2, parts+seats 7/7, figures 8/10 moved |
| 76457 | 6 door, 3 window, 7 seat, 1 bed, 2 turnable | 6 door, 1 gate (1), 1 window, 3 container, 3 seat (1), 1 bed (1) | 1 gate, 3 container | 2 window, 4 seat, 2 turnable | 6/6 at 100 % | doors 6/6, parts+seats 13/13, figures 11/12 moved |
| 77092 | 1 container | 1 door (1), 1 container, 1 bed (1), 1 mechanism | 1 door, 1 bed, 1 mechanism | - | no doorways | parts+seats 1/1, figures 2/4 moved |
| 80049 | 1 door, 4 window, 2 seat | 2 door (2), 4 seat (4), 1 bed (1) | 1 door, 2 seat, 1 bed | 4 window | 0/1 at 100 % | doors 1/1, parts+seats 6/6, figures 7/8 moved |
| 910004 | 3 door, 8 window, 2 container, 9 seat | 7 door (1), 4 window, 7 seat (1), 4 bed (4), 1 mechanism | 4 door, 4 bed, 1 mechanism | 4 window, 2 container, 2 seat | 1/3 at 100 % | doors 3/3, parts+seats 19/19, figures 3/4 moved |
| 910032 | 5 door, 4 seat, 4 bed, 10 turnable | 6 door, 1 gate (1), 6 window, 3 container (3), 16 seat (12), 1 bed (1) | 1 door, 1 gate, 6 window, 3 container, 12 seat | 3 bed, 10 turnable | 3/5 at 100 % | doors 5/5, parts+seats 18/18, figures 4/7 moved |
| 910047 | 1 container, 2 seat | 1 gate (1), 3 container, 1 seat (1), 1 bed (1), 5 mechanism (4) | 1 gate, 2 container, 1 bed, 5 mechanism | 1 seat | no doorways | parts+seats 3/3, figures 6/9 moved |
| 910049 | 1 door, 1 seat, 1 turnable | 1 gate (1), 1 mechanism (1) | 1 gate, 1 mechanism | 1 door, 1 seat, 1 turnable | 0/1 at 100 % | parts+seats 3/3, figures 6/8 moved, 1 in a wall |

Totals over the 40 packs: 40/40 export and validate; 73 doorways, 0 FAIL, 36
walked through at 100 %, 1 at its passable size, 36 SEALED; 233 moving parts,
1,512 tap boxes, 0 overlaps, 0 over a seat, 0 without a box; the tap probe
finds 227 parts that take a tap from a standing spot within 3 blocks, 3 that
refuse every one (10337's and 75397's turnable inside a closed body, 10365's
chest lid in the hold) and 3 no standing spot reaches (21318's and 75397's
turnable, 75397's drawer). The stage reports 0 unhandled candidates: every
part whose description names a movable thing is found, static with a
reason, carried, or owned by another entity.

SEALED means the doorway opens (the leaf swings, its cells clear) but one side
has no floor a player can stand on along the straight corridor through it:
76417's 4-pane shop door stands at the platform edge over a drop, 42663's van
door opens onto furniture, and most of the rest open onto rooms the shipped
COLLIDER grid has filled (a collider cell is a whole block whenever any
geometry reaches it, and a minifig room is 2-3 blocks wide with furniture in
it). The fix is finer colliders, not a bigger doorway cut (open in
`TASKS-BEDROCK-ADDON.md`).

### GameTest on the Pixel (cmgametest, 2026-09-25)

37 sets ran (21061, 21063 and 10337 have nothing to test); logs in
`output/gametest/ix-7867/logs/` and, for the seven re-run on the fixed build
`4ee514b5`, `output/gametest/ix-4ee5/logs/`. **Doorways 61/63 as the offline
walk predicts; parts and seats 269/270; pinball pass.** Every seat mounted
(a seat a figure was sat on holds its figure). The first run found one real
fault, fixed in `4ee514b5`: a window, lid or cupboard door never closed
again when the player stood at it, because the runtime's "never close on
someone" test covered every leaf; only a doorway checks now. What is left:

- **71040 Door 1** opens on a hit and does not close on the second, from
  the spot the test chose. The tap audit picks the spot from the CLOSED tap
  boxes; from there the open leaf is behind a wall, so the line-of-sight
  filter refuses the second tap. A player walks round; the test should pick
  a spot that sees both states (TODO in `_gametest_pack.ts`).
- **41395 Door 1**: the offline walk calls it SEALED; on the device the
  player walked through it open (and not closed). The offline collider walk
  is pessimistic here - the device is the better answer.
- **42670 Door 4**: offline OK; on the device the walker FELL off the
  approach both closed and open (it ended on the arena floor). Not yet
  looked at: the doorway is up a step or on a platform the test's walk line
  runs off.
- **Figures** (the minifig-AI stage, not this one): 176 of 232 roaming
  figures moved; 71040's two never moved (one inside a wall), 31141 moved 2
  of 6, 910049 has one figure ending inside a wall.

### Why the misses

- **Brick-built doors and gates** (10354's round hobbit door, 80049's teal
  double doors, 910004's patchwork door, 910047's plank gate, 42639's garage
  gate, 910049's iron gate, 41395's glass side wings): assembled from plates
  and tiles on hinge bricks or clips. No rule finds a leaf that is not one
  part; it needs a hinge-joint detector (find the clip/hinge pair, take the
  connected slab on its free side). Not attempted.
- **Micro-scale sets** (21061, 21063, 76419): their "doors" and "gates" are
  carved recesses a few studs tall; nothing a minifig-scale player could use.
- **Vehicles' own parts** (10337's and 42172's butterfly doors, engine
  covers and seats; 76286's cockpit): brick-built on a car or ship.
- **Mechanisms** (cranes, winches, lifts, swing arms, drawbridges,
  catapults: 10341, 10365, 21318, 21360, 60380, 71043, 75397, 910047...):
  no generic mechanism rule. The pinball's flippers, buttons and plunger
  (11374) are the pinball engine's; a coaster's cars and lift (10261, 10303)
  the coaster engine's.
- **Seats** the furniture rule does not match (910032's 12, 42670's 6,
  71043's hall benches). Where looked at (910032): dining chairs whose seat
  tile sits under the table top, sofas on solid bases with no backrest the
  rule reads. The ride cars' seats are the cars'.
- **Beds**: a mattress with no headboard (42663's three camper beds), and
  910004's four, whose build the bed rule does not match (not inspected).
- **Containers**: brick-built cupboards and wardrobes, and 30150's one-piece
  "Adventurers Chest", which has no lid part.
- **Windows**: of 910032's French windows and shutters, the moulded ones the
  stage saw are fixed panes (30046, a centred origin); the rest are
  brick-built.

### What "found more" is

- Moulded opening windows (60603 casements, 60607/60608 panes: 60380 13,
  76269 12, 41703 7): each is an opening part by design; the renders showed
  them closed and read them as fixed.
- Hidden interiors: 76269's top-floor meeting room (6 chairs), cupboards and
  drawers inside closed rooms (75397, 76269).
- **False positives** known: 910032's ten steering wheels are iron-railing
  ornaments (a wheel always turns; turning it is harmless); 31141's 2 x 2
  roof tile on 1 x 2 bricks is probably a chimney cap with a seat on it; the
  remaining brick-built seats and beds were read from their columns, not
  checked in the game.
