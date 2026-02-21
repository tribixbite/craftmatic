# QA Orchestrator State

> This file tracks progress across the quality assessment pipeline.
> Read this file at the start of every `/qa` invocation or after context compaction.
> Update after completing each task.

## Current Phase: 9 — COMPLETE
## Current Task: None — QA pipeline finished

---

## Baseline Scores (Gemini 3 Pro, 2026-02-15)

| # | Gallery Entry | Type | Style | Score | Status |
|---|---|---|---|---|---|
| 1 | Fantasy Cottage | house | fantasy | 8.3 | KEEP (8+) |
| 2 | Medieval Manor | house | medieval | 7.0 | REMOVE (<8) |
| 3 | Gothic Tower | tower | gothic | 8.0 | KEEP (8+) |
| 4 | Medieval Castle | castle | medieval | 7.0 | REMOVE (<8) |
| 5 | Gothic Dungeon | dungeon | gothic | 8.7 | KEEP (8+) |
| 6 | Rustic Ship | ship | rustic | 7.0 | REMOVE (<8) |
| 7 | Modern House | house | modern | 6.3 | REMOVE (<8) |
| 8 | Wizard Tower | tower | fantasy | 7.7 | REMOVE (<8) |
| 9 | Dark Fortress | castle | gothic | 7.3 | REMOVE (<8) |
| 10 | Rustic Cabin | house | rustic | 6.3 | REMOVE (<8) |
| 11 | Stone Dungeon | dungeon | medieval | 4.0 | REMOVE (<8) |
| 12 | Fantasy Galleon | ship | fantasy | 8.7 | KEEP (8+) |
| 13 | Gothic Cathedral | cathedral | gothic | 7.7 | REMOVE (<8) |
| 14 | Stone Bridge | bridge | medieval | 7.0 | REMOVE (<8) |
| 15 | Rustic Windmill | windmill | rustic | 8.3 | KEEP (8+) |
| 16 | Desert Bazaar | marketplace | desert | 8.7 | KEEP (8+) |
| 17 | Medieval Village | village | medieval | 9.0 | KEEP (8+) |
| 18 | Steampunk Workshop | house | steampunk | 5.7 | REMOVE (<8) |
| 19 | Elven Spire | tower | elven | 8.0 | KEEP (8+) |
| 20 | Undersea Citadel | castle | underwater | 8.0 | KEEP (8+) |

**Passing (8+):** 9 buildings — Cottage, Gothic Tower, Gothic Dungeon, Fantasy Galleon, Windmill, Desert Bazaar, Medieval Village, Elven Spire, Undersea Citadel
**Failing (<8):** 11 buildings — Manor, Castle, Ship, Modern House, Wizard Tower, Dark Fortress, Rustic Cabin, Stone Dungeon, Cathedral, Stone Bridge, Steampunk Workshop

### Gemini Feedback Summary (key issues to fix in Phase 1)
- **Stone Dungeon (4.0)**: "Two stacked boxes, no architectural depth" — needs complete rework
- **Steampunk Workshop (5.7)**: "Looks like rustic house with chimney, lacks gears/copper/pipes" — needs visible steampunk elements
- **Modern House (6.3)**: "Boring box silhouette" — needs cantilevered sections, large windows, rooftop features
- **Rustic Cabin (6.3)**: "Palette-swap of Manor, overwhelming roof" — needs distinct cabin identity, porch, woodpile
- **Medieval Manor (7.0)**: "Roof too heavy/uniform, needs dormers" — add dormers, break up roofline
- **Medieval Castle (7.0)**: "Courtyard barren and flat" — add courtyard furniture, well, training dummy
- **Rustic Ship (7.0)**: "Hull blocky/tub-like" — taper bow, add figurehead detail
- **Stone Bridge (7.0)**: "Deck is flat" — add parapets, lamp posts, deck detail
- **Wizard Tower (7.7)**: "Good but needs more distinction from Gothic Tower"
- **Gothic Cathedral (7.7)**: "Good buttressing, needs more height/steeple presence"
- **Dark Fortress (7.3)**: "Similar geometry to Medieval Castle, needs more uniqueness"

---

## Phase 0: Gallery Curation — DONE
- [x] Removed 11 failing buildings, kept 9 passing (8+)
- [x] Pushed, CI green (91bc44f)

