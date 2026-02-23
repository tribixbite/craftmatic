# Real-World Building Grading Report

> Minecraft generation accuracy vs. real-world street-view reference
> Graded by Gemini 3 Pro Preview (2026-02-23)
> Newton re-graded 2026-02-23 after rustic fallback fix
> Comparison renders: [GitHub Pages viewer](https://tribixbite.github.io/craftmatic/comparison/)

---

## Building 1: 2340 Francisco St, San Francisco, CA 94123

**Real building:** 1929 stucco apartment, 4 stories, 12 units, Marina District.
Spanish/Mediterranean influence, flat roof, cream/beige stucco.

**Generation config:** Desert style, 4 floors, flat roof, 56x25 grid, sandstone/terracotta palette.

| Criteria | Grade | Notes |
|---|---|---|
| **Scale Accuracy** | **A** | 4 stories matches reality. 56x25 footprint appropriate for multi-unit lot. |
| **Style Accuracy** | **A-** | Stucco-to-sandstone/terracotta is the correct block mapping. Flat roof historically accurate for SF Marina. |
| **Type Accuracy** | **A** | Reads clearly as a residential apartment block, not a fortress or house. |
| **Overall Realism** | **A** | Strongest generation. Captures Marina District palette within vanilla block constraints. |

**Overall: A**

---

## Building 2: 240 Highland St, Newton, MA 02465

**Real building:** 1899 Queen Anne Victorian estate, 9 bedrooms, 5 baths, 3 stories, 9,094 sqft, 1 acre lot.
Complex roofline, turrets/towers, wraparound porch, wood clapboard/shingle siding, bay windows, ornate Victorian trim.

### v1 — Modern Style (FIXED)

**Generation config:** Modern style, 2 floors, 69x15 grid. (Build year uncertain — style mapping defaulted to "modern".)

| Criteria | Grade | Notes |
|---|---|---|
| **Scale Accuracy** | **C** | 2 floors acceptable for a house but misses the grandeur of 3-story estate. Too squat. |
| **Style Accuracy** | **F** | Critical failure. "Modern" (flat roof, concrete/glass) is the antithesis of Queen Anne Victorian. |
| **Type Accuracy** | **C-** | Looks like a house, but a contemporary suburban one, not a historic estate. |
| **Overall Realism** | **D** | Visual dissonance between historic Newton address and modern box output. |

**v1 Overall: D**

**Root cause:** Build year uncertain in data, system defaulted to "Modern" fallback.

### v2 — Rustic Style (CURRENT)

**Generation config:** Rustic style, 2 floors, 69x20x38 grid, 11,204 blocks, spruce/dark oak palette with gabled roofs.

**Fix applied:** When `year_built` is uncertain, fallback changed from "modern" to "rustic".

| Criteria | Grade | Notes |
|---|---|---|
| **Scale Accuracy** | **B-** | Total volume improved, but 69x20 footprint creates a 3.5:1 "longhouse" aspect ratio. Real Queen Anne is boxier (~40x40 or L-shape). 2 floors misses the distinct 3-story grandeur of a 9,094 sqft estate. |
| **Style Accuracy** | **B** | Massive improvement. Spruce/dark oak palette correctly evokes "historic" and "residential." Gabled roof directionally correct. Gap: "rustic" is a generic bucket — lacks Queen Anne vocabulary (turrets, bay windows, wraparound porch, asymmetry). Reads more "grand hunting lodge" than "Victorian manor." |
| **Type Accuracy** | **A-** | Successfully reads as a large, expensive, historic residential property. No longer looks like a tech office or modern art museum. The "estate" feel is present. |
| **Overall Realism** | **B** | Coherent and aesthetically pleasing as a Minecraft structure. If you didn't know the specific address, you'd accept it as a plausible large house. The "uncanny valley" of the glass box is gone. |

**v2 Overall: B** (up from D)

### v1 vs v2 Comparison

| Feature | Old "Modern" (v1) | New "Rustic" (v2) | Impact |
|---|---|---|---|
| **Materiality** | White concrete, cyan stained glass. Cold, sterile. | Spruce planks, dark oak logs, cobblestone. Warm, organic. | **High.** Immediate fix to the "time travel" error. |
| **Roofline** | Flat roof with parapets. | Gabled roof with overhangs. | **Medium.** Better fits New England context. |
| **Vibe** | Commercial / Tech Office. | Residential / Lodge. | **High.** Aligns with property usage. |
| **Geometry** | Boxy, modular. | Still somewhat boxy, softened by wood textures. | **Low.** Underlying 69x20 grid issue persists. |

**Summary:** Fix moved from "Wrong Building" (glass box for a Victorian) to "Right Building, Wrong Shape" (correct materials, needs geometric tuning).

---

## Building 3: 525 S Winchester Blvd, San Jose, CA 95128 (Winchester Mystery House)

**Real building:** 1884-1922 Queen Anne Victorian, 24,000 sqft, 160 rooms, 4 stories (originally 7 pre-1906 earthquake).
Redwood construction, complex irregular roofline, cupolas, turrets, fish-scale shingles, sprawling organic layout.

**Generation config:** Rustic style, 5 floors, 135x35 grid, spruce/dark oak palette.

| Criteria | Grade | Notes |
|---|---|---|
| **Scale Accuracy** | **A-** | 5 floors close to real 4-7 story variance. 135-block length correctly identifies massive horizontal structure. |
| **Style Accuracy** | **B+** | Spruce/dark oak is the best vanilla mapping for redwood construction. Lacks architectural chaos (turrets/gables) but palette is correct. |
| **Type Accuracy** | **A** | Correctly identified as a massive manor/estate, not a castle. |
| **Overall Realism** | **B+** | Impressive given the Winchester House is an edge case. Massing handled well. |

**Overall: B+**

---

## Summary Grades

| Building | Scale | Style | Type | Realism | Overall | Change |
|---|---|---|---|---|---|---|
| SF Apartment (2340 Francisco) | A | A- | A | A | **A** | — |
| Newton Victorian (240 Highland) | B- | B | A- | B | **B** | up from D |
| Winchester House (525 Winchester) | A- | B+ | A | B+ | **B+** | — |

**Average: B+ (up from B- with the Modern failure dragging it down)**

---

## Remaining Recommendations (Newton B → A Path)

### 1. Aspect Ratio Constraints ("Shoebox" Fix)
The 69x20 grid is too linear for a Victorian estate. If `property_type == 'single_family'` and `sqft > 4000`, penalize aspect ratios > 2:1. Force width expansion or L-shapes rather than lengthening the primary axis.

### 2. Verticality Heuristic
9,094 sqft squeezed into 2 floors forces a massive footprint. If `sqft > 5000` AND `lot_coverage < 40%`, force `floors = 3`. This would shrink the footprint and create the towering silhouette typical of Queen Anne homes.

### 3. Victorian Turret Sub-routine
"Rustic" is too flat. Create a `Victorian` modifier: if style is Rustic and era pre-1920, randomly replace one corner of the grid with a cylinder or octagon stack (turret) extending above the roofline. Single highest-ROI change to signal "Victorian."

### 4. Porch Wrap
For Rustic/Victorian styles, generate a 3-block deep perimeter of fence/slabs around 50% of the ground floor to represent wraparound porches.

---

## Improvement vs. Previous "Fantasy Castle" Approach

**Improvement score: 9/10**

The previous approach generated 9-floor fantasy castles with battlements and towers for every building regardless of type. The current iteration represents a working **Semantic Generation Engine**.

### Key improvements:
1. **Scale:** Verticality problem solved. Francisco St (4 floors) vs Newton (2 floors) proves height logic reads data correctly.
2. **Materiality:** Moving from stone bricks (castle) to sandstone (SF) and spruce (Winchester) adds geographic grounding.
3. **Style fallback:** The "Modern" default for unknown year_built has been replaced with "Rustic," preventing anachronistic generations.
4. **The "Castle" problem:**
   - *Old:* 2340 Francisco St looked like a fortress (Grade: F)
   - *New:* 2340 Francisco St looks like an apartment (Grade: A)

---

## Reference Sources
- [Apartments.com - 2340 Francisco St](https://www.apartments.com/2340-francisco-st-san-francisco-ca/vwvrd8d/)
- [Trulia - 240 Highland St](https://www.trulia.com/p/ma/newton/240-highland-st-newton-ma-02465--2002111304)
- [Winchester Mystery House - Wikipedia](https://en.wikipedia.org/wiki/Winchester_Mystery_House)
- [Winchester Mystery House - Official Photo Gallery](https://winchestermysteryhouse.com/photo-gallery/)
- [Library of Congress - Winchester House HABS Survey](https://www.loc.gov/resource/hhh.ca0959.photos?st=gallery)
- [Winchester Victorian Aesthetic Legacy](https://winchestermysteryhouse.com/victorian-aesthetic-legacy/)
