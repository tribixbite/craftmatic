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
  NEW version. Verified 2026-09-21: the command can report delivery to the
  existing top-most Minecraft activity; establish import success by reading the
  new behavior/resource pack manifests and their matching dependency UUIDs, not
  from the `am start` exit status alone. For ADB taps, use raw screenshot
  coordinates, not the tool's resized display: a 2244×1008 landscape capture
  viewed at 1600×719 needs coordinates multiplied by 2244/1600. `wm size`
  may still report portrait 1008×2244; that is not the active input frame.
  Activate packs by editing the world's `world_*_packs.json` ONLY
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
- **The grid frame is LDraw turned half a turn about X (since 2026-09-22).**
  The voxelizer maps LDraw (x, y, z) to cells (x, −y, −z): LDraw and
  Minecraft are both right-handed, so that is the proper rotation between
  them (det +1), and the model's −Z front lands at grid +Z (south). Until
  2026-09-22 the grid was (x, −y, z) — a MIRROR — so every block export was
  the model's mirror image, and the shell used the point reflection −I as
  its LDraw→render matrix purely to land on that mirrored grid. That
  compensation is gone: the shell is now compiled like a vehicle whose nose
  is LDraw −Z (`SHELL_FRAME = ldrawToRenderRotation('-z')`, det +1); the
  world at yaw 0 sees render (−x, y, −z) (`extraPlacement`, Pixel-proven),
  which composes to exactly (x, −y, −z) — the grid's frame. Its actor stands
  at `sceneGridPoint(frame, originLdu)` with yaw 0 and turns with the wand
  like every actor. The full change and what it invalidated on the device:
  "The grid was a mirror" (2026-09-22) at the end of this guide.
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
  added to `CAR_WORDS` so their sets read as vehicles. A genuine LDraw door leaf is
  measured in the exported grid for both a one-block width and two-block headroom.
  If a supported wand step (100–400%) reaches both, the Brick Wand offers that exact
  “Use door size …%” action and lays a rotated Bedrock door permutation after the
  resized colliders; it does not claim a door above 400%. A leaf whose threshold is
  at any supported threshold is partitioned by exact `SceneDoor.brick` identity out of the monolithic
  shell and compiled as a separate static leaf actor on the same source/grid frame.
  `PlacementActor.maxSizeExclusive` keeps that authentic leaf below its measured
  threshold and hides it above only when the vanilla replacement was installed;
  failed support/clearance checks keep the authentic leaf visible and report the
  reason instead of leaving a hole. At 100% the actor hides only when `applySceneDoors`
  recorded that exact source door as hung. Re-placing at 100% restores the leaf,
  while the normal placement history removes the prior actor on resize and Undo.
  Leaves that still cannot meet both dimensions at 400% remain part of the shell and
  are not falsely advertised as interactive.
  Retain a candidate's fractional model-local floor until `worldPoint` scales it;
  quantize only in world space. Flooring 1.8 before 300% incorrectly places the
  door at 3 blocks instead of 5 (physical edge 5.4). A source and serialized-runtime
  regression pin this upper-storey case.
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
    share keeps min lo / max hi, 400 blocks per tick), leaving doors/lights out except
    measured semantic door leaves that are re-hung with Bedrock `BlockPermutation`
    states at their offered size; a
    coloured-block export refuses a resized place with a message (entities-only sizing
    is still offered). Undo restores the boxes. Brick-built furniture is intentionally
    not guessed from arbitrary geometry: packs offer **Add seat here** only when the
    player marks a chair surface at their feet. Up to 12 model-local anchors are
    deduplicated, persisted per player across script reloads, rotated/scaled with the
    placement, and removable via **Manage marked seats**.
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
budget, bounded at 12 LDU, with the choice in the diagnostics: measured −0.33 % on 71043 ultra (165 culled,
the compiler culls before studs and merging, so less than the probe): hygiene rather than strategy.

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

### The box-UV ceiling run: 487,856 cuboids survived, no crash found (2026-09-19)

`output/device-919/ceiling/CEILING.md`, `packs.md`. 14 more distinct Ultra packs
(10278, 10297, 75827, 10307, 10255, 71040, 10305, 10256, 10276, 10294, 10272,
21058, 10318, 42115; 10,109-54,849 cuboids each) were activated in world 919 on
top of the three installed ones, in eight steps, with three sets placed
throughout and nothing from the new packs placed:

| step | packs | cuboids | nativePss | totalPss | GL mtrack | median frame |
|---|---:|---:|---:|---:|---:|---:|
| 0 | 3 | 77,345 | 969 MB | 1.76 GB | 415 MB | 16.68 ms |
| 2 | 9 | 246,385 | 1.31 GB | 2.26 GB | 405 MB | 16.68 ms |
| 3 | 10 | 283,319 | 1.60 GB | 2.37 GB | 400 MB | 16.68 ms |
| 5 | 12 | 374,978 | 1.86 GB | 2.58 GB | 387 MB | 16.69 ms |
| 8 | 17 | **487,856** | **2.21 GB** | **2.99 GB** | 392 MB | 16.73 ms |

- No bad_alloc, no low-memory kill, no ANR at any step; 60 fps throughout
  (the new packs' entities were never summoned, so this is the DEFINITION
  side only). nativePss slope 2.4-2.7 kB per cuboid: the on-device
  confirmation of the box-UV A/B. GL mtrack did not move (nothing new drawn).
- The run stopped for lack of prepared packs, not device stress, so the true
  box-UV ceiling is ABOVE 487,856 and unmeasured. `DEVICE_CUBOID_BUDGET` is now
  **480,000**, the highest observed survival, and the warning text says so
  ("past the highest sum measured to survive", not "likely to crash").
- The old six-face-UV crash (bad_alloc at 281k, 1.58 GB native) is therefore
  not a native-heap total limit either: 2.21 GB of box-UV definitions load.
  What it was is unknown; do not quote 260k for anything any more.
- Drawn cuboids remain a separate limit (~50-100k visible hold 60 fps,
  ~150k hold 30); the budget expresses resident definitions only.
- **Milano 76286-v2 (mast fix): PASS at 100 %** — the v2 ship rests its gear
  on the ground (`ceiling/shots/milano-v2-100-view.jpg`); 400 % not tested.
- Traps: **`adb push` does not truncate a shorter target** — reverting a 137-line
  `world_*_packs.json` to 18 lines left the old tail after the new `]`; run
  `adb shell "echo -n '' > <path>"` before pushing a shorter file. A cosmetic
  dark overlay stuck to one screen position appeared after the Milano version
  swap and survived Save & Quit; not investigated. The 14 new packs remain
  installed on the phone, active in no world.

### The LOD hull shipped broken for two days (user report 2026-09-21)

A user placed 10303 and called the result "horrendous… even up close", with
surfaces that "jitter between different colors in a seizure-inducing spasm".
Both causes were in the LOD, and both are the kind that a host test cannot see.

**`query.distance_from_camera` measures to the entity ROOT, and a shell's root
is not inside the model.** `originAboveModel` spawns the actor
`ceil(height)+1` blocks ABOVE the build, with the geometry hanging below it, so
for 10303 the root sits 45 blocks over the ground track. Measured on the
shipped hull: **68.7 % of the skin (2,190 of 3,189 cells) was already past the
32-block threshold**, so any ground-level camera saw the hull at ANY distance —
the user's point-blank screenshot is a blob. A bare distance constant cannot be
right across a minifig and a 44-block tower: the switch is now
`lodDistance + the entity's reach from its root` (`buildLodHull` returns
`extentBlocks`/`radiusBlocks`, rotation-aware), which guarantees the camera is
at least `lodDistance` from every cube. The default rose 32 -> 96: at Bedrock's
70 degree FOV on the Pixel's 1344-px screen a block covers 960/D px, so at 32 a
brick face was 11 px in plain sight, and at 96 it is 3.75 px. 10303 switches at
146.3. Diagnostics now report `radiusBlocks` and `switchDistance` per entity.

**A per-colour hull must give each cell ONE owner.** The rasteriser ran each
colour's mask independently, so a skin cell touched by several colours got a
full-cell cube from each — **1,523 of 3,189 cells carried 2 to 9 cubes**, since
a block is 53 LDU and a brick 20. Coplanar faces of different colours are the
diagonal hatching, and which one wins flips with camera motion: that is the
"seizure" flicker. A cell now belongs to the colour with the most clipped cube
volume in it, ties to the earlier draw order. Every cell is single-claimant and
the hull got CHEAPER: 1,143 -> 753 cuboids, 28 -> 22 colour geometries.

Consequence worth weighing: for a large set the hull now draws only past ~146
blocks, and entities have been seen drawn at 128 on the Pixel, so it may never
appear while still costing ~753 resident cuboids. `lod: 'none'` is the switch if
a pack should not pay for it.

### LOD hull verified on the Pixel; default ON at the pipeline (2026-09-19, night)

`output/device-919/lod/LOD-RESULT.md`, `shots/`. The three LOD packs (same uuids,
version bumped) replaced the installed ones in world 919:

- **The query resolves in a render controller's `geometry` field and its unit
  is blocks.** Camera walked out from the Hogwarts/Great Hall origin in 4-block
  steps with `/camera … free`: full detail through 26 blocks, the flat
  per-colour hull from 28 blocks, hull at every distance to 128. The default
  `lodDistance` 32 measures 26-28 because the query reads from the entity root
  and the camera sits ahead of the player; left at 32.
- **Frame time**: near (~12 blocks, full detail) median 16.68 ms but mean 21.25
  and p90 33.37 ms; far (~92 blocks, all hulls) median/mean/p90 all ~16.7 ms.
  In this scene the hull removes the spikes rather than moving the median (the
  three placed sets were already under the 60 fps band); the "2x in a
  multi-set world" figure remains an inference from the frame curve. Memory did
  not move with distance (975 vs 961 MB nativePss): a render-cost lever only.
- Content log: zero errors or warnings with the LOD packs loaded.
- Consequence: `runSchemPipeline` and `_playable_ref.ts` now default to
  `lod: 'hull'`; `buildPlayableAddon` itself keeps `none` as its default so the
  bare-form unit tests and golden packs stay pinned, and `--lod=none` ships the
  pre-LOD bytes. The client entity declares one `empty` geometry with no
  controller of its own. Not exposed in the UI (a per-export toggle is a
  memory-for-frame-time trade of +3-10 % cuboids per entity).

### Device round 2026-09-20: LOD on five sets, chalet collision height, Milano at 400 % (evidence `output/device-919/round-2026-09-20/REPORT.md`)

- **LOD on a five-set row** (Milano, Hogwarts, Great Hall, Titanic 10294,
  Colosseum 10276; 179k non-LOD / 185k LOD active cuboids): hull confirmed
  at distance on a second scene, nativePss unchanged by distance (definition-
  side again), and every perf row 16.7 ms median. That is NOT a null result
  for LOD: the sets landed 66–108 blocks apart, so no camera position had more
  than one full-detail set in range. The 09-19 spike (mean 21.25 / p90 33.37
  ms) needed three full-detail sets inside 32 blocks; that crowded A/B is
  still unrepeated. Taj Mahal was dropped: duplicate wands in the hotbar made
  its slot unidentifiable — grant each wand fresh via `/function` before use.
- **Chalet figures, `collision_box.height` 1.8 vs 0.95** (`--figure-collision-
  height`, 910004, fresh flat world, ~6 min dwell each): 0 of 7 moved at 1.8,
  **1 of 7 at 0.95**. A real but weak signal; six stay stuck, so a global cut
  is not the mechanism. Next: per-figure height from the interior clearance.
- **Milano 76286-v2 at 400 %: FAIL** — the gear hangs with a visible gap
  (`shots/186-milano400-under.jpg`). The grounding held at 100 % only. Root
  cause found and fixed offline the same day (next subsection); evidence and
  the device procedure in `GROUNDING.md`.
- Traps: `/camera` far from loaded chunks fails silently and renders black
  silhouettes (teleport the player instead); the transport dropped before
  nearly every wand-menu tap this round.

### Crowded LOD follow-up (2026-09-20; evidence `output/corpus-improvements-2026-09-20/device/REPORT.md`)

The crowded distance transition was measured with one Hogwarts 71043, one Milano
76286 and one Great Hall 76435 main actor in the same isolated scene. All three
roots were 20–25 blocks from the near camera: **71,884 full-detail cuboids**
gave 16.72 ms median / 24.74 mean / 33.40 p90 over 62 frames. The identical
actors from an 80-block camera drew **3,160 hull cuboids** and held 16.67 /
16.67 / 16.74 ms. Active definitions were 80,210 cuboids in both views;
nativePss was 426 vs 416 MB and GL mtrack 362.5 vs 361.8 MB. This is **not a
controlled LOD performance A/B**: distance changes screen coverage, and 62
frames is a short sample. Keep the same-camera full-versus-hull gate open;
do not attribute the observed frame-time difference to LOD alone or infer a
memory effect. The chalet repeat was aborted before world load
after repeated wireless-ADB chat-input drops, so the previous 0/7 vs 1/7 result
remains the only evidence. Both worlds' pack JSON was restored and SHA-256
verified; the app was returned to its starting Play screen.

For the controlled repeat, no production feature is missing: export the same
source/label/options twice with `--lod=hull --lod-distance=1024` (full at the
fixed near camera) and `--lod=hull --lod-distance=1` (hull at that same camera).
Both packs retain the same full and hull geometry, so residency is held fixed.
`test/bedrock-lod-hull.test.ts` checks equal geometry, entities, scripts, pack
cuboid counts and UUIDs; controller thresholds are the intended difference.
Select the correct generated pack version explicitly and verify its diagnostics
after each switch. Use identical actor positions/camera, warm up, then collect
longer alternating full/hull samples (e.g. ≥30 seconds each, several repeats).
Record thermal/load conditions and actor counts; restore exact original pack
JSON afterward. This fixture test prepares the experiment, not a device pass.

### The wand's size factor multiplied a constant lift (fixed 2026-09-20; device PASS at 100/200/400 %)

Evidence: `output/device-919/round-2026-09-20/GROUNDING.md`; the device check
`GROUNDING-RESULT.md` — `76286-v3` placed at one pin at 100, 200 and 400 %,
gear tips on the grass in all three shots (`shots/g-100-under.jpg`,
`g-200-under.jpg`, `under-400-approach.jpg`, pixel-sampled leg-to-grass with no
sky between), and the 100 % ghost now starts at ground level.

Every actor coordinate a pack ships is scaled about the pin by the wand's size
factor (`worldPoint`: `anchor + p × f`), so each one has to be a measurement
INSIDE the model — a height above the model's own floor plane, which is the
same `anchor.y` the structure tiles, the collider grid and the ghost stand on.
The component actor's Y defaulted to a **constant 1 block**, which is not such
a height, so `f` multiplied it and the model floated `f` blocks over the pin:
1 at 100 %, **4 at 400 %**. Only an aircraft shows it — `kind === 'plane'`
ships `has_gravity: false` with hover movement/navigation, so nothing pulls it
back down; a car or a boat falls the difference away. The default applied
exactly when the component covers the whole source model (`schem-pipeline.ts`
pushes it with no x/y/z), i.e. every vehicle-only export.

Fix: one helper, `componentSpawnPoint` (`engine/playable-addon.ts`), used by
the actor, the extras' `primaryPos`, the preview points and the ghost, with
Y defaulting to **0** — the model's own floor. A component inside a larger
scene keeps the floor height the pipeline gives it, which IS a real height in
the model and scales correctly. Measured on the built packs (actor Y +
geometry floor, both × f): 76286 goes from `0.25/0.5/0.75/1/1.5/2/3/4` blocks
over the pin at 25…400 % to **0 at every step**. The same +1 shifted the ghost
preview up a block and pushed its top row out of the scene bounds
(`sceneOccupancy` marks at `c.y + y`): the Milano's ghost was 1..13 blocks and
is now 0..13.

What was NOT wrong, each re-checked rather than assumed: the render frame
already grounds a model on its lowest cuboid (`floorY = all.min[1]`, so the
shipped `.geo.json` has `minY = 0`); the building shell's origin lift cancels
because the geometry is authored `−lift` and the actor spawned `+lift`, both
scaled; the collider grid grows up from the pin (`wy0 = (y + lo/16) × f`);
`minecraft:scale` pivots on the entity origin; and `modelScale` rescales the
cell and the units-per-LDU together, so `modelScale × f` still multiplies a
zero. Guarded by `test/bedrock-placement-grounding.test.ts` (6 tests through
the serialized runtime; 3 fail on the pre-fix code, 3 pin the halves that were
already right).

### 21060 access measurement (2026-09-21, offline only)

The selected `DbixConvV3/21060.ldr` has no recognized semantic door leaves.
At export scale 4× its collider archive contains 30,084 occupied cells in a
108×40×55 footprint. The corrected supported-two-high-cell traversal reaches
1,768 cells from the exterior, including the raised front approach at
`y=5,z=3,x=34…63` and further terraces. Evidence and reproducible reader:
`output/pipeline-2026-09-21/21060-access/{analyze.ts,result.json}`.
An earlier palette-decoding error counted every grid cell as solid; discard
that result. This proves a stepped approach exists, not that an interior door
works. Do not advertise “400% working doors” for this source until an actual
opening and interactive-door placement are verified in game. The current
semantic-door recommendation correctly abstains; explicit marked seats still
work independently of door recognition.

### Measured coaster runtime (2026-09-21, acceptance in progress)

`coaster-path.ts` validates explicit sampled routes, rejects oversized or
zero-length segments, and joins only mutually unique compatible endpoints.
`bedrock-coaster.ts` packages an added grey ride cart; it does not replace the
source's LEGO cars. Each cart stores the model origin, rotation, size and route
index through the normal placement lifecycle. Movement preserves distance on
failed teleports or unloaded chunks, stops without a rider, and restores its
saved progress after script reload. Undo/re-place removes the cart.

**Device-proved on 10303 (2026-09-21):** the cart spawned, climbed the measured
track from y 66 to y 100 on a build spanning y 63-107, dwelled at the far end
and retraced it, carried its rider 377 s unbroken, logged zero Actor/Molang/
Scripting errors across the session, and Undo removed both cart and shell. Two
things that run did NOT establish: whether the cart MODEL pitches and rolls
through the loop (the chase camera clips inside the shell and an unmounted cart
does not move, so there is no side-on view), and the touch "interact to ride"
path — on a dense set the cart sits inside the shell with no reachable prompt,
so boarding used `/ride`. Both are open items in `TASKS-BEDROCK-ADDON.md`.

Closed paths circulate; open paths pause and reverse at their actual ends.
Boarding has a two-second delay and sneak dismounts. Cart geometry, collision
and seat scale with both export scale and wand size. Parallel-transport track
frames animate cart pitch and roll, including inverted loops. The nine-cuboid
cart uses the measured 60-LDU wheel gauge and rail-top contact datum. This does
not promise upside-down player roll or a physical train
simulation. Rider retention during actual Bedrock movement is a separate
device gate, not established by host-script tests or successful pack import.

#### A `float` actor property needs a FLOAT LITERAL in the JSON (2026-09-21)

Bedrock types an actor property's `default`/`range` numbers by their **literal
form**, not by the declared `type`. `JSON.stringify(0)` writes `0`, and the game
then rejects the property:

```
[Actor][error]-… craftmatic:coaster_qa_coaster_cart | minecraft:entity | description |
  Error loading property 'craftmatic:track_pitch': 'default' value does not match the specified type 'float'
[Actor][error]-… | Error loading Actor Properties
```

One bad property drops the **whole** property component, so the failure surfaces
far from its cause: the client's `query.property(...)` animation errors on every
frame (`query.property called on an actor without a property component`) and the
server's `Entity.setProperty` throws inside the movement tick, which the ride
runtime catches, warns about and untracks — the cart stops after one step. The
in-game symptom is a generic "Coaster paused" message with no mention of JSON.

