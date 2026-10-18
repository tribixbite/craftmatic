# Placement v2 implementation and experiment ledger

This is a development slice of the [replacement architecture](pdf-placement-v2-architecture-2026-09-11.md).
It is not yet a replacement full-booklet solver. All runtime experiments use
PDF observations, universal CAD and reference-free runtime artifacts. Reference
models enter only separate evaluation processes; runtime VLM calls are zero.

## Implemented

* Sparse exclusive feature assignment, explicit visible-feature penalties,
  shared-seam capacity and per-instance evidence accounting.
* Native-pixel drawing/render feature extraction and visible coplanar instance
  seams. The first representation is sampled edges, not semantic segmentation.
* Whole-ellipse correspondence with one-to-one matching of location and projected
  shape. Gray and max-channel extraction prevent saturated surfaces from
  becoming solid blobs under every dark-ink threshold. Curves are not presumed
  to be studs; holes and decoration can also generate them.
* Deterministic translation refinement. This changes camera image origin, not
  a part's depth, and accepts only improvements to the specified objective.
* Drawing-to-CAD translation lifting with explicit camera-nullspace depth,
  evidence-supplied bounds, connector witnesses and multi-view rank checks.
  These primitives have synthetic tests; they are not a measured general pose
  proposal generator. Real detached-component proposals carry unbounded depth.
* Verified separation of an exploded step's depicted state from its final
  attached state, plus independently recomputed arrow-contact evidence.
* A runtime candidate replay harness, separate reference evaluator, and a
  diagnostic bridge to the existing candidate generator for continuation.
* A detached-component shape matcher for the area-only detector's ambiguities.
* A finite mixed-integer pose/observation assignment solver with exact inventory
  quotas, collision conflicts and exclusive drawing-stroke capacity, plus a
  raw-registry adapter to test selection before complete-assembly retention.
* Joint base/new-part correspondence. Each base feature has an exact visible/
  suppressed choice tied to selected foreground poses, using owner-buffer
  samples. Auxiliary feature states never become exported physical pieces.
* A tested projected-sample visibility helper for prospective cheap ranking;
  it is not used by the recorded trials and is not an exact visibility proof.

The runtime harness accepts no truth path. Reports record source snapshots,
start/end hashes, PDF and candidate hashes, camera policy, and tie counts.
Newer reports additionally record/check universal CAD hashes and write a report
digest. Every run uses a fresh output directory under `output/pdf-placement-v2/`.
No better-source model or web/export file is modified.

## Opening discrimination experiments

The comparison below is against the old **image objective's selected opening**,
not against the best historical opening heuristic and not against whole sets.
All three are development fixtures already examined in the previous program.

| Fixture | Opening pieces | Old image selector, structural | New selector, structural | Best retained candidate |
| --- | ---: | ---: | ---: | ---: |
| 41601 | 7 | 3 | 6 | 6 |
| 41624 | 3 | 2 | 3 | 3 |
| 40377 | 4 | 1 | 1 | 2 |

Structural scores permit authoritative aliases and verified unprinted CAD
symmetries. Raw strict scores are separate: selected 41601 is 3, selected 41624
is 1, and selected 40377 is 1. These differences must not be hidden by calling
all three columns strict pose accuracy. Full reference denominators remain
108, 109 and 90 respectively in the evaluation artifacts.

41601's existing symmetry heuristic already selected 6/7. Thus the new image
channel reproduces that opening result without a symmetry preference; it has
not yet improved the autonomous full-model baseline of 6/108.

### Iteration 1: exclusive sampled edges and seams

`*-opening-v1` reranks every retained candidate under the same union of camera
matrices, each independently translated by bounding-box centering. It uses no
accepted camera origin from a preferred candidate. This is still an inherited
camera proposal pool, not independent camera calibration.

No structural gain: 41601 stays in its 24-way wrong class, 41624 stays at 2/3,
and 40377 stays at 1/4. Adding ownership to anonymous point samples does not
recover curve topology or make truly hidden geometry observable.

**Replay defect:** the initial 41624 replay rendered its appended arrow-attached
piece against the seated-body mask. The old generator had correctly distinguished
these states; the new adapter initially lost that distinction. Versions 1–3 on
41624 cannot establish that the new scorer fails on the correct depicted state.
`partition_display` now checks the appended count, identity and translation
against runtime attachment provenance. A regression test prevents this mistake.
40377's ambiguity is upstream: its bank declares no detached piece at all.

