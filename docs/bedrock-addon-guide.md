# Bedrock playable add-ons

Read before changing entity geometry, vehicle controls, cameras, pack generation, or device QA. For block structure exports, see [Minecraft export](minecraft-pipeline-guide.md).

[Project guide](../CLAUDE.md). Paths in code spans are relative to the repository root unless explicitly qualified.

## Bedrock playable add-on — entity geometry (2026-09-14)

Tracker + architecture: **[TASKS-BEDROCK-ADDON.md](../TASKS-BEDROCK-ADDON.md)**;
spec: `docs/bedrock-entity-spec-2026-09-14.md`. The `.mcaddon` vehicle entity is
compiled from REAL part geometry (`engine/ldraw-part-geometry.ts` →
`ldraw-part-prototype.ts` → `ldraw-entity-compiler.ts`), colours are LDraw RGB
(`ldraw-entity-materials.ts`, classes generated from LDConfig), and each entity
ships MER/normal texture sets with `capabilities:["pbr"]`. Hard-won facts:
- **Bedrock's entity frame is left-handed.** Compile in a right-handed render
  frame (Y up, nose −Z, right +X; LDraw→render is a proper rotation `A`) and
  mirror ONLY at the JSON step: `origin.x = −max.x`, `pivot.x = −pivot.x`,
  bone `rotation = (−a, −b, c)` from a ZYX Euler of `A·R·Aᵀ`. That is
  Blockbench's codec convention and it was proven on the Pixel with an
  asymmetric calibration model. The previous `transformPoint` mirrored one
  facing (det −1) and nobody noticed because vehicles are symmetric.
- **LDraw parts are open at the bottom and model the inner ceiling.** Ray
  parity leaves every brick hollow; the prototype compiler floods air from
  the top and four sides instead (six sides for translucent parts), so a brick
  is one cuboid and a pin hole stays open. Stud primitives are stripped from
  prototypes and re-emitted only where the model leaves them exposed.
- **Budgets are device policy**: balanced 6,144 cuboids keeps a 340-part
  X-wing at 4 LDU and a 1,906-part DeLorean at 8 LDU, both ≥ 0.95 six-view
  silhouette IoU (`scripts/_entity_silhouette.ts`); the spec's 4,096 pushed
  them to 8/16 LDU. `scripts/_playable_ref.ts` is the CLI export gate.
- **Pixel QA mechanics** (helpers: `scripts/_pixel_shot.sh <name>` screenshots
  to a ≤1999 px jpg, `scripts/_pixel_cmd.sh "/cmd"` types one chat command; both
  set `MSYS_NO_PATHCONV=1`, without which Git Bash rewrites `/tp …` into
  `C:/Program Files/Git/tp`). The Pixel's wireless-adb address rotates and its
  mDNS entry doubles it ("more than one device"): `adb devices -l`, then
  `export ANDROID_SERIAL=<ip:port>`. Import with the game at its main menu via
  `am start -n com.mojang.minecraftpe/.MainActivity -a android.intent.action.VIEW
  -d 'content://com.android.externalstorage.documents/document/primary%3ADownload%2F<f>.mcaddon'
  -t application/octet-stream --grant-read-uri-permission` (a `file://` VIEW
  imports nothing; an implicit intent lands in the chooser). A re-import of the
  same pack uuid lands in a `<name>(1)` folder and the world list must name the
  NEW version. Activate packs by editing the world's `world_*_packs.json` ONLY
  after `am force-stop` (the running app rewrites them from memory); `adb shell
  rm` inside `Android/data/com.mojang.minecraftpe` is denied, `adb push` works.
  The world list is sorted by last played — screenshot it before tapping a tile.
  `/ride @s start_riding @e[type=craftmatic:<cid>,c=1] teleport_rider` mounts
  without a touch; `/testfor` only sees entities in ticking chunks. **After an
  elevated `/tp` the player FALLS back to the ground before the screenshot**
  (Creative, not flying) — an afternoon of "entities vanish when viewed from
  above" was the camera pitched into the grass at ground level. For an exact
  viewpoint use `/camera @s set minecraft:free pos X Y Z facing X Y Z`, then
  `/camera @s clear`, and check the Position readout.
- **Riding facts measured 2026-09-15 (Pixel, 1.26.45)**: a first-person rider
  sits inside the entity's cuboids. A rider-driven ground vehicle is
  client-authoritative: `getVelocity()` reads ~0 while it visibly drives (planes
  report fine), so speed is measured from the position delta — `riddenVelocity`
  in both runtimes. `follow_orbit` has NO block collision.
- **Second device round (2026-09-15, captures in
  `output/bedrock-entity-qa/captures-2026-09-15b/`), all measured:**
  - **The nose is inferred, never assumed** (`vehicle-facing.ts`): driver parts
    (minifig torso/head/legs, seats, steering stands all face local −Z),
    windscreen lean, trans-red tail lights, wheel count/size asymmetry, canopy
    position and the narrow end (planes) vote; the decision and votes ship in
    `craftmatic-diagnostics.json`. Before this every golden model drove
    tail-first and an X-long plane flew sideways. Check a change with
    `_entity_silhouette.ts --out`: in `left.png` the nose must be on the LEFT.
  - **A camera preset's `control_scheme` key is IGNORED; `/controlscheme` works.**
    Under the default locked scheme the joystick's left/right STRAFES (the
    "just forward and backwards" report); `vehicle-camera.js` runs
    `controlscheme @s set player_relative` on mount so the stick ROTATES the
    rider, which is the heading `input_ground_controlled` follows. Neither
    `follow_orbit` nor `fixed_boom` turns with the rider, so ground vehicles
    get a script-driven `minecraft:free` camera placed behind the rider's yaw
    every tick (`easeTime 0.15`); aircraft keep the orbit preset because look
    pitch is their climb/dive input. Cleared on dismount.
  - **Jump is a native camel `dash_action`** (hold charges, release dashes;
    the touch UI shows horse-style Jump + Dismount buttons, so Jump no longer
    exits). The driver script only plays effects and the cooldown HUD.
  - **Aircraft follow bedrock-samples' Happy Ghast at format 1.26.30**:
    `free_camera_controlled` (NOT `input_air_controlled`, which needs
    ≥1.21.90 and the entity declared 1.20.80), `vertical_movement_action`,
    `movement.hover`/`navigation.hover`, `jump.static`, `is_tamed` +
    `behavior.player_ride_tamed`. Speeds are the ghast's scaled
    (movement 0.3, flying_speed 0.3, vertical 0.5): at 1.35/0.9 the X-wing
    climbed 206 blocks in a second; at these it climbs ~17 blocks/s and flies
    forward ~5 blocks/s.
  - **Format 1.26.30 removed `minecraft:pushable` from the schema** — the whole
    entity fails to parse (`… is not a valid entity type` at spawn). Vanilla
    mobs use `pushable_by_block` (pistons) and, only when shovable,
    `pushable_by_entity`. **A Bedrock identifier's name may not start with a
    digit** (`craftmatic:75892mclaren_preview` never registered; structures
    named that way fail `structure load` silently — the wand now checks
    `successCount`). Every id in the pack carries a `v_`/`p_` guard; the
    export stem from the LEGO tab is name-first, so real exports are safe, but
    a CLI `--label` starting with the set number is not.
  - **Reading the Pixel's content log**: Settings → Creator → "Enable content
    log file" + "Show content log UI" (both ON now); errors show on world load
    and land in `games/com.mojang/logs/ContentLog*.txt` (adb-pullable). Android
    logcat has nothing. `options.txt` is in internal storage — not reachable.
  - **Brick Wand**: a ghost entity (`bedrock-preview-entity.ts`) shows the
    whole build at the pin, turned with the rotation; the action bar carries a
    progress bar; "Pin centred on me" puts the footprint centre on the player
    (a vehicle-only pack used to land half a model away — the "nothing
    appeared" report); each tile's ticking area is held 8 ticks after its load
    and the last one 40. World-tile taps on the Play screen need a 120 ms press
    (`input swipe x y x y 120`); a plain `input tap` does nothing. Joystick
    steering over adb is a DRAG from the stick centre (`input swipe 337 550 470
    550 1500`); a press at the stick edge does nothing, and look-area swipes did
    not register at all.
  - **Test ground vehicles on flat open ground.** The Tumbler summoned at a
    shoreline (shallow water, sand steps) read 0.0 mph on every input; on
    grass it drove, turned ~90° and kept the camera behind. An aircraft flies
    where the rider LOOKS: the Milano dived 26 blocks over 32 forward because
    the free-look pitch was down. `/fill` for a test platform silently does
    nothing when its chunks are not loaded.
  - **Silhouette gate scores the placements the compiler kept** (`IoU kept`),
    with `IoU full` and the stand / detached / internal counts beside it; the
    old single number blamed the compiler for the display stand it drops on
    purpose (76240: 0.84 full vs 0.957 kept). `mergeAlignedCuboids` is
    lossless and worth ~6 %; cell size was never the limit (76240 at 4 LDU /
    39k cubes still 0.854 full).

## Minifig scale, extras, cockpit ranking, buildings (2026-09-16)

Built and gated offline (`output/bedrock-entity-qa/round-2026-09-16/`); the
device claims are listed in `TASKS-BEDROCK-ADDON.md` until the Pixel round
settles them.
- **One scale** (`engine/lego-scale.ts`): a standing minifig is 96 LDU
  (measured from 3816/3815/973/3626 at their standard offsets) and the player
  1.8 blocks, so 1 block = 53.33 LDU, 1 stud = 6 geometry units. The entity
  compiler, the `.mcaddon` block export (`resolution: 'minifig'`, the default
  when the setting is `auto`) and the placement of figures/seats all use it.
  The old 1 block = 5 studs made every vehicle 1.8× too small - "erratic"
  because a display-scale Tumbler and a minifig-scale Senna read as the same
  mistake at different sizes.
- **Cockpit is ranked evidence on the primary object** (`findCockpit`): a
  seated figure (torso inside the 8 %-shrunk footprint, feet above the model's
  lowest point) → seat mould → steering wheel → the LARGEST windscreen/canopy
  mould → the largest translucent part ≥ 30 LDU on two axes → default cabin.
  Eyes: 11 LDU above a torso origin, 51 above a seat pan, 20 above a wheel
  and 30 behind it, the centre of a canopy. The old average over every
  translucent part put the X-wing's rider under its tail (engine glows and
  the cart's lamps outvoted one canopy). The driver figure is removed from the
  geometry (`driverFigureRemoved`); the player sits in its place. Printed
  ids resolve to their mould (`baseMould`: `30372p79` → `30372`).
- **Extras** (`prepareEntityPlacements`): connected clusters on real part
  bounds, largest = vehicle; every other cluster is a `figure` (torso group +
  ≤ a few carried/stood-on parts, whole figures dropped by the stand rules
  included), a secondary `vehicle` (≥ 12 parts with wheels or a seat, or ≥
  15 % of the vehicle) or a `prop`. Figures become minifig NPCs
  (`figureBehavior`: random stroll, open doors, look at players, no damage),
  a wheeled object a rideable car, a wheel-less one a static prop; props
  such as stands are not exported. `mainVehicleOnly` (settings popover
  "Main vehicle only", `--main-only`) leaves them all out. Placement is in
  the vehicle's own levelled frame (`extraPlacement`; frame reasoning in its
  doc comment - the (−x, y, −z) yaw-0 mapping is the one assumption the
  device round must confirm).
- **Facing** (`vehicle-facing.ts`): planes vote on `engine glow` (translucent
  round/dish/cone parts, footprint-weighted, away from their centroid; weight
  3) and `canopy position` (glass only, 1.5); centroid votes are measured
  from the MASS centre in both axes; the narrow-end test runs on both axes
  but only on an axis at least half the other. The Milano's wingspan
  (1,504 LDU) is longer than its hull (785), so "along the long axis" read
  across the ship and its symmetric engine dishes cancelled - the 90° error.
- **Aircraft steer like cars**: `player_relative` + the script chase camera
  for every kind; for a plane the camera looks along the rider's exact yaw
  AND pitch so `free_camera_controlled` and the rider's look agree. The orbit
  preset's drag orbited the camera and never turned the rider.
