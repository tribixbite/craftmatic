# Iterate State — v110

**Target**: 9/10 buildings at 9+
**Current**: 1/10 passing
**Model**: gemini-2.5-flash | **Runs/batch**: 0 | **Mode**: fresh (20% trimmed mean)
**Updated**: 2026-03-16T16:28:43.100Z
**Last deep review**: 2026-03-13T05:54:05.303Z (gemini-2.5-pro)

| Building | Difficulty | TrimmedMean | SatRef | Runs | Avg A | Avg B | Avg C | Status | Diagnosis |
|---|---|---|---|---|---|---|---|---|
| flatiron | easy | 9.7 | 3/5 | 5 | 3.4 | 2.8 | 2.8 | PASS | high-variance(range=4) |
| sentinel | medium | 5 | 3/5 | 5 | 1.0 | 1.0 | 3.0 | FAIL | footprint(1.0/4), massing(1.0/3) |
| portland | medium | 7.3 | 3/5 | 5 | 2.6 | 2.0 | 3.0 | FAIL | footprint(2.6/4), high-variance(range=4) |
| mitdome | medium | 0 | 3/5 | 0 | — | — | — | FAIL | no data |
| montgomery | medium | 0 | 5/5 | 0 | — | — | — | FAIL | no data |
| charlotte | medium | 0 | 3/5 | 0 | — | — | — | FAIL | no data |
| atlanta | medium | 5.7 | 3/5 | 5 | 1.8 | 1.6 | 2.2 | FAIL | footprint(1.8/4), massing(1.6/3), high-variance(range=5) |
| artinstitute | medium | 0 | 5/5 | 0 | — | — | — | FAIL | no data |
| phoenix | medium | — | — | — | — | — | — | PENDING | — |
| sandiego | medium | 7 | 3/5 | 5 | 2.0 | 2.0 | 3.0 | FAIL | footprint(2.0/4) |

## Action Items

- [ ] **charlotte** (0): Improve footprint (post-mask, 2x res, tighter dilate). Fix massing (check capture height, mode-passes).
- [ ] **montgomery** (0): Improve footprint (post-mask, 2x res, tighter dilate). Fix massing (check capture height, mode-passes).
- [ ] **artinstitute** (0): Improve footprint (post-mask, 2x res, tighter dilate). Fix massing (check capture height, mode-passes).
- [ ] **mitdome** (0): Improve footprint (post-mask, 2x res, tighter dilate). Fix massing (check capture height, mode-passes).
- [ ] **sentinel** (5): Improve footprint (post-mask, 2x res, tighter dilate). Fix massing (check capture height, mode-passes).
- [ ] **atlanta** (5.7): Improve footprint (post-mask, 2x res, tighter dilate). Fix massing (check capture height, mode-passes). Stabilize grading (more runs, check sat-ref quality).
- [ ] **sandiego** (7): Improve footprint (post-mask, 2x res, tighter dilate).
- [ ] **portland** (7.3): Improve footprint (post-mask, 2x res, tighter dilate). Stabilize grading (more runs, check sat-ref quality).
