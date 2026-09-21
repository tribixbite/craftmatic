# LEGO model → Bedrock add-on — tracker

This file holds open work and the evidence needed to resume. Completed history
belongs in `git log`, `docs/lego-sources-guide.md`, and
`docs/bedrock-addon-guide.md`. Spec: `docs/bedrock-entity-spec-2026-09-14.md`.

## Active round — 2026-09-20, user: “do all”

Local implementation and validation only. **No push, R2 publication, tag,
release, or history rewrite is authorized.** Do not promote a model merely
because an aggregate metric improves.

Read next: sources guide §6b, §8b–8e, §9, §10; add-on guide's final sections.
Evidence root: `output/corpus-improvements-2026-09-20/`.

- [ ] Finish corrected figure A/B for MecabricksLDR and DbixConvV3 and window
  A/B for DbixConvV2. Owner: corpus agent; evidence `corpus-repairs/README.md`.
  Original Mecabricks trial: 1,037 touched, figure defects 3,166→380, but
  per-file overlap/sunk regressions and needless pose changes prohibit broad
  application. Slot-owner instability fixed in clego `bb1adb01`; fresh trials
  are rerun-stable on all 1,020 Mecabricks and 644 DbixV3 touched outputs.
  Window trial: 299 files / 1,985 panes, all rerun-stable; full A/B pending.
  Accept only improved, nonregressing, pose-reviewed files, with exact backups
  and before/after hashes. No archive recovery on these generated classes.
  `figure-preserve-proof-ab.json` is exploratory (earlier build, limited
  metrics, no hashes), not final v3 acceptance. Regrade provisional candidates
  with complete finite metrics and exact before/after byte provenance.
- [ ] Finish the complete upstream board and build a **candidate** index.
  Current job: `board/`, logs `board-run.log` and `board-resume.log`;
  20,764 sources, 763 completed rows retained at restart, 16 workers,
  `OPENBLAS_NUM_THREADS=1`. Before restarting, inspect the active process
  command line: never run two writers against this journal.
  After accepted corpus changes, resume grading so content hashes invalidate
  changed rows. From `C:/git/clego`, with `CLEGO_LDRAW_LIB=upstream`:
  `python -B -u geograde/scoreboard.py --full --grade --all-entries --report --workers 16 --out-dir C:/git/craftmatic/output/corpus-improvements-2026-09-20/board`
  then
  `python build_model_index.py --scoreboard C:/git/craftmatic/output/corpus-improvements-2026-09-20/board/scoreboard_full.json --out C:/git/craftmatic/output/corpus-improvements-2026-09-20/candidate-index.json`.
  Inspect errors, missing/stale grades, indexed hash coverage, and pick changes
  before adopting it. Do not fresh-date old measurements.
- [ ] Review eventual publication plan separately. Content-bound receipts,
  immutable upload snapshots, interrupted-tail recovery, preflight receipt
  coverage, and explicit legacy readback migration are implemented. Status has
  20,764 indexed sources, zero content-certified receipts, and 20,704 legacy-only
  paths. `sync_models_r2.py --verify-legacy --dry-run` only lists candidates;
  `--verify-legacy` compares full remote/local SHA256 without any PUT and writes
  observed-readback receipts. All 33 mocked tests pass (`35858706`); no real
  migration/publication run. It does not certify everlasting CDN/origin state.
- [ ] Finish eight exact no-op override removals with isolated byte-identical
  before/after index proof. Owner: MPD agent; `overrides/REPORT.md`.
  Candidate output must not overwrite the shared index or its summary.
  Keep the ten conversion-target and six visual-choice overrides intact.
- [ ] Missing-torso placement remains gated. `beam.build(..., recover_torsos=True)`
  is experimental/default OFF (`85ddc410`). Inventory recovery works, but
  70100 globally reallocates unrelated parts and leaves an exploded figure.
  Controls 31045/75031/8533 retain scores; zero scalar figure defects is not
  acceptance evidence. A post-allocation arm-anchor prototype avoids global
  re-layout but adds sunk hips on 40300. Next: unique opposite-arm pair,
  bounded spacing/support, floor-aware hips/legs, abstain on ambiguity, wider
  visual A/B. Evidence `torso-reader/`, `torso-reader-final/`,
  `torso-reader-local-anchor/`. No trial reader model promoted.
- [ ] Reconcile final evidence, rerun affected checks, update guides, and commit
  own changes. Preserve user-owned dirty files below.

Implemented locally: window gate ≥2 and all-alternative grading
(`e5f20b21`), per-row time/SHA256 index freshness (`7d74c064`), MPD-local
repairs (`f540c89b`), strict publisher/race/hash checks (`c8bd5ce6`,
`d7e52f0a`, `60076051`). MPD 40746 accepted on disk: figure 10→6,
window 1→0, other metrics unchanged; source SHA256
`b1fafa93b2a2c7216b5c138988d6521af600a9bddb72c22a33ab9a343ef2dce2`.
40809 remains evidence-only because floating parts rise 10→11; see `mpd/`.
MPD repair is section-local, not cross-submodel matching; repeated definitions
also preclude archive inventory recovery.

