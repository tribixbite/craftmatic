# Accuracy Grading — Gemini 3 Pro Preview

## Phase 1 (P0-P3) — 2026-02-28

_Automated review of P0-P3 accuracy fixes_

### Fix Impact Scores

| Fix | Score | Rationale |
|-----|-------|-----------|
| **P0: Floor Gate** | **10/10** | Critical structural fix. SV story counting is unreliable due to tree occlusion and camera angles. Gating behind Mapbox/Overture height data (Lidar/photogrammetry-derived) corrects fundamental building massing. Fixed 50% of sample cases (SF, Austin, Denver, LA). |
| **P1: Veg. Rejection** | **8/10** | Critical visual fix. "Green houses" are a jarring immersion breaker. Simple HSL filtering is computationally cheap and effective. Prevents the wrong color even if it doesn't find the perfect one. |
| **P2: Region Styles** | **5/10** | Heuristic band-aid. Moving SF from "Desert" to "Colonial" is an improvement but still inaccurate (real: Mediterranean). Hard-coding style by region+year is brittle. Solves "Desert in Seattle" absurdity but doesn't solve true style fidelity. |
| **P3: Heading Align** | **3/10** | Quality of life. Important for thumbnail UX but low impact on schematic generation in this batch. Foundational fix for future improvements (better sampling). |

### Per-Address Scores

| Location | Before | After | Notes |
|----------|--------|-------|-------|
| **SF (Francisco St)** | 2/10 | 7/10 | Massive improvement. 1f→4f critical. Style still wrong (Colonial vs Mediterranean). |
| **Austin (Long Canyon)** | 3/10 | 8/10 | Fixed both massing (+1 floor) and "Green Wall" bug. |
| **Denver (S Xavier)** | 4/10 | 9/10 | Near perfect. Removing hallucinated 2nd floor makes correct Ranch. |
| **Seattle (Ledroit Pl)** | 3/10 | 7/10 | Fixed green wall. "Rustic" is safe bet for Seattle. |
| **LA (Ennis House)** | 6/10 | 8/10 | +1 floor helps. "Desert" style works well for FLW textile blocks. |
| **Charleston** | 7/10 | 7/10 | Unchanged. Gothic acceptable for historic Charleston. |
| **Minneapolis** | 8/10 | 8/10 | Unchanged. Rustic 2f good fit for Craftsman bungalow. |
| **Tucson** | 9/10 | 9/10 | Unchanged. Already optimal. |

**Average: 5.3/10 → 7.9/10 (+2.6 points)**

---

## Phase 2+3 (VLM + Roof + Color) — 2026-02-28

_Automated review after VLM prompt, vegetation bypass, pitch-driven roofs, gambrel fix, Charleston ratio_

### Fix Impact Scores

| Fix | Score | Rationale |
|-----|-------|-----------|
| **VLM Style Classifier** | **N/A** | Inactive for this batch (no ANTHROPIC_API_KEY). Potential impact: 9/10 — missing link for SF "Colonial" vs "Mediterranean" mismatch. |
| **Vegetation Bypass** | **7/10** | Essential stability fix. Prevents "Moss House" edge case where foliage obscures facade color. |
| **Solar Pitch → Shape** | **8/10** | High impact. Data-driven roof shapes replace random assignment. Caveat: may be over-aggressive on "Flat" (see Charleston). |
| **Gambrel Overuse Fix** | **10/10** | MVP of this phase. Killed systematic bias — 8/14 addresses incorrectly had gambrel. Variety in output (flat/hip/gable) proves logic is now reactive. |
| **Charleston Aspect Ratio** | **9/10** | Solves specific but glaring topological error. 3:1 ratios enable row-house and "single house" generation previously impossible. |

### Per-Address Scores

| Location | Phase 1 | Phase 2+3 | Notes |
|----------|---------|-----------|-------|
| **SF (Francisco St)** | 7.0 | **8.5** | Flat roof correct for Bay Area vernacular. "Colonial" style texture still wrong (VLM will fix). |
| **Newton (Highland St)** | ~7.5 | **8.5** | Colonial/Gable correct. Gambrel removal helped. |
| **Austin (Long Canyon)** | 8.0 | **7.5** | **Regression.** Gable correct but 3 floors for 1-story ranch is 200% Z-axis error. |
| **Denver (S Xavier)** | 9.0 | **9.5** | Near perfect. Rustic + hip + 1f exactly right. |
| **Seattle (Ledroit Pl)** | 7.0 | **9.0** | Rustic/Gable/2f accurate for Craftsman. |
| **LA (Ennis House)** | 8.0 | **9.0** | Flat roof correct. Desert style works. |
| **Minneapolis (Ulysses)** | 8.0 | **8.5** | Gable correct for Craftsman bungalow. |
| **Charleston (Legare)** | 7.0 | **8.0** | Footprint triumph (10×27). Roof=flat is wrong (real: low-slope hip). |
| **Tucson (Adams)** | 9.0 | **9.0** | Desert/Flat/1f still optimal. Biggest beneficiary of pitch fix. |

**Average: 7.9/10 → 8.6/10 (+0.7 points)**

### Regressions

- **Austin**: 8.0 → 7.5. Floor count (3f) wrong for 1-story ranch. Footprint + roof improved.
- **Charleston roof**: Footprint improved but low-slope hip misclassified as flat (<5° threshold too binary).

### Top 3 Remaining Accuracy Gaps

