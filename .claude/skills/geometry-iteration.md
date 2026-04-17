# Geometry/Massing Iteration Loop

## Purpose
Iterative improvement loop targeting geometry and massing defects in the voxelizer pipeline. After each change, re-voxelize + grade failing buildings via `iterate-grade.ts` until scores plateau (3 consecutive iterations with no improvement).

## Trigger
Use when buildings fail on geometry-related defects: massing (B), footprint (A), height_truncated, or proportions_correct.

## State File
`output/geometry-iteration-state.md` — tracks iteration number, change description, scores, and whether improvement occurred.

## Target Buildings
Focus on buildings scoring < 9/10 whose diagnosis includes geometry defects:
- seattle-library: 8/10 (massing 0.3/1, stepped volumes not captured)
- disney-hall: 6.7/10 (footprint 1.4/2, curved shell — inherent voxel limitation)

## Workflow

### 1. Identify Root Cause
Before changing code, analyze:
- Is the defect in the source mesh (Google 3D Tiles LOD)?
- Is the defect introduced by post-processing (interior fill, morphClose, modeFilter)?
- Run `--info` mode and compare with/without `--no-fill` to isolate

### 2. Make Targeted Change
One change per iteration. Candidate fixes (ordered by expected impact):

**Interior Fill (mesh-filter.ts: fillInteriorGaps)**
- For stepped profiles: reduce/skip Y-dilation to preserve gaps between stacked volumes
- Make clearOpenAirFill more aggressive for stepped buildings
- Add horizontal-only dilation option

**Mode Filter (mesh-filter.ts: modeFilter3D)**
- Resolution-aware thresholds: at res=2, require higher plurality (>40%) for complex shapes
- Skip mode filter for blocks at step transition layers (Y where footprint area changes >20%)

**Morph Close (voxelize-glb.ts: morphClose3D)**
- Reduce stepped fraction 0.40 → 0.25 (protect more of building)
- Or switch to per-volume morph close (detect volumes via Y-axis density profile)

**Surface Smoothing (voxelize-glb.ts: smoothSurface)**
- Reduce stepped fraction 0.50 → 0.35 for more preservation

### 3. Test
```bash
# Quick test: just the failing buildings, 3 VLM runs
bun scripts/iterate-grade.ts --only seattle-library,disney-hall --version v307 --runs 3

# Regression check: include 2-3 passing buildings
bun scripts/iterate-grade.ts --only seattle-library,disney-hall,flatiron,citigroup --version v307 --runs 3
```

### 4. Evaluate
- If target building improved AND no regressions: commit, iterate
- If target building unchanged: revert, try next candidate fix
- If regression in passing building: revert immediately
- If 3 consecutive iterations show no improvement: STOP — declare plateau

### 5. Commit
```
v30X: geometry — {brief description of change}

— opus-4-6
```

### 6. Update State
Update `output/geometry-iteration-state.md` with:
- Iteration number
- Change description
- Before/after scores
- Next planned change

## Important Notes
- seattle-library and disney-hall both use `--no-enu` (headless GLBs)
- seattle-library uses res=2, modePasses=1, maskDilate=1
- disney-hall uses res=2, modePasses=1, maskDilate=0, osmId=relation/6333150
- Interior fill uses dilation=1 for OSM-masked builds (NOT the large dilation path)
- The 180° Y-flip + enuHorizontalAngle=0 is CORRECT — don't change
- Disney Hall's curved sails → voxel cubes is an inherent limitation; modest improvements only
- Always compare palette-compare.ts block counts before/after
