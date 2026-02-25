# Craftmatic Generation Accuracy Review

## Review Date: 2025-02-24
## Reviewer: Claude Opus 4.6 (multimodal analysis of generated renders vs real building data)

---

## Executive Summary

**Overall Grade: D+ (1.5/4.0)**

The generated Minecraft structures capture basic proportions (footprint size, floor count) but fail to represent the actual architectural character of the real buildings. All 9 test addresses produce structures that look like generic medieval/fantasy Minecraft builds rather than recognizable representations of the real properties.

**Root cause:** The style palette system is monolithic — once a style is selected (e.g. "fantasy" for 1890-1970 buildings), all 95 block definitions override any data-driven material/color/shape decisions. The data collection pipeline is excellent (70+ fields from 5 APIs), but >60% of collected data is unused or overridden at generation time.

---

## Per-Address Grades

### 1. San Francisco — 2340 Francisco St (sf-allapis)
**Real building:** 1929 Marina-district apartment complex, 13,905 sqft, 12-unit, Mediterranean Revival style, warm tan/cream stucco, flat/low-pitch roof, 3 stories, large windows, courtyard
**Generated:** Dark medieval mansion, white concrete + dark oak timber, gambrel roof, brick chimneys, L-shaped with companion buildings

| Category | Grade | Notes |
|----------|-------|-------|
| Overall Shape | C | L-plan reasonable for 13k sqft, correct 3-story count |
| Proportions | C+ | Width/length roughly correct from sqft |
| Roof Style | F | Gambrel roof on a flat-roof apartment building |
| Materials/Color | D | Should be warm stucco, got cold white concrete + dark wood |
| Landscaping | D | Random fences and flowers vs courtyard |
| **Address Total** | **D+** | Recognizable as "big building" but not as apartment |

**Key flaws:**
1. Year 1929 → "fantasy" style → gambrel roof (should be flat/low-pitch Mediterranean)
2. propertyType="OTHER" from Parcl → multi-unit detection failed → no flat-roof override
3. Wall color data collected (tan/warm) but overridden by fantasy palette white_concrete

---

### 2. Newton MA — 240 Highland St (newton-allapis)
**Real building:** Large New England estate, stone/brick with Tudor elements, gabled roof, multiple chimneys, heavily wooded lot
**Generated:** Brown-roofed stone/concrete manor, complex gabled roof, multiple sections

| Category | Grade | Notes |
|----------|-------|-------|
| Overall Shape | B- | Complex multi-section captures estate feel |
| Proportions | B | Large footprint matches 6000+ sqft |
| Roof Style | C+ | Gabled is correct but too uniform, needs dormers |
| Materials/Color | C | Stone-ish look OK, missing Tudor timber framing |
| Landscaping | C- | Basic fence/flowers, should have heavy trees |
| **Address Total** | **C+** | Best of the 9; estate "feel" comes through |

---

### 3. San Jose — 525 S Winchester Blvd (sanjose-allapis)
**Real building:** The Winchester Mystery House — sprawling Victorian, 24,000 sqft, 161 rooms, complex roofline, wood siding, Queen Anne style, multiple towers and turrets
**Generated:** Large tan/yellow Victorian with complex roofline, multiple chimneys, wide sprawling footprint

| Category | Grade | Notes |
|----------|-------|-------|
| Overall Shape | C+ | Sprawling footprint captures size |
| Proportions | B- | Wide + complex matches Winchester's character |
| Roof Style | C | Multiple gables OK but needs towers/turrets |
| Materials/Color | C- | Tan/yellow vs actual wood-brown; missing painted wood detail |
| Landscaping | D | Basic fencing vs the famous Victorian gardens |
| **Address Total** | **C** | Scale is right but architectural details absent |

---

### 4. Walpole NH — 13 Union St (walpole-allapis)
**Real building:** Small New England colonial, ~2000 sqft, white clapboard, gray roof, 2-story, central chimney, simple rectangular plan
**Generated:** Low sandstone-colored ranch, gray gabled roof, 3 chimneys, long narrow footprint

| Category | Grade | Notes |
|----------|-------|-------|
| Overall Shape | D | Too long and narrow; should be compact rectangle |
| Proportions | C- | Floor count off (1-story generated, should be 2) |
| Roof Style | C | Gable correct for New England |
| Materials/Color | D | Sandstone/tan instead of white clapboard |
| Landscaping | D | Minimal |
| **Address Total** | **D+** | Doesn't read as New England colonial |

