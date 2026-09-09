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

## Round three: the target, the budget, the camera test and construction

### What round two called a scorer failure was three separate defects

Round two left "the scorer cannot separate sub-stud pose differences" as the
binding constraint, on the evidence that 40377 page index 17 selected an
assembly beating the reference-equivalent by 0.0033. Taking that apart produced
three findings, none of which is a scorer resolution limit.

**The diagnostic was not measuring the run.** `placement_diagnose_target_score`
rebuilt the page's drawing from the PDF and skipped the run's own mask decision.
Page index 17 restricted its target to the body's image component - 52,177
pixels - while the diagnostic scored the whole 65,869-pixel drawing. The same
selected assembly scores 0.5442 under the run and 0.2865 under the diagnostic,
so the saved verdict compared two different questions. `placement_run_scene` now
rebuilds the run's own target, the driver records `mask_source` in
`results.json`, and both diagnostics use it.

**The target of an exploded page does not contain the piece being added.** Page
index 17 draws one black 4x4 round plate placed and an identical one exploded
above it under two red arrows, so the body component shows a *one*-plate
assembly. Measured at the run's own registration and mask: body alone 0.5954,
body plus the lower plate 0.5679, body plus both 0.5409, and the selected
assembly - one plate misplaced, the other buried in the torso - 0.5442.
Completeness itself is penalised, so no amount of pose resolution can win.
`placement_exploded_page` detects such a piece from the conservative component
graph, an accepted arrow and the component's drawn area against what one
allocated part covers at the page camera. It fires on page index 17 of 40377 and
on no other page of that booklet, and on pages 2 and 8 of 41624, so every other
page keeps its previous behaviour exactly.

**The withheld piece is placed by the arrows, and that channel is exact.** Given
the drawn plate at (30, -152, 0), `placement_exploded_attach` scores every
enumerated pose by `placement_arrow_contacts` insertion evidence and selects the
stacked (30, -160, 0) out of 8,192 poses at 0.51 px mean arrowhead error and
score 1.0, against 0.1244 and 11.34 px for the next distinct translation. That
is the pose the independent model holds; nothing here reads it.

### The correct pose was never in the bank, and the reason was a unit error

Switching the exploded handling on did not move page index 17. Driving pages 16
to 19 with it reproduces round two to the part: 49/46, 51/46, 52/46, 58/46.
`placement_diagnose_coarse_rank`, which rebuilds a page's own bank and reports
where a requested pose sits under the coarse composite and under the native
scorer, found the correct pose absent from the screened bank altogether.

The occupancy screen rejects a placement whose opaque silhouette leaves the
drawn foreground, with an absolute tolerance carried from the *body's* residual
overflow - 2 pixels on that page. Removing the arrows from the target mask
notches it along the drawn plate, so the reference-equivalent plate renders
9,551 pixels of which 19 fall outside, 0.199% of its own area, and it was
discarded before the search could score it; the median candidate on that page
overflows 1,748 pixels. A proportional allowance in the candidate's own units at
0.01 grows the retained set from 1,635 to 2,027 of 8,192 and keeps the correct
pose. With it in the bank, the coarse composite ranks its 2 LDU neighbour first
(0.34132 against 0.34059) and the native scorer that actually selects ranks the
reference pose first (0.56789 against 0.56737), with both inside the retained
top twelve.

### A camera is now accepted, carried or refused, with the reason recorded

`placement_camera_gate` measures two things at the containment-refined
registration. The first is the drawn ink the registered body does not explain,
divided by the largest area the page's own allocated pieces could cover at that
camera - the convex hull of each part's projected universal-CAD vertices,
maximised over the 24 cube orientations, which over-states a real silhouette.
The second is departure from the expected scale.

Raw coverage cannot serve, and that is worth stating because it was the obvious
first choice. Coverage depends on how large the body already is: 40377's good
pages cover 94-98% at 49 parts, while 41624's good pages cover 47-78% at 3-9
parts, because most of what they do not cover is the pieces the page is adding.
A 0.90 coverage threshold accepts 40377 and refuses all of 41624.

Measured across both fixtures, with the outcome of the page that used each
registration:

| fixture | page | px per LDU | unexplained / addable | placed correctly |
| ------- | ---: | ---------: | --------------------: | ---------------- |
| 40377   |   16 |     1.6918 |                 0.223 | 1 of 1           |
| 40377   |   17 |     1.6918 |                 0.053 | camera carried   |
| 40377   |   18 |     1.4791 |                 1.105 | 0 of 1           |
| 40377   |   19 |     1.4831 |                 1.582 | 0 of 6           |
| 41624   |    3 |     1.0753 |                 0.409 | 2 of 3 retained  |
| 41624   |    4 |     1.0753 |                 0.535 | 1 of 3           |
| 41624   |    5 |     1.0196 |                 0.616 | 0 of 4           |
| 41624   |    6 |     0.8723 |                 1.431 | 0 of 2           |
| 41624   |    7 |     0.8723 |                 1.228 | 0 of 3           |
| 41624   |    8 |     0.8723 |                 1.359 | 0 of 4           |

Every page that placed anything correctly is below 0.62; every page whose camera
is measurably wrong is above 1.10. The default sits in that gap. The test is
necessary, never sufficient - 41624 page 5 passes and still places nothing right
- and it refuses a correct camera when the body it renders is itself wrong,
which is the intended conservative failure.

### The drawings measure the scale the body cannot

