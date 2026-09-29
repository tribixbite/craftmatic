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
labels (the uuid follows the label; recipe `output/device-round-2026-09-26d/build.sh`
in the main checkout, 19 sets; the 14 round labels are in
`output/device-round-2026-09-26b/new-manifests.txt`, the Gabby five use `Name (set-1)`;
the creator pack is `bun scripts/_minifig_ref.ts <out> --creator=starter "--label=Minifig Creator"`).

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
- Content log: it is written in 4 KB blocks, so the LAST world load's tail is
  still in the game's buffer when you read it at the Play screen (both phones'
  logs ended mid-line at 73,728 bytes, 2026-09-26). Open and close the world
  once more, then read: the load before is then complete on disk.
- Phone clean-up history: `output/phone-cleanup-0926/` in the polish worktree.
  Left on purpose: the Pixel's `screen-2026*.mp4` (may be the user's), web-app
  downloads, `Download/craftmatic-pack-backup-0924/`, older imported pack
  folders under `behavior_packs` (adb cannot delete there without root).
  Round 26d deleted its own 20 `000-*.mcaddon` imports on the Pixel and its
  own Saga staging dir (10,317 files, file by file). 9 other
  `/data/local/tmp/craftmatic-deploy-2026092[6]-17*..19*` dirs from the
  wand, dolls, vehicle-seat and Gabby agents remain on the Saga.
- Saga world 925 still holds three 42703 interactive entities (lid 1, doors
  1-2) from an earlier session (not touched in 26d). The creator-wand draft:
  `/kill @e[type=craftmatic:minifig_minifig]` and `…minifig_preview` found
  no target once the creator pack was bound again (its load sweep removes
  drafts), so it is gone or in an unloaded chunk.

## Sources round (2026-09-27)

New releases and missing parts are DONE and published (clego `6e075c84`,
`c636ea03`, `b82659bb`; craftmatic `fe46a79e`): 8 new sets indexed (40900 DBIX;
30730 30733 30736 40777 6565181 910061 952502 Mecabricks fan files), 14
DbixConvV3 doll/City files repaired (53117 fire-helmet hair -> Studio
`bl_53117pb02`, 69938 beekeeper hat printed `p01`/`p02`, doll headgear seated
on the stud, dropped parts carried). R2 + prod read back by sha256, index
`be4a63123f87`. Reports: clego `discovery/new_releases_2026-09-27.md`,
`discovery/missing_parts_2026-09-27.md`. Open from them:
- [ ] 208 sourceless 2026 sets have no digital model on any channel checked
  (promos, magazine gifts, polybags, books, Duplo...); re-run
  `python discovery/refresh_local.py --check` weekly. clego `sets.csv` is 220
  rows behind Rebrickable (not refreshed).
- [ ] `MecabricksLDR/71052-3.ldr` (BIONICLE Cosplayer, Series 29) is on disk
  but NOT indexed: the index keys a set by the stem before `-`, so it would
  stand for the whole series. Needs a per-figure key scheme.
- [ ] Mecabricks downloads use `POST /api/workshop/model/load`, which their
  robots.txt disallows (same endpoint as every earlier harvest). Decide.
- [ ] Still no geometry (no mould found after Studio release + early-access,
  `ldraw_ref`, today's `ldrawunf.zip`, library.ldraw.org, Mecabricks CDN,
  Rebrickable, Brickset): Gabby cats 65213, 102297, 3862, 5690-5692, 7415,
  107527; doll hair 79989 (alt design 106161), 35620 (12 sets); 65224
  (stand-in 69969); 102722/5607 (Ursula), 7872/7842 (doll neckwear), 6330
  (plush pillow, 10 sets). Torso prints not surveyed this round.
- [ ] Corpus-wide: 182 ids (>=1,576 placements, 380 sets) dropped by published
  DBIX files now resolve: `dbix_doll_patch.py --carry` or regenerate. 28 ids
  (269 placements) have a Studio identity row to an existing `bl_*` file
  (49663, 69971, 5990, 5326...) - each needs a frame check before mapping.
- [ ] In-app `.lxf` path has no headgear-seating or beekeeper-colour rule
  (`TODO(doll-headgear)` in `gen-ldd-part-map.py`; `lxf-parser.ts`).

## Round 2026-09-26d (main checkout, `9b6118c5`)

