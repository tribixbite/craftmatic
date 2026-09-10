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

### Strategy memo, after the whole chain — and a correction to the one above

The checkpoint condition was met: 53 of 90 is not 60, so this records the measured
case rather than continuing to drive. It also corrects the memo written earlier in
this round, which was drafted before the full chain ran.

**The page-18 tie was not an irreducible scorer limit, and saying so was wrong.**
That memo concluded that three objectives fail to separate page 18's two candidates
by more than 0.25%, that the page does not contain the information, and that a
bounded two-page decision window was therefore the requirement. The full chain
falsifies the premise: **the same page, with the same candidates, selected the
reference pose (0, -112, -48).** What differed was the registration it inherited -
reach-v3 built pages 16 and 17 itself under the scale window and the prescan, and
page 18's native score rose from 0.4885 to 0.5357. A 4 LDU tie that flips when the
camera upstream improves is downstream of registration quality, not a resolution
limit of the scorer. The look-ahead window remains the strongest *untried* channel,
and the reach measurement supports it - the `41740` goes from 4 LDU out of reach to
exactly enumerable the moment the mount is right, which is a decisive signal - but
it is a second-order lever now, not the binding one.

**What binds now, measured.**

1. *Containment still passes through the emitted body.* Camera **choice** no longer
   does, which is what this round fixed, but the containment filter does, and page
   22 is the measurement: its propagated registration covers 90.3% of the drawing
   against 76-80% for the body-template alternatives, and is rejected for
   overflowing by 669 pixels against a 553-pixel allowance - **116 pixels of
   55,333**, because the body carries page 19's five wrong parts. The gate then
   correctly refuses the small survivors. One threshold, calibrated on a
   nearly-correct body, costs three pages.
2. *Eleven of the thirty-two parts on pages 20-32 sit behind two subassembly
   constructions that complete and are wrong.* Both are 1 structural of N, which is
   0 beyond the nailed root. Page 31's is a data limit its own drawings prove;
   page 20's is undiagnosed, and two of its seven pieces cannot be scored at all
   because the PDF BOM says `98138pb072` and the model says `98138pz0`.
3. *The pages that were reached place little.* Pages 23-30 emitted 14 parts for 3
   correct. That is better than round three's tail, which emitted 12 for 0, but it
   is not accuracy, and precision falls from 0.942 at page 18 to 0.688 at the end.

**Recommendation, in order.**

1. *Stop judging containment against an absolute fraction of the body's area.*
   Two PDF-derived alternatives, both measurable on the pages already driven.
   Either scale the allowance by how wrong the body is already known to be - the
   previous accepted page's own unexplained-ink share is exactly that number and is
   already computed - or, better, compare a page's registrations by *coverage*
   among those within a relative multiple of the best achievable overflow. Coverage
   cannot be a threshold across pages, as round three proved, but within one page
   and one body it is directly comparable, and on page 22 no coverage-aware rule
   would have preferred a 76% registration over a 90% one.
2. *Make the two constructions right, or leave them out and say so.* They are worth
   11 parts directly and more downstream, since page 21 and page 32 are attachments
   that repair the body every later page registers against. Start by unifying
   `98138pb072` with `98138pz0` in the **evaluation** - it is parked as a candidate
   with its evidence, and until it is settled page 20 cannot score above 5 of 7
   however well it is built.
3. *Aim the later closure rounds.* The per-round parent budget reaches rounds two
   and three; the evidence ordering that makes round one spend well does not apply
   to them. Page 19 placed one of its four corner-round tiles and the other three
   are one correct parent away.
4. *Then the look-ahead window*, as the first memo said, but as the fourth item
   rather than the first.

## Round five: containment inside the page, a settled alias, and what a late page can see

Round four's recommendations were taken in its order. The first is done and
works on its own terms — three refused pages become drivable on the registration
that best explains their drawings — the second removed an impossibility without
making the construction right, and the third turned out to be aimed at the wrong
defect. None of them raised whole-model coverage, and the reason they did not is
the round's actual finding: registration is no longer the constraint anywhere on
40377 pages 16 to 30. Evidence is.

### Containment judged within the page, not against the body

Round four's binding measurement was that camera *choice* no longer passes
through the emitted body but containment still does, and that page index 22 of
40377 paid 116 pixels of 55,333 for it. The absolute allowance is a fraction of
the body's own rendered area, and the quantity it should scale with is how wrong
the body already is, which is not known in advance.

What is knowable, within one page and against one body, is the overflow the
page's own hypotheses achieve. `placement_origin_refine` now also admits a
registration whose overflow **as a fraction of its own rendered area** is within
a multiple of the smallest such fraction any hypothesis on that page reaches.
Normalising by the render's own area is load-bearing rather than cosmetic: a
camera that is simply too small overflows less in absolute pixels and would
otherwise set a floor no correct registration could meet. On page 22 the
body-template survivors overflow 147 to 440 pixels while rendering 42k-48k, and
the propagated registration overflows 669 while rendering 55,333 — 0.317% against
1.209%, where the absolute rule compares 147 against 669 and gets the ordering
backwards.

The rule is self-limiting by construction, and that is measured rather than
asserted. Where any hypothesis is cleanly contained the page's floor is zero, the
relative allowance collapses to the absolute one and nothing changes. Where the
floor itself exceeds `relative_cap` the page has no registration worth comparing
against and the rule is withheld entirely — 40377 page 26's second drawing, whose
best hypothesis overflows by 7.3% of its own area, is refused exactly as before
instead of admitting eleven hypotheses at 7-27%.

`placement_containment_regression` replays both rules over every page a completed
run recorded. Admission and the camera verdict are closed-form in the saved
overflow, occupied and covered pixel counts, so this re-evaluates measurements
rather than re-running anything; what it cannot predict is what the search then
selects, and a drawing whose accepted registration changes has to be driven.

| run | drawings | unchanged | changed |
| --- | ---: | ---: | --- |
| 40377 `r4-reach-v3` | 17 | 14 | p22 refused → propagated at 90.3% coverage; p26 main refused → 89.8%; p26 retry 58.5% body template → 80.6% propagated |
| 41624 `r4-window-v1` | 6 | 6 | none |
| 41624 `r4-draw-c1` | 7 | 7 | none |

Coverage *ordering* is implemented, measured and **not adopted**: ranking retained
registrations by coverage instead of template score changes the first accepted
registration on 10 of the 17 drawings, including pages that place correctly
today. One page's evidence is not a reason to change the default objective on
seven others.

### `98138pb072` is `98138pz0`, on three independent sources

Round four parked this and noted that page index 20 could not score above 5 of 7
until it was settled. It is settled, by evidence of exactly the kind that settled
`3010pb291`/`3010py3` in an earlier round.

* **The universal part's own header.** The current official `98138pz0.dat`
  declares `0 !KEYWORDS Brickheadz, BrickLink 98138pb072, Eye, Rebrickable
  98138pr0060`. `PartLibrary` already consumes that field, so fetching the file
  into the universal-parts cache is the whole change — no resolver code moved.
  Why it was unavailable offline is dateable: the locally installed library is
  the Studio-bundled LDraw release 207, whose copy is `UPDATE 2017-01`, and the
  keywords arrived with `2023-04-21 [Cheenzo] Subfiled pattern for reuse, added
  keywords` in `UPDATE 2023-03`.
* **Studio's own part table.** `StudioPartDefinition2.txt` carries two rows for
  BL item key 153546, both with BL ItemNo `98138pb072` and the identical
  description "Tile, Round 1 x 1 with 2 White Squares Pattern (BrickHeadz
  Standard Eye)", one mapping to `98138pb072.dat` and one to `98138pz0.dat`.
* **The CAD.** Recursive parse of both files: identical bounding boxes to 0.0
  LDU, surface areas within 3 parts per million, 94.2% of distinct vertices
  shared exactly at 0.001 LDU in both directions. The residual 5.8% is the
  official part's `4-4ering` primitive against the Studio file's flat triangles,
  which is why triangle counts are reported rather than asserted equal.

Recorded by `placement_verify_98138_alias`. The evaluation now canonicalises
`98138pb072` to `98138pz0` through the existing alias mechanism, so page 20's two
tiles are scorable.

### Page 20's construction was not a well-posed problem, and the PDF says so

Unparking the alias did not raise page 20's construction: it stays at 1 of 7
structural, i.e. nothing beyond the nailed root. The reason is that its seven
allocated pieces are not one rigid body.

`placement_diagnose_group_connectivity` measures that with the exact predicate
`Assembly._consume_coincident` uses, at the pieces' reference poses: components
of **5, 1 and 1**. The two black round tiles engage zero connectors with any of
the other six or with each other, and sit 31 LDU away on a piece page 19 placed.
Page 31's four pieces come back as one component of 4, so the diagnostic
discriminates rather than always splitting. `placement_construct_body` requires a
complete connected assembly of everything it is given, so no correct result was
*reachable* — which is why 84 retained candidates over three roots topped out at
2 of 7.

The PDF says the same thing without the model, twice.

* **The substep drawings are not all one object.** Page 20's three drawings align
  162 to 164 at scale 1.00 and IoU 0.9334, and 168 to either of them only at
  scale 0.80 and IoU 0.34 — below the 0.60 floor `placement_drawing_registration`
  already refuses at. 168 is the exploded first substep; 162 and 164 are the
  built states. Round four compared only substeps 2 and 3 and read the page as
  cumulative throughout.
* **The final substep contains no ink of the withheld colour.** Classified
  against the page's own allocated colours, xref 164's 8,136 foreground pixels
  are 6,523 bright-light-orange, 509 white and **57 black** — 0.7%, which is
  outline. One 1x1 round tile covers about 510 pixels at that camera. The control
  is page index 21, the attachment page, whose drawing is 31% black because it
  shows those tiles installed on the head beside a black 4x4 round plate.

`placement_undrawn_pieces` turns the second into an opt-in rule: a colour with
less drawn ink than one of its own pieces must cover is not in this drawing, so
those pieces are withheld from the construction and stay outstanding for a later
page. It withholds a whole colour rather than guessing which piece, never
withholds every piece, and refuses when it would leave fewer than two. Its
limitation is occlusion and it is real — a piece drawn but wholly hidden is
indistinguishable from one not drawn — which is why the threshold is a fraction
of a *single* piece's silhouette and why it is off by default. On page 31, whose
four black pieces sit on a black plate, it measures a drawn share of 16 and
withholds nothing.

With the two tiles withheld, page 20's construction is a well-posed five-piece
build and its own image score rises from 0.4543 to 0.6120. **It is still 1 of 5
structural.** `--local-rerank 0.5` reproduces the identical selection at the
identical score. One root retains a 3-of-5 candidate it does not select, so there
is a selection gap there, but the runtime result is 20% and the fix-or-exclude
rule says exclude: `--exclude-construction PAGE=REASON` records that decision in
the journal, keeps the page's pieces outstanding and keeps its ink attributable,
so a deliberate exclusion is distinguishable from an absent construction.

### Pages 23-30 are a visibility failure, not a closure-ordering one

Round four's third recommendation was to aim the later closure rounds at these
pages, on the reading that the per-round parent budget lands but the evidence
ordering does not apply there. Measured, that is not what they are missing.

* **Bank recall, from the run's own registries.** Page 23 holds 1 of 1 reference
  poses, page 28 3 of 3, page 29 2 of 2, page 30 2 of 3. The correct poses are
  already enumerated at round one, so a later closure round is not the gap.
* **Every retained candidate, not just the selected one.** Across pages 23, 24,
  25, 26, 27, 28 and 29 the best retained beats the selected on exactly one page,
  by one pose. Re-ranking is worth at most that, which reproduces round three's
  finding on the earlier pages.
* **The arrow channel, measured rather than quoted.** Accepted arrowheads in each
  page's largest drawing: pages 23, 24, 25 and 26 have none; 27, 28, 29 and 30
  have 3, 1, 2 and 2. So it reaches half the class — and it orders closure
  *parents*, which recall says these pages do not need.

What does explain them is how little of the added piece the drawing shows. Page
23 adds one white 4x4 plate to a 58-part body. Its reference pose paints **899**
drawn pixels; the four top-ranked rivals paint 10,939 to 11,003, because the true
mounting face is turned away and theirs are not. Every channel prefers the
visible rival:

| page 23 candidate | coarse rank | native rank | local rank | painted px | engaged mates | voxel contacts |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| selected | 1 | 1 | 9 | 10,944 | 12 | 697 |
| best local rival | 9 | 5 | 1 | 11,003 | - | - |
| **reference** | **260** | **13 of 16** | **13 of 16** | **899** | **10** | **534** |

The local objective, which restricts the evidence to the region the addition
changes, prefers the wrong pose *more* strongly than the whole-drawing one
(0.2673 against 0.2266), because 899 pixels of an occluded sliver agree with the
drawing worse than a plate-shaped 11,000 do. The seated tie-break prefers it too:
the wrong pose engages twelve connector mates against the reference pose's ten.
This is not a resolution limit and not a tie — it is an evidence shortage of one
order of magnitude.

`placement_diagnose_visibility` then answers the question that decides whether a
look-ahead window could fix it. The same pose, measured against each later page's
own body at that page's own accepted registration, on the round-four chain:

| page | 23 | 24 | 25 | 28 | 29 | 30 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| painted pixels | 899 | 74 | 74 | 74 | 74 | 74 |
| drawn foreground | 58,519 | 59,485 | 61,901 | 66,731 | 67,445 | 70,051 |

The obvious objection is that the piece looks occluded only because the body
occluding it carries wrong parts. `--reference-model` answers it: the
independent model is mapped into reconstruction coordinates through the inverse
of the recall diagnostic's measured alignment, the pose under test is removed,
and the measurement is repeated against that complete, correct assembly. On the
round-five chain, whose body is a part better:

| painted against | page 23 | page 24 | page 25 |
| --- | ---: | ---: | ---: |
| our emitted body (60-63 parts) | 523 | 528 | 528 |
| the complete 89-part reference model | **75** | **76** | **76** |

The piece is *more* hidden inside the finished model than behind our errors, so
the mounting face is turned away at the booklet's viewpoint and repairing the
body cannot reveal it.

The booklet never shows that face again, so **no window over those pages can
decide page 23 by the piece's own silhouette.** Round four's separate argument
for the window — that page 19's six pieces mount on page 18's plate and only fit
one of its two candidates, so the *children's reachability* decides the parent —
is untouched by this and remains the case for building it. The pixel argument for
it is not available on this class.

The class is not uniform, and the counter-case is worth stating because it is the
one place the local objective wins. On page 28 the reference `3710` is coarse and
native rank 1 and is placed correctly, while the reference `61252` is native rank
13 and **local rank 1** at 0.24246, the best local score in the sample. So the
local rerank now has five measurements — +1 on 41624's opening, negative on page
18, neutral on page 20's construction, negative on page 23, positive on page 28 —
and is a lever with a scope rather than a default.

### 41624: the 3 to 5 was the opening, not the registration

Round four reported 41624 moving 3/109 to 5/109 with drawing-to-drawing
registration on, and said the control separating that from the better 3-of-3
opening was queued rather than measured. Measured now, same opening, same code,
`--drawing-registration off`:

| page | control (off) | round four (prefer) |
| ---: | --- | --- |
| 3 | 6 emitted / 3 structural, 0.6171, body template | 6 / 3, 0.6171, body template |
| 4 | 9 / **5**, 0.6511, body template | 9 / **5**, 0.6623, drawing to drawing |
| 5 | 13 / 5, 0.5047 | 13 / 5, 0.5051 |
| 6 | 15 / 5, 0.4684 | 15 / 5, 0.4842 |
| 7 | camera refused | 18 / 5, 0.4670 |
| 8 | camera refused | 22 / 5, 0.4613 |

The fixture reaches **5/109 either way**. The whole of round four's 3 to 5 is the
opening round three built and never drove from; drawing-to-drawing registration
contributed no correct pose here. What it did contribute is pages 7 and 8, which
emit seven more parts and get none right, taking precision from 0.333 to 0.227.
The round-five containment change is separately inert on this fixture — the
replay over both round-four runs' thirteen drawings changes no admission and no
accepted registration, because 41624's pages register cleanly and their overflow
floor is zero.

Driving the fixture's full page scope needs an allocation that covers it, and the
only one that does is superseded on three of its pages. `41624-element-bridge`
spans pages 2 to 39 with 99 pieces, but its page-3 third callout is `2431` (Tile
1 x 4) at icon score 0.523 where the bridged `p2to8` allocation rounds three and
four used assigns element `4121715` to `2780`, "Technic Pin with Friction and
Slots", at 0.967 — and that page's own drawings show a red 1x2 brick with a pin
pushed into it. Pages 6 and 7 differ too. So the full-scope drive's early rows
are not comparable with the table above, and the honest statement about it is
that it drives mechanically through more than a dozen pages and adds no correct
pose after page 4: 31 emitted at 5 structural by page index 12, precision falling
from 0.556 to 0.161.

**That mis-identification was found by the round's own new rule, from PDF pixels
alone.** Run over every driven addition page of both fixtures, `placement_undrawn
_pieces` withholds nothing on all thirteen of 40377's — the smallest drawn share
is 2.139 against a 0.25 threshold — and fires exactly once on 41624, on page
index 3, where the black class's drawn share is **0.061**. A black 1x4 tile would
cover about sixteen times the ink that page has. So the rule has a second use it
was not written for: a consistency check between an allocation's identities and
the drawing's colour classes.

### A latent defect the exclusion test exposed

`--exclude-construction PAGE=REASON` was straightforward to add and did not fire,
which is how a second defect surfaced. The body-area probe that decides whether a
page draws the current assembly renders the body at the previous page's matrix or
at the page's own. A page exposing no stud row with no predecessor in its scope
has neither, so the probe abstained and the kind test fell back to the ordinary
addition path — exactly wrong on a subassembly page, and a subassembly page is
the most likely first page of a scope to expose no rows. The prescan already
measures a neighbour's camera for this case; the probe now borrows it too and the
kind evidence records which camera it used.

Measured: starting a scope at page index 20, that page went from
`camera_refused` after four attempts to register a subassembly drawing against
the main body, to `subassembly` on the measurement it should have made — 8,136
drawn pixels against a 43,667-pixel body silhouette and a 26,200 threshold, on a
camera borrowed from page 21. The main round-five drive is unaffected because it
carries page 19's matrices, so the branch never fired there.

### Round five's whole-chain result: 53/90, unchanged

Pages 16 to 32 driven in one invocation from the same page-15 checkpoint as round
four, differing only by `--containment-multiple 4`:

| page | round four | round five |
| ---: | --- | --- |
| 16 | placed 49 / 46 | placed 49 / 46 |
| 17 | placed 51 / 48 | placed 51 / 48 |
| 18 | placed **52 / 49** (0.942) | placed **52 / 49** (0.942) |
| 19 | placed 58 / 50 | placed 58 / 50 |
| 20 | subassembly page | subassembly page (construction excluded) |
| 21 | no allocation | no allocation |
| 22 | **camera refused, twice** | **placed 60 / 51** |
| 23 | placed 59 / 50 | placed 61 / 51 |
| 24 | placed 61 / 50 | placed 63 / 51 |
| 25 | placed 63 / 50 | placed 65 / 51 |
| 26 | camera refused, placed on retry 75 / 53 | placed 69 / 51 |
| 27 | camera refused, placed on retry 77 / 53 | placed 71 / 51 |
| 28 | placed 66 / 51 | placed 74 / 52 |
| 29 | placed 68 / **53** (0.779) | placed 76 / **53** (0.697) |
| 30 | placed 71 / 53 | placed 79 / 53 (0.671) |
| 31 | subassembly page | subassembly page |
| 32 | no allocation | no allocation |

Round four's rows for pages 26 and 27 come from its retry pass, which ran after
page 30, so its chain is not in page order at the end and round five's is.

**Whole-model coverage is 53/90 (58.9%) in both.** The containment fix did what
it was measured to do — page 22 registers on the propagated camera that covers
90.3% of its drawing, and places one of its two pieces correctly, which is the
only correct pose it adds — and the chain gives it back. Pages 26 and 27, which
round four reached only on a retry, now place in the main pass and place nothing
right either way; the extra wrong parts they and pages 23-25 contribute cost one
pose at page 29, which added two correct poses in round four and one here. Net
zero, and precision at the coverage peak falls from 0.779 to 0.697.

The accurate checkpoint is unchanged and identical to the part: page 18, 49
correct of 52 emitted, 0.942. The 27 parts emitted after page 19 contribute two
correct poses between them.

That is the honest reading of round four's first recommendation. It was right
about the defect — an absolute allowance calibrated on a nearly-correct body was
rejecting the registration that best explains the drawing — and fixing it makes
three refused pages drivable without making them place better, because what
those pages are short of is evidence, not registration.

### Code changed during the run, and what that does and does not mean

The per-page source snapshots disclose it, so it is stated rather than left to be
found: `placement_autodrive.py` was edited while the round-five chain was
executing, and page 16's snapshot hashes differently from page 25's. The
difference is the `construction_excluded` branch, its command-line flag, its
options key and one message string. The branch is unreachable without a flag this
run does not pass, and a running Python process keeps the module it imported, so
the run is behaviourally identical to the code it was launched with. That is what
the snapshots are for; a change that *had* mattered would be visible the same way.

### Open gaps after round five

Round four's list is superseded. Its item 1 is closed — containment no longer
judges a registration against an absolute fraction of the body's area — and its
item 3 is measured rather than open: page 20's construction was never a well-posed
problem and page 31's is a data limit, so both are excluded on stated evidence.
What replaces them is this.

1. **The late pages' correct pose is an order of magnitude less visible than its
   rivals, in the finished model as well as in ours.** 40377 page 23's plate
   paints 899 pixels against 11,000, and 75 against the complete reference
   assembly. Every image objective and the physical seating measure prefer the
   visible rival. This is an evidence shortage, not a scorer defect, and it is
   the reason pages 23-30 place little. Nothing in the drawings of pages 24-30
   revisits that face.
2. **Two of 40377's thirteen late pages hold subassemblies that are excluded
   rather than solved**, worth eleven allocated pieces directly and more
   downstream, since pages 21 and 32 are attachments that would repair the body.
   Page 20's is now well posed at five pieces and still 1 of 5; page 31's is the
   data limit its own two drawings prove at IoU 0.9914.
3. **The allocation is per *step*, not per body.** Page 20's parts strip lists
   seven pieces of which two are installed by the attachment on the next page.
   `placement_undrawn_pieces` detects that case from the drawing's colour classes,
   but the withheld pieces are then placed by nothing: the attachment stage
   attaches a rigid group and cannot also place loose pieces.
4. **The look-ahead window is still unimplemented, and its case is now narrower.**
   The pixel argument for it does not apply to the late pages, because the
   booklet never redraws the face. The reachability argument round four measured
   — page 19's `41740` goes from 4 LDU out of reach to exactly enumerable once
   page 18's plate is right — is untouched and remains the case for it.
5. **Repeated multiplicities, occlusion-aware scoring, flexible parts, global
   backtracking and population certification** remain untouched, as after rounds
   one through four.

### Recommendation, in order

1. *Treat visibility as a first-class quantity in the search, not as an implicit
   weight.* Every objective in the pipeline rewards explained ink, so a candidate
   that paints 11,000 pixels is compared with one that paints 899 as if the two
   were equally evidenced. The measurement to make first is a population one, not
   another objective: across every page of both fixtures, how often is the
   reference pose's painted area an order of magnitude below the selected one's?
   That number decides whether this is the late-page failure or *the* failure.
2. *Get one construction right, on the fixture that can show it.* Page 20's is
   now well posed and its retained set contains a 3-of-5 candidate its scorer
   does not select, which is a concrete, bounded selection question on a
   five-piece body — unlike every late-page tie, whose information is missing
   rather than mis-weighted.