Every camera proposal the driver made passed through the emitted body, so a
wrong body took the camera down with it. Page index 18 rejected the carried
camera because the body overflows its drawing by 4,007 pixels and covers 88.6%
of it, and the body overflows because it carries page 17's wrong parts; the page
then kept its own stud-row camera, 12.6% small, and page 19 inherited that
scale.

The drawings settle it without the body. Maximising silhouette
intersection-over-union of one drawing against the next over a scale ladder, on
40377: 15 to 16 gives 1.03 at IoU 0.972, 16 to 17 gives 0.99 at 0.976, 17 to 18
gives 1.03 at 0.959, 18 to 19 gives 1.00 at 0.987, and even the non-adjacent 19
to 22 gives 1.02 at 0.894. The booklet is drawn at one scale throughout, and
page 18's drawing is 1.03 times page 17's rather than the 0.87 its own stud rows
imply. `placement_drawing_scale` offers the carried matrices rescaled by that
measured ratio, and the camera gate's expected scale becomes the previous
accepted scale times the ratio. The ratio slightly over-states the camera ratio
because the later drawing also holds the pieces the step adds, so it is a
proposal and a bound, never a calibration.

Reported honestly: the measurements above are offline. The first drive that
would have exercised the channel end to end failed on pages 17 to 19 with an
ordering defect - the block read the page's drawing before the drawing was
loaded, so `drawing` was unbound - and produced no numbers. The defect is fixed;
the channel has no end-to-end result from this round, and the 48/90 checkpoint
above was reached without it.

### A body can be built from a drawing with nothing to register against

The observation that makes a first page ordinary is that the reconstruction's
global frame is free: evaluation aligns whole frames, and
`placement_body_registration` already sweeps all 24 cube rotations of the
camera, which is the same hypothesis set as rotating the assembly. One allocated
piece can therefore be nailed to the identity transform without loss of
generality, and the page becomes an addition of the remaining pieces to a
one-piece body - the pipeline `place_page` already runs, exploded-piece handling
included. `placement_construct_body` tries roots in descending drawn area and
keeps the best complete result by the page's own image score.

On 41624 page index 2, whose drawing shows a 4x4 plate with one 1x2 attached and
a second 1x2 exploded above under two green arrows: the 4x4 plate registers at
0.9214 coverage with 0.249 of the drawing unexplained against what the page can
add, the exploded detector withholds one 1x2, the search places the other, and
the arrows place the withheld one. Three emitted, two structural, in 17 seconds -
the same result as the stage-specific three-piece bootstrap it replaces, reached
generically and with the borrowed camera the prescan supplies. The arrow-placed
plate is the one that lands exactly right: after the free global yaw it sits at
the reference (30, -8, 0) relative to the root, while the image-placed plate is
one stud inboard of (-30, -8, 0).

That one-stud error is a genuine selection failure, and the only one this round
found. Both poses are in the bank and both survive screening; the whole-drawing
scorer prefers the wrong one 0.87677 to 0.87575. Restricting the evidence to the
region the addition changes, and counting colour only where the addition changes
the class the body already renders - a red plate on a red plate changes none, so
colour abstains and the visible-edge chamfer decides - ranks the reference pose
first at 0.7841 against 0.7727. That is `--local-rerank`, and switching it on takes the whole
construction from 2 of 3 to **3 of 3**: the emitted pair is (0, -8, -30) and
(0, -8, 30) relative to the root, which is the reference pair exactly. It stays
off by default all the same - one fixture is not evidence for a default
objective, and 40377 page index 17 does not need it, since under the corrected
exploded target the whole-drawing scorer already ranks the reference pose first
there.

### Round three's whole-chain result

Every run below starts from the same page-15 checkpoint and differs only in what
is switched on. Coverage is against the independent 90-part model and structural
agreement uses the derived universal-CAD symmetry proofs.

| what is on | page | emitted | structural | precision |
| --- | ---: | ---: | ---: | ---: |
| round two, reproduced | 16 | 49 | 46 | 0.939 |
| round two, reproduced | 17 | 51 | 46 | 0.902 |
| round two, reproduced | 18 | 52 | 46 | 0.885 |
| round two, reproduced | 19 | 58 | 46 | 0.793 |
| + exploded target only | 16 | 49 | 46 | 0.939 |
| + exploded target only | 17 | 51 | 46 | 0.902 |
| + exploded target only | 18 | 52 | 46 | 0.885 |
| + exploded target only | 19 | 58 | 46 | 0.793 |
| + candidate overflow budget + camera gate | 16 | 49 | 46 | 0.939 |
| **+ candidate overflow budget + camera gate** | **17** | **51** | **48** | **0.941** |
| + candidate overflow budget + camera gate | 18 | camera refused | - | - |
| + candidate overflow budget + camera gate | 19 | 57 | 48 | 0.842 |

The exploded target alone reproduces round two to the part, which is what
pointed at the occupancy screen. With both, page index 17 places the drawn plate
at (30, -152, 0) - the pose the diagnostic predicted it would select, at the
score it predicted, 0.5679 - and the arrows place the stacked one at
(30, -160, 0) with 0.51 px of arrowhead error. Whole-model coverage moves
**46/90 to 48/90 (53.3%)** and precision recovers from 0.902 to 0.941. The
accurate checkpoint is page index 17.

Page index 18 is refused rather than driven: its registration leaves 1.05 times
more drawn ink unexplained than the page can possibly add, and its scale is
12.6% below the previous accepted page. Round two emitted a part there and got
it wrong.