Measured alignment enrichment is committed (`293ea949`): 34 previously
unmeasured rows now have actual-mesh bounds, recursive upstream-before-Studio
resolution retained; 12 additional rows rejected, 1,839/1,839 bounded.
80911 already had a bound and was rejected; the former missing-bound claim
was stale. Controlled LOD pack invariants are covered by `7a2d582d`, not a
device performance acceptance.

Latest completed checks: both TypeScript checks pass; Vitest 1,763 passed /
26 skipped (118 files passed / 1 skipped); combined clego figure/window/reader/
index tests 160 passed; publisher 33 passed. Full integrated rerun log:
`craftmatic-tests-integrated.log`. Recheck after concurrent code changes.

## Repository and publication boundaries

Craftmatic began at `741f6700`. Clego refs were 523 ahead / 249 behind at
assessment (not freshly fetched); the older 511-commit/630 MB snapshot-growth
figure is historical. Ask before rewriting history. Do not recommit large
scoreboard/index snapshots; this round's board is isolated under output.
The full grade journal and `scoreboard_extra.json` are inputs, not disposable
reports. Before untracking snapshots, provide checksum-backed recovery and
prove a clean-clone rebuild with all consumers. Preserve the curated
`lego_sets/ReconV8/_indexed.json` allow-list; no untracking occurred this round.

Five pre-existing dirty clego files are NOT owned by this round:
`mecabricks_align.json`, `geograde/mb_fix_report.json`,
`geograde/mb_fix_report_MecabricksSearchLDR.json`,
`discovery/eb_ldd_sample_grades.json`, `recon_v7_work/pdfpick_cache.json`.
Never stage them with feature work. `lego_sets/` is ignored: preserve local
byte snapshots; do not force-add the corpus. No local corpus apply is live
until separately authorized publication.

Last recorded deployed index: `64c4746eb7e7`, 9,066 verified / 11,698
defective entries, 5,652 verified primaries, zero ungraded. These are historical
pre-round measurements, not the result of the running board. Previous window
republishing and beam wiring are complete; do not repeat stale §9.8 commands.

Sandbox shell startup fails `CreateProcessWithLogonW failed: 2`; scoped elevated
PowerShell works. Use explicit shell and `login:false`.

## Device work — state restored

Pixel `192.168.0.122:5555`; Minecraft 1.26.51. Latest report:
`output/corpus-improvements-2026-09-20/device/REPORT.md`.
World 919's original three pack versions and blank's original h0.95 version
were byte/SHA256-restored; test actors removed with a coordinate-bounded
selector, camera cleared, player returned to 826/−60/87, app at Play/Worlds.

- [ ] Controlled crowded LOD A/B: three roots 20–25 blocks from camera measured
  near/full p90 33.40 ms versus far/hull 16.74 ms (62 frames each). Moving the
  camera changes screen coverage, so this is a transition observation, not an
  isolated LOD effect. Repeat full/hull with identical actors/camera and longer
  alternating samples. Active definitions 80,210; drawn 71,884 versus 3,160.
  Existing `--lod=hull --lod-distance=1024` versus `--lod-distance=1` isolates
  the representation at one near camera while keeping resident geometry equal;
  pack invariant test and version-selection recipe are in the add-on guide.
- [ ] Chalet roaming: old h1.8 control 0/7 versus h0.95 1/7. New dwell trial
  aborted before world load due repeated ADB chat-input drops. Keep seated
  figures 4/5/6 out of the walker denominator; census walkers 1/2/3/7 for ≥10 min.
  Test local clearance before changing global height. Walkers have floor
  support but ceilings/head-cell colliders; an actor moved to open grass walks.
  Alternative: nearest navigable porch/garden cell. Blank still intentionally
  has its restored h0.95 pack; deactivate it explicitly for a future clean test.
- [ ] 76435 detached roofline objects at 400%: distinguish source extras from
  polished/parked parts. Source is exploded (42 clusters); IO/76435.io has
  70 clusters and no IOModel2V2 replacement exists.
- [ ] Remove only the confirmed obsolete inactive pack folders via file manager
  when approved/identifiable: 3 round + 14 ceiling + WinterChal(1),
  Titanic102(1), Colosseum1(1), TajMahal10(1) were recorded previously.
  Inventory again before removal; some counts may overlap. ADB removal was
  denied. Do not remove active packs or user worlds.
- [ ] Device visuals for 71043/76435 source repairs; pack archive checks do not
  establish rendered content quality. Dense 71043/31201 exports need Ultra detail.
- [ ] Human/device input gates: look-down dive under chase camera; joystick
  steering; X-wing walk cycle / first-person cockpit; sitting thigh sign;
  doors/lights omitted at 200% confirmed only by dialog text; door tapping
  (1/7) and museum “no room within three blocks”; figure home/edge restraint.
  ADB look swipes did not work, /rotate absent, /tp dismounts riders.
  Historical single-pointer/SELinux findings may differ on the now-rooted phone.

## Other corpus and renderer backlog

