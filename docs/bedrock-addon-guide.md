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
  - Tests: `test/bedrock-placement-size.test.ts` (size groups, collider runs, 200 %
    re-lay geometry, refusal, aim-follow, 15° turn) beside the runtime/ghost tests.
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

