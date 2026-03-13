# Iterate State — v94

**Target**: 9/10 buildings at 9+
**Current**: 10/10 passing
**Model**: gemini-2.5-flash | **Runs/batch**: 6 | **Mode**: accumulate (20% trimmed mean)
**Updated**: 2026-03-13T22:31:44.766Z
**Last deep review**: 2026-03-13T05:54:05.303Z (gemini-2.5-pro)

| Building | Difficulty | TrimmedMean | SatRef | Runs | Avg A | Avg B | Avg C | Status | Diagnosis |
|---|---|---|---|---|---|---|---|---|
| flatiron | easy | 10 | 3/5 | 18 | 3.9 | 3.0 | 3.0 | PASS | passing |
| sentinel | medium | 9.4 | 3/5 | 18 | 3.4 | 2.8 | 2.9 | PASS | high-variance(range=4) |
| scottsdale | medium | 9.9 | 3/5 | 18 | 3.8 | 3.0 | 3.0 | PASS | passing |
| francisco | hard | 10 | 3/5 | 18 | 4.0 | 3.0 | 3.0 | PASS | passing |
| portland | medium | 9.3 | 3/5 | 18 | 3.3 | 2.8 | 3.0 | PASS | passing |
| houston | medium | 10 | 3/5 | 12 | 3.7 | 2.8 | 3.0 | PASS | high-variance(range=4) |
| atlanta | medium | 9.1 | 3/5 | 24 | 3.6 | 2.5 | 2.7 | PASS | high-variance(range=4) |
| sandiego | medium | 9.1 | 3/5 | 30 | 3.3 | 2.7 | 3.0 | PASS | passing |
| arlington | medium | 10 | 3/5 | 18 | 3.9 | 2.9 | 3.0 | PASS | passing |
| nashville | medium | 9.2 | 3/5 | 18 | 3.3 | 2.7 | 2.8 | PASS | high-variance(range=4) |
