# Real-World Building Grading Report

> Minecraft generation accuracy vs. real-world street-view reference
> Graded by Gemini 3 Pro Preview (2026-02-23)
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

**Real building:** 1899 Queen Anne Victorian estate, 9 bedrooms, 3 stories, 9,020 sqft, 1 acre lot.
Complex roofline, turrets/towers, wraparound porch, wood clapboard/shingle siding.

**Generation config:** Modern style, 2 floors, 69x15 grid. (Build year uncertain -- style mapping failed.)

| Criteria | Grade | Notes |
|---|---|---|
| **Scale Accuracy** | **C** | 2 floors acceptable for a house but misses the grandeur of 3-story estate. Too squat. |
| **Style Accuracy** | **F** | Critical failure. "Modern" (flat roof, concrete/glass) is the antithesis of Queen Anne Victorian. |
| **Type Accuracy** | **C-** | Looks like a house, but a contemporary suburban one, not a historic estate. |
| **Overall Realism** | **D** | Visual dissonance between historic Newton address and modern box output. |

**Overall: D**

**Root cause:** Build year uncertain in data, system defaulted to "Modern" fallback.

**Recommendation:** If `year_built` is null, query `neighborhood_avg_year` or default to "Traditional/Rustic" rather than "Modern" (statistically unlikely for most residential datasets).

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

| Building | Scale | Style | Type | Realism | Overall |
|---|---|---|---|---|---|
| SF Apartment (2340 Francisco) | A | A- | A | A | **A** |
| Newton Victorian (240 Highland) | C | F | C- | D | **D** |
| Winchester House (525 Winchester) | A- | B+ | A | B+ | **B+** |

---

## Improvement vs. Previous "Fantasy Castle" Approach

**Improvement score: 9/10**

The previous approach generated 9-floor fantasy castles with battlements and towers for every building regardless of type. The current iteration represents a working **Semantic Generation Engine**.

### Key improvements:
1. **Scale:** Verticality problem solved. Francisco St (4 floors) vs Newton (2 floors) proves height logic reads data correctly.
2. **Materiality:** Moving from stone bricks (castle) to sandstone (SF) and spruce (Winchester) adds geographic grounding.
3. **The "Castle" problem:**
   - *Old:* 2340 Francisco St looked like a fortress (Grade: F)
   - *New:* 2340 Francisco St looks like an apartment (Grade: A)

### Strategic Recommendations

1. **Fix the "Modern" fallback:** Building 2 failed because of a logic gap. Never default to "Modern" unless data explicitly confirms post-1950 construction. Default to "Rustic" or "Brick" for unknown dates in US datasets.
2. **Roofing logic:** The next quality leap will come from roof shapes:
   - *Flat* for Modern/Spanish (Building 1 -- working)
   - *A-Frame/Gabled* for Victorian/Rustic (Buildings 2 & 3 -- missing)
   - If "Victorian" detected in style mapping, force gabled roof generation.

---

## Reference Sources
- [Apartments.com - 2340 Francisco St](https://www.apartments.com/2340-francisco-st-san-francisco-ca/vwvrd8d/)
- [Trulia - 240 Highland St](https://www.trulia.com/p/ma/newton/240-highland-st-newton-ma-02465--2002111304)
- [Winchester Mystery House - Wikipedia](https://en.wikipedia.org/wiki/Winchester_Mystery_House)
- [Winchester Mystery House - Official Photo Gallery](https://winchestermysteryhouse.com/photo-gallery/)
- [Library of Congress - Winchester House HABS Survey](https://www.loc.gov/resource/hhh.ca0959.photos?st=gallery)
- [Winchester Victorian Aesthetic Legacy](https://winchestermysteryhouse.com/victorian-aesthetic-legacy/)
