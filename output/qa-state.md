# QA Orchestrator State

> This file tracks progress across the quality assessment pipeline.
> Read this file at the start of every `/qa` invocation or after context compaction.
> Update after completing each task.

## Current Phase: 2 — Re-score with Gemini
## Current Task: Round 2 generator upgrades — fix 18 buildings below 9

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
- [ ] Round 2 generator upgrades targeting 9+ (in progress)
- [ ] Re-deploy, re-screenshot, re-score
- [ ] Fix and re-score until all 9+

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

## Phase 3: Room Interior Quality Test
- [ ] Click each building in gallery, switch to cutaway/floor view
- [ ] Screenshot each floor of 5 representative buildings
- [ ] Score room furnishing quality with Gemini
- [ ] Fix any empty/sparse rooms

## Phase 4: Multi-Style Matrix Test
- [ ] Generate House in all 9 styles, screenshot grid
- [ ] Generate Tower in all 9 styles, screenshot grid
- [ ] Score style differentiation with Gemini
- [ ] Fix any styles that look too similar

## Phase 5: Scale Variation Test
- [ ] Generate House at 1, 2, 3, 5 floors
- [ ] Generate Tower at 2, 4, 6, 8 floors
- [ ] Score proportional scaling with Gemini
- [ ] Fix any that stretch or look wrong at extremes

## Phase 6: Seed Stability Test
- [ ] Generate same config with seeds 1-10
- [ ] Score variety and consistency with Gemini
- [ ] Ensure different seeds produce meaningfully different results

## Phase 7: L/T/U Floor Plan Test
- [ ] Generate House with each plan shape (rect, L, T, U)
- [ ] Screenshot and score with Gemini
- [ ] Verify non-rectangular geometry is visually distinct

## Phase 8: Feature Flags Test
- [ ] Generate House with each feature flag toggled
- [ ] Screenshot: chimney on/off, porch on/off, pool on/off, fence on/off
- [ ] Score visibility of each feature with Gemini

## Phase 9: Final Report
- [ ] Compile all scores into summary table
- [ ] Document any remaining issues
- [ ] Final commit with all improvements

---

## Completion Log
<!-- Append results here as phases complete -->
