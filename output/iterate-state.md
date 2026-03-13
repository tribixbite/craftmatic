# Iterate State — v91

**Target**: 9/10 buildings at 9+
**Current**: 9/10 passing
**Model**: gemini-2.5-flash | **Runs/batch**: 11 | **Mode**: fresh (20% trimmed mean)
**Updated**: 2026-03-13T02:06:31.777Z

| Building | Difficulty | TrimmedMean | Runs | Scores | Avg A | Avg B | Avg C | Status | Diagnosis |
|---|---|---|---|---|---|---|---|---|---|
| flatiron | easy | 10 | 11 | [10,10,10,10,10,10,10,10,10,10,10] | 4.0 | 3.0 | 3.0 | PASS | passing |
| sentinel | medium | 9.9 | 11 | [8.5,10,10,9,10,10,9.3,10,9.8,10,10] | 3.9 | 2.9 | 2.9 | PASS | passing |
| mitdome | medium | 9 | 11 | [10,10,10,9.5,9,7,7,9.5,8,6,10] | 3.1 | 2.8 | 2.8 | PASS | high-variance(range=4) |
| francisco | hard | 9.3 | 11 | [9,8.5,7.5,10,9,10,7,9.5,10,10,9] | 3.5 | 2.7 | 2.8 | PASS | passing |
| portland | medium | 9.9 | 11 | [10,10,10,10,9.5,9,9,10,10,10,10] | 3.8 | 3.0 | 3.0 | PASS | passing |
| winnetka | medium | 4.2 | 11 | [6,3,2,5,2,3,6.5,6,3.5,3,6] | 2.3 | 0.9 | 1.0 | FAIL | footprint(2.3/4), massing(0.9/3), surface(1.0/3), high-variance(range=4.5) |
| tampa | medium | 9.6 | 11 | [9.5,10,9.5,9.5,9.5,10,8.5,10,9.5,10,9.5] | 3.7 | 3.0 | 3.0 | PASS | passing |
| houston | medium | 9.3 | 22 | [9.4,7,8.5,10,8.5,10,9.5,7,6,9.5,7,9,9,9.5,9,9.5,10,10,10,10,10,8.5] | 3.5 | 2.7 | 2.7 | PASS | high-variance(range=4) |
| arlington | medium | 9.9 | 22 | [10,10,10,10,9,4,9.5,10,4,5,8.5,10,10,10,10,10,10,10,10,10,10,10] | 3.4 | 2.7 | 3.0 | PASS | high-variance(range=6) |
| nashville | medium | 9 | 11 | [8.5,10,8.5,9.5,7,10,8.5,10,8.5,9,9] | 3.6 | 2.7 | 2.7 | PASS | passing |

## Action Items

- [ ] **guggenheim** (2.3): Improve footprint (post-mask, 2x res, tighter dilate). Fix massing (check capture height, mode-passes). Stabilize grading (more runs, check sat-ref quality).
- [ ] **geisel** (3.2): Improve footprint (post-mask, 2x res, tighter dilate). Fix massing (check capture height, mode-passes).
- [ ] **artinstitute** (3.5): Improve footprint (post-mask, 2x res, tighter dilate). Fix massing (check capture height, mode-passes).
- [ ] **raleigh** (4.2): Improve footprint (post-mask, 2x res, tighter dilate). Fix massing (check capture height, mode-passes). Stabilize grading (more runs, check sat-ref quality).
- [ ] **winnetka** (4.2): Improve footprint (post-mask, 2x res, tighter dilate). Fix massing (check capture height, mode-passes). Stabilize grading (more runs, check sat-ref quality).
- [ ] **dallas** (5.4): Improve footprint (post-mask, 2x res, tighter dilate). Fix massing (check capture height, mode-passes). Stabilize grading (more runs, check sat-ref quality).
- [ ] **cambridge** (7.8): Improve footprint (post-mask, 2x res, tighter dilate). Stabilize grading (more runs, check sat-ref quality).
- [ ] **beach** (8.1): Stabilize grading (more runs, check sat-ref quality).
- [ ] **miami** (8.3): Stabilize grading (more runs, check sat-ref quality).
