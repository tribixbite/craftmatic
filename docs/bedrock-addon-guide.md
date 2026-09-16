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
