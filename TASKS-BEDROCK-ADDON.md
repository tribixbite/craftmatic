# LEGO model → Bedrock add-on — tracker

**Handoff rule:** assume a context switch after every turn. This file holds OPEN
work and the measurements a decision still needs. Completed items are deleted;
history is `git log` (`e405be4`…) and the "Bedrock playable add-on" section of
`CLAUDE.md`, which carries every hard-won fact (frame, budgets, Pixel
import/command/camera recipe, riding facts, the 2026-09-15 device round).
Spec: `docs/bedrock-entity-spec-2026-09-14.md`.

## State (2026-09-15, second device round)

Verified on the Pixel 8 Pro (Bedrock 1.26.45, QA world `smUmxh2eJjw=`) with
75892, 7140, and the user's own 76240 and 76286, captures in
`output/bedrock-entity-qa/captures-2026-09-15b/`:
- nose inferred from parts (`vehicle-facing.ts`): Senna tail lights and Tumbler
  rear wheels face the chase camera, X-wing engines toward it (`quad2.jpg`,
  `quad5.jpg`, `quad8.jpg`);
- joystick left/right steers (`/controlscheme … player_relative` on mount), the
  free chase camera stays behind through turns (`quad2.jpg`; Tumbler
  `quad8.jpg` top row: +10 blocks forward, then a ~90° turn);
- Jump = native dash (`dash_action`), Dismount is its own button (`dash3.jpg`);
- aircraft: forward flies where the rider looks (the Milano dived 26 blocks
  while looking down, `quad8.jpg` bottom row), Jump climbs ~20 blocks/s;
- Brick Wand: ghost preview renders (`ghost4.jpg`), progress bar
  (`progress1.jpg`), placement appears at once (`placed4.jpg`), "Pin centred on
  me" puts the build on the player.
Prod part census (`check-missing-parts.mjs`): 7140 clean; 76240 `67687`×2 now
aliased to `4600` and `30426`×1 unresolved; 76286 `28710`×1 unresolved; 10300
`x346`×2 + one light-brick subassembly (its `.io` CustomParts cover the rest).
`30426` / `28710` / `x346` exist in neither the official nor the unofficial
LDraw library. Root and `web/` typecheck clean; vitest 1,596 passing (the two
`import-nlcd` failures are the live API).

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

Silhouette gate (`_entity_silhouette.ts`, six views, px 512). **`IoU kept`** scores
the emitted cuboids against the placements the compiler actually kept — the
approximation quality the gate is for; **`IoU full`** scores them against the
whole component, so the difference is what the entity leaves out (display
stand, plaque minifigs, buried pins). Before 2026-09-15 only the full score was
reported and the stand drop was silent, which is why the two big models read
0.84/0.87: 76240's base plate and figures were 20 % of the front silhouette.

| Model (source) | Profile | Cubes | Cell | IoU kept | IoU full | Left out (stand / detached / internal) |
|---|---|---|---|---|---|---|
| 75892 (OMR) | balanced | 1,840 | 4 LDU | 0.981 | 0.981 | 0 / 0 / 0 (wind tunnel excluded upstream by the submodel rule) |
| 10300 (IO present) | balanced | 6,071 | 8 LDU | 0.981 | 0.953 | 0 / 3 / 47 |
| 7140 (OMR) | balanced | 4,754 | 4 LDU | 0.960 | 0.960 | 0 / 0 / 0 |
| 76240 (MecabricksLDR) | balanced | 3,225 | 32 LDU | **0.957** | 0.840 | 135 / 0 / 210 |
| 76240 | high | 9,201 | 16 LDU | **0.969** | 0.849 | 135 / 0 / 210 |
| 76286 (DbixConvV3) | balanced | 5,478 | 8 LDU | **0.966** | 0.873 | 93 / 10 / 17 (716 studs omitted) |
| 76286 | high | 8,342 | 8 LDU | **0.969** | 0.876 | 93 / 10 / 17 |

Gate is ≥ 0.95 on `IoU kept`: every golden model passes on `balanced`. Cell
size is NOT what limits the full score — 76240 at `ultra` (39,189 cubes, 4 LDU)
still reads 0.854 full. The lossless same-colour cuboid merge
(`mergeAlignedCuboids`) removed 225–267 cubes on 76240 (6–7 %), not enough to
change its cell; the tractor tyre `70695` ×184 is 47 % of its budget.
`IO/76240-1.io` is a flat parts grid, NOT a model — the Mecabricks LDR is the
only real 76240 source.

## Open

- [ ] **Repeated-part budget** (76240: `70695` ×184 = 4,416 cubes at 16 LDU):
      a stricter per-part cube cap for parts with many placements would let the
      whole model keep a finer cell. Not started.
- [ ] **A ground vehicle summoned at a shoreline stays put**: the Tumbler at
      (−94, 63, 189) in shallow water / against sand steps read 0.0 mph on
      every input; the same entity on grass drove and turned. Whether that is
      the 3.5×2.5 collision box wedged in blocks or water drag is not measured.
- [ ] **Swipe-to-look** was not testable over adb (`input swipe` on the look
      area did nothing); check by hand.
- [ ] `30426` (76240 ×1), `28710` (76286 ×1), `x346` (10300 ×2): design ids with
      no LDraw part in either library; identify the LDraw mould and add
      filename aliases, or leave as the documented residue.
- [ ] **Molang errors `unable to find member variable .r/.g/.b`** appeared in the
      content-log UI while mounting the X-wing (not in the pulled log file);
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
