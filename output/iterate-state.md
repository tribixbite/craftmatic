# Iterate State — v109

**Target**: 9/10 buildings at 9+
**Current**: 1/10 passing
**Model**: gemini-2.5-flash | **Runs/batch**: 5 | **Mode**: fresh (20% trimmed mean)
**Updated**: 2026-03-16T15:23:21.321Z
**Last deep review**: 2026-03-13T05:54:05.303Z (gemini-2.5-pro)

| Building | Difficulty | TrimmedMean | SatRef | Runs | Avg A | Avg B | Avg C | Status | Diagnosis |
|---|---|---|---|---|---|---|---|---|
| flatiron | easy | 9.7 | 3/5 | 5 | 3.4 | 2.8 | 2.8 | PASS | high-variance(range=4) |
| sentinel | medium | 5 | 3/5 | 5 | 1.0 | 1.0 | 3.0 | FAIL | footprint(1.0/4), massing(1.0/3) |
| portland | medium | 7.3 | 3/5 | 5 | 2.6 | 2.0 | 3.0 | FAIL | footprint(2.6/4), high-variance(range=4) |
| raleigh | medium | 5 | 3/5 | 5 | 1.6 | 1.2 | 2.2 | FAIL | footprint(1.6/4), massing(1.2/3), high-variance(range=4) |
| dakota | medium | 4.3 | 3/5 | 5 | 1.0 | 1.0 | 2.4 | FAIL | footprint(1.0/4), massing(1.0/3) |
| tampa | medium | 6.3 | 3/5 | 5 | 1.4 | 1.8 | 2.6 | FAIL | footprint(1.4/4), massing(1.8/3), high-variance(range=4) |
| atlanta | medium | 5.7 | 3/5 | 5 | 1.8 | 1.6 | 2.2 | FAIL | footprint(1.8/4), massing(1.6/3), high-variance(range=5) |
| nashville | medium | 4.7 | 3/5 | 5 | 1.8 | 1.4 | 1.6 | FAIL | footprint(1.8/4), massing(1.4/3), surface(1.6/3), high-variance(range=4) |
| arlington | medium | 4 | 3/5 | 5 | 0.6 | 1.0 | 2.4 | FAIL | footprint(0.6/4), massing(1.0/3) |
| sandiego | medium | 7 | 3/5 | 5 | 2.0 | 2.0 | 3.0 | FAIL | footprint(2.0/4) |

## Action Items

- [ ] **arlington** (4): Improve footprint (post-mask, 2x res, tighter dilate). Fix massing (check capture height, mode-passes).
- [ ] **dakota** (4.3): Improve footprint (post-mask, 2x res, tighter dilate). Fix massing (check capture height, mode-passes).
- [ ] **nashville** (4.7): Improve footprint (post-mask, 2x res, tighter dilate). Fix massing (check capture height, mode-passes). Stabilize grading (more runs, check sat-ref quality).
- [ ] **sentinel** (5): Improve footprint (post-mask, 2x res, tighter dilate). Fix massing (check capture height, mode-passes).
- [ ] **raleigh** (5): Improve footprint (post-mask, 2x res, tighter dilate). Fix massing (check capture height, mode-passes). Stabilize grading (more runs, check sat-ref quality).
- [ ] **atlanta** (5.7): Improve footprint (post-mask, 2x res, tighter dilate). Fix massing (check capture height, mode-passes). Stabilize grading (more runs, check sat-ref quality).
- [ ] **tampa** (6.3): Improve footprint (post-mask, 2x res, tighter dilate). Fix massing (check capture height, mode-passes). Stabilize grading (more runs, check sat-ref quality).
- [ ] **sandiego** (7): Improve footprint (post-mask, 2x res, tighter dilate).
- [ ] **portland** (7.3): Improve footprint (post-mask, 2x res, tighter dilate). Stabilize grading (more runs, check sat-ref quality).