3. *Place the withheld pieces.* A colour the construction's drawing does not show
   is placed by the attachment page instead, which currently attaches a rigid
   group and nothing else. Two of 40377's ninety parts sit behind this.
4. *Keep the look-ahead window, for reachability rather than for pixels.* Round
   four's measurement stands; round five's says not to expect it to fix pages
   23-30.
5. *Do not buy another selection objective.* The local rerank now has five
   measurements across two fixtures — one clear gain, two clear losses, one
   neutral, one gain — and the seated tie-break has two losses. Both are levers
   with scopes, not defaults.

## Round six: what the whole population is actually blocked by

Round five ended by recommending a population measurement before another
objective, on the grounds that one page's 899-against-11,000 might be the
failure or might be *a* failure. It is a failure, and a small one. Measured
across every reference part both fixtures fail to place, visibility accounts for
**5 of 63 in-scope parts**. Candidate generation accounts for 26.

### The table, and how each class is decided

`placement_population_table` assigns every reference part the final assembly does
not place correctly to exactly one primary class. It reads the run's own
journal, each page's own registry and each page's own accepted camera; the
reference model supplies the targets, the alignment and the poses measured, all
strictly after the run.

* `out_of_scope` — no page of the run allocates it. Nothing the run does could
  place it.
* `allocation_blocked` — a page allocates it and that page was never driven: a
  subassembly construction the driver refuses, a page with no allocation.
* `unreachable` — a driven page allocates it and the reference pose is **absent
  from that page's enumerated bank**, so no scorer could have selected it. The
  bank test is `placement_diagnose_bank_recall`'s, with saved universal-CAD
  symmetry proofs.
* `visibility_limited` — the pose is in the bank but paints under 200 px, or
  under a quarter of the page's own selected addition, **against the body the run
  actually scored it on**. That is the quantity the objective saw.
* `mis_selected` — in the bank, painting a competitive area, still not selected.

| class | 40377 pages 16-32 | 41624 pages 3-8 | total | share of in-scope |
| --- | ---: | ---: | ---: | ---: |
| `unreachable` | 8 | 18 | **26** | 41.3% |
| `mis_selected` | 12 | 10 | **22** | 34.9% |
| `allocation_blocked` | 10 | 0 | 10 | 15.9% |
| `visibility_limited` | 4 | 1 | **5** | 7.9% |
| in-scope failures | 34 | 29 | 63 | |
| `out_of_scope` | 3 | 75 | 78 | — |
| correct | 53/90 | 5/109 | | |

41624's 75 out-of-scope parts are the 101 pages the six-page drive never
reaches; they are excluded from every share above rather than counted as
failures of anything measured here.

### Two controls, one of which fails and says so

**Correctly-placed control.** Nine reference instances 40377 *did* place
correctly paint 874 to 14,133 px against their own page body (median 9,332), and
678 to 4,861 against the complete reference model. Every part in the
`visibility_limited` class paints 0 to 979. The class separates, on this fixture.

**Complete-reference control, and where it is inapplicable.** Round five's
measurement — is the piece hidden by the viewpoint or only by our own wrong
parts? — needs the finished model to be a fair stand-in for the body. On 41624
pages 3-8 it is not: the two parts the run places *correctly* paint **0** pixels
against the complete 109-part reference at those pages' cameras, because a
six-to-twenty-two-part body's camera buries every addition under the whole
finished model. The tool reports `complete_reference_control: applicable=false`
rather than quoting the number, and classification uses the body the run scored
against. On 40377 pages 16-30, where the body is 49 to 79 of 90 parts, the
control is applicable and round five's page-23 figures reproduce exactly: 523 px
against our body, 75 against the complete reference, rival 619.

### What this says about round five's reading

Round five's page-23 measurement is confirmed and its generalisation is not.
Page 23 is one part. The largest class on both fixtures is `unreachable` — the
correct pose was never enumerated — and it is 18 of 29 on 41624, where round four
and five spent their effort on registration and cameras. The second is
`mis_selected`, which is the only class a better objective can convert, and it is
22 parts. Visibility-limited is 5.

The practical consequence for round six's plan: a channel that proposes poses
**outside the enumerated bank** addresses 26 parts; a channel that only re-ranks
what the bank already holds addresses at most 22; a channel aimed specifically at
invisible pieces addresses 5. Mirror completion is worth building for the first
reason, not the third.

### Mirror completion: what it converts, and the count that was inflated

The channel proposes the reflection of an already-placed piece about the model's
own symmetry plane. It needs no drawing evidence about the piece being placed,
which is why it was worth trying against a class the drawings cannot decide.

Three parts, each measured:

* **The mould has to admit the reflection.** `placement_verify_part_mirrors`
  records, for each of the 24 improper octahedral elements, whether a mould's
  universal CAD maps onto itself. If some improper `Q` does, the reflection of a
  placement `(p, R)` by plane reflection `S` is realised by the **proper** frame
  `S R Q`, so the proposal names a buildable pose. 47 of the two fixtures' 54
  moulds admit one; the seven that do not are five printed moulds and the chiral
  43722/43723 wedge pair. The vertex tolerance is 0.01 LDU rather than exact:
  LDraw's curved primitives store polygon vertices rounded to a few decimals and
  that rounding is not itself mirror-symmetric, so 4032a, 3941 and 60474 reflect
  onto themselves to 0.001 LDU and to nothing tighter. Triangle-level invariance
  is never true and would mean nothing if it were, because LDraw splits a quad
  along one diagonal and a diagonal is chiral: 0 of 54 moulds admit one.
* **The plane is detected, never assumed.** Candidate offsets are exactly the
  midpoints implied by pairs of same-mould same-colour placements in that page's
  own base body. On 40377 the detector finds axis 2 at offset 0 on every driven
  page, at agreement 0.850 on page 16 falling to 0.661 on page 30 as the body
  accumulates errors — the agreement is itself a readout of body quality.
* **The proposal is gated physically.** It must not collide and must engage at
  least one connector, by `recon_v8.assembly`'s own predicates.

**The asymmetric control does what it must.** On 41624 the plane is refused on
all six driven pages — agreement 0.000 to 0.333 against a 0.5 floor — and the
channel proposes nothing at all. Zero false positives, by abstention. A guard was
needed to get that: the three-part opening body reached agreement **1.000** on a
meaningless plane, so a plane is now refused below eight mirror-eligible parts.

**The conversion, in distinct parts.** Five admitted proposals on 40377 produce
four hits — but on **two** distinct reference instances. The channel re-proposes
the same missing 87079 tile on pages 22, 24 and 25, because every later page
whose allocation names that identity offers the same opportunity. The denominator
is inflated by the same multiplicity: 37 wrong-target *opportunities* across the
13 pages are **25** distinct wrong parts. So the honest figure is **2 of 25**,
with one false positive, and the earlier per-page reading of "4 of 37" counted
opportunities on both sides of the ratio.

**Where the proposals come from matters more than the plane does.** Across pages
the channel proposes *nothing*: a model's symmetric pair is allocated on the same
page, so when the page runs neither partner is placed. Both conversions come from
a within-page source — the page's own first correctly placed piece, or a piece a
previous page placed correctly and whose partner is still outstanding. And both
targets were already in that page's bank, so on this fixture mirror completion is
a **selection prior**, not the reachability expansion the population table said
was the larger class.

### The mirror channel cannot be turned into a runtime rule, and here is why

Having a ceiling of two parts is not the same as having a rule. Three
formulations were built and measured, and none of them survives.

**Post-hoc replacement.** When a page allocates three copies of a mould and gets
one of them right, runtime cannot tell which one to overwrite. Every strict
determinism gate - one unmatched addition, one admitted proposal - then declines
to fire on exactly the pages where the ceiling exists.

**A tie-break over the retained assemblies**, which is the shape of the existing
local-rerank and seated levers. `placement_mirror_rerank` measures it over every
retained beam of every driven page:

| | pages | selected correct | mirror-reranked | best retained |
| --- | ---: | ---: | ---: | ---: |
| 40377 pages 16-30 | 13 | 8 | 8 | 10 |

**Not one retained assembly on any page contains a single mirror-consistent
addition.** The tie-break has nothing to reorder, and the reason is visible on
page 22: its two correct 87079 tiles sit at the same z, stacked at y = -76 and
-116, so they are not each other's reflection. The tile that *is* their mirror is
allocated on a later page and never enters a retained assembly there at all -
even though the bank holds its pose. That splits the population table's
`mis_selected` class in two: *retained but not selected*, worth at most the +2
this table shows across thirteen pages, and *enumerated but never retained*,
which no re-ranking can reach.

**Committing a base-sourced proposal before the search.** This is the only
formulation the driver could actually execute, because the base body is the one
thing it holds before searching. The ceiling tool now separates it: of the five
admitted proposals, **three** are derivable from the base alone, and they hit
**one** distinct reference instance and produce **one** false positive. A
coin flip is not a channel.

**Verdict: measured, and not adopted.** Mirror completion is correct where it
fires, abstains cleanly on the asymmetric fixture, and its ceiling on the fixture
built for it is 2 of 25 distinct wrong parts - of which 1 is runtime-reachable,
at 50% precision. The tooling stays because the plane-agreement number is a
useful independent readout of body quality (0.850 at page 16 falling to 0.661 at
page 30, tracking the errors the chain accumulates), but no driver flag is added.

### Inventory-capacity forcing: the premise is false by two orders of magnitude

The proposed rule was: when a page's allocation leaves exactly one piece and the
legal-mate enumeration offers exactly one collision-legal, connector-engaged
region, place it there whatever the drawing shows. `placement_inventory_forcing`
counts the regions.

| fixture | allocated identities | single-piece | distinct one-stud locations (min / median / max) | forced |
| --- | ---: | ---: | ---: | ---: |
| 40377 pages 16-30 | 20 | 13 | 110 / 382 / 669 | **0** |
| 41624 pages 3-8 | 12 | 7 | 64 / 230 / 408 | **0** |

Not one allocated identity on either fixture has as few distinct locations as its
own quota. The rule can never fire, and the gap is not marginal.

Two measurement traps were hit on the way, and both are recorded because either
one alone yields a confident wrong answer:

* **Single-linkage clustering chains through a dense body.** Every candidate
  position is within one stud of some other, so 40377 page 16's 8,192 poses come
  back as **one** region and six of twenty identities read as forced. The count
  above uses occupied cells of a one-stud lattice, which cannot chain; the
  chained number is kept beside it as the control that exposed the artefact.
* **Neither physical filter does what it looks like.** The collision test rejects
  nothing — `legal` equals `bank` on every page of both fixtures, because the
  enumeration already screened it. And "at least one connector engaged with the
  base" is not a valid filter at all: a twelve-pose sample per identity finds
  engagement 0 on nineteen of 40377's twenty identities, because closure also
  enumerates poses that mate with a *sibling addition* rather than with the base.
  This module was written assuming the opposite; the sample refuted it and the
  assumption is recorded rather than quietly used.

### A construction's own symmetry is worth one part, on the one construction available

Round five left 40377 page 20's five-piece head at 1 of 5 with a 3-of-5 candidate
retained and not selected, and called it a selection gap. It is, and there is a
runtime-legal signal for it that comes from neither the drawing nor the reference:
a subassembly is usually bilaterally symmetric about its own plane, so a candidate
that is not says something about itself.

`placement_construction_symmetry` ranks the retained candidates by the plane
agreement each one reaches *on its own parts*:

| plane agreement | candidates | structural score |
| --- | ---: | --- |
| 0.333 (1 of 3 eligible) | 16 | all 1 of 5 |
| 0.667 (2 of 3 eligible) | 20 | eight at 3, eight at 2, four at 1 |

Ranking by agreement first and image score second selects `beam_08` at 2 of 5
instead of `beam_00` at 1 of 5: **+1**, against an oracle of 3. The honest caveat
is the sample: the head has five pieces of which three are mirror-eligible, so the
discrimination is one part wide, which is why the eligible count is printed beside
every fraction.

The control abstains. 41624's three-piece opening construction has **one**
mirror-eligible part, the plane test declines on every candidate, and the ranking
returns the same selection it was given: delta +0.

### 41624 driven to its full scope: 26 pages, 75 parts, still 5 correct

Round five's full-scope run finished during round six. It drives pages 3 to 39,
places on 26 of them, refuses a camera on 9 (twice, counting the retry pass) and
emits 75 parts.

| checkpoint | page 3 | page 4 | page 8 | page 16 | page 27 | page 39 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| emitted | 6 | 9 | 21 | 40 | 63 | 75 |
| structural | 3 | **5** | 5 | 5 | 5 | **5** |
| precision | 0.500 | 0.556 | 0.238 | 0.125 | 0.079 | **0.067** |

**Every correct pose is placed by page 4.** The 70 parts pages 5 to 39 add
contribute nothing, and precision falls by a factor of eight. Round five's
warning that this run's early rows are not comparable with the `p2to8` runs
stands — it uses the `41624-element-bridge` allocation, whose page-3 third
callout is the disputed `2431` — but the outcome is the same 5/109 either way,
which is now measured on three separate configurations.

The population table on that run is the round's most useful single number:

| class | count | share of the 86 in-scope failures |
| --- | ---: | ---: |
| `unreachable` | **60** | 69.8% |
| `mis_selected` | 13 | 15.1% |
| `allocation_blocked` | 10 | 11.6% |
| `visibility_limited` | 3 | 3.5% |

On the deepest drive either fixture has ever had, **seven of ten failures are a
reference pose the page's own bank never contained**.

### The largest class is a budget, not an evidence limit

`unreachable` — the reference pose is absent from the page's own enumerated bank
— is 8 of 34 in-scope failures on 40377 and **60 of 86** on 41624's full-scope
drive. Rounds one through five treated the bank as given and spent their effort
on cameras, registration, containment and objectives. It is not given.

Every registry of both runs says so in a field nobody had read across pages:

| run | pages | parent budget hit | pose budget hit | closure exhaustive |
| --- | ---: | ---: | ---: | ---: |
| 40377 `r5-contain-v1` | 13 | **13** | 5 | 0 |
| 41624 `r5-full-scope` | 27 | **27** | 10 | 0 |

Not one page of either fixture ever finished its closure. The parent budget of
128 was reached on all 40 of them.

Re-running 40377 page 26 from the identical base body and camera with
`--max-closure-parents 1024 --max-poses 32768`:

| | parents processed | bank poses | budget hit | reference targets in bank |
| --- | ---: | ---: | --- | ---: |
| round five (128) | 128 | 2,090 | parent | **3 of 5** |
| round six (1024) | 808 | 5,889 | none | **5 of 5** |

The closure *finished* at 808 parents, so 1024 is not a new wall but a budget
large enough to stop mattering on this page. Both 3023b poses that the round-five
population table classified `unreachable` were enumerable all along; they were
behind a resource limit set five rounds ago and never revisited. The cost of
lifting it on this page was about a minute of closure.

## The ceiling memo

Round six was told to write this if coverage stayed below 65 of 90 after the
population measurement and the two new channels. It did — 53/90 is unchanged
since round four — so here is the measured ceiling, what would raise it, and
where the program should go.

Two sections written after this memo refine it and are not superseded by it, so
read them together: *The same page, placed* shows that lifting the closure budget
converts `unreachable` into `mis_selected` rather than into correct, which makes
lever 1 below a precondition rather than a fix; and *Where a correct pose is
actually lost* splits `mis_selected` into screen, retention and ranking and puts
numbers on lever 2, which this memo could only name.

### The ceiling is a ladder, and each rung has a named owner

Every rung below is the population table's own class count added to the current
score. Nothing here is an estimate.

| rung | 40377 | 41624 (full scope) | what has to be true |
| --- | ---: | ---: | --- |
| today | **53/90** (58.9%) | **5/109** (4.6%) | — |
| + `mis_selected` | 65/90 (72.2%) | 18/109 (16.5%) | a selector that beats the image objective on poses the bank already holds |
| + `visibility_limited` | 69/90 (76.7%) | 21/109 (19.3%) | a channel that does not need the piece to be visible |
| + `allocation_blocked` | **79/90** (87.8%) | 31/109 (28.4%) | both subassembly constructions solved |
| residual | 11 | 78 | `unreachable` + `out_of_scope` |

**79 of 90 is the ceiling of the current architecture on 40377**, and 31 of 109
on 41624, *if* every enumerated pose were selected perfectly and both
constructions were solved. The gap between the two fixtures is almost entirely
the `unreachable` class: 8 parts against 60.

Two of those rungs are much harder than their count suggests, and the round
measured both:

* Of 40377's 12 `mis_selected`, only **2** are reachable by re-ranking the
  assemblies the search actually retains — `placement_mirror_rerank`'s oracle
  column is 10 against a selected 8 across thirteen pages. The other ten are in
  the bank and in no retained assembly, so they are a *retention* problem
  (occupancy screen, coarse ranking, beam width), not a scoring one.
* The `visibility_limited` rung was round six's brief, and three channels were
  built and measured against it. Mirror completion reaches 2 of 25 distinct wrong
  parts, of which 1 is runtime-reachable at 50% precision. Inventory-capacity
  forcing cannot fire at all — the minimum over both fixtures is 64 distinct
  one-stud locations for a piece whose quota is one. A construction's own
  symmetry is worth +1, on the one construction it applies to. **The rung is
  worth 4 parts on 40377 and the channels available to reach it deliver at most
  1-2 of them.**

### What would actually raise the number, in measured order

**1. Finish the closure.** No page of either fixture has ever completed its
candidate enumeration; the 128-parent budget was hit on all 40 driven pages.
Page 26 at 1024 parents finishes at 808, and its bank recall goes 3/5 to 5/5.
This is the largest class on both fixtures — 8 parts on 40377, **60 on 41624** —
and it is a number in a config, not a missing evidence channel. Everything else
in this memo is smaller.

**2. Fix what the search retains, not how it ranks.** Ten of 40377's twelve
`mis_selected` never reach a retained assembly. Re-ranking is worth +2 and has
now been measured five ways across rounds three, five and six; retention has
never been measured at all.

**3. Solve one construction properly.** 10 parts on each fixture sit behind an
undriven subassembly, and on 40377 pages 21 and 32 are attachments that would
repair the body downstream of it. The construction's own bilateral symmetry is a
real signal there (+1 of 5 on page 20) and it is the only evidence a body built
from nothing has besides its single drawing.

**What would *not* raise it, on this evidence.** More camera angles from inset or
rotated views were the obvious answer to round five's finding. The population
says visibility is 4 parts on 40377 and 3 on 41624 — **7 of 120 in-scope failures
across both fixtures**. Even a perfect new viewpoint channel buys less than the
closure budget does on one page.

### Breadth or depth

**Depth, on this fixture, for one more round — then breadth.**

The case for depth is that the top of the ladder is not yet known to be reachable
and the cheapest rung has not been tried. Rounds five and six each spent
themselves on evidence channels and returned +0 poses between them, because both
picked their target from the last page they had looked at rather than from a
population. The population now exists, it names candidate enumeration as the
largest class on both fixtures, and a one-page experiment already moved that
class. Not testing it on the whole chain would repeat exactly the mistake this
round was written to correct.

The case for breadth after that is stronger than it was. Two fixtures cannot
distinguish "this architecture reaches 79/90 on a BrickHeadz" from "this
architecture reaches 79/90 on a model whose pages add one or two pieces to a body
that is already most of the model". 41624 is the counter-example already in hand
and its ceiling is 31/109 — and the whole difference is enumeration. A third and
fourth fixture would say whether 41624 or 40377 is the outlier, which is the
question that decides whether the program has a method or a fixture.

The concrete recommendation is therefore: re-drive both fixtures' full scopes
with the closure budget raised until no page reports a budget hit, report the
trajectory, and only then choose between deepening retention on 40377 and adding
fixtures. If the raised budget does not move the chain, the ladder above is the
honest ceiling and breadth becomes the only remaining question worth asking.

### The same page, placed: the budget converts one class into another

Page 26 at 1024 parents does not place better. It emits 69 parts at 51 structural
— **exactly round five's row**, from a bank nearly three times the size that now
contains both poses the round-five bank was missing.

So the correct reading of the previous section is narrower than it looked. Lifting
the closure budget moves parts from `unreachable` to `mis_selected`; it does not
move them to correct. On this page the two recovered 3023b poses are enumerated,
and the search still prefers something else — which is the same wall the
`mis_selected` class already describes, reached from the other side.

That does not make the budget finding worthless: a pose that is not enumerated
cannot be selected by any future selector, so the ceiling of every downstream
improvement was 3 of 5 on this page and is now 5 of 5. It does mean the budget is
a **precondition** rather than a fix, and the honest expected value of raising it
alone is small. The whole-chain run measures that rather than assuming it.

### Round five's leftovers, closed

* **Page 20's 3-of-5 retained-but-not-selected candidate.** Addressed, partly:
  ranking the retained candidates by their own bilateral symmetry moves the
  selection from 1 of 5 to 2 of 5 against an oracle of 3, on a discrimination
  three eligible parts wide. It is the only runtime-legal signal found for a body
  that has no parent to register against and only one drawing.
* **The withheld undrawn pieces.** Round five withheld page 20's black colour
  class from its construction because the drawing contains 57 black pixels where
  one such piece must cover about 510, and noted the withheld pieces are then
  placed by nothing. Round six's two new channels cannot place them either, and
  the reason is not a gap: they are the two `98138pb072` BrickHeadz eyes, and a
  printed mould is exactly what mirror completion must abstain on. The abstention
  is doubly evidenced here — the print rule refuses it, and the mould's universal
  CAD is *independently* chiral, its closest octahedral reflection missing by
  1.41 LDU. Forcing cannot fire on them either. They remain outstanding and the
  population table counts them under `allocation_blocked`, with page 20's other
  five pieces.
* **41624's full-scope run.** Absorbed above. Its early rows are indeed not
  comparable with the `p2to8` runs — it uses a different allocation whose page-3
  third callout is disputed — but the fixture reaches 5/109 on all three
  configurations measured, so the non-comparability changes no conclusion.

### Where a correct pose is actually lost

`mis_selected` was three failures wearing one name. `placement_retention_audit`
separates them exactly — a page's occupancy record stores `input_candidates`
equal to its bank size and `retained_indices` as indices into that same bank, so
screen survival is a set membership test rather than a re-derivation — and then
reads the assemblies the run wrote to see which targets any retained assembly
contains.

Counted in **distinct reference instances**, not per-page opportunities:

| stage the pose was lost at | 40377 pages 16-30 | 41624 pages 3-39 | both |
| --- | ---: | ---: | ---: |
| never enumerated | 8 | **60** | **68** |
| rejected by the occupancy screen | 1 | 7 | 8 |
| enumerated, screened, in no retained assembly | **13** | 7 | **20** |
| in a retained assembly, ranked below another | 2 | 2 | **4** |
| selected correctly | 8 | 2 | 10 |
| distinct targets | 32 | 78 | 110 |

The screen row is reported on the view the search selected. Measuring instead
over the union of every scored view — the tool's own stated limitation, made
measurable rather than left as a caveat — changes 40377 not at all (23 targets
survive either way) and moves exactly one part on 41624, from 7 screen losses to
6 and 7 retention losses to 8. The conclusion is unaffected.

**Ranking is 4 of the 100 losses.** Rounds two through six bought and measured
selection objectives — the local rerank five times, the seated tie-break twice,
a mirror-consistency tie-break once — against the smallest stage in the pipeline.
Round five's "do not buy another selection objective" was right for a reason it
did not have.

The two fixtures fail at different stages, which is the strongest argument in this
memo for more fixtures: 40377 is dominated by retention and 41624 by enumeration,
and with two fixtures there is no way to tell which is typical.

