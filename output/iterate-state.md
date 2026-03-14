# Iterate State — v96b

**Target**: 9/10 buildings at 9+
**Current**: 9/10 passing
**Model**: gemini-2.5-flash | **Runs/batch**: 3 | **Mode**: fresh (20% trimmed mean)
**Updated**: 2026-03-14T19:34:19.090Z
**Last deep review**: 2026-03-13T05:54:05.303Z (gemini-2.5-pro)

| Building | Difficulty | TrimmedMean | SatRef | Runs | Avg A | Avg B | Avg C | Status | Diagnosis |
|---|---|---|---|---|---|---|---|---|
| flatiron | easy | 10 | 3/5 | 3 | 4.0 | 3.0 | 3.0 | PASS | passing |
| sentinel | medium | 9 | 3/5 | 3 | 3.3 | 2.7 | 3.0 | PASS | passing |
| scottsdale | medium | 10 | 3/5 | 3 | 4.0 | 3.0 | 3.0 | PASS | passing |
| francisco | hard | 10 | 3/5 | 3 | 4.0 | 3.0 | 3.0 | PASS | passing |
| portland | medium | 10 | 3/5 | 3 | 4.0 | 3.0 | 3.0 | PASS | passing |
| houston | medium | 10 | 3/5 | 3 | 3.3 | 2.7 | 2.7 | PASS | high-variance(range=4) |
| atlanta | medium | 10 | 3/5 | 3 | 4.0 | 3.0 | 3.0 | PASS | passing |
| sandiego | medium | 8 | 3/5 | 3 | 2.7 | 2.7 | 3.0 | FAIL | footprint(2.7/4) |
| arlington | medium | 10 | 3/5 | 3 | 4.0 | 3.0 | 3.0 | PASS | passing |
| raleigh | medium | 9 | 3/5 | 3 | 4.0 | 2.3 | 3.0 | PASS | passing |

## Action Items

- [ ] **sandiego** (8): Improve footprint (post-mask, 2x res, tighter dilate).