- **Buildings** (`bedrock-scene-actors.ts`, on the placements that are not a
  vehicle): figures (torso + ≥ 2 parts) become NPCs and leave the block
  scenery; seat moulds (4079 family, "Seat/Chair/Bench" descriptions) get an
  invisible rideable `<stem>_seat` entity at the pan (rider 0.3 blocks under
  it; `lock_rider_rotation: 181`); door LEAVES ("Door …" descriptions, not
  Frame/Glass/Sliding/Revolving) have their cells cut to air and vanilla
  doors hung at the bottom (one per cell of width, outer hinges; the
  hinge end is the mould's origin end on every LDraw leaf; wood by colour,
  `oak_door` renamed to Bedrock's `wooden_door`); leaves under two cells
  tall stay blocks. LDraw has NO bed mould and modular chairs are brick-built,
  so beds and brick chairs are not detected. Census of the target sets:
  10326 - 7 leaves, 1 seat, 9 figures; 910004 - 3 leaves, 9 seats, 7
  figures; 910047 - 9 figures; 76419 is microscale (1 figure).
- **Pipeline trap fixed**: the bricks path threw the geometry voxelizer's
  result away when it produced fewer cells than bricks - at 53 LDU cells a
  192-part Senna is ~35 cells - and with it the grid origin, so every
  component and scene actor failed to align ("Component alignment requires
  resolved source geometry"). The test is now the resolver's own fallback
  count.
- **Third device round (2026-09-16, `output/bedrock-entity-qa/captures-2026-09-16/`,
  58 shots + `notes.md`)**: rider IN the X-wing cockpit (seat 0, 1.89, 1.5 =
  the player's readout), both planes fly nose-first, Senna 2.70 × 2.01 × 7.12
  blocks, the cart on the pilot's LEFT (so `extraPlacement`'s frame holds),
  the seat entity seats and the Dismount button frees. Found and fixed the
  same day: `minecraft:pushable_by_entity` takes NO members at 1.26.30 (every
  figure failed to parse and the wand aborted on its first actor - the
  placement script now skips a failed actor and says so); a scripted
  `controlscheme` once on mount did not take while the chat command did, so
  it is re-applied every 10 ticks; doors sat entombed in the second cell of
  a straddled 20 LDU wall and three floated over air (the cut now opens every
  cell the FRAME straddles and steps the door down onto the floor). Still
  open: the Tumbler's 32 LDU grain reads 14.5 wide (11.5 true) with blobs
  where the rear tyres are (the repeated-part budget item). Device facts:
  Pixel at `192.168.0.122:5555` with an `SM_X730` also attached (always set
  `ANDROID_SERIAL`); a `… && adb … &` chain backgrounds the whole chain in
  Git Bash (wrap the backgrounded part in `{ … & }`); the chase camera is
  re-set every tick, so `/camera @s clear` cannot give a first-person view
  while riding; `/execute … positioned ^ ^ ^N run summon` ignores the
  offset; the flat 61×61 test platform is at −123/66/500 in the QA world.
- **Round 2 (2026-09-16, `captures-2026-09-16b/`)**: the round-1 fixes hold
  (figures parse, wand places all actors, stick turns car and plane with zero
  strafe, figures 1.96 blocks tall and strolling). New findings: the
  **DbixConvV3 sources are exploded instruction layouts** (Winter Chalet
  125 × 116 studs vs 41 × 18 in its `.io`) - export buildings from the `.io`
  / `IOModel2V2` files; at 53 LDU cells an 8 LDU baseplate makes its whole
  cell solid, so a door leaf sitting on it reads the floor row as its bottom
  cell (the door now hangs one cell up, judged on in-grid neighbours); a
  door implies a passage, so solid cells between the door and the nearest
  air within three cells are opened on both sides (the outside of the model
  counts as air); 60616's unofficial file is described `GLASS DOOR FOR FRAME`;
  BrickLink Designer Program `.io` files name torsos `bl_973…c01_torso`;
  figures carry `minecraft:home` (radius 12) so they do not wander off.
  Device facts: `/tp @s ~ ~ ~` DISMOUNTS a rider; yaw probe = `/execute as
  @e[type=…] at @s rotated as @s run summon armor_stand ^ ^ ^6`; the entity's
  server yaw lags the client while driving (use travel deltas); `input text`
  drops `"`; the stick rotates the RIDER and the body follows on forward
  input (no pivot in place); the wand menu needs `input swipe 1119 820 1119
  420 500` to reach Place/Undo.
- **Round 4 (2026-09-16, `captures-2026-09-16d/`, 64 shots + `notes.md`)**: the
  brick-accurate shell + collider grid and the jointed minifig rig are CONFIRMED on
  the device. Content log **zero `[error]`** in 39,876 lines. Walls stop the player
  at **offset 0.00** on both axes at rotation 0° and again at 90°; the player stands
  at y 67.00 (ground) / 70.00 (upper) with the drawn plate under the feet; 4/4 doors
  hang in their openings and an NPC had already opened one (`behavior.open_door`
  works). Figures: 7/7 chalet, 7/7 museum, 8/8 modular, all jointed (arms, hands,
  two legs), legs at different swing angles across rapid frames, **2.03 blocks** tall
  beside the 1.80 player. **Structure rotation 90° is CLOCKWISE**:
  `wx = ox + (sizeZ−1−lz)`, `wz = oz + lx` (verified on 4/4 doors). Open defect:
  the museum, modular and Hogwarts SHELLS render near-black in full daylight while
  the chalet and the X-wing are lit correctly and the figures beside them are bright —
  the shell entity's light sample is almost certainly taken inside the
  `light_dampening` collider volume. Device facts:
  - **`/sdcard/Android/data/<pkg>` is only mounted while the app process lives.**
    After `am force-stop`, every `adb push`/`shell` into `minecraftWorlds/<id>/`
    fails `Transport endpoint is not connected` AND kills the adb-over-wifi
    transport. Working recipe: force-stop → relaunch the app to its MAIN MENU →
    `adb push` to `/sdcard/Download/` → `adb shell cp` into the world dir, one op
    per connection with a disconnect/connect retry. Editing `world_*_packs.json`
    at the main menu is safe; the game only reads them at world load.
  - **Walking over adb**: `adb shell input swipe 337 550 337 380 <ms>` from the
    joystick centre drives the player forward for the duration; background it and
    screenshot mid-walk. This is what makes the wall-collision test measurable.
  - **`/effect @e[family=craftmatic_figure] slowness 60 20 true` pins figures still**
    — without it a figure walks 2-7 blocks between the `/tp` and the screenshot and
    every same-depth pixel measurement is meaningless (two wasted attempts).
  - **The BP `.mcstructure` is the door oracle** (little-endian NBT; ~50-line
    parser): `size`, the palette with full block states and every door's LOCAL
    x/y/z. Add the placement origin and `/testforblock` needs no guessing.
  - **A bare `/testforblock <pos> <block>` (no states)** compares the DEFAULT
    permutation, and the failure text distinguishes wrong-state
    (`did not match the expected block state`) from wrong-block — a cheap
    "is this door here at all" probe.
  - `/kill @e[family=craftmatic_figure]` / `craftmatic_seat` clears a round's
    actors in one command; a plain `/fill <box> air` reports the non-air count.
  - `adb shell input text` occasionally drops leading characters (a `/give`
    arrived as `giv`) — screenshot the result before relying on it.
- **Patch hygiene**: a Python `"""…"""` patch string turns `\b` into a
  BACKSPACE; seven regex word boundaries in the compiler silently became
  `\x08` and `isFigurePart('…','Minifig Hair')` returned false. Use raw
  strings or write the TypeScript with the Write tool; `cat -A` shows `^H`.

## Jointed minifigs and brick-accurate buildings (2026-09-16, round 4)

Built and gated offline (`output/bedrock-entity-qa/round-2026-09-16b/`,
`QA-BRIEF.md` there lists the device claims); commit `66b0367`.
- **Every figure is rebuilt on the canonical minifig rig** (`engine/minifig-rig.ts`,
  `assembleMinifig`), not compiled as the pile of parts the source carries.
  Converted sources are lossy: the IOModel2V2 museum has NO arms in any of
  its nine figures, three have no legs and two no head; the old path shipped
  those as legless torsos or left them in the blocks ("some seem to be
  missing legs"). The rig classifies each part of a torso group into a slot
  by the library description first and the id family second
  (`classifyMinifigPart`), re-places the body at the STANDARD offsets and
  supplies what is missing (3626c head, 3815 hips, 3816/3817 legs, 3818/3819
  arms, 3820 hands) in the colours the figure gives away (limbs = torso,
  hips = legs, hands = head). A hips-and-legs composite (`3815c01`/`970c00`)
  is split into three moulds so the legs can move. Headwear keeps its offset
  from the head, a cape/backpack from the torso, a held item from the
  nearest hand re-expressed in the canonical hand's frame.
- **Canonical offsets, torso-local LDU (Y down, figure faces −Z, its RIGHT
  is −X)**, measured from OMR 7140 and BrickLink Designer Program `.io` files:
  head 0,−24,0 · hips 0,32,0 · legs 0,44,0 · arms ±15.552,9,0 turned 10°
  about Z (right arm +10°) · hands ±23.86,26.6,−10.32 = the arm's turn then
  45° about X. Feet at y 72, head top at −24: 96 LDU (`LDU_PER_MINIFIG`).
  `Minifig Leg Right` 3816 spans x −19.5..−1.5 and `Minifig Arm Right` 3818
  stands at −15.552: the figure's right is −X. Cape 4524's origin is the neck
  (bounds y 0..40, z −10.5..20.5): it hangs at torso 0,0,0.
- **The compiler takes a rig** (`CompileLdrawEntityOptions.rig` + `frame` +
  `wholeModel`): bones with pivots at the joints (`MINIFIG_BONES`: body →
  head, arm_right/left → hand_right/left, hips → leg_right/left), aligned
  parts authored in their bone, a rotated part as a child bone `r<i>` under
  its rig bone (so the 10° arms and 45° hands follow the arm bone). Every
  mesh chunk carries its bones' parent chain (empty bones are fine), parents
  before children. `kind: 'figure'` without a rig runs the rig automatically
  and returns `figure.facingLdu` (the torso's EXACT horizontal direction) so
  the actor yaw is no longer snapped to an axis (`extraPlacement` takes it).
- **Animations** (`MINIFIG_ANIMATIONS`, one shared
  `animations/craftmatic_minifig.animation.json`): walk = legs ±32° and arms
  ±25° in opposite phase on `math.cos(query.modified_distance_moved * 38.17)`
  gated by `query.is_moving` (phase tied to distance, so no foot slide);
  look = vanilla's look_at_target on the head; sit = legs −90° while
  `query.is_riding`. The client entity gets `animations` + `scripts.animate`
  (`MINIFIG_CLIENT_ANIMATIONS`). `figureRole`: a torso plus one more BODY
  part is an NPC (the rig fills the rest); one colour and ≥ 3 parts is a
  statue; a torso with only a hand is partial.
- **Custom minifigs** (`minifigFromSpec`): head / torso / hair / legs / arms /
  hands / held items / cape / back accessories by part id + colour;
  `bun scripts/_minifig_ref.ts --label=Knight --torso=973:4 --hair=3901:0
  --legs=1 --held-right=3847:71 --cape=4` builds a one-figure pack (12 parts,
  174 cuboids, 108 ms). The add-on builder accepts a figures-only pack.
- **Brick-accurate buildings** (`engine/bedrock-building-shell.ts`, on by
  default, `addonBuildingBricks` / `--buildings=blocks`): everything that is
  not a vehicle, a figure or a door leaf is compiled as ONE static "shell"
  entity (`<id>_shell`, kind `prop`, `wholeModel`, no clustering so a loose
  tree or signpost stays) at the vehicle pipeline's fidelity, and the block
  structure becomes `craftmatic:collider` blocks. Budgets
  (`LEGO_SHELL_QUALITY`): balanced 16,384 cuboids from 8 LDU, high 32,768
  from 4, ultra 65,536; the compiler coarsens when over. Measured: museum
  10,931 cuboids / 12 meshes / 22.9 s, chalet 6,922 / 8 / 6.6 s, 910047
  8,806, Hogwarts 6,488, all at 8 LDU without coarsening.
- **The grid frame is a MIRROR of LDraw.** The voxelizer maps LDraw (x, y, z)
  to cells (x, −y, z); LDraw and Minecraft are both right-handed, so every
  block export is the model's mirror image (invisible on symmetric builds;
  a hinge side would show). Entities are compiled through PROPER rotations
  and land unmirrored, so a shell compiled like a vehicle could never sit on
  its own colliders. The shell therefore uses the point reflection −I as its
  LDraw→render matrix (`SHELL_FRAME`): the world at yaw 0 sees render
  (−x, y, −z) (`extraPlacement`, Pixel-proven), which composes to (x, −y, z)
  - the grid's frame. Its actor stands at `sceneGridPoint(frame, originLdu)`
  with yaw 0 and turns with the wand like every actor. Fixing the mirror in
  the block pipeline is a separate decision (it changes every schematic
  byte-for-byte; rule 5).
- **Colliders** (`buildColliderGrid`): integer states `craftmatic:lo` (0..15)
  and `craftmatic:hi` (1..16), sixteenths; 136 permutations each setting
  `minecraft:collision_box` origin/size; measured per cell from the shell's
  `partBoxesLdu` (every body cuboid's LDraw AABB), so a cell whose only
  content is an 8 LDU baseplate collides 0..3/16 and the player stands ON
  the drawn plate. Full block when no box reaches a solid cell (gap fill).
  Alpha-tested clear texture (`textures/blocks/craftmatic_collider.png`,
  registered in `blocks.json` + `terrain_texture.json`), `light_dampening: 0`
  (daylight reaches the interior; the shell is lit from its origin block),
  `selection_box: false` (taps reach the vanilla door behind). Doors,
  trapdoors, lanterns/torches/lights, beds and signs stay visible
  (`isSceneBlock`). `toBedrockBlock` passes `craftmatic:` ids through with
  namespaced int/bool/string states. Chalet: 1,020 colliders, 302 part-height.
- **Shell entity**: `shellBehavior` - no gravity, no collision, 0.1 collision
  box, unhurt, `craftmatic_shell` family; a display stand left beside a
  vehicle ships the same way (the Senna golden model now lists a `(shell)`).
- **Seated figures ride their seat.** A figure the source sat on a seat mould
  (`SceneFigure.seated`, torso within 30 LDU of the pan and up to 60 above it)
  used to take the seat out of the free list and spawn standing. Now the seat
  entity ships anyway (`seatIndex` on the figure → `PlacementActor.rideOf`),
  the seat's `family_types` admit `craftmatic_figure`, and placement.js calls
  the seat's `minecraft:rideable` `addRider` once both are spawned; the `sit`
  animation (legs −90°, sign unverified on a device) plays on
  `query.is_riding`. Chalet: 9 seats, figures 4/5/6 ride seats 12/13/16 of the
  actor list. Unverified on the Pixel (built after round 4's packs were cut).
- **Round 5 (2026-09-16, `captures-2026-09-16e/`)**: the shell lighting fix
  holds (museum wall 15.5 → 114.9/255 mean grey at noon, modular 12.1 → 110.7;
  the entity's light IS the block at its own origin, so a shell's origin sits a
  block over its roof, `originAboveModel`); colliders still at offset 0.00
  after the lift; seated figures ride their seats and stay put 22 min; the
  player sits on a free seat. Device facts: each pack ships its OWN wand item
  `craftmatic:<stem>_brick_wand` (a hotbar wand drives the model it belongs
  to - `/give` the right one); opening a wand needs a ~700 ms long press; the
  wand menu now has a "Lighting / night vision" row, so button offsets shifted;
  with `MSYS_NO_PATHCONV=1` an `adb push` needs a `C:/…` local path (a `/c/…`
  path silently pushes nothing and the follow-up `cp` still reports success).

## Making a playable add-on: the exact UI chain, and every source (2026-09-17)

**The web UI chain, in full.** Load a set in the LEGO tab (search + click a
`.lego-result-card`, or drop a file on the upload input), then:

1. Leave the `Vehicle` select beside the download menu on **"Detect vehicle
   components"** (`#lego-vehicle-mode`, value `auto`).
2. Leave `⚙ MC settings` at its defaults. The rows the add-on actually reads
   are **Resolution** = "Auto — finest that fits", **Model scale (playable
   add-on)** = "Auto", **Brick-accurate buildings** = ON, **Main vehicle only**
   = OFF, **Vehicle detail** = "Balanced", **Vehicle front** = "Auto".
   *`Main vehicle only` ON removes every figure, seat and door;* `Brick-accurate
   buildings` OFF replaces the shell entity with a coloured block structure.
3. `Download…` → **"Add-on — controls detected or selected components
   (.mcaddon)"** (the `mcaddon` option under the `Minecraft: Bedrock` optgroup).
   No other option makes a playable pack: `mcpack` is a static structure,
   `lego-mcpack` is only a texture pack, `live` pushes blocks to a running game.

**For a stud-dense model, the default drops the studs — set Vehicle detail to
Ultra.** `balanced` allows `maxStudCubes` 4,096 within a `maxModelCubes` budget
of 16,384, and the stud budget is what is LEFT after the render cuboids
(`ldraw-entity-compiler.ts:1382`), so a large shell can leave almost nothing for
studs and they are dropped whole. Measured on the named sets (default → ultra):

| set | cuboids | studs | omitted at default |
|---|---|---|---|
| 71043 Hogwarts Castle | 15,650 → **48,057** | 0 → **9,172** | 1,938 |
| 31201 Hogwarts Crests | 1,860 → **23,537** | 0 → **9,256** | 9,256 |
| 76435, 910004, 10326, 76405 | — | full at the default | 0 |

71043 goes 0.62 MB → 1.55 MB. The two that need it are the dense ones: a castle
whose shell alone spends the cuboid budget, and a flat crest mosaic whose studs
ARE the picture. **The default is deliberately not changed** — `ultra` is
labelled desktop-class and the QA device is a phone — so this is a per-model
choice, not a bug.

That is the whole chain — the tested Winter Chalet and Natural History Museum
packs used **nothing but these defaults**. The CLI gate
`bun scripts/_playable_ref.ts <model> <out> --label="<name>"` runs the same
`runSchemPipeline`, and re-cutting the chalet from `IO/910004.io` in 2026-09-17
reproduced the round-2026-09-17 reference pack's component list (shell + 7
figures + 9 seats) and both warnings exactly, at 307,690 vs 307,380 bytes.

**Every source reaches this path — measured, not assumed.** Figures, seats,
doors and the shell are found geometrically and from LDraw part descriptions,
never from submodel names, so a flat part list qualifies. One add-on cut per
source class on 2026-09-17 (`output/addon-evidence-2026-09-17/`), all defaults:

| source | model | shell | figures | seats | arm warnings |
|---|---|---|---|---|---|
| `io` | 910004 Winter Chalet | 1 | 7 | 9 | 0 |
| `io_model2_v2` | 10326 Natural History Museum | 1 | 7 | 1 | 0 (was 7) |
| `lxf` (through the real UI) | 71043 Hogwarts Castle | 1 | 4 | 0 | 0 |
| `dbix_conv_v3` (through the real UI) | 76435 Great Hall | 1 | 10 | 3 | 0 after the fix |
| `mecabricks` | 71799 NINJAGO City Markets | 1 | 21 | 1 | 0 |
| `omr` | 10176 King's Castle | 1 | 10 | 0 | 0 |
| `recon_v3` | 10041 | 1 | 4 | 7 | **4** |

`recon_v3` is the one class that still loses arms, and for its own reason: its
arms are present but flung (median 276 LDU from a torso, 0 % within 25), so they
fall outside `groupFigures`' 40 LDU horizontal radius and the rig supplies
standard moulds. That is a corpus defect, not an add-on one. Two limits stay:

- **Vehicle-inside-scenery isolation needs named submodels** (`sourcePath`, set
  only from MPD `0 FILE` sections). `.lxf` and the converted corpora are flat,
  so a vehicle parked in a scenery build falls back to the road-wheel heuristic
  and otherwise exports without a movable subset.
- **The 50 % `fallbackPartCount` cliff** (`engine/schem-pipeline.ts`): if fewer
  than half the parts resolve to real geometry the pack silently degrades to a
  coloured block structure, and a partial vehicle component throws outright.

**A bad source shows up as a bad add-on, not as an error.** Before the DBIX
placement fix below, the chalet cut from `DbixConvV3/910004.ldr` warned
*"the source lacked the figure's right arm, left arm; standard moulds were
supplied"* for **all seven figures**, hung 2 doors instead of 4 and dropped one
leaf outside the export bounds. The same file after the fix hangs 4 doors in 3
doorways with no arm warnings — the `.io` reference's exact profile.

**A retired LDraw mould has no name, and that cost the museum every arm.**
LDraw retires a mould with a one-line stub whose whole description is
`~Moved to <newid>`, so a `^Minifig Arm` description test misses it and the
literal id misses every id list. The `.io`-derived Natural History Museum
places its arms as `981`/`982` and its hands as `983`; `983` happened to be in
the hand id list and `981`/`982` were in no list at all, so `isFigurePart` left
both arms in the building shell and the rig supplied standard moulds — "the
source lacked the figure's right arm, left arm", for all seven figures. **The
museum add-on signed off in the 2026-09-16 round shipped that way.**
`mouldFamilyId(part, description)` in `engine/minifig-rig.ts` now resolves the
redirect once and every figure classifier asks it, which covers the whole
retired-mould family rather than one id at a time. Measured through
`scripts/_playable_ref.ts` on `IOModel2V2/10326-noprint.ldr`: arm warnings
**7 → 0**. Blast radius: **292 of 802 `IOModel2V2` files carry 981/982, 2,616
placements** — every one of those sets' figures was armless in an add-on.
`OMR`, `MecabricksLDR`, `ReconV3` and `DbixConvV3` use `3818`/`3819` and were
never affected. Do not "fix" the next missing body part by appending an id to
`FIGURE_PART_IDS` without first checking whether its description is a stub.

**DbixConvV3 files really are exploded instruction layouts — the 2026-09-16
note stands.** A draft of this section briefly claimed the spread was a
placement bug; that was measured on a conversion variant which was afterwards
rejected, where the footprint collapse came from mis-placing parts rather than
correcting them. On what ships, the minifig-arm fix moves footprints only a
little: Winter Chalet 125 × 116 → 124 × 97 studs (0.19 → 0.23 parts/stud²),
Natural History Museum 114 × 54 → 83 × 54 (0.65 → 0.89). **Keep cutting
buildings from the `.io` / `IOModel2V2` file where one exists.** Density below
~0.3 parts/stud² marks a spread layout.

The arm fix does reach the add-on: the chalet cut from `DbixConvV3/910004.ldr`
warned "the source lacked the figure's right arm, left arm" for all seven
figures before it and for none after, while the door count (2 hung, 1 leaf
outside the export bounds, against 4 in 3 doorways from the `.io`) is unchanged
— that difference is the layout, not the arms.

## Model scale, aircraft descend and the wand's size/aim (2026-09-17)

Built and gated offline (`output/bedrock-entity-qa/round-2026-09-17/`, vitest 1,627
passing); the device claims are listed in `TASKS-BEDROCK-ADDON.md` until the Pixel
round settles them.
- **Model scale** (`engine/addon-scale.ts`, `planAddonScale`): ONE multiplier of the
  minifig scale drives the voxel cell (`LDU_PER_BLOCK / scale`, so blocks and colliders),
  the entity compiler's units per LDU (`BEDROCK_UNITS_PER_LDU × scale`, every compile
  call in `buildPlayableAddon`) and the figure placement beside a vehicle
  (`extraPlacement(..., lduPerBlock)`), so geometry, colliders and actors always agree.
  `ui/schem-export.ts` derives BOTH from one plan (`planResolutionAtCell`); an explicit
  block resolution still sets the cell and the entities follow it (`modelScale =
  LDU_PER_BLOCK / cellLDU`). `auto`: a minifig body part (973/3814/76382 torso, 3815
  hips, 3816/3817 legs, `_torso` custom parts) → 1×; a figure-less model whose TITLE
  reads as a vehicle → shrunk so its longest origin extent (+1 stud a side) is the real
  thing's length (car 4.6 / boat 9 / aircraft 12 blocks), never enlarged, floor ¼×;
  a microfigure (85863, 48 LDU with its base) and no minifig → 2× (`MICROFIG_SCALE`, the
  microfig stands player height); anything else 1×. The settings popover's "Model scale" row shows the decision for
  the loaded set. Measured: 10242 Mini Cooper (OMR) auto → **0.38×**, cell 140 LDU,
  geometry bounds 7×5 vs 14×9 at 1×, collision 2.8×1.8 vs 3.5×2.5, seat 0.3 vs 2.84
  high, same 6,113 cuboids (the part grain stays in LDU). LEGO Icons car names
  (`mini cooper|aston martin|land rover|defender|volkswagen|caterham|ecto-1`) were
  added to `CAR_WORDS` so their sets read as vehicles. Below ¾× a door leaf never
  spans two cells, so no doors hang (the popover says so).
- **Aircraft descend**: vanilla's only vertical input is Jump = climb; the Happy Ghast
  descends by LOOKING down, and under the script chase camera (which sets a
  `minecraft:free` camera every tick) that pitch was reported not to reach the entity.
  The plane entity carries `craftmatic:descending` (`vertical_movement_action`
  −0.5, `AIRCRAFT_DESCEND_GROUP`) with `craftmatic:descend_on/off` events; the driver
  script adds it while the rider pulls the stick BACK and holds Jump and removes it when
  the stick returns (`vehicle.triggerEvent`), HUD `[DESCENDING]` /
  `BACK+JUMP: DESCEND`. Sneak could not be the input: on a mount it is Dismount.
- **Wand rework** (`bedrock-placement-pack.ts`): state per player is
  `{anchor, dimension, rotation, size, aim}`.
  - *Follow my aim* (menu 9): every 4 ticks `getBlockFromViewDirection` (96 blocks);
    the footprint centre is put on the hit FACE (Up → the block above, East → x+1, …),
    the anchor floored, the ghost teleported. Any pin/edit/place clears `aim`.
  - *Size* (menu 10, steps 150/200/300/400/25/50/75/100 %): actor positions scale
    about the pin (`worldPoint`), each spawned actor gets `craftmatic:size_<pct>`
    (`withSizeGroups`: one component group per step with `minecraft:scale`, a scaled
    `collision_box` and, for a mount, `minecraft:rideable` with seat positions and
    camera radius scaled - `minecraft:scale` is assumed NOT to move a rider's seat), the
    ghost gets the same event. Blocks: a brick-shell pack ships its collider grid as
    run-length text (`encodeColliderRuns`, value 0..136 = air or a `(lo,hi)` pair,
    `[valueChar][countChar]` pairs, chalet ≈ a few KB) and the script re-lays it at the
    new size in ≤48-block boxes (backup → clear → `setPermutation` of
    `craftmatic:collider[lo,hi]`, sixteenths re-cut per world row, a block two cells
    share keeps min lo / max hi, 400 blocks per tick), leaving doors/lights out; a
    coloured-block export refuses a resized place with a message (entities-only sizing
    is still offered). Undo restores the boxes.
  - *Fine turn*: a pack with no tiles (a vehicle, a figure) rotates in 15° steps both
    ways (`pointAt` turns about the footprint centre; `size()` is the turned bounding
    box); block packs keep 90°. DeLorean controls stay the LAST button.
  - **Invisible walls after scaling (fixed 2026-09-18, offline; device round pending).**
    Two defects in the re-lay, both found by `test/bedrock-collider-scale.test.ts`:
    (1) the box clear never ran - `dim.fillBlocks({from,to}, 'minecraft:air')` passes a
    plain object where `fillBlocks(volume: BlockVolumeBase, …)` needs a `BlockVolume`
    INSTANCE, and the call sat inside `try {} catch {}`, so every re-lay UNIONED with the
    colliders already standing. Cycling 100 → 150 → … → 400 without undo left every
    earlier size's walls in place, invisible. Fix: `clearColliders()` walks the box in
    32-cubes (`fillBlocks` is capped at 32768 blocks like `/fill`) with
    `blockFilter.includeTypes = [craftmatic:collider]`, so the player's own world inside
    the footprint is untouched; the placement now records its `bounds` and the NEXT one
    sweeps them first (a smaller re-lay does not reach the bigger one's footprint), in
    ≤48-block boxes because a bigger `tickingarea add` is refused. The lo/hi merge is
    also now restricted to cells THIS pass wrote. (2) a cell claimed every world column
    its scaled span touched, dilating the model outward by up to a whole block at any
    fractional factor: at 150 % the wall beside a doorway claimed the doorway's own first
    column. Fix `cellColumns()`: at f ≥ 1 a column is claimed when its CENTRE is inside
    the span (the ranges still tile exactly, so no wall gets a hole); below 100 % several
    cells share a column and "any overlap" stays, or the floor gets holes. Integer steps
    (200/300/400 %) are unchanged, which is why the earlier 2× device round looked clean.
  - Tests: `test/bedrock-placement-size.test.ts` (size groups, collider runs, 200 %
    re-lay geometry, refusal, aim-follow, 15° turn) beside the runtime/ghost tests, and
    `test/bedrock-collider-scale.test.ts` — the re-lay at EVERY size step against the
    model's own volume derived from geometry (X/Z: an exact set of columns; Y: the
    sixteenth hull a single `[lo,hi]` pair can express), a doorway that must stay
    walkable, repeated placement at growing sizes, and the same run over 31141's real
    shipped pack (skips without the clego corpus). Both share `test/_placement-host.ts`,
    whose `fillBlocks` now rejects a non-`BlockVolume` the way the game does — the old
    `vi.fn()` stub is what hid defect (1).
- **Custom-minifig UI** (`ui/minifig-builder.ts`): the LEGO tab's "🧍 Minifig" popover is
  the browser face of `minifigFromSpec` - part ids + LDraw colour ids per slot, colour
  names from `/ldraw-color-names.json`, values persisted in localStorage, the compile on
  the main thread (`buildPlayableAddon` with a 3×3 empty grid and one figure, parts from
  `/ldraw-parts` like the Worker). `scripts/_minifig_browser_check.mjs` drives it headless
  and captures the download. The export stem is the shared 12-char name stem
  (`Browser Knight` → `Browser.mcaddon`, pack id `browser`, `/function b_f53710`).
- **LXF placement** (`docs/lego-renderer-guide.md`): Studio's `ldraw.xml` row is applied
  as its inverse and is primary; measured on 91 native `.lxf` files with authentic
  truth. 71043's floating/pierced pieces came from the forward-applied fallback path;
  it now takes the Studio path for all 5,967 placements.
- **Device round 2026-09-17 (world "917", Bedrock 1.26.51.1, `captures-2026-09-17/notes.md`,
  142 shots)**: BACK+JUMP descends (ALT −43→−60 in 3.5 s), the 0.38× Mini Cooper measures
  4.55 × 2.0 blocks and drives, the whole wand rework passes (aim-follow, size cycle, 200 %
  colliders re-laid and walls stop the player at the doubled position, upper floor at the
  doubled height, figures 3.9–4.1 blocks at 200 % and 0.9–1.1 at 50 %, Undo restores). Five
  defects found and fixed the same day:
  - **`starting_rot_x` is not in the 1.26.51 camera-preset schema** and ONE bad preset fails
    the whole pack's presets (`Failed to load camera presets`). Dropped from `fixed_boom`.
  - **Removing a component group removes its components outright, even ones the base
    `components` also declare.** The descend group's removal left the plane with no
    `vertical_movement_action`, so Jump neither climbed nor descended and dismounted the
    rider. Both directions are now groups (`craftmatic:climbing` added on
    `minecraft:entity_spawned`, swapped by `descend_on`/`descend_off`); the base has none.
  - **An unscaled player cannot sit inside a model shorter than itself**: the 0.38× Mini's
    cockpit seat put the rider through the flank at y −61 (ground −60). A model under
    2.0 blocks seats the rider on it (seat y ≥ height − 0.55).
  - **Figures with a 0.9 × 2.0 collision box could not path out of the rooms the 0.6 × 1.8
    player walks**: 6 of 7 chalet figures never moved until `/tp`'d to open ground. Boxes are
    now capped at the player's, and a figure spawned in a full collider cell is lifted to the
    first clear cell.
  - Aim-follow says "look at a block" when the raycast finds nothing (looking at the sky).
  Device facts: the 1.26.51 joystick ring is NOT at round-5's (337,550) (that is the look area
  now) and two simultaneous touches are impossible from adb; `input keyboard keyevent
  --duration` holds a key and a stylus pointer source counts as a second pointer; keyboard
  SPACE dismounts a rider (use the touch Jump button); `/rotate` does not exist; `/tp @s …
  facing …` dismounts; a `/fill` ruler from y −60 shows 4 blocks (the top ground block is
  replaced). Flat world surface y −60; chalet placed at −17/−60/32, Mini at −1/−61/−186.
- **Round b (2026-09-17, `captures-2026-09-17b/notes.md`)**: content log 0 `[error]`;
  climb survives three descend cycles (the climb group swap works, an event-only cycle on
  an unridden plane too); aim-at-sky message shown. The Mini's CAR sits on the ground
  (y −60.00) - the rider's location reads a block lower (Bedrock reports a rider at its
  seat minus its own ride offset), and the arm/shoe still clipped the driver-side flank at
  the compiler's offset seat → models under 2.4 tall or 2.2 wide now seat the rider on the
  roof line, centred. The figure lift misfired: a 3/16 floor plate is a
  `craftmatic:collider` too, so "any collider = blocked" lifted a ground-floor figure to
  +4 and an upper-floor one onto the ROOF (+8); only a collider spanning ≥ 12 sixteenths is
  a wall now, and a figure with no clear cell within three blocks stays put. Figures 4/5/6
  of the chalet are the seated ones and never walk by design. Device facts: **`adb push`
  into `Android/data/…` does not truncate an existing file** - pad a pushed
  `world_*_packs.json` to at least the old byte length or the JSON ends in trailing garbage
  (`adb shell rm` there is denied); the content log is 16 KiB block-buffered, so the tail of
  a session is missing until the game flushes it.
- **Round c (2026-09-17, `captures-2026-09-17c/notes.md`)**: the Mini rider sits on the roof
  line, centred (+1.33 over the car origin = height − 0.55 for the real 1.9-block car; nothing
  through the flanks; drives). Chalet figures: **0 of 7 roam** with the corrected lift; the
  walkers stand on floor-plate colliders (hi 1/3/15) under a ~2.25-block ceiling and the mob
  navigation does not path there while the player walks the same rooms - see the tracker's
  hypothesis and next experiment. Device fact: quotes CAN be typed over adb with
  `input keycombination 59 75` (Shift+apostrophe), which makes `/testforblock … ["craftmatic:lo"=0]`
  state probes possible.

## Pack identity: the manifest UUIDs are keyed on the model, not on the stem (2026-09-18)

**Three different Hogwarts sets shipped the SAME BP/RP header uuid.** Every
manifest uuid was `deterministicUuid('<salt>:' + id)` where `id =
toBedrockIdentifier(stem)` and the stem carries at most `NAME_STEM_MAX` = 12
characters of the model's NAME (`engine/export-name.ts`). `Hogwarts Castle`,
`Hogwarts Castle and Grounds` and `Hogwarts Castle: The Great Hall` all reduce to
`Hogwarts` → `hogwarts`, so all three got BP header `ae1e85e9-c183-4543-8b2c-2a5d1e7ca0f7`
and RP header `50b68212-9b9b-47cb-97bb-d196628c4460` — measured on two real
archives, not inferred. Minecraft keys a pack by its header uuid: the second
import lands in a `<name>(1)` folder and a world can only ever activate one of
them, so the player silently loses a set.

- **The uuids now come from `packIdentity(stem, label)`** (`engine/mcpack.ts`),
  used by both the `.mcaddon` (`playable-addon.ts`) and the `.mcpack`
  (`mcpack.ts buildManifest`) manifests. It is the FULL label followed by the
  full stem, each reduced to lowercase alphanumeric words and de-duplicated:
  `hogwarts castle 71043 | hogwarts 71043`. Normalizing that far means the LEGO
  tab's `Hogwarts Castle (71043)` and a CLI `--label="Hogwarts Castle 71043"`
  name the SAME pack, so a re-export updates the player's pack in place.
  Deliberately **not** a content hash — re-exporting at another quality or scale
  must replace the pack, not add a second one.
- **`scripts/_playable_ref.ts` passed `setNumber` where `modelExportStem` takes
  `setNum`.** The key was silently dropped, so every CLI export was named by the
  bare 12-char name stem. Nothing caught it because **`scripts/` is outside both
  tsconfigs** (root is `src/`, `web/tsconfig.json` is `web/src/`), so TypeScript
  never excess-property-checked the literal. Treat any object literal in
  `scripts/` as untyped.
- **Blast radius of the old scheme, over `web/public/lego-models-index.json`:
  5,116 of 10,169 sets (50.3 %) shared a 12-char name stem with another set, in
  1,336 clusters** — `heartlake` ×70, `police` ×58, `creative` ×57, `hogwarts`
  ×54, `helicopter`/`imperial` ×35. Name **+ set number** (what the LEGO tab
  already passed, and what the CLI passes now) leaves **0** clusters, which is
  why indexed exports from the tab were never affected; the CLI and the Minifig
  popover (`ui/minifig-builder.ts`, a label with no set number) were.
- **The pack id itself is unchanged in shape** — still `toBedrockIdentifier(stem)`,
  so `/function` (`placementAlias`, a 6-hex hash of the id), the wand item id and
  the entity/structure namespace all still derive from it. With the CLI fix the
  ids become `hogwarts_71043` / `hogwarts_76419` / `hogwarts_76435`, which is
  readable and already unique for every indexed set. **Residual:** two packs with
  no set number and a shared 12-char stem (two custom minifigs named
  `Harry Potter …`) now get distinct uuids but still share the pack id, so their
  entity ids would collide if both were active at once.
- **Every previously exported pack's uuids change with this fix.** A user
  re-exporting a set they already have installed gets a new pack beside the old
  one, once.
- Evidence: `output/uuid-fix-2026-09-18/` (before/after `.mcaddon`s + CLI JSON,
  the collision scan and the re-derivation check). Gates: three packs re-cut
  (71043 `--quality=ultra`, 76419, 76435), 15/15 uuids pairwise distinct, each
  set byte-identical across two builds, `python scripts/_mcaddon_check.py` OK on
  all of them, the shipped `/function b_*.mcfunction` matching each manifest's
  description. Regression tests: `test/playable-addon.test.ts` "pack identity".

---

## The device ceiling is CUBOIDS, not packs and not bytes (2026-09-18)

**Minecraft Bedrock 1.26.51.1 on a Pixel 8 Pro (11.83 GB RAM) dies loading a
world with 10 Ultra-quality add-on packs; 9 load.** The kill is an in-process
OOM, not the low-memory killer: `libc++abi: terminating due to uncaught
exception of type St9bad_alloc` followed by `Fatal signal 6 (SIGABRT)`.

- **Retained cost fits `native heap = 739 MB + 3.08 kB per cuboid`**, which
  predicted three surviving configurations within 2 %. At N=9 the active packs
  summed 258,972 cuboids and 1.58 GB settled; at N=10, 281,185 cuboids and
  death. The ceiling is therefore **~260,000 cuboids summed over every active
  pack** — `DEVICE_CUBOID_BUDGET` in `engine/playable-addon.ts` — and it is a
  cuboid sum, not a pack count.
- **Minifying does NOT reduce memory.** Decisive A/B on the same pack, identical
  cuboids, pretty (131.7 MB of JSON) vs minified (23.0 MB): settled native
  allocation 947,571 kB vs 951,340 kB, **0.4 % apart**, the minified one very
  slightly higher. Never present minification as the OOM fix.
- **Better merging is not available.** `hiddenCubesCulled` and
  `mergeAlignedCuboids` are near-exhausted (culled 0.0-2.5 %, merged
  0.0-11.8 %); an independent greedy same-colour merge found **0.1 %** more and
  zero duplicate cubes. Chunking (1024 cubes per geometry) is not the problem
  either: cube objects are 97.4 % of the bytes, all bone and description headers
  together 2.6 %.

### What the exporter does about it

1. **Every FIGURE is compiled at `balanced` detail however fine the pack is**
   (`clampFigureQuality`, applied in `compileLdrawEntityGeometry` for
   `kind === 'figure'`; vehicles, props and building shells keep the requested
   quality). Ultra exists to spend what is left of `maxModelCubes` after the
   render cuboids **on a dense model**; a minifig is ~10 placements on the rig
   and never approaches that budget. Measured on 76286's four figures, six-view
   silhouette IoU against the figures' own source triangles is **0.940-0.959 at
   1 LDU (1,268-1,586 cuboids), 0.904-0.932 at 2 LDU (444-544) and 0.852-0.897
   at 4 LDU (133-155)** — the head and hands round off, nothing else moves, and
   4 LDU is what a figure has always been given in a balanced pack. If that ever
   reads as too coarse next to a player, clamp to `high` (2 LDU) rather than
   removing the clamp: 1 LDU is 3x the cuboids again for 0.03 more IoU.
2. **The pack's own cuboid total is reported and warned about.**
   `maxModelCubes` caps ONE entity; nothing capped a pack, and one measured pack
   shipped 82,163 cuboids over 12 entities in silence. `packCuboidBudget()`
   puts `pack: { cuboids, entities, deviceCuboidBudget, shareOfDeviceBudget,
   packsThatFitTogether, … }` into `craftmatic-diagnostics.json` on every
   export, and raises an export warning from 10 % of the device budget:
   *"Castle: 82,163 cuboids across 12 entities - 32% of the ~260,000-cuboid
   budget a phone has for ALL of its add-on packs together (measured on a
   Pixel 8 Pro). About 3 packs this size can be active at once; a 4th is likely
   to crash the world as it loads."*
3. **Geometry JSON ships minified** (`geoJson` in `playable-addon.ts`; every
   other file stays pretty-printed for a human opening the archive). This is a
   download-and-storage fix ONLY — see the A/B above.

### Measured effect (2026-09-18)

| pack | quality | cuboids | archive | unpacked | packs that fit in 260k |
|---|---|---|---|---|---|
| 71043 Hogwarts Castle | ultra | 53,695 → **48,683** (-9.3 %) | 1.593 → **0.574 MB** | 95.11 → **16.10 MB** | 4 → **5** |
| 76286 Guardians' Ship | ultra | 23,577 → **18,599** (-21.1 %) | 0.718 → **0.252 MB** | 41.35 → **6.06 MB** | 11 → **13** |
| 76435 Great Hall | balanced | 8,875 → 8,875 (control) | 0.332 → **0.173 MB** | 16.49 → **3.46 MB** | 29 → 29 |

Figures in the two Ultra packs fall 5,602 → 590 (4 figures) and 5,552 → 574
(4 figures); 76435 was already balanced, so its cuboids are unchanged — the
control that shows the clamp only ever touches a pack above balanced.
Gates: `bun run typecheck`, `bun run typecheck:web`, `bun run test`,
`python scripts/_mcaddon_check.py` OK on all three. Regression tests:
`test/bedrock-cuboid-budget.test.ts`.

---

## Entity instancing is a NO-GO; cheaper cubes is worth ~1/3 (2026-09-19)

Three experiments on the Pixel 8 Pro (Bedrock 1.26.51.1, world `917`, the eight
shipped Craftmatic packs active, 71043 Ultra among them — its shell is **48,093
cuboids**). Raw evidence, every `dumpsys` dump and every screenshot:
`output/bedrock-entity-qa/instancing-2026-09-18/` (`samples.tsv`, `fps.tsv`,
`loadtimes.tsv`). Harness: `scripts/_pixel_perf.sh` (`mem` / `fps` / `ref` /
`load`); probe pack generator: `scripts/_bedrock_probe_pack.py`.

The proposal under test was: ship each distinct part SHAPE once and express a set
as transforms — one entity type per part prototype, per-instance rotation/colour
through client-synced `minecraft:entity_properties`. The headroom looked large
(71043 Ultra's 50,319 cuboids reduce to 1,754 distinct shapes, 28.7x; 455
prototypes / 8,612 definition cubes against 30,642 placements).

### 1. The 3.08 kB/cuboid IS definition-side — the premise held

With the pack active and **zero** shell instances, then summoning the shell
repeatedly (`nativePss` from `dumpsys meminfo`, kB):

| instances | 0 | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|---|
| nativePss | 1,211,473-1,213,777 | 1,180,329 | 1,191,121 | 1,212,049 | 1,215,709 | 1,221,025 |
| GL mtrack | 249,528 | 280,380 | 285,304 | 287,920 | 287,696 | 289,156 |

Slope 2 to 5 is **+10.3 MB per extra instance**, 1 to 5 is +10.4, and an
independent 1 to 3 run gave +13.7. So an extra instance of a 48,093-cuboid entity
costs **10-14 MB = 0.21-0.29 kB per cuboid**, against the 3.08 kB/cuboid paid once
when the pack loads: **~93 % of the memory is definition-side.** GL mtrack
confirms the mechanism — the FIRST instance uploads +31 MB of vertex buffer and
every later one adds 1-2 MB, i.e. **the mesh is shared across instances.**

Combined with experiment 2 the whole surface fits one two-term model:
**per instance = 40 kB fixed (the Actor) + 0.22 kB per cuboid.**

Frame cost of rendered cuboids, same run (`SurfaceFlinger --latency`, 60 Hz cap):
1 shell 16.70 ms median (21.25 mean), 2 -> 33.34, 3 -> 33.35, 5 -> 66.67. About
**50-100k visible cuboids for 60 fps, ~150k for 30.**

### 2. Per-Actor cost — NO-GO on both thresholds

`craftmatic:probe_part`: 12 cubes (a 2x4 brick at minifig scale), one
client-synced int property driving bone yaw plus a declared colour slot, no AI,
no physics, no gravity, `is_summonable`. Spawned nearest-first at 2-block spacing
around the player by `/function`.

| entities | nativePss (kB) | delta per entity | frame median | vs 0 entities |
|---|---|---|---|---|
| 0 | 1,289,552-1,289,660 | — | 16.68 ms | — |
| 500 | 1,308,836 | **38.5 kB** | 16.68 ms (17.48 mean) | +0 % |
| 2,000 | 1,380,496-1,381,100 | **47.9 kB** | 33.35 ms | **+100 %** |
| 6,000 | 1,538,392-1,545,084 | **40.1 kB** | 116.7-150.1 ms | **+600-800 %** |

The gate was 10 kB or less per entity **and** under 25 % frame-time regression at
2,000. Measured **31-48 kB** and **+100 %**. Both fail, by about 4x each.

- **It is not overdraw.** With the same 6,000 entities and a `minecraft:free`
  camera 200 blocks away — none of them in frame — the frame time was still
  133 ms (7.5 fps). The cost is CPU-side per-entity work; culling cannot help.
- **Splitting geometry into entities costs ~4x the frame budget per cuboid.**
  96,186 cuboids in **2** entities render at 33.3 ms; 72,000 cuboids in **6,000**
  entities take 117-150 ms.
- **Actor churn leaks.** After killing all 6,000 the heap settled at 1,431,604 kB
  against a 1,289,606 kB pre-spawn baseline — **142 MB not returned**.
- **Persistence works but costs load time.** 2,000 entities saved and reloaded
  fine: **58.4 s vs a 47.8 s control, +22 %, ~5.3 ms per entity.** The spawn
  itself (4,000 `summon`s in one `/function`) was survivable.

Applied to 71043's 30,642 placements: 30,642 x 40 kB = **1.23 GB** of Actor
overhead alone, plus ~128 MB of per-instance cuboids and 26 MB of prototype
definitions — **~1.38 GB against the 148 MB the pack costs today, ~9x worse**, on
a device whose entire add-on budget is ~260,000 cuboids (~780 MB). Break-even is
(48,093 - 8,612) x 3.08 kB / 40 kB = **~3,040 entities**; the set needs ten times
that, and 6,000 idle entities already run at 7 fps. **Do not build it.**

### 3. Cheaper cubes is real but modest — about a third

All 48,093 cubes of the shipped `hogwarts_71043_shell.geo.json` rewritten from
six-face UV objects to box UV `"uv": [u, v]` (each cube keeping its own north-face
uv), cuboid count identical, **file padded to the original byte length so file
size is not a variable**, pushed over the device copy, cold app restart + world
load for every reading:

| | nativePss (kB) | nativeAlloc (kB) |
|---|---|---|
| A original | 1,280,812 / 1,280,960 | 1,145,409 |
| B box UV | 1,224,889 / 1,224,553 | 1,131,114 / 1,130,746 |
| C original restored | 1,269,852 / 1,269,908 | 1,140,935 |

A and C reproduce within 11 MB (0.9 %). Against their mean, box UV saves
**50.7 MB = 1.05 kB per cuboid = 34 % of the 3.08 kB** on `nativePss`, and
12.2 MB = 0.26 kB = 8 % on `nativeAlloc`. The geometry was still parsed and drawn:
content log **0 errors**, and a summoned shell reproduced the original's exact
frame signature (16.68 median / 20.98 mean / 33.35 p90 vs 16.70 / 21.25 / 33.35).

Dropping 5 of every 6 face descriptors removed only about a third of the cost,
because a cube still becomes six quads and 24 vertices however its UVs were
written. **Per-cube face data is a minority of the 3.08 kB, not the bulk.** It is
still the cheapest lever available — worth roughly a third, taking the device
ceiling from ~260k cuboids to maybe ~350-400k — but it is not the 28.7x the
prototype ratio suggested, and instancing cannot deliver that either. Shipping it
means the exporter emitting box UV, which needs one geometry (and a flat swatch
texture) per colour, since box UV maps all six faces from one atlas rect.

### Shipped: box UV + one swatch per colour (2026-09-19)

`compileLdrawEntityGeometry` now groups its cuboids by LDraw colour and emits
**one geometry per colour** whose cubes carry `"uv": [0, 0]`, textured with a
16x16 swatch of that one colour (`generateLegoMaterialSwatch` /
`legoMaterialSwatchName` in `engine/ldraw-entity-atlas.ts`, which replaced the
per-entity 32 x (1+16N) atlas). The swatch is uniform, which is the whole point:
box UV lays the six faces out in a cross **scaled by the cube's size**, so a
50-unit cube walks — and wraps past — hundreds of texels, and on a uniform
texture every one of them, at every mip level and under any filter or wrap mode,
is the same colour. A swatch is a pure function of the colour id, so all the
entities in a pack share one set of files. `CompiledLdrawGeometry.meshes`
(`{id, material, translucent}`) replaced `meshIds` + `canopyMeshId`; the client
entity binds `Texture.default`/`Texture.tex_N` per geometry and
`Material.blend` (`entity_alphablend`) for the translucent colours, which are
still emitted last so they draw over the opaque ones.

Offline before/after over the three gate packs (cuboids identical in all three,
which is the point — this buys memory per cuboid, not fewer cuboids):

| pack | quality | cuboids | geometries | pack bytes | entity-texture bytes | texture size |
|---|---|---|---|---|---|---|
| 71043 Hogwarts Castle | ultra | 50,057 (unchanged) | 52 -> **89** | 584,701 -> **505,857** | 320,446 -> **137,392** | 32x481 + 32x161 atlases -> 41 x **16x16** |
| 76286 Guardians' Ship | ultra | 19,950 (unchanged) | 24 -> **54** | 262,171 -> **244,583** | 252,334 -> **97,504** | -> 29 x 16x16 |
| 76435 Great Hall | balanced | 8,875 (unchanged) | 21 -> **56** | 173,295 -> **175,780** | 330,270 -> **110,886** | -> 33 x 16x16 |

- **Geometry count grows ~1.7-2.7x** (one geometry per colour, still chunked at
  `meshChunkCubes` = 1024 within a colour), and with it the render-controller
  count. Bone headers barely move (71043: 4,092 -> 4,070 — grouping by colour
  concentrates bones as much as splitting duplicates them), and headers were
  2.6 % of the bytes to begin with. **What this costs in draw calls is NOT
  covered by the A/B above**, which kept the original chunking and only rewrote
  UVs; it needs a device round.
- **Colours are provably unchanged.** `scripts/_entity_color_diff.ts` resolves the
  RGBA every cube actually samples end to end (geometry -> render controller ->
  texture -> decoded PNG texel) and diffs before against after, keyed by
  entity + bone + origin + size + rotation + pivot: **79,392 cubes over the three
  packs, 0 changed, 0 added, 0 missing.** The same pass confirms the premise the
  grouping rests on — in the BEFORE packs, **0 cubes had six faces of more than
  one colour**.
- **What box UV cannot express** is the stud-top tile, and only the square-peg
  stud fallback (`studFacets` 1) ever used it: a fanned stud's facets always
  shared one plain tile. `studTopTilesDropped` counts them in
  `craftmatic-diagnostics.json` and raises an export warning. All three packs
  report 0 (they run at 3-4 facets).
- **`DEVICE_CUBOID_BUDGET` stays at 260,000.** It is fitted to an observed
  crash; the A/B's two counters disagree by 4x on the saving (2.03 kB/cuboid by
  `nativePss`, 2.78 by `nativeAlloc`), which puts the real ceiling somewhere
  between ~288,000 and ~394,000. The export warning now says exactly that.
  Raising the constant needs the pack-stacking run repeated on box-UV packs.
- **Not converted:** the BlockGrid voxel fallback in `playable-addon.ts`
  (`geometry()`), whose cubes carry an embossed stud tile on top and a bevelled
  seam tile on the sides — two tiles box UV cannot address — and the wand's
  preview ghost, which is already one uniform tint. Both are capped well below
  the budget.

Gates: `bun run typecheck`, `bun run typecheck:web`, `bun run test`
(1,702 passing), `python scripts/_mcaddon_check.py` OK on all three rebuilt
packs. Regression tests: `test/ldraw-entity-atlas.test.ts`,
`test/ldraw-entity-compiler.test.ts` ("gives every geometry ONE colour…"),
`test/playable-addon.test.ts`, `test/playable-golden-models.test.ts`.

### Device facts this round paid for

- **`adb push` into `Android/data` does NOT truncate.** A 761-byte restore over
  the game's 850-byte `world_behavior_packs.json` left the old 89-byte tail
  behind and produced invalid JSON while still reporting "1 file pushed". Pad any
  shorter replacement to the on-device byte length (trailing whitespace is valid
  JSON), or let the game rewrite the file itself.
- **`adb push` cannot create a directory there** (`remote secure_mkdirs() failed:
  Permission denied`) and `rm` is denied, so `development_behavior_packs/` is
  unusable over adb: a pack can ONLY be installed by letting the game import an
  `.mcaddon`, and it can never be removed over adb afterwards.
- **A freshly imported pack is invisible to world loads until the app restarts.**
  The world's `world_*_packs.json` entry for it is silently dropped and the file
  rewritten with the surviving packs. force-stop + relaunch to the main menu
  FIRST, then write the pack list.
- **The game keeps rewriting a world's `world_*_packs.json` after Save & Quit**,
  so a restore written at the menu is overwritten. Restore after a force-stop +
  relaunch, then let the game write the canonical copy on the next quit — that
  came back byte-identical to the backup (md5 verified).
- **A pack manifest uuid built from a sha1 slice is not a valid UUID** (wrong
  version/variant nibbles). Use `uuid5`.
- **`dumpsys gfxinfo com.mojang.minecraftpe` is useless** — Minecraft draws into a
  SurfaceView, so HWUI recorded 3 frames in a whole session. Use
  `dumpsys SurfaceFlinger --latency "<hex> SurfaceView[com.mojang.minecraftpe/com.mojang.minecraftpe.MainActivity](BLAST)#<id>"`;
  column 2 is the actual present time in ns.
- **Enter both sends AND closes the Bedrock chat** on 1.26.51 — re-open the chat
  to screenshot a command's reply.
- Detecting "world finished loading" by screen brightness fails (a screen full of
  entities is as bright as the loading dialog). RMSE against a crop of the HUD's
  right-hand buttons is clean: ~0.00-0.11 in world, 0.15-0.58 while loading.

---

## A resident "master" part library: the coverage frontier is real, the consumer is still missing (2026-09-19, second pass)

Second audit of the proposal "install one large master add-on (behaviours + textures +
geometry for thousands of parts) once, then ship every set as a few hundred kB of assembly
instructions". The first pass (same day) priced the library on ONE number — every distinct
corpus part once, 534,354 cuboids = 2.06x the ~260,000 ceiling — and closed the question
on it. That number is right and it answers the wrong question: nobody needs every part
resident. This pass asks how many SETS a library of a given cuboid cost fully serves, what
the rest ship themselves, where the cuboids go inside a part, and — the part that actually
decides it — what on the device could draw a library part per placement. Every number
below is computed from the cached census and cost rows in `output/master-addon-audit/`
(the corpus itself was being regenerated and was not re-read); harnesses:
`scripts/corpus-part-census.ts`, `scripts/part-library-cost.ts`, `scripts/part-block-bounds.ts`
(first pass), `scripts/master-addon-frontier.ts`, `scripts/block-route-per-set.ts`,
`scripts/part-decomposition-compare.ts` (this pass), writing `frontier.json`,
`block-route-per-set.json` and `decomposition-compare-*.json` beside the inputs.