### Iteration 2: whole curves

`41601-opening-v2-curves` selects the 6/7 class. The remaining 12-way tie contains
only six-match candidates. Equal weighting of normalized edge and whole-curve
cost was specified before this run; there was no weight sweep to choose a pose.
Its selected file is `beam_29.ldr` under the declared deterministic hash ordering.

The important evidence is visible in the saved renders: the wrong class exposes
brick undersides, while the better class presents the round stud caps drawn by
the PDF. Isolated edge points can match nearby unrelated strokes; a complete
curve cannot receive credit from a square opening just because their pixels
are close. This channel is nevertheless only a hypothesis for broader fixtures.

### Iteration 3: translation control

`41624-opening-v3-align` tests the same symmetric translation ladder on every
candidate. It changes no selected cost or pose. It also predates the display
adapter correction, so this is not evidence against camera refinement generally.
Translation cannot resolve camera-depth or part-orientation ambiguity.

### Iteration 4: display state and contacts

`41624-opening-v4-display` selects `beam_17.ldr`, all 3/3 structurally correct,
with a two-way best-score tie whose members are both correct. The final attached
piece is excluded from the seated image and judged by PDF arrowheads against
universal connector contacts at each candidate's own proposed registration.

An evaluation-only decomposition explains the gain: seated-image correspondence
alone has a six-member best tie containing both two- and three-match assemblies;
the separate arrow factor resolves the attachment ambiguity. Merely dropping
the exploded part from the image is insufficient.

`40377-opening-v4-curves` remains 1/4. Its bank contains no fully correct opening,
so tuning selection there cannot solve the opening.

### Iteration 5: saturated-color feature extraction

`41624-opening-v5-value` uses both gray and max-channel curve detection. The
choice remains 3/3; the grayscale-only extractor had returned no curves on this
red drawing. A synthetic regression verifies that dark outlines on a saturated
red surface remain detectable. This is a feature-extraction correction, not an
additional pose gain. This configuration supplies the continuation experiment.

## Drawing-driven detached identity

`40377-detached-v1` resolves the ambiguous floating component as `2420:15` using
the PDF and universal CAD shape, with normalized cost 1.18957, versus 1.25566 for
`99780:15` and 1.29742 for `15571:15`. The 0.06609 margin exceeds the predeclared
0.02 decision threshold. It examines all allocated identities and cube rotations;
there is no set-specific override.

This is a component identity result, not a recovered attachment. Its best
orientation/center correspondence lifts to a rank-two translation domain and
explicitly leaves depth unbounded. The next construction experiment uses that
identity to represent three seated pieces plus one exploded piece correctly.

### Fresh opening generation with the corrected interpretation

`40377-bootstrap-v1` derives opening page 2 and prescan pages 3–4 from a verified
PDF-only allocation cache, builds three fresh root banks, and replays every
successful root. All three use the same scene and mask role. The runtime selects
root 0, `beam_16.ldr`, at normalized cost 0.752706.

| Root | Retained candidates | Selected structural matches / 4 | Bank ceiling / 4 |
| --- | ---: | ---: | ---: |
| 99780 | 36 | 1 | 2 |
| 2420 | 36 | 2 | 3 |
| 15571 | 32 | 1 | 2 |

This fresh construction raises the best available bank ceiling to three but
does **not** improve the selected opening: structural and strict scores remain
1/4. Both proposal incompleteness and selection error remain. The separate
sealed evaluations are `40377-bootstrap-v1/root-00-evaluation.json` through
`root-02-evaluation.json`. No root was selected using these reference scores.

The bootstrap CLI can also invoke the existing PDF-only inventory/allocation
on-ramp when no cache is supplied. That uncached path has mocked integration
coverage, not a new end-to-end accuracy measurement in this experiment.

## Continuation beyond the opening

`41624-continue-v1` starts from the three correct pieces selected by v5 and
automatically derives pages 3–5 from the existing PDF-only allocation. After each
legacy-generated candidate bank, the v2 objective selects the checkpoint carried
to the next page. This is a generator bridge, not joint revision of earlier poses.

| Checkpoint | Emitted pieces | Structural matches | Strict matches |
| --- | ---: | ---: | ---: |
| Opening | 3 | 3 | 1 |
| Page 3 | 6 | 3 | 1 |
| Page 4 | 9 | 5 | 1 |
| Page 5 | 13 | 5 | 1 |

