# Iterate State — v106 (nadir composites)

**Target**: 9/10 buildings at 9+
**Current**: 0/10 passing (flash w/ nadir sat), 1/10 passing (flash w/ oblique sat)
**Model**: gemini-2.5-flash | **Runs/batch**: 5 | **Mode**: fresh (20% trimmed mean)
**Updated**: 2026-03-16T10:00:00Z
**Last deep review**: 2026-03-13T05:54:05.303Z (gemini-2.5-pro)

## v106 Nadir Satellite Fix

Composite panel order changed from `oblique sat | iso | topdown` to `nadir sat | topdown | iso`.
This gives the VLM matched perspectives (LEFT+CENTER both top-down) for honest footprint comparison.

**Result**: Scores dropped ~0.5-1.5 points across the board. The nadir composites expose
real footprint issues that oblique imagery masked. Previous "passing" scores were inflated by
the VLM's inability to compare mismatched perspectives.

## Flash Scores (nadir composites, 5 runs each)

| Building | Difficulty | Nadir Score | Oblique Score | Delta | Notes |
|---|---|---|---|---|---|
| flatiron | easy | 8.5 | 9.2 | -0.7 | Still strong, close to passing |
| sentinel | medium | 7.7 | 8.0 | -0.3 | Wedge shape visible but messy edges |
| portland | medium | 7.0 | 8.7 | -1.7 | Rectangular, hard to distinguish |
| raleigh | medium | 5.4 | 6.9 | -1.5 | High variance (3.8-7.7 range) |
| dakota | medium | 7.7 | 6.9 | +0.8 | Improved — z18 shows courtyard better |
| tampa | medium | 7.2 | 8.7 | -1.5 | Triangular footprint, z18 still oblique |
| atlanta | medium | 5.7 | 7.0 | -1.3 | Surrounding geometry bleed |
| nashville | medium | 3.6 | 3.8 | -0.2 | Blobby amorphous — pipeline issue |
| arlington | medium | 5.7 | 6.4 | -0.7 | High variance (4.6-10 range) |
| sandiego | medium | 7.0 | 6.9 | +0.1 | High variance (4.6-9.2 range) |

**Average**: 6.25 (nadir) vs 7.25 (oblique)

## Key Issues Exposed by Nadir Composites

1. **Surrounding geometry bleed**: Nashville, Atlanta, Raleigh voxels include neighboring buildings/terrain. OSM mask not tight enough.
2. **Blobby footprints**: Nashville, Tampa, Atlanta have amorphous edges — morphClose + modeFilter rounding corners.
3. **z18 still oblique in NYC**: Dakota, Flatiron z18 still has slight tilt. May need z17 for truly nadir in dense urban.
4. **Flash not outputting sub-scores**: A/B/C all 0 — flash ignores structured format, just gives totals.

## Action Items

- [ ] **Nashville** (3.6): Worst performer. Blobby footprint, need tighter mask + possibly different capture.
- [ ] **Raleigh** (5.4): High variance. May need better sat ref or tighter isolation.
- [ ] **Arlington/Atlanta** (5.7): Surrounding geometry. Tighter maskDilate or OSM mask needed.
- [ ] **Portland** (7.0): Rectangular — hard to score high without distinctive features.
- [ ] **San Diego** (7.0): High variance. Could benefit from more runs for stable mean.
- [ ] **Tampa** (7.2): z18 Tampa satellite still somewhat oblique. Good voxel though.
- [ ] **Sentinel** (7.7): Close. Better edge cleanup could push to 8+.
- [ ] **Dakota** (7.7): Actually improved with nadir. Courtyard visible at z18.
- [ ] **Flatiron** (8.5): Closest to passing. Triangle clear in both views. Needs fewer stray blocks.
- [ ] **Sub-score parsing**: Flash model ignores A/B/C format. May need simpler prompt or different model.
