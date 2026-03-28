# Iterate State — v300

**Target**: 9/10 buildings at 9+
**Current**: 0/10 passing (10/10 graded)
**Model**: gemini-2.5-pro | **Runs/batch**: 3 | **Mode**: fresh (20% trimmed mean)
**Updated**: 2026-03-28T06:00:00Z

| Building | Difficulty | TrimmedMean | SatRef | Runs | Status | Diagnosis |
|---|---|---|---|---|---|---|
| pennzoil | hard | 8 | 3/5 | 3 | FAIL | identity(1.3/2), high-variance(range=4) |
| flatiron | easy | 7 | 3/5 | 3 | FAIL | massing(0.7/3), identity(2.0/2) |
| nga-east | medium | 5 | 3/5 | 3 | FAIL | footprint(2.0/4) |
| dallas-cityhall | hard | 3 | 3/5 | 3 | FAIL | footprint, floating_artifacts, !recognizable |
| citigroup | hard | 2 | 3/5 | 3 | FAIL | height truncated (36%), merged neighbors |
| transamerica | hard | 2 | 3/5 | 3 | FAIL | height truncated (21%), false_positives_merged |
| seattle-library | hard | 1 | 3/5 | 3 | FAIL | height_truncated, floating_artifacts, !recognizable |
| boston-cityhall | hard | 1 | 3/5 | 3 | FAIL | facade_holes, floating_artifacts, !recognizable |
| la-cityhall | hard | 1 | 3/5 | 3 | FAIL | height truncated (39%), floating_artifacts, !recognizable |
| geisel | hard | 0 | 3/5 | 3 | FAIL | false_positives_merged, facade_holes, !recognizable |

## Root Cause Analysis

### What works (2/10 buildings)
- **Pennzoil (8/10)**: Short (52m), angular 45° tops, distinctive twin towers. Captures fully within 50m radius. Recognized in 2/3 runs.
- **Flatiron (7/10)**: Iconic triangular wedge visible even at ~60% height capture. Universally recognized by VLM.

### Why the other 8 fail

**1. Height truncation (4 buildings)**
Google 3D Tiles LOD + tiles-headless 50m capture radius clips tall buildings:
- Citigroup 279m → captured 101m (36%)
- Transamerica 260m → captured 55m (21%)
- LA City Hall 138m → captured 55m (39%)
- Seattle Library 56m → captured 54m (96%) — height OK but still fails

**2. Raw CIELAB texture noise (all 8 failing)**
Photogrammetry textures produce speckled dark patches that VLM flags as `facade_holes`. Dark blocks (deepslate, andesite, tuff) from baked shadows + CIELAB noise look like structural damage in renders. Gamma 0.4 helps but doesn't eliminate.

**3. Street furniture not severed (5 buildings)**
Thin vertical poles (street lights, sign posts) visible in Dallas, Seattle, Boston, LA, Transamerica. `severStreetFurniture()` misses poles outside the building footprint.

**4. Neighbor/plaza merging (3 buildings)**
Geisel includes surrounding walkways/structures (100×102 at 2x = 50m×51m actual, vs ~25m building). Boston captures City Hall Plaza infrastructure. Dallas includes parking structures.

**5. VLM recognition gap (8 buildings)**
`!building_recognizable` flagged on 8/10. Only Flatiron and Pennzoil are recognized. The VLM doesn't know what Dallas City Hall, NGA East, Geisel Library etc. look like from voxels. This costs -3 points per building, making 7/10 the ceiling for unrecognized buildings.

### Structural limitations

The binary defect scoring is honest but harsh. A single `!building_recognizable` defect costs -3, capping any unrecognized building at 7/10 max (assuming zero other defects). Most real builds have 2-3 defects, pushing scores to 1-3.

The pipeline produces reasonable voxel builds (clear geometry, solid fills, good footprints) but:
- The **texture quality** from raw CIELAB photogrammetry creates visual noise that VLM interprets as damage
- The **rendering pipeline** (DDA shadows + AO + dark CIELAB blocks) compounds darkness
- The **VLM recognition** requirement eliminates most non-iconic buildings

## Pipeline vs Building Set

| Success factor | Pennzoil/Flatiron | Other 8 |
|---|---|---|
| Height < 60m | Yes/Partial | 4/8 too tall |
| Angular features | 45°/triangle | Curves, subtle |
| VLM recognized | Yes | No |
| Clean capture | Yes (old GLBs) | Mixed |
| Distinct footprint | Yes | Some |

## Options

1. **Replace building set with shorter angular buildings** — find 8 more buildings <60m with distinctive angular shapes that VLM knows
2. **Remove !recognizable penalty** — dishonest, masks real quality issues
3. **Improve capture pipeline** — re-capture with --multi-angle --height for tall buildings
4. **Fix texture pipeline** — larger kernel, bilateral filter, disable DDA/AO for certain buildings
5. **Accept 2/10 passing** — the pipeline genuinely struggles with complex architecture
