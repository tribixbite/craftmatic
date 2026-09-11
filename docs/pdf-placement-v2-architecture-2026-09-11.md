# PDF placement v2: instance correspondence and revisable assembly inference

Status: architecture with an initial implementation slice; not a validated
full-booklet reconstructor. See the [implementation and experiment ledger](pdf-placement-v2-results-2026-09-11.md).
Active implementation, test gates and deferred work are tracked in the
[rework plan](pdf-placement-v2-work-plan-2026-09-11.md); see also the
[post-implementation design review](pdf-placement-v2-design-review-2026-09-11.md).
Prepared against the September 9 handoff and the round-ten development ledger.
Runtime input remains the PDF, optional inventory, and universal part CAD and
catalog data. No runtime VLM, set model lookup, reference poses, or manually
chosen opening. Development VLM observations are diagnostics, never cached
runtime instructions or set-specific placement rules.

## Decision and evidence

Keep the autonomous inventory/callout front end. Replace placement as a separate
implementation under `scripts/pdf-recon/`. Its central representation will be
part instances, drawing observations, and explicit correspondences, with cameras
and assembly history jointly revisable. The current emitted body cannot remain
the authority that decides both where candidates exist and how the drawing is
registered.

The autonomous baselines are 40377: 2/90, 41601: 6/108, and 41624: 2/109 correct
poses; the mean of set-level percentages is 3.2%. Scope coverage (median 95%) is
not identity or pose accuracy. The front end's canonicalized multiset overlap
averages 91%, and its reference-step agreement averages 74%, with reference
decomposition caveats. Thus placement must retain identity and step alternatives
instead of treating every allocated page quota as unquestionable truth.

The ledger measures both absent correct proposals and an objective that prefers
wrong assemblies. Fixing only one cannot solve reconstruction. The existing
`placement_local_delta.py` already restricts scoring to local windows;
`placement_feature_scene_score.py` already adds visible edges. The new work is
**exclusive correspondence and instance accounting**, not another weighted
combination of those existing scores.

The observed ceilings apply to the measured old search banks. They are evidence
against that implementation, not a mathematical impossibility result for all
image-based reconstruction. Conversely, a new formulation is a hypothesis, not
evidence that 90% is achievable.

## Runtime data model

Use immutable, versioned observations and separately versioned hypotheses. Keep
native-image, PDF-page, local-body, and world coordinates explicitly typed, with
transforms and units recorded; never silently resize a target to fit a candidate.

| Record | Required content |
| --- | --- |
| Scene | PDF hash, page and panel IDs, image/alpha or raster source, native-to-page transform, masks with provenance, scene-role alternatives |
| Observation | Stable ID, stroke/polyline or curve, endpoints, tangent, junctions, color-side evidence, localization uncertainty, annotation probability |
| Track | Cross-scene observation matches, relative-view hypotheses, inlier evidence, uncertainty; no accepted-body camera dependency |
| Part instance | Stable physical instance ID, identity/color alternatives, inventory pool, introduction-scene alternatives, local pose domain |
| Body | Local coordinate frame, member instances, parent attachment alternatives, repetition multiplicity |
| Camera hypothesis | Projection family, parameters, uncertainty, supporting observation IDs, gauge and lineage |
| Pose proposal | Identity, body-local rigid transform, camera hypothesis, observed feature matches, depth/contact derivation and rejection reasons |
| Assignment | Observed interval to predicted feature/instance or background/annotation; shared-seam identity where appropriate |
| Solution | Instances, body transforms, camera states, correspondences, unresolved alternatives, factor residuals and provenance |

Mould variants may share inventory capacity while retaining distinct meshes and
connectors. Proven aliases and physical symmetries are separate metadata; a
printed part does not inherit the yaw symmetry of its undecorated shape.

## 1. Compile the booklet into observations

Reuse PDF scene extraction but preserve all plausible panels and their roles:
main assembly, construction inset, exploded group, attachment, rotation, and
repetition. A page is not necessarily one step, and a PDF image is not
necessarily one physical part. Native paths and image XObjects are evidence
sources, not semantic instance labels. Scanned pages need a raster fallback.

Extract oriented strokes, junctions, stud ellipses, and adjacent material/color
regions. Keep unknown/annotation alternatives. Arrow classification must use
shape and context; removing everything red would erase red pieces. Keep uncertain
masks soft or as alternatives rather than permanently deleting their evidence.

Track persistent features between compatible drawings using robust geometric
agreement. Establish relative camera/view constraints from these tracks and
CAD-scale cues, independently of the previously selected assembly. View changes
create new view groups rather than forced similarity transforms.

Compute added, removed, and changed evidence with alignment uncertainty bands.
Difference evidence localizes proposal regions; it is not a segmentation oracle.
Occlusion, antialiasing, changing shading, viewpoint changes and exploded parts
can all change ink without introducing a new physical instance. Low-confidence
differences must not hard-exclude a pose.

## 2. Propose poses from the drawing

