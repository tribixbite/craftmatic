# Placement v2 bounded complete-search work

Owner: `complete_search`  
Status: implementation and focused controls complete; real-fixture integration
and GPU-backed complete-objective runs are owned by the fixture/objective tasks.

## Scope

`scripts/pdf-recon/placement_v2_complete_search.py` is a generic exact selector
for a deliberately finite pose bank. It enumerates every exact-quota
combination, rejects represented pairwise conflicts and selections without a
selected-only path to a base-supported physical pose, and calls one supplied
whole-assembly score callback exactly once for every feasible combination.
Lower scores win. All selections within a declared absolute tolerance of the
true minimum score are reported as optimum ties.

The module has no renderer, PDF, CAD, reference-truth, MILP, or placement-runtime
import. A callback receives the complete tuple of selected `CompletePose`
records, including instances that produce no visible feature in the current
drawing. Its opaque payload gives an objective adapter the complete item needed
to render and score that assembly.

The public contract is:

```python
search_complete_assemblies(
    poses, quotas, conflicts, score_complete,
    limits=CompleteSearchLimits(max_poses=64, max_combinations=100_000),
    absolute_tolerance=1e-12,
)
```

Candidate and quota inputs are canonicalized by quota key and stable pose ID.
Callback and result ordering are therefore deterministic and invariant to input
permutations. The callback must return one finite real cost. The complete
objective adapter can wrap its scorer as:

```python
lambda poses: scorer(base + tuple(pose.payload for pose in poses)).normalized_cost
```

## Exhaustiveness and refusal boundary

Before the first score call, the implementation checks `max_poses` against the
whole supplied bank and computes the exact-quota raw combination bound

`product(comb(candidate_count[key], quota[key]))`.

It refuses if either limit is exceeded. Conflicts and rooted support are not
used to shrink that pre-score bound, so a heavily constrained bank cannot slip
past the declared exhaustive-search budget. Within an accepted bank, no unary
image score, surrogate objective, visible-match count, heuristic ranking, or
unproved bound prunes a combination. The finite optimum claim covers only all
physically feasible exact-quota combinations of the supplied pose bank. It says
nothing about omitted poses, continuous pose domains, other cameras, later
booklet states, or a complete booklet optimum.

`max_poses` bounds candidate records, not selected cardinality. The selected
cardinality is fixed by the sum of exact quotas and is reported separately.
Zero quotas are supported. If a positive quota has too few candidates, the raw
bound is zero and the result contains no assemblies without calling the scorer.

## Representation policy for B3/B5

This selector deliberately separates physical feasibility from current-view
evidence. Exact quotas, collision conflicts, and rooted support determine which
complete selections are physical under the supplied representation. There is no
minimum visible-match floor. A hidden but mechanically rooted required piece is
feasible and is still included in the callback input. Conversely, an invisible
piece without a selected support path remains physically infeasible.

This differs from the earlier joint surrogate representation, where unary
candidate visibility and a per-real-pose match floor could participate in
selection. Complete visibility, new-part/new-part occlusion, ownership, and seam
topology now belong inside the common whole-assembly callback. The search cannot
certify that a callback implements those semantics; that is the separate B3
objective/renderer control. It only certifies that every accepted physical
combination received the same callback contract, addressing the finite-search
part of B5.

Image-indistinguishable tied assemblies remain distinct pose selections in the
tie report. Deciding that they are visually indistinguishable requires separate
evidence and is outside this module.

## Controls and limits

`scripts/pdf-recon/test_placement_v2_complete_search.py` passed 9 focused tests
in 0.08 seconds on 2026-09-11. The controls cover:

* agreement with an independently written powerset brute-force feasibility
  check, with callback-call equality to the full feasible set;
* a handcrafted interaction objective that reverses unary per-pose preference;
* zero quota behavior;
* a hidden, rooted required piece reaching the complete callback;
* absolute-tolerance optimum ties;
* candidate and quota input permutations;
* pose-limit and combination-limit refusal before any callback, including a
  bank whose conflicts would eliminate every pair;
* a rootless complete selection producing no callback and no optimum.

These are small CPU-only controls. They do not exercise CAD rendering, GPU
layers, PDF observations, visual feature correctness, fixture provenance, or
runtime scaling. Pytest emitted two cache-write permission warnings; the tests
themselves passed.

## TODO and handoff

* The complete-objective worker must validate that its fixed-canvas scorer
  recomputes visibility, new/new occlusion and seams from each complete item
  tuple, and must keep its normalized score definition fixed across calls.
* The complete-fixture worker must adapt the frozen 41624 page-3 candidate bank
  into `CompletePose` records, run within explicit limits, and compare the
  exhaustive optimum and ties with the known correct and old runtime selections.
* GPU-backed actual runs are delegated to the fixture/objective workers. This
  search task makes no GPU or real-PDF numerical claim.
* A later scalable optimizer must be checked against these finite exhaustive
  results. Agreement on one bounded bank does not establish scalable optimality
  or autonomous booklet accuracy.
