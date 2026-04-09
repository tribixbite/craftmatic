# Geometry-Accurate Voxelization: 95%+ Quality Loop

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Achieve 95%+ visual accuracy on 10 diverse LEGO models (100+ pieces each) using the geometry-accurate voxelizer with tri-axis ray casting.

**Architecture:** Fix post-processing corruption, add AABB fallback for missing geometry, expand color coverage, then build an automated grading loop that renders all 10 models and scores them via Claude vision API until 95%+ on every model.

**Tech Stack:** TypeScript, Bun, LDraw .dat triangle geometry, CIE Lab color matching, Claude vision API for grading.

---

## Benchmark Models (10 random, 100+ pieces)

| # | File | Parts | Type |
|---|------|-------|------|
| 1 | `71043_hogwarts_castle.ldr` | 5,936 | HP Building |
| 2 | `42083 Bugatti Chiron.mpd` | 4,382 | Technic Supercar |
| 3 | `10179 UCS Millenium Falcon.mpd` | 4,324 | Star Wars UCS |
| 4 | `10255 Assembly Square.ldr` | 3,997 | Modular Building |
| 5 | `60216 Downtown Fire Brigade.mpd` | 3,615 | City Building |
| 6 | `31084 Pirate Roller Coaster [Model A].mpd` | 1,507 | Creator Ride |
| 7 | `8010 Darth Vader.mpd` | 671 | Buildable Figure |
| 8 | `6986 Mission Commander.mpd` | 600 | Classic Space |
| 9 | `8849 Tractor.ldr` | 349 | Technic Farm |
| 10 | `1924 Viking Line Ferry.ldr` | 242 | Boat |

---

## Critical Issues (found in analysis)

1. **Post-processing corrupts geometry voxels** — `solidifyColumns()` and `fillSingleVoxelGaps()` fill valid air pockets inside geometry-accurate models, creating phantom blocks inside hollow structures. ~5-10% quality loss.
2. **Missing geometry = skipped parts** — When a .dat file isn't found, the geometry voxelizer skips the part entirely (black holes). Should fall back to AABB dims.
3. **Color coverage at 26%** — Only ~105/400 LDraw colors have explicit RGB entries. Unmapped ones hit CIE Lab fallback which works but is slow.

---

### Task 1: Fix Post-Processing for Geometry Mode

**Files:**
- Modify: `web/src/ui/lego.ts:603-605`

The geometry voxelizer produces accurate solid/air via parity-filled ray casting. Applying `solidifyColumns()` fills valid interior voids (wheel wells, cockpits, engine bays) with phantom blocks. Applying `fillSingleVoxelGaps()` bridges intentional 1-cell gaps (Technic beam holes, window openings).

- [ ] **Step 1: Conditionally skip post-processing in geometry mode**

In `web/src/ui/lego.ts`, change lines 603-605 from:

```typescript
  solidifyColumns(result.grid, 6);
  fillSingleVoxelGaps(result.grid);
```

to:

```typescript
  // Post-processing: only for AABB mode — geometry mode already has accurate solid/air via ray casting.
  // solidifyColumns fills valid interior voids (cockpits, wheel wells) with phantom blocks.
  if (!geometryMode) {
    solidifyColumns(result.grid, 6);
    fillSingleVoxelGaps(result.grid);
  }
```

- [ ] **Step 2: Verify with typecheck**

Run: `bun run typecheck`
Expected: clean output

---

### Task 2: Add AABB Fallback for Missing Geometry

**Files:**
- Modify: `web/src/engine/ldraw-geometry.ts:420-427`
- Import: `getPartDims`, `hasDims` from `ldraw-part-dims.js`

When a .dat file can't be fetched or has no triangles, the geometry voxelizer currently skips the part (creating holes). Instead, fall back to the AABB bounding-box fill using `getPartDims()`.

- [ ] **Step 1: Add import for part dims**

At the top of `ldraw-geometry.ts`, add:

```typescript
import { getPartDims } from './ldraw-part-dims.js';
```

- [ ] **Step 2: Replace skip with AABB fallback**

Replace the fallback block (around line 420-427):

```typescript
    const localTris = partGeomCache.get(normId(brick.part));
    if (!localTris || localTris.length === 0) {
      fallbackPartCount++;
      continue;
    }
```

with:

```typescript
    const localTris = partGeomCache.get(normId(brick.part));
    if (!localTris || localTris.length === 0) {
      // Fallback: use AABB dims fill (same as bbox voxelizer)
      fallbackPartCount++;
      const [sW, sH, sL] = getPartDims(brick.part);
      const R = brick.rot ?? IDENTITY;
      const lxHalf = (sW - 1) / 2 * LDU_STUD;
      const lzHalf = (sL - 1) / 2 * LDU_STUD;
      const lyBot = (sH - 1) * 8; // plates
      // Compute world AABB
      let bxMin = Infinity, bxMax = -Infinity;
      let byMin = Infinity, byMax = -Infinity;
      let bzMin = Infinity, bzMax = -Infinity;
      for (const lx of [-lxHalf, lxHalf]) {
        for (const ly of [0, lyBot]) {
          for (const lz of [-lzHalf, lzHalf]) {
            const wx = R[0]!*lx + R[1]!*ly + R[2]!*lz + brick.x;
            const wy = R[3]!*lx + R[4]!*ly + R[5]!*lz + brick.y;
            const wz = R[6]!*lx + R[7]!*ly + R[8]!*lz + brick.z;
            if (wx < bxMin) bxMin = wx; if (wx > bxMax) bxMax = wx;
            if (wy < byMin) byMin = wy; if (wy > byMax) byMax = wy;
            if (wz < bzMin) bzMin = wz; if (wz > bzMax) bzMax = wz;
          }
        }
      }
      const gxMin = Math.round(bxMin / LDU_STUD), gxMax = Math.round(bxMax / LDU_STUD);
      const gyMin = Math.round(-byMax / LDU_PER_Y), gyMax = Math.round(-byMin / LDU_PER_Y);
      const gzMin = Math.round(bzMin / LDU_STUD), gzMax = Math.round(bzMax / LDU_STUD);
      for (let x = gxMin; x <= gxMax; x++)
        for (let y = gyMin; y <= gyMax; y++)
          for (let z = gzMin; z <= gzMax; z++)
            cells.push({ gx: x, gy: y, gz: z, block, color: brick.color });
      continue;
    }
```

