# LEGO model → Bedrock add-on — tracker

**Handoff rule:** assume a context switch after every turn. This file holds OPEN
work and the measurements a decision still needs. Completed items are deleted;
history is `git log` (`e405be4`…) and the "Bedrock playable add-on" section of
`CLAUDE.md`, which carries every hard-won fact (frame, budgets, Pixel
import/command/camera recipe, riding facts, the 2026-09-15 device round).
Spec: `docs/bedrock-entity-spec-2026-09-14.md`.

## State (2026-09-15, second device round)

Verified on the Pixel 8 Pro (Bedrock 1.26.45, QA world `smUmxh2eJjw=`) with
75892 (car) and 7140 (plane), captures in
`output/bedrock-entity-qa/captures-2026-09-15b/`:
- nose inferred from parts (`vehicle-facing.ts`): Senna's tail lights face the
  chase camera, X-wing engines toward the camera (`quad2.jpg`, `quad5.jpg`);
- joystick left/right steers (`/controlscheme … player_relative` on mount), the
  free chase camera stays behind through turns (`quad2.jpg`);
- Jump = native dash (`dash_action`), Dismount is its own button (`dash3.jpg`);
- aircraft: forward flies, Jump climbs ~17 blocks/s (`quad5.jpg`);
- Brick Wand: ghost preview renders (`ghost4.jpg`), progress bar
  (`progress1.jpg`), placement appears at once (`placed4.jpg`), "Pin centred on
  me" puts the build on the player.
Root and `web/` typecheck clean; vitest 1,585 passing (the two `import-nlcd`
failures are the live API).

```
lego.ts ─► ui/schem-export.ts ─► Worker: schem-pipeline.ts runSchemPipeline()
   ├─ discoverPlayableComponents()   playable-components.ts  (named submodel ≥ ½ wins)
   └─ buildPlayableAddon()           playable-addon.ts       (behaviour, presets, scripts, atlases, ghost)
        ├─ compileLdrawEntityGeometry()  ldraw-entity-compiler.ts
        │    level pose → drop detached clusters → inferVehicleNose (vehicle-facing.ts) →
        │    prototypes → instance → cull hidden → stud fans → recentre → seat/collision → .geo.json
        └─ buildPreviewGhost()           bedrock-preview-entity.ts (scene occupancy → ≤1,536 cuboids)
```
CLI gate: `bun scripts/_playable_ref.ts <model> [out] --label=… [--quality=…] [--camera=orbit|boom]`
(prints `craftmatic-diagnostics.json`, incl. `facing.votes`). Silhouette:
`bun scripts/_entity_silhouette.ts … --out=<dir>` (side view: nose must be on
the LEFT). Pixel helpers: `scripts/_pixel_shot.sh`, `scripts/_pixel_cmd.sh`.
**Use a label whose stem does not start with a digit** (`--label="McLaren Senna"`,
not `"75892 …"`): Bedrock rejects digit-leading identifiers.

## Measurements that still drive decisions

| Model (source) | Profile | Cubes | Cell | Six-view IoU | Notes |
|---|---|---|---|---|---|
| 75892 (OMR) | balanced | 1,840 | 4 LDU | **0.981** | nose −z (steering wheel + windscreen + tail lights) |
| 10300 (IO present) | balanced | 6,042 | 8 LDU | **0.953** | nose −x (tail lights + windscreen) |
| 7140 (OMR) | balanced | 4,933 | 4 LDU | 0.964 | nose −z (seated pilot + canopy) |
| 76240 (MecabricksLDR) | balanced | 3,569 | 16 LDU | 0.839 | nose −z (2 vs 4 wheels); `high` 0.855 |
| 76286 (DbixConvV3) | balanced | 5,674 | 8 LDU | 0.871 | nose −x (narrow end, agreement 1.0); `high` 0.876 |

Gate is ≥ 0.95 mean. `IO/76240-1.io` is a flat parts grid, NOT a model — the
Mecabricks LDR is the only real 76240 source.

## Open

- [ ] **76240 / 76286 under the silhouette gate on every profile.** Lever not
      yet tried: lossless merge of same-material, face-adjacent body cuboids
      after `cullHiddenCuboids` (union unchanged, fewer cubes ⇒ finer microcell
      survives the budget loop). Then per-part simplification for repeated small
      parts (`heaviestParts`), analytic templates (spec §7B).
- [ ] **76240 unresolved parts**: the Mecabricks LDR has 135 unknown part
      names; at `balanced` 2 placements render as boxes (`67687`). Census the
      `unresolvedParts` of the golden models and route filename aliases to
      `ldraw-part-aliases.ts`, frame-changing ones to clego.
- [ ] **Device-verify 76240 and 76286 themselves** (facing, steering at 3.5-wide
      collision box, Milano climb) — this round verified the mechanism on 75892
      and 7140; the heavy packs were not re-imported.
- [ ] **Dive / look-pitch on aircraft** and swipe-to-look were not testable over
      adb (`input swipe` on the look area did nothing); check by hand.
- [ ] **Molang errors `unable to find member variable .r/.g/.b`** appeared in the
      content-log UI while mounting the X-wing (not in the pulled log file yet);
      source unknown (render controller? vanilla ride UI?).
- [ ] **D3 Vibrant Visuals**: MER/normal response never seen on a device that
      renders it (the Pixel runs the classic renderer).
- [ ] Chase camera (`minecraft:free`, script) has no block collision; the
      `_chase`/`_boom` presets still ship but are only used for aircraft.
- [ ] Device housekeeping: stale pack folders `75892McLar`, `7140X-wing`,
      `McLarenSen(1..3)`, `X-wingStar(1)` on the Pixel (`adb shell rm` denied);
      the QA world lists the newest versions. Content log file + UI are ON in
      the Pixel's Creator settings (leave on; logs land in
      `games/com.mojang/logs/`).

## Hard rules (from the spec)

1. No whole-model voxelization on the entity path; no `poly_mesh`.
2. `getPartDims()` only as an explicit, diagnosed AABB fallback.
3. No Minecraft block colours on the entity path.
4. Nothing silent: every part/print/transparency/pose/cluster degradation lands in
   `craftmatic-diagnostics.json` and the export warning.
5. Don't touch the world-block pipeline, rideability, the DeLorean behaviour or
   the BlockGrid fallback to solve an entity-rendering problem.
6. Compile per unique part once; instance many; preserve exact source transforms.
