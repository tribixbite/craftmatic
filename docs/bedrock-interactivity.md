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
  line, nor a collider form the player's own box stands in (round 30h:
  10326's Door 3 refused from inside the invisible band a tilted handrail's
  bounding box leaves at head height; "Door 3's tap and Door 2's pockets"
  below). A refused tap says *"The door 1 is behind a wall from here - step in
  front of it"*: a tap that does nothing reads as a broken part.
  Before refusing, the tap goes to what the player aimed at in plain sight
  (2026-09-26): the nearest other moving part or seat on the player's VIEW
  ray, in reach, with a clear line of sight, is toggled or mounted instead.
  On the Pixel a long press on 76457's Bed picked Door 4's box beyond a wall
  (walls have no selection box, so that box was first on the ray) and was
  refused. The refusal record (`craftmatic:ix_refused`) carries the eyes, the
  part's position and the collider cell that cut the line, for the GameTest.
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
   until a column a player can stand in - no collider in the band from a 9/16
   step over the DOORWAY's floor to 2.5 blocks over it; the columns between
   are trimmed to what lies outside that band (since 2026-09-29; the earlier
   row-based rule cleared a floor level with a high-hung leaf, see "The
   doorway's floor, a floor's top, and the device's line").
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
   doorway's blocks is stepped out along the leaf's normal - their own side
   first, then the other - onto the first point where the body is free AND
   stands on a floor at most a block under its feet; with no such point on
   either side the close is refused ("Step out of the gate to close it")
   (`stepOutPlan`, "A step-out onto a floor" below). A body only touching a
   doorway cell (under 1/64 block of overlap) is beside it, not in it.
5. **A raised threshold gets a tread.** A leaf standing on a plate or two over
   the floors either side is a rise past the 9/16 auto-step: walking at
   41732's shop door the device player stopped short. A half-way tread is laid
   on the floor beside it, both ways (`thresholdTreads` in the diagnostics), and
   the passability test now requires every OK doorway at 100 % to be walked
   through without a jump.
6. **A sunken sill gets a tread too** (`fillSunkenSills`, 2026-10-07). A
   leaf whose frame's sill lies more than the step below the floor on a side
   is a gutter: 10326's Door 3 has its sill at 3/16 between the corridor's
   tiles at 14/16 and the WC's at 15/16. A walking player crosses it in
   stride (Saga 30i), but a SNEAKING one never steps off the corridor's edge
   (Minecraft's sneak guard refuses a drop past the step) and stopped 0.24
   before the leaf on every line (Pixel 30j; the tester's HUD sneak button
   was lit from a seat exit on - the touch sneak button is a toggle, and a
   seat says "sneak to get off"); a slow walk that does drop in meets a 0.75
   riser out. The sill column is raised to half a block under the higher
   floor, only where both sides are floors with headroom, both within the
   step of the tread, and the doorway keeps 1.8 blocks over it. The cell is
   the closed leaf's (clearance leaves it), and the open state restores it
   raised. `_ix_passability.ts` walks each OK doorway's lines SNEAKING at
   100 % and prints `SNEAK-STOP` where a line the walk crosses stops; the
   regression `door3-sneak-10326` replays the Pixel's walk.

Windows, cabinets, levers and turnables are not passages: their closed part
boxes stay in the static colliders, so a closed-up window is still a wall.

## The scale rule

A doorway is passable at a size when its opening holds a **minifig**: 40 LDU
across (2 studs, the hips) and 96 LDU high (standing, head included), at the
model's own scale - 0.75 x 1.8 blocks at minifig scale, which holds the 0.6 x
1.8 player (`DOORWAY_PASS_WIDTH_LDU` x `DOORWAY_PASS_HEIGHT_LDU`, since
2026-09-29; it was a whole-block 1 x 2 passage, which kept a minifig's
0.9-block shop door shut at 100 %). A gate has no lintel (width only); a
hatch is a hole: 1 x 1 block. Each doorway ships its **`passSize`**: the
first wand size (100/150/200/300/400 %) at which its opening clears that; 0
when none does. Below it the leaf still swings open but its
colliders stay (the runtime says *"This opening is 0.8 x 1.4 blocks at 100
percent: too small to walk through at 100 percent. Place the build at 200
percent or larger to pass."*). The pack warnings carry one line per set
(*"Doorways passable (a player needs an opening a minifig fits, 0.75 x 1.8
blocks): 4 from 100 %, 2 from 200 %"*), the diagnostics carry every part's opening and `passSize`, and the
Walk add-on's legend says how many are passable at the chosen size.

## Clearance: colliders pulled back to the geometry

Ride set-down search (2026-10-05): 10797's slide terminal has no legal
standing pose within the former 1.5-block search. The runtime now searches
up to `RIDE.SETDOWN_REACH_BLOCKS = 2` (scaled with the ride, minimum 100%),
retaining the existing collision-free body and three-block maximum floor
drop requirements. A faithful substitution of only the old runtime's search
radius fixes both child-play collisions. The initially proposed compiler
landing trim was unnecessary and was removed; source geometry and collider
clearance policy remain unchanged.

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
  a phantom ledge a player stood on is never taken away - with ONE
  exception, a surface that is **only a wall's top over open air** (below);
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
3. **Not at a door** - no cell a closed leaf's mid-plane crosses, from 0.4
   block before one end to 0.4 past the other (the frame's sliver beside the
   leaf), is trimmed (`door-leaf`), nor any cell the doorway cut changed
   (`door-cut`). Cells in front of and behind a leaf may be: a trim there
   cannot open the leaf's plane (the first build protected every cell the
   leaf's box touched, which kept the approach to 11371's doors solid).
4. **Floors stay** - above: `walkable-top`. The exception (`wallTopRim`,
   2026-09-26): the top cell of a WALL may be narrowed to the wall when all of
   these hold, counted as `wallTops` in the report:
   - the proposal is a plain wall band (kind 0) from the cell's bottom, and the
     cell below has geometry in its top sixteenth under the band - the wall
     rises through the row boundary (a plate on the ground, a floor, a roof
     slope's floor + wall form never qualify);
   - every freed strip opens sideways onto a neighbour column with NO collider
     (as built, the cut and every closed doorway laid) from the strip's floor
     (the highest geometry under it; the lowest the floor can be) up to a
     standing player's head over the top: the rim was a shelf over open air,
     so no surface beside it is lost and the strip is no new pit;
   - it is no doorway's landing: not within 2 blocks of a closed leaf with its
     top within a jump (1.25) of the leaf's foot. Without this guard 31141's
     Doors 3 and 5 read ONE-WAY (their only level spot outside was such a rim).

   Why: device round 2026-09-26a, 76457. The Pixel player walking from the
   street to Doors 1-2 stopped at z 7.3 (pin 2000) and no jump cleared it.
   In front of those doors stands the set's sweet stand, a 2x8 plate
   (`3034`) turned 16 degrees carrying about 25 parts up to 2.03 blocks (bricks
   1932-1956 of `DbixConvV3/76457.ldr`). Its top row (y 1.0-1.94) holds
   geometry only over z 6.0-6.6 of the z 6 cells, but rule 4 kept each of
   those cells whole: the collider face stood at z 7.0, 0.4-0.7 block in front
   of the stand from the knee to over the head. An OLD fault - in the 25c pack
   the whole column was solid 0.06-1.94 - which clearance had halved (row 0)
   and refused in row 1 as `walkable-top`. With the exception the rim is at the
   stand (z 6.5): `bun scripts/_walk_line.ts <pack>` stops the 26a pack at
   z 7.30 for x 13.8-15.0 (the device's reading) and walks the fixed one onto
   the stand and up to the closed Door 1 (z 4.30 at x 14.6); all six doorways
   stay OK. The column at x 15 keeps its rim: it lies within 2 blocks of
   Door 2 and 0.8 over its foot (the landing guard), so at x 15.0-15.9 the
   edge is still ~0.7 block proud of the stand. The stand itself is real
   geometry and blocks the straight line to Doors 1-2: they are reached
   around its east end (x 16.5) or over it. Saga (26.52): the player walked
   past z 2007.3 onto the stand (z 2005.30).

   Over the 40 favourites (sweeps at `e7398be3` and `e0330b31`,
   `_clearance_report.ts --sizes=100,200`): reach at 100 % 18,681.5 ->
   19,774.4 blocks² (+5.8 %), at 200 % 21,915.9 -> 21,930.4; doorways OK 41 /
   SEALED 29 at 100 % and 51 / 22 at 200 %, unchanged in every set; FAIL 0;
   `_ix_passability.ts` 0 FAIL at 100/200 %, turns 0/90. Where a set's reach
   FELL, it fell by less than the rim area removed (10261 at 100 %: -87
   blocks² of reach, 230 blocks² of phantom top narrowed; 42663: -9 vs 18;
   the rest at most -1.5 % at 200 %): the standing spots lost are the phantom
   rims themselves, which the reach walk had counted. Room counts fall because
   rims were counted as rooms.
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

### Where the forms go at another size

A cell's form is laid by `cellPieces`: its boxes, turned with the cell, are
spread over the world columns the cell owns (the re-lay's centre rule), and
each world block takes `colliderCover` of the pieces that land in it - a block
two cells share covers both. Below 100 % a form is widened to the full block
(several cells share one there). A structure turned by `structure load` keeps
block states, so at 100 % the placement re-sets every form cell of each piece
to its turned form while the piece is loaded; the same pass lays a form the
world cannot resolve (an older pack's definitions winning) as the full
collider over its extent (`lay`, logged `BRICK_WAND_FORM_FALLBACK`): a wall too
thick, never a hole. The re-lay and the doorway runtime use `lay` too.

Invisible steps (`bedrock-collider-scale.ts`) are planned over the grid as it
was before clearance, every form read as its full cell. A tread only fills a
column the planner found standable and clear, so its never-block check holds
in a world at least as blocked as the one the pack lays; planning on the forms
opened columns at 300-400 % that failed the planner's fast verification, and
its slow path took 10261 from 70 s to 190 s to export.

### The calculator

`bun scripts/_clearance_report.ts <after dir> --before=<before dir>
[--sizes=100,150,200,300,400] [--sets=…] [--json=] [--md=]`, over two
`_favorites_export_sweep.ts` directories (built without and with clearance):
per set and size (turn 0), the standing area a 0.6 x 1.8 player reaches on
foot from the ground around the model (a quarter-block lattice, half a block
from 300 %; every passable doorway open; divided by the size factor squared
so sizes compare), the flat regions ("rooms", at least one square block) that
area reaches, and the doorway verdicts. `_ix_sweep_report.ts` gives the
doorway verdicts alone. A region count can FALL when a wall thins enough to
join two regions into one; the area is the number to read.

### The walk harness learned the forms

`interactive-walk.ts` routes over columns, then walks the per-tick player
over the real boxes. A column a form leaves at least half free is open to the
route; the player stands at the centre of the free part (aiming at the column
centre ran it into the form); a move crosses a face only where both columns'
free parts meet it (a thin wall on the boundary closed 42639's Door 1, which
the route had run straight through); a drop must fall through a free span of
the neighbour column (a route stepped off 42663's roof through the ceiling
below); and an approach stands within a jump of the door's floor (a roof over
the door is not an approach). None of these changes a verdict on the packs
built before clearance (36 OK, 36 SEALED, 1 SMALL, as the audit found).

### Results over the 40 favourites (2026-09-25, final at `f6e24774`)

Before: the sweep at `bb6dcf8e` (no clearance). After: the sweep at
`f6e24774` (clearance, the walk-harness fixes, merged with main). Clearance
examined 61,845 collider cells holding geometry: 16,828 are filled by their
geometry already, 32,950 were pulled back to a wall form and 179 ceilings
raised (10,630 cubic blocks freed); refused: 10,587 standing surfaces
(`walkable-top`), 1,106 cells the doorway cut had changed, 165 at a closed
leaf's plane, 226 near a leak (15 sets), 0 unverifiable. The pass takes at
most 0.94 s a set (at most 3.0 M voxels). The leaks it found were real routes -
traced on 11371: a cell beside a closed door that the collider grid already
left open while the geometry fills it, joined to a trimmed cell behind it -
and each was refused.

| size | standing area reached (blocks², 100 % scale) | rooms reached | doorways OK | SEALED | FAIL |
|---|---|---|---|---|---|
| 100 % | 17,655 → 18,670 (+5.7 %) | 617 → 642 | 36 → 38 | 36 → 34 | 0 → 0 |
| 150 % | 18,437 → 19,355 (+5.0 %) | 681 → 735 | 38 → 41 | 34 → 31 | 0 → 0 |
| 200 % | 20,691 → 21,873 (+5.7 %) | 1,001 → 1,050 | 39 → 42 | 33 → 28 | 0 → 0 |
| 300 % | 20,812 → 21,938 (+5.4 %) | 945 → 971 | 32 → 36 | 32 → 27 | 0 → 0 |
| 400 % | 20,690 → 21,785 (+5.3 %) | 920 → 990 | 26 → 29 | 32 → 28 | 0 → 0 |

(The before counts at 150-400 % differ from the audit's because the walk
harness itself changed - see "The walk harness learned the forms"; both
columns here use the final harness.)

Unsealed at 100 %: 76435's Door 1 and 80049's Gate 1 (both walked on the
Pixel, below). 910004's Door 3 read OK in this sweep and is SEALED since
`e68194e9`: its only level approach spot stood inside the closed leaf (see the
device results), so the final count is 38 OK / 34 SEALED. Per set
(forms = cells laid as a clearance form):

| set | forms | reach 100 % (blocks²) | rooms reached 100 % | doorways OK / SEALED 100 % | reach 200 % | doorways OK / SEALED 200 % |
|---|---|---|---|---|---|---|
| 10261 | 1951 | 1825 → 1961 | 156 → 138 | 0 / 0 → 0 / 0 | 1741.8 → 1860.6 | 0 / 0 → 0 / 0 |
| 10303 | 2193 | 851.3 → 912.4 | 61 → 60 | 0 / 0 → 0 / 0 | 903.9 → 1031.6 | 0 / 0 → 0 / 0 |
| 10326 | 1059 | 114.1 → 144.3 | 13 → 16 | 3 / 3 → 3 / 3 | 138.2 → 176 | 3 / 3 → 3 / 3 |
| 10337 | 214 | 20.6 → 30.8 | 0 → 0 | 0 / 0 → 0 / 0 | 39.1 → 52.1 | 0 / 0 → 0 / 0 |
| 10341 | 1325 | 19.1 → 27.6 | 0 → 0 | 0 / 0 → 0 / 0 | 24.6 → 35.9 | 0 / 0 → 0 / 0 |
| 10354 | 539 | 1070.1 → 1093.3 | 54 → 54 | 0 / 0 → 0 / 0 | 1310.3 → 1363.1 | 0 / 0 → 0 / 0 |
| 10365 | 1112 | 825.6 → 832.8 | 8 → 7 | 0 / 0 → 0 / 0 | 848.3 → 866.5 | 0 / 0 → 0 / 0 |
| 11371 | 558 | 291.8 → 303.8 | 7 → 8 | 1 / 7 → 1 / 7 | 445.4 → 457.1 | 1 / 7 → 1 / 7 |
| 11374 | 668 | 191 → 240.7 | 0 → 2 | 0 / 0 → 0 / 0 | 288.3 → 303.5 | 0 / 0 → 0 / 0 |
| 21061 | 712 | 75.4 → 83.3 | 5 → 4 | 0 / 0 → 0 / 0 | 83.5 → 99.3 | 0 / 0 → 0 / 0 |
| 21063 | 696 | 29.6 → 30.6 | 3 → 4 | 0 / 0 → 0 / 0 | 35.1 → 36.5 | 0 / 0 → 0 / 0 |
| 21318 | 919 | 480.8 → 528.9 | 16 → 16 | 0 / 3 → 0 / 3 | 488 → 539.9 | 0 / 3 → 1 / 2 |
| 21360 | 523 | 518.1 → 527 | 0 → 0 | 0 / 0 → 0 / 0 | 560 → 560 | 0 / 0 → 0 / 0 |
| 31141 | 330 | 130.1 → 137.4 | 8 → 11 | 4 / 1 → 4 / 1 | 153.8 → 175.2 | 4 / 0 → 4 / 0 |
| 41395 | 253 | 139.3 → 147.4 | 11 → 11 | 0 / 2 → 0 / 2 | 164.2 → 182.8 | 0 / 2 → 0 / 2 |
| 41703 | 482 | 410.4 → 426.8 | 9 → 11 | 1 / 0 → 1 / 0 | 516.8 → 589.3 | 1 / 0 → 1 / 0 |
| 41732 | 606 | 415.4 → 432.2 | 5 → 9 | 5 / 1 → 5 / 1 | 438.6 → 469.6 | 5 / 1 → 5 / 1 |
| 42172 | 908 | 193.6 → 204.6 | 3 → 5 | 0 / 0 → 0 / 0 | 205.9 → 224.8 | 0 / 0 → 0 / 0 |
| 42639 | 747 | 506.3 → 510.3 | 0 → 0 | 1 / 1 → 1 / 1 | 516.6 → 523.1 | 1 / 1 → 1 / 1 |
| 42652 | 306 | 229.5 → 237.3 | 7 → 8 | 1 / 0 → 1 / 0 | 285.6 → 297.7 | 1 / 0 → 1 / 0 |
| 42663 | 151 | 99 → 191.3 | 2 → 17 | 0 / 1 → 0 / 1 | 115.3 → 130.1 | 0 / 1 → 0 / 1 |
| 42670 | 431 | 317 → 324 | 17 → 17 | 3 / 3 → 3 / 3 | 457.5 → 474.5 | 4 / 3 → 4 / 3 |
| 43267 | 410 | 281.5 → 285.3 | 0 → 0 | 0 / 0 → 0 / 0 | 286.7 → 290.3 | 0 / 0 → 0 / 0 |
| 60380 | 703 | 740.3 → 780.1 | 7 → 9 | 1 / 2 → 1 / 2 | 1105.1 → 1137 | 1 / 2 → 1 / 2 |
| 60446 | 203 | 271.3 → 273.9 | 6 → 6 | 0 / 0 → 0 / 0 | 242.6 → 251.8 | 0 / 0 → 0 / 0 |
| 71040 | 1441 | 96.9 → 100.4 | 0 → 0 | 0 / 2 → 0 / 2 | 352.3 → 361.9 | 1 / 1 → 1 / 1 |
| 71043 | 1724 | 757.5 → 811.8 | 57 → 58 | 0 / 0 → 0 / 0 | 817.9 → 921 | 0 / 0 → 0 / 0 |
| 75397 | 1081 | 609.4 → 694.4 | 3 → 3 | 0 / 1 → 0 / 1 | 844.8 → 864.6 | 0 / 1 → 1 / 0 |
| 76269 | 1888 | 779.6 → 791.1 | 11 → 11 | 2 / 1 → 2 / 1 | 828.9 → 852.5 | 2 / 1 → 2 / 1 |
| 76286 | 491 | 612.8 → 614.9 | 3 → 3 | 0 / 0 → 0 / 0 | 616.7 → 622.8 | 0 / 0 → 0 / 0 |
| 76417 | 1463 | 572.6 → 595.5 | 3 → 3 | 3 / 1 → 3 / 1 | 784.8 → 796.2 | 3 / 1 → 2 / 1 |
| 76419 | 408 | 159.4 → 215.8 | 17 → 29 | 0 / 0 → 0 / 0 | 177.2 → 227.1 | 0 / 0 → 0 / 0 |
| 76435 | 624 | 277.9 → 290.1 | 22 → 21 | 1 / 1 → 2 / 0 | 444.9 → 479.4 | 2 / 0 → 2 / 0 |
| 76457 | 874 | 994.8 → 1024.5 | 24 → 22 | 6 / 0 → 6 / 0 | 1025.3 → 1078.3 | 6 / 0 → 6 / 0 |
| 77092 | 1129 | 1505.3 → 1526 | 0 → 0 | 0 / 0 → 0 / 0 | 1558.4 → 1564.6 | 0 / 0 → 0 / 0 |
| 80049 | 776 | 370.2 → 413.3 | 10 → 18 | 0 / 1 → 1 / 0 | 568.1 → 624.8 | 0 / 1 → 0 / 0 |
| 910004 | 403 | 38.8 → 44.7 | 4 → 4 | 1 / 2 → 1 / 2 | 47.4 → 55.4 | 1 / 2 → 1 / 2 |
| 910032 | 749 | 63.7 → 82 | 13 → 11 | 3 / 2 → 3 / 2 | 89 → 106.2 | 3 / 2 → 4 / 1 |
| 910047 | 779 | 613.5 → 629.8 | 38 → 32 | 0 / 0 → 0 / 0 | 954.6 → 982.2 | 0 / 0 → 0 / 0 |
| 910049 | 1121 | 156.8 → 168.4 | 14 → 14 | 0 / 1 → 0 / 1 | 185.3 → 207.6 | 0 / 1 → 1 / 0 |

**Why 33 stay SEALED at 100 %** (`output/clearance-0925/sealed.ts` prints the
cells in front of each side; read by hand, not a computed classification):
the side with no approach is usually NOT a thick collider any more. Most
common, the floor on that side is more than a jump from the door's own floor
(a door hung on a raised base over open ground: 41395, 60380, 42670 Door 6,
31141 Door 4, 41732 Door 3; 11371's shop doors sit 1.1 blocks under their
shop floors); next, the model's own geometry fills the doorway's floor rows
(furniture, stairs, a counter or a solid wall behind the door: 10326 Door 3,
42663's van, 76417 Door 1, 21318); and in a few, standing surfaces the floor
rule keeps whole (`walkable-top`: a step or bench the width of the door) close
the corridor. The floor rule now narrows a surface that is only a wall's top
(rule 4's exception), and raised thresholds get stairs (below).

### Stairs up to a raised threshold (2026-09-26)

A door on a raised base over open ground read SEALED or ONE-WAY: the single
half-way tread covers two 9/16 auto-steps only. `planThresholdStairs`
(`bedrock-interactives.ts`, run in `planInteractiveColliders` once every
doorway is cut) walks out from each leaf column along the leaf's normal: a
level or auto-step column is walked onto (a landing, a planter), a drop past
the auto-step takes a tread 9/16 under the last, and the run ends on a floor
within an auto-step of the ground plane; one even run is re-spaced into equal
steps. It is laid only past a certain test, and every stair considered is
reported with its verdict in the pack diagnostics (`stairs`, `stairTreads`):

- the leaf's normal within ~20 degrees of a grid axis (`off-axis`: a
  diagonal door - 11371's shops, 31141 Door 4, 60380 Door 2 - keeps its
  verdict; a diagonal stair would need two columns per step);
- at most 4 treads (`STAIR_MAX_TREADS`) over at most 2.5 blocks
  (`STAIR_MAX_RISE16`) from the ground to the doorway's floor, within 8
  columns (superseded 2026-09-30 by "Access steps" below: half-block risers,
  up to 4 blocks and 7 treads, turning along the facade);
- every tread column open air from its floor to a standing player's head over
  the doorway's floor (`not open air`), never a doorway cell, never within 2
  cells of another doorway standing lower than the tread (`in front of another
  doorway`);
- **outside only**: every filled cell is reached by the leak flood
  (`LeakFlood`, a flying sneaking player from outside) through the collider
  world with every door closed (`not outside`). A tread can only make walkable
  a space a player already reaches from outside with the doors shut, so it
  never opens an enclosed room and never leads past a closed leaf. A raised
  door inside a room keeps its verdict: stricter than needed, never wrong.

Over the 40 favourites (sweep at `dfd19552` against `e0330b31`,
`output/polish-0926/` in the polish worktree; `_ix_passability.ts` at
100-400 %, turns 0 and 90; `_clearance_report.ts`): at 100 % OK 41 -> 43,
ONE-WAY 8 -> 7, SEALED 29 -> 28, FAIL 0; at 200 % OK 51 -> 53, SEALED 22 ->
20; at 400 % OK 38 -> 40, SEALED 18 -> 17; reach +9.7 blocks² at 100 %,
+22.2 at 200 %. Changed: 41395 Door 2 and 60380 Door 3 ONE-WAY -> OK at
every size; 42670 Door 6 SEALED -> ONE-WAY at every size (stairs on one side;
the other stays unwalked); 42670 Door 3 SEALED
-> ONE-WAY at 200 %, OK at 400 %/90; 41395 Door 1 at 300-400 % from no
approach either way to walked out (ONE-WAY). No doorway got worse. The rest
stay SEALED for other reasons: an interior side full of furniture or a wall,
an upper floor with no floor under the stair, or a diagonal leaf.

### Doors a minifig uses, at 100 % (2026-09-29)

The user's brief: *"At 100% scale if a minifig irl can use the doors and
chairs etc, the normal 100% scale mc imported set should allow a mc player to
fit through and operate doors etc."* A minifig at minifig scale is 96 LDU
standing (1.8 blocks, the player's height) and 2 studs across the hips (40
LDU, 0.75 block, wider than the 0.6 player) - but only 1 stud (0.375 block)
deep, where the player is 0.6. So a doorway a minifig walks STRAIGHT through
in the real set holds the player; one where the minifig squeezes between the
door and a railing or a bed a stud away does not.

**Measuring it.** `bun scripts/_ix_sealed_causes.ts <packs> <geometry> [--drawn]`
walks every doorway the passability walk does not call OK over
counterfactual worlds and names the cause (header of the script for the
buckets): first an exact-box 1/8-block lattice walk of the player over the
model's OWN geometry (`--drawn`: the pack's drawn cuboids; without it,
clearance's layer footprints, which are one bounding box per sixteenth per
cell and so fill a doorway cell between two jambs - use `--drawn` to judge
the model), then, where the model lets the player through, the colliders:
refused trims applied by kind, the lattice over the colliders (a harness
refusal), and the collider cells standing where the geometry walk stood.
The geometry comes from the build: `_favorites_export_sweep.ts --geometry
<dir>` (or `_ix_cell_geometry.ts` for one pack) dumps clearance's layers.
Sweeps `output/doors-0929/before-g` (at `e2a20394`) and `after` (at
`90b09bc9`) in the doors worktree; 83 doorways over the 40 favourites.

Causes of every doorway not OK at turn 0 (distinct doorways; the model judged
over the drawn cuboids):

| cause | 100 % before | after | 150 % before | after |
|---|---|---|---|---|
| opening under the passable size (`passSize`) | 1 | 0 | 0 | 0 |
| collider: phantom top kept (`walkable-top`) | 4 | 0 | 0 | 0 |
| walk harness: the column route | 0 | 0 | 4 | 0 |
| collider: refused as `door-cut` | 0 | 0 | 3 | 2 |
| collider: form too coarse for the geometry | 1 | 2 | 1 | 1 |
| collider: refused near a leak | 1 | 1 | 0 | 0 |
| model: solid geometry in front (furniture, wall, railing) | 15 | 13 | 9 | 8 |
| model: no way through the corridor (steps, a turn, a diagonal) | 15 | 8 | 12 | 9 |
| model: a drop past the jump | 3 | 2 | 3 | 2 |
| **not OK** | **40** | **26** | **32** | **22** |

Four rules, each pinned in `test/doorway-reach.test.ts`:

1. **`passSize` is a minifig's envelope** (`passSizeFor`,
   `DOORWAY_PASS_WIDTH_LDU` 40 x `DOORWAY_PASS_HEIGHT_LDU` 96, measured at the
   model's own scale - the collider frame's `scale / cellXZ`, which the
   opening used to ignore), not the whole-block 1 x 2 passage: 80049's shop
   doors (48 x 123 LDU) and 42670's Door 1 (53 x 112) open at 100 %. A hatch
   keeps 1 x 1 block. 71043's microscale doors (48 x 80 LDU) stay at 150 %:
   80 LDU is under a standing minifig.
2. **A phantom top in a doorway's approach goes** (clearance rule 4,
   `approachTop`): the plan records each door's or gate's approach (the
   columns along its normal within `PASSAGE_REACH_CELLS`) and floor; a
   surface there whose top is over an auto-step above the door's floor and
   whose bottom is under the head of a player standing an auto-step up is
   not the approach's floor but an obstacle in it. Its trim still contains
   the geometry and passes the leak check. 10326's Doors 1-2 (a 1/16 sliver of
   shelf read as a whole block top, 0.05 block into the head), 11371's Door 7.
3. **The collider grid and its layers round alike** (`floor16` / `ceil16` in
   `bedrock-building-shell.ts`): the cell's lo/hi were float32 and the layers
   float64, so an edge ON a sixteenth read 12 in one and 13 in the other, and
   clearance refused the cell as one the doorway cut had changed - 69 cells
   of 10261, a set with no doorway at all. 910049's gate.
4. **The walk sees what a box sweeps, and only through the doorway**
   (`interactive-walk.ts`): where the column graph finds no approach or no
   route it falls back to an exact-box 1/8-block lattice (`doorwayLattice`;
   the per-tick player still judges every route) - a corridor straddling a
   column boundary, 21318's Door 1, 41732's Door 3, 11371's diagonal shop
   doors; and every search crosses the leaf's plane only IN the doorway at
   its level (`crossesAtDoor`): 42670's raised Door 3 had "passed" at 200-400 %
   by a route down its stairs and under it on the ground.

Passability over the 40 favourites (`_ix_passability.ts`, turns 0 and 90;
rows / doorways at turn 0):

| size | OK rows | ONE-WAY | SEALED | SMALL | NO-APPROACH | STEP | FAIL | doorways not OK (turn 0) |
|---|---|---|---|---|---|---|---|---|
| 100 % | 84 -> 112 | 14 -> 4 | 56 -> 44 | 6 -> 0 | 4 -> 4 | 0 -> 0 | 0 -> 0 | 40 -> 26 |
| 150 % | 104 -> 121 | 11 -> 4 | 48 -> 37 | 0 -> 0 | 0 -> 0 | 1 -> 2 | 0 -> 0 | 32 -> 22 |
| 200 % | 105 -> 118 | 15 -> 5 | 40 -> 36 | 0 -> 0 | 0 -> 0 | 4 -> 5 | 0 -> 0 | 30 -> 23 |
| 300 % | 93 -> 101 | 20 -> 13 | 34 -> 32 | 0 -> 0 | 0 -> 0 | 17 -> 18 | 0 -> 0 | 36 -> 32 |
| 400 % | 80 -> 87 | 33 -> 25 | 34 -> 32 | 0 -> 0 | 0 -> 0 | 17 -> 20 | 0 -> 0 | 43 -> 39 |

(OK rows omit the two `Garage door 1` doorways, OK throughout, which the
tally's parser missed.) Got worse, and why: 42670 Door 3 at 200-400 % was
ONE-WAY/OK only through the route under it (now SEALED, as at 100 %); 76435's
Gate 1 at 300-400 % ONE-WAY -> STEP and 910004's Door 3 SEALED -> STEP at
150-400 % (OK at 100 % now, a riser past the jump above it). Seats: 153 of
156 places the source sits a figure give the player a seat, unchanged (the
sweep's labels are bare set numbers, so 41395's and 42663's steering wheels
find no vehicle; `_seat_audit.ts` with the LEGO tab's labels reads 160/162).
Render faults (`_render_fault_audit.ts`): 8,151 coplanar pairs, 31.04 block
faces, identical before and after.

**What is left at 100 %, and why** (drawn cuboids; `stand` is the highest
floor a 0.6 x 1.8 box fits at one block out, relative to the door's floor,
`width` the free width across the corridor at body height):

- Solid geometry in front, no standing place one block out on one side
  (13): 10326 Door 3, 11371 Doors 6 and 8 (8: a bed), 21318 Door 2, 41395
  Door 1 (the bus door over the road: ONE-WAY), 42663 Door 1, 42670 Door 3 (a
  bed and a dresser), 71040 Doors 1-2, 76417 Door 1 (floor 18, no floor
  either side), 910004 Doors 2, 4, 5 (4: a round table). Renders of both
  sides of every one: `output/doors-0929/sheet[A-D].png`. A minifig stands
  in these only sideways between the leaf and the furniture (1 stud deep);
  the player is 0.6 deep.
- No way through the straight corridor although a place to stand exists one
  block out (8): 10326 Door 6, 21318 Door 3, 42670 Doors 5 (a chair in the
  way, a balcony railing beyond) and 6, 60380 Door 2 (diagonal), 75397 Gate 1,
  76269 Door 1, 910032 Door 5 (a staircase). The exact-box walk that may
  leave sideways once through (`wide`) does not get through either.
- A drop past the jump both ways (2): 71043 Doors 1-2, the microscale
  castle's doors, 48 x 80 LDU (under a standing minifig) and 2.9-3 blocks
  over the ground.
- Colliders (3): 42639 Door 1 and 910032 Door 4, where a thin post or a
  corner of the geometry is covered by a quarter-block band running the
  cell's whole length (`form`; an eighth-block kit, simulated with
  `--kit8` before rule 3, unsealed only 910049's gate at 100 % - which rule 3
  passes - and 76269's Door 1 at 150 %, so the 43-id vocabulary stays);
  11371 Door 1, whose trims are refused near a leak.

### The doorway's floor, a floor's top, and the device's line (Saga round 2026-09-29c)

Two doors the walk called OK at 100 % were not, on the Saga, and both faults
were the walk's and the cut's reading of a FLOOR (evidence
`output/doors-fix-0929/` in the doors worktree: `passability-before-100-0.json`,
the round-source rebuilds `packs-round/` = the 29d packs cell for cell,
`geo-round/` their geometry, `regression-*.json` over the 29d round packs;
the final rebuilds and verdict diffs are in `output/doors-fix-0929b/`):

- **10326 Door 1** (device: from the "porch" at 2.5, walking in, the feet
  landed at -59.75, the base plate). Replayed offline on the 29c pack at
  x 10.67 (`tools/walk_axis.ts`), the walk lands on the base plate at z 0.3
  to 0.7 exactly as the device did; the threshold (10,2,1, 0..14/16) is
  intact in 29c, 29d and every rebuild - the cut did NOT remove the floor
  under the leaf. The source has nothing in front of the leaf between the
  base plate and the threshold (no drawn cuboid in x 9.9..11.35, y 0.3..2.8,
  z < 0.85): the door is 2.6 blocks over the plate at the model's front
  edge, and the device's "porch" was a teleport into the air. The walk had
  called it OK from a half-way tread laid on the base wall's rim (2.0, full
  cell) that clearance then trimmed to a floor + wall form, leaving the
  tread 0.9 over the plate; the same inside on a 2/16 z-sliver. Both treads
  are gone (rule 2). Rebuilt, the collider grid keeps the model's 1/8-block
  lip in front of the door (10,2,0 and 10,3,0: a 3.0..3.125 floor band)
  as a whole cell, 1 block deep - a ledge at the doorway's level over the
  pit that the row rule used to clear; at 100 % the device line now starts
  on it, at 150 % `HOLE ... (starts 3.94 under)` still reports the plate.
- **910004 Door 3** (walk-out stopped one cell before the doorway). Inside
  the door the chalet has a reddish-brown platform (x 2.75..5, colour 70)
  topping out at 5.0 with a step at 4.69 by the door (x 2.19..3), under the
  upper floor at 6.25..6.44: headroom 1.56..1.75 on the step and 1.25..1.44
  on the platform, both under the player's 1.8. The `collider_w6` at head
  height the device met (cell 2,5,2, 0..2/16 over x 12..16/16) is the
  platform's lip, a superset of its geometry (layers 0..1 at x 13..16). The
  walk stood in the alcove (`2.38, 4.69, 2.5`) and called the door OK;
  `_ix_sealed_causes.ts --drawn` says `model:solid`. Identical cells in the
  29b and 29d packs. The model's, reported now (rule 3).
- **41732 Door 3**, found by the new line report on the 29d pack: the model's
  stoop in front of the leaf column (a slope part topping out 2/16 over the
  threshold, 7.875) was cleared WHOLE by the passage cut, leaving a
  2.7-block pit to the street in the leaf's own column; the walk passed
  through the stoop's neighbour column beside it.
- **10022** (Santa Fe car, `test/interactive-passability.test.ts`): every
  door's sill is 1.44 over the track bed with no platform in the source, so
  every door is ONE-WAY at 100 %. Door 2 read OK on main only because Door
  1's row-based passage cleared Door 2's sill in one column (a notch down to
  1.0); rule 1 keeps the sill, and the test's `minOkAt100` is 0. At 150 and
  200 % Door 1 now reads OK (an approach along a ledge on the car's side at
  3.0, 3 blocks down the car; main: ONE-WAY) with a HOLE on the straight
  line from outside; not judged against the model.

Six rules, pinned in `test/doorway-reach.test.ts`, `test/bedrock-interactives.test.ts`
and (31141, 10022, 41732) `test/interactive-passability.test.ts`:

1. **The passage is measured from the doorway's floor** (`planInteractiveColliders`),
   not from the row the leaf's bottom is in. A column is standable when no
   collider reaches into the band from a 9/16 step over the doorway's floor
   to 2.5 blocks over it (`PASSAGE_STEP16`, `PASSAGE_CLEAR16`), and opening
   a column trims each cell to what lies outside the band (a floor under it
   where the cell's geometry has one, a lintel over it) instead of clearing
   the cell whole. The row rule ("row y0 at most a step high") read a floor
   LEVEL with a leaf hung 14/16 up its row as an obstacle: 41732's stoop,
   10022's sill, the museum's floor behind Door 1. For a leaf at a row
   boundary the rules agree exactly. The flip side: a cell under the step
   line is kept whole even where its geometry is a sliver (10326's lip).
2. **A tread or stair stands on a floor, never on a wall's rim**
   (`standingTop16`): the planners get the cells' geometry (`layers`) and
   read a cell's standing top from its cover - a floor + wall form's floor,
   a wall + ceiling form's slab, a full cell's top; a wall band has none. A
   stair run that meets a rim under the doorway's floor is refused ("not
   open air"). Without geometry (old callers) every span top is a floor, as
   before.
3. **An approach is a spot a player can go on from** (`continues`, column
   graph and lattice): a two-way move to a column that is no leaf's and no
   nearer the leaf's plane - onward or sideways (a corridor along the wall,
   a balcony still count; a spot beside another doorway's leaf goes on
   through it, 10022's vestibule). A one-column alcove is SEALED.
4. **The device's line is walked too** (`doorwayColumnLines`, printed by
   `_ix_passability.ts` as `HOLE`): for an OK doorway the per-tick player is
   walked straight through EACH leaf column, and a fall past the jump within
   a block of the leaf's plane (`HOLE_REACH`) is reported with its depth;
   `(starts N under)` marks a line whose start is already more than a jump
   under the doorway's floor (the door hangs over that ground). The verdict
   does not change: the walk's OK is true through the column it used.
5. **A line starts where a player can stand**: the farthest point from
   `LINE_OUT` (1.5) in to `LINE_MIN_OUT` (0.5) with room for the player's box
   within a jump over the doorway's floor. Dropped blindly at the doorway's
   floor, the box started inside a step topping out above it (76417's roof
   beside Gate 1 at 150 %) or inside a wall (10326 Door 1 from inside),
   fell through (the walker ignores a box it already overlaps), and printed
   HOLEs of 5.9 and 17-19 blocks nobody can reach.
6. **The walks jump only where a jump helps** (`jumpHelps`): the box a
   short reach ahead is blocked at the feet and free a jump up. They jumped
   on ANY clipped move, so momentum into a jamb beside a slanted approach
   (31141's 45-degree Door 4, once the stoop outside it was kept by rule 1)
   jumped through the leaf plane and "passed only with a jump".

Verdicts over the 29d round's packs (19 + the fixture, sizes 100/150, turns
0/90, 116 rows; `output/doors-fix-0929b/verdicts/` in the doors worktree):
main's packs walked by main's harness against packs rebuilt at `448fc3db`
(`df580c19` changed only the walk) walked by `df580c19` change exactly four rows, all 910004 Door 3 (OK ->
SEALED at 100 %, STEP -> SEALED at 150 %); 0 FAIL either side. HOLE rows
after: 10326 Door 1 at 150 % (both turns, starts 3.94 under). 41732 Door
3's 2.69 HOLE on main's pack is gone with the stoop kept.

Device-unproven: all of it. 10326 Door 1 now has an invisible ledge one
block deep at the doorway's level where the model has a 1/8-block lip (the
device player would stand on it walking out); 41732 Door 3's kept stoop and
31141/10022 were never walked on a phone.

### Access steps (2026-09-30)

The user's standing rule (2026-09-30): *"always prefer unlocking exploration
and interactivity."* A door hung more than a jump over the ground in front of
it cannot be walked into at all. The case that raised it: 10326's Door 1 on
the device's source (`IOModel2V2/10326-noprint.ldr`) hangs 2.9 blocks over the
base plate at the model's FRONT EDGE with nothing drawn in front, so the 1/8
lip at the doorway's level (kept since 2026-09-30) is a ledge over a pit and
the simulator's porch line (`door1-10326`) fell 2.625 blocks. The stairs of
2026-09-26 could not reach it: the run needed six columns past the grid's
edge, and 2.9 blocks was over their 2.5-block limit.

`planThresholdStairs` is now the one access-stair pass (the 2026-09-26 rules
above stand except where this section changes them):

- **Half-block risers** (`STAIR_RISE16` 8): a slab's height, walked up without
  a jump; where a run meets one of the model's own floors or the ground that
  one riser may be the 9/16 auto-step. Up to 4 blocks (`STAIR_MAX_RISE16` 64,
  `STAIR_MAX_TREADS` 7).
- **Straight out, else along the facade.** A uniform-cost search from each
  leaf column: the first move leaves along the leaf's normal, later ones go on
  or turn (at most `STAIR_MAX_TURNS` 2, each costing `STAIR_TURN_COST` 4
  columns), within 12 columns. The model's own floors within the auto-step
  are walked onto on the way (a porch, its own steps).
- **Only where a jump does not already reach.** The same search with no tread
  and the jump (`ACCESS_JUMP16`, 1.25 blocks) as its step runs first; a side
  it walks down to the ground gets nothing - the brief's "more than a jump".
  (The first build had no such test and laid a 2/16 tread with two turns
  beside 10326's ground-floor Door 4.)
- **Never in anyone's way.** No tread in another doorway's approach above that
  doorway's floor (besides the 2026-09-26 leaf clearance), and no tread or the
  head room over it in a cell of `accessAvoidCells`: the pack's slide and lift
  paths and their exits, coaster track, mount tops and orbits (a cell box
  round every quarter-block sample, a block under to two over), vehicle
  footprints, figure spawns and seats.
- **The doorway's own lip is its landing.** A wall-band rim within
  `LANDING_REACH` of the leaf and `LANDING_RISE` of its foot is a floor to the
  search: clearance's landing guard (rule 4) keeps exactly those whole
  (`collider-clearance.ts`, now exported). Elsewhere a rim still refuses.
- **Every refusal past the first column is reported** in `stairs` ("no stair:
  straight out, <why> at step <k>, ..."); a side whose first column is a wall
  or another leaf stays silent, as before.

**The margin.** A stair may not leave the grid (only the ground it ends on
may lie past it), so the pipeline widens the grid where a raised door faces
out of the model (`accessMarginFor`, `padGridXZ`, schem-pipeline.ts): for a
scene door leaf whose foot is more than a jump over the grid's floor, on each
side along its normal where the voxel grid holds nothing at chest height
between the leaf and that side, by the treads a straight half-block run needs
plus a landing, less the columns already in front, at most
`ACCESS_MARGIN_MAX` (7) blocks. The grid and the voxelizer's origin move
together BEFORE anything is placed on the frame, so every actor, seat, ride,
door and collider keeps its place relative to the model; the model sits the
margin further in from the wand's pinned corner, and the footprint (preview,
figures' roaming area) grows by it. When no stair ends up in the margin
(`accessMarginUsed`), the pipeline exports again without it, so a model whose
raised door turned out to be reached already keeps its own footprint (the
favourites sweep widened 10326 from the index's source, 43267 and 910032 for
nothing before this). The diagnostics carry `accessMargin` with `used`.

**Scaled treads at doorway thresholds.** A threshold is ONE surface for both
of a doorway's sides, and the scaled-grid tread planner restores only what the
unassisted walk reaches by no route: when 31141's Door 2 got a stair up its
back, its front ledge lost its treads at 150-200 % and the door read ONE-WAY.
`planColliderTreads` now takes the doorways' closed cells (`doorCells`) and,
after its main plan, restores every blocked rise from a reached surface into a
threshold column by the same rule, each run verified never to block
(`test/doorway-threshold-treads.test.ts`).

**The late tread pass** (2026-10-07, `latePass` in bedrock-collider-scale.ts).
The main rule restores only a surface the grid walk reaches by no route, and
that walk takes any drop and any detour: 10261 at 200 % kept a 1.5-block rim
along its west side (reached round the corner) and a riser on its lift hill
(reached by dropping 10 blocks off the track, and its edge key shared with
the platform level under it, so never tried) - the Pixel player stopped at
both (round 2026-10-07j). After the main plan and the doorway pass the laying
walk runs again with "reached" meaning reached without a drop past 3 blocks,
refused edges keyed exactly, a tread-holding column a target at another level,
and a run laid from the GROUND onto the model wherever the 100 % grid walks
onto it (`edgeSweep`; only from the ground, where the planner's full-cell
reading of a clearance form and the device agree). Every late run is verified
never to block. Measured on 10261 at 200 % / 0: the plan's reach rose from
32.6 to 43.6 blocks (the top of the lift); walking straight up lanes z 4.8-5.6
of the hill goes from x 25.7 to 39.7 (jumping), and from the west lanes z
22-24 now climb onto the base. Not done: a straight walk up the lift past x
39.7 (each lane of the hill rises 1.75 every second column at 200 %; the
planner reaches the top from the next lane, a player holding a straight line
does not). A "slope sweep" (a run at every such riser between reached
surfaces) was tried and dropped: planned over full cells it raised a lane
where the shipped forms are lower and stopped the same walk at x 30.7. The
lane pass below does it over the forms.

**The lane pass** (2026-10-07, `lanePass` in bedrock-collider-scale.ts,
`colliderLaneWalk` in bedrock-placement-pack.ts). The Pixel climbed 10261's
lift hill at 200 % with AUTO-JUMP only - adb drives one finger, and a
5-year-old on touch relies on it too - and stopped at pin + (28.2, 9.88) on
three tries (round 30k), 1.2 blocks past 30j instead of the ~14 the late pass
promised: the offline walk JUMPED whenever it was blocked, and auto-jump never
tries an obstacle over 1.2 (Java's `updateAutoJump`, assumed for Bedrock:
quirk `auto-jump`, physics spec §4.4a). The walker now models it
(`WalkInput.autoJump`), and `_walk_line.ts --dir=+x --jump=auto` on the 30k
pack stops at exactly 28.20, 9.88: in front of a 1.25 riser inside column
x 28 (its x 28.0-28.5 half is a form at 9.875, the other half 11.125). Past
it the lane rises 0.875-1.125 per column to x 39 and then 1.75 every second
column (x 39 -> 40, 41 -> 42, ...).

So, last in the plan: every rise over auto-jump's 19/16 (and within two of
them) from a reached surface to the next column's surface in a straight
LANE - the column behind the foot at most an auto-jump under it, the column
past the top at most one over it: a hill or a stair, not a rim over a drop -
is offered a run in hops of at most 19/16, bottom up, round after round (a run
up one riser reaches the foot of the next). It is planned over a second grid
read from the FORMS (`ScaledColliderGrid` on the source cells with their
clearance forms: each column's own pieces, where the full-cell grid reads x 30
as 12.875 instead of 12.0), with column protections per level (a tread under
the track 10 blocks down does not stop a run on it). A run is kept only when:
the per-tick walker with auto-jump, starting on the run's landing, walks into
the column past the riser's top with it (`LANE_PAST`) and did not without it;
no straight walk INTO a column it writes, from two columns out along x or z,
gets more than `LANE_SLACK` shorter (the first try without this check laid a
tread on another lane's approach and stopped the lift walk at x 18.7); and the
form grid's reach loses nothing (batch, then run by run). Without the walk
(grid-only callers, the walk preview's own planning) the pass lays nothing.

Measured on the 30k pack re-planned at 200 % / 0: 630 -> 1,723 tread blocks
(631 runs, 419 of them lane runs, verified); the auto-jump walk from the foot
reaches x 70 at y 41.9 (the top of the lift) on lanes z 4.6, 4.85, 5.2, 5.6
(was 28.2; the jump-whenever-blocked walk 39.7 -> 70). Planning cost per size
and turn: ~0.3 s -> ~10 s at 200-400 % (10,000 lane walks), so a large set's
export takes about two minutes longer (`TODO(lane-pass-cost)`: cache the
cross-lane walks between runs; 10261 built in 180 s against 53 s, 10326 in
137 s against 69 s). Built (`output/collider-fix2-20261007/packs-0a08d086`):
the shipped 10261 at 200 % climbs to x 70.06, y 41.88 with auto-jump on lanes
z 4.6-5.6 (z 4.2, the hill's edge, stops at 29.7). `_ix_passability.ts` over
nine rebuilt sets x 100-400 % x 0/90: 0 FAIL / HOLE before and after, STEP
rows 22 -> 16 (10326 Door 3 at 300 %, 76457 Door 1 at 300 % and Door 2 at
400 % now OK, both turns), nothing worse.

The west side of 10261's base at 200 % (round 30k lanes walking +x from
x -4.5, auto-jump walk on the 30k pack vs the device): z 14.5, 20.5, 24.5,
26.5 stop at 6.20 against a full column 4+ blocks tall at x 6.5-9 (the
model's grey wall); z 24.0 stands on a 2-block form at 2.00 and stops at 6.70
against a 6.75-high column at x 7 (wall); z 8.5 stops at 10.70 against a
4-high column at x 11 (wall); z 34.5 stands at 3.00 and stops at 9.70 against
a 6.75-high column at x 10 (wall); z 28.5 stands at 1.00 and stops at 9.70
under an overhang at x 10 whose underside is 1.375 over the floor (headroom:
the model's); z 30.5 stops at 6.70 before a 1.75 riser at x 7 under a slab
1.625 over its foot (headroom: the model's). All of these match the device to
the 0.1 block except z 30.5 (device 5.70). z 22.5/23.5 climb (device too, to
16.2-16.4, where the model's own floor goes on rising by half-block steps -
the device walk's end, not a stop the colliders make); z 38.5 and 41.5 reach
x 30 in the model where the device stopped at 12.39 / 11.79 (not
explained by the colliders: entities are not in this walk). z 2.5 stops at
5.70 at a stand; the lane pass takes it to 8.20. No missing step was found
on the west side beyond that one.

**Results over the 40 favourites** (sweeps `output/access-steps-0930/sweep-base2`
at `dc699e3e`, built from an archive of the base tree: the sweep spawns one
export per set, so a first baseline run while the code was being edited mixed
old and new builds and was discarded - and
`sweep-after3` at `7f7723fa`; `_ix_passability.ts` at 100-400 %, turns 0 and
90, `pass-base.json` / `pass-after3.json`, diff `verdict-diff3.txt` by
`tools/verdict_diff.py`; stair verdicts `stairs-after3.txt`):

| size | OK rows | ONE-WAY | STEP | SEALED | NO-APPROACH | HOLE rows | FAIL |
|---|---|---|---|---|---|---|---|
| 100 % | 112 -> 114 | 2 -> 0 | 0 -> 0 | 48 -> 48 | 4 -> 4 | 4 -> 4 | 0 -> 0 |
| 150 % | 122 -> 124 | 2 -> 0 | 2 -> 2 | 40 -> 40 | 0 | 8 -> 8 | 0 -> 0 |
| 200 % | 127 -> 129 | 3 -> 1 | 0 | 36 -> 36 | 0 | 9 -> 9 | 0 -> 0 |
| 300 % | 117 -> 120 | 2 -> 2 | 13 -> 10 | 34 -> 34 | 0 | 8 -> 8 | 0 -> 0 |
| 400 % | 112 -> 116 | 6 -> 6 | 14 -> 10 | 34 -> 34 | 0 | 8 -> 8 | 0 -> 0 |

Changed doorways: 41395 Door 1 (the bus door over the road) ONE-WAY -> OK at
100-200 % and STEP -> OK at 300-400 %, both turns (margin 3 blocks at low x,
2 treads); 42670 Door 6 STEP -> OK at 400 %/0; 76435 Gate 1 STEP -> OK at
300-400 %/0; 42670's Garage door 1 keeps OK with fewer HOLE columns at
200-400 % (5 -> 1, 8 -> 1, 22 -> 6/2); 31141 Door 2 keeps OK with fewer HOLE
columns (it now also has a 6-tread stair up its back, one turn). No OK row got
worse; the one HOLE count that grew is 31141 Door 3 at 400 %/90 (24 -> 27
columns, an OK row). Stairs laid: 46 cells over 7 sets (base: 2 cells, one
stair). The sweep's 10326 is the index's first pick, where Door 1 reads OK
with no stair (every side reached with jumps); on the device's source the
regression `door1-10326` passes (the porch line walks in up a straight
6-tread stair from each leaf column, `packs-7f7723fa/`), and the whole
regression set is OK (`packs-7f7723fa/regressions.md`).

Child play (`bun scripts/sim.ts`, 200 scenarios): base 198 pass / 2 fail,
after 198 / 2, the same two scenarios (42639's and 60380's driver views, open
in the tracker); `sim-base.json` / `sim-after3.json`.

Doorways still not OK at 100 %/0 (26, `unreached-100.txt`), by what the
search said: the model's own geometry in the way of either side (furniture,
a wall, a railing - 10326 Doors 3 and 6, 11371 Door 8, 42639 Door 1, 42670
Doors 3 and 5, 71040 Door 1, 75397 Gate 1, 910004 Doors 2, 4 and 5, 910032
Door 5, 80049 Gate 1, 910049 Gate 1, 11371 Door 1, 21318 Door 1: "not open
air", "a wall's rim" or "a leaf column" on the straight line and no turn
around it, or no stair side at all); a diagonal leaf (`off-axis`: 11371 Door
6, 21318 Doors 2-3, 76417 Door 1, 910032 Door 4); 42663's van (a stair laid on
one side; the other is solid geometry, the 2026-09-29 table); 910004 Door 3 (the headroom inside is
the model's, 1.25-1.75 blocks); 71043's microscale doors (walls within 2-5
columns and no approach either side). These are the model's, as the
2026-09-29 causes table found.

**Device-unproven:** all of it - walking up a half-block invisible stair on the
Pixel or the Saga (and turning on one), a margin-widened placement (41395:
the model 3 blocks in from the pinned corner), the scaled treads at a
threshold, and whether figures now roam down a stair into the margin (their
area is the widened footprint).

**Compromises and limits.** The margin is decided from the scene's door
leaves (`discoverSceneActors`), not from the interactivity stage's doorways,
so a brick-built door or gate is never widened for (its stair can still run
inside the footprint). A side reached only through the interior (a raised
door INSIDE a room) still gets no stair: the outside-only flood refuses it -
`TODO(access-steps)` in `planThresholdStairs` if a child needs one. A stair
never runs diagonally, and at most 12 columns with 2 turns.

### The museum's back doors (round 2026-09-30g)

On both phones 10326's Door 1 stair passed, and showed what it was built for:
the brown leaf hung flush on the facade directly over a drawn ground-level
doorway (a white arch round an empty frame; through it the room, a round
tile and the knob), and the stair lifted the child past that doorway into
the leaf 3 blocks up (`output/device-round-2026-09-30g/pixel/12-front-close.jpg`,
`25*-door1-*.jpg`).

It was never a missed door or a detector rule. The white arch frames a
`60596` Door 1 x 4 x 6 Frame at y -152..-4 (the ground floor); the leaf is
`60616` placed AT THE FRAME'S ORIGIN, as every LDraw door and frame pair is.
The name resolved to Studio's `UnOfficial/parts/60616.dat` ("GLASS DOOR FOR
FRAME 1X4X6 (Needs Work)"), whose origin is the leaf's FOOT (body y -140..-8),
not its head like `60616a`/`b` (y 4..136): every plain-60616 leaf drew 144 LDU
(2.7 blocks) over its frame, and the leaf's attachment pass then took the
arch's pediment (3023 + two 54200) as the leaf's hardware. The real set
(Brick Architect's review: "three doors in the back of the building") has
three reddish-brown doors in those frames at street level - our Doors 1-3 -
and its MAIN entrance is the front door between the white columns at the top
of the front steps, our Doors 4-5 (trans-clear `80683` pair, which were always
right). `STUDIO_FRAME_REDIRECTS` reads `60616` as `60616a`
(docs/lego-sources-guide.md, the superseded "do not alias" note, has the
corpus evidence). The index's first pick for 10326, the `.io`, was never
affected: Studio's `model.ldr` names the leaf `60616a`; only the IOModel2V2
`.ldr` the rounds ship (converted from the LDD-id `model2.ldr`) says `60616`.

On the round's source at `74209454` (`output/museum-entrance-0930/`):
Doors 1-3 stand at y 0.21 in their frames with the knob on the leaf; the
access margin is dropped ("no access stair used it; exported without it"),
so the model sits where 30f put it (6 blocks nearer the pinned corner than
30g); Door 1 OK, Door 2 ONE-WAY -> OK, Doors 4-5 OK, Doors 3 and 6 still
SEALED by the model (`sealed-74209454/causes*.txt`: Door 3 `model:solid`,
no standing place a block out on its -x side; Door 6, the upper floor,
`model:route`). The stair is not wanted any more and none is laid; nothing
of it can stand in the ground entrance's approach.

Favourites sweep (40 sets, `_ix_passability.ts` at 100 and 200 %, turns 0
and 90; base from an archive of `e680bb9b`, `sweep-base-e680bb9b*`, against
`sweep-new-74209454*`, diff `verdict-diff-74209454.txt`): no OK row got
worse; 910032 Door 5 SEALED -> OK at every size and turn; 31141 Door 3 at
200 %/0 ONE-WAY -> OK; 31141 Doors 2-4 keep OK with their HOLE columns
gone (2 -> 0 at 100 %, 4-7 -> 0 at 200 %). Totals at 100 %: OK 114 -> 116,
SEALED 48 -> 46; at 200 %: OK 129 -> 132, SEALED 36 -> 34, ONE-WAY 1 -> 0.

Rendering the fixed door showed one more fault, in the compiler: the leaf's
handle studs (60616a's pair at x 57 on both faces) drew 0.9 block past its
free edge. `findExposedStuds` placed a stud "unrotated at the brick origin"
for any bone but `body` and wheels, and an interactive's leaf is ALIGNED in
the rig bone `ix_untilt`, so a leaf turned 180 degrees had its studs on the
far side of the hinge. The branch keys on `aligned` now (`b5fbebde`); a
symmetric stud layout (a minifig head's stud, a hip's pair) hid the same
error on every figure. A second favourites sweep at `b5fbebde` changed no
verdict against `74209454` (`verdict-diff-b5fbebde-vs-74209454.txt`); on the
round's 10326 pack the render-fault audit fell from 217 z-fight pairs / 0.70
block faces to 188 / 0.41. Simulator on the round rebuilt at `3dc93bca`
(`round-3dc93bca/`, 22 packs): regressions 10 OK and `gabby-car-overhang` not
reproduced (as in 30g), `door1-10326` "no HOLE on Door 1's lines"; child play
on 10326 5/5 pass.

Device-unproven: the door in its frame (tap, swing, walk in at the ground),
Door 2 both ways, the handle studs on the leaf, and the museum placed
without the margin. (Round 30h proved all four on the Saga.)

### Door 3's tap and Door 2's pockets (round 2026-09-30h)

**Door 3 refused a tap in plain view.** On the Saga a tap on 10326's Door 3
(inside, turned 90 degrees, into the WC) from 1.9 blocks with the whole leaf
in view was refused "behind a wall" twice
(`output/device-round-2026-09-30h/saga/s26-door3-tap.jpg`); from 0.9 it
opened. The simulator reproduces it from the round's exact spot (corner
pinned at 5380,-60,5380; feet anchor + (4.6, 0.2, 2.4), looking at the
leaf's centre anchor + (6.5, 1.2, 2.35)): regression `door3-tap-10326`
(`tapPartFrom`). The refusal record names the cell that cut the line,
`10,-59,-4 craftmatic:collider_w10[0,16]` - the cell the player's EYES are
in. That collider stands for nothing drawn there. It is the bounding box of
two handrail bars tilted 42.7 degrees (bones `r1583`/`r1589`, 72 and 84
units long) that climb from x 2.2, y 1.0 to x 6.2, y 4.7 over the spot:
`buildColliderGrid` lays each part cuboid's AXIS-ALIGNED box, so under a
tilted part it leaves an invisible band (here z 2..2.75 over y 1..2, x 2..6)
at head height. The tester stood in it by teleport (the Position read
5384,-60,5382), and every line of sight to the leaf started inside it; the
0.9-block spot was in the band too, in a cell the part's own margin skips.
A child walking the corridor stops at the band's face (z 3.05), and from
there the round's own runtime already opens the door (simulator, z 3.17).

The runtime's sight test now skips a collider form box the player's own
box (0.6 x 1.8 at its feet) overlaps by more than 1/64 block (`sightClear`'s
`body`; the seat hand-off `forward` passes the same box): a solid the player
stands in is around the player, not between the player and the part. A
wall the player stands clear of, touches, or one beyond the one it is in,
still refuses (`bedrock-interactives.test.ts`, "does not count a collider the
player stands inside"). Round 30h's pack refuses from the device's spot;
the pack built at `99f5090d` opens (`output/door-tap-0930/` in the worktree
that made it, `sim-regressions.md`: 13 OK, `gabby-car-overhang` not
reproduced as before; child play on 10326 5/5 pass).

**The tap sweep** (`scripts/_ix_tap_probe.ts --runtime=<base archive>` for
the before, `--clipped` for spots where the player's box overlaps a
collider form; `output/door-tap-0930/tap-sweep.sh`, `sweep-compare.py`,
`clip-classify.ts`), over the 40 favourites exported at `482a1fbe`
(`fav40-482a1fbe/`, 40/40, `sweep-cur40*`):

- FREE standing spots (244 parts, 3,900 reachable spot-part pairs): identical
  before and after - 3,697 accepted, 3,459 close again, 0 flips either way,
  no part refuses every tap (two turnables are out of reach, as before).
  Every spot a child can walk to answers exactly as before, so no door
  behind a real wall became tappable from anywhere a player stands.
- CLIPPED spots (16,981 pairs): accepted 10,084 -> 15,039, closes 8,998 ->
  14,050, 0 accepted -> refused. Of the 4,955 that flipped, 275 have the
  player's box only in colliders with nothing drawn at the body (the
  museum's case) and 4,680 inside DRAWN geometry: a player left inside a
  real wall (a teleport, a placement laid round it) now taps past the wall
  it stands in. That is consistent with what such a player sees - an
  entity's faces are not drawn from inside, so the camera sees through the
  wall it is in - but it is a widening, measured, not a side effect nobody
  looked at. The 8 packs built at `99f5090d`: free 562 = 562, clipped
  1,515 -> 2,176.

The cause - a tilted part's collider was its bounding box, so a child
walking under the museum's handrail bumped its head on air - is fixed since
`1a21dd38`: "Tilted parts are laid from their own box" below.

**Door 2 is a door you use from a block away.** The walk rated it OK from
start points 0.9 out, but on the Saga a child 2.1 blocks west or 2.5 east
could not walk up to it: the east side is a pocket boxed in by the model's
display cases. `walkThroughDoorway` now measures, at 100 % with the door
open, how far a player WALKS (steps only - `STEP_HEIGHT`, no jump onto
furniture, as the device walked it by stick) from the doorway on each side:
`room`, the farthest point of a flood over the fine lattice from the side's
approach spot, staying on that side, every other door open (Door 1's entry
pocket leads on THROUGH Door 2, its pair, whose columns the flood walks).
Under `SHORT_APPROACH_ROOM` (2.25 blocks from the doorway's centre: half the
leaf, a block, a player's half-width) the side is a pocket and
`_ix_passability.ts` prints `SHORT-APPROACH from <side>: room <r>` after the
verdict, counts the rows and writes `room` / `shortApproach` to the JSON. The
verdict is unchanged (332 verdict rows over the favourites, 0 differ from
the base script, at `482a1fbe` as on the older `favsweep-3664f4f3` packs).
Over the 40 favourites at 100 % (116 sides at `482a1fbe`) the values run
1.13 ... 1.98, 2.08, 2.13, 2.19, then a gap to 2.40; the threshold sits in
it (the older packs: ... 2.13, then 2.47).
Not measured above 100 %: the step is the player's and does not grow with
the model, so at 200 % a doubled riser reads as a wall - with the threshold
scaled, 20 of 65 doorways at 200 %/0 read as pockets against 9 of 57 at
100 % (first draft, threshold 2); `TODO(short-approach)`.

SHORT-APPROACH at 100 % over the favourites at `482a1fbe` (turns 0 and 90
alike), 9 sides of 9 OK doorways in 9 sets: 10326 Door 2 + (1.98, the
device's pocket reached about 1.65 from the leaf's centre), 11371 Door 7 -
(1.63), 31141 Door 5 + (2.19), 42639 Door 2 + (2.08), 42670 Door 1 - (1.35),
60380 Door 1 + (1.13), 71040 Door 2 + (2.13), 76435 Gate 1 + (1.29), 910032
Door 3 - (1.29). Only 10326's is device-observed. (On the 45-commit-older
`favsweep-3664f4f3` packs 31141's Doors 2-4 read pockets and Door 5 did not:
its colliders changed since.)

### Tilted parts are laid from their own box (2026-09-30)

`buildColliderGrid` laid every body cuboid's world AABB. Under a part turned
off the vertical that box holds air the part never reaches: 10326's two
handrail bars (tilted 42.7 degrees, 72 and 84 units long) made a band at head
height over the corridor to Door 3 (z 2..2.75 over y 1..2, x 2..6 from the
pinned corner). The compiler now hands each turned cuboid's oriented box to
the grid (`partBoxesLdu[].obb`: the part-local cuboid and the placement that
turns it), and the grid lays a TILTED one (`isTiltedBox`: its own up axis
leaves the vertical by more than `TILT_EPS`) from the cuboid itself: only the
cells it reaches past the same 0.02 / 0.001 margins the AABB path skips, each
over the height it spans in that cell, with an exact footprint per sixteenth
layer (`clipParallelepiped`, engine/oriented-box.ts: the bounds of a
parallelepiped clipped to a box). Clearance then trims those layers like any
other geometry. A ramp or a sloped roof keeps a top in every column it
crosses - its own highest point there - instead of one flat plateau at the
summit over a solid wedge.

**The rule was decided by measurement** (`output/tilted-colliders-0930/` in
the worktree that made it; 40 favourites exported from a clean archive of
`89a86310` and from each candidate, each set from the index's first pick):

| over the 40 favourites | base (AABB) | every turned cuboid exact (`251fd1bf`) | tilted only (`1a21dd38`) |
|---|---|---|---|
| collider cells | 61,471 | 58,088 (-3,388, +5) | 59,315 (-2,157, +1) |
| summed form height (sixteenths) | 626,873 | 578,075 | 586,460 |
| reach at 100 % (square blocks) | 20,081.1 | 20,190.4 | 20,818.5 |
| reach at 200 % | 22,084.3 | 21,983.1 | 22,262.5 |
| rooms reached at 100 % / 200 % | 648 / 1,027 | 691 / 1,031 | 708 / 1,083 |
| passability rows SEALED -> OK / STEP (of 332) | - | 22 / 2 | 3 / 2 |
| OK rows that regressed; HOLE rows | - ; 4 | 0 ; 5 | 0 ; 4 |
| sim child play, 200 scenarios (exact drawn reading) | 5 fail | 1 fail | 0 fail |

Laying EVERY turned cuboid exactly unlocked 19 more doorway rows (21318
Doors 1-2, 11371 Door 6, 42670's garage door, 76417 Door 1: walls of parts
turned about the vertical) but cost 76435 its upper floor (reach 415.9 ->
303.2 at 100 %, 13 of 33 rooms: the climb runs over parts turned 45 degrees
about the vertical whose bounding boxes were the steps) and put 76417's Gate
1 on the bare corner of a baseplate turned 45 degrees (a 13.9-block fall the
sim caught), and 11371's Doors 5/6 at 150 % turn 90 onto a 0.56-block ledge
the re-lay moves. Only a tilt makes the vertical band, so a cuboid turned
about the vertical alone kept its bounding box, whose vertical extent is
exact already (superseded the same day: "Yaw-turned parts" below). 20,041 of the favourites' 33,629 turned shell placements are
tilted (393,265 cuboids laid exactly, sparing 2,148 cells nothing reaches);
every one of the 40 sets has some. Per set at 100 %, reach fell by more than
3 square blocks only in 910047 (648.8 -> 641.6) and 71043 (883.3 -> 878.5);
at 200 %, 10261 (1,994.6 -> 1,787.7: its tilted track and supports re-laid
at double height climb differently - 2,225 column-levels lost, 778 gained)
and 10354 (1,360.3 -> 1,342.7). 75397 gained the most (698.9 -> 1,119.3, 3
-> 34 rooms).

The museum corridor (round source, label "Natural History Museum 10326"):
a standing player fits under the handrail at x 4.3-5.8 down to z 2.3 (2.1
at x 5.3-5.8), where the base stopped at z 3.1 - the band's face, the
device's 3.05 (`stand-map.ts`, `_walk_line.ts --x=4.4..5.7 --from=3.5
--to=2.0 --y=0.9`: base stops at z 3.05-3.30, now 2.05-2.30 at the wall).
Door 3 is OK at 100 % (was SEALED), STEP at 200 %. Regressions 13 OK +
`gabby-car-overhang` not reproduced, as before.

**The simulator reads a turned drawn cube by its own shape.** Its doorway
line asked "does the model draw a floor here" of each cube's CORNER box, so
air beside a turned cube read as floor and a collider grid that follows the
geometry read as a hole (76417's Gate 1 diamond). `DrawnBox.solid` carries a
turned cube's parallelepiped; the floor test reads `drawnTopOver` and "is
this collider the model's" reads `drawnReaches`. Judged that way the BASE
packs fail 5 of 200 child-play scenarios (10326 Door 3 at 150 % turn 90 and
910004 Door 5 four times: colliders where nothing is drawn); the tilted rule
fails none. `heightOverDrawn` (slide seats over their chute) still reads the
corner box: `TODO(tilted-colliders)`, its 0.2 limit was measured that way.

Device-only: the corridor walk by stick under the handrail, and Door 3's tap
from the corridor (both passed on the Saga, round 2026-09-30i).

### Yaw-turned parts: their own box, plus the corners that are steps (2026-09-30)

The Saga (round 30i) walked out of 76417's Gate 1 onto an INVISIBLE FLOOR 17
blocks over the grass, and off its edge: shell bone `r321`, a baseplate turned
45 degrees about the vertical under the bank's floor, still laid its bounding
box, and the box's corners outside the plate's diamond were colliders over
nothing drawn. A yaw-turned cuboid is now laid from its own box like a tilted
one, and its bounding box is judged column by column (`buildColliderGrid`):

- the bounding-box pieces in a column merge into RUNS (touching spans);
- a run stays a collider when its top is within a jump
  (`YAW_STEP_MAX_BLOCKS`, 1.25) of the highest DRAWN surface at or under its
  bottom in that column - every cuboid's own geometry, recorded per cuboid so
  none is its own support - or of the ground (`yawStepKept`). Kept runs
  support the runs over them (a stair of turned treads climbs run on run);
- otherwise it is dropped: a floor over a drop (76417's corner), or a wall's
  corner taller than a jump (an invisible pillar beside a doorway).

76435's climb is the case for the steps: its stair's risers are 1.19 and
1.44 blocks without the corners and 0.44-0.75 with them, each corner a riser
over the tread drawn under it. The export warning counts cuboids, runs kept
and dropped.

**Measured over the 40 favourites** (`output/yaw-colliders-0930/` in the
worktree that made it; each set from the index's first pick; base = a clean
archive of `90b6c0b0` with its own `bun install`, A = `f164960e` (this rule),
B = `5ee3a3d6` (A + the drop guards below); `tools/collider-diff.ts`,
`scripts/_clearance_report.ts --sizes=100,200`, `_ix_passability.ts` at
100-400 %, turns 0 and 90, `tools/verdict_diff.py`, `scripts/sim.ts` with the
tree's simulator at `93b8a099` for all three):

| over the 40 favourites | base (yaw AABB) | A: yaw rule | B: + guards |
|---|---|---|---|
| collider cells | 59,315 | 58,365 (-952, +2) | 58,528 (+163 guard cells) |
| summed form height (sixteenths) | 586,460 | 580,521 | 582,235 |
| reach at 100 % (square blocks) | 20,818.5 | 20,614.3 | 20,617.3 |
| reach at 200 % | 22,262.5 | 22,152.6 | 22,158.2 |
| rooms reached at 100 % / 200 % | 708 / 1,083 | 695 / 1,067 | 696 / 1,068 |
| passability rows SEALED -> OK (of 830) | - | 27 | 27 |
| OK rows that regressed | - | 6 | 8 (+ Gate 1 at 100 %, both turns) |
| sim child play, 200 scenarios | 0 fail | 1 fail | 0 fail |

181,379 yaw-turned cuboids over the 40 (B): 4,472 runs kept as steps, 3,269
dropped. Unlocked: 76417 Door 1 (SEALED -> OK at every size and turn),
11371 Door 6 (100-300 %), 21318 Door 3 (100-400 %) - three of the five
doorways "exact for all" unlocked, and 76435 keeps its climb (reach 416.4 ->
416.0 at 100 %, rooms 33 -> 35). Regressed: 11371 Door 5 OK -> STEP at
300/400 % (both turns), 21318 Door 1 OK -> SEALED at 150 % (both turns),
76417 Door 3 STEP -> ONE-WAY at 300 %.

**Every reach lost is a walk over nothing drawn.** The four sets that lose
more than 10 square blocks at 100 % lose them at an invisible floor:
60446 (360.1 -> 277.9: the climb's first riser stood on a corner at
(2.1, 2.25, 12.4-13.1) - `drawn_at.ts` finds 0 cuboids there), 21318 (631.8 ->
585.3: the upper floor was crossed at (18.1, 10.94, 10.4-10.6), 0 cuboids,
over a 10-block drop), 10261 (1,905.7 -> 1,839.6: (37.6, 13.25, 9.9), 0
cuboids) and 71043 (878.5 -> 859.5). `reach-path.ts <base> <new> --to=x,z,level`
prints the route the base walked and where the new pack loses it.

The one child-play failure in A was 11371 Doors 5/6 at 150 % turn 90: the
porch line (2.5 out) fell 4.9-6.6 blocks where the model draws a narrow
ledge the 150 % re-lay leaves without a collider at that turn (the same
case the "exact for all" trial met). In B the doors' drop guards stand
there and the line stops, attributed to the model. `TODO(yaw-colliders)`:
a narrow yaw-turned ledge re-laid at 150 % turn 90 can lose its collider.

Rules tried and rejected (`exp-v2`, `exp-v3`, six sets): judging a run by the
highest drawn top under its TOP and keeping only the cap over it changed
nothing measurable; keeping a run that BRIDGES two drawn floors (both sides
along x or z within the auto-step) kept wall corners between wall tops and
re-sealed 76417 Door 1.

### A doorway over a drop (2026-09-30)

With its invisible floor gone, 76417's Gate 1 - a barred gate in the bank's
outer wall, the bank standing 17 blocks up on the rock that holds the vault
track, nothing drawn outside it at any height (`drawn_at.ts`: 0 cuboids in
the columns past it) - opened straight into the air: the simulator's lines
through it fell 13.9 and 15 blocks. No access stair reaches that high
(`STAIR_MAX_RISE16`, 4 blocks), and the model has no floor out there to
restore, so the gate leads nowhere: it opens and shows the view, and a child
may not walk off it.

`planDropGuards` (after the access stairs) follows each doorway side's
LANDING out from the leaf column, column to face-sharing column on that side
within `GUARD_REACH` (3), while each column's floor is within a jump of the
last; a column on the side whose floor lies more than `GUARD_DROP16` (4
blocks) under the landing beside it gets a guard - its empty cells filled
from the landing's floor to `GUARD_HEIGHT16` (1.5 blocks, over a jump) above
it. Never in a leaf column, a closed cell, an avoided cell (rides, track,
figures, seats, vehicles) or past the grid (`TODO(drop-guards)`: a door at
the grid's edge over a drop is reported, not guarded - 910004 Doors 3 and 5,
910032 Door 5). The doorway's `stairs` notes say what was guarded;
`output/yaw-colliders-0930/guard_notes.ts <dir>` lists them.

Over the favourites (B): 35 doorway sides in 14 sets got a guard note,
163 guard cells laid in 12 sets, 7 drops not guardable. Clearance leaves 26 neighbouring cells
untrimmed it trimmed before. The only verdicts that change are Gate 1's at
100 % (OK -> SEALED, both turns: honest - nowhere to walk) and two rows
that gain a SHORT-APPROACH flag (41732 Door 6, 80049 Door 2 at 100 %);
reach is unchanged (20,614.3 -> 20,617.3). At 200 % the leaf column and the
guard leave a one-block alcove outside Gate 1, and the gate reads OK there.

The simulator attributes a stop on a guard to the model's drop
(`modelDropUnder`: nothing drawn within a jump under the doorway's floor
past the stopping face), and `standOver` replays a device standing spot: the
regression case `gate1-invisible-floor-76417` stands the player on the round
30i pack at the Saga's spot (corner + 13.56, 16.88, 1.44) - REPRODUCED, on
colliders with nothing drawn under - and on the new pack the spot is inside
the guard and no Gate 1 line falls.

**Device-only:** Gate 1 opened on the Saga (the guard is invisible: does a
child read an open gate it cannot walk through as broken?), and the 76417
diamond edge at the bank's other doors (Doors 2/3 walked fine in 30i).

### A step-out onto a floor (Pixel round 30k, 2026-10-07)

Standing just inside 76417's OPEN Gate 1 (7511.70,-43.0,7153.30, pin
7500,-60,7150), the Pixel player was moved out to ~7513,-44,7151 and fell 17
blocks; the gate was closed afterwards. The cause is the door's own close
path, not the guard and not a figure: the round's chat helper
(`_pixel_cmd.sh`) taps the chat's Exit at raw 45,39 after each command, and
when the chat had already closed that tap landed on the world - the frame
before each fall shows its touch marker, then the "Open / close" hint and the
leaf swinging shut. A tap closed the gate; the step-out then ran. The player's
body was only TOUCHING the doorway's cells (7153.30 is 7153.2998 in float32:
0.0002 of overlap with the z 2..3 cells), which counted as inside; the side it
stood on (into the bank) is wall for all 3 blocks of the search; and the other
side's first point where the body was free - floor or no floor - is 2.3 blocks
out along the gate's diagonal normal, over the drop: (11.70 + 0.707 x 2.3,
3.30 - 0.707 x 2.3) = (13.33, 1.67), exactly where the device landed
(7513.33,-60,7151.67).

`stepOutPlan` (bedrock-interactives.ts) now (a) counts a body overlapping a
doorway cell by under 1/64 block as beside it, (b) accepts a point only where
the body is free AND a floor lies within a step over to one block under its
feet (`STEP_OUT_DROP`), set down on that floor, the occupant's own side first,
then the other, and (c) plans the moves BEFORE the close: an occupant with no
such point on either side refuses the close with "Step out of the <door> to
close it - there is no floor to step onto." Regression
`gate1-throwout-76417` replays the Pixel's poses on the 30k pack: the device
pose and one a tenth of a block further in both fall 17.02 blocks on the old
runtime; on this one the device pose closes without moving the player and the
deeper pose steps into the bank, onto its floor at 10.14,17.06,4.76. Gate 1's
drop guard is unchanged (`gate1-invisible-floor-76417` still OK).

Not caused by this, seen on the way: both of the round's Gate 1 poses
(the `/tp` to 10.5,17.5,4.5 it tapped from, and 11.70,17.0,3.30) overlap
static colliders in the pack (the f5 wall at 10,17,4, the full cell at
11,17,3). Bedrock let a teleported player stand there, and the round's
diagonal walk that ended at the second pose STARTED inside the first; a walk
from a legal spot does not reach either.

### Known limits

- Shapes are quarter-block bands along one axis. A 1-stud wall (6/16) against
  a cell face leaves 8/16 of collider, not 6; a wall standing in the middle of
  a cell off the centre band, two walls in one cell, or a corner, stay full.
- A cell's form is one box, or a band plus one box: a cell holding a floor
  plate, a wall AND a shelf keeps the whole footprint over the extra span.
- Figures (`scripts/figures.js`) read a form as the full block it replaced
  (`blockSpan`, `6e3d8725`): their planner is block-granular, so they gain
  nothing from clearance yet (TODO in `blockSpan`).
- The tread planner and the reach walk (`ScaledColliderGrid`) read a form as
  its whole block: conservative, they never count on the freed space.
- Array collision boxes (the floor + wall and wall + ceiling forms) are
  format 1.26.0; the Pixel loaded them (below). The 100 % turned-form pass
  (a placement turned 90/180/270) is host-tested only, not on the device.
- `rail-track.test.ts`'s 910044 case times out at 60 s after the host's power
  loss on 2026-09-25, at this branch's base `bb6dcf8e` as well: not clearance.

### On the Pixel (GameTest, world `cmgametest`, 2026-09-25)

Packs from committed trees (`8cb10287` after, `bb6dcf8e`/`e68194e9` before),
GameTest variants by `_gametest_pack.ts`, content logs in the clearance
worktree's `output/clearance-0925/device/logs/`. Every run: all placement
actors found, no content-log error about a block, no `BRICK_WAND_FORM_FALLBACK`
(every form block resolved), and every part and seat check passed.

| set | before clearance | after clearance |
|---|---|---|
| 80049 Gate 1 | SEALED: closed blocked, open `partial` (0.68) | OK: closed blocked, open **passed** (1.03) |
| 76435 Door 1 | SEALED: closed blocked, open `partial` (0.60) | OK: closed blocked, open **passed** (1.03) |
| 76435 Door 2 | OK | OK (closed blocked, open passed) |
| 41732, 6 doorways | 6/6 as predicted (earlier rounds) | 6/6 as predicted; Door 3 SEALED as predicted |
| 76417, 3 doorways | 3/3 (earlier rounds) | 3/3: closed blocked, open passed |
| 910004, 3 doorways | 3/3 (Door 1 OK, Doors 2-3 SEALED) | 3/3 (same) |

Two faults the device found, both fixed and re-run:

- **910004 Door 3 walked through CLOSED** (first after-run, `6e3d8725`). Not a
  collider gap: the offline walk put the approach spot inside the closed
  leaf, and Minecraft lets a body walk out of a box it already overlaps. An
  approach now skips every column a leaf of the doorway's group fills closed
  and must be clear with the leaves closed (`e68194e9`); Door 3 reads SEALED.
- **80049 Gate 1's opened doorway lost its sill.** The runtime laid an opened
  doorway's own blocks as air, clearing the static part the cut had kept (a
  sill under a leaf hung a plate up); the walker dropped into the 1/4-block
  pit and stopped. Own cells with a kept span are now restored (`8cb10287`);
  the gate then walked through.

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
- `bun scripts/_ix_sealed_causes.ts <pack dir> <geometry dir> [--drawn] [--kit8]`:
  why each doorway that is not OK is not (the model, the colliders, the walk;
  "Doors a minifig uses, at 100 %"); `DEBUG_DOOR=<set>/<label>/<size>` draws
  both lattice reaches. The geometry dir comes from
  `_favorites_export_sweep.ts --geometry <dir>`.
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

Round 2026-09-25b (910032's 12 missed seats, 42663's headboard-less beds),
each rule from a crop render of the miss (`output/ix-seats/shots/`):
- a part with something resting on half its top (the plate under an armrest)
  is not a seat surface; a backrest is measured to the top of its STACK
  (brick, plates, curved brick) for a seat two studs deep; a base under 2.5 x
  the seat's area is the seat's own body, not its floor; a turned seat is
  measured in its own frame, with only backrest parts turned with it;
- a square seat's back may be on either axis (a booth), and armrests at both
  ends with a wall along a long side make a sofa;
- stools: a steering-wheel top counts, the column walk allows a few LDU of
  gap (an open-stud round plate's mesh is 3 LDU), half an LDU of height
  tolerance; a toilet (`isToiletBowl`: an inverted dome or dish) faces away
  from its cistern;
- a MATTRESS without a headboard (`isMattress`): one colour, at least 1.8 x as
  long as wide, nothing beside it at its height but a pillow at exactly one
  short end (at most 16 LDU), mostly on parts of another colour; flipped
  `Tile … Inverted` pairs count as a surface (42663's camper beds). Without
  the pillow rule it added 7 false beds (roof panels, mats).
910032 8 -> 26 seats (sofas, armchairs, booths, 3 of 4 bar stools, the
toilet, stools); 42663 0 -> 3 beds; 42670 0 -> 1 bed. Still missed: 910032's
4th bar stool (its wheel touches the counter at seat height), 42670's sofa,
armchair and stools, 11371's armchair (its seat is a bracket; the old find
was the plate under the armrest). The same rules add about 11 seats that are
NOT furniture in other favourites (10261 1, 31141 1, 41703 1, 42639 2, 60380
2, 76457 1, 77092 1, 80049 2; seen in renders): small 2 x 2 "chairs" are the
open precision problem.

## Brick-built doors, gates and mechanisms

A door built from plates and tiles on two clips, or a bus's side wall on
hinge bricks, has no description to read; what it has is a JOINT.
`engine/brick-hinges.ts` (driven by the interactivity stage after the
moulded rules, the same cap, entity, animation, collider and tap-box path):

1. **Joints from LDCad.** `scripts/gen-hinge-joint-snaps.py` resolves every
   TURNING connector of the joint families (finger hinges, clips, round pins,
   bars, holes, axles, turntable rings; from stud primitives only a hollow
   stud's hole) into `engine/hinge-joint-snaps.ts` (1,272 parts, packed). Two
   placements whose connectors mate on one line (finger to finger of one
   group, a clip on a 4 LDU bar, a male cylinder in a female one of its
   radius) are a joint; an axle in an axle hole is a joint that does not turn.
   LDCad lays a snap's sections from its position toward its local -Y.
2. **Rigid connections**: a stud inside another part's box, a stud-group
   part's top under another's bottom, a small part embedded in another, every
   non-turning joint - all only between parts SQUARE to each other (a leaf
   the source left ajar stands on the floor's studs but is not on them).
3. **Cut a joint line**: every turning joint on one line at once (a door hangs
   on two hinges). The side that comes away small is what moves; a lone bar
   held only by the leaf's clips is the pivot (910004).
4. **Class by shape, checked by a sweep.** Every class was tightened by a
   visual review of what it found (each assembly rendered red in its grey
   surroundings, `bun scripts/_ix_hinges.ts --list=<picks> --crops=<dir>`
   then `_shoot_set.mjs`): 135 candidates became 14.
   - A PANEL (its parts cover half its outline face on) beside a vertical line,
     standing on a floor, at most 3.5 x as tall as wide: a **door** (a lintel
     over it) or **gate** (none) - a doorway like a moulded one. Under a lintel
     but off the floor, or too tall: a **door leaf** / **hinged panel**
     (swings, collider kept).
   - A **wing**: a thick section of 12+ parts on hinge bricks or plates that
     swings OUT into free air (at most 2 percent of it in the model a quarter
     turn out, at least 25 percent turned in): 41395's bus sides read 0/27 and
     0/46; a coaster's lattice deck (0/19, 6/10) and a stair railing (8/44) do
     not.
   - Lids and flaps only on a hinge proper; a level hinge set at an angle is an
     angle joint (a roof, a ramp).
   - Rejected by rule, each seen in the review: a bar in a bar tube or hollow
     stud (railings, ladders, lamp posts - 10341's tower read as twenty lids),
     assemblies mostly of Technic parts (a mechanism's insides), leaves of
     struts (low cover), a mirror or sign on its clip (in the air, no lintel),
     small flaps on clips (roof wedges, pipes, signs).
   - A **mechanism** that turns a step per tap only on a turntable. On a pin or
     an axle the review found a cart's wheel, a davit and a lift's linkage and
     no windmill; nothing yet tells them apart, so none moves.

Every joint line is reported with its verdict (`interactivity.hinges` in the
pack diagnostics: lines, verdicts, what moved and its noun);
`bun scripts/_ix_hinges.ts <ldr> --all` lists them with the reason.

Over the favourites (first picks, LDraw): 80049 2 doors (the teal double
door on clips), 910004 2 doors (the patchwork door), 910047 2 doors (the
plank gate) + 1 upstairs door, 76435 1 gate (the stud-covered slab door),
41395 2 wings, 11371 2 hinged panels (window columns on a tower's hinges).
Not found: 10354's round door (its hinge 3830/3831 joins two floor
modules; the round leaf is not on a joint the table knows), 42639's garage
gate and 910049's iron gate (no joint line splits them off), cranes, lifts,
drawbridges and windmills (no turntable joint in the favourites; on axles, see
above).

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
occupant step-out and the threshold treads. Also unproven (2026-09-29,
offline only): the approach trims (10326's Doors 1-2, 11371's Door 7), a
minifig-sized doorway opening at 100 % (80049's 0.9-block shop doors, 42670
Door 1), and the doorways the fine lattice now walks (21318 Door 1, 41732
Door 3, 11371's diagonal shop doors, 31141 Door 4) - a GameTest walk of each
is the check.

## The 40-set audit (2026-09-26)

Every favourite set, exported from its index first pick through the one
interactivity stage (`bun scripts/_favorites_export_sweep.ts` at `46aea7ea`, main merged),
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
| 10261 | 4 container, 4 seat, 1 bed, 1 lever | 3 seat, 1 mechanism | 1 mechanism | 4 container, 1 seat, 1 bed, 1 lever | no doorways | parts+seats 10/10, figures 5/7 moved |
| 10303 | 2 seat, 4 turnable | 3 seat, 1 mechanism (1) | 1 seat, 1 mechanism | 4 turnable | no doorways | parts+seats 6/6, figures 7/8 moved |
| 10326 | 6 door, 1 window, 1 seat, 2 lever, 1 turnable | 3 door, 1 seat (1), 1 turnable (1), 1 mechanism (1) | 1 mechanism | 3 door, 1 window, 2 lever | 3/6 at 100 % | doors 4/4, parts+seats 7/7, figures 7/7 moved |
| 10337 | 1 turnable | 2 door (2), 1 hatch (1), 2 seat (2) | 2 door, 1 hatch, 2 seat | 1 turnable | no doorways | not run |
| 10341 | 1 turnable | 1 mechanism (1) | 1 mechanism | 1 turnable | no doorways | parts+seats 1/1 |
| 10354 | 2 window, 3 container | 1 door (1), 1 mechanism (1) | 1 door, 1 mechanism | 2 window, 3 container | no doorways | parts+seats 5/5, figures 8/9 moved |
| 10365 | 1 container, 2 seat, 1 turnable | 10 mechanism (1) | 10 mechanism | 1 container, 2 seat, 1 turnable | no doorways | parts+seats 3/3, figures 6/8 moved |
| 11371 | 8 door, 2 window, 2 seat, 1 lever, 2 mechanism | 5 door, 1 container (1) | 1 container | 3 door, 2 window, 2 seat, 1 lever, 2 mechanism | 1/8 at 100 % | doors 7/7, parts+seats 8/8, figures 7/7 moved |
| 11374 | - | 5 lever (2), 2 turnable, 3 mechanism (3) | 5 lever, 2 turnable, 3 mechanism | - | no doorways | pinball pass |
| 21061 | - | 3 door (3) | 3 door | - | no doorways | not run |
| 21063 | 1 bed | 1 gate (1) | 1 gate | 1 bed | no doorways | parts+seats 1/1 |
| 21318 | 3 door, 1 turnable | 2 door, 4 seat (4), 1 lever (1), 1 mechanism (1) | 4 seat, 1 lever, 1 mechanism | 1 door, 1 turnable | 0/3 at 100 % | doors 2/2, parts+seats 1/1, figures 3/4 moved |
| 21360 | 4 seat, 1 turnable | 3 seat (3), 2 mechanism (2) | 2 mechanism | 1 seat, 1 turnable | no doorways | parts+seats 5/5, figures 9/9 moved |
| 31141 | 5 door, 2 window, 4 seat, 3 lever, 1 turnable | 3 door, 5 seat (3), 2 turnable | 1 seat, 1 turnable | 2 door, 2 window, 3 lever | 4/5 at 100 % | doors 5/5, parts+seats 9/10, figures 4/6 moved (failed: Window 2) |
| 41395 | 2 door, 1 window, 1 container, 1 lever, 1 turnable, 2 mechanism | 3 door (2), 1 turnable, 2 mechanism (1) | 1 door | 1 window, 1 container, 1 lever | 0/2 at 100 % | doors 2/2, parts+seats 6/6, figures 3/3 moved |
| 41703 | 1 door, 8 window, 1 container, 3 seat, 1 bed, 1 lever | 1 door, 1 window, 1 container, 1 seat, 2 turnable, 2 mechanism (1) | 2 turnable, 2 mechanism | 7 window, 2 seat, 1 bed, 1 lever | 1/1 at 100 % | doors 1/1, parts+seats 14/14, figures 3/4 moved |
| 41732 | 6 door, 2 window, 10 seat | 2 door, 2 container (2), 8 seat (5) | 2 container | 4 door, 2 window, 2 seat | 5/6 at 100 % | doors 6/6, parts+seats 12/12, figures 6/7 moved |
| 42172 | 1 turnable | 2 door (2), 1 turnable, 1 mechanism (1) | 2 door, 1 mechanism | - | no doorways | parts+seats 1/1 |
| 42639 | 2 door, 5 seat | 1 door, 1 gate (1), 2 container (2), 2 seat (2), 3 bed (3) | 1 gate, 2 container, 3 bed | 1 door, 3 seat | 1/2 at 100 % | doors 2/2, parts+seats 6/6, figures 6/8 moved |
| 42652 | 1 door, 4 window, 1 lever, 1 turnable | 2 door (1), 2 seat (2), 1 bed (1), 1 mechanism | 1 door, 2 seat, 1 bed, 1 mechanism | 4 window, 1 lever, 1 turnable | 1/1 at 100 % | doors 1/1, parts+seats 6/6, figures 4/4 moved |
| 42663 | 1 door, 1 window, 2 container, 3 bed, 1 turnable | 1 door, 2 seat, 3 bed (3), 2 mechanism (2) | 2 seat, 2 mechanism | 1 window, 2 container, 1 turnable | 0/1 at 100 % | doors 1/1, parts+seats 7/7, figures 2/3 moved |
| 42670 | 7 door, 2 container, 1 bed, 1 lever | 3 door, 1 gate, 6 seat (4), 1 mechanism | 1 gate, 6 seat, 1 mechanism | 4 door, 2 container, 1 bed, 1 lever | 3/7 at 100 % | doors 5/5, parts+seats 6/6, figures 6/7 moved |
| 43267 | 2 container, 5 seat, 1 turnable | 3 container (1), 1 bed (1), 1 mechanism | 1 container, 1 bed, 1 mechanism | 5 seat, 1 turnable | no doorways | parts+seats 8/8, figures 4/5 moved |
| 60380 | 3 door, 13 window, 10 seat, 1 turnable | 3 door, 7 seat (7), 3 mechanism (2) | 3 mechanism | 13 window, 3 seat, 1 turnable | 1/3 at 100 % | doors 2/2, parts+seats 28/28, figures 11/14 moved |
| 60446 | 2 seat | 4 hatch (2), 2 seat, 1 mechanism | 4 hatch, 1 mechanism | - | no doorways | parts+seats 2/2, figures 1/3 moved |
| 71040 | 2 door, 2 container, 1 seat, 5 turnable | 3 door, 1 window, 1 container (1), 1 bed (1), 1 lever, 1 mechanism (1) | 1 door, 1 window, 1 bed, 1 lever, 1 mechanism | 1 container, 1 seat, 5 turnable | 0/2 at 100 % | doors 1/1, parts+seats 9/9, figures 0/2 moved, 1 in a wall |
| 71043 | 2 door, 9 turnable | 1 door, 4 seat (4), 1 bed (1), 2 mechanism (2) | 4 seat, 1 bed, 2 mechanism | 1 door, 9 turnable | 0/2 at 100 % | parts+seats 11/11, figures 3/4 moved |
| 75397 | 1 door, 3 container, 1 seat, 5 turnable | 2 turnable, 4 mechanism (4) | 4 mechanism | 1 door, 3 container, 1 seat, 3 turnable | 0/1 at 100 % | doors 1/1, parts+seats 7/7, figures 5/6 moved |
| 76269 | 3 door, 12 window, 3 container, 10 seat | 1 door, 1 mechanism (1) | 1 mechanism | 2 door, 12 window, 3 container, 10 seat | 2/3 at 100 % | doors 3/3, parts+seats 25/25, figures 15/20 moved |
| 76286 | - | 1 hatch, 2 seat (2), 2 mechanism (2) | 1 hatch, 2 seat, 2 mechanism | - | no doorways | figures 4/4 moved |
| 76417 | 4 door, 4 window, 1 container, 1 seat | 4 door, 3 container, 1 seat (1), 1 lever, 1 mechanism (1) | 2 container, 1 lever, 1 mechanism | 4 window | 3/4 at 100 % | doors 3/3, parts+seats 7/7, figures 9/11 moved |
| 76419 | 4 seat | 2 gate (2), 1 mechanism (1) | 2 gate, 1 mechanism | 4 seat | no doorways | parts+seats 4/4 |
| 76435 | 2 door, 1 gate, 7 seat | 3 door (1), 1 seat | 1 door | 1 gate, 6 seat | 2/3 at 100 % | doors 3/3, parts+seats 7/7, figures 8/10 moved |
| 76457 | 6 door, 3 window, 8 seat, 1 bed, 2 turnable | 6 door, 1 gate (1), 1 window, 3 container, 3 seat (1), 1 bed (1) | 1 gate, 3 container | 2 window, 5 seat, 2 turnable | 6/6 at 100 % | doors 6/6, parts+seats 14/14, figures 11/12 moved |
| 77092 | 1 container, 1 seat | 1 door (1), 1 container, 1 bed (1), 1 mechanism | 1 door, 1 bed, 1 mechanism | 1 seat | no doorways | parts+seats 2/2, figures 2/4 moved |
| 80049 | 3 door, 4 window, 4 seat | 2 door (2), 4 seat (4), 1 bed (1) | 1 bed | 1 door, 4 window | 0/3 at 100 %, 2 at its size | doors 3/3, parts+seats 7/8, figures 8/8 moved (failed: Window 3) |
| 910004 | 5 door, 8 window, 2 container, 9 seat | 7 door (1), 4 window, 7 seat (1), 4 bed (4), 1 mechanism | 2 door, 4 bed, 1 mechanism | 4 window, 2 container, 2 seat | 1/5 at 100 % | doors 5/5, parts+seats 19/19, figures 2/4 moved |
| 910032 | 5 door, 23 seat, 3 bed, 10 turnable | 6 door, 1 gate (1), 6 window, 3 container (3), 16 seat (12), 1 bed (1) | 1 door, 1 gate, 6 window, 3 container | 7 seat, 2 bed, 10 turnable | 3/5 at 100 % | doors 5/5, parts+seats 35/35, figures 4/7 moved, 1 in a wall |
| 910047 | 3 door, 1 container, 3 seat | 1 gate (1), 3 container, 1 seat (1), 1 bed (1), 5 mechanism (4) | 1 gate, 2 container, 1 bed, 5 mechanism | 3 door, 2 seat | 3/3 at 100 % | doors 1/3, parts+seats 4/4, figures 7/8 moved (failed: Door 1, Door 2) |
| 910049 | 1 door, 1 seat, 1 turnable | 1 gate (1), 1 mechanism (1) | 1 gate, 1 mechanism | 1 door, 1 seat, 1 turnable | 0/1 at 100 % | parts+seats 3/3, figures 6/8 moved |

Totals over the 40 packs (`output/ix-final/sweep-m/`): 40/40 export and
validate (`_mcaddon_check`); 83 doorways, 0 FAIL: 40 walked through at 100 %,
9 ONE-WAY (walked out, the step back in is over the jump), 3 SMALL, 2
NO-APPROACH, 29 SEALED (`output/ix-final/walk-m.json`); 243 moving parts,
1,580 tap boxes, 0 overlaps, 0 over a seat; the tap probe: 3 parts refuse
every tap (10337's and 75397's turnable inside a closed body, 10365's chest
lid in the hold), 0 open without closing again from a spot that opened them,
3 out of reach (21318's, 75397's and 910032's turnables). Main's scene
vehicles now own 60380's car (its two car doors and steering wheel) and a
turnable of 42639; they left this stage's count with it.

SEALED means the doorway opens (the leaf swings, its cells clear) but one side
has no floor a player can stand on along the straight corridor through it:
76417's 4-pane shop door stands at the platform edge over a drop, 42663's van
door opens onto furniture, and most of the rest open onto rooms the shipped
COLLIDER grid has filled (a collider cell is a whole block whenever any
geometry reaches it, and a minifig room is 2-3 blocks wide with furniture in
it). Finer colliders are now in: "Clearance" above took this to 38 OK / 34
SEALED, and says why the rest stay sealed.

### GameTest on the Pixel (cmgametest, 2026-09-26)

All 40 sets through `output/gametest/ix-final/_gt_device_run.py` (one test
variant bound at a time; 10337 and 21061 have nothing to test). Seven sets
a fix touched were re-run on the merged build (`2972c608` variants of the
`46aea7ea` packs: 10326, 42670, 31141, 42652, 80049 in run 4; 11371, 910047
in run 3); the other 31 are the first run's (`fc38d81a` packs). 71040's
re-run could not open the world (a featured-server tile pushed `cmgametest`
to slot 3, which the driver does not check), so its row is the first run's.
Logs: `output/gametest/ix-final/logs/` (first-run copies of the re-run sets
in `logs-run1/`), summary `device-summary.json`. **Doorways 69/71 as the
offline walk predicts; parts and seats 306/308; pinball pass.** Every seat
mounted, the brick-built finds included (80049's, 910004's and 910047's
doors and 76435's gate walked as predicted except below; 41395's two wings,
11371's two hinged panels and 71043's two doors toggle on a hit).

Closed since the last round:
- **71040 Door 1** toggles open and closed (first run, `fc38d81a`): the tap audit now taps a second
  time at the OPEN boxes and the test stands at a spot that does both, clear
  of the closed leaf (the old spot was 0.46 block from its hinge end).
- **41395 Door 1/2** read ONE-WAY offline (the bus floor is over the jump
  from the road) and walk out on the device as predicted.
- **42670 Door 4** passes: the walk follows the offline route leg by leg and
  jumps the 1.25-block rise. The walker ends on the street at progress 0.76,
  so this pass is by the progress rule, not a clean crossing into the room.
- **10326 Door 2/4, 11371 Door 3/4**: through, then off a drop beyond, now
  judged through (they were "fell").

Still differing:
- **910047 Door 1/2** (the brick-built plank gate): offline OK; the device
  walker falls off the narrow threshold closed and open (progress 0.32 and
  0.73, ending on the arena floor). The straight line stays in the route's
  columns, so the leg-by-leg walk does not apply; the simulated player drifts
  off a 1-block ledge.
- **42652 Window 2** passes again from the nearest accepted spot (run 4); the
  both-ways spot, now kept for doorway parts only, was refused on it.
- **31141 Window 2, 80049 Window 3**: the runtime refuses the hit as "behind
  a wall from here" (the new `craftmatic:ix_refused` field), from the spot
  the offline host accepts and that passed in the 2026-09-25 round.
  Unexplained (TODO in `_gametest_pack.ts`); a player standing in front of
  the window is not refused offline.

### Why the misses

- **Brick-built doors and gates**: see "Brick-built doors, gates and
  mechanisms" above (found 14; 10354's round door, 42639's garage gate and
  910049's iron gate still missed).
- **Micro-scale sets** (21061, 21063, 76419): their "doors" and "gates" are
  carved recesses a few studs tall; nothing a minifig-scale player could use.
- **Vehicles' own parts** (10337's and 42172's butterfly doors, engine
  covers and seats; 76286's cockpit): brick-built on a car or ship.
- **Mechanisms** (cranes, winches, lifts, swing arms, drawbridges,
  catapults: 10341, 10365, 21318, 21360, 60380, 71043, 75397, 910047...):
  no generic mechanism rule. The pinball's flippers, buttons and plunger
  (11374) are the pinball engine's; a coaster's cars and lift (10261, 10303)
  the coaster engine's.
- **Seats**: see "Brick-built seats" above (910032 8 -> 26, round
  2026-09-25b); still missed: 910032's 4th bar stool, 42670's sofa, armchair
  and stools, 71043's hall benches. The ride cars' seats are the cars'.
- **Beds**: 42663's three camper mattresses are found (`isMattress`);
  910004's four still are not (not inspected).
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

## Gabby's Dollhouse additions (2026-09-26)

- **Swings** are seats (`isSwingSeat`), sat on the seat under the bar.
- **A canopy hinged on its handle bar** (`Windscreen ... Canopy ... Handle`,
  18990) is a `lid`; a vehicle's canopy stays its vehicle's.
- **Slides and lifts** are rides, not interactives: `engine/bedrock-rides.ts`
  (docs/bedrock-addon-guide.md "Gabby's Dollhouse"). A lift closes the
  "lifts" gap in "Why the misses" for the dollhouse shape only (two or more
  tall slim guides and a car covering them); cranes, winches and drawbridges
  are still missed.
- None of the five sets has a doorway: dollhouses are open-fronted
  (`_ix_passability.ts`: 0 doorways, 0 FAIL).
