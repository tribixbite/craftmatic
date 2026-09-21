# Selected-set quality audit — 2026-09-21

This is a read-only join of the frontend's actual `bestIndexedModel()` auto-pick
from `C:/git/clego/lego-models-index.json`, the current bytes under
`C:/git/clego/lego_sets`, and the completed 2026-09-20 upstream-library board
at `output/corpus-improvements-2026-09-20/board/scoreboard_full.json`. The table
records the pre-repair production snapshot. Subsequently only 75397 was repaired
and published (details below); the index and ranking remain unchanged.

## Evidence boundary

- At audit time all 39 auto-selected files matched the index hash and fresh board row's
  full SHA-256 exactly. `fresh` is therefore source-grade freshness, not merely
  an index-to-disk comparison.
- `index V/D` is the index's older `asm` label. A read-only production GET
  audit found the deployed index byte-identical to the local index and all 39
  auto-selected production files full-SHA-identical to the locally graded
  bytes; the per-row evidence is in
  `output/pipeline-2026-09-21/selected39-production-freshness.md`.
  `board PASS/DEF` is the
  newer hash-matched measurement. The auto-picks have 11 PASS and 28 DEFECTIVE
  fresh rows; their local-index labels say 14 verified and 25 defective. The
  three disagreements are 10326 (four off-frame panes), 42172 (fresh
  unknown-part threshold), and 910032 (two figure defects), all on the same
  bytes the local index labels verified.
- Auto-pick is intentionally not `models[0]`: inflated (>2.2× catalogue count)
  and conversion demotions apply before verified promotion. Twelve of these
  39 sets move away from row zero. A production probe independently confirmed
  that behavior for 10303.
- Counters are `floating/big-floating`, split-0 cluster count (`S`), figure
  defects, window defects, and grader-unknown placements. Every selected file
  has a current window measurement; there are no inferred or unknown zeros.
- `residue` records material counters the compact columns omit: side models
  (`side`), polish-displaced parts (`disp`), staged main fraction (`stage`),
  overlap (`ovl`), and sunk parts.
- Grader-unknown is not renderer-missing. The grader uses a frozen upstream
  library; the web renderer has a broader production resolution chain. A
  nonzero `U` is therefore a source-audit lead, not proof of missing rendered
  geometry.

## Actual selected files

