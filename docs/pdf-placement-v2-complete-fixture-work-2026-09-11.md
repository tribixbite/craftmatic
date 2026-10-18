# Placement v2 complete-fixture objective control

Owner: `complete_fixture`  
Status: implementation in progress; measurement blocked on shared search and objective code freeze.

## Scope

This evaluation-only control starts from the sealed
`41624-page3-fixture-control-v1` manifest. It creates a separately sealed child
manifest whose finite domain is the union of the two frozen alternatives: two
pin poses and four brick poses. The resulting exact-quota search has 12 raw
combinations. The parent bytes remain unchanged.

The selector and complete-objective scorer receive pose geometry, quota,
collision, selected-only rooted-support, camera, and drawing evidence. They do
not receive the parent `correct` or `runtime_selected_wrong` labels. Those labels
are opened only after ranking for evaluation-only structural and strict
fixed-frame counts. The domain itself was reference-selected, so no result is a
runtime recall or accuracy claim.

## Frozen gates

| Gate | Status | Evidence |
| --- | --- | --- |
| protected parent manifest | pending | expected SHA-256 `53943efeb340d8916e95627993d6ce558236ca9d7dcfe7425ee9e7131b4a297d` |
| shared complete search code freeze | pending | awaiting owner |
| shared complete objective code freeze | pending | awaiting owner |
| objective weights and tie rule frozen before measurement | pending | child manifest records complete config and `1e-12` absolute tolerance |
| six-pose / 12-combination bound | pending | freeze refuses any other shape |
| source/input/CAD guards | pending | start/end hashes and source snapshots required |
| GPU serialization | pending | root notification required immediately before and after the sole render run |
| complete pair parity | pending | both sealed diagnostic-v2 scores must reproduce within `1e-12` |
| all feasible rankings and all ties | pending | shared complete search output |
| post-ranking fixed-frame evaluation | pending | winner ties and every feasible selection |

## Work log

The harness and focused tests were drafted without rendering. No runtime or
evaluation output has yet been created. The next failure to resolve is shared
API code freeze, followed by CPU-only tests and child-manifest freeze. The sole
actual experiment remains gated until both shared workers explicitly freeze.