`web/src/engine/bedrock-json.ts` wraps such values in `bedrockFloat()` and the
pack serializer restores them as bare `0.0` / `-90.0` literals; `int`, `bool` and
`enum` properties are safe as plain numbers (the creator wand's are). Covered by
a byte-level test on the emitted entity file in `test/bedrock-coaster.test.ts`.

Read the device **content log**, not logcat, for this class of fault: Bedrock
writes nothing about it to logcat. The log lives in
`/sdcard/Android/data/com.mojang.minecraftpe/files/games/com.mojang/logs/`
(newest file by mtime, tens of MB — grep it on-device).

**Gate a device round on `grep -cE '\[Molang\]\[error\]'`.** The three quiet
`[Actor][error]` lines at load are easy to miss; the same defect also produced
**348,797** `query.property called on an actor without a property component`
lines — one distinct message at ~60/s for two hours — and that single number
catches the whole class (dropped property component, typo'd property name,
property queried on the wrong entity). A clean pack reads 0.

#### An entity identifier may not begin with a digit (2026-09-21)

`craftmatic:10303loop_10303_coaster_cart` is refused outright —
`ERROR: Invalid entity identifier …, identifier cannot begin with a number` —
and the entity then does not exist: the wand places the build and reports
`1 entity could not be spawned`, and `/testfor @e[type=…]` is a *syntax* error
rather than "no targets matched". **Most LEGO set stems are numeric**, so this
silently removed the ride cart and marked seats of essentially every set while
shells, figures and previews (which carried a `b_`/`f_`/`p_` prefix) were fine.

Every entity id now goes through `entityId(raw, prefix)` in `playable-addon.ts`.
The rule is also in `scripts/_mcaddon_check.py`, so it fails offline: five
separate inline copies of the same test is how the two newest entities missed
it, and a convention that is not enforced by a gate is not a convention.

Other device facts from that round: **the content log can stop growing while
the app runs** (it died at 34,893,824 bytes and never rotated, so a world load
produced on-screen error toasts and nothing on disk) — force-stop and relaunch
to start a fresh log before trusting a zero count. `input tap`/`input swipe`
are unreliable on Bedrock's UI where `input motionevent DOWN/UP` works; the
chat field drops and reorders characters from `input text`, so type one
character at a time and insert the leading `/` LAST (typing it first opens
command autocomplete, which steals focus). A 16,904-cuboid shell actor is not
drawn at all from ~69 blocks away — stay within ~35 blocks for screenshots.

#### Bedrock culls an actor by its COLLISION BOX, not its visible bounds (2026-09-22)

A device round photographed 10303 in full detail at 60 blocks and **completely
absent** at 70, 86, 100 and 168 — the model popped out of existence. It was not
the LOD, not frustum culling (the shell declares `visible_bounds` of 177 x 189
blocks, so a camera 70 out is well inside it) and not simulation distance (the
player never left the model's own ticking chunks).

It is Bedrock's per-actor render cull, which scales with
`minecraft:collision_box` — and a brick shell declared **0.1 x 0.1**. Three
observations fit `cull = 64 x max(1, box diagonal)` blocks: the 0.1-box shell
stops at ~64, the 0.6 x 1.8 figures were still drawn at 100 and gone by 168, and
the guide's earlier "drawn at 128" was the Milano, not a shell. The 64-per-unit
constant is Java's `shouldRenderAtSqrDistance` rule; Bedrock's counterpart is
undocumented, so treat the fit as measured-not-documented.

Two consequences. The shell's box is now a needle sized for four times the
model's largest dimension, so 10303 draws to 176 blocks instead of 64, and the
size groups scale it (a 25 % placement would otherwise cull at 16). And the LOD
hull is the SAME actor, so it culls at the same distance: a switch past the cull
can never be reached. `planLodSwitch` derives the switch from the entity's own
cull and SKIPS the hull when nothing fits, rather than shipping geometry no
camera can see — for a while 10303 was carrying 760 such cuboids.

#### Bedrock's form renderer deletes a bare `%` (2026-09-22)

The wand's size button rendered `100%` as `100`, and the walk-through reason
lost every sign: "at 100 ;", "reaches 5  of the model's height". Mojang's own
`en_US.lang` escapes a literal percent as `%%` (`options.percent.format=%s%%`),
but nothing here confirms a script FORM honours that escape, and a visible `%%`
would be worse than the loss — so in-game strings spell "percent" while
`craftmatic-diagnostics.json` keeps the measured `%`. A device round can try
`%%` on one string; if it renders, `bedrockInGameText()` is the only change.

#### A same-UUID pack upgrade needs the ACTIVE FOLDER overwritten (2026-09-21)

Deterministic manifest UUIDs make a rebuilt pack upgrade in place — but each
import creates a NEW folder (`Name—`, `Name—(1)`, `Name—(2)`), and Bedrock
resolves a world's pack by UUID to the folder its own store already associates
with it. Editing `world_behavior_packs.json` / `world_resource_packs.json` to
pin the new version is silently reverted on world load; Edit World → Behavior
Packs → "Technical details" kept reporting the OLD version at the original
folder path, and a reload produced fresh `[Actor][error]` lines from the stale
copy — so a passing import and an activated pack proved nothing.

What works: confirm the old and new folders have identical file lists, back up
every file with its SHA256, then copy the new content OVER the active folder
on-device and verify with `md5sum`. Check the version by reading the ACTIVE
folder's `manifest.json`, never the newest folder's.

**Deactivating and re-activating the pack in the UI does NOT clear it** — the
store keeps the uuid pinned to the folder it first saw, and the Available list
exposes no Technical details link, so no folder can be chosen from the UI.
Three more traps found overwriting a pack whose files had been RENAMED:

- `adb push` cannot create a directory under `Android/data` **and still reports
  "1 file pushed"**. Sha256-verify every pushed file; a new `texts/` directory
  silently did not land.
- Push does not truncate, so a file that shrank keeps its old tail. Pad the new
  content to at least the old length (or write it elsewhere and copy on-device).
- `rm` is denied there, so stale files from the previous build cannot be
  removed — and a stale entity definition still loads and re-raises its errors.
  Write the new content into the OLD filenames: Bedrock keys on the
  `identifier` field in the JSON, not on the path.

`/ride @s start_riding @e[type=…,c=1]` boards deterministically and does
exercise a pack's ride runtime (Bedrock selectors use `c=1`, not `limit=1`), and
`/camera @s set minecraft:third_person` works while riding. It is not a
substitute for testing the touch interact path.

Profile extraction must use the mould's rail endpoint/axis, not merely stud or
sleeper origins. In 10303 those frames can differ by 32 LDU, producing false
45-LDU gaps after rotation. A visually closed source model does not authorize
nearest-endpoint shortcuts. Keep unresolved connections explicit until mesh
measurements and route-overlay views agree; current acceptance is recorded in
`TASKS-BEDROCK-ADDON.md`.

`coaster-track.ts` supports ten measured track moulds, including source-embedded
80564 geometry. It requires compatible endpoint tangents, mutual unique joins,
and available render geometry; it never bridges a missing piece. In 10303 the
main 29-fragment course includes all six repaired loop sections. A geometrically
verified opposed vertical 25061 pair is treated as one composite running curve.
Vertical guide-only chains and isolated decorative moulds do not spawn carts.
The tower transfer remains a TODO: the main course shuttles at its real ends,
not a fabricated closed circuit. This mechanism also applies to other sets
using supported moulds; unsupported track shapes remain explicit gaps.

### The set's own cars are the ride, and its own lift closes the circuit (2026-09-22)

The fabricated grey cart is now the fallback, not the ride. Where
`detectCoasterAssemblies` (`coaster-assemblies.ts`, `ab2aebf9`) finds ride cars
on a route, `coasterRoutesFromAssemblies` (`bedrock-coaster.ts`) hands the pack
those cars, their posed riders and the set's lift, and `schem-pipeline.ts` takes
every one of their bricks out of the static shell, so nothing is drawn twice.
The rules are data, never set-specific:

- **Car → entity.** Each car's bricks are re-expressed in a canonical frame
  (`canonicalCoasterCar`: travel +X, up -Y, the running datum at the origin; a
  det -1 Studio frame is made proper by flipping local Z) and compiled with
  `ldrawToRenderRotation('+x')` and `originLdu [0,0,0]`, so the entity origin is
  the point the runtime puts on the track and the car sits its measured
  `originAboveDatum` above the rails. Every root bone is re-parented under
  `track_pitch` → `track_roll` (`wrapTrackBones`), the same pitch/roll bones
  the cart had. **One entity type per distinct car body** (`planCoasterVehicles`
  keys on part+colour+pose of the body bricks); cars with the same body share
  the definition and are instanced per car.
- **Riders ride along.** A car's posed rider is compiled INTO the car as a
  `rider_<k>` rig bone (one variant per distinct rider on that body), selected
  per instance by the `craftmatic:rider` int property and hidden while a player
  has the seat (`craftmatic:occupied` bool; the track animation scales the
  bone to 0). The player's seat is the rider's measured hips joint through the
  compiler's own seated-eye rule (`RIDER_EYE_ABOVE_HIPS_LDU` 55 = torso 44 +
  eye 11, then `SEATED_EYE_HEIGHT_BLOCKS`), so the player sits where the figure
  sat. The rider's figure parts also leave the NPC list (10261's riders sit
  upright in the station and would have wandered off).
- **Heading is authored.** A car's nose keeps its measured heading along the
  route (`cars.heading` ±1); the fabricated cart keeps facing its motion
  (`heading` 0). A shuttle with real cars therefore runs backwards on the
  return leg instead of spinning every car round at the dead end.
- **Platform lift = the route plus the deck.** On an open route with a platform
  lift the runtime path is the route with the deck's own running line
  appended at BOTH terminals: the deck at its parked pose before arc 0 and,
  translated by the measured travel, after the far end (`coasterRuntimeConfig`;
  a lift docked at the `end` terminal reverses the route first, so every lift
  route reads the same way, direction -1 toward the deck). Both docks are
  SNAPPED onto their terminals; 10303's authored pose sits 30.2 LDU above and
  15.2 short of the station terminal, and the deck's 27-LDU tilt rise means the
  travel that meets both terminals is **1,884.9 LDU** (1,857.8 terminal-to-
  terminal, 1,854.6 authored), 22.8 LDU off vertical (0.7°). The physics, the
  brake and the frames need no special case: the train rolls off the course
  onto the deck, brakes to its centre, the platform entity (the deck's 55
  bricks, compiled like a shell at yaw 0) and its counterweight (the strays
  riding the tower guides parallel to the hoist within
  `COUNTERWEIGHT_LATERAL_MAX_LDU`, moving opposite) translate at
  `PLATFORM_SPEED` 2.5 blocks/s carrying the cars, the arc is re-based onto the
  delivered deck (`arc + total - deckLength`) and the train departs down the
  course. The platform returns once the train has cleared the deck; a train
  arriving before it is back holds at the terminal. Holding guarantees are the
  cart's: an unloaded chunk or a refused teleport under the hoist holds
  progress; a removed platform lets the cars proceed; Undo retires everything.
- **Chain lift = the assist, confined.** A measured chain drive sets the
  circuit's direction (the way it climbs) and confines the existing chain assist
  to its arc span (`route.chain`); elsewhere a climb is on momentum down to the
  0.8 floor. No entity is needed. A set with no detected drive keeps the assist
  on every climb, as device-proved.
- **A siding stays parked.** An open route shorter than `PARKED_SIDING_FACTOR`
  (2) train lengths holding a train is display, not a ride: no route is
  emitted for it and its bricks stay in the shell (10261's 480-LDU siding with
  a 394-LDU train).
- **Fallback unchanged.** A route with no detected car keeps the rider-measured
  train and the fabricated cart, byte-for-byte the device-proved behaviour
  (`rideHost` suite, 49 tests unchanged).

Measured on the two sets (`bun --preload <scratch>/preload.ts scripts/_playable_ref.ts`,
the tree's `playable-addon.ts` served patched; the patch is in the report):

| | 10303 Loop Coaster | 10261 Roller Coaster |
|---|---|---|
| Route | open, 8,930.5 LDU + deck ×2 = **181.6 blocks** (1,044 samples) | closed, **244.7 blocks** (1,713 samples) |
| Cars | 3 × `26021` at 2.25 blocks, heading -1, 3 body types (bodies differ), 1 rider each | 3 × `26021c01` at 2.363 blocks, heading +1, 3 types, 1 rider each; 3 more parked on Track 2 |
| Lift | platform: deck 7.06 blocks, travel (-0.43, 35.34, 0.005), 390 cuboids + 2,351-cuboid counterweight | chain over arcs 2.39–31.7 blocks (7 drive parts), direction +1 |
| Station | stop 20.29 (was 13.23 + the 7.06 deck) | stop 219.41 (unchanged) |
| Cuboids | cart 0; vehicles 6,719; pack 57,579 / 14 entities (was 50,765 / 10) | cart 0; vehicles 4,922; pack 54,538 / 12 entities (was 52,750 / 13: three rider NPCs gone) |
| Host cycle (`scratch/sim/sim-lift.ts` on the built pack's own `coaster.js`) | station dwell → deck stop at arc 3.53 → 14 s hoist → delivered at 178.07 → course → station, 1,112 ticks per lap; counterweight 102.5 → 67.2 while the platform 65.8 → 101.1; cars 2.03–2.25 apart; rider kept through the lift | circulates, chain holds 2.5 on the hill, max 7.5 blocks/s, cars 2.14–2.36 apart |

Both packs pass `scripts/_mcaddon_check.py`. `coaster-track.ts` now strips a
leading `<set> - ` from embedded part stems, so the OMR `10261-1.mpd` (parts
named `10261 - 25061.dat`) extracts its track at all.

**Not verified on the device** (host-simulated only): the compiled cars' pitch
and roll SIGN through the loop (the same convention as the cart, itself never
seen side-on), the rider bone actually hiding under `scale: 0.0`, the seat
height inside the tub at 0.3 blocks (the compiler's clamp), and the platform
carrying a player visibly (a rider is retained through the lift on the host).

### Ride polish after the first rides (2026-09-22): speed, wheelbase, track ups, the rider inside the loop, two trains

The user rode both sets ("nearly flawless" / "nearly perfect") and reported
four things; every one was measured on the host before it was touched, in
`bedrock-coaster.ts` only (`output/bedrock-entity-qa/coaster-polish-2026-09-22/
sim-ride.ts` runs a pack's own `coaster.js` and prints the numbers below).

- **"Friction too high" was the sample-spacing ceiling**, not friction: the
  per-tick arc step was clamped to one authored sample (7.5 blocks/s on 10303).
  A tick is now integrated in SUBSTEPS no longer than a sample spacing, each
  sampling the grade where the train is, so the polyline bounds the step and
  the physics bounds the speed (`MAX_SPEED` 12 → 16, `ROLLING` 0.15 → 0.12,
  `DRAG` 0.012 → 0.008). Drops: 10303 peak 8.9 → **16.0**, mean 7.3 → 10.2
  blocks/s; 10261 peak 7.5 → **13.0**, mean 5.7 → 7.7.
- **Cars see-sawed because each pitched on the local tangent.** A car now
  pitches on the CHORD between its wheel contacts (`wheelbase`: 50 LDU on the
  26021 base — the 24869 wheels measured at ±25 on 10303, and the same figure
  from `26021c01.dat` for 10261's composite chassis via `CHASSIS_WHEELBASE_LDU`,
  because a shortcut part exposes no wheel to measure). Adjacent-car pitch
  difference: 10303 worst 66 → 38°, median 7.3 → 2.1°; 10261 worst 55 → 39°,
  over 20° on 11.2 → 6.9 % of car-pair ticks. What is left is real: the loops
  (r ≈ 3.7 blocks; two cars 2.25 apart differ by 35° there) and the
  fragment-join jogs in the extracted polyline (10261 arc 79-81 climbs 1 block
  in 0.5 of run, 64° for one chord length) — those belong to
  `coaster-track.ts`, not to the runtime. Coupling needs no extra constraint:
  cars are already a fixed arc apart, so the chord fix is the coupling.
- **"Rotated wrong at the top of the elevator" was parallel transport.** The
  helical loops have torsion; the minimum-twist frame left the cars 61-84° on
  their side from the first loop onward and delivered them to the top deck
  rolled **−117°** (the sim's hand-off row: roll 0.0 → −117.2 on the delivery
  tick), unwinding only back down through the loops. `coasterTrackUps` twists
  each transported up toward the physical up — gravity's where the track is
  within 60° of upright (LEGO track is never banked), the smoothed curve
  normal when banked further inside a vertical curve tighter than 8 blocks
  with its centre on the car's up side (a loop, never a crest) — at most
  20°/block. 10303's upright twist is now ≤ 20° (in the loop exits) and the
  hand-off is 0.0/0.0; 10261 is unchanged at 0°. A first attempt that used the
  curve normal on ANY vertical bend rolled 10261's dips by 11° from the
  polyline's join noise — the 60° gate is what stops that.
- **The rider left the loop** because a Bedrock seat is a fixed offset in the
  entity's yaw-only frame: inverted, it put the player 1.55 blocks ABOVE the
  rails. The runtime now places the ENTITY where the rider's head belongs
  (seat and 1.25-block eye carried through the car's real pitch and roll, less
  the upright eye) and draws the body back onto the rails through three synced
  float properties `craftmatic:body_x/y/z` on the root `track_pitch` bone's
  `position` (model units, entity frame: X mirrored, −Z forward). Eye at both
  10303 apexes: **−1.57 blocks below the rails** (inside), 0.25 lateral, never
  higher than −0.50 through an inversion. On upright track all three offsets
  are exactly 0, so nothing device-proved moves; on a climb the entity (and
  its hit box) sits behind and below the bricks by the eye's tilt.
  **Not device-verified:** that Bedrock applies an animated root-bone
  `position` in the geometry's own axis convention (the derivation is in
  `coasterRuntime`); if the drawn body sits off the rails in a loop or on the
  vertical drop, that sign is the first suspect.
- **Two trains.** A route with the set's own cars runs `COASTER_TRAINS` = 2:
  the second waits at a block point one train length + 0.5 behind the
  platform (10303 arc 27.5, 10261 arc 211.8 — both inside the level station
  run) and departs once the first is half a lap ahead; a train returning to an
  occupied platform holds there. 10261's second train IS the siding's three
  cars (Track 2, 1.9 blocks from the circuit; they leave the shell). **10303
  has only three cars, so its second train is a second copy of them.** The
  hoist is one per placement (`hoists`, owner = the train on it), so the
  second train waits at the terminal while the platform returns. Host cycle:
  10303 T1 departs t100, T2 t725 (T1 at 50.0 %), then alternately every 741
  ticks; 10261 T2 departs at 50.0 %, then every 795 ticks; never both on the
  platform, never closer than the gap.

Unchanged and still device-proved by construction: riderless running, the
station brake and dwell, the boarding hold, the tap prompt, chunk holds,
refused-teleport holds, Undo retirement and the property ranges (three new
float properties, all clamped). Pre-existing and untouched: the roll bone
snaps where the track passes vertical (the yaw/pitch/roll decomposition has no
yaw there; 256°/block at 10303 arc 95 in both the old and new packs).

### The second-loop swivel and the crawl over the top (2026-09-24)

Device report: "first upside-down swivel fixed but still occurs during second
upside-down loop" (10303) and "all coasters are about 50 % too slow — you
creep to nearly stopped during upside-down loops". Both measured on the host
first, by running each pack's own `coaster.js` (and the new runtime over the
same CONFIG) tick by tick.

**Swivel — two causes, one per stage.** The runtime took the car's yaw from
its NOSE azimuth while "upright" (`up.y >= 0` and horizontal > 0.2) and held
it once inverted. A LEGO loop is a helix, and 10303's second loop enters with
the track also turning sideways, so as the nose steepened its azimuth swung
toward the lateral component: the yaw went 0 → 28 → 69 degrees in the last
ticks before the hold (up to 53 in one tick), was held at 69 through the
loop, and came back on the exit — a **101-degree** swivel of the rider, whose
camera turns with the entity's yaw. The first loop enters square, which is
why the 2026-09-23 hold fixed it and not this one.
- `coasterCarAttitude` (shared by the pack, serialized like
  `sampleCoasterPath`, and the add-on preview) now takes the yaw from the
  heading of the car's AXLE (`nose × up`), which is horizontal through any
  loop and turns only as the track really turns. No hold, no threshold on
  the nose, no memory of which loop it is. Fallback (a car on its side) is
  the script's own last yaw, not `getRotation()`.
- That exposed the second cause: `coasterTrackUps` aimed the up at gravity's
  up until 60 degrees of bank, and gravity projected off a steep, sideways-
  leaning tangent leans with it — 48 degrees off the loop's plane at pitches
  60-77 on the second loop, which still swung the axle yaw 43 degrees. Inside
  a loop-tight vertical curve the up now follows the loop normal from 37
  degrees of pitch (`LOOP_STEEP_LEVEL` 0.8; 0.5 left a 19-degree swing).

Yaw range over each inversion ±3 blocks (host, riderless, three cars):

| 10303 | before | after |
|---|---|---|
| loop 1 (arc 110 → 98) | 0 | 11.9-12.5 (the helix's own lean) |
| loop 2 (arc 74 → 63) | **89-105**, up to 53 in one tick | 8.7-10.0, ≤ 7.6 per tick |

Pinned by `bedrock-coaster.test.ts` ("turns over through BOTH loops…" on the
corpus 10303, a synthetic two-helix course, and the attitude unit test) and
`coaster-preview.test.ts`. The one residual blip is a 5-degree, one-tick jog
at loop 1's apex where the extracted polyline steps sideways at a fragment
join — track data, not the runtime.

**Speed — a ceiling, not gravity.** 10303's drop hit the old 16 blocks/s
ceiling, which discards energy for good, so the train reached its first loop
at 4.6 blocks/s and was carried over the top by the chain assist at 2.5
blocks/s (sqrt(g r) there is 6.2). Everything else was simply real-gravity
slow for toy radii (3.7-block loops). Three changes, `COASTER_PHYSICS`:
- `COASTER_RIDE_PACE` 1.6: every speed × 1.6, every acceleration × 2.56
  (gravity, rolling loss, chain accel, station brake), drag unchanged — the
  same ride, the same energy, played back faster. Dwell ticks unchanged.
  **Superseded 2026-09-25:** 1.6 rode "a touch TOO fast"; the pace is now √2
  (g = 2 g = 19.6) with `MAX_SPEED` = 20 × pace. The reason, the gravity audit
  of every physics model and the host numbers: `docs/physics-architecture.md`.
- `MAX_SPEED` 16 → 32.
- An inversion floor: through an inversion the train keeps
  `INVERSION_MARGIN` (1.3) × sqrt(g r) × sqrt(−up.y), zero at vertical so it
  never kicks. r is `coasterLoopRadius` (median radius over the inverted
  samples, 3.93 blocks on 10303), carried as `route.loopRadius`. On the four
  sets it never binds; it is the guarantee.

Host numbers (mean moving speed, laps include the 5 s station dwell):

| set | max b/s | mean moving b/s | lap s | min speed over a loop top |
|---|---|---|---|---|
| 10303 | 16.0 → 32.0 | 5.78 → 11.75 | 45.2 → 28.9 | 2.51 / 8.26 → 14.6 / 17.0 (sqrt(g r) 9.9) |
| 10261 | 13.1 → 20.9 | 4.39 → 7.08 | 80.3 → 50.4 | no inversion |
| 42703 | 9.6 → 15.3 | 2.98 → 4.84 | 33.5 → 22.1 | no inversion |
| 76417 | 10.1 → 16.2 | 3.40 → 5.56 | 43.6 → 30.9 (shuttle cycle) | no inversion |

**Not device-verified:** that the rider feels no swivel (the camera follows
entity yaw — the premise of the fix), that 32 blocks/s teleports read
smoothly on the Pixel, and that the faster hoist (4 blocks/s) carries a rider
visibly. Old packs keep their old physics: CONFIG carries it, so the change
needs a rebuilt pack.

### The rider's camera follows the track (2026-09-24, measured on the Pixel)

User request: the rider's baseline view should be what a real rider sees,
following the track "including the upside down loops", while the player can
still look around. Until now a rider had their own first person, upright, with
the yaw turning with the car.

**What Bedrock offers (researched, then measured on Minecraft 26.51 / script
runtime `@minecraft/server` 2.10.0, world 924 with NO experiments):**

| API | Rotation it takes | Measured |
|---|---|---|
| `Camera.setCamera('minecraft:free', {location, rotation: {x, y}, easeOptions})` | `CameraSetRotOptions.rotation` is a `Vector2`: yaw and pitch, no roll | Pitch outside ±90 **throws** "Pitch (x rot) is outside accepted range of [-90, 90]" |
| `Camera.playAnimation(spline, {animation: {progressKeyFrames, rotationKeyFrames}})` (stable since 2.6.0 / 1.26.10) | `RotationKeyFrame.rotation` is a `Vector3`; **z is roll** | One held animation of `{x: 0, y: 0, z: 90}` turns the horizon vertical (ground on the LEFT: +z rolls the view left); z 180 draws the world upside down |
| same | keyframes | Refused unless more than 0.05 s apart ("Time between rotation frames must be greater than 0.05"); a two-point `LinearSpline` is refused ("Linear needs at least 2 control points") whether its points are 0.01 or 1 block apart — three points play |
| same, re-issued | chaining | A new animation issued while one is playing moves the camera but its rotation is **never drawn** (0.1 s every tick, 0.15 s and 0.12 s every 2 ticks: level horizon throughout). Back-to-back animations that each finish do roll, but the camera **reverts to the player's own view** in any gap and after the last one (flashes seen at 2-tick / 0.1 s spacing) |
| `Camera.attachToEntity` | follows an entity locator | not needed once `clamp` worked; not measured |

Sources: `@minecraft/server@2.9.0` and `@2.12.0-beta` typings from unpkg
(`CameraSetRotOptions`, `RotationKeyFrame`, `SplineAnimation`); Microsoft Learn
"Animating with the Free Camera Script API" and "1.26.10 Update Notes" (splines
and attach-to-entity released in 2.6.0); minecraft.wiki `/camera` history. No
source documents roll; the z meaning and every limit above are device facts.

**So a true upside-down view is possible in stable only as a single camera
animation, and cannot be sustained tick by tick.** A pre-computed animation
covering a whole inversion (the physics is deterministic) is the one untested
route to real roll; its unknowns are how spline progress maps to time and how
the camera leaves it without a flash. `# TODO` if the user wants roll badly
enough to spend a device round on it.

**What shipped first: `clamp` (superseded 2026-09-25 by `loop`, below).** Each tick
the runtime puts a free camera at the rider's eye in the seat (the seat and the
seated eye height carried through the car's real frame — the same point the
entity placement already computes) looking exactly along the car's nose (the
wheel chord, facing its authored heading), eased over 0.1 s. It pitches with
every climb and drop and follows every curve; through a loop the view pitches
up to vertical and, because the pitch cannot pass 90, the image turns over
(yaw +180) spread over ~4 ticks at 40°/tick instead of snapping. It cannot
draw the world upside down at the apex (the rider looks back along the track
with the sky up). Host numbers on 10303: exact along the nose on every tick but
13 per lap (the turn-overs), where it lags by up to 34° while the view is
41-83° from level.

**Look-around.** The player's own head turn, measured against the car, is a
clamped offset applied in the car's frame (±70 yaw, ±50 pitch;
`coasterRiderLook`). Three device facts shape it:
- `setRotation` cannot recentre the pitch (known), so the reference is where
  the head was when boarding, re-taken for the first **10 ticks**: Bedrock turns
  a new rider to the seat a few ticks after mounting (a 65° offset appeared
  without the settle).
