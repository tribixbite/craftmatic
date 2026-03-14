# Iterate State — v95

**Target**: 9/10 buildings at 9+
**Current**: 8/10 passing
**Model**: gemini-2.5-flash | **Runs/batch**: 6 | **Mode**: fresh (20% trimmed mean)
**Updated**: 2026-03-14T05:24:47.100Z
**Last deep review**: 2026-03-13T05:54:05.303Z (gemini-2.5-pro)

| Building | Difficulty | TrimmedMean | SatRef | Runs | Avg A | Avg B | Avg C | Status | Diagnosis |
|---|---|---|---|---|---|---|---|---|
| flatiron | easy | 10 | 3/5 | 6 | 4.0 | 3.0 | 3.0 | PASS | passing |
| sentinel | medium | 9.5 | 3/5 | 6 | 3.5 | 3.0 | 3.0 | PASS | passing |
| scottsdale | medium | 10 | 3/5 | 6 | 4.0 | 3.0 | 3.0 | PASS | passing |
| francisco | hard | 9.8 | 3/5 | 6 | 3.5 | 2.5 | 2.8 | PASS | high-variance(range=6) |
| portland | medium | 10 | 3/5 | 6 | 4.0 | 3.0 | 3.0 | PASS | passing |
| houston | medium | 9.5 | 3/5 | 6 | 3.5 | 3.0 | 3.0 | PASS | passing |
| atlanta | medium | 9.1 | 3/5 | 12 | 3.3 | 2.8 | 2.9 | PASS | high-variance(range=4) |
| tampa | medium | 5.8 | 3/5 | 6 | 1.7 | 1.7 | 2.0 | FAIL | footprint(1.7/4), massing(1.7/3) |
| arlington | medium | 10 | 3/5 | 6 | 4.0 | 3.0 | 3.0 | PASS | passing |
| miami | medium | 6.5 | 3/5 | 6 | 1.8 | 2.0 | 2.5 | FAIL | footprint(1.8/4) |

## Action Items

- [ ] **tampa** (5.8): Improve footprint (post-mask, 2x res, tighter dilate). Fix massing (check capture height, mode-passes).
- [ ] **miami** (6.5): Improve footprint (post-mask, 2x res, tighter dilate).
