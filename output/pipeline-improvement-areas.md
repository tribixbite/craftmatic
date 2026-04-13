# Voxelizer Pipeline: 10 Areas for Improvement

Based on visual inspection of 3 test buildings (Flatiron, Noe Valley residential, Geisel Library) voxelized from cached Google 3D Tiles GLBs, plus architecture review.

---

## 1. Facade Void Filling is Inadequate

**Observed:** Flatiron iso view has massive black holes spanning 10-20 block areas mid-facade. The building looks like a bombed-out ruin rather than a solid structure.

**Root cause:** `fillFacadeHoles()` only does a single pass filling air with 4+ solid face-neighbors. This threshold is too strict for large voids — a 5-wide hole has interior air voxels with 0-2 solid neighbors, so they're never touched.

**Fix:** Multi-pass iterative fill (currently rejected because 3-pass closed courtyards). Need facade-aware iteration: only fill voxels that are coplanar with known facade planes, not interior voids. Use the facade plane detection from `flattenFacades()` to constrain fill direction.

---

## 2. Gray Monotone / Color Desaturation

**Observed:** All 3 buildings are overwhelmingly gray. Noe is a uniform gray box with zero color variation. Flatiron has 95% gray stone blocks. Geisel is dark gray chaos.

**Root cause:** Google 3D Tiles textures are photogrammetry captures with baked shadows, sky reflections, and atmospheric haze — all desaturating toward gray. The pipeline's `smoothDarkBlocks` + `modeFilter3D` + `constrainPalette` each push further toward gray by averaging and merging outlier colors.

**Fix:** (a) Histogram equalization on sampled RGB before `rgbToWallBlock()` mapping — stretch saturation channel. (b) Use satellite imagery color as a facade tint reference (already have `sampleSatelliteRoof()`). (c) Per-face dominant color from Street View analysis, applied as a warm/cool shift to the entire face rather than block-by-block.

---

## 3. Auto-Detect Confidence Too Low → Generic Mode Fallback

**Observed:** All 3 test buildings scored confidence 4.3-4.9/10, triggering `--generic` mode. Generic mode skips most post-processing (facade flatten, straighten, cornice detect, window regularization, peaked roof). The pipeline's best tools are never used.

**Root cause:** `analyzeGrid()` penalizes low footprint fill ratio, irregular shapes, and low rectangular confidence. Photogrammetry captures inherently have ragged edges and noise that tank these metrics. The threshold for building-mode vs generic is poorly calibrated.

**Fix:** (a) Lower the generic threshold — 4.5 should still qualify for building mode. (b) Add pre-analysis cleanup: a light morphClose + ground removal before running `analyzeGrid()` so the confidence score reflects the cleaned shape, not raw mesh noise. (c) Separate "data quality" from "building detection" — a ragged building is still a building.

---

## 4. Vertical Striping Artifacts

**Observed:** Flatiron facades have pronounced vertical stripes — alternating solid/air columns creating a venetian-blind effect.

**Root cause:** Voxelization of thin mesh surfaces at oblique angles to the grid. When a mesh face is nearly parallel to a voxel column, some columns intersect and others don't, creating the striping pattern. The narrow-band voxelizer (v316 phase 5) helps but doesn't eliminate it for facade planes that aren't axis-aligned.

**Fix:** (a) Increase voxelization overlap — use a larger sampling kernel or ray bundle per voxel. (b) Post-voxelize: detect stripe patterns (air columns between two solid columns on the same facade plane) and fill them. Could be as simple as a 1D morphClose along each horizontal facade row.

---

## 5. Ground Plane Bleeding / Below-Grade Artifacts

**Observed:** Noe has dark "dripping" artifacts extending below the building footprint. Geisel has sandstone-colored ground bleeding up into the structure.

**Root cause:** Google 3D Tiles include terrain mesh that intersects building bases. `removeGroundPlane()` is too conservative — it only clears the bottom 1-2 layers. `filterMeshesByHeight()` uses a global `minHeight` threshold that doesn't account for sloped terrain.

**Fix:** (a) Per-column ground detection: for each XZ column, find the lowest solid voxel and check if it's part of a horizontal plane (not the building). Clear everything below. (b) Use OSM building footprint earlier — if we have the polygon, clip below-grade voxels before any other processing. (c) Adaptive `minHeight` based on terrain slope from the mesh itself.

---

## 6. Building Isolation Failure (Neighbor Merging)

**Observed:** Geisel topdown shows a massive circular blob that includes surrounding terrain, walkways, and adjacent structures all merged into one mass. The distinctive mushroom shape is buried inside noise.

**Root cause:** `isolateTallestStructure()` uses connected-component analysis, but when the capture radius is too large, everything is connected via ground plane. The component label covers the entire grid. `severByHeightGradient()` and `watershedIsolate()` try to separate, but the height gradient is gradual (parking structure merges into library).

**Fix:** (a) Tighter capture radius — building-bounds pipeline should reduce radius for distinctive shapes. (b) Use OSM footprint polygon as a hard mask before any CC analysis. Currently `maskToFootprint()` runs after isolation, but it should be the first operation. (c) For non-OSM cases: density-based clustering (DBSCAN) on the voxel cloud, not just CC labeling.

---

## 7. Interior Fill / Clear Cycle Waste

**Observed:** Pipeline logs show massive fill operations (`fillInteriorGaps: 12,000 filled`, `scanlineInteriorFill: 8,000 filled`) immediately followed by `clearOpenAirFill: 11,500 cleared`. This fill-then-clear cycle is wasteful and can damage real geometry.