**Key flaws:**
1. White clapboard (collected from Smarty: "vinyl siding") not mapped to white_concrete or quartz
2. Colonial style not selected despite NH address and formal street name
3. Floor count calculated wrong from sqft

---

### 5. Byron Center MI — 2431 72nd St SW (byron-allapis)
**Real building:** Modern suburban home, white/light gray, 2-3 story, contemporary design with clean lines, flat or low-pitch roof sections, attached garage
**Generated:** Large white modernist compound with flat roofs, pool, glass-heavy facades, attached structures

| Category | Grade | Notes |
|----------|-------|-------|
| Overall Shape | C+ | Modern compound captures contemporary feel |
| Proportions | C | Scale seems large for the address |
| Roof Style | B- | Flat/low-pitch correct for modern style |
| Materials/Color | B- | White concrete close to real white exterior |
| Landscaping | C | Pool and paths add modern feel |
| **Address Total** | **C+** | Modern style selection was correct here |

---

### 6. Vinalhaven ME — 216 Zekes Point Rd (vinalhaven-allapis)
**Real building:** Maine island cottage/cabin, wood shingle, small ~1500 sqft, rustic coastal, steep gabled roof, wooded lot
**Generated:** Dark brown timber lodge, steep roof, chimney, compact footprint

| Category | Grade | Notes |
|----------|-------|-------|
| Overall Shape | C+ | Compact building reasonable |
| Proportions | C | Generally OK for small property |
| Roof Style | C+ | Steep gable fits Maine coastal |
| Materials/Color | C | Brown wood OK but too dark, needs weathered gray shingle |
| Landscaping | D | Missing wooded/coastal character |
| **Address Total** | **C** | "Cabin in the woods" feel but not specifically coastal Maine |

---

### 7. Suttons Bay MI — 5835 S Bridget Rose Ln (suttonsbay-allapis)
**Real building:** Northern Michigan lakefront home, wood/stone, 2-3 stories, rustic modern, large windows, wooded hillside
**Generated:** Dark brown angular building, very steep roof dominating, looks more like a collapsed structure

| Category | Grade | Notes |
|----------|-------|-------|
| Overall Shape | D | Roof-to-wall ratio way off; structure looks crushed |
| Proportions | D | Building width reasonable but roof overwhelms |
| Roof Style | D | Too steep and massive; dominates the building |
| Materials/Color | D+ | Dark brown everywhere, no variation |
| Landscaping | D | Minimal |
| **Address Total** | **D** | Worst of the 9; doesn't look like a house |

**Key flaws:**
1. Roof height way too high relative to wall height
2. Single-material monotone (all dark oak/spruce)
3. No glass/windows visible from this angle

---

### 8. Los Angeles — 2607 Glendower Ave (losangeles-allapis)
**Real building:** THE ENNIS HOUSE — Frank Lloyd Wright's Mayan Revival masterpiece, 6000 sqft, textured concrete blocks, flat terraced roof, geometric patterns, hillside placement, fortress-like, 27,000+ concrete blocks
**Generated:** Sprawling compound with main house (gray/brown walls, sloped roof) and detached structures, large lot

| Category | Grade | Notes |
|----------|-------|-------|
| Overall Shape | D | Compound layout doesn't match Ennis House's monolithic fortress form |
| Proportions | C | Scale roughly right for 6000 sqft |
| Roof Style | F | Sloped gable roof on a building famous for flat/terraced roof |
| Materials/Color | D | Should be ALL concrete blocks, got mixed materials |
| Landscaping | D | Needs hillside terracing, got flat green lawn |
| **Address Total** | **D** | Completely misses the iconic Mayan Revival character |

**Key flaws:**
1. osmArchitecture="mayan_revival" not recognized by `mapArchitectureToStyle()` → falls through to year-based "fantasy"
2. Flat roof from OSM data overridden by style default
3. Concrete block material not mapped
4. Hillside/terracing not representable with current flat-lot generation

---

### 9. Seattle — 4810 SW Ledroit Pl (seattle-allapis)
**Real building:** Pacific Northwest craftsman/bungalow style, wood siding, moderate size, gabled roof, front porch, wooded lot
**Generated:** Dark timber house with gabled roof, chimney, moderate footprint

