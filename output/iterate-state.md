# Iterate State — v301

**Target**: 9/10 buildings at 9+
**Current**: 9/10 passing
**Model**: gemini-2.5-pro | **Runs/batch**: 5 | **Mode**: fresh (20% trimmed mean)
**Updated**: 2026-03-29T05:05:56.750Z

| Building | Difficulty | TrimmedMean | SatRef | Runs | Avg A | Avg B | Avg C | Avg D | Status | Diagnosis |
|---|---|---|---|---|---|---|---|---|---|
| flatiron | easy | 9 | 3/5 | 5 | 2.0 | 0.0 | 3.0 | 0.0 | PASS | massing(0.0/1) |
| pennzoil | hard | 10 | 3/5 | 5 | 2.0 | 0.8 | 2.8 | 1.6 | PASS | massing(0.8/1), identity(1.6/2) |
| nga-east | medium | 10 | 3/5 | 5 | 1.8 | 1.0 | 3.0 | 0.4 | PASS | footprint(1.8/2), identity(0.4/2) |
| dallas-cityhall | hard | 10 | 3/5 | 5 | 2.0 | 1.0 | 3.0 | 0.0 | PASS | passing |
| seattle-library | hard | 9 | 3/5 | 5 | 2.0 | 0.0 | 3.0 | 0.0 | PASS | massing(0.0/1) |
| boston-cityhall | hard | 9 | 3/5 | 5 | 2.0 | 1.0 | 2.0 | 0.0 | PASS | passing |
| citigroup | hard | 8 | 3/5 | 5 | 1.8 | 0.2 | 2.0 | 0.0 | FAIL | footprint(1.8/2), massing(0.2/1) |
| geisel | hard | 9.3 | 3/5 | 5 | 2.0 | 1.0 | 2.4 | 0.0 | PASS | passing |
| transamerica | hard | 9.3 | 3/5 | 5 | 2.0 | 0.4 | 3.0 | 0.0 | PASS | massing(0.4/1) |
| la-cityhall | hard | 10 | 3/5 | 5 | 2.0 | 1.0 | 3.0 | 0.0 | PASS | passing |

## Action Items

- [ ] **citigroup** (8): Improve footprint (post-mask, 2x res, tighter dilate). Fix massing (check capture height, mode-passes).
