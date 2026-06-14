# Iterate State — v315c

**Target**: 9/10 buildings at 9+
**Current**: 18/10 passing
**Model**: gemini-2.5-pro | **Runs/batch**: 3 | **Mode**: fresh (20% trimmed mean)
**Updated**: 2026-04-13T05:44:53.560Z

| Building | Difficulty | TrimmedMean | SatRef | Runs | Avg A | Avg B | Avg C | Avg D | Status | Diagnosis |
|---|---|---|---|---|---|---|---|---|---|
| flatiron | easy | 4 | 3/5 | 3 | 0.7 | 0.0 | 2.0 | 1.0 | FAIL | footprint(0.7/3), massing(0.0/1), proportions(1.0/2), high-variance(range=4) |
| pennzoil | hard | 10 | 3/5 | 3 | 2.0 | 1.0 | 3.0 | 1.0 | PASS | proportions(1.0/2) |
| nga-east | medium | 9 | 3/5 | 1 | 2.0 | 1.0 | 2.0 | 1.0 | PASS | proportions(1.0/2) |
| dallas-cityhall | hard | 9 | 3/5 | 3 | 3.0 | 0.7 | 2.0 | 1.0 | PASS | massing(0.7/1), proportions(1.0/2) |
| seattle-library | hard | 8 | 3/5 | 3 | 3.0 | 0.0 | 2.0 | 1.0 | FAIL | massing(0.0/1), proportions(1.0/2) |
| boston-cityhall | hard | 8 | 3/5 | 3 | 2.0 | 0.0 | 2.0 | 1.0 | FAIL | massing(0.0/1), proportions(1.0/2) |
| citigroup | hard | 10 | 3/5 | 3 | 3.0 | 1.0 | 3.0 | 2.0 | PASS | passing |
| geisel | hard | 9 | 3/5 | 3 | 2.0 | 0.7 | 2.0 | 1.0 | PASS | massing(0.7/1), proportions(1.0/2) |
| transamerica | hard | 10 | 3/5 | 3 | 3.0 | 1.0 | 3.0 | 2.0 | PASS | passing |
| la-cityhall | hard | 10 | 3/5 | 3 | 2.3 | 1.0 | 3.0 | 2.0 | PASS | passing |

## Action Items

- [ ] **flatiron** (4): Improve footprint (post-mask, 2x res, tighter dilate). Fix massing (check capture height, mode-passes). Stabilize grading (more runs, check sat-ref quality).
- [ ] **seattle-library** (8): Fix massing (check capture height, mode-passes).
- [ ] **boston-cityhall** (8): Improve footprint (post-mask, 2x res, tighter dilate). Fix massing (check capture height, mode-passes).
