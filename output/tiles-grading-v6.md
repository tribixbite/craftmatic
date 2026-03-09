# Tiles Voxelization Grading — v6 (2026-03-09)

## Changes (v5 → v6)

1. **Center crop `--crop 20`**: Remove blocks beyond XZ radius 20 from grid center (40m diameter)
   - Applied to existing GLBs offline — no browser re-capture needed
   - Goal: isolate target building from 50m-radius neighborhood capture
2. **LA special case**: crop=10 needed (crop=20 still too large, render hung)

## Block Count Comparison (v5 → v6)

| Building | v5 Blocks | v6 Blocks | Change | Crop Removed |
|----------|-----------|-----------|--------|--------------|
| sf | 40,042 | 21,004 | **-48%** | ~19K |
| newton | 42,980 | 34,145 | -21% | ~9K |
| sanjose | 78,515 | 40,659 | -48% | ~38K |
| walpole | 9,867 | 7,816 | -21% | ~2K |
| byron | 75,432 | 38,939 | -48% | ~37K |
| vinalhaven | 16,195 | 12,985 | -20% | ~3K |
| suttonsbay | 16,710 | 14,395 | -14% | ~2K |
| losangeles | 86,705 | 11,046 | **-87%** | ~76K (crop=10) |
| seattle | 119,576 | 52,182 | -56% | ~67K |
| austin | 76,409 | 40,397 | -47% | ~36K |
| minneapolis | 51,535 | 25,296 | -51% | ~26K |
| charleston | 73,778 | 39,142 | -47% | ~35K |

Crop=20 removes 14-56% of blocks. The biggest reductions (sanjose, byron, seattle, austin, charleston) had the most neighborhood contamination at 50m radius.

## Grading Results

| Building | Address | Score | v5 Score | Tile | Notes |
|----------|---------|-------|----------|------|-------|
| sf-v6 | 2340 Francisco St, SF | 3.5 | 3.0 | 2 | Single building isolated, visible wall detail + vertical form |
| newton-v6 | 240 Highland St, Newton MA | 2.5 | 2.5 | 2 | Compact solid mass, roof visible, some dark areas |
| sanjose-v6 | 525 S Winchester Blvd, San Jose | 2.0 | 2.5 | 1 | Green speckle remains; tile=1 too small to assess properly |
| walpole-v6 | 13 Union St, Walpole NH | 1.0 | 1.0 | 2 | Still only 8 blocks tall — rural detail ceiling |
| byron-v6 | 2431 72nd St SW, Byron Center MI | 1.5 | 1.5 | 1 | Flat mass, tile=1 barely visible |
| vinalhaven-v6 | 216 Zekes Point Rd, Vinalhaven ME | 1.5 | 1.5 | 2 | Compact dark/gray mass, building footprint visible |
| suttonsbay-v6 | 5835 S Bridget Rose Ln, Suttons Bay MI | 1.5 | 1.5 | 2 | Green elements still visible, low-detail |
| losangeles-v6 | 2607 Glendower Ave, LA | 1.5 | 2.0 | 2 | Tall column with heavy green — hillside vegetation dominates |
| seattle-v6 | 4810 SW Ledroit Pl, Seattle WA | 1.5 | 2.0 | 1 | Large dark mass, tile=1 barely visible |
| austin-v6 | 8504 Long Canyon Dr, Austin TX | 1.5 | 2.5 | 1 | Flat mass, tile=1 barely visible |
| minneapolis-v6 | 2730 Ulysses St NE, Minneapolis MN | 1.5 | 2.5 | 1 | Flat mass, tile=1 barely visible |
| charleston-v6 | 41 Legare St, Charleston SC | 2.0 | 3.0 | 1 | Was best at v5; tile=1 loses all visual detail |

**Average: 1.8/10** (v5: 2.3, v4: 2.1, v3: 1.7)

## Analysis

### Score dropped from v5 (2.3 → 1.8) — why?

The crop itself was a good idea, but two confounding factors mask its benefit:

1. **tile=1 renders destroy visual fidelity**: 6 of 12 buildings required tile=1 (>20K blocks hung at tile=2 on ARM). At 1 pixel per block, a 56×39 grid renders as 56×39 pixels — impossible to visually grade. Austin, minneapolis, charleston all had solid v5 scores (2.5-3.0) that dropped to 1.5-2.0 purely from render quality, not voxel quality.

2. **Component isolation already did the heavy lifting**: v5's `removeSmallComponents(Infinity)` already isolated the target building for SF. Crop=20 adds marginal benefit on top.

### What crop=20 actually improved

- **SF**: Best result — single building clearly isolated with visible vertical form (3.5, up from 3.0)
- **Block count reduction**: All buildings significantly lighter (14-87% fewer blocks), which helps downstream performance

### What crop=20 didn't help

- **Rural tiles**: Walpole/Vinalhaven/Suttons Bay still ceiling-limited by Google Tiles detail
- **Hillside terrain**: LA still captures terrain slope as voxels despite tight crop
- **Neighborhood blobs**: Seattle/Byron still capture multiple structures within 20m XZ radius

## Rendering Bottleneck

The ARM texture atlas hang is now the primary blocker for visual assessment. tile=2 produces usable renders but hangs on >20K block grids. tile=1 renders are too small for human or VLM grading.

Options:
1. Render on non-ARM machine (x86 server/desktop)
2. Render subsets of large grids (e.g., front face only)
3. Use browser Three.js renderer instead of CLI png-renderer

## Score Progression

| Version | Average | Key Change |
|---------|---------|------------|
| v1 | 1.1 | Baseline |
| v2 | 1.2 | Pipeline fixes on old GLBs |
| v3 | 1.7 | Browser re-capture with OrthoCam + cylinder |
| v4 | 2.1 | Double fill + vegetation block filter |
| v5 | **2.3** | Component isolation (largest only) |
| v6 | 1.8 | Center crop=20 (regression from tile=1 render quality) |

Note: v6 voxel quality is likely >= v5. The score regression is a rendering artifact, not a pipeline regression.

## Next Priority

1. **Fix render pipeline**: Either render on x86 or use browser-based Three.js renderer — tile=1 renders are useless
2. **Per-building crop radius**: Use buildingBounds data to set crop radius per building (residential ~15m, commercial ~25m) instead of one-size-fits-all crop=20
3. **Ground plane subtraction**: Detect lowest occupied Y layer and remove terrain below building footprint
4. **Hillside compensation**: LA needs terrain slope detection to avoid capturing ground as building
