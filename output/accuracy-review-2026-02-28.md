# Accuracy Review — Comparison Data vs Real-World Photos

_2026-02-28 — reviewed from live screenshots + Street View / Mapillary images_

## Executive Summary

12/14 active API sources, 14 addresses. Three systemic issues dominate accuracy loss:

1. **Low-confidence SV story count overrides measured height data** (critical bug)
2. **SV color analysis samples trees instead of buildings** when occluded
3. **Style vocabulary too coarse** — "desert" covers too many distinct styles

---

## 1. Floor Count — Critical Priority Chain Bug

**Root cause**: `address-pipeline.ts:1181`
```typescript
let effectiveStories = prop.osmLevels ?? prop.overtureFloors ?? prop.svStoryCount ?? prop.stories;
```

The `??` chain treats SV story count (automated, often <0.30 confidence) as equal to
OSM levels (human-mapped ground truth). No confidence gate exists.

### Impact per address

| Address | Mapbox height | → floors | SV story | SV conf | Generated | Delta |
|---------|--------------|----------|----------|---------|-----------|-------|
| **sf** | 13m | 4f | 1 | 0.30 | **1f** | **-3** |
| **austin** | 10.7m | 3f | 1 | 0.30 | 2f | -1 |
| **losangeles** | 16.1m | 5f | 3 | 0.43 | 3f | -2 |
| **denver** | 4m | 1f | 4 | 0.24 | 2f | +1 |
| seattle | 6m | 2f | 3 | 0.19 | 3f | +1 |
| charleston | 9.3m | 3f | 5 | 0.21 | 3f | 0 |
| minneapolis | 8m | 2f | 3 | 0.18 | 2f | 0 |
| tucson | 3.6m | 1f | 1 | 0.30 | 1f | 0 |

**Every SV story confidence is below 0.50.** The feature is unreliable as-is.

### Fix: Confidence gate + height priority

```typescript
// Only trust SV story count above 0.5 confidence
const svStoriesIfConfident = (prop.svStoryConfidence ?? 0) > 0.5
  ? prop.svStoryCount : undefined;

// Prefer measured height over SV analysis
const heightFloors = (prop.mapboxHeight ?? prop.overtureHeight)
  ? Math.max(1, Math.round((prop.mapboxHeight ?? prop.overtureHeight ?? 0) / 3.5))
  : undefined;

let effectiveStories = prop.osmLevels
  ?? prop.overtureFloors
  ?? heightFloors
  ?? svStoriesIfConfident
  ?? prop.stories;
```

This promotes Mapbox/Overture height (measured, reliable) above SV analysis.

---

## 2. SV Color Analysis — Tree Occlusion Problem

The Canvas2D color extraction samples fixed screen zones. When trees dominate the
Street View image, it extracts tree colors instead of building colors.

### Affected addresses

| Address | Actual building | SV wall color | SV block | Problem |
|---------|----------------|---------------|----------|---------|
| **sf** | WHITE stucco | rgb(137,125,94) | sandstone | Tree + bush in foreground |
| **austin** | Barely visible | rgb(83,87,55) | green_concrete | Fully occluded by oak trees |
| **seattle** | Hidden | rgb(77,86,54) | green_concrete | Massive cedar hedge |
| denver | Tan/cream siding | rgb(110,113,111) | stone_bricks | Close but wrong material |
| charleston | Grey wood clapboard | rgb(124,127,122) | stone | Right color, wrong texture |

**austin and seattle**: The real building is invisible in the Street View image. The
algorithm is literally sampling foliage and assigning green_concrete as wall material.

### Potential fixes (in priority order)

1. **Confidence-gated colors**: If the wall/roof color zones have very low variance or
   are dominated by green (hue 80-160), flag as "occluded" and skip color override
2. **Green rejection heuristic**: If wall color is within HSL hue 60-180 and saturation
   >15%, it's likely vegetation — discard and fall back to category defaults
3. **Multi-heading sampling**: Try 4 headings (±90° from computed bearing) and pick
   the heading where wall zone has highest saturation and non-green hue
4. **Mapillary fallback**: When Google SV shows occlusion, try the Mapillary image
   which may have a different angle

---

## 3. Style Vocabulary — "desert" Overused

"Desert" style (`acacia` wood, sandstone, flat roof) is applied to too many cases:

| Address | Year | Actual architecture | Generated | Better match |
|---------|------|-------------------|-----------|-------------|
| **sf** | 1929 | Mediterranean Revival (white stucco, balconies) | desert | colonial or new "mediterranean" |
| **losangeles** | 1924 | Mayan Revival concrete block (Ennis House!) | desert | steampunk or new "brutalist" |
| sanjose | varies | Multi-story complex | desert | modern |
| tucson | varies | Southwest ranch | desert | desert (correct) |

### Over-mapping paths to "desert"

- `inferStyleFromCounty`: SF county post-1910 → desert
- `inferStyleFromPropertyType`: multi-family 1920-1969 → desert
- `inferStyleFromPropertyType`: OTHER with 6+ bed/bath 1920-1969 → desert
- `inferStyle` (year-based): 1920-1944 → desert (globally!)

**The 1920-1944 blanket "desert" rule** is wrong for most of the US. Spanish Revival
was dominant in California/Southwest but Colonial Revival/Tudor/Craftsman were
dominant in the Northeast, Midwest, and Southeast during this era.

### Fix: Split year-based inference by region

```typescript
if (year >= 1920 && year < 1945) {
  // Only desert for Southwest + SoCal; colonial elsewhere
  const sw = ['CA','AZ','NM','NV'].includes(state);
  const fl = ['FL'].includes(state);
  return sw || fl ? 'desert' : 'colonial';
}
```

