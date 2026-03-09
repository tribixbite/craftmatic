# Tiles Voxelization Grading — v6 (2026-03-09)

## Changes (v5 → v6)

1. **Center crop `--crop 20`**: Remove blocks beyond XZ radius 20 from grid center (40m diameter)
   - Applied to existing GLBs offline — no browser re-capture needed
   - Goal: isolate target building from 50m-radius neighborhood capture
2. **LA special case**: crop=10 (hillside terrain + vegetation needed tighter crop)
3. **Render fix**: `sharp.concurrency(1)` prevents libvips thread pool deadlock on Android ARM64
4. **Interior block cull**: Skip fully surrounded blocks in isometric renderer (massive speedup)
5. All renders at tile=4 (was tile=1-2 before render fixes)

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

## Grading Results

| Building | Address | Score | v5 Score | Notes |
|----------|---------|-------|----------|-------|
| sf-v6 | 2340 Francisco St, SF | 3.5 | 3.0 | Single building isolated, visible wall detail + vertical form, clear roofline |
| newton-v6 | 240 Highland St, Newton MA | 3.0 | 2.5 | Compact solid mass, visible roof planes, wall color variation, textured |
| sanjose-v6 | 525 S Winchester Blvd, San Jose | 2.5 | 2.5 | Commercial complex visible, green vegetation patch on roof, wall detail |
| walpole-v6 | 13 Union St, Walpole NH | 1.5 | 1.0 | Flat 8-block structure, olive/dark tones, faint building footprint visible |
| byron-v6 | 2431 72nd St SW, Byron Center MI | 2.5 | 1.5 | Tan/olive residential, visible roof planes + terrain, green vegetation spots |
| vinalhaven-v6 | 216 Zekes Point Rd, Vinalhaven ME | 1.5 | 1.5 | Dark flat mass, faint building outline, coastal low-detail |
| suttonsbay-v6 | 5835 S Bridget Rose Ln, Suttons Bay MI | 2.0 | 1.5 | Compact gray mass, visible roof, some green vegetation bleed |
| losangeles-v6 | 2607 Glendower Ave, LA | 2.0 | 2.0 | Tall hillside column, vegetation (green) throughout, terrain mixed in |
| seattle-v6 | 4810 SW Ledroit Pl, Seattle WA | 2.0 | 2.0 | Large mass, multiple buildings still merged, dark porous walls |
| austin-v6 | 8504 Long Canyon Dr, Austin TX | 2.5 | 2.5 | Rounded solid mass, visible roof plane, wall color banding |
| minneapolis-v6 | 2730 Ulysses St NE, Minneapolis MN | 2.5 | 2.5 | Flat solid building, visible roof and wall planes, gray tones |
| charleston-v6 | 41 Legare St, Charleston SC | 3.0 | 3.0 | Solid rectangular form, visible wall/roof color contrast, good detail |

**Average: 2.4/10** (v5: 2.3, v4: 2.1, v3: 1.7, v2: 1.2, v1: 1.1)

## What Improved

- **Render quality**: tile=4 renders show actual building detail (textures, wall color, roof planes) — the v5 tile=1/2 renders hid real improvements
- **SF best ever** (3.5): Single building isolated with clear vertical form
- **Byron jump** (1.5→2.5): Was previously unrenderable (render hung). Now shows residential structure with roof
- **Newton/Charleston** (3.0): Consistent solid building forms with visible architectural detail
- **Block reduction**: 14-87% fewer blocks from crop, improving both render speed and building isolation

## Remaining Issues

### 1. Cylinder crop shape
Crop=20 creates a circular XZ boundary. Buildings near the edge get partial voxels cut off. Need rectangular crop based on building footprint orientation.

### 2. Vegetation bleed
Byron, Suttons Bay, San Jose, LA all show green blocks (lime_concrete, green_concrete) from photogrammetry trees. The block-based filter catches some but not all vegetation.

### 3. Rural detail ceiling
Walpole (8 blocks tall), Vinalhaven (12 blocks) — Google 3D Tiles simply lack geometry for rural buildings. No pipeline fix helps.

### 4. Hillside terrain
LA captures hillside slope as voxels despite crop=10. Need ground plane detection + subtraction.

### 5. Neighborhood merging
Seattle still captures multiple structures within 20m XZ radius. Per-building crop radius from buildingBounds would help.

## Render Performance (after fixes)

| Building | Blocks | Render ms | Sharp ms | Total |
|----------|--------|-----------|----------|-------|
| sf | 21,004 | 626 | 7 | 633 |
| newton | 34,145 | 203 | 6 | 209 |
| sanjose | 40,659 | 295 | 7 | 302 |
| walpole | 7,816 | 142 | 4 | 146 |
| byron | 38,939 | 281 | 8 | 289 |
| vinalhaven | 12,985 | 153 | 5 | 158 |
| suttonsbay | 14,395 | 167 | 4 | 171 |
| losangeles | 11,046 | 152 | 7 | 159 |
| seattle | 52,182 | 333 | 8 | 341 |
| austin | 40,397 | 343 | 8 | 351 |
| minneapolis | 25,296 | 238 | 6 | 244 |
| charleston | 39,142 | 350 | 12 | 362 |

All renders under 650ms. Two key fixes:
1. `sharp.concurrency(1)` — prevents libvips thread pool deadlock on bionic libc
2. Interior block cull — skips blocks surrounded by 6 solid neighbors, ~80% of filled grid blocks

## Score Progression

| Version | Average | Key Change |
|---------|---------|------------|
| v1 | 1.1 | Baseline |
| v2 | 1.2 | Pipeline fixes on old GLBs |
| v3 | 1.7 | Browser re-capture with OrthoCam + cylinder |
| v4 | 2.1 | Double fill + vegetation block filter |
| v5 | 2.3 | Component isolation (largest only) |
| **v6** | **2.4** | **Center crop + render pipeline fix (tile=4)** |

## Next Priority

1. **Per-building crop radius**: Use buildingBounds to set per-address crop (residential ~15m, commercial ~25m)
2. **Ground plane subtraction**: Detect and remove terrain below building footprint
3. **Rectangular crop**: Align crop to building orientation instead of circular XZ radius
4. **Stronger vegetation filter**: Expand VEGETATION_BLOCKS set or add color-based post-filter
