# Tiles Voxelization Grading — v3 (2026-03-09)

## What Changed (v2 → v3)

v2 re-voxelized OLD browser-captured GLBs (PerspectiveCamera + sphere filter).
v3 **re-captured all 12 buildings from browser** with the fixed pipeline, then re-voxelized through CLI.

### Capture pipeline fixes active:
1. OrthographicCamera at Y=500 (was PerspectiveCamera at (0,8,8))
2. XZ-cylinder filter (was sphere — clipped tall geometry)
3. errorTarget=4.0 for ortho SSE

### CLI pipeline fixes active:
4. Removed solidifyCore, carveFacadeShadows, fireEscapeFilter, addRoofCornice
5. Removed warm bias, MIN_BRIGHT 180→140, kernel 16→24, desat 0.65→0.5
6. Shadow-only palette (7 rules, was 22 aggressive rules)

## Grading Results

| Building | Address | Grid | Blocks | Palette | Score | Notes |
|----------|---------|------|--------|---------|-------|-------|
| sf-v3 | 2340 Francisco St, SF | 55x36x57 | 38,522 | 27 | 2.0 | Two building volumes, porous surfaces, color variety present |
| newton-v3 | 240 Highland St, Newton MA | 35x29x43 | 39,006 | 23 | 2.5 | Compact blocky form, recognizable building mass |
| sanjose-v3 | 525 S Winchester Blvd, San Jose | 54x33x54 | 54,658 | 25 | 2.0 | Large complex captured, some green vegetation, chaotic |
| walpole-v3 | 13 Union St, Walpole NH | 34x8x43 | 8,621 | 24 | 1.0 | Only 8 blocks tall — looks like a roof slab, not a building |
| byron-v3 | 2431 72nd St SW, Byron Center MI | 54x34x56 | 44,965 | 26 | 1.5 | Tan terrain+trees+building mixed, can't isolate house |
| vinalhaven-v3 | 216 Zekes Point Rd, Vinalhaven ME | 34x12x43 | 13,974 | 17 | 1.0 | 12 blocks tall, flat slab with holes |
| suttonsbay-v3 | 5835 S Bridget Rose Ln, Suttons Bay MI | 32x15x41 | 13,644 | 22 | 1.0 | Flat slab, trees as green noise |
| losangeles-v3 | 2607 Glendower Ave, LA | 56x37x55 | 61,532 | 25 | 1.5 | Hillside capture, vegetation dominates, chaotic |
| seattle-v3 | 4810 SW Ledroit Pl, Seattle WA | 60x45x49 | 92,517 | 22 | 1.5 | Largest by blocks, dark mass, multiple buildings merged |
| austin-v3 | 8504 Long Canyon Dr, Austin TX | 54x37x52 | 40,194 | 23 | 2.0 | Two building masses, light gray, some structure visible |
| minneapolis-v3 | 2730 Ulysses St NE, Minneapolis MN | 56x39x41 | 43,124 | 19 | 2.0 | Flat building footprint, dark structure on corner |
| charleston-v3 | 41 Legare St, Charleston SC | 53x35x54 | 39,673 | 24 | 2.5 | Best of batch — identifiable building form, lighter walls |

**Average: 1.7/10** (v2: 1.2/10, v1: 1.1/10)

## Improvement Over v2

- **+0.5 avg** — marginal improvement
- **Color variety**: 17-27 palette materials (v2 also had this after color fix)
- **More geometry captured**: New GLBs are 2-6x larger (e.g. SF 934KB→2.3MB, San Jose→5.8MB)
- **No artificial materials**: No bricks/spruce cornice artifacts

## Remaining Systemic Issues (Severity Order)

### 1. Capture radius too wide (critical)
All 12 captures use 50m radius. Residential buildings are 10-15m wide. Result: 70%+ of voxels are neighboring buildings, trees, terrain, driveways. The target building is unidentifiable in the noise.

**Fix**: Use `buildingBounds` pipeline (already implemented) to set tight radius. Residential: 15-25m, not 50m.

### 2. No solidifyCore leaves hollow shells (high)
Photogrammetry meshes are thin surfaces (~0.3m). At 1 block/m, many voxels miss the surface entirely. Removing solidifyCore (which was destroying non-rectangular geometry) also removed the only mechanism for filling these gaps.

**Fix**: Replace solidifyCore with a smarter fill:
- Use `fillInteriorGaps()` (flood-fill) which preserves concave shapes
- OR: increase surface threshold further (0.65→0.85) for thicker shells
- OR: restore solidifyCore but only for high-confidence rectangular buildings

### 3. Trees/vegetation captured as dark noise (high)
Green concrete patches (trees), dark masses (shadows under canopy), and terrain features overwhelm the building signal.

**Fix**: Pre-filter by color — reject mesh faces with green/brown dominant color before voxelization. Or post-filter: remove connected components not attached to the main building mass.

### 4. Rural buildings lack tile detail (medium)
Walpole (8 blocks), Vinalhaven (12 blocks), Suttons Bay (15 blocks) — Google 3D tiles have very low detail in rural areas. These buildings are barely resolved.

**Fix**: Accept this as a Google Tiles limitation. Flag low-detail captures and skip or fallback to procedural generation.

### 5. Hillside/terrain captured (medium)
Los Angeles (hillside), Byron Center (rolling terrain) — elevation changes captured as part of the building volume.

**Fix**: Ground plane detection + terrain stripping before voxelization.

## Recommended Next Steps

1. **Tighter capture radius**: Use buildingBounds for auto-sizing (already implemented, just not wired to batch)
2. **Restore interior fill**: Either smarter solidifyCore or thicker shell threshold
3. **Vegetation filter**: Color-based pre-filter on mesh faces
4. **Skip rural**: Auto-detect low-detail tiles (< 20 blocks tall) and flag for procedural fallback
5. **Re-grade after above fixes**: Expect 3-4/10 with tighter radius + fill + vegetation filter
