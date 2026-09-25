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
| seat | 4079 family + `Seat/Chair/Bench` (`isSeat`); library furniture `Chair/Bench/Stool/Toilet/Throne/Sofa/Couch/Armchair` incl. Fabuland (`isFurnitureSeat`), seated on its PAN (`seatPanLocalY`); brick-built stools: a 2 x 2 tile on a narrow column 6-32 LDU over its floor (`brickBuiltStools`) | — | — | — | the invisible rideable seat entity (the same one the Brick Wand's "Add seat here" uses); a figure the source sat there rides it |

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
  the source left open, 76269's). Doorways
  whose closed cells merely share or touch a cell (`linkSharedDoorways` →
  `shares`) keep a shared cell laid while either is closed, but move on their
  own: the first build moved every touching pair together, so 76457's Door 1
  swung whenever Door 2, hung beside it on the same side, was tapped (device
  2026-09-24e). Over the favourites 20 doorways touch another; 14 are halves of
  a double door, 6 move on their own (76457's Door 1 and 2, 10326's two leaves
  meeting at a corner, 42670's two staggered doors);
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

## Not verified on a device

Device round 2026-09-24d (packs at 8346fb29): doors render as LEGO, open and
close on tap, walk-through confirmed (76457 doors, 76417's front double doors
and 45-degree barred door). Device round 2026-09-24e (packs at 1e33902c):
76417's front doors open, close and block both ways; the through-wall filter
worked there; 41732's doors 4 and 5 walk both ways and the wand reads 5 of 6;
76457's Doors 2-5 and Gate 1 open and close, a 90-degree placement's Door 3
works. Fixed since, unproven on the device: the line-of-sight tap filter and
its message, double doors paired only when they are one (76457's Door 1), the
stool seat, the reach note. Still unproven: `custom_hit_test` picking (and that
`pivot` is the box centre), the root-bone scale at a non-100 % size, the
occupant step-out and the threshold treads.

## Measured on the favourites (2026-09-24)

`bun scripts/_favorites_export_sweep.ts` at `7f4637f7` (after device round
2026-09-24e's fixes): **40/40 exported, 0 problems**; then `bun scripts/_ix_sweep_report.ts <sweep dir> --md=...` walked every
doorway at 100 % (turn 0) and at its passable size. **72 doorways, 0 FAIL**: 35
walked through open and blocked closed at 100 %, 1 too small at 100 % (SMALL,
kept blocked) and walked through at its 150 %, **36 SEALED**. Totals: 72 doors,
12 cabinets, 67 windows, 11 levers, 84 turnables, 61 seats (40 moulded, 21
brick-built stools in 12 sets). `bun
scripts/_ix_hitbox_audit.ts` over the same 40 packs: 246 parts, 1,434 tap
boxes, **0 overlaps between parts, 0 over a seat, 0 parts without a box**. Two
turnables could not keep a box clear and stay static (the export warns): 10261's
turntable 3679 sits under a seat, and one of 21318's two coincident 32124s (0 gates and 0 hatches:
the favourites have no fence gate, and their two trap doors are 92099, whose
centred origin names no hinge).

`bun scripts/_ix_tap_probe.ts` over the same packs: of 246 parts, **242 take a
tap** from a standing spot within 3 blocks. 2 are refused from every such spot
because the model's own colliders stand on every line of sight: 10337's
turnable 1 and 75397's turnable 1, both closed inside a body you cannot stand
in. 2 more have no standing spot within reach at all: 21318's and 75397's
turnable 2. The 21 stools were read from their columns (`_seat_scan.ts`), not
checked by eye in the game. Most are a round tile or a studs-on-edge tile on a
round plate or brick, as designed. At least one is a false positive: 31141's
is a 2 x 2 tile on 1 x 2 bricks on a roof, probably a chimney cap. Some others
are unclear: 60446's rounded-end tiles, and a 41732 tile on small tiles on a
plate. The stool rule has no test for indoors.

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
