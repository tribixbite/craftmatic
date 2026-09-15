# LEGO model → Bedrock add-on — tracker

**Handoff rule:** assume a context switch after every turn. This file holds OPEN
work and the measurements a decision still needs. Completed items are deleted;
history is `git log` (`e405be4`…`7d4898c`) and the "Bedrock playable add-on"
section of `CLAUDE.md`, which carries every hard-won fact (frame, budgets, Pixel
import/command/camera recipe, riding facts). Spec: `docs/bedrock-entity-spec-2026-09-14.md`.

## State (2026-09-15)

The `.mcaddon` vehicle entity is compiled from real part geometry, LDraw
colours, PBR texture sets, round studs, levelled poses, alias-resolved parts,
a chase camera and measured ride speed. Verified in-game on the Pixel 8 Pro
(Bedrock 1.26.45, QA world `smUmxh2eJjw=`) for 10300, 75892, 76240 and 76286:
mount → chase camera, steering, HUD speed, translucent windshield, studs, views
from above with the free camera. Root and `web/` typecheck clean; vitest 1,546
passing (the two `import-nlcd` failures are the live API).

```
lego.ts ─► ui/schem-export.ts ─► Worker: schem-pipeline.ts runSchemPipeline()
   ├─ discoverPlayableComponents()   playable-components.ts  (named submodel ≥ ½ wins)
   └─ buildPlayableAddon()           playable-addon.ts       (behaviour, camera preset, scripts, atlases)
        └─ compileLdrawEntityGeometry()  ldraw-entity-compiler.ts
             level pose → drop detached clusters → prototypes (ldraw-part-prototype.ts,
             from ldraw-part-geometry.ts meshes) → instance (A·R·Aᵀ snap / bone) →
             cull hidden → stud fans → recentre → seat/collision → chunked .geo.json
```
CLI gate: `bun scripts/_playable_ref.ts <model> [out] --label=… [--quality=…]`
(prints `craftmatic-diagnostics.json`). Silhouette: `bun scripts/_entity_silhouette.ts`.
Seat/components probe: `bun scripts/_entity_seat_probe.ts <model> "<label>"`.
Pixel: `scripts/_pixel_shot.sh`, `scripts/_pixel_cmd.sh` (recipe in CLAUDE.md).

## Measurements that still drive decisions

| Model (source) | Profile | Cubes | Cell | Six-view IoU | Notes |
|---|---|---|---|---|---|
| 75892 (OMR) | balanced | 1,848 | 4 LDU | **0.982** | 190/227 placements = `Car.ldr`; seat from `73081` |
| 10300 (IO present) | balanced | 6,049 | 8 LDU | **0.951** | 0 box placements (was 27) |
| 7140 (OMR) | balanced | 4,339 | 4 LDU | 0.964 (2026-09-14, before this round) | not re-measured |
| 76240 (MecabricksLDR) | high | 9,634 | 16 LDU | **0.855** | posed 19.4°, levelled; 2 box placements (`67687`) |
| 76286 (DbixConvV3) | high | 8,539 | 8 LDU | **0.876** | posed 7.2°, levelled; 716 studs need `high` |

Gate is ≥ 0.95 mean. Evidence: `output/bedrock-entity-qa/captures-2026-09-15/`
(`free-*.jpg` from above, `cal-round*.jpg` studs, `sv1.jpg` 56.7 mph, `tm-windshield2.jpg`).

## Open

- [ ] **76240 / 76286 under the silhouette gate on every profile.** Both are
      2,000+-part posed models the cube budget coarsens to 16 / 8 LDU. The
      `heaviestParts` diagnostic names the spend (76240: `70695` ×184 = 920
      cuboids). Levers, in order: per-part prototype simplification for repeated
      small parts; an automatic `high` default above ~1,500 parts (at `balanced`
      the Milano omits ALL studs: 716 > budget 469); analytic templates (spec §7B).
- [ ] **D3 Vibrant Visuals**: MER/normal response never seen on a device that
      renders it (the Pixel runs the classic renderer; pack loads with
      `capabilities:["pbr"]` and no content-log error).
- [ ] **76240 index source**: `MecabricksLDR/76240.ldr` has 135 unknown parts;
      `IO/76240-1.io` is the better source and is what an upload uses. Index
      ranking (clego) should prefer it.
- [ ] **Chase camera has no block collision** (`follow_orbit`): boom is
      `longest + 2.5` blocks at roof height; still clips into a hill parked
      behind the car. A shorter boom while stationary, or `fixed_boom`, untested.
- [ ] Device housekeeping: re-imports of the same pack land in `<name>(1)`,
      `(2)` folders that `adb shell rm` cannot delete; harmless, but the world
      lists must name the NEWEST version (`world_*_packs.json`).

## Hard rules (from the spec)

1. No whole-model voxelization on the entity path; no `poly_mesh`.
2. `getPartDims()` only as an explicit, diagnosed AABB fallback.
3. No Minecraft block colours on the entity path.
4. Nothing silent: every part/print/transparency/pose/cluster degradation lands in
   `craftmatic-diagnostics.json` and the export warning.
5. Don't touch the world-block pipeline, rideability, the DeLorean behaviour or
   the BlockGrid fallback to solve an entity-rendering problem.
6. Compile per unique part once; instance many; preserve exact source transforms.
