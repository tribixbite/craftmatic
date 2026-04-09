# Iterate State — v310 (Post-Recapture Validation)

**Target**: 9/10 buildings at 9+
**Current**: 18/21 passing at 9+ (85.7%)
**Model**: gemini-2.5-pro | **Runs/batch**: 3 | **Mode**: 20% trimmed mean
**Updated**: 2026-04-09

| Building | Difficulty | TrimmedMean | Runs | Status | Diagnosis |
|---|---|---|---|---|---|
| flatiron | easy | 9 | 3 | PASS | Phase 4d improved (was 8 in v309) |
| pennzoil | hard | 9 | 3 | PASS | stable |
| nga-east | medium | 9 | 3 | PASS | stable |
| dallas-cityhall | hard | 8 | 3 | PLATEAU | cantilever underside |
| seattle-library | hard | 8 | 3 | REGRESSED | was 10 before recapture, fresh GLB lower quality |
| boston-cityhall | hard | 9 | 3 | PASS | stable |
| citigroup | hard | 9 | 3 | PASS | recovered after recapture fix |
| geisel | hard | 9 | 3 | PASS | stable |
| transamerica | hard | 10 | 3 | PASS | recovered after recapture fix |
| la-cityhall | hard | 10 | 3 | PASS | stable |

## Phase 1c Headless Validation

**Finding**: Phase 1c tighter bands cause regressions in headless capture.
- citigroup: OOM (308 meshes/21MB), transamerica: 10→8, seattle-library: 10→7
- **Root cause**: Google Tiles non-deterministic — more cameras load different (not better) tiles
- **Resolution**: Reverted in headless. Phase 1c browser-only.

## Action Items
- [ ] seattle-library: re-run headless capture attempts to find a good GLB (scored 10 with old GLB)
- [ ] dallas-cityhall + coit-grandrapids: plateau (source data limited)
