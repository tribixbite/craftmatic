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

## Rounds 2026-09-29a/b (`d95b7f5e`, `f37227ad`)

**Sent**: `output/device-round-2026-09-29a/craftmatic-packs-d95b7f5e.zip`
(sha256 f3a4036ed521a05d02db690af3380397a26f04fdfe460606b757affd7b168aff;
19 set packs + creator + PACKS.md, uuids = 28a's, parts = 28a's). Deployed
`--exclusive` on both phones (camprobe unbound on the Pixel); content logs
0 errors / 0 overridden. Evidence in the round folder (`saga/`, `pixel/`).
29b: `output/device-round-2026-09-29b/craftmatic-packs-f37227ad.zip` (sha256
c9c523f18bcf0da0f419904ae53efa173f5c9b79950c863c2ee2232b8c086137), same
uuids and parts, content logs 0/0 on both, deployed `--exclusive`.
- [x] Wand: first use no menu, the ghost follows the aim; second use shows
  the menu with Place first; place + Undo (both phones).
- [x] Doors at 100 %: 10326 Door 1 walked in and out, closed/reopened from
  inside (Pixel; the Saga's walk-out stopped once at 0.6, not repeated);
  910004 Door 3 opened and walked out (both), walking back in stopped at the
  threshold once on the Pixel.
- [ ] 10303 loops pitch over on both phones; Pixel exits continuous. **Saga:
  a one-frame cut to the car's other side + 0.1-0.15 s swing back at loop 1's
  exit on EVERY lap in round 29b (3 of 3; 29a saw it on lap 1 only); loop 2's
  exit is continuous.** Evidence `output/device-round-2026-09-29b/saga/rec/`
  (`lap*-exit1-30fps-big-1-8.jpg`, `lap*-framediff.tsv`). Open: Saga-only,
  so likely frame timing at the hand-back (26.52 vs the Pixel's 26.51).
- [x] 10365 (round 29b, draft 5.23, 7-deep pool): floats 5.3 below the
  surface on both phones, waterline above the hull's bottom edge, lower hull
  and posts under water, drives 43 blocks level. A 3-deep pool grounds it.
  `TODO(boats)` 2-block cap stays a judgement until the user sees it.
- [ ] 10261 kiosk figure: still no retake in round 29b, and the log said why -
  `FIGURE_RETAKE_NO_SEAT craftmatic:roller_10261_fig2 near 4584,-57,4592` (both
  phones): its home is ~2 blocks above the seat entity, outside the 1.5-block
  search. Since: the figure remembers its seat's id and searches 4 blocks
  (host test with the seat 2 below fails at 1.5). Device-unproven.
- [ ] 910004 Door 3 from inside: the tap button named Window 6 (tap
  occlusion, below); tapping the leaf worked.
- [x] "Place…" drew in a smaller grey font on both phones: now "Place".

## User report 2026-09-29 (after round 29b) - make it great for a 5-year-old

User: "Some of the last packs minifigs still had unclosed faces / surfaces and
the gabby cars obstructed driver view when mounted also the slide in the
dollhouse was misaligned and elevator didn't seem functional. Make it awesome
for my 5yo to explore and play with."
- [ ] Minifigs with unclosed faces / open surfaces (which sets and where: find
  on the device first; suspects: hollow part compile, hidden-cube cull,
  head carve, coplanar separation).
- [x] Gabby cars' view, the 10788 slide and lift: fixed in `377850a5` (worktree
  `agent-a743597866bba6650`), device-checked on the Saga, world 925, packs
  `output/gabby-play-0929/packs-377850a5/` (uuids unchanged; content log 0 errors / 0 overridden).
  Evidence `output/gabby-play-0929/saga/` (`s*` = before, `v*` = after) and `output/gabby-play-0929/rec/`.
  - Cars: 10797's cat car put the eye inside its bodywork (default-cabin, view
    0 of 15 rays clear); now the seat is on its rear deck and first person
    sees ahead (`v27`, `rec/v_car10797_cockpit`); 10796's carts see ahead too
    (`v34`, `v36`). 10797's car also FELL THROUGH THE WORLD under an overhang
    (Saga: y -104, `s43`-`s46`); the ground scan now passes under it (host test).
  - 10788 slide: the rider ran on the chute's side rails, 30 LDU over the bed;
    now in the chute (`rec/v_slide10788-big-*`, `rec/v_slide10796-big-*`).
  - 10788 lift: the "car" was the shaft's back-wall cap (it flew over the
    roof, `rec/lift10788_a-big-1-8.jpg`); now the pink platform (3863) rides
    its frames and stops at the three room floors, tap it to board
    (`v09`-`v19`, `rec/v_lift_*`).
  Gates at `34eb8363`: typecheck (root, web), `bun run test` 2,739 passed,
  physics spec current, favourites sweep 40/40 (`output/gabby-play-0929/sweep/`),
  `_mcaddon_check` 0 fails (sweep + 5 Gabby), `_ix_passability` 100/150 % rot 0:
  0 FAIL, 41 SEALED = the `merge-0929` baseline's 41 (none new). The device
  packs are `377850a5`; `34eb8363` changes no Gabby seat (vehicle audit).
