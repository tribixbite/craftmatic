# LEGO model → Bedrock add-on — tracker

This file holds open work and the evidence needed to resume. Completed history
belongs in `git log`, `docs/lego-sources-guide.md`, and
`docs/bedrock-addon-guide.md`. Spec: `docs/bedrock-entity-spec-2026-09-14.md`.

## Active round — 2026-09-21 evening, USER-REPORTED VISUAL REGRESSION (10303)

The user placed 10303 on the Pixel 8 Pro from
`output/bedrock-entity-qa/10303-coaster-idfix-20260921.mcaddon` and rejected the
result: "the visual quality of the model looks horrendous and is unacceptable -
even up close… once the player is moved a dozen or so individual blocks away…
the visual quality goes from horrendous to deplorable - and on top of that the
surfaces jitter between different colors in a seizure-inducing spasm."
Their own screenshots are the evidence, pulled and downscaled to
`output/bedrock-entity-qa/user-report-20260921/u-*.png` (raw beside them):

- `u-183012` (player -17,82,95), `u-183028` (-20,82,92), `u-183034` (-19,82,93)
  and `u-183927` (-27,64,49, point blank): the model draws as a coarse blocky
  BLOB — the LOD hull — with heavy diagonal hatching on the surfaces.
- `u-183050` (-33,85,78): the SAME model in full crisp detail.
  So the hull is taking over at close range, and the hatching is two coplanar
  surfaces fighting for depth. `query.distance_from_camera` measures to the
  ENTITY, and the shell is ONE entity spanning ~42x44x21 blocks, so a camera
  standing at the geometry is easily >32 (`DEFAULT_LOD_DISTANCE`) from its
  origin. Working hypothesis, being verified: the threshold must include the
  model's bounding radius and the base default must be far larger, and
  per-colour hull cells may claim the same face.
- `u-183050`/`u-183028` also show the figure defects: two riders stand bolt
  UPRIGHT and FLOAT beside the near-vertical drop car, and hair pieces hang
  detached above their heads.

Open, all three in flight:
- [x] **LOD fixed (`eba9b515`).** `query.distance_from_camera` measures to the
  entity ROOT, and a shell's root sits ABOVE the model (`originAboveModel`),
  45 blocks over 10303's ground track: 68.7 % of the skin (2,190 of 3,189
  cells) was already past the 32-block threshold, so a ground camera saw the
  hull at ANY distance. The switch is now `lodDistance + the entity's reach
  from its root` and the default is 96 (at 70 degrees FOV a brick face is
  3.75 px there); 10303 switches at 146.3. The shimmer was 1,523 of 3,189 hull
  cells carrying a cube from 2-9 colours at once; a cell now belongs to the
  colour with the most volume in it — every cell single-owner, hull 1,143 ->
  753 cuboids. Not device-verified yet.
- [x] **Figures fixed (`4c032ce6`).** The source riders ARE seated 90 degrees
  nose-down (matrix `0 -1 0 / 0 0 -1 / 1 0 0`). A figure tilted past 30 degrees
  now stays whole in the model at its source pose; the floor comes from body
  parts only (hanging hands no longer set it); cluster membership is measured
  in the torso's frame so legs are not left behind and re-synthesised; and
  BrickLink-form descriptions plus head-origin adoption keep 43753 hair on its
  head. 10303 ships 8 NPCs instead of 11 and the shell regains 20 rider parts.
  Open follow-up in `bedrock-coaster.ts`: seating those posed riders ON the
  cart (figure family + extra seats) would make them live along the track.
- [ ] **Close-up fidelity — the user's headline complaint, still open.** The CLI
  AND web default is `balanced`: 8 LDU microcell, 64 cubes/part, 13,936 shell
  cuboids for 10303 = 3.5 % of the 480k device ceiling. `ultra` is 4 LDU /
  256 cubes = 47,726 shell, 54,481 pack, 11.4 %, and 8 such packs still fit.
  **`high` is broken**: it asks for 4 LDU but its own 32,768 `maxModelCubes`
  cap forces a fallback to 8, so it buys almost nothing. There is NO budget
  clamp in `playable-addon.ts` (`packCuboidBudget` only warns at >=10 %), so
  nothing vetoes a finer mesh; the dial is `LEGO_SHELL_QUALITY` in
  `bedrock-building-shell.ts`. Separate DRAW limit: ~50-100k visible for
  60 fps, ~150k for 30 fps. User's bar: "drastically" better.
- [ ] Ride behaviour the user asked for: continuous motion with or without a
  rider, real gravity (crawl uphill, fast on the drop), a dwell at the flat
  reload station, and mounting by walking up and tapping — today the cart is
  unreachable inside the shell and device QA had to board with `/ride`.
  Owner: coaster.

