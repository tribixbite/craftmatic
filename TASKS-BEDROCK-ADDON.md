# LEGO model → Bedrock add-on — tracker

This file holds open work and the evidence needed to resume. Completed history
belongs in `git log`, `docs/lego-sources-guide.md`, and
`docs/bedrock-addon-guide.md`. Spec: `docs/bedrock-entity-spec-2026-09-14.md`.

## Active round — 2026-09-21, deployed verification and playable accuracy

User explicitly authorizes pushing and deployed-site verification; wireless
ADB needs no USB or root for pack import. Feature commit `490a5746` and door
elevation follow-up `e25af6e4` were pushed to `origin/main`. Validation commit
`e5a2b936` is pushed through merge `0ab7f1eb` (preserving the scheduled source
refresh); CI `35603541570` and deployment `35603541576` passed. Production creator export
and desktop/mobile browser checks passed; actual Minecraft acceptance is open.
No tags, destructive history rewrite, world deletion, or app-data reset.
Do not promote a model merely because an aggregate metric improves.

Current lanes (serialize staging/commits through the main agent):

- [ ] Verify creator UI, persistence, geometry and lifecycle in Minecraft;
  starter library/runtime/web/CLI implementation is deployed. Owner: `creator`.
- [ ] Verify scaled door replacement and manual seats in Minecraft. Broader
  furniture and custom brick-built openings remain open; 21060 has no detected
  semantic leaf, so do not advertise a 400% working-door preset.
- [ ] Work from the completed 39-set source/freshness audit at
  `docs/set-quality-audit-2026-09-21.md`; rendering/export/in-game coverage is
  separate from the now-confirmed production source hashes.
- [ ] Recover device acceptance over wireless ADB. Only `set_audit` drives
  the phone; repeated shell `error: closed` prevented import. Files was last
  foreground; restore Minecraft when transport permits. Do not restart the
  device/framework or alter existing worlds to work around transport failure.

Current integration gates (offline implementation ready; device acceptance open):

- Creator library/UI/compiler use shared origin `[0,72,0]`, explicit paired
  moulds, optional None and fixed print layers. Actual archive coordinates,
  base-vs-print controllers and requested paired moulds pass regression tests.
  Runtime device acceptance remains open; earlier starter packs are provisional.
- Root owns creator runtime integration: 13 behavior-host tests now exercise
  code colour IDs, strict atomic import, renamed saves, cross-dimension caps,
  cleanup, busy retry, hotbar opening and interrupted-edit reload recovery.
- `door_implementation` owns placement doors/manual seats. Offline
  tests cover actual Bedrock permutations, size recommendation, rotation and
  persisted seat anchors; actual device acceptance remains required.
- Working ADB binary: `C:/Android/Sdk/platform-tools/adb.exe`; wireless serial
  `192.168.0.122:5555`. A missing agent PATH is not a transport failure.
- Current committed pack `output/bedrock-entity-qa/creator-wand-490a5746.mcaddon`
  SHA256 `f9b624e7ca7a3605caf5622e51b540e76303e3aac81e7c8974a2bfe4f28a38b7`:
  459 library cuboids, no unresolved parts; structural validator passes.
  Phone Download now also contains these committed bytes under
  `000-creator-wand-490a5746.mcaddon`, not imported. Recovery briefly restored
  Minecraft then reopened Files for import; transport went offline again.
  Last foreground: Files raw internal storage. Existing worlds/activations untouched.
- Isolated Chrome CDP: `http://127.0.0.1:9227`, last PID 37936; verify before
  reuse. Run `.mjs` probes with Node, not Bun's broken CDP WebSocket path.
  Probe accepts `PROBE_CDP_URL`. A returned exec `session_id` means running.
- Production creator evidence: `output/minifig-browser-check-creator-20260921-prod-diagnostics/`.
  Actual downloaded `Browser.mcaddon` passes archive validation (3 client
  entities, 37 geometries, 66 textures); all 23 diagnostic entities report zero
  unresolved/AABB/print/substitution fallbacks. Backpack code round-trip passes,
  desktop 1400×950 and mobile 390×844 popovers fit. Latest harness passed with
  zero page errors; URL-level logs retain 50 HTTP 404s, 37 HTTP 503s and 67
  aborted requests despite the successful export. Investigate network overhead
  separately; do not claim the site is free of request errors.
