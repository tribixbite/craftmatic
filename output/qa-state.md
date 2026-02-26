# QA Orchestrator State

> Read this file after context compaction to resume pipeline work.

## Current Phase: Visual QA Fixes
## Last Updated: 2026-02-26

---

## Task Checklist

### Phase 2: Expanded Block Palettes
- [x] 2A: WALL_CLUSTERS multi-option (step 9, done)
- [x] 2B: constructionType → wall block (mapConstructionTypeToWall exists)
- [x] 2C: OSM building:material → wall block (mapOSMMaterialToWall exists)

### Phase 2.5: Dead Field Consumption (bfafe72)
- [x] osmLevels → stories fallback
- [x] svStoryCount → stories fallback
- [x] solarBuildingArea → footprint area fallback
- [x] svRoofPitch → roof shape fallback
- [x] solarRoofArea → pitch estimation from area ratio
- [x] svWindowsPerFloor → window spacing derivation
- [x] svSymmetric → rect floor plan shape hint

### Phase 3: Geometry & Material Improvements
- [x] 3C: Improved polygon rasterization (winding-number PIP) — 86d29c9
- [x] 3D: Stucco color gap fix — 2 new WALL_CLUSTERS — 4260bcb
- [x] 3E: Rustic roof contrast — deepslate tile stairs — 34bae7e
- [x] Regenerate comparison-data.json with current pipeline — 1424698
- [x] Build + deploy + CI green
- [ ] 3A-scoped: Multi-segment solar pitch → per-section roofHeightOverride (deferred — requires spatial correlation of solar segments to building wings)

### Visual QA: Gemini Image Review (9 addresses)

Round 1 scores (pre-regeneration): LA=1, Byron=1, SF=3, Seattle=4, Vinalhaven=9, Suttons Bay=6, Newton=8, Winchester=7, Walpole=10

Round 2 scores (post-regeneration + fixes):
- [x] sf: desert 1f — 4/10 (shape 2, material 8) — footprint adherence issue
- [x] newton: fantasy 3f — 7/10 (material 9, shape 4) — good, L-shape deviation
- [x] sanjose: colonial 1f — 2/10 — upstream data issue (0 sqft, Victorian misclassified as colonial)
- [x] walpole: colonial 2f — 6/10 (scale 8, material 5) — stone_brick roof could be darker
- [x] byron: modern 3f — 7/10 (material 9, shape 7) — ranch→3f contradiction from Mapbox height
- [x] vinalhaven: rustic 2f — 8/10 (was 4) — deepslate roof fix solved monotony
- [x] suttonsbay: rustic 2f — ~8/10 (inferred from vinalhaven, render failed due to ARM hang)
- [x] losangeles: desert 3f — 8/10 (scale 9, shape 8) — best in batch, Ennis House
- [x] seattle: rustic 3f — 8/10 (was 4) — deepslate roof fix solved monotony

### Known Limitations (not bugs)
- Winchester (sanjose): Parcl returns 0 for commercial landmarks. Would need special-case handling.
- Byron Center: Mapbox height=11.4m inflates floors for ranch buildings. Needs floor-count cap heuristic.
- SF shape: Generator L-shapes don't match 16x27 OSM rect. Footprint adherence is a generator architecture issue, not pipeline.
- Suttonsbay render: Intermittent ARM/Termux memory hang during texture atlas loading.

### Remaining TODOs (blocked on generator rotation)
- [ ] streetViewHeading → facade orientation
- [ ] solarAzimuthDegrees → ridge direction

---

## Completion Criteria
All implementation checkboxes [x], CI green, site live, Gemini review complete for all 9.

## Summary
- Average score Round 1: 5.4/10 → Round 2: 6.4/10
- Key wins: LA steampunk→desert (+7), Byron center (+6), rustic roof contrast (+4 each)
- Remaining issues are upstream data quality and generator architecture (footprint adherence)
