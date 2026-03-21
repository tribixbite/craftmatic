# Iterate State — v300

**Target**: 9/10 buildings at 9+
**Current**: 0/10 passing (3/10 graded, 7/10 pending GLB capture)
**Model**: gemini-2.5-pro | **Runs/batch**: 3 | **Mode**: fresh (20% trimmed mean)
**Updated**: 2026-03-21T05:00:00Z

| Building | Difficulty | TrimmedMean | SatRef | Runs | Avg A | Avg B | Avg C | Avg D | Status | Diagnosis |
|---|---|---|---|---|---|---|---|---|---|
| flatiron | easy | 7 | 3/5 | 3 | 4.0 | 0.7 | 2.7 | 2.0 | FAIL | height truncated (32m/87m=37%), --no-enu restores height to 53m |
| pennzoil | hard | 8 | 3/5 | 3 | 4.0 | 2.7 | 2.0 | 1.3 | FAIL | identity variance (8,4,8), facade_holes from CIELAB noise |
| nga-east | medium | — | — | — | — | — | — | — | PENDING | needs GLB capture (browser WebGL) |
| dallas-cityhall | hard | — | — | — | — | — | — | — | PENDING | needs GLB capture (browser WebGL) |
| seattle-library | hard | — | — | — | — | — | — | — | PENDING | needs GLB capture (browser WebGL) |
| boston-cityhall | hard | — | — | — | — | — | — | — | PENDING | needs GLB capture (browser WebGL) |
| citigroup | hard | 2 | 3/5 | 3 | 2.0 | 0.0 | 3.0 | 0.0 | FAIL | height truncated (101m/279m=36%), merged neighbors, not recognizable |
| denver-art | hard | — | — | — | — | — | — | — | PENDING | needs GLB capture (browser WebGL) |
| usaf-chapel | hard | — | — | — | — | — | — | — | PENDING | needs GLB capture (browser WebGL) |
| la-cityhall | hard | — | — | — | — | — | — | — | PENDING | needs GLB capture (browser WebGL) |

## Tier 1 Integration Results

### Pennzoil (8/10) — BEST
- Twin trapezoidal towers with 45° angled tops
- Grid: 54×41×52, 6875 blocks, 24-color palette
- Only `facade_holes_visible` flagged consistently (CIELAB texture noise)
- Recognizable in 2/3 runs, proportions correct in 2/3 runs
- **Bottleneck**: VLM variance (range=4), facade noise

### Flatiron (7/10) — GOOD
- Triangular wedge shape clearly visible in topdown
- Grid: 86×106×107, 167K blocks at 2x resolution
- Height truncated: 53m captured of 87m actual (61%)
- Building recognized in all 3 runs
- **Bottleneck**: height truncation from Google 3D Tiles LOD, proportions wrong

### Citigroup (2/10) — POOR
- 45° crown IS visible in render but VLM doesn't recognize it
- Grid: 81×101×107, 131K blocks at 1x resolution
- Height truncated: 101m captured of 279m actual (36%)
- Merged with neighboring buildings (footprint 81×107 vs expected 49×49)
- **Bottleneck**: extreme height truncation, neighbor merging, too tall for capture

## v300 Pipeline Assessment

### What works
- **Binary defect checklist**: Consistent 0-variance across 3 runs for Citigroup (all 2). More deterministic than v200 A/B/C/D.
- **--no-enu for pre-oriented GLBs**: Restores correct height (Flatiron 63→106 blocks)
- **Prompt calibration**: Severity thresholds prevent false positives for floating_artifacts
- **OSM masking**: Correctly isolates Pennzoil footprint (54×52 blocks)

### What doesn't work
- **Raw CIELAB textures (Task 4)**: Creates speckled dark patches flagged as facade_holes
- **Height truncation**: Google 3D Tiles LOD only captures 36-61% of buildings >80m
- **DDA shadows + AO (Tasks 6-7)**: Compound darkness with CIELAB makes facades look damaged
- **Neighbor merging**: Dense urban captures (NYC) include surrounding buildings

### Blockers
1. **GLB capture**: 7/10 buildings need browser-based capture via tiles-headless (WebGL required)
2. **Height truncation**: Fundamental Google 3D Tiles LOD limitation for buildings >100m
3. **Facade quality**: Raw CIELAB + DDA + AO creates noisy facades that trigger VLM defect flags

## Action Items
- [ ] Capture GLBs for 7 pending buildings (requires browser WebGL)
- [ ] Investigate facade smoothing: larger kernel, bilateral filter, or partial zone normalization
- [ ] Consider shorter buildings (<80m) to avoid height truncation
- [ ] Run Pennzoil with 11 runs for stable trimmed mean
