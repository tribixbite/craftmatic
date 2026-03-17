# Iterate State — v200

**Target**: 9/10 buildings at 9+
**Current**: 1/10 passing
**Model**: gemini-2.5-flash | **Runs/batch**: 3 | **Mode**: fresh (20% trimmed mean)
**Updated**: 2026-03-17T11:46:59.322Z
**Last deep review**: 2026-03-13T05:54:05.303Z (gemini-2.5-pro)

| Building | Difficulty | TrimmedMean | SatRef | Runs | Avg A | Avg B | Avg C | Avg D | Status | Diagnosis |
|---|---|---|---|---|---|---|---|---|---|
| flatiron | easy | 9 | 3/5 | 3 | 4.0 | 2.3 | 3.0 | 2.0 | PASS | identity(2.0/2) |
| esb | hard | 4 | 5/5 | 3 | 1.3 | 1.0 | 1.3 | 0.0 | FAIL | footprint(1.3/4), massing(1.0/3), surface(1.3/3) |
| chrysler | hard | — | — | — | — | — | — | — | PENDING | — |
| guggenheim | hard | 3 | 5/5 | 3 | 0.7 | 0.3 | 2.3 | 0.0 | FAIL | footprint(0.7/4), massing(0.3/3) |
| transamerica | hard | 2 | 3/5 | 3 | 1.0 | 0.0 | 2.3 | 0.0 | FAIL | footprint(1.0/4), massing(0.0/3), high-variance(range=4) |
| uscapitol | hard | — | — | — | — | — | — | — | PENDING | — |
| mitdome | hard | — | — | — | — | — | — | — | PENDING | — |
| artinstitute | medium | — | — | — | — | — | — | — | PENDING | — |
| willistower | hard | — | — | — | — | — | — | — | PENDING | — |
| geisel | hard | — | — | — | — | — | — | — | PENDING | — |

## Action Items

- [ ] **transamerica** (2): Improve footprint (post-mask, 2x res, tighter dilate). Fix massing (check capture height, mode-passes). Stabilize grading (more runs, check sat-ref quality).
- [ ] **guggenheim** (3): Improve footprint (post-mask, 2x res, tighter dilate). Fix massing (check capture height, mode-passes).
- [ ] **esb** (4): Improve footprint (post-mask, 2x res, tighter dilate). Fix massing (check capture height, mode-passes).