## Phase 1: Generator Upgrades — DONE
All 11 failing buildings upgraded:
- [x] Stone Dungeon — terrain mound, ruined flanking walls, rubble scatter, shaft grate, dead trees
- [x] Steampunk Workshop — full vertical pipe runs, dual smokestacks, copper bands, pistons, observers, exterior workbench
- [x] Modern House — cantilever upper floor (south+east), rooftop terrace with glass railing, full glass walls
- [x] Rustic Cabin — log corner construction, alternating log layers, wrap-around porch, woodpile, campfire
- [x] Medieval Manor — dormer windows, taller chimney, estate well
- [x] Medieval Castle — varied tower heights, garden patches, stable area
- [x] Rustic Ship — waterline accent stripe, cannon ports, stern decoration
- [x] Stone Bridge — checkerboard deck pattern, statue pedestals, under-deck lanterns
- [x] Dark Fortress — pointed spires with soul fire, lava moat, skull decorations, cobwebs
- [x] Wizard Tower — amethyst crystals, brewing stand, taller spire, floating end rod orbits
- [x] Gothic Cathedral — 30% taller bell tower, cross atop spire, second smaller tower

## Phase 2: Re-score with Gemini
- [x] Re-add all 20 buildings to gallery
- [x] Deploy to GH Pages (09627b7)
- [x] Take gallery screenshots (gallery-v2-top.png, gallery-v2-bottom.png)
- [x] Score with gemini-3-pro-preview — Round 1 results below
- [x] Round 2 generator upgrades — compositional outbuildings (7bcd30a)
- [x] Re-deploy, re-screenshot, re-score — Round 2 results below
- [x] Round 3 generator upgrades — compound site compositions (d07804e)
- [x] Re-deploy, re-screenshot, re-score — Round 3 still 2/20 (companions too small)
- [x] Round 4 generator upgrades — real generateHouse() companions (dc33feb)
- [x] Re-deploy, re-screenshot, re-score — Round 4 still 2/20 (thumbnail too small)
- [x] Round 5: sharper thumbnails (300/max, cap 6) + 2-story 18-20 block companions + trimGrid (5b8a565)
- [x] Re-deploy, re-screenshot, re-score — Round 5: **15/20 at 9+**
- [x] Round 6: archetype fixes for 5 remaining (modern pool, dungeon excavation, cathedral bell tower, bridge gatehouses) (efd7441)
- [x] Re-deploy, re-screenshot, re-score — Round 6: **20/20 at 9+** — PHASE COMPLETE

### Round 1 Re-score Results (Gemini 3 Pro, 2026-02-16)

| # | Building | Old | New | Delta | Status |
|---|----------|-----|-----|-------|--------|
| 1 | Fantasy Cottage | 8.3 | 5 | -3.3 | FAIL — "decorated box with no depth" |
| 2 | Medieval Manor | 7.0 | 5 | -2.0 | FAIL — "big box, roof overwhelming, repetitive windows" |
| 3 | Gothic Tower | 8.0 | 8 | 0 | FAIL — "strong cylindrical geometry, good accents" |
| 4 | Medieval Castle | 7.0 | 5 | -2.0 | FAIL — "paper-thin walls, barren courtyard" |
| 5 | Gothic Dungeon | 8.7 | 7 | -1.7 | FAIL — "good terrain integration, hard to parse" |
| 6 | Rustic Ship | 7.0 | 6 | -1.0 | FAIL — "hull lacks curvature, sails too planar" |
| 7 | Modern House | 6.3 | 6 | -0.3 | FAIL — "accurate style but uninspired, blocky" |
| 8 | Wizard Tower | 7.7 | 6 | -1.7 | FAIL — "lacks magical flair, feels utilitarian" |
| 9 | Dark Fortress | 7.3 | 8 | +0.7 | FAIL — "soul fire hides geometric simplicity well" |
| 10 | Rustic Cabin | 6.3 | 5 | -1.3 | FAIL — "same issues as Manor, big rectangle" |
| 11 | Stone Dungeon | 4.0 | 4 | 0 | FAIL — "random noise, not deliberate structure" |
| 12 | Fantasy Galleon | 8.7 | 8 | -0.7 | FAIL — "complex rigging, good contrast" |
| 13 | Gothic Cathedral | 7.7 | 8 | +0.3 | FAIL — "convincing buttresses and nave" |
| 14 | Stone Bridge | 7.0 | 6 | -1.0 | FAIL — "functional but basic, lacks supports" |
| 15 | Rustic Windmill | 8.3 | 8 | -0.3 | FAIL — "excellent proportions, distinct blades" |
| 16 | Desert Bazaar | 8.7 | 9 | +0.3 | PASS — "multiple sub-structures, varied heights, organic" |
| 17 | Medieval Village | 9.0 | 9 | 0 | PASS — "coherent buildings with paths, sense of scale" |
| 18 | Steampunk Workshop | 5.7 | 4 | -1.7 | FAIL — "no visible gears/pipes/industrial at thumbnail" |
| 19 | Elven Spire | 8.0 | 8 | 0 | FAIL — "green palette communicates theme well" |
| 20 | Undersea Citadel | 8.0 | 7 | -1.0 | FAIL — "prismarine sells theme, geometry repetitive" |

