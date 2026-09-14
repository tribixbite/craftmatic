# Placement v2 complete-objective work

Status: implementation and CPU abstraction controls complete; real renderer
parity belongs to the separately frozen GPU fixture.

Owned implementation:

* `scripts/pdf-recon/placement_v2_complete_objective.py`
* `scripts/pdf-recon/test_placement_v2_complete_objective.py`

## Declared objective and API

`CompleteObjectiveScorer(scene, base, camera, coverage_items)` constructs one
renderer and one fixed padded canvas for a bounded candidate domain.  Calls of
`scorer(complete_items)` return `CompleteObjectiveScore`; lower
`normalized_cost` is better.  A generic exhaustive search can use
`lambda poses: scorer(base + tuple(p.payload for p in poses)).normalized_cost`.
The one-shot `score_complete_objective` wrapper exists for diagnostics, while
enumeration should reuse the scorer to avoid renderer initialization per
assembly.

The canvas is derived once from the projected union of the base and every
declared coverage item using the sealed v8 three-pixel padding rule.  A larger
saved v8 camera padding record may be supplied and is preserved only after its
scene dimensions, spacing, refusal state, and candidate-domain coverage are
validated.  A scored assembly outside that fixed domain is refused.  Padding
never changes per assembly, so raster grid phase and normalization remain
comparable; visible predictions beyond the native image remain in the score.

The versioned `CompleteObjectiveConfig` declares the v8 constants rather than
learning them from a fixture.  Each score records the full config, padding,
edge and curve components, weights, counts, raster evidence, visible owners,
and fully hidden owners.  Runtime inputs are limited to the scene, base,
camera, complete physical items, the bounded coverage domain, and universal
renderer geometry.  The module has no reference-model, VLM, proposal-bank, or
path-dependent logic.

## Exact relationship to sealed v8

Each call performs one true complete-assembly render.  Triangle ownership is
converted to physical-instance ownership after the render, so new-part/new-part
occlusion is resolved by the actual depth buffer.  The visible outline adds
actual inter-instance seams and suppresses tessellation inside one instance.
Those visible samples enter the same exclusive correspondence scorer used by
v8, including `kind_mismatch_cost=4.0` and the existing normalization.  Whole
rendered ellipses enter the same one-to-one curve scorer.  When target curves
exist, the final normalized cost is exactly one half edge plus one half curve;
without target curves it is the edge normalized cost.  These weights were not
changed for the real fixture.

This differs from the joint-selection surrogate.  The surrogate combines
base-plus-one-pose tokens, unary suppression, and conditional base visibility
inside a MILP.  Its objective cannot represent visibility or seam changes
between two newly selected parts.  The complete scorer evaluates every whole
assembly presented to it and can therefore serve as the numeric callback for a
bounded exhaustive optimizer.

## Controls and limits

The focused suite uses a fake renderer that returns the same buffers as the
production adapter.  It checks direct parity with the edge-token/correspondence
pipeline, exclusive ownership on an actual two-instance seam, complete hiding
of an earlier new owner by a later new owner, normalized edge/curve weights,
retention of an off-native prediction inside declared padding, refusal outside
that padding, saved-padding validation, stable config metadata, and the
one-shot wrapper.  It does not invoke the GPU.

The implementation is exact for the sealed v8 raster objective, not for all
visual semantics in an instruction drawing.  Edges remain anonymous sampled
raster intervals; a seam, hole, silhouette, decoration, or annotation can
still be confused when their local metadata agrees.  Curves are detected
ellipses rather than semantic studs or holes.  Seam rasterization is the
existing one-pixel lower/right convention, sampling is grid-discretized, and
owner visibility is only as accurate as renderer geometry and depth.  The
score does not establish collision freedom, mechanical support, intended
identity, pose-domain recall, drawing-state correctness, camera correctness,
or visual distinguishability.  Those remain separate feasibility,
representation, and evaluation controls.

Validation on 2026-09-11: focused CPU suite passed with 6 tests.  Production
GPU parity and the bounded real-fixture enumeration are recorded by their
separate fixture owner so only one GPU process is used.