- Fresh 39-set audit uses `bestIndexedModel`, not `models[0]`: 11 PASS /
  28 DEFECTIVE. Twelve picks differ from first-entry ordering; the older
  local-index labels are 14 verified / 25 defective, with stale passes on
  10326/42172/910032.
  Production 10303 selected IOModel2V2, rendered 3,808 bricks, and reported
  nine missing pieces across 43753/80564/x346. All 39 production selected files
  returned HTTP 200 and matched graded local SHA256; deployed/local indexes
  also match. Evidence: `selected39-production-freshness.md` under the root below.
- Exact-byte repair evidence under `output/pipeline-2026-09-21/`: 75397
  figures 8→2; 76286 2→1; 76435 3→0; 80049 10→7, other measured metrics
  unchanged. 75397 fixed front/iso/left views and figure closeups are accepted
  (`75397-{before,after}-reviewed/`): detached gold arms/hands are reattached
  with the asymmetric pose preserved. 75397 is now applied locally with exact
  original backup in `75397-apply-backup/`; candidate full SHA256 is
  `b552734a27a762898b9bb7492a1d4b26ac79a0376948259bf7f5c56df4a9e140`.
  One-file `--dry-run --only MecabricksLDR/75397.ldr --no-index` passes.
  Actual R2 upload was blocked by auto-review: request explicit corpus-upload
  approval before retrying. No upload occurred; production/index still name
  original `5cfd6121f256…`. 76286 also passed fixed front/iso/left and closeup
  review (`76286-{before,after}-reviewed/`): only 41879b headwear moves 2.25 LDU
  down, other poses/ship unchanged. Candidate SHA256
  `51faf5b8e717bb01b0b855c20f53b3e9081a160d407c9e587ff0adf43522d5b3`
  is NOT applied. 76435/80049 visual gates remain. 42639/42663 show
  no improvement; 76269 rejected because float rises 45→50 (big 35→40).
- Full board and both legacy A/B jobs completed. Isolated candidate index
  `output/corpus-improvements-2026-09-20/candidate-index.json` was built:
  20,764 entries, 8,936 verified / 11,828 defective; investigate four dropped
  stale grades and ranking changes before adoption. Live index untouched.
- Latest integrated test run: **1,803 passed / 26 skipped**, exit 0, log
  `output/pipeline-2026-09-21/integrated-test.log`. Root/web typechecks and web
  build pass. Agent full runs had four external-service null failures; the
  root rerun passed them without changing those tests. Final affected suite
  55/55 and both typechecks passed. Follow-up fractional door-elevation fix
  has 31 focused tests and both typechecks passing: keep local Y fractional
  until after wand scaling, then quantize in world space.
- Door leaf geometry is separate and retained until its corresponding vanilla
  door is actually installed; support/clearance failure keeps the leaf visible.
  Runtime host covers small→usable→small, rotation, fallback and Undo. 21060
  has no recognized semantic leaf; its 4× terrace is reachable offline, but
  no working interior door or 400% preset is claimed.

Read next: sources guide §6b, §8b–8e, §9, §10; add-on guide's final sections.
Evidence root: `output/corpus-improvements-2026-09-20/`.

- [ ] Visually review exact-byte figure candidates before applying; use the
  completed cohort A/B only for nominations (`corpus-repairs/README.md`).
  Original Mecabricks trial: 1,037 touched, figure defects 3,166→380, but
  per-file overlap/sunk regressions and needless pose changes prohibit broad
  application. Slot-owner instability fixed in clego `bb1adb01`; fresh trials
  are rerun-stable on all 1,020 Mecabricks and 644 DbixV3 touched outputs.
  Window trial: 299 files / 1,985 panes, all rerun-stable. Completed legacy
  A/B nominates 251 window and 345 Mecabricks files, but lacks full hash
  provenance; do not apply from those counts alone. The resumable helper is at
  clego `4d2dbad7` (five focused tests pass): it rehashes queued inputs before
  and after grading, requires an exact checkpoint key and complete finite
  metrics, records only successful pairs, and isolates torn suffixes. A future
  retry must use a **new** output name, which creates
  `<out>.progress.jsonl`, for example from `C:/git/clego` in PowerShell:
  `$env:CLEGO_LDRAW_LIB='upstream'; python -B -u geograde/_ab_dirs.py C:/git/craftmatic/output/corpus-improvements-2026-09-20/corpus-repairs/window-dbixv2-touched.txt C:/git/craftmatic/output/corpus-improvements-2026-09-20/corpus-repairs/trials/window-dbixv2 C:/git/craftmatic/output/corpus-improvements-2026-09-20/corpus-repairs/window-dbixv2-ab-resume.json 2`.
  Substitute the Mecabricks touched list/trial root and a new Mecabricks output
  name for that cohort. Final A/B only nominates candidates; targeted hardened
  regrade and visual review remain required before any corpus apply/publication.
  Accept only improved, nonregressing, pose-reviewed files, with exact backups
  and before/after hashes. No archive recovery on these generated classes.
  `figure-preserve-proof-ab.json` is exploratory (earlier build, limited
  metrics, no hashes), not final v3 acceptance. Regrade provisional candidates
  with complete finite metrics and exact before/after byte provenance.