**Sent**: `output/device-round-2026-09-26d/craftmatic-packs-9b6118c5.zip`
(sha256 10ab1b08be07e86aa8da4cfb83b7ae8c6c471409b9efa7ed16f1f3b23fb1932f;
19 set packs + `minifig-creator.mcaddon` + PACKS.md). Built one at a time
from the clean `9b6118c5` (stamp `f1212596d08a`, clean), `--faces=output/faces-art-0926`
(local-only photo art). All 40 header uuids equal their references
(`uuid-proof.tsv`: 26b manifests for the 14, the Gabby agent's `packs-ebb20563`
for the five, the wand agent's pack for the creator). `_mcaddon_check` 20/20.
Parts vs 26c identical for 12 of 14; 10261 gains `lid_1` (18990 canopy, one
part out of the shell); 41732 and 42703 are the republished doll sources
(+1 part each, art faces 0->6 and 0->3). Gabby five: parts identical to
`ebb20563`, each gains Gabby's art face (0924b had no doll art). Render audit
equal to the references except 41732 (0.34 -> 0.39 block faces: fig2 x fig3
overlap, 34 pairs, the known doll-spawn overlap). Evidence in the round folder:
`check.txt`, `render-audit-summary.txt`, `saga/`, `pixel/`, deploy logs.

Deployed `--exclusive` over all 20 (Saga 925 dev + `--prune-stale`: 4 stale
10786 RP files deleted; Pixel 924 import). Content log 0 errors / 0
overridden on both, every load complete on disk. Results (both phones unless
noted):
- Dolls: 41732 fig2/fig6 and 42703 fig1/fig2 have faces, hair and legs
  (`saga/s10`, `s11`, `pixel/p08-dolls-row-crop`).
- 42172 at 100 %: head in the cabin (side camera `saga/s19`, `pixel/p12`),
  slot 9 looks out through the windscreen (`saga/s16`, `pixel/p11`).
- 7140 at 150 %: rider in the cockpit under the canopy (`saga/s22b`,
  `s24`, `pixel/p13`); first person through the canopy frame (`s23`, `p14`).
- 10788 lift: stop 2 -> 3, set down on the top floor beside the shaft
  (position readouts: Saga 3064,-50,2981 = exit 3; Pixel 3249,-50,3028 =
  exit 3). The car does not visibly move in a fixed-camera burst
  (`saga/s43-10788-lift-sheet`, `pixel/p16`). Slide: top to foot on both
  (`saga/s49`, `pixel/p17`).
- 10786 on a `/fill` pool: floats, boards, drives (Saga 10 mph, 7 blocks;
  Pixel 13 mph), not aground (`saga/s52-56`, `pixel/p19-22`). Pool refilled
  with dirt and grass.
- 11204 bubble dome: FOUND by a tap from ~3 blocks (label "lid 2", Open /
  close) and opens and closes on both (`saga/s62-64`, `pixel/p26-31`).
- Minifig Creator: open, draft beside the view, pose (Waving on the Saga,
  Arms up on the Pixel), place standing still, Undo returns it to the draft,
  Discard (`saga/s66-70`, `pixel/p33-37`).
- Everything placed was undone, wands cleared, both phones at the Play screen.

Not seen on a device yet: the ride-car name tag (10261 placed and ridden),
tap forwarding by a real finger, the display scatter, stairs by a real
player, 11204's chest lid, a lift ride that shows the car moving.

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
- [ ] Rider camera through loops (2026-09-29, worktree
  `agent-a4896775dd698fb20`, evidence `output/coaster-cam-0929/`): the
  spin at every loop's zenith and exit was the `roll`-mode chart flip
  interpolated linearly by the client; keyframes are now `over` views
  (continuous pitch past ±90, which `playAnimation` takes), the animation
  outlives its hand-back by `animTail` 6 (the player's-view flash), and
  `animLag` is 2 (marker-measured; 3 jolted 1.4 ticks into and out of each
  loop). Device proof pending in this worktree's round: ride 10303 on the
  Pixel after the rebuilt pack, look for (a) no spin over either top, (b) no
  flash at either exit, (c) no jolt at the animation's start/end. Still
  open after it: the per-tick eased camera itself sits ~1.6 ticks ahead of
  the drawn car (the whole ride, not only loops) — a history-lagged per-tick
  camera would put the eye in the drawn seat; `over`'s keyframe direction
  is off the nose by up to ~3 degrees on a leaning loop.
- [ ] Pinball: cabinet button's 1.5x inward travel and launch-tick smoothing
  not seen on a device; drag release inferred (5 still ticks); tap-to-flipper
  ~100 ms is the server round trip.
- [ ] Minifig creator wand: `bedrock-minifig-wand.ts` has the same held-wand
  logic the pinball stand-up fix changed in the placement wand (a seated
  player clears `held`): creator agent's file.

## Open — rendering and export

- [ ] **Far-side slivers folded** (2026-09-28, `foldFarSlivers` in
  `ldraw-part-prototype.ts`): a part whose bounds end a float hair past a
  grid plane (8.0005 on 2 LDU) used to emit its last lattice row as a
  0.0002-0.03 LDU cuboid. Folded into the row before: favourites' thin cubes
  7,002 -> 902 (10261 550 -> 5), extents unchanged, no hole (a sliver with an
  empty neighbour is kept). Side effect: fewer cubes re-plan every pack's
  grains, so z-fight moves both ways (7 packs up, 4 down, 29 same; total
  8,028 -> 8,122 pairs, 30.04 -> 30.17 block faces; 42172 +0.08, 77092 +0.11).
  NOT shown to be visible on a device either way: a sliver is back-face culled
  and mostly shares its neighbour's colour. Evidence `output/fold-0928/`
  (`sweep2/`, `ix.log`), probe `scripts/_planar_cuboid_probe.ts`.
  The `fix/bedrock-fidelity` worktree commit `ecc2c265` (thicken exact-zero
  cuboids outward by one cell) is NOT merged: it changes none of 10261's
  placed parts (their slivers are >1e-9 thick) and where it acts it pushes a
  flat part's plane a whole cell (2-8 LDU) past its own bounds.
- [ ] 10261: 49 cross-actor coplanar pairs where the parked cars' grey floor
  (26021) lies in the station track's red top plane (`_render_fault_audit.ts`);
  the export's separation pass works within one actor only.

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
- [ ] Pixel by hand: a figure code pasted into the Name/code form (open, draft
  beside the view, pose, place standing, Undo, Discard seen on the Pixel in
  round 26d, `output/device-round-2026-09-26d/pixel/p33-37`).
- [ ] A released (walk) creator figure walking after the new place flow on a
  device (walk was device-proved by `creator_<id>` on 2026-09-25 only).
- [ ] `look` animation turns set-figure heads off their bodies (seen on the
  Saga on `minifig_fig1`); dropped for the creator only. `TODO(figures)`.
- [ ] `_minifig_ref.ts` packs are named "(unstamped)" in Minecraft's pack list.
- Creator pack `027c2c03…` is bound again in Saga 925 and Pixel 924 (round
  26d ships it beside the set packs).

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
- [x] Saga (world 925, 18:13-18:43, lock taken and released): the four packs
  of `packs-c0737b89` (41732, 42703 in place over round 26c's; 43267, 11204
  new) deployed without `--exclusive`; content log 0 errors / 0 overridden.
  Evidence `output/dolls-0926/saga/`. Figure NUMBERS changed between the old
  and new packs (the stump doll now anchors first), so a true pair is matched
  by doll: `pair_42703_pink-pr0147_before-after.jpg` (blank face -> her own
  face, stars and lips), `pair_41732_fig2_before-after.jpg`. All five
  princesses of 43267 and mermaid Gabby have faces, hair, tails
  (`after_43267_*`, `after_11204_fig1.jpg`); 41732 fig1 and 43267 fig5 are
  bald (no LDraw hair mould, below). Walk: a doll walked off with its head on
  (`walk_*`). Sit: `/ride` seated `princess_43267_fig5` (`sit_1.jpg`, legs
  forward seen from the front). Everything summoned was killed; Play screen.
- [ ] Device, not captured: a side view of a seated doll's 90-degree hip bend,
  a mid-stride arm swing (faces, hair, legs seen on the Pixel in round 26d). The deploy's staging dir
  `/data/local/tmp/craftmatic-deploy-20260926-182514-46336` stays on the Saga
  (the script keeps it; removing it is file by file).
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
  `separateFigureSpawns` (`6a82f8d0`) did NOT separate 41732's pair: the
  round 26d rebuild on `9b6118c5` still has fig2 x fig3 at 34 pairs
  (`output/device-round-2026-09-26d/render-audit.txt`). Next: why the pair is
  not seen as one figure inside another.
- [ ] Doll art: the far half is mirrored from the near eye (asymmetric prints
  come out symmetric there) and a seam or a shading patch remains on about a
  third of the 28 heads (`face-measure/doll-art-sheet.png`); 28649pr0016 fits
  at pitch -20 and reads wrong. Gold on nougat skin is lost.
- [ ] In-app `.lxf` path: `FIGURE_TURN` (the 5828 hair) is converter-only.

## Seating (2026-09-27, merged `worktree-agent-a123ff9c…`)

Every place a figure sits is in the export report's seat census
(`engine/seat-census.ts`); guide: docs/bedrock-addon-guide.md "Where the
player sits". 45 sets (40 favourites + 5 Gabby): places the player can sit
153/170 -> **160/162** (raw parts 153/176 -> 170/172). Evidence in the
worktree `output/seat-audit-0927/` (`final/audit.md`, `veh-final.log`,
`sweep/` 40/40, `ix.log` 0 FAIL). Rules: a ship's wheel steers, the driver
sits at the wheel, a source-seated figure proves a seat and yields it to a
player within 2.5 blocks, one measured eye height 1.12 (coaster included),
boats face bow-first, a boat's driver is never under its hull (60221 on
deck), 76286's pilot fits from 100 %.
- [x] Round 2026-09-28a (`ed25bf51`, both phones, content log 0/0; zip
  `output/device-round-2026-09-28a/craftmatic-packs-ed25bf51.zip`, sha256
  1801142e...; evidence `saga/`, `pixel/` there): 10365 rider at the helm by
  the stern lanterns, drives bow-first; 76286 pilot drawn in the cockpit at
  100 %; a seated 10261 kiosk figure stands up when the player comes within
  2.5 blocks and the player sits; 10261 close-up at 2-5 blocks shows no
  stripes or missing faces.
- [ ] 10365 floated ~3 blocks over the water (Saga probe 2026-09-28,
  `output/probe-0928-float/`: CMVT y -61.3 = surface -60.1 - draft 1.2, but
  the lowest DRAWN point was +2.86 over the origin). Fixed offline, not yet
  on a device: (1) an entity's vertical bounds and floor read where a rotated
  bone's cuboid is DRAWN, not its stored unrotated box (10365's drawn bottom
  0.00 over the origin, was 2.86; `scripts/_drawn_floor.ts`); (2) a boat's
  draft is its keel (the largest part's bottom, `keelBlocks`) plus the
  immersion, so its stand posts go under and the hull sits 1.2 deep; (3) the
  runtime's water scan follows the waterline (origin + draft), not the
  origin, or a deep draft read each lower water block as the top (host test).
  Across (x, z) the stored boxes still set the centre (drawn boxes moved 51
  figures 0.26-0.55 blocks off their feet); `TODO(bounds)` for vehicle
  footprints. Favourites: 452 of 452 yaw-0 actors keep their world span
  (`--world`), driver seats keep their source, 40/40 export, 0 doorway FAIL.
  Next device round: 10365 on a /fill pool, hull in the water.
- [ ] 76286's pilot sits at a REAR window: the Saga probe (2026-09-28,
  `output/probe-0928-float/`) measured its pointed nose at world +z and the
  chase camera behind the engine rings, so its facing (-z, inferred) is RIGHT.
  The seat comes from `canopy-parts`, i.e. 84954, a windscreen mould set as a
  rear window aft of the engines (source z 371 of -203..554); first person
  looks forward down the cabin to the two real pilot seats (riderAt eye
  0, 4.5, -3.66). A facing "fix" (b733c029) turned it round and was undone.
  Tried and dropped (2026-09-28): glass aft of centre is a rear window
  (75301's canopy is aft of its long nose too), glass behind the glow
  centroid, behind every glow part (the Milano has a small dish aft of its
  window), behind the area-weighted glow (75301 still lost its canopy). No
  glow rule separates the two. Next: the seat from its brick-built front
  seats, or a recorded seat with this evidence.
- [ ] 60221 rider is at deck height but at the hull's side edge (seat x 1.09);
  looking down from the eye shows water.
- [ ] 10261 kiosk figure had not retaken its seat ~20 s after the player left
  (the runtime retries every 100 ticks): watch longer, then read the code.
- [ ] Not checked on a device: a coaster ride at eye 1.12; a 76457 NPC.
- [ ] Left: 60446's second figure stays in the vehicle geometry (no
  passenger seat, `TODO(seat-passenger-figures)`); 75397's second steering
  spot is not a seat. 42092 (Technic, 0.9 scale) keeps the eye in the hull
  at every size - not a minifig cabin.
