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
- Bedrock `.mcpack` contains native tiled structures and a placement function.
- Playable Bedrock `.mcaddon` combines behavior, resources, and model components. Vehicle behavior belongs to this format.
- Send to Minecraft streams compressed, validated Bedrock placement operations into the active HotSchem library.

Java downloads preserve the chest inventories and sign text represented in the source `BlockGrid`. Bedrock block exports currently omit block-entity payloads such as pot contents, bed/banner colors, sign text, and inventories; the export status reports these limitations. Generator armor-stand markers are represented as fence placeholders in block-only Bedrock output.

## Playable exports

Choose **Auto** for source-based detection or explicitly choose **Car** or **Plane** for a standalone model. Auto separates named vehicle submodels and wheel clusters; ambiguous flattened models may need an explicit whole-model choice. It does not certify automatic recognition of every vehicle in the catalog.

Cars use native ride and ground controls. Planes use native ride and air controls. Both use fast movement settings. Computer-screen interactions open controls for nearby lights, doors, and vehicle status. Geometry keeps the exported voxel colors and complete cuboids; exports exceeding the 16,384-cuboid budget ask for a lower resolution instead of silently truncating the vehicle.

For the verified flattened 76252 source, the wheel-based selection identifies a 339-placement Batmobile separately from the 3,976-placement Batcave and attaches two screen controls to measured source coordinates. Component geometry is removed from the static scenery and spawned separately.

## Delivery protocol

The hosted Cloudflare Durable Object pairs one Minecraft socket and one browser socket. Pairing expires after 15 minutes. The browser has a separate credential and can submit only bounded model data; it cannot submit game commands. Commands target the paired player. Delivery verifies HotSchem's receiver version and waits for its persisted-model acknowledgment, not merely a successful `/scriptevent` command.

HS1 uses the shared ASCII LZW codec, an eight-digit FNV-1a corruption checksum, and numbered chunks. The checksum detects corruption, not authentication; session credentials and encrypted transport provide access control. The receiver validates model dimensions, palette, operations, and stored-library limits before publication. Imports are limited to 4 MiB of encoded text, 16 saved models, and 8 MiB of saved text per world.

The starter source is checked in under `bedrock/hotschem`. Rebuild its download with `node scripts/build-hotschem.mjs`. Its codec is shared with the browser under `web/src/engine/hotschem`.

## Verification scope

Prior Pixel testing demonstrated an encrypted WebSocket handshake, a Planner script event, and a browser-triggered command while the same phone's Minecraft process remained loaded. That experiment used an ADB tunnel. Hosted endpoint and complete-transfer results must be recorded separately; a working browser UI alone does not prove Minecraft compatibility.

The deployed Cloudflare relay passes a complete protocol-simulator transfer, including its crypto, bounded command window, and receiver-commit check. Actual retail Pixel hosting remains under investigation: `wss://` has not reached the relay and `ws://` attempts have disconnected during setup. The production pairing command remains `wss://`. The UI does not report a successful delivery for these failures.

Playwright MCP on port 8989 verified real browser downloads of Java schematics, native Bedrock packs, and playable add-ons. Default-resolution 76252 produced a 585,511-byte add-on containing 12 structure tiles, 8,251 colored Batmobile cuboids, and two screens. Actual 8855 Prop Plane export also produced its flight behavior and resources. In-game control validation is separate from these archive checks.
