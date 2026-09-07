# PDF placement rearchitecture — development record

Inputs are instruction PDF pixels/text and an optional parts list. Universal CAD geometry, connector metadata and color catalogs are permitted. Independent models are evaluation-only. No runtime VLM is permitted; research outputs remain quarantined and cannot replace better-source production models.

## Accuracy and deployment

No complete reconstruction has yet met the requested 90% exact-placement threshold under this architecture. Small-stage improvements must not be presented as full-model accuracy. The earlier 95.4% extraction claim concerns reader coverage/agreement, not accurate reconstructed models.

The earlier source audit found 2,355 unique base sets for which reconstruction is the only indexed model source (2,639 catalog entries). V8 experiments existed for nine such sets; two were live, neither certified. The production set-filter correction was already deployed. This placement research has not published any model.

## Verified engineering findings

- Native PDF assembly artwork in inspected fixtures is raster image XObjects. Extracting those images avoids whole-page labels and inventory contamination.
- Exploded parts and arrows cannot be scored as assembled silhouettes. Future drawings help, but introduce additional parts and occlusion.
- The camera is asymmetric. Stud ellipses and a stud grid support a deterministic physical projection estimate; its orientation can change between drawings.
- Returning a projected candidate center loses orientation/depth ties. The experiment preserves the actual selected candidate transform.
- Flood-filling synthetic white CAD renders with the PDF background tolerance erased lit white surfaces. Synthetic renders now use exact background equality.
- Surface sampling omitted real mesh extrema for one part; actual triangle extrema now preserve physical camera bounds.
- Candidate-specific bounding-box fitting rewarded wrong assemblies. Fixed camera scale and registered image origins improve the search.
- Pruning between additions in one instruction step can eliminate the correct completed step. The two-addition search retains legal intermediate states before scoring their completions.
- Connector candidate sets were invariant to the tested coordinate gauges and insertion orders. There is no evidence for the suspected upstream candidate-generation bug.
- Reference-file order does not necessarily equal PDF instruction order, particularly for repeated identical parts. Evaluation against the whole independent model is primary; authored prefixes are diagnostics only.

## Saved development trials

All results below concern set 40377 development stages, evaluated post hoc against the independent 90-part OMR model. No reference pose participates in runtime selection.

| Trial | Selected exact poses | Interpretation |
| --- | --- | --- |
| `40377-pair-camera-v1` | 2/2 emitted parts | Correct bootstrap selected first using CAD edges, calibrated camera and arrow constraints. |
| `40377-registered-four-v1` | 3/4 emitted parts | Correct 4/4 alternative retained at rank three. |
| `40377-registered-six-v1` | 4/6 emitted parts | First four now correct; next two plates displaced, not merely rotated. Only 4/90 whole-model coverage. |
| `40377-unknown-six-v1` | 4/6 emitted parts | Ignoring future blue regions alone does not resolve the placement error. |
| `40377-views-six-v1` | 3/6 emitted parts | Color-supported view search regressed; remains an opt-in failed experiment. |
| `40377-exploded-six-v1` | 5/6 emitted parts | Entirely correct 6/6 alternative at rank two; last plate attaches below rather than above. |
| `40377-contacts-six-v1` | 6/6 emitted parts | Arrowhead-to-stud contact evidence selects the correct full opening stage. Only 6/90 whole-model coverage. |
| `40377-group-nine-v1` | 6/9 emitted parts | CPU global color score chooses a sideways group; correct geometry retained at rank eleven. |
| `40377-gpu-nine-v1` | 7/9 raw strict; 9/9 structural | One authoritative ID alias and one verified unprinted yaw symmetry explain the differences. Only 9/90 whole-model coverage. |
| `40377-gpu-eleven-v1` | 7/11 raw strict; 11/11 structural | Two cylinders correctly attached; their quarter-turn yaw symmetry is verified from universal CAD. |
| `40377-gpu-thirteen-v1` | 8/13 raw strict; 13/13 structural | Two-plate group attached through either member; native per-scene camera hypotheses and corrected depth planes. Only 13/90 whole-model coverage. |
| `40377-gpu-seventeen-layers-v3` | 9/17 raw strict; 15/17 structural | Correct 17/17 candidate retained at rank three; one whole two-part group is misplaced in the selected result. |
| `40377-gpu-seventeen-native-edges-v4` | 10/17 raw strict; 17/17 structural | Fixed-native-coordinate color plus visible-edge scoring selects the correct retained assembly from PDF evidence. Only 17/90 whole-model coverage. |