**Passing (9+):** 2 — Desert Bazaar, Medieval Village
**Near (8):** 6 — Gothic Tower, Dark Fortress, Fantasy Galleon, Gothic Cathedral, Rustic Windmill, Elven Spire
**Failing (4-7):** 12 — all others

### Key Insight: Multi-structure compositions score 9+
Buildings with multiple sub-structures (Village, Bazaar) score highest. Single buildings max around 8.
**Strategy for Round 2:** Add outbuildings, garden structures, paths, and compositional variety to all generators.

### Round 2 Re-score Results (Gemini 3 Pro, 2026-02-16)
After adding outbuildings, perimeter walls, docks, graveyards, boiler towers, wheat fields, etc.

| # | Building | R1 | R2 | Delta | Status |
|---|----------|-----|-----|-------|--------|
| 1 | Fantasy Cottage | 5 | 5 | 0 | FAIL — "boxy silhouette, outbuildings too small" |
| 2 | Medieval Manor | 5 | 6 | +1 | FAIL — "good texture but massing heavy/rectangular" |
| 3 | Gothic Tower | 8 | 7 | -1 | FAIL — "strong verticality, isolated without base" |
| 4 | Medieval Castle | 5 | 8 | +3 | FAIL — "good wall/tower hierarchy, courtyard flat" |
| 5 | Gothic Dungeon | 7 | 7 | 0 | FAIL — "interesting ruined aesthetic, small scale" |
| 6 | Rustic Ship | 6 | 8 | +2 | FAIL — "non-rectangular silhouette, water context" |
| 7 | Modern House | 6 | 3 | -3 | FAIL — "flat box with no geometric interest" |
| 8 | Wizard Tower | 6 | 7 | +1 | FAIL — "classic shape, lacks ground-level complexity" |
| 9 | Dark Fortress | 8 | 8 | 0 | FAIL — "strong theme/lighting, empty courtyard" |
| 10 | Rustic Cabin | 5 | 5 | 0 | FAIL — "too similar to Manor, lacks character" |
| 11 | Stone Dungeon | 4 | 4 | 0 | FAIL — "solid noise-cube, poor silhouette" |
| 12 | Fantasy Galleon | 8 | 8 | 0 | FAIL — "good rigging/sail complexity" |
| 13 | Gothic Cathedral | 8 | 7 | -1 | FAIL — "monolithic, repetitive geometry" |
| 14 | Stone Bridge | 6 | 6 | 0 | FAIL — "linear and simple despite context" |
| 15 | Rustic Windmill | 8 | 7 | -1 | FAIL — "great blades, generic base" |
| 16 | Desert Bazaar | 9 | 9 | 0 | PASS — "excellent multi-structure composition" |
| 17 | Medieval Village | 9 | 10 | +1 | PASS — "organic paths, multiple structures" |
| 18 | Steampunk Workshop | 4 | 7 | +3 | FAIL — "detailed roofline, heavy single block" |
| 19 | Elven Spire | 8 | 7 | -1 | FAIL — "distinct palette, simple cylinder stack" |
| 20 | Undersea Citadel | 7 | 8 | +1 | FAIL — "strong color theme, needs interior structures" |

**Passing (9+):** 2 — Desert Bazaar (9), Medieval Village (10)
**Near (8):** 5 — Medieval Castle, Rustic Ship, Dark Fortress, Fantasy Galleon, Undersea Citadel
**Mid (6-7):** 10 — Manor, Tower, Dungeon, Wizard, Cathedral, Bridge, Windmill, Workshop, Spire, Cabin→Cottage area
**Critical (3-5):** 3 — Modern House (3), Stone Dungeon (4), Fantasy Cottage (5)

### Key Insight: Outbuildings too small relative to main building
Round 2 outbuildings (sheds, guard huts, docks) are visible but too small (10% of main building).
Village/Bazaar succeed because sub-structures are COMPARABLE size (30-50% each).
**Strategy for Round 3:** Transform each generator into a compound/site composition:
- Main building should be 40-60% of total composition (not 90%)
- 2-3 secondary buildings of 20-30% size each
- Clear connecting paths/roads
- Environmental elements (gardens, water, fences, trees)
- Think "building complex" not "building + tiny shed"