| part of the proposal | verdict | the number |
|---|---|---|
| shared behaviour/mechanism pack | **yes** (unchanged) | `placement.js` 99 % line-identical across packs; per-set behaviour payload 3.9-8.8 kB; a set's whole BP compresses to 12-29 kB |
| shared texture pack | **yes, already done** | one 16x16 swatch per colour (2026-09-19); 18.8 kB byte-identical across every pack |
| per-set assembly manifest | **yes** (unchanged) | 71043 = 133 kB raw / 47 kB gzip (22 B per placement); 10307 (25,403 placements) = 528 kB / 158 kB |
| a library that covers most sets fits the ceiling | **yes — the first pass was wrong to imply otherwise** | 7,563 parts ranked by sets-per-cuboid = 259,957 cuboids (1.00x) fully cover **7,201 / 10,169 sets (70.8 %)**; at half the ceiling the median set's residue is 71 cuboids |
| resident geometry library, drawn per placement | **still no** | a block cell holds one block and 71043 puts **3.1 placements in each cell** (9.8 % alone in theirs); per-placement entities are the measured NO-GO above; and the library IS the ceiling — the entity route ships a median set for ~3,600 cuboids |

Facts from the first pass that stand: **corpus** 4,310,010 placements over 10,169 sets
(0 parse failures), 14,278 distinct part ids (11,454 resolve offline), 66,954 (part,
colour) pairs, 66.9 % axis-aligned; concentration 80 / 394 / 820 / 1,448 / 4,024 parts cover
50 / 80 / 90 / 95 / 99 % of placements, 5,564 ids (39 %) are single-set; per set median 194
placements, 60 parts, 13 colours. **Library** at every quality: balanced 460,546 body +
73,808 stud = 534,354 (2.06x), high 1,193,897 (4.59x), ultra 2,550,577 (9.81x); per part
median 34 / p90 87 / max 128 at balanced. A set's per-part subset is 2.35x smaller than
what it places (median 1,492 vs 3,626 cuboids; 71043 9,802 vs 98,816 before culling) —
the prize an instancer would win. `tint_method` is biome tints only, so colour is never
per-instance for free. `manifest.json` `dependencies[]` and `pack_scope: "global"` exist;
no script API creates a block type, entity type or geometry at runtime.