- The yaw Bedrock reports for a rider is the CLIENT's, which turns the rider
  with its own interpolated view of the car: it trails the server's car yaw by
  **~6 ticks**. Uncompensated, the look swung -37..+55° through the fast curve
  after the lift; compared with the car's yaw 6 ticks back (`lookLag` 6) it
  stayed within 5° of the rider's real head turn.
- A ratcheting reference turned those transients into a permanent drift (0 →
  49° over one lap), so the reference never moves (`ratchet` false).

Device evidence (`output/coaster-camera-0924/device/` in the main checkout,
with the recordings `clamp1.mp4`, `clamp2.mp4`, `roll3.mp4`, `seq*.mp4`): `clamp1-loops.jpg` (lift, crest, curve, vertical drop, both loops at
4 fps), `clamp-look.jpg` (drag right → camera 70° right of the car, clamped;
drag back), `clamp2-debug.jpg` (the on-screen per-tick readout with `lag 6`),
`ab.jpg`/`24-roll90.jpg`/`25-roll180.jpg` (the roll probe), `seq-sheet*.jpg`,
`seq2-sheet.jpg` (the chaining probes), `roll3-loops0.jpg` (roll mode riding:
level horizon, the chain never drawn).

Also: the camera draws the rider's own upright body around the eye, so a rider
is made invisible while the camera is theirs (as the pinball seat); camera and
invisibility are released on dismount and kept through a paused tick. A car
standing still uses the plain eased camera in every mode.

The measurements in this section came from a `/scriptevent
craftmatic:coaster_cam` tuning hook (`mode`, `ease`, `look`, `turn`, `lag`,
`alag`, `ratchet`, a `debug` action-bar readout, a `trace` log, and the probes
`rot`, `roll`, `seq`, `loopsim`, `attach`, `clear`). It was REMOVED on
2026-09-25 once the defaults had been ridden; every value, `animLag`
included, is now a field of `COASTER_RIDER_VIEW`. To measure again, restore
the hook from history (search the log of `bedrock-coaster.ts` for
`coaster_cam`). The walk preview rides with the same
functions (drag = head turn) and now honours a route's fixed direction and the
cars' authored heading, which it ignored before (it ran 10303 the wrong way).

#### Round 2 (2026-09-25): no turn on the drop, a real upside-down loop

User, after riding `clamp`: "the camera view works mostly except it turns
about 90 degrees upon descent and does a strange sideways turn for the upside
down loops". Both were `clamp`'s turn-over (reproduced offline on 10303 at
pace √2, `repro-*.tsv` in `output/coaster-camera-0924/`): past vertical it
re-derived the yaw from the nose and turned it round at 40° a tick — and
10303's drop OVERHANGS past vertical (car pitch 97-103°), so the drop turned
the view too. The rider's 6-tick look-lag correction was not involved.

**Per tick, `reflect`**: the yaw is the heading of the view's own right axis
(the car's axle; continuous through any loop), the pitch is fitted to the
view's direction and up and then folded back into ±90 past vertical (a
triangle wave: 100 → 80, ±180 → 0). The view never turns round: up a loop it
pitches to the zenith and back down to level over the top, world upright.
10303 host numbers: worst yaw step 16.7°/tick (a real curve at 18 blocks/s),
none on the drop or in the loops, where `clamp` stepped 40.

**Through an inversion, one animation (`loop`, the default)**: measured on the
Pixel, a camera animation re-issued every tick draws NO rotation (only the
last, uninterrupted one does; with or without the experiment), but a single
uninterrupted animation rolls: `loopsim` (a 5-block loop in front of the
player, 2-3 s) goes up, fully upside down (grass at the top of the screen),
down and back to level (`loopsim4-flip-zoom.jpg`). Keyframe facts: `x` is the
NEGATED pitch (Microsoft's flyover sample agrees: `x: -55` looks down),
`z = +90` rolls the view left, keyframes more than 0.05 s apart. So when the
car climbs into a loop the runtime predicts the train (`planner`: the ride's
own `integrate`/`carPose`, same order, bit-exact), finds the first inverted
run (car up.y < -0.2, starting within 10 ticks) and its end (up.y > 0.3), and
sends it as one animation: eye positions resampled to equal arc steps (so
progress is the same whether the client reads alpha by arc or by point),
`roll`-mode views every 2 ticks. The per-tick camera stays silent while the
train is exactly where the plan put it and takes over, without an ease, at
the plan's end or the moment the ride leaves the plan (a held chunk, a
refused teleport). The plan stops where any brake could engage (the station,
the loading bay, the deck, the end of an open route): there the loop is
drawn by `reflect` alone. 10303: both loops, 30 and 24 ticks (1.5 s and
1.2 s), every animation played to its planned end on the host.

**The prediction is gated by cost (regression fixed 2026-09-25).** As first
shipped (`2b7e11bd`), every tick with the car pitched past 20 degrees ran an
80-tick prediction whether or not a loop existed. On 10261 (no inversions,
long steep drops) that was 117 ride substeps a tick on the drops against
2.4 on the flat (host, shipped pack `243f54b1`: 4.9 ms against 0.35 ms a
tick); on the phone the script tick overran, the ride slowed ("time slows")
and the per-tick camera stuttered. Now: `planner.near` predicts nothing
unless inverted track (a sample with up.y < 0) lies within reach of the
rider's car in 11 ticks at the fastest the train could go; a prediction
stops at tick 21 with no inversion begun, as soon as one is seen beyond tick
10, or 2 ticks after the found one ends; and a prediction that finds
nothing for `c` ticks skips the next `c − 10` ticks, which provably fail
the same way (the ride follows its own prediction or falls behind it). The
replay digests of 10261, 10303 and 42703 are bit-identical to the shipped
runtime (`bun scripts/_coaster_replay.ts <pack> --rebuild`): same camera
calls, same animations on the same ticks. Steep-tick substeps: 10261
117 → 2.4, 10303 77.5 → 7.8. Tests: "loop mode on steep track with no
inversion … predicts nothing" and "loop mode predicts only near an
inversion" count the ride's work through the `Math` the runtime sees.
Ridden on the Saga (2026-09-25, world 925, packs `37cdf61c`), with an A/B on
10261: on the shipped `243f54b1` pack the 9-second chain lift (host: 180
ticks at 3.5 blocks/s) took ~47 s of wall time, about 4 ticks a second, and
the action bar refreshed only every ~5 s; on `37cdf61c` it took 9 s. Station
dwells ran at full rate on both, so only the steep track lagged. 10303's
lift-top-to-lift-top cycle took 55 s against the host's 54, both loops still
roll, and `freezedetect` finds no frozen frame on the drop and loops. 42703's
departure cycle took 23-25 s against the host's 23. The content logs were
clean. Evidence: `output/coaster-lag-0925/device/` in the fix's worktree
(the ride videos, `*-bars*.png` action-bar strips, contact sheets).

**The "Experimental Creator Camera Features" experiment
(`experiments.experimental_creator_cameras`, set in `cmgametest` with
`scripts/_leveldat_experiments.py --creator-cameras`) changes none of this**:
`setCamera` still refuses a pitch past ±90 and per-tick animations still draw
no rotation (`c-rot.jpg`, `cmg-seq-sheet.jpg`, `cmg-seq2-sheet.jpg`). What it
adds (Microsoft Learn, minecraft.wiki "Experiments"): an over-the-shoulder
preset and `/camera play_spline` for splines written into a behaviour pack —
static paths, no use for a placed, moving ride. Nothing needs it, so the pack
does not probe for it. `attachToEntity` takes only a fixed attach point
(`EntityAttachPoint`: Eyes, Head, Body…), not a bone locator, and the car's
pitch and roll are client-side bone animations, so an attached camera cannot
inherit them; not built.

**Ridden on the Pixel (2026-09-25, pack `60565096`, world 924).** The drop
faces straight ahead (on-screen readout `cam y-90 p90 | car y-90 p90` down
the overhang), both loops roll the view (name tags at 120-150 degrees), the
per-tick camera resumes between and after them, and drag-look reaches the
±70 clamp and returns. One fix came from the ride: the client draws the
train INTERPOLATED behind the server, so an animation on the server's own
schedule ran ahead of the drawn car — at the first ride the camera sat
inside the rider of the car ahead. Keyframe k now shows the pose of tick
k − `animLag`; ridden at 1, 3 and 6 in one session, 3 matches the per-tick
view (the car ahead's rider bottom-centre), 1 is still inside that rider, 6
trails behind the train. Evidence `final-lap-lag3.jpg`, `loopride2-lag*.jpg`,
`loopride2.mp4` in `output/coaster-camera-0924/device/`.

### The ramps' running line was on two datums (2026-09-22, `coaster-track.ts`)

The residue the chord fix left — 10261 arc 79-81 climbing a block in half a
block of run, 10303 arcs 37/39/89/91/115-132 — was track data, and it was
the 80564 fault again: controls on two datums. The four ramp moulds (26559,
26560, 26561, 34738) were built from sleeper origins in the interior and
hand-added connector controls at every end, all offset a vertical 32 LDU.
Ray-cast at the tread band on Studio's meshes (`scripts` in
`output/bedrock-entity-qa/coaster-track-datum-2026-09-22/` — rail top by
vertical ray at z 29-31), every straight mould has its rail top at -17.8 and
its running line at -32: the running datum is **14.2 LDU above the rail top**
(the `measureDatumAboveRailTop` 14). The ramps' level ends matched that to
.01 LDU; every SLOPED end put the running line 3.9 LDU **below** the rail
top instead of 18.6 above it (the .9-gradient clip planes are 36-44 LDU under
the rail, not 17.8), so the whole of 26561 rode 23 LDU inside its rails and
each transition into one jogged 14-31 LDU in a few LDU of run. The interior
sleepers sit 11.5-13.8 LDU under the rail on these moulds (not 17.8), so the
middle was 2-6 LDU high as well.

All four ramps are now one datum: a literal rail-top table at 5 LDU steps
(`RAMP_RAIL_TOP`, the x = -10 tip taken on the rail line because the mesh
carries a 5 LDU end relief there) offset 14.2 LDU along the local normal
(`COASTER_RUNNING_ABOVE_RAIL_TOP_LDU`). Nothing is smoothed: the
`jogs.ts`/`seams.ts` scans find **0** chord-pitch clusters over 40°/block and
**0** vertices over 25° on either set (10303 had 6 clusters and 10 vertices,
10261 10 and 20). 10261 keeps all 43 seams (≤ 1.14 LDU). 10303's three
26559s that stand rotated 90° (`26559:1429`, `1421`, `2153`, the drop's
pull-outs) are not clip-mated: with honest tips their rails run **7.66-7.80
LDU past their neighbours' along the travel direction**, laterally within
.08 LDU, at 7.6-8.9° kinks (the modelled rails are 40.6° and 42.0°, not 45).
The stitcher admits that as an overlap (`overlapToleranceLdu`,
`COASTER_TRACK_OVERLAP_TOLERANCE_LDU` 8) and the route builder drops the
doubly measured samples the way it already dropped a matched connector, so
the route never steps backwards. The kinks are the set's geometry and stay.

Measured with the runtime owner's `sim-ride.ts` on rebuilt packs
(`coaster-track-datum-2026-09-22/sim-summary.txt`): 10303 worst adjacent-car
pitch 38.4° → **36.0°** (now the loops: two cars 2.25 blocks apart on a
3.7-block radius), and none of the named arcs remains over 20°; 10261 worst
38.8° → **26.1°** (a real valley where a descending 26559 meets its mirror),
over 20° on 6.9 % → **1.8 %** of car-pair ticks, p99 33.4° → 21.3°. Routes
are 181.14 / 243.55 blocks (were 181.6 / 244.7), stations 20.38 / 217.78,
10303's upright twist ≤ 19.6°. Composite chassis: `CoasterCar.wheelbaseLdu`
is now measured (separate wheels: the spread of their origins along the
travel axis; a shortcut: its own wheel subfile placements read through the
shared text cache, `peekDatText`) — `26021c01` measures **50 LDU** (two
24869 at x ±25), the same as `CHASSIS_WHEELBASE_LDU` assumed, which can go.

## Close-up fidelity: the budget is spent per part, where it shows (2026-09-21)

The user's report was that the capacity work "tanked" the close-up. Measured,
the four capacity commits did not touch 10303's close-up at all: its shell was
13,872 cuboids at 8 LDU on 2026-09-18 11:13 (`output/addon-verify-2026-09-18/
10303/10303.json`, before `348d9069`, `b662f354`, `ae982fac`, `d3a66020`) and
13,936 at 8 LDU after all four. Box UV changed no colour (0 of 79,392 cubes),
the cull removed 126 never-visible cuboids, the decomposition choice only
changes counts. What the close-up had been since brick-accurate buildings
shipped (`9c9f0809`, 09-16) was the `LEGO_SHELL_QUALITY` table itself:

- `balanced` = **8 LDU with a 64-cuboid part cap**. The cap coarsens exactly
  the detailed parts: 10303's track moulds 25061 / 26559 / 26560 / 80564 are
  151 / 137 / 123 / 115 cuboids at 8 LDU, so they shipped at **16 LDU**
  (41 / 40 / 37 / 37 cuboids), the coarsest thing in the set.
- `high` asked for 4 LDU under a 32,768 cap; 10303 is 37-39k there, so the
  whole model fell back to 8 LDU (`modelCoarsened: 1`) and `high` bought
  4-facet studs and nothing else.
- Whole-model coarsening doubled EVERY part's cell when the model was over
  budget by any amount.

### Fidelity versus grain, measured (10303, 298 moulds, 3,495 placements)

Six-view silhouette IoU per part against its own triangles (the entity gate's
measure, part-local), weighted by placements × silhouette area, with prototype
cuboid sums before the cull and the merge (`scratchpad` scripts of the session;
the per-part table is reproducible with `planPartGrains` + `silhouetteIoU`):

