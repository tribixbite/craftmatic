# Accuracy Fix Tasks

## Phase 1 (complete — 5.3/10 → 7.9/10)
- [x] P0: Floor estimation confidence gate (address-pipeline.ts)
- [x] P1: Green/vegetation rejection in SV color analysis
- [x] P2: Region-aware year→style mapping
- [x] P3: Mapillary heading alignment in image selection
- [x] Regenerate comparison data + images for all fixes
- [x] Gemini 3.1 Pro visual grading of before/after

## Phase 2 (complete — VLM + Roof + Color)
- [x] Enhanced Vision Tier 3 prompt with structured style + material taxonomy
- [x] Wired VLM fields through CLI + comparison + resolveStyle()
- [x] dominantColorExcluding() vegetation bypass in CLI + browser
- [x] Solar pitch → roof shape refinement (tangent + Arnis log cap)
- [x] Typecheck, test, build, regen comparison, push + CI

## Phase 3 (complete — 7.9/10 → 8.6/10)
- [x] Fix gambrel overuse: pitch-driven roof shape (was segment-count)
- [x] Charleston 3:1 aspect ratio for OSM-measured footprints
- [x] Regen comparison data + images for all 14 addresses
- [x] Gemini 3 Pro Phase 2+3 grading

## Phase 4 (pending — targeting 9.0+)
- [ ] Investigate Austin floor count regression (3f on 1-story ranch)
- [ ] Low-slope hip discrimination (5°-15° range, precipitation bias)
- [ ] Enable VLM with ANTHROPIC_API_KEY for comparison generation
- [ ] Validate VLM style labels fix SF "Colonial"→"Mediterranean"
