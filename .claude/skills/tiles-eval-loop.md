# Tiles Voxelization Eval Loop

## Purpose
Automated improvement loop for tiles voxelization pipeline. After each pipeline change, re-voxelize all buildings, re-render, and evaluate via Gemini VLM until all 12 locations score >= 8/10.

## Trigger
Run after any change to the tiles voxelization pipeline (voxelize-glb.ts, mesh-filter.ts, tile-capture.ts, tiles.ts, voxelizer.ts).

## State File
`output/tiles-eval-state.md` — tracks current scores, iteration count, and next improvement.

## Workflow

### 1. Re-voxelize all 12 buildings
```bash
TILES=/data/data/com.termux/files/home/git/craftmatic/output/tiles
# Use the GLB-to-key mapping from eval-tiles.ts
# Apply --crop, --filterVegetation, -m surface -r 1
# Output as {key}-v{N}.schem
```

### 2. Re-render all 12 as JPEGs
```bash
# Update SCHEMS list in scripts/render-new-tiles.ts to v{N}
bun scripts/render-new-tiles.ts
```

### 3. Evaluate via Gemini (PAL MCP)
Send each (satellite, render) pair to `mcp__pal__chat` with model `gemini-3-pro-preview`:
- Satellite images in: `output/tiles/eval/{key}-satellite.jpg`
- Render images in: `output/tiles/{key}-v{N}.jpg`
- 2 buildings per call (4 images, under 5-image limit)
- Prompt must be UNBIASED — no leading questions, no context about what was changed

### Eval Prompt Template
```
You are evaluating Minecraft voxelized building recreations against satellite imagery.
Image 1 is a satellite photo. Image 2 is an isometric voxel render at 1 block/m.

Rate on 1-10: 1=unrecognizable blob, 3=vaguely building-shaped, 5=recognizable type
with correct proportions, 7=clear form matching footprint, 8=strong match with
architectural features, 10=perfect.

Be STRICT. Do NOT inflate. Reply in this exact format:
SCORE: N/10
MATCHES: what matches satellite
WRONG: what's wrong or missing
FIX: one specific improvement
```

### 4. Check scores
- If ALL locations >= 8/10: DONE. Commit and report.
- If any < 8/10: Identify the lowest-scoring buildings and their feedback.
  Implement the most common/impactful improvement suggestion.
  Return to step 1.

### 5. Commit after each iteration
```
feat: tiles pipeline v{N} — {description of change}
```
Update `output/tiles-eval-state.md` with scores and next steps.

## GLB File Mapping
| Key | GLB Filename |
|-----|-------------|
| sf | tiles-2340-francisco-st-san-francisco-ca-94123.glb |
| newton | tiles-240-highland-st-newton-ma-02465.glb |
| sanjose | tiles-525-s-winchester-blvd-san-jose-ca-95128.glb |
| walpole | tiles-13-union-st-walpole-nh-03608.glb |
| byron | tiles-2431-72nd-st-sw-byron-center-mi-49315.glb |
| vinalhaven | tiles-216-zekes-point-rd-vinalhaven-me-04863.glb |
| suttonsbay | tiles-5835-s-bridget-rose-ln-suttons-bay-mi-49682.glb |
| losangeles | tiles-2607-glendower-ave-los-angeles-ca-90027.glb |
| seattle | tiles-4810-sw-ledroit-pl-seattle-wa-98136.glb |
| austin | tiles-8504-long-canyon-dr-austin-tx-78730.glb |
| minneapolis | tiles-2730-ulysses-st-ne-minneapolis-mn-55418.glb |
| charleston | tiles-41-legare-st-charleston-sc-29401.glb |

## Coordinates (for satellite images)
| Key | Lat,Lng |
|-----|---------|
| sf | 37.8005,-122.4382 |
| newton | 42.3295,-71.2105 |
| sanjose | 37.3127,-121.9480 |
| walpole | 43.0767,-72.4309 |
| byron | 42.8064,-85.7252 |
| vinalhaven | 44.0521,-68.8020 |
| suttonsbay | 44.9038,-85.6490 |
| losangeles | 34.1103,-118.2808 |
| seattle | 47.5551,-122.3876 |
| austin | 30.3456,-97.8005 |
| minneapolis | 45.0235,-93.2225 |
| charleston | 32.7716,-79.9377 |

## Current Status
- v7: avg 1.4/10 (Gemini eval)
- Top issue: No building footprint isolation — everything within crop radius voxelized as one mass
- Next fix: OSM footprint masking