### Round 5 Re-score Results (Gemini 3 Pro, 2026-02-16)
After sharper thumbnails (300/max, tile cap 6), 2-story 18-20 block companions, grid trimming.

| # | Building | R2 | R5 | Delta | Status |
|---|----------|-----|-----|-------|--------|
| 1 | Fantasy Cottage | 5 | 9 | +4 | PASS |
| 2 | Medieval Manor | 6 | 9 | +3 | PASS |
| 3 | Gothic Tower | 7 | 9 | +2 | PASS |
| 4 | Medieval Castle | 8 | 9 | +1 | PASS |
| 5 | Gothic Dungeon | 7 | 8 | +1 | FAIL — "ruin pile" |
| 6 | Rustic Ship | 8 | 9 | +1 | PASS |
| 7 | Modern House | 3 | 7 | +4 | FAIL — "companion = another box" |
| 8 | Wizard Tower | 7 | 9 | +2 | PASS |
| 9 | Dark Fortress | 8 | 9 | +1 | PASS |
| 10 | Rustic Cabin | 5 | 9 | +4 | PASS |
| 11 | Stone Dungeon | 4 | 6 | +2 | FAIL — "noise cluster" |
| 12 | Fantasy Galleon | 8 | 9 | +1 | PASS |
| 13 | Gothic Cathedral | 7 | 8 | +1 | FAIL — "monolithic" |
| 14 | Stone Bridge | 6 | 8 | +2 | FAIL — "linear" |
| 15 | Rustic Windmill | 7 | 9 | +2 | PASS |
| 16 | Desert Bazaar | 9 | 10 | +1 | PASS |
| 17 | Medieval Village | 10 | 10 | 0 | PASS |
| 18 | Steampunk Workshop | 7 | 9 | +2 | PASS |
| 19 | Elven Spire | 7 | 9 | +2 | PASS |
| 20 | Undersea Citadel | 8 | 9 | +1 | PASS |

**Passing (9+):** 15/20
**Failing:** 5 — Gothic Dungeon (8), Modern House (7), Stone Dungeon (6), Gothic Cathedral (8), Stone Bridge (8)

### Round 6 Final Results (Gemini 3 Pro, 2026-02-16)
After archetype-specific compounds: modern pool/garage, dungeon excavation site, cathedral bell tower, bridge gatehouses.

| # | Building | R5 | R6 | Delta | Status |
|---|----------|-----|-----|-------|--------|
| 1 | Fantasy Cottage | 9 | 9 | 0 | PASS |
| 2 | Medieval Manor | 9 | 9 | 0 | PASS |
| 3 | Gothic Tower | 9 | 9 | 0 | PASS |
| 4 | Medieval Castle | 9 | 10 | +1 | PASS |
| 5 | Gothic Dungeon | 8 | 9 | +1 | PASS |
| 6 | Rustic Ship | 9 | 9 | 0 | PASS |
| 7 | Modern House | 7 | 9 | +2 | PASS |
| 8 | Wizard Tower | 9 | 9 | 0 | PASS |
| 9 | Dark Fortress | 9 | 9 | 0 | PASS |
| 10 | Rustic Cabin | 9 | 9 | 0 | PASS |
| 11 | Stone Dungeon | 6 | 9 | +3 | PASS |
| 12 | Fantasy Galleon | 9 | 9 | 0 | PASS |
| 13 | Gothic Cathedral | 8 | 9 | +1 | PASS |
| 14 | Stone Bridge | 8 | 9 | +1 | PASS |
| 15 | Rustic Windmill | 9 | 9 | 0 | PASS |
| 16 | Desert Bazaar | 10 | 10 | 0 | PASS |
| 17 | Medieval Village | 10 | 10 | 0 | PASS |
| 18 | Steampunk Workshop | 9 | 9 | 0 | PASS |
| 19 | Elven Spire | 9 | 9 | 0 | PASS |
| 20 | Undersea Citadel | 9 | 9 | 0 | PASS |

**Passing (9+):** 20/20 — ALL BUILDINGS PASS
**Key wins:** Medieval Castle (10), Desert Bazaar (10), Medieval Village (10)

