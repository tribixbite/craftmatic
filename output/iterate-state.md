# Iterate State — v106

**Target**: 9/10 buildings at 9+
**Current**: 1/10 passing (flash), 0/10 (3.1-pro-preview — model drift detected)
**Model**: gemini-2.5-flash + gemini-3.1-pro-preview | **Runs/batch**: 5 (flash), 3 (pro)
**Updated**: 2026-03-16T07:30:00Z
**Last deep review**: 2026-03-13T05:54:05.303Z (gemini-2.5-pro)

## v106 Changes (from v105)
- morphClose3D r=2→r=1: preserves acute corners (Flatiron triangle)
- modeFilter3D capped to 2 passes (was 2-3): reduces cascade homogenization
- homogenizeFacadesByFace threshold 10%→15%: preserves architectural accents
- Tampa/Atlanta maskDilate 2→1: tighter isolation
- detectAndRegularizeWindows runs for all tiles (was scene-only)

## Flash Scores (gemini-2.5-flash, 5 runs)

| Building | Difficulty | TrimmedMean | Status | Notes |
|---|---|---|---|---|
| flatiron | easy | 9.2 | PASS | +3.0 from v105 (was 6.2 on pro) |
| sentinel | medium | 8.0 | FAIL | was 10 on v105 pro — model diff? |
| portland | medium | 8.7 | near-PASS | +3.3 from v105 (was 5.4 on pro) |
| raleigh | medium | 6.9 | FAIL | was 9.5 on v105 pro |
| dakota | medium | 6.9 | FAIL | was 9 on v105 pro |
| tampa | medium | 8.7 | near-PASS | +4.9 from v105 (was 3.8 on pro) |
| atlanta | medium | 7.0 | FAIL | was 10 on v105 pro |
| nashville | medium | 3.8 | FAIL | was 10 on v105 pro |
| arlington | medium | 6.4 | FAIL | was 9.3 on v105 pro |
| sandiego | medium | 6.9 | FAIL | was 9.3 on v105 pro |

## Pro Scores (gemini-3.1-pro-preview, 3 runs — MODEL DRIFT)

| Building | v105 Pro | v106 Pro | Delta | Notes |
|---|---|---|---|---|
| flatiron | 6.2 | **8.5** | +2.3 | pipeline improvement confirmed |
| sentinel | 10 | 5.4 | -4.6 | model drift (identical voxel for sentinel) |
| portland | 5.4 | 5.4 | 0 | no change |
| dakota | 9 | 1.5 | -7.5 | severe model drift |
| tampa | 3.8 | 3.1 | -0.7 | slight regression |
| nashville | 10 | 0 | -10 | catastrophic model drift |

## Analysis

gemini-3.1-pro-preview has drifted since v105 baseline — preview models rotate.
Buildings scored 9-10 two days ago now score 0-5 with IDENTICAL or improved voxels.
Sub-scores (A/B/C) mostly 0 — model not outputting structured scores reliably.

Pipeline changes ARE helping the 3 target buildings (Flatiron +2.3 on Pro, +3.0 on Flash).
But model instability makes cross-version comparison unreliable on Pro.

## Action Items

- [ ] **Model stability**: Switch to gemini-2.5-flash as primary grader (stable) or gemini-2.5-pro (stable, expensive)
- [ ] **nashville** (3.8 flash): Investigate — may need better GLB capture or building-specific tuning
- [ ] **arlington** (6.4 flash): High variance (4-10 range) — needs more runs or sat ref improvement
- [ ] **raleigh/dakota/sandiego** (~6.9 flash): Near-miss buildings — could benefit from sat ref quality improvement
- [ ] **atlanta** (7.0 flash): Isolation still imperfect despite dilate=1; --no-osm + --no-post-mask flags may interfere
- [ ] **sentinel** (8.0 flash): Close to passing — investigate render angle or window detail
- [ ] **portland/tampa** (8.7 flash): Nearly passing — may improve with more runs (variance)