Page index 19 is the honest counter-example, and it is worth reporting in full.
The gate did its job: it rejected the page's own 1.5346 camera - 9.3% off the
previous accepted scale, 1.32 times more unexplained ink than the page can add -
and accepted the carried 1.6918 matrix, which covers 93.4% of the drawing at
0.380. That is the choice round two's template score got wrong. The registration
duly improves, from a selected score of 0.3809 to 0.4748. And the page still
places none of its six pieces correctly, so precision falls from 0.941 to 0.842.

Two things follow. The camera test is necessary and not sufficient, as stated.
And refusing page 18 is not free: the body now lacks the plate that page adds,
page 19's drawing shows it, and the pieces page 19 attaches sit on it. Stopping
error propagation by refusal substitutes a missing-part gap for a wrong-part
one, which the next page still has to register against.

On 41624 the constructor plus the local rerank take the opening from 2 of 3 to
3 of 3, which is the first page of that fixture placed exactly right.

### Strategy: what the per-page drive can and cannot reach

The round's checkpoint condition was reached - 48 of 90 is not 55 - so this
records the measured case rather than continuing to drive.

**The reachable page scope caps the number far below the target.** 40377's 90
parts are allocated as 32 on pages 7-11 (the existing base), 6 on page 12, 4 on
13, 6 on 15, 1 on 16, 2 on 17, 1 on 18 and 6 on 19 - 58 through page index 19 -
and exactly 32 on pages 20 to 32. A *perfect* drive through page 19 is therefore
58 of 90, 64%. No improvement to pages 12-19 can reach 90%; pages 20-32 have to
work.

**Selection is not what is missing.** Evaluating every retained candidate rather
than the selected one on the round-two chain: page 16 selected 46 of 49 and the
best retained is also 46; page 17 selected 46 and the best retained is 47; page
18 selected 46 and the best retained is 47; page 19 selected 46 and the best
retained is 46. Re-ranking, backtracking over retained alternatives, or a better
selection objective is worth at most one pose per page. Every gain this round
came from what enters the bank - the target the page is scored against, and the
budget a candidate is screened with.

**What propagates failure is registering against the emitted body.** Page index
18 rejected the carried camera because the body it renders overflows the drawing
by 4,007 pixels and covers 88.6% of it, and the body overflows because it
carries page 17's wrong parts. Its own camera, 12.6% small, then wins on
template score, and every later page inherits that scale. One wrong page does
not cost its own pieces; it costs every page after it. The same mechanism run
forwards is why attaching the page-13 subassembly was worth six extra correct
poses downstream in round one.

**Recommendation, in order.**

1. *Register a page against the previous page's drawing, not against the emitted
   body.* Consecutive drawings differ only by the pieces the step adds, and
   `placement_drawing_scale` already measures the similarity between them from
   PDF pixels alone - 0.99 to 1.03 with IoU 0.89 to 0.99 across 40377, including
   a non-adjacent pair. This round wired that measurement in as an extra camera
   hypothesis and as the gate's expected scale; the deeper version replaces
   body-template registration with drawing-to-drawing registration entirely, so
   the emitted body supplies geometry for scoring and collision only and can no
   longer destroy the camera. It is directly testable: page 18's registration
   either becomes contained under image-to-image alignment or it does not.
2. *Then extend the scope to pages 20-32.* Eight of those thirteen pages expose
   their own stud-row camera (21, 22, 23, 24, 25, 28, 31, 32) and five do not
   (20, 26, 27, 29, 30) and can borrow one by prescan, so camera availability is
   not the blocker; they have never been driven from a body worth registering
   against. Page 20 is a subassembly page and page 21 both finishes and attaches
   it, which the new constructor and the driver's body table now cover between
   them.
3. *Keep the camera gate refusing.* A refused page emits nothing, which is worth
   more than a page that emits six wrong poses.

The alternative the checkpoint names - solving pages independently and
reconciling globally - is not available in its literal form, because a page's
drawing shows the whole accumulated assembly and cannot be solved without
knowing where the earlier pieces went. The useful independence is exactly the
registration independence in (1).

### Open gaps after round three

1. **Pages 20-32 of 40377 are untouched and hold 32 of its 90 parts.** Nothing
   above reaches 90% without them.
2. **Registration still passes through the emitted body**, which is the measured
   mechanism by which one wrong page costs every later one.