The two tools were built independently and reconcile exactly, which is the check
that either of them is counting the right objects. `placement_population_table`'s
`unreachable` equals `placement_retention_audit`'s `lost_before_enumeration` on
both fixtures (8 and 60), and the population's `mis_selected` plus
`visibility_limited` equals the audit's screen plus retention plus ranking on
both (16 = 1 + 13 + 2 on 40377, and 16 = 7 + 7 + 2 on 41624).

### Round six's trajectory: unchanged, and that is the result

| round | 40377 | 41624 | what the round bought |
| ---: | ---: | ---: | --- |
| 1 | 26/90 | — | native scenes, calibrated cameras, CAD geometry |
| 2 | 46/90 | 3/109 | camera, identity, the body table |
| 3 | 46/90 | 3/109 | the target, the budget, construction |
| 4 | 48/90 → 53/90 | 5/109 | drawing-to-drawing registration, per-round closure |
| 5 | 53/90 | 5/109 | containment judged in-page, the 98138 alias |
| **6** | **53/90** | **5/109 (full scope)** | **the population, and three channels not adopted** |

Round six adopted no runtime change, so the chain number is unchanged by
construction. What it produced instead is the measurement that says why rounds
four and five also produced nothing: 96% of the loss is upstream of the objective
those rounds improved, and the class round five identified as the cause is 6% of
it. 41624's number is now measured over its whole 37-page scope rather than six
pages, and it is the same 5.

Two experiments were left running at the end of the round and are **not** included
in any number above.

* A whole-chain 40377 re-drive at `--max-closure-parents 1024`, everything else
  identical to round five, in `40377-r6-parents-chain`. A first attempt also
  raised `--max-poses` to 32768 and was abandoned: page 16's closure had not
  finished after fifty minutes, against about one minute for page 26 at the
  parent budget alone. The pose budget was never the binding one — it was hit on
  5 of 13 pages against the parent budget's 13 of 13 — so raising it buys nothing
  and costs the whole experiment. Isolating the one measured constraint is both
  cheaper and a cleaner test.
* A page-19 re-drive at `--beam 256 --top-k 64`, aimed at the retention stage.
  Page 19 is the extreme case: all six of its reference targets are in the bank
  and all six survive the occupancy screen, and exactly one reaches a retained
  assembly.

Both are far slower per page than the round-five settings, and that cost is
itself a result any adoption has to carry.

### The two budgets interact, and page 16 is the case that shows it

The re-scoped chain's first page reports the experiment's own limit. 40377 page
16 at `--max-closure-parents 1024`, with the pose budget left at round five's
8192, produces a bank of **8,192 poses and a score of 0.6372338224690584** — the
same 49 parts and the identical score to sixteen significant figures as round
five at 128 parents.

The registry says why: page 16 hits *both* budgets in both runs. The closure
fills its 8,192-pose cap before it exhausts even 128 parents, so the extra 896
parents are never reached and the enumeration is byte-identical. Page 26 was the
opposite case — its closure had pose headroom, ran out of parents at 128, and
finished at 808 when allowed to.

So "raise the parent budget" is not a single lever. It is inert on the 5 of 13
pages where the pose cap binds first, and effective on the 8 where it does not.
Raising both together is what the abandoned first attempt did, and its cost was
the experiment itself — page 16's closure had not finished in fifty minutes at
32768 poses. A budget policy that actually works has to be adaptive rather than a
pair of constants, and neither constant has ever been tuned.

### Widening the search does not fix retention

Page 19 is the extreme retention case: all six of its reference targets are in
the bank, all six survive the occupancy screen, and exactly one reaches a
retained assembly. Re-driven from the identical page-18 body at `--beam 256
--top-k 64` against round five's `--beam 96 --top-k 12`:

| | retained assemblies | targets in bank | survive screen | in any retained assembly | selected |
| --- | ---: | ---: | ---: | ---: | ---: |
| round five | 44 | 6 | 6 | 1 | 1 |
| round six, wide | **200** | 6 | 6 | **1** | 1 |

**Four and a half times as many retained assemblies contain exactly the same one
correct pose.** The emitted result is 58 parts at 50 structural with score
0.5245855326837143 — identical to round five to sixteen figures — for 1,017
seconds of search.

So the retention loss is in the *traversal*, not in the output width. A complete
assembly has to place all six allocated pieces at once, and the layer search
prunes by incremental image agreement, so a correct pose that paints little is
dropped early in the traversal whatever the beam and `top_k` are afterwards.
Widening the exit does not help when the candidate never reaches it.

One confound, stated: the single-page scope changes the camera prescan, so this
run's bank is 6,856 poses against round five's 7,467 rather than identical. The
selected assembly and its score are identical regardless, and the six targets are
in both banks, so the comparison holds on its own terms.

That leaves the second-largest class — 20 of 100 losses across both fixtures, 13
of them on 40377 — with **no measured lever at all**. Enumeration has one that
works on 8 of 13 pages and converts nothing on its own; retention now has one
that has been tried and does nothing.

### The traversal priority is an agreement count, and that is a lead

If retention is lost in the traversal, the traversal order is worth reading. It
is one expression, identical in `placement_multi_shape_search` and
`placement_mixed_batch_search`:

    priorities = [float(np.sum((labels[i] == target) & (target > 0))) for i in ...]

A raw **count** of agreeing pixels, bounded above by the candidate's own painted
area. A pose covering 11,000 px can score up to 11,000; one covering 500 px can
score at most 500 however perfectly it agrees. `placement_cardinality_search`
then orders by `-priority` within each colour group, so the small-footprint pose
is explored last **by construction** — which is the same area bias the population
table found in the objectives, sitting one stage earlier and never examined.

`placement_traversal_priority` measures the scale-free alternative — the same
agreement divided by the candidate's own painted area — without changing
anything. Median rank of a page's reference poses in its own screened bank:

| page | screened | reference poses located | by count | by rate |
| ---: | ---: | ---: | ---: | ---: |
| 16 | 1,258 | 1 of 3 | **1** | **1** |
| 17 | 2,322 | 1 of 2 | **1** | **1** |
| **19** | 2,637 | **6 of 6** | **1502** | **120.5** |
| 26 | 1,926 | 2 of 5 | 71 | 71 |
| 28 | 4,847 | 2 of 3 | 58.5 | **75** |

Page 19 is the case retention loses: its four small 25269 plates paint 874-964 px
and sit at ranks 1501-1507 of 2,637 under the count, and at 117-292 under the
rate — an order of magnitude, on the page where five of six screened targets
never reach a retained assembly. The two pages the run already gets right are
**rank 1 under both**, so the change does not demote a correct pose that is
already first. Page 28 is a small regression, 58.5 to 75.

Two things this is not. It is not an adoption: one large win, two neutral
controls and one small loss is the same mixed shape every lever in this program
has had, and the honest next step is an A/B drive of the whole chain, not a
default. And it is not sufficient even where it wins — the ranking is over single
placements while the traversal is over combinations, so a better rank is a
necessary condition for reaching a pose, not a proof the search would keep it.

**A separate defect the same measurement exposed.** On page 26 the agreement is
**0 for every candidate in the bank**, both reference and selected. The coarse
target carries no class the page's candidates can match, so the priority contains
no information and the traversal order there is effectively arbitrary. That is
its own bug, on a page that places 0 of 5, and it is invisible to any ranking
comparison because both rankings are equally uninformative.

### The parent-budget chain through page 19: nothing changes

| page | round five (128 parents) | round six (1024 parents) |
| ---: | --- | --- |
| 16 | 49 emitted / 46 structural, 0.6372 | 49 / 46, 0.6372 |
| 17 | 51 / 48, 0.5780 | 51 / 48, 0.5780 |
| 18 | 52 / 49, 0.5357 | 52 / 49, 0.5357 |
| 19 | 58 / 50, 0.5246 | 58 / 50, 0.5246 |

Identical on every row, and on pages 16 and 17 identical to sixteen figures of
image score. Four of the first four pages hit the pose cap before exhausting even
128 parents, so the extra budget is never spent, exactly as page 16 predicted.
The chain continues past page 20 on a resume; pages 22 to 30 are where the
parent budget was the binding one and where any effect has to appear.

Two driver defects surfaced getting there, and the second is worth more than the
experiment.

* The first attempt stopped at page 20 because `--continue-on-unsupported` was
  omitted. It is a driver argument rather than a page option, so it is not part
  of the resume config a run writes — which is why the omission is invisible in
  the journal.
* **The resume then refused, and nothing had changed.** `resume_checkpoints`
  compared a live options dict against one parsed from the journal, so it
  compared Python types rather than configuration: `scales` is built as a tuple
  and JSON reads it back as a list, and the two are never equal. **Every run that
  ever wrote that option was unresumable**, and the failure message says
  "configuration changed", which is exactly wrong. Both sides are now
  round-tripped through JSON before comparison, which asks the question the
  guard intends; a changed option, a changed page scope and a checkpoint without
  hashes are still refused, and now tested. The resumed run carries pages 16-19
  forward unchanged.

### Pages 26 and 27 allocate a colour their drawings do not contain

The zero agreement on page 26 is not a near-miss and not a classifier confusing
two similar colours. Reading the palette back by index:

| page | bank palette | target classes present | candidate classes |
| ---: | --- | --- | --- |
| 25 | 0 1 15 19 29 71 72 322 | all eight | 15 |
| **26** | 0 1 15 19 29 71 72 **191** 322 | everything **except 191** | **191** |
| **27** | 0 1 15 19 29 71 72 **191** 322 | everything **except 191** | **191** |
| 30 | 0 1 15 19 29 71 72 191 322 | everything except 191 | 0, 1 |

191 is bright light orange and 322 is medium azure — nowhere near each other, so
this is not a nearest-colour collision. 191 enters the palette only on the pages
whose candidates carry it, and on those pages **not one drawing pixel is
classified as it**.

What the drawing says underneath the *correct* poses settles it. Page 26's three
locatable reference poses paint 2,029-2,040 px each, and the classes beneath
them are white, black, 71 and 72 — never 191:

| pose | painted | drawing classes under the footprint |
| --- | ---: | --- |
| reference | 2,040 | 15: 1421, 0: 289, 71: 130, 72: 81, 19: 23, none: 96 |
| reference | 2,029 | 15: 626, 0: 552, 71: 170, 72: 126, none: 555 |
| reference | 2,030 | 0: 414, 15: 207, 71: 137, 72: 87, none: 1185 |
| selected | 2,308 | 1: 2029, 19: 83, 29: 27, none: 140 |
| selected | 2,277 | 19: 2032, none: 244 |

So the page's four bright-light-orange plates are **not visible in its drawing at
all**, and the coarse composite is blind to them by construction: a candidate
painting a class the target does not contain adds nothing to `correct` and
nothing to `false`. Every one of page 26's 1,926 candidates and page 27's 4,142
scores exactly zero, the traversal order there is arbitrary, and between them the
two pages hold **7 reference targets and place 0**.

This is the sharpest form of the visibility class the round was briefed on — not
"the piece paints few pixels" but "the piece's colour is absent from the
drawing" — and it is exactly what `placement_undrawn_pieces` was built for in
round five. **That rule reported withholding nothing on all thirteen of 40377's
pages, at a smallest drawn share of 2.139.** The two measurements disagree and
which is right is not settled here: they may classify colour differently, or the
rule's drawn-share denominator may not be the quantity this measures. Reconciling
them is the first thing to do on these two pages, because if the drawing really
contains no 191, then withholding those pieces from the image-judged search — the
mechanism round five already built and shipped opt-in — is the correct handling
and it is not firing.

## Round seven: the closure was never a budget problem, it was a predicate problem

Round six's ceiling memo put "finish the closure" first on the measured list and
called the parent budget "a number in a config". The coordinator's addendum then
narrowed that: the budget is two constants, neither ever tuned, and on the pages
where the **pose** cap binds, raising parents alone is provably inert. Round
seven begins by asking what the closure actually costs, and the answer changes
the shape of the problem: it was never affordable to finish, and now it is.

### Round six's two in-flight runs, absorbed

**`40377-r6-parents-chain`, 1024 closure parents, everything else round five.**
Through page 19 it reproduces round five *exactly* - 49/26/46, 51/26/48,
52/27/49, 58/28/50 emitted/strict/structural, precision to the digit - and the
registries say why:

| page | base-attached | r5 poses (128 parents) | r6 poses (1024 parents) | which cap binds |
| ---: | ---: | ---: | ---: | --- |
| 16 | 4,668 | 8,192 | **8,192** | pose |
| 17 | 4,269 | 8,192 | **8,192** | pose |
| 18 | 5,258 | 8,192 | **8,192** | pose |
| 19 | 3,191 | 7,467 | **8,192** | parent, then pose |

Three of the four pages fill the 8,192-pose cap before exhausting even 128
parents, so the parent budget is inert on them and a raise cannot change one
byte. Page 19 is the one that had headroom: its bank grows by 725 poses, it
becomes pose-capped in turn, and **its output is still identical**. That is the
round-six "the budget converts one class into another" finding reproduced on a
second page, this time with the conversion visible and worth nothing.

**`40377-r6-retain-p19`, beam 256 / top-k 64.** Completes. It writes **200**
retained assemblies instead of 44 and emits the same **58** parts. Width is not
the retention lever, measured on the fixture's own extreme case.

### Where the parent-expansion time goes

`placement_closure_profile` rebuilds a page's `ShapeRegistry` from the registry
the run itself wrote and times one closure round with the stages separated. The
registry's own `seconds` field cannot answer this: in evidence mode the driver
builds one seed per page and calls `branch()` per drawing, and `branch` copies
`started` from the seed, so the recorded 129.7 s on page 18 spans the
registration and ranking work done in between.

On 40377 page 18 (one shape, `3031`, 5,258 base-attached poses, 392 relative
mates per parent), expanding **64** parents:

| stage | seconds | share |
| --- | ---: | ---: |
| `collision` (`Assembly.collides`) | **18.87** | **98.3%** |
| `transform` (4x4 product, rounding, bank lookup) | 0.28 | 1.4% |
| everything else | 0.06 | 0.3% |
| one closure round, 64 of 5,258 parents | 19.21 | |

25,088 candidates produce 22,111 duplicate keys and only 2,977 collision calls -
and those 2,977 calls are the whole cost, at **6.3 ms each**. Finishing this one
page's own first round projects to **1,578 s**. That is why round six's attempt
at 1024 parents and 32,768 poses had not finished page 16 after fifty minutes:
not a wall in the search, a scalar predicate.

### The predicate is a Python loop, and it did not need to be

`Assembly.collision` builds the candidate's voxel set by walking up to 4,000
surface samples in Python - nine multiplies, a floor and a set insertion each -
then tests dict membership per voxel, then erodes the set with six more
membership tests per voxel. `placement_fast_collision` does the same arithmetic
on numpy arrays and packs the voxels into sorted int64 keys.

The point of the module is that it is not an approximation:

* The world coordinate is evaluated elementwise in the same association order
  the scalar loop uses. IEEE 754 requires each individual multiply and add to be
  correctly rounded and numpy does not contract them into an FMA, so every
  intermediate is bit-identical. Dividing by the 4 LDU voxel edge and flooring
  are both exact.
* The rotated point cloud is cached per (part, rotation) with the rotation's
  exact bytes as the key, and only the translation is added per pose - the same
  expression tree, so caching changes no value.
* `collision()` computes both core terms unconditionally, because
  `candidates()` stores the floats it returns. `collides()` short-circuits, and
  each exit is a proven implication rather than a heuristic - notably: erosion
  is a subset, so the second core term can never exceed the plain count, and a
  plain share already at or below the core threshold settles the disjunction
  without eroding anything.
* Only the erosion probes are restricted, to the voxels that are actually
  occupied. Erosion is still judged against the whole voxel set, so the count is
  the same one; a voxel outside the body cannot contribute to the eroded
  intersection however interior it is.

It patches an `Assembly` **instance**, never the class, so `C:/git/clego` is
unmodified and `Assembly.candidates` - which calls `self.collision` - is
accelerated for free.

**Equivalence is the gate, and it is checked three ways.** Over 3,000 real
closure transforms on page 18 the `(plain, core)` tuple and the `collides`
verdict both agree on every one. `test_placement_fast_collision` asserts the
packed key set equals the scalar voxelisation, that the erosion matches
`assembly.erode`, that the restricted probe form matches the unrestricted one,
and that a whole recorded registry is equal field for field with the fast path
on and off. And the A/B on real pages hashes the entire record: page 18 and page
26 at 128 parents produce **identical sha256** with and without it.

| measurement, 40377 page 18 | scalar | vectorised | ratio |
| --- | ---: | ---: | ---: |
| one `collides` call | 6.34 ms | 0.345 ms | **18.4x** |
| base-attached enumeration (5,258 poses) | 39.95 s | 4.76 s | 8.4x |
| 64 closure parents | 19.21 s | 1.23 s | 15.6x |
| projected full first round | 1,578 s | 101 s | |

The counts are unchanged at every step - 25,088 candidates, 22,111 duplicates,
2,977 collision calls, 1,315 poses added, 6,573 bank poses - which is what makes
this a speedup rather than a different search.

### What a complete closure actually contains

With the predicate affordable, every 40377 page's **complete** first closure
round can be measured for the first time. No budget: parents run to the
base-attached count, poses to two million.

| page | base-attached | r5 bank (128 parents / 8,192) | complete round-1 bank | closure seconds |
| ---: | ---: | ---: | ---: | ---: |
| 16 | 4,668 | 8,192 | **50,056** | 100.0 |
| 17 | 4,269 | 8,192 | **108,444** | 144.8 |
| 18 | 5,258 | 8,192 | **57,711** | 121.2 |
| 19 | 3,191 | 7,467 | **65,637** | 35.5 |
| 22 | 1,437 | 1,437 | 1,437 | 0.0 |
| 23 | 5,396 | 8,192 | **60,582** | 125.1 |
| 24 | 1,390 | 1,390 | 1,390 | 0.0 |
| 25 | 1,321 | 1,321 | 1,321 | 0.0 |
| 26 | 808 | 2,090 | 5,889 | 1.9 |
| 27 | 2,698 | 5,333 | **31,853** | 24.0 |
| 28 | 4,379 | 8,192 | **140,430** | 72.2 |
| 29 | 984 | 2,130 | 8,330 | 2.3 |
| 30 | 2,136 | 5,609 | **86,707** | 24.7 |

The whole chain's complete enumeration is about **11 minutes**, against a page
26 that round six timed at "about a minute" for one page and a page 16 that had
not finished in fifty. Page 26's complete bank is 5,889 poses at 808 parents,
which reproduces round six's one-page experiment exactly.

Two results in that table are worth separating from the speedup. Pages 22, 24
and 25 add **nothing** in closure: their complete round-one bank is their
base-attached set, so they were never budget-limited at all and no enumeration
work can help them. And pages 17, 28 and 30 hold 13 to 17 times more legal poses
than the search has ever seen, which is the reachability headroom the population
table's `unreachable` class was measuring the absence of.

### Root cause: LDraw 19 and 191 share a hue, and palette order decides the winner

The first hypothesis — that `placement_undrawn_pieces` classifies against a
palette of the allocated colours alone, so a single-colour allocation has no
competitor — was implemented and **refuted**. Replaying the rule over all
thirteen driven pages with the body's colours added changes no verdict, and page
26's drawn share for 191 stays at 6.244 against a 0.25 threshold. The two colour
tables are identical too: `recon_v7.render.color_rgb` and
`placement_colored_cad._rgb` agree on all nine colours to the byte.

The actual cause is in `palette_labels`, and it is exact. Converted to OpenCV
HSV, **LDraw 19 (Tan, 228 205 158) and LDraw 191 (Bright Light Orange, 248 187
61) both have hue 20**. The classifier discriminates hue-bearing colours by hue
distance alone — saturation and value are gates, not discriminators — so every
pixel of either colour is a perfect tie, and `np.argmin` resolves a tie by taking
the **lower palette index**. Which colour wins is therefore decided by the order
of the list that happens to be passed in.

Classifying 40377 page 26's own drawing three ways:

| palette order | pixels → 19 | pixels → 191 | unclassified |
| --- | ---: | ---: | ---: |
| `build_bank`'s, sorted numerically | **12,353** | **0** | 5,495 |
| the undrawn rule's, allocated colour first | 117 | **12,236** | 5,495 |
| with 19 removed entirely | 0 | 12,236 | 5,607 |

The same ~12,300 pixels, three verdicts. `build_bank` sorts its palette
numerically, so 19 precedes 191 and takes every orange pixel; the undrawn rule
builds its palette allocated-colours-first, so 191 precedes 19 and takes them
back. **That is why the two measurements disagreed, and neither was wrong about
its own palette.**

The consequence is not symmetric. 40377 contains **one** tan part and **ten**
bright light orange ones, so the coarse target hands roughly 12,300 pixels of
orange to a colour with a single small part in the whole model, and leaves the
class the page is actually placing empty. Pages 26 and 27 then score exactly zero
agreement for all 1,926 and 4,142 candidates, their traversal order is arbitrary,
and they place 0 of 7 reference targets.

**The fix is a discriminator, not a threshold.** 19 and 191 are far apart in
saturation — 78 against 192 — so a tie on hue should be broken on saturation
distance rather than on list position. That is a change to a shared classifier
and, as the module's own docstring already warns about the neutral-spread fix,
scores from before and after are not comparable; it is the first thing to do next
round rather than something to slip in beside a measurement.

### The discriminator, measured and left off by default

`palette_labels` gains an opt-in `saturation_tiebreak`, defaulting to 0 so no
existing number moves. It adds a multiple of the saturation difference to the hue
distance **for the ordering only**, never for the 20-degree acceptance test —
adding it to both tightened acceptance as a side effect, pushing 184 pixels of
page 26 into unclassified, which is a different change wearing this one's name.
With the split, the unclassified count is identical at every weight.

Page 26's own drawing, numerically sorted palette, by tie-break weight:

| weight | 19 (Tan) | 191 (Bright Light Orange) | 0 | 15 | 71 | 72 | unclassified |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 (today) | **12,353** | **0** | 4,107 | 25,183 | 2,702 | 2,453 | 5,495 |
| 0.01 | 161 | **12,372** | 4,107 | 25,183 | 2,702 | 2,453 | 5,495 |
| 0.05 | 161 | 12,441 | 4,107 | 25,183 | 2,702 | 2,453 | 5,495 |
| 0.2 | 163 | 12,451 | 4,107 | 25,183 | 2,702 | 2,453 | 5,495 |

At 0.01 the well-separated colours are byte-identical and only the tied pair
moves; by 0.2 the drift reaches the other chromatic entries (322 goes 9 to 546,
blue 8,211 to 7,674), so 0.01 to 0.05 is the usable band and 0.2 is not.

Six tests pin the behaviour, including the one that matters: **without the
tie-break the same orange pixel classifies as tan or as orange depending only on
which order the palette was built in**, and with it the verdict is the same
either way. A real hue difference is never overridden, and acceptance never
changes.

**Not wired into any run.** The classifier is shared by the coarse target, the
undrawn rule and the camera gate, so turning it on moves every score that depends
on colour and makes saved numbers incomparable — the same warning the module's
own neutral-spread fix carries. Enabling it and re-driving both fixtures is a
round's work on its own, and it is now a one-argument experiment instead of an
unknown.

### The collision's scope, and where the tie-break does not reach

The 19/191 tie is not a 40377 quirk. Both fixtures have it, and on 41624 it is
larger:

| fixture | colour 19 (Tan) | colour 191 (Bright Light Orange) | share of the model |
| --- | ---: | ---: | ---: |
| 40377 | 1 part | 10 parts | 11 of 90 |
| 41624 | **17 parts** | 8 parts | **25 of 109** |

Both palettes sort numerically, so 19 precedes 191 and takes every tied pixel on
both fixtures. On 41624 that is a colour carrying 8 parts that can never win a
pixel against one carrying 17.

