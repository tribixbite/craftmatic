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

## Phase 4 (complete — floor count + multi-unit roof)
- [x] Roof height correction: subtract tan(pitch)×halfSpan from Mapbox height
- [x] Property records (Smarty) priority above SV in floor estimation chain
- [x] Cross-ref cap: heightDerivedFloors ≤ prop.stories + 1
- [x] Solar footprint in minFloors (catches sprawling ranches without OSM data)
- [x] Multi-unit flat override respects Solar pitch > 15° evidence
- [x] Austin: 3f → 2f | Charleston: flat → gable
- [x] Regen + render + CI green

## Phase 5 (complete — 8.6/10 → 8.9/10)
- [x] OpenRouter provider support for VLM Tier 3 (OPENROUTER_API_KEY)
- [x] Full regen with VLM: SF "Mediterranean", LA "Modern", Charleston "Colonial"
- [x] Regen comparison data + render images for all 14 addresses
- [x] Grading via Claude Sonnet/Gemini (8.9/10 avg)

## Phase 6 (complete — floor cap + VLM roofShape)
- [x] Discrepancy-based stories cap: trust assessor exactly for ≤1 gap (Austin 2f→1f)
- [x] minFloors capped to prop.stories when assessor data available
- [x] VLM roofShape field added to Tier 3 prompt (gable/hip/flat/gambrel/mansard/shed)
- [x] VLM roofShape wired through CLI + comparison + roof priority chain
- [x] Fix mapArchitectureToStyle missing "desert"/"brownstone" regex patterns
- [x] Regen comparison data + render images for all 14 addresses
- [ ] Charleston gable→hip: VLM returns gable (front-view limitation)
- [ ] Newton 3f→2f: Mapbox 7.5m with roof correction gives 1f, minFloors=2 caps to 2f

## Data Audit (complete — JSON fidelity)
- [x] Full PropertyData stored in comparison JSON (was 7 fields, now 19-61)
- [x] resolvedPalette stored in genOptions (was missing — SV color data not serialized)
- [x] Comparison UI: notes row shows wall/roofMat from resolvedPalette
- [x] Comparison UI: generateForTier() passes resolvedPalette/landscape/orientation/season
- [x] All 14 addresses verified: svWallOverride → resolvedPalette.wall correctly propagated
- [x] Import tab JSON round-trip: importedPropertyOverrides for all non-form fields
- [x] Generate tab: roofShape, floorPlanShape, features, season, JSON import/export
- [x] All 14 addresses re-rendered at tile=10 (was: only 3 at tile=10, 11 at tile=8)
- [x] VLM non-determinism resolved: full regen produces consistent JSON + images in single pass

## Phase 7 (complete — SV indoor fix + roof height + outdoor preference)
- [x] Multi-factor indoor detection: foliage (trees ≠ ceiling) + road (bottom zone) scoring
- [x] source=outdoor preference on SV metadata API (free calls, avoids indoor panoramas)
- [x] queryStreetViewFallback() retries at 100m/250m/500m radius when indoor detected
- [x] Removed proportional cap ln(area×0.15+3) from roof height formula — trust Solar tangent
- [x] Walpole: roofH 4→6 blocks (31° pitch), SV analysis now runs (was false-positive indoor)
- [x] Regen + render 5 affected addresses at tile=10
- [ ] Byron/Vinalhaven/Suttonsbay: no outdoor SV coverage at all (rural, 3/14 still missing VLM)
- [ ] San Jose (Winchester Mystery House): indoor panorama confirmed, no outdoor fallback available

## Phase 8 (backlog — targeting 9.5+)
- [ ] VLM floor count estimation as additional signal
- [ ] Charleston hip: multi-angle VLM or Solar segment geometry cross-ref
- [ ] Improved roof correction for wide buildings (estSpan from sqft is unreliable)
- [ ] Multi-heading SV for tree-obscured views (rotate ±45° to find clearer angle)