Evidence lives in `output/pdf-placement-beam/` and `output/pdf-placement-diagnosis/`. The six-part run scored 1,265,750 candidate hypotheses. GPU rendering tests recorded eight passing checks, exact repeated GPU scores and agreement with CPU in the tested cases; these are implementation checks, not accuracy evidence.

## Active gaps

1. Look-ahead images contain future colored parts. Their regions and stud detections must be treated as unknown for an incomplete assembly, not as target occupancy.
2. Edge-only camera registration can align known white parts to unrelated blue-wall edges. Color compatibility and visibility must constrain view hypotheses.
3. First instructions can contain a partially assembled group plus a detached duplicate. Fixture 41624 begins with three pieces in two image components; the two-part bootstrap is insufficient.
4. Dark outlines on saturated red parts need color-aware contour extraction. A max-channel diagnostic improved camera detection, but is not yet a general validated reader.
5. Historical PLI assignments on the second fixture contain a pin/tile mismatch and an omitted yellow part. Near-perfect inventory identification cannot be assumed to imply correct per-step matching.
6. General subassemblies, repeated assembly multiplicities, occlusion, flexible parts and full-model certification remain unimplemented or unvalidated.

Further inspection of 40377's two-plate step shows one new plate already attached in the main image and the other detached. The main component is therefore an intermediate five-part state, not the preceding four-part assembly. A direct exploded-step constraint is under development. Evaluation confirmed the correct two-addition path is enumerated and collision-legal; the old score preferred the wrong assembly (0.8231 versus 0.6620), isolating a scoring/evidence failure for this sequence.

The direct exploded-step implementation initially improved selected output to 5/6 exact poses. Its final height ambiguity was a physically legal underside versus topside attachment, not a connector-generation defect. Arrowhead/contact evidence identifies two receiving stud contacts for the correct alternative at 1.90px mean arrowhead error. Integrated contact scoring now selects **6/6 exact poses** in the full opening-stage search. Missing connector evidence abstains rather than declaring a candidate impossible. Batch contact scoring agrees with serial scoring across 198 synthetic/random boundary poses.

