# LEGO model → Bedrock add-on — tracker

Open work and the evidence a decision still needs. **Prune, don't append**:
delete what is done; history lives in `git log` and the guides
(`docs/bedrock-addon-guide.md`, `docs/bedrock-interactivity.md`,
`docs/physics-architecture.md`, `docs/lego-sources-guide.md`,
`docs/testing-guide.md`). Spec: `docs/bedrock-entity-spec-2026-09-14.md`.
Parallel agents append ONE section each at the end of this file.

## Start here

| surface | command | URL |
|---|---|---|
| Web app (LEGO tab, viewer, **Walk add-on**) | `bun dev:web --host` | http://localhost:4000 |
| Operator console (every runnable operation) | `bun run console` | http://localhost:4600 |

A killed background server does NOT free its port (children re-parent):
`netstat -ano | grep LISTENING | grep -E ':(4000|4600)'`, kill the owner PID
before restarting. Neither surface proves Bedrock rendering, culling, form
text or ride physics — those stay on the device.

Gates before any pack round: `bun run typecheck`, `bun run typecheck:web`,
`bun run test`, `python scripts/_mcaddon_check.py <pack>`,
`bun scripts/_favorites_export_sweep.ts --out output/<new dir>`,
`bun scripts/_ix_passability.ts <dir>/*.mcaddon --sizes=100,150,200,300,400 --rotations=0,90`
(0 FAIL). Build packs ONE AT A TIME from a COMMITTED tree with the round's
labels (the uuid follows the label; recipe `output/device-round-2026-09-26c/build.sh`
in the polish worktree, labels in `C:/git/craftmatic/output/device-round-2026-09-26b/new-manifests.txt`).

## Phones

- **Pixel 8 Pro** (`adb devices -l`; mDNS serial `adb-39141FDJG007G5-…`,
  lock `C:/git/craftmatic/output/.phone-lock`), Minecraft 26.51, not rooted:
  world **924** (QA, import mode), **cmgametest** (GameTest; runner
  `output/gametest-0926/_gt_device_run.py <set>…` in the polish worktree).
- **Saga** (`192.168.1.243:5555`, rooted, lock `C:/git/craftmatic/output/.saga-lock`),
  Minecraft 26.52: world **925** (root dev mode). **NEVER `stop`/`start`,
  `setprop ctl.restart` or any framework restart; no reboot; no clearing app
  data** (either phone). Taps: long press, `input swipe x y x y 300`.
- Deploy: `python -u scripts/_pixel_dev_deploy.py <world> <packs…> [--serial S]
  [--exclusive] [--prune-stale]`. `--exclusive` only with the FULL round
  list. `--prune-stale` (dev mode, i.e. the Saga) lists the files a replaced
  dev folder holds that the new build does not ship into the backup dir, then
  `rm`s each one and `rmdir`s emptied dirs — never recursive.
- Cleaned 2026-09-26 (lists: `output/phone-cleanup-0926/` in the polish
  worktree): Pixel 287 files (imported `.mcaddon` copies in Download, our
  recordings in Download and Movies, UI dumps and screenshots); Saga 44,706
  files (14 `/data/local/tmp/craftmatic-deploy-*` staging dirs, 18 stale
  LOD/`fig8` files in the dev packs, 4 recordings). Left on purpose: the
  Pixel's `screen-2026*.mp4` (Android's recorder; may be the user's), web-app
  downloads (`*-1_*.mcaddon`, `.mcpack`, `.schem`), `Download/craftmatic-pack-backup-0924/`
  (empty folders), older imported pack folders under `behavior_packs`
  (adb cannot delete there without root); another agent's staging dir in use.
- Second pass (after round 26c): Pixel 20 more `000-*.mcaddon` imports; Saga
  16,277 files in 6 staging dirs (4 left by the creator-wand agent, 2 of this
  round). `/data/local/tmp` holds no `craftmatic-deploy-*` now. Left: the
  Gabby agent's 5 `000-*gabby*` imports on the Pixel (possibly in use).
