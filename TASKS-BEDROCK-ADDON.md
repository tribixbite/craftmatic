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
  data** (either phone). Taps: 90 ms swipes `input swipe x y x y 90` worked
  for every button and the crosshair (2026-09-29; 300 ms also works). Chat:
  per-character `input text` with 60 ms gaps lands in order (~8 s a command;
  `_saga_chat.sh`'s "first char at the end" fix-up now deletes the last
  letter). Two-finger input (Back+Jump) via root `sendevent` on
  `/dev/input/event4` (protocol B; ROTATION_270: panel x = landscape y,
  panel y = 2400 − landscape x). The wand's second use may not open its
  menu: switch hotbar slot away and back. Place shows a confirm form (green
  button at raw 1197,960). No flight in 925: a `/tp` into the air falls; use
  a glass platform for top-down shots. The content log gets ~10 verbose
  `No sound found ... 'fly'` lines/min per hovering flyer (defect 5 above).
  `/tp @s ~ ~ ~` DISMOUNTS (probe position after dismounting). `tp ...
  facing` computes from the FEET: aim the crosshair at height h with
  `facing ~ ~(h-1.62) ~` after `execute at` the entity. The wand's "Place
  now" button is green only while hovered and its y follows the form text
  (raw 504/707/960): find the first button under the text
  (`29c/saga/tools/findbtn.py`). `input keyevent 4` after Enter opens the
  pause menu. The touch "Mount" button moves; `/ride @s start_riding
  <entity> teleport_rider` is the reliable mount. toybox `find` has no
  `-delete`: `find <dir> -type f -exec rm {} \;` then `-depth -type d -exec
  rmdir {} \;`; deploy backup dirs are root-owned (`su -c`).
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

## Round 2026-09-30i (`fd91cf23`) - door tap from inside a collider, tilted colliders

**Sent** (zip, not deployed yet): `output/device-round-2026-09-30i/craftmatic-packs-fd91cf23.zip`
(sha256 c45d6b95787b25b9701949b9fa085683ef5f5cc8aef090d195b1b388f46d2a47;
23 packs, labels as 30h; `check.txt` 23/23 OK, uuids = 30h, parts = 30h).
Sim: regressions all OK + gabby-car-overhang not reproduced; hop passes.
Saga round DONE 2026-09-30 21:41-22:47 (`output/device-round-2026-09-30i/saga/_notes.txt`;
content log 0 errors / 0 FIGURE_RETAKE / 0 fly / 0 overridden): 10326 corridor
head clear to z 5382.30 (x 5385.0) / 5382.05 (x 5385.6) as predicted (30h
5383.05); Door 3 taps open from 2.0 and 1.5 blocks, walk in/out by stick;
76417 Doors 2/3 walk through, no invisible walls.
- [ ] 76417 Gate 1 opens onto an INVISIBLE FLOOR over a 17-block drop
  (5393.56,-43.12,5381.44 = corner + 13.56,16.88,1.44): shell bone `r321`, a
  plate turned 45 deg about the vertical, still lays its AABB, whose corners
  are colliders over air; walking on, the player falls to the grass.
  Offline: `bun output/device-round-2026-09-30i/saga/tools/drawn_at.ts <76417 pack> 13 14 0 35 1 2`
  (0 drawn cuboids in that column). `TODO(tilted-colliders)` (a): yaw-only
  turns keep the AABB because 76435's climb uses those boxes as steps.
- [ ] 10261 at 200 %: no device climb route found above the base (front-edge
  columns x 5430-5448 and the east walkway x 5462 stand > 1 block); no earlier
  round recorded one. Find a route offline first (reach 1,995 -> 1,788).
- Saga incident: after Save & Quit the screen froze on "Loading..." > 5 min
  (world saved); `am force-stop` + relaunch recovered it, bindings intact.
- World 925 holds a marked 10261 seat ("Add seat here (1/12)") from an
  earlier session.

## Round 2026-09-30h (`59fb347c`) - museum back doors, cockpit fallback