41624 is worse than a single tie, because four of its colours sit within nine hue
degrees of each other — 4 (h3), 25 (h15), 19 (h20), 191 (h20), 14 (h24) — well
inside the classifier's own 20-degree acceptance window. Pairwise:

| pair | hue | saturation | Lab | verdict |
| --- | ---: | ---: | ---: | --- |
| 19 / 191 | **0** | **114** | 44.1 | tie on hue, separated cleanly by saturation |
| 25 / 191 | 5 | 39 | 38.3 | marginal |
| 14 / 191 | 4 | **5** | **16.7** | separated by nothing in HSV |
| 14 / 19 | 4 | 119 | 48.1 | saturation separates |

So the honest limit of the tie-break just added: **it resolves the hue-0 tie on
both fixtures** — 10 parts on 40377 and 8 on 41624 whose colour currently cannot
win a pixel — and it does **not** separate 14 from 191, which differ by 5
saturation levels and 16.7 in Lab and are simply near-identical colours. 41624
has one part in colour 14, so that residual is one part; the finding is recorded
because the next person to hit it should not expect the tie-break to help.

The general statement is the one to carry: **hue is the wrong metric for this
job.** A Lab distance separates every pair in the table above by 16.7 or more
while hue separates two of them by zero, and it needs no tie-break because it has
no ties. Replacing the discriminator is a larger change than adding a tie-break —
it moves every classification, not only the tied ones — and it is named here as
the principled version rather than smuggled in.

### Correction: the chain is not robust to an image-indistinguishable tie

The table above says pages 16-19 are identical under the raised parent budget.
That is true of every reported number and **false of the emitted model**, which
is the thing the next page consumes. Comparing the two runs file by file:

| page | model sha256 | image score |
| ---: | --- | --- |
| 16 | identical | identical, 0.6372338224690584 |
| 17 | identical | identical, 0.5780034952011921 |
| 18 | identical | identical, 0.5357490227060575 |
| 19 | **differs in one line** | **identical, 0.5245855326837143** |

The differing line is one `25269` quarter tile at the same position (10, 20, 10)
in both, under two different proper rotations a quarter turn apart — both
orthonormal, both determinant 1, and the mould has exactly **one** proven vertex
symmetry, so they are genuinely distinct placements. The image objective scores
them the same to sixteen significant figures, and the structural evaluation
counts 50 either way, so the tile is wrong in both and nothing in the run can
tell them apart.

What follows from that one tie is not small. Page 22 inherits a different base
body, and with it:

| page 22 | round five | round six |
| --- | --- | --- |
| base sha256 | ea12976997ed | 631a5aac4ebf |
| registration source | `drawing_to_drawing`, IoU 0.890 | **`body_template`** |
| selected view | 0 | **2** |
| camera scale px/LDU | 1.6916 | **1.4863** |
| image score | 0.3668 | **0.2529** |
| bank | 1,437 poses | 1,437 poses |

The bank is byte-for-byte the same size, the emitted part count is the same 60,
and the page nevertheless registers by a different mechanism at a different scale
for a third of the score. Pages 26 and 27 then refuse a camera, where round five
placed them.

So the raised parent budget's effect on this chain is **not** the thing being
measured: it is downstream of a coin-flip at page 19 that the budget happened to
land on the other side of. Any A/B of a chain-level change has to carry this — a
single tie broken differently, on a pose no objective can rank, redirects the
camera path five pages later. That is a property of the pipeline worth knowing
independently of any lever, and it means chain-level comparisons of two
configurations are only as trustworthy as the number of such ties between them.

### Ties are pervasive, and they are variance rather than lost coverage

`placement_score_ties` counts, from each run's own `results.json`, how many
retained assemblies share the top image score, and hashes their files to
separate "two names for one answer" from "two answers and no way to choose":

| run | pages | exact tie at the top | of which genuinely different assemblies | most tied |
| --- | ---: | ---: | ---: | ---: |
| 40377 `r5-contain-v1` | 13 | **7** | **7** | 4 |
| 41624 `r5-full-scope` | 27 | **15** | **15** | **12** |

**Every tie is between distinct assemblies** — not one duplicated. On more than
half of all driven pages, across both fixtures, the run picks among 2 to 12
different assemblies that the image objective scores bit-identically, and it
picks by list order.

The obvious follow-up is whether a better tie-break is free coverage. It is not.
Comparing the correct-part count of every assembly inside each exact tie on
40377:

| page | tied assemblies | correct in each | selected |
| ---: | ---: | --- | ---: |
| 16 | 4 | 1, 1, 1, 1 | 1 |
| 17 | 4 | 2, 2, 2, 2 | 2 |
| 18 | 4 | 1, 1, 1, 1 | 1 |
| 19 | 2 | 1, 1 | 1 |
| 23 | 4 | 0, 0, 0, 0 | 0 |
| 26 | 3 | 0, 0, 0 | 0 |
| 28 | 4 | 1, 1, 1, 1 | 1 |

Total selected 8, best available inside the ties 8: **a perfect tie-break is
worth zero on this fixture**. The tied assemblies differ in which pose they use
and are equally right or equally wrong about how many.

So ties are a **variance** source, not a bias one, and that is exactly why they
matter for method rather than for score. Page 19's two-way tie costs nothing on
page 19 and still sends page 22 from `drawing_to_drawing` at 1.6916 px/LDU to
`body_template` at 1.4863, and its score from 0.3668 to 0.2529. With 7 and 15
such forks in a chain, two configurations can differ by several pages of camera
path without either being better. **Every chain comparison in rounds two through
six carries this exposure and none of them measured it**; the honest way to run a
chain-level A/B from here is to report it alongside, or to fix the tie-break to
something deterministic under both configurations before comparing.

### Concurrent work in the same tree, and what this session did not touch

Two commits landed in `scripts/pdf-recon` during this round that this session did
not author — `perf(recon): the closure was unaffordable because its predicate was
scalar` and `feat(recon): an adaptive closure budget, a screened-set cap, Lab
classes and an unplateaued window` — and there is further uncommitted work in the
same files. They act on this round's measurements directly: an **adaptive closure
budget** for the finding that no page ever finishes its closure and that a fixed
pair of constants is the wrong shape, **Lab classes** for the finding that hue is
the wrong discriminator, a **`pose_tie_ranks`** ordering for the page-19 tie, and
an `own_agreement` exchange window for the traversal-priority result.

Two consequences for reading this record.

* The `saturation_tiebreak` measured above survives in the classifier beside the
  new Lab path, and its six tests still pass. It is now the fallback rather than
  the recommendation, which is the right relationship: Lab has no ties to break.
* **An assembly-level tie-break was written here and then removed rather than
  committed.** `pose_tie_ranks` addresses the same coin flip one stage earlier,
  in a file being actively edited, and the census says a perfect assembly-level
  tie-break is worth zero coverage — so a second overlapping mechanism would have
  been duplicated semantics and a merge hazard for no measured gain. The
  assembly-level tie itself remains as measured: 7 of 13 and 15 of 27 pages, every
  one between genuinely different assemblies. Whether the upstream pose ordering
  removes it downstream is a measurement nobody has made yet, and
  `placement_score_ties` is the tool that would make it.

### The budget experiment, closed: it enlarged a tied set from two to three

Running the tie census on the parent-budget chain itself finishes the story with
a number rather than an inference:

| page | round five: retained / tied | round six: retained / tied | best score |
| ---: | ---: | ---: | --- |
| 19 | 44 / **2** | 45 / **3** | 0.524586 in both |
| 22 | 13 / 1 | 42 / 2 | 0.3668 vs 0.2529 |
| 26 (retry) | 15 / 3 | 12 / **12** | 0.2918 vs 0.2438 |

**The only measurable effect of raising the parent budget through page 19 was to
enlarge that page's tied set from two members to three**, at an identical top
score of 0.524586, and the stable sort then handed the page to a different one.
Everything downstream — page 22's registration falling from `drawing_to_drawing`
to `body_template`, pages 26 and 27 refusing a camera in the main pass — follows
from that draw, not from the budget.

Page 26 on the retry pass is the extreme: **12 retained assemblies, all 12 tied
exactly, all 12 distinct**. Its selection is a one-in-twelve coin flip among
assemblies the objective cannot separate at all — which is the same page whose
coarse target contains no bright light orange, so the objective is not merely
indifferent there, it is blind.

The budget experiment therefore returns no usable chain number, and saying so is
the result. What it did establish stands: every page of both fixtures hits the
parent budget, page 26 recalls 3 of 5 reference poses at 128 parents and 5 of 5
at 1024, and the enlarged bank places no better. The chain-level question needs a
deterministic tie-break first, which is what the concurrent `pose_tie_ranks` work
is for.

### Finishing the closure is affordable; screening it is the next wall

The driver runs the complete closure exactly as the standalone measurement said
it would - 40377 page 19 at `--max-closure-parents 0`: 3,191 parents, 65,637
poses, `closure_rounds_complete: true`, 29.8 s. What round seven did not
anticipate is the stage after it. The occupancy screen renders one silhouette
per candidate, and `build_bank` then rasterises a depth and a label layer per
survivor at 363 KB to 750 KB each; both are linear in the bank. So a bank that
grows 8x makes the screen cost 8x, and page 28's complete bank at a 69% screen
retention would ask `build_bank` for far more than the 12 GB host budget - which
raises `Bank requires ... bytes` and produces **nothing** for that page.

Two things follow, and they are the honest shape of the "just raise the budget"
recommendation. First, `stratified_cap` exists so that a page degrades to a
smaller bank rather than to no bank, and it caps round robin over quota keys by
**coverage rate** rather than by pixel count, because a count is bounded by the
candidate's own area and would re-import the same scale bias that loses small
pieces in the traversal. Second, the parent and pose budgets are not really
enumeration parameters at all - they are *screen-cost* parameters, and that is
the thing five rounds of tuning them never said out loud.

### Where a correct pose is actually lost, measured a second time

`placement_retention_stage` re-derives round six's retention table from the runs'
own artifacts and reconciles with it exactly (40377: 32 targets, 24 in bank, 23
screened, 10 in a retained assembly; 41624: 78/18/11/4), with one correction:
round six's "13" on 40377 is a **net**. The distinct count of instances that are
screened and in no retained assembly is **14**; the net is 13 because one
target - `60474`:0 on page 17 - reaches the selected assembly *without*
surviving the screen, because it is that page's withheld, arrow-attached piece
and bypasses screen and bank entirely. The combined target class is **21
distinct instances**.

Four hypotheses were measured against those 21, and three are refuted:

* **Bank truncation.** 92 of 92 driven views across both runs report
  `bounded_search`; **zero** report `host_bank_budget_exceeded`, and on all 92
  the rasterised placement count equals the screened count. **0 of 21.**
* **Beam width.** Round six's own re-drive at beam 256 / top-k 64 retains 200
  assemblies and the same 1 of 6. Replaying the shipped beam level by level on
  page 19 reproduces the run (same 12 complete states, coarse score identical to
  1e-16) and shows why width cannot help: **the reference-equivalent complete
  assembly scores 0.293785093 against the beam's own best complete state
  0.293821457**. The coarse objective's optimum over this bank is not the
  reference, so an exhaustive search returns the same wrong answer. Three of the
  six reference poses are *inside* the beam at level 1 (ranks 0, 1, 12, 13, 20)
  and die later anyway.
* **The low-paint tail.** The five lost page-19 targets paint 884 to 4,204 px;
  the one **retained** target paints **874**, the least of them. Paint count does
  not separate lost from retained. Refuted on its own fixture.
* **Support connectivity.** All 42 screened placements are support-reachable, so
  the stated hypothesis fails - but narrowly true for **5 of 21**: those are
  closure poses one hop from an anchor, and every one of their eleven one-swap
  probes fails on *connectivity*, never collision (0 collide, 11 disconnect). A
  closure pose is legal only together with its witnessed parent, and both the
  beam and the exchange move one placement at a time.

**Collision** accounts for another **2 of 21** - the reference pose collides with
every single-swap partner and needs two simultaneous swaps - and these are not
weak candidates: 40377's `2431` on page 19 is the rank-0 single placement on the
whole page.

What kills the remaining 14 is a **plateau**. Beam and exchange both rank by the
incremental per-class depth-composite IoU, and on page 19 view 1 **1,236 of
2,637 screened candidates (46.9%) change it by exactly zero** - bit-identical to
the empty-assembly score. Across all 40 driven pages of both fixtures the
zero-delta share is **5.9% to 52.6%**. Inside that band `argsort(kind='stable')`
orders by bank index, so admission is decided by enumeration order. The cause is
structural rather than numerical: a candidate whose pixels are already painted
with the same class contributes nothing - *including when a wrong piece is
standing in the same place*. A white plate on a white body is invisible to the
pruner.

And the two objectives disagree. The one-swap that introduces page 19's correct
`41740` moves the coarse score by **-1.11e-5** and the native selection score by
**+5.63e-3**: opposite signs, 500x in magnitude. Only coarse survivors ever reach
the native scorer.

### The fix that follows, and the number it is actually worth

The exchange renders only the `native_width` = 16 best same-key candidates,
ordered by that same flat delta - and 47% to 59% of each key's eligible
candidates tie exactly there, so the reference poses sit at window ranks 86-97,
232-233 and 298-299. Width would have to be about 300 for page 19's correct
`41740` to be rendered at all.

`LayerComposite.own_agreement` counts a candidate's own painted pixels that
already carry the drawing's class there - one bincount over segments the class
already builds, **no extra render** - and nothing already placed can flatten it.
The same poses move to ranks 0/1, 2/3 and 47/49/52. Measured on page 19 at the
same budget:

| exchange window ordering | native score | renders | reference targets |
| --- | ---: | ---: | ---: |
| incremental (shipped control) | 0.524585533 | 84 | **1 of 6** |
| own agreement | **0.532939594** | 217 | **2 of 6** |
| union of the two, 8 each | 0.532719515 | 314 | 2 of 6 |

The honest negative control is page 26, where the losses are the objective's
rather than the window's: **0 of 3 either way**, native identical at
0.291810253. And the honest ceiling is small. Of the 21 instances, only **4**
have a legal one-swap that *raises the run's own native score* - all four on
40377 page 19, none on 41624. For **10 of 21** the native objective scores the
reference-pose swap **lower**, by 6.5e-4 to 1.53e-2.

**That is the round's headline, and it corrects round six's ladder.** Retention
is the *smallest* lever measured, not the second largest: ten of the twenty-one
instances filed under retention would simply be re-filed as ranking losses the
moment retention were fixed, which is the same class-conversion round six saw
when it lifted the closure budget. Round six's split put ranking at 4 of 100;
counted this way it is at least 14 of the 21 in that class.

### The absent colour class was a palette-order coin flip, and repairing it does not help

Round six found that 40377 pages 26 and 27 allocate bright light orange (191)
and that neither drawing contains one pixel classified as it, so 1,926 and 4,142
candidates - **all** of them, not a subset - score exactly zero and traversal
order is arbitrary. Round five's `placement_undrawn_pieces` had reported
withholding nothing on all 13 pages. Both are right:

| quantity | palette order | p26 -> 191 | p27 -> 191 | verdict |
| --- | --- | ---: | ---: | --- |
| the undrawn rule | allocated colours first | 12,236 | 14,882 | nothing withheld |
| the coarse target the objective scores | numerically sorted | **0** | **0** | absent |

They compute the same predicate on the same pixels and differ in **the order of
the palette list**. LDraw 19 (Tan) and 191 (Bright Light Orange) both convert to
OpenCV hue 20, `palette_labels` discriminates chromatic entries by hue alone, and
`argmin` breaks the perfect tie by lower palette index. The defect is symmetric:
pure 191 labels as 19 when 19 is listed first and pure 19 labels as 191 when 191
is. The brief's own hypothesis - that the undrawn rule measures a footprint
rather than a colour's presence - is **refuted**; so is the context-colours
explanation, which changes no verdict on any of the 13 pages.

`--chromatic-metric lab` fixes it properly rather than by a tuned weight, because
the collision is a cluster and not a pair: 41624 has four colours inside nine hue
degrees over 25 of its 109 parts, the bias inverts between fixtures because the
commoner colour differs, and 14 and 191 are not separable in HSV at all. Verified
directly: under hue, reversing the palette swaps tan and orange; under Lab both
classify correctly either way. It is applied to the ordering only - acceptance
stays the hue test and the saturation and brightness gates are untouched - so the
same pixels are classified and only which class each gets can change.

**And on the pages it was built for it makes things worse, measured.** Repairing
the classifier drops page 26's zero-agreement candidates from 1,926 of 1,926 to
739 of 1,926, so the priority becomes informative - and it points at the wrong
poses. The three enumerated reference poses change the actual objective by
**exactly 0.00000000 under both classifications**, because their visible pixels
fall where the drawing carries no orange at all; the drawing's ~12,300 orange
pixels belong to other parts. Their ranks under the repaired classifier are
1,164, 1,216 and 1,639, while the wrong selected poses rise to ranks 3, 4, 28 and
29. Of the seven reference targets on those two pages, **four were never
enumerated** and three are visibility-blocked; none is blocked by the absent
class. Withholding cannot even be expressed there, because the absent colour *is*
the entire allocation on both pages - it would leave zero image-judged pieces,
below the rule's own guard - and page 26 has no accepted arrowheads for the
non-image channel to use. Page 27 has three, and places both pieces **wrong**, at
104 px and 38 px mean arrowhead error against the documented good case of 0.5 px.

So the classifier repair is adopted as a **correctness** fix, not as a lever, and
it is recorded here that on the one place it was expected to buy parts it buys
none and demotes the correct poses.

### Every chain A/B in this program has been carrying an unmeasured coin flip

`placement_score_ties` counts, from the runs' own `results.json`, how many
retained assemblies share the top image score exactly:

| run | pages | pages with an exact tie among *different* assemblies | widest tie |
| --- | ---: | ---: | ---: |
| 40377 `r5-contain-v1` | 13 | **7** | 4-way |
| 41624 `r5-full-scope` | 27 | **15** | 12-way |

Within a tie the correct-part counts are equal, so this is variance and not bias.
It still matters, because each fork sends the chain down a different camera path.
Round six's parent-budget chain is the worked example, and it is not a budget
effect at all: it reproduces round five exactly through page 19, then page 19
emits one `25269` quarter tile under either of two proper rotations a quarter
turn apart - identical to sixteen significant figures, both structurally wrong -
and page 22 falls from `drawing_to_drawing` registration at 1.6916 px/LDU to
`body_template` at 1.4863, its score from 0.3668 to 0.2529. Pages 26 and 27,
which round five placed, come back `camera_refused`.

`argsort(kind='stable')` breaks such a tie by array position, which is bank
index, which is closure enumeration order - so *any* configuration change that
reorders the bank re-rolls every tie in the chain. `--tie-break pose` ranks by
the rounded placement instead, in the beam's per-state expansion, in its
cross-state cut and in the exchange window, so two configurations holding the
same tied pair resolve it identically. Every driven page also now journals its
own tie census, so a chain row carries its exposure rather than assuming none.

**The consequence for this round's method is that round five's 53/90 is not a
usable baseline for a configuration A/B**, and neither were rounds four's and
five's own chain deltas. The control for everything below is a re-drive of round
five's exact configuration with the deterministic tie-break and nothing else
changed.

### The parent-budget chain, finished: 50/90, and why that number cannot be read

| checkpoint | round five (128 parents) | round six (1024 parents) |
| --- | --- | --- |
| page 18 | 52 emitted / **49** | 52 / **49** (models byte-identical) |
| page 19 | 58 / **50** | 58 / **50** (one line differs, same score) |
| page 25 | 65 / 51 | 65 / **50** |
| page 30 | 79 / **53** | 73 / **50** |
| final, after retries | 79 / **53** (0.589) | 79 / **50** (0.556) |

The chain lands **three poses lower**, and after page 19 its structural count is
frozen at 50: pages 22 to 30 and both retries add 21 parts and **not one correct
pose**, where round five's added three.

**That difference cannot be attributed.** Two things changed at once and this run
cannot separate them:

* page 19's tied set grew from two members to three at an identical score, and
  the sort handed the page to a different one — every later page inherits that
  body and, at page 22, a different registration mechanism and camera scale;
* pages 22 onward also got genuinely larger banks (page 22 retained 13 assemblies
  in round five and 42 here, page 23 12 against 38), so the search itself is not
  the same experiment.

Either could account for three poses. The one thing measured cleanly is the size
of the exposure: **8 of this chain's 13 placed pages end in an exact tie among
genuinely different assemblies**, and a single such tie at page 19 is enough to
change the camera path for the remaining nine. So a chain-level delta of three on
this fixture is inside the noise a tie-break draw can produce, which retroactively
puts round four's 48-to-53 and round five's hold at 53 in the same band.

The conclusion is not that the budget is bad. It is that **this fixture cannot
resolve a three-pose chain-level effect at all** until the tie-break is
deterministic, and that is now the precondition for every A/B this program runs,
not a refinement of one.

### Round seven's whole-chain result: 53/90 re-baselined, then 54/90

Two 40377 chains, same base checkpoint, same 17-page scope, same allocation.
Both driven with `--tie-break pose`, so the comparison is between the
configurations and not between two rolls of the same dice. They differ in exactly
one flag.

| | round five | **control** (r5 config + deterministic tie-break) | **window** (control + `own_agreement`) |
| --- | ---: | ---: | ---: |
| emitted | 79 | 79 | 79 |
| structural | **53** | **53** | **54** |
| authoritative-alias | 36 | 37 | **38** |
| raw strict | 30 | 31 | **32** |
| precision | 0.671 | 0.671 | **0.684** |
| coverage | 0.589 | 0.589 | **0.600** |
| pages with a tie among different assemblies | 7 of 13 | 7 of 13 | 9 of 13 |

**Round five's 53/90 survives re-baselining**, which is the first thing that had
to be checked and was not guaranteed: the control reaches the same 53 structural
parts, with one more at the alias and strict levels, so determinism cost nothing
and tightened two of the three agreement measures.

**The exchange window ordering is worth +1 structural on the whole chain**, and
it is the same part the single-page gate predicted: page 19 goes 50 to 51 at the
moment the correct `41740` enters the emitted assembly, and the gain survives
eleven more pages to the end. It also carries +1 at alias and strict level and
raises precision at identical emission, which a lucky tie would not do
consistently across three measures.

It is +1, and the honest frame is that the round-six ceiling table predicted at
most 4 from this lever on this fixture and the diagnosis predicted 1 realised.
**The prediction was exact.**

Two costs are recorded rather than buried. Pages 26 and 27 are `camera_refused`
on the main pass in the window chain and recovered by the retry pass at the same
54 - the changed page-19 body moves the camera path, which is the same
sensitivity round six's chain hit, now visible because both sides are
deterministic. And the tie exposure rises from 7 to 9 of 13 pages, which is a
property of the assemblies retained rather than of the mechanism; the two chains
share an identical bank, so nothing in this +1 is a re-rolled tie.

### The single-page gate, with everything on

One page-19 drive from round five's own page-18 body, with the complete closure,
the screened-set cap, the Lab classifier, the own-agreement window and the pose
tie-break all on at once:

| | round five page 19 | everything on |
| --- | ---: | ---: |
| closure | 128 parents, 7,467 poses | **3,191 parents, 65,637 poses, complete** |
| screened (best view) | 2,716 | **19,222** (capped to 6,000 for the bank) |
| emitted | 58 | 58 |
| structural | 50 | **51** |
| alias / strict | 34 / 28 | **35 / 29** |
| tie exposure | 2 | **1** |

The complete closure and the 7x larger screened set buy nothing beyond what the
window ordering alone buys, which is the third independent confirmation of round
six's "the budget converts one class into another" finding — and this time the
conversion is measured at eight times the bank size rather than three.

### 41624, driven to its full scope under the same configuration