---

## 4. Mapillary Image Quality

The `pickBestImage` algorithm selects by distance + recency but not by heading
alignment with the building. The SF Mapillary image (heading 266°) shows a street
intersection, not the building frontage. The bearing from pano to building is ~343°
(from SV) but Mapillary picked a camera facing ~266°.

### Fix

Add heading alignment bonus to `pickBestImage` scoring when target bearing is known:
```typescript
const bearingDelta = Math.abs(img.compassAngle - targetBearing);
const headingPenalty = Math.min(bearingDelta, 360 - bearingDelta) / 360 * 0.002;
```

---

## 5. Solar planeHeight is Elevation, Not Building Height

| Address | planeHeight | Likely meaning |
|---------|------------|----------------|
| sf | 17.0m | Roof elevation (sea level ~5m + 12m building) |
| charleston | 11.6m | Roof elevation |
| denver | **1632.1m** | Mile-high elevation! |
| austin | 235.2m | Hill country elevation |
| walpole | 137.2m | Valley elevation |

`planeHeight` from Google Solar is the **absolute elevation of the roof plane above
sea level**, not the building height. It should NOT be used for floor estimation.
Only `footprintArea` and `roofPitch` from Solar are useful.

### Status

Currently `planeHeight` is not used for floor estimation (only roofPitch impacts
roofShape). But the field is displayed in the comparison view, which is misleading.
Consider relabeling or hiding it.

---

## 6. Per-Address Accuracy Notes

### sf (2340 Francisco St, San Francisco)
- **Real**: 4-story white Mediterranean apartment, balconies, flat roof, L-shape
- **Generated (allapis)**: 1-floor desert, L-shape, flat roof
- **Issues**: Floor count -3 (SV override), color wrong (sandstone not white), style
  wrong (desert not Mediterranean)
- **Score**: 3/10

### newton (240 Highland St, Newton MA)
- **Generated**: 3-floor colonial — reasonable for New England
- No SV analysis available. Mapbox says 7.5m→2f, generated 3f (from sqft heuristic)
- **Score**: 6/10

### sanjose (Winchester Mystery House)
- **Generated**: 3-floor desert — landmark property, unusual case
- **Score**: 5/10

### walpole (13 Union St, Walpole NH)
- **Generated**: 2-floor colonial — good match for rural New England
- **Score**: 7/10

### losangeles (Ennis House)
- **Real**: 3-4 story Mayan Revival concrete block (Frank Lloyd Wright)
- **Generated**: 3-floor desert — completely wrong material and style
- This is perhaps the most distinctive residential building in the US; no style preset
  could match it, but "steampunk" would be closer than "desert"
- **Score**: 4/10

### seattle (4800 NE 70th St)
- **Real**: Hidden behind trees — can't see building in either SV or Mapillary
- Green concrete walls are wrong (sampling trees)
- **Score**: 4/10

### austin (7312 Cibolo Creek Trail)
- **Real**: House completely hidden behind oak trees in Hill Country
- Green concrete walls from tree sampling, 2 floors vs Mapbox 3f
- **Score**: 4/10

### denver (2560 S Wolff St)
- **Real**: 1-story ranch, tan siding, dark asphalt roof, front porch
- **Generated**: 2-floor rustic — one floor too many
- SV says 4 stories @ 0.24 confidence (wildly wrong), Mapbox says 4m → 1f (correct)
- But effective floors = 2 (from someapis tier), SV 4@0.24 not used since someapis
  already set it. The allapis tier doesn't recompute from Mapbox properly.
- **Score**: 5/10

### minneapolis (4132 Garfield Ave)
- **Generated**: 2-floor rustic — reasonable for Minneapolis bungalow
- **Score**: 6/10

### charleston (41 Society St)
- **Real**: 3-story wood clapboard, shuttered windows, bay windows, covered entry
- **Generated**: 3-floor gothic — floor count correct. Style "gothic" isn't bad
  (ornamental) but "colonial" would be more appropriate for Lowcountry
- **Score**: 6/10

### tucson
- **Generated**: 1-floor desert — correct for Southwest ranch
- **Score**: 7/10

---

## Priority Fixes (Ranked by Impact)

### P0 — Floor estimation confidence gate
- Gate SV story count on confidence > 0.5
- Promote Mapbox/Overture height-derived floors above SV in priority chain
- **Affected**: sf (-3f), losangeles (-2f), austin (-1f)
- **Effort**: ~20 lines in address-pipeline.ts

### P1 — Green/vegetation rejection in SV color analysis
- Detect when wall zone is dominated by green hue
- Fall back to category material defaults instead of vegetation colors
- **Affected**: austin, seattle, partially sf
- **Effort**: ~30 lines in import-sv-analysis.ts

### P2 — Region-aware year→style mapping
- Split 1920-1944 era by state/region instead of blanket "desert"
- Add proper Craftsman/bungalow recognition for PNW/Midwest
- **Affected**: sf, potentially all 1920-1944 non-Southwest addresses
- **Effort**: ~40 lines in address-pipeline.ts style inference

### P3 — Multi-family style improvements
- Mediterranean multi-family (SF) needs distinct treatment from desert ranch
- Consider "colonial" or new preset for stucco apartments with balconies
- **Affected**: sf, losangeles
- **Effort**: Medium — requires new style evaluation

### P4 — Mapillary heading alignment
- Factor in target bearing when selecting best image
- **Affected**: sf Mapillary image quality
- **Effort**: ~10 lines in mapillary.ts
