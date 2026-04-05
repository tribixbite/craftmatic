# Iterate State — v80

**Target**: 9/10 buildings at 9+
**Current**: 14/10 passing
**Model**: gemini-2.5-pro | **Runs/batch**: 1 | **Mode**: fresh (20% trimmed mean)
**Updated**: 2026-04-05T05:21:09.956Z

| Building | Difficulty | TrimmedMean | SatRef | Runs | Avg A | Avg B | Avg C | Avg D | Status | Diagnosis |
|---|---|---|---|---|---|---|---|---|---|
| flatiron | easy | 8 | 3/5 | 1 | 2.0 | 0.0 | 2.0 | 0.0 | FAIL | massing(0.0/1) |
| pennzoil | hard | 10 | 3/5 | 1 | 2.0 | 1.0 | 3.0 | 2.0 | PASS | identity(2.0/2) |
| nga-east | medium | 7 | 3/5 | 1 | 1.0 | 1.0 | 2.0 | 0.0 | FAIL | footprint(1.0/2) |
| dallas-cityhall | hard | 9 | 3/5 | 1 | 2.0 | 1.0 | 2.0 | 2.0 | PASS | identity(2.0/2) |
| seattle-library | hard | 8 | 3/5 | 1 | 2.0 | 0.0 | 2.0 | 0.0 | FAIL | massing(0.0/1) |
| boston-cityhall | hard | 9 | 3/5 | 1 | 2.0 | 1.0 | 2.0 | 0.0 | PASS | passing |
| citigroup | hard | 10 | 3/5 | 1 | 2.0 | 1.0 | 3.0 | 2.0 | PASS | identity(2.0/2) |
| geisel | hard | 8 | 3/5 | 1 | 2.0 | 1.0 | 1.0 | 0.0 | FAIL | surface(1.0/3) |
| transamerica | hard | 10 | 3/5 | 1 | 2.0 | 1.0 | 3.0 | 2.0 | PASS | identity(2.0/2) |
| la-cityhall | hard | 0 | — | 0 | — | — | — | — | FAIL | error: Error: Command failed: bun scripts/voxelize-glb.ts "output/tiles/la-cityhall.glb" --auto --coords "34.0537,-118.2430" --mask-dilate 1 --gamma 0.4 -r 1 -o "output/tiles/la-cityhall-v80.schem" --no-enu |

## Action Items

- [ ] **la-cityhall** (0): Improve footprint (post-mask, 2x res, tighter dilate). Fix massing (check capture height, mode-passes).
- [ ] **nga-east** (7): Improve footprint (post-mask, 2x res, tighter dilate). Fix massing (check capture height, mode-passes).
- [ ] **coit-grandrapids** (7.3): Improve footprint (post-mask, 2x res, tighter dilate). Fix massing (check capture height, mode-passes).
- [ ] **flatiron** (8): Improve footprint (post-mask, 2x res, tighter dilate). Fix massing (check capture height, mode-passes).
- [ ] **seattle-library** (8): Improve footprint (post-mask, 2x res, tighter dilate). Fix massing (check capture height, mode-passes).
- [ ] **geisel** (8): Improve footprint (post-mask, 2x res, tighter dilate). Fix massing (check capture height, mode-passes).
- [ ] **disney-hall** (8): Improve footprint (post-mask, 2x res, tighter dilate). Fix massing (check capture height, mode-passes).
