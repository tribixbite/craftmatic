# Iterate State — v93

**Target**: 9/10 buildings at 9+
**Current**: 6/10 passing
**Model**: gemini-2.5-flash | **Runs/batch**: 6 | **Mode**: fresh (20% trimmed mean)
**Updated**: 2026-03-13T08:12:47.155Z
**Last deep review**: 2026-03-13T05:54:05.303Z (gemini-2.5-pro)

| Building | Difficulty | TrimmedMean | SatRef | Runs | Avg A | Avg B | Avg C | Status | Diagnosis |
|---|---|---|---|---|---|---|---|---|
| flatiron | easy | 10 | 3/5 | 5 | 4.0 | 3.0 | 3.0 | PASS | passing |
| sentinel | medium | 10 | 3/5 | 5 | 4.0 | 3.0 | 3.0 | PASS | passing |
| dakota | medium | 4.5 | 5/5 | 6 | 1.8 | 1.3 | 1.3 | FAIL | footprint(1.8/4), massing(1.3/3), surface(1.3/3) |
| francisco | hard | 10 | 3/5 | 5 | 3.6 | 2.6 | 2.6 | PASS | high-variance(range=6) |
| portland | medium | 9.3 | 3/5 | 6 | 4.0 | 3.0 | 2.2 | PASS | passing |
| atlanta | medium | 6.5 | 3/5 | 6 | 2.7 | 2.0 | 1.8 | FAIL | footprint(2.7/4), surface(1.8/3) |
| sandiego | medium | 8 | 3/5 | 12 | 2.9 | 2.6 | 2.3 | FAIL | footprint(2.9/4), high-variance(range=6) |
| montgomery | medium | 2.8 | 3/5 | 6 | 2.0 | 0.0 | 1.3 | FAIL | footprint(2.0/4), massing(0.0/3), surface(1.3/3), high-variance(range=5) |
| arlington | medium | 9 | 3/5 | 5 | 4.0 | 3.0 | 2.0 | PASS | passing |
| phoenix | medium | 9.1 | 4/5 | 18 | 3.6 | 2.6 | 2.6 | PASS | high-variance(range=5) |

## Action Items

- [ ] **montgomery** (2.8): Improve footprint (post-mask, 2x res, tighter dilate). Fix massing (check capture height, mode-passes). Stabilize grading (more runs, check sat-ref quality).
- [ ] **dakota** (4.5): Improve footprint (post-mask, 2x res, tighter dilate). Fix massing (check capture height, mode-passes).
- [ ] **atlanta** (6.5): Improve footprint (post-mask, 2x res, tighter dilate).
- [ ] **sandiego** (8): Improve footprint (post-mask, 2x res, tighter dilate). Stabilize grading (more runs, check sat-ref quality).