### 1. Reconciling the numbers under review

A table circulated with "6,000 parts = 218,013 cuboids = 0.84x, 60.8 % of sets" and a
whole-library total of 472,244. Reproduced exactly: it merged only the five shard files
(10,954 rows) and missed `proto-cost-balanced.json`, the unsharded run of the **500
most-placed parts** (10,201 cuboids), and it counted each stud as 1 cuboid where a library
carries 4 (`studFacets`). Whole library: 11,454 rows = 460,546 body + 18,452 studs x 4 =
**534,354**, as the first pass said. Its coverage column was right (39.2 / 60.7 / 71.1 /
80.2 % at 4,000 / 6,000 / 7,139 / 8,514 parts is the strict definition below); its cost
column was 15-17 % low. Corrected, ranking all ids by set frequency:

| library parts | balanced cuboids (studs) | x ceiling | sets fully covered, resolvable parts | sets fully covered, strict |
|---|---|---|---|---|
| 4,000 | 154,037 (22,136) | 0.59x | 4,297 (42.3 %) | 3,900 (38.4 %) |
| 5,000 | 202,847 (28,984) | 0.78x | 5,560 (54.7 %) | 4,981 (49.0 %) |
| 6,000 | 249,874 (33,516) | 0.96x | 6,607 (65.0 %) | 5,850 (57.5 %) |
| 7,139 | 301,989 (38,852) | 1.16x | 7,658 (75.3 %) | 6,739 (66.3 %) |
| 8,514 | 364,825 (46,464) | 1.40x | 8,586 (84.4 %) | 7,510 (73.9 %) |
| 14,278 | 534,354 (73,808) | 2.06x | 10,169 (100 %) | 8,786 (86.4 %) |

