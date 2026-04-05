# Coit Creative Arts Academy — Iteration State

## Building
- Address: 617 Coit Ave NE, Grand Rapids, MI 49503
- Type: School complex — multi-wing brick institutional, flat roofs, mixed eras (~12m height)
- OSM: way/223060418 (building=school)
- Coords: 42.9742448, -85.6653327
- Pipeline: resolution=2, maskDilate=0, modePasses=3, --no-enu

## Divergences (model vs reality)

| # | Issue | Category | Penalty | Fixable? |
|---|-------|----------|---------|----------|
| 1 | gray_concrete dominant (73%) — real is tan+red brick | Color | !surface_detail | Yes (desat/gamma) |
| 2 | Neighbor structures in footprint | False positive | -2 | Yes (OSM ID) |
| 3 | Wing edges jagged — real has clean 90° corners | Geometry | footprint | Yes (edge straighten) |
| 4 | Floating artifacts at edges | Cleanup | -1 | Yes (component threshold) |
| 5 | Height too low (6.5m vs 8-12m) | Source data | -1 | No (Tiles LOD) |
| 6 | No height differentiation between wings | Source data | n/a | No |
| 7 | No window grid patterns | Resolution | n/a | No (2 block/m) |

## Baseline (v307)
- Score: **8/10** [7, 8, 10]
- Diagnosis: footprint(1.3/2), massing(0.7/1), identity(1.3/2)
- Key defect: false_positives_merged 2/3 runs → -2 penalty
- Blocks: 12,742 | Palette: 14

## Iteration Log

### Iteration 1 (v308) — Explicit OSM ID
- Change: Added `osmId: 'way/223060418'` to building config
- Target: Eliminate false_positives_merged penalty (-2)
- Result: **7/10** [8, 7, 7] — No effect. Proximity search already found same building.
- Blocks: 12,742 (identical). false_positives_merged still 3/3.

### Iteration 2 (v308) — Color pipeline fix
- Change: Brick desaturation 0.8→0.95 (voxelizer.ts), chroma guard 8→5 (mesh-filter.ts)
- Target: Preserve brick/terracotta hues through CIE-Lab matching
- Result: **8/10** [8, 8, 7] — Blocks IDENTICAL (12,742). Source textures from aerial 3D Tiles are already gray — brick color only visible at street level, not roof-view photogrammetry.

### Iteration 3 (v308b) — maskDilate 0→1
- Change: maskDilate 0→1 to connect thin wing corridors
- Target: Improve compound footprint connectivity
- 3-run result: **10/10** [10, 10, 10] — appeared perfect (VLM noise)
- 5-run validation: **7.3/10** [8, 7, 10, 7, 7] — false_positives_merged 4/5 runs

## Plateau Declaration

**Score: 7-8/10** — stable across 3 iterations, 8+ runs total.

Remaining defects are **unfixable through pipeline changes**:
- `false_positives_merged` (4/5 runs, -2): Multi-wing school compound inherently looks like merged separate structures in voxel form. The L-shape with corridors reads as multiple buildings to VLM.
- `height_truncated` (3/5 runs, -1): Google 3D Tiles LOD limitation — building only ~6.5m in tiles vs 8-12m reality.
- `facade_holes_visible` (intermittent): Thin wing connections create through-holes at 2 block/m resolution.

Pipeline config frozen at: resolution=2, maskDilate=1, osmId=way/223060418, modePasses=3, --no-enu
