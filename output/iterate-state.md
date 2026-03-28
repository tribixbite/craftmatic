# Iterate State — v300

**Target**: 9/10 buildings at 9+
**Current**: 9/10 passing
**Model**: gemini-2.5-pro | **Runs/batch**: 5 | **Mode**: fresh (20% trimmed mean)
**Updated**: 2026-03-28T14:49:35.285Z

| Building | Difficulty | TrimmedMean | SatRef | Runs | Avg A | Avg B | Avg C | Avg D | Status | Diagnosis |
|---|---|---|---|---|---|---|---|---|---|
| flatiron | easy | 10 | 3/5 | 5 | 3.0 | 1.0 | 3.0 | 2.0 | PASS | identity(2.0/2) |
| pennzoil | hard | 10 | 3/5 | 5 | 3.0 | 1.0 | 3.0 | 2.0 | PASS | identity(2.0/2) |
| nga-east | medium | 9 | 3/5 | 5 | 2.2 | 1.0 | 3.0 | 0.8 | PASS | footprint(2.2/3), identity(0.8/2) |
| dallas-cityhall | hard | 10 | 3/5 | 5 | 3.0 | 1.0 | 3.0 | 1.2 | PASS | identity(1.2/2) |
| seattle-library | hard | 9 | 3/5 | 5 | 2.0 | 0.0 | 3.0 | 0.0 | PASS | massing(0.0/1) |
| boston-cityhall | hard | 9 | 3/5 | 5 | 2.0 | 1.0 | 2.0 | 0.0 | PASS | passing |
| citigroup | hard | 8.3 | 3/5 | 5 | 2.0 | 0.4 | 2.0 | 0.0 | FAIL | massing(0.4/1) |
| geisel | hard | 9 | 3/5 | 5 | 2.0 | 1.0 | 1.8 | 0.0 | PASS | surface(1.8/3) |
| transamerica | hard | 9.3 | 3/5 | 5 | 3.0 | 0.4 | 3.0 | 0.0 | PASS | massing(0.4/1) |
| la-cityhall | hard | 9 | 3/5 | 5 | 2.0 | 1.0 | 3.0 | 0.0 | PASS | footprint(2.0/3) |

## Action Items

- [ ] **citigroup** (8.3): Improve footprint (post-mask, 2x res, tighter dilate). Fix massing (check capture height, mode-passes).