| uniform grain | cuboids | area-weighted IoU | compile (all moulds) |
|---|---:|---:|---:|
| 8 LDU | 15,128 | 0.930 | 0.5 s |
| 4 LDU | 50,863 | 0.949 | 1-5 s |
| 2 LDU | 141,866 | 0.967 | 3.5-10 s |
| 1 LDU | 315,738 | 0.977 | 68 s |

The loss at 8 LDU is concentrated: the track moulds sit at 0.71-0.75 (0.82-0.86
at 4, 0.90-0.92 at 2), Technic pins at 0.69, 2x2 round bricks at 0.92 at both 8
and 4 (only 2 LDU rounds them). 1,860 of the placements are a single cuboid at
any grain (plates, bricks, tiles) and cost nothing to keep fine.

Two policies for fitting a budget, simulated on that table from a 2 LDU start
(box parts never move; a step is the next cell with fewer cuboids):

| body budget | uniform grain | largest spender first | least IoU loss per cuboid saved |
|---:|---|---:|---:|
| 48k | 4 LDU = 0.949 | 0.949 | **0.957**, track at 2-4 LDU |
| 64k | | 0.956 | **0.960** |
| 96k | | 0.962 | **0.964** |

### What shipped

- **`planPartGrains`** (`ldraw-part-prototype.ts`): every part starts at the
  preset's microcell; while `placements × prototype cuboids` (plus unresolved
  boxes) exceeds the budget, the one part whose next useful cell loses the
  least `placements × silhouetteArea × ΔIoU` per cuboid saved is coarsened,
  never past `PLANNER_COARSEST_LDU` = 8. The compiler
  (`compileLdrawEntityGeometry`) reserves the studs' share first from a draft
  instantiation, plans, instantiates, re-measures the exposed studs on the
  planned model (the count FALLS as holes close: 10303 exposes 2,616 studs at
  2 LDU and 1,302 after the plan) and re-plans with what they gave back, up
  to three passes. Everything is in `diagnostics.grainPlan` (budget, cuboids
  and fidelity before/after, parts and placements per cell) and one warning
  names what was coarsened; `heaviestParts` carries each mould's cell.
- **Silhouette scorer** (`silhouetteReference` / `silhouetteIoU`): the gate's
  six views at ≤256 px, 1.5 px/LDU; boxes are rect-filled in the five axis
  views and three faces in the isometric. ~0.4 s for all of 10303's moulds;
  the 2 LDU compile itself (3.5-10 s, best-of) is the planner's cost.
- **Presets retuned** so microcell and budget agree, against the device
  limits (~480k resident cuboids; ~50k drawn for 60 fps, ~100k for 30):
  shells `balanced` 2 LDU / 49,152, `high` 2 / 98,304, `ultra` 2 / 163,840;
  vehicles `balanced` 2 / 24,576, `high` 2 / 49,152, `ultra` 1 / 98,304.
  `maxPartCubes` is 4,096 everywhere: a guard, no longer the fidelity dial.
  Figures still clamp to `high` (2 LDU, unchanged).

### Measured result, 10303 (`scripts/_playable_ref.ts`, 2026-09-21)

| preset | shell cuboids (studs) | pack | device share | plan fidelity | placements at 2 / 4 / 8 LDU | pipeline |
|---|---:|---:|---:|---:|---|---:|
| before (balanced, 8 LDU, cap 64) | 13,936 (3,450 @3 facets) | 16,904 | 3.5 % | 0.930 (offline) | 0 / 0 / 3,495 (track at 16) | 9 s |
| **balanced** | 44,824 (5,208 @4) | 50,765 | 10.6 %, 9 packs | 0.918 of 0.938 at full 2 LDU (scorer scale) | 2,149 / 458 / 975 | 27-29 s |
| high | 93,968 (5,984 @4) | 99,908 | 20.8 %, 4 packs | 0.934 of 0.938 | 2,726 / 364 / 492 | 39 s |
| ultra | 151,663 (10,464 @4) | 157,654 | 32.8 %, 3 packs | 0.938 (nothing coarsened) | 3,582 / 0 / 0 | 28 s |

At balanced the track moulds are at 2-4 LDU (25059, 26021 at 2; 25061, 26559,
26560, 80564 at 4), Technic holes are open, and the 975 placements left at
8 LDU are tiles, pins and 2x2 round bricks whose silhouette does not move
between 4 and 8 (333 of them are a plain box at 8 anyway). The scorer's
absolute IoU runs ~0.03 under the 512-px offline table (coarser pixels on the
big moulds); the ordering is what the plan uses. 71043 (5,936 parts) fits
balanced at 46.2k with fidelity 0.957 of 0.967 - but its 8,720 exposed studs
fall to 1 facet under the 25 % stud cap (they were OMITTED before); a set that
size wants `high`. Golden vehicles at balanced: X-wing 12,316, McLaren 6,231,
DeLorean 41,600 (as a shell), all at 2 LDU with nothing coarsened.

### Not verified here

- No device run of the new packs. Meshes per entity rise (10303 balanced 63,
  high 113, ultra 169 geometries against the 82 of the 71043 castle that ran);
  the 480k resident ceiling was measured with box UV and holds, but a 150k
  ultra set fully in view is a ~30 fps scene by the drawn-cuboid curve.
- Compile time: the 2 LDU start costs 20-30 s per 3,800-part set in bun on
  this box under contention; the web Worker will be slower. `ultra` is the
  same grain and no slower than `balanced` (fewer planning passes).
- The stud facet ladder (4 → 3 → 1) and the 25 % stud cap are unchanged;
  a 2-facet step or a stud share tied to the plan would help 71043-class sets.

## Walk-through size recommendation, measured from geometry (2026-09-21)

The user asked for an auto size suggestion so that "doors can become real
doors and a player can walk through them", and for it to reach 150-400 % on
micro-scale Architecture/Icons sets. This is now a MEASUREMENT of the model,
not a reading of its name or theme, and it is DATA (`recommendAccessScale` in
`engine/bedrock-scene-actors.ts`): a recommended step plus the numbers in a
sentence. `planAddonScale`'s `auto` is untouched and no export changes size.

**The rule.** A player needs a clear opening 1 block wide by 2 high and two
blocks of headroom (`PASSAGE_*` in `engine/addon-scale.ts` - the whole-block
quantisation of the 0.6 × 1.8 player; `JUMP_HEIGHT_BLOCKS` 1.25,
`STEP_HEIGHT_BLOCKS` 0.6). `measureSceneAccess(bricks, scene.meshes,
{ exclude: scene.figureBricks })` builds an occupancy grid of the whole model
at a 5 × 4 LDU cell aligned to world multiples (half-stud × half-plate, so an
axis-aligned opening measures exactly; a plate-sized cell under-read a 104 LDU
doorway by a cell and pushed it from 100 % to 150 %), part boxes for ordinary
parts and a three-axis ray-parity solid fill for moulds with a hole
(`Door|Window|Arch` descriptions), door LEAVES left out because they open.
It then measures:

1. **Openings.** Semantic door leaves by their own extent (a leaf wider than
   tall is a hatch - the Titanic's 44 1×3×1 hull doors - and never door
   evidence), and geometric APERTURES: every floor-level air run walled on both
   sides, under a lintel, at least 16 × 24 LDU, no wider than 2.5× its height
   (the gap under a car is not a doorway), that opens into a wider space or the
   outside within 100 LDU on BOTH faces. Each gets `requiredScale =
   max(1 block / width, 2 blocks / height)`.
2. **Headroom.** The median floor-to-ceiling over interior floor cells.
3. **The reach walk**, once per step (100/150/200/300/400 %): a breadth-first
   walk from the outside ring over cells that are a floor with player headroom
   and a player-wide clear run (foot, waist and head rows), moving to a
   neighbour at most one jump up. A LEGO brick riser is 0.45 blocks: a step at
   100 %, a jump at 200 %, a wall at 300 % - so a size that opens the doorways
   can lose the upper floors. The walk reports the highest floor reached per
   step against the model's top standing surface.