For each allocated identity alternative, match projected CAD feature templates
against local observations: oriented segments, endpoints, stud patterns, scale
and color-side transitions. Start with rigid orthographic/weak-perspective views
and the common orthogonal part rotations, explicitly reporting when those
families cannot explain a scene. Hinges, axles and arbitrary rotations require
additional connector-specific pose families before broader claims are possible.

Do not enumerate every mating position on the currently selected body. Match
image features first; lift the resulting image-space constraints into 3D:

`u = P (R v + t) + o`

For a fixed camera and part orientation, a 2D correspondence constrains translation
but leaves depth along the camera nullspace. Represent this as a bounded depth
domain, not a guessed point. Intersect it with compatible connector relations,
multiple observations, LEGO spacing where applicable, and physical feasibility.
Multiple part anchors can be solved together before any is attached to the
selected body. If evidence supplies no defensible finite bound, leave the
domain unresolved and record that fact instead of imposing a hidden set-sized box.

Union three proposal sources: observed-feature matches, drawing-change regions,
and connector mates from multiple live body hypotheses. Each source retains
provenance. The connector fallback handles hidden additions, but failure to mate
to the current winner cannot veto all drawing-supported alternatives. Incomplete
connector metadata produces uncertainty, not proof of impossible geometry.

## 3. Score explicit instance correspondences

Render candidate assemblies with depth, instance ID, feature ID, and visible
boundary provenance. Split predicted and observed strokes into comparable
intervals. Solve a partial, capacity-constrained correspondence assignment:

* A drawing interval can explain one predicted physical boundary. Two parts
  sharing a seam use one boundary with two adjacent instance IDs, so the same
  ink cannot independently reward arbitrarily many pieces.
* Matching cost includes distance normalized by localization uncertainty,
  tangent/curvature agreement, endpoint/junction compatibility, and material
  transition evidence. Color supports geometry; it is not sufficient ownership.
* Unmatched predicted **visible** features incur a cost. Hidden features do not.
  Unmatched observed construction features also incur a cost, with explicit
  annotation/background alternatives and a calibrated cost for using them.
* A fully occluded part receives no invented visual confidence. Its support must
  come from another drawing, an assembly relation or physical constraints.

This is a joint assignment, not independent nearest-edge/chamfer scores per
part. Independent matching could let every same-colored part reuse the same
stroke and reproduce the old plateau. Visibility depends on the hypothesized
assembly; recompute it after edits and penalize unsupported occluders. Printed
decoration edges must be distinguished from shape edges where CAD permits it.

The proposed objective is a sum of robust correspondence residuals, unexplained
visible evidence, cross-drawing tracks, assembly relations, and instruction-role
evidence, subject to inventory and valid-geometry constraints. Normalize by
measurement uncertainty and report each term. Weights and rejection tolerances
must be fixed on development cases before held-out evaluation. This document
does not assign unmeasured confidence probabilities to score margins.

Single-view ambiguity still exists. If two physically distinct assemblies predict
the same available evidence, ownership cannot magically distinguish them.
Preserve both, with deterministic ordering and an ambiguity count.

## 4. Solve a revisable assembly graph

Discrete variables represent identity/pose alternatives, feature assignments,
instruction roles and body attachments. Continuous variables represent cameras
and allowed pose refinements. Fix one arbitrary root frame to remove the global
rigid gauge; different gauges must yield equivalent solutions.

Implement a bounded alternating solver: correspondence assignment at fixed
geometry; constrained discrete assembly selection; robust camera/pose refinement;
visibility refresh; then regeneration where residual observations demand it.
Use assignment/min-cost-flow machinery for matching and a discrete constraint
solver for finite pose domains. Do not assume the full visibility-dependent
problem is one linear assignment or one convex optimization.

Process small scene windows with multiple retained hypotheses. Reopen earlier
variables when later independent evidence contradicts them. Track any fixed-lag
pruning as a measured approximation and retain restart checkpoints. Final
booklet reconciliation revisits body attachments and cross-view consistency;
it must not merely concatenate emitted page fragments.

Every branch receives the same drawing-derived camera proposals and refinement
budget. Cameras remain variables constrained by independent tracks, not a single
accepted registration inherited from the winning body. Initialization-lineage
permutation is a required control. Simply independently fitting each candidate
with the old IoU objective would recreate the same circularity at another level.

Subassemblies live in local frames until attachment. Repeated constructions
instantiate distinct physical copies. Exploded drawings have separate display
displacements linked to assembly pose through arrow/contact constraints; the
solver must not move the final part into its illustrated floating position.

Inventory limits remain accounting constraints. They are not a revived inventory
capacity ranker or a reason to place unsupported pieces to reach a count target.

## Implementation boundaries

Proposed modules (names describe planned files, not existing capabilities):