The same two flags on 41624's 36-page scope, from the same round-three
construction checkpoint and the same element-bridge allocation round five used:

| checkpoint | page 3 | page 4 | **page 5** | page 8 | page 16 | page 38 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| emitted | 6 | 9 | 13 | 21 | 42 | 86 |
| structural, round five | 3 | 5 | 5 | 5 | 5 | **5** |
| structural, round seven | 3 | 5 | **6** | 6 | 6 | **6** |

**5/109 to 6/109**, and the extra part arrives on page 5 - the first page after
the opening, which is where round five's run stopped gaining. 86 parts emitted
against round five's 75, at precision 0.070. Twenty of the 31 placed pages end in
an exact tie among genuinely different assemblies, which is the highest exposure
measured anywhere in the program and the reason 41624's number should be quoted
with that column attached.

So the round moves both fixtures by exactly one part: **54/90 and 6/109**. That
is the honest size of the only lever the diagnosis said was live, and it is the
size the diagnosis predicted before either chain was driven.

### Round seven's trajectory

| round | 40377 | 41624 | what the round bought |
| ---: | ---: | ---: | --- |
| 1 | 26/90 | — | native scenes, calibrated cameras, CAD geometry |
| 2 | 46/90 | 3/109 | camera, identity, the body table |
| 3 | 46/90 | 3/109 | the target, the budget, construction |
| 4 | 48/90 → 53/90 | 5/109 | drawing-to-drawing registration, per-round closure |
| 5 | 53/90 | 5/109 | containment judged in-page, the 98138 alias |
| 6 | 53/90 | 5/109 (full scope) | the population, and three channels not adopted |
| **7** | **54/90** | **6/109** | **an affordable closure, a deterministic tie-break, and the measurement that retention is the smallest lever** |

Round seven's number is +1. What it actually delivered is three things the
number does not show:

* the closure is **finishable** — 18x on the predicate, every page's complete
  first round in seconds to 2.4 minutes against a projected 26 minutes for one
  page — and finishing it is measured to buy nothing by itself, so that
  recommendation is now closed rather than outstanding;
* every chain comparison in this program up to round six was **un-baselined**,
  and round six's own 3-part regression is now attributed to a coin flip rather
  than to its configuration;
* **retention is the smallest lever, not the second largest.** Ten of the
  twenty-one instances filed under it are the objective preferring another pose,
  and on page 19 a perfect search over the bank still returns the wrong assembly
  because the reference-equivalent complete assembly scores *below* the beam's own
  best. Every remaining lever is costed in distinct parts, and none of them is
  large.

That is why the breadth clause fires, and why the plan below aims at the
objective rather than at another search stage.

## The breadth plan

Round six's memo said: depth for one more round, then breadth, and named the
trigger — if enumeration and retention leave the chain below about 65/90 and
15/109, stop deepening and go wide. Round seven did the enumeration and the
retention work and the trigger fires. It fires for a better reason than "the
number did not move", though, and the reason decides what breadth is *for*.

### Why depth is finished on these two fixtures

Every remaining lever on 40377 has now been costed in distinct parts, and the
costing is what closes the question:

| lever | measured ceiling on 40377 | measured on 41624 |
| --- | ---: | ---: |
| finish the closure | converts 8 `unreachable` into `mis_selected`; **0** into correct on the one page tested twice | 60 `unreachable`, untested at completion |
| exchange window ordering | **4** reachable, **1** realised | **0** |
| parent-child compound exchange | 5 reachable, 0 realised | included above |
| conflict-guided double exchange | 2 reachable, 0 realised | included above |
| mirror completion (round six) | 2 of 25 distinct, 1 runtime-reachable at 50% precision | abstains |
| inventory-capacity forcing (round six) | **0** — cannot fire | **0** |
| construction symmetry (round six) | +1, on the one construction | +0 |
| a better selection objective | 10 of 21 retention losses are *already* objective preferences | 2 |

The last row is the one that ends the depth argument. Ten of the twenty-one
instances filed under retention are cases where the run's own native objective
scores the reference pose **lower** than what it chose. They are not reachable
by any traversal, retention or enumeration change; they are the objective being
wrong about which assembly explains the drawing. And the coarse objective agrees
with itself about that: on page 19 the reference-equivalent complete assembly
scores **0.293785093** against the beam's own best complete state
**0.293821457**, so a *perfect* search over that bank returns the same wrong
answer. Five rounds of search work have been improving the machinery that finds
the optimum of an objective whose optimum is not the model.

That is a finding about the *objective*, and an objective cannot be fixed on the
fixture that motivated it without overfitting to it. Which is precisely what
breadth is for.

### What two fixtures cannot tell us, stated as the question

40377 is a 90-part BrickHeadz whose pages add one or two pieces to a body that
is already most of the model. 41624 is a 109-part set whose six-page opening
carries every correct pose it will ever have. They fail at different stages —
40377 is dominated by retention and objective disagreement, 41624 by enumeration
— and with two fixtures there is no way to say which is typical. The ladder says
"79 of 90 on 40377 and 31 of 109 on 41624"; nothing in the program says whether
either is representative of anything.

The question the next round should answer is therefore **not** "can we place
more of 40377". It is: *which failure stage is typical, and does it depend on a
property of the set we can measure before driving it?*

### The five fixtures, and why each one

Chosen to vary the two properties that plausibly decide the failure stage —
**how much body a page registers against** and **how many pieces a page adds** —
while keeping every one inside the constraints the program already satisfies: a
PDF in the local corpus, an OMR reference to evaluate against strictly after the
run, and a part count small enough that a whole-scope drive is affordable.

| # | property being varied | what it discriminates |
| ---: | --- | --- |
| 1 | another BrickHeadz, ~90 parts | is 40377 typical *of its own family*, or is it the outlier? The cheapest possible control, and if this one fails differently the program has a fixture problem, not a method |
| 2 | a small set whose pages add **one** piece each to a growing body | isolates "page adds little" from "body is nearly complete": 40377 confounds them |
| 3 | a set with a large flat baseplate opening | 41624's enumeration blow-up should be a function of base-attached count; a big flat base is the extreme case and predicts the `unreachable` share before driving |
| 4 | a set with several sub-assembly pages | `allocation_blocked` is 10 parts on each fixture today and is *entirely* undriven work; one fixture cannot say whether that class is 11% or 50% of a typical set |
| 5 | a set with strong colour variety and no hue collisions | the classifier defects found this round were both colour-degeneracy defects; a fixture where colour is informative measures what the objective is worth when its evidence is clean |

### Cost, honestly

The per-fixture cost is now dominated by the screen, not the closure. Measured
this round on 40377 page 19: a complete first-round closure is **29.8 s**, and
screening its 65,637 candidates is **about six minutes per view**, three views
per page. At the shipped 8,192-pose bank a page screens in well under a minute.
So:

* **Per fixture, at shipped budgets:** roughly one hour of driving for a 15-30
  page scope, plus the allocation work upstream of it — which is the part that
  is *not* automated and is where a new fixture actually costs. Call it a day per
  fixture, most of it identity and allocation, and say so rather than quoting the
  driving time alone.
* **Per fixture, at completed closures:** add roughly an order of magnitude to
  the screen unless `--max-bank-candidates` is used, which makes it a different
  experiment. Complete closures are not the default for a breadth round.

Five fixtures is therefore about a week, and the deliverable is a population
table and a retention table per fixture — the same two tools, unchanged, which
is the point of having built them.

### The one thing that would change the plan

If fixture 1 — another BrickHeadz — fails at the *same* stages as 40377, with a
similar objective-disagreement share, then the objective is the target and the
breadth round should be three fixtures rather than five, with the saved effort
spent on a scoring experiment instead. Run fixture 1 first and decide on its
population table.

## Round eight: the two-placement move, built, and what it is worth

Round seven diagnosed and designed three connectivity/collision fixes and left
them unbuilt: a **compound exchange** (the mechanism - a quota-preserving edit
that changes two placements at once), **closure-parent connectivity** (the
guided partner for a pose whose one-swap probes all fail on connectivity) and a
**conflict-guided double exchange** (the guided partner for a pose that collides
with the piece standing in its place). They are one module,
`placement_compound_exchange`, called from the production pass
(`native_exchange`, `--compound-width`) and from the diagnostic
(`placement_retention_stage --double-probe`) so the measurement and the runtime
move are the same code.

### A correction to the brief before any of it is driven

The round-seven ceiling table reads "5 reachable" and "2 reachable" for the two
classes, and the natural reading - **+7 reachable on 40377** - is wrong. Those
seven are distinct instances across **both** fixtures. Read out of the mechanism
tables per fixture:

| class | 40377 | 41624 |
| --- | ---: | ---: |
| closure-parent connectivity | 1 (ti 75, page 26) | 4 (ti 87 p8; ti 29, ti 30 p11; ti 97 p36) |
| collision | 2 (ti 53 p19; ti 78 p28) | 0 |
| **total** | **3** | **4** |

So the honest ceiling for track one on 40377 is **three** instances, not seven,
and the 58-60/90 the brief hoped for was never reachable from this lever.

### The probe, run before the drive: 6 of 7 reachable, 1 of 7 realisable

`--double-probe` enumerates the guided two-placement exchanges from the assembly
the run selected, checks each for quota, collision and connectivity in full, and
native-scores every legal one against what the run chose. It is the same
prediction-then-drive method round seven used, and it costs eight to seventy-two
GPU renders per page rather than an hour.

| fixture | page | instance | class | legal compound assemblies | best native delta | recovered |
| --- | ---: | --- | --- | ---: | ---: | :-: |
| 40377 | 19 | ti 53 `2431`:15 | collision | 8 | **+0.008185** | **yes** |
| 40377 | 28 | ti 78 `3623`:1 | collision | 12 | -0.001336 | no |
| 40377 | 26 | ti 75 `3023b`:191 | connectivity | 72 | -0.012655 | no |
| 41624 | 8 | ti 87 `3023b`:0 | connectivity | 48 | -0.006285 | no |
| 41624 | 11 | ti 29 `3023b`:19 | connectivity | 8 | -0.053801 | no |
| 41624 | 11 | ti 30 `3023b`:19 | connectivity | 8 | -0.058523 | no |
| 41624 | 36 | ti 97 `3023b`:0 | connectivity | **0** | - | no |

**The mechanism works and the objective does not want it.** Six of the seven
instances round seven filed as structurally unreachable are reachable by a legal
quota-preserving two-placement exchange, so the diagnosis was right about the
mechanism; but on five of those six the run's own native scorer prefers the
assembly it already had, by 1.3e-3 to 5.9e-2. That is round seven's headline
arriving in a class that had never been measured for it: the retention losses
were 10 of 21 objective preferences, and the *structural* losses are 5 of 6.

The one exception is 40377 page 19's `2431`, which the round-seven diagnosis
named as the rank-0 single placement on the whole page: its best compound
assembly scores **+0.008185** above the selected one, half again the +0.005633
the window-ordering fix was worth on the same page. Predicted before driving:
**+1 structural on 40377, +0 on 41624.**

**41624's ti 97 is unreachable at any move size, and the reason is exact.** Its
page allocates `3023b`:0 with quota **one**, and every witnessed neighbour of the
target is *also* a `3023b`:0. A quota-preserving exchange cannot admit two
placements of a key the page allocates once, so no two-placement move - and no
larger one that keeps the allocation - can contain both the pose and its witness.
That instance is blocked by the page allocation, not by the search.

### Pooled across both fixtures, the objective is wrong three times in four

Round seven's one-swap probes and round eight's two-placement probes compute the
same quantity - the best signed native delta of a legal quota-preserving edit
that introduces one reference instance - so they pool. `placement_objective_gap`
does that, per distinct reference instance rather than per page opportunity:

| | instances | with a legal edit | the objective would take | it prefers its own |
| --- | ---: | ---: | ---: | ---: |
| 40377 | 14 | 14 | 5 | 9 |
| 41624 | 7 | 6 | **0** | 6 |
| **pooled** | **21** | **20** | **5** | **15 (75%)** |

**The concentration is the finding, not the share.** All five instances a better
search could convert are on 40377, and all five are on **page 19**. The entire
measured upside of every search-side lever this program has built or costed -
beam width, closure completion, retention, window ordering, compound exchange -
is five parts on one page of one fixture. Every other instance is the selection
objective preferring the assembly the run already had, by 6e-4 to 5.9e-2.

That is the measurement the breadth round was supposed to produce, arriving one
fixture early, and it points the same way round seven's page-19 replay did: the
optimum of this objective is not the model.

## The third fixture: 41601-1 Cyborg, and what the on-ramp actually costs

The breadth plan's fixture 1 is "another BrickHeadz, ~90 parts - the cheapest
possible control". `41601-1` (DC series 2, 2018, 108 parts, BI document
`6220569.pdf`, OMR `41601-1.mpd`) was chosen over 21 other in-band BrickHeadz
candidates because it is the only one besides 40377 whose **catalog part count,
OMR leaf placements and PDF BOM quantities all agree exactly at 108**, removing
the reconciliation confound 40377's own 73/90 BOM-vs-OMR overlap introduced.

A structural discriminator worth recording for every future fixture: the OMR
corpus has two authors and only one is usable. **Damien Roux [Darats]** files
carry **zero `0 STEP` markers** and inflated placement counts (41485: 188 leaf
against a 91-part catalog); **Vincent Messenet [Cheenzo]** files carry real step
structure and near-exact BOM agreement. Both existing fixtures are Cheenzo, and
ten of the 22 in-band BrickHeadz are Darats and are not comparable references.

### The automation gap, measured rather than estimated

The breadth plan's cost note says allocation "is the part that is *not*
automated". Driven end to end on a fresh fixture, that is half right - every
stage ran unattended, and the gap is not missing tooling but **what the tooling
correctly refuses**:

| stage | tool | outcome on 41601 | attended? |
| --- | --- | --- | --- |
| identity / BOM | `anchored_pipeline_trial --joint` | 48 records, **108/108 pieces**, 2 elements ambiguous | no |
| colour confirmation | `placement_element_bridge` | **0 proposals, 0 confirmations** | no |
| slot assignment | `global_pdf_slot_assignment` | 68 callouts, 105 pieces, 101 unambiguous | no |
| page-scoped allocation | `placement_slot_adapter` | **refuses 6 pages**; 83 of 108 pieces drivable | **yes - the page scope is a human choice** |
| opening body | `placement_construct_body` | see below | no |
| the chain | `placement_autodrive` | see below | no |

**The whole attended cost is one decision: which pages to drop.** Everything
else is a command. But that decision costs 25 of 108 pieces before a single pose
is searched, so the pipeline's *allocation ceiling* on a fresh fixture is
**77%**, and that is a property of the fixture rather than of the driver.

### 41601's ambiguity is a different class from 40377's, and colour cannot touch it

40377 reached zero unresolved rows with `--color-constraints` and one ambiguous
piece. 41601 has four ambiguous pieces and **`--color-constraints` changes
nothing**, because the ambiguity is not about colour at all:

| page | qty | candidates |
| ---: | ---: | --- |
| 8, 17, 21 | 1 each | `15573`:72 / `3794a`:72 / `3794b`:72 |
| 10 | 1 | `4032a`:25 / `4032b`:25 |

These are **mould variants of one physical part**. Their universal CAD bounding
boxes are identical to the LDU (`15573`/`3794a`/`3794b` all span
[-20,-4,-10]-[20,8,10]; `4032a`/`4032b` both [-20,-4,-20]-[20,8,20]) and differ
only in under-the-plate tube geometry - 172, 188 and 220 triangles for the same
outside. No drawing can separate them and no colour evidence can either, so the
slot adapter is right to refuse them and no amount of pixel evidence will change
that. Two further rows are lost upstream for unrelated reasons: page 5 has a
callout the assignment could not match to any inventory slot, and page 19 an
"ambiguous artwork association" between two crop components.

**The principled fix is an equivalence class, not better evidence.** A
mould-variant group whose external CAD agrees within tolerance is one search
candidate with several legal names; resolving it by geometry rather than by
guessing would recover 4 of the 25 lost pieces on this fixture without emitting
an arbitrary variant as fact. That is a *new* channel this round measured into
existence, and it is filed rather than built.

### The single-page gate: the move fires, the objective improves, the model does not

One page-19 drive from the round-seven window chain's own page-18 body, control
and treatment differing in exactly one flag, both under the deterministic
tie-break.

| | control (`--compound-width 0`) | treatment (`--compound-width 8`) |
| --- | ---: | ---: |
| emitted | 58 | 58 |
| **structural** | **51** | **51** |
| authoritative-alias | 35 | 35 |
| raw strict | 29 | 29 |
| best native score | 0.532679984 | **0.534664523** |
| native renders per start | 79-153 | 151-203 |
| single-swap rejections per pass | 32-34 collision, 102-182 connectivity | 16-87 collision, 104-186 connectivity |
| legal compound assemblies found | - | 64-70 per pass |
| compound moves **taken** | - | **1 per start, every start, every view** |

**The control reproduces the chain exactly** (58/51/35/29 against the chain's own
page-19 row), so the gate is measuring what it claims to.

**And the treatment is the clearest demonstration this program has produced that
the objective is the problem.** The compound move is not marginal: it fires on
every start of every view, it is the *first* move the pass takes each time, and
it raises the selection score by +0.001985 - more than the window ordering was
worth on this page. The emitted assembly changes substantially (indices
`[383, 698, 704, 708, 714, 1385]` to `[490, 522, 698, 722, 725, 1226]`, four of
six placements different). **Not one additional pose is correct.** A strictly
larger legal search space, searched with a strictly better move set, returns a
strictly better-scoring assembly that is exactly as wrong.

Two honest caveats, both recorded rather than buried:

* the 64-render budget was **exhausted on every pass** (`budget_exhausted: true`,
  against 64-70 legal compound assemblies enumerated per pass and 130-200
  rejected window entries), so the compound reach was truncated. The move that
  *was* taken was found inside that truncation;
* the probe predicted +1 from a different start - the round-five run's page-19
  assembly - and the window chain's page-19 start already contains the correct
  `41740` the probe's start lacked. A prediction made from one local optimum does
  not transfer to another, and that is a limitation of the probe, not a failure
  of the prediction. It is also the third independent observation this round that
  what a search improvement finds depends on which wrong assembly it starts from.

### Round eight's whole-chain result on 40377: 54/90 to **51/90**

Same base checkpoint, same 17-page scope, same allocation, same deterministic
tie-break as round seven's window chain. One flag differs.

| | round seven (window) | **round eight (window + compound)** |
| --- | ---: | ---: |
| emitted | 79 | 79 |
| **structural** | **54** | **51** |
| authoritative-alias | 38 | 35 |
| raw strict | 32 | 29 |
| precision | 0.684 | 0.646 |
| coverage | 0.600 | 0.567 |
| pages with a tie among different assemblies | 9 of 13 | 9 of 13 |
| widest tie | 12-way | 4-way |

**The chain lands three poses lower, and unlike round six's regression this one is
attributable.** Both chains are deterministic, both hold the same tie-break, and
page 19's two assemblies are not tied - the compound one scores **0.534665**
against the control's **0.532680**, a genuine 0.002 preference by the objective
that selects. The mechanism is then exactly round six's:

| page | round seven | round eight |
| ---: | --- | --- |
| 19 | `drawing_to_drawing` 1.6916, score 0.5327, **51 structural** | `drawing_to_drawing` 1.6916, score 0.5347, **51 structural** |
| 22 | `drawing_to_drawing` **1.6916**, 0.3738 | `body_template` **1.4863**, 0.2583 |
| 23-30 | 1.6916 throughout; 52 at p28, **54** at p29 | **1.5010** throughout; **51** frozen from p19 |

Page 19 itself is a wash - the compound move changes four of six placements and
the correct count does not move - and then page 22 falls off
`drawing_to_drawing` onto a `body_template` registration at the wrong scale,
every later page inherits 1.5010 instead of 1.6916, and the three poses round
seven gained at pages 28-29 never arrive. Pages 22 to 30 add 21 parts and **not
one correct pose**, which is the third time this program has recorded that
signature.

**So the honest track-one number is 51/90, and the honest reading is stronger
than "the lever was worth nothing".** A strictly larger legal search space,
searched with a strictly better move set, found a strictly better optimum of the
selection objective - and the model got **worse**. That is not an
under-optimisation result and no further search work addresses it. It is direct
evidence that the objective is misspecified.

The measured expectation was +1 and the delivered result is -3. Both are inside
the same finding: the probe's +1 was measured from a different local optimum, and
the -3 is the chain's camera path reacting to a better-scoring page-19 body. The
prediction protocol round seven introduced held for the mechanism (6 of 7
reachable, exactly as designed) and failed for the outcome, because a page's
contribution to the chain is not a function of that page's objective value.

**`--compound-width` therefore ships off by default.** It is correct, tested and
journalled, and on this fixture turning it on costs three poses.

### 40377's number is mostly inherited, and that reframes every fixture comparison

Evaluating each fixture's **starting checkpoint** against its own reference, which
this program had not done:

| fixture | base structural | final structural | **the drive's own contribution** | placed pages |
| --- | ---: | ---: | ---: | ---: |
| 40377 (round seven, window) | **45** | 54 | **+9** | 13 |
| 41624 (round seven, window) | 3 | 6 | **+3** | 31 |
| 41601 (round eight, in flight) | 3 | 3 at page 9 | **+0 so far** | 5 |

**Forty-five of 40377's fifty-four correct poses were already in the checkpoint
the chain starts from.** That checkpoint was built by rounds one and two over
pages 1-15, page by page, with a diagnostic pass per page - not by the autonomous
driver over a whole booklet. Every number this program has quoted for 40377 -
26/90, 46/90, 48/90, 53/90, 54/90 - is that inheritance plus a single-digit
driven contribution, and the ladder's "79 of 90" ceiling is a ceiling on the
inherited body plus emission, not on the driver.

So the answer to the breadth plan's own question - *which failure stage is
typical, and does it depend on a property of the set we can measure before
driving it?* - is that the failure profile is **consistent**, and the property
that separated the two existing fixtures was never a property of the set at all.
Controlled for the checkpoint, all three fixtures do the same thing: an
autonomous page-by-page drive contributes **single-digit** correct poses and then
stops gaining, whatever the family, the part count, the colour variety or the
page shape. 41601 is a near-identical BrickHeadz to 40377 and behaves like
41624.

### 41601 driven end to end: 3/108, and the 17 driven pages add zero correct poses

Round seven's adopted configuration exactly - deterministic pose tie-break,
`own_agreement` exchange window, `--compound-width` off so the fixture stays
comparable with the other two - from the page-2 construction over the 18-page
scope the slot adapter allowed.

| checkpoint | page 3 | page 9 | page 14 | page 24 | final (after retries) |
| --- | ---: | ---: | ---: | ---: | ---: |
| emitted | 11 | 32 | 51 | 70 | **77** |
| **structural** | **3** | **3** | **3** | **3** | **3** |

77 emitted against 108, coverage **0.028**, precision **0.039**, and **13 of 17
placed pages end in an exact tie among genuinely different assemblies** - the
highest per-page tie exposure of the three fixtures. The three correct poses are
the construction's own; the seventeen driven pages add **74 parts and not one
correct pose**.

### The three population tables, side by side

`placement_population_table`, one primary class per unplaced reference part:

| fixture | truth | correct | emitted | out of scope | allocation blocked | unreachable | visibility limited | mis-selected |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 40377 | 90 | 53 | 79 | 3 | 10 | **8** | 4 | 12 |
| 41624 | 109 | 5 | 75 | 18 | 10 | **60** | 3 | 13 |
| **41601** | **108** | **3** | **77** | **24** | **3** | **66** | **7** | **5** |