| set | selected source and path | hash | grade / fresh | F/B · S · Fig · W · U | residue | best next evidence or candidate |
|---|---|---|---|---|---|---|
| 10303 | `io_model2_v2` `IOModel2V2/10303.ldr` | `b51c0b67042c` | index V; board PASS / yes | 8/0 · 1 · 0 · 0 · 53 | side 165 | Production confirms this assembled auto-pick and 3,808 rendered bricks; census 9 renderer-missing pieces, not all 53 grader unknowns. |
| 10326 | `io_model2_v2` `IOModel2V2/10326-noprint.ldr` | `d164e9dd43f8` | index V; board **DEF** / yes | 0/0 · 1 · 0 · **4** · 35 | sunk 1 | Index label is stale. Diagnose four panes; `DbixConvV3/10326.ldr` has W0/U0 but one figure defect and lower retention. |
| 10337 | `io_model2_v2` `IOModel2V2/10337.ldr` | `f8730b89e05e` | index V; board PASS / yes | 0/0 · 0 · 0 · 0 · 18 | sunk 3 | Renderer-missing census for the 18 grader unknowns; no source defect candidate. |
| 10341 | `io_model2_v2` `IOModel2V2/10341.ldr` | `1fbc9dbf22bf` | index V; board PASS / yes | 0/0 · 3 · 0 · 0 · 30 | clean otherwise | Renderer-missing census; no calibrated source defect. |
| 10354 | `dbix_conv_v3` `DbixConvV3/10354.ldr` | `d2b0669344b6` | index D; board DEF / yes | 1/0 · 5 · 8 · 0 · 0 | side 521, disp 167, stage .747 | Compare `MecabricksLDR/10354.ldr` visually: 0 big float/0 disp but still 4 figure defects + 1 unknown. |
| 10365 | `dbix_conv_v3` `DbixConvV3/10365.ldr` | `6844915264cc` | index D; board DEF / yes | 80/69 · 5 · 0 · 0 · 0 | side/disp 147, stage .867 | Fix v3 alignment/polish; every indexed alternate remains defective. |
| 11371 | `dbix_conv_v3` `DbixConvV3/11371.ldr` | `5bbb8f0e6d44` | index V; board PASS / yes | 1/0 · 4 · 0 · 0 · 1 | side 95, sunk 1 | Verify the one unknown in renderer; source is already the passing alternate. |
| 11374 | `dbix_conv_v3` `DbixConvV3/11374.ldr` | `e4ad7758b941` | index V; board PASS / yes | 2/0 · 1 · 0 · 0 · 0 | side 3, ovl .09% | Visual/export probe only. |
| 21061 | `io` `IO/21061.io` | `10a0528a0aa0` | index V; board PASS / yes | 0/0 · 0 · 0 · 0 · 0 | clean | Visual/export probe only. |
| 21063 | `io` `IO/21063.io` | `e178448ea530` | index V; board PASS / yes | 0/0 · 0 · 0 · 0 · 0 | inventory .939 | Visual check for intentional inventory delta; retain IO pending it. |
| 21318 | `omr` `OMR/21318-1.mpd` | `0b4b4ff9d8a7` | index V; board PASS / yes | 4/0 · 13 · 0 · 0 · 0 | side 6 | Authentic-source split residue; visual/export probe, no generated repair. |
| 21360 | `dbix_conv_v3` `DbixConvV3/21360.ldr` | `cffb3a91383d` | index D; board DEF / yes | 118/118 · 12 · 10 · 0 · 0 | ovl .34%, sunk 2 | V3 float/figure repair; v2 cuts float to 59 but has 65 figure defects. |
| 31141 | `io_model2_v2` `IOModel2V2/31141.ldr` | `42f371176ce3` | index D; board DEF / yes | 0/0 · 1 · 3 · 0 · 36 | otherwise clean | Render against `DbixConvV3/31141_sm01.ldr` (1 figure defect, no unknowns) and confirm model/variant identity. |
| 41395 | `mecabricks` `MecabricksLDR/41395.ldr` | `9cfe47d0bde2` | index D; board DEF / yes | 8/7 · 1 · 8 · 0 · 7 | side 38, sunk 4 | Not touched by completed preserve-pose trial; needs a targeted figure/unknown diagnosis. |
| 41703 | `dbix_conv_v3` `DbixConvV3/41703.ldr` | `d8c1c2604169` | index D; board DEF / yes | 30/30 · 6 · 1 · 0 · 0 | side/disp 63, stage .879 | V3 staged/polish repair; indexed alternates are worse. |
| 41732 | `dbix_conv_v3` `DbixConvV3/41732.ldr` | `8f5ab470a63b` | index D; board DEF / yes | 27/14 · 5 · 3 · 0 · 0 | side 41, sunk 1 | Target current figures/float; `LDR/41732.ldr` loses 175 parts and is still defective. |
| 42172 | `io_model2_v2` `IOModel2V2/42172.ldr` | `f8433d83d692` | index V; board **DEF** / yes | 1/0 · 4 · 0 · 0 · 97 | side 19, ovl .10%, sunk 8 | Fresh grade invalidates the verified label; renderer-missing census before source edits. |
| 42639 | `dbix_conv_v3` `DbixConvV3/42639.ldr` | `9de8d9b8ebc2` | index D; board DEF / yes | 3/0 · 5 · 5 · 0 · 0 | side 56, sunk 1 | Target figure residue; alternates introduce major float. |
| 42652 | `dbix_conv_v3` `DbixConvV3/42652.ldr` | `e33282b23a7c` | index D; board DEF / yes | 40/27 · 0 · 2 · 0 · 0 | side 70, disp 71, stage .899 | Repair v3 float/polish; v2 has less float but 21 figure defects. |
| 42663 | `dbix_conv_v3` `DbixConvV3/42663.ldr` | `dc3218f6cfe7` | index D; board DEF / yes | 0/0 · 0 · 2 · 0 · 0 | side 70 | Render `LDR/42663.ldr`: scalar PASS but only 672/782 placements (86% retention). |
| 42670 | `dbix_conv_v3` `DbixConvV3/42670.ldr` | `91679922cc40` | index D; board DEF / yes | 4/0 · 4 · 5 · 0 · 0 | side 91, disp 50, sunk 1 | Target v3 figures/polish; PASS `LDR/42670.ldr` retains only 87%. |
| 43267 | `dbix_conv_v3` `DbixConvV3/43267.ldr` | `bac0b81b38d2` | index D; board DEF / yes | 49/34 · 0 · 1 · 0 · 3 | side 3, sunk 3 | Fix current float; PASS `LDR/43267.ldr` retains only 84%. |
| 60380 | `dbix_conv_v3` `DbixConvV3/60380.ldr` | `e30ab48ebccf` | index D; board DEF / yes | 74/6 · 5 · 1 · 0 · 0 | side 159, stage .895, sunk 1 | Target v3 float/staged residue; all alternates are defective. |
| 60446 | `io_model2_v2` `IOModel2V2/60446-base.ldr` | `706cc6f2570c` | index D; board DEF / yes | 20/20 · 0 · 1 · 0 · 27 | side 453 | Render `DbixConvV3/60446.ldr` (2/0 float, 1 figure, 0 unknown) and verify base-model identity. |
| 71040 | `mecabricks` `MecabricksLDR/71040.ldr` | `dbe8fcadd6dc` | index V; board PASS / yes | 0/0 · 0 · 0 · 0 · 0 | sunk 1 | Completed preserve-pose trial is a no-op; retain source. |
| 71043 | `lxf` `LXF/71043_hogwarts_castle.lxf` | `479bdba847f9` | index D; board DEF / yes | 23/0 · 30 · 5 · 0 · 0 | side 159, ovl .05%, sunk 5 | Source/render inspection; sole LDR alternate adds 22 big-float parts. |
| 75397 | `mecabricks` `MecabricksLDR/75397.ldr` | `5cfd6121f256` | index D; board DEF / yes | 88/80 · 0 · 8 · 0 · 13 | side 160, ovl .18%, sunk 12 | Pre-repair row. Hardened A/B and fixed-pose visuals pass: figures 8→2, all other metrics and n=3,973 unchanged. Repaired bytes `b552734a27a7` now live; index metadata remains old. |
| 76269 | `mecabricks` `MecabricksLDR/76269.ldr` | `945fb96c1898` | index D; board DEF / yes | 97/88 · 0 · 12 · 0 · 59 | side 475, ovl .06% | Conv demotion chooses this over v3, but v3 has 45/35 float and U0; visually compare before revising the policy or source rank. |
| 76286 | `dbix_conv_v3` `DbixConvV3/76286.ldr` | `b5be43f938ac` | index D; board DEF / yes | 3/0 · 1 · 2 · 0 · 1 | side 50, sunk 4 | Target two figures, then renderer-check the one grader unknown. |
| 76417 | `dbix_conv_v3` `DbixConvV3/76417.ldr` | `f18bca56f6f9` | index D; board DEF / yes | 32/0 · 15 · 7 · 0 · 0 | side 1,639, stage .598 | Staged/multi-build visual diagnosis before any repair. |
| 76419 | `io` `IO/76419.io` | `43d117e8caac` | index V; board PASS / yes | 0/0 · 0 · 0 · 0 · 0 | ovl .08% | Visual/export probe only. |
| 76435 | `dbix_conv_v3` `DbixConvV3/76435.ldr` | `7475b0163388` | index D; board DEF / yes | 5/0 · 2 · 3 · 0 · 0 | side 111, disp 94, sunk 1 | Repair v3 polish/figures; existing in-game actor is not source-fidelity proof. |
| 76457 | `dbix_conv_v3` `DbixConvV3/76457.ldr` | `c71140a2ce9c` | index D; board DEF / yes | 3/0 · 7 · 0 · 1 · 0 | side 160, stage .336 | Window count is within calibrated noise; staged fraction requires visual model-identity review. |
| 77092 | `dbix_conv_v3` `DbixConvV3/77092_sm01.ldr` | `d780b641b90d` | index D; board DEF / yes | 15/10 · 10 · 3 · 0 · 0 | side 540, stage .749, ovl .36%, sunk 5 | Keep SM01; every sibling/alternate grades worse. Target remaining float/figures. |
| 80049 | `dbix_conv_v3` `DbixConvV3/80049.ldr` | `509950a380c8` | index D; board DEF / yes | 5/0 · 5 · 10 · 0 · 0 | side/disp 95, sunk 1 | Target figures/polish; windows are clean, alternates remain defective. |
| 910004 | `io_model2_v2` `IOModel2V2/910004.ldr` | `3843a4b86327` | index V; board PASS / yes | 0/0 · 0 · 0 · 1 · 44 | clean otherwise | Window count is within noise; census the 44 grader unknowns in renderer/export. |
| 910032 | `io_model2_v2` `IOModel2V2/910032.ldr` | `41f17e094128` | index V; board **DEF** / yes | 0/0 · 0 · 2 · 0 · 39 | clean otherwise | Repair the two figure defects; row-zero IO passes but is demoted as inflated. |
| 910047 | `io_model2_v2` `IOModel2V2/910047.ldr` | `8fba10ff56f3` | index D; board DEF / yes | 2/0 · 1 · 10 · 0 · 82 | side 95 | Render `DbixConvV3/910047.ldr` (1 figure, 0 unknown, but 20 float) against the actual pick. |
| 910049 | `io_model2_v2` `IOModel2V2/910049-closed.ldr` | `b7df6c315935` | index D; board DEF / yes | 39/33 · 6 · 23 · 0 · 132 | side 10 | Actual auto-pick is worse than row-zero IO on float/fig/U; audit inflated-source demotion and closed-model identity. |