| Module | Responsibility |
| --- | --- |
| `placement_v2_observations.py` | Stable scene/feature records and evidence cache |
| `placement_v2_tracks.py` | Drawing-only matches, relative views, uncertain change regions |
| `placement_v2_proposals.py` | Feature-to-CAD hypotheses and depth/contact domains |
| `placement_v2_correspondence.py` | Visibility-aware interval ownership and residuals |
| `placement_v2_graph.py` | Instance/body/camera variables and constraints |
| `placement_v2_solve.py` | Bounded alternating inference, reopening and ambiguity records |
| `placement_v2_run.py` | PDF-only orchestration and quarantined LDraw/report export |
| `placement_v2_evaluate.py` | Separate post-run reference evaluation process |

Reuse the front-end modules `placement_pdf_inventory`, `global_pdf_slot_assignment`,
`placement_slot_size_gate`, and `placement_slot_adapter` behind schema adapters.
Reuse `vector_scene` extraction with its selection limitations exposed. Reuse
universal CAD geometry, feature-edge extraction, and render buffers after checking
their coordinate and visibility contracts. `placement_local_delta.render_layers`
already exposes triangle ownership: adapt that into stable instance/feature IDs.
`placement_drawing_scale.align` is a relative-view proposal, not absolute camera
calibration; silhouette growth can bias its scale.

Do not change protected clego files or production model selection. Runtime must
not import evaluation code or accept a truth path. Launch evaluation only after
the runtime output hash is sealed. Cache keys include PDF, CAD, configuration,
source and observation-schema hashes; a file existing is not sufficient reuse
validation. VLM usage is recorded in a separate development report.

## Falsifiable build sequence

1. **Observation and ownership slice.** Build the correspondence scorer and
   replay single-page candidate sets before integrating a new chain. Include
   41601's ambiguous opening, 41624's incorrectly preferred opening, 40377's
   stacked/exploded page 17 and same-color/occlusion cases. Include at least one
   previously successful control. Reference-supplied candidates are permitted
   only in this explicitly evaluation-only discrimination experiment.
2. **Drawing-driven proposal slice.** Measure recall using PDF/CAD-only generated
   poses, including bootstrap and wrong-parent cases. Count loss at feature
   extraction, matching, depth lifting, collision, truncation and selection.
   Do not repair a miss by silently injecting reference poses into the runtime bank.
3. **Joint-camera window slice.** Solve openings and short windows without a
   hand-built body. Permute camera initialization and branch order, test changes
   of gauge and repeated identical instances, and retain ties. Compare old/new
   generator crossed with old/new scorer so the source of gains is identifiable.
4. **Autonomous booklet slice.** Only after the earlier gates, run all three
   baseline fixtures from PDF alone with source snapshots and full provenance.
   Then evaluate untouched sets and different instruction styles before tuning
   for further breadth. Six related BrickHeadz fixtures cannot establish generality.

Proposed gates, to freeze in the experiment manifest before measurements:

* Ownership slice: prohibit unsupported duplicate credit and favor the correct
  candidate over the old wrong winner on at least 80% of a preregistered set of
  visually distinguishable candidate pairs; report indistinguishable pairs
  separately with the entire denominator. No ties count as successful separation.
* Proposal slice: at least 95% recall of eligible poses on frozen page fixtures
  within declared time/memory budgets. Also report recall against **all** parts,
  naming every unsupported family; conditional recall is not model coverage.
* Window slice: improve exact added-part poses on each baseline fixture without
  manual openings; show that improvements survive lineage/ordering controls.
* Booklet target: at least 90% full-model pose recall per evaluated set, with
  precision, completeness, strict/alias/structural metrics, runtime, unresolved
  instances, tie counts and driver contribution all reported. Macro averages
  alone cannot pass a failing set. This is an acceptance target, not a forecast.

Evaluation aligns a single whole-model rigid frame and uses one-to-one instance
matching; it must not independently realign each fragment or page to truth.
Normalize legitimate subpart decompositions and report the normalization policy.
Hidden unresolved parts stay in the full-model denominator. Geometry-equivalent
symmetry does not justify ignoring print orientation or connector differences.

If ownership cannot separate the single-page controls, stop integration and
inspect which actual observations differ. If candidates are absent, stop scorer
tuning and repair proposal coverage. If the available PDF evidence is genuinely
ambiguous, report an equivalence class rather than claim a recovered exact model.

## Scope and expected outcome

The first deliverable should be the measured observation/ownership slice, not a
new full-booklet launcher around the old scorer. It can establish whether the
proposed evidence resolves the known defect before substantial solver investment.
This is a substantial research implementation with several independently risky
subsystems; this review provides no defensible completion-date or accuracy promise.

The architecture targets unattended processing of all PDFs, with complete models
where supported and explicit partial/ambiguous results elsewhere. A guarantee of
exact complete reconstruction of every PDF is not justified: drawings can omit
or obscure information. Broader support needs measured handling of scanned
instructions, Technic joints, flexible parts and other families beyond BrickHeadz.

Sources: [handoff](recon-handoff-2026-09-09.md),
[measurement ledger](pdf-placement-rearchitecture-2026-09-07.md), and the named
source modules inspected during this review. No new reconstruction accuracy
experiment was run as part of this architecture document.