The recommendation: door leaves decide when present (their MEDIAN required
scale), else the aperture at the 25th percentile of required scale (the larger
openings; small gaps between furniture are the rest); rounded up to the first
step; raised to the headroom step when one exists; and if that step loses
more than a quarter of the reachable height against another step, the reason
says so and names that step ("the choice is between the doors and the
stairs") instead of choosing silently. No opening at any step, or a solid
model, is said plainly.

**Measured** (`bun scripts/_access_scale.ts <source>`; heights in blocks at 100 %):

| set | source | leaves | openings | pick at 100 % | headroom | reach 1×/1.5×/2×/3×/4× (top) | recommends |
|---|---|---|---|---|---|---|---|
| 10255 Assembly Square | IO | 13 | 274 | 1.3×2.5 | 3.8 | 0.7/1.0/0.4/0.4/0.2 (21.9) | **100 %**, 13/13 leaves clear |
| 10278 Police Station | IO | 8 | 61 | 1.3×2.5 | 2.9 | 11.6/2.6/1.9/1.4/1.6 (17.6) | **100 %**, 8/8 |
| 31141 Main Street sm01 | LDR | 5 | 86 | 1.3×2.5 | 2.3 | 0.5/0.5/0.5/0.2/0.2 (14.0) | **100 %**, 5/5 |
| 910004 Winter Chalet | IO | 3 | 43 | 1.3×2.5 | 2.1 | 5.3/5.6/5.6/4.1/0 (10.1) | **100 %**, 3/3 |
| 10303 Loop Coaster | IO | 0 | 149 | 1.7×1.5 | 2.5 | 5.4/2.0/1.7/1.5/0.2 (43.2) | **150 %** (cells coarsened to 7.5×6) |
| 71043 Hogwarts | IO | 0 | 323 | 0.6×2.3 | 1.7 | 0 at every step (31.8; the rock base is a cliff) | **200 %** |
| 76419 Hogwarts micro | DbixConvV3 | 0 | 49 | 0.8×0.9 | 3.5 | 1.5/0/0/0/0 (13.7) | **300 %** |
| 21060 Himeji | DbixConvV3 | 0 | 23 | 0.4×0.6 | 0.75 | 9.8/0.6/0.6/0/0 (9.8) | **400 %** opens 19/23 to 1.5×2.4, but the terraces are lost: "the choice is between the doors and the stairs" |
| 21034 London | IO | 0 | 12 | 0.4×5.1 | 1.2 | 5.0/3.1/1.5/1.5/0.8 (7.1) | **300 %**, same tension (21 % vs 70 % of the height) |
| 21058 Pyramid | IO | 0 | 13 | 0.4×0.9 | 0.9 | 9.5/9.5/9.5/2.4/2.4 (9.5) | **300 %**, same tension (25 % vs 100 %) |
| 21042 Statue of Liberty | IO | 0 | 81 | 0.7×0.9 | 1.4 | 0 at every step | **300 %** (the pedestal's arcade) |
| 21054 White House | IO | 0 | 0 | - | 1.4 | 0 | **none**: "No doorway found; interior floors are 1.4 blocks under the ceiling at 100 % (150 % gives standing room), but nothing leads into them" |
| 10242 Mini Cooper | IO | 0 | 9 | 0.3×0.6 | 0.7 | 1.1/0/0/0/0 (5.9) | 400 % (geometry only; `planAddonScale` says vehicle 0.38× - the UI should show the auto plan and offer this as "to walk inside") |
| 10294 Titanic | IO | 44 hatches | 373 | 1.1×0.9 | 1.9 | 1.2/1.2/0/0/0 (21.2) | 300 % |

The 21060 finding above stands: 400 % opens one-stud wall openings to
1.5 × 2.4 blocks geometrically; nothing here proves an interior door works in
game, and the walk shows the raised approach is lost at that size.

**Also in this round.** `SceneActors.groundLdu` (the model's underside) and
`sceneFloorPoint(frame, groundLdu, p)`: a figure's height must be measured up
from the pin plane the shell and colliders stand on, not from the voxel grid's
row-0 bottom, which the voxelizer's surface pass rounds up to half a cell above
a thin baseplate. The chalet's seven figures (DbixConvV3/910004.ldr, standing
on the ground beside the model, feet at LDraw y 8 = the underside) came out at
−0.15 blocks; `floorLdu` itself is exact (IO/910004.io: three figures' feet at
the tile/plate tops under them, to the LDU). Doors keep `sceneGridPoint`: they
are cut into the block grid and were device-verified.

**Not wired yet** (the pipeline, the pack diagnostics and the UI are other
agents' files): `schem-pipeline.ts` should call `measureSceneAccess` +
`recommendAccessScale` after `discoverSceneActors`, map figures and seats
through `sceneFloorPoint(frame, scene.groundLdu, …)`, and ship the
recommendation in the export result and `craftmatic-diagnostics.json`; the
settings popover's "Model scale" row and the wand's Size menu should show
`sizePct` + `reason` beside the auto plan. The measurement is ~0.1-4.6 s per
set in bun (48 M-cell budget; 71043 and 10303 coarsen to 7.5 × 6 LDU).

## The grid was a mirror; every LDraw → world frame is now the same rotation (2026-09-22, breaking)

The renderer's finding (LEGO rendering guide, "The LDraw → scene frame is a
ROTATION"): LDraw (Y down) was converted to three.js (Y up) by negating Y
alone — a reflection, det −1 — so every model rendered mirrored. The block
grid had the same reflection (`(x, −y, z)`), which is why this guide used to
say "the grid frame is a MIRROR of LDraw" and why the building shell needed
`SHELL_FRAME = −I`: a proper entity could only land on a mirrored grid through
a second reflection. The user accepted the breaking change; the whole tree
moved to the half turn about X, `(x, −y, −z)`, at once.

**What changed on the Bedrock side, and how each site now derives:**
- `sceneGridPoint` / `sceneGridVector`: `gz = −z / cellXZ` (was `+z`). Every
  actor position, route point, lift travel, screen anchor and door cell maps
  through them, so the whole scene moved to `length − z` in the grid.
- `yawForFacing`: world Z is LDraw −Z, so a figure facing LDraw −Z (the
  front) is yaw 0 (was 180) and +Z is 180; ±X keep ∓90. `componentLayout`'s
  `actorYaw` now calls it: a −Z-nosed vehicle stands at yaw 0, a +Z one at
  180, ±X unchanged. The grid-fallback geometry and the grid-derived seats
  are authored for the new yaw (the Z-axis branches swapped); the compiled
  entities need nothing, because a compiled −Z nose at yaw 0 IS the grid
  frame: world sees render `(−x, y, −z)`, render = `diag(−1,−1,1)·LDraw`,
  product `(x, −y, −z)`.
- `SHELL_FRAME` is `ldrawToRenderRotation('-z')` (det +1) — the −I
  compensation is deleted, and the shell, the lift platform and the
  counterweight (all compiled through it at yaw 0) land on the new grid.
- Door hinges: `SceneDoor.hingeAtMin` is measured in LDraw; along Z the
  grid runs the other way, so `applySceneDoors` and `runtimeDoorCandidates`
  read the hinge through `hingeAtGridMin`. Along X nothing changed.
- `block-shapes.ts` stairs: an LDraw +Z rise faces north (was south); the
  legacy `ldraw-voxelizer.ts` slope/wedge/corner/bracket masks read their Z
  direction against `gzMin`/`gzMax` the other way round; `bridgePartContacts`
  and the fallback AABB negate Z like Y.
- Java `display-entities.ts`: `cz = midZ − z` and the quaternion is the
  conjugation by `diag(1, −1, −1)` (a yaw about LDraw's down-pointing Y is the
  opposite yaw about Minecraft's up; a roll about X keeps its sign).
- `extraPlacement`, the entity JSON's X mirror, the car/figure compile frames
  (`ldrawToRenderRotation`), the canonical coaster car frame, the runtime's
  yaw/pitch/roll and `body_x/y/z` maths are all entity- or world-frame and
  did not move. Vehicles and figures keep their Pixel-proven chirality.
- Every Bedrock export's notes now open with `FRAME_CHANGE_NOTE`
  (`bedrock-export-notes.ts`) and `craftmatic-provenance.json` carries
  `frame: "x180"` (`pipeline-version.ts`); a pack without it is mirrored.

**Measured on the two coaster packs (`scripts/_playable_ref.ts`, the
published `IOModel2V2/*.ldr`, before → after):**
- 10303: route 181.1417 → **181.1417** blocks, station stop 20.3778 →
  **20.3778**, station length 26.6365 → 26.6365; shell 44,953 → **44,902**
  cuboids, lift 390 → 390, counterweight 2,351 → 2,346, vehicle cuboids
  6,719 → 6,714, pack 57,579 → 57,553. Station point z 9.34 → 10.66, lift
  parked z 6.14 → 13.86, counterweight z 12.39 → 7.61, lift travel z 0.005 →
  −0.005 (all `length − z`, the mirror undone).
- 10261: route 243.5521 → **243.5521**, station 217.7820 → **217.7820**,
  station length 26.0035 → 26.0035; shell 42,121 → **42,123**, vehicle
  cuboids 8,050 → 8,050, pack 56,293 → 56,286, colliders 5,268 → 5,268.
  Station point z 1.62 → 19.38.
- The route lengths and station arcs did NOT move, and that is the correct
  outcome, not a missed site: the track extraction and the assemblies work
  in LDraw and only the final `sceneGridPoint` changed, and the new grid is
  an isometry of the old one (a reflection of the polyline has the same arc
  lengths). The handful of cuboids that moved are the 2 LDU micro-cell
  planner sampling the un-mirrored geometry on the other side of each cell.

**Device-proven results this INVALIDATES (a Pixel round is needed; nothing
below can be re-verified from the workstation):**
- The shell standing on its own colliders (chalet, museum, 10303, 10261;
  rounds 2026-09-16..22): the shell frame and the grid both moved, the
  composition is proven only on paper (`test/ldraw-frame.test.ts` pins the
  algebra) and by the unchanged collider count.
- Figure and seat yaws in buildings (a figure now faces the way the source
  did instead of its mirror), the door hinge side on the Z-axis doors, and
  the wand's ghost/preview alignment with the structure (the ghost is
  grid→entity and unchanged; the grid under it is not).
- The coaster: the lift platform and counterweight at yaw 0 on the moved
  grid, the second train's loading-bay arc, the cars' `heading` on the
  un-mirrored track (heading is measured in LDraw and did not change sign;
  the track's turns did), and "the rider inside the loop" — the runtime maths
  is world-frame and unchanged, but the world it runs in is the other
  handedness.
- Java `block_display` exports were never device-verified and now differ
  in both position and rotation.
- One thing this change did NOT touch but that the same analysis makes
  suspicious: `bedrock-preview-entity.ts` and the grid-fallback `geometry()`
  author a world offset `(dx, dz)` as JSON `(−dx, −dz)`, while the compiler's
  Pixel-proven derivation (JSON x = −render x, world at yaw 0 = (−render x,
  y, −render z)) gives JSON x = +world dx. Symmetric ghosts hide an X mirror;
  an asymmetric grid-only component would show it. Not changed here — it is
  grid→entity, independent of the LDraw frame, and needs a device to settle.

## Invisible steps where scaling broke a climb (2026-09-22)

The decision (user): "Invisible geometry that unlocks interactivity and
enhances gameplay is almost always desirable. Invisible walls restrict rather
than unlock player movement and actions without any reason (sheer bug)." A
player stays player-sized at every wand size while a model's risers grow with
it (a brick riser is 0.45 blocks: a step at 100 %, a jump at 200 %, past the
1.25-block jump from 300 %), so `engine/bedrock-collider-scale.ts` plans
**treads** - `craftmatic:collider` blocks with partial `lo`/`hi` - that a
brick-shell pack ships per size step (150-400 %) and quarter turn, and the
wand's re-lay sets after the collider runs of each box (`placeColliders`).

- **The rule.** A run of treads is laid only for an edge from a surface the
  reach walk has reached to an adjacent standable surface whose rise at the
  chosen size exceeds the jump, whose rise in the 100 % grid is within it (a
  move the set's own figures make), and which the unassisted walk reaches by
  no route. The run is laid back over floor the walk already reaches (that
  level, then no higher: a lower step, the ground before a plinth), solid
  down to it, in half-block hops where the floor allows and the fewest
  jump-height hops otherwise, keeping the player's standing headroom and a
  jump's arc clear. A run may absorb the earlier run that arrived at its start
  (a one-block ledge between the ground and a higher surface needs one
  continuous staircase), but only when the merged staircase is gentle.
- **Never block.** The walk is re-run from scratch and compared with the bare
  walk: every surface reachable before stays reachable (a floor block that now
  carries a tread is reachable at the tread's height), every tread and every
  restored surface is reachable; a run that would break that is reverted.
  `test/bedrock-collider-treads.test.ts` checks the invariant independently by
  walking the emitted blocks, and that at 100 % the runs, tiles and wand
  commands are byte-identical with the feature on and off.
- **The walk** (`walkScaledColliders`) is the block-grid form of
  `measureSceneAccess`'s, with one addition: a rise above the 0.6 auto-step is
  a jump and needs its arc clear above the ORIGIN column (origin headroom >=
  rise + 1.8). `measureSceneAccess` does not yet apply this.
- **Measured** (`bun scripts/_collider_treads.ts <pack.mcaddon | source> [--turns]
  [--target=x,y,z:label] [--route] [--refused]`; highest surface a player reaches
  on foot from outside, blocks at 100 %, bare -> with treads, 0° turn):

  | set | 100 % | 150 % | 200 % | 300 % | 400 % | tread blocks 150/200/300/400 |
  |---|---|---|---|---|---|---|
  | 910004 chalet (shipped pack) | 2.0 | 0.25 -> 2.0 | 0.44 -> 2.0 | 0.25 -> 2.0 | 0.25 -> 2.0 | 12 / 20 / 69 / 182 |
  | 10303 coaster (shipped pack) | 5.56 | 0 -> 5.58 | 0.63 -> 5.56 | 0.38 -> 5.56 | 0.19 -> 5.56 | 228 / 312 / 1,302 / 3,268 |
  | 21060 Himeji (DbixConvV3) | 4.0 | 1.0 -> 4.0 | 0.19 -> 4.0 | 0.19 -> 4.0 | 0.19 -> 4.5 | 70 / 210 / 662 / 1,573 |
  | 76419 Hogwarts micro (DbixConvV3) | 0 | 0 -> 1.38 | 0 -> 2.0 | 0 -> 2.0 | 0 -> 2.0 | 4 / 8 / 18 / 30 |

  The coaster's station platform (`coaster.routes[0].station.point`, model
  `[24.66, 3.30, 9.26]`) is reached bare at 100 % by the walk (route printed by
  `--route`: two one-block jumps at x 36.5/35.5 along z 7.5, one at x 30.5),
  and with treads at 150/200/300/400 %. The device round of 2026-09-21 found
  no route on foot at 100 %; the walk's route is what to check there.
- **Pack.** `PlacementColliders.treads` (`plans[\`${pct}:${turn}\`]`, 7 chars
  per block; the coaster's 16 plans are 18,207 blocks, ~125 KB of plan text,
  1.3 s to plan at export), `craftmatic-treads.json`
  beside the diagnostics (counts, refused edges, walk before/after per plan),
  and the wand's Place confirmation and result name the count. `treads: false`
  on the spec ships the bare grid (the re-lay suites use it).
- **Shell cull box.** Bedrock draws an actor to `64 x max(1, |collision box
  diagonal|)` blocks (Pixel 8 Pro, 2026-09-21). `shellCollisionBox(extent)` is a
  0.1-wide needle tall enough for four times the model's largest dimension
  (10303: 176 blocks, a 5-block model: 64, 400 %: 704, 25 %: 64), standing above
  the roof. `playable-addon.ts` must pass `sgeo.sizeBlocks` to `shellBehavior`
  (until then a 44-block extent is assumed) and re-derive its LOD switch from
  `actorCullDistance` instead of 64.

## Figures on the device (2026-09-24): faces, hair, big-figs, mini-dolls

The user's Pixel screenshots of 76417 and 42703 (`output/device-round-2026-09-24b/screenshots/`)
showed blank faces on every head, striped hair, mermaid tails as pink blobs
on the torso, Hagrid as floating hair and arms, and a stray skin-coloured hand
beside 42703's dolls. Five causes, none of them a rendering problem:

- **A quarter of Studio's unofficial parts were nameless.** 5,605 of the
  22,692 files in `UnOfficial/parts` start with `0 FILE <name>.dat` and carry
  the description on the SECOND line; `descriptionOf` read the first, so
  `37777` (Hagrid's `Torso Large`), `37779`/`37783` (`Arm Large with Pin`),
  `37784` (his hair-and-beard), `93230p04` (the goblins' ear-hair) and every
  mini-doll hair were `FILE …` to every classifier. The header is skipped now
  (`ldraw-part-geometry.ts`), as `gen-minidoll-slots.ts` always did.
- **Mini-dolls are rigged** (`minifig-rig.ts`, `FigureSystem = 'minidoll'`):
  head 33.2 above the torso, arms ±11, hips 29.4 below and 1.2 forward, the
  one-piece legs 47.4 below the hips and 2.7 further forward — the library's
  own numbers (`92456` places its arms at ±11; `92248` and `92251`/`16529`
  carry `!HELP` origin notes). The converted 42703 places the mermaid tail
  `16529` AT the hips (no LDD→LDraw row); the rig moves it to the legs joint.
  A doll walks stiff-legged (its legs ride the `hips` bone; the shared
  animation's `leg_*` bones do not exist on it) and holds items at ∓25.9,
  29.7, −4 (where both of 42703's microphones sit).
- **Big-figs are rigged** (`'bigfig'`): the body mould at the origin, arms on
  the shoulder pins at ±20, 9.5 (`37777`'s `peghole` primitives), the head or
  hair-with-beard on the neck at −24, minifig hands at the arms' ends, and
  short legs under the coat at 64 (feet at 88).
- **The frame is the body's consensus, not the torso's word.** Each part with
  an exact canonical offset votes for where the torso origin is; the largest
  cluster within 4 LDU wins, ties to the torso. 76417's `37777` has no
  alignment row, so the converter left it at its raw LDD origin, 10 / −70.5
  LDU from where its own head, arms and legs put the shoulders — anchored on
  it, Hagrid's body sat in the ground and his hair and arms in the air.
  `reanchoredLdu` reports the move; the scene floor (`bedrock-scene-actors.ts`)
  now stands a figure on the rig's `feetY`, not on the source body's bounds.
- **The repair is applied to the SOURCE, once, before anything reads it**
  (`repairFigureTorsos`, called at the top of the `.mcaddon` pipeline and in
  both compiler preparation paths). The regenerated 76417 (`d3a02437401c`,
  the finished-model page) seats Harry and Hagrid IN the vault cart, and the
  coaster detector takes a figure as a rider by where its TORSO is: Hagrid's
  raw torso was inside the chassis and the repaired one is 98 LDU above it —
  either way a rider, but only the repaired one is drawn whole. The
  cart-floor saucer `38799` the raw torso had pulled into his group goes back
  to the cart (9 parts, not 10).
- **A car keeps every posed rider.** `canonicalCoasterCar` took `seats[0]`
  alone: the second rider's bricks had left the shell as car members and were
  emitted nowhere — Hagrid vanished from the whole pack while the diagnostics
  said "1 posed rider aboard" (a count of CARS with riders). The first seat's
  rider is the player's variant (hidden while ridden); every other seat's
  rider is a passenger in the car body.
- **A head with legs but no torso is still a figure** (`figureAnchor`,
  `groupFigures`): the rig synthesises the torso (`92241` for a doll, `973`
  for a minifig) in the sleeve's colour, else the hips'. 42703's fifth doll
  arrived as head, hair, arm stump, hips and legs; its stump floated in the
  shell where the shoulder should be.
- **Faces.** Converted sources carry no head print — the LXFML holds the face
  as an LDD `decoration` the conversion drops — so every head is a plain
  `3626c`/`92198`. A plain head (every triangle colour 16) now gets a default
  face (`faceDecals`: two eyes at 40 % of the height, a mouth at 66 %, as thin
  cuboids proud of the front-most compiled cell, black on light skin and
  white on dark). Since the same day it is only the FALLBACK - see
  "Accurate faces" below: the converters now draw a decorated head as its
  printed LDraw part and the compiler draws a print as a texture.
- **Hair stripes.** Two mechanisms, both fixed in the figure compile: the 2×2×2
  majority downsample punctures a thin shell where it crosses the lattice
  diagonally (`preserveSurface` keeps any cell the surface touches; headwear
  compiles with it), and a head cell that shares space with its hair draws
  its coplanar face through the hair (the head carve: aligned head cuboids
  are clipped by the headwear's, `headCubesCarved` in the diagnostics).
- **Olive-green goblins are not in the source.** Every `3626` head and every
  `68498` ear-hair in the DBIX LXFML of 76417 carries material 283 (Light
  Nougat) — the ears as `materials="1:0,283:0"` etc. — and the `.io` agrees
  (all `3626c` at 78). Nothing in the pipeline drops 330; the LXFML never has
  it on a figure. If the set's goblins are olive, that is a correction to
  the SOURCE (clego's `reconvert_dbix.py` material→pattern table), not to
  the pipeline.

Offline evidence: `node scripts/_shoot_addon_walk.mjs <pack> <out.png> model
figures --url=http://localhost:<port> --figure=<n|label> --view=front
--distance=4.5` renders any figure face-on from any worktree's dev server;
`output/device-round-2026-09-24b/figures-*.png` holds the before/after set.
Tests: `test/figure-systems.test.ts`. Not verified on the device: the doll
and big-fig animations, and Bedrock's rendering of the 0.9 LDU face decals.

### Accurate faces: three routes, measured (2026-09-24)

The LXFML knows every face exactly: each head `<Brick>` carries its LEGO
ELEMENT id (`itemNos`, design + colour + print) and a DECORATION id
(`decorationBriefId` / `Part@decoration`, e.g. `1029859` for 76417's goblin,
element 6454427 = BrickLink `3626pb3484` = hp448's head). What was missing
was a join from those ids to something drawable. Three routes, measured over
the DBIX LXFML corpus (5,641 head placements, 604 undecorated; 5,037
decorated = 1,611 distinct decoration ids in 1,329 set files):

| population | decorated heads (distinct) | route 1: LDraw print | + route 2: BL photo art | no source |
|---|---|---|---|---|
| 76417 | 15 (14) | 2 (2) | 15 (14), 100 % | 0 |
| 42703 | 6 (6) | 3 (3) | 3 (3) | 3 new doll heads |
| 40 favourites (27 with decorated heads) | 232 (171) | 96 (62), 41 % | 202 (141), 87 % | 30 |
| whole corpus | 5,037 (1,611) | 1,755 (218), 35 % | 4,051 (1,009), 80 % | 986 (604) |

(Counted from the corpus extract with the shipped table; `n:` identity rows =
route 2. Sets fully faced: favourites 7 → 19 of 27, corpus 225 → 881 of 1,329.)

**Route 1 — the printed LDraw part (shipped, every surface).**
`scripts/gen-ldd-print-map.py` → `web/public/ldd-print-map.json`: element →
BrickLink item (Studio's `elementInfoList.json`, both editions), element →
Rebrickable part (clego `elements.csv`), then BL/RB id → LDraw file through
Studio's `StudioPartDefinition2.txt` BL column, a Studio BL copy's
`0 BL_Item_No` header and the official library's `0 !KEYWORDS BrickLink` /
`Rebrickable` lines. BrickLink numbers a head print ONCE across moulds
(`3626pb3484` = `3626cpb3484` = `3626bpb3484`), so ids are compared on that key.
A file is accepted only if the served library has it (Studio seed + upstream
official/unofficial; all 484 verified on prod's `/ldraw-parts/_batch`) AND it
bounds exactly like `3626c`/`92198` - the check rejected the 52 `92198pXXcYY`
whole-doll composites and three Studio `3626*pb*` copies 24 LDU off. The
converters swap only the FILE after the plain mould's alignment has placed
the head (`printedHeadFor` in `lxf-parser.ts`, clego `dbix_print_heads.py`).
Decoration-id rows are the fallback for an element no table knows (8
placements corpus-wide). The web viewer draws these prints natively.

**Route 2 — face art from the BrickLink catalogue photo (offline builds).**
For a head with no LDraw print the table gives its BrickLink print id
(3,197 `n:` rows, `3626pb<N>`). The head STAYS the plain mould and the id is
written on the line before it: `0 !CRAFTMATIC HEAD_PRINT 3626pb3484`
(`ldraw-directives.ts`; the parser attaches it to the next type-1 line as
`ParsedBrick.headPrint`, and `assembleMinifig` carries it onto the rigged
head). A first version wrote the id AS the part name (`3626cpb3484.dat`):
our renderer drew it through the alias ladder, but no library ships that
file, so clego's geograde counted it missing (76417: unknown part placements
18 -> 31) and so would any stock LDraw tool. Never put an invented name in a
source. `scripts/gen-face-art.py <dir> <model>...`
fetches `img.bricklink.com/ItemImage/PN/<colour>/3626pb<N>.png` (BL colour
from `elementInfoList`), takes the leftmost (front) head, crops to the body
(rows >= 80 % of the widest), keys the median skin out, drops the silhouette
rim, and keeps ink lighter than the skin only beside dark ink (the studio
highlight on the forehead goes, a goblin's teeth stay; on a dark head all
ink is kept). Photos existed for 12/12 of 76417's and 75/76 of the
favourites' identity heads; by eye about 68 of those 75 are clean and ~7 show
artefacts (a tiny or offset photo, a yellow head keyed into its own shading,
a cropped head). `bun scripts/_playable_ref.ts <model> <pack> --faces=<dir>`
seeds it. Nothing in the web app fetches photos and this repo does not
redistribute them - shipping route 2 to users is a licence decision.
LEGO's own CDN (`lego.com/cdn/product-assets/element.img.photoreal.192x192/
<element>.jpg`) had every one of 76417's and 42703's 21 elements, but as a 3/4
render - usable only with re-projection, not implemented.

**Route 3 — sources that already place printed heads.** LDraw-native sources
(10261's `.mpd`, IOModel2V2's 10303, ...) place `3626cp*`/`3626cpb*` directly.
Their colour triangles DID survive voxelisation (10261's sunglasses head
showed lenses and lips) but only as 2 LDU blocks - a smudge, not a face
(`output/faces-0924/shots/route3-10261-fig2-face.png`). They now go through the
same texture path as route 1.

**The face as a TEXTURE (`engine/head-face.ts`).** A head whose part carries
explicit-colour triangles is rasterised face-on from −Z at 4 texels per LDU
(z-buffered, 2x2 supersampled, so a dual-sided head's back print never shows;
colour 16 = transparent). The compiler re-colours the print's FRONT-half
cuboids to the head colour (a back print keeps its cuboids) and adds ONE
decal cube 0.6 LDU proud of the front-most cuboid, with PER-FACE UV naming
only the face it looks out of, into one alpha-tested atlas per entity
(`<entity>_faces.png`, material `entity_alphatest`). Box UV stays on every
other cube. Orientation: the Pixel-proven frame is `world = (−x, y, −z)` of
the render frame, a proper rotation, so a texture must read unmirrored from
outside in the render frame - image right = `(−n) × up`; through the JSON's
X mirror that is north u → +X, south u → −X, east u → +Z, west u → −Z,
v → −Y (a player skin's face on its head's `north` face agrees). A face
that looks up/down keeps its cuboid print. The Walk add-on reads the atlas
and per-face UVs back and draws them; 42703's `92198p27` lopsided smile has
the same handedness there as in the web viewer. The minifig creator opts
out (`faceTextures: false`; its slots carry print layers). Diagnostics:
`faceTextures: {printed, art, atlas}` per entity.

**Found on the way:** a CLI build asked the local (2020) library's alias
ladder BEFORE the prod mirror for the exact name, so `3626cp1t` - upstream
unofficial only - silently became plain `3626c` offline. `ldraw-geometry.ts`
now asks the mirror for the exact name first (`e09a0fa9`).

**Publication:** clego `dbix_print_heads.py` (patch mode) went over 1,196
published DbixConvV3 files: 1,736 heads renamed to their printed part and
2,269 HEAD_PRINT lines inserted before unchanged plain heads (1,196 heads
paired by order where an older run wrote other numbers, 0 missed); 76417 was
regenerated by its recipe (`_lxfml_assemble.ts --root-step` +
`_lxfml_to_ldr.ts`). Checked against the shipped bytes: across all 1,197
files the only differences are 1,738 renames to a printed part that exists in
the served library and 2,282 inserted HEAD_PRINT lines. Geograde A/B with the
upstream library: see `output/faces-0924/PUBLISH2.md`. Files and sha256/12 in
the same file (`publish2/`; the first `publish/` set used identity part
names and is superseded).

**Open:** device check of the decal (orientation, alpha cut-out); 986
decorated placements with no source (505 mini-doll heads - BrickLink numbers
them bare, e.g. `101267`, and no identity row is written for them -
and 536 elements newer than Studio's Jul 2025 element table); UNdecorated
heads (statues) still get the default face because a converted `.ldr` cannot
tell them from an unresolved print.

## Moving parts: doors, windows, hatches, levers, turnables (2026-09-24)

Every door leaf (at any angle to the grid), gate, trap door, opening window,
cupboard door, lever and turnable of a brick-accurate building is now its own
entity of the exact LEGO parts, hinged at the measured pivot and eased by one
float actor property; doorways are cut into the collider grid and their closed
cells are laid by `scripts/interactives.js`, which also persists the state.
The vanilla-door path (`applySceneDoors`, `runtimeDoorCandidates`, leaf actors)
now serves only the coloured-block export. Design, rules, the scale rule and
the offline proofs: [bedrock-interactivity.md](bedrock-interactivity.md).

## Pinball: plunger, tap targets on the flippers, drawn ball (2026-09-25)

`engine/bedrock-pinball.ts` (runtime + plan), `pinball-physics.ts` (sim),
`pinball-table.ts` (detection). The user's report on the 2026-09-24 pack
(`1e33902c`): an orange overlay near the right, a wrong right-flipper swing,
lag, a launch button instead of a plunger, and half-screen tap zones that
were unreliable and hard to find. Device evidence for everything below:
`output/pb0924f/device/` in the pinball worktree (world 924, Pixel 8 Pro,
Minecraft 26.51).

- **The orange things in the seated view.** Two, both set parts
  (`bun scripts/_pinball_parts_near.ts <ldr> --colors=25,182,191 [--u=a..b --w=a..b]`):
  (1) the orange capsule floating left of the cabinet front is 96874 **Brick
  Separator** (#2254), the set's loose accessory lying beside the two spare
  balls. It now leaves the shell (`PinballTable.looseBricks`, any part
  described "Brick Separator"). (2) The orange ball in a gold ring near the
  right wall above the right flipper is the set's own **planet**: 32474
  Technic Ball Joint (orange) on a trans-clear 6019 clip, ringed by pearl-gold
  35485 (#1918, #1819, #2235, u 784 w 1303, 57 LDU above the playfield). It is
  model geometry and stays; it stands above the ball's band, so the ball
  passes under it. With the camera moved onto the head, the lifted yellow
  seat pad also filled the bottom third of the view; the pad now shrinks to
  nothing while ridden (`consoleHideAnimation`, `q.has_rider`).
- **Right flipper.** The half-turn was the ±180° seam (`71c98317`): 11374's
  right flipper rests at 162.5° and raises to −162.5°, so the unwrapped swing
  read 325° and was clamped to 180. On the Pixel both flippers now swing 35°
  in opposite senses: GameTest `maxMove` [35, 0] / [0, 35] per hotbar slot and
  per flipper target (right reads −35.04, not 180), and the recordings show
  each flipper raise on its own tap (`65-right-flipper-up.jpg`).
- **Plunger.** `PinballTable.plungerBricks`: Technic rod parts (no bricks,
  plates, tiles) within 1.2 ball radii of the lane's line behind the serve,
  down to 4 radii under the playfield. On 11374 these are the 13 parts of the
  tow-ball tip, 1 x 15 liftarm rod, axles, cam knob and rubber pin. They ship
  as one entity on a single `pb_move` bone; `craftmatic:pull` (0..1) moves it
  `plungerStroke` (40 LDU) toward the player. The sim fires at
  `launchMax x pull` (a spring), so a pull under ~0.63 does not climb 11374's
  lane and rolls back onto the plunger (`return`). Touch: tap the plunger's
  yellow target to take hold (it draws back over 1.2 s), tap again to let go.
  If a finger's events repeat while it is held, the plunger fires when they
  stop. Stick: pulled back = drawn that far (rate-limited to half a second
  from rest to full). Device: the knob draws back out of the cabinet front
  and the ball follows it (`64-plunger-strip.jpg`); release fires and scores.
- **Tap targets: what the phone's tap ray actually is.** Probe targets along
  the screen's centre column (`{"probe":[[0,-20],...,[0,80]],"d":1.6}`) were
  hit at pitch 0 / 10 / 20 / 40 for taps at y 250 / 450 / 640 / 850 of 1008.
  The tap ray follows the **player's own view** (reported pitch 18°, not the
  free camera's ~50°), mapped through the tapped screen position. Boxes on
  the camera's line of sight to each flipper were drawn on the flippers but
  never hit (taps 0/0/0). So every target is **two entities**: an OUTLINE on
  the camera ray (alpha-blended frame on its top face, what the player sees
  on the part) and an invisible PICK box on the level-view ray for the same
  screen spot, following the rider's reported pitch (`fitPinballZone` models
  `camera` / `level`). Both count as the target. Pick boxes 1.2 blocks from
  the head, sized for pitches 0-50 (`PICK_PITCHES`) and capped so neighbours
  never overlap. Device: left, right, left, right, plunger, plunger
  registered in that order (readout 1/1/0 → 2/3/2) and the ball launched.
  Offline check of the outlines: `bun scripts/_pinball_zone_report.ts <BP dir>
  --svg=<file>` projects the playfield, both flippers, the waiting ball and
  the targets through the seated camera.
- **The ball is drawn from properties.** The ball entity stays on the serve
  point; each tick it changes, the runtime writes its plane offset and
  velocity (`craftmatic:bu/bw/bvu/bvw`) and bumps `craftmatic:seq`. The
  client's pre-animation times `v.dt` since the last bump, and the `move`
  animation draws offset + velocity x dt. All four variables must be declared
  in `initialize`: Bedrock does not default an unset variable, and one GameTest
  run logged 11,969 "unknown variable" errors before that (0 after, both 924
  sessions). **Animated bone positions keep the render frame's X and negate
  its Z** (`PINBALL_AXIS_SIGNS` = +1/−1): with the geometry writer's −1/+1 the
  ball flew off the cabinet. `{"axes":[sx,sz]}` overrides them live.
- **Lag, measured.** `{"perf":1}` logs `[pinball-perf]` lines to the content
  log. With the old per-tick world scan, fixed 12 substeps and teleported
  ball (`{"cache":0,"fixed":1,"ball":"teleport"}`), the script took 3.39 ms per
  tick on average (10 windows of 100 ticks, 2.83-4.01). The new defaults took
  1.71 ms (52 windows, 1.23-2.01). The server tick gap was 50.5 ms either way,
  so the old runtime did not slow the server. Both ball modes reach the
  frame rate: `scripts/_video_motion_rate.py` counts 26-29 new pictures per
  0.5 s in the upper playfield during a shot, teleported or drawn. The client
  interpolates a teleported entity, so the 20 Hz teleport was not jerky. What
  the drawn ball removes is the client's interpolation delay (it
  extrapolates from the latest update instead of easing toward it). That
  delay was not measured separately, and we do not know which part of the
  "lag" the user felt it accounts for.
- **Still open.** The final build's pinball GameTest could not run: another
  agent's 21360 test variant was bound in `cmgametest` at the same time, and
  its placement hook answered the pinball request (`actorsFound 0`). The
  previous build of the same runtime (`7234854a`) passed there: flipper
  targets 2/2, plunger pull 0 → 0.79 in 20 ticks, ball offset −665 LDU up the
  lane. Rerun `pinball_arcade_11374` with only that variant bound.

## Figure life: scripted strolls over the real colliders (2026-09-25)

Figures no longer use vanilla `random_stroll` / `minecraft:home`. On the
Pixel the mob path-finder, which plans in whole block cells, never found a
path over the partial-height `craftmatic:collider` floors (Winter Chalet:
0 of 7 roamed). Figures standing on plain ground strolled off the model under
the 12-block home radius. `scripts/figures.js` (`engine/bedrock-figure-life.ts`)
now plans over the collision spans themselves: a collider's `[lo, hi]`
sixteenths, any other block as a cube, plants and carpets excluded. It moves
the figure by velocity (`applyImpulse` to a target speed each tick). The
engine's own collision, gravity and step-up then carry that out. This was
measured to work on mobs on the Pixel. The vanilla behaviour that stays is
`look_at_player` (probability 0.08) and `random_look_around` for the head.

- **Home record.** At spawn, the placement runtime writes the dynamic property
  `craftmatic:fig`: `{home, area, ground, f, mode}`. `area` is the placement's
  world box, `ground` the pin plane, `f` the size factor, and `mode` is
  `seated` for a `rideOf` figure. The record survives a reload, so the runtime
  re-adopts figures after one. A figure summoned with a spawn egg takes its
  current position as home. Only the pack's own figure types are driven.
- **Planner rules** (`FIGURE_TUNING`). A stroll ends 2-6 cells away. It stays
  in the footprint, within 7 blocks of home (× the size, capped at 14) and
  within 1.2 blocks (× size) of the home floor. Steps rise and drop at most
  0.6 blocks: no jumps and no falls, so a figure keeps to its floor. A
  diagonal step needs both of its corner cells to be free. A figure turns on
  the spot when its heading is more than 60° off, walks at 1.2 blocks/s, and
  pauses 3-9 s between strolls, with a 20 % chance of a 15-25 s pause. After
  2-12 minutes it may borrow a free seat of its pack for 20-40 s, and it
  gets up when a player comes within 2.5 blocks. It never stops within 1.25
  blocks of a door or window leaf. If it is pushed out of its area it plans
  back in, and after 10 s it is put home. A source-seated figure stays on its
  seat and is re-seated if it is knocked off. A figure with fewer than 4
  reachable cells (a plinth or a loft) stays and looks about.
- **Wedged figures.** A LEGO figure stands a hair from a cupboard, and its
  1-block collider column often holds that part at head height. The figure
  first walks one cell out into the free column. With no free neighbour, it
  is set down once on the standable column within 3 cells whose floor is
  largest. The first version searched 2 cells for the nearest one, and the
  chalet's figure 7 picked a cell behind the house wall.
- **Where a figure spawns is decided at export** (`resolveFigureSpawn`,
  called from `playable-addon.ts` over the collider grid the pack ships; no
  collider is added for it). The 2026-09-25 census found 16 figures in 5
  favourites that fell at placement (7 in 21360, 4 in 42639, 3 in 43267,
  1 in 77092, and 10261's one was a census artefact: a SEATED figure counted
  at its lifted spawn). `bun scripts/_figure_support_audit.ts <source>` lists
  the parts under every source figure's feet and whose they are: all 15 real
  cases stand on NO part. They are LEGO's box-art line-up of figures on the
  table beside the model, at the level of the model's base, and the model's
  underside is lower than that table (a few parts hang below the base, so the
  pin plane is 2-5 blocks under the line-up). No plate, tile, fence or thin
  floor was missing from the grid. A second class came out of the same data:
  every figure the placement's spawn lift raised more than a step (71040,
  31141, 42639, 77092, 43267, 910049; 1.2-2.6 blocks) stood INSIDE a 1-block
  collider column (a wall, a counter, the base it stood against) and was put
  on the roof above it, with 2-6 cells to walk; 71040's two figures "never
  moved" for that reason. The export now keeps a figure its own column
  carries (a step up, a hair down, snapped to the collider top), sets a figure
  that stands on nothing down on the surface below it in its own column, and
  moves one standing inside a column to the roomiest standable column within
  2 cells (cost = distance + 1.5 x drop + 3 x rise; at least `minRoamCells` of
  room preferred). The pack's warnings list each figure it grounded or moved.
  Census over the same packs: dropped 16 -> 0, lifted onto a roof 0, 71040
  2/2 move, 31141 4/6, 910049 7/8; collider runs byte-identical and
  `_ix_passability` identical on the 8 affected sets. The runtime's re-home
  (a home nothing supports becomes the floor it landed on) stays as the
  backstop for other sizes.
- **Colliders and figures are in two different frames** (found while pinning
  the resolver). The shell and its colliders are laid with `sceneGridPoint`
  (the voxel grid's frame), figures with `sceneFloorPoint` (up from the
  model's underside). Where the underside is off a cell boundary the two
  differ by up to half a cell: `test/schem-pipeline.test.ts`'s baseplate is
  drawn from -0.15 to 0 (under the pin plane, so the collider grid clips it
  out) while its figure was placed 0.15 up, above the drawn plate. The
  resolver snaps every supported figure onto the collider top it stands on,
  which is also the drawn surface; the sunk baseplate itself is untouched.
  # TODO(shell owner): lay the shell and colliders from the underside too,
  so a baseplate is not drawn into the terrain and dropped from the colliders.
- **Seats on another storey.** On the Pixel (76269, 3-minute watch) three
  figures sat down and got up again, but two took a seat on another floor
  (6 blocks down, 6.7 up): the "already beside the seat" test measured only
  horizontal distance. It now also needs the seat within 1.2 blocks of the
  figure's height (`test/bedrock-figure-life.test.ts`, red before the fix).
- **Minifig Creator figures walk too.** The creator's figure type is in
  `scripts/figures.js` (`draftTypes`); its npc group has no `random_stroll`.
  While the wand holds it as a draft (`craftmatic:draft`) the runtime leaves
  it alone; the wand clears its home record on release, so it is re-adopted
  with a home where it now stands. Device (GameTest `creator_<id>`): held
  still as a draft (0 blocks), walked 13-14 blocks once released, stayed
  within 4.9-6.2 blocks of the release point, home record written. That run
  also found the creator figure had NEVER had its properties on the device:
  Bedrock refused `craftmatic:family` and single-entry slots' `[0, 0]` int
  ranges ("range max is less than range min") and with them the whole
  property component, so every `q.property` errored and the wand's
  `setProperty` threw. Ranges are now at least `[0, 1]` and
  `scripts/_mcaddon_check.py` fails any range not wider than one value.
- **Mini-dolls** hinge their one-piece legs (`92251`, `16529`) on their own
  `legs` bone at the hips joint (29.4, -1.2 below the torso: the moulds'
  `!HELP` hip rotation point). `MINIDOLL_CLIENT_ANIMATIONS`: the walk rocks
  the legs 5 degrees side to side per step (one moulded piece cannot scissor)
  with the arms swinging, and the sit bends the legs 90 degrees at the hinge,
  as the toy's do. Not yet seen on the device.
- **Gait, measured.** The walk phase rate comes from the leg: 0.525 blocks
  from hip to sole and a ±35° swing give a 1.2045-block cycle. The GameTest
  gait probe (`--gait-probe`: a server-side animation controller on one
  figure reports every whole unit of `query.modified_distance_moved` and the
  bucket of `query.modified_move_speed`, while the figure is pushed exactly
  as the walker pushes it, about 25 blocks per speed) measured on the Pixel:
  **3.88 units per block** at 0.021 and 0.042 blocks/tick (96 and 97 units),
  3.76 at 0.083, and `modified_move_speed` = 3.9 x blocks/tick. The rate
  (`MINIFIG_GAIT.degPerUnit`) is now 77.03 degrees per unit (was 74.72 from
  a guessed 4). The larger error was the swing AMOUNT: `modified_move_speed
  x 4` was 0.65 at the walker's real speed, so the legs swung 23 of 35
  degrees and the feet covered 68 % of the ground (33 % at 50 % size). The
  swing is now full from 0.01 blocks/tick (`GAIT_FULL_SWING_SPEED` 0.04) and
  only fades at a start and a stop. The same probe showed the walker's real
  ground speed: asking 0.06 blocks/tick by impulse gives **0.0415** (0.83
  blocks/s; 0.03 gives 0.0207, 0.12 gives 0.0833). The feel was left alone;
  the animation is locked to distance, so the speed does not change the
  sliding. Not yet checked by eye on a recording after the fix.
  # TODO: a figure below 100 % has shorter legs in the world, so its phase
  should turn 1/size faster; the client has no measured size query yet.

**Measured on the Pixel** (GameTest `figures_<id>`, 60 s, 100 %, in the
`cmgametest` arena; logs in the figures worktree's `output/figure-ai/device/`):

| set | vanilla AI (before) | scripted (after, `0711e753`) |
|---|---|---|
| 910004 Winter Chalet | 4 roamers: 2 moved (about 40 blocks each), both **left the model** (17-23 of 61 samples) and **fell off the arena** to -2; figure 7 ended **inside a cupboard's collider**; 3 seated stayed | 2/4 moved (mean 4.7 blocks), **0 left, 0 fell, 0 in a wall**; 3/3 seated stayed; the loft figure (2 cells) and figure 7 (set down beside the cupboard, under 4 cells) stay |
| 41732 Downtown | 7/7 moved (mean 31.1), **6/7 left the model, 4 fell below the floor** | 6/7 moved (mean 17.8), **0 left, 0 fell, 0 in a wall**; figure 3 stays on its 0.94-block perch |
| 76457 Hogsmeade | 12/12 moved (mean 30.4), **3/12 left the model** | 11/12 moved (mean 17.0), **0 left, 0 fell**; figure 9 stays on its 1-block perch |

The doors tests in the same runs still match the offline walk (910004 3/3,
41732 6/6). No figure sat down in the 60 s watches, so seat borrowing is
proved only by the host simulation.

**Offline:** `bun scripts/_figure_roam_census.ts <pack.mcaddon>...` runs the
shipped `figures.js` in `engine/figure-life-sim.ts`. That is a host world of
the pack's collider grid with a stand-in for Bedrock's collision. The census
prints each figure's spawn lift, headroom, reachable cells and simulated
path. For 41732 and 76457 its "moved" counts matched the device: 6/7 and
11/12. For 910004 it gives 3/4 against 2/4 on the device. Over all 40
favourites (`0711e753` packs plus the re-home fix) it simulates 60 s for 236
figures. 4 are source-seated and stay seated. Of 232 roamers, 177 moved and
0 left their area. 83 start with fewer than 4 reachable cells, and 16 fell
from an unsupported spawn. With the export-time spawn (packs from the
figures worktree's `output/fig-close/sweep40/`, current runtime): of the same
232 roamers **216 moved**, **14** start with fewer than 4 cells, **0 fell**,
0 left their area, and 5 borrowed a seat within the 60 s.

**Round 2 on the Pixel** (2026-09-25 afternoon, `figures`-only GameTest
variants in `cmgametest`, packs from `1e18ef68`; logs in the figures
worktree's `output/fig-close/device/`):

| set | before | after |
|---|---|---|
| 71040 Disney Castle | none moved, one ended in a wall | 2/2 moved (12.7, 13.9 blocks), 0 in a wall, 0 left |
| 31141 Main Street | 2/6 moved | 4/6 moved; figures 1 and 5 stay in upper rooms the 1-block collider grid leaves 4 cells of |
| 910049 Transylvania (3 min) | one figure ended in a wall | 7/8 moved, 0 in a wall; figure 1 sat on its floor's bench for 31 s and got up; figure 7 stays (2 cells) |
| 21360 Willy Wonka | 7 of the line-up fell at placement | 0 fell (`fellAtSpawn` empty), 9/9 moved, 0 left |
| 76269 Avengers Tower (3 min) | no figure had sat on the device | first run: 3 sat and stood up (27, 36, 22 samples), two of them on a seat on another storey; after the fix (`1e18ef68`): figure 16 sat 40 samples on its own floor (1.4 against 1.6) and stood up, no seat taken across a floor, 17/20 moved, 0 left, 0 in a wall |
| creator probe (`_minifig_ref.ts --creator=starter`) | vanilla `random_stroll` | the `creator_<id>` test passed: a draft holds still, a released figure walks |

### Round 3 (2026-09-25, after the user played): cabinet buttons, pull plunger, held item, latency

User: "tap the flipper buttons (with enlarged area), ensure any held item is
not displayed, use a pulling mechanism instead of tap…tap, more responsive".
Evidence: `output/pb0924f/device/r3-*` in the pinball worktree.

- **Cabinet buttons.** `PinballTable.buttons`: round parts outside each side
  wall level with the flippers. 11374: per side a trans-clear 79850 4 x 4
  dome, a white 14769 round cap and two white 4032b round plates (#1986,
  #1608, #1987, #1988 left at u 878 w 779; #1685, #2131, #1683, #1684 right
  at w 1461), 70 LDU below the playfield. Each side ships as its own entity,
  pressed 8 LDU inward (`craftmatic:press`) while its flipper is up. The tap
  targets now sit on the buttons: outline on the camera ray, pick box on the
  level-view ray, enlarged to 4 ball radii outward / 1 inward and 6.5 along.
  The on-flipper outlines and the plunger target are gone. Device: button
  taps registered every time (8 / 8 in `r3-play`, 41 in the tap maps), also
  after the pitch had drifted to 64. The press animation is small from the
  seat and the action bar covers most of the button; GameTest proves the
  property (each target hit presses exactly its own button: [0,1] / [1,0]).
- **Held item.** Invisibility does not hide a held item. The hotbar now parks
  on the free slot nearest the middle; with a full hotbar, the middle item
  moves to a free inventory slot and is moved back on leaving (recorded on the
  player, restored after a reload too; never dropped). Device: a stick in slot
  5, seated → parked on slot 4, nothing drawn (`r3-31-holding` / `r3-32-seated`).
  GameTest: `heldBefore` stick, `heldSeated` none.
- **What the phone reports for a held or dragged finger** (measured):
  - a press held on a target: ONE `playerInteractWithEntity` (long press)
    about 0.5 s in, nothing repeated, nothing on release;
  - a drag with head turning unlocked: the player's pitch every tick
    (200 px → 18° → 61°, ~0.21°/px); the free camera stays put;
  - the stick at the ready screen: analogue, 0 → −0.88 as the finger slides
    down, 0 on release (contrary to the 2026-09-24 note that it only reports
    in play).
  So the plunger is a **pull**: while a ball waits, head turning is unlocked;
  the pull is the pitch change since the drag began over 30° and it fires
  once the pitch stops changing for 5 ticks (no release event exists). The
  stick pull fires on its exact release. `setRotation`'s pitch still does
  not take, so after a pull the pitch stays (64 in `r3-drag1`); a drag in
  either direction pulls. Device: pull 18 → 64°, "drag release at pull
  1.00", ball launched, head turning locked again.
- **Latency** (`scripts/_video_tap_latency.py`, Android pointer location on,
  60 fps recording): a quick tap reaches a visibly raised flipper in about
  100 ms (84-101 ms over six taps) — two server ticks for the hit to arrive
  and the property to come back. A press held 90 ms: 282-362 ms (the hit
  fires at release). Raising the flipper inside the hit event (`flipNow`)
  instead of on the next tick made no measurable difference (median 312 vs
  331 ms held; ~100 ms tapped): the round trip, not the script, is the delay,
  and a script cannot animate on the client from a touch.
- **GameTest** `pinball_arcade_11374` on `d57ea3c2`, only its pack bound in
  `cmgametest` (bindings saved and restored around it): PASS — held item
  hidden, slots, both button targets (only their own flipper and button),
  the drag pull (pull 0.13 → 1.0 over 8 ticks, ball −665 LDU up the lane).
  An `attackEntity` hit is delivered after the call returns, so the same
  tick reads the old angle (`sameTick` [0,0]); the next tick has it.

### Round 4 (2026-09-25): tuning hooks out, a readable press, no launch jump

- **Tuning hooks removed.** `/scriptevent craftmatic:pinball` (offsets,
  reach, pick model, camera, view, ball mode, axes, perf/log, cache/fixed,
  camlock/predict/dragpull) and its probe targets are gone; the runtime
  hard-codes the measured defaults (level-view pick boxes at the rider's
  pitch, camera on the head, free camera, cached scan, adaptive substeps,
  in-event flip, head turning unlocked only while a ball waits). The ball's
  `teleport` mode survives only as `PinballRuntimeConfig.ballMode` (tests).
- **The press is readable.** A cabinet button is drawn pressed
  `PINBALL_BUTTON_TRAVEL` (2.5) times its measured 8 LDU stroke, and it and
  its tap target's outline flash warm yellow while the flipper is up: the
  render controller's `overlay_color` reads `craftmatic:press`
  (`pressFlashOverlay`; the outline zone now declares that property and ships
  its own controller). The action bar is at most 26 visible characters in
  every phase (`<< Ball 2/3 12,340 >>`, `Ball 1/3 - drag to launch`, the pull
  bar), so the centred line no longer reaches the buttons; the final score
  moved to the title. Pixel, world 924: with the stick held left the left
  outline turned yellow and the white dome became a yellow sliver pushed
  mostly into the cabinet wall; the bar ends clear of both buttons
  (`output/polish-0925/device/s14-leftheld.jpg` in the polish worktree).
  2.5x may be more travel than needed: the dome nearly disappears.
- **No launch jump.** The sim fires from the serve point while the client
  last drew the ball on the pulled-back plunger tip (a full stroke, ~0.75
  block, behind it). The launch tick's update now starts the drawn ball where
  it was drawn, with the velocity that reaches the next update's position in
  one tick (host test: the drawn path meets the next update within 1.5 LDU;
  before, the ball jumped the whole 40 LDU stroke in one frame).

## Rail vehicles on the coaster engine (2026-09-25)

A train is the coaster with a driver. There is ONE ride engine:
`rideSubstep` (`engine/bedrock-coaster.ts`) is the per-substep speed step
that the pack runtime (`coasterRuntime`, which receives it as an argument
because it is serialised by `.toString()`) and the walk preview
(`coaster-preview.ts`) both call. Track routing, car attitude
(`coasterCarAttitude`), boarding, the rider camera and the placement are
the coaster's, unchanged. What differs is data:

- A railway route carries `physics: RAIL_TRAIN_PHYSICS`, whose `DRIVER`
  block switches the step from gravity-only to driven: the rider's stick
  (`inputInfo.getMovementVector().y`, read against the train's FIXED nose,
  never its motion) accelerates at 3 blocks/s² to a 12 blocks/s top speed,
  brakes at 6 against the motion, and reverses only from rest. Nobody at the
  controls: a 6 blocks/s² park brake. No chain, no inversion floor, no
  minimum speed, no station dwell. An open end is a buffer stop that holds
  the whole end car on the line (`cars.endInset`), not the coaster's shuttle
  reversal. Its cars prompt "Drive the train".
- Without `DRIVER` the step is the shipped coaster formula in the same
  floating-point order: bit-identical over 20,000 sampled states
  (`test/rail-track.test.ts`), and the SHIPPED 10303/10261 runtimes replayed
  through the refactored `coasterScript` give the same digest over 4,000
  ticks (10303 `c3b205e9…`, 10261 `0b2f11a5…`;
  `bun scripts/_coaster_replay.ts <pack> --rebuild`).

### Track: railway moulds on the rail-top centreline

`coaster-track.ts` routes railway moulds as a second profile family
(`CoasterTrackProfile.family = 'train'`), measured on the library meshes:
53401 / 2865 / 74746 straights (rail heads z ±50, top y −16, ends x ±160),
53400 / 2867 / 74747 curves (both heads are circles about (0, −800): the
centreline is R 800 over 22.5°), 85976 (R 480 over 45°, gauge 60), and loose
4.5V/12V rails (3228a/b/c) paired one gauge apart (100; 60 for mine-cart
track). Checks: 16 synthetic 53400s close one circle; 4559 closes a
26-mould circuit, 4558/10001 a 20-mould one. Not routed: points, crossings,
12V curves, the 53834/85977 ramps and the monorail — they break a line into
open routes, and the audit names them.

### Cars: a connected body over its running gear

`detectCoasterAssemblies` runs a railway branch only where a railway route
exists (a coaster set is detected exactly as before): running gear is every
`Train Wheel …`, self-wheeled or plain wheel part; everything that is track
(moulds, sleepers, points, loose rails) and every brick whose top is at or
under the rail heads within 200 LDU of the line (a display's track bed) is
scenery. The rest is clustered by contact with the gear and the couplers
(magnets, buffer beams) left out, so coupled cars separate; a body with two
gear units at least 20 LDU apart under it is a car, its widest brick the
chassis frame, and it must stand square over the line (≤ 30 LDU lateral,
≤ 120 LDU above the rail top). The pipeline keeps a train on its own track
off the free-vehicle path (10277 is titled "Locomotive"), keeps it at
minifig scale (`planAddonScale`: railway gauge is the minifig railway's),
never puts the fabricated coaster cart on railway track, and leaves a train
that fills its display line in the build.

### Audit (`bun scripts/_rail_audit.ts [--all]`)

None of the 40 favourites has railway track: 10261, 10303, 10341, 60380 and
76417 carry coaster track only, the rest no rail. Over the whole index
(10,169 sets read), 45 sets stand a train on its own railway track, 179
have a train with no track in the source (it stays a wheeled vehicle or
the build), 45 have track and no running gear, 19 track and train apart.

| set | source | line | train found | what it does (replay host, 60 s) |
|---|---|---|---|---|
| 4559 Cargo Railway | IOModel2V2 | 9V circuit, 26 moulds, 8,225 LDU | 2 cars (2972 bases), 2 riders | laps at 12 blocks/s on full stick; brakes and reverses on the stick |
| 910044 Wild West Train | IOModel2V2 | open, 8 × 53401, 2,560 LDU | loco, tender, car; driver and guard | runs 22 blocks between its buffers |
| 10277 Crocodile Locomotive | OMR | open, 4 paired 3228c, 1,280 LDU | 1 car of 1,050 parts (the articulated loco as one body) | 2.25 blocks of play: the loco fills its display track |
| 60052 Cargo Train | EurobricksTopic | open, 7 moulds | 4 cars | stays in the build: the 2,320-LDU train fills its 2,240-LDU line |
| 21344 Orient Express | IOModel2V2 | open, 9 paired 3228c | 1 body of 2,138 parts | the whole train is one connected body (no coupler parts to split at) |
| 4204 The Mine | IOModel2V2 | open, 4 paired 3228c (gauge 60) | 1 cart joined to a rock | cart welded to scenery by contact |
| 4558 Metroliner | LDR | 12V circuit, 20 moulds | none | its 12V axles-with-wheels leave no body over two gear units |
| 60198, 60197, 4512, 7938, 10254, 71044, 60098, 60051 … | Mecabricks / Eurobricks / some LDR | none | — | **source defect**: see below |

**Mecabricks and LXF-converted sources place railway track 90° off the
LDraw part.** Adjacent 53401/2865 straights 320 LDU apart step along the
part's LOCAL Z in 12 of 13 MecabricksLDR and 6 of 6 EurobricksLDR sources
with straights; the library part runs along local X (authentic LDR/OMR/
IOModel2V2: 11 of 12 along X). So those sets' track is drawn as a ladder of
crossways pieces in the viewer too, and nothing routes. This is a converter
alignment row for 53400/53401 (clego), not something the router should
guess around; `output/rail-0925/frame.ts` is the tally.

**On the device (GameTest `train_<id>_<n>`, Pixel, 2026-09-25, packs at
`260accca`):** 4559's circuit and 910044's open line both PASS. A simulated
player boarded the lead car (`interactWithEntity`), the stick hook drove it:
forward 2 s 5.23 blocks at 5.2 blocks/s (the rail's 3 blocks/s²), stick back
brought it to rest after 18 ticks and then drove it the other way (4559 27.7
blocks up to 12 blocks/s; 910044 12.5), and 910044 ran to its buffer and
stopped there on the line (tick 84 of 400). Parked with nobody driving, it
did not creep. Evidence: the vehicle worktree's
`output/vehicle-0925b/device/gt-4559/`, `gt-910044/`.

Open: a REAL rider's stick on a train is still unmeasured (the GameTest
drives through the hook; placing a railway set in world 924 needs the
wand's form); seat for a train car with no posed rider is the compiler's
mid-height default (inside a loco body); an articulated loco or a train with
no coupler parts is one rigid body (fine on the straight display lines
above, wrong on curves).

## Vehicle operation: cars, boats, planes, measured (2026-09-25)

Code: `web/src/engine/bedrock-vehicle.ts` (flight and boat models, the drive
animation, the scripted-vehicle runtime), `playable-addon.ts`
(`behaviorEntity`, the car/rotor driver and the camera), the compiler's
`vehicleRig` (`ldraw-entity-compiler.ts`). Constants, units and the DRY map:
`docs/physics-architecture.md` §4.6 and §9. Evidence:
`output/vehicle-audit-0925/` in the vehicle worktree (GameTest logs
`gt-base/`, `gt-v2/`, `gt-v3/`; real drives `real-v2/`, `real-v3/`).

### How each class is measured now

- **GameTest vehicle course** (`vehicle_<id>_<n>`,
  `bun scripts/_gametest_pack.ts <pack> --only=vehicles`): a 64 × 64 arena
  (land, a pool a block lower, a half slab and a full step on lane B). The
  vehicle is spawned, a simulated player boards it (`interactWithEntity`)
  and it runs phases sampled every 2 ticks: settle, forward/ahead, coast,
  reverse/astern, a held turn, the class's Jump, steps (car), take-off,
  climb, turn, approach and roll-out (plane), rudder, boost, shore and back
  off (boat), a second rider where there is a seat. One `CMGT VEHICLE_PHASE`
  line per phase and a `CMGT VEHICLE` verdict.
- **A simulated player's stick never reaches `inputInfo`** (every sample read
  0, 0 while it drove, 2026-09-25), and neither `lookAtLocation` nor
  `setRotation` aims a riding one (the camel car always drove across the
  course, off the arena). A native mount is driven by the simulated player
  itself; a scripted one through the runtime's hook
  `/scriptevent craftmatic:flight_input {"x":0,"y":1,"jump":false,"ticks":40}`.
- **Simulated speeds are not a real rider's.** GameTest drove the car at
  43.6 blocks/s; a real rider reads the HUD. Real drives therefore log
  telemetry: `/scriptevent craftmatic:vehicle_telemetry on` writes one
  `CMVT {json}` content-log line per second per vehicle (position, yaw,
  speed, the stick and Jump as the script sees them).

### Before → after, per class

| class | before (measured, Pixel) | after (measured, Pixel) |
|---|---|---|
| **Car** (was the native camel controller) | movement 1.05: a real rider at HALF stick read 44.8-65.8 mph (20-29 blocks/s), GameTest 43.6 blocks/s at full; **on a straight stick the car drove circles**: under `player_relative` the rider's yaw turned by itself ~36 degrees per 4 ticks (car yaw 69 → -125 → -36 in 2 s) in every camera mode, cockpit view included; under the game's default and `player_relative_strafe` schemes it drove straight but the stick's left/right slid it SIDEWAYS without turning it; it stopped dead on release (2.3 blocks from 43 blocks/s); no wheel motion | scripted `carStep`: 19 blocks/s (42 mph) at full stick, brake then 5 blocks/s reverse, coasts down at 2.5 blocks/s² hands off, steering that bites with speed (full lock by 5 blocks/s, fading to ~43 degrees/s at the top), Jump boost to 26 for 1.5 s, eases up one-block steps, stops at a wall, falls off an edge, crawls through water; slope pitch, body roll out of a turn, spinning and steering wheels; a passenger seat behind the driver on any car 3.5 blocks or longer. Device: see "The scripted car on the device" below |
| **Boat** (was the camel over `minecraft:buoyant`) | floated (dy 0) but crawled at **1.6-1.8 blocks/s** on water whatever its movement; `simulate_fluid_physics` rejected by the 1.26.30 schema (a `[Json][error]` at every pack load); 60221's yacht sailed SIDEWAYS (nose voted across the deck) | scripted `boatStep`: **8.0 blocks/s** ahead, 12 on the Jump boost (3 s, then 4 s cool-down), 2.5 astern, coasts down on the water's drag (13.7 blocks from 8 blocks/s), rudder 119 degrees in 3 s at speed and a little at rest, stops at a shore (GameTest `beaches`, a real rider stopped at the pool's edge with the stick held) and backs off it; draft 12 % of its height; swell drawn as heave, roll and pitch. GameTest 9/9 checks on 60221 and 10365; a real rider's Jump boosted and did NOT dismount |
| **Fixed wing** (was the Happy Ghast hover controller) | GameTest: a simulated Jump never climbed (0 blocks); it flew where the camera looked, hovered with no take-off speed, stall or landing | scripted `flightStep`: Jump is the throttle (cruise power by itself aloft), take-off at 10 blocks/s after about 15 blocks of run, stick back climbs (39 blocks in 3 s at full stick on the Milano), forward dives, left/right banks and turns (162 degrees in 3 s), stall below 7 blocks/s, landing and brakes to a stop. GameTest 5/5 on 76286 and 7140. A real rider: Jump held 4 s took off (speed 0 → 19.3 blocks/s, ALT 5) without dismounting, cruise 23.2 blocks/s, stick back pitched to 39 degrees, stick right turned right |
| **Rotorcraft** | unchanged: the Happy Ghast hover (a title naming a helicopter, copter, drone...) | unchanged, plus the drive animation (nose dips with speed, banks into a turn) |

### Controls (phone, keyboard, controller)

The joystick is the movement stick (WASD / left stick); Jump is the touch
Jump button (Space / A); Dismount is the touch Dismount button (Shift / the
controller's sneak) - on every vehicle, because each keeps a controlling
component that makes Jump an input (a plain rideable dismounts on Jump,
pinball 2026-09-24).

- **Car**: stick forward/back drives, brakes and reverses, left/right
  steers; Jump boosts. The 10300 time machine is a scripted car too (since
  the second round, 2026-09-25): its time circuits set its top speed just
  past the armed jump speed and show the circuit on the HUD.
- **Hover craft** (a title in `HOVER_WORDS`: 75397's sail barge, a
  speeder): driven like a car, floating a block over land and water alike.
- **Boat**: stick forward/back is throttle and astern, left/right the rudder;
  Jump boosts.
- **Plane**: Jump is the throttle; stick back climbs (and at take-off speed
  lifts off), forward dives, left/right banks and turns. On the ground,
  stick back with the throttle released brakes.
- **Helicopter**: stick to fly and turn, Jump climbs, stick back + Jump
  descends.
- **Stick sign, measured**: pushing the stick RIGHT reads
  `getMovementVector().x` = -0.44 to -0.78 on the Pixel (Minecraft's +x
  strafe is LEFT). `FLIGHT.STICK_X_RIGHT` / `BOAT.STICK_X_RIGHT` = -1.
- **Camera**: every rider gets the script's chase camera; hotbar **slot 9**
  swaps it for the cockpit view (the rider's own first person), any other
  slot brings it back. A scripted vehicle's boom follows the VEHICLE's
  heading and trails along its nose in 3D (a climbing aircraft stayed under
  the frame's edge with a level boom), and the rider keeps the game's
  default control scheme so the stick's left/right reaches the script as
  input. The camel car's tuning hooks (`craftmatic:vehicle_scheme`,
  `vehicle_camera`) were removed with the camel; only a rotorcraft still
  rides natively (held in `player_relative`).
- **Lights**: at night a light block runs ahead of the nose of any driven
  car, hover craft or boat (no more night vision); the HUD shows `[LIGHTS]`.
- **HUD** is ASCII: the Pixel's HUD font drew the vehicle emoji and U+FE0F
  as empty boxes.

### Wheels, seats, facing

- **Road wheels** (`vehicleWheelAssemblies`): wheel and tyre placements
  whose boxes share at least half the smaller one's volume are one wheel (a
  rim set in along its axle still joins its tyre; twin rear wheels stay two);
  the axle is the box's thinnest side and must be horizontal and across the
  travel axis. 10337 `.io`: 12 placements → 6 wheels (its IOModel2V2 first pick: 10, see the traps); 42172: 8 → 4.
- **Seats**: the model's free seat moulds (not the driver's, none a figure
  sits on) become passenger seats; with none, a car or boat at least 3.5
  blocks long gets passengers behind the driver (one on a car, up to three
  on a ship, a block or two apart).
- **Facing**: a car or boat with a decisively long footprint (≥ 1.3×) keeps
  its nose on the long axis; the votes only choose the end.

### The scripted car on the device (42172, `f06405e7`)

- **GameTest** (`gt-v5/42172/device/`): 8/8 checks. Ahead 30.7 blocks in
  3 s with 0 sideways (top 19.0 blocks/s); coasts 33.6 blocks after release
  (15.6 blocks/s after 2 s; it rolled off the arena's edge and dropped 4.5
  blocks, which the fall handled); reverse 5.0 blocks/s; a held right turn
  155 degrees in 3 s; the boost to 20.8 (40 ticks from rest); lane B's slab
  and step climbed (dy +1); a second rider seated.
- **A real rider** (`real-v5/car-cmvt.txt`): straight stick (y 0.33 → 0.75,
  x ≈ 0): yaw held at exactly 0 while speed rose 1.05 → 14.3 blocks/s;
  released, it coasted 14 → 6 blocks/s over 3 s (the camel stopped dead);
  forward-right (x -0.30 → -0.49): yaw 0 → 10 → 36 → 68, a right turn;
  back (y -0.53): -2.6 → -3.6 blocks/s astern. Against the camel's same
  straight drag (yaw 69 → -125 → -36), the four-scheme A/B that proved no
  scheme could steer it is in `real-v4/scheme-ab-cmvt.txt`.

### Recordings (world 924, 2026-09-25, `recordings/`)

- `cm-car-0925b.mp4` (42172, scripted): 19-33 mph ahead with the chase
  camera straight behind, 18-27 through a forward-right turn, a coast from
  22 to 14 mph, `[REV]` at 6-7 mph, then `[BOOST]` to 45-47 mph.
- `cm-boat-0925b.mp4` / `cm-boatlong-0925b.mp4` (60221, scripted): up to 13
  mph sitting at the waterline, a visible lean in the turn, a stop at the
  bank with `[SHORE AHEAD]`; a boost down the 60-block pool at 22 mph that
  stopped at the far wall.
- `cm-plane-0925b.mp4` (76286, scripted): take-off run to 43 mph and ALT 2
  in about 4 s, a climb to ALT 36 by 11 s, a clear right bank of about 25
  degrees, gentle forward pulses down to ALT 13; the 3D boom kept the ship
  centred through the climb and the bank (the level boom of the earlier
  `cm-plane-0925.mp4` lost it to the frame's edge).
- A touch stick pushed to its rim reads 0.816, not 1 (a full-stick car held
  15.5 of 19 blocks/s): every model now counts 0.8 as full (`STICK_FULL`).
  Jump and the stick together cannot be sent over adb (one pointer), so the
  boost-while-driving in the recordings was a stick press, a lift, a Jump
  tap and a press again.

### Vehicle audit: the 40 favourites and 21 vehicle sets

`bun scripts/_vehicle_audit.ts --md --mirror=http://localhost:4000/ldraw-parts`
(the index's first pick for each set, labelled as the LEGO tab labels it;
`audit.json` beside the packs). Controller: `scripted` = moved by
`scripts/vehicles.js`, `hover` = the Happy Ghast rotorcraft, `camel` = the
native ground controller (only the 10300 time machine and grid-only cars
now). Seats count the driver. Wheels: wheel/tyre placements / spinning
wheel bones. The favourites were audited at `49dfc36d` and every vehicle
row re-run at `f06405e7`; detection is the same code in both.

| set | detected (controller) | nose (source, agreement) | seats | wheels / spinning | size w×h×l blocks | scale | a player would expect |
|---|---|---|---|---|---|---|---|
| 10261 Roller Coaster | static | | | | | 1 | coaster (its own engine) |
| 10303 Loop Coaster | car (scripted, in the scene) | +x (inferred, 100%) | 1 | 3 / 3 | 1.88×3.42×3.55 | 1 | coaster (its own engine); the balloon seller's tricycle rides |
| 10326 Natural History Museum | static | | | | | 1 | building or scenery (static) |
| 10337 Lamborghini Countach 5000 Quattrovalvole | car (scripted) | +x (inferred, 73%) | 2 | 12 / 10 | 2.39×1.38×4.7 | 0.28 | car |
| 10341 NASA Artemis Space Launch System | static | | | | | 1 | static launch tower and rocket |
| 10354 The Lord of the Rings: The Shire | static | | | | | 1 | building or scenery (static) |
| 10365 Captain Jack Sparrow's Pirate Ship | boat (scripted) | +z (inferred, 100%) | 3 | 0 / 0 | 15.63×29.27×28.88 | 1 | ship |
| 11371 Shopping Street | static | | | | | 1 | building or scenery (static) |
| 11374 Arcade Pinball Machine | static | | | | | 1 | building or scenery (static) |
| 21061 Notre-Dame de Paris | static | | | | | 1 | building or scenery (static) |
| 21063 Neuschwanstein Castle | static | | | | | 1 | building or scenery (static) |
| 21318 Tree House | static | | | | | 1 | building or scenery (static) |
| 21360 Willy Wonka & the Chocolate Factory | static | | | | | 1 | building or scenery (static) |
| 31141 Main Street | static | | | | | 1 | building or scenery (static) |
| 41395 Friendship Bus | car (scripted) | -z (inferred, 100%) | 2 | 8 / 4 | 1.96×2.77×3.9 | 0.29 | bus |
| 41703 Friendship Tree House | static | | | | | 1 | building or scenery (static) |
| 41732 Downtown Flower and Design Stores | static | | | | | 1 | building or scenery (static) |
| 42172 McLaren P1 | car (scripted) | -x (inferred, 100%) | 2 | 8 / 4 | 4.48×2.13×6.97 | 0.25 | car |
| 42639 Andrea's Modern Mansion | car (scripted, in the scene) | -z (inferred, 67%) | 2 | 8 / 4 | 3.94×1.96×5.7 | 1 | mansion; its car drives |
| 42652 Friendship Tree House Hangout | static | | | | | 1 | building or scenery (static) |
| 42663 Friendship Camper Van Adventure | car (scripted) | -x (inferred, 97%) | 1 | 10 / 6 | 1.73×1.71×3.06 | 0.25 | camper van |
| 42670 Heartlake City Apartments and Stores | static | | | | | 1 | building or scenery (static) |
| 43267 Princess Castle & Royal Pets | static | | | | | 1 | building or scenery (static) |
| 60380 Downtown | car (scripted, in the scene) | -z (inferred, 94%) | 2 | 4 / 4 | 3.26×2.68×3.94 | 1 | town; its food truck drives |
| 60446 Modular Galactic Spaceship | plane (scripted) | +x (inferred, 80%) | 1 | 1 / 0 | 16.62×7.52×14.24 | 1 | spaceship |
| 71040 Disney Castle | static | | | | | 1 | building or scenery (static) |
| 71043 Hogwarts Castle | static | | | | | 1 | building or scenery (static) |
| 75397 Jabba's Sail Barge | hover (scripted) | +x (inferred, 100%) | 4 | 0 / 0 | 13.56×13.47×36.67 | 1 | hover barge (flies in the film) |
| 76269 Avengers Tower | static | | | | | 1 | building or scenery (static) |
| 76286 The Milano Spaceship | plane (scripted) | -z (inferred, 73%) | 1 | 0 / 0 | 30×8.83×16.04 | 1 | spaceship |
| 76417 Gringotts Wizarding Bank – Collectors' E | static | | | | | 1 | bank with a coaster |
| 76419 Hogwarts Castle and Grounds | static | | | | | 1 | building or scenery (static) |
| 76435 Hogwarts Castle: The Great Hall | static | | | | | 1 | building or scenery (static) |
| 76457 Hogsmeade Village – Collectors' Edition | static | | | | | 1 | building or scenery (static) |
| 77092 Great Deku Tree 2-in-1 | static | | | | | 1 | building or scenery (static) |
| 80049 Dragon of the East Palace | static | | | | | 1 | building or scenery (static) |
| 910004 Winter Chalet | static | | | | | 1 | building or scenery (static) |
| 910032 Parisian Street | static | | | | | 1 | building or scenery (static) |
| 910047 Medieval Seaside Market | boat (scripted, in the scene) +1 car | -x (convention, 0%) | 4 | 0 / 0 | 2.7×2.62×6.83 | 1 | market; its rowing boat sails, its cart drives |
| 910049 Adventure in Transylvania | static | | | | | 1 | building or scenery (static) |
| 10295 Porsche 911 Turbo & 911 Targa | car (scripted) | -z (inferred, 100%) | 2 | 10 / 4 | 2.03×1.38×4.5 | 0.27 | car (two in the set) |
| 42143 Ferrari Daytona SP3 | car (scripted) | +z (inferred, 100%) | 1 | 13 / 7 | 3.48×2.5×7.6 | 0.25 | car |
| 76139 1989 Batmobile | car (scripted) | -z (inferred, 100%) | 2 | 9 / 4 | 3.62×1.74×7.2 | 0.25 | car |
| 10242 MINI Cooper | car (scripted) | -z (inferred, 99%) | 2 | 10 / 4 | 3.41×2.28×4.39 | 0.38 | car |
| 75892 McLaren Senna | car (scripted) | -z (inferred, 100%) | 2 | 12 / 4 | 2.7×2.01×7.12 | 1 | car |
| 42128 Heavy Duty Tow Truck | car (scripted) +1 car | -z (inferred, 69%: clear headlights at -z) | 2 | 36 / 6 | 2.16×2.71×7.54 | 0.25 | tow truck |
| 60253 Ice-cream Truck | car (scripted) | -x (inferred, 93%) | 2 | 8 / 6 | 4.74×4.67×8.03 | 1 | van |
| 10277 Crocodile Locomotive | static | | | | | 1 | locomotive (rail engine: fills its display track) |
| 60198 Cargo Train | car (scripted, in the scene) +1 car | +x (inferred, 100%) | 2 | 8 / 4 | 3.28×3.22×7.29 | 1 | train (converted track 90 degrees off); its truck and forklift drive |
| 31109 Pirate Ship | boat (scripted) | -z (inferred, 81%) | 4 | 0 / 0 | 15.46×17.5×21.65 | 1 | ship |
| 60266 Ocean Exploration Ship | boat (scripted) | +x (inferred, 60%) | 4 | 0 / 0 | 8.91×8.25×29.95 | 1 | ship with small boats |
| 60221 Diving Yacht | boat (scripted) | -z (inferred, 36%) | 2 | 0 / 0 | 5.17×3.16×10.65 | 1 | yacht |
| 6286 Skull's Eye Schooner | boat (scripted) | -z (inferred, 37%) | 4 | 0 / 0 | 10.5×22.67×33.88 | 1 | ship |
| 70618 Destiny's Bounty | plane (scripted; craft word, wings) | -x (inferred, 97%) | 1 | 0 / 0 | 9.86×21.17×27.15 | 1 | flying ship |
| 60367 Passenger Airplane | plane (scripted) +6 car | -x (inferred, 100%) | 4 | 4 / 4 | 24.75×8.32×21 | 1 | airliner and airport vehicles |
| 42066 Air Race Jet | plane (scripted) | -z (inferred, 100%) | 1 | 9 / 4 | 7.53×4.7×12.11 | 0.43 | jet |
| 7140 X-wing Fighter | plane (scripted) | -z (inferred, 100%) | 1 | 0 / 0 | 11.63×2.96×12.71 | 1 | starfighter |
| 75301 Luke Skywalker's X-Wing Fighter | plane (scripted) | -z (inferred, 67%) | 1 | 20 / 4 | 14.25×4.84×15.76 | 1 | starfighter |
| 42092 Rescue Helicopter | plane (hover) | -z (inferred, 100%) | 1 | 2 / 0 | 11.77×5.37×12.15 | 0.9 | helicopter |
| 60405 Emergency Rescue Helicopter | plane (hover) | -z (inferred, 60%) | 1 | 0 / 0 | 15.91×5.12×15.34 | 1 | helicopter |
| 10497 Galaxy Explorer | plane (scripted; craft word, wings) | -z (inferred, 100%) | 1 | 12 / 4 | 15.04×6.39×24.9 | 1 | spaceship |
| 10300 Back to the Future Time Machine | car (scripted) | -x (inferred, 100%) | 2 | 8 / 4 | 1.99×3.12×4.69 | 0.26 | time machine |
| 4559 Cargo Railway | car (scripted, in the scene) + driven train | +z (inferred, 100%) | 2 | 12 / 6 | 2.64×3.5×5.1 | 1 | train on its circuit; its truck drives |
| 910044 Wild West Train | static + driven train | | | | | 1 | train on its line |

What the table says (re-run 2026-09-25 evening at `7eb68d47` over 64 sets,
`output/vehicle-0925b/audit-all/` in the vehicle worktree; the first round's
four gaps are closed, see "Second round" below):
- 30 of the 64 sets are static, every one as a player would expect:
  buildings, scenery, 10341's launch tower, the two coasters (their own
  engine) and 10277 (its loco fills its display track). 910044's train and
  4559's train run on their own track as driven trains (not in this table:
  they are coaster types, not `craftmatic_vehicle`).
- Vehicles now found INSIDE scenes: 60380's food truck, 910047's rowing boat
  and hand cart, 42639's car, 60198's truck and forklift, 4559's truck and
  10303's balloon-seller tricycle. No favourite building gained a false one
  (the finder's verdict on every object it judged is in the export warnings,
  `Scene vehicles: …`).
- 70618 and 10497 are planes: a craft word in the title, wings in the parts.
  75397 is a hover craft. 42128's nose is inferred (-z, 69 %) from its clear
  headlights; every other nose in the table is unchanged from the first round.
- 910047's rowing boat has no nose evidence (`convention`): it is nearly
  symmetric end to end.
- Two helicopters keep the native hover controller; every car (the time
  machine included), hover craft, boat and fixed wing is scripted.

### Traps found this round

- **The prod part mirror throttles parallel exports.** Six `_playable_ref.ts`
  runs at once got HTTP 429 for over an hour: 10337 lost 5093/5095 to AABB
  boxes and four 10303 corpus tests failed. Build packs one at a time and
  point every process at a dev server when prod throttles
  (`CRAFTMATIC_LDRAW_MIRROR=http://localhost:4000/ldraw-parts`, or
  `_playable_ref.ts --mirror=`); the 10303 tests then pass (112/112).
- **10337's first pick (IOModel2V2) has its four 5650 rims 38 LDU off their
  15413 tyres** (the `.io` has them seated), so the rig finds 10 wheels there
  and 6 in the `.io`: the rims spin on their own axles, off-centre. A source
  defect, left to the source repair.
- **Teleporting a scripted boat into water** logs six `[Molang][error]
  unable to find member variable .x/.y/.z` lines (the engine's splash; seen
  only on test teleports).
- **The favourites sweep never exercised vehicles**: it labels each pack
  with the bare set number, which no vehicle word matches.
  `bun scripts/_vehicle_audit.ts` labels exports `Name (set-1)` as the LEGO
  tab does. (Since the second round the sweep DOES reach the scene-vehicle
  finder: a bare number is not a vehicle title, so 60380 and 910047 export
  their vehicles in the sweep too.)

### Second round (2026-09-25 evening): the open items closed

Code at `260accca`..`7eb68d47`. Evidence under the vehicle worktree's
`output/vehicle-0925b/` (packs `packs/`, the 64-set audit `audit-all/`,
GameTest variants `gt/`, device logs and recordings `device/`, scene-vehicle
silhouettes `sil/`).

**Classification.**
- *Craft words.* A title with "explorer", "bounty", "voyager", "lander" or
  "orbiter" (not "bounty hunter") names a vehicle whose KIND the parts
  decide (`vehicleKindFromParts`: wings → plane, a hull/oars → boat, road
  wheels → car). Over the index's 10,169 titles the two words that matter
  here occur in 52 titles, every one a vehicle bar the bounty-hunter figure
  packs. 70618: 30 wing placements, 2 boat → plane, nose -x (97 %). 10497:
  35 wing, 12 wheel placements → plane, nose -z (100 %). A craft title whose
  parts say nothing stays static with a warning naming the counts.
- *Hover.* `HOVER_WORDS` (hover…, sail barge, (land)speeder, podracer,
  repulsor, air cushion) makes a vehicle a hover craft whatever its kind;
  75397 keeps its boat geometry (the hull, four seats) and floats.
- *Vehicles inside scenes* (`engine/scene-vehicles.ts`, run only when the
  title names no vehicle): the lowest layer's flat parts are set aside as
  ground, the rest split into separate objects on the compiler's own contact
  rule, a flat floor patch that lies inside ONE small object's footprint is
  glued back to it (a boat's keel plates), an object claims the wheels and
  parts lying wholly inside its box, and it is a car when it stands on ≥ 3
  wheel positions (or 2 with a steering wheel or seat), a boat with ≥ 2 oars
  or a hull/rudder/sail part; ≥ 6 studs long, ≤ 25 % of the scene, no track
  or ride-car part. A car keeps nothing that reaches below its wheels (60380's
  brick separator lay against its side). Measured over the 32 static
  favourites + 4559/60198/910044: 60380 food truck (53 placements), 910047
  rowing boat (76 + 3 aboard) and hand cart (90), 42639 car (131), 10303
  balloon tricycle (48), 4559 truck (91), 60198 truck and forklift; no false
  find in a building (a 4-stud barrow in 41703 is rejected as too small, a
  coaster car as the rail engine's). Silhouettes: `sil/`.
- *42128's nose:* a new facing vote, `headlights`: clear round lamps in the
  outer quarter of one end (a clear lens stacked on a coloured one is part of
  that lamp). 42128: four at -z, none at +z → -z, 69 % with its tail lights
  (+z) against the wheel-count vote. Its radiator grille (six `2412` tiles at
  z −639) and the tow boom at +z agree. No other nose in the 64-set audit
  changed.

**Collision (the swept footprint).** See `docs/physics-architecture.md`
§4.6. Host proof on the serialised runtime (`test/bedrock-vehicle.test.ts`):
a 7-block car driving past a trunk 1.5 blocks off its centre line stops
with its nose at the trunk's face (the same car with a zero half width, i.e.
the old centre-line probe, drives through to x > 14); a taxiing aircraft
stops on a post at its wingtip; a car rests ON a collider plate floor at
2/16 of a block, not a block above it. The device course's new `post`
phase is the same test in Bedrock (results below).

**Hover craft.** `carStep` on `HOVER`; host: off the land and over water it
rides `RIDE_HEIGHT` above the surface and never sinks. GameTest adds an
`over_water` phase.

**Headlights.** One light block ahead of the nose at night (host: placed,
moved cell by cell, removed on dismount; none by day). Cost is measured on
the device by the `msPerTick` field of the telemetry (below).

**Time machine.** A scripted car; its circuits set the top speed through
`VEHICLE_DYNAMIC.topSpeed` (88 mph × 1.03 → 40.5 blocks/s; 150 mph armed →
69 blocks/s) and the HUD line; the jump fires once when the measured speed
along its heading reaches the armed speed (host test with the real script).
The camel components, `CAR_MOVEMENT`, `DASH_ACTION` and the
`vehicle_scheme` / `vehicle_camera` hooks are gone; `vehicle-driver.js` now
ships only with a rotorcraft.

**Trains in GameTest.** The rail runtime takes the same stick hook
(`CoasterRuntimeConfig.inputEvent` = `FLIGHT_INPUT_EVENT`; host test: parked
without it, driven by it for one car id or every train, park-braked after).
`train_<id>_<n>` places the model, boards the lead car and drives it; both
trains pass on the Pixel ("Rail vehicles on the coaster engine" above).

**On the device (Pixel 8 Pro, 2026-09-25).** GameTest, one variant bound in
`cmgametest` at a time (`device/gt-<set>/`, packs at `260accca`):

| set | verdict | the new checks |
|---|---|---|
| 42172 McLaren P1 | PASS 9/9 | post 1.89 off the centre line: stopped at along 4.46 (its nose at the post: 4.52) |
| 4559 truck (in the scene) | PASS 9/9 | post 0.97 off: 4.41 / 4.45 |
| 10300 time machine | PASS 9/9 | post 0.65 off: 4.60 / 4.66; 18 Molang errors from its spark particle (removed at `b470d467`) |
| 75397 sail barge (hover) | PASS 9/9 | post 5.76 off: 4.66 / 4.67; `over_water` 34.65 blocks off the land and over the pool, lowest −1.12 (the pool is a block under the land), never sunk |
| 60221 yacht | PASS 11/11 | post 2.2 off: 4.18 / 4.18 |
| 76286 Milano | FAIL at `260accca`, PASS 7/7 at `1939e916` | the post held (4.98 / 4.98) but it never took off: its 16-block body tilted about its centre at the 12-degree rotation put the tail band into the runway, and every take-off roll stopped. Fixed at `301a579d` (the band tilts about its low end; host test); the reruns are below |
| 4559 / 910044 trains | PASS | see the rail section |

Real rides in world 924 (`device/recordings/`, `cmvt-summary-924.txt`):
- **Headlights** (42172 and 10300 at night): `[LIGHTS]` on the HUD and a
  light block on the ground ahead of the nose, moving with the car. The
  runtime's own time (`msPerTick` in the telemetry) was 2.4-5.4 ms a tick
  driving and 1.0-2.9 idle for the McLaren with its light, 3.5-5.8 for the
  time machine: the light costs one block write per cell crossed.
- **Collision** (10300 at night into a 1 x 1 log post off its centre line):
  it stopped at the post's face with `[BLOCKED: BACK UP]` (hit at the post)
  and reversed away. The McLaren run could not test this: world 924 still
  binds an OLDER McLaren pack (`243f54b1`, built under the label "McLaren
  P1 42172", so it is a different pack uuid), whose script drives the same
  entity type without the footprint; the log shows two CMVT lines a tick.
  Left bound (924's bindings are kept).
- **Colliders count**: the barge's first attempt stopped against another
  placed model's invisible `craftmatic:collider` blocks - the shell's walls
  now stop a vehicle, as they stop a player.
- **Hover**: the barge held y −59 over the grass and over a pond and back,
  never sinking, HUD `HOVER`. Its cost at `260accca` was the finding of the
  round: 13.7-28.7 ms a tick driving (456-912 footprint checks: the whole
  100-block perimeter at four heights, twice or more per tick when turning).
  `301a579d` probes only the leading boundary; the rerun is below.
- **Time machine**: a scripted car at 91 mph (its 40.5 blocks/s top speed)
  with `[TIME CIRCUIT OFF]`, steering with the stick. Its rider sat 3
  blocks above the car: the "present" model carries a 600-LDU pole of
  Technic axles and a whip at its tail, and a model shrunk below player
  size seated its rider on the model's TOP. Fixed at `71312684`: the rider
  sits on the roof over the seat (`roofAtSeatBlocks`; 10300's seat 2.57 →
  0.30 blocks).

Second device session, packs at `b470d467` (`device/gt3-*`, `clip5-75397/`,
`clip6-10300/`):
- **The barge's cost** with only the leading boundary probed (`301a579d`):
  driving straight 68 footprint checks and 2.4-7.0 ms a tick (median 5.2;
  was 456 checks and 13.7-28.7 ms); turning 472 checks, 6.1-15.7 ms (median
  14: a turn swings half of a 100-block perimeter); idle ~2.2 ms. The time
  machine driving straight: 12-36 checks, 1.7-4.5 ms (median 2.9, was
  3.6-8.7). # TODO: a turning barge still costs ~14 ms a tick; if that
  shows as lag on the phone, probe a turn at 1-block spacing along the
  rotation only where the swept arc exceeds a block.
- **75397 GameTest PASS** again (over_water 34.65 blocks, lowest −1.14);
  **10300 PASS** with 0 Molang errors (the spark particle is gone); in 924 it
  held over 60 mph for 16 s with no error line of any kind.
- **76286 Milano**: the tail fix worked - the take-off roll left the ground
  (up 8.2 blocks, 27 blocks/s) - but flown straight it was 110 blocks out by
  its climb, stopped being readable ("Entity being invalid", outside the
  simulated area) and the test threw before its verdict. The course now
  ends the roll once airborne and circles right (`1939e916`); a vehicle
  that stops being readable ends the course with `staysInReach` false.
- **An empty car coasted off**: the time machine, got out of at 91 mph,
  coasted ~200 blocks, ran into terrain that was not loaded and fell 250
  blocks through it. Now an empty car brakes (`CAR.BRAKE`), and no scripted
  vehicle moves where the block under it or at its nose is unloaded
  (`1939e916`, host tests).

Third device session, packs at `1939e916` (`device/gt4-76286/`,
`clip7-10300/`, `recordings/cmv-clip7-10300.mp4`):
- **76286 Milano PASS 7/7** on the circling course: off the ground after a
  27.8-block roll (18.7 blocks/s), +16 blocks in the 1.5 s climb, a 162-degree
  right turn, a descending circle to a landing, then the post (4.98 / 4.98);
  `staysInReach` true, no script error.
- **10300**: the rider now sits ON the car (only the head shows over the roof
  from behind; before, the whole body floated 3 blocks up). Got out of at 91
  mph, the empty car braked at ~14 blocks/s² and stopped ~59 blocks on, on
  the grass at y −60 (session 2: ~200 blocks and a fall to −317).
  2.4-3.7 ms a tick driving, 0 Molang errors. (The telemetry rows after the
  dismount reached only the on-screen log, not the file.)