## Completed-job assessment

Both jobs left as live in `corpus-repairs/LIVE-JOBS.md` actually completed:

- `figure-mecabricks-preserve-ab-strict.json`: 1,020 matched A/B rows. Applying
  the documented conservative scalar rule (figure defects strictly decrease,
  exact placement count retained, no increase in float/big-float, split,
  overlap, sunk, side-model, window, duplicate, unknown, or overlap volume)
  leaves 345 **legacy nominations**. These are not acceptances because the job
  predates input/grader hashing. Of the user's actual selected files, 75397 is
  the actionable row: figures 8→2 with no measured regression. 71040 is a
  no-op, and 41395 was not touched.
  `output/pipeline-2026-09-21/75397-hardened-ab.json` subsequently regraded
  75397 with exact hashes and the hardened helper: figure defects 8→2, while
  all other retained metrics are identical (`n=3973`, float/big 88/80,
  unknown 13, sunk 12, overlap 7 parts / 896 LDU3). It passes the scalar gate
  and now needs only fixed-pose visual review before any in-place apply.
- `window-dbixv2-ab-strict.json`: 299 matched A/B rows; 251 meet the analogous
  conservative scalar nomination rule. This is a DbixConvV2 trial, while none
  of the 39 current primaries is DbixConvV2. It therefore does not certify any
  selected file. The most relevant trial candidates among these sets are
  `DbixConvV2/{11371,41703,41732,42652,42670,43267,76417,76435}.ldr`, whose
  windows fall to zero without a measured scalar regression. They remain poor
  source-switch candidates where their figure/float grade is worse than the
  selected v3 file; the useful action is to carry the proven window repair into
  future converter regeneration, not promote v2 blindly.
