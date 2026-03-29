# Iterate State — v301

**Model**: gemini-2.5-pro | **Runs/batch**: 5 | **Mode**: fresh (20% trimmed mean)
**Updated**: 2026-03-29T14:05:05.885Z

## Old Group (v300 set) — 9/10 at 9+

| Building | Difficulty | TrimmedMean | Runs | Status | Diagnosis |
|---|---|---|---|---|---|
| flatiron | easy | 9 | 5 | PASS | massing(0.0/1) |
| pennzoil | hard | 10 | 5 | PASS | massing(0.8/1), identity(1.6/2) |
| nga-east | medium | 10 | 5 | PASS | footprint(1.8/2), identity(0.4/2) |
| dallas-cityhall | hard | 10 | 5 | PASS | passing |
| seattle-library | hard | 9 | 5 | PASS | massing(0.0/1) |
| boston-cityhall | hard | 9 | 5 | PASS | passing |
| citigroup | hard | 8 | 5 | FAIL | footprint(1.8/2), massing(0.2/1) |
| geisel | hard | 9.3 | 5 | PASS | passing |
| transamerica | hard | 9.3 | 5 | PASS | massing(0.4/1) |
| la-cityhall | hard | 10 | 5 | PASS | passing |

## New Group (v301 set) — 10/10 at 9+

| Building | Difficulty | TrimmedMean | Runs | Status | Diagnosis |
|---|---|---|---|---|---|
| marina-city | hard | 10 | 5 | PASS | identity(0.8/2) |
| hearst-tower | hard | 10 | 5 | PASS | passing |
| guggenheim | hard | 9 | 5 | PASS | passing |
| fbi-hq | medium | 10 | 5 | PASS | passing |
| mopop | hard | 9 | 5 | PASS | massing(0.2/1) |
| natl-cathedral | hard | 10 | 5 | PASS | identity(0.4/2) |
| boa-tower | hard | 9 | 5 | PASS | massing(0.0/1) |
| tribune-tower | hard | 10 | 5 | PASS | massing(0.8/1), identity(1.6/2) |
| vessel-nyc | hard | 9.3 | 5 | PASS | footprint(1.8/2), massing(0.6/1), identity(0.4/2) |
| disney-hall | hard | 10 | 5 | PASS | passing |

## Action Items

- [x] New group: 10/10 at 9+ (target achieved)
- [ ] **citigroup** (8): sole old-group failure — footprint + massing issues