The driver adds **two correct placements**. This partial model has 5/13 (38.5%)
structural precision and 5/109 (4.59%) full-reference coverage. It is not a
completed-booklet accuracy result. Evaluation is saved separately as
`41624-continue-v1-evaluation.json`; the final model SHA-256 is
`368f3e3687b5f75f2dbdf0be24a31abba1f957d0b34b4ee724d08c5186f4de0f`.

A separate evaluation of all 38 retained page-3 candidates finds a ceiling of
three structural matches: none contains a correct addition. That finding
motivates testing joint pose/observation assignment on the 8,192 raw pose
hypotheses before the old assembly-bank retention stage. It does not establish
that the raw pool contains the missing correct poses.

### Raw-pose assignment integration

**Implementation defect discovered after v5:** `_projected_descriptor` took a
view of the scorer's cached projected CAD coordinates and added the image offset
in place. Repeated rotations accumulated offsets in that shared buffer and
corrupted subsequent renders. A copy plus a repeated-call cache-invariance
regression fixes this. **Trials v1–v5 below document the buggy implementation;
their filtering/visibility failures do not establish a failure of the intended
objective or camera model.** The opening replays and continuation above do not
call this descriptor and are unaffected. The first clean raw-pose control is v6.

The first `41624-page3-pose-search-v1` attempt consumes the raw 8,192-pose
registry, applies drawing-based thinning to at most 256 poses per identity/color,
and renders those individually before retaining at most 32 per key. It failed
the support contract: a retained pin had no retained support witness. No complete
model or pose-accuracy result was emitted. This exposed a problem with
independent per-key thinning, rather than proving the joint objective effective.

The pose solver jointly chooses binary pose alternatives and partial one-to-one
observation matches. Unmatched visible predictions and unmatched observations
carry explicit costs. Exact identity/color quotas constrain selection, and
collision pairs cannot both be selected. These constraints prevent the same
drawing stroke from independently rewarding multiple selected pieces. The
support constraint sends flow from base-supported selected poses through
selected contacts, with one unit consumed by each selected pose. This permits
rooted cycles while excluding floating cycles and unsupported selected parts.
It replaces the first solver's incompatible requirement for an acyclic graph.
The adapter's feature tokens are still rendered one candidate at a time against a
fixed base; their visibility can change when candidates are combined. Therefore
the selected complete assembly receives a separate visibility-correct edge and
curve score, and optimality of the finite surrogate must not be described as
optimality of the reconstruction.

`41624-page3-pose-search-v2` completes with rooted-flow support and unchanged
256/32 per-key caps. It prunes 18 unsupported options, leaving 46. The MILP
solves its surrogate optimally (reported gap zero), but chooses three poses
with **zero visible owned tokens and zero observation matches**. The report
explicitly marks them visually unsupported. Whole-model evaluation is 3/6
structural and 1/6 strict: all additions are wrong.

The separate evaluator enumerates two equally maximum structural base
alignments. It uses one shared alignment for an entire tier at a time, never
realigning individual candidate poses:

| Candidate tier | Pose/color alternatives | Correct allocated poses recoverable / 3 |
| --- | ---: | ---: |
| Raw registry | 8,192 | 3 |
| Cheap drawing filter | 512 | 1 |
| Render filter plus support pruning | 46 | 0 |

Both correct `3700` poses disappear at the cheap filter; the surviving `2780`
disappears later. This is conditional pose recall under the evaluated best base
alignments, not a feasible joint-assembly proof. It nevertheless establishes
that the new independent filters discard useful proposals already available
to them. The absence of visual penalties for completely hidden quota fillers
is a separate selection failure. Subsequent trials must address both.

`41624-page3-pose-search-v3` adds an explicit minimum of one exclusive drawing
match per selected depicted addition, with the same candidate budgets and
ranking. It correctly returns `no_complete_assignment` instead of emitting
hidden quota fillers. After support pruning, neither part pool contains a
match-capable retained option. Stage recall remains 3 → 1 → 0. This is improved
failure handling, not improved reconstruction accuracy. Runs v2/v3 captured input
hashes only at the end, so they do not establish data-file stability during the
run; the evaluator records that limitation separately from code-source sealing.

