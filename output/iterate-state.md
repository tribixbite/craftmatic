# Iterate State — v311

**Target**: 9/10 buildings at 9+
**Current**: 17/21 passing (flatiron 9→8 on re-grade, VLM noise)
**Model**: gemini-2.5-pro | **Runs/batch**: 3 | **Mode**: fresh (20% trimmed mean)
**Updated**: 2026-04-09

## v311 Changes
- `fillFacadeHoles()`: fills air with 4+ solid face-neighbors (single-pass, safe)
- `removeIsolatedVoxels()`: removes voxels with ≤1 face-neighbor (noise dots)
- Iterative hole fill TESTED and REJECTED (closes courtyards, dallas 8→6)

| Building | Difficulty | v310 | v311 | Status | Diagnosis |
|---|---|---|---|---|---|
| flatiron | easy | 9 | 8-9 | MARGINAL | VLM noise: [9,9,9] then [8,8,9] on re-grade |
| pennzoil | hard | 9 | 9 | PASS | stable |
| nga-east | medium | 9 | 9 | PASS | stable |
| dallas-cityhall | hard | 8 | 8 | FAIL | facade_holes_visible, floating_artifacts (plateau) |
| seattle-library | hard | 8 | 8 | FAIL | height_truncated, facade_holes (source data) |
| coit-grandrapids | hard | 8 | 8 | FAIL | massing, identity (source data plateau) |
| boston-cityhall | hard | 9 | 9 | PASS | stable |
| citigroup | hard | 9 | 9 | PASS | stable |
| geisel | hard | 9 | 9 | PASS | stable |
| transamerica | hard | 10 | 10 | PASS | 3/3 perfect |
| la-cityhall | hard | 10 | 10 | PASS | stable |

## Plateau Confirmed
3-4 failures are source data limitations, not fixable with post-processing:
- flatiron: borderline 8-9, VLM scoring noise (consistent 9 in v310, dropped to 8 on one re-grade)
- dallas-cityhall: inverted pyramid form barely captured, facade holes from low LOD
- seattle-library: height truncated by Google Tiles, diamond facets lost at low resolution
- coit-grandrapids: complex multi-wing school, massing not distinctive enough