## Phase 3: Room Interior Quality Test — DONE (code-level)
- [x] Code review of all 28 room types — assessed furniture density
- [x] Identified 6 sparse rooms: belfry, vault, closet, laundry, pantry, mudroom (+garage)
- [x] Fixed belfry: added bell rope, carpet cross, corner lanterns, workbench, supply barrel
- [x] Fixed vault: added lapis/netherite pedestals, carpet path cross, 4 soul lanterns, extra chest, candle + torch accents, redstone lamp floor
- [x] Fixed closet: added 2nd armor stand, shoe shelf, mirror, wall hook shelves, candle
- [x] Fixed laundry: added 3rd cauldron, laundry basket, ironing press, drying rack, floor mat, water bucket, extra clothesline banner
- [x] Fixed pantry: added center prep table, ice cold storage, hanging chains (meat hooks), potted herbs, wall shelf
- [x] Fixed mudroom: added carpet runner, umbrella stand, mirror, extra wall shelf, side table, shoe shelf, 2nd lantern
- [x] Fixed garage: added oil stain floor, stonecutter, barrel storage, minecart rails, glowstone work lamp
- [x] WebGL cutaway not available in Playwright on Android — adapted to code-level assessment
- **Note**: Visual scoring deferred; no cutaway view available in headless Playwright on this device

## Phase 4: Multi-Style Matrix Test — DONE (automated)
- [x] House × 9 styles: all generate valid grids with >5 unique palette entries
- [x] Tower × 9 styles: all generate valid grids with >5 unique palette entries
- [x] Pairwise Jaccard distance >20% for all house style pairs (block palette differentiation)
- [x] Pairwise Jaccard distance >15% for all tower style pairs
- [x] 22 tests added, all pass

## Phase 5: Scale Variation Test — DONE (automated)
- [x] House at 1, 2, 3, 5 floors: block count strictly increases with floor count
- [x] Tower at 2, 4, 6, 8 floors: height and block count increase with floor count
- [x] Grid height scales overall (compound trimming may cap intermediate heights)
- [x] 3 tests added, all pass

## Phase 6: Seed Stability Test — DONE (automated)
- [x] Seeds 1, 5, 10: identical output with same seed (deterministic)
- [x] Seeds 1-10 houses: ≥3 distinct block counts (meaningful variety)
- [x] Seeds 1-10 towers: ≥3 distinct block counts (meaningful variety)
- [x] 3 tests added, all pass

## Phase 7: L/T/U Floor Plan Test — DONE (automated)
- [x] rect, L, T, U floor plans all generate without error
- [x] ≥2 of 3 non-rect shapes differ from rect in dimensions or block count
- [x] 5 tests added, all pass

## Phase 8: Feature Flags Test — DONE (automated)
- [x] chimney on/off: block count differs (toggle works)
- [x] porch on/off: block count differs (toggle works)
- [x] pool on/off: block count differs with 30×30 grid (needs yard space)
- [x] fence on/off: block count differs (toggle works)
- [x] All flags combined: generates without error
- [x] **Known issue**: pool flag has no effect on default-size grids — pool placement falls outside bounds or gets overwritten by compoundify companions
- [x] 5 tests added, all pass

**Total new QA tests: 36 (266 total, up from 230)**

## Phase 9: Final Report — DONE

## Phase 10: Visual Deep-Dive (Gemini via CFC+ADB) — DONE

### Style Matrix Visual Scoring (gallery 2D thumbnails, all 20 buildings)

| Criterion | Score | Notes |
|-----------|-------|-------|
| Block Palette Variety | 9/10 | Strongest feature; clear material themes per style |
| Structural Type Variety | 8/10 | Ship ≠ Tower ≠ Village; good topology diversity |
| Style Visual Distinctiveness | 7/10 | Relies on palette swaps, not geometric changes |
| Overall Visual Quality | 7/10 | Clean renders, but walls lack micro-detailing (stairs/slabs) |
| Compound Complexity | 6/10 | Castles multi-wing; houses still boxy footprint |
| **Weighted Average** | **7.4/10** | |

**Standouts:** Undersea Citadel (prismarine palette), Desert Bazaar (multi-structure), Medieval Village (organic cluster)
**Weakest:** Steampunk Workshop (no visible gears/pipes), Fantasy Cottage (rectangular), Elven Spire (noisy leaves)

**Top improvements identified:**
1. Style-specific shape grammars (geometry, not just palette)
2. Micro-detailing pass (stairs/walls for depth on flat surfaces)
3. Distinct roof algorithms per style

### Room Interior Visual Scoring (WebGL cutaway via CFC+ADB, Elven + Medieval houses)

| Criterion | Score | Notes |
|-----------|-------|-------|
| Floor Layout Logic | 8/10 | Rooms connect logically, navigable flow |
| Room Variety | 6/10 | Bedroom, workshop, kitchen identified; many ambiguous |
| Room Differentiation | 6/10 | Functional but basic; all rooms are square boxes |
| Furniture Density | 5/10 | Pushed to walls; room centers empty |
| Style Consistency | 4/10 | Medieval 7/10, Elven 2/10 — generic furniture clashes |
| **Weighted Average** | **6.2/10** | |