- [ ] GameTest drive on the Pixel (`bun scripts/_gametest_pack.ts <pack>
  --only=vehicles`, world `cmgametest`) to confirm seating did not change
  driving.

## Gabby sets (2026-09-26)

10796 Kitty Care Ear, 10797 Party Room, 10788 Dollhouse, 10786 Ship & Spa, 11204
Aquarium Adventure. Worktree `agent-afae0705` (branch `worktree-agent-afae0705e4b49f559`);
evidence `output/gabby-0926/` there. Guide: docs/bedrock-addon-guide.md "Gabby's Dollhouse".

- [x] Sources: DbixConvV3 is every set's pick (renders `sheets/`, box art `boxart/`).
  Published (clego `5efac7c4` converter, `698cd61a` index; R2 + prod sha readback
  `src-fix/readback.json`): 10786 hull 28925c06 white/purple + life jacket bl_24184,
  LEGOID colours for 10788/10797/11204. The mini-doll round (`f0b0d857`) then
  republished all five with whole dolls on top; the worktree index is clego's copy.
- [x] Code (`8c14c181`, `c345c0de`, `ebb20563`): mini-doll scale cue; "Ship & Spa"
  is a scene; scene vehicles keep deck props; slides and lifts ride
  (`bedrock-rides.ts`, `scripts/rides.js`); swings are seats; a canopy on its
  handle is a lid. Favourites sweep vs `28a5baf0` (`sweep-base/`,
  `sweep-after2/`): 40/40 OK; changes: slides in 41395, 41703, 42652 (2);
  10261's 18990 canopy is a lid; 910047's boat and car keep 3 props they
  dropped; two false lifts (10303, 10341) fixed in `c345c0de` (re-swept
  `sweep-after3/`: no lift).
