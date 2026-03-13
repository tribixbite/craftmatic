# Iterate State — v93

**Target**: 9/10 buildings at 9+
**Current**: 7/10 passing
**Model**: gemini-2.5-flash | **Runs/batch**: 6 | **Mode**: fresh (20% trimmed mean)
**Updated**: 2026-03-13T09:02:28.285Z
**Last deep review**: 2026-03-13T05:54:05.303Z (gemini-2.5-pro)

| Building | Difficulty | TrimmedMean | SatRef | Runs | Avg A | Avg B | Avg C | Status | Diagnosis |
|---|---|---|---|---|---|---|---|---|
| flatiron | easy | 10 | 3/5 | 5 | 4.0 | 3.0 | 3.0 | PASS | passing |
| sentinel | medium | 10 | 3/5 | 5 | 4.0 | 3.0 | 3.0 | PASS | passing |
| scottsdale | medium | 9.8 | 3/5 | 6 | 3.7 | 2.7 | 3.0 | PASS | passing |
| francisco | hard | 10 | 3/5 | 5 | 3.6 | 2.6 | 2.6 | PASS | high-variance(range=6) |
| portland | medium | 9.3 | 3/5 | 6 | 4.0 | 3.0 | 2.2 | PASS | passing |
| seattle | medium | 3 | 3/5 | 6 | 0.7 | 0.5 | 1.7 | FAIL | footprint(0.7/4), massing(0.5/3), surface(1.7/3) |
| sandiego | medium | 8 | 3/5 | 12 | 2.8 | 2.6 | 2.6 | FAIL | footprint(2.8/4), high-variance(range=4) |
| noe | medium | 8.5 | 3/5 | 6 | 3.0 | 2.7 | 2.7 | FAIL | high-variance(range=4) |
| arlington | medium | 9 | 3/5 | 5 | 4.0 | 3.0 | 2.0 | PASS | passing |
| phoenix | medium | 9.1 | 4/5 | 18 | 3.6 | 2.6 | 2.6 | PASS | high-variance(range=5) |

## Action Items

- [ ] **seattle** (3): Improve footprint (post-mask, 2x res, tighter dilate). Fix massing (check capture height, mode-passes).
- [ ] **sandiego** (8): Improve footprint (post-mask, 2x res, tighter dilate). Stabilize grading (more runs, check sat-ref quality).
- [ ] **noe** (8.5): Stabilize grading (more runs, check sat-ref quality).