| Category | Grade | Notes |
|----------|-------|-------|
| Overall Shape | C | Basic house shape reasonable |
| Proportions | C+ | Moderate size correct |
| Roof Style | C+ | Gabled correct for craftsman |
| Materials/Color | C- | Dark oak/spruce everywhere, should show wood siding character |
| Landscaping | D | Missing PNW trees/gardens |
| **Address Total** | **C-** | Generic "house" but not specifically craftsman |

---

## Summary Table

| Address | Shape | Proportions | Roof | Materials | Landscaping | **Total** |
|---------|-------|-------------|------|-----------|-------------|-----------|
| SF Apartment | C | C+ | F | D | D | **D+** |
| Newton Estate | B- | B | C+ | C | C- | **C+** |
| Winchester House | C+ | B- | C | C- | D | **C** |
| Walpole Colonial | D | C- | C | D | D | **D+** |
| Byron Modern | C+ | C | B- | B- | C | **C+** |
| Vinalhaven Cottage | C+ | C | C+ | C | D | **C** |
| Suttons Bay | D | D | D | D+ | D | **D** |
| Ennis House | D | C | F | D | D | **D** |
| Seattle Craftsman | C | C+ | C+ | C- | D | **C-** |

**Average: D+ (1.5/4.0)**

---

## Top 10 Issues to Fix (Priority Order)

### P0: Critical (breaks recognizability)

1. **Style palettes override data-driven materials** — Wall/roof overrides from OSM/Smarty/SV should ALWAYS take precedence over style defaults. Currently style defaults win when no override is set, but the override chain has gaps.

2. **Year-based style inference too coarse** — 1890-1970 all maps to "fantasy" (gambrel roof, white concrete, dark oak). This covers 6 of 9 test addresses. Need finer buckets and regional awareness.

3. **Roof shape overridden by style** — OSM flat roof, Solar API data, and Smarty roofFrame are collected but frequently overridden by style.defaultRoofShape.

### P1: Important (affects accuracy)

4. **Missing architecture-to-style mappings** — "mayan_revival", "art_deco", "mid_century_modern", "craftsman", "ranch", "colonial_revival", "mediterranean" all unmapped. These are common Smarty/OSM values.

5. **Multi-unit detection fails** — propertyType="OTHER" from Parcl doesn't trigger flat-roof override. Need osmBuildingType + sqft + bedroom heuristic.

6. **No color fidelity** — Collected hex colors from OSM and SV (e.g. tan for SF, gray for Walpole) never make it to the palette. Need a `nearestMinecraftBlock(hex)` mapper.

### P2: Nice-to-have (improves realism)

7. **Roof height scaling** — Suttons Bay shows roof height dominating. Need `min(roofHeight, floors * STORY_H)` clamp.

8. **Regional material defaults** — New England → white clapboard, Pacific NW → wood/green, Southwest → stucco/adobe. Currently only city/county hints for style, not for materials within a style.

9. **Landscaping diversity** — All addresses get same fence+flowers. Should vary by climate (desert, coastal, wooded) and lot size.

10. **Companion building relevance** — Detached structures (garage, shed) should reflect API data (hasGarage, hasPorch) rather than random style additions.

---

## Code Fix Plan

### Fix 1: Data-driven overrides trump style defaults
**File:** `src/gen/gen-house.ts` line ~39
```
// BEFORE:
const roofShape = roofShapeOpt ?? style.defaultRoofShape;
// AFTER:
const roofShape = roofShapeOpt ?? style.defaultRoofShape;
// (This is already correct — the issue is in convertToGenerationOptions
//  where roofShapeOpt is sometimes not passed when it should be)
```
**Real fix:** In `convertToGenerationOptions()`, ensure roof/wall overrides are ALWAYS passed, never left undefined to fall through to style default.

### Fix 2: Expand year-based inference
**File:** `src/gen/address-pipeline.ts` ~`inferStyle()`
- Split 1890-1970 into: 1890-1920 (craftsman/colonial), 1920-1945 (art deco/revival), 1945-1970 (ranch/mid-century)
- Add "craftsman" and "ranch" style palettes

### Fix 3: Add missing architecture mappings
**File:** `src/gen/address-pipeline.ts` ~`mapArchitectureToStyle()`
- Add: mayan_revival → modern, art_deco → steampunk, craftsman → rustic, ranch → modern, mediterranean → desert, colonial_revival → colonial

### Fix 4: Clamp roof height
**File:** `src/gen/gen-house.ts`
- `const effectiveRoofH = Math.min(roofHeightOverride ?? style.roofHeight, floors * STORY_H + 2)`