**Sent** (zip, not deployed yet): `output/device-round-2026-09-30h/craftmatic-packs-59fb347c.zip`
(sha256 6c90f4f32c47d63f6f4b639fe701549af2f28d98f0923df52fe353adcb3c8088;
23 packs, labels as 30g; `check.txt` 23/23 OK, uuids = 30g; parts = 30g
except 10326 (doors 1-3 drop the pediment parts they had absorbed, shell +6,
door 6 +1 - the 60616a fix)). Sim: regressions 13 OK + gabby-car-overhang
not reproduced; hop passes.
Saga round DONE 2026-09-30 (`output/device-round-2026-09-30h/saga/_notes.txt`;
content log 0 errors / 0 FIGURE_RETAKE / 0 fly / 0 overridden): 10326 Door 1
at the ground in its arch, no stair, tap opens, stick walk in/out, knobs on
the leaves; 76286 cockpit FIXED (eye over the hull, horizon across the middle;
a dark fin covers the top ~20 %); 42639 FIXED (door top under the horizon, at
31 mph too); 60380 / 42172 / 7140 / 60221 unchanged; 10365 helm eye OK. Only
76286 took the high fallback in this round (no ship did).
- [ ] 10326 Door 3 tap: FIXED OFFLINE (`99f5090d`, docs/bedrock-interactivity.md
  "Door 3's tap and Door 2's pockets"; sim regression `door3-tap-10326` OK).
  The device spot is INSIDE an invisible collider band (`collider_w10`, the
  bounding box of a handrail tilted 42.7 deg over the corridor); the runtime
  now skips a form the player's own box stands in. Packs at `99f5090d`:
  `.claude/worktrees/agent-aa7e8ea0c704eedba/output/door-tap-0930/packs-99f5090d/`
  (10326 with the round's source + label; 8/8 `_mcaddon_check` OK).
  Device-only: the same tap (feet 5384.6,-59.8,5382.4 by /tp, look at
  5386.5,-58.8,5382.35) opens; and walk the corridor by stick to see where
  the head meets the band (expect z ~5383.05).
- [ ] Tilted-part colliders: FIXED OFFLINE (`1a21dd38`, docs/bedrock-interactivity.md
  "Tilted parts are laid from their own box"): a TILTED cuboid is laid from its
  oriented box, a yaw-turned one keeps its AABB (exact-for-all measured and
  rejected: 76435 reach 415.9 -> 303.2). Favourites: reach @100 20,081 -> 20,819,
  rooms 648 -> 708, 3 SEALED -> OK + 2 SEALED -> STEP, 0 OK regressed, sim
  child play 0/200 fail (base 5/200 under the exact drawn reading). Packs
  (round sources + labels, 8/8 `_mcaddon_check` OK; regressions 13 OK +
  overhang not reproduced): `.claude/worktrees/agent-acc3de06ad386c5b6/output/tilted-colliders-0930/packs-1a21dd38/`
  (10326 sha256 5a2a6441...). Device-only: walk the corridor to Door 3 by
  stick - expect the head clear under the handrail to z ~5382.3 (x 5384.3-5385.8),
  where round 30h stopped at ~5383.05; Door 3 tap from there.
- [ ] `TODO(tilted-colliders)` follow-ups: (a) a yaw-turned cuboid's walls laid
  exactly while keeping the tops a climb uses - exact-for-all unlocked 19 more
  doorway rows (21318 D1-2, 11371 D6, 42670 garage, 76417 D1); (b) the sim's
  `heightOverDrawn` still reads a turned cube's corner box (10788 slide limit).
- Tap widening ACCEPTED under the standing rule (prefer interactivity):
  from CLIPPED spots 4,955 pairs flipped refused -> accepted (4,680 inside
  drawn geometry); free standing spots identical (3,697 before and after).
- [ ] 10326 Door 2 pocket: now flagged offline as SHORT-APPROACH (east side,
  room 1.98 < 2.25; `_ix_passability` at 100 % only, verdicts unchanged).
  Favourites with it (at `482a1fbe`): 10326 D2, 11371 D7, 31141 D5, 42639 D2,
  42670 D1, 60380 D1, 71040 D2, 76435 Gate 1, 910032 D3 (only 10326's
  device-seen). Favourites export at `482a1fbe`:
  `.claude/worktrees/agent-aa7e8ea0c704eedba/output/door-tap-0930/fav40-482a1fbe/`.
  The pocket is the model's display cases; no pack fix planned.
- Doors 2 and 3 are INSIDE (turned 90 deg), not on the back wall; Door 1 is the
  back face's only doorway.
- Pixel still needs a hand (see 30g below).

## Round 2026-09-30g (`c73c545a`) - access stairs, cockpit seats, sim fold

**Sent** (zip, not deployed yet): `output/device-round-2026-09-30g/craftmatic-packs-c73c545a.zip`
(sha256 c38344709432b514f8c9b8f48ac117ede3766d38746ad7daab30466528b6b409;
23 packs, same set list and labels as 30f; `check.txt` 23/23 OK, uuids =
30f). Sim on these packs: regressions 11 OK (incl. `door1-10326` now
walks in by the stair, `cockpit-occluded-42639`) + gabby-car-overhang not
reproduced as before; `--scenario=hop` passes.
Device round 2026-09-30 (Saga complete; Pixel lost adb at 15:13 after item 1;
evidence `output/device-round-2026-09-30g/{pixel,saga}/_notes.txt`): 10326 Door 1
stair PASSES on both (y -60..-57 by stick only, in and out; door exactly 6.0
further from the corner = the margin); hop PASSES on the Saga (front car in 3/3,
no flash, cloud hovers then fades); 60380 / 42172 / 7140 / 60221 cockpit OK;
Saga content log 0 errors / 0 FIGURE_RETAKE / 0 fly.
- [ ] 76286 cockpit in the hull and 42639's side panel: FIXED OFFLINE
  (`8b765dbd`, `8aa1425c`; section "Cockpit fallback" at the end). Device
  check of the next round's packs still open.
- [ ] 10326 back doors: FIXED offline (`74209454` + `b5fbebde`, docs/bedrock-interactivity.md
  "The museum's back doors"). Plain `60616` read Studio's foot-origin stub, so
  Doors 1-3 hung a door height over their own ground-floor frames; now read as
  `60616a`: Door 1 stands in the white-arched frame, no access stair or margin,
  Door 2 ONE-WAY -> OK; the handle studs no longer float 0.9 block off the leaf.
  Round packs at `3dc93bca` (same labels/uuids, 22/22 `_mcaddon_check` OK):
  `.claude/worktrees/agent-a83a9ff783672ba04/output/museum-entrance-0930/round-3dc93bca/`;
  sim regressions 10 OK + gabby-car-overhang not reproduced; 10326 child play 5/5.
  Device-only: tap/swing/walk in at the ground door (both phones), Door 2 both
  ways, the knob/stud on the leaf, the museum placed WITHOUT the 6-block margin
  (it sits 6 nearer the pinned corner than in 30g).
- [ ] 10303 (Saga, 6 laps): first-drop one-frame jump 6/6; loop-1 exit swing
  5/7 (30f: 1/5). Camera work, device-measured.
- [ ] Hop: 0.5-0.9 s of vanilla "Sneak to get off" before the coaster HUD.
- [ ] PIXEL NEEDS A HAND: wireless debugging off/rotated (re-enable + re-pair);
  left in world 924 unsaved at 5490,-60,5480 with the wand, coordinates ON
  (was off), 10326 undone; `/sdcard/r30g-stairup.mp4`, `/sdcard/r30g-stairdown.mp4`
  and 23 `/sdcard/Download/000-*.mcaddon` to delete one by one; then delete
  `output/.phone-lock` (kept with a note). Saga: 9 older deploy staging dirs
  in `/data/local/tmp/craftmatic-deploy-*` (file by file only).
- Phones rule learned: LAN games from other devices list FIRST in the worlds
  screen - never tap the first tile; pick world 924/925 by NAME (30g's Saga
  flush may have joined "stonecraft party" for ~55 s).

## Round 2026-09-30f (`dc699e3e`) - hop, collision x-mirror fix, 42639 + 60380

**Sent** (zip, not deployed yet): `output/device-round-2026-09-30f/craftmatic-packs-dc699e3e.zip`
(sha256 cb71547462e6dfe4799eae618289b8d790c832a1b237e8a2b9ed6e5a2bd8bc91;
23 packs = 30e's 21 + 42639 `Andrea's Modern Mansion (42639-1)` + 60380
`Downtown (60380-1)`; `check.txt` 23/23 OK, uuids = 30e, parts = 30e).
Build: `bash output/device-round-2026-09-30f/build.sh`, check:
`python output/device-round-2026-09-30f/check.py <packs> <creator>`. The first
30f build (`stale-premirror-*`, 09e2e8a4) predates the x-mirror fix: never ship it.
Sim on these packs: regressions 10 OK / 1 not reproduced (gabby-car-overhang,
as before); `--scenario=hop` (10261 + Nimbus, 10788 + 42639) all pass.
Device round DONE 2026-09-30 (Pixel + Saga, 23/23 bound, content logs 0
errors / 0 FIGURE_RETAKE / 0 fly lines; evidence `output/device-round-2026-09-30f/{pixel,saga}/_notes.txt`):
hop works (cloud onto 10261's lift-hill train and a 18.9 b/s train into a
hovering cloud both seat the front car; empty cloud hovers; no flash, 1-2
frames through the painted riders' heads; 10797 slide into its parked car ->
driver seat, drove 50 blocks); 60380 driver view OK; clearance after the
x-mirror fix: no invisible walls / pass-throughs (10326 D1, 41732 D3, 76457
D3); 10261 kiosk seated, no retake line; Nimbus 10.55 b/s at 0.0725.
- [ ] 42639 COCKPIT view: fixed offline (section "Cockpit view" at the end);
  device check of the next round's pack still open.
- [ ] 10303: a one-frame jump at the bottom of the first drop EVERY lap (the
  loop-1 ENTRY handover, under the car -> behind it); the loop-1 exit swing
  1/5 (0.17 s to the car's side). Saga.
- [ ] Hop device gaps: a full train (needs a second player), which seat a
  rider takes when seat 0 is held, 10788 + 42639 slide foot; the Saga not run.
- [ ] Cars coast ~2.5 b/s per s after the stick is released (16 b/s -> 70
  blocks to stop, `pixel/car-coast-cmvt.txt`): judge for a 5-year-old.
- [ ] Leftover on the Saga: deploy staging dir
  `/data/local/tmp/craftmatic-deploy-20260930-111450-114536` (delete file by
  file only, never recursively).
- Next round carries the access steps (`a806594b`, not device-proved).

## Round 2026-09-29c (`e2c21112`) - faces closed, Gabby play, kiosk retake, Nimbus

**Sent**: `output/device-round-2026-09-29c/craftmatic-packs-e2c21112.zip`
(sha256 cc9919f74d517725da7d9a22e87a02bdec4e423ab987f3fa15d525d5a3b15728;
19 round packs + `nimbus-fixture.mcaddon` + creator, `pack-hashes.tsv`
inside). Built one at a time from clean main (stamp `6ebcce855fd2`), faces
`output/faces-art-0926`. `check.txt`: 21/21 `_mcaddon_check` OK, every
uuid = 29b's (`uuid-proof.tsv`), parts = 29b's except 10788 (the lift car is
now the 1-part platform 3863; the old 12-part cap is back in the shell - the
intended change). Render faults <= 1.9 block faces (11374 worst, as before);
passability 100 %/rot 0: 22 OK, 6 SEALED, 0 FAIL.
- [x] Pixel (`pixel/`, `_notes.txt` indexes 171 files): deployed
  `--exclusive`, 21/21 bound, content log 0 errors / 0 overridden. Figures
  CLOSED: 10261 fig6 front/side/chin at 1.7-2.2 blocks, walking, 76417
  fig10, 41732 fig2, seated (kiosk fig2, coaster riders), idle head turn -
  no gap on any figure looked at. Kiosk fig2 RETAKES its own seat (yielded at
  2.2 blocks, player sat, walked 4.6 away, seated again at the seat's own
  position after 10 s; the success path logs no FIGURE_RETAKE line). Nimbus:
  orbit, tap-train summon, fly 13.7 mph, climb, dismount (descend not
  testable by adb). 10788 lift: tap boards, floors 2, 3, back down. Undo
  left nothing.
- [x] 10788 slide seat not tappable: FIXED and merged `16d4bc82` (a touch
  tap is a hit; `board()` seats a tapped ride seat; pick box 1.0 x 0.6) -
  details under "User report 2026-09-29". Floor 3's west room holds (the
  probes were under the slab / in a wall band). Device tap unproven.
- [x] Round 29d BUILT from `3abc14f7` (every merge of the day):
  `output/device-round-2026-09-29d/craftmatic-packs-3abc14f7.zip` (sha256 in
  the `.sha256` beside it; `pack-hashes.tsv` inside; `check.txt` 21/21 OK,
  uuids = 29c's, parts = 29c's).
- [x] Pixel 29d (`29d/pixel/`, `_notes.txt`; content log 0/0): 10788 SLIDE
  BY TAP boards from inside the top room and from outside the west wall
  (the chute is 2.4 blocks / 1.26 down by construction); lift tap boards;
  Nimbus: no "could not take its seat" line, remount hint ~3.0 s, cruise
  MEASURED 13.1 blocks/s at 0.09 (not 11.5: v ≈ 120·fs + 2.3, so
  `FLYER.FLYING_SPEED` is now 0.0725 for ~11, to confirm); figures closed
  (fig6 front/side/chin, seated fig2). The `fly` log lines were solved
  by the Saga A/B (below) and shipped in `7591ccc1`. Pixel wand
  recipe: a crosshair tap never fires itemUse; re-select the wand (hotbar
  2 then 1) to open the menu; screenshot before every menu row tap.
- [x] Nimbus fixes re-checked on the Pixel (`output/nimbus-pixel-0929/`,
  `_notes.txt`; pack from `a754a7de`, content log 0/0): hint shown 2.75 s;
  HUD 85.7 mph vs 85.9 true (CMVT cadence 4 ticks, server 38.3 blocks/s at
  `flying_speed` 0.3 - no bursts on 26.51); look down + Jump dives ~4
  blocks/s (climb ~22); float-down 89 blocks in 11 s, "Floating down",
  unharmed (was a 229-block drop); tap while riding ignored; orbit still
  running after 47 min; Undo clean. Look pitch cannot be dragged by adb -
  the agent mounted a parked cloud after `tp ... 90 45`.
- [x] Nimbus follow-ups MERGED `3abc14f7` (2,827 tests): `FLYER.FLYING_SPEED`
  0.09 (~11.5 b/s by proportion, to be re-measured; rotor keeps 0.3), the
  remount hint (`riderId` cleared when empty), seat `addRider` retried twice
  before any message (orbit seats silent), the `fly` sound entry moved to
  `interactive_sounds.entity_sounds.entities.<id>.events.fly.default: ""`
  (the `entity_sounds` one measured useless; `TODO(fly-sound)` lists the
  next A/Bs). Device items: the section "Nimbus follow-ups after the Pixel
  re-check" at the end of this file (29d Pixel round covers them).
- [x] Saga 29c (`saga/`, 419 MB; `tools/` has place.sh + findbtn.py):
  deployed `--exclusive`, 21+21 bound, content log 0 errors / 0 overridden.
  Faces CLOSED (10261 fig6 front/side/back/chin height, walking; 76457
  fig1/5/8/10 diagonal; fig10's sweater shows grain shading bands, not
  holes). Kiosk fig2 yields and RETAKES (`RETAKEN` probe). Gabby: lift
  1→2→3→2→1 with side exits (tap boards at floor 1 only - see below);
  slide "Wheee!" 2.4 blocks; 10797 cockpit sees ahead, no fall-through in 4
  drives (but `[BLOCKED: BACK UP]` at the room edge from 3 sides - approach
  or base plates, not investigated); 10796 cockpit sees ahead; 11204 slide;
  10786 boat aground as expected. 10303 loops pitch over; the 29b exit cut
  NOT reproduced (n=1 lap). Undo left nothing, incl. ridden cars.
- [x] Saga 29c doorway defects MERGED `c4c34b1c` (2,842 tests; details in
  the doors section at the end of this file): (A) 10326 Door 1's drop is the
  MODEL's - the door sits 2.6 blocks above the base plate with nothing drawn
  in front; the harness had passed it on a tread laid on a wall rim, now
  removed, and walks each leaf column printing HOLE. (B) 910004 Door 3 is the
  model's too: 1.25-1.75 blocks of headroom inside (a platform under the
  upper floor); the harness now says SEALED. (D) a `craftmatic:fig_seating`
  mark stops the retake runtime while the placement is still seating.
  Only verdict change in 116 rows: 910004 Door 3 OK/STEP -> SEALED.
  - [x] Decided 2026-09-30 (user): KEEP 10326's invisible 1-block ledge.
    Standing rule: prefer the option that unlocks exploration/interactivity.
  - [ ] Device: 10326 Door 1 walk-out onto that ledge; 41732 Door 3 both
    ways; a 10261 placement with no FIGURE_RETAKE line.
- [x] Saga 29d (`29d/saga/`; content logs 0/0 in all 12): 10788 slide by
  TAP from inside the top room and from outside; lift boards by tap on
  floors 1, 2 AND 3 (29c's floor 2/3 failures gone; from inside floor 2's
  room the platform is behind colliders - not reachable, by design?);
  Nimbus: no false seat line, remount hint 3.0 s, dive, float-down (also in
  survival: all hearts), cruise 12.5 blocks/s at 0.09 (Pixel 13.1; HUD
  matches true); 10261 fig6 closed; no FIGURE_RETAKE line.
- [ ] 10303 loop-1 exit swing on the Saga is INTERMITTENT: 4 of 6 laps
  (29b 3/3, 29c 0/1): behind -> side -> FRONT -> side -> behind in 3-4
  frames at y -47/-48. Suspect the hand-back's first `setCamera` yaw vs the
  `over` chart's end (`bedrock-coaster.ts` `COASTER_RIDER_VIEW`); measure
  with camprobe before changing. Device-only (the sim does not model the
  camera).
- [x] Fly-sound A/B on the Saga (`output/fly-sound-ab-0929/saga/`): variant A
  (`interactive_sounds.block_sounds.normal` = vanilla's events + `fly: ""`)
  and C give 0 lines in every window; B (a silent sound definition) 404/min
  flying, no better than baseline. Content log flushes on HOME, not on Save
  & Quit. -> shipped in `7591ccc1`.
- [ ] The user's own look at the rebuilt figures and the Gabby sets.

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
- [ ] Device round after the faces merge (both phones, same labels as 29b so
  every uuid holds): the faces fix, the kiosk retake `46e855f1`, the Gabby
  play fixes, and the Nimbus fixture; send ONE zip.
- [x] Gabby cars' view, the 10788 slide and lift: fixed in `377850a5`, MERGED
  to main `e8cb009b` (gates green, 2,761 tests), device-checked on the Saga, world 925, packs
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
- [x] 29c Pixel: the 10788 slide seat could not be boarded by a TAP (three
  taps, `/ride` ran it): a touch tap is a hit and `rides.js` boarded only a
  lift's car on one; `board()` now seats a tapped ride seat too, and the
  seat's pick box is the chute's width (`RIDE_SEAT_TAP_BOX` 1.0 x 0.6).
  Host test pins the Pixel's seat point inside its `collider_w6` cell.
  Colliders were never in the way (`selection_box: false`); idle points
  unchanged in all six slide sets. Floor 3's west room HOLDS the player:
  the probes were 0.19 block under the slab's top / in the front wall band /
  outside the west wall; 105/105 offline drops rest on the floor.
  Evidence + rebuilt pack (label unchanged, uuid holds): `output/gabby-fix-0929/`
  (`_notes.txt`; `10788-gabbys-dollhouse.mcaddon` sha256 b7d86ce4b6f1…5efba at
  `4ced924f`; guide "The slide's seat could not be boarded"). Regression: the
  8-set sweep before/after identical in rides, validity and passability.
  - [ ] Device: tap the top of 10788's slide from inside its top room (stand
    at model 12.5,9.25,4 = the round's 5580.5,-50.75,5608) and from outside;
    the pick on the widened box and the tap boarding are host-only so far.
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

## Headless Bedrock simulator (2026-09-29, user-approved)

- [x] Walk preview at 90/180/270 drew every actor facing the wrong way since
  4ceb3c42 (`QuarterTurn` is degrees; the preview multiplied it by 90 again).
  Fixed `ad751582`, browser-proved on 10788 + 10326 at all four turns
  (coverage 1.000, 30/30 holder yaws; `output/walk-preview-yaw-0930/fixed/`).
  Unchecked: the sitting camera's sign and a `door` leaf's swing direction.
- [ ] `TODO(sim-gametest)`: the one `@minecraft/server` mock left is
  `test/gametest-pack.test.ts`'s fake `@minecraft/server-gametest`. The
  simulator needs that module (registerAsync + builder, `Test`, a
  `SimulatedPlayer` with steering for `moveToLocation`) so a GameTest pack
  and the sim run the SAME scenario definitions; the member list and counts
  are in docs/sim-engine.md "The GameTest and the simulator".
- [ ] `TODO(walk-pack-blocks)`: `WalkWorld` (addon-walk.ts) reads the CURRENT
  collider kit's block JSON; a pack built before the x-mirror fix ships other
  definitions. Read the pack's own `blocks/*.json` when walking an old pack.
- [ ] `_ix_tap_probe` on 10326: "closes" fell for Doors 2-6 (e.g. 14 -> 12)
  once the probe's player became a real occupant; inferred (the runtime's
  "someone in the doorway" check refuses the spot the player stands in), not
  traced per spot. No test asserts "closes".

Goal: catch most bugs in minutes without an adb round; long term it grows
into a standalone web game engine (user: "Keep it modular and DRY"). Of 14
device-found defects on 09-29, ~9 were our logic and simulator-catchable.
A worktree agent is building `web/src/sim/` (world, entity components from
the pack JSON, physics from `addon-walk.ts`, one mock `@minecraft/server`
running ALL pack scripts together, measured touch input: tap = ray + hit,
quirk registry with evidence, scenario DSL + invariants, craftmatic
child-play adapter, `scripts/sim.ts`, `docs/sim-engine.md`).
- [ ] Acceptance: the regression set reproduces on the OLD packs and passes
  on new builds - 29b Gabby slide on rails / lift car / 10797 fall-through /
  eye in bodywork; 29c slide tap; Nimbus sneak drop + hint overwrite; 29d
  10326 threshold + 910004 approach wall (still failing on main until the
  doorway agent merges); the spurious 10261 retake line.
- [ ] Then: the unmodelled-API ranking (the roadmap). The test hosts,
  interactive-walk's world and figure-life-sim are folded onto the simulator
  (2026-09-30, docs/sim-engine.md "The older hosts, folded").
- Regression gate on `output/device-round-2026-09-30f/packs-dc699e3e`:
  `door1-10326` reads FAIL (reproduced, the model's) because those packs
  predate the access stairs (`373445c7`), which the case now expects; the
  same verdict at `a806594b`. The other nine as before.

## Quirk probe on the Pixel (2026-09-30, worktree `agent-adebef11c6236a71d`)

`bun scripts/_gametest_quirks.ts --out=<dir> [--tests=quirk_tp,quirk_dismount,quirk_dismount2,quirk_bands,quirk_reach]`
builds a standalone GameTest pack (not a model pack); run it with
`QUIRK_TESTS=<n> python -u output/gametest-quirks-0930/_run_quirks.py <probe.mcaddon> <run> output/bedrock-entity-qa/device-backups/20260930-095611`
(the last argument holds cmgametest's ORIGINAL bindings, `c2e08f53` /
`2193775f`, restored after the run). Evidence `output/gametest-quirks-0930/run1..3/`
(`_summarise.py <run>` tabulates). Quirk rows: `teleport-into-floor`,
`dismount-free-spot`, `tap-is-hit`, `hold-is-interact`, new `block-collision-x-mirrored`.
- [ ] **Every pack built before `0605e0a3` has its x-banded clearance forms
  on the wrong half of the block** (Bedrock mirrors a block collision box's
  x; device-proved, and the fix device-proved in run 3). Rebuild and
  redeploy the round's packs before the next device round; walls that
  "leaked" or doorways that stopped a player 0.5 early in x may be this.
  Re-run `_ix_passability.ts` / favourites sweep on fresh builds (the
  offline tools read the kit, so their verdicts do not change; the
  device's do).
- [ ] Dismount order past (0,-1), (0,+1), (+1,-1), (+1,+1), (-1,+1) and the
  exact floor window: `TODO(dismount-order)` / `TODO(dismount-floor)` in
  `web/src/sim/physics/systems.ts`; a MOB rider's spot is unmeasured.
- [ ] A phone player's own touch pick reach and a real sneak cannot be
  produced by GameTest (simulated `isSneaking = true` does not dismount);
  both stay assumed (tap pick 5, sneak = stop_riding's spot).
- Left on the Pixel: the probe's imported BP/RP folders under
  `behavior_packs/Craftmatic(8)` and `resource_packs/Craftmatic` (adb cannot
  delete there without root), unbound from every world.

## New-set onboarding + 11390 (2026-09-29)

Infra is in (sources guide "Onboarding ONE announced set"): clego
`python discovery/new_set.py <sku> --run` (ladder + harvest/grade/lift/publish,
exit 0/3/1; lift proved on 40900: entry byte-equal to live, nothing else
moved, ~5 min), craftmatic `bun scripts/new-set.ts <sku> --commit --browser`
(live index + models, index commit, Chrome deep-link render via
`_live_set_check.mjs`, pack + gates + zip), `scripts/new-set-watch.ps1 <sku>`
for `schtasks` (hourly; lock + DONE; one run for 11390 exited 3 as designed).
No other new set to test on (2026-09-30): DBIX skulist 1,961 = held 1,961
(`dbix_refresh.py --check`: NEW 0), and a direct probe of the 160 unheld
2025-26 sets of 150+ parts in Rebrickable (clego
`python discovery/probe_recent_unheld.py`, `3cfc590d`; method checked on
40900 = 5 served) found 0 served. Re-run both weekly until 11390 lands.
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
- [x] Nimbus rig MERGED `fa7a0a11` (gates green, 2,799 tests, physics spec
  current): `flyer` motion (native rotor controller, cloud-styled, bob),
  `engine/set-canon.ts` (11390: cloud mount, companion orbit; THE per-set
  hint table), `engine/bedrock-flyer.ts` (mount detector, orbit path, summon
  runtime `scripts/flyer.js`: tap Goku → your own cloud 1.5 blocks ahead,
  mounted at once; empty clouds fade after 1,200 ticks; cap 8), orbit ride
  kind in `bedrock-rides.ts`, fixture `test/fixtures/nimbus-fixture.ldr`
  (298 real parts), GameTest `flyer_<id>`, guide "Flyer mounts and
  companions". Sweep of 8 sets unchanged. Pack from main:
  `output/nimbus-main-0929/nimbus-fixture.mcaddon` ("Nimbus found, 26 parts,
  100 percent cloud colours").
- [x] Nimbus on the Saga (`output/nimbus-saga-0929/`, pack from `fa7a0a11`,
  world 925, 100 %): orbit closed at 3.0 blocks/s (13.3 s lap) and 0.79 of
  the pillar, figure seated for 15+ laps, no jitter; tap → white puff, cloud
  1.5 ahead, mounted at once, seated ON TOP (1st + 3rd person); forward =
  look, Jump climbs ~20 blocks/s, hands-off holds, Back+Jump descends; empty
  cloud fades at 58-61 s; cap 8 holds (8 born in one tick + a tap → 8);
  tapping Goku never mounts his cloud; Undo leaves nothing; content log 0
  errors. Sounds unverified (no audio capture).
- [x] The five Nimbus defects FIXED and merged (`a754a7de`, 2,821 tests):
  (1) look down + Jump dives (`FLYER.DIVE_PITCH_DEG` 25; the descend group
  only acts on Jump, so a pitch-only dive is not possible on a native mount;
  HUD/README say so); (2) a player who leaves a flyer more than 2 blocks up
  gets `slow_falling` 30 s + "Floating down" (10-tick poll; no dismount event
  in @minecraft/server 2.9); (3) ride hint "NIMBUS! Jump climbs, look down +
  Jump dives, sneak gets off" for the first 60 ticks of every ride; (4) HUD
  speed = mean over a 20-tick window of MOVED positions (client mounts move
  in bursts), teleports > 5 blocks ignored; (5) RP `sounds.json` with
  `fly: ""` for every hovering entity (rotor, flyer, scripted vehicles),
  gated by `_mcaddon_check.py`.
- [x] Nimbus fixes re-checked on the Pixel (`output/nimbus-pixel-0929/`):
  dive, float-down, hint and HUD speed measured good; the `fly` line was
  not silenced (details under "Round 2026-09-29c"). Follow-ups merged
  `3abc14f7`; round 29d carries everything. Still to do: the Pixel GameTest
  `flyer_<id>` and the cruise re-measure at 0.09.
- [ ] When the 11390 file lands: `new-set.ts 11390`; if the export warns
  `Mounts ... NOT found: <reason>`, the reason names the threshold (colour
  code → `MOUNT_STYLE_COLOURS.cloud.codes`; parts → `FLYER.MOUNT_MAX_PARTS`).
  If two figures stand on small builds, add a `figure` hint to the canon.
- [x] Minifigs with unclosed faces: Bedrock does not draw a box-UV side face
  whose DECLARED height floors to 0 (Pixel probe); every figure's 0.6-unit
  grain lost 13-24 % of its visible surface. Fixed (`f706452e`,
  `boxUvSafeCube` size + 2 / inflate -1, cube count unchanged; cull kept within
  a rig bone: +822 cubes over 85 figure entities). Rebuilt round packs
  `output/fig-faces-0929/packs-f706452e/` (worktree `agent-a173ac725…`) are
  bound in world 924; before/after on the Pixel in `output/fig-faces-0929/pixel/`
  (`fig6-*-before-after.jpg`). Guide: "Unclosed faces: Bedrock floors a box-UV
  cube's size". Open: (a) shells/vehicles/props box-UV safe since `6980474e`
  (user-shots triage 2026-10-01): a device look at a shell is still owed; (b) 1-2 LDU² head/hair slits on 5 figures (10797,
  11204, 42703 fig4, 76286 fig2, 10365 fig8), diagonal views only; (c) the user's
  own look at the rebuilt figures. MERGED to main after the Gabby and Nimbus
  merges (gates re-run on main).

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

## Nimbus follow-ups after the Pixel re-check (worktree agent-a666ee99b, 2026-09-29)

The Pixel re-check (`output/nimbus-pixel-0929/_notes.txt`) passed the hint,
the HUD speed, the dive and the float-down; four follow-ups are fixed here,
tests first (`test/vehicle-driver.test.ts`, `test/placement-seating.test.ts`,
`test/nimbus-fixture.test.ts`, `test/playable-addon.test.ts`), evidence
`output/nimbus-fix2-0929/`. Add-on guide, "Flyer mounts and companions",
"Pixel re-check"; physics spec §4.6 and §9.
- [x] Device (Pixel + Saga 29d): cruise 13.1 / 12.5 blocks/s at 0.09 -> now
  0.0725 (re-measure next round); remount hint and no false seat line PASS.
- [x] `fly` lines: SOLVED - `interactive_sounds.block_sounds.normal` =
  vanilla's events + `fly: ""` (Saga A/B: 0 in every window), shipped in
  `7591ccc1` for every pack with an entity; per-entity entries removed.
  Unknown: whether the key replaces or merges vanilla's (`TODO(fly-sound)`).

## Doors fix after Saga round 29c (worktree `agent-a9d41e0a221ddc20b`, 2026-09-29/30)

Commits `cb8e851a` (the first agent's WIP) + `db994f40`, `448fc3db`,
`df580c19`. Findings: `docs/bedrock-interactivity.md`, "The doorway's floor,
a floor's top, and the device's line". Evidence: the worktree's
`output/doors-fix-0929/` (probes in `tools/`) and `output/doors-fix-0929b/`
(`packs-448fc3db/` = the 29d round rebuilt, `verdicts/*.json` + `verdict_diff.py`,
`trace_door.ts`, `trace_line.ts`, `sweep/`). Gates at `df580c19`: both
typechecks, `bun run test` 2822 passed / 31 skipped, physics spec current,
passability 0 FAIL (4 rows changed, all 910004 Door 3 -> SEALED), sweep 6/6
with `_mcaddon_check` valid.
- (A) 10326 Door 1: the device's fall is the model's (door 2.6 over the base
  plate at the model's front edge, no steps in the source; the threshold is
  intact in every pack). Fixed: the phantom tread the walk stood on.
- (B) 910004 Door 3: the model's (platform under a 1.56-1.75 ceiling); SEALED.
- (D) FIGURE_RETAKE_NO_SEAT: `craftmatic:fig_seating` mark from spawn to the
  placement's seating pass. Probably also the "figure 4 could not take its
  seat" line (the runtime's retake seating fig4 before the placement's pass
  did): not proved, the reason text was not captured.
- [ ] Device: 10326 Door 1 walk-out at x 10.67 (expect the new invisible
  1-block ledge at the doorway's level, then the model's edge), 41732 Door 3
  both ways (stoop kept), 10261 placement: no FIGURE_RETAKE_NO_SEAT in the
  content log, the kiosk figure seated.
- [ ] 10022 Door 1 reads OK at 150/200 % via a ledge on the car's side
  (main: ONE-WAY); not judged against the model.

## Headless Bedrock simulator (2026-09-30, worktree `agent-ab277014785c1263d`)

`web/src/sim` + `bun scripts/sim.ts`, guide `docs/sim-engine.md` (tiers:
validators -> simulator -> GameTest -> short tap round). Loads a built pack as
shipped, runs ALL its scripts unmodified against a `@minecraft/server` mock
(unmodelled API recorded, never passed), plays a child's session with
invariants. Commits `22cf0417`..`19a91eae`; gates at `19a91eae`: both
typechecks, physics spec current; `bun run test` 2845 passed / 31 skipped at
`a641f6a4` (sim suite `test/sim-engine.test.ts` 23 + the placement host's 287
re-run after the last fixes). Evidence `output/sim-regress-449abd0e/`
(regression packs built from `449abd0e`, `regressions.md|json`) and
`output/sim-favourites-449abd0e/` (40 favourites, `child-play.md|json|log`,
`child-play-summary.txt`).
- Regression set (`bun scripts/sim.ts --scenario=regressions --new=<dir>`):
  9 of 10 reproduce on the packs the device ran and pass (or, for the two
  doors, reproduce attributed to the MODEL) on current builds. Not
  reproduced: 10797's car under an overhang (the Saga's overhang is not
  recorded; neither the model's overhangs nor a fixture of the host test's
  geometry made the old ground scan fail).
- Favourites child play triaged (2026-09-30, worktree `agent-a92b1e56f92bc2094`,
  commits `e7355bff`..HEAD; evidence `output/sim-triage-0930/` in that tree:
  `base-sim-on-base-packs.json` = before, `final-child-play.json|md` = after,
  `probes/` the scripts). Before 144 pass / 56 fail, after 197 / 3 (packs
  built from `4db40e56`, the three ride packs from `72c8c619`; `_ix_passability` 0 FAIL, 40/40
  `_mcaddon_check` OK). Classes and fixes in docs/sim-engine.md "Doorway
  attribution" and the commit messages. Open:
  - [ ] 29d set rebuilt (`packs-29d-rebuild2`): 10797 slide set-down still
    0.18 inside `collider_f9`; 11204 slide 0.443 over the drawn chute (not
    the run-out: check its frame like 42652's); 10796 slide 0.206 (limit 0.2,
    `TODO(sim-slide)`); 10796 car_2 driven ~100 blocks off stays after Undo
    (Undo sees loaded entities only); 10796 cars 13/15 and 10/15 views.
  - [ ] Device-only: `teleport-into-floor` (29d Pixel read y -56, not the slab
    top: a GameTest teleporting 0.2-0.4 into a slab settles it) and
    `dismount-free-spot` (assumed).

## Hop (2026-09-30, worktree `agent-a67a945e8cc86f24a`)

Fly or drive into another mountable and ride it (user request for the
5-year-old). One runtime, `web/src/engine/bedrock-ride-hop.ts` ->
`BP/scripts/hop.js` in every pack with a driveable; slide set-downs in
`rides.js`; coaster cars carry train/rank tags; a scripted plane left by a
hop hovers (`VEHICLE_DYNAMIC.hold`). Design: physics spec §4.8, add-on guide
"Hop", sim-engine "Hop". Commits `c7c20023`, `d16ef785`, `196360e2`.
Evidence `output/hop-0930/` in that worktree: packs `packs-196360e2/`
(11 sets, one at a time, clean stamp), `mcaddon-check-196360e2.txt` (11 OK),
`hop-196360e2.log|json|md` + `hop-10797-196360e2.*` (4/4 pass),
`regressions-196360e2.*`, `childplay-196360e2.*`, `hop-census-196360e2.txt`,
`gametest-nimbus-196360e2/` (flyer GameTest with the hop phase), `tools/`.
- Offline: `test/bedrock-ride-hop.test.ts` 11 pass; Nimbus into 10261's
  train at 17.6 blocks/s met car rank 1, seated in rank 0, coaster camera
  next tick, cloud moved 0; full train flown through; 10788 + 42639 and 10797
  slide into a parked car; 0 unintended hops in 11 packs' child play.
- Regressions on the hop packs: every case OK, `door1-10326` now expects
  `pass` (ledge kept by the user 2026-09-30).
- [ ] Device: Nimbus (or a plane) into 10261's moving train: which car
  seats the child, whether the coaster camera takes over without a flash,
  the cloud hovering where left; a car at 10797's slide foot. Quirks
  assumed: `rider-seat-order`, `add-rider-after-eject`, `aabb-is-collision-box`.
- [ ] GameTest `flyer_<id>` now records `hop` (second cloud swept through
  the first); run it on the Pixel (`cmgametest`).
- [ ] 10788 + 42639: the car parked at the slide foot cannot drive out (the
  slide ends on an upper floor); a model question, not the hop's.

## Access steps (2026-09-30, worktree `agent-a44a9ee098a094474`)

Invisible half-block stairs up to doors hung more than a jump over the
ground, straight out or turning along the facade, with the grid widened past
the model's edge where a raised door faces out (at most 7 blocks, dropped
again when no stair uses it). Design and numbers: docs/bedrock-interactivity.md
"Access steps". Commits `373445c7`, `0de83c83`, `7f7723fa` (+ docs). Evidence
`output/access-steps-0930/` in that worktree: `sweep-base2/` (base `dc699e3e`,
built from an archive of the base tree in `base-src/`; `sweep-before/` is
CONTAMINATED - mixed builds, ignore) vs `sweep-after3/` (`7f7723fa`),
`pass-base.json` / `pass-after3.json` + `verdict-diff3.txt`, `stairs-after3.txt`,
`unreached-100.txt`, `sim-base.*` / `sim-after3.*`, regression packs
`packs-7f7723fa/` (6 packs, round labels, `_mcaddon_check` 6/6, `regressions.md`:
every case OK, `door1-10326` now `pass`), probes in `tools/`.
- Passability (40 favourites, 100-400 %, turns 0/90): OK rows +2/+2/+2/+3/+4,
  ONE-WAY 2->0 at 100 and 150 %, STEP 13->10 and 14->10 at 300/400 %, 0 FAIL,
  no OK row worse. 41395 Door 1 ONE-WAY/STEP -> OK at every size.
  Child play 198/200 before and after (same two driver-view fails).
- [ ] Device: walk up 10326 Door 1's stair on the round's pack
  (`packs-7f7723fa/10326-natural-history-museum.mcaddon`: 6 treads straight
  out of each leaf column, the model 6 blocks in from the pinned corner) and
  41395 Door 1's (margin 3 at low x); a turning stair (42663 Door 1, 31141
  Door 2's back); a scaled threshold climb at 150-200 % (31141 Door 2 front).
  Half-block invisible risers and turning on one are unproven on both phones.
- [ ] Figures may now roam down a stair into the margin (their area is the
  widened footprint): watch a 10326 placement for figures outside the model.
- [ ] `TODO(access-steps)`: no stair for a door whose INSIDE floor is out of
  reach (the outside-only flood refuses it); the margin is decided from the
  scene's door leaves only (a brick-built door is never widened for).
- 26 doorways stay not OK at 100 %/0 (`unreached-100.txt`): the model's
  geometry either side, diagonal leaves (off-axis), 42663's van, 910004 Door
  3's headroom, 71043's microscale doors - the 2026-09-29 causes; report,
  do not hack.

## Cockpit view (2026-09-30, worktree `agent-a3760e662cc5224f1`)

42639's cockpit view (Pixel 30f, two thirds its own teal body). Root causes
and the rule: add-on guide "The driver's eye sees the road ahead". Commits
`f35cd5c5` (registry quote escape, same as main's `1a119917`), `9759f0bf`
(seat x turned with the geometry, wheel eye aft along the vehicle, `AHEAD`
for every seat, sim guard on the same rule), `c3f77f69` (regression
`cockpit-occluded-42639`, console entry, docs), `40fd7d54` (a boat's wheel
under the keel is stowed). Evidence `output/cockpit-0930/` in this worktree:
`packs-40fd7d54/` (42639, 60380, 42172, 10797; round labels + faces, one at a
time, clean stamp), `mcaddon-check-40fd7d54.txt` (4/4 OK),
`views-40fd7d54/` (offline hotbar-9 pictures), `cockpit-before-after.jpg`
(round 30f pack left, fix right), `childplay-40fd7d54.*` (19/20: the 10797
slide set-down in `collider_f9`, the same on the 30f pack),
`regressions-40fd7d54.*` (the car cases OK; the other cases' packs were not
built), `audit-base-f35cd5c5/` vs `audit-40fd7d54/` (vehicle audit, 61 sets,
41 rideables, + `views/`), `audit-diff-f35cd5c5-40fd7d54.txt`,
`plan-vs-drawn-40fd7d54.txt`.
- Drawn horizon (`AHEAD` over the drawn geometry, `_cockpit_view.ts`): not
  all clear 23/41 rideables -> 14/41. Fixed: 42639 0/6->6/6, 41395 0->6,
  10365 2->6, 10497 0->6, 60198 car_2 0->6, 60253 3->6, 60367 4->6, 70618
  5->6, 75892 0->6, 60221 5->6; 42172 and 10797 unchanged (6/6). After the x
  fix the compiler's own horizon score equals the simulator's on 40/41
  (76139: 6 vs 4, rotated-cube bounds).
- [ ] Device: the cockpit view (hotbar 9) of 42639 (eye on the wheel's line,
  the rim just under the horizon, the raised door at the left) and 60380
  (in the cab now, not outside its wall); any off-centre seat moved to the
  other side (22 rideables changed: `audit-diff-*.txt`).
- [ ] 60446 now FAILS the horizon (0/6): its seat is the source's pilot's,
  inside the craft, whose torso faces ~35 degrees off the inferred nose (+x)
  at a side window; before, the mirrored seat floated the rider outside the
  craft (6/6 of sky). Facing or pilot-direction question, not the seat.
- Still flagged: superseded by "Cockpit fallback" below (13 of those 14 now
  see the horizon).
- Not changed: every compiled seat's `lock_rider_rotation: 0` (the device's
  "look drags do not move" the cockpit view).

## Cockpit fallback (2026-09-30, worktree `agent-a46e1a84740d559db`)

Commits `8b765dbd` (`driverSeesOut` = AHEAD + SIDES, `AHEAD_FALLBACK`, sim
invariant on the same rule, regressions `cockpit-side-panel-42639` and
`cockpit-in-hull-76286`), `8aa1425c` (SIDES counts only a panel within 1
block). Design + numbers: add-on guide "The view to either side, and when
no eye in the cabin sees ahead". Evidence `output/cockpit-fallback-0930/`
in that worktree: `packs-8aa1425c/` (76286, 42639, 60380, 42172, 10797,
7140, 60221; 30g labels + faces, one at a time, stamp clean),
`mcaddon-check-8aa1425c.txt` (7/7 OK), `views-30g/` vs `views-8aa1425c/`,
`cockpit-before-after-8aa1425c.jpg`, `regressions-8aa1425c.log` (car
cases OK; FAIL lines are only packs not built this round), the audit
`audit-base-40fd7d54/` vs `audit-8aa1425c/` + `audit-diff-*.txt`,
`fallback-sheet-8aa1425c.jpg`. Rebuild: `bash output/cockpit-fallback-0930/build.sh`.
- [ ] Device: hotbar 9 on 76286 (eye 3.1 over the rear-window seat, the
  ship's back and horizon ahead, rider hidden), 42639 (eye 0.4 higher, the
  door's top under the horizon, body still drawn); 60380 / 42172 / 7140 /
  60221 / 10797 are unchanged by construction (same eyes, all 28 side rays
  clear).
- [ ] 31109's fallback eye is 10.2 blocks up (over the mast tops; any lower
  eye's horizon is in its sails): judge on the device whether a child
  prefers that to the helm. 6286 +5.7, 75397 +6.3, 60266 +4.1 likewise.
- [ ] Ships and boats that took the fallback lose their drawn captain in the
  chase view (body hidden at every size). `TODO(cockpit-camera)`: a camera
  offset from the seat instead of moving it - needs a device probe of a
  client-side offset camera (a free camera lags ~3.5 ticks).
- [ ] Not seeing out after the fix (5/41): 76139 (plan 6/6, drawn 4/6,
  rotated-cube bounds), 10295 and 60367 sub3/sub6 (pillars/cabin walls
  within a block no in-cabin point clears), 60266 (fallback eye sees ahead,
  a panel at its right).