- Saga world 925 still holds three 42703 interactive entities (lid 1, doors
  1-2) from an earlier session, and a creator-wand draft figure the Minifig
  Creator wand spawned when its slot was selected (the creator pack is no
  longer bound, so it will not load): remove with `/kill` by type when next
  in-world. The player's hotbar is empty (the creator wand item went with its
  pack's binding).

## Round 2026-09-26c (polish worktree `agent-a55b8131b17a9ef8f`)

Commits: `dfd19552` stairs + `--prune-stale`, `14a0a08c` tap forwarding +
refusal record, `f275ff02` ride-car name tags + pinball stand-up,
`6a82f8d0`/`3f5ca815` figure separation + display scatter, `bb37618f`
GameTest tester position, merged with main at `da9dcbad`. **Sent**:
`output/device-round-2026-09-26c/craftmatic-packs-da9dcbad.zip` (sha256
01217bdd613b049ed3713eeeeafaee974b54dcef84ad89094425af253818a8c7; 14 packs +
PACKS.md, built one at a time from `da9dcbad`, same labels and uuids as 26b,
`_mcaddon_check` 14/14, parts identical to 26b). Saga 925: dev
`--exclusive --prune-stale` (the creator pack's binding dropped; 0 stale
files), content log 0 errors / 0 overridden after a world load. Pixel 924:
import `--exclusive`, 14 + 14 bound; world not opened.

Device results:
- Saga, pinball stand-up (packs at `3f5ca815`): 11374 placed with the wand,
  seated by `/ride`, stood up; the wand slot came back selected and NO wand
  form opened (`output/polish-0926/saga/s16`, `s18`); Undo removed it.
- Pixel GameTest (`cmgametest`, variants of the `6a82f8d0` packs,
  `output/gametest-0926/logs/`): doorways as predicted 910047 3/3 (the plank
  gate walked this time), 41395 2/2 (Door 2 OK on its stairs), 60380 2/2
  (Door 3 OK), 31141 5/5, 42670 6/7 (Door 4 predicted blocked open, the
  device walked it: better than predicted); parts+seats 910047 4/4, 41395
  6/6, 60380 25/25, 42670 4/4, 31141 9/10.
