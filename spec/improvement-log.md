# LEGO Voxelization — Improvement Log

> Append a new entry after each automated improvement pass.
> Format: `## Pass N — [date] — [type]`

---

## Pass 0 — Baseline (manual work before loop)

**Type**: Initial implementation + fixes

**Changes made:**
- Created `scripts/gen-part-dims.ts` — recursive LDraw .dat bbox extractor
- Generated `ldraw-part-dims-generated.ts` — 7,252 non-trivial entries
- `Math.floor` fix for sH (stud-bump inflation): plates now correctly sH=1, bricks sH=3
- Comprehensive rewrite of `ldraw-part-dims.ts` — ~300 hand-crafted dims + PartShape type system
- Slope staircase masking in `ldraw-voxelizer.ts` — ascending axis from R matrix
- Fixed duplicate `'92438'` key in dims table

**Visual grade results (Haiku 72/100 appears to be grader ceiling):**
| Set | Bricks | Blocks | Score |
|-----|--------|--------|-------|
| 21309-1 Saturn V | 1,845 | 11,454 | 72/100 |
| 10030-1 ISD | 3,037 | 146,648 | 72/100 |
| 10179-1 Falcon | 5,606 | 78,109 | 72/100 |

**Block dimensions:**
- Saturn V: 13×256×16
- ISD: 125×136×79
- Falcon: 76×86×112

**Observations:**
- Haiku grader appears calibrated to ~72 for this quality level — incremental improvements
  don't move the needle. Use block counts and visual inspection as proxy metrics.
- ISD and Falcon renders look recognizable (wedge + disc shapes visible)
- Saturn V is 9px wide in orthographic render — too narrow for grader to evaluate well
- sH fix reduced Falcon from 87,119 → 78,109 blocks (-10%), showing real improvement

**Next priority:** Wedge masking (triangular horizontal footprint for wedge plates)

---

<!-- AUTOMATED PASSES BELOW — appended by improve-next.sh -->
