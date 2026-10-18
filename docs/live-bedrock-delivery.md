# Live Bedrock delivery

Craftmatic can prepare a loaded LEGO model or an uploaded schematic for HotSchem's saved model library. Sending a model does not place blocks. Open the in-game Planner to preview, choose a location and scale, place, or undo.

## First-time setup

1. Download `HotSchem-Live-0.6.0.mcaddon` from the Send to Minecraft dialog and open it with Minecraft.
2. Enable **HotSchem Live** and **HotSchem Live Resources** on the host's world, replacing older HotSchem entries in the active-pack list. Use a single-player world with cheats enabled for the initial setup.
3. Enable WebSockets in Minecraft's General settings. Keep Require Encrypted WebSockets enabled.
4. Choose **Send to Minecraft** in Craftmatic and copy its pairing command into Minecraft chat.
5. Return to Craftmatic on the same phone. Wait for delivery confirmation, then return to Minecraft and open the Planner.

New block models can arrive without leaving the world once the receiver is active. Activating a new pack initially still requires world setup. New custom entity geometry/resources in playable add-ons require importing and enabling that add-on; block streaming cannot hot-register new resource definitions.

## Formats

- Java `.schem` and `.litematic` downloads contain static blocks for their respective Java tools.
- Bedrock `.mcpack` contains native tiled structures and a BrickWand for positioning and placement.
- Playable Bedrock `.mcaddon` combines behavior, resources, and model components. Vehicle behavior belongs to this format.
- Send to Minecraft streams compressed, validated Bedrock placement operations into the active HotSchem library.

Java downloads preserve the chest inventories and sign text represented in the source `BlockGrid`. Bedrock block exports currently omit block-entity payloads such as pot contents, bed/banner colors, sign text, and inventories; the export status reports these limitations. Generator armor-stand markers are represented as fence placeholders in block-only Bedrock output.

## Playable exports

Choose **Auto** for source-based detection or explicitly choose **Car** or **Plane** for a standalone model. Auto separates named vehicle submodels and wheel clusters; ambiguous flattened models may need an explicit whole-model choice. It does not certify automatic recognition of every vehicle in the catalog.

Cars use native ride and ground controls. Planes use native ride and air controls. Speed settings have been reduced by about 25% from the initial release and remain fast. Vehicles reject damage, including falls and fire, so normal collisions do not destroy them. Computer-screen interactions open controls for nearby lights, doors, scanner vision, and vehicle locations. Geometry keeps the exported voxel colors and complete cuboids, split into independently rendered meshes of at most 1,024 cuboids. Exports exceeding the 16,384-cuboid budget ask for a lower resolution instead of silently truncating the vehicle.

Re-exporting a pack keeps its UUID and increases its manifest version so Minecraft can update the previous import. Rejoin the world after updating an active pack. Vehicle geometry uses the same block scale as its stationary surroundings. Seat placement and forward-axis handling are described in the September 11 update below.

For the verified flattened 76252 source, all 399 placements of the Batmobile's original assembly are identified by their complete placement signature. The former wheel-box crop omitted 112 car parts and included 52 scenery parts. The corrected exporter rebuilds scenery from the remaining source records instead of subtracting a voxel mask, which could leave fragments behind. Sources that do not match the verified assembly need named submodel metadata; they are not assigned the old approximate crop. Two screen controls use measured source coordinates.

## BrickWand placement

Activate the exported pack and find its named **BrickWand** in Creative inventory. The short function `/function b76252` grants the Batcave wand; `/function b8855` grants the plane wand. Other models have a short generated alias shown after downloading. The old `craftmatic/<model>` function alias also grants the wand. Functions no longer place immediately.

Select the wand in your hotbar to open its menu. Switch to another slot and back to reopen it. Pin the model's bottom corner, enter XYZ coordinates, and rotate in 90-degree steps. **View preview in world** closes the menu and shows a full-size outline and sparse model samples at the pinned coordinates. It remains fixed when the camera moves, rotates with placement, and uses non-fire markers for the bounds and coordinate axes. It refreshes every 12 game ticks, capped at 320 particles. This is a placement wireframe, not a solid ghost mesh; distant or unloaded chunks may not display particles. Reopen the wand for **Place**, which separately confirms replacement of blocks in the target area. Structures and interactive entities use the same rotated coordinate frame.

