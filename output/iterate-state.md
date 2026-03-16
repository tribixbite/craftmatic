# Iterate State — v107

**Target**: 9/10 buildings at 9+
**Current**: 0/10 passing
**Model**: gemini-2.5-flash | **Runs/batch**: 0 | **Mode**: fresh (20% trimmed mean)
**Updated**: 2026-03-16T14:37:38.884Z
**Last deep review**: 2026-03-13T05:54:05.303Z (gemini-2.5-pro)

| Building | Difficulty | TrimmedMean | SatRef | Runs | Avg A | Avg B | Avg C | Status | Diagnosis |
|---|---|---|---|---|---|---|---|---|
| flatiron | easy | 8.5 | 3/5 | 5 | 0.0 | 0.0 | 0.0 | FAIL | footprint(0.0/4), massing(0.0/3), surface(0.0/3), high-variance(range=3.0999999999999996) |
| sentinel | medium | 7.7 | 3/5 | 5 | 0.0 | 0.0 | 0.0 | FAIL | footprint(0.0/4), massing(0.0/3), surface(0.0/3) |
| portland | medium | 7 | 3/5 | 5 | 0.0 | 0.0 | 0.0 | FAIL | footprint(0.0/4), massing(0.0/3), surface(0.0/3) |
| raleigh | medium | 5.4 | 3/5 | 5 | 0.0 | 0.0 | 0.0 | FAIL | footprint(0.0/4), massing(0.0/3), surface(0.0/3), high-variance(range=3.9000000000000004) |
| dakota | medium | 7.7 | 5/5 | 5 | 0.0 | 0.0 | 0.0 | FAIL | footprint(0.0/4), massing(0.0/3), surface(0.0/3) |
| tampa | medium | 7.2 | 3/5 | 5 | 0.0 | 0.0 | 0.0 | FAIL | footprint(0.0/4), massing(0.0/3), surface(0.0/3) |
| atlanta | medium | 5.7 | 3/5 | 5 | 0.6 | 0.6 | 0.8 | FAIL | footprint(0.6/4), massing(0.6/3), surface(0.8/3), high-variance(range=4) |
| nashville | medium | 3.6 | 3/5 | 5 | 0.0 | 0.0 | 0.0 | FAIL | footprint(0.0/4), massing(0.0/3), surface(0.0/3) |
| arlington | medium | 5.7 | 3/5 | 5 | 0.0 | 0.0 | 0.0 | FAIL | footprint(0.0/4), massing(0.0/3), surface(0.0/3), high-variance(range=5.4) |
| sandiego | medium | 7 | 3/5 | 5 | 0.0 | 0.0 | 0.0 | FAIL | footprint(0.0/4), massing(0.0/3), surface(0.0/3), high-variance(range=4.6) |

## Action Items

- [ ] **nashville** (3.6): Improve footprint (post-mask, 2x res, tighter dilate). Fix massing (check capture height, mode-passes).
- [ ] **raleigh** (5.4): Improve footprint (post-mask, 2x res, tighter dilate). Fix massing (check capture height, mode-passes). Stabilize grading (more runs, check sat-ref quality).
- [ ] **arlington** (5.7): Improve footprint (post-mask, 2x res, tighter dilate). Fix massing (check capture height, mode-passes). Stabilize grading (more runs, check sat-ref quality).
- [ ] **atlanta** (5.7): Improve footprint (post-mask, 2x res, tighter dilate). Fix massing (check capture height, mode-passes). Stabilize grading (more runs, check sat-ref quality).
- [ ] **portland** (7): Improve footprint (post-mask, 2x res, tighter dilate). Fix massing (check capture height, mode-passes).
- [ ] **sandiego** (7): Improve footprint (post-mask, 2x res, tighter dilate). Fix massing (check capture height, mode-passes). Stabilize grading (more runs, check sat-ref quality).
- [ ] **tampa** (7.2): Improve footprint (post-mask, 2x res, tighter dilate). Fix massing (check capture height, mode-passes).
- [ ] **sentinel** (7.7): Improve footprint (post-mask, 2x res, tighter dilate). Fix massing (check capture height, mode-passes).
- [ ] **dakota** (7.7): Improve footprint (post-mask, 2x res, tighter dilate). Fix massing (check capture height, mode-passes).
- [ ] **flatiron** (8.5): Improve footprint (post-mask, 2x res, tighter dilate). Fix massing (check capture height, mode-passes). Stabilize grading (more runs, check sat-ref quality).
