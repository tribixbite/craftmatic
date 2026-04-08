# Iterate State — v310 (Phases 1-5 + 1c + 4d)

**Target**: 9/10 buildings at 9+
**Current**: 19/21 passing at 9+ (90.5%)
**Model**: gemini-2.5-pro | **Runs/batch**: 3 | **Mode**: 20% trimmed mean
**Updated**: 2026-04-08

## Results Summary

### Old Group (10 buildings) — 9/10 passing
| Building | Score | Status | v309→v310 |
|---|---|---|---|
| pennzoil | 9 | PASS | 10→9 (noise, still pass) |
| citigroup | 10 | PASS | 10→10 |
| transamerica | 10 | PASS | 10→10 |
| la-cityhall | 10 | PASS | 10→10 |
| nga-east | 9 | PASS | 9→9 |
| geisel | 9 | PASS | 9→9 |
| boston-cityhall | 9 | PASS | 9→9 |
| flatiron | 9 | PASS | **8→9** (Phase 4d palette clustering) |
| seattle-library | 10 | PASS | **8→10** (Phase 4d reduced glass noise) |
| **dallas-cityhall** | **8** | PLATEAU | 8→8 (cantilever underside) |

### New Group (11 buildings) — 10/11 passing
| Building | Score | Status | v309→v310 |
|---|---|---|---|
| hearst-tower | 10 | PASS | 10→10 |
| fbi-hq | 10 | PASS | 10→10 |
| mopop | 10 | PASS | 10→10 |
| boa-tower | 10 | PASS | 10→10 |
| vessel-nyc | 10 | PASS | 9.7→10 |
| disney-hall | 10 | PASS | **9→10** (Phase 4d) |
| marina-city | 9 | PASS | 9→9 |
| guggenheim | 9 | PASS | 9→9 |
| natl-cathedral | 9 | PASS | 9→9 |
| tribune-tower | 9 | PASS | 9→9 |
| **coit-grandrapids** | **8** | PLATEAU | 8→8 (low-rise school) |

## Pipeline Phases Implemented (v310)
1. **Phase 1a+1b**: Progressive LOD cap (6.0) + 4 side cameras for facade forcing
2. **Phase 1c**: Vertical-slice capture for tall buildings (multi-height camera sweeps)
3. **Phase 2a**: Dual-threshold voxelization (1.5× broad + BVH precision)
4. **Phase 2b**: Scanline interior fill with sky-visibility courtyard protection
5. **Phase 2c**: Facade-aligned morphClose (radius-2, normal-only)
6. **Phase 3a+3b**: Density + distance artifact cleanup
7. **Phase 4a**: Multi-sample color averaging (5 barycentric jitters, Lab space)
8. **Phase 4c+4e**: Facade color coherence + roof plane smoothing
9. **Phase 4d**: K-means facade palette clustering (k=4 per face, Lab space)
10. **Phase 5a**: Sky-reflecting window detection (blue/grey specular)
11. **Phase 5b+5c**: Cornice preservation + setback-aware facade flattening

## v310 vs v309 Improvements
| Building | v309 | v310 | Delta |
|---|---|---|---|
| flatiron | 8 | 9 | +1 (palette clustering) |
| seattle-library | 8 | 10 | +2 (glass noise reduction) |
| disney-hall | 9 | 10 | +1 (palette clustering) |
| vessel-nyc | 9.7 | 10 | +0.3 |

## Plateau Analysis
2 remaining failures are source data limitations (confirmed by Gemini 3 Pro review):
- **Dallas City Hall**: Photogrammetry fails on cantilever undersides (no camera angles)
- **Coit-Grandrapids**: Low-rise (11m) has minimal vertical geometry in tileset

Pipeline is production-ready. Next improvements require external data sources.
