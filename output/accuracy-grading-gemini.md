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
