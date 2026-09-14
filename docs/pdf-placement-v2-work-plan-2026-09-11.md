# PDF placement rework: implementation plan and task tracker

Owner: primary agent; implementation/testing delegated to GPT-5.6 Sol.
Status: second implementation wave active on objective consistency; first wave
validated. This is the canonical TODO list for the work following
[the architectural review](pdf-placement-v2-design-review-2026-09-11.md).
The [architecture](pdf-placement-v2-architecture-2026-09-11.md) defines the target;
the [experiment ledger](pdf-placement-v2-results-2026-09-11.md) records prior runs.

## Rules and completion criteria

* Runtime inputs: PDF, optional inventory and universal CAD/catalog/connector
  data. Zero runtime VLM and no reference model or set-specific placement rules.
* Reference assemblies may enter explicitly separate evaluation controls only.
  Their candidate choices and cached artifacts must never feed runtime search.
* Preserve other agents' work, especially web export. Each worker owns explicit
  files; the primary agent stages/commits only this task's reviewed files.
* Keep one GPU job at a time. Use fresh run directories, frozen source/input/CAD
  receipts, fixed denominators and explicit validity labels. Do not overwrite
  protected clego sources, model files or historical evidence.
* A checked box means its stated acceptance evidence exists. Tests passing,
  implementation existing and geometric accuracy are separate completion states.
* No new full-booklet run until the bounded representation, feasibility,
  objective and optimization gates below pass. A failed gate creates a specific
  repair task rather than an uninformative parameter sweep.

## Active assignments

| ID | Owner | Scope and owned files | Status | Acceptance |
| --- | --- | --- | --- | --- |
| S1 | `solver_rework` / Sol | Existing `placement_v2_pose_assignment.py`, `placement_v2_joint_assignment.py`, their two tests; [solver work log](pdf-placement-v2-solver-work-2026-09-11.md) | Complete for bounded scope | Direct visibility and physical-only flow; independent exhaustive agreement on synthetic controls |
| T1 | `independent_controls` / Sol | New `placement_v2_controls.py`, its test; [controls work log](pdf-placement-v2-controls-work-2026-09-11.md) | Complete for bounded scope | Eleven controls; complete tiny feasible sets, optimum/ties and refusal at limits |
| F1 | `real_fixture_controls` / Sol | New `placement_v2_fixture_controls.py`, its test; [fixture work log](pdf-placement-v2-fixture-work-2026-09-11.md) | Complete for first fixture | Correct combination feasible; surrogate/final preference reversal reproduced with guards and old-score parity |
| I1 | Primary | This tracker, documentation links, integration review and task-only commits | Review and tests complete | 121 tests passed; only owned files included in the integration commit |
| O2 | `complete_objective` / Sol | New `placement_v2_complete_objective.py`, its test; [objective work log](pdf-placement-v2-objective-work-2026-09-11.md) | In progress | One reusable full-assembly objective, unchanged v8 weights; parity with sealed complete renders |
| S2 | `complete_search` / Sol | New `placement_v2_complete_search.py`, its test; [complete-search work log](pdf-placement-v2-complete-search-work-2026-09-11.md) | In progress | Enumerate every mechanically feasible complete assembly within declared bounds, score with O2, preserve ties |
| F2 | `complete_fixture` / Sol | New `placement_v2_complete_fixture.py`, its test; [complete-fixture work log](pdf-placement-v2-complete-fixture-work-2026-09-11.md) | In progress | All 12 exact-quota combinations of the frozen six-pose diagnostic domain; independent evaluation after selection |
| I2 | Primary | This tracker and second-wave integration | In progress | Review scorer/search contracts, guard evidence, run combined tests and commit only owned files |

All paths in the table are under `scripts/pdf-recon/` unless linked as docs.
Workers must log changes, tests, limitations and handoff in their own MD, avoiding
concurrent edits to this master tracker. The primary updates consolidated status.

## Phase A: trustworthy bounded controls (current work)

- [x] A0. Record architectural critique and invalidated trial classes in a durable
  document (`73cb5e9`); preserve current implementation as a measured baseline.
