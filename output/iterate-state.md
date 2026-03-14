# Iterate State — v95

**Target**: 9/10 buildings at 9+
**Current**: 9/10 passing
**Model**: gemini-2.5-flash | **Runs/batch**: 6 | **Mode**: fresh (20% trimmed mean)
**Updated**: 2026-03-14T06:30:37.870Z
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
| sandiego | medium | 8 | 3/5 | 6 | 2.7 | 2.7 | 2.5 | FAIL | footprint(2.7/4) |
| arlington | medium | 10 | 3/5 | 6 | 4.0 | 3.0 | 3.0 | PASS | passing |
| raleigh | medium | 10 | 3/5 | 12 | 4.0 | 2.9 | 3.0 | PASS | passing |

## Action Items

- [ ] **sandiego** (8): Improve footprint (post-mask, 2x res, tighter dilate).
