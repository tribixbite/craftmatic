# Placement v2 real-fixture control work

Owner: `real_fixture_controls`  
Status: first bounded real-fixture diagnostic complete; broader fixture coverage
and independent exhaustive visual matching remain pending.

## Scope and evidence boundary

This task builds an explicitly evaluation-only diagnostic from the sealed
`output/pdf-placement-v2/41624-page3-pose-search-v8` run. Reference truth may
identify a fixed correct combination only after the runtime seal is validated.
The resulting manifest is prohibited from runtime proposal generation, caches,
model paths and set-specific search rules. It is a development fixture, not a
held-out accuracy measurement.

The first fixture contains exactly two three-addition complete assemblies under
camera 0 and one shared maximum base alignment:

| assembly | `2780:0` | first `3700:4` | second `3700:4` | provenance |
| --- | --- | --- | --- | --- |
| retained correct | registry 2540 | registry 1035 | registry 1067 | sealed post-hoc evaluation, alignment 1 |
| wrong alternative | registry 33 | registry 1140 | registry 7043 | v8 camera-0 solver incumbent |

The correct combination fills the exact quotas (`2780:0 = 1`, `3700:4 = 2`),
and all three IDs occur in camera 0's explicit final retained set. In the sealed
support graph, 1035 and 1067 are base-supported and 2540 has a direct support
edge to 1067. This is only a representation witness. Collision and joint
visibility/ownership still require bounded recomputation; they must not be
inferred from unary retention.

## Implementation and limits

`scripts/pdf-recon/placement_v2_fixture_controls.py` has two phases:

1. `freeze` verifies the runtime and evaluation seals, finds an exact-quota set
   of retained candidates with distinct reference instances under one common
   alignment, records the runtime-selected alternative, copies pose transforms
   and provenance into a sealed manifest, and records pending gates honestly.
2. `diagnose` reconstructs only the six frozen unary renders, recomputes pairwise
   collisions and rooted support, forces each three-pose combination through the
   actual joint visibility/assignment representation, and optionally renders the
   two complete assemblies under the same edge-plus-curve objective used by v8.

The hard limit is eight candidate assemblies; this fixture uses two. The harness
does not scan the 8,192-pose registry, run a booklet, change runtime caches, or
claim that its finite alternatives are exhaustive beyond the frozen comparison.
The final objective still inherits v8's feature semantics and does not
independently adjudicate visual indistinguishability.

## Current gates

| gate | status | evidence or next action |
| --- | --- | --- |
| common-frame correct IDs | complete | 2540, 1035, 1067 under alignment 1 |
| runtime wrong alternative | complete | 33, 1140, 7043 from camera-0 incumbent |
| exact quota and retention | complete | derived from sealed report/evaluation |
| rooted support | preflight complete | correct: 2540 → 1067 → base; actual bounded reconstruction will repeat it |
| collision | complete for both fixed assemblies | zero represented pairwise conflicts |
| joint visibility/ownership feasibility | complete for both fixed assemblies | revised fixed-selection MILPs optimal; independent physical/visibility control also passes |
| complete same-objective comparison | complete for this two-assembly bank | final objective prefers correct by 0.1488147114 |
| visual indistinguishability | unverified | requires separate independent adjudication |

## Frozen result

The sealed manifest is
`output/pdf-placement-v2/41624-page3-fixture-control-v1/manifest.json` (SHA-256
`53943efeb340d8916e95627993d6ce558236ca9d7dcfe7425ee9e7131b4a297d`).
The final diagnostic is
`output/pdf-placement-v2/41624-page3-fixture-diagnostic-v2/diagnostic.json`
(SHA-256
`1c9afb960755af2b047354dee0f6030cc772034dbef380e8617b030a1de7aa9b`).
The run completed in about 5.3 seconds and made exactly six unary candidate
renders plus two complete-assembly renders. It scanned no raw poses.
The preliminary `fixture-diagnostic-v1` output is superseded by v2 because v2
adds full source snapshots, runtime/CAD start/end guards, the independent
physical/visibility check and sealed-scorer parity. Its numerical comparison is
unchanged.

Both fixed assemblies satisfy exact quotas, have zero represented pairwise
conflicts, and have a selected-only path to a base-supported pose. The separate
bounded control independently derives the same physical feasibility and a
486-visible/154-suppressed base-feature partition for each selection. This
control does not score the roughly 700 observations: its exhaustive matcher
correctly refuses problems at this scale. Joint visual feasibility and costs
therefore remain solver evidence, not an independent exhaustive matching
certificate.

The revised direct-visibility MILP proves both fixed selections feasible and
optimal:

| assembly | surrogate total | raw primal | raw dual | constant | absolute gap | real/base matches |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| correct | 1251.5026032010 | -158.4973967990 | -158.4973967990 | 1410 | 0 | 218 / 444 |
| runtime wrong | 1245.5679791871 | -164.4320208129 | -164.4320208129 | 1410 | 1.14e-13 | 205 / 430 |

The fixed surrogate prefers the wrong assembly by 5.9346240140. Better
optimization of that surrogate alone cannot select the correct member of this
pair. This does not establish the optimum or ranking over v8's full retained
bank.

The complete-assembly score reverses the preference:

| assembly | edge cost | curve cost | combined declared cost |
| --- | ---: | ---: | ---: |
| correct | 0.7308191451 | 1.0419006252 | 0.8863598851 |
| runtime wrong | 0.7841370483 | 1.2862121448 | 1.0351745965 |

The correct assembly wins this two-member final-objective comparison by
0.1488147114. The reconstructed wrong cost exactly equals sealed v8 camera 0's
recorded actual cost, providing scorer parity. Reference identity establishes
which assembly is structurally correct; it does not independently establish
visual distinguishability or validate the feature/curve objective itself.

The final run snapshots the full live pose-search dependency set and the
fixture/control sources. Start/end source hashes, report/results/source-model,
PDF, base, registry, registration and all recorded CAD dependency hashes agree.
Key frozen source hashes are:

* fixture harness: `5460eeca4158254834ea24b863c975eeb163d082cf21b5865aa737fc66934fb4`
* pose assignment: `aa45fc283b780dabf0ee80586c9d56b690b343a2cd443d1c22fa8507a46663f6`
* joint assignment: `569daba9624f00bf168bc0e56bf339dc6c1f961c9d41f960bc48fb3a9bb1baca`
* independent controls: `8f7f7012044e4c997ef729342e800cfc93ec4ae1515940c4197b6976ee6e23d0`

The first real gate therefore isolates a surrogate/final-objective mismatch for
this feasible pair. It does not yet distinguish scalable-optimizer behavior on
the same final objective, because no optimizer currently optimizes that final
complete-assembly score and this fixture contains only two alternatives.

| failure class | finding for this bounded pair |
| --- | --- |
| missing candidates | rejected: all three correct poses are explicitly retained under one camera/alignment |
| represented infeasibility | rejected: quota, collision, rooted support, visibility and exclusive assignment pass |
| final objective | passes this pair: it prefers correct, with visual indistinguishability still unverified |
| selection surrogate | fails this pair: its exact fixed costs prefer wrong |
| optimizer | unresolved for the final objective; improving optimization of the current surrogate cannot repair this pairwise reversal |