- [ ] Review the completed upstream board and **candidate** index.
  Board: 20,764 sources; selected sets 5,871 PASS / 4,298 DEFECTIVE,
  zero ERROR. Candidate has four dropped stale grades to investigate.
  Before any rerun inspect process command lines; never create two writers.
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

Eight exact no-op overrides were removed in clego `4d2dbad7`. Isolated
before/after indexes are byte-identical at SHA256
`6553ef921a12a9e8d55e1af0120d0f29712899d8ff32e3cdadcca981841c9fd0`
(10,169 sets / 20,764 entries); candidate summaries are isolated from the live
summary, and the ten conversion-target plus six visual-choice overrides remain.
The focused index tests pass 6/6; the live index and tracked summary were not
changed. Evidence: `overrides/REPORT.md`.

Transient all-candidate-503 subpart recovery is committed (`4a658505`). Offline
fault injection reproduced a partial, non-empty assembled parent that repair
correctly did not re-probe in the same throttle window but then falsely stayed
cached across the next load. The load reset now invalidates the transient child
and assembled ancestors, and the affected load reports the subpart gap. This
proves the mechanism and recovery, not that the historical two lost 10303
instances had this cause—the production trace lacks failed stems/dependencies.

Measured alignment enrichment is committed (`293ea949`): 34 previously
unmeasured rows now have actual-mesh bounds, recursive upstream-before-Studio
resolution retained; 12 additional rows rejected, 1,839/1,839 bounded.
80911 already had a bound and was rejected; the former missing-bound claim
was stale. Controlled LOD pack invariants are covered by `7a2d582d`, not a
device performance acceptance.

Latest completed checks after `4a658505`: `bun run test` exit 0, 1,764 passed /
26 skipped (118 files passed / 1 skipped); both `bun run typecheck` and
`bun run typecheck:web` pass; focused part-cache suite 16/16 passes. Integrated
log: `output/corpus-improvements-2026-09-20/integration/bun-test-after-4a658505.log`.
Combined clego figure/window/reader/index tests 160 passed; publisher 33 passed.
Recheck after concurrent code changes.

## Repository and publication boundaries

Craftmatic began at `741f6700`. Clego refs after fetch were 544 ahead / 249
behind; the older 511-commit/630 MB snapshot-growth
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

Current sole phone owner: `set_audit`. Use ordinary pack import/file-manager
workflow; user notes root is unnecessary and likely unavailable. User approved
`adb root` if needed, but do not treat it as a prerequisite. No reboot/framework
restart/data clear. Back up current world/pack state before any activation;
the restoration report below is historical, not a fresh snapshot.
Current transport blocker: connect succeeds but even a persistent TTY shell
exits 1 with `error: closed` before a prompt. No import/activation occurred.
Files by Google is last known foreground; restore Minecraft when transport
recovers. Root asked user asynchronously about unlock/authorization prompt.

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
- [ ] Missing moulds: 28710, 30426, x346.
- [ ] Mini-dolls are excluded from minifig held-part classification but not rigged.
  76419's microfigure auto-scales 2×, but its four-part torso group is not an NPC.
- [ ] Grader false-positive work: wheel/tyre, hand/weapon, axle/hole encased
  overlaps; inspect pairs before treating the old 52-file overlap tail as bad.
  Deliberate gaps: cone on torso neck and uncalibrated medium-leg band.
- [ ] Creator pack is implemented but not device-accepted. Actual emitted
  geometry/print checks and phone save/load/edit/reload/NPC behavior remain
  release gates; see `docs/minifig-creator-wand.md`.
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