`41624-page3-pose-search-v4` groups raw rotations into the nearest of 24 proper
signed-axis families without snapping the actual poses, diversifies projected
centers in 16-pixel cells, applies match admissibility before the render cutoff,
and preserves available rendered support paths under an explicit extra cap.
It still loses both correct bricks at the cheap stage. Eight match-capable pin
options lack a usable rendered support path; no brick option is match-capable.
The runtime refuses. Recall remains 3 → 1 → 0. This trial verifies code, runtime
input, and CAD stability at both ends. Its measured runtime is 8.78 seconds,
motivating an all-raw-pose rendering control before further fast-filter tuning.

`41624-page3-pose-search-v5` renders all 8,192 raw poses in 97.3 seconds but
still refuses after reporting no match-capable brick. This prompted the cache
audit and exposed the mutation defect above. Its result is superseded by the
post-fix control; it is not evidence that correct bricks are inherently invisible.

### First valid full-raw control

`41624-page3-pose-search-v6` fixes the projection-cache mutation and renders all
8,192 poses in 139.9 seconds. It finds 1,626 match-capable pins and 2,659
match-capable bricks. The per-key render cutoff keeps 256 each; support closure
adds 20, giving 532 options. All runtime input, source, and CAD guards pass.

The solver reaches its finite surrogate optimum with 70 exclusive matches and
no zero-token selections. Nevertheless the selected model is only **3/6
structural, 1/6 strict**: all three additions are wrong. Raw and all-rendered
recall are 3/3; final-retained recall is 1/3. Under the applicable common base
alignment, the correct pin ranks 437–440, one brick ranks 53–54, and the other
ranks 2,001–2,002 in their standalone scores. Only the first brick survives the
256 cutoff, and joint assignment does not select it.

This is a valid ranking/assignment failure. The saved selected render also
exposes a scoring defect: much of the new geometry lies beyond the native
canvas, where clipping removes the missing visible-feature penalty. Subsequent
scoring must retain those predictions outside the observation rectangle.

`41624-page3-pose-search-v7` adds a padded native render domain covering the
projected union of all raw poses and the base. The 128×98 observation canvas
becomes a 182×179 render canvas, with padding [27, 48, 27, 33]; edge and curve
coordinates are shifted back to the original observation frame. A maximum
dimension guard refuses excessive padding instead of silently clipping.

The run takes 187.98 seconds. Final pose recall stays 1/3. The correct pin's
rank improves to 305–308, the retained brick to 21–22, and the other brick to
1,913–1,914. The selected checkpoint remains 3/6 structural and 1/6 strict.
This solve stops at its time limit with a feasible incumbent and reported
MIP gap 0.6571; unlike v6, it is not a proved surrogate optimum. Padding fixes
the clipping contract but does not solve the remaining ranking problem.

### Joint base and addition ownership

The next implementation removes permanent base-to-drawing claims. Full drawing
observations participate once in the joint solve; new-part features and visible
base features compete for the same observation capacity. A base feature is
suppressed exactly when at least one selected pose is declared to cover its
sampled base-foreground pixel by the padded owner buffer. Visible/hidden
auxiliary feature states use the existing quota, conflict, and rooted-support
solver; their IDs cannot be exported as physical parts.

Standalone ranking now compares each complete base-plus-one-candidate render
with the full drawing, rather than comparing only the candidate's tokens with
observations left over after permanent base claims. Final assembly visibility
and whole curves are still recomputed independently. The unary base suppression
contract does not resolve interactions between two added parts or every change
in edge topology. This remains a bounded approximation, not a joint full-booklet
assembly graph.

`41624-page3-pose-search-v8` evaluates all 8,192 raw poses under each of three
camera hypotheses with this joint base model. It takes **1,422.26 seconds**
(23.7 minutes). Cameras 0 and 1 produce feasible incumbents; camera 2 explicitly
refuses because no integral incumbent is available at its 60-second solve limit.
Neither feasible solve proves optimality (reported relative gaps approximately
3,717.7 and 1,978.4). Runtime image scoring selects camera 1, registry poses
1003, 1031 and 818, with normalized cost 0.939922. All source, runtime-input and
CAD guards pass; runtime VLM calls remain zero. This cost must not be interpreted
as geometric accuracy.

Independent evaluation finds **3/6 structural and 1/6 raw strict** in the final
selected model: all three new placements are wrong. Raw, rendered and final
union recall across the three cameras are each 3/3. Camera 0 retains all three
correct poses under one shared best base alignment but selects none; camera 1
retains two and selects none; camera 2 retains two and refuses. Thus the latest
trial improves candidate retention without improving selected placement accuracy.
Retention alone does not prove joint feasibility under every constraint, and
the large solve gaps prevent attributing this result solely to the objective.
The independent evaluation seal is
`bf17ca907eec8d11970e74f9d442b1dc92211bd1e14b2a12d6debfc659e44e6d`.

