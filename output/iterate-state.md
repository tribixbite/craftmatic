# Iterate State — v306

**Target**: 9/10 buildings at 9+
**Current**: 18/10 passing
**Model**: gemini-2.5-pro | **Runs/batch**: 3 | **Mode**: fresh (20% trimmed mean)
**Updated**: 2026-04-02T12:44:55.394Z

| Building | Difficulty | TrimmedMean | SatRef | Runs | Avg A | Avg B | Avg C | Avg D | Status | Diagnosis |
|---|---|---|---|---|---|---|---|---|---|
| flatiron | easy | 9 | 3/5 | 3 | 2.0 | 1.0 | 2.0 | 2.0 | PASS | identity(2.0/2) |
| pennzoil | hard | 9 | 3/5 | 3 | 2.0 | 1.0 | 2.3 | 2.0 | PASS | identity(2.0/2) |
| nga-east | medium | 9 | 3/5 | 5 | 2.0 | 1.0 | 2.0 | 0.0 | PASS | passing |
| dallas-cityhall | hard | 9 | 3/5 | 5 | 2.0 | 1.0 | 2.0 | 2.0 | PASS | identity(2.0/2) |
| seattle-library | hard | 8 | 3/5 | 3 | 2.0 | 0.3 | 1.7 | 2.0 | FAIL | massing(0.3/1), surface(1.7/3), identity(2.0/2) |
| boston-cityhall | hard | 9 | 3/5 | 5 | 2.0 | 0.8 | 2.0 | 0.0 | PASS | massing(0.8/1) |
| citigroup | hard | 10 | 3/5 | 3 | 2.0 | 1.0 | 3.0 | 2.0 | PASS | identity(2.0/2) |
| geisel | hard | 9 | 3/5 | 5 | 2.0 | 1.0 | 2.0 | 0.0 | PASS | passing |
| transamerica | hard | 10 | 3/5 | 5 | 2.0 | 1.0 | 3.0 | 2.0 | PASS | identity(2.0/2) |
| la-cityhall | hard | 10 | 3/5 | 5 | 2.0 | 1.0 | 3.0 | 2.0 | PASS | identity(2.0/2) |

## Action Items

- [ ] **disney-hall** (6.7): Improve footprint (post-mask, 2x res, tighter dilate). Fix massing (check capture height, mode-passes).
- [ ] **seattle-library** (8): Improve footprint (post-mask, 2x res, tighter dilate). Fix massing (check capture height, mode-passes).