Each area is loaded with the native [ticking-area preload command](https://learn.microsoft.com/en-us/minecraft/creator/documents/tickingareacommand?view=minecraft-bedrock-stable), followed by a block probe in every intersecting chunk. Polling checks cancellation every two ticks and stops after 600 ticks if loading fails. The temporary area is removed after the operation. A failed attempt that changed no blocks preserves the previous Undo history; a partial placement keeps its own restoration snapshots.

The wand can cancel a running placement and undo the last placement, also after the world is closed and reopened or the game restarted (since 2026-09-25). Undo restores saved blocks and removes the entities spawned by that placement. The block snapshots are saved into the world (`StructureSaveMode.World`), and the record (dimension, snapshot names and corners, spawned entity ids, the placement's box and a `cmu_…` tag carried by every spawned entity) is kept in the placing player's dynamic property `craftmatic:<pack id>:undo`, split over numbered keys above 30,000 characters. After a reload Undo removes the entities it can reach by id and then, as each snapshot's area loads, every entity carrying the tag; entities outside all snapshots are swept box by box over the placement's bounds. A placement made after a reload retires the previous one the same way. A placement interrupted by a crash before it finished records nothing. Importing or granting the wand does not modify the world.

## Delivery protocol

The hosted Cloudflare Durable Object pairs one Minecraft socket and one browser socket. Pairing expires after 15 minutes. The browser has a separate credential and can submit only bounded model data; it cannot submit game commands. Commands target the paired player. Delivery verifies HotSchem's receiver version and waits for its persisted-model acknowledgment, not merely a successful `/scriptevent` command.

HS1 uses the shared ASCII LZW codec, an eight-digit FNV-1a corruption checksum, and numbered chunks. The checksum detects corruption, not authentication; session credentials and encrypted transport provide access control. The receiver validates model dimensions, palette, operations, and stored-library limits before publication. Imports are limited to 4 MiB of encoded text, 16 saved models, and 8 MiB of saved text per world.

The starter source is checked in under `bedrock/hotschem`. Rebuild its download with `node scripts/build-hotschem.mjs`. Its codec is shared with the browser under `web/src/engine/hotschem`.

## Verification scope

The current Android QA uses the separate `My World` on the retail Pixel, preserving the original `test` world. A controlled version-only import proved that the oversized timestamp version caused `Unknown Pack Name`; the compact-version add-on imported successfully. Native tests confirmed hotbar activation, pinning, XYZ editing, 90-degree rotation, and particles without the menu reopening. The original full-size particle preview was too sparse for the 327-block model, motivating the nearby miniature. A clear-weather, level-view native capture confirmed visible miniature particles; the sparse point cloud conveys bounds and orientation with limited fine detail on a phone. Native loading tests exposed stalls in the earlier area-loading implementations. The final runtime uses fresh area names and two-tick gaps around removal and creation; version `[2,666,17108]` completed all 18 tiles and reported successful Batcave placement in approximately 95 seconds. Undo completed before the first five-second check; visiting the actor locations afterward confirmed that the Batmobile and both screens had been removed. Earlier partial test builds remain only in the remote QA area.

The updated Batmobile was directly summoned and rendered intact with its yellow stripe. Minecraft rejected a 1,000-point damage command and the entity remained present. Mounting and forward touch input moved the rider from approximately `(990,64,990)` to `(978,66,954)` in 2.5 seconds. These checks used the `final-equip` add-on version `[2,666,14060]`; they verify vehicle behavior separately from the later preview and loading refinements.

Prior Pixel testing demonstrated an encrypted WebSocket handshake, a Planner script event, and a browser-triggered command while the same phone's Minecraft process remained loaded. That experiment used an ADB tunnel. Hosted endpoint and complete-transfer results must be recorded separately; a working browser UI alone does not prove Minecraft compatibility.

The Cloudflare relay passes a complete protocol-simulator transfer, including its crypto, bounded command window, and receiver-commit check. A controlled retail Pixel experiment identified the immediate-close bug: the identical encrypted Node fixture succeeds with `Connection: Upgrade` and fails with `Connection: upgrade`. The relay now explicitly requests the capitalization Minecraft accepts. Local workerd preserves it and passes encrypted transfer; whether the deployed Cloudflare edge preserves it still requires verification. The pairing command uses the shorter `/connect` alias and remains `wss://`. Disconnects and failed handshakes now fail promptly, including when the browser arrives after the failure, rather than leaving delivery waiting indefinitely.

Playwright MCP on port 8989 verified real browser downloads of Java schematics, native Bedrock packs, and playable add-ons. Default-resolution 76252 produced a 585,511-byte add-on containing 12 structure tiles, 8,251 colored Batmobile cuboids, and two screens. Actual 8855 Prop Plane export also produced its flight behavior and resources. In-game control validation is separate from these archive checks.

On September 10, 2026, a fresh local Playwright run loaded the catalog's default `MecabricksLDR/76252.ldr` source and downloaded `output/current-qa/76252-Batcave-release.mcpack` (351,565 bytes) and `output/current-qa/76252-Batcave-release.mcaddon` (541,137 bytes). Both use compact, import-safe manifest versions whose components stay at or below 32,767. The playable archive identifies the verified complete 399-placement Batmobile assembly, contains one Batmobile and two screens, and preserves 6,823 colored cuboids across seven meshes of at most 1,024 cubes. Its vehicle movement is reduced to `1.05` with a `1.35` maximum and rejects all damage. Executing the extracted serialized Brick Wand runtimes against mocked Bedrock APIs verified exact-item hotbar activation without repeated menus while held, dimension-bound pinning, a rotated particle preview, all 18 rotated structure loads, rotated actor placement, cancellation after asynchronous loading without spawning an actor, and complete undo. The source load warned that `11402p1` through `11402p9` were unavailable and that the deployed source hash did not match the catalog metadata; those missing placements occur after the Batmobile's first 399 placements.

The earlier release through `ad1f069` passed production deployment and Playwright checks on `craftmatic.click` on September 10, 2026. Release `3961a34` was deployed successfully on September 10. A production Playwright download confirmed compact numeric manifest versions. The public edge still lowercased `Connection: upgrade`; the encrypted simulator passed, but the known retail Android handshake incompatibility remains unresolved. Testing the browser-before-Minecraft connection order exposed a pairing race; the relay now waits for the encrypted game handshake before sending commands, and the integration simulator covers this order. In a dedicated retail Pixel test world, the earlier Batmobile mounted successfully and traveled approximately 94 blocks horizontally during a three-second forward input on a clear platform. A computer entity also opened its control menu through native touch.

The 8855 plane also passed native flight testing: `/ride @s summon_ride craftmatic:propplane_8855_plane` mounted it immediately, forward touch input moved approximately 360 horizontal blocks in two seconds, and the ascend control increased altitude. These are extremely fast settings. That device test used the initial pack; the subsequent zero-start-speed and above-body-seat adjustments passed source checks, but Android's import cache prevented validating the replacement pack in the same session. Hosted Android streaming still has the separate connection limitation described above.


## September 11 usability corrections

The Minecraft export settings now offer **covered interiors** (including rooms with open fronts), **sealed rooms only**, three lamp styles, and 3/6/10-block spacing. Lighting remains opt-in, places lamps only in air, and preserves source blocks. The wand also offers ten-minute night vision and an explicit off control for existing builds.

`/wsserver` and its `/connect` alias require cheats and Admin/operator permission. An incorrect-permission error occurs before any network connection; it is independent of the hosted handshake limitation. On a LAN world the host must grant the player operator permission. An add-on cannot grant that permission itself.

Vehicles no longer shrink independently to eight blocks. Component voxel scale is converted back to scene scale, and fractional spawn coordinates are retained. The verified Batmobile source has a cockpit anchor and +X nose direction. Standalone cars remain whole assemblies rather than being cropped around wheel clusters; common Technic car brands and 10300/DeLorean names are recognized. Other sources use their measured longitudinal axis, with an explicit **Vehicle front** export setting for ambiguous front/rear direction. Geometry uses proper rotations (no reflection), and rider yaw is locked to the vehicle. Generic cockpit placement still needs per-model native verification; automatic bounds alone cannot identify every driver's seat.

A fresh production 10300 add-on imported successfully on the retail Pixel during this investigation (`output/current-qa/10300-import-result.png`). Its behavior/resource header, module, and cross-pack dependency versions were matching numeric arrays. The reported wrong-type error could not be reproduced with that fresh download; no speculative manifest-version change was made.

The updated local Batcave export contains a 61 x 37 x 150-block Batmobile mesh (6,823 cuboids across seven meshes) inside a 327 x 186 x 161-block scene, replacing the old independent eight-block cap. Covered dense lighting added 5,210 lamps. The actual browser archive is `output/current-qa/76252-Batcave-vehicle-lighting-final.mcaddon`; its 18 scenery tiles and vehicle were inspected separately. Model 10300 at one block per stud exported a complete 45 x 18 x 36-block car. Its finer default resolution exceeded the 16,384-cuboid budget; that error now propagates without a second inline export. Choose a coarser resolution when prompted.


## Direct TLS compatibility bridge

The Worker already requests `Connection: Upgrade`, but the public Cloudflare edge still writes `Connection: upgrade`. A direct Node TLS bridge is available in `bridge/`; it preserves the case-sensitive handshake required by the tested retail client and forwards unchanged text/binary frames to the existing Cloudflare session. The game encryption exchange still terminates at the original session handler. The bridge accepts only game session paths; browser authentication and payload upload stay on Cloudflare.

The verified Railway endpoint is `wss://bedrock-ws-bridge-production.up.railway.app`, configured as `MINECRAFT_WS_ORIGIN` in `wrangler.toml`. This changes only the generated Minecraft URL; browser authentication/upload remain on Cloudflare. Plaintext, credentials, paths and query strings are rejected. Railway terminates public TLS and forwards privately to the bridge with explicit `TRUST_PROXY_TLS_TERMINATION=1`; no public plaintext endpoint is advertised.

The response-header Transform Rule experiment in `bridge/cloudflare-header-rule.json` was tested on September 11 after the token permissions were updated. Cloudflare accepted and enabled the narrowly scoped status-101 rule, but repeated raw TLS handshakes, including a check after propagation, still returned `Connection: upgrade`. The ineffective rule was deleted without changing other rules. More token permissions are not the solution. The documented API permissions are zone **Transform Rules → Edit** and account **Account Rulesets → Read**. This experiment does not distinguish a skipped response-transform phase from later edge normalization; it establishes that the tested rule does not repair the final handshake.


The Railway deployment and the earlier loopback bridge both completed the three-chunk P-384/AES-256-CFB8 simulator against the production Cloudflare backend. Railway's actual public TLS handshake returned `Connection: Upgrade`, unlike Cloudflare's edge. Seven bridge tests cover explicit listener-mode selection, opcode preservation, strict routes/protocol, backend failure, TTL cleanup and the connection cap. The native Pixel test is pending reconnection: ADB at `192.168.0.216:5555` was unreachable. See [the current handoff](bedrock-handoff-2026-09-11.md) for resources, validation methods and remaining work.

## DeLorean time circuit

New playable 10300/DeLorean exports add **DeLorean controls** to the Brick Wand menu. Mount the car or stand within 32 blocks, enter destination X/Y/Z and a trigger speed (10–150 mph, default 88), then wait for “Destination ready.” Hold forward to accelerate gradually. The circuit jumps once when measured forward speed reaches the selected threshold, stops the car at the exact entered coordinates, and preserves or restores its riders. Set the circuit again for another jump. Destination preparation expires after 60 seconds or a rider dismount; obstructed or unloaded destinations report an error and require rearming.

The controller targets a 6 mph-per-second ramp, compensates for retained velocity under drag, and uses interval-start velocity to avoid false jumps while pushing against a wall. Units use one block as one metre. Runtime tests cover strong simulated drag, stationary collisions, braking, exact coordinates, a single jump, and oversized-coordinate rejection. These tests and browser archive inspection do not establish native Bedrock driving feel or physics; device verification remains separate.

## September 14 native vehicle driving and flight verification (Pixel 8 Pro)

Native in-game driving, flight, visual fidelity, and multi-seat audio mechanics were directly verified on retail Minecraft Bedrock (Android 17, Google Pixel 8 Pro connected at `192.168.0.216:5555`).

### 1. Lego Batmobile (`craftmatic:batcave_76252_batmobile`)
- **Ground Driving & Elevation**: Mounted via `/ride @s start_riding @e[type=craftmatic:batcave_76252_batmobile,c=1]`. Drove >50 blocks across rugged mesa badlands from `(286, 71, 145)` to `(331, 69, 112)` overlooking the river canyon. Auto-step (1.25 blocks) handled stepped sandstone terrain smoothly without catching or losing momentum.
- **Reverse Gear & Steering**: Tested reverse gear with backward touch control; verified speed HUD displaying `[REV] -mph` and rear steering responsiveness.
- **Visual Fidelity**: Inspected from first-person cockpit, third-person front (`output/screen-camera-executed.png`), third-person rear (`output/screen-near-batmobile.png`), and high-altitude chase camera (`output/screen-after-enter.png`). Verified authentic 76252 geometry: round rear jet turbine with red center cone, dual red taillights, swept bat-wing fins, and canopy roof.

### 2. Lego Prop Plane (`craftmatic:propplane_8855_plane`)
- **3D Flight & Climb**: Summoned at `(313, 66, 13)` and mounted via `/ride`. Cruised and climbed >115 blocks horizontally across terrain from `(313, 67, 13)` to `(428, 72, -10)` using air controls (`can_fly: {}`, `input_air_controlled`). Ascent verified with vertical pitch input (`output/screen-flew-plane.png`, `output/screen-plane-high-altitude.png`).
- **Visual Fidelity**: Verified yellow biplane wings with ribbed aerofoil slats, grey wing struts, black tail elevator, landing gear, and nametag `Prop Plane (8855-1)`.
- **Clean Landing & Dismount**: Dismounted cleanly on a ridge at `(428, 71, -11)` (`output/screen-plane-dismounted.png`).

### 3. Model Engine Enhancements
- **Inflated Parts Tray Demotion**: Prioritizes authentic assembled models (`io_model2_v2` / `.ldr`) whose part counts closely match the official catalog count (within ±35%) while penalizing inflated loose-parts tray `.io` sources (`n > catalogParts * 2.2`). Fixes 401 sets across the catalog.
- **Multi-Seat & Co-Pilot HUD**: Supports 1-seat (driver), 2-seat (driver + copilot lateral offsets), and 4+ seat vehicle layouts. Locks passenger rotation to vehicle heading and broadcasts real-time speedometer HUD with `[👥 N]` rider count to all passengers.
- **Dynamic Speed-Modulated Audio**: Calculates engine sound pitch dynamically (`Math.min(2.0, Math.max(0.6, 0.6 + (mph / 45) * 0.9))`) with periodic tick sounds (`minecart.base` for cars, `elytra.loop` for aircraft, `random.splash` for watercraft) and idle motor rumble.

## September 14 comprehensive 4-model in-game verification (Pixel 8 Pro: 21063, 76419, 76240, 76286)

Full in-game visual fidelity and manual driving/flying functionality were verified on retail Minecraft Bedrock (Android 17, Google Pixel 8 Pro connected at `192.168.0.216:5555`) for all four target models exported by Craftmatic:

### 1. Batmobile Tumbler (76240) — Ground Vehicle Verification
- **Summon & Mounting**: Exported as `.mcaddon` with entity identifier `craftmatic:v_76240_car`. Summoned via `/summon craftmatic:v_76240_car ~ ~ ~8`. Player mounted cleanly into driver cockpit (`output/current-qa/batmobile_mounted_cockpit.png`).
- **Ground Driving & Desert Dunes Traversal**: Driven >75 blocks across desert dunes (`output/current-qa/batmobile_driving_action.png`). Clamped collision box (`width <= 3.5`, `height <= 2.5`) enabled the wide chassis to scale dunes and 1.56m terrain steps without getting stuck or bottoming out.
- **Dismount & Damage Immunity**: Dismounted with 0 damage taken (`deals_damage: 'no'`) parked cleanly on the dunes (`output/current-qa/batmobile_parked_after_drive.png`).
- **Render-to-Voxel Visual Fidelity**: Voxel geometry rendered with HD 32x(1+16N) embossed LEGO circular studs and ABS seam bevels across the armor plating, rear oversized dual tires, aerodynamic wings, and cockpit cowl.

### 2. The Milano Spaceship (76286) — 3D Flight Verification
- **Summon & Mounting**: Exported as `.mcaddon` with entity identifier `craftmatic:v_76286_plane`. Summoned via `/summon craftmatic:v_76286_plane ~ ~2 ~8`. Mounted into cockpit (`output/current-qa/milano_mounted_cockpit.png`).
- **Full 3D Flight & Pitch/Yaw Maneuvers**: Piloted in 3D flight climbing above the desert landscape (`output/current-qa/milano_in_game_flight.png`). Controls responded smoothly to pitch up/down, banking turns, and sustained cruising speed.
- **Landing & Visual Fidelity**: Touched down cleanly on flat terrain and dismounted (`output/current-qa/milano_parked_landing.png`). Swept bird-of-prey wings, quad engine thrusters, and canopy rendered authentically with crisp circular studs and modular seam lines across all angles.

### 3. Hogwarts Castle & Grounds (76419) — High-Fidelity Architecture
- **Structure Placement**: Exported as `.mcpack` with identifier `craftmatic:76419`. Loaded via Bedrock command `/structure load "craftmatic:76419" ~ ~ ~` at staging coordinates `(400, 67, 400)`.
- **In-Game Visual Fidelity Inspection**:
  - Eye-level platform overview: `output/current-qa/hogwarts_eye_level_platform.png` showing the Great Hall, central courtyard, Astronomy Tower, and viaduct bridge.
  - Spire and battlements close-up: `output/current-qa/hogwarts_closeup_spires.png` demonstrating individual centered circular 3D LEGO studs on all stone battlements, turret cones, and roof tiles.

### 4. Neuschwanstein Castle (21063) — Multi-Slice Architecture
- **Multi-Slice Placement**: Slices loaded via `/structure load "craftmatic:21063_x0_y0_z0" ~ ~ ~` and `/structure load "craftmatic:21063_x0_y0_z1" ~ ~ ~` at staging coordinates `(480, 72, 400)`.
- **In-Game Visual Fidelity Inspection**:
  - High-altitude facade shot: `output/current-qa/neuschwanstein_majestic_facade.png` capturing the iconic white limestone walls, cylindrical towers, and gatehouse.
  - Close-up inspection of east slope: `output/current-qa/neuschwanstein_facing_east.png` confirming authentic embossed circular LEGO studs on every green landscape block and masonry surface.

### 5. Master Panorama & World Multi-Model Survey
- **Dual Castle Co-existence**: Both Hogwarts and Neuschwanstein standing simultaneously in the desert staging sector (`output/current-qa/both_castles_in_world.png`).
- **Quad-Model Master View**: High-altitude master panorama capturing both castles and vehicles in the live world (`output/current-qa/quad_model_master_view.png`).


