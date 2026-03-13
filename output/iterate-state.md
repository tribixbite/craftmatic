# Iterate State — v92

**Target**: 9/10 buildings at 9+
**Current**: 4/10 passing
**Model**: gemini-2.5-flash | **Runs/batch**: 6 | **Mode**: accumulate (20% trimmed mean)
**Updated**: 2026-03-13T06:52:26.211Z
**Last deep review**: 2026-03-13T05:54:05.303Z (gemini-2.5-pro)

| Building | Difficulty | TrimmedMean | SatRef | Runs | Avg A | Avg B | Avg C | Status | Diagnosis |
|---|---|---|---|---|---|---|---|---|
| flatiron | easy | 10 | 3/5 | 5 | 4.0 | 3.0 | 3.0 | PASS | passing |
| sentinel | medium | 10 | 3/5 | 5 | 4.0 | 3.0 | 3.0 | PASS | passing |
| mitdome | medium | 6.4 | 3/5 | 11 | 2.8 | 2.3 | 1.5 | FAIL | footprint(2.8/4), surface(1.5/3), high-variance(range=4) |
| francisco | hard | 10 | 3/5 | 5 | 3.6 | 2.6 | 2.6 | PASS | high-variance(range=6) |
| portland | medium | 8 | 3/5 | 11 | 3.2 | 2.4 | 2.3 | FAIL | high-variance(range=5) |
| winnetka | medium | 6.1 | 3/5 | 11 | 2.7 | 2.0 | 1.2 | FAIL | footprint(2.7/4), surface(1.2/3), high-variance(range=5) |
| tampa | medium | 6.3 | 3/5 | 11 | 2.5 | 2.3 | 1.9 | FAIL | footprint(2.5/4), surface(1.9/3), high-variance(range=5) |
| houston | medium | 0 | — | 0 | — | — | — | FAIL | error: Error: Unable to connect. Is the computer able to access the url? |
| arlington | medium | 9 | 3/5 | 5 | 4.0 | 3.0 | 2.0 | PASS | passing |
| nashville | medium | 0 | — | 0 | — | — | — | FAIL | error: Error: Unable to connect. Is the computer able to access the url? |

## Action Items

- [ ] **houston** (0): Improve footprint (post-mask, 2x res, tighter dilate). Fix massing (check capture height, mode-passes).
- [ ] **nashville** (0): Improve footprint (post-mask, 2x res, tighter dilate). Fix massing (check capture height, mode-passes).
- [ ] **winnetka** (6.1): Improve footprint (post-mask, 2x res, tighter dilate). Stabilize grading (more runs, check sat-ref quality).
- [ ] **tampa** (6.3): Improve footprint (post-mask, 2x res, tighter dilate). Stabilize grading (more runs, check sat-ref quality).
- [ ] **mitdome** (6.4): Improve footprint (post-mask, 2x res, tighter dilate). Stabilize grading (more runs, check sat-ref quality).
- [ ] **portland** (8): Stabilize grading (more runs, check sat-ref quality).
