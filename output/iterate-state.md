# Iterate State — v300

**Target**: 9/10 buildings at 9+
**Current**: 3/10 passing
**Model**: gemini-2.5-pro | **Runs/batch**: 3 | **Mode**: fresh (20% trimmed mean)
**Updated**: 2026-03-28T11:52:18.880Z

| Building | Difficulty | TrimmedMean | SatRef | Runs | Avg A | Avg B | Avg C | Avg D | Status | Diagnosis |
|---|---|---|---|---|---|---|---|---|---|
| flatiron | easy | 10 | 3/5 | 3 | 3.0 | 2.0 | 3.0 | 1.3 | PASS | identity(1.3/2), high-variance(range=4) |
| pennzoil | hard | 10 | 3/5 | 3 | 3.0 | 3.0 | 3.0 | 2.0 | PASS | identity(2.0/2) |
| nga-east | medium | 10 | 3/5 | 3 | 3.0 | 3.0 | 3.0 | 1.3 | PASS | identity(1.3/2) |
| dallas-cityhall | hard | 8 | 3/5 | 3 | 3.0 | 2.3 | 3.0 | 0.7 | FAIL | identity(0.7/2) |
| seattle-library | hard | 5 | 3/5 | 3 | 2.0 | 0.0 | 3.0 | 0.0 | FAIL | footprint(2.0/4), massing(0.0/3) |
| boston-cityhall | hard | 6 | 3/5 | 3 | 2.0 | 2.0 | 2.3 | 0.0 | FAIL | footprint(2.0/4) |
| citigroup | hard | 6 | 3/5 | 3 | 2.0 | 2.0 | 2.0 | 0.0 | FAIL | footprint(2.0/4) |
| geisel | hard | 6 | 3/5 | 3 | 2.0 | 2.3 | 2.0 | 0.0 | FAIL | footprint(2.0/4) |
| transamerica | hard | 6 | 3/5 | 3 | 3.0 | 0.7 | 3.0 | 0.0 | FAIL | massing(0.7/3) |
| la-cityhall | hard | 7 | 3/5 | 3 | 2.0 | 2.0 | 3.0 | 0.0 | FAIL | footprint(2.0/4) |

## Action Items

- [ ] **seattle-library** (5): Improve footprint (post-mask, 2x res, tighter dilate). Fix massing (check capture height, mode-passes).
- [ ] **citigroup** (6): Improve footprint (post-mask, 2x res, tighter dilate).
- [ ] **boston-cityhall** (6): Improve footprint (post-mask, 2x res, tighter dilate).
- [ ] **geisel** (6): Improve footprint (post-mask, 2x res, tighter dilate).
- [ ] **transamerica** (6): Fix massing (check capture height, mode-passes).
- [ ] **la-cityhall** (7): Improve footprint (post-mask, 2x res, tighter dilate).
- [ ] **dallas-cityhall** (8): Fine-tune pipeline params.
