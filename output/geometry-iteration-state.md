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
- seattle-library: 8 → 8 (surface C:1.7→2.0, one run hit 9, but height_truncated still limits)
- disney-hall: 6.7 → **8** (+1.3, surface detail recovered, merge reduced from 3/5 to 1/3 runs)
- Regressions: NONE

### Iteration 2: TBD
- Change:
- seattle-library: /10
- disney-hall: /10
- Regressions:
