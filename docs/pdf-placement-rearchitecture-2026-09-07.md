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
| `40377-gpu-eighteen-material-screen-v2` | 11/18 raw strict; 18/18 structural | Actual visible CAD material labels replace shaded-RGB classification. Cached single-group screening preserves the exhaustive selection. |
| `40377-automatic-to26-v1/page-009/placement` | 13/22 raw strict; 16/22 canonical; 22/22 structural | Automatic PDF allocation, pair construction, quantity and joint attachment. Only 22/90 full-model coverage. |
| `40377-automatic-to26-v1/page-010/placement` | 15/26 raw strict; 20/26 canonical; 26/26 structural | Second automatically dispatched repeated pair. Two distinct internal group geometries and 24,513 detailed views scored in 383.67 seconds. Only 26/90 full-model coverage. |

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

New continuation runs write atomic journals and support explicit `--resume`. Reuse requires unchanged PDF, allocation, base model/manifest, run configuration and completed model/results hashes; only a contiguous completed prefix can be skipped. Failed page directories are preserved and retries use distinct attempt directories. Legacy journals without those hashes are rejected rather than silently trusted. Completed checkpoints record their own source snapshots; resumed runs may contain explicitly recorded different code versions.

Contained overlapping XObjects caused false multiple-main-scene ambiguity on page indices 7, 9 and 10. Correcting PDF-edge versus OpenCV-pixel-center alignment yields 93.6–94.5% blurred pixel agreement and 98.0–99.7% foreground coverage for the corresponding fragments. The detector retains changed artwork and spatially separate views in synthetic controls. This is a bounded layout/pixel hypothesis, not proof that every overlapping PDF image may be discarded.

## Material scoring and continuation checks

Shading caused 3,477 of 6,070 visible white CAD pixels in a controlled render to be classified as gray. The optional material scorer obtains labels from actual visible triangle materials, sharing one depth/owner buffer with edge rendering. Its pastel-aware target classifier also recovers the later pink brick. Seventeen-part material IoU improves from 0.4909 to 0.8788; this is an image metric, not placement accuracy. Selected structural placements remain correct in separate 9-, 11-, 13-, 17- and 18-part checks. The automatic next step reaches 22/22 structural placements. Reports are saved in `output/pdf-placement-diagnosis/`, including `material-regression-summary.json` and `40377-automatic-page009-alias-poses.json`.

Single-group cached screening now uses an explicit empty second layer, scores complete candidates, and preserves the exhaustive eighteen-part selection. Three native/synthetic controls check its index convention, color classification and score agreement. The ordinary placement unit suite passes 59 tests. Optional visible part-instance seams distinguish real coplanar brick joints from triangle boundaries and preserve the accepted seventeen-part selection across all twenty retained candidates; this experiment remains separate from the default scorer.

The numbered page-index-11 inset now independently selects all six group placements correctly. Page-index-13 construction retains both 4032 mold branches: all four poses/identities agree for the 4032a branch, while the 4032b branch differs in one mold identity. Runtime retains both alternatives; evaluation does not choose the branch. Mixed six-bracket placement, connecting these groups to the full assembly, cross-page continuation and global backtracking remain open.

## Inventory omission versus mold uncertainty (slot trial)

The missing page-index-13 callout was caused by dropping an inventory record whose element ID maps to both 4032a and 4032b. `global_pdf_slot_assignment.py` assigns callouts to PDF inventory slots, preserving one capacity for that record and both possible mold IDs. The saved 40377 slot trial assigns all 55 callouts / 90 pieces, leaving 89 unambiguous identity instances and one explicit mold ambiguity. The recovered round-plate callout matches its PDF inventory icon at 0.970806 frozen-encoder similarity. All 54 previously assigned callouts retain their previous IDs, colors and quantities.

This fixes the omitted-piece accounting in the new slot experiment; it does not resolve the mold or prove identity accuracy. The legacy placement allocation interface still takes one ID per callout and does not consume this new variant-bearing file. Tests ensure two mold alternatives do not double capacity and a quantity group cannot be split or forced into insufficient inventory. No reference model or VLM participates.

## Autonomous multi-page driving and the search rewrite

The page-11 rigid-group attachment that was running at the previous checkpoint
completed. Independent evaluation of its 32 emitted parts records 32/32
structural, 21/32 canonical-alias and 15/32 raw-strict poses, so whole-model
coverage moved from 26/90 to **32/90**. That is coverage, not model accuracy.

Four generic components replace the stage-specific development runs.

`placement_origin_refine.py` uses silhouette containment. The already-placed
body is opaque, so at the true registration none of its rendered pixels may lie
outside the artwork's dilated foreground. An explicit integer offset window
recovers the quantized template origin, and orientations that cannot contain the
body at any offset are rejected with their measured overflow. On page index 12
this converts a registration rejected for 22 overflow pixels into an exact fit
and discards 8 of 12 hypotheses; wrong orientations overflow by about 18,000
pixels, so the test discriminates strongly. Containment is necessary, never
sufficient. Because a body that already contains a misplaced part legitimately
protrudes, the gate also accepts overflow up to a stated fraction of the body's
own area, and can fall back to the least-overflowing views explicitly flagged
uncontained. The occupancy screen inside the search allows exactly the overflow
its view measured; without that the fallback was rejected one stage later and
the page died with `no_models`.

`placement_multi_shape_batch.py` and `placement_multi_shape_search.py`
generalize the single-shape registry to a page holding several distinct CAD
shapes in several colours, with cross-shape closure, collision and witnessed
support, and a per (part, colour) quota. Seven of the remaining 40377 pages
need this.

`placement_page_camera.py` selects a page's main drawings from the existing PDF
scene evidence and emits row/robust/multirow camera proposals for any page.
Every non-panel drawing is returned as a candidate, ordered by drawn area,
because layout alone cannot rank a subassembly against the body. An exploded
piece is a separate image component whose studs are not the body's studs, so
the largest component's own camera is offered before the whole-drawing camera.

`placement_autodrive.py` chains camera, registration, containment refinement,
registry and search across a page scope, writing an atomic journal with
hash-verified resume, and reusing the previous page's camera matrices when a
drawing exposes no stud row.

### The search was the defect, and it was measurable

Two evaluation-only diagnostics distinguish failures that look identical in the
output. `placement_diagnose_bank_recall.py` asks whether the enumerated pose
bank contains the reference poses at all; `placement_diagnose_target_score.py`
scores the reference-equivalent assembly with the runtime scorer at the runtime
registration, respecting the page's own quota. On page index 12 the bank holds
exactly the six poses the page needs (five light bluish grey, one tan) and the
reference-equivalent assembly scored 0.8250 against the selected 0.8139:
**search failure, not scoring failure**. Page index 15 gave the same verdict.

The exact-cardinality depth-first search does not scale past about three
additions. On page index 12, with 1,382 registered placements, it exhausted its
100,000-node budget and reached zero complete assemblies on its two
best-registered views, emitting 33/38 structural poses.

`placement_layer_beam.py` replaces the traversal. States expand only through
base anchors and witnessed support edges, which loses no structurally legal set
because every connected set containing an anchor has such an insertion order.
Ranking uses the exact depth composite: a candidate can only change pixels it
paints, so its effect on the per-class correct and false counts is four filtered
bincounts over (segment, class) cells - 81 ms for a 4,000-candidate bank, and a
test pins the deltas against a rebuilt composite. A quota-preserving exchange
pass with perturbed restarts leaves the local optimum greedy expansion commits
to. This raised page index 12 to 36/38.

The residual came from an objective mismatch: the search optimised the coarse
composite while selection used the native colour-plus-visible-edge scorer, and
the two disagree. `native_exchange` runs the same quota-preserving exchange
judged by the scorer that actually selects, over the best coarse alternatives
per slot so the render count stays bounded, restarted from several coarse
optima. Page index 12 then reaches **37/38 structural** and its selected native
score is 0.825037871607446 - the exact value the reference equivalent scores,
i.e. the search finds a score-equivalent assembly rather than a worse local
optimum.

### Whole-chain result and where it stops

| Checkpoint | Emitted | Structural | Canonical alias | Raw strict |
| --- | ---: | ---: | ---: | ---: |
| page-11 attachment (start of this work) | 32 | 32 | 21 | 15 |
| page index 12 | 38 | 37 | 26 | 20 |
| page index 15 | 44 | 38 | - | - |
| page index 16 | 45 | 39 | - | - |
| pages 14-32 driven to page index 30 | 82 | 40 | 27 | 21 |

Whole-model coverage therefore moved 26/90 to **40/90 (44.4%)**, with the
page-16 checkpoint the accurate one at 39 correct of 45 emitted. This is not
90%, and the later pages are not accurate: from page index 17 the selected
native score falls from 0.81 to between 0.14 and 0.38, and the 37 parts added
after page 16 contribute one correct pose between them. Emitting them raises
coverage by one and lowers precision from 0.87 to 0.49.

The cause is registration, not search. At page index 17 the body renders at a
visibly different viewpoint and scale from the artwork (body-only native score
0.29, visible-edge score 0.14) and containment cannot be satisfied at any
offset - best overflow 569 pixels. Fitting the camera to the body's own image
component rather than the whole drawing was tried and did not recover the page.
Until a page's camera is right, everything downstream of it is decoration.

### Structural evaluation was itself wrong

The structural score used a hand-written symmetry list that omitted the
four-fold yaw of a square 4x4 plate, so page index 16's 3031 was counted wrong
while sitting at exactly the reference position with a rotation differing by a
quarter turn. `placement_part_symmetry_table.py` now derives each part's local
group from the saved universal-CAD proofs instead: `vertex` level for parts
whose rotated CAD occupies the same surface, `triangle` level when the full
colored triangle set also maps onto itself, identity only for printed moulds,
and each proof re-validated against the current geometry files on load. Proofs
are recorded for all 34 parts of this set; the legacy hand-listed number is
still reported beside the new one (39 versus 40 on the same model).

### Identity branches instead of dropped pages

`placement_slot_branches.py` emits one ordinary allocation directory per
combination of an ambiguous inventory identity, so a page is no longer dropped
whole because one element maps to two moulds. Page index 13 of 40377 produced
its two 4032a/4032b branches this way. Post hoc, the existing 4032a group
construction is internally 4/4 correct and the 4032b branch 3/4; runtime keeps
both, and evaluation does not choose.

### Result after cross-page attachment: 46/90

Attaching the page-13 subassembly on page index 14 does not only add its own
four parts; it repairs the body the later pages register against. Driving pages
15 onward from that 42-part checkpoint gives:

| Checkpoint | Emitted | Structural | Precision |
| --- | ---: | ---: | ---: |
| page index 12 | 38 | 37 | 0.974 |
| page index 14 (subassembly attached) | 42 | 41 | 0.976 |
| page index 15 | 48 | 45 | 0.938 |
| **page index 16** | **49** | **46** | **0.939** |
| page index 17 | 51 | 46 | 0.902 |
| page index 18 | 52 | 46 | 0.885 |
| page index 19 | 58 | 46 | 0.793 |

Whole-model coverage is therefore **46/90 (51.1%)** at the page-16 checkpoint,
up from 26/90 when this work began, and every part emitted after page 16 is
wrong. The same pages driven without the subassembly reached only 39 correct at
page 16, so the four-part attachment is worth six additional correct poses
downstream — a wrong body registers worse, and a worse registration places
worse.

### Page index 17 is a third, distinct failure

Its three plausible causes were separated by measurement rather than argument.

* Camera. A development-only visual check (remote VLM, verification only, never
  a pipeline input) compared the artwork against our render at the selected
  registration and reported the same viewpoint and the same apparent scale.
  The camera is not the defect.
* Target contamination. The page draws one plate already attached and an
  identical one exploded above it. Those detached pixels can never be explained
  by an incomplete body, so they depress the score and drag the registration.
  Restricting the target to the body's own image component raised the selected
  native score from 0.1631 to 0.3325 and changed no pose.
* Candidate generation. The bank recall diagnostic finds only one of the two
  reference 60474 poses in the enumerated bank. Raising the bounded closure from
  64 to 1,024 parents and 8,192 to 24,000 poses — 277 seconds of enumeration,
  budget still exhausted — did not produce the second. The stacked plate is not
  reachable through the current connector closure at all, which is a
  candidate-generation gap, distinct from both search and registration.

That is now the binding constraint, and it is a different problem from the one
the search rewrite solved.

### Open gaps, unchanged or newly measured

1. The stacked second 60474 on page index 17 is not reachable through the
   bounded connector closure at any budget tried, and the pages after it place
   nothing correctly. Candidate generation, not search or camera, is the
   binding constraint on 40377 now.
2. Page index 20's drawings are all small part views with no body view, so the
   page cannot be registered against the assembly at all.
3. Cross-page attachment now works end to end on this fixture. Page index 13
   builds a separate four-piece stack and page index 14, which adds no callout,
   attaches it: 9,984 legal group placements, 49,152 scored views, giving 42
   emitted parts at 41 structural, 28 canonical-alias and 22 raw-strict, i.e.
   41/90 coverage at precision 0.976. That is a better model than the 82-part
   chain at 40/90 and precision 0.488, because it stops before the page-17
   registration wall rather than emitting parts through it. Pages 21 and 32 need
   the same treatment, and multi-body state inside the driver, which would
   schedule it without a hand-issued command, is still absent.
4. Page index 13 is a separate subassembly built from nothing, not an addition
   to the main body. Multi-body state is still absent from the driver.
5. The second fixture 41624 has a complete 109/109 slot assignment but three
   unmapped identities on pages 3 and 15, which breaks any contiguous drive; its
   existing three-piece bootstrap is 2/3 structural.
6. Repeated multiplicities, occlusion, flexible parts, global backtracking and
   whole-PDF autonomous startup remain unimplemented, as before.

## Round two: generation, the camera, identity and the body table

### The candidate-generation gap was a budget spent in the wrong order

The bounded connector closure expands only `max_closure_parents` of the
base-attached poses, and it visited them in connector-enumeration order, which
carries no information about the page. On page index 17 the parent whose child
is the stacked second `60474` is bank index **3927 of 4147**, so no budget below
that index could reach it however large the pose cap was — which is exactly why
raising 64 to 1,024 parents and 8,192 to 24,000 poses changed nothing. The
relative mate itself was never missing: a lone `60474` offers the stacked
`t = (0, -8, 0)` mount in all four yaws.

`ShapeRegistry` now separates enumeration from expansion and accepts an explicit
parent permutation, so ordering can add correct children and can never make an
illegal one legal. `placement_evidence_closure` derives that order from the
page's own refined registration:

* silhouette overflow, and ink inside the drawing that the placed body does not
  already explain — this alone moved the correct parent to rank 1,662, because
  the correct plate is 84% occluded by the body drawn around it, so novelty is
  weak precisely where it is needed;
* `placement_arrow_parent`, which assigns the page's accepted arrowheads to each
  candidate pose's own receiving stud caps. An instruction arrow points at the
  connector that receives the next piece, so when that connector belongs to a
  piece the same page adds, the arrowheads name the parent outright. Page 17's
  two red arrows give the correct parent a 14.4 px residual against a 145.5 px
  median, and rank **39** on the best view.

Shapes are ranked separately and interleaved, because bank order groups every
pose of one shape before the next and a parent budget could be consumed entirely
by the first shape. Per-view *ranks* are merged rather than pixel residuals,
which are not comparable across camera hypotheses; that costs a little (rank 70
instead of 39) and is the honest combination.

How far the arrow channel reaches is worth stating plainly: on 40377 the
conservative arrow classifier accepts at least one arrowhead in the largest
drawing of **7 of the 26 instruction pages** (indices 13, 17, 22, 27, 28, 29,
30). That is the booklet's layout rather than the classifier's conservatism:
pages 15, 16, 18 and 19 show their new piece in the top-left inset panel and
draw it already installed on the assembly, so there is no arrow to find. The
channel is decisive where it exists and silent elsewhere, where silhouette
novelty and containment carry the ordering on their own. It is not a universal
parent selector.

Measured on page index 17: bank recall goes from **1/2 to 2/2** reference poses
with a *smaller* bank, 14,357 poses against 24,000. The recall diagnostic also
stopped using a hand-written symmetry list — which had no entry for `60474` at
all — in favour of the derived universal-CAD proof table; it still reports 1/2
for the old bank, so the gain is generation, not a looser equivalence.

### Page 17 was a mis-scaled camera, and the previous verdict was wrong

Fixing recall did not fix the page: all 28 retained candidates still scored 46
of 51 emitted, and the target-score diagnostic returned *scoring failure* — the
reference-equivalent assembly scored 0.151 against the selected 0.320. But an
absolute 0.15 for a correct assembly is not a scoring failure, it is a bad
registration, and the previous round's conclusion that "the camera is not the
defect" rested on a development-only VLM eyeballing the viewpoint.

Measuring instead: the stud-row camera returns **29.1-30.1 pixels per stud on
page 17 where pages 15 and 16 both return 33.8-34.1**. The body duly renders a
175x276 silhouette against a 199x318 drawing — the same 13% — containment fails
at every offset in the window, the refiner falls back to the least-overflowing
view, and the search fills the 43-pixel band left over on the right with a
misplaced plate. That band is visible in the selected render.

Consecutive instruction pages draw the same assembly at the same size, so the
previous page's measured scale is a PDF-derived proposal of exactly the kind the
driver already makes when a drawing exposes no stud row at all. Each page's own
orientations are now also offered rescaled to that prior, as extra hypotheses
that registration and containment still have to choose, and the accepted
registration's scale becomes the next page's prior.

`placement_origin_refine` also gained an opt-in scale ladder judged by target
coverage among contained registrations, since containment alone cannot compare
scales — a render that is too small is trivially contained. Reported honestly: on
page 17 that ladder selects 0.90/0.95, the wrong direction, because a tight
overflow allowance rejects the correct larger scale before coverage is ever
consulted. It is off by default and the cross-page prior is the mechanism that
works.

### The driver holds a body table, and page kinds are measured

Three of 40377's pages are not additions to one body, and each previously failed
as something else: page index 20 draws two small part views and a numbered
substep and reported `camera_unsupported`; page index 14 allocates nothing and
attaches page 13's four-piece stack but reported `no_allocation`; page index 21
finishes page 20's subassembly and attaches it.

The discriminator is physical: a drawing that shows the current assembly cannot
be much smaller than that assembly's own rendered silhouette. Measured on 40377,
the largest non-panel drawing per page is

| body views | 12 | 14 | 15 | 16 | 17 | 18 | 19 | 21 | 22 | 32 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| pixels | 40k | 42k | 50k | 52k | 66k | 56k | 56k | 57k | 60k | 83k |

against **18k on page 13 and 8k on page 20**, with a body that renders 42k.
`placement_page_kind` turns that into four kinds; where no camera exists to
render the body — exactly the case on a subassembly page — the last page that
did draw the body supplies the reference, which is still PDF-only because an
assembly only grows.

Verified end to end on 40377 pages 13 to 14: the driver measures that page 14
draws the body (42,432 pixels against a 40,090 body silhouette, threshold
24,054) while allocating nothing, finds the page-13 stack pending, and runs the
attachment itself - 9,984 legal group placements, 49,152 scored views, 42
emitted parts at 41 structural, 28 canonical-alias and 22 raw-strict, precision
0.976. Those are round one's numbers to the part; what changed is that no human
issued the command.

That run then completed pages 15 to 19 in the same invocation: 48/45, 49/46,
51/46, 52/46, 58/46. So the 46/90 checkpoint - and the wrong tail after it - is
reproduced end to end with no hand-issued step in the middle, matching the
hand-assembled round-one chain row for row. The driver neither gains nor loses
by scheduling the attachment itself. The subassembly's *construction* is still
supplied to it; the scheduling, the choice of page to attach on, and everything
downstream are not.

Also verified on pages 19-21: page 19 places, page 20 reports `subassembly_page`
carrying its measurement (8,136 against a 41,733 body and a 25,039 threshold)
instead of a camera failure, and page 21 reports that it would attach were a
subassembly pending. The driver now carries that pending body and runs
`placement_attach_group` itself on the page the booklet points at. Construction
of a body from nothing is still not implemented, so a construction is supplied
per page with `--group-run` and the run stops with an explicit record when one is
not; what moved into the driver is the scheduling that previously needed a
hand-issued command.

### 41624's identity blocker: catalog proposes, the icon confirms

Two inventory elements of 41624 are in no universal catalog the reader consults:
`4121715` (page index 3, one piece) and `6046979` (page index 15, two pieces).
`placement_catalog_factor_bridge` already learns the two namespace relations
from the 41,549 element IDs both catalogs resolve unambiguously, and it
correctly refuses to collapse the colour relation: Rebrickable colour 0 was
co-observed against LDraw 0 in 3,443 elements and against seven other codes in
11. It therefore proposes one part and eight or sixteen colours, which is not an
identity, and the slot adapter refuses the page.

The evidence that settles it is set-specific and already in hand: the element's
own inventory icon is drawn in the part's colour. `placement_element_bridge`
compares each candidate's LDraw RGB against the icon's **modal** foreground
colour with an explicit separation margin, and confirms nothing when the part
itself is disputed. The mode is load-bearing — instruction icons are a flat base
colour with darker shading and a dark outline, so the foreground *mean* of a
white part lands on grey, and the first attempt duly resolved white `99206` to
Light Bluish Grey.

Measured: `6046979` to LDraw 15 at distance 11.5 against 108.3 for the nearest
rival, `4121715` to LDraw 0 at 17.4 against 158.7. Both agree with the universal
CAD headers — `2780.dat` is "Technic Pin with Friction and Slots", `99206.dat`
is "Plate 2 x 2 x 0.667 with Two Studs On Side and Two Raised" — and with the
icons, which draw a black Technic pin and a white two-studs-on-side plate. The
slot assignment's unmapped identity count goes from 3 to 0, and the whole
inventory now carries one identity per piece. As a control, the slot adapter
refuses page index 3 outright on the pre-bridge assignment and produces a
19-piece page 3-8 allocation on the bridged one.

### Page 17 unpicked, one defect at a time

Page index 17 turned out to hold four independent defects. Each was isolated by
measurement, and fixing one only exposed the next, so they are reported as a
sequence rather than as a single result. Every run below starts from the same
page-15 checkpoint and differs only in what is switched on.

| What is fixed | p17 bank recall | p17 registration | p17 native score | p17 emitted / structural |
| --- | --- | --- | ---: | --- |
| round one | 1 of 2 at 24,000 poses | fallback, 541 px outside, 68% covered | 0.331 | 51 / 46 |
| + evidence-ordered closure | **2 of 2 at 8,192 poses** | fallback, 541 px outside, 68% covered | 0.332 | 51 / 46 |
| + carried camera matrix | 2 of 2 | **contained, 2 px outside, 97.8% covered** | **0.570** | 51 / 46 |
| + channel-spread neutrality | 2 of 2 | contained, 2 px outside, 97.8% covered | 0.544 | 51 / 46 |

Read down the columns rather than across the last one. Candidate generation is
fixed: the correct pose is now in the bank at a *smaller* budget than the one
that failed. The camera is fixed: the body registers with two pixels of overflow
where it previously could not be contained at all. And the scorer's treatment of
black is fixed, which changes the failure completely even though the structural
count does not move.

That last row is the one worth stating carefully, because a count of 46 hides
what happened. Before the colour fix the search put the two black plates at
reference-frame heights of -4 and -8 LDU, which is buried in the base of the
model - hiding them scored better than placing them. After it, one plate sits at
(10, -168, -10) against a reference (0, -168, 0), on the correct surface and
within 14 LDU, and the second at (-20, -112, 44). The selected assembly now
renders 10,051 class-0 pixels where it rendered 307. The margin by which the
wrong assembly wins fell from 0.0129 (0.5699 against 0.5570) to 0.0033 (0.5442
against 0.5409). None of that earns a structural match, which requires one LDU.

The colour fix must not be sold as an accuracy gain, because it is not one yet.
It is a correctness fix with an unambiguous argument - LDraw black is a neutral,
and drawn black now classifies as one - and its mechanism is measured. Its
effect on placement so far is mixed: it improves the page-17 failure mode
without changing the count, and on 41624 pages 3 to 5 it *costs* one structural
match, 2 correct of 13 emitted against 3 of 13 without it. Across the two
fixtures the measured accuracy change is neutral to slightly negative. It stays
in because a classifier that cannot see a black brick will keep producing the
page-17 failure elsewhere, not because it raised a number.

### The whole-chain numbers

Driving pages 15 to 19 from the page-14 checkpoint with evidence-ordered closure
at the *round-one* budget - 128 parents and 8,192 poses, against round one's 64
and 8,192 - reproduces round one exactly:

| Checkpoint | Emitted | Structural | Precision |
| --- | ---: | ---: | ---: |
| page index 15 | 48 | 45 | 0.938 |
| **page index 16** | **49** | **46** | **0.939** |
| page index 17 | 51 | 46 | 0.902 |
| page index 18 | 52 | 46 | 0.885 |
| page index 19 | 58 | 46 | 0.793 |

Re-running pages 16 to 19 with everything switched on - evidence-ordered
closure, carried camera matrices and channel-spread neutrality - gives the same
four rows: 49/46, 51/46, 52/46, 58/46.

So whole-model coverage stands where round one left it, at **46/90 (51.1%)** at
the page-16 checkpoint. Fixing recall did not raise it, and neither did fixing
the camera or the colour classifier. **Round two's reading of why - a sub-stud
pose difference the scorer cannot resolve - was wrong**, and is corrected below.
The emitted-but-wrong tail
did not retract either: pages 17 to 19 still emit 12 parts and get none of them
right. What round two can claim is that three of the four reasons for that tail
are now measured and removed, and the fourth is characterised precisely enough
to attack.

### 41624 driven for the first time

With the identity blocker gone, 41624 has a page 3-8 allocation of 19 pieces and
can be driven. Its first honest numbers, from its existing three-piece bootstrap
(itself 2 of 3 structural):

| Checkpoint | Emitted | Structural | Precision |
| --- | ---: | ---: | ---: |
| bootstrap (page index 2) | 3 | 2 | 0.667 |
| page index 3 | 6 | 2 | 0.333 |
| page index 4 | 9 | 3 | 0.333 |
| page index 8 | 22 | 3 | 0.136 |

That is **3/109 (2.8%) coverage**, and it is the run *without* the colour
neutrality fix; with it the same six pages emit the same 22 parts at 2
structural, which is the negative result recorded above. The drive works mechanically - six pages, no
unsupported page, every camera contained or explicitly fallen back - and places
almost nothing correctly. Page index 3 is only drivable at all because of the
camera prescan: its drawing exposes no stud row, and as the first page of the
scope it had no predecessor to borrow from, so it previously died and took the
three pieces the identity work had just recovered with it. Borrowing page 4's
camera registers it at 0.642.

The fixture's problem is now its start, not its identity: three of the first six
parts are wrong, and every later page registers against that. 40377 already
showed what this costs - attaching the page-13 subassembly was worth six extra
correct poses downstream purely by repairing the body. Whole-PDF startup, which
would build that first body properly, remains the unimplemented gap it was.

### Open gaps after round two

The round-one list above is superseded. Items 1, 2 and 5 of it are closed and
are replaced by what is now binding.

1. **The target of an exploded page does not contain the piece being added.**
   Round two concluded that page index 17's residual was a sub-stud pose
   difference the scorer could not resolve. That was wrong. The page draws one
   black plate placed and an identical one exploded above it under two arrows,
   so the body component shows a *one*-plate assembly, and scoring a complete
   two-plate candidate against it rewards leaving the second plate out. Measured
   at the run's own registration and mask: body only 0.5954, body plus the lower
   plate 0.5679, body plus both 0.5409. Every added plate lowers the score
   monotonically, so completeness itself is penalised - no amount of pose
   resolution can win against that target. This was found and fixed by
   `64224c0`, which also caught that
   `placement_diagnose_target_score` had been rebuilding the drawing without the
   run's own mask, comparing two different questions; the offline numbers round
   two reported did apply the run's mask and stand, but the diagnostic's did
   not.
2. **A page's own stud-row camera is not reliable.** An acceptance test, absent
   when round two wrote this, now exists in `placement_camera_gate`. Page index 17 needed its predecessor's matrix (native score 0.595
   against 0.337); pages 18 and 19 rejected it and kept their own, which score
   0.29 and 0.32. Carrying, rescaling, borrowing and retrying are all now
   available and all are *proposals* chosen by a template score that was wrong
   on page 17 and may be wrong when it accepts. A camera acceptance test is
   missing.
3. **Whole-PDF startup is now the binding constraint on 41624, not identity.**
   Its three-piece bootstrap is 2 of 3 structural and every later page registers
   against that. 40377 already measured what a repaired body is worth - six
   extra correct poses downstream from one four-piece attachment - so the first
   body is worth more than any later page.
4. **Subassembly construction from nothing remains unimplemented.** The driver
   now recognises such a page and schedules the attachment, but the construction
   is supplied to it. 40377 pages 13, 20 and 21 need it; page 21 needs it twice,
   since it both finishes page 20's subassembly and attaches it.
5. Repeated multiplicities, occlusion, flexible parts, global backtracking and
   population certification remain untouched.