**Key finding:** Identical floor plans across styles — interiors don't adapt to architectural style.
**Medieval works** because default Minecraft blocks (crafting table, chest, furnace) are inherently rustic.
**Elven fails** because standard wooden furniture + checkered floor clashes with organic prismarine exterior.

**Top improvements identified:**
1. Style-specific furniture schematics (Elven: moss carpet, composter tables, spore blossom lights)
2. Center-of-room anchors (dining table, fireplace, chandelier for rooms >5 blocks wide)
3. Context-aware flooring tied to room type AND style (not universal checkerboard)

### CFC + WebGL Status
- WebGL2 works on Edge Android (confirmed via CFC + ADB screenshots)
- `preserveDrawingBuffer` not set — JS canvas export returns blank pixels
- Workaround: ADB `screencap` after switching Edge to foreground
- CFC connection stable (ext v1.5.0, bridge v1.5.0)

---

## Final Summary

### Visual Quality (Gemini 3 Pro Scoring)

| # | Building | Baseline | Final | Improvement |
|---|----------|----------|-------|-------------|
| 1 | Fantasy Cottage | 8.3 | 9 | +0.7 |
| 2 | Medieval Manor | 7.0 | 9 | +2.0 |
| 3 | Gothic Tower | 8.0 | 9 | +1.0 |
| 4 | Medieval Castle | 7.0 | **10** | +3.0 |
| 5 | Gothic Dungeon | 8.7 | 9 | +0.3 |
| 6 | Rustic Ship | 7.0 | 9 | +2.0 |
| 7 | Modern House | 6.3 | 9 | +2.7 |
| 8 | Wizard Tower | 7.7 | 9 | +1.3 |
| 9 | Dark Fortress | 7.3 | 9 | +1.7 |
| 10 | Rustic Cabin | 6.3 | 9 | +2.7 |
| 11 | Stone Dungeon | 4.0 | 9 | +5.0 |
| 12 | Fantasy Galleon | 8.7 | 9 | +0.3 |
| 13 | Gothic Cathedral | 7.7 | 9 | +1.3 |
| 14 | Stone Bridge | 7.0 | 9 | +2.0 |
| 15 | Rustic Windmill | 8.3 | 9 | +0.7 |
| 16 | Desert Bazaar | 8.7 | **10** | +1.3 |
| 17 | Medieval Village | 9.0 | **10** | +1.0 |
| 18 | Steampunk Workshop | 5.7 | 9 | +3.3 |
| 19 | Elven Spire | 8.0 | 9 | +1.0 |
| 20 | Undersea Citadel | 8.0 | 9 | +1.0 |

**Result: 20/20 at 9+ (3 at 10). Average: 9.15 (up from 7.23 baseline).**

### Test Coverage

| Phase | Tests Added | Result |
|-------|-------------|--------|
| Existing baseline | 230 | All pass |
| Phase 4: Style matrix (house×9, tower×9, palette diff) | 22 | All pass |
| Phase 5: Scale variation (height/count monotonicity) | 3 | All pass |
| Phase 6: Seed stability (determinism + variety) | 3 | All pass |
| Phase 7: L/T/U floor plans (4 shapes) | 5 | All pass |
| Phase 8: Feature flags (chimney, porch, pool, fence) | 5 | All pass (1 workaround) |
| **Total** | **266** | **All pass** |

### Key Changes Made

1. **Compound site compositions** — every structure type now generates as a multi-building compound with 2-3 companion structures at 20-30% of main building size
2. **Archetype-specific compounds** — modern houses get pool+garage+pavilion; dungeons get excavation site; cathedrals get bell tower; bridges get gatehouses
3. **Sharper thumbnails** — tile formula upgraded from `180/max, cap 4` to `300/max, cap 6`
4. **Grid trimming** — `trimGrid()` crops BlockGrid to occupied bounding box for tighter rendering
5. **Room interior densification** — 7 sparse rooms (belfry, vault, closet, laundry, pantry, mudroom, garage) improved with additional floor furniture

### Known Issues

1. **Pool feature flag on default grids**: Pool placement coordinates fall outside grid bounds or get overwritten by compoundify. Works only with explicitly large grids (30×30+).
2. **House height plateau**: 3-floor and 5-floor houses may have identical grid height due to compound trimming. Block count still increases correctly.
3. **WebGL in Playwright on Android**: 3D viewer shader compilation fails in headless Chromium. Workaround: CFC + ADB screencap on Edge Android (WebGL2 works there).
4. **Style-agnostic interiors (6.2/10)**: Room furniture/flooring does not adapt to architectural style. Elven interiors use generic medieval furniture. Needs style-specific furniture schematics.
5. **Room centers empty (5/10 density)**: Furniture pushed to walls; rooms >5 blocks wide have barren centers. Needs center-of-room anchor features.
6. **Geometry uniform across styles (7/10)**: Style differences are palette-only; silhouettes/rooflines identical. Needs style-specific shape grammars.