**41601 reproduces 41624 and not 40377**, which is the answer the breadth plan
was built to get: `unreachable` is 63% of 41601's failures and 58% of 41624's,
against 9% of 40377's. Combined with the checkpoint measurement above, the two
readings are one reading - 40377's `unreachable` share is small *because* its
inherited body already holds 45 of the model, so few reference poses are left for
its late pages to enumerate.

**And `unreachable` on a from-scratch fixture is mostly a cascade, not an
independent enumeration defect.** The closure enumerates poses attached to the
*current body*; 41601's body is already wrong at page 3, so from page 4 onward no
page's bank can contain the reference pose. One wrong opening converts most of the
model into `unreachable` by construction. That is why the class is 66 on the
fixture that gained nothing and 8 on the fixture that started from a good body.

### 41601's retention table, and the pooled gap over three fixtures

| | 40377 | 41624 | 41601 |
| --- | ---: | ---: | ---: |
| distinct reference targets | 32 | 78 | 78 |
| in bank | 24 | 18 | **12** |
| survived the screen | 23 | 11 | **9** |
| in some retained assembly | 10 | 4 | **1** |
| screened and in no retained assembly | 14 | 7 | **8** |
| of those: search missed a better assembly | 4 | 0 | **1** |
| of those: the objective prefers another pose | 7 | 3 | **4** |
| of those: no legal one-swap | 3 | 4 | **3** |

Its three structural instances are all reachable by a two-placement exchange and
**none** improves the objective (-0.0093 to -0.0249). Pooled over all three
fixtures, with both probe kinds and per distinct instance:

| | instances | with a legal edit | the objective would take | it prefers its own |
| --- | ---: | ---: | ---: | ---: |
| 40377 | 14 | 14 | 5 | 9 |
| 41624 | 7 | 6 | 0 | 6 |
| 41601 | 8 | 8 | **1** | 7 |
| **pooled** | **29** | **28** | **6** | **22 (78.6%)** |

Three fixtures, three families of failure stage, one constant: **on 22 of the 28
losses a legal edit can reach, the objective that selects scores the reference
below what the run already chose.** Five of the six exceptions are on 40377 page
19. The share did not fall when a third, independently chosen fixture was added -
it rose.

## The round-eight strategy memo

### Is any further image-scoring investment rational? No, and the evidence is now direct

Three independent lines, all measured this round, all pointing the same way:

1. **A better optimum produced a worse model.** The compound chain found a
   strictly better-scoring page-19 assembly (+0.002 on the objective that
   selects, not a tie) and the chain lost three poses (54 to 51). This is not
   "the lever bought nothing"; it is the objective's gradient pointing away from
   the model.
2. **78.6% of reachable losses are already objective preferences**, over three
   fixtures, and the share rose when the third was added. No traversal,
   retention, budget or move-set change touches any of them by construction.
3. **The remaining upside is five parts on one page.** Every instance a better
   search could convert is concentrated on 40377 page 19 - one page, one fixture,
   out of 61 placed pages across three fixtures.

So the answer to "does any image-scoring investment remain rational" is **no, not
as a ranking or search investment**. The one image-side question still open is
*different in kind*: the objective is a single-view, per-class depth-composite IoU
over one page's drawing, and its measured pathology - a candidate whose pixels are
already painted with the same class contributes nothing, so a wrong piece standing
in the right place is invisible - is a property of that *formulation*, not of how
it is optimised.

### What the next architecture has to be, in measured priority order

