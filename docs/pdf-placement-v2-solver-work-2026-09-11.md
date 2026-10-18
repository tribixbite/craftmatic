# Placement v2 bounded solver rework

Status: implementation complete and focused tests passing on 2026-09-11.

## Plan

- Keep `solve_joint_base_assignment` and its current objective/matching policy.
- Represent each base feature with one direct visibility binary constrained to
  equal the negation of the OR of its selected occluding physical poses.
- Keep support-flow variables and capacities limited to physical pose options.
- Add backwards-compatible raw-bound, objective-constant, absolute-gap,
  model-size and solve-time diagnostics.
- Exercise exact objectives, multi-occluder OR visibility, physical support
  cycles and the absence of auxiliary support flow in focused tests.

## Scope and limits

Owned code is limited to the pose and joint assignment modules, their two test
files, and this work log. This change does not alter proposal generation,
visible-feature grouping/matching policy, or the declared assignment objective.
It does not run GPU, renderer, web/CLEGO, or full-booklet workloads.

## Test status

The focused pose/joint assignment suite passes 26 tests. The latest broader
`test_placement_v2_*.py` discovery passes 87 tests. These are implementation
regressions only; no renderer, GPU, real-fixture, or booklet accuracy claim is
made here.

## Diagnostics contract

`raw_primal_bound` and `raw_dual_bound` use the shifted solver objective, before
the unmatched-observation `objective_constant` is restored in `total_cost`.
`mip_gap` retains SciPy/HiGHS' relative shifted-objective value.
`absolute_gap` is `raw_primal_bound - raw_dual_bound`; a dual bound exceeding
the primal beyond numerical tolerance is rejected instead of hidden with an
absolute-value operation. All new result fields have defaults for compatibility.

`solver_time_seconds` measures only the `scipy.optimize.milp` call. Model
construction and result validation are outside that timer. Variable,
constraint and sparse-nonzero counts describe the submitted model;
`visibility_variable_count` and `physical_flow_variable_count` expose the
separation directly. A base feature adds one visibility variable and no support
flow variable. Physical flow count remains the number of real support arcs plus
real root-source arcs.

## Preserved limits

The direct conditional-feature path is private to the pose solver and is used
by the unchanged public `solve_joint_base_assignment` signature. Shared-boundary
preparation remains scoped to each pose/base-feature owner, matching the prior
policy. The default real-pose match floor remains one; callers may explicitly
pass zero for physical pieces whose evidence comes from support or prior views.

Solver source freeze supplied to the independent controls before comparative
runs:

- `placement_v2_pose_assignment.py`: `AA45FC283B780DABF0EE80586C9D56B690B343A2CD443D1C22FA8507A46663F6`
- `placement_v2_joint_assignment.py`: `569DABA9624F00BF168BC0E56BF339DC6C1F961C9D41F960BC48FB3A9BB1BACA`