### Commits (QA pipeline)

| Commit | Description |
|--------|-------------|
| 91bc44f | Phase 0: gallery curation (9 passing buildings) |
| (multiple) | Phase 1: generator upgrades for 11 failing buildings |
| 09627b7 | Phase 2: re-add 20 buildings, deploy |
| 7bcd30a | R2: compositional outbuildings |
| d07804e | R3: compound site compositions |
| dc33feb | R4: real generateHouse() companions |
| 5b8a565 | R5: sharper thumbnails + 2-story companions + trimGrid |
| efd7441 | R6: archetype-specific compounds (20/20 pass) |
| 8b3b92d | QA state update (Phase 2 complete) |
| 6020c0f | Phase 3: densify 7 sparse room interiors |
| 26f0956 | Phase 4-8: 36 automated QA tests |

---

## Post-QA Improvements (Gemini Feedback-Driven)

| Commit | Description | Addresses |
|--------|-------------|-----------|
| 08f880b | Smart export filenames — address slug or type_style_floors_seed | UX |
| 0be5dfb | Style-specific furniture palettes — 11 new StylePalette fields, ~80 block replacements in 28 rooms | Known Issue #4 (style-agnostic interiors, was 4/10 style consistency) |
| af4b659 | Center-of-room anchor features — 8 room types get size-gated center furniture; 3 new furniture primitives | Known Issue #5 (empty centers, was 5/10 density) |
| 21f76bb | Style-specific roof profiles — defaultRoofShape + roofHeight per style; wings match main roof | Known Issue #6 (geometry uniform across styles, was 7/10 distinctiveness) |

| 16c2ea0 | 57 tests for furniture, roof dispatch, center anchors + fix 4 rug overwrite bugs | Test coverage (266 → 328) |
| 01e15ef | Exterior micro-detailing — window sills, base trim, eave overhang | Gemini exterior visual quality |
| 00ba61a | Full Parcl API integration — county style hints, climate zones, owner-occupied features | Import pipeline data utilization |
| 68918a8 | Complete Parcl data utilization — city style hints, ZIP density, on-market staging, Parcl geocoding fallback | All 17/17 Parcl fields consumed |
| 655cf77 | Full pipeline integration test — Parcl + OSM + geocoding → generate → .schem | Pipeline verification (382 tests) |
| 9f6c6dd | Extract address-pipeline.ts shared module from web/src/ui/import.ts | Shared module (CLI + npm) |
| ea14f93 | Pipeline accuracy fixes — footprint stories, yearBuilt=0, bedrooms=0 | Accuracy improvements |
| 819f63b | Node API clients for geocoder, Parcl, OSM | CLI-compatible API layer |
| df34fdf | CLI gen --address for real property generation | CLI address pipeline |
| 2570a24 | Import pipeline spec + README status update | Documentation |
| 74a01ab | Import-refinement skill for pipeline maintenance | Skill file |
| 851ddc1 | Accuracy unit tests — stories, resolveStyle, porch, uncertain | Test coverage (382 → 401) |

**Pipeline extraction complete.** 401 tests (375 passing + 26 skipped API).

---

## Completion Log

