# Accuracy Grading — Gemini 3 Pro Preview

_2026-02-28 — automated review of P0-P3 accuracy fixes_

## Fix Impact Scores

| Fix | Score | Rationale |
|-----|-------|-----------|
| **P0: Floor Gate** | **10/10** | Critical structural fix. SV story counting is unreliable due to tree occlusion and camera angles. Gating behind Mapbox/Overture height data (Lidar/photogrammetry-derived) corrects fundamental building massing. Fixed 50% of sample cases (SF, Austin, Denver, LA). |
| **P1: Veg. Rejection** | **8/10** | Critical visual fix. "Green houses" are a jarring immersion breaker. Simple HSL filtering is computationally cheap and effective. Prevents the wrong color even if it doesn't find the perfect one. |
| **P2: Region Styles** | **5/10** | Heuristic band-aid. Moving SF from "Desert" to "Colonial" is an improvement but still inaccurate (real: Mediterranean). Hard-coding style by region+year is brittle. Solves "Desert in Seattle" absurdity but doesn't solve true style fidelity. |
| **P3: Heading Align** | **3/10** | Quality of life. Important for thumbnail UX but low impact on schematic generation in this batch. Foundational fix for future improvements (better sampling). |

## Overall Accuracy Improvement

**Estimated: ~40% → ~80% accuracy**

- **Massing (Height/Scale):** Significantly improved. System now respects physical reality (Mapbox data) over vision inference. Eliminated "1-story pancake" and "tall-skinny tower" errors.
- **Materiality:** Improved resilience. No longer painting houses with hedge textures.
- **Style:** Marginally improved. Removed "Desert" from non-desert regions, but "Colonial" fallback is too generic for complex markets like SF or historic Charleston.

## Per-Address Before/After Scores

| Location | Before | After | Notes |
|----------|--------|-------|-------|
| **SF (Francisco St)** | 2/10 | 7/10 | Massive improvement. 1f→4f critical. Style still wrong (Colonial vs Mediterranean) but massing is primary factor. |
| **Austin (Long Canyon)** | 3/10 | 8/10 | Fixed both massing (+1 floor) and "Green Wall" bug. |
| **Denver (S Xavier)** | 4/10 | 9/10 | Near perfect. Removing hallucinated 2nd floor makes correct Ranch representation. |
| **Seattle (Ledroit Pl)** | 3/10 | 7/10 | Fixed green wall. "Rustic" is safe bet for Seattle. |
| **LA (Ennis House)** | 6/10 | 8/10 | +1 floor helps. "Desert" style (sandstone/terracotta) works well for FLW textile blocks. |
| **Charleston** | 7/10 | 7/10 | Unchanged. Gothic acceptable for historic Charleston. |
| **Minneapolis** | 8/10 | 8/10 | Unchanged. Rustic 2f good fit for Craftsman bungalow. |
| **Tucson** | 9/10 | 9/10 | Unchanged. Already optimal. |

**Average: Before 5.3/10 → After 7.9/10 (+2.6 points)**

## Recommended Next Steps (Priority Order)

1. **VLM-based style classifier**: Send P3-aligned SV image to a lightweight VLM (GPT-4o-mini or Haiku) to classify architectural style from Minecraft-compatible options. Solves SF Mediterranean vs Colonial immediately.

2. **Roof shape determination**: Query Google Solar / Overture 3D roof attributes. If unavailable, use VLM to also extract roof_type.

3. **K-Means color sampling**: Replace P1 fallback-to-defaults with K-Means clustering on the P3-aligned image (excluding green/sky/asphalt hue ranges). Pick dominant non-vegetation cluster center.