Two coverage definitions, because 2,824 of the 14,278 ids resolve in no library (LSynth
hoses, submodel names, missing files — 1.76 % of placements) and **1,383 sets (13.6 %) use
at least one**: "resolvable" counts a set covered when every part that CAN render is in
the library (what a library could ever do); "strict" additionally requires no unresolved
id (what the set would look like complete). Denominator everywhere: 10,169 sets.

### 2. The frontier: selection matters, and the naive ranking is not the best one

"Maximise sets fully covered per cuboid" is a covering problem. Three selections at equal
balanced budgets, studs at 4 facets (`master-addon-frontier.ts`):

| budget | naive (by set count): parts / sets covered | ratio (sets per cuboid): parts / sets covered | greedy cheapest-set-first: parts / sets covered |
|---|---|---|---|
| 50,000 (0.19x) | 1,646 / 1,146 (11.3 %) | 2,390 / 1,687 (16.6 %) | 2,102 / **1,954 (19.2 %)** |
| 100,000 (0.38x) | 2,809 / 2,627 (25.8 %) | 3,892 / **3,011 (29.6 %)** | 3,394 / 2,978 (29.3 %) |
| 130,000 (0.50x) | 3,466 / 3,575 (35.2 %) | 4,651 / **3,936 (38.7 %)** | 4,049 / 3,484 (34.3 %) |
| 175,000 (0.67x) | 4,338 / 4,784 (47.0 %) | 5,747 / **5,270 (51.8 %)** | 5,029 / 4,476 (44.0 %) |
| 218,000 (0.84x) | 5,231 / 5,897 (58.0 %) | 6,696 / **6,316 (62.1 %)** | 5,839 / 5,129 (50.4 %) |
| 260,000 (1.00x) | 6,098 / 6,847 (67.3 %) | 7,563 / **7,201 (70.8 %)** | 6,596 / 5,850 (57.5 %) |
| 325,000 (1.25x) | 7,451 / 7,976 (78.4 %) | 8,873 / **8,323 (81.8 %)** | 7,878 / 7,306 (71.8 %) |
| 400,000 (1.54x) | 9,005 / 8,925 (87.8 %) | 10,187 / **9,204 (90.5 %)** | 9,357 / 8,779 (86.3 %) |