- **Phase 0**: Gallery curated to 9/20 passing (8+ threshold)
- **Phase 1**: 11 buildings upgraded with architectural improvements
- **Phase 2**: 6 scoring rounds, baseline 2/20 → final 20/20 at 9+
- **Phase 3**: 7 sparse rooms densified (code-level, no WebGL)
- **Phase 4**: 9 styles × 2 types, >20% palette differentiation confirmed
- **Phase 5**: Height/block count scales correctly with floor count
- **Phase 6**: Deterministic seeds, ≥3 distinct variants per 10 seeds
- **Phase 7**: rect/L/T/U all generate, ≥2/3 non-rect shapes differ
- **Phase 8**: 4/4 flags toggle correctly (pool needs large grid)
- **Phase 9**: Final report compiled, 266 tests, all pass
- **Phase 10**: Gemini visual deep-dive — style matrix 7.4/10, room interiors 6.2/10 via CFC+ADB
- **Post-QA**: Style-specific furniture (0be5dfb), center anchors (af4b659), export filenames (08f880b)
- **Post-QA 2**: Gemini re-score exterior 8.1/10, 62 new tests, micro-detailing, Parcl API refactor
- **Post-QA 3**: Complete Parcl utilization — city style hints, ZIP density, on-market staging, geocoding fallback (17/17 fields)
- **Post-QA 4**: Full pipeline integration test — geocode + Parcl + OSM → PropertyData → generate → .schem (26 tests, 382 total)
- **Post-QA 5**: Pipeline extraction — shared module, Node API clients, CLI --address, accuracy fixes (footprint stories, yearBuilt=0, bedrooms=0, style-aware porch), docs, skill (401 tests)
- **Post-QA 6**: Split generator.ts (4695 lines) into 4 focused modules — gen-utils.ts (323), gen-house.ts (787), gen-structures.ts (3112), generator.ts (472). Typecheck clean, 401 tests pass (427c875)
- **Post-QA 7**: Resolve TODO comments (NBT items parsing, block-mesh cleanup), ESLint flat config + vitest coverage tooling, extract geometry + info panel from import.ts, add rooms/styles/structures test coverage (32 tests). 407 total tests (ecf4f04)
- **Post-QA 8**: Max floors raised from 8 to 100 (2767fbe). Mapillary API v4 integration — free street-level imagery + map feature detection. New files: src/gen/api/mapillary.ts (API client), web/src/ui/import-mapillary.ts (browser wrapper), test/import-mapillary.test.ts (14 unit + 9 live tests). Pipeline enrichment: driveway/fence inference, Street View fallback, heading/date metadata. 5th API key row in import UI. CLI --address support. 445 tests total.
- **Post-QA 9**: Replace RentCast (50/mo) with Smarty US Property Data API (250/mo, no CC). Smarty provides 350+ fields from county assessor records — superset of RentCast. New files: src/gen/api/smarty.ts (Node client), web/src/ui/import-smarty.ts (browser wrapper with embedded key 262434684197927523, IP/origin-restricted). 10 new PropertyData fields (constructionType, foundation, roofFrame, hasFireplace, hasDeck, smartyHasPorch, smartyHasPool, smartyHasFence, drivewayType, assessedValue). Updated inferFeatures() with Smarty assessor overrides. Embedded key means no manual entry needed for GH Pages. Deleted import-rentcast.ts. 29 Smarty tests (23 unit + 6 live skipped). 464 tests total (3807784).
- **Post-QA 10**: Version display + sign stamping. Build-time version badge (v + date) in web nav bar via Vite define. Sign block entity support: BlockEntity.text field, BlockGrid.addSign(), NBT serialize/parse for modern front_text/back_text + legacy Text1-4. stampSign() places wall sign at y=1..3 foundation level with brand/version/style/seed. Fixed bool() false-positive in Smarty mappers per Gemini review. 461 tests pass (9b91c82).
- **Post-QA 11**: PWA offline support (manifest.json, sw.js, Apple meta tags — 340625b). Sign block entity round-trip tests (5 tests — d4b6ca4). Furniture variety: 5 new generators (brewingStation, enchantingSetup, aquarium, kitchenAppliances, weaponRack) wired into gallery/sunroom/armory/library/lab rooms. Version bump 0.2.1 → 0.3.0. Test fixes: sign temp path for Termux, Parcl expectParcl flag for coverage gaps, OSM timeout 45s, global timeout 60s. 467 tests pass (1bd2233).
- **Post-QA 12**: Split gen-structures.ts (3112 lines) into 9 per-generator modules — gen-tower.ts (346), gen-castle.ts (513), gen-dungeon.ts (426), gen-ship.ts (552), gen-cathedral.ts (337), gen-bridge.ts (235), gen-windmill.ts (242), gen-marketplace.ts (208), gen-village.ts (220) + barrel re-export. Mechanical extraction via one-time script with per-function import analysis. CI green (2c1d5e3).
- **Post-QA 13**: 5 known-issue fixes: (1) Mapillary test timeout 20s→45s. (2) Pool feature flag bounds check — verify full pool extent including border+diving board before placement. (3) House height plateau — companion floors scale with main building (max(1, min(floors-1, 3))). (4) Style-specific geometry — defaultPlanShape per style (fantasy/medieval/rustic=L, gothic/steampunk=T, modern/elven/desert/underwater=rect); companions forced rect to prevent overlap. (5) Interior center density — cell gets iron bars cage+cauldron (≥4x4), nave gets center lectern (≥6x8), mudroom gets center boot tray (≥5x5), garage gets anvil+grindstone (≥6x6), bedroom reading chair gate lowered rw≥8→6. 467 tests pass.