3. **The local rerank is measured on one page of one fixture.** It is the only
   selection-side gain found this round (41624's opening, 2 of 3 to 3 of 3) and
   it is off by default until it is measured on more than that.
4. **Repeated multiplicities, occlusion, flexible parts, global backtracking and
   population certification** remain untouched, as after rounds one and two.

## Round four: registering against the drawings, and what pages 20-32 actually are

### Round three's in-flight runs, absorbed

Two of round three's runs were still executing at its checkpoint. Both completed
and neither changes its 48/90 figure, but the gated one adds a measurement that
reframes the whole tail.

| run | page | emitted | structural | precision | selected native score |
| --- | ---: | ---: | ---: | ---: | ---: |
| exploded target only, gate off | 16 | 49 | 46 | 0.939 | 0.6372 |
| exploded target only, gate off | 17 | 51 | 46 | 0.902 | 0.5436 |
| exploded target only, gate off | 18 | 52 | 46 | 0.885 | 0.2936 |
| exploded target only, gate off | 19 | 58 | 46 | 0.793 | 0.3809 |
| **overflow budget + gate** | **17** | **51** | **48** | **0.941** | **0.5679** |
| overflow budget + gate | 18 | camera refused | - | - | - |
| overflow budget + gate | 19 | 57 | 48 | 0.842 | 0.4748 |

The gated run continued past the refusal, so page 19 was driven from the correct
page-17 checkpoint at the *carried* scale of 1.6918 px per LDU rather than its own
1.4791. It emitted six parts and got none of them right, exactly as it did at the
wrong scale. Page 19 is therefore not a camera failure, and the round-three
reading that scale propagation is what breaks the tail does not explain it.

### Page 19 fails because page 18 was refused

`placement_diagnose_bank_recall` on page 19's own bank finds three of its six
reference poses present in the evidence-ordered bank and **none** in bank order at
any budget tried - one round, 128 then 512 parents, 6,191 then 15,881 poses. The
enumeration is not at fault, and the reason is exact and uniform.

All six reference poses sit at z = -56. The nearest pose the enumeration can offer
for each sits at the same x and the same y and **z = -48**: a uniform 8 LDU offset,
one plate thickness, on all six. The surface they mount on is a 4x4 plate the
reference holds at (0, -112, -48), standing on its side, and that plate is not in
the body.

Pages 16, 18 and 23 each allocate one white `3031`, and after page 17 the
reference holds three unplaced, at (0, -160, 0) and (0, -112, ±48). Page 16's own
bank contains all three and it took (0, -160, 0). Instruction order is monotone,
so the plate page 19 mounts on is page 18's - the page the camera gate refused.

**Page 18 is worth seven parts, not one.** A refused page emitting nothing is
still better than a page emitting six wrong poses, but the refusal does not stop
at its own piece: it removes the mount every later page needs. That is the same
mechanism round one measured forwards, when attaching the page-13 subassembly was
worth six extra correct poses downstream.

### Drawing-to-drawing registration, and what it measurably changed

`placement_drawing_registration.propagate` composes the previous page's *accepted*
registration with the uniform similarity that aligns the two drawings, which
`placement_drawing_scale.align` already measures from PDF pixels alone:

    p_current = s · p_previous + t        (measured between the two drawings)
    p_previous = M_previous · X + o_previous       (the accepted registration)
    ⇒ M_current = s · M_previous,  o_current = s · o_previous + t

The emitted body takes no part in choosing that camera or that origin. It still
supplies containment, collision and scoring, so this is not a claim that the body
is unnecessary - only that a body carrying a wrong part can no longer decide where
the camera is. Six offline tests pin the arithmetic on synthetic masks, including
refusal when the two drawings are of different viewpoints.

Three corrections came out of driving it, each measured rather than argued.

**The search chooses among views, so the registration a run *uses* is the selected
view's.** Page 16 offered the propagated camera first and the search still picked
the body-template view: native 0.6372 against 0.5511, the same selected pose, and
a bit-identical score to the ungated round-three run. The carried registration now
follows the selected view, so the chain propagates from the camera that was
actually used rather than from the one that happened to be ranked first.

**The drawing ratio over-states the camera ratio**, exactly as
`placement_drawing_scale` warns, because the later drawing also holds the pieces
the step adds. Page 15 to 16 optimises at 1.03 where both pages' own stud rows
agree within 1%. `propagate` now always offers the unit-scale row beside the
best-agreement row. On page 18 that is the difference between failure and success:

| page 18 registration | px per LDU | coverage | outside px | contained |
| --- | ---: | ---: | ---: | --- |
| its own stud rows (round three) | 1.4791 | 0.7541 | 256 | yes, and refused by the gate |
| propagated at the agreement optimum 1.03 | 1.7874 | 0.9925 | 2,491 of 60,219 | no |
| **propagated at unit scale** | **1.7353** | **0.9837** | **564 of 56,740** | **yes** |

The page's own camera explains three quarters of its drawing; the propagated one
explains 98.4% of it and is contained inside the 1% allowance. The camera gate
accepts it, and the search selects it over both body-template alternatives. So the
memo's testable prediction is answered: **page 18's registration does become
contained under image-to-image alignment**, where body-template registration could
not be contained at any offset.

**The camera gate charged all unexplained ink to the current page's own
allocation.** A page the drive skips is drawn on every page after it, so its ink
was being charged to whatever two pieces the later page happens to add, refusing
those pages for a reason unrelated to their cameras. The driver now carries the
allocations of pages it did not place, the gate may attribute ink to them, and an
attachment removes the pages it consumed. Every verdict records the attributable
list.

### What pages 20-32 actually are, measured from the layout

`placement_step_graph` on pages 19-32 of 40377, against the drawn foreground
areas of each page's non-panel images:

| page | allocated | largest drawing | structure |
| ---: | ---: | ---: | --- |
| 20 | 7 | 8,136 | unframed numbered group, substeps in order 168, 162, 164 |
| 21 | 0 | 56,986 | attaches page 20's group (cross-page edge to xref 171) |
| 22-25 | 2, 1, 2, 2 | 59k-62k | ordinary additions |
| 26 | 4 | 60,789 | addition, plus a 32k second drawing and a 2x inset |
| 27-30 | 2, 3, 2, 3 | 63k-70k | ordinary additions |
| 31 | 4 | 24,599 | unframed numbered group, substeps 224 then 228 |
| 32 | 0 | 83,378 | attaches page 31's group (cross-page edge to xref 235) |

So the thirteen pages hold exactly 32 pieces, two of them build separate bodies
and two attach them, and the driver's page-kind test classifies all four
correctly from the drawn areas alone. The two constructions are cumulative in
their own drawings - page 20's substeps 2 and 3 align at scale 1.00 with IoU
0.9334 and containment 1.0, page 31's two at 1.00 and IoU 0.9914 - so the last
substep of each shows the whole subassembly and is a legitimate target for
placing all of its pieces at once.

### A printed round tile had no legal mate at all

Page 20's construction failed at every root and every drawing with `no_models`,
and not for want of closure depth. Its allocation includes two printed round
tiles, `98138pb072`, and the enumeration reports zero base candidates and zero
relative candidates for that part against anything. Measured directly against a
plate host: **twelve legal mates with collision checking off, zero with it on.**
Every mate the part has is rejected as an overlap.

LDCad's convention, quoted in `recon_v8.connectors` itself, puts a female
anti-stud's reference point on the part's bottom face with its axis pointing out;
`3024` declares `[gender=F] [pos=0 8 0]` against a bbox of y in [-4, 8], and
`s/25269s01` declares the same. `98138` has no shadow record of its own or its
subparts, so its female is recovered from the primitive tree instead:
`s/98138s02` references `stud4o` at (0, 4, 0) through diag(1, -1, 1). That puts
the tube at y in [4, 8] correctly, but it puts the *primitive's origin*, and so
the connector's reference point, at the tube's inner end - and a stud mating 4 LDU
inside the tile is driven too deep, which the collision test rightly refuses.

`placement_connector_repair` moves such a record to the other end, under four
conditions that make it a correction rather than a guess: female CYL at the
anti-stud radius and depth, axis parallel to y, reference point off the
maximum-y face, and the opposite end of the same tube on that face at the same x
and z. Over the fixture's parts it repairs exactly the two `98138` variants and
leaves every other one untouched, including the structurally identical `25269`
that already declares the convention. After it, the repaired part yields twelve
collision-legal candidates at exactly the transforms `25269` yields.

The first attempt moved the orientation without the record's explicit `axis`
field, which is what `expand_variants` actually reads, and produced a 16 LDU
discrepancy instead - a reminder that a connector record carries its mating
direction twice. It is installed by seeding `recon_v8.assembly`'s connector
cache, so no upstream file changes and the scope is the parts a run asks for.

### An image objective cannot resolve 4 LDU of depth

Page 18 under the new registration adds its plate at (0, -112, -44) where the
reference holds (0, -112, -48). Bank recall is 2 of 2 and the reference-equivalent
assembly is retained at rank 4, so this is selection. The margin is **0.0012** -
0.488517 against 0.487312 - and the channels disagree about it:

| candidate | colour | visible edge | blended | local class | local edge |
| --- | ---: | ---: | ---: | ---: | ---: |
| selected (0, -112, -44) | 0.259430 | 0.717604 | **0.488517** | 0.090475 | 0.692133 |
| reference (0, -112, -48) | **0.265415** | 0.709210 | 0.487312 | **0.131837** | 0.607061 |

Colour prefers the reference in both objectives, the visible-edge chamfer prefers
the wrong pose in both, and the edge term is the larger. `--local-rerank 0.5`
therefore makes it *worse*, not better: it selects the same candidate and widens
the margin to 0.0172. That is the second measurement against the local rerank as
a general lever, after round three's one success.

A physical measurement looked at first as if it separated them easily - the
reference pose has 2,256 face-adjacent voxel contacts with the body against the
selected pose's 1,949, a 16% margin where the image margin is 0.25%. **That
reading was wrong**, and the section below records what the correct measurement
says instead: the 16% came from counting the additions' *overlapping* voxels'
neighbours, so it measured interpenetration rather than seating, and both
candidates in fact engage twelve connectors. `placement_seated_contact` exists and
is opt-in, but page 18 is outside its scope.

### Page 19 is a three-level chain, and its second hop is unreachable by construction

Fixing page 18 is necessary and not sufficient, and the measurement separates the
two cleanly. Rebuilding page 18's body with its plate relocated to the reference
pose - an evaluation-only body; the provenance guard in
`placement_multi_shape_batch` refused it as a base run, which is the guard working
- and asking what page 19 can then enumerate:

| piece | nearest enumerated pose, emitted body | nearest, reference-mount body |
| --- | ---: | ---: |
| `41740` plate | 4.0 LDU | **0.0 LDU** |
| `2431` tile | 10.0 LDU | 10.0 LDU |
| four `25269` corner rounds | 26.0 LDU each | 26.0 LDU each |

So page 18's plate is demonstrably the mount for the `41740`: with it right, that
pose becomes exactly enumerable. The other five mount on the `41740` rather than
on the plate, and stay where they were until the `41740` is in the body - a second
closure hop.

That hop is not reachable at any budget the current closure admits, and the reason
is structural rather than a tuning question. `ShapeRegistry.close` counts
`max_closure_parents` **globally across rounds** and stops every remaining round
the moment the budget is hit, while round one's frontier is the entire
base-attached set: 3,587 poses on this page. Reaching round two therefore requires
a parent budget larger than the whole base-attached set *and* a pose cap large
enough to hold its children - about 320,000 - which is neither feasible nor usable
by the search. Raising the budget from 128 to 512 duly changed
`closure_rounds_completed` not at all, in either bank or evidence order.

Evidence ordering does not close the gap either, because it is a permutation of
the base-attached poses only and says nothing about round two's frontier. It did
reach 3 of 6 against the wrong body, so the mount, the parent order and the
per-round budget are three separate additive constraints on this one page rather
than one defect seen three times. A per-round budget with an evidence-ordered
second frontier is the implied fix and is not implemented.

### Neither selection lever moved page 18, and one of them was mis-measured

Two candidate levers were tried on page 18's 0.0012 margin and both are recorded
as failures, because a lever that does not move a number should not be described
as if it might.

`--local-rerank 0.5` selects the identical candidate and widens the margin to
0.0172. Its class term prefers the reference (0.131837 against 0.090475) and its
edge term prefers the wrong pose more strongly (0.607061 against 0.692133). That
is the second measurement against the local rerank as a general lever, after
round three's single success on 41624's opening.

`--seated-tolerance 0.01` also selects the same pose, and the reason is worth
stating exactly, because the first reading of it was wrong. Measuring the
candidates physically:

| pose | engaged mates | voxel contacts | voxel overlap |
| --- | ---: | ---: | ---: |
| selected (0, -112, -44) | 12 | 653 | 281 |
| reference (0, -112, -48) | 12 | 645 | 364 |
| a third (0, -132, -48) | 10 | 594 | 303 |

Both candidates engage **twelve** connectors under the exact predicate
`Assembly._consume_coincident` uses. They are two physically valid seatings of the
same plate on different stud rows of the same body, not a seated pose against a
proud one, so no seating measure can separate them - and the voxel-contact column
prefers the wrong one. The first version of the tie-break ranked by that column
and claimed a 16% margin for the reference; that figure counted the additions'
*overlapping* voxels' neighbours as contacts, so it measured interpenetration
rather than seating. Excluding overlap it is 1% the other way. The tie-break stays,
opt-in and off by default and ranked by engaged mates, for the case it does address
- a candidate that leaves its joint proud engages nothing - and page 18 is outside
its scope.

What is left for page 18 is therefore cross-page evidence. Page 19's drawing shows
the same plate from the next accumulated state, and page 19's own six pieces only
fit on one of the two candidates: the run that follows page 18 knows which pose was
right. Using that means either backtracking over page 18's retained alternatives or
solving pages 18 and 19 jointly, and neither is implemented.

### Page 31's construction is limited by its own drawing, not by the search

`placement_construct_body` completes page 31's four-piece build from all three
roots it tries, publishing three distinct group hypotheses for the attachment to
choose between. Post hoc, every one of them is **1 of 4** structurally correct -
and since the root is nailed at the identity transform, that is 0 of 3 beyond it.

That is a data limit rather than a search limit, and the page says so itself: its
two drawings align at scale 1.00 with IoU 0.9914, because the pieces are three
flat black tiles laid on a black 6x6 plate and they barely change the silhouette.
Colour is uniform, the silhouette is nearly invariant, and the visible-edge channel
sees little. A drawing that does not distinguish the alternatives cannot be made to.

### The connector repair unblocks both constructions, and neither is correct

With the repair and a four-round closure at 512 parents - a one-piece root has only
432 to 1,284 base-attached poses, so the global parent budget *does* reach later
rounds there, unlike on a full body - `placement_construct_body` completes both of
40377's subassembly pages from every root it tries: page 20 seven parts from three
roots, page 31 four parts from three roots. Before the repair page 20 returned
`no_models` at every root and every drawing, so one printed round tile with no
legal mate was the whole blocker.

Post hoc, every one of the six results is **1** structurally correct part of its
emitted set. A construction nails one piece at the identity transform, so the
honest reading is 0 of 6 on page 20 and 0 of 3 on page 31. Completion and
correctness are different achievements and only the first was reached.

That decides how the reach drive is run. Attaching a 1-of-7 body on page 21 would
poison the body the nine untested addition pages register against - the mechanism
round one measured in the other direction, when a *correct* four-piece attachment
was worth six extra downstream poses. So the drive runs without `--group-run`:
pages 20, 21, 31 and 32 are recorded skipped, and their 11 allocated pieces are
carried as unexplained-ink credit so the camera gate does not refuse pages 22 to 30
for ink those pages never owed.

### Strategy: what round four fixed, and what it exposed instead

Round three's first recommendation was to register a page against the previous
page's drawing rather than the emitted body, and to treat page 18 as the test.
That is done and it worked on its own terms: page 18 registers at 98.4% coverage
inside the containment allowance where its own stud rows reach 75.4% and round
three could not contain it at any offset, the gate accepts it, and the search
selects the propagated view over both body-template alternatives. Registration is
no longer the binding constraint on pages 12 to 19.

**It did not raise coverage, and the reason is the shape of the problem rather than
any remaining defect in the parts round four touched.** An instruction booklet is a
dependency tree and this pipeline commits irrevocably at each node. Page 18's single
4x4 plate is the root of at least thirteen further parts - page 19's six mount on it
through the `41740`, and page 20's seven attach into the same region on page 21. Its
two candidate poses differ by 4 LDU, both are physically valid seatings engaging
twelve connectors each, and three separate objectives - whole-drawing, local, seated
- rank them within a quarter of one per cent, two of them wrongly. The page does not
contain the information that separates them.

The next page does. Page 19's drawing shows the same plate one step later, and page
19's own six pieces only fit on one of the two candidates. So the measurement points
at a bounded two-page window rather than at a better objective.

**Recommendation, in order.**

1. *Decide page N with page N+1's drawing.* Not general global backtracking - a
   window of one. Page N's retained alternatives are already saved as `beam_*.ldr`,
   there are at most a few dozen, and page N+1's registration is already computed
   without reference to the emitted body. Score each alternative's continuation and
   commit the one the pair prefers. Page 18's 0.0012 margin is decisive evidence
   that one page of look-ahead is worth more than a fourth selection objective.
2. *Rank a later closure round's frontier by the same evidence that ranks the
   first.* The per-round parent budget landed this round and reaches rounds two and
   three; what is missing is choosing what to expand in them. Page 19's five tiles
   are one correct parent - the `41740` pose, already exactly enumerable once page
   18 is right - away from reachable.
3. *Keep the camera gate refusing, and keep charging a skipped page's ink to that
   page.* Both are in. A refused page emitting nothing is still worth more than six
   wrong poses, and the attribution fix is what stops the refusal cascading.
4. *Stop buying selection objectives for sub-stud ties.* Three were measured this
   round and all three fail on page 18. Two of them - the local rerank and the
   seated tie-break - were built and measured in this round specifically to attack
   it. The information is not in the page.

### The drawing chain holds across the whole remaining scope

The propagation's only precondition is that consecutive body-view drawings align.
Measured on every consecutive pair of 40377's body views from page 15 to page 32,
by silhouette intersection-over-union over the scale ladder:

| pair | 15-16 | 16-17 | 17-18 | 18-19 | 19-21 | 21-22 | 22-23 | 23-24 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| scale | 1.03 | 1.01 | 1.00 | 1.00 | 1.00 | 1.01 | 1.00 | 1.00 |
| IoU | 0.972 | 0.779 | 0.794 | 0.987 | 0.972 | 0.908 | 0.923 | 0.983 |

| pair | 24-25 | 25-26 | 26-27 | 27-28 | 28-29 | 29-30 | 30-32 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| scale | 1.00 | 0.99 | 1.00 | 1.06 | 1.00 | 1.00 | 1.11 |
| IoU | 0.927 | 0.847 | 0.955 | 0.821 | 0.987 | 0.951 | 0.838 |

Every pair aligns, IoU 0.779 to 0.987 with a median of 0.927, all well above the
0.60 floor at which the propagation refuses. Two things in the table are worth
naming. The 16-17 and 17-18 pairs fit at 0.78-0.79 with offsets of about 100
pixels in y, because those pages place their drawing differently on the sheet -
which is not a problem for the mechanism, since the offset is exactly what it
measures. And 27-28 fits at 1.06 while 30-32 fits at 1.11, the latter because page
32 draws the model on the stand it has just attached: that is the over-statement
`placement_drawing_scale` warns about, and it is why the unit scale has to be
offered alongside the fitted one rather than instead of it.

### On a small assembly the fitted drawing ratio is badly inflated

The same measurement on 41624's pages 2 to 8, whose assembly grows from three
pieces to nineteen:

| pair | 2-3 | 3-4 | 4-5 | 5-6 | 6-7 | 7-8 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| scale | 1.01 | 1.00 | **1.23** | 1.00 | 1.05 | 1.01 |
| IoU | 0.700 | 0.804 | 0.747 | 0.966 | 0.953 | 0.819 |

Every pair still aligns above the 0.60 floor, so the propagation applies to this
fixture as well. But 4 to 5 fits at **1.23**, because page 5 adds four pieces to a
nine-piece assembly and the fit absorbs that growth. On 40377 the same measure
stays between 0.99 and 1.11, because a step there adds one to six pieces to a
49-part body.

So the over-statement scales with the fraction of the assembly a step adds. That
makes the unit-scale hypothesis *more* load-bearing early in a booklet than late,
and it makes using the fitted ratio on its own actively wrong on a small model -
which is worth stating because the fitted ratio is what round three wired in as
the camera gate's expected scale.

### 41624 moves 3/109 to 5/109, and the gate's own expected scale was the next wall

Driving 41624's pages 3 to 8 from its 3-of-3 opening with drawing-to-drawing
registration, the repair and the gate enforcing:

| page | emitted | structural | precision | selected score | registration |
| ---: | ---: | ---: | ---: | ---: | --- |
| 3 | 6 | 3 | 0.500 | 0.6171 | body template |
| 4 | 9 | **5** | 0.556 | 0.6623 | **drawing to drawing** |
| 5-8 | camera refused | - | - | - | - |

Round three's corresponding rows, from the 2-of-3 opening, were 6/2 and 9/3 at
precision 0.333, then 22/3 at 0.136 by page 8. So this run is **5/109 against
3/109**, precision 0.556 against 0.333, with the four pages that used to emit
thirteen wrong parts refused instead. Part of that gain is the better opening -
round three built the 3-of-3 construction but never drove from it - and the control
that separates the two is the same six pages without drawing-to-drawing
registration, which is queued rather than measured. What is not in doubt is that
page 4 selected the propagated camera and placed two of its three pieces.

Pages 5 to 8 were then refused for exactly one reason, and it was the gate's own
arithmetic rather than the camera. Containment was satisfied, coverage 0.577 to
0.637, unexplained ink 0.199 to 0.392 - all passing - and the camera was
**1.0860 px per LDU on all four pages, the same value the page that placed
correctly used**. What moved was the expectation: round three set it to the
previous accepted scale times the measured drawing ratio, and 4 to 5 fits at 1.23.
The gate refused an unchanged camera for being 19% off an expectation 23% wrong.

`scale_window` makes that criterion an interval - from the previous accepted scale
to that scale times the ratio, widened by the tolerance at both ends - which is what
`placement_drawing_scale` always said the ratio was good for. It collapses to the
old point behaviour when no ratio is supplied, and a refusal now names the window
it fell outside.

### Open gaps after round four

Round three's list is superseded. Its items 1 and 2 are closed - registration no
longer passes through the emitted body, and pages 20-32 are now characterised and
driven rather than untouched - and what replaces them is this.

1. **The pipeline commits a page before the evidence that decides it exists.**
   Page 18's two candidates differ by 4 LDU, are both physically valid seatings,
   and are separated by 0.0012 of image score by three different objectives, two
   of which prefer the wrong one. Page 19's drawing settles it. A bounded one-page
   decision window is the measured requirement; nothing implements it.
2. **Choosing what to expand in a later closure round.** The per-round parent
   budget landed and reaches rounds two and three. The evidence ordering that
   makes round one's budget spend well is a permutation of the base-attached poses
   only, so a later round still expands an arbitrary prefix - which is why page
   19's five tiles stay 10 and 26 LDU from any enumerated pose even with the
   correct mount in the body.
3. **A subassembly construction completes and is wrong.** Both of 40377's are 1
   structurally correct of their emitted set, i.e. 0 beyond the nailed root. Page
   31's is a data limit its own drawings prove - two views at IoU 0.9914 because
   flat black tiles on a black plate barely change the silhouette - and page 20's
   is not yet diagnosed. Until a construction is right, attaching it makes the
   pages after it worse rather than better.
4. **The drawing ratio is only a bound, and how loose a bound depends on the
   model's size.** It reaches 1.23 on a nine-piece assembly against 0.99-1.11 on a
   49-part one. The gate now treats it as an interval; anything else that consumes
   it must too.
5. **Repeated multiplicities, occlusion, flexible parts, whole-PDF autonomous
   startup and population certification** remain untouched, as after rounds one,
   two and three.

### Round four's whole-chain result: 48/90 to 53/90

Pages 16 to 32 driven in one invocation from the page-15 checkpoint, with
drawing-to-drawing registration, the anti-stud repair, the camera gate enforcing
with its scale criterion as a window, and no `--group-run` (both constructions
being 1-of-N, attaching one would poison the pages after it):

| page | status | emitted | structural | precision | coverage | registration |
| ---: | --- | ---: | ---: | ---: | ---: | --- |
| 16 | placed | 49 | 46 | 0.939 | 51.1% | body template |
| 17 | placed | 51 | 48 | 0.941 | 53.3% | body template |
| **18** | placed | 52 | **49** | **0.942** | 54.4% | **drawing to drawing** |
| 19 | placed | 58 | 50 | 0.862 | 55.6% | drawing to drawing |
| 20 | subassembly page | - | - | - | - | - |
| 21 | no allocation (nothing pending) | - | - | - | - | - |
| 22 | camera refused | - | - | - | - | - |
| 23 | placed | 59 | 50 | 0.847 | 55.6% | drawing to drawing |
| 24 | placed | 61 | 50 | 0.820 | 55.6% | drawing to drawing |
| 25 | placed | 63 | 50 | 0.794 | 55.6% | drawing to drawing |
| 26 | camera refused (placed on retry) | 75 | 53 | 0.707 | 58.9% | body template |
| 27 | camera refused (placed on retry) | 77 | 53 | 0.688 | 58.9% | drawing to drawing |
| 28 | placed | 66 | 51 | 0.773 | 56.7% | drawing to drawing |
| 29 | placed | 68 | **53** | 0.779 | **58.9%** | drawing to drawing |
| 30 | placed | 71 | 53 | 0.746 | 58.9% | drawing to drawing |
| 31 | subassembly page | - | - | - | - | - |
| 32 | no allocation (nothing pending) | - | - | - | - | - |

**Whole-model coverage moves 48/90 to 53/90 (58.9%).** Ten of the thirteen pages
20-32 were reached; nine placements after page 19 used the propagated camera.

The gain traces exactly where the measurement predicted. **Page 18 placed its 4x4
plate at (0, -112, -48), the reference pose**, where every earlier run put it 4 LDU
shallow - so the drawing-to-drawing registration that made the page registrable at
all also made its selection right in the full chain. Page 19 then placed one of its
four corner-round tiles at (-30, -142, -56), on that plate: the piece that was 8 LDU
out of reach in every previous run, reachable because the mount finally exists.
Pages 28 and 29 added three more between them.

The honest checkpoints, since coverage and precision move opposite ways: page 18 is
the most accurate at 49 correct of 52 emitted (0.942), page 29 is the highest
coverage at 53 of 68 (0.779), and the run ends at 53 of 77 (0.688). The 19 parts
emitted after page 19 contribute three correct poses between them.

### Where the three refused pages died, measured

Page 22 was refused twice, in the main pass and the retry, and the reason is
precise and worth 116 pixels. Its propagated registrations cover 90.3% and 92.4% of
the drawing; the body-template alternatives cover 76-80%. But the body now carries
page 19's five wrong parts, so the propagated ones overflow the artwork by 669 and
1,199 pixels against a 1% allowance of 553 and 576 - the unit-scale one **misses
containment by 116 pixels out of 55,333**. Containment then keeps only the small
body-template registrations, and the gate correctly refuses those for being 0.6-2.5%
below the scale window.

So the drawing-to-drawing work removed the body from *choosing* the camera, and
containment still passes through the body. A body carrying five wrong parts
protrudes, and the allowance that was calibrated on a nearly-correct body rejects
the correct camera by a fifth of one per cent. The unexplained-ink criterion, by
contrast, passed comfortably at 0.496-0.579 - the attribution fix worked, charging
page 20's seven unplaced pieces where they belonged, with nine pieces attributable
in total.
