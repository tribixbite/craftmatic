# Tiles Voxelization Grading — v7 Gemini 3 Pro Eval (2026-03-09)

## Evaluation Method
- Satellite image (Google Static Maps z20) + isometric voxel render (tile=4)
- Sent to Gemini 3 Pro Preview via PAL MCP
- Prompt: strict 1-10 scale, no inflation, unbiased comparison

## Scores

| # | Building | Address | Score | Key Feedback |
|---|----------|---------|-------|--------------|
| 1 | sf | 2340 Francisco St, SF | 4/10 | Angled corner footprint visible, but walls degraded with noise/holes |
| 2 | newton | 240 Highland St, Newton MA | 3/10 | Rough L-shaped footprint, but roof completely flat (should be pitched) |
| 3 | sanjose | 525 S Winchester Blvd, San Jose | 1/10 | Unstructured noisy cylindrical chunk, nothing matches |
| 4 | byron | 2431 72nd St SW, Byron Center MI | 1/10 | Satellite shows empty field, pipeline generated chaotic mass |
| 5 | losangeles | 2607 Glendower Ave, LA | 1/10 | Noisy cylindrical extrusion, house blended with tree canopy |
| 6 | charleston | 41 Legare St, Charleston SC | 1/10 | Solid cylindrical block merging multiple buildings + courtyards |
| 7 | walpole | 13 Union St, Walpole NH | 1/10 | Raw terrain extrusion, no building present |
| 8 | vinalhaven | 216 Zekes Point Rd, Vinalhaven ME | 1/10 | Unconstrained terrain/canopy noise |
| 9 | suttonsbay | 5835 S Bridget Rose Ln, Suttons Bay MI | 1/10 | Unstructured noisy blob |
| 10 | seattle | 4810 SW Ledroit Pl, Seattle WA | 1/10 | Solid cylindrical mass merging building + dirt lot + parking |
| 11 | austin | 8504 Long Canyon Dr, Austin TX | 1/10 | Cylindrical chunk of terrain/canopy, no building |
| 12 | minneapolis | 2730 Ulysses St NE, Minneapolis MN | 1/10 | Flat noisy gray cylinder |

**Average: 1.4/10**

## Universal Issues (Gemini's consistent feedback)

### 1. Circular crop shape (every building)
The `--crop 20` creates a cylindrical XZ boundary. Every render looks like a "noisy cylindrical chunk" because the crop shape is visually dominant. Need rectangular crop aligned to building footprint.

### 2. No building isolation from terrain (every building)
The pipeline voxelizes everything within the capture radius — terrain, vegetation, neighboring structures, parking lots — into one solid mass. Need OSM footprint masking to keep only building geometry.

### 3. Flat roofs on pitched buildings (newton, byron, all residential)
Pitched/gabled roofs are flattened by the voxelization resolution. Need roof type detection and explicit angled roof generation.

### 4. Vegetation contamination (sanjose, byron, losangeles, suttonsbay)
Tree canopy captured as building mass. Block-based vegetation filter insufficient for photogrammetry color-baked vegetation.

### 5. Empty lot / no building (byron, walpole, suttonsbay)
Some addresses may not have prominent buildings in Google 3D Tiles. Need pre-validation gate.

## Priority Improvements (from Gemini)

1. **OSM footprint masking** — Query OSM building polygon, rasterize to 2D mask, apply during voxelization to keep only building blocks. This single fix addresses issues #1, #2, #4.
2. **Rectangular crop** — Replace circular `cropToCenter` with axis-aligned or oriented bounding box from OSM polygon.
3. **Roof type classification** — Detect pitched vs flat roofs and generate angled roof planes.
4. **Pre-validation gate** — Check for valid building footprint before voxelization; abort for empty lots.

## Score Progression

| Version | Avg (self) | Avg (Gemini) | Key Change |
|---------|-----------|--------------|------------|
| v1-v5 | 1.1-2.3 | — | Camera, fill, filter, component isolation |
| v6 | 2.4 | — | Crop + render fix |
| **v7** | — | **1.4** | Ground plane removal (minimal impact) |

Self-grading was significantly inflated vs Gemini's unbiased evaluation.