- [ ] Minifigs with unclosed faces / open surfaces (another agent owns it).
- [ ] Gabby, still open from the play round:
  - Undo leaves a car the player rode behind (10796 car 1, 10797's car,
    `v41-kill`, `s53`): killed by hand; not investigated.
  - Chase camera: the rider's head still sits at the middle of a doll car's
    chase view (`v33b`, `v35b`); the boom now rises over it only when the
    rider is drawn. The cockpit (slot 9) view is clear.
  - The 10788 attic has no lift stop (the platform's runner block would leave
    the top frame); its rooms 2-3 are reached by the lift only.
  - Not re-checked this round: 10786's boat, 11204's slide after the bed fix
    (both moved < 0.5 block in the offline path), the turntable, swing, stool,
    drawers and lids. 10797's turntable showed no tap target at 2.5 blocks (`s50`).
  - Lift exit onto the 2nd/3rd floors lands beside the shaft on the room's
    floor (`v17`); the step off is a teleport, not a walk.

## New-set onboarding + 11390 (2026-09-29)

Infra is in (sources guide "Onboarding ONE announced set"): clego
`python discovery/new_set.py <sku> --run` (ladder + harvest/grade/lift/publish,
exit 0/3/1; lift proved on 40900: entry byte-equal to live, nothing else
moved, ~5 min), craftmatic `bun scripts/new-set.ts <sku> --commit --browser`
(live index + models, index commit, Chrome deep-link render via
`_live_set_check.mjs`, pack + gates + zip), `scripts/new-set-watch.ps1 <sku>`
for `schtasks` (hourly; lock + DONE; one run for 11390 exited 3 as designed).
App: `mergeIndexSets` (catalog topped up from the index) and `?tab=lego&set=N`
- PROD-proved on 40900 (`f03497b9`: drawn in 11 s,
`output/new-set-40900-prod/live-40900.png`; pack + gates + zip in
`output/new-set-40900-pack2/`). 11390 today: `announced` (lego.com knows it:
1,764 pieces, 0 PDFs; DBIX 204; not in Rebrickable).
- [ ] The user registers the task: `schtasks /create /tn "craftmatic-new-set-11390"
  /sc hourly /st 06:05 /tr "powershell -NoProfile -ExecutionPolicy Bypass -File
  C:\git\craftmatic\scripts\new-set-watch.ps1 11390"` (release 2026-11-01).
- [ ] Untested until a set actually appears: `new_set.py --run` from
  `3d-available` end to end (each step is proven alone: harvest via
  `dbix_refresh --set` on 40900 in the 09-27 round, lift on 40900 today,
  publish = refresh_local's) and `new-set.ts --commit` (git add/commit/push
  of the index copy).