- [ ] Remaining figure residue after this round: HuntArchiveLDR (52 picks,
  25 affected; old mean 13.4 defects/affected pick), decorated Mecabricks torsos
  (47 unresolved refs / 256 placements in 55/2,002 arm-bearing files), and
  posed wrists. Map decorated 973j/973aq identities without misclassifying 2550
  monkey body; do not canonicalize intentional arm poses.
- [ ] Windows: hand-authored EurobricksLDR (8 off-frame placements / 1 of 43
  picks) needs explicit policy/visual review; .io requires an archive/client
  path; cross-submodel MPD pairs unsupported. Fix DBIX's wrong learned constant
  offsets upstream so regeneration cannot undo a seating pass.
- [ ] Override hygiene: re-audit eight formerly no-op rows and ten conv:1
  targets against the candidate index and actual frontend ranking before
  removing them. Six near-identical visual calls remain reviewable:
  71425, 71441, 71481, 72035, 80117, 72045; 71439/71440 were rejected.
  Evidence `clego/geograde/rerank_visual_2026-09-20.json`.
- [ ] `io_part_count` inflation demotes authentic .io in 390/406 sets. Do NOT
  fix the count alone: model.ldr's bl_* refs and Studio's omitted
  !LDRAW_ORG Unofficial_Part header still need renderer support.
- [ ] Class-B residual: 108 different stems / 4,795 placements need actual
  geometry aliases. Exact reframes already browser-verified (60118:6,
  21061:80), not merely unit-tested.
- [ ] Four rotation abstentions: 35186×81, 4526×14, 35473×5, 5443×2.
  Strict LXF cohort remains ~41% Technic / ~65% System; flex synthesis and
  equivalent-pose scoring are open (`output/lxf-gt/strict-hybrid_xml_first.json`).
- [ ] Upstream 503 can still lose parts (10303 once 3,814 instead of 3,816);
  see testing guide TODO. Missing moulds: 28710, 30426, x346.
- [ ] Mini-dolls are excluded from minifig held-part classification but not rigged.
  76419's microfigure auto-scales 2×, but its four-part torso group is not an NPC.
- [ ] Grader false-positive work: wheel/tyre, hand/weapon, axle/hole encased
  overlaps; inspect pairs before treating the old 52-file overlap tail as bad.
  Deliberate gaps: cone on torso neck and uncalibrated medium-leg band.
- [ ] Minifig creator wand: designed, not built. See
  `docs/minifig-creator-wand.md`; types are unconsumed; plan steps 4/6 need device.
- [ ] Source compact-layout quality flag: staged DBIX instruction layouts can
  remain spread despite arm repair; proposed density threshold ~0.3 parts/stud²
  needs validation, not automatic promotion.
- [ ] World-block mirror (x,y,z → x,−y,z) is a separate explicit decision: changing
  it changes every schematic. Entity frame −I currently matches that grid.
- [ ] Beds/brick-built chairs undetected; door sizing/straddled-cell duplication
  and <¾-scale leaf height; 910047 sparse fill 17%; repeated-part budget
  (76240 70695×184); Tumbler 32-LDU grain reads 14.5 wide versus 11.5 true;
  figure hair/stud height 2.03 blocks; unused _chase/_boom presets.
- [ ] Retain rollback snapshots until trusted, including the 41 MB pre-window
  `clego/geograde/_window_round/before_bytes/`; do not delete during validation.

## Closed architectural routes — do not reopen without new evidence

Entity-per-part instancing and a resident master part library are NO-GO;
Bedrock actor overhead (31–48 kB each), lack of geometry-instance transforms,
and multi-placement-per-block occupancy defeat them. Detailed corrections and
measurements are in the add-on guide, not a proposal to repeat these trials.
Cuboid merging has only 0.1% left; textures ≤0.85 MB; chunk overhead 2.6%.
split0 union repair creates false positives on authentic .io.
Measured device guardrails: resident ceiling 487,856 (budget 480k), roughly
50–100k visible cuboids for 60fps / 150k for 30fps; 6,000 entities leaked 142 MB.
Culling 100–400%, collider clear, and Milano grounding 100/200/400% are verified.

## Hard rules and entry points

1. No whole-model voxelization or poly_mesh on the entity path.
2. getPartDims only as an explicit, diagnosed AABB fallback.
3. No Minecraft block colours on the entity path.
4. Diagnose every part/print/transparency/pose/cluster/figure/door degradation.
5. Do not change world blocks, rideability, DeLorean behavior, or BlockGrid fallback
   to fix entity rendering.
6. Compile each unique part once; instance it; preserve exact source transforms.

Chain: lego.ts → schem-export.ts scale plan → schem-pipeline worker →
playable-components / bedrock-scene-actors → playable-addon →
placement assets/colliders. CLI:
`bun scripts/_playable_ref.ts <model> [out] --label=… [--quality=…] [--main-only] [--buildings=bricks|blocks] [--scale=auto|0.25..4]`;
`bun scripts/_minifig_ref.ts --label=Knight --torso=973:4 …`;
`python scripts/lxf_gt_eval.py --all --variants shipped`.
Use a vehicle-readable label (“X-wing Starfighter 7140”, not “XWing 7140”).
