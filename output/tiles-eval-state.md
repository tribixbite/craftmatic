# Tiles Eval State

## Current Version: v7
## Iteration: 1
## Average Score: 1.4/10 (Gemini 3 Pro)
## Target: 8/10 all locations

## Scores
| Key | Score | Top Issue |
|-----|-------|-----------|
| sf | 4/10 | Walls degraded with noise/holes, missing rooftop features |
| newton | 3/10 | Flat roof (should be pitched), rough L-shape footprint visible |
| sanjose | 1/10 | Noisy cylindrical chunk, nothing matches |
| walpole | 1/10 | Raw terrain extrusion, no building present |
| byron | 1/10 | Empty field in satellite, pipeline generated chaotic mass |
| vinalhaven | 1/10 | Unconstrained terrain/canopy noise |
| suttonsbay | 1/10 | Unstructured noisy blob |
| losangeles | 1/10 | House blended with tree canopy |
| seattle | 1/10 | Merges building + dirt lot + parking |
| austin | 1/10 | Cylindrical chunk of terrain/canopy |
| minneapolis | 1/10 | Flat noisy gray cylinder |
| charleston | 1/10 | Multiple buildings + courtyards merged |

## Next Improvement: OSM Footprint Masking
The #1 issue across all buildings is lack of building isolation. The circular crop captures everything (terrain, vegetation, neighbors). Fix:
1. Query OSM Overpass for building polygon at target coordinates
2. Rasterize polygon to 2D binary mask in voxel grid coordinate space
3. Apply mask after voxelization — clear all blocks outside building footprint
4. Replace circular `cropToCenter` with footprint-aware crop

## Improvement History
| Version | Avg | Change |
|---------|-----|--------|
| v1-v3 | 1.1-1.7 | Camera, capture fixes |
| v4 | 2.1 (self) | Double fill + vegetation filter |
| v5 | 2.3 (self) | Component isolation |
| v6 | 2.4 (self) | Center crop + render fix |
| v7 | 1.4 (Gemini) | Ground plane removal |
