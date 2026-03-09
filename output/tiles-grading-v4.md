# Tiles Voxelization Grading — v4 (2026-03-09)

## Changes (v3 → v4)

1. **Double fill**: fillInteriorGaps dilation 3→5, second pass after rectification
2. **Vegetation block filter**: skip green_concrete/lime_concrete/moss_block during surface voxelization
3. **Batch radius**: 50m→25m default (won't affect existing GLBs, only future captures)

## Block Count Comparison (v3 → v4)

| Building | v3 Blocks | v4 Blocks | Change | Fill Pass 2 |
|----------|-----------|-----------|--------|-------------|
| sf | 38,522 | 73,594 | **+91%** | 25,589 |
| newton | 39,006 | 42,980 | +10% | 1,416 |
| sanjose | 54,658 | 78,515 | +44% | 14,021 |
| walpole | 8,621 | 9,867 | +14% | 653 |
| byron | 44,965 | 75,432 | +68% | 19,380 |
| vinalhaven | 13,974 | 16,195 | +16% | 983 |
| suttonsbay | 13,644 | 16,710 | +22% | 1,961 |
| losangeles | 61,532 | 86,705 | +41% | 17,093 |
| seattle | 92,517 | 119,576 | +29% | 14,126 |
| austin | 40,194 | 76,409 | **+90%** | 27,035 |
| minneapolis | 43,124 | 51,535 | +19% | 5,099 |
| charleston | 39,673 | 73,778 | **+86%** | 25,618 |

Double fill is the main win — second pass catches 1K-27K additional voxels after rectification closes wall gaps.

## Grading Results

| Building | Address | Score | v3 Score | Notes |
|----------|---------|-------|----------|-------|
| sf-v4 | 2340 Francisco St, SF | 3.0 | 2.0 | Much more solid, two building volumes clearly visible |
| newton-v4 | 240 Highland St, Newton MA | 2.5 | 2.5 | Compact solid mass, dark |
| sanjose-v4 | 525 S Winchester Blvd, San Jose | 2.5 | 2.0 | Complex visible with solid walls, one tree patch |
| walpole-v4 | 13 Union St, Walpole NH | 1.0 | 1.0 | Still only 8 blocks tall — low-detail rural tiles |
| byron-v4 | 2431 72nd St SW, Byron Center MI | 1.5 | 1.5 | (render hung — using v3 score) |
| vinalhaven-v4 | 216 Zekes Point Rd, Vinalhaven ME | 1.5 | 1.0 | More solid, building footprint visible |
| suttonsbay-v4 | 5835 S Bridget Rose Ln, Suttons Bay MI | 1.5 | 1.0 | More solid, green trees less dominant |
| losangeles-v4 | 2607 Glendower Ave, LA | 2.0 | 1.5 | Hillside, more solid but still chaotic |
| seattle-v4 | 4810 SW Ledroit Pl, Seattle WA | 2.0 | 1.5 | Large solid mass, multiple buildings merged |
| austin-v4 | 8504 Long Canyon Dr, Austin TX | 2.5 | 2.0 | Solid building mass with clear form |
| minneapolis-v4 | 2730 Ulysses St NE, Minneapolis MN | 2.5 | 2.0 | Flat solid building, structures on top |
| charleston-v4 | 41 Legare St, Charleston SC | 3.0 | 2.5 | Best — solid building form, lighter walls |

**Average: 2.1/10** (v3: 1.7, v2: 1.2, v1: 1.1)

## What Improved

- **Solidity**: Buildings are no longer porous shells — double fill increased block count 10-91%
- **Charleston/SF at 3.0**: First buildings to cross the "recognizable as a building" threshold
- **Vegetation filter**: Minimal visible impact (block-based filter is conservative, as intended)

## Remaining Bottlenecks

### 1. Capture radius (still 50m from old GLBs)
The 25m default only applies to NEW browser captures. All v4 schems still use the same v3 GLBs captured with old 50m radius. This is the #1 remaining issue — need re-capture.

### 2. Rural tile detail ceiling
Walpole (8 blocks), Vinalhaven (12 blocks), Suttons Bay (15 blocks) — Google 3D Tiles simply don't have geometry for rural buildings. No pipeline fix can help.

### 3. Neighborhood capture (no building isolation)
Seattle, Minneapolis capture entire blocks. Need either:
- Tighter radius (fix #1)
- Component analysis to isolate the target building from neighbors
- Building footprint mask from OSM/Solar API

### 4. Hillside terrain
Los Angeles captures terrain slope as voxels. Need ground plane detection + subtraction.

## Score Progression

| Version | Average | Key Change |
|---------|---------|------------|
| v1 | 1.1 | Baseline (old camera + sphere + solidifyCore) |
| v2 | 1.2 | Pipeline fixes on old GLBs (no effect) |
| v3 | 1.7 | Browser re-capture with OrthoCam + cylinder |
| **v4** | **2.1** | **Double fill + vegetation block filter** |

## Next Priority

1. **Re-capture with 25m radius**: New browser batch using buildingBounds auto-sizing
2. **Component isolation**: After voxelization, keep only the largest connected component
3. **Ground plane subtraction**: Detect and remove terrain below building footprint