- [x] A1. Launch separate Sol implementation, independent-test and real-fixture
  workers with explicit ownership and shared API coordination.
- [x] A2 / S1. Replace fake base-feature parts with direct visibility variables;
  retain rooted support on physical instances only. No silent scoring changes.
- [x] A3 / S1. Report raw primal/dual bounds, removed constant, absolute gap,
  variable/constraint counts and timing. Do not compare shifted relative gaps
  with displayed total cost.
- [x] A4 / T1. Independently enumerate tiny physical pose combinations, reject
  conflicts/rootless support components, apply visibility and exhaustive
  one-to-one feature matching; include explicit limits and tie reporting.
- [x] A5 / T1. Compare MILP against the independent oracle on frozen synthetic
  cases: overlap, seams, uncertain observation positions, alternative supports,
  hidden pieces with zero visibility floor and invalid disconnected cycles.
- [x] A6 / F1. Freeze the first real diagnostic fixture from 41624 page 3 with
  PDF/CAD/source hashes, common-frame reference alignment, correct alternatives
  and runtime wrong selections. Label reference use evaluation-only throughout.
- [x] A7 / F1. Produce a witness or precise rejection for joint feasibility of
  the retained correct additions under actual runtime constraints.
- [x] A8 / F1. Compare a bounded set of complete assemblies with the same final
  visibility/edge/curve objective; separate ties and wrong preferences. This is
  an objective diagnostic, not runtime candidate recall or generalization.
- [x] A9 / I1. Review combined code and run the full v2 regression suite plus
  new controls; record test count, runtime and file list before committing.

## Phase B: representation and objective gates

Dependencies: validated Phase A harness, not merely completed source files.

Current B3/B5 slice is O2/S2/F2 above. Freeze the six-pose union from the previous
evaluation-only fixture (two pins and four bricks, choose one and two) before
running. Score all mechanically feasible combinations, including mixed correct/
wrong hybrids, using the existing complete objective without a weight sweep.
The search consumes no truth labels, but the domain is reference-selected
diagnostic data and cannot establish autonomous candidate recall or accuracy.
No permanent runtime switch or full-booklet run is part of this slice.

- [ ] B1. Independent CAD → camera → image and export round-trip fixtures,
  including rotated/chiral parts, units, origin/basis and nested transforms.
- [ ] B2. Real PDF controls for overlap, shared seams, exploded/attached state,
  hidden parts, connector orientation and camera ambiguity. Verify crop/state
  annotations; freeze training/development versus untouched evaluation split.
- [ ] B3. Check full correct-assembly visibility, including new-part/new-part
  occlusion and changing seam topology. Remove unary-visibility assumptions from
  any claim of an exact whole-assembly objective.
- [ ] B4. Test coherent curve, endpoint/junction and color-side channels one at
  a time against frozen wrong alternatives. Distinguish annotation/unknown ink.
- [ ] B5. Declare one assembly objective and test its exact finite optimum;
  explicitly separate image-indistinguishable alternatives. The existing
  surrogate solve followed by one final rescore per camera does not pass.
- [ ] B6. Choose and validate a scalable optimizer against that finite optimum;
  cheap approximations may propose/prune only under documented assumptions.
- [ ] B7. Replace the universal per-part visible-match floor with evidence states
  supporting hidden parts through previous scenes/mechanical constraints; test
  against unsupported invisible placements. Avoid removing the guard blindly.
- [ ] B8. Benchmark cold/warm times, phase costs, memory and solver bounds on
  identical frozen inputs. Keep solver speed separate from pose accuracy.

## Phase C: proposal and temporal architecture

Dependencies: objective and optimizer pass bounded controls.

- [ ] C1. Immutable physical instance IDs; identity/color/introduction-scene
  alternatives rather than treating approximate allocation as exact page truth.
- [ ] C2. Drawing-driven projected pose domains with explicit nullspace depth;
  universal CAD connectors and multiple views constrain depth. No truth injection.
