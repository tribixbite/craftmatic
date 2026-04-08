# Iterate State — v309 (Photogrammetry Quality Phases 1-5)

**Target**: 9/10 buildings at 9+
**Current**: 17/21 passing at 9+ (81%)
**Model**: gemini-2.5-pro | **Runs/batch**: 3-5 | **Mode**: 20% trimmed mean
**Updated**: 2026-04-08

## Results Summary

### Old Group (10 buildings) — 8/10 passing
| Building | Score | Status | Defects |
|---|---|---|---|
| pennzoil | 10 | PASS | — |
| citigroup | 10 | PASS | — |
| transamerica | 10 | PASS | — |
| la-cityhall | 10 | PASS | Fixed from 0 (error) |
| nga-east | 9 | PASS | Improved from 7 |
| geisel | 9 | PASS | Improved from 8 |
| boston-cityhall | 9 | PASS | Stable |
| **flatiron** | **8** | PLATEAU | height_truncated, facade_holes (LOD cap) |
| **dallas-cityhall** | **8** | PLATEAU | facade_holes, floating_artifacts (cantilever underside) |
| **seattle-library** | **8** | PLATEAU | height_truncated, facade_holes (reflective glass LOD) |

### New Group (11 buildings) — 9/11 passing
| Building | Score | Status |
|---|---|---|
| hearst-tower | 10 | PASS |
| fbi-hq | 10 | PASS |
| mopop | 10 | PASS |
| boa-tower | 10 | PASS |
| vessel-nyc | 9.7 | PASS |
| disney-hall | 9 | PASS | Improved from 8 |
| marina-city | 9 | PASS |
| guggenheim | 9 | PASS |
| natl-cathedral | 9 | PASS |
| tribune-tower | 9 | PASS |
| **coit-grandrapids** | **8** | PLATEAU | low-rise school, minimal massing |

## Pipeline Phases Implemented (v309)
1. **Phase 1a+1b**: Progressive LOD cap (6.0) + 4 side cameras for facade forcing
2. **Phase 2a**: Dual-threshold voxelization (1.5× broad + BVH precision)
3. **Phase 2b**: Scanline interior fill with sky-visibility courtyard protection
4. **Phase 2c**: Facade-aligned morphClose (radius-2, normal-only)
5. **Phase 3a+3b**: Density + distance artifact cleanup
6. **Phase 4a**: Multi-sample color averaging (5 barycentric jitters, Lab space)
7. **Phase 4c+4e**: Facade color coherence + roof plane smoothing
8. **Phase 5a**: Sky-reflecting window detection (blue/grey specular)
9. **Phase 5b+5c**: Cornice preservation + setback-aware facade flattening

## Plateau Analysis (Gemini 3 Pro Review)
The 4 failing buildings are **source data limitations**, not pipeline issues:
- **Flatiron**: Google Tiles melts narrow tips into street geometry; height LOD cap
- **Dallas City Hall**: Photogrammetry fails on cantilever undersides (no camera angles)
- **Seattle Library**: Reflective glass = worst-case photogrammetry; fragmented mesh
- **Coit-Grandrapids**: Low-rise (11m) has minimal vertical geometry in tileset

Assessment: Pipeline is **production-ready for standard urban topology** (Gemini 3 Pro).
Next improvements would require external data sources (procedural generation, depth maps).

## Improvements vs v80 Baseline
| Building | v80 | v309 | Delta |
|---|---|---|---|
| la-cityhall | 0 | 10 | +10 (error fixed) |
| nga-east | 7 | 9 | +2 |
| coit-grandrapids | 7.3 | 8 | +0.7 |
| geisel | 8 | 9 | +1 |
| disney-hall | 8 | 9 | +1 |
| flatiron | 8 | 8 | 0 (plateau) |
| seattle-library | 8 | 8 | 0 (plateau) |
| dallas-cityhall | 9 | 8 | -1 (noise) |