This implementation is not ready to replace production reconstruction. The next
experiment should separate conditional base-feature logic from physical-part
support flow to reduce solver size, then measure whether a well-solved objective
selects the retained correct assembly. Only after that should it expand to
revisable earlier placements and full-booklet runs. No measured result here
establishes accurate reconstruction of complete PDF-only sets.

## Reproduction and interpretation

Final regression validation: **101 tests passed in 3.42 seconds** across the
16 new reconstruction test modules. Coverage includes exclusive assignment,
rooted support, conditional base visibility, projection-cache immutability,
padding, display-state separation, checkpoint publication and evaluation seals.
The final telemetry-only change adds flushed progress events and camera phase
timings; it was made after the v8 runtime source snapshot was sealed.

Example opening replay and separate evaluation, from the repository root:

```powershell
python scripts/pdf-recon/placement_v2_replay.py --bank output/pdf-placement-beam/41624-r10-autonomous/construction/construction --out output/pdf-placement-v2/NEW-RUN --curves --arrows
python scripts/pdf-recon/placement_v2_evaluate.py --run output/pdf-placement-v2/NEW-RUN --truth C:/git/clego/lego_sets/OMR/41624-1.mpd --out output/pdf-placement-v2/NEW-EVALUATION.json
```

Fresh construction from a PDF (omit `--allocation-run` to run inventory and
allocation too), followed by a bounded continuation:

```powershell
python scripts/pdf-recon/placement_v2_bootstrap.py --pdf C:/git/clego/lego_sets/PDF/6314914.pdf --allocation-run output/pdf-placement-beam/40377-r10-autonomous/allocation --out output/pdf-placement-v2/NEW-BOOTSTRAP
```

Use the selected root's `replay_directory` recorded in `bootstrap.json` as
`--opening-replay` below; root 0 is selected in the recorded 40377 experiment.

```powershell
python scripts/pdf-recon/placement_v2_continue.py --pdf C:/git/clego/lego_sets/PDF/6314914.pdf --allocation-run output/pdf-placement-beam/40377-r10-autonomous/allocation --opening-replay output/pdf-placement-v2/NEW-BOOTSTRAP/root-00-replay --out output/pdf-placement-v2/NEW-CONTINUATION --max-pages 3
python scripts/pdf-recon/placement_v2_trajectory.py --run output/pdf-placement-v2/NEW-CONTINUATION --truth C:/git/clego/lego_sets/OMR/40377-1.mpd --out output/pdf-placement-v2/NEW-TRAJECTORY.json
```

These commands intentionally preserve unresolved/incorrect hypotheses. A model
being emitted does not certify its geometry, and a bounded continuation is not
a full-set reconstruction.

Raw-pose assignment control on the recorded page-3 runtime registry:

```powershell
python scripts/pdf-recon/placement_v2_pose_search.py --source output/pdf-placement-v2/41624-continue-v1/drive/page-003/placement --out output/pdf-placement-v2/NEW-POSE-RUN --cheap-budget 8192 --render-budget 256 --support-extra-cap 256 --max-cameras 3 --solver-time-limit 60
python scripts/pdf-recon/placement_v2_pose_search_evaluate.py --run output/pdf-placement-v2/NEW-POSE-RUN --truth C:/git/clego/lego_sets/OMR/41624-1.mpd --out output/pdf-placement-v2/NEW-POSE-EVALUATION.json
```

The raw-pose entry point consumes generated runtime data, not a reference model.
It still depends on the legacy registry and camera proposals. The smaller CLI
budgets are experimental speed controls, not validated accuracy-preserving cuts.

The existing bank is PDF-only runtime output, but it still limits proposal
recall. A replay is neither an autonomous full-booklet run nor a held-out
generalization experiment. Do not substitute opening precision, crop coverage,
or image scores for full-model reconstruction accuracy.

The initial sparse matcher also has a 24-neighbor cap per predicted token;
recording capacity does not make its candidate graph exhaustive. Raster-grid
phase, annotation mistakes, feature detection and camera uncertainty remain
limitations. The full joint revisable assembly graph described in the architecture
is not implemented by the legacy-generator continuation bridge.