Sets covered are by resolvable parts; strict is 4-8 points lower throughout (260k ratio:
6,344 = 62.4 %). Ranking parts by sets-per-cuboid beats the naive ranking at every budget
from 100k up (+3.5 points at the ceiling, with 1,465 more parts for the same cuboids,
because it prefers 1-cuboid box parts over 128-cuboid sculpts). The greedy that admits
whole sets cheapest-first wins only below ~100k and is clearly worse above: it spends the
budget completing small sets that share few parts, and its residue distribution is the
worst of the three (median 706 vs 0 at 260k). The frontier is concave — the 60-70 %
point costs the whole ceiling and 90 % costs 1.5x it.

### 3. The hybrid: a set ships its own residue

A set does not need every part resident; it needs its common parts in the library and
ships the rest. Residue = cuboids of a set's resolvable parts NOT in the library, priced at
library stud cost (an upper bound: a shipped residue culls covered studs):

| library | parts / cuboids | sets with residue 0 | residue cuboids median / p75 / p90 / p99 / max | residue parts median / p90 / max | sets with residue <= 500 / <= 1,000 |
|---|---|---|---|---|---|
| naive 4,000 | 4,000 / 155,587 | 4,333 (42.6 %) | 30 / 137 / 306 / 986 / 4,269 | 1 / 6 / 53 | 95.8 % / 99.1 % |
| naive 6,000 | 6,000 / 255,171 | 6,736 (66.2 %) | 0 / 43 / 141 / 540 / 3,915 | 0 / 3 / 36 | 98.8 % / 99.8 % |
| naive 8,514 | 8,514 / 378,034 | 8,764 (86.2 %) | 0 / 0 / 40 / 259 / 3,491 | 0 / 1 / 29 | 99.8 % / 99.9 % |
| ratio @130k | 4,651 / 129,989 | 3,936 (38.7 %) | 71 / 215 / 425 / 1,223 / 4,540 | 1 / 6 / 46 | 92.6 % / 98.3 % |
| ratio @260k | 7,563 / 259,957 | 7,201 (70.8 %) | 0 / 53 / 158 / 653 / 3,990 | 0 / 2 / 33 | 98.3 % / 99.6 % |

(naive rows here use the resolvable-only ranking, hence 155,587 not 154,037.) So yes: at
4,000 parts the median set is 30 residue cuboids and 96 % of sets are under 500 — a residue
pack is a few kB. **The hybrid is the right shape for any architecture that can consume the
library**; it does not need 100 % coverage and never did. It changes nothing about §5.

### 4. Where a part's cuboids go

- **Studs are 13.8 % of a balanced library** (73,808 of 534,354; 6.2 % at high, 2.9 % at
  ultra) and they are concentrated: 2,894 of 11,454 parts have any (median 2, p90 10, max
  812), and the 479 `exact-box` parts — 1 body cuboid each, **1,538,794 placements = 35.7 %
  of the corpus** — cost 479 body + 8,412 stud cuboids, studs being 95 % of their price.
  A library cannot know exposure, but the consumer can hide it: block geometry
  `bone_visibility` takes a Molang expression per bone since 1.20.10 (learn.microsoft.com,
  `minecraft:geometry`), so a stud bone driven by a block state costs one boolean state, not
  a second geometry. That removes the DRAW, not the definition memory, which is
  definition-side (§1 of the instancing section). The cheaper stud is `studFacets` 1
  (square peg): -55,356 cuboids, 534,354 -> 478,998 (-10.4 %), and it is what box UV
  already drops the disc tile for. Not taken: the round stud is the LEGO read.