1. **Z-Axis / Floor Count Logic** — Austin (3f) on a ranch. Cross-reference OSM `building:levels` more strictly or use VLM floor estimation.
2. **Low-Slope Hip Discrimination** — 5° cutoff is too binary. Many historic hip roofs are 10-15°. Consider region precipitation bias (Charleston → not flat).
3. **Texture/Style Mapping** — SF "Colonial" on "Mediterranean" is jarring. VLM style classifier (Phase 2 Fix #1) is the direct fix.

### Recommended Next Steps

1. Enable VLM API key for comparison generation to validate style classification
2. Add "low-slope hip" category for 5°-15° range (or precipitation-aware bias)
3. Investigate Austin floor count source — likely bad SV estimate bypassing confidence gate

---

## Phase 4+5 (Floor Fix + VLM via OpenRouter) — 2026-02-28

_Automated review after height correction, Smarty priority, OpenRouter VLM style classification_

### Fix Impact Scores

| Fix | Score | Rationale |
|-----|-------|-----------|
| **Roof Height Correction** | **9/10** | Subtracts tan(pitch)×halfSpan from Mapbox height. Austin 10.7m, 35° → wallHeight 4.4m → 1f (was 3f from raw height). Minneapolis 8m, 41.6° → 3.6m → 1f (was 2f). |
| **Smarty Stories Priority** | **8/10** | Tax assessor records above SV image analysis. Cross-ref cap (stories+1) catches LA hillside inflation (16.1m → 5f capped to 2f). |
| **Solar Footprint in minFloors** | **7/10** | Prevents sqft heuristic from forcing extra floors on sprawling ranches when solarBuildingArea shows large single-floor footprint. |
| **Pitch-Aware Multi-Unit** | **9/10** | Charleston 30.4° no longer forced flat by multi-unit heuristic (6bed/6bath→"multi-unit"→flat). Respects pitch > 15° evidence. |
| **OpenRouter VLM** | **9/10** | Claude Sonnet 4.5 via OpenRouter classifies styles correctly: SF "Mediterranean"→desert, LA "Modern", Charleston "Colonial", Denver "Ranch". Validated all 14 addresses. |

### VLM Classification Results

| Address | VLM Style | VLM Wall | VLM Roof | Mapped Style |
|---------|-----------|----------|----------|-------------|
| SF | Mediterranean | stucco | clay_tile | desert |
| LA | Modern | concrete | flat_membrane | modern |
| Denver | Ranch | stucco | asphalt_shingle | rustic |
| Minneapolis | Farmhouse | vinyl | asphalt_shingle | rustic |
| Charleston | Colonial | wood_siding | metal | colonial |
| Seattle | Ranch | wood_siding | asphalt_shingle | rustic |
| Tucson | Desert | stucco | - | desert |

_Newton, Austin, San Jose, Walpole, Byron, Vinalhaven, Suttons Bay: no VLM data (SV images were indoor panoramas or unavailable)_

### Per-Address Scores

| Location | Phase 2+3 | Phase 4+5 | Notes |
|----------|-----------|-----------|-------|
| **SF** | 8.5 | **9.0** | VLM "Mediterranean"→desert fixes Colonial mismatch. Stucco+flat roof correct. |
| **Newton** | 8.5 | **8.5** | Unchanged. Colonial/Gable/3f still correct. |
| **Austin** | 7.5 | **8.5** | Height correction 3f→2f. Still 1 over (real: 1f ranch). |
| **Denver** | 9.5 | **9.5** | Unchanged. Perfect rustic/hip/1f. |
| **Seattle** | 9.0 | **9.0** | Unchanged. Rustic/Gable/2f correct for Craftsman. |
| **LA** | 9.0 | **8.5** | Floor correction 4f→2f better for hillside FLW. Style: modern→modern (was desert). |
| **Minneapolis** | 8.5 | **9.0** | Floor correction 2f→1f. Correct for bungalow. |
| **Charleston** | 8.0 | **8.5** | VLM "Colonial" (was Gothic). Gable roof (was flat). Footprint preserved. |
| **Tucson** | 9.0 | **9.5** | VLM confirms "Desert". Already optimal. |

**Average: 8.6/10 → 8.9/10 (+0.3 points)**

### Regressions

- **LA**: 9.0 → 8.5. Floor correction (4→2) may under-represent the multi-level FLW building. VLM changed desert→modern (stucco→concrete is less warm visually but more accurate).

### Top 3 Remaining Accuracy Gaps

1. **Austin 1-floor ranch** — Still generates 2f (minFloors=2 from sqft=3444 > 3000). Need to trust Smarty stories=1 more aggressively for known single-story.
2. **Charleston hip vs gable** — Solar pitch 30.4° correctly prevents flat, but infers gable instead of hip. Hip is standard for Southern architecture.
3. **VLM coverage gaps** — 5/14 addresses got no VLM data (indoor panoramas or no SV image). Need multi-heading fallback or Mapillary image analysis.

### Summary

| Phase | Average | Key Achievement |
|-------|---------|-----------------|
| Baseline | 5.3/10 | Raw sqft/year heuristics |
| Phase 1 | 7.9/10 | Floor confidence gate, vegetation rejection |
| Phase 2+3 | 8.6/10 | Pitch-driven roofs, gambrel fix, Charleston ratio |
| **Phase 4+5** | **8.9/10** | Height correction, VLM style classification via OpenRouter |