- [ ] C3. Audit connector extraction frames and coverage by family; combine
  compatible connectors with geometry. Missing metadata means unknown;
  proximity and graph connectivity are not assembly certificates.
- [ ] C4. Independent drawing tracks and camera hypotheses with uncertainty;
  do not inherit accepted-body registration as independent corroboration.
- [ ] C5. Body-local subassemblies and overlapping scene windows with revisable
  earlier placements/cameras; preserve candidate ties and gauge consistency.
- [ ] C6. Handle construction insets, arrows, repetition and deliberately
  detached bodies without forcing the whole set into one component.
- [ ] C7. Measure recall loss separately at extraction, identity, pose lifting,
  constraints, thinning, camera filtering and final selection under one shared
  whole-model alignment. Hidden/unresolved parts remain in the denominator.

## Phase D: evidence durability and full-booklet acceptance

- [ ] D1. Machine-readable experiment index linked from Markdown: claim IDs,
  exact inputs/dependencies, configuration, witnesses, metrics/denominators,
  primal/dual bounds, time/memory and explicit permitted conclusions.
- [ ] D2. Dependency-based invalidation/supersession of experiment conclusions;
  validity (`valid`, `invalidated`, `confounded`, `unverified`) is independent of
  whether a trial improved accuracy. Seed with the known v1–v5 cache defect and
  opening display-state defect without treating unaffected trials as invalid.
- [ ] D3. Reproduce selected historical claims before promoting them to durable
  algorithmic lessons; preserve narrower implementation-specific conclusions.
- [ ] D4. Autonomous complete-booklet controls on 40377, 41601 and 41624 with
  no manual opening, then untouched sets and instruction styles. Report strict,
  alias and structural precision/recall, emitted/full inventory, ambiguity and
  runtime separately. Do not substitute opening precision for full-set recall.
- [ ] D5. Validate additional pose/part families and scanned instructions before
  broad support claims: Technic, hinges, arbitrary rotations, flexible parts.
- [ ] D6. Production promotion only after per-set full-model acceptance and
  preserved source-quality rules. The ≥90% target remains a target, not a promise.

## Current evidence and next decision

Baseline: v8 retained all three correct next-part poses in camera 0 but selected
none; the solve was not proved optimal. Final winner was 3/6 structural, 1/6
strict, with all additions wrong. Runtime was 1,422.26 seconds. The old v2 suite
passed 101 tests. These facts motivate A2–A8; they do not establish which change
will improve real placement accuracy.

First-wave outcome: **121 tests passed in 11.27 seconds** across all 18 v2
pytest modules. The independent oracle checks every feasible tiny selection,
objective and tied optimum; it refuses problems where its bounds or a
correspondence cap would prevent exhaustiveness. This is synthetic surrogate
validation, not real-model accuracy.

The evaluation-only real fixture compares two complete assemblies under the
same camera and base. Both fixed-selection solves reach optimality:

| Assembly | Joint surrogate cost (lower better) | Complete-render cost (lower better) |
| --- | ---: | ---: |
| Retained correct additions | 1251.502603 | 0.886359885 |
| Old camera-0 wrong selection | 1245.567979 | 1.035174597 |

The correct pose combination is mechanically and jointly feasible. The
surrogate prefers the wrong combination, while the complete-render objective
prefers the correct one. The reconstructed wrong complete score exactly matches
the sealed v8 camera-0 score. Source/input/CAD start/end guards pass in
`output/pdf-placement-v2/41624-page3-fixture-diagnostic-v2/diagnostic.json`, seal
`1c9afb960755af2b047354dee0f6030cc772034dbef380e8617b030a1de7aa9b`.
Its predecessor v1 is superseded by this stronger provenance control.

**Next assignment: B3/B5, objective consistency.** Reproduce and eliminate the
preference reversal on bounded complete-assembly controls before another
production-scale search. Merely solving the present surrogate better does not
repair this pair. This two-assembly comparison is not an exhaustive search over
the original bank, proof of visual distinguishability, a speed comparison with
v8's unrestricted solve, or an autonomous placement-accuracy improvement.
All later phases remain unchecked until their own evidence exists.
