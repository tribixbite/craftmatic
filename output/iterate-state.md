# Iterate State — v200

**Target**: 7/10 buildings at 7+
**Current**: 3/10 at 8+ (flatiron 8.7, citigroup 8.7, pennzoil 8.0)
**Model**: gemini-2.5-flash | **Runs/batch**: 5 | **Mode**: accumulate (20% trimmed mean)
**Updated**: 2026-03-19T09:37:57.284Z

| Building | Difficulty | TrimmedMean | SatRef | Runs | Avg A | Avg B | Avg C | Avg D | Status | Diagnosis |
|---|---|---|---|---|---|---|---|---|---|
| flatiron | easy | 8.7 | 3/5 | 5 | 4.0 | 2.0 | 2.4 | 1.8 | FAIL | identity(1.8/2), high-variance(range=4) |
| esb | hard | — | — | — | — | — | — | — | PENDING | — |
| chrysler | hard | 5.3 | 3/5 | 5 | 2.0 | 1.6 | 1.4 | 0.0 | FAIL | footprint(2.0/4), massing(1.6/3), surface(1.4/3) |
| citigroup | hard | 8.7 | 5/5 | 5 | 2.8 | 2.8 | 2.6 | 0.8 | FAIL | footprint(2.8/4), identity(0.8/2), high-variance(range=5) |
| ansonia | medium | 4 | 3/5 | 5 | 1.0 | 1.2 | 1.8 | 0.0 | FAIL | footprint(1.0/4), massing(1.2/3), surface(1.8/3), high-variance(range=4) |
| oculus | hard | 6.7 | 3/5 | 5 | 2.0 | 2.4 | 2.4 | 1.6 | FAIL | footprint(2.0/4), identity(1.6/2), high-variance(range=4) |
| portland | medium | 6 | 3/5 | 5 | 1.8 | 1.6 | 2.6 | 0.0 | FAIL | footprint(1.8/4), massing(1.6/3), high-variance(range=4) |
| artinstitute | medium | 3.3 | 5/5 | 5 | 1.2 | 0.8 | 1.4 | 0.0 | FAIL | footprint(1.2/4), massing(0.8/3), surface(1.4/3) |
| willistower | hard | 6.7 | 3/5 | 5 | 2.2 | 2.2 | 2.4 | 1.6 | FAIL | footprint(2.2/4), identity(1.6/2), high-variance(range=4) |
| pennzoil | hard | 8 | 3/5 | 5 | 2.6 | 2.4 | 3.0 | 0.8 | FAIL | footprint(2.6/4), identity(0.8/2), high-variance(range=4) |

## Action Items

- [ ] **artinstitute** (3.3): Improve footprint (post-mask, 2x res, tighter dilate). Fix massing (check capture height, mode-passes).
- [ ] **ansonia** (4): Improve footprint (post-mask, 2x res, tighter dilate). Fix massing (check capture height, mode-passes). Stabilize grading (more runs, check sat-ref quality).
- [ ] **chrysler** (5.3): Improve footprint (post-mask, 2x res, tighter dilate). Fix massing (check capture height, mode-passes).
- [ ] **portland** (6): Improve footprint (post-mask, 2x res, tighter dilate). Fix massing (check capture height, mode-passes). Stabilize grading (more runs, check sat-ref quality).
- [ ] **oculus** (6.7): Improve footprint (post-mask, 2x res, tighter dilate). Stabilize grading (more runs, check sat-ref quality).
- [ ] **willistower** (6.7): Improve footprint (post-mask, 2x res, tighter dilate). Stabilize grading (more runs, check sat-ref quality).
- [ ] **pennzoil** (8): Improve footprint (post-mask, 2x res, tighter dilate). Stabilize grading (more runs, check sat-ref quality).
- [ ] **flatiron** (8.7): Stabilize grading (more runs, check sat-ref quality).
- [ ] **citigroup** (8.7): Improve footprint (post-mask, 2x res, tighter dilate). Stabilize grading (more runs, check sat-ref quality).
