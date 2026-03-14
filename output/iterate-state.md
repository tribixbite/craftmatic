# Iterate State — v95

**Target**: 9/10 buildings at 9+
**Current**: 5/10 passing
**Model**: gemini-2.5-flash | **Runs/batch**: 6 | **Mode**: fresh (20% trimmed mean)
**Updated**: 2026-03-14T02:01:57.537Z
**Last deep review**: 2026-03-13T05:54:05.303Z (gemini-2.5-pro)

| Building | Difficulty | TrimmedMean | SatRef | Runs | Avg A | Avg B | Avg C | Status | Diagnosis |
|---|---|---|---|---|---|---|---|---|
| flatiron | easy | 10 | 3/5 | 6 | 4.0 | 3.0 | 3.0 | PASS | passing |
| sentinel | medium | 8.3 | 3/5 | 6 | 3.0 | 2.3 | 2.8 | FAIL | high-variance(range=4) |
| scottsdale | medium | 10 | 3/5 | 6 | 4.0 | 3.0 | 3.0 | PASS | passing |
| francisco | hard | 7.8 | 3/5 | 6 | 2.8 | 2.3 | 2.7 | FAIL | footprint(2.8/4), high-variance(range=4) |
| portland | medium | 10 | 3/5 | 6 | 4.0 | 3.0 | 3.0 | PASS | passing |
| houston | medium | 6.5 | 3/5 | 6 | 2.5 | 2.0 | 2.0 | FAIL | footprint(2.5/4) |
| atlanta | medium | 7.3 | 3/5 | 6 | 2.7 | 2.3 | 2.5 | FAIL | footprint(2.7/4), high-variance(range=4) |
| sandiego | medium | 7.3 | 3/5 | 6 | 2.3 | 1.8 | 3.0 | FAIL | footprint(2.3/4), massing(1.8/3) |
| arlington | medium | 10 | 3/5 | 6 | 4.0 | 3.0 | 3.0 | PASS | passing |
| nashville | medium | 9 | 3/5 | 6 | 3.2 | 2.7 | 3.0 | PASS | passing |

## Action Items

- [ ] **houston** (6.5): Improve footprint (post-mask, 2x res, tighter dilate).
- [ ] **atlanta** (7.3): Improve footprint (post-mask, 2x res, tighter dilate). Stabilize grading (more runs, check sat-ref quality).
- [ ] **sandiego** (7.3): Improve footprint (post-mask, 2x res, tighter dilate). Fix massing (check capture height, mode-passes).
- [ ] **francisco** (7.8): Improve footprint (post-mask, 2x res, tighter dilate). Stabilize grading (more runs, check sat-ref quality).
- [ ] **sentinel** (8.3): Stabilize grading (more runs, check sat-ref quality).
