# Placement v2: architectural review and evidence rules

Decision: stop expanding the current placement adapter until its observation,
feasibility and selection contracts pass independent controls. Keep useful
primitives; do not treat the current adapter as the foundation of a validated
full-booklet solver. This review follows implementation commit `b4b6f4a`.

This is not a recommendation to discard v2 and start a third implementation.
The intended architecture already specifies most of these requirements. The
immediate work is a smaller diagnostic harness and a localized solver redesign;
revisable windows and broader proposals follow validated evidence, not another
large speculative integration.

Sources: [v2 measurements](pdf-placement-v2-results-2026-09-11.md),
[intended architecture](pdf-placement-v2-architecture-2026-09-11.md),
[prior handoff](recon-handoff-2026-09-09.md), and
[3D generation audit](lego-3d-generation-audit-2026-09-08.md).
This review inspected current code and documents; it did not rerun historical
experiments or independently reproduce the audit's production measurements.
Implementation assignments, evidence gates and remaining TODOs now live in the
[rework tracker](pdf-placement-v2-work-plan-2026-09-11.md).

## What should change before refinement

1. **Represent physical instances, cameras and assembly history explicitly.**
   The continuation bridge freezes the chosen base; raw search inherits the old
   registry and camera hypotheses. Neither implements the revisable assembly
   graph in the architecture. Use body-local subassemblies and short overlapping
   scene windows with shared instance identities and revisable poses/cameras.
   Preserve identity and introduction-step alternatives: approximate allocation
   is evidence, not unquestionable exact per-page quotas. Keep the working
   inventory front end, with its measured limits.

2. **Use drawing-supported pose domains and attachment relations.**
   The translation-lifting primitive exists, but is not a measured proposal
   generator. Image correspondences should constrain projected placement;
   compatible connectors and other views should constrain the remaining depth.
   Keep unresolved depth explicit. Existing mating enumeration can supplement
   these domains, but should not make the previously selected body the sole
   source of possible poses.

3. **Optimize and validate a consistent assembly objective.**
   `placement_v2_pose_search.py` ranks base-plus-one-part renders, solves token
   assignment using single-part visibility and conditional base suppression,
   then applies true assembly visibility and ellipse scoring to only one
   incumbent per camera. The solve does not optimize that final objective.
   Another added part can hide an edge or create a seam, invalidating unary
   evidence. Preserve cheap scores as proposals/bounds only where justified;
   evaluate competing complete assemblies under the same declared objective.
   A bounded exhaustive control must precede choosing a scalable search method.

4. **Make observation structure stronger than anonymous point capacity.**
   Exclusive point matching prevents duplicate credit, but cannot by itself
   distinguish a hole, a stud, an outer boundary, an internal seam or a nearby
   unrelated edge. Test coherent curves, endpoints/junctions and color on the
   two sides of an edge. Explicitly model annotation/background alternatives.
   Test these channels separately; additional feature names are not evidence
   that they discriminate real PDF drawings.

5. **Separate visibility logic from physical support.**
   `placement_v2_joint_assignment.py` encodes each base feature as a visible or
   hidden auxiliary part. `placement_v2_pose_assignment.py` then sends support
   flow through those states, with capacity based on all quotas, including
   hundreds of auxiliary features. This is an avoidable coupling. Use direct
   Boolean visibility constraints and reserve attachment/support relations for
   physical instances. It is a plausible efficiency improvement, not a proven
   explanation of all solver difficulty. Benchmark it rather than promising a
   speedup. The adapter's requirement that every real pose match at least one
   observed feature is also unsuitable for legitimately hidden pieces; their
   evidence may come from an earlier scene or a mechanical relation.

Keep immutable provenance, independent evaluation, explicit refusal, padded
rendering, exploded/attached state separation and exclusive feature accounting.
Those are valuable contracts even though the current placement accuracy is low.

## Ideas worth borrowing from the 3D generation audit

* **Fix and verify coordinate frames at their source.** The audit attributes
  major conversion defects to local origins, alignment payloads and basis
  changes. For recon, verify CAD vertices, connector frames, rotations, camera
  projections and exported transforms together, including rotated and chiral
  fixtures. Do not apply Mecabricks/LXF correction tables to native LDraw poses.
* **Borrow connector metadata and geometry jointly, with explicit coverage.**
  Part-local connector positions, axes and compatible families are useful depth
  and attachment evidence. Surface proximity alone is not a mechanical joint;
  an absent connector entry is not evidence that a joint is impossible. The
  browser table deliberately omits parts and large connector grids; reuse the
  underlying parser/data with measured coverage, not that compact table as a
  universal recon constraint. Validate its frame conventions independently.
* **Do not force every model into one connected component.** Subassemblies,
  minifigures and detached props can be intentional. Model the booklet's
  assembly relationships and scene roles. Contact tests provide evidence within
  those relationships; connectedness cannot certify intended placement.
* **Attach every quality claim to exact bytes and dependencies.** Copy the
  audit's content-versioned provenance and stale-result invalidation principles.
  Extend current run seals into an experiment registry with implementation
  validity and explicit supersession. Successful loading, healthy coverage and
  a passing unit suite must remain distinct from geometric accuracy.