**1. The opening, not the objective (the largest class by far).** 41601 and 41624
lose 63% and 58% of their models to `unreachable`, and that class is a cascade
from a wrong body in the first pages. 40377's own 45-pose base was built by hand,
page by page, and is the only reason its numbers ever looked different. Nothing in
the current architecture verifies or repairs an opening; the driver commits page 3
and never revisits it ("Selected checkpoints freeze earlier poses; no global
backtracking", the journal's own limitation). This is where a 90% target lives or
dies, and it is not a scoring problem - it is the absence of backtracking over a
decision the whole chain inherits.

**2. Evidence that is not the drawing's pixels.** In measured order of what the
instruments actually carry:

* **BOM / inventory-capacity constraints as a likelihood, not a filter.** The
  allocation is already exact per page and per key and currently constrains
  cardinality only. 41601's `4070`:72 is the worked example - seven of its eight
  retention losses are one part in one colour whose instances the objective cannot
  tell apart, and the inventory says exactly how many go where.
* **Connector-graph likelihood.** The witnessed support graph is computed for
  every candidate pair and used only as a legality predicate. Turning it into a
  score rescores assemblies already retained, so it is the cheapest experiment
  available. The honest caveat is that its partially-built form
  (`placement_seated_contact`, `--seated-tolerance`) measured
  **non-discriminating** on the one case it was built for, and that module's own
  docstring records a retracted 16% claim. It is a lead, not a plan.
* **Multi-view / cross-page consistency.** The same piece is drawn on several
  pages at different cameras and the objective scores each page independently.
  40377 page 19's own tie - one `25269` in two image-indistinguishable quarter
  turns, identical to sixteen significant figures - cannot be resolved within one
  view by any amount of scoring, and 13 of 17 pages on 41601 end in such a tie.

**3. The on-ramp, which is cheap and currently costs more than the search does.**
41601 lost 25 of 108 pieces before a pose was searched, four of them to
mould-variant ambiguity an equivalence class resolves without guessing. That is a
larger number than anything the search has delivered on any fixture.

### Is 90% reachable under this architecture? On the measured evidence, no

Stated as plainly as the numbers allow:

* the best whole-model result in the program is **54 of 90 (60%)** on the one
  fixture whose opening was hand-built, of which **9** came from the driver;
* both fixtures driven from their own construction land at **6 of 109 (5.5%)** and
  **3 of 108 (2.8%)**;
* the driver's own contribution, measured on three fixtures, is **+9, +3, +0**
  correct poses over 13, 31 and 17 placed pages.

A 90% target requires roughly 97 correct poses on 41601. The architecture as
driven produces **zero** after the opening. That gap is not closed by any lever
this program has costed, and the round's own attempt to close it with a strictly
better search made one fixture worse. **90% is not reachable under this
architecture**, and the honest reframing is that the *reachable* target for an
autonomous page-by-page image-scored driver is what it has demonstrated: a correct
opening plus single digits.

The remaining breadth fixtures - 3, 4 and 5 in the plan, the flat baseplate, the
sub-assembly set and the clean-colour set - are **no longer the priority**. Their
purpose was to decide whether the failure profile is consistent, and three
fixtures already answer that: it is consistent once the checkpoint is controlled
for. A fourth and fifth confirmation of a twice-confirmed finding is not worth a
week. The next round should attack **the opening, with backtracking**, and measure
it on 41601 and 41624 - the two fixtures that start from nothing and therefore
actually test it.

### Round eight's trajectory

| round | 40377 | 41624 | 41601 | what the round bought |
| ---: | ---: | ---: | ---: | --- |
| 6 | 53/90 | 5/109 | - | the population, three channels not adopted |
| 7 | 54/90 | 6/109 | - | affordable closure, deterministic ties, retention is the smallest lever |
| **8** | **51/90** | 6/109 (predicted +0) | **3/108** | **the two-placement move, built and measured negative; 45 of 40377's 54 shown to be inherited; the objective measured wrong on 78.6% of reachable losses over three fixtures** |

Round eight's number is **-3**, and that is the most useful number the program has
produced. It is the first time a strictly better optimum of the selection
objective has been shown to make the model strictly worse, on a deterministic
A/B, and it is what closes the search era of this work.

## Round nine: the opening, with backtracking, and what the inventory cannot say

Round eight's memo named two investments in priority order - page-level
backtracking over the opening, and inventory capacity as the first non-pixel
evidence - and a checkpoint: if the two together move the from-scratch fixtures'
driver-own-contribution by less than about +10 each, the next tier gets a costed
plan rather than an implementation. Both were built. This section is what they
measure.

### Before any policy: what the retained sets actually contain

Page-level backtracking can only ever reach an assembly the page's own search
retained, and every one of those is already on disk - `beam_NN.ldr`, ranked,
with the objective score that ranked it. `placement_alternatives_oracle` scores
all of them against the reference. No GPU, no re-search, five minutes of CPU per
fixture, and it decides where a budget belongs before an hour is spent on one.

| fixture | placed pages | retained bodies per page | pages whose retained set holds a better body | summed page-level reachable delta | pages ending in an exact tie | widest tie |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 41601 | 17 | 12-39 | **2** | **+2** | 13 | 8 |
| 41624 | 31 | 12-44 | **1** | **+1** | 20 | 12 |

**Fifteen of 41601's seventeen driven pages retain nothing better than what was
selected**, and thirty of 41624's thirty-one. On those pages every retained body
- up to 44 of them - carries exactly the same correct poses as the one the
objective picked. This is round seven's "retention is the smallest lever" in a
stronger form: it is not that the ranking is wrong inside the retained set, it
is that the model is not in the retained set at all.

The **openings** are a different matter, and the two fixtures differ:

| construction | retained | distinct | selected | best retained | rank of the best | objective gap | top-tie width |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 41601 (7 pieces) | 36 | 36 | **3 of 7** | **6 of 7** (twelve bodies) | 24 | **0.0132** | **24** |
| 41624 (3 pieces) | 36 | 36 | **3** | 3 | 0 | 0 | 2 |

41601's opening search has something to reach and 41624's does not: its
construction already selected the best body it retained. 41601's is the sharper
statement - the objective's top plateau is a **24-way exact tie**, every member
of which is 3 of 7 correct, and the twelve bodies at 6 of 7 sit in a second
exact tie 0.0132 below it. No tie-break reaches them; a preference reversal
worth 2% of the objective does.

### Backtracking, built

`placement_backtrack.py` reopens a committed site, takes an alternative, and
re-drives forward. Four decisions carry the design:

* **The branch set is the objective's own indifference classes.** Branching on
  retained bodies would make 36 branches of 41601's construction; branching on
  exact-score classes makes **two**, and the structural spread inside every
  censused class is zero, so the collapse loses nothing measurable. Every class
  and its width is recorded.
* **A reopened site costs no re-search.** `derive_base` writes the alternative
  as a checkpoint's `model.ldr` and reorders the retained list so the
  alternative is first, because `registration_of_run` seeds drawing-to-drawing
  propagation from `results[0]`'s view - a branch has to propagate from the
  camera its own body was scored at, or the reopening changes two things.
* **A reopened site is strictly earlier than the page that raised the trigger.**
  Every trigger is a statement about an inherited body, so the page that reports
  one cannot be the page that caused it.
* **Selection is runtime-legal**: more of the booklet placed, then more pieces
  emitted, then fewer instrument contradictions, then the mean page score. The
  reference is read afterwards, by the oracle, and never chooses a branch.

`--reuse-root` adopts a completed run as branch 0 after verifying its page
scope, its whole option set and its base-model hash, so a measurement does not
pay for its own baseline twice.

### The triggers fire once in four completed journals

| journal | registration_collapse | refusal_run | score_trend | capacity_violation |
| --- | :-: | :-: | :-: | :-: |
| 40377 round seven (window) | - | - | - | - |
| 40377 round eight (compound) | **page 22** | - | page 22 | - |
| 41601 round eight | - | - | - | - |
| 41624 round seven | - | page 37 | - | - |

`registration_collapse` is a body-template fallback that *also* moves the camera
scale past the gate's own tolerance. Both halves are load-bearing: a
body-template fallback at a stable scale happens on three of 40377's pages and
three of 41624's and is harmless. The one firing is round eight's measured
regression exactly. `score_trend` fires on the same page but also has to be
silent on round seven's page 22, which fell 30% while gaining three poses; it
cannot separate the two chains and is off by default.

**And 41601 produces no contradiction at all.** Seventeen placed pages, all
`drawing_to_drawing`, registration IoU 0.73 to 0.98, a camera scale that moves
monotonically from 1.10 to 1.27 px/LDU - a healthy-looking run carrying a
3-of-108 body. A wrong opening is **silent** under every instrument the driver
has. That is the finding that shapes the round: a trigger-driven backtracker
would never fire on the fixture that most needs one, which is why the
unconditional opening search (`--backtrack-triggers always`) exists at all.

### Inventory capacity: three claims, three measurements, and no lever

The brief's second investment is the BOM as a likelihood. `placement_capacity`
keeps three claims apart, because two of them are provably vacuous as a ranker
and saying which is the result.

**1. Count capacity cannot rank two assemblies of one page.** The page
allocation is exact per key, the search enforces that quota, and every retained
assembly therefore uses the identical multiset. Measured on 41601: 34 of its 46
unambiguous keys have their *whole* pool allocated inside the driven scope, and
every driven page emitted its whole allocation (the journal's per-page piece
deltas match the allocation on all 17). Two candidates of one page are
count-identical by construction.

**2. The draw-down audit finds nothing on this fixture.** Consuming the pool page
by page in scope order, no page overdraws a key and no allocated key is missing
from the inventory: **zero deficits**, so `capacity_violation` never fires on
41601. The audit is still the right shape - it is a statement about the whole
run rather than about one pose, so it belongs in the trigger set - but it is
silent here, which makes it the fourth instrument that cannot see a 3-of-108
body.

**3. The look-ahead is constant across every candidate.** `capacity_of_body`
asks what the rest of the booklet still needs and counts, per key, the
collision-free connector mates the committed body offers and the distinct
one-stud lattice cells they occupy - round six's non-chaining measure. Over
**75 candidate bodies on two sites**:

| site | candidates | deficient keys | total deficit | minimum slack | remaining locations |
| --- | ---: | ---: | ---: | ---: | --- |
| 41601 construction (76 pieces still to place) | 36 | **2 on every one** | **2 on every one** | -1 | 1899-2018 |
| 41601 page 3 (72 pieces still to place) | 39 | **2 on every one** | **2 on every one** | -1 | 2205-2564 |

The two deficient keys are `98138` and `98138pb072` on every body, because
neither has a base-attached mate on a small body at all - they mate onto a piece
a later page adds. That is round six's own recorded caveat reproduced exactly,
and it means the deficits carry no information about the candidate.

The one term that does vary is the total remaining locations, and it is worse
than useless:

| site | correct-class bodies | wrong-class bodies |
| --- | --- | --- |
| construction | 6 of 7: mean **1901** locations (1899-1905) | 3 of 7: mean **1964** (1910-2018) |
| page 3 | 4 correct: mean **2320** (2235-2426) | 3 correct: mean **2343** (2205-2564) |

On the construction the two classes are perfectly separated **in the wrong
direction** - the correct opening leaves *less* remaining capacity, so a
"more capacity is better" rule picks the wrong class every time. And the
inverted rule that would have looked so good on that one site is refuted by the
second: on page 3 the ranges overlap almost completely and both extremes -
most capacity and least capacity - are wrong-class bodies. One site would have
produced a confident wrong law; two sites produce the honest answer.

`rank(candidates, band)` applies the term the way the brief specifies, inside a
stated band below the best score so it can break a tie and can never override
image evidence. Its measured effect on both sites, at every band up to and
beyond the 0.0133 the construction would need: **zero reorderings**.

**The worked case the brief named, `4070`:72, resolves the same way.** Seven of
41601's eight retention losses are that one part in that one colour, its
inventory pool is 17 and the pages draw 4, 4, 4 and 1 of it, and every one of
those allocations is exact. The inventory says exactly how many go where - and
it says the same thing to every candidate assembly on the page, because they all
place four. What it cannot say is *which four locations*, and that is the whole
question.

### The mould classes: one capacity pool, not one search candidate

Round eight filed the equivalence class as the cheap on-ramp lever and predicted
it would recover four pieces. Measured rather than assumed, with the pipeline's
own representations:

| class | universal bounds | max difference | 4 LDU voxels | eroded cores | connector sets | disposition |
| --- | --- | ---: | --- | --- | --- | --- |
| `15573`/`3794a`/`3794b` | identical | **0.0 LDU** | 176 / 191 / 175 (symmetric difference 29, 13) | 37 / 36 / 36 | differ | pool, not identity |
| `4032a`/`4032b` | identical | **0.0 LDU** | 254 / 256 (symmetric difference 2) | 44 / 48 | differ | pool, not identity |

So the memo's premise is confirmed exactly - the outsides agree to the LDU, with
zero difference - and its proposed conclusion is not. `Assembly.candidates` and
`Assembly.collides` read the voxel set and the connector set, and both differ,
so the search cannot treat these names as one candidate; the *inventory* can,
because the piece, its colour and its count are known and only the filename is
not. Pooling them closes 41601's inventory completely: 46 keys and 104 pieces
with 4 ambiguous becomes **48 keys and 108 pieces with none**.

The scope this buys is far larger than the four pieces, because a refused row
refuses its whole page:

| policy | drivable pages | allocated pieces | withheld, declared | allocation ceiling |
| --- | ---: | ---: | ---: | ---: |
| `refuse` (round eight) | 19 | 83 | 0 | 76.9% |
| `withhold` | **23** | **92** | 4 | **85.2%** |
| `canonical` | 23 | 96 | 0 | 88.9% |

**The same class blocks 40377, and was worked around by hand a round at a time.**
Its inventory has exactly one ambiguous slot and it is `4032a`/`4032b` again -
the record round one dropped, then recovered by preserving one capacity and both
mould ids, then resolved by building **two hand-made construction branches** for
page index 13 whose poses agree and whose mould identity does not. So this is a
recurring structural blocker across both BrickHeadz fixtures rather than a
property of 41601, and the proven table handles it without a branch pair.

`withhold` declares the class row without allocating it: the page's other pieces
are drivable, the withheld piece's ink is attributable at the camera gate
(`placement_autodrive.page_withheld`, the same mechanism a skipped page's pieces
use - without it the gate would refuse the page one stage later for a reason
that has nothing to do with its camera), and no filename is ever guessed.
`canonical` allocates the class under its canonical member and records that the
name is a coin flip inside a proven-equivalent class. Nine allocated pieces for
no guess is the honest default, and it is a larger number than any search-side
lever this program has delivered on any fixture.

### Three drives, and the predictions made before they ran

The program's prediction protocol: state the expectation from the probe, then
drive, then record both. All three configurations differ from their own
already-completed baseline in the backtracking flags alone, and each adopts that
baseline as branch 0 after a hash-and-option check.

| drive | site reopened | what the probe says is there | prediction |
| --- | --- | --- | --- |
| **41601 opening search** (`--backtrack-triggers always --backtrack-order base-first`) | the construction, class 1 of 2 | a 6-of-7 opening against the selected 3-of-7, 0.0132 of score below it | The cascade claim says a correct opening puts later reference poses back inside the enumerated banks. If it holds, the chain should end well above the +3 the opening itself supplies; if it does not, the driver's own contribution stays single-digit and the chain lands near 6-9 of 108. |
| **40377 validation** (`--backtrack-triggers registration_collapse --backtrack-order nearest`) | page 19, class 1 of 8 | 51 structural selected, and the next class is **50** - one *worse* | The policy has no access to that number. It reopens because page 22 collapsed. The branch starts one pose down and recovers only if pages 22-30 keep `drawing_to_drawing` at 1.69 px/LDU: about 53 if the collapse is avoided, about 50 if it recurs. Round eight's chain scored 51. |
| **41624 ceiling probe** (`--force-reopen 3=3`) | page 3, class 3 of 6 | the one retained body on the whole fixture with a fourth correct pose | A policy would need three branches to reach it, so this measures the ceiling rather than the policy. If a +1 opening propagates, the chain ends above 6 of 109; if the failure is downstream of the opening, it ends at 6 or 7. |

### 41601's opening search: the model doubles, the driver still contributes nothing

Branch 0 is round eight's drive, adopted after a hash-and-option check. Branch 1
is the same 18-page scope, the same options, driven from the construction's
second score class - the 6-of-7 opening the objective ranked twenty-fourth.

| | branch 0 (round eight's opening) | **branch 1 (the 6-of-7 opening)** |
| --- | ---: | ---: |
| opening structural | 3 of 7 | **6 of 7** |
| pages placed | 17 | 16 |
| emitted | 77 | 75 |
| **final structural** | **3 of 108** | **6 of 108** |
| coverage | 0.028 | **0.056** |
| precision | 0.039 | **0.080** |
| **driver-own contribution** | **+0** | **+0** |
| pages ending in a tie | 13 of 17 | 11 of 16 |
| mean page score | 0.5152 | 0.4910 |

**The model doubles and the drive still adds nothing.** Branch 1's structural
count is 6 at page 3 and 6 at page 27, unchanged across all sixteen driven
pages, exactly as branch 0 held 3 across seventeen. Every correct pose in either
chain came from its opening.

That is a direct refutation of round eight's own reading of the `unreachable`
class. The population table says where the difference went:

| class | branch 0 | branch 1 | change |
| --- | ---: | ---: | ---: |
| correct | 3 | **6** | +3 |
| unreachable | 66 | **58** | **-8** |
| mis-selected | 5 | **15** | **+10** |
| visibility limited | 7 | 3 | -4 |
| out of scope | 24 | 22 | -2 |
| allocation blocked | 3 | 4 | +1 |

Round eight said "41601's body is already wrong at page 3, so from page 4 onward
no page's bank can contain the reference pose", and treated `unreachable` as a
cascade a correct opening would unwind. Measured: a substantially correct
opening unwinds **eight** of the sixty-six, and **ten** reference instances move
from `unreachable` straight into `mis_selected` - the bank now holds the right
pose and the run picks another one. Fixing the opening converts unreachable into
mis-selected, not into correct.

**And the runtime-legal selection rule chose the worse branch.** Branch 0 placed
one more page and emitted two more pieces (its retry pass recovered page 15,
which branch 1 never placed), so `downstream` ordered it first - selecting a
3-of-108 model over a 6-of-108 one. Every term in that rule is honest and none
of them can see the model. The mechanism reached a better body; the criterion
could not identify it. That is round eight's finding in a new place: not the
image objective this time, but every runtime-legal proxy the driver has.

### 40377's validation: the policy fires, reopens the right page, and recovers +2

The only chain in the program whose journal contains a contradiction. The
trigger fired exactly where round eight's regression is: page 22, a
`body_template` fallback at 1.4863 px/LDU against page 19's 1.6916, a **-12.1%**
camera-scale move and a **-51.7%** score move. `nearest` reopened page 19 - the
latest committed page strictly before the trigger - and took its second score
class, which the oracle says is one pose **worse** than the one the run had.

| | round seven (window) | round eight (window + compound) | **round nine (+ backtracking)** |
| --- | ---: | ---: | ---: |
| page 19 structural | 51 | 51 | **50** (the reopened class) |
| page 22 registration | `drawing_to_drawing` 1.6916 | `body_template` **1.4863** | **`drawing_to_drawing` 1.6749** |
| page 22 score | 0.3738 | 0.2583 | **0.3797** |
| emitted | 79 | 79 | 79 |
| **final structural** | **54** | **51** | **53** |
| coverage | 0.600 | 0.567 | **0.589** |

**The mechanism works end to end.** Starting one pose down, the branch avoided
the collapse, and pages 28 and 29 delivered the +1 and +2 that round eight lost
- 50 to 53 - recovering two of round eight's three-pose regression. The
prediction registered before the drive ("about 53 if the collapse is avoided,
about 50 if it recurs") held.

**And the selection rule chose the losing branch again.** Both branches placed
thirteen pages and emitted seventy-nine pieces, so `downstream` fell through to
its next term - camera failures - where the root scores 0 and the repaired
branch scores 2, because pages 26 and 27 needed the retry pass in the branch and
not in the root. It selected 51 over 53.

Twice now, on two fixtures, the mechanism reached the better model and the
runtime-legal criterion refused it. Ordering the terms the other way round -
instrument contradictions before coverage - would have selected correctly on
both: 40377 on the registration collapse (0 against 1), 41601 on the camera
failures (1 against 2). That rule is in the module as `contradictions`, and it
is **fitted to two observations**; it is a hypothesis the next round can test on
a fixture it was not derived from, not a validated criterion.

### The opening is selectable without the drawing, and the channel already existed

The capacity probe asked whether a non-pixel signal separates 41601's two
opening classes and answered no. A second non-pixel signal does, and it was
built in round six for a different fixture: `placement_construction_symmetry`
ranks a construction's retained candidates by the bilateral plane agreement each
one reaches **on its own parts**, reading nothing but the candidate assemblies
and universal CAD.

| 41601 construction | bodies | objective score | plane agreement | eligible parts matched | structural |
| --- | ---: | ---: | ---: | ---: | ---: |
| score class 0 | 24 | 0.650320 | **0.600** | 3 of 5 | 3 of 7 |
| score class 1 | 12 | 0.637095 | **1.000** | **5 of 5** | **6 of 7** |

The separation is total and it is on the right side: every body the image
objective put on its 24-way top plateau is bilaterally *incomplete*, and every
body in the class it demoted by 0.0132 is bilaterally complete. Ranking by plane
agreement first selects `beam_24` - the same body the backtracking branch drove -
and the delta is **+3, equal to the oracle best**.

So the whole chain is runtime-legal end to end: construct, rank the retained
constructions by their own symmetry, drive. That is 41601 at **6 of 108** with no
reference anywhere in the loop, and it costs one CPU minute rather than a second
drive - the backtracking branch was how the opening's value was *measured*, and
the symmetry channel is how a production pipeline would *choose* it.

Three constructions have now been measured with this channel and it has never
been negative: 40377 page 20's head **+1** (three eligible parts, round six),
41624's three-piece opening **+0** (one eligible part - it abstains, and the run's
own pick was already the best body it retained), 41601's seven-piece opening
**+3** (five eligible parts). The discrimination scales with the number of
mirror-eligible parts, which is the honest way to read it and the reason the
eligibility count is printed beside every fraction.

### The next tier, costed rather than built

Round eight's checkpoint: if backtracking and capacity move the from-scratch
fixtures' *driver-own contribution* by less than about +10 each, the next tier
gets a costed plan. Measured, that contribution moved by **+0 on 41601** - the
drive adds nothing from either opening - and capacity produced **zero**
reorderings and **zero** deficits. The checkpoint is not close, so the tier below
is costed and not built. Each item states the probe that would decide it and the
rule for stopping.

**1. Multi-view / cross-page consistency - the highest-value untested item.**
41601's 24-way exact tie is a single-view artefact and can be shown to be one:
the 24 bodies are geometrically distinct (any two share on average **3.5 of 7**
placements, as few as 2), the four `3005` bricks alone occupy seven different
positions inside the tie, and the objective scores every one of them identically
to sixteen significant figures. The next page draws the same assembly from a
camera the driver already computes. *Probe*: re-score the construction's 36
retained bodies against pages 3 and 4 under those pages' accepted registrations
and ask whether the tie breaks, and in which direction. ~72 GPU renders,
minutes. *Cost*: two to three engineering days, because a candidate has to be
rendered under a registration belonging to a page it was not searched at.
*Adopt if*: the multi-view score ranks 41601's 6-of-7 class above its 3-of-7
class **and** leaves 40377 page 19's selection where it is. *Stop if*: the tie
survives, which would say the pathology is the per-class IoU formulation rather
than the single view.

**2. Connector-graph likelihood - cheap, and with a measured ceiling that argues
against it.** Turning the witnessed support graph from a legality predicate into
a score rescores bodies already on disk: no GPU, no re-search, and
`placement_capacity.probe_directory` is the harness shape it needs. *Cost*: one
day, ten CPU minutes to run. *But its ceiling is now measured*: on driven pages
there is nothing for any rescoring to reach - 15 of 17 retained sets on 41601 and
30 of 31 on 41624 contain nothing better than what was selected - so its whole
reachable upside on the two from-scratch fixtures is **+2 and +1**, plus the
openings, where the symmetry channel already reaches the oracle best. *Adopt
if*: it separates the correct class on at least two of the three censused sites.
The prior is poor: `placement_seated_contact` measured non-discriminating on the
one case it was built for and its own docstring records a retracted claim.

**3. The branch-selection criterion, which this round created.** The mechanism
now reaches better models than the run selects, twice, and every runtime-legal
rule shipped picked the worse one. `contradictions` would have picked correctly
on both and is fitted to exactly those two observations. *Probe*: one branch pair
on a fixture the rule was not derived from - about one GPU hour, since the
baseline can be adopted. *Adopt if*: it picks the better branch there too.
*Note*: for the opening specifically this may be moot, because the symmetry
channel chooses the opening **before** any branch is driven, which is both
cheaper and measured.

**4. The on-ramp, which this round measured as the largest lever of any kind.**
One equivalence table moved 41601's drivable scope from 83 pieces to 92, against
search-side levers worth +1 to +3. The remaining refusals on that fixture are
identity and association failures rather than placement failures - page 5's two
callouts that match no inventory slot (costing the page's four allocated pieces)
and page 19's ambiguous artwork association (costing five) - and they are worth
**twelve more pieces of scope**. *Cost*: hours, no GPU. This is where the next
round's first day belongs.

### Where the ten recovered instances stop, measured a second way

The population table says a correct opening moved ten reference instances out of
`unreachable` and into `mis_selected`. `placement_alternatives_oracle` on the
same branch says where they stopped:

| | branch 0 (3-of-7 opening) | branch 1 (6-of-7 opening) |
| --- | ---: | ---: |
| placed pages | 17 | 16 |
| pages whose retained set holds a better body | 2 | **1** |
| summed page-level reachable delta | +2 | **+1** |
| pages ending in an exact tie | 13 | 11 |

So the instances that became reachable entered the page's enumerated **bank**
and never reached a **retained assembly**: 15 of 16 pages still retain nothing
better than what was selected, and the one that does holds a single body one
pose better, at rank 13. Combined with round seven's retention measurement -
bank truncation zero, beam width refuted, the reference-equivalent complete
assembly scoring *below* the beam's own best complete state - the loss is at the
same place it has always been. Making the body right changes which poses are
enumerable and does not change which assemblies the objective keeps.

### The wider scope, driven: nine more pieces, no more correct poses

The mould classes admitted four pages the round-eight allocation refused. Same
construction, same options, `--mould-policy withhold`, one variable.

| | round eight scope | **round nine scope (mould classes admitted)** |
| --- | ---: | ---: |
| pages driven | 18 | **22** |
| pages placed | 17 | **21** |
| emitted | 77 | **86** |
| **structural** | **3** | **3** |
| precision | 0.039 | 0.035 |
| pages ending in an exact tie | 13 of 17 | 16 of 21 |

Pages 8, 10, 17 and 21 placed - the on-ramp lever works end to end, and the
camera gate accepted every one of them with the withheld class piece's ink
attributed rather than charged to the pieces the page adds. They contributed
**nine pieces and zero correct poses**, which is what every other page in this
program's from-scratch drives contributes.

So the three levers this round built are consistent with each other and with the
two before it:

| lever | what it moved | what it did not |
| --- | --- | --- |
| a better opening (41601) | 3 of 108 to **6 of 108** | the drive's own contribution: +0 |
| repairing a collapse (40377) | 51 of 90 to **53 of 90** | the pages after the repair still add poses only where round seven's chain did |
| a wider scope (41601) | 77 emitted to **86** | 3 correct, unchanged |
| inventory capacity | nothing: 0 deficits, 0 reorderings over 75 candidates | - |

Every gain this round came from **choosing a different body**, and none from
driving better. The wide scope was driven from the round-eight opening, so the
two 41601 gains have not been combined; that run is not measured.

### 41624's ceiling probe: thirteen more pieces, five more pages, the same six poses

Its page 3 retains exactly one body with a fourth correct pose, in score class
three - three branches away for a policy that takes classes in order, so this
drive was pointed straight at it with `--force-reopen 3=3` and is recorded as a
ceiling probe rather than a policy result.

| | branch 0 (round seven) | **branch 1 (the +1 page-3 body)** |
| --- | ---: | ---: |
| page 3 structural | 3 | **4** |
| pages placed | 31 | **36** |
| camera failures in the main pass | 11 | **8** |
| emitted | 86 | **99** |
| **final structural** | **6 of 109** | **6 of 109** |
| coverage | 0.055 | 0.055 |
| precision | 0.070 | 0.061 |
| **driver-own contribution** | **+3** (3 to 6) | **+2** (4 to 6) |
| pages ending in an exact tie | 20 of 31 | 24 of 35 |

A better opening bought **thirteen more emitted pieces and five more placed
pages** - the camera path survived on pages the root refused - and **not one more
correct pose**. Both chains reach 6 and stop: the root at page 5, the branch at
page 4. This is the same shape as 41601's, from the opposite direction: body
quality changes what the driver can *place*, never what it places *correctly*.

### The checkpoint, answered on its own metric

Round eight's metric is the drive's own contribution, base checkpoint against
final structural:

| chain | base | final | **contribution** | placed pages |
| --- | ---: | ---: | ---: | ---: |
| 40377 round seven (window) | 45 | 54 | +9 | 13 |
| 40377 round eight (compound) | 45 | 51 | +6 | 13 |
| **40377 round nine (backtracking)** | 45 | **53** | **+8** | 13 |
| 41624 round seven | 3 | 6 | +3 | 31 |
| **41624 round nine (better opening)** | 4 | 6 | **+2** | 35 |
| 41601 round eight | 3 | 3 | +0 | 17 |
| **41601 round nine (better opening)** | 6 | 6 | **+0** | 16 |
| **41601 round nine (wider scope)** | 3 | 3 | **+0** | 21 |

**The checkpoint asked for about +10 each on the two from-scratch fixtures and
got +0 and -1.** Backtracking moved 41601's contribution by nothing at all and
41624's by minus one, and the inventory-capacity term produced zero deficits and
zero reorderings over 75 candidate bodies. The next tier is therefore costed
above and not built.

What the round *did* move is worth stating beside that, because it is not zero
and it is all of one kind:

| | round eight | round nine | by what mechanism |
| --- | ---: | ---: | --- |
| 40377 | 51 of 90 | **53 of 90** | a trigger, a reopening, and a re-drive that avoided the collapse |
| 41601 | 3 of 108 | **6 of 108** | a different opening, chosen by the construction's own symmetry |
| 41601 emitted | 77 on 17 pages | **86 on 21 pages** | the mould-equivalence classes admitting four refused pages |
| 41624 emitted | 86 on 31 pages | **99 on 36 pages** | a different page-3 body |

Every one of those came from **choosing a different body to drive from**. None
came from the drive placing better, and the drive's own contribution is
single-digit or zero on every fixture the program has measured.

### One note on the objective's formulation, recorded and not acted on

Out of this round's scope by the brief, so nothing was changed, but two
measurements bear on it and belong in the record.

* **The top plateau is broad and geometrically real.** 41601's construction ends
  in a 24-way exact tie whose members are *not* relabelings of one assembly: all
  36 retained bodies have distinct placement multisets, any two tied bodies share
  on average **3.5 of 7** placements (as few as 2), and the four `3005` bricks
  alone occupy seven distinct positions inside the tie. A per-class,
  single-view, depth-composite IoU assigns twenty-four materially different
  seven-piece assemblies the same value to sixteen significant figures.
* **The plateau is on the wrong side of a 2% preference.** The bodies it contains
  are 3 of 7 correct and bilaterally incomplete; the class it demotes by 0.0132
  is 6 of 7 correct and bilaterally complete. So the formulation is not merely
  indifferent here - it prefers, and the preference is inverted.

### Round nine's trajectory

| round | 40377 | 41624 | 41601 | what the round bought |
| ---: | ---: | ---: | ---: | --- |
| 6 | 53/90 | 5/109 | - | the population, three channels not adopted |
| 7 | 54/90 | 6/109 | - | affordable closure, deterministic ties, retention is the smallest lever |
| 8 | 51/90 | 6/109 | 3/108 | the two-placement move measured negative; 45 of 54 shown inherited; the objective wrong on 78.6% of reachable losses |
| **9** | **53/90** | **6/109** (99 emitted, was 86) | **6/108** | **backtracking recovers two of round eight's three; a 6-of-7 opening doubles 41601 and the drive still contributes +0; the construction's own symmetry selects that opening with no reference; capacity refuted on 75 bodies; the mould classes are one pool and not one identity, worth +9 pieces of scope** |

The round's most useful number is **+0**. Round eight showed a better optimum of
the objective making the model worse; round nine shows a *materially better body*
- twice as many correct poses, chosen by a channel the reference never touches -
making the model no better than its own opening. The driver does not degrade a
good body; it simply adds nothing to it. Whatever the next architecture is, the
per-page image-scored addition step is not the part that has to be repaired
first: **the parts that pick a body are, and they now demonstrably work.**

## Round ten: the on-ramp, closed; the opening, combined; and what a second view says

Round nine's costed plan put the on-ramp first ("the largest lever of any kind":
one equivalence table moved 41601's scope by nine pieces against search-side
levers worth +1 to +3), the multi-view probe second, and left the two 41601
gains - a symmetry-selected 6-of-7 opening and a mould-pooled wider scope -
never combined. This round runs all three.

### The predictions, registered before any of them ran

Written 2026-09-09 16:40 local, before the combined drive reached page 7 and
before the autonomous drive or the probe started.

| trial | what the prior rounds say | prediction |
| --- | --- | --- |
| **41601 combined** (6-of-7 opening + 92-piece/23-page mould-pooled scope) | branch 1 reached 6/108 from that opening on 18 pages with +0 of its own; the wide scope reached 3/108 on 22 pages with +0 of its own | If the drive keeps contributing +0 the chain lands at **6/108** on about 21 placed pages and 84-88 emitted. Anything above 8 would be the first evidence that scope and opening interact. |
| **41601 autonomous** (zero attended steps, 25 pages, 108 pieces) | the repaired on-ramp reallocates the opening page's plate to `3022`:72 where the reference's steps 1+2 say `3031`:72 | The opening cannot reach 6 of 7 with a wrong piece in it, so **opening <= 5 of 7 and the chain 3-6 of 108**, with the driver at +0. The scope is 12 pieces wider and the opening is worse: this measures which of the two matters. |
| **multi-view probe** (36 bodies, two later pages, two lineages) | round eight and nine both located the failure in the objective's FORMULATION, and a second view scores with the same formulation | The exact tie **breaks** - different pixels give generically distinct numbers - but the two classes are **not cleanly separated with the 6-of-7 class above the 3-of-7 class under both lineages**. A clean separation would be the first evidence that the pathology is the single view rather than the objective. |

### The on-ramp's two association classes, repaired generically

Round nine named them and priced them at twelve pieces of 41601's scope: page 5
"a callout the assignment could not match to any inventory slot" and page 19 "an
ambiguous artwork association between two crop components". Reproduced, they are
two different defects and neither is about inventory matching.

**Page 5 is a translucent part.** Its callout is a trans-light-blue 2x2 round
brick, and the PLI ink threshold (colour distance > 90 from the panel
background) catches only its studs and outline. The part's own body sits at
distance ~46 - between the background's spread and opaque plastic - so the
artwork fragments, and the fragment NEAREST the quantity label is an 8x9 stud.
The crop was that stud, and `canonical` then rejected it because an 8x9 crop of
solid ink has no background border from which to estimate a background.

The repair is a hysteresis GROUPING, not a lower threshold: strong components
that one weak component joins are one candidate, and the reported box is the
union of their **strong** boxes. A part whose strong mask is already one
component is therefore byte-identical, a weak halo is never mistaken for an
edge, and a weak component too large to be one part's artwork groups nothing -
so the white page surround, which is itself far from the PLI background, cannot
merge unrelated callouts. Page 5's crop goes from `[95,63,103,72]` to
`[95,35,130,75]`, the whole brick.

**Page 19 is a solved assignment problem misread as ambiguity.** Its two
candidates score 22.317 and 22.437 - inside the 3px indistinguishability window,
so the anchor was refused - but the second component is already the
unambiguous, uncontested match of a DIFFERENT quantity on the same page at
10.482. One drawn component belongs to one label, so the association is an
assignment, and `crop_items` now solves it as one. An anchor is called ambiguous
only when forbidding its match costs the whole page almost nothing; where a
rival anchor has no substitute, forbidding is expensive and exclusivity decides
it. The case the old post-hoc rule protected - two labels whose artwork merged
into one component - still refuses both, and has its own test.

**Measured before adoption, on a corpus rather than the fixture that motivated
it**: `placement_association_ab` drives every non-inventory page of 13 PDFs
under each configuration and reports the per-anchor transitions.

| configuration | anchors | repaired | broken | boxes changed | boxes identical |
| --- | ---: | ---: | ---: | ---: | ---: |
| fragment grouping only | 788 | 0 | **0** | 4 | 784 |
| exclusive association only | 788 | 2 | **0** | 0 | 786 |
| both | 788 | **2** | **0** | 4 | 784 |
| both + panel geometry | 788 | **3** | 1 | 4 | 783 |

**And the four changed boxes are invisible to the matcher.** `canonical` crops
back to the largest foreground component, so for all three changed boxes that
already worked its output is **byte-identical**; the fourth is 41601 page 5,
which goes from no usable crop at all to a usable one. The one "broken" anchor
under panel geometry is 6191970 page 43, where the baseline had associated the
quantity with the PLI **panel frame** - a 250x158 component of 3% fill - and the
rule correctly refuses it. An honest refusal replacing a wrong crop is not a
regression, and it is the only one in 788.

With the panel rule (which already existed and was simply off) all three
fixtures resolve **every** anchor: 41601 69/70 -> 70/70, 41624 68/69 -> 69/69,
40377 55/55 unchanged.

### The scope is now derived, and the pipeline has no attended step

`placement_slot_adapter --auto-scope` admits every page that carries evidence
and no refused row, and records each excluded page with the rows that refused it
and the pieces that scope loses. `placement_autonomous_run` runs the whole chain
- slot assignment, mould equivalence, allocation, construction, opening
selection, drive - as one command with no human decision in it, and
`placement_construction_symmetry` no longer needs a reference to select an
opening (it never used one to *choose*; it required one to *report*).

| fixture | allocation | pages | allocated | withheld | in scope | of printed |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 41601 | round eight `refuse` | 19 | 83 | 0 | 83 | 76.9% |
| 41601 | round nine `withhold` | 23 | 92 | 4 | 96 | 88.9% |
| 41601 | **round ten, derived** | **25** | **104** | 4 | **108** | **100%** |
| 41624 | legacy element bridge | 37 | 99 | 0 | 99 | 90.8% |
| 41624 | **round ten, derived** | 37 | 100 | 6 | **106** | **97.2%** |

### What the wider scope costs, and the instrument that can see it

A global piece count cannot see an on-ramp regression: the slot solver maximises
`qty x similarity` over a GLOBAL assignment, so two more callouts can reshuffle
identities elsewhere while the whole multiset stays exactly the printed
inventory. `placement_allocation_audit` scores an allocation against the
reference's own step structure by order-preserving alignment - each page in
booklet order takes a contiguous run of steps - because one page is not one step
(41601's page 2 carries the reference's steps 1 AND 2, and a page-to-step
assignment was measured understating a correct allocation by exactly that).

| fixture | allocation | pieces | accounted | fraction | exactly matched pages |
| --- | --- | ---: | ---: | ---: | ---: |
| 41601 | round nine | 96 | 76 | 0.792 | 11 |
| 41601 | round ten | 108 | **80** | 0.741 | 11 |
| 41624 | legacy | 99 | 69 | 0.697 | 19 |
| 41624 | round ten | 106 | **85** | **0.802** | **26** |

**On 41624 the repair is better on every axis** - seven more pieces of scope,
sixteen more accounted, seven more exactly matched pages, and a higher fraction.
**On 41601 it buys four accounted pieces for twelve of scope, and one of the
losses is the opening.** Four callouts move:

| page | round nine | round ten | reference |
| ---: | --- | --- | --- |
| 2 | `3031`:72 at **0.998** | `3022`:72 at 0.939 | steps 1+2 are exactly `3031`:72, `3023b`:71 x2, `3005`:71 x4 |
| 7 | `3022`:72 at 0.938 | `3958`:0 at **0.483** | - |
| 19 | *not a callout at all* | `3031`:71 at 0.997 | - |
| 27 | `3031`:71 at 0.971 | `3031`:72 at 0.978 | - |

Three callouts now compete for the inventory's two `3031` slots, and the solver
resolves it by taking page 2's near-certain match away. So round ten's opening
page carries one wrong identity, on the page every prior round has shown
dominates the whole chain.

### Two candidate remedies, both measured, both refused

**The acceptance floor is not a lever.** `placement_slot_floor` re-solves from
the saved scores at a sweep of floors and pairs each with the audit - no
encoder, no GPU:

| floor | 41601 scope | 41601 accounted | 41624 scope | 41624 accounted |
| ---: | --- | ---: | --- | ---: |
| **0.30 (shipped)** | 25 pages / 108 | 80 | 37 pages / 106 | **85** |
| 0.50 | 23 / 99 | **81** | 36 / 101 | 82 |
| 0.70 | 23 / 99 | **81** | 35 / 98 | 81 |
| 0.90 | 15 / 67 | 63 | 30 / 81 | 65 |

At 0.50 41601's page 2 is `3031`:72 again and its accounted count is one higher;
41624's is three LOWER. The two fixtures point opposite ways by one and three
pieces, so **no fixture-independent floor helps both** and the shipped 0.30
stands.

**A crop-size channel is non-discriminating as formulated.** A 4x4 plate and a
2x2 plate are the same shape and differ only in size, which `canonical`
normalises away - so the obvious extra evidence is the crop's area against its
inventory icon's, relative to the page. At floor 0.30 the wrong page-2
assignment is indeed the single largest deviation on the fixture (log-deviation
0.573); at floor 0.50 the **correct** one is the second largest (0.420). The
statistic is dominated by a large part drawn on a page of small parts, not by
identity error. A joint identity/size/capacity assignment - a per-page scale
variable solved WITH the identities rather than after them - is the principled
form, and it is filed rather than fitted.

### The derived allocation reproduces a hand-worked one exactly, and extends it

The strongest available check on an automated on-ramp is a human's own careful
output, and 40377 has one: its allocation was worked page by page over rounds
one to nine and is the input every 40377 chain in this program has been driven
from. Run the round-ten pipeline on 40377 with no attended step and compare.

| | hand-worked (rounds 1-9) | **round ten, derived** |
| --- | ---: | ---: |
| pages | 17 | **28** |
| allocated pieces | 54 | 89 (+1 withheld) |
| of the printed inventory | 60.0% | **100%** |
| pages where the (part, colour, quantity) bags differ | - | **0 of 17** |

**Every one of the seventeen hand-worked pages reproduces identically**, down to
part, colour and count, and the derived allocation adds pages 2-11 and 13 - the
thirty-five pieces the *hand-built opening* supplied. That reframes the
program's own scoreboard: 40377's "54 of 90" was measured against an allocation
that only ever contained 54 pieces on 17 pages, with the other 36 hand-placed
before the driver started. The fixture can now be driven from scratch.

Pooled over a wider corpus - 25 PDFs and 1,104 anchors - the association repair
changes 12 crop boxes. `placement_canonical_invariance` scores every one of them
against what the MATCHER sees rather than against the box:

| outcome | boxes |
| --- | ---: |
| byte-identical matcher input | 3 |
| newly usable (no valid crop before) | 1 |
| genuinely different | **8** |
| lost (was usable, now not) | **0** |

All eight genuinely-different boxes were inspected: every one is the whole part
replacing a fragment or replacing the PLI panel frame - four translucent
assemblies cropped to half their length, two beams cropped short of their tip
behind a length badge, one small part cropped to its lower half, and one crop
that was the entire panel row of three parts. Translucent and light-coloured
artwork fragmenting under a single ink threshold is a **corpus-wide** failure
mode, not a property of 41601 page 5.

### The third remedy, filed above and then measured: CAD-size consistency

The size channel was refused a page ago because the statistic was wrong, not
because the idea was. Crop area against **inventory icon** area cannot be
constant across a page: a printed BOM scales each icon to its cell, so a big
part's icon is relatively smaller and the ratio grows with part size - which is
exactly the pattern that made a correct large plate look like the page's biggest
outlier. Universal CAD is the yardstick that does not have that defect. For a
candidate identity the part's own bounding-box diagonal is known in LDU, and

    implied page scale = crop diagonal / CAD bounding-box diagonal

must agree across one page's callouts, because one page draws its PLI at one
scale. Nothing here is learned, nothing is fitted, and nothing reads a
reference.

On 41601 the separation is one-sided and wide:

| assignment | implied scale | page median | log deviation | verdict |
| --- | ---: | ---: | ---: | --- |
| page 7 `3958`:0 | 0.341 | 0.865 | **0.931** | wrong |
| page 2 `3022`:72 | 1.914 | 0.981 | **0.668** | wrong (the opening) |
| page 27 `3031`:72 | 1.425 | 0.948 | **0.408** | wrong |
| every other assignment, 25 pages | - | - | **<= 0.155** | - |

`placement_slot_size_gate` applies it by **re-solving, not by overriding**:
violating (callout, slot) pairs leave the solver's candidate set and the global
assignment is solved again, to a fixed point. The solver still chooses, capacity
stays exact, and the module asserts no identity of its own. A page with fewer
than three callouts has no reliable median and is skipped rather than guessed
at.

**Calibrated on three fixtures, not on the one that motivated it.** At tolerance
0.30 the gate fires twelve pairs on 41601 and **zero** on 41624 and 40377; only
below 0.25 does it start firing on 40377, where it costs seven pieces of scope
and buys nothing. 41601's own result is flat from 0.20 to 0.40, because its
errors sit at 0.41 and above.

| 41601 allocation | pages | in scope | accounted | exact pages | opening page |
| --- | ---: | ---: | ---: | ---: | --- |
| round nine | 23 | 96 | 76 | 11 | correct |
| round ten, ungated | 25 | **108** | 80 | 11 | **wrong** |
| round ten, **gated** | 24 | 103 | **81** | **12** | **correct** |

The gate converges (zero residual violations, maximum deviation 0.155) and
restores page 2 to exactly the reference's steps 1 and 2. It costs five pieces
of scope - page 27's callout no longer matches any slot once the plate it was
taking is denied it, and its page leaves the scope with it - and that is the
honest trade: the opening page's identity against four pieces at the end of the
booklet. On 41624 and 40377 nothing changes at all, and 40377's derived
allocation still reproduces all seventeen hand-worked pages identically.

This is the first **non-pixel evidence channel** in the program that has both
separated a real error and cost nothing on the fixtures where there was no error
to find. Round nine's list of non-pixel candidates - inventory capacity,
connector-graph likelihood, seated contact - had produced zero, zero and a
retracted claim.

### The on-ramp, measured on six fixtures instead of three

The PDF is now the pipeline's only input: `placement_pdf_inventory` extracts the
printed BOM (reproducing 41601's existing inventory record for record), and the
slot assignment no longer reads a completed *allocation* to recover a verified
PDF hash - which had made the on-ramp circular, since an allocation is
downstream of that assignment. So the on-ramp can be measured on any fixture
with a stepped reference, and three more exist: `41604`, `41606` and `41625` are
the only other BrickHeadz OMR files that are Cheenzo-authored, carry real `0
STEP` structure and sit in the size band.

Six fixtures, one command each, no attended step, identical configuration:

| set | scope pages | printed pieces | in scope | of printed | pages excluded | size-gate pairs | accounted | fraction | exact pages |
| --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: |
| 40377 | 28 | 90 | **90** | **100%** | - | 0 | 68 | 0.756 | 17 |
| 41601 | 24 | 108 | 103 | 95% | 27 | 12 | 81 | 0.786 | 12 |
| 41604 | 17 | 101 | 63 | **62%** | 6, 7, 15, 18, 19, 23 | 1 | 49 | 0.778 | 7 |
| 41606 | 28 | 113 | 103 | 91% | 13, 17, 18 | 11 | 62 | 0.602 | 14 |
| 41624 | 37 | 109 | 106 | 97% | 13 | 0 | 85 | 0.802 | 26 |
| 41625 | 35 | 129 | 122 | 95% | 3, 14 | 1 | 89 | 0.730 | 21 |

**Median 95% of the printed inventory reaches a drivable page scope with no
human decision, mean 90%**, and about three quarters of the allocated pieces
group the way the reference's own steps group them. Round nine's equivalent
number, on the one fixture it was measured on, was 77% with the scope chosen by
hand.

The residue is two named classes, and neither is a placement problem:

* **A callout the solver cannot place in any slot** (41604: 8 callouts, 41606: 3,
  41601: 1 after gating). The crop is found and the identity is not.
* **An element the catalog maps to no LDraw name at all** (41625 pages 3 and 14,
  seven pieces). The adapter is right to refuse: there is no name to allocate.

41604 is the one fixture where the on-ramp is genuinely weak, and it is weak in
one specific way: eight unassigned callouts spread over six pages, one of which
carries thirteen pieces. Its 62% is a matcher-recall number, not a scope-policy
number, and it is the honest counterexample to the other five.

### What is left in the on-ramp is identity, and it has a number

Pooled over the six fixtures' 410 callouts, the identity stage divides cleanly:

| outcome | callouts | share |
| --- | ---: | ---: |
| assigned the slot that is its own best match | **369** | **90.0%** |
| assigned some other slot - a solver compromise | 28 | 6.8% |
| assigned nothing | 13 | 3.2% |

The compromises are usually tiny (median score gap 0.013 on four fixtures) and
occasionally not (0.198 on 40377, 0.122 on 41604). Both residues have the same
cause and it is not the solver: **the frozen artwork encoder cannot separate
small parts of the same shape**, so several callouts crowd onto one slot and the
global assignment has to break the tie by capacity.

41604 is the clearest case and worth recording exactly, because its 62% is the
breadth table's outlier. Its eight unassigned callouts are all real, inspected
part callouts - dark red 1x2 plates and tiles on six different pages - and every
one of them ranks `32028`:320 (a 1x2 plate with door rail, printed capacity
**one**) as its best match at 0.75-0.78. The fixture's dark red 1x2 capacity is
not short: `3023b`:320 has eleven, `3070b`:320 four, `87079`:320 four,
`3069b`:320 three. The inventory can hold them; the encoder cannot tell them
apart, and the solver leaves eight callouts rather than guess.

That is the same failure as 41601's three `3031` claimants, and it bounds what
the CAD-size gate can do: the gate separates parts whose *sizes* differ (a 4x4
plate from a 2x2), and `3023b` and `32028` have the same bounding box to the
LDU. Round ten's on-ramp gains came from repairing association and from using
size; the residue needs the identity evidence itself to improve, which CLAUDE.md
already records as measured-and-hard (a small CNN improved eligible BOM-icon
retrieval and did **not** transfer to unseen-set PLI).

### The size gate on all six fixtures, including where it costs something

The gate was calibrated on three fixtures and the breadth run makes six
available. At the shipped tolerance of 0.30, against the same pipeline with the
gate effectively off:

| set | pairs gated | accounted, gated | accounted, off | exact pages, gated | exact pages, off |
| --- | ---: | ---: | ---: | ---: | ---: |
| 40377 | 0 | 68 | 68 | 17 | 17 |
| 41601 | 12 | **81** | 80 | **12** | 11 |
| 41604 | 1 | 49 | **50** | 7 | **8** |
| 41606 | 11 | 62 | 62 | 14 | 14 |
| 41624 | 0 | 85 | 85 | 26 | 26 |
| 41625 | 1 | **89** | 88 | **21** | 20 |
| **pooled** | 25 | **434** | 433 | **97** | 96 |

**Net +1 accounted piece and +1 exactly matched page across six fixtures, and
one fixture where it costs exactly that much.** On its own that is a wash, and
it would not justify the module. What justifies it is *which* piece: on 41601 it
restores the opening page to the reference's own first two steps, and every
round of this program has measured the opening deciding the chain while a page
late in the booklet decides almost nothing.

A control worth recording: at a tolerance of 0.0001 - every deviation a
violation - the gate destroys every allocation (226, 294 and 201 pairs banned on
the three new fixtures, scope down by a third to a half, and it does not
converge). The statistic is an outlier test and nothing else; it says which
assignment disagrees with its page, never which assignment is right.

### The on-ramp's quality, decomposed: identity, then page

Two numbers separate cleanly and should never be quoted as one. The first
ignores pages entirely - how much of the allocated multiset is a part and colour
the reference actually contains, after canonical renaming:

| set | reference leaves | allocated | multiset overlap | share of allocated |
| --- | ---: | ---: | ---: | ---: |
| 40377 | 96 | 89 | 85 | **96%** |
| 41601 | 112 | 99 | 90 | 91% |
| 41604 | 106 | 62 | 58 | 94% |
| 41606 | 117 | 102 | 89 | 87% |
| 41624 | 109 | 100 | 92 | 92% |
| 41625 | 182 | 117 | 99 | 85% |

**Mean 91%.** Part of the residue is genuine catalog disagreement rather than
error - CLAUDE.md already records 40377's printed BOM overlapping its OMR at
73/90 exact ids with at least fourteen differences carrying universal
catalog/rename evidence, and canonicalisation is what lifts that to 96% here.

The second number is the page assignment, and it is the weaker one: the
order-preserving audit accounts for a mean **74%** of allocated pieces. So of
the pieces whose identity is right, roughly four in five land on a page the
reference's own step structure agrees with, and one in five does not.

A caveat that belongs beside both: an OMR leaf count is not a printed piece
count (41625 draws 182 leaves against a 129-piece BOM, because the reference
expands sub-parts), so the accounted *fraction* is comparable across
allocations of one fixture and not across fixtures.

### The combined 41601 run: both gains, and exactly the larger of the two

Round nine ended with 41601's two gains never combined - a symmetry-selected
6-of-7 opening on the round-eight scope, and the mould-pooled 92-piece/23-page
scope from the round-eight opening. One drive, one variable changed against each
of them.

| | r8 drive | r9 backtrack branch 1 | r9 wide scope | **r10 combined** |
| --- | ---: | ---: | ---: | ---: |
| opening | 3 of 7 | **6 of 7** | 3 of 7 | **6 of 7** |
| scope | 18 pages / 83 | 18 / 83 | **22 / 92** | **22 / 92** |
| pages placed | 17 | 16 | 21 | **20** |
| emitted | 77 | 75 | 86 | **85** |
| **structural** | 3 | **6** | 3 | **6 of 108** |
| coverage | 0.028 | 0.056 | 0.028 | **0.056** |
| precision | 0.039 | 0.080 | 0.035 | 0.071 |
| **driver's own contribution** | +0 | +0 | +0 | **+0** |
| pages ending in an exact tie | 13 of 17 | 11 of 16 | 16 of 21 | **13 of 20** |

**The two gains do not add; the combination is exactly the maximum of them.**
The better opening supplies its three poses and the wider scope supplies its
eight emitted pieces, and the structural count is 6 at page 3 and 6 at page 24 -
unchanged across all twenty placed pages, for the fourth chain running.

The prediction registered before the drive was "6 of 108 on about 21 placed
pages and 84-88 emitted, anything above 8 would be the first evidence that scope
and opening interact". Measured: **6 of 108, 20 placed pages, 85 emitted.** There
is no interaction.

### The multi-view probe: the second view's verdict is decided by whose camera it is

Round nine costed this as "the highest-value untested item" at two to three
engineering days, with an explicit stopping rule. It cost eighteen seconds of
GPU, and it stops.

Each of the construction's 36 retained bodies was scored as a fixed assembly
under a later page's **accepted registration** - the page's own camera, native
origin and mask decision, rebuilt byte-identically from the run that placed it -
using the same call the search's own exchange uses. Two later pages, and two
lineages: the run driven from the 3-of-7 opening and the run driven from the
6-of-7 one.

| registration's lineage | page | class 0 (3 of 7, n=24) | class 1 (6 of 7, n=12) | separated | picks |
| --- | ---: | --- | --- | :-: | --- |
| 3-of-7 (`r8-drive`) | 3 | 0.0837 - **0.6283** | 0.1088 | no | **class 0** |
| 3-of-7 (`r8-drive`) | 4 | 0.0804 - **0.3895** | 0.0963 | no | **class 0** |
| 6-of-7 (`branch-01`) | 3 | 0.1039 - 0.1066 | **0.6167** | yes | **class 1** |
| 6-of-7 (`branch-01`) | 4 | 0.0926 - 0.0993 | **0.3868** | yes | **class 1** |

**The two lineages disagree, completely and symmetrically.** Under either one,
the body that produced that page's camera scores five to six times higher than
the other class - because a page's accepted registration is *propagated from the
body its own run drove*, so scoring alternatives under it asks a circular
question. The probe's own docstring predicted this bias and the measurement
confirms it is not a small correction: it is the entire signal.

Two further facts from the same table, both against the multi-view idea:

* **The within-class tie survives every view.** Twenty-four bodies still take at
  most two distinct values and twelve still take exactly one, to full precision,
  under all four registrations. A second view separates the two *classes* and
  does not separate the geometrically distinct bodies inside either one - the
  24-way tie round nine measured is still 12-wide at the best score.
* **The pathology is therefore the objective's formulation, not the single
  view**, which is exactly the branch round nine's stopping rule assigned to
  that outcome.

The prediction registered before the probe said the tie would break but the
classes would not be cleanly separated in the right direction under both
lineages. Half right, and the half that was wrong matters: the *between-class*
gap moved hugely, the *within-class* tie did not move at all, and the direction
was set by whose camera it was.

**Verdict: do not build the integration.** A multi-view objective would first
need each candidate registered independently on the later page, which is a
per-candidate registration search per page and reintroduces the same objective
one level down. That is a far larger item than the two to three days round nine
costed, and it is now costed on evidence.

### 41601, end to end, from the PDF alone with no attended step

One command. The PDF is the only input; the reference is read afterwards, by the
evaluator, and chooses nothing.

| stage | derived | result |
| --- | --- | --- |
| printed inventory | `placement_pdf_inventory` | 48 records, 108 pieces, 2 elements ambiguous |
| callout association | `crop_items` (grouped, exclusive, panel geometry) | 70 of 70 anchors resolved |
| identity | slot MILP + **CAD-size gate** (12 pairs, converged) | 108 pieces, page 2 = the reference's steps 1 and 2 |
| page scope | `--auto-scope` | 24 pages, 103 pieces in scope, page 27 excluded and named |
| opening | construction on the first scope page, symmetry-selected | `beam_24`, **6 of 7**, +3 over the objective's own pick, equal to the oracle best |
| drive | 23 pages | 19 placed, 78 emitted |
| **final** | | **6 of 108 correct poses, driver contribution +0** |

**The prediction registered before this ran was wrong, and it is worth saying
exactly how.** It said "the repaired on-ramp reallocates the opening page's plate
to `3022`:72 ... so opening <= 5 of 7 and the chain 3-6 of 108". The chain landed
in that band, but the opening did not: the **CAD-size gate, which did not exist
when the prediction was written**, removed that reallocation and put page 2 back
to `3031`:72. The prediction was falsified by the round's own repair, which is
the only honest way to describe it.

One page was lost to a code defect rather than to the pipeline: page 5 - the
translucent-callout page the association repair recovered - failed with
`Object of type bool_ is not JSON serializable` because a scene record carries
numpy booleans and the evidence writer used a bare `json.dumps`. It had never
been in a drivable scope before. Fixed, and the run is reported with the defect
named rather than re-driven, because every measurement in this program says an
extra page adds emitted pieces and no correct poses.

### The four 41601 chains side by side

| | r8 | r9 opening | r9 scope | r10 combined | **r10 autonomous** |
| --- | ---: | ---: | ---: | ---: | ---: |
| attended steps | 1 | 1 | 1 | 1 | **0** |
| opening structural | 3 of 7 | 6 of 7 | 3 of 7 | 6 of 7 | **6 of 7** |
| scope | 18p / 83 | 18 / 83 | 22 / 92 | 22 / 92 | **23 / 103** |
| pages placed | 17 | 16 | 21 | 20 | 19 |
| emitted | 77 | 75 | 86 | 85 | 78 |
| **structural** | 3 | 6 | 3 | 6 | **6 of 108** |
| driver's own contribution | +0 | +0 | +0 | +0 | **+0** |
| pages ending in a tie | 13/17 | 11/16 | 16/21 | 13/20 | **13/19** |

**Five chains, five different scopes and two different openings, and the drive's
own contribution is +0 in every one.** The structural count is decided entirely
by the opening; nothing after page 3 has ever moved it on this fixture.

## Round ten's strategy checkpoint: where the 90%-from-PDF mission stands

Ten rounds have produced enough measurement to say this stage by stage rather
than as an impression. Every line below is a number some tool in
`scripts/pdf-recon/` reproduces.

| stage, from a PDF and nothing else | state | the measurement |
| --- | --- | --- |
| printed BOM extraction | works | six fixtures; reproduces the historical inventories record for record |
| callout association | **~100% of anchors resolve** on the fixtures | 25 PDFs, 1,104 anchors: 0 broken, 3 repaired, 8 crops corrected |
| identity: callout to slot | 90.0% own-best, 6.8% compromise, 3.2% unassigned | 410 callouts over six fixtures |
| identity at the multiset level | **mean 91% correct** | allocated multiset against the canonicalised reference |
| page scope | **median 95%, mean 90% of printed pieces**, zero attended steps | six fixtures |
| page assignment | mean 74% of allocated pieces | order-preserving audit against reference steps |
| opening selection | reference-free; equals the oracle best where five parts are mirror-eligible | three constructions: +3, +1, +0 |
| **per-page placement drive** | **+0 own contribution on from-scratch fixtures** | five 41601 chains, plus 41624 and 40377 |
| **correct poses, from scratch** | **6 of 108** | round ten's autonomous run |

**The on-ramp was the largest lever and it has now largely been pulled.** Round
nine called it that on the strength of nine pieces of scope; round ten took
41601 from 83 drivable pieces to 103, 41624 from 99 to 106, 40377 from a
hand-worked 54 to a derived 90, removed the last attended step, and made the PDF
the only input. What that bought in correct poses is zero. The constraint moved;
it did not lift.

### The binding constraint is the per-page objective, and that is now five measurements

1. **Its optimum is not the model.** A deterministic A/B produced a strictly
   better optimum and a strictly worse chain (54 to 51). Pooled over three
   fixtures, 78.6% of reachable losses are already objective *preferences*.
2. **It cannot separate materially different assemblies.** 41601's opening ends
   in a 24-way EXACT tie whose members share on average 3.5 of 7 placements, and
   it *prefers* the bilaterally incomplete class by 2%.
3. **A second view does not fix (2).** Round ten scored all 36 retained bodies
   under two later pages' accepted registrations, in two lineages: the ranking
   is decided by whose camera the registration was propagated from, the lineages
   disagree symmetrically, and the within-class tie survives every view intact.
4. **Perfect selection over everything enumerable caps at 79/90 and 31/109.**
   Even a flawless ranker over today's banks cannot reach 90% on 41624.
5. **Repairing the opening converts `unreachable` into `mis_selected`, not into
   `correct`.** The candidate generator and the ranker are *both* inadequate and
   fixing either alone exposes the other.

(4) and (5) decide the strategy. The program spent five rounds improving
selection over a bank that does not contain the answer 68% of the time, and one
round proving that a better bank is then mis-ranked.

### What the evidence says the next investment is

Not more search, not more rescoring, not another tie-break, and - after round
ten - not multi-view aggregation over accepted registrations. Two things, in
this order, and each is a subsystem rather than a parameter.

**1. A per-instance objective.** Today's score is a per-colour-class
depth-composite IoU over the whole drawing plus a visible-edge term. It has no
way to say *this part, in this pose, explains this region*, which is exactly why
a wrong piece standing in the right place costs it nothing and why 24 different
assemblies score identically to sixteen significant figures. The replacement is
local correspondence: a candidate's projected CAD silhouette and visible-edge set
matched against the drawing's own strokes in the neighbourhood it claims, scored
per instance and aggregated. Validate it on **single pages**, where the answer is
known and a chain's variance cannot hide a regression, before any chain is driven
with it.

**2. Candidate generation driven by the drawing.** 68% of losses are poses the
bank never contained, and the bank is generated model-side, by connector closure
around the body already placed. The booklet supplies a signal the pipeline does
not use: consecutive pages draw the same assembly, and the *difference* between
two registered drawings localises exactly where new ink appeared. Enumerating at
that difference rather than everywhere the connectors allow attacks the largest
loss class at its source. Note this is not the refuted multi-view idea: it uses
the later page to say **where to look**, not to **rank** what was found, and the
circularity that killed the probe does not apply to a difference image.

### How large is that, honestly

Both are new scoring or generation stacks. On the evidence of ten rounds, in
which every costed lever returned between +0 and +3 correct poses, this is a
**multi-month programme**, not two or three more rounds. It is worth saying
plainly: **90% correct poses from PDF alone is not reachable by continuing to
tune the current architecture**, and five independent measurements say so rather
than one.

### What is worth shipping now, because it works

The on-ramp is a usable product on its own. From a PDF and nothing else the
pipeline emits a page-scoped, identity-checked bill of materials - which piece,
which colour, how many, on which step page - at a median 95% of the printed
inventory with no human in the loop, with every refusal named and none guessed.
That is a per-step parts list for any set whose booklet is in the corpus, and it
does not depend on the placement problem being solved. The poses are the part
that is not ready, and the scoreboard says so in the same numbers it always has.

### 41624, end to end from the PDF alone: 2 of 109, and the derivation that cost it

| stage | result |
| --- | --- |
| printed inventory | 51 records, 109 pieces |
| callout association | 69 of 69 anchors resolved |
| identity | 108 pieces assigned, 1 callout unplaced; size gate fires **0** pairs |
| page scope | 37 pages, **106 of 109 pieces**, page 13 excluded and named |
| opening | `beam_00`, **2 of 3**; the symmetry channel abstains (one mirror-eligible part) |
| drive | 36 pages, **36 placed**, 100 emitted |
| **final** | **2 of 109 correct poses, driver contribution +0** |
| ties | 26 of 36 pages end in an exact tie |

That is **worse than round seven's attended 6 of 109**, and the whole difference
is in the opening. The cause is precise and is not the association work or the
scope: page 2's allocation is **byte-identical** to the legacy one
(`3023b`:4 x2, `3031`:4 x1) and the construction selects the same root
(`3031`:4) at the same score to sixteen digits - but a **different body**. The
one input that differs is the prescan page set, which round ten *derives* ("the
next two scope pages", giving `[4]` after page 3 yielded no stud row) where the
round-three human run used `[4, 5]`.

| 41624 opening | prescan | structural |
| --- | --- | ---: |
| round three (human) | `[4, 5]` | **3 of 3** |
| round ten (derived) | `[4]` | 2 of 3 |

**One prescan page costs one opening pose, and one opening pose costs four in the
final chain**: the round-seven chain went 3 to 6 (+3) and the autonomous chain
goes 2 to 2 (+0). It is the sharpest illustration this program has produced of
its own central finding - the opening decides the chain and nothing after it
does - and it arrived as a cost of automating a choice, which is the honest
price of removing the last attended step.

The derivation is a one-line rule and the fix is a measurement, not a guess: a
wider prescan set can only add camera candidates, so the probe is to derive the
next **three** scope pages instead of two and check both fixtures. Queued.
