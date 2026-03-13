# Iterate State — v94

**Target**: 9/10 buildings at 9+
**Current**: 9/10 passing
**Model**: gemini-2.5-flash | **Runs/batch**: 6 | **Mode**: accumulate (20% trimmed mean)
**Updated**: 2026-03-13T23:38:42.249Z
**Last deep review**: 2026-03-13T05:54:05.303Z (gemini-2.5-pro)

| Building | Difficulty | TrimmedMean | SatRef | Runs | Avg A | Avg B | Avg C | Status | Diagnosis |
|---|---|---|---|---|---|---|---|---|
| flatiron | easy | 10 | 3/5 | 36 | 4.0 | 3.0 | 3.0 | PASS | passing |
| sentinel | medium | 9.2 | 3/5 | 36 | 3.3 | 2.6 | 2.9 | PASS | high-variance(range=4) |
| scottsdale | medium | 9.5 | 3/5 | 36 | 3.6 | 2.7 | 3.0 | PASS | passing |
| francisco | hard | 10 | 3/5 | 36 | 3.9 | 2.9 | 2.9 | PASS | high-variance(range=4) |
| portland | medium | 9.3 | 3/5 | 36 | 3.3 | 2.7 | 3.0 | PASS | high-variance(range=4) |
| houston | medium | 9.4 | 3/5 | 30 | 3.4 | 2.7 | 2.8 | PASS | high-variance(range=4) |
| atlanta | medium | 9.3 | 3/5 | 30 | 3.5 | 2.6 | 2.9 | PASS | high-variance(range=4) |
| sandiego | medium | 8.5 | 3/5 | 6 | 3.2 | 2.5 | 2.7 | FAIL | high-variance(range=4) |
| arlington | medium | 10 | 3/5 | 36 | 4.0 | 3.0 | 3.0 | PASS | passing |
| nashville | medium | 9.5 | 3/5 | 36 | 3.4 | 2.7 | 2.8 | PASS | high-variance(range=4) |

## Action Items

- [ ] **sandiego** (8.5): Stabilize grading (more runs, check sat-ref quality).
