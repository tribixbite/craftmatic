# LEGO Pipeline — Complete Gaps Roadmap

> This file drives the automated improvement loop (loop-state.json).
> Each pass picks the highest-priority unfinished item, implements it fully,
> records it in improvement-log.md, and updates this file.
>
> **LOOP INSTRUCTIONS**: Read this file first, then improvement-log.md to see
> what's done. Pick the first OPEN item, implement it completely, mark DONE.

---

## Resources Available from ../clego

| Resource | Path | What it gives us |
|---|---|---|
| **Part library** | `C:\git\clego\extracted\studio_release\app\ldraw\parts\` | 19,075 .dat files, full geometry |
| **Primitives** | `C:\git\clego\extracted\studio_release\app\ldraw\p\` | 2,671 primitive .dat files |
| **Sub-parts** | `C:\git\clego\extracted\studio_release\app\ldraw\parts\s\` | 6,940 sub-part .dat files |
| **StudioColorDefinition.txt** | `C:\git\clego\extracted\studio_release\app\data\StudioColorDefinition.txt` | 255 colors: Studio→BL→LDraw→LDD columns |
| **StudioPartDefinition2.txt** | `C:\git\clego\extracted\studio_release\app\data\StudioPartDefinition2.txt` | 18,842 Studio part→LDraw .dat mappings |
| **ldraw.xml** | `C:\git\clego\extracted\studio_release\app\data\ldraw.xml` | LDD designID→LDraw filename (210 entries) |
| **LEGOSetList.tsv** | `C:\git\clego\extracted\studio_release\app\data\LEGOSetList.tsv` | 20,060 official sets |
| **LDConfig.ldr** | `C:\git\clego\extracted\studio_release\app\ldraw\LDConfig.ldr` | LDraw color definitions (official) |
| **Reconstructed LDR** | `C:\git\clego\lego_sets\Reconstructed\` | 5,005 reconstructed 3D .ldr models |
| **PDF instructions** | `C:\git\clego\lego_sets\PDF\` | 11,700 LEGO instruction PDFs |
| **part_dims.py** | `C:\git\clego\part_dims.py` | Python reference: 192 manual part dims |
| **reconstruct_from_pdf.py** | `C:\git\clego\reconstruct_from_pdf.py` | 2,566-line pure-CV PDF→3D pipeline |

---

## Gap Items — Priority Ordered

### GAP-01 — BFF Fallback: 2D Mosaic → Real 3D Model [DONE — Pass 1] ★★★★★
**Current**: When a set is not in LDraw OMR, `bff-loader.ts` produces a flat 2D grid of 1×1 plates (a color mosaic), NOT a 3D assembled model.
**Impact**: ~18,000+ sets (everything not in the 1,470-set OMR) render as flat floors.
**Fix**: Multi-tiered fallback upgrade:

1. **Tier 1 — clego Reconstructed**: Serve the 5,005 .ldr files from `../clego/lego_sets/Reconstructed/` via the dev server or bundle a manifest. When user requests set `75192-1`, check if `75192-1_reconstructed.ldr` exists and serve it instead of the BFF mosaic.
   - Add `/lego-reconstructed/` proxy route in `vite.config.ts` pointing to `C:\git\clego\lego_sets\Reconstructed\`
   - In `lego.ts` auto-load chain: OMR → clego reconstructed → BFF mosaic
   - File naming in clego: `{set_num}_reconstructed.ldr` (verify exact format with `ls C:\git\clego\lego_sets\Reconstructed\ | head -20`)

2. **Tier 2 — Seymouria LDR**: 1,717 LDR files in `C:\git\clego\lego_sets\LDR\`. Same proxy approach.

3. **Tier 3 — BFF mosaic kept as last resort** with a clear UI label "Color reference only — no 3D shape"

**Acceptance criteria**: Loading a set not in OMR shows a 3D voxelized shape (not a flat mosaic) when the reconstructed file exists.

---

### GAP-02 — Cubic Mode + Slope Angles are Squashed [DONE — Pass 2] ★★★★
**Current**: When `cubicScale=true`, `LDU_PER_Y=20` (studs) instead of 8 (plates). But the slope ramp height `spanY` is computed in *grid cells*, so the linear taper `round(t * spanY)` is unaffected by the LDU scale. However, arch radius uses `archRPlates = archRStuds * 2.5` which hardcodes the plate-to-stud ratio. In cubic mode this multiplier should be `1.0` not `2.5`.

**Investigation needed**: Read `voxelizeLDraw` in `ldraw-voxelizer.ts`. Find every place where `2.5` or `LDU_PER_PLATE / LDU_PER_STUD` is implicitly assumed. Specifically:
- Arch radius: `archRPlates = archRStuds * 2.5` — wrong in cubic mode (should be `* 1.0`)
- Slope `spanY` is already in grid cells (correct for both modes)
- Check `gyMin/gyMax` computation is using correct `LDU_PER_Y`

**Fix**: Thread `options` (or derived `aspectRatio = LDU_PER_Y / LDU_PER_STUD`) into arch masking. In cubic mode, arch radius in plate-cells = `archRStuds * 1.0`.

**Acceptance criteria**: In cubic mode, ISD arch parts (inverted arches on hull) produce correct curved hollow undersides. Before/after block count comparison.

---

### GAP-03 — Unknown Color IDs → Silent Gray [DONE — Pass 1] ★★★
**Current**: Any unmapped color ID silently maps to `minecraft:gray_concrete`. No warning. User has no idea their model has unmapped colors.
**Fix**:
1. In `voxelizeLDraw`, track unmapped color IDs (Set of unseen IDs).
2. Add `unmappedColors: number[]` to the return value of `voxelizeLDraw`.
3. In `lego.ts` `voxelizeAndDisplay`, if `unmappedColors.length > 0`, add a warning to the status bar: `⚠ ${unmappedColors.length} unmapped color IDs (${unmappedColors.slice(0,5).join(', ')}...) → gray`.
4. Cross-reference `LDConfig.ldr` to identify what these color IDs actually are (for future mapping).

**Acceptance criteria**: Loading a set with unusual colors shows a warning listing the unmapped IDs.

---

### GAP-04 — LDraw Part Dims: 11,000 Parts with No Entry [DONE — Pass 2] ★★★★
**Current**: `ldraw-part-dims-generated.ts` has 7,252 entries. LDraw library has 19,075 parts. ~11,800 parts fall back to `[1,1,1]`.
**Why the gap**: `gen-part-dims.ts` skips parts whose computed bbox rounds to `[1,1,1]` (same as default, no point emitting). But many parts that should have larger dims fail to compute correctly due to:
  - Sub-file resolution failures (missing primitives)
  - Geometry only in primitives (box5.dat, cylinder, ring) that aren't expanded
  - Parts where all geometry is in sub-parts not recursively resolved

**Fix**:
1. Audit `gen-part-dims.ts` — verify it actually resolves `p/` primitives (box5.dat, 4-4cyli.dat etc.)
2. The key primitives that define most brick geometry are in `p/`: `box5.dat` (basic box), `box4.dat`, `4-4cyli.dat` (cylinder), rings. If these are not recursively resolved, most parts will have empty bboxes.
3. Cross-reference with `part_dims.py` from clego (192 manual entries) — check if any of those should be in our table but aren't.
4. Use `StudioPartDefinition2.txt` to find LDraw filenames for common BL parts; verify dims.
5. For the worst offenders: run `scripts/check-bbox.mjs` on common parts that return [1,1,1] to diagnose.

**Target**: Get generated table from 7,252 to 14,000+ entries (covering all non-trivially-sized parts).

**Acceptance criteria**: `gen-part-dims.ts` re-run produces ≥14,000 entries. Common parts like Technic pins, beams, axles have correct dims.

---

### GAP-05 — Recursion Depth Limit Too Low [DONE — Pass 1] ★★
**Current**: `MAX_DEPTH = 20` in `ldraw-parser.ts`. Deeply nested sub-assemblies (Technic gearboxes, Power Functions modules, some Creator sets) silently truncate.
**Fix**: Increase `MAX_DEPTH` from 20 to 50. Test that circular reference guard still works correctly (the `visited` Set is the real guard; depth is just a failsafe).
**Acceptance criteria**: Models with deep sub-assemblies (e.g. Mindstorms NXT 8527) parse completely. No performance regression on benchmark sets.

---

### GAP-06 — LXF Rotation Flip Unvalidated [DONE — Pass 3] ★★
**Current**: `lxf-parser.ts` applies `C×R×C` where `C = diag(1,-1,1)` to convert LDD Y-up → LDraw Y-down. This formula is theoretically correct but was never validated against real `.lxf` exports.
**Fix**:
1. Find a known .lxf file in `C:\git\clego\lego_sets\LXF\` — pick a simple set (e.g. a small Creator set).
2. Parse it with the current code, voxelize, and compare visually to the official image.
3. If wrong orientation: try `R_ldraw = R_ldd` (no flip), `R_ldraw = -R_ldd`, etc.
4. Document the validated formula.

**Acceptance criteria**: A simple Creator .lxf set (e.g. 10696 Classic Medium Box) renders correctly oriented (house is upright, not flipped).

---

### GAP-07 — Minifig Parts: 1×1 Plate → Humanoid Shape [OPEN] ★★
**Current**: Minifig parts (head 3626c, torso 973c, hips 3815, legs 3816/3817, arms 3819/3818) have dims in the table but no special assembly. A full minifig renders as a 2×5×2 block pillar.
**Fix**:
1. Detect minifig part clusters in `voxelizeLDraw`: if a model contains ≥3 of the key minifig part IDs within a small spatial neighborhood, treat them as a unit.
2. Better approach: add all minifig sub-parts to PART_SHAPES with accurate dims:
   - Head `3626c`: `[1,2,1]` round shape
   - Torso `973c01`: `[2,3,2]`
   - Hips `3815`: `[2,1,2]`
   - Each leg `3816`/`3817`: `[1,2,1]`
3. Verify dims from LDraw .dat files using `scripts/check-bbox.mjs`.

**Acceptance criteria**: A set with minifigs (e.g. any City set) shows recognizable humanoid shapes instead of undifferentiated blocks.

---

### GAP-08 — Transparent Parts: Adjacent Face Bleed [OPEN] ★★
**Current**: Transparent LEGO maps to stained glass. But adjacent transparent blocks don't merge faces in Minecraft's Three.js renderer — large transparent surfaces (windshields, cockpit canopies) render with internal grid lines visible.
**Fix**: In the Three.js renderer (scene.ts), transparent blocks that are adjacent should share a merged face. Options:
1. Post-process the grid: replace large contiguous glass regions with a single merged transparent mesh.
2. Add a `glass_plane` geometry type (like `pane` but full-block) that's a single quad per face.
3. For now, at minimum: ensure `renderOrder` is set correctly so transparent faces don't z-fight.

**Acceptance criteria**: A model with a large cockpit canopy (e.g. Falcon cockpit dome) renders as a smooth curved transparent surface, not a grid.

---

### GAP-09 — MAX_DIM=256 Scale-Down: No Crop Option [DONE — Pass 3] ★★
**Current**: Models over 256 blocks in any dimension scale the entire grid down uniformly. A tall model like Saturn V (13×256×16) loses no width/depth info; but a wide model that's only slightly over 256 gets unnecessarily shrunk.
**Fix**:
1. Add `maxDim?: number` to `VoxelizeOptions` (default 384 to allow non-legacy Minecraft; old limit was 256).
2. Add `cropInstead?: boolean` to `VoxelizeOptions` — instead of scaling, crop the model at the dimension limit (keeping the base, removing top).
3. Update UI: add a "Max Size" control or just increase default to 384.
4. Warning: "Scaled to fit 256-block limit" is already shown; update text to reflect actual limit.

**Acceptance criteria**: Saturn V in accurate mode (256 plates tall) fits without scaling. Models up to 384 blocks render without warning.

---

### GAP-10 — Standalone .ldr Files: Missing Sub-Part Resolution [DONE — Pass 3] ★★★
**Current**: `parseLDraw` resolves sub-files by looking in the MPD's embedded sections. For standalone `.ldr` files that reference external library parts (e.g. `1 16 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat`), the sub-file sections don't exist in the file → the part is emitted as a primitive reference and filtered out.
**Implication**: Standalone LDR files (like those from clego's Reconstructed folder) may have ZERO parts after parsing if all parts are external references.
**Investigation**: Test parsing a reconstructed LDR from clego:
```
parseLDraw(readFileSync('C:/git/clego/lego_sets/Reconstructed/75192-1_reconstructed.ldr', 'utf8'))
```
Count parsed bricks. If 0, this is the issue.
**Fix**: In `parseLDraw`, for unresolved sub-file refs:
- Don't just emit the reference as a leaf brick
- If the ref matches a known part ID (exists in `DIMS` or `GENERATED_DIMS`), emit it as a `ParsedBrick` with the given transform but treat it as an atomic part (don't try to resolve its geometry)
- This is already the case for primitives — extend to ALL unresolved parts

**Acceptance criteria**: Parsing a standalone `.ldr` from clego Reconstructed produces correct brick count.

---

### GAP-11 — BFF Inventory Labels "2D" in UI [DONE — Pass 3] ★
**Current**: When BFF fallback produces a flat mosaic, it shows "Built {set}: {w}×{h}×{l} — N blocks". User doesn't know it's a flat mosaic vs a real 3D assembly.
**Fix**: BFF loader should return a flag `isMosaic: boolean`. In `lego.ts`, show a clear label: "⚠ 2D color map only — no 3D model available for this set" in amber. Add a note in the download description too.

**Acceptance criteria**: UI clearly differentiates 3D voxelizations from flat BFF mosaics.

---

### GAP-12 — BRACKET_SHELF_DIR Coverage Expansion [DONE — Pass 3] ★★
**Current**: `BRACKET_SHELF_DIR` covers 9 known bracket parts (99207, 99781, 99780, 44728, 36840, 36841, 15706, 11476, 92438). Any other bracket part defaults to `'up'`.
**Fix**:
1. Extract all bracket-tagged parts from `PART_SHAPES` in `ldraw-part-dims.ts`.
2. For each, look up the LDraw .dat description in `C:\git\clego\extracted\studio_release\app\ldraw\parts\`.
3. Check the description for "Up" vs "Down" vs "Side" in the LDraw description string (parts are typically named "Bracket 1x2-2x4 Up" etc).
4. Build a comprehensive `BRACKET_SHELF_DIR` covering all bracket variants.
5. Use `scripts/check-bbox.mjs` to verify orientation.

**Script to run**:
```bash
grep -r "Bracket" C:/git/clego/extracted/studio_release/app/ldraw/parts/ --include="*.dat" -l | head -50
```

**Acceptance criteria**: All bracket parts have explicit shelf direction entries (no unknown defaults).

---

### GAP-13 — Arch Masking: Asymmetric Pillar Support [OPEN] ★
**Current**: Arch masking assumes symmetric pillars at both ends of the arch span. Some arch parts (corner arches, curved wall sections) are asymmetric (pillar only at one end, or different-width pillars).
**Investigation**: Read all parts tagged `arch` in `PART_SHAPES`. Look up their LDraw descriptions. Identify any that are asymmetric.
**Fix**: Add `archPillarLeft: number` and `archPillarRight: number` to `PartShapeEntry` (default 1 for both). For asymmetric parts, set different values. Update arch masking to use per-part pillar widths.

**Acceptance criteria**: Asymmetric arch parts (if any exist in benchmark sets) render with correct hollow undersides.

---

### GAP-14 — Frame Coverage Expansion [DONE — Pass 3] ★
**Current**: Only 5 frame parts known. Other Technic open-frame bricks may exist.
**Fix**:
1. Search LDraw descriptions: `grep -i "Frame\|Open\|Window Frame" parts/*.dat | head -50`
2. For each candidate, check bbox with `scripts/check-bbox.mjs` and compute frame thickness.
3. Add to `PART_FRAME_THICKNESS` in `ldraw-part-dims.ts`.

**Acceptance criteria**: Frame coverage expanded to include all major frame/window variants.

---

### GAP-15 — Corner Masking Coverage Expansion [OPEN] ★
**Current**: Only 2 corner parts in `PART_SHAPES` (both are Technic frame corners from Falcon).
**Fix**:
1. Search for "Corner" in LDraw part descriptions.
2. Identify Technic connector corner variants, arch corner pieces, wall corner bricks.
3. Add to `PART_SHAPES` with `corner` shape type.

**Acceptance criteria**: Common corner pieces in popular sets are correctly L-shaped.

---

### GAP-16 — Model Orientation Normalization [DONE — Pass 3] ★★
**Current**: Assumes model is right-side-up. Some old LDR files (especially from BrickLink Studio 1.x) are upside-down or on their side. These render incorrectly in the voxelizer.
**Detection**: Check the Y centroid of the model relative to origin. If most geometry is at positive Y (which in LDraw = downward), the model is upright. If at negative Y, it's flipped.
**Fix**:
1. In `voxelizeLDraw`, compute the Y centroid of all brick positions.
2. If centroid is positive (meaning model extends downward in LDraw space), the model is correctly oriented (LDraw Y-down = LEGO parts sitting on a table, stud-up).
3. If centroid is negative (model extends upward in LDraw space), flip the model: negate all Y translations before voxelizing.
4. Add `wasFlipped: boolean` to return type and surface it in UI.

**Acceptance criteria**: An intentionally upside-down LDR file voxelizes correctly after auto-flip.

---

### GAP-17 — LOD for Large Models in 3D Viewer [OPEN] ★★
**Current**: Three.js renders every block at full geometry. ISD at 138K blocks can cause frame drops on mobile.
**Fix**:
1. In `scene.ts`, add a `LOD_THRESHOLD = 50_000` constant.
2. For models over threshold: group distant voxels into larger merged quads (2×2 or 4×4 block tiles).
3. Simpler alternative: culling — only render blocks with at least one exposed face (flood-fill from outside to mark hidden interior blocks, skip them).
4. Simplest win: Three.js already has frustum culling on InstancedMesh; ensure bounding boxes are set correctly.

**Acceptance criteria**: ISD (138K blocks) renders at ≥30fps on a mid-range machine. Culling hides interior blocks.

---

### GAP-18 — Assembly Step Sequencing from LDR [OPEN] ★★★
**Current**: No step-by-step assembly support. LDraw files use `0 STEP` meta-commands to separate build steps.
**clego resource**: `reconstruct_from_pdf.py` accumulates parts page-by-page (each page = one build step).
**Fix**:
1. In `ldraw-parser.ts`, preserve `STEP` markers from the LDraw file: when parsing, group `ParsedBrick[]` by step number (type-0 `STEP` lines).
2. Add `step?: number` to `ParsedBrick` interface.
3. In `lego.ts`, add a "Steps" slider/control: voxelize only bricks with `step <= currentStep`.
4. This gives interactive step-by-step playback.
5. The Layer Guide export should output steps instead of (or in addition to) Y-layers.

**Acceptance criteria**: Loading the Saturn V MPD and using the step slider shows progressive construction from bottom to top, matching the real instruction booklet.

---

### GAP-19 — Color Accuracy: Minecraft Palette Coverage [DONE — Pass 3] ★★
**Current**: 169 LDraw + 162 Studio colors mapped. No metric for how well Minecraft concrete/glass approximates the actual LEGO color palette.
**Fix**:
1. Load `LDConfig.ldr` from clego — it contains official hex RGB values for every LDraw color.
2. For each LDraw color mapped to a Minecraft block, compute ΔE (CIE76 color difference) between the LDraw hex and the Minecraft block's actual RGB.
3. For colors with ΔE > 20 (noticeably wrong), find a better Minecraft block.
4. Add more Minecraft blocks to expand the palette: deepslate, tuff, copper variants, terracotta variants, concrete powder, wool.
5. Export the color accuracy table as a build-time report.

**Acceptance criteria**: Average ΔE across all mapped colors is < 15. No mapped color has ΔE > 35.

---

### GAP-20 — PDF → Assembly Step Reconstruction [OPEN] ★★★★
**Current**: No PDF parsing in craftmatic at all. clego has 11,700 PDFs and a 2,566-line reconstruction pipeline.
**Integration approach** (NOT porting the full Python pipeline — too complex):
1. **Immediate**: Use clego's already-reconstructed 5,005 .ldr files (covered in GAP-01). This gives 3D models for 5,005 sets without needing the PDF pipeline.
2. **Medium-term**: Add a "Download Instructions PDF" link in the LEGO tab UI (use clego's `biapp_instructions.json` to know which sets have PDFs, link to LEGO's CDN).
3. **Long-term**: Port the LEGO instruction page-image step-detection to TypeScript/browser using the same CV approach (color blob detection per page, accumulate parts).
4. **For the loop**: Implement the "Download Instructions" link and step sequencing (GAP-18) in combination.

**Acceptance criteria**: LEGO tab shows a "View Instructions" link for sets with known PDFs. Step slider works for OMR/reconstructed models.

---

## Completion Criteria

All 20 gaps addressed = pipeline ready for production. Milestone scores:
- **GAP-01 complete**: 18,000+ sets now show real 3D shapes instead of flat mosaics
- **GAP-04 complete**: 14,000+ part dims entries (up from 7,252)
- **GAP-18 complete**: Interactive step-by-step build playback
- **GAP-20 complete**: PDF instruction link + step playback integrated

---

## Pass Instructions for Loop

Each loop pass:
1. Read this file — find the first OPEN item
2. Read `improvement-log.md` — verify it's not already done
3. Implement the item completely (code + typecheck + test)
4. Mark item `[DONE — Pass N]` in this file
5. Append to `improvement-log.md`
6. Run `bun run typecheck` — must pass clean
7. Run `bun scripts/visual-grade.ts` if relevant (voxelizer changes)

**HARD RULES (do not break)**:
- `scripts/loop-check.mjs` — never modify
- `.claude/loop-state.json` — only update via the state machine, never manually set `active: false`
- `spec/improvement-log.md` — append only, never delete history
- One gap per pass (don't combine multiple gaps into one pass unless trivially small)
- Typecheck must pass before finishing
