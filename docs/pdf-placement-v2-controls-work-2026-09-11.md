# Placement v2 independent controls work log

Owner: `independent_controls`  
Status: complete for the bounded synthetic control requested in Phase A  
Date: 2026-09-11

## Scope and result

Added `scripts/pdf-recon/placement_v2_controls.py` and
`scripts/pdf-recon/test_placement_v2_controls.py`. The control is an
evaluation-only finite oracle. It does not call the production MILP, SciPy
optimization, or the production correspondence preparation/matching helpers.

For a deliberately small caller-supplied bank, it:

* enumerates every combination implied by exact physical quota counts;
* rejects pair conflicts and checks physical support by ordinary reachability
  from selected `base_supported` roots over selected parent-to-child arcs;
* computes each base feature as visible exactly when no selected pose belongs
  to its occluder set;
* prepares pose and base token groups independently, preserving the frozen
  public API's per-owner `shared_boundary_id` scope;
* enumerates unmatched or eligible-observation choices for every visible
  prediction group and enforces exclusive observation ownership;
* applies the explicit per-real-pose match floor, including the supported
  zero-token hidden-piece case at floor 0;
* returns all feasible physical selections, all match-floor-feasible scores,
  and every tied minimum-cost physical selection in deterministic order.

`check_physical_pose_selection` is a separate bounded entry point for a fixed
selection. It checks exact quotas, conflicts, rooted physical support, and the
base-visibility OR without constructing the visual matching state space. This
allows a larger sealed fixture to use an independent mechanical/visibility
witness while correctly leaving its hundreds-of-features objective as
non-exhaustive solver evidence.

The control has explicit limits for input options, observations, quota
combinations, prediction groups per assembly, and a conservative total matching
state bound. It raises `ValueError` before scoring if a limit is exceeded. It
also refuses a case when `CorrespondenceConfig.max_neighbors_per_prediction`
would discard any otherwise eligible observation edge. Therefore agreement is
an uncapped exhaustive matching result, not certification of a production
graph after neighbor thinning.

## Frozen API coordination

Coordination with `solver_rework` fixed comparison against the unchanged public
entry point:

```text
solve_joint_base_assignment(options, observed, quotas, base_features,
    conflicts=(), config=..., time_limit=30,
    minimum_matches_per_real_pose=1)
```

The frozen solver hashes used for the final comparative run were:

```text
placement_v2_pose_assignment.py
AA45FC283B780DABF0EE80586C9D56B690B343A2CD443D1C22FA8507A46663F6
placement_v2_joint_assignment.py
569DABA9624F00BF168BC0E56BF339DC6C1F961C9D41F960BC48FB3A9BB1BACA
```

The current production contract groups a shared boundary within one pose or
one base feature. It does not merge the same `shared_boundary_id` across two
separately selected pose owners. The oracle mirrors that declared finite
surrogate exactly. The overlap control separately verifies that two physical
prediction groups cannot reuse one observed interval, while a two-token seam
inside one pose consumes only one matching row.

## Tests and evidence

The new tests compare the oracle with the public joint solver on:

* exact quotas, conflicts, and the complete tiny feasible-selection set;
* rooted alternative support, an accepted rooted cycle, and a rejected
  disconnected support cycle;
* direct base visibility for the OR of multiple selected occluders;
* a mechanically supported, zero-token hidden physical piece at explicit floor
  0 and its infeasibility at explicit floor 1;
* overlapping predictions, exclusive observation use, and a scoped shared seam;
* observation-dependent uncertainty eligibility and normalized distance cost;
* two equal-cost pose alternatives, with both oracle optimum ties retained;
* option/observation/quota-order permutation invariance and a nonempty pool with
  an explicit zero quota;
* a deterministic four-assembly fixture containing distance, kind, material,
  uncertainty, unmatched, and annotation costs;
* refusal at option, pose-combination, matching-state, and neighbor-cap bounds.

For each small parity fixture, the test forces every exact-quota physical
selection through the public solver. It compares rejection versus feasibility,
then checks base visibility and total objective for every feasible selection.
It finally checks that the unrestricted public optimum has the oracle optimum
cost and belongs to the oracle's full tied-optimum set.

Final focused command (run outside the filesystem sandbox because the installed
SciPy native DLLs receive `Access is denied` inside it):

```text
cd C:\git\craftmatic\scripts\pdf-recon
python -m unittest test_placement_v2_pose_assignment.py \
  test_placement_v2_joint_assignment.py test_placement_v2_controls.py -v
```

Result after the final additions: **37 tests passed in 0.041 seconds**. This
includes 11 independent-control tests and the 26 frozen solver tests.
`git diff --check` passed for both owned Python files.

## Evidence boundary and remaining work

This establishes agreement between the public optimizer and an independent
exhaustive implementation for the tested finite surrogate. It is evidence for
the exact-quota, conflict, rooted-support, conditional-visibility, exclusive
matching, uncertainty, floor, objective, and tie contracts on those tiny
fixtures.

It does not establish that this surrogate represents real PDF semantics, that
the pose bank contains a correct pose, that unary feature visibility equals the
visibility of a complete rendered assembly, or that the objective prefers the
correct real assembly. No PDF, CAD geometry, reference pose, renderer, camera,
or real crop enters this control. The separate sealed real-fixture work must
test those questions. A passing oracle comparison cannot be reported as
placement accuracy or evidence that a booklet reconstruction is correct.

## TODO handed to integration

- [x] Implement independent bounded selection, support, visibility, and matching.
- [x] Refuse rather than truncate at every declared oracle bound.
- [x] Compare complete tiny feasible sets, objectives, optima, and ties against
  the frozen public joint solver.
- [x] Exercise overlap/seams, zero-token floor 0, wrong cycles, uncertainty,
  explicit floors, and deterministic multi-cost fixtures.
- [ ] Combine with the sealed real-fixture controls before drawing any conclusion
  about PDF evidence, candidate quality, or real assembly preference.
- [ ] If cross-pose seam coalescing becomes a new public semantic contract, add
  it to both solvers and create a new independent control; do not reinterpret
  this per-owner parity result after the fact.
