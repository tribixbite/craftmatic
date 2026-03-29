# Iterate State — v302

**Target**: 9/10 buildings at 9+
**Current**: 14/10 passing
**Model**: gemini-2.5-pro | **Runs/batch**: 5 | **Mode**: fresh (20% trimmed mean)
**Updated**: 2026-03-29T20:05:15.842Z

| Building | Difficulty | TrimmedMean | SatRef | Runs | Avg A | Avg B | Avg C | Avg D | Status | Diagnosis |
|---|---|---|---|---|---|---|---|---|---|
| flatiron | easy | 9 | 3/5 | 5 | 2.0 | 1.0 | 2.0 | 2.0 | PASS | identity(2.0/2) |
| pennzoil | hard | 10 | 3/5 | 5 | 2.0 | 1.0 | 3.0 | 2.0 | PASS | identity(2.0/2) |
| nga-east | medium | 8 | 3/5 | 5 | 1.8 | 1.0 | 1.0 | 0.0 | FAIL | footprint(1.8/2), surface(1.0/3) |
| dallas-cityhall | hard | 8.3 | 3/5 | 5 | 2.0 | 1.0 | 1.4 | 0.0 | FAIL | surface(1.4/3) |
| seattle-library | hard | 8 | 3/5 | 5 | 2.0 | 0.0 | 2.0 | 0.0 | FAIL | massing(0.0/1) |
| boston-cityhall | hard | 9 | 3/5 | 5 | 2.0 | 0.8 | 2.0 | 0.0 | PASS | massing(0.8/1) |
| citigroup | hard | 9.7 | 3/5 | 5 | 2.0 | 1.0 | 2.6 | 2.0 | PASS | identity(2.0/2) |
| geisel | hard | 9 | 3/5 | 5 | 2.0 | 1.0 | 2.0 | 0.0 | PASS | passing |
| transamerica | hard | 8 | 3/5 | 5 | 1.2 | 1.0 | 3.0 | 2.0 | FAIL | footprint(1.2/2), identity(2.0/2) |
| la-cityhall | hard | 10 | 3/5 | 5 | 2.0 | 1.0 | 3.0 | 2.0 | PASS | identity(2.0/2) |

## Action Items

- [ ] **disney-hall** (6.7): Improve footprint (post-mask, 2x res, tighter dilate). Fix massing (check capture height, mode-passes).
- [ ] **nga-east** (8): Improve footprint (post-mask, 2x res, tighter dilate). Fix massing (check capture height, mode-passes).
- [ ] **seattle-library** (8): Improve footprint (post-mask, 2x res, tighter dilate). Fix massing (check capture height, mode-passes).
- [ ] **transamerica** (8): Improve footprint (post-mask, 2x res, tighter dilate). Fix massing (check capture height, mode-passes).
- [ ] **dallas-cityhall** (8.3): Improve footprint (post-mask, 2x res, tighter dilate). Fix massing (check capture height, mode-passes).
- [ ] **vessel-nyc** (8.7): Improve footprint (post-mask, 2x res, tighter dilate). Fix massing (check capture height, mode-passes).