Acceptance is a fresh device round with the user's own bar, not unit tests.

**Device state changed 2026-09-21 evening: the user deleted every behavior and
resource pack except the base Craftmatic one and created a new FLAT BLANK world
called `921`.** That is the clean test bed — the duplicate-UUID folder trap is
gone, so a fresh import should resolve correctly. Do not assume the old
`CoasterQA` world or its packs still exist.

Further user requirements from the same round:
- [ ] Auto-scale RECOMMENDATION per model, measured not themed: architecture and
  Icon sets are micro-scale and must be scaled up to be walkable. The bar is
  that a player (0.6 x 1.8 blocks) can pass the model's doorways and stand under
  its floors; the UI should say why ("doorways are 0.4 blocks at 100 %; 300 %
  makes them 1.2"). Manual override always remains. Owner: scale-recommendation.
- [ ] **A minifig must never become a giant.** The wand's 25-400 % steps scale
  every entity today; a FIGURE must stay player-sized at any model size, while
  buildings and vehicles keep scaling — without sinking figures through floors
  or out of vehicle seats. Owner: scale-cap.
- [ ] Suspected bug: no up/down movement inside a scaled-up model, because a
  height is computed from the unscaled 1x grid. History: `e168bd49` (scaled
  placements kept their old walls) and `e25af6e4` (keep local Y fractional until
  after wand scaling, then quantize in world space). Must be reproduced or
  disproved with a real placement at 200/400 %, not read off the code.
  Owner: scale-cap.
- [ ] Three-car train: make the cart three single-seat vehicles instead of one.
  This dissolves the "no per-seat family restriction" blocker (each car carries
  its own component-level family) and matches the source, whose three rider
  clusters sit 120 LDU apart. Under evaluation by the coaster owner.
- [ ] Pack PROVENANCE stamp: every pack should say which export-pipeline build
  and which source model produced it, so a pack on the phone can be identified
  without reading `manifest.json` by hand (a device round was already lost to a
  stale folder). NOTE the trap: git does not preserve mtimes, so a
  "last modified" stamp differs per clone and in CI — the reproducible
  equivalent is the last pipeline COMMIT's date/sha, or a content hash over the
  engine sources. The web app builds packs in the BROWSER (no git, no fs), so
  anything git-derived must be injected at build time with an honest fallback,
  and the Bedrock `version` must stay `[int,int,int]` and MONOTONIC or the
  stale-folder confusion returns. Owner: provenance.
- The source minifigs do NOT need to ride the coaster; they now stay posed in
  the model geometry, which is already correct.

## Active round — 2026-09-21, 10303 track repair and ride mechanism

User asks to visually inspect/fix 10303's missing track and implement reusable
rideable coasters. Root inspected the actual production closeups under
`output/pipeline-2026-09-21/10303-prod-track-diagnosis/`: six `80564` loop-quarter
placements are invisible. Exact geometry exists inside `IO/10303.io`'s
`model2.ldr` but the `IOModel2V2` conversion discarded the embedded definitions.
Hair `43753` ×1 and tooth `x346` ×2 were ALSO fixed by that same parser change,
not just the six `80564`s: all three are embedded-definition ids, and a fresh
measured run of the repaired source reports `unresolvedParts: []` for all 12
entities (shell 3710 source / 302 unique / 302 resolved, `embeddedParts: 3`),
with neither id among the 10 sibling-mould substitutions. Evidence
`output/bedrock-entity-qa/10303-before.log`. `x346` remains absent from the
LDraw library for OTHER sets that do not embed it (~450 references).

Viewer parser repair: Studio DATs explicitly marked `IsSubModel False` and
`IsAssembly False` remain terminal meshes; official Part/Subpart definitions
do too, while shortcuts still expand. Studio inherited colour `-1` normalizes
to LDraw `16` for geometry and nested placements. Parser/mesh regressions pass.
Final golden-colour render accepted: 3808 placements, zero missing parts,
both loops closed. Evidence: `10303-embedded-preserve-final/` under the round
output directory. Parser commit `caff7cff` is deployed; CI `35630253885` and
deployment `35630254112` passed. Converter commit `922de02c` is local to clego
(do not push its divergent master). Its 4 tests pass; unsafe embedded child
frames are rejected instead of substituted.

The repaired source is applied locally AND published at `IOModel2V2/10303.ldr`,
SHA256 `df3b47c3c9f27623eaa1d8ab40fdf9a0938035cab5d5ffdaac20b55f31676b38`;
original exact backup: `output/pipeline-2026-09-21/10303-apply-backup/10303.ldr`,
pre-repair SHA256 `b51c0b67042cc31a0dbf371f3bf1d48ddbd40b308d1f5b6e2b616785a2b10656`.
The user has since granted STANDING approval for public R2 publication and for
index corrections, so a future single-file repair no longer waits on an ask —
but still publish scoped (`--only <path>`), verify by plain-URL readback against
the full SHA256, and keep the index diff to the entries you actually changed.

Measured profiles and rendered overlays now agree: 42 placed moulds become
41 fragments (one opposed vertical 25061 pair), 34 joins, components
`[29,7,1,1,1,1,1]`, zero ambiguous endpoints. Exactly one automatic ride route
is emitted: 29 fragments, 1066 points, 9327.185 LDU, including all six 80564s.
The seven-piece vertical guide and five isolated decorative tracks are withheld.
Evidence: `output/pipeline-2026-09-21/10303-route-overlay-visual-corrected/`.
The apparent 45.25-LDU ramp gap was a sleeper-origin error: actual rail ends
meet within 0.0385 LDU. Nine-cuboid cart overlays show wheel contact on flat and
loop track; parallel-transport frames animate cart pitch/roll, not player roll.

- [x] **Actual mounted movement, rider retention and Undo: PROVED on the
  device (Pixel 8 Pro, Bedrock 1.26.51, 2026-09-21).** A mounted rider traversed
  the 10-block measured route, reversed at BOTH open ends, stayed on the cart
  for 60+ s and dismounted cleanly; Undo removed the placement. Coordinates at
  16:26:57 `-5,64,-34` -> 16:27:11 `5,64,-34` -> 16:27:34 `-4,64,-34` ->
  16:28:00 `1,64,-34`. Evidence `output/bedrock-entity-qa/coaster-float-*`
  (`ride-t0/t5/t15/t20`, `159-dismountconfirm`, `161-undotap`), device backups
  with SHA256 under `device-backups/`.
  Root cause of the earlier stall, captured from the device CONTENT LOG (nothing
  about it reaches logcat): float actor properties serialized as integer
  literals, so Bedrock rejected them and dropped the cart's whole property
  component. Fixed in `0a3f6c9a`/`c4cab387`; see the add-on guide.
  Measured before/after in one continuous log: `[Actor][error]` 6 -> 9 while
  broken (3 per load), then ZERO new after the fixed pack went live;
  `query.property called on an actor without a property component` 348,797 lines
  at ~60/s for two hours, then ZERO new. **Use `grep -cE '\[Molang\]\[error\]'`
  as the pass/fail gate for future device rounds** — it catches the whole class
  (dropped property component, typo'd property, property queried on the wrong
  entity) in one number, and a clean pack reads 0.
- [ ] **Device pack UPGRADES need the active folder overwritten, not a version
  pin.** Three folders shared one pack UUID (`CoasterQA—`, `—(1)`, `—(2)` at
  versions 11111/17308/19240) and Bedrock resolved the world to the folder its
  own store already associated with that UUID: hand-editing
  `world_behavior_packs.json`/`world_resource_packs.json` was silently reverted
  on load, "Technical details" still showed 2.695.11111, and a reload produced 3
  FRESH `[Actor][error]` lines citing the old path. What worked: confirm the old
  and new folders have identical file lists, back up all 40 files with SHA256,
  then `cp` the new content over the ACTIVE folder in place and verify by
  `md5sum`. Open work: stop shipping duplicate-UUID installs — either clean up
  the stale folders (file manager; ADB removal is denied) or give QA packs a
  per-build UUID so versions can coexist.
- [x] **Lift/transfer semantics: MEASURED, and the withhold is correct.** The
  main course's open ends and the seven-piece `25059` vertical guide's ends were
  measured in model LDU: closest pairing `80566:33:end` <-> `25059:23:start` is
  **389.74 LDU (19.49 blocks)** with tangentDot **-0.017**; the next three are
  404.85 / 450.31 / 451.26 LDU, all with |tangentDot| <= 0.12. The joiner
  requires <= 3 LDU and tangentDot >= 0.97 (`COASTER_TRACK_ENDPOINT_TOLERANCE_LDU`,
  `stitchCoasterTrackFragments`), so every candidate misses distance by 130-700x
  and tangent by ~1.0. This is a real physical gap (the guide sits at x=-578,
  z=-260 against course ends at x=-382/-782, z=-580), not the 32-LDU
  sleeper-datum artifact. The open route is therefore correct and shuttles.
  Any lift would be an AUTHORED transfer mechanism, a separate decision: never
  bridge it with invented rail.
- [x] **Repaired 10303 source PUBLISHED (user-approved, 2026-09-21).**
  `python sync_models_r2.py --only IOModel2V2/10303.ldr --no-index` returned
  `ok=1 fail=0`; plain-URL readback of
  `https://craftmatic.click/lego-models/IOModel2V2/10303.ldr` returns 818,156
  bytes at SHA256 `df3b47c3…` (the repaired file), confirmed twice. The index
  entry was patched surgically — production before/after differ by **12 bytes**,
  one field: `sets[10303].models[1].hash` `b51c0b67042c` -> `df3b47c3c9f2`; set
  count and every other entry unchanged. The gated publisher path refuses while
  unrelated local WIP files differ from their index hashes, so the index went
  through the publisher's own `_put_stable_file` primitive on that one key.
  `web/public/lego-models-index.json` carries the same patch.
  **Production served the pre-repair source until this point** (18 placements
  across 10 primitive ids were absent), so earlier "zero missing parts" claims
  were about the LOCAL file only.

Current real pack: `output/bedrock-entity-qa/10303-coaster-floatprops-20260921.mcaddon`,
SHA256 `151244ed3b564a39e94188232ed2f0422788347485727aafc87a58dd7c408131`,
304171 bytes, version `[2,695,19507]`, rebuilt from the repaired local source
`C:/git/clego/lego_sets/IOModel2V2/10303.ldr` (SHA256 `df3b47c3…`) with
`bun scripts/_playable_ref.ts <that source> <out> --label="10303-Loop-Coaster"`.
Archive validation passes with the same shape as before (15 clients, 114
geometries, 129 textures), same BP uuid `f868c24d-…`, same 16,904 cuboids and
the same single 1066-sample 174.885-block open route; an archive-wide file diff
against the superseded `10303-coaster-measured-final.mcaddon` (SHA256
`466ae9fd…`, which carries the integer-literal defect) shows ONLY the float
literals, the two added stage names and the version. Earlier fragmented-route
packs are superseded.
**The REAL 10303 ride is DEVICE-PROVED (2026-09-21, after a second defect).**
That run first found that Bedrock refuses an entity identifier beginning with a
digit, so the cart never existed (`1 entity could not be spawned`); fixed in
`90e70b40` — see the add-on guide. Retest pack
`output/bedrock-entity-qa/10303-coaster-idfix-20260921.mcaddon`, SHA256
`bd5af9ede4be6f574c1a0d83f7742da4f5cd1a5cac059fb0ecaececc12cb1332`,
version `[2,695,26652]`. Measured on the phone:
  * log gate CLEAN over the whole session (17:34:18-17:53:16, 135,168 bytes):
    `[Actor][error]` 0, `[Molang][error]` 0, `[Scripting][error]` 0; the game
    logged `PackId [f868c24d-…_2.695.26652]`, i.e. the fixed build;
  * the cart spawned (`/testfor` -> "Found Track 1 Ride Cart"), placement
    reported no unspawnable entity;
  * **shuttle reversal proven**: a 34-frame 1.4 s trace climbs (1,68,-2) ->
    (-16,94) -> dwells two frames at (-22,100,-9) -> retraces to (10,70);
  * climbs y 66 -> 100 on a build spanning y 63-107, i.e. it reaches the lift top;
  * **rider retained 377 s** (6 min 17 s) with the action bar unbroken, and zero
    `paused`/`not loaded` lines in the log;
  * Undo removed both cart and shell (`/testfor` matches neither afterwards).
  Evidence: `output/bedrock-entity-qa/shots-10303/` (b26, b36, b41-b44, b47-b51)
  and `coaster-10303-ContentLog-idfix-2026-09-21_17-33-45.txt`.
- [ ] **Cart pitch/roll through the loop is STILL UNVERIFIED.** The position
  trace follows the loop, but whether the cart MODEL tilts was never seen: the
  chase camera clips inside the shell and an unmounted cart does not move, so
  there is no side-on view. Needs a spectator/free-camera pass
  (`/camera @s set minecraft:free` — `/tp` from height falls) or a smaller test
  build where the track is exposed. Wheel-to-rail contact is likewise an
  observation from the ride camera, not a proof.
- [ ] **The ride cart cannot be BOARDED BY TOUCH on a dense set.** It sits deep
  inside the shell geometry with no reachable interact prompt; the device run
  boarded with `/ride @s start_riding @e[type=…,c=1]`, which exercised the ride
  runtime but NOT the documented "interact to ride" path a player would use.
  Decide the fix: place the cart at an exposed station point, or give the wand
  a "board the ride" action. The pack README currently promises interaction.

Current offline gates: full suite **1868 passed / 29 skipped, exit 0**
(`output/bedrock-entity-qa/final-round-tests.log`), both typechecks and the
production web build pass (`final-round-build.log`). Earlier partial runs are
superseded. The float guards were confirmed by reintroducing the integer
literal; the helper refactor leaves the emitted entity bytes identical.
Commits `13a65adf`, `00e83471` and earlier are pushed and deployed. CI
`35641616290` failed initially and on one rerun only at live MRLC canopy
assertions (`test/import-nlcd.test.ts`, service returned null); 1839 passed,
36 skipped and both typechecks passed. Do not describe that CI run as green.
Fresh production local-upload render/export passed:
`output/pipeline-2026-09-21/10303-production-final-13a65adf-render/` has 3808
source bricks and zero missing parts; sibling `-export/10303.mcaddon` is
289772 bytes, SHA256 `22b83419288888fadb9031add4f518a037824cb036022dd49e9f58349e964047`.
It contains one open 1066-point route (174.884724 blocks), nine cart cuboids,
zero unresolved source parts, and no browser page errors. Public source is
still unchanged pending the exact approval above.
Foundation commit `3d445a9d` is deployed (CI `35631850545`, deploy `35631850715`
passed); production repaired-source local-upload render has zero missing parts
and its export includes the previously missing shared manual-seat assets.
Root alone stages/commits; unrelated corpus files and `output/pdf-*` stay untouched.

## Prior round — deployed verification and playable accuracy

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
- [ ] Recover device acceptance over wireless ADB. Creator import is verified
  (2026-09-21): with Minecraft foreground, the explicit content-URI VIEW
  command below created fresh `Creator—Pl` behavior/resource folders at 12:58.
  Their manifests identify `Creator — Playable` and matching UUIDs
  `6cfa2e48-350d-478d-8fb0-4713d9c5ac9f` /
  `94bd65f4-7693-4e29-9fd6-5d39fbe6abdd`, version `[2,694,28785]`.
  No world was opened or changed. Activation and in-world acceptance remain
  open; do not restart the device/framework or alter existing worlds.

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
  `000-creator-wand-490a5746.mcaddon`. Verified import command (with Minecraft
  foreground): `C:/Android/Sdk/platform-tools/adb.exe -s 192.168.0.122:5555
  shell am start -n com.mojang.minecraftpe/.MainActivity -a
  android.intent.action.VIEW -d
  content://com.android.externalstorage.documents/document/primary%3ADownload%2F000-creator-wand-490a5746.mcaddon
  -t application/octet-stream --grant-read-uri-permission`. Android reports
  delivery to the existing top-most Minecraft activity; verify installed pack
  folders/manifests, rather than treating that exit code alone as success.
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
  with the asymmetric pose preserved. 75397 is now applied and published with exact
  original backup in `75397-apply-backup/`; candidate full SHA256 is
  `b552734a27a762898b9bb7492a1d4b26ac79a0376948259bf7f5c56df4a9e140`.
  User explicitly approved the single public R2 replacement. Scoped publisher
  `--only MecabricksLDR/75397.ldr --no-index` returned `ok=1 fail=0`; canonical
  live GET matches the full repaired SHA (`75397-cdn-readback.ldr`). Production
  index is byte-unchanged at `64c4746e…9191a` (`75397-postpublish-index.json`),
  intentionally retaining the old hash/8-defect warning until controlled index
  regeneration/publication. Production browser load passes (3,973 bricks;
  same-origin browser fetch matches exact SHA and repair marker), evidence
  `75397-prod-postpublish-20260921/`. Viewer correctly warns about the stale
  index hash; this warning is expected, not a failed model load.
  76286 also passed fixed front/iso/left and closeup
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
- [x] Missing moulds, researched 2026-09-21: **`x346` is now mapped to `41669`**
  (LEGO internal design id vs LDraw's number; the mesh 10303 embeds is
  byte-identical to `41669.dat`), covering ~450 placements in ~92 corpus files.
  `28710` has no BrickLink or LDraw catalogue entry at all and its only corpus
  use is ONE placement in 76286 replicated across five pipeline-stage copies —
  reads like a stray token, not a mould. `30426` is a cloth/cape element
  (Rebrickable calls it "Special Mantle"), 22 refs across ~20 distinct sets,
  almost all under `_MecabricksLDR_prev/`; LDraw ships no rigid equivalent, so
  it stays unmapped rather than guessed. Do not invent geometry for either.
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