- **Coarsening is common, truncation is rare.** At balanced 1,738 parts (15.2 %) needed a
  coarser microcell to meet `maxPartCubes` 128 (1,405 once to 8 LDU, 282 twice, 51 three
  times) — they are 34,370 placements, 0.8 % of the corpus; 19 parts sit exactly at 128; 4
  are `aabb-fallback`; 52 `empty`. Sources by placements: mesh-decomposition 2,695,040
  (10,919 parts), exact-box 1,538,794 (479), aabb-fallback 11 (4), empty 114 (52).
- **The greedy merge is near its class optimum; a best-of pass buys 7-8 %.** On the same
  coarse lattice, so every candidate tiles exactly the same cells in the same colours
  (checked cell-for-cell, `decomposition-compare-*.json` `allCoverExact: true`): the other
  five axis orders save 1.4-1.6 %; largest-box-first saves 5.4-6.1 % but is WORSE on 85 of
  399 random parts; the per-part minimum of all seven candidates saves **7.4 % on 399
  random parts (15,692 -> 14,529, balanced), 8.4 % on the 69 costliest (6,907 -> 6,329),
  6.7 % at high (37,348 -> 34,833)**. Shipped as the opt-in `decomposition: 'best-of'` in
  `compilePartPrototype` (default unchanged; `test/ldraw-part-prototype.test.ts`). The
  same lever reads as QUALITY at the cap: a dome that greedy has to coarsen to 4 LDU at
  `high` (80 cuboids) fits under 256 at 2 LDU with best-of (247). Cost: largest-box-first is
  quadratic in cells — 7 s / 399 parts at balanced, 35 s at high; measure ultra on a 300-part
  set before making it the default.
- **Per-part quality by frequency is cheap at the top and expensive below it.** Re-costing
  the 260k ratio library: `high` for the 168 parts used by >= 1,000 sets adds 2,541 cuboids
  (+1.0 %) and upgrades 346,655 of 784,891 set-uses (44 %); `high` for the 1,250 parts in
  >= 100 sets adds 45,587 (+17.5 %, 87 % of set-uses); `high` for >= 10 sets adds 204k
  (1.78x); ultra/high/balanced tiers at 1,000/100 cost 1.19x. The first tier is free and
  should be the policy of any library; the second is the practical ceiling.

### 5. The consumer, re-examined — and the number that closes it

The first pass rejected the block route on a corpus-wide permutation count. Three things
it assumed are wrong or irrelevant, and one thing it did not measure is decisive.

- **Cross-pack geometry is documented.** `minecraft:geometry` "must either match an existing
  geometry identifier in any of the loaded resource packs or be one of the currently
  supported Vanilla identifiers" (learn.microsoft.com/minecraft/creator, Block Components
  Documentation - minecraft:geometry, updated 2026-08-25). So a master RP can declare the
  geometries and a per-set BP can declare blocks that reference them. Not device-tested.
- **The 65,536 cap is per WORLD, counts permutations, and is a warning.** "A cap of 65,536
  permutations that all blocks on a map can generate has been placed due to performance
  concerns. Attempting to add a resource pack with more permutations than said cap will
  result in the following warning: 'Worlds with over 65536 block permutations may degrade
  performance. Current world has XXXXXX permutations.' This warning will block marketplace
  ingestion" (learn.microsoft.com, Block Documentation - Block States and Permutations,
  2025-03-05). Permutations are the product of a block's state value counts; the community
  wiki (wiki.bedrock.dev/blocks/block-permutations) adds a hard per-BLOCK cap of 65,536
  (excess states dropped with a content-log error) — community source, not Microsoft.
  Colour and rotation do not have to be separate states: one integer "variant" state can
  enumerate exactly the (colour, rotation) pairs a set uses, with `minecraft:transformation`
  per permutation ("rotation in increments of 90 degrees", plus `translation` and `scale`,
  format 1.19.80+) and `minecraft:material_instances` per permutation for the swatch.
- **Per set the count is small** (`block-route-per-set.ts`, on the two cached full
  manifests): 71043 needs **659** permutations (309 parts, 42 colours, 24 aligned rotations;
  2,197 aligned placements), 10307 **1,632** (259 parts, 31 colours; 13,530 aligned). Baking
  the origin's 1/16-block offset into the variant via `translation` raises those to 1,802 and
  10,403. From the census, the median set's upper bound min(aligned, parts x colours x 24) is
  107 (p90 681, max 13,530). The corpus-wide 208,074 / 1.6 M figures of the first pass are
  what a single pack of every set would declare, and nothing proposes that. **The cap is not
  the blocker.**
- **What blocks cannot do is unchanged**: the 30x30x30 px bound ("Your block is limited to
  30x30x30 pixels in size … at least 1 pixel … within the 16x16x16 block unit",
  wiki.bedrock.dev/blocks/block-components) is 100 LDU at minifig scale and excludes 13 % of
  corpus placements (89.6 % / 89.5 % of 71043 / 10307 fit); 33.1 % of corpus placements are
  not axis-aligned (71043: 63.2 %, 10307: 46.7 %; per set the aligned share is median 82 %,
  p10 11 %, and only 2,829 sets are 100 % aligned). Those would stay on the entity path.
- **The decisive number is block-cell occupancy, which the first pass never measured.** A
  block cell holds one block. At minifig scale (1 block = 53.33 LDU = 2.67 studs) the
  placements of 71043 fall into 1,903 cells at **3.14 per cell, max 22, and only 9.8 % of
  placements are alone in theirs**; restricted to the aligned-and-fitting subset it is still
  3.01 per cell (11 % alone). 10307: 2.90 per cell, 9.9 % alone (aligned-and-fitting 2.37,
  16.2 %). Halving the model (1 block = 106.67 LDU, so 98 % of parts fit the bound) makes it
  10.6 per cell with 1.2 % alone; doubling it (26.67 LDU, only 71 % fit) still leaves 1.37 per
  cell with 52 % alone. LEGO parts sit 8-20 LDU apart; a block cell is 53. **No scale exists
  at which most placements get a cell of their own**, so "one part = one block" cannot
  represent a set, and cutting a cell's worth of parts into one block is the
  `buildings=blocks` voxel path already measured at 1.01-1.07x — per-set geometry again, no
  library. Measured on two sets (the two largest); the density is a property of LEGO
  geometry, not of set size, but the median set is unmeasured.
- **Entities per placement** are closed above (40 kB Actor, 2,000 double frame time). One
  entity drawing many library geometries through many render controllers is not a
  workaround either: a render controller has no per-controller transform and animations
  address bones BY NAME, so two placements of the same part cannot be posed apart. Not
  device-tested; it fails on the format, not on a measurement.
- **And the library is the ceiling.** Its cuboids are definition-side memory (~3.08 kB each,
  §1 of the instancing section — measured on entity geometry; that block geometry costs the
  same is an ASSUMPTION, the format and loader are shared but it was not measured). A 130k
  library is half the device's add-on budget before a set is placed; a 260k one is all of it.
  The entity route ships a median set for **3,625 cuboids** before culling
  (`analysis.json`, `per_set_placed_cuboids`), 71043 for 48,093: the resident library is
  36-72x the median set's device memory and 2.7-5.4x the castle's, and it would still need a
  consumer that does not exist. What a library saves is bytes over the wire and the
  import-a-pack-per-set UX (a pack can only be installed by importing an `.mcaddon` and is
  invisible to worlds until an app restart, "Device facts" above); what it costs is memory,
  which is the scarce thing.

### Verdict

The first pass's headline was the wrong measurement and its "2.06x" should not be quoted
as the reason: **a 7,563-part library fits the ceiling and fully covers 70.8 % of sets, and a
hybrid needs far less** (§2, §3). The proposal still does not ship because nothing on the
device can draw a resident part per placement: entities are the measured NO-GO, and blocks
fail on occupancy (3.1 placements per cell) before the cap (per-world, 659 permutations for
71043) or the bound (13 %) come into it — and a library that fits the ceiling is the
ceiling. Keep the shared BP/RP split (yes), the per-set manifest (yes) and the per-part
levers, which apply to the entity path today: `decomposition: 'best-of'` (-7 %), `high` for
the top-168 parts (+1 %), and box UV (-34 % memory per cuboid, shipped). Re-open only if
Bedrock ships per-placement geometry instancing (a geometry reference inside a geometry, or
a per-render-controller transform) or a multi-block cell.

### Not verified here