- No inherited grading process is evidenced as still writing these outputs;
  both final JSONs contain their advertised complete row counts. Their tracker
  is stale and should be closed, but the files must remain nomination-only per
  its own provenance warning.

Exact leading candidate files:

- Figure: `output/corpus-improvements-2026-09-20/corpus-repairs/trials/figure-mecabricks-preserve/MecabricksLDR/75397.ldr`
- Window example: `output/corpus-improvements-2026-09-20/corpus-repairs/trials/window-dbixv2/DbixConvV2/42670.ldr`

75397 passed fixed-camera front/iso/left and figure closeup review: the gold
figure's detached arms/hands reattach while retaining its asymmetric pose;
the lineup, stands and ship are unchanged. Evidence is under
`output/pipeline-2026-09-21/75397-{before,after}-reviewed/`. This accepts the
hash-pinned candidate. With explicit user approval, it is now applied and
published at full SHA256 `b552734a27a762898b9bb7492a1d4b26ac79a0376948259bf7f5c56df4a9e140`.
The exact original (`5cfd6121f256142eff4d9a61a7ba27976de5c94b7a20a90416e2c81dcae0c5aa`)
is backed up in `output/pipeline-2026-09-21/75397-apply-backup/`.
One-file publisher returned `ok=1 fail=0` with index skipped. Canonical public
GET matched the complete repaired hash (`75397-cdn-readback.ldr` under the
evidence root above); production index readback remains SHA256
`64c4746eb7e7254211bf32e5053a79c7c2e90dc6819c7abe5636e9bb1909191a`.
Its 75397 hash/grade metadata intentionally remains stale, not newly certified.
Production browser auto-load rendered 3,973 bricks (3,963 live instances, 681
meshes); its same-origin fetch returned the exact repaired SHA and provenance
marker. The viewer correctly displays an index-hash mismatch warning. Evidence:
`output/pipeline-2026-09-21/75397-prod-postpublish-20260921/`.
Other legacy
nominations still need a small hardened, hash-pinned targeted regrade followed
by visual review. Do not apply the whole trial cohort.