* **Exercise the actual path and independent controls.** A transform unit test
  or synthetic contact example cannot validate a real reconstruction. Likewise,
  a correction that improves source conversion is not a PDF inference result.
* **Keep denominators fixed and expose affected populations.** Report full-set
  recall, emitted precision and stage-specific proposal recall separately,
  including hidden and unresolved parts. Split changed and unchanged cases.
  More recovered difficult cases can lower a conditional accuracy ratio even
  when absolute correct placements rise; coverage is reach, not correctness.

The audit itself is not infallible evidence. It contains evolving checked-off
notes and remaining caveats. `scripts/ldcad_connectivity.py` still calls some
geometry/contact results certificates, whereas the later audit explicitly
rejects that claim. Prefer the narrower verified contract; do not inherit
authority from the wording of a comment or handoff.

## Durable lessons, with bounded claims

| Finding | Evidence status | What it supports; what it does not |
| --- | --- | --- |
| v2 raw-pose trials v1–v5 mutated cached projected coordinates | Confirmed implementation defect, fixed with a regression | Invalidate those trials' ranking/visibility conclusions. They do not reject their intended algorithms. |
| 41624 opening replays v1–v3 confused depicted and attached state | Confirmed implementation defect | Invalidate scoring conclusions for that display state. Keep a distinct representation of the two states. |
| v6 correctly solved its finite surrogate but chose three wrong additions | Valid recorded control | The tested surrogate/bank is inadequate. It does not prove every image-based objective inadequate. |
| v7 padding retained off-canvas penalties but did not improve placement | Valid recorded control, time-limited solve | Padding repairs a scoring contract; it is not a demonstrated accuracy improvement. |
| v8 camera 0 retained three correct poses but selected none | Valid recorded control, nonoptimal incumbent | Candidate retention is insufficient. Joint feasibility, optimizer quality and objective preference still need separation. |
| v8 took 1,422.26 seconds for one three-addition checkpoint | Valid recorded runtime, specific hardware/process state | The present implementation is not a demonstrated scalable full-booklet solution. It is not a general complexity lower bound. |
| 101 tests passed | Implementation regression evidence | Tested contracts pass. This does not establish placement quality, semantic correctness or absence of other bugs. |
| Opening selections reached 6/7 and 3/3 structural | Valid development-fixture measurements | Certain opening ambiguities can be resolved. Not held-out generalization; not full-model recall; 41601's prior heuristic already reached 6/7. |
| Prior handoff reports 3.2% mean autonomous full-model placement | Historical measurement, not rerun by this review | Preserve as the reported baseline, with its original artifacts and metric. Do not replace it with partial opening precision. |
| Prior later-view trial inherited an accepted hypothesis's camera | Historical confounded experimental design | Reject that circular multi-view protocol, not independent multi-view inference. |
| Prior finite-bank ceilings and budget increases failed | Historical implementation-specific measurements | Avoid repeating the same bank/scorer combination without a reason. No impossibility theorem for broader proposals or image inference. |

The recorded v8 solver `mip_gap` comes from an objective with a constant removed;
the reported total cost adds that constant back. Relative gaps are sensitive to
this shift. Record raw primal and dual bounds, the constant and the absolute gap
before interpreting their magnitude. The reliable current conclusion is that
neither incumbent is proved optimal, not that it is a particular percentage
away from the displayed total cost's optimum.

## Required next experiment, before another booklet run

Freeze a small evaluation-only set of verified assemblies with real PDF crops,
known wrong alternatives and synthetic controls. Include overlap, seams,
exploded state, hidden parts, rotated connectors and camera ambiguity. Reference
assemblies may supply diagnostic controls in this separate harness; they must
not enter runtime proposal generation, caches or set-specific rules. Reserve
untouched fixtures for subsequent evaluation.

For each case, answer these questions independently:

1. Does the known assembly project and export correctly under independently
   checked transforms, with the correct depicted state and visible features?
2. Does the runtime generator retain its poses under one shared alignment?
3. Can those poses coexist under the actual inventory, collision, support and
   visibility constraints? Retention is not a feasibility witness.
4. Among a deliberately small exhaustively enumerated bank of feasible complete
   assemblies, does the declared objective prefer the known assembly, tie it,
   or prefer a wrong one? Report visual indistinguishability separately.
5. Does the intended scalable optimizer recover that same finite optimum?

Each failure now names a repair target: representation, generation, constraints,
objective or optimizer. Integration is justified only after these gates pass
on the frozen controls. My previous iteration expanded the adapter before
establishing that evidence; that sequencing should not be repeated.

Every future experiment record should contain: claim ID; exact inputs, code,
CAD and configuration; observation/pose/feasibility witnesses; metric and full
denominator; primal/dual bounds; runtime; implementation validity status;
invalidating defects; superseded run IDs; and an explicit permitted conclusion.
Use `valid`, `invalidated`, `confounded` and `unverified` separately from
`improved` or `failed`. A failed implementation is useful bug evidence but weak
evidence against the idea it was intended to implement.

Outlook: code-only reconstruction remains a plausible research direction for
well-observed rigid assemblies. Current evidence does not justify optimism that
incremental tuning of this adapter will reach 90%, or a promise of complete
accurate reconstruction for every PDF. Progress should be judged by passing
the bounded tests above and then held-out full-model measurements.
