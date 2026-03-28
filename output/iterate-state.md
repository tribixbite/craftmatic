# Iterate State — v300

**Target**: 9/10 buildings at 9+
**Current**: 1/10 passing
**Model**: gemini-2.5-pro | **Runs/batch**: 3 | **Mode**: fresh (20% trimmed mean)
**Updated**: 2026-03-28T05:25:22.832Z

| Building | Difficulty | TrimmedMean | SatRef | Runs | Avg A | Avg B | Avg C | Avg D | Status | Diagnosis |
|---|---|---|---|---|---|---|---|---|---|
| flatiron | easy | 8 | 3/5 | 3 | 4.0 | 1.3 | 2.7 | 2.0 | FAIL | massing(1.3/3), identity(2.0/2) |
| pennzoil | hard | 7 | 3/5 | 3 | 4.0 | 2.3 | 2.0 | 0.7 | FAIL | identity(0.7/2) |
| nga-east | medium | 10 | 3/5 | 3 | 3.3 | 3.0 | 3.0 | 1.3 | PASS | identity(1.3/2) |
| dallas-cityhall | hard | 5 | 3/5 | 3 | 2.0 | 2.0 | 1.7 | 0.0 | FAIL | footprint(2.0/4), surface(1.7/3) |
| seattle-library | hard | 3 | 3/5 | 3 | 2.0 | 0.0 | 2.0 | 0.0 | FAIL | footprint(2.0/4), massing(0.0/3) |
| boston-cityhall | hard | 4 | 3/5 | 3 | 2.0 | 2.0 | 1.0 | 0.0 | FAIL | footprint(2.0/4), surface(1.0/3) |
| citigroup | hard | 4 | 3/5 | 3 | 2.0 | 0.0 | 3.0 | 0.0 | FAIL | footprint(2.0/4), massing(0.0/3) |
| geisel | hard | 4 | 3/5 | 3 | 1.7 | 2.0 | 1.0 | 0.0 | FAIL | footprint(1.7/4), surface(1.0/3) |
| transamerica | hard | 4 | 3/5 | 3 | 1.0 | 2.0 | 3.0 | 0.0 | FAIL | footprint(1.0/4) |
| la-cityhall | hard | 3 | 3/5 | 3 | 2.0 | 0.0 | 2.0 | 0.0 | FAIL | footprint(2.0/4), massing(0.0/3) |

## Action Items

- [ ] **seattle-library** (3): Improve footprint (post-mask, 2x res, tighter dilate). Fix massing (check capture height, mode-passes).
- [ ] **la-cityhall** (3): Improve footprint (post-mask, 2x res, tighter dilate). Fix massing (check capture height, mode-passes).
- [ ] **citigroup** (4): Improve footprint (post-mask, 2x res, tighter dilate). Fix massing (check capture height, mode-passes).
- [ ] **boston-cityhall** (4): Improve footprint (post-mask, 2x res, tighter dilate).
- [ ] **geisel** (4): Improve footprint (post-mask, 2x res, tighter dilate).
- [ ] **transamerica** (4): Improve footprint (post-mask, 2x res, tighter dilate).
- [ ] **dallas-cityhall** (5): Improve footprint (post-mask, 2x res, tighter dilate).
- [ ] **pennzoil** (7): Fine-tune pipeline params.
- [ ] **flatiron** (8): Fix massing (check capture height, mode-passes).