- [ ] **Step 3: Verify with typecheck**

Run: `bun run typecheck`
Expected: clean output

---

### Task 3: Expand LDraw Color RGB Coverage

**Files:**
- Modify: `web/src/engine/ldraw-colors.ts` (the `LDRAW_COLOR_RGB` object)

Add all missing standard LDraw color RGB values from the official LDConfig.ldr spec. The current table has ~150 entries; the full LDraw spec defines ~400+. Focus on the 0-511 range and ensure all common colors have RGB values for CIE Lab fallback.

- [ ] **Step 1: Fetch complete color definitions from LDraw library**

Run this to extract all color definitions from the local LDraw library:

```bash
grep -E "^0 !COLOUR" C:/git/clego/extracted/studio_release/app/ldraw/LDConfig.ldr | head -80
```

This gives the authoritative RGB hex for each LDraw color ID.

- [ ] **Step 2: Add missing RGB entries to LDRAW_COLOR_RGB**

Parse the LDConfig.ldr output and add all missing color IDs to the `LDRAW_COLOR_RGB` map. Each entry is `colorId: '#RRGGBB'`. Ensure no duplicates with existing entries.

- [ ] **Step 3: Verify with typecheck**

Run: `bun run typecheck`
Expected: clean output

---

### Task 4: Build Automated Grading Script

**Files:**
- Create: `scripts/grade-geometry.ts`

Build a script that:
1. Loads each of the 10 benchmark models from `C:/git/clego/lego_sets/LDR/`
2. Parses with `parseLDraw()`
3. Voxelizes with `voxelizeLDrawGeometry()` in cubic mode
4. Renders orthographic front/side/top views as PNG (using the existing rendering pipeline from `grade-models.ts`)
5. Fetches a reference image (Rebrickable thumbnail or set box art) 
6. Sends both to Claude vision API asking "Rate 1-10 how closely the voxelized model resembles the assembled LEGO set"
7. Reports scores and identifies which models fail < 9.5/10
8. Writes results to `.claude/geometry-grade-state.json`

The script should be runnable as `bun scripts/grade-geometry.ts` and produce a summary table.

- [ ] **Step 1: Create the grading script skeleton**

Model it on the existing `scripts/grade-models.ts` but:
- Use `voxelizeLDrawGeometry()` instead of `voxelizeLDraw()`
- Load from local LDR directory instead of OMR
- Use cubic scale by default
- Skip post-processing (geometry mode)
- Grade threshold: 9.5/10 (maps to ~95% accuracy)

- [ ] **Step 2: Add the 10 benchmark model paths**

Hardcode the 10 model paths from the benchmark table above.

- [ ] **Step 3: Add rendering (reuse from grade-models.ts)**

Copy the orthographic rendering logic from `grade-models.ts` that generates front/side/top view PNGs from a BlockGrid.

- [ ] **Step 4: Add Claude vision grading**

Send the rendered views to Claude with a prompt asking for a 1-10 quality score and specific issues.

- [ ] **Step 5: Run initial grading baseline**

Run: `bun scripts/grade-geometry.ts`
Record baseline scores for all 10 models.

---

### Task 5: Iteration Loop — Fix Issues Until 95%+

After getting baseline scores from Task 4, iterate:

- [ ] **Step 1: Identify lowest-scoring model**

Read the grading output. Focus on the model with the lowest score.

- [ ] **Step 2: Diagnose specific issues**

For the failing model, check:
- How many parts fell back to AABB? (check `fallbackPartCount`)
- Are there color mapping issues? (check `unmappedColors`)
- Are there geometry gaps (holes in surfaces)?
- Are there orientation/flip issues?

- [ ] **Step 3: Fix the root cause**

Apply targeted fixes:
- Missing part geometry → add to generated dims or fix .dat file path resolution
- Wrong colors → add explicit entries to `LDRAW_COLOR_TO_BLOCK` or `LDRAW_COLOR_RGB`
- Geometry gaps → adjust ray casting parameters or add surface-only fill
- Orientation issues → fix auto-flip threshold or add model-specific overrides

- [ ] **Step 4: Re-grade and check if 95%+ achieved**

Run: `bun scripts/grade-geometry.ts`
If all 10 models score >= 9.5/10, we're done.
If not, go back to Step 1 with the next failing model.

---

## Success Criteria

- All 10 benchmark models score >= 9.5/10 from Claude vision grading
- No model has > 5% fallback parts (geometry coverage)
- No model has unmapped colors visible as gray blocks
- Geometry mode enabled by default in dev when `/ldraw-parts` is available