- [x] Packs `output/gabby-0926/packs-ebb20563/` + `gabby-packs-5d58c67e.zip`
  (sha256 5d58c67ea02475fcad293049151842d4e36a37a6d3a972ae6a2a62b328201a88).
  `_mcaddon_check` 5/5; render audit <= 0.35 block faces; no substituted,
  unresolved or bbox parts; no coarsening.
- [x] Device, content log 0 errors / 0 overridden in every session. Pixel 924
  (`pixel/REPORT.md`): all five placed; 10796 slide ran to the foot; 10788 lift
  moved up and down (r2); on ebb20563 the view during the lift ride is no longer a
  solid wall colour (r3), but that ride set the rider only 0.7 blocks higher. Saga 925 (`saga/REPORT.md`, packs 18837c0c): 10788 lift up, up, down with
  clean dismounts; 10797 slide; 10786 boat boards (aground on grass, as expected).
  Saga r2 (ebb20563): deployed, content log 0/0; its `/ride ... c=1` took the
  nearest ride seat, which was 10788's slide ("Wheee!"), and it ran.
- [ ] Not seen working on a device: 11204's chest, the swing seat, the carts,
  10797's turntable and stool, the drawers. (11204's dome opens and closes by a
  tap from ~3 blocks on both phones, round 26d.) Pixel r3: re-boarding the lift from the
  same spot re-seated the parked car without a trip (host sim
  `lift_sim.ts` cycles every ride; not explained).
- [ ] 10788: the car found is the upper cat-eared assembly (2456/3002/15068 at
  y -424..-592); the pink box at the shaft's foot may be the real car - check the
  instructions. Above 100 % a solid car's rider is inside it again
  (`TODO(rides)`).
- [ ] The cats have no LDraw bodies (65213, 102297, 5690-5692, 3862): MerCat's head
  4040 stands alone; do not invent geometry.
- [ ] 10796/10797/10786/11204 are staged captures: builds stand in a row.
- [ ] Prod serves the old index until craftmatic deploys; the five files are live.
- [ ] clego `dbix_reconvert_summary.json` carries uncommitted entries from this
  round's trial reconversions (shared file, left as is).