- 31141 Window 2 explained: the tester stood 2.88 blocks off its spot
  (`stoodAt1` 20.5, 0.31, 5.54 vs spot 20.5, 3, 4.5): it fell off the ledge
  spot on teleport and hit from the floor below, where a wall really is in
  the way (the refusal's cutting cell 226,-55,308 is a full collider). Not a
  line-of-sight disagreement. Next: choose tap spots with room around them.
- 80049 did not run twice: the runner opened world 924, which now sorts
  first on the Play screen (the runner's tile check matched the wrong tile).
  Next: make `_gt_device_run.py` find the `cmgametest` tile by name.
- Not seen on a device: the ride-car name tag (needs 10261 placed and
  ridden), tap forwarding by a real finger, the display scatter, stairs by a
  real player.

## Open — interactivity

- [ ] **SEALED doorways, what is left** (28 of 83 at 100 % after the stairs;
  docs/bedrock-interactivity.md "Stairs up to a raised threshold"). Next, in
  measured order: diagonal stairs (two columns per step) for the off-axis
  leaves (11371's shops, 31141 Door 4, 60380 Door 2); an interior-side stair
  test that accepts a closed room's own flood region instead of "outside
  only"; the rest open onto furniture or walls (`output/clearance-0925/sealed.ts`
  in the clearance worktree prints what stands in front of each side).
  Stairs are not seen on a device yet beyond the GameTest runs below.
- [ ] **GameTest tap spots on ledges**: 31141 Window 2's tester fell 2.88
  blocks off its spot before hitting (see round 26c): the harness, not the
  runtime's line of sight. Next: `_gametest_pack.ts` prefers spots with
  standable neighbours at the same height; then re-run 31141 and 80049
  (80049 needs the runner to find `cmgametest` by name).
- [ ] 910047 Door 1/2 (plank gate) walked as predicted in round 26c after
  failing on 26b's run: the simulated walk is flaky on its 1-block ledge; one
  more pass decides.
- [ ] **Tap occlusion**: 910004 Door 4 tapped from the front toggled Window 3
  (Window 3's box first on the ray; no refusal, so no forwarding). Next: the
  tap audit could flag boxes that occlude another part's box from its
  approach spots.
- [ ] **Seat precision**: ~11 non-furniture "chairs/stools/beds" from the
  brick-built furniture rules (10261 1, 31141 1, 41703 1, 42639 2, 60380 2,
  76457 1, 77092 1, 80049 2; crops `output/ix-seats/shots/r*.png`/`t*.png` in
  worktree `agent-a16b2371…` do not mark the seat). Next: re-render each find
  with the seat marked, then a rule (candidate: standing room in front of the
  seat at its floor).
- [ ] Brick-built hinges still missed: 10354's round door, 42639's garage
  gate, 910049's iron gate (`_ix_hinges.ts --all`); mechanisms on pins/axles
  have no rule. STEP at big sizes (a doorstep past the jump at 200-400 %).
- [ ] Device-unproven: `custom_hit_test` by a real finger, slide direction of
  drawers/roller doors, root-bone scale off 100 %, occupant step-out, the
  100 % turned-form pass, tap forwarding (docs/bedrock-interactivity.md "Not
  verified on a device").

## Open — figures

- [ ] Display scatter (`settleLooseAccessories`) and figure separation
  (`separateFigureSpawns`) are host-tested only. 76417: 84 loose figure parts,
  20 touching nothing are set down (`_figure_parts_census.ts <src> --support`).
  76435 is not in the device round.
- [ ] Look at a walking figure after the gait fix (one straight-walk
  recording); mini-doll walk/sit on a device (42663 or 41395). Mini-doll rig
  code is owned by the mini-doll agent.
- [ ] Figures that stay (31141 1 and 5, 910049 7, 76269 3/6/7): 1-4 reachable
  cells; the planner is block-granular and reads a clearance form as its full
  block (`blockSpan` TODO).
- [ ] Colliders are laid in the grid frame, figures in the underside frame:
  a baseplate off a cell boundary is drawn into the terrain.
- [ ] Figure walk phase below 100 % (shorter legs, same rate).
- [ ] Creator figure geometry re-declares `armor_offset.default_neck` per
  head/hair geometry (content-log error, harmless so far) — creator agent.
- [ ] 42703's mermaid display dolls hover (stand parts 35678/35680/6330 have
  no LDraw part); goblins at 76417's teller desks only by an explicit rule.

## Open — vehicles, coasters, pinball

- [ ] Turning 36-block barge ~14 ms/tick (472 footprint checks). TODO in the
  guide: probe a turn only where the swept arc exceeds a block.
- [ ] McLaren corner test in 924 was void (two bound McLaren packs): redo.
- [ ] A real rider's stick on a driven train; the scripted car on the phone:
  steering at top speed (43 deg/s), slope pitch, a wall stop felt by a rider.
- [ ] 910047's rowing boat facing is a convention guess; converted railway
  track (Mecabricks, Eurobricks LXF) is placed 90 degrees off the LDraw part
  (a clego converter row).
- [ ] Coasters: pace √2 verdict on the Pixel (record in
  docs/physics-architecture.md §10-11); ceiling/drag not Froude-scaled above
  100 %; loop-1 apex one-tick 5-degree twitch; two 64.6-degree zigzags at the
  mirrored 26559 joins; lift docks snapped (1,884.9 vs 1,857.8 LDU);
  counterweight detection is a heuristic; lap bars for 42703 need an LDraw
  part for 77083.
- [ ] Pinball: cabinet button's 1.5x inward travel and launch-tick smoothing
  not seen on a device; drag release inferred (5 still ticks); tap-to-flipper
  ~100 ms is the server round trip.
- [ ] Minifig creator wand: `bedrock-minifig-wand.ts` has the same held-wand
  logic the pinball stand-up fix changed in the placement wand (a seated
  player clears `held`): creator agent's file.

## Open — rendering and export

- [ ] Stair-step striping on curved parts (42703 arches, round columns) at 2
  LDU: geometry; only a finer grain or merged steps change it.
- [ ] Close-up fidelity: rotated-cuboid facets for round parts are measured
  and half-built (`ldraw-round-facets.ts`, `_round_facet_yield.ts`), not
  emitted (constraints in `ldraw-entity-compiler.ts`: `worldBoxes` and
  `renderCuboids` are parallel; facets must not be `aligned`). Budget `high`
  was measured and not taken (2x memory).
- [ ] Cull above 100 %: the LOD plan caps at ~72 blocks (`TODO(cull)`); 200-400 % unmeasured.
- [ ] Walk preview: `world.simulated()`/`compareReach` not on the HUD; second
  train renders parked; car bank not animated; `three` chunk cost re-measure.
  The Z-mirror/rotation fix is verified in Chrome (2026-09-26: 76457 Door 1
  in its frame, closed and swung open, walked through; 11374 pinball ball
  launched 680 LDU; `output/polish-0926/walk-*.png`).
- [ ] 8 of 38 favourites ship as side-by-side sub-builds (60446, 10354, 77092,
  42652, 76269, 42639, 42663; `_source_connectivity.ts`); contact-maximising
  assembly failed (`_assembly_mate.ts`) — needs stud/anti-stud geometry.
- [ ] "Loose in the SOURCE" warning fires on 39 of 40 favourites (4 LDU AABB
  tolerance vs geograde's); decide by looking at one in game.
- [ ] Faces on the device: decal orientation and alpha cut unverified; route 2
  face art is offline-only (licence question for the user); 986 decorated
  heads have no source.

## Open — sources and corpus (clego)

- [ ] Deploy the app change first: prod ignores the index's `pick` until
  `lego-sources.ts` step 4 ships (60052 and 75398 wrong on prod). Check with
  `bun scripts/_index_picks.ts web/public/lego-models-index.json`.
- [ ] Gate v2: 14 Eurobricks regens eye-rejected; no track-end table for
  12V/4.5V/9V points/32087; scores cover multi-file sets only (re-score recipe
  in clego `GEOGRADE.md` "Pick policy"); 7751's pick unclear.
- [ ] RELEARN `dbix_part_align.json` with the embedded-origin correction; clego
  commits `80c14ba8` `bee8e945` `14e00945` `818cc7a8` `17d40022` `1858beba`
  `69b5cc54` unpushed; 75 IOModel2V2 sets the flattener refuses.
- [ ] Alignment rows: 258 of 263 added rows unvalidated (connectivity A/B
  neutral); 11512 pothos/step regressions unexplained; 478 lxfv56 rows on the
  measured table undecided; 233 other `bl_*` rows need frame measurement
  (`_coaster_frame_measure.ts`); 30 placements in 76417 without a row.
- [ ] Converter gaps (none is a reader bug): prints (`Part@decoration`, 3,874
  sets), stickers (1,757), flex paths (847), second shell colour (~10k
  placements), `MLCAD HIDE` (deliberately skipped).
- [ ] 697 embedded-part (`<set> - <mould>.dat`) sources: sweep for silent
  losses (export one, diff its entity list against the `.ldr` pick).
- [ ] uuid-schema explodes are display poses: do NOT apply. Partial apply
  (figures only) for rejects like 76269; 424 `convert_lxf.py` picks deserve a
  regen + A/B; DbixConvV2/DbixLDR not regenerated.
- [ ] Corpus backlog: HuntArchiveLDR figure residue, decorated Mecabricks
  torsos, windows on hand-authored EurobricksLDR, override hygiene (71425,
  71441, 71481, 72035, 80117, 72045), `io_part_count` inflation, class-B 108
  stems, four rotation abstentions, missing-torso placement (gated),
  compact-layout flag, candidate index review, publication plan review.
  Evidence `output/corpus-improvements-2026-09-20/`.
- [ ] The world-block mirror removal (`diag(1,-1,-1)` everywhere) is a
  breaking change the user decided on 2026-09-22; not started.

## Backlog, lower priority (each still open)

- [ ] Crowded LOD A/B with identical actors and camera (`--lod=hull
  --lod-distance=1024` vs `=1`); the earlier near/far numbers mixed screen
  coverage into the comparison.
- [ ] 76435 detached roofline objects at 400 %: source extras vs parked parts
  (no IOModel2V2 replacement); device visuals for the 71043/76435 repairs.
- [ ] Human-only input gates: look-down dive under the chase camera, joystick
  steering, X-wing walk cycle and cockpit, sitting thigh sign, doors/lights
  omitted at 200 %, figure home restraint.
- [ ] Creator pack release gates: emitted geometry/print checks and phone
  save/load/edit/reload by hand (`docs/minifig-creator-wand.md`).
- [ ] Console: window filtering must go through the census op; browser and
  device operations never exercised; `_pixel_perf.sh ref` takes no label.
- [ ] 76419's microfigure auto-scales 2x but its torso group is not an NPC;
  grader false positives (wheel/tyre, hand/weapon, axle/hole overlaps).
- [ ] Door sizing/straddled-cell duplication and <3/4-scale leaf height;
  910047 sparse fill 17 %; repeated-part budget (76240 70695 x184); Tumbler
  32-LDU grain 14.5 wide vs 11.5; unused `_chase`/`_boom` presets.
- [ ] Try `%%` in one form string on a device (if it renders, only
  `bedrockInGameText()` changes). `mainVehicleOnly` exports get no walk
  measurement (deliberate).
- [ ] Keep rollback snapshots until trusted (clego
  `geograde/_window_round/before_bytes/`, 41 MB).

## Closed routes — do not reopen without new evidence

Entity-per-part instancing and a resident master part library are NO-GO
(31-48 kB per actor, no instance transforms). `MLCAD SKIP_BEGIN` is the hose;
`MLCAD HIDE` parts are alternates; `BUFEXCHG RETRIEVE` restores a snapshot.
split0 union repair makes false positives on authentic `.io`. Device
guardrails: resident ceiling 487,856 cuboids (budget 480k), ~50-100k visible
for 60 fps; every actor stops drawing at ~72 blocks on 26.51/26.52.

## Hard rules and entry points

1. No whole-model voxelization or poly_mesh on the entity path.
2. getPartDims only as an explicit, diagnosed AABB fallback.
3. No Minecraft block colours on the entity path.
4. Diagnose every part/print/transparency/pose/cluster/figure/door degradation.
5. Do not change world blocks, rideability, DeLorean behaviour, or BlockGrid
   fallback to fix entity rendering.
6. Compile each unique part once; instance it; preserve exact source transforms.

Chain: lego.ts → schem-export.ts → schem-pipeline worker →
playable-components / bedrock-scene-actors → playable-addon → placement
assets/colliders. CLI: `bun scripts/_playable_ref.ts <model> [out] --label=…
[--quality=…] [--faces=<dir>]`.

## Minifig wand (2026-09-26)

Wand worktree `agent-a548028d7bb28a5d5`, commits `1d001960`, `f2a86ea5`,
`6a77244b` (+ the docs commit). Device evidence `output/minifig-wand-0926/`
there (Saga world 925; `saga/` before, `saga2..4/` after). Findings and fixes:
add-on guide "Minifig Creator wand on the phones". The wand works by hand on the
Saga end to end; open items:
- [ ] Run GameTest `creator_wand_<id>` on the Pixel (`cmgametest`): variant
  built at `output/minifig-wand-0926/gametest-6a77244b/minifig-creator-gametest.mcaddon`
  (bind it ALONE: the polish round's 31141 GameTest variant is bound there now). Not run: the Pixel lock was held.
- [ ] Pixel by hand: the same function list on the Pixel's screen (form width,
  preview spot at 45 degrees), and a figure code pasted into the Name/code form.
- [ ] A released (walk) creator figure walking after the new place flow on a
  device (walk was device-proved by `creator_<id>` on 2026-09-25 only).
- [ ] `look` animation turns set-figure heads off their bodies (seen on the
  Saga on `minifig_fig1`); dropped for the creator only. `TODO(figures)`.
- [ ] `_minifig_ref.ts` packs are named "(unstamped)" in Minecraft's pack list.
- Creator pack `027c2c03…` unbound from Saga world 925 by round 26c's
  `--exclusive` deploy; its dev folder stays installed.

## Mini-doll faces and bodies (2026-09-26)

Dolls worktree `agent-a04a934e6ea2fce73`; craftmatic `3a1b1f45`, `d272ef5b`,
`b038d2f0`, `04308020` (+ docs); clego `c246a71d` (converter + patch tool),
`f0b0d857` (13 sources published, R2 + prod read back). Account: add-on guide
"Mini-doll faces and whole bodies". Evidence `output/dolls-0926/`: census
`census-before.*` / `census-after.*`, source line-ups `src-r2/lineups/`,
doll art sheet `face-measure/doll-art-sheet.png`, packs `packs-<commit>/`,
face art dir `output/faces-art-0926/` (minifig art of 0924b + 28 doll heads).
Rebuild the art: `python -u scripts/gen-face-art.py output/faces-art-0926 <sources…>`.
Open:
- [ ] Device: close-ups of doll faces and bodies, a doll walking and sitting,
  before/after pairs (41732, 42703 against round 26b's packs). See the
  device notes below this list for what was and was not done.
- [ ] Hair with no LDraw mould, so 7 distinct dolls are bald: `79989` (hair
  and hat, 41732), `53117` (hair and fire helmet, 42670), `35620` (long wavy
  hair with side braid, 41703); 41703's boy's `36060` hair is placed ~750 LDU
  away by the LXFML itself; 41703's beekeeper hat `69938` IS an LDraw part but
  the doll patch carries doll moulds only (extend it to headwear at a doll
  head). 41395 (Mecabricks) has no heads, two dolls no legs, hair 71 LDU off.
- [ ] Microdolls (41732's two children, `69969`/`65224`) and babies (42670)
  stay geometry: a head 68 LDU above a `doll_body` is outside the grouping
  reach and the rig has no micro-doll canon. Gabby's MerCat (`4040` head,
  `65213` microdoll mermaid body: no LDraw part) likewise.
- [ ] Torso PRINTS (the most visible gap): 39 of the 43 doll torsos in these
  13 sets have no printed LDraw file (Rebrickable keyword match), so the dolls
  wear bare skin-coloured torsos. Options: torso art from LEGO's element renders
  (the head route, on the torso front), or the garment's colour. Leg prints:
  LDraw has some (`100937p04` = 41732's `101347c01pr0179`); the converter
  prints heads only.
- [ ] Two dolls spawned overlapping in 41732 (fig2/fig3: +34 coplanar pairs
  between the two NPCs, from the SOURCE now giving both their legs - the old
  code on the new sources shows the same 178) and 43267 (fig1/fig5). Main's
  `separateFigureSpawns` (`6a82f8d0`, merged after these packs were built)
  should separate them: re-run `_render_fault_audit.ts` on a rebuild.
- [ ] Doll art: the far half is mirrored from the near eye (asymmetric prints
  come out symmetric there) and a seam or a shading patch remains on about a
  third of the 28 heads (`face-measure/doll-art-sheet.png`); 28649pr0016 fits
  at pitch -20 and reads wrong. Gold on nougat skin is lost.
- [ ] craftmatic `web/public/lego-models-index.json` lags clego's (the Gabby
  round's and this round's entries): refresh it from clego after merging.
- [ ] In-app `.lxf` path: `FIGURE_TURN` (the 5828 hair) is converter-only.