- [ ] Nimbus rig (worktree agent, offline only): `flyer` motion (native rotor
  controller, cloud-styled), `set-canon.ts` (11390: cloud mount, companion
  orbit), mount detector, interact → own cloud (60 s despawn, cap), fixture
  `test/fixtures/nimbus-fixture.ldr`, GameTest. Then: merge after gates, a
  Pixel GameTest round, and when the 11390 file lands, `new-set.ts 11390`
  and the one-line canon check (cloud colour family).

## Open — interactivity

- [ ] **Doorways not OK at 100 %: 26 of 83** (was 40; 150 %: 22, was 32; 0
  FAIL at every size; docs/bedrock-interactivity.md "Doors a minifig uses, at
  100 %", sweeps `output/doors-0929/{before-g,after}` in worktree
  `agent-a8832fe8…`). `bun scripts/_ix_sealed_causes.ts <packs> <geometry>
  --drawn` names each cause. Left: 23 are the model's own geometry for a
  0.6 x 1.8 player walking straight through (furniture, a wall or a railing
  a stud from the leaf - a minifig is 1 stud deep, the player 0.6; stairs or
  a turn in the corridor; 71043's microscale doors, 48 x 80 LDU over a
  3-block drop) - report, do not hack. 3 are colliders: 42639 Door 1 and
  910032 Door 4 (a thin post covered by a whole-length quarter band - a
  box-shaped form would be needed; eighth bands buy almost nothing,
  `--kit8`), 11371 Door 1 (trims refused near a leak). Next: a GameTest walk
  of the newly passable ones (80049 Doors 1-2, 42670 Door 1, 10326 Doors 1-2,
  11371 Doors 2-4 and 7, 21318 Door 1, 31141 Door 4, 41732 Door 3, 910004
  Door 3, 910049 Gate 1) - none is device-proven.
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
  (continuous pitch past ±90, which `playAnimation` takes; ridden clean
  through loop 1, `ride2-apex1-big-*.jpg`), the animation outlives its
  hand-back by `animTail` 6, and both cameras ride the DRAWN seat
  (`tickLag` 1.5, `animLag` 3.5, marker-measured: the old per-tick camera
  sat 1.7 blocks ahead of the drawn car at 10 blocks/s — in the car ahead at
  speed). Ridden (`f131fe80`, `device/ride3*.jpg`): (a) no spin over either
  top, (b) no own-view flash at either loop, (c) loop 1's hand-back smooth,
  loop 2's cut ~40 degrees in one frame → the lag now blends from `animLag`
  to `tickLag` over `handbackBlend` 4 ticks. Ridden again (`ed273b4b`,
  `device/ride4*.jpg`, content log 0 errors): both loops pitch over with no
  spin, both exits continuous, no flash. Not verified by eye: (d) the view
  is from the own seat (the marker measurement says so). Open: `over`'s
  keyframe direction is off the nose by up to ~3 degrees on a leaning loop;
  the eased camera's ±30 px frame jitter; the camprobe pack (`5c0c9d3e…`,
  `Craftmatic(7)`) is still bound in world 924 — harmless, unbind with the
  next `--exclusive` round. The user's own verdict is the gate.
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
  looking down from the eye shows water. Tried 2026-09-29: glass-derived eyes on
  the vehicle's centreline - 60221's centre is solid cabin (rider then hidden
  to 400 %, torso 34 % inside) and 60405's bbox centre is off its body; dropped.
- [ ] 10261 kiosk figure retake: the runtime retakes a seat only with no player
  within 2.5 blocks of it; re-check on a device standing well away (the probe
  may have stayed beside it). Host sim covers the retake.
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
- [ ] The cats have no LDraw bodies (65213, 102297, 5690-5692, 3862): MerCat's head
  4040 stands alone; do not invent geometry.
- [ ] 10796/10797/10786/11204 are staged captures: builds stand in a row.
- [ ] Prod serves the old index until craftmatic deploys; the five files are live.
- [ ] clego `dbix_reconvert_summary.json` carries uncommitted entries from this
  round's trial reconversions (shared file, left as is).