**Root cause:** Interior fill algorithms assume a watertight shell, but photogrammetry meshes are full of holes. Fill leaks through facade voids, then `clearOpenAirFill` has to clean up. But the cleanup uses floodfill from exterior air, which may not reach all leaked areas, or may incorrectly clear real interior space.

**Fix:** (a) Run facade void filling BEFORE interior fill — close the shell first. (b) Use a conservative fill strategy: only fill voxels that are enclosed on all 6 faces by ray-cast to solid (not just CC-based). (c) Track which voxels were filled vs original, so clear can target only filled voxels rather than applying destructive floodfill.

---

## 8. No Roof Reconstruction

**Observed:** Flatiron has a ragged, uneven top with random bumps and missing sections. Noe's flat roof is featureless gray. Neither looks like an actual building roof.

**Root cause:** `addPeakedRoof()` exists but is only triggered for specific residential typologies. Flat roofs get no treatment — the raw photogrammetry top surface (which is the worst-captured area due to limited aerial coverage) is left as-is.

**Fix:** (a) Flat roof cleanup: detect the roof plane (highest continuous horizontal surface) and regularize it — fill holes, level bumps, apply uniform material. (b) Use satellite imagery for roof color (already have `sampleSatelliteRoof()` but it's only used for semantic recolor). (c) For buildings with known pitched roofs (from OSM/Smarty data), reconstruct the roof geometry procedurally rather than trusting the mesh.

---

## 9. No Window/Fenestration Pattern

**Observed:** None of the 3 buildings show any window pattern. Facades are solid walls of gray blocks. `detectAndRegularizeWindows()` and `injectSyntheticWindows()` exist but aren't producing visible results.

**Root cause:** Window detection depends on identifying recessed or differently-colored voxels in a regular grid pattern on facades. Photogrammetry textures map windows as slightly darker gray pixels — not distinct enough for the delta-E threshold. And with generic mode active, many window operations are skipped entirely.

**Fix:** (a) Lower the luminance threshold for dark window detection in `glazeDarkWindows()`. (b) Use Street View imagery to identify window positions and spacing, then project onto the voxel grid. (c) For buildings where windows aren't detected, inject a synthetic pattern based on building type (commercial = regular grid, residential = centered per floor).

---

## 10. Pipeline Ordering: OSM Data Should Be First-Class

**Observed:** The pipeline runs 15+ geometry passes before consulting OSM data. By the time the OSM footprint is applied, the building has already been mangled by generic-mode processing.

**Root cause:** Historical pipeline growth — OSM integration was added late. The auto-detect + geometry stages were designed for stand-alone operation. OSM mask is treated as an optional refinement rather than the primary shape constraint.

**Fix:** Restructure pipeline ordering:
1. Load GLB → voxelize → **immediately** apply OSM footprint mask (if coords available)
2. Run `analyzeGrid()` on the masked result (much higher confidence)
3. Apply building-mode processing (not generic)
4. Color pipeline with OSM/SV material data

This "OSM-first" approach would fix issues #3, #6, and partially #5 and #8. The building bounds pipeline already resolves OSM data in parallel — just need to use it earlier.

---

## Priority Order

| Priority | Area | Impact | Effort | Status |
|----------|------|--------|--------|--------|
| 1 | #10 OSM-first pipeline | Fixes 3-4 other issues | Medium | **Partial** — OSM earlier, try/catch, but not before analyzeGrid |
| 2 | #3 Auto-detect calibration | Unlocks all post-processing | Low | **DONE** — threshold lowered to 3.5 |
| 3 | #1 Facade void filling | Biggest visual defect | Medium | **DONE** — `fillFacadeVoidsIterative` (facade-plane-constrained multi-pass) |
| 4 | #2 Color desaturation | Universal quality issue | Medium | **DONE** — `boostPhotogrammetrySaturation` (Lab hue-matched replacement) |
| 5 | #6 Building isolation | Critical for complex sites | High | Unchanged |
| 6 | #4 Vertical striping | Common artifact | Medium | **DONE** — `fillFacadeStripes` (X/Z axis gap scan) |
| 7 | #7 Fill/clear ordering | Correctness + perf | Low | **DONE** — `filledSet` tracking, clear only filled voxels |
| 8 | #5 Ground plane cleanup | Common artifact | Medium | **DONE** — `removeGroundPlaneAdaptive` (per-Y fill ratio analysis) |
| 9 | #9 Window patterns | Adds realism | High | **Partial** — `glazeDarkWindows(photogrammetryMode=true)` wired |
| 10 | #8 Roof reconstruction | Adds realism | High | **DONE** — `regularizeFlatRoof` (top-Y leveling + hole fill) |

## Review History

| Date | Rating | Findings |
|------|--------|----------|
| 2026-04-13 (pre-fix) | 6.5/10 | 20 findings from Opus architecture review |
| 2026-04-13 (post-fix round 1) | 8.5/10 | 2 CRITICAL + 4 HIGH + 6 MEDIUM + 6 LOW |
| 2026-04-13 (post-fix round 2) | 8.0/10 | 0 CRITICAL + 3 HIGH (pre-existing) + 5 MEDIUM + 5 LOW |

### Remaining HIGH findings (pre-existing, not from this session):
- H1: `smoothRareBlocks` reads from live grid during mutation (cascading replacements)
- H2: `maskToFootprintAligned` missing erode step (mask larger than intended)
- H3: `maskToFootprintAligned` applies dx/dz offset before rotation (offset gets rotated)

— Opus 4.6, 2026-04-13