The next subassembly exposed loss of embedded colors in the old renderer. An initial claim that 3010pb291 geometry was missing was incorrect: it exists in the local unofficial library, which the first path search missed. The official [3010py3 part definition](https://library.ldraw.org/library/official/parts/3010py3.dat) explicitly identifies BrickLink 3010pb291 in its header. A quarantined universal-part resolver now uses that alias; a new recursive parser preserves inherited and explicit colors and raises on missing CAD. Its 396 triangles retain the yellow/black print. A complete inventory geometry audit found all 32 mapped part IDs available; one unresolved inventory record remains a 4032a/4032b mold ambiguity. The three-part subassembly and its attachment now select the correct geometry.

The inset stud spacing agrees with the earlier camera scale, but its viewing angle differs continuously; the earlier projection plus 24 coordinate-frame rotations cannot represent it. Single-row stud centers plus ellipse covariance now recover an independent camera for each such scene. Complete inset search and rigid-group attachment produce the correct nine-part geometry.

The decisive nine-part scoring fixes are equal weighting of supported base-color regions (so the small white base is not overwhelmed by the blue wall), camera-relative lighting, and actual per-pixel CUDA depth rendering. The old fixed world light changed scores under harmless global coordinate changes. The new renderer passes exact repeated-render and global-rotation/inverse-camera controls. An independent float64 CPU depth-buffer renderer agrees exactly with the GPU native nine-part image and mask: the old centroid painter was hiding printed triangles. Canonical depth-plane coefficients also remove 119 coplanar stress-test discrepancies while retaining a 0.0001 LDU depth separation.

The full GPU nine-part trial evaluated 17,856 views of 744 legal group placements and selects 9/9 structural poses. Raw strict agreement is 7/9; the official 3010pb291/3010py3 alias raises it to 8/9, and the known unprinted rectangular-part yaw symmetry raises it to 9/9. Universal CAD vertex sets are exactly invariant under 180-degree yaw for 3010 and 3710; their 90-degree rotations are not equivalent. Printed-part yaw is never relaxed. These are separate metrics, not hidden substitutions.

New trials save source snapshots and start/end hashes to disclose code changes during execution. Research code remains separate from protected upstream files and production model data.

The deterministic remaining-page inventory in `output/pdf-placement-vector/remaining-roadmap-v2/` finds 76 allocated pieces across page indices 7–32, 13 pages with more than two additions, five detected inset pages and 21 main scenes with camera proposals. These proposals are not camera certification. One additional unresolved callout remains, so the current 89-piece assignment is incomplete. Repeated inset groups and unfinished groups spanning pages require an explicit assembly graph; the stage-specific development runs are not yet an autonomous whole-PDF pipeline.

Blanket removal of red pixels corrupts the later printed bowtie and red parts in another fixture. The conservative arrow helper preserves both tested bowtie images and all tested red-part pixels while identifying five early red arrows and three green arrows. It returns uncertain blobs and failure reasons rather than treating every saturated region as an arrow. These are bounded controls, not population validation.

The beam CLI accepts an optional `--parts-list PATH` with JSON records such as `[{"part":"3001","color":4,"qty":2}]`. It records the input hash, merges repeated inventory rows and rejects pose/step fields. With no supplied list, it extracts the PDF inventory. This permits the user's optional inventory input without admitting reference model placements.

## Repeated groups and automatic continuation

The page-index-7 pair is now built from automatic PDF allocations and a unique native “2x” label inside its panel. Full colored-triangle comparison (not just vertex sets) reduces twenty saved group hypotheses to three distinct geometries. Proper global coordinate changes, face ordering and triangle ordering do not change the key; altered surfaces, relative placement, IDs and colors remain distinct.

An exhaustive two-copy attachment attempt exposed a scaling problem: 979 independently base-attached legal placements produce 478,731 unordered pairs per camera. It was interrupted with an explicit record before producing a selection. Two opt-in screening methods score complete pairs before native rendering, rather than greedily pruning after the first copy. The surface-sample method screens 478,731 pairs in 5.59 seconds in its saved single-view benchmark. The cached GPU depth-layer method screens 444,869 span-compatible pairs in 2.85 seconds using about 195 MB GPU memory. It preserves full-canvas false-positive penalties and explicit coplanar layer order. Both finite shortlists can miss the best full-resolution candidate; these timings are not placement-accuracy measurements. The completed layer trial retained the correct seventeen-part assembly, initially at rank three.

Color-only scoring preferred a quarter-turned, offset two-part group because approximate neutral shading obscures the gray/white distinction. Visible depth/normal edges expose the incorrect side-stud arrangement. An explicit edge-weight ablation selected the correct retained assembly at every tested nonzero weight. The runtime reranker uses equal color/edge weight and compares edges at fixed native image coordinates, without separately resizing candidate silhouettes. It selects the fully correct 17/17 structural assembly before independent evaluation. The 3023→3023b rename is supported by the universal part's history header; its exact full-triangle half-turn symmetry and unchanged coordinate bounds are recorded separately. This is not complete-model accuracy.

`placement_continue.py` dispatches supported singleton and repeated exploded-pair pages from a PDF-derived checkpoint, preserving PDF image identity and stopping on unresolved callouts or unsupported structures. It does not yet implement whole-PDF startup, arbitrary subassemblies, cross-page state or global backtracking. A separate layout graph recognizes numbered inset substeps and a cross-page incoming shaft, but geometric attachment still must validate those proposals.

Contained overlapping XObjects caused false multiple-main-scene ambiguity on page indices 7, 9 and 10. Correcting PDF-edge versus OpenCV-pixel-center alignment yields 93.6–94.5% blurred pixel agreement and 98.0–99.7% foreground coverage for the corresponding fragments. The detector retains changed artwork and spatially separate views in synthetic controls. This is a bounded layout/pixel hypothesis, not proof that every overlapping PDF image may be discarded.

## Inventory omission versus mold uncertainty

The missing page-index-13 callout was caused by dropping an inventory record whose element ID maps to both 4032a and 4032b. `global_pdf_slot_assignment.py` assigns callouts to PDF inventory slots, preserving one capacity for that record and both possible mold IDs. The saved 40377 slot trial assigns all 55 callouts / 90 pieces, leaving 89 unambiguous identity instances and one explicit mold ambiguity. The recovered round-plate callout matches its PDF inventory icon at 0.970806 frozen-encoder similarity. All 54 previously assigned callouts retain their previous IDs, colors and quantities.

This fixes the omitted-piece accounting in the new slot experiment; it does not resolve the mold or prove identity accuracy. The legacy placement allocation interface still takes one ID per callout and does not consume this new variant-bearing file. Tests ensure two mold alternatives do not double capacity and a quantity group cannot be split or forced into insufficient inventory. No reference model or VLM participates.
