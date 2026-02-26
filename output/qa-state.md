# QA Orchestrator State

> Read this file after context compaction to resume pipeline work.

## Current Phase: Implementation + Visual QA
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

### Phase 3: Geometry Improvements
- [x] 3C: Improved polygon rasterization (winding-number PIP) — 86d29c9
- [x] 3D: Stucco color gap fix — 2 new WALL_CLUSTERS for warm brown/olive range
- [ ] 3A-scoped: Multi-segment solar pitch → per-segment roofHeightOverride
- [ ] Regenerate comparison-data.json with current pipeline (stale data root cause)
- [ ] Build + deploy + CI green

### Visual QA: Gemini Image Review (9 addresses)
- [ ] sf: 2340 Francisco St, San Francisco, CA 94123
- [ ] newton: 240 Highland St, Newton, MA 02465
- [ ] sanjose: 525 S Winchester Blvd, San Jose, CA 95128
- [ ] walpole: 13 Union St, Walpole, NH 03608
- [ ] byron: 2431 72nd St SW, Byron Center, MI 49315
- [ ] vinalhaven: 216 Zekes Point Rd, Vinalhaven, ME 04863
- [ ] suttonsbay: 5835 S Bridget Rose Ln, Suttons Bay, MI 49682
- [ ] losangeles: 2607 Glendower Ave, Los Angeles, CA 90027
- [ ] seattle: 4810 SW Ledroit Pl, Seattle, WA 98136

### Remaining TODOs (blocked on generator rotation)
- [ ] streetViewHeading → facade orientation
- [ ] solarAzimuthDegrees → ridge direction

---

## Completion Criteria
All implementation checkboxes [x], CI green, site live, Gemini review complete for all 9.
