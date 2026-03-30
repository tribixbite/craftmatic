# Iterate State — v305

**Target**: 9/10 buildings at 9+ per group
**Current**: 9/10 old + 9/10 new = 18/20 — TARGET MET
**Model**: gemini-2.5-pro | **Runs/batch**: 5 | **Mode**: fresh (20% trimmed mean)
**Updated**: 2026-03-30T05:10:55.968Z

## Old Group (9/10 PASS)

| Building | Difficulty | TrimmedMean | Runs | Status |
|---|---|---|---|---|
| flatiron | easy | 9 | 5 | PASS |
| pennzoil | hard | 10 | 5 | PASS |
| nga-east | medium | 9 | 5 | PASS |
| dallas-cityhall | hard | 9 | 5 | PASS |
| seattle-library | hard | 8.3 | 5 | FAIL |
| boston-cityhall | hard | 9 | 5 | PASS |
| citigroup | hard | 9.7 | 5 | PASS |
| geisel | hard | 9 | 5 | PASS |
| transamerica | hard | 10 | 5 | PASS |
| la-cityhall | hard | 10 | 5 | PASS |

## New Group (9/10 PASS)

| Building | Difficulty | TrimmedMean | Runs | Status |
|---|---|---|---|---|
| marina-city | hard | 9 | 5 | PASS |
| hearst-tower | hard | 10 | 5 | PASS |
| guggenheim | hard | 9 | 5 | PASS |
| fbi-hq | hard | 10 | 5 | PASS |
| mopop | hard | 10 | 5 | PASS |
| natl-cathedral | hard | 9 | 5 | PASS |
| boa-tower | hard | 10 | 5 | PASS |
| tribune-tower | hard | 9 | 5 | PASS |
| vessel-nyc | hard | 9.7 | 5 | PASS |
| disney-hall | hard | 6.7 | 5 | FAIL |

## Remaining Failures

- **seattle-library** (8.3): Bimodal 9/7/9/7/9 — intermittent height_truncated + floating_artifacts from nearby structures. Glass facade challenges.
- **disney-hall** (6.7): GLB capture includes Music Center campus neighbors. false_positives_merged persists despite explicit OSM relation/6333150.