## Render, export, and in-game coverage

- No scalar source grade proves a renderer or exporter result. The common
  source-side gaps here are figures, floating/split assemblies, polish-displaced
  parts, and staged captures. Renderer-side missing geometry must be established
  separately against the web resolver; grader unknowns alone do not establish it.
- The prior Pixel run loaded already-installed LOD actors for 71043, 76286, and
  76435 and measured near/far performance. It did not prove that those packs
  were exported from the current selected path/hash, nor that their visual
  assembly matches the source. Treat this as runtime/performance evidence only.
- The other 36 sets have no set-specific in-game evidence in this round. A
  production Chrome probe did confirm 10303's intended auto-pick
  (`IOModel2V2/10303.ldr`) and completed UI render of 3,808 bricks in 26.5 s.
  It reported 9 missing pieces across 43753, 80564, and x346, plus 44
  alias-resolved pieces; that is renderer evidence distinct from the board's
  53 grader-unknown placements. The debug-hook route fetch was sandbox-blocked,
  so matrix/explode/export and canvas evidence remain open. Equivalent probes
  for 31141, 71043, and 76286 are still required.

## Highest-value cohorts

1. Include the published 75397 repair in the next controlled board/index refresh;
   do not mistake the unchanged index's 8-defect row for its new 2-defect bytes.
2. Target near-pass figure residue on 76286, 42639, 42663, and 910047. These
   avoid broad source switches and have small, concentrated figure counts.
3. Treat 10354/10365/41703/42652/76435/80049 as v3 polish/alignment work; their
   `disp` or big-float residue is source-side and cannot be repaired by the web
   renderer or voxel contact bridging.
4. Visually triage staged/multi-build selections 76417, 76457, 77092, 60380,
   and 10354 before moving parts. A low `stage` fraction can describe a valid
   alternate build as well as a bad capture.
5. Run the production renderer-missing census on 42172, 75397, 910049, 41395,
   and 10326. Their nonzero grader-unknown counts are not enough to justify
   corpus edits.
