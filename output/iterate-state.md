# Iterate State — v102

**Target**: 9/10 buildings at 9+
**Current**: 6/10 passing
**Model**: gemini-2.5-pro | **Runs/batch**: 3 | **Mode**: accumulate (20% trimmed mean)
**Updated**: 2026-03-14T23:50:02.405Z
**Last deep review**: 2026-03-13T05:54:05.303Z (gemini-2.5-pro)

| Building | Difficulty | TrimmedMean | SatRef | Runs | Avg A | Avg B | Avg C | Status | Diagnosis |
|---|---|---|---|---|---|---|---|---|
| flatiron | easy | 9.3 | 3/5 | 6 | 4.0 | 2.3 | 3.0 | PASS | passing |
| sentinel | medium | 10 | 3/5 | 6 | 3.7 | 3.0 | 3.0 | PASS | passing |
| portland | medium | 6.8 | 3/5 | 6 | 2.7 | 1.3 | 3.0 | FAIL | footprint(2.7/4), massing(1.3/3), high-variance(range=5) |
| raleigh | medium | 9.5 | 3/5 | 6 | 3.5 | 2.7 | 3.0 | PASS | passing |
| dakota | medium | 9 | 3/5 | 6 | 3.0 | 2.5 | 3.0 | PASS | high-variance(range=5) |
| tampa | medium | 7.5 | 3/5 | 6 | 3.3 | 1.2 | 2.7 | FAIL | massing(1.2/3) |
| atlanta | medium | 10 | 3/5 | 6 | 4.0 | 2.8 | 3.0 | PASS | passing |
| nashville | medium | 6 | 3/5 | 6 | 2.3 | 2.0 | 2.2 | FAIL | footprint(2.3/4) |
| arlington | medium | 9.3 | 3/5 | 6 | 3.7 | 2.2 | 3.0 | PASS | high-variance(range=4) |
| sandiego | medium | 7.5 | 3/5 | 6 | 2.5 | 2.2 | 2.7 | FAIL | footprint(2.5/4), high-variance(range=6) |

## Action Items

- [ ] **nashville** (6): Improve footprint (post-mask, 2x res, tighter dilate).
- [ ] **portland** (6.8): Improve footprint (post-mask, 2x res, tighter dilate). Fix massing (check capture height, mode-passes). Stabilize grading (more runs, check sat-ref quality).
- [ ] **tampa** (7.5): Fix massing (check capture height, mode-passes).
- [ ] **sandiego** (7.5): Improve footprint (post-mask, 2x res, tighter dilate). Stabilize grading (more runs, check sat-ref quality).
