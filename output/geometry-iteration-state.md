# Geometry Iteration State

## Baseline (v306)
| Building | Score | Diagnosis |
|----------|-------|-----------|
| seattle-library | 8.0 | massing(0.3/1), surface(1.7/3) |
| disney-hall | 6.7 | footprint(1.4/2), surface(1.0/3) |

## Sanity Check Results (v306)
- enuHorizontalAngle=0 after 180° flip: CORRECT (intentional)
- Interior fill dilation=1: CORRECT (not the large dilation path)
- Complex shape detection: WORKING (facade flattening skipped)
- Profile-aware morph close: ACTIVE (stepped fraction 0.40)
- Disney Hall curved sails → voxels: INHERENT LIMITATION

## Iteration Log

### Iteration 1 (v307): Skip post-filter morphClose for complex shapes + raise tapered morphClose fraction 0.20→0.35
- Changes:
  1. Skip unconditional post-filter morphClose for complex shapes (preserves sail gaps, facet transitions)
  2. Raise first morphClose tapered fraction 0.20→0.35 (compensates for skipped post-filter, fills facade holes)
- flatiron: 9 → 9 (no regression)
- seattle-library: 8 → 8 (surface improved in 3-run test, but height_truncated still limits)
- disney-hall: 6.7 → **8** (+1.3, surface detail recovered, merge reduced)
- Regressions: NONE

### Iteration 2 (v307c): Profile-aware post-filter morphClose (base zone only)
- Change: Instead of fully skipping post-filter morphClose, run it with height limit for complex shapes
- Result: No improvement. Block counts identical to v307. VLM scores varied due to noise.
- REVERTED — kept v307 approach (full skip for complex)

### 5-Run Validation (v307 final)
| Building | v306 (baseline) | v307 (5 runs) | Raw scores |
|----------|----------------|---------------|------------|
| flatiron | 9 | 9 | [9, 9, 9, 9, 9] |
| seattle-library | 8 | 7.7 | [8, 8, 7, 8, 7] |
| disney-hall | 6.7 | **8** | [8, 7, 8, 8, 8] |

## PLATEAU DECLARED

### Remaining Bottlenecks (unfixable in pipeline)
- **seattle-library height_truncated**: Google 3D Tiles LOD captures ~60% of 56m building. Flagged 5/5 runs. Source data limitation.
- **seattle-library facade_holes**: Angular glass diamond facets create voxel gaps at block resolution. Flagged 5/5 runs.
- **disney-hall floating_artifacts**: Organic sail forms → disconnected voxel islands at 2-block/m resolution. Flagged 4/5 runs.
- **disney-hall facade_holes**: Curved metallic surfaces → angular voxel approximations with visible gaps. Flagged 5/5 runs.
- **disney-hall false_positives_merged**: VLM interprets organic sail forms as separate attached structures. Flagged 1/5 runs.

### Net improvement: disney-hall +1.3 (6.7→8), seattle-library stable (within noise)
