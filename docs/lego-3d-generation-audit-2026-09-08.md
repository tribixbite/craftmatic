# LEGO tab: 3D generation audit and TODOs

Audit date: 2026-09-08. Scope: deployed LEGO tab, especially floating elf hair in **10316 Rivendell** and separated pieces in **71043 Hogwarts Castle**. Documentation only; no application fixes are included.

## Evidence and limits

- Inspected [production](https://craftmatic.click/) using a fresh headless Chrome session. The app displayed `v2026.09.09`; its entry bundle was `assets/index-nxOWyDO3.js`. These identifiers do not prove correspondence to a Git commit.
- Read the [live model index](https://craftmatic.click/lego-models-index.json), generated `2026-09-05`, and compared the two entries with the checkout. They matched.
- Loaded **71043** through the deployed LEGO search. Status reported **5,967 bricks rendered as 3D geometry**, approximately **83×115 studs**, with an LDD alignment warning. The explode slider read **0**. The selected request was `/lego-models/LXF/71043_hogwarts_castle.lxf`.
- The live `/ldd-part-map.json` returned **HTTP 200 with 4,467 entries**. A missing alignment-table response did not explain that fresh load; per-part coverage and correctness remain unmeasured.
- Reviewed source resolution, LXF/LDraw parsing, part aliases/caches, direct rendering, voxel contact repair, and relevant test sources. Starting checkout HEAD was `1ef9333`; another agent is working in this repository.
- **The two visual defects are user-reported.** This audit did not independently measure the hair gap, capture a new visual comparison, identify the affected hair part IDs, or prove Hogwarts' precise transform defect. A completed render and a zero slider are not proof of correct assembly. Existing output images were not treated as current production evidence. No test suite was run for this documentation-only change.

## Pipeline and source selection

`Catalog/index → selected model → parser/world placements → part resolution → direct triangle viewer`

Voxel/Minecraft conversion is a separate downstream route. The direct-render branch in [lego.ts](../web/src/ui/lego.ts), `voxelizeAndDisplay()`, explicitly bypasses voxelization. Consequently, a voxel contact patch cannot establish that the direct 3D model is fixed.

| Set | Default live source | Alternative | Implication |
| --- | --- | --- | --- |
| 10316 | `mecabricks`, `MecabricksLDR/10316.ldr`, 6,271 indexed placements | `pdf_recon`, 7,784 indexed placements | Investigate conversion origins, resolved hair geometry and attachment; the alternative is an approximate reconstruction, not a verified replacement. |
| 71043 | `lxf`, `LXF/71043_hogwarts_castle.lxf`, 5,967 indexed placements | `lxf_conv`, 5,936 placements, `conv: 1` | Both sources have conversion lineage. Switching to the second source is not an established fix. |

Catalog counts are 6,181 and 6,020 respectively. Placement counts can differ because assemblies split into constituent parts, spares differ, or sources omit pieces. Count differences need reconciliation; they do not alone prove incompleteness.

## P0 — Resolve the two reported defects

### 1. 10316: diagnose elf hair in direct 3D

**Finding:** [ldraw-part-aliases.ts](../web/src/engine/ldraw-part-aliases.ts) documents Mecabricks/LDraw naming differences and origin incompatibilities already encountered in Rivendell. This makes a source/part-coordinate mismatch a credible hypothesis, but does not identify the hair defect. A correct-looking substitute can still have a different local origin.

**Existing work:** [ldraw-geometry.ts](../web/src/engine/ldraw-geometry.ts), `bridgePartContacts()`, addresses voxel head/hair seams. Its rationale cites measurements on **76416**, not 10316. It fills voxel contacts; it does not move the direct viewer's hair meshes.

- [ ] Reproduce each affected elf in production with 3D Render enabled, all layers visible, explode zero and rotation paused. Record source, hair/head IDs, original and resolved filenames, colors, world transforms, and front/side close-ups.
- [ ] Compare the source placement with the resolved `.dat` geometry in a trusted LDraw/Studio reference. Measure the hair attachment socket against the head stud in LDU; distinguish intentional shell clearance from a misplaced socket.
- [ ] Check alias/suffix fallback, substituted mould, missing subfiles, source conversion offsets, and any nested assembly transforms. Compare an unaffected figure and rotated instances of the same hair.
- [ ] Fix the earliest incorrect transform or part mapping. If an origin correction is necessary, scope it to verified source/part provenance and apply it in the proper local coordinate frame. Avoid a global vertical hair offset or automatically snapping all accessories to nearby heads.
- [ ] Validate voxel export separately. Ensure contact bridging preserves intentional gaps and does not merge adjacent figures, foliage, capes, or detached accessories.

**Acceptance:** identified elf hair sockets align with their heads in direct 3D from front, side and oblique views; no new head/hair intersections; the same parts work when rotated. Voxel output is checked independently at supported resolutions.

### 2. 71043: separate source placement from viewer explosion

**Finding:** production selects native LXF and already warns that complex-model alignment is approximate. [lxf-parser.ts](../web/src/engine/lxf-parser.ts) composes per-part alignment with the LDD bone transform, converts units by ×25, and changes the Y-axis convention. Unmapped design IDs receive identity alignment. That fallback can resolve the right geometry at the wrong origin.

**Existing work:** [viewer.ts](../web/src/viewer/ldraw/viewer.ts), `setExplodeFactor()`, derives exploded positions from saved assembled matrices. `load()` rebuilds the model; the UI resets the slider/label to zero after loading. These mechanisms exist and should be tested before prescribing another reset patch.

- [ ] At explode zero, compare representative instance matrices with parsed placements and saved assembled matrices. Sample foundation bricks, stacked plates, rotated/SNOT parts and tower modules. Determine whether displacement already exists before rendering.
- [ ] Measure LXF alignment coverage by **placement count and unique design ID**. List fallback IDs and their affected locations; inspect non-identity alignments as well as missing entries.
- [ ] Compare a few known neighboring parts against a trusted reference. Check matrix ordering, alignment direction, rotated translation, units, nested assemblies and source workspace layout. Uniform radial displacement implicates explode state; recurring offsets by part family implicate alignment. These are diagnostic patterns, not conclusions.
- [ ] Compare both indexed sources with explicit source selection. Preserve warnings and do not promote the `conv: 1` alternative merely because it loads.
- [ ] Test explode `0 → 100 → 0`, load another set then return, switch source, switch layer/step, and load during an in-progress request. Verify matrices, displayed slider value, edges, picking and exported assembled geometry agree.

**Acceptance:** Hogwarts walls, plates, towers and foundation meet at intended connections at zero explode; source-specific defects are resolved or clearly documented. Returning to zero restores the original assembled matrices within numerical tolerance. A known-good reference and fixed camera comparisons substantiate the result.

## P1 — Prevent recurrence and make failures diagnosable

### 3. Stop silently degrading LXF alignment

**Confirmed code gap:** `loadPartMap()` converts HTTP/network/JSON errors into `{}` and retains the promise. A transient failure can therefore leave every LXF load in that page session using identity alignment. Unknown design IDs also fall back without a structured coverage report. The successful live table fetch does not remove this failure path.

- [ ] Validate the alignment-table schema and numeric values; distinguish unavailable table from individual unsupported IDs.
- [ ] Retry transient failures without permanently caching an empty result. Give the user a useful failure/retry state when the entire alignment resource is unavailable.
- [ ] Return diagnostics with parsed bricks: mapped/unmapped placements, invalid/skipped transforms, unsupported multi-bone parts, table version and source identity.
- [ ] Add integration coverage for a failed fetch followed by recovery, malformed JSON, a partially covered real fixture, and fresh versus warm sessions. Existing [lxf-alignment.test.ts](../test/lxf-alignment.test.ts) verifies pure transform math; that does not validate production table coverage or loading behavior.

### 4. Rank sources by verified assembly quality

**Gap:** [lego-sources.ts](../web/src/engine/lego-sources.ts), `indexedTryOrder()`, mostly follows index order and avoids a flagged first entry when an unflagged option exists. It does not rank measured attachment quality. [source-quality.ts](../web/src/engine/source-quality.ts) uses provenance/header rules and defaults unknown headers to `good`; this is not geometric validation.

- [x] Add source hash, converter/alignment version, geometry coverage, verification date, and assembly status (`verified`, `unverified`, `known defective`) to model metadata. — **Done 2026-09-09** (index schema 2, clego `a7748c9b`). Per-entry `asm`/`sev`/`defects` are geograde's measured PASS/DEFECTIVE verdict for THAT FILE, `lineage` is the file's own `0 !LINEAGE <tool> <good|partial>` stamp, `hash` is sha256/12 of the bytes; the index root carries the scoreboard timestamp + thresholds as the verification date. 9,614 of 20,274 entries graded (6,353 verified / 3,256 defective); **2,749 grades were DROPPED as stale** because the file was re-emitted after grading — an ungraded entry reports `unverified`, never a clean bill. Geometry *coverage* is not included: geograde measures defects and inventory retention, not resolved-geometry coverage, and inventing a number for it would be worse than omitting it.
- [x] Prefer a verified assembled source over an unverified conversion when equivalent variants exist. Retain manual access and precise caveats for imperfect sources. — **Done** (`lego-sources.ts` `verifiedPromotion`). Guarded so it stays a refinement: the incumbent must be graded *defective* (an unverified incumbent is never demoted — absence of a grade is not evidence), the candidate must be graded PASS, not conv-flagged, in the same-or-better provenance class, retain ≥95 % of the incumbent's placements and not grade worse on severity. Measured: 145 of 10,092 sets change auto-pick, none across a class boundary; the unguarded "first verified wins" rule moved 360 sets and promoted a vision reconstruction over a conversion 34 times. Every entry stays selectable in the picker with its caveats.
- [x] Distinguish intended source from the source that actually succeeded after fallback. Display the loaded source and a concise reason for any fallback. — **Done** (`lego.ts` `loadDiag` / `loadedSourceBadge` / `fallbackNote`). The badge shows the source that actually rendered, marked `⚠ fallback` when it is not the intended pick, with the full trail in its tooltip; the render status carries a one-line reason, and a measured-defect note when the loaded file is graded defective.
- [x] Expose a compact diagnostic download containing source URL/hash, app version, mapping version, missing/substituted parts, warnings, and render state. Reproduction should not depend on guessing from a set number. — **Done** (`ui/lego-diagnostics.ts` + the `⤓ diagnostics` link under the status). One caveat travels in the bundle's own `notes`: `app.version` is vite's build DATE, not a commit, and the `.dat` cache revision is still `null` because `parts.ts`'s `IDB_VERSION_KEY` is module-private (see item 6).

### 5. Treat connectivity verification as a heuristic

**Confirmed limitation:** [connectivity-audit.ts](../web/src/viewer/ldraw/connectivity-audit.ts) samples surfaces into a voxel grid and joins shared/adjacent cells. Its comments acknowledge false detachment for clips, bars, pins and microscale/SNOT assemblies, specifically including 71043. Proximity tolerance can also join surfaces across a small real gap. A single component is therefore not proof of mechanically correct assembly despite stronger wording elsewhere in the file.

- [x] Label results as contact candidates; disclose resolution/tolerance and missing geometry. Separate intentionally detached minifigures/accessories from suspicious parts of the main build. — **Done 2026-09-09.** The control is now "Contact check"; every message it can produce lives in `ui/contact-check-status.ts` and is unit-tested against the claim boundary (the old "✓ Verified: all N pieces form one connected structure" is gone — the strongest honest statement for one component is "no unattached piece found", and the copy says it is not proof of correct assembly). Each verdict discloses the 4 LDU tolerance, attachment-table coverage as a % of the model, pieces with no resolved geometry, and placements that never rendered at all so the audit never saw them. Detached groups are split into `airborne` (nothing within 12 LDU below, >48 LDU above the floor — the suspicious class) and `grounded` (resting on something — minifigures, accessories, stands, second models), using geograde's calibrated thresholds, and the copy states in words that this is a guess from geometry, not intent.
- [x] Add attachment metadata for head/hair, studs/tubes and common clips/pins. Combine this with surface checks and reference images instead of forcing every set into one component. — **Done** (`scripts/gen-attachment-snaps.py` → `viewer/ldraw/attachment-snaps.ts`, 413 parts / 1,116 connectors resolved from the LDCad shadow library). `auditConnectivity` fuses it with the surface pass — the hybrid the snap engine's own conclusion called for and CLAUDE.md recorded as never done. Coverage is deliberately partial (all clip-bearing shadow parts, curated clip/bar plates whose clip lives in a subpart, minifig heads + headgear, bars/pins/axles, small stud families), so the audit REPORTS how many of this model's pieces the table reached rather than implying completeness. Measured live: 10365 → 25 % of pieces covered, 0 extra unions (surface contact already had those joints); 42007 → 54 % covered. Bug found and fixed on the way: `expand_grid` in `scripts/ldcad_connectivity.py` crashed on LDCad's 3-axis grid form and took the whole part's snaps down with it (13 such lines in the shipped library).
- [x] Test true attachment, visible near-gap false positives, rotated contacts, missing geometry and deliberate detached submodels. Existing [connectivity tests](../test/connectivity-audit.test.ts) are useful synthetic checks, not set-level acceptance. — **Done**: 17 cases in `connectivity-audit.test.ts` (+11 copy cases in `contact-check-status.test.ts`), covering each named case plus the hair-displaced-from-head negative. Still synthetic, as the note says — a set-level acceptance fixture is P2's "focused visual fixtures" item, which remains open.

### 6. Version geometry caches with deployed data

**Confirmed design risk:** [parts.ts](../web/src/viewer/ldraw/parts.ts) persists successful part text in IndexedDB under the manually maintained `IDB_VERSION_KEY = 'v1'`. A corrected upstream part can remain stale in an existing browser unless cache identity changes. This is a risk, not a proven cause of either report.

- [ ] Tie cache identity to the deployed library revision; track model, aliases and alignment-map versions alongside it.
- [ ] Test a warm browser after a library correction, not only an incognito session. Ensure dependent assembled geometry is invalidated when child definitions change.
- [ ] Validate model-specific custom parts across sequential loads so reused names cannot leak definitions between models. Existing per-load inline clearing is a useful safeguard to preserve.

## P2 — Quality and deployment checks

- [ ] **Add focused visual fixtures:** 10316 elf close-ups and full model; 71043 foundation, wall/tower joints and full model; one simple official LDraw control; one rotated/SNOT control. Pin source and library hashes, camera, lighting, full-layer state and explode zero. Use targeted gap/transform assertions plus reviewed images rather than a single subjective score.
- [ ] **Exercise the actual production path:** check model URL, alignment table, recursive part loading, missing geometry and browser errors on deployment. Record app/index/library revisions together. The README still advertises a GitHub Pages demo, while this audit used `craftmatic.click`; document the supported deployment and asset-base expectations.
- [ ] **Keep performance measurable:** record cold/warm load time, request failures, geometry coverage, frame time and memory for these roughly 6,000-part sets, including mobile. Preserve current instancing, caching and stale-load cancellation; investigate regressions with measurements.
- [ ] **Validate exports independently:** GLB/OBJ/STL should preserve assembled transforms even after using explode controls. Minecraft exports should preserve intended contacts at their selected resolution without manufacturing structural bridges in deliberate gaps.
- [ ] **Refresh misleading documentation:** the header in `ldraw-geometry.ts` still says geometry works only in development, despite the production part-serving infrastructure. `scripts/verify-lego-visual.ts` checks coarse voxel counts/dimensions and top-down output on other sets; it is not a direct-render hair/assembly regression test.

## Recommended execution order

1. Capture the two production defects with exact source and affected-part identifiers; establish reference placements.
2. Repair the identified source/alignment/geometry fault and prove it in direct 3D, preserving concurrent repository work.
3. Close silent alignment failure and diagnostic gaps; add the narrowly targeted regressions above.
4. Deploy versioned assets, validate fresh **and existing** browser sessions, then verify exports and performance.

Do not close either reported issue solely because rendering completes, missing-part count reaches zero, the explode slider reads zero, or a connectivity score improves.