- Block-geometry definition memory per cuboid (assumed equal to entity geometry's 3.08 kB).
- Cross-pack geometry resolution and the per-world permutation warning on the Pixel (docs only).
- The median set's cell occupancy (two manifests measured; the census has no positions).
- `best-of` compile time at ultra on a full set, and its effect on `mergeAlignedCuboids`
  downstream (the per-part count is measured; the per-pack count after merging is not).
- The 1.76 % of placements whose ids resolve nowhere: absent from every architecture alike.

### The decomposition saving is a per-PACK number, and it depends on the grain

`best-of` (five extra axis orders plus a largest-box-first pass, same cells
tiled) measured **-7.4 % per PART**. That is not the number that reaches the
device: `mergeAlignedCuboids` runs over the whole model afterwards and absorbs
same-colour face-adjacent boxes across part boundaries, so a per-part win can
hand it a worse arrangement. Measured per pack with
`scripts/decomposition-pack-ab.ts` over the three golden models:

| quality | greedy | best-of | | per set |
|---|---:|---:|---:|---|
| balanced (4 LDU) | 10,828 | 10,746 | **-0.8 %** | -6.8 % / -2.3 % / **+2.0 %** |
| high (2 LDU) | 18,128 | 17,150 | **-5.4 %** | -5.3 % / -6.4 % / -4.3 %, and 7140 loses a mesh |

At a coarse grain the merge has already taken most of what `best-of` would win,
and 10300 comes out worse. So the compiler's default follows the MICROCELL —
`best-of` at 2 LDU and finer, `greedy` at 4 LDU — and an explicit
`decomposition` option overrides both. Nothing about the geometry changes
either way; only the cuboid count does.

## Device round on world 919 (2026-09-19): scale culling, collider clear, box UV cohabitation

Pixel 8 Pro, Bedrock 1.26.51, a fresh flat world with every add-on deleted
first; three packs (71043 ultra 49,833 cuboids, 76286 ultra 18,501, 76435
balanced 9,011 = 77,345 active). Evidence `output/device-919/` (REPORT.md,
HANDOFF.md, shots/, perf/).

- **Culling at scale — fixed.** With the origin pushed out of the frustum
  (pitch −40° to −45°, 74 blocks back) the hull renders in full at 100, 200,
  300 and 400 %, and at 400 % turned 30° off-axis with the fine-turn — the
  case the ender-dragon-style radius box was at risk on. No diagonal pad
  needed.
- **Collider clear — fixed.** 76435 cycled 100→150→200→300→400→25→50→75→100
  at a fixed origin; `/testforblock` reads the door gap as Air and the wall as
  `craftmatic:collider` identically before and after — no merged walls. A
  400 % place reports "100 % · done" 3.6–7.5 s after the confirm tap.
- **Three different packs together, box UV**: nativePss 1,029,199 kB, GL
  mtrack 709,736 kB, totalPss 2,108,722 kB, median frame 33.3 ms = 30 fps at
  77k active cuboids — consistent with "~150k visible hold 30". An extra
  Actor of the 49,833-cuboid castle costs ≈ 2.7 MB (1,029,199 → 1,028,447 →
  1,034,615 kB over +2), the definition-side share again.
- `DEVICE_CUBOID_BUDGET` stays at 260,000: the stacking run that would place
  the box-UV ceiling (288k–394k) needs ~10 distinct Ultra packs and was not
  repeated.
- Traps: `/testforblock` at a known local offset beats joystick walking for a
  collider test; the wand menu's scroll position resets to the top after
  EVERY tap; screenshot coordinates are ×1.1226 to native (2244x1008); the
  Play screen's LAN-world tile appears and disappears with the host's
  broadcast and shifts every local tile one slot — read the label before each
  tap (an agent joined the wrong world this round).

## Five cost proposals measured (2026-09-19, evening)

Five proposals to cut device cost were put forward together; four were settled
against the shipped compiler output (harnesses `scripts/_probe-geo-audit.ts`,
`scripts/_probe-hull-lod.ts`; evidence `output/_probe-q-2026-09-19/`), the fifth
is the device ceiling run tracked in `TASKS-BEDROCK-ADDON.md`. Numbers are the
three golden packs as shipped (71043 ultra 48,093 shell cuboids, 76286 ultra
16,565, 76435 balanced 7,521) plus 71043 rebuilt at balanced (15,654).

| proposal | verdict | the number |
|---|---|---|
| 1. boolean boundary pass (merge flush cuboids, cull interior faces; claimed -30 to -55 %) | **not real** | same-colour merge re-run on the shipped set removes 0.00-0.03 %; a colour-blind merge 0.37-1.40 % and is forbidden by box UV; hidden faces are 8.5-18.1 % of all faces, and omitting them needs per-face UV, which costs back the 1.05 kB/cuboid box UV saved: net about +43 % memory |
| 2. LOD hull swapped by `query.distance_from_camera` (claimed hull 3-5k cuboids, -80 % drawn) | **real as an fps lever**, not a memory one | per-colour 1-block hull = 1,946 / 456 / 710 cuboids (+4.0 % of the three packs, 1.2 % of the budget); mechanism documented; expected about 2x frame rate with one set near and two far (77,345 to ~49,000 drawn cuboids on the measured frame curve) |
| 3. spawn/despawn proxies so only nearby sets exist as actors (claimed 50 sets per world) | **not real** | memory is definition-side: a second 49,833-cuboid Actor costs about 2.7 MB against ~100 MB of definitions per such pack, and every activated pack's definitions stay resident whether or not an entity exists; entities in non-ticking chunks are already neither simulated nor drawn; killing entities leaks (142 MB after 6,000) |
| 4. macro-actor decomposition (~40-50k cuboids per actor) | **already shipped** | one shell actor per set (48,093 cuboids for 71043); the other 4-11 entities are figures, seats and door leaves the game needs as actors (3.5-16.5 % of cuboids); 1,024 cubes per geometry is a renderer-safety partition, not an actor split, and Bedrock documents no per-geometry cap |
| 5. measure the box-UV ceiling by stacking packs on world 919 | **accurate; running** | the 260,000 budget came from the six-face-UV OOM; box UV saves 34 % per cuboid so the expected crossing is 288k-394k |

### 1. Hidden faces and merging: what is actually left

`cullHiddenCuboids` (`ldraw-entity-compiler.ts`) is a sampled-ring test at
`min(4, microcellLdu)` LDU: a cuboid is culled when every sample in the one-cell
ring around its AABB is occupied by an aligned OPAQUE cuboid of ANY colour, so
there is no cross-colour or cross-part blind spot. Studs are appended after the
cull and the merge and are never culled. **What it did have was a silent bailout**:
`nx*ny*nz > 40,000,000` returned an empty set, which fires on 71043 at every
quality (1511x1449x1760 LDU = 61.3 M cells at 4 LDU), so the culler had never
run on the largest golden model. Re-run at coarser cells on the shipped set: 6 LDU
culls 219 (0.46 %), 8 LDU 262 (0.54 %), 12 LDU 338 (0.70 %); 16 LDU (3 studs)
culls visible material. Fixed by coarsening to the smallest cell that fits the
budget, bounded at 12 LDU, with the choice in the diagnostics: a ~0.5 % gain,
hygiene rather than strategy.

Faces: only axis-aligned cubes can have a coplanar neighbour, and rotated-bone
cubes are 66-72 % of the castle. Hidden faces are 29.8 / 28.1 / 34.0 / 28.8 %
of axis-aligned faces and **8.5 / 8.8 / 11.7 / 18.1 % of ALL faces** (71043 ultra
/ 71043 balanced / 76286 / 76435); adding rotated cubes' AABBs as occluders moves
that at most 0.7 points. Cubes fully enclosed on six faces but shipped: 14 / 17 /
0 / 3. Cubes strictly inside one larger cube: 211 / 225 / 220 / 153 (0.4-2.0 %,
part interiors, not studs). Every cube-level lever together is at most ~1.1 %.

Omitting a face needs the per-face UV object form (schema `minecraft:geometry`
1.21.0: "Omitting a face will cause that face to not get drawn"). Emitted bytes
for 71043 ultra: box UV 3,409 kB, six-face 13,930 kB, per-face with hidden faces
omitted 13,038 kB. Bytes are not memory (pretty vs minified: 0.4 %), so the
decisive figure is the device one: box UV saves 1.05 kB of the 3.08 kB per
cuboid; per-face UV pays it back, and the omitted 0.51 faces per cube save at
most ~0.17 kB even crediting the whole remaining 2.03 kB to face data. Break-even
needs at least 52 % of faces hidden; the ceiling is 8.5-18.1 %. The one place
omission could matter is GL mtrack (709 MB at 77k active = 9.2 kB/cuboid of GPU
memory, at most 8.5 % = ~60 MB): unmeasured, and not the nativePss OOM ceiling
either way.

### 2. LOD hull: what it is and what it must prove on the device

Mechanism (documented): a render controller's `geometry` accepts a Molang
expression returning one resource. Mojang's own example is
`"geometry": "query.is_sheared ? geometry.sheared : geometry.woolly"`
(bedrock.dev Molang, doc build 1.26.50.4), and `arrays.geometries` with
`"geometry": "Array.geos[expr]"`, `index = max(0, expr) % size`, is in the Learn
schema `render_controller.v1.8.0` (sheep example). One geometry per controller;
there is no "draw nothing", so the full-detail controllers switch to a shared
EMPTY geometry at distance and the hull controllers do the inverse. Bedrock has
no LOD feature of its own (`conditional_bandwidth_optimization` is packet
throttling; `visible_bounds_*` is a frustum box). `query.distance_from_camera`
("distance of the root of this entity from the camera", Learn 2026-01-08) has
UNDOCUMENTED units and undocumented validity inside a render controller; it
carries neither the client-only nor the server-only tag.

Hull sizes on the block cell (surface voxels, greedy-merged): 1-block
single-colour 573 / 185 / 215 (1.2 / 1.1 / 2.9 %), per-colour 1,946 / 456 / 710
(4.0 / 2.8 / 9.4 %), 2-block per-colour 756 / 242 / 282. Per-colour is the
default because box UV binds one colour per geometry; a single hull geometry
would draw the castle as one flat colour. The proposal's 3-5k was 5-10x too high:
the castle is 30x29x34 blocks at minifig scale.

Cost/benefit: memory +3,112 cuboids for all three golden packs (+4.0 %, 1.2 % of
the budget, ~6.3 MB) because both geometries stay resident; neither a memory
lever nor a memory cost. fps on the world-919 scene (77,345 active = 33.3 ms
measured): one set near + two far draws ~49,259, which lands on the measured
one-shell datapoint (16.7 ms, 60 fps); all three far draws 3,112. That is an
inference from the measured frame curve, not a device number. Shipped as
`lod: 'hull'` (default `'none'`; nothing changes until the device round passes).
The device must settle: (1) the far view actually shows the hull (the query
resolves in a render controller), (2) near/far frame time against 33.3 ms with
all three placed, (3) the switch distance in blocks (the query's units), and
(4) that ~117 controllers per entity (77 today) do not cost more in draw calls
than the hull saves; the box-UV round left the draw-call effect of controller
count unmeasured.

### 3. Spawn/despawn proxies: why the premise fails

The claim is that with marker blocks spawning the heavy actor only when a player
is near, "only the 2 or 3 sets in the player's vicinity exist in native memory".
Every number in this guide says the opposite: the pack's cost is definition-side
(a second Actor of the 49,833-cuboid castle costs about 2.7 MB against ~100 MB
for its definitions; 93 % of the instancing cost was definition-side),
definitions of every activated pack load with the world whether or not an entity
is summoned, entities outside ticking chunks are already neither simulated nor
drawn (`/testfor` cannot even see them), and actor churn leaks (142 MB not
returned after killing 6,000). A world with 50 large sets activated is 50 packs
of definitions: the cuboid budget is a sum over ACTIVATED packs, not over
summoned entities. Nothing to build.

## The buried-cuboid culler had never run on the largest model (2026-09-19)

`cullHiddenCuboids` allocates a dense `Uint8Array` occupancy grid and used to
**return an empty set** whenever `nx·ny·nz` exceeded 40 M cells — silently, with
nothing in the diagnostics. 71043 at ultra needs 61.3 M cells at its 4 LDU
occupancy cell, so the cull had never run on it at ultra OR at balanced.

- Fix: `cullHiddenCuboidsWithinBudget` coarsens the occupancy cell up
  `CULL_CELL_LADDER` = 4, 6, 8, 12 LDU to the finest cell that fits
  `CULL_GRID_CELL_BUDGET` (40 M), and only skips when even 12 LDU does not.
  **The ladder stops at 12 deliberately**: measured on 71043 ultra
  (`scripts/_probe-geo-audit.ts`), 6 LDU culls 219 cuboids (0.46 %), 8 LDU 262,
  12 LDU 338 — and **16 LDU culls visible material** (three exposed studs).
  A coarser occupancy cell is strictly more conservative in the ring test, so
  coarsening cannot over-cull relative to the requested cell; a model that
  already fits keeps its cell and its exact previous result.
- Everything lands in the diagnostics: `hiddenCull { cellLdu,
  requestedCellLdu, gridCells, coarsened, skipped }` per entity, and a skip
  also raises an export warning.
- Measured on 71043 at ultra (`output/_probe-q-2026-09-19/71043-ultra-cullfix.mcaddon`,
  same invocation as `output/device-919/build-71043.log`): the shell's occupancy
  cell coarsens 4 → 6 LDU (18.3 M cells), `hiddenCubesCulled` 0 → **165**, shell
  cuboids **48,093 → 47,936 (−0.33 %)**, pack 49,833 → 49,676, archive 505,416 →
  504,758 bytes. The net is under the probe's 0.46 % because the probe counted on
  the SHIPPED cube set (studs included, after the merge) while the compiler culls
  before studs and before `mergeAlignedCuboids`.
- Regression tests: `test/ldraw-entity-compiler.test.ts` (fits-keeps-its-cell,
  forced coarsening still culls the enclosed cube, skip only past 12 LDU, and
  the diagnostics field).

## Opt-in per-colour LOD hull, switched by camera distance (2026-09-19)

`engine/bedrock-lod-hull.ts` + `lod: 'none' | 'hull'` / `lodDistance` on
`buildPlayableAddon` (threaded through `runSchemPipeline`; CLI
`--lod=hull [--lod-distance=N]`). **Default `none`, and nothing shipped changes
until a device round settles the mechanism** — the UI does not offer it yet.

- **It cannot save memory, and must not be sold as if it could.** Add-on cost is
  DEFINITION-side (`DEVICE_CUBOID_BUDGET`), so both geometries stay resident
  whatever the camera does: the hull is *extra* cuboids and is counted in
  `pack.cuboids` / `pack.lodCuboids`. What it can buy is draw and vertex work at
  distance, and that is exactly what is not yet measured.
- **Per colour, not one colour.** Box UV means one geometry carries one colour,
  so keeping the model's colours at distance means one hull geometry per colour.
  Measured at a 1-block cell: 71043 ultra 1,944 cuboids over 39 colours (4.1 %
  of the shell), 76286 492 over 18 (3.0 %), 76435 724 over 29 (9.6 %). A
  single-colour hull is ~3x cheaper (the probe measured 573/185/215) and renders
  the set as one flat blob — a regression, not an LOD. Each hull geometry binds
  the colour's EXISTING 16x16 swatch, so no new textures.
- **Built from the FINAL emitted cube list**, i.e. from the geometry document
  itself (after cull, merge and studs): every cube reduced to its world AABB
  (bone-chain and per-cube rotations applied), voxelised on the block cell,
  reduced to surface voxels (a solid cell with an empty 6-neighbour) and
  greedy-merged. The rasteriser is HALF-OPEN on the max face — treating it as
  closed makes a 1x1x1 block fill 2x2x2 and one colour's hull paints over its
  neighbour's skin (the throwaway probe had that inflation, which is why its
  71043 number was 1,946 and the shipped one is 1,944).
- **The switch is the documented `arrays.geometries` mechanism**: every
  controller gets `arrays.geometries {"Array.g": ["Geometry.mesh_N",
  "Geometry.empty"]}` and `"geometry": "Array.g[query.distance_from_camera <op> D]"`
  — `>` for the full-detail controllers (far → empty), `<=` for the hull ones.
  Index is `max(0, expr) % size`, so a boolean picks element 0 or 1. One shared
  empty geometry (a single bone, NO cubes — the format accepts that) is declared
  once per pack and bound as `empty` in each LOD client entity. Doc URLs are
  cited in `meshControllers`.
- **`query.distance_from_camera`'s UNIT IS UNDOCUMENTED**, and so is whether the
  query is evaluated inside a render controller's `geometry` field at all
  (Mojang's example there is `query.is_sheared`). That is stated in the code, in
  the export warning and in the `lod.note` of `craftmatic-diagnostics.json`.
  **Device round pending**: `output/device-919/lod/packs.md` has the three packs
  (71043/76286/76435, `_mcaddon_check.py` 3/3), their uuids — unchanged, keyed on
  the model; the **version** bumps from the build clock, `[2, 691, …]` vs the
  device's `[2, 690, …]`, which is what makes the re-import activatable — and the
  exact three measurements: (1) does the far view show the hull, (2) frame time
  near vs far against the 33.3 ms / 77k-cuboid world-919 baseline, (3) the switch
  distance in blocks, which calibrates the query's unit. If (1) shows no change
  at any distance, the approach is dead and the option should be removed rather
  than tuned.
- Figures are never hulled (already clamped to a few hundred cuboids, and the
  player stands beside them); the BlockGrid voxel fallback and the wand ghost are
  not hulled either.
- Tests: `test/bedrock-lod-hull.test.ts` — the greedy over a 3x3x3 solid (26
  surface cells in exactly 6 boxes), per-colour grouping with a buried cell,
  cell-size scaling, the empty geometry, and through a real pack: default `none`
  leaves the controllers/geometry/diagnostics exactly as they were, `hull` adds
  the file, declares one empty geometry, inverts the index expression, and the
  pack's cuboid budget counts the hull.
