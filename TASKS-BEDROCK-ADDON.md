# LEGO model → Bedrock add-on — tracker

**Handoff rule:** assume a context switch after every turn. This file holds OPEN
work and the measurements a decision still needs. Completed items are deleted;
history is `git log` and `docs/bedrock-addon-guide.md`, which carries every
hard-won fact (frame, budgets, Pixel import/command/camera recipe, riding facts,
the 2026-09-15/16 rounds, the minifig rig, the building shell, the model scale
and the wand's size/aim). Spec: `docs/bedrock-entity-spec-2026-09-14.md`.

## State (2026-09-18 — 18-set review round; see "In flight" at the end)

The placement round is shipped and live (prod index `generated: 2026-09-18`,
10,169 sets byte-identical to local). A follow-up review of 18 named sets in the
browser then found five further defects; three are fixed and pushed, two are open.
Detail lives in `docs/lego-sources-guide.md` (alignment rules),
`docs/bedrock-addon-guide.md` (add-on chain, pack identity, the Ultra stud
budget), clego `GEOGRADE.md` (what the grader can and cannot see) and `git log`.

### The 18-set review (`efa7317b`, CI + Deploy green)

Sets: 910047 910004 10303 10326 76419 71043 76435 21061 21063 60446 10341 10337
42172 76286 31141 11371 21318 910032. **All 18 load; 17 of 18 look right.**
Arms are authentic: 131 of 133 placements sit 17.8-18.4 LDU from their torso.
Evidence `output/verify-2026-09-18b/` (per-set montages + two contact sheets).
Re-run it with `scripts/_verify-sets-{batch,analyze}.mjs` and
`_verify-sets-montage.sh` — all three take `<outDir> [set...]`.

**FIXED — `981` left arms resolved to nothing** (`d1e9b851`). 19 one-armed
figures (910047 8, 910032 7, 11371 3, 76419 1). A resolution race with a DEPTH
asymmetry: `982 -> 3818 -> s818s01` is 2 hops, `981 -> 3819 -> 3818 -> s818s01`
is 3; the cache publishes an empty placeholder on text arrival, and the old
repair invalidated only UPWARDS, so no number of retries converged. Repair now
walks DOWN to the empty descendant. **1,435 of the library's 12,132 parts reach
geometry through 3+ hops**, so exposure was corpus-wide. Trap: judging emptiness
by triangle count calls healthy pure-edge primitives (`4-4edge`) broken.

**FIXED — colliding pack uuids** (`6aa88d6b`). 71043/76419/76435 all stemmed to
`hogwarts` and shipped identical BP/RP uuids, so the second import lands in a
`(1)` folder the world cannot activate. Scoped honestly: the LEGO tab already
passed `setNum`; what shipped broken was the CLI (`setNumber` vs `setNum`,
uncaught because **`scripts/` is outside BOTH tsconfigs**) and the minifig
popover. Under the CLI scheme 5,116 of 10,169 sets (50.3 %) collided.

**FIXED — the CLI could not export `.lxf`** (`d0895b68`); 71043 was browser-only.

**OPEN — 10303 floating track is OUR converter bug, diagnosed not shipped.**
`flatten_io_model2.py` / `io_authenticity.py:179` drops the `.io`'s embedded
Studio mesh definitions and substitutes the LDraw part of the same number.
For `80566` the two meshes are the same SIZE but have different ORIGINS (pure
translation `(137, 80, 420.63)` LDU), so three coaster curves render up to 22
studs out. geograde on the `.io` grades `float=1`, on the flattened `.ldr`
`float=12`. A scratch correction took 10303 from 4 isolated placements to 1 and
its width 119.7 cm -> 86.0 cm against LEGO's published 85 cm. The residual
`3068b` is mounted on two `80564` pieces that have NO LDraw part at all and so
render as nothing — expected, not fixable by moving the tile. Fix + corpus A/B
in flight in clego; NOTHING is to be published until the A/B names every file
that worsens.

**OPEN — `io_part_count` inflation demotes the authentic `.io` for 390 of the
406 sets** whose best source is an `.io`. `clego/build_model_index.py:554` counts
every `1 ` line in `model2.ldr`, including the ~11.4k primitive references inside
the inlined part definitions (10303: 15,242 counted vs 3,808 real), and
`findInflatedPromotion` (`web/src/engine/lego-sources.ts:196`) then demotes it.
**Do not "fix the count" alone** — the app cannot currently render those `.io`s
better (`io-extractor.ts` prefers `model.ldr`, which references unresolvable
`bl_*.dat`, and `ldraw-parser.ts:237` only treats an embedded `.dat` as a part
definition when it carries `!LDRAW_ORG Unofficial_Part`, which Studio omits), so
correcting it would make things worse.

**OPEN — 11371's two arms read 23.76 LDU**, both exactly, against a
`bl_973pb…c01_3814_0` decomposed-composite torso whose origin convention differs
from a bare `973`. Identical values are an origin offset, not a placement error.

### The placement round before it — SHIPPED, see `git log` and the guides

Two poisoned LDD correction rows put every minifig arm tens of studs from its
shoulder, and LDraw's `~Moved to` stubs made `.io`-derived arms match nothing;
a third, separate `mecabricks` defect followed. All fixed, deployed and
verified on prod bytes. Numbers: `docs/lego-sources-guide.md`, `git log`.

**Three traps this round paid for — do not re-learn them.**
- **An `agree` threshold on the learned table is wrong.** Low `agree` means the
  correction is CONTEXT-DEPENDENT, not noisy. It broke 35 sets (41713: 63 → 372 big
  floating) and even a 7-row threshold still broke 4002021. What ships is a
  two-entry `DROP_LEARNED` list. Inverting the ldraw.xml prior globally has its own
  victims (43226: 0 → 153).
- **geograde cannot see a displaced arm.** It lands at floor level and is classed
  `side model`, "not a defect". 76435's headline metrics are identical before and
  after a hundred loose arms were re-attached. The check that works is part
  identity: an arm sits 17–18 LDU from its torso.
- **geograde's `split0` exemption fires on ANY neighbour within one voxel**, so a
  9-part minifig hid a 272-part detached sub-build in 4002021 and made the fix look
  like a regression. `graph_split_parts` now reports the part count beside the
  cluster count; the parts it hid went 429 → 152.

**Add-on fidelity, all six named sets, all defaults, brick-accurate shells, none
degraded to blocks; `scripts/_mcaddon_check.py` passes 8/8.** Two need
**Vehicle detail = Ultra** or their studs are dropped: 71043 (1,938 studs; 15,650 →
48,057 cuboids at Ultra) and 31201 (9,256).

### Earlier this day — commits `38ea28c`…`2b0b059`:
- **LXF placement** (`fix(lxf)`): Studio's `ldraw.xml` row applied as its INVERSE is
  now the primary correction, clego's measured table the fallback. Ground truth over
  the native `.lxf` files with an authentic `.io` (`scripts/lxf_gt_eval.py`):
  10242 Mini Cooper 89.3 → **93.6 % GEO** (exact 74 → 93 %); strict cohort (54 files, a
  Model B .lxf only against a Model B .io) weighted 60.2 → **65.7 %**, median 61.1 →
  **68.7 %**, exact mean 38.0 → 48.7 %, NO file worse by > 1 pt (`output/lxf-gt/strict-*.json`).
  Three files still < 10 % (315 European Taxie, 42039, 4x4 with Powerboat) - their .io
  is a different layout of the set, not a placement failure.
  71043 Hogwarts (the screenshots: floating window, pierced white plates in the tower)
  has no authentic `.io`, so it was measured with clego's geograde on the two placements
  (`output/lxf-gt/71043-probe/geograde.log`): old maths **16 floating parts / 27 unsupported
  splits / 5 sunk / 0.05 % overlap** → new maths **0 / 0 / 0 / 0.00 %** (1,047 of 5,967
  placements moved; 3794 jumpers, 2412 grilles, 2780 pins, 4162/3666 tiles, 60601 glass).
  Browser renders of the new path (`hogwarts-close-*.png` there): the Grand Staircase's
  white stairs sit under their turntable instead of piercing the floor; tower walls clean.
- **Aircraft descend** (`feat(bedrock)`): `craftmatic:descending` group (Jump's
  vertical action −0.5) toggled by the driver script while the stick is pulled BACK
  and Jump held; HUD `BACK+JUMP: DESCEND`.
- **Model scale** (`engine/addon-scale.ts`): one multiplier of the minifig scale drives
  the block/collider cell, the entity units and figure placement. `auto`: a minifig →
  1×; a figure-less display vehicle → shrunk to real length (car 4.6 / boat 9 / plane
  12 blocks, floor ¼×); else 1×. Settings popover "Model scale" with a live decision
  line; CLI `--scale=`. Mini Cooper 10242 auto → 0.38× (4.6 blocks, 7×5 bounds vs 14×9).
- **Custom-minifig UI** (`ui/minifig-builder.ts`, "🧍 Minifig" beside MC settings): torso /
  head / hair / held / cape by part id + LDraw colour, legs/hips/arms/hands colours; the
  figure is compiled on the main thread through `buildPlayableAddon` and downloaded as a
  figures-only `.mcaddon`. Headless check `node scripts/_minifig_browser_check.mjs`:
  12-part knight, 32 KB, 191 ms, zero page errors. Unverified on a device (spawn it with
  its wand, `/function b_…`).
- **Wand rework** (`bedrock-placement-pack.ts`): "Follow my aim" carries the ghost to
  the aimed block face until pinned; "Size" cycles 150/200/300/400/25/50/75/100 % -
  every entity has `craftmatic:size_<pct>` groups (scale + collision + scaled seats),
  a brick-shell building's colliders are re-laid to size by script from a run-length
  grid in the pack (doors/lights left out off 100 %), a coloured-block export refuses
  a resized place; entity-only packs turn in 15° steps. Menu: 9 Follow my aim ·
  10 Size · (11 Turn back, entity-only) · DeLorean last.

Offline gates: root + web typecheck clean; vitest **1,627 passing, 26 skipped**
(`output/bedrock-entity-qa/round-2026-09-17/vitest-full.log`). Packs for the device
round in `output/bedrock-entity-qa/round-2026-09-17/` (`xwing`, `mini-auto`, `mini-1x`,
`chalet` `.mcaddon` + `.json` summaries); brief `QA-BRIEF.md` there.

```
lego.ts ─► ui/schem-export.ts (planAddonScale → cell + modelScale) ─► Worker: schem-pipeline.ts
   ├─ discoverPlayableComponents()   playable-components.ts  (named submodel ≥ ½ wins)
   ├─ discoverSceneActors()          bedrock-scene-actors.ts (figures / seats / door leaves)
   ├─ shell = scenery − vehicles − figures − door leaves   (buildingFidelity 'bricks', default)
   └─ buildPlayableAddon(modelScale) playable-addon.ts
        ├─ every compile at BEDROCK_UNITS_PER_LDU × modelScale; extras at LDU_PER_BLOCK / modelScale
        ├─ every behaviour wrapped by withSizeGroups() (size_25..400)
        ├─ shell → buildColliderGrid → encodeColliderRuns → PlacementColliders in the wand config
        └─ buildPlacementPackAssets(): aim / size / fine-turn runtime
```
CLI gates: `bun scripts/_playable_ref.ts <model> [out] --label=… [--quality=…] [--main-only] [--buildings=bricks|blocks] [--scale=auto|0.25..4]`;
`bun scripts/_minifig_ref.ts --label=Knight --torso=973:4 …`; `python scripts/lxf_gt_eval.py --all --variants shipped`
(strict cohort: a `[Model B]` .lxf only against a `[Model B]` .io; results `output/lxf-gt/strict-*.json`).
**A CLI label must read as the vehicle** (`--label="X-wing Starfighter 7140"`; `XWing 7140` exported a shell + figures, no plane).

## Device round 2026-09-17 — DONE, world "917" (`svO65HnoLQA=`), Bedrock **1.26.51.1**

Full verdict table, measurements and the adb-input findings:
`output/bedrock-entity-qa/captures-2026-09-17/notes.md` (shots `10-*`..`142-*`).
Settled: import/activate (no `(N)` folders, scripts load without Experimental);
BACK+JUMP **descends** (HUD `[DESCENDING]`, ALT -43→-60 in ~3.5 s); Mini Cooper at 0.38×
measures **4.55 × 2.0 blocks** and drives (103.5 mph); the whole wand rework — menu order
0–10, aim-follow ghost, size cycle 100/150/200/300/400/25/50/75, 200 % ghost `34×22×16`,
colliders re-laid at 2× (`/testforblock 0 -45 40 craftmatic:collider` found, walls stop the
player, upper floor at y −54), figures 3.9–4.1 blocks at 200 % and 0.9–1.1 at 50 %, Undo
restores terrain and removes every entity, 50 % walls still block.

### Rounds b + c (2026-09-17, `captures-2026-09-17b/notes.md`, `captures-2026-09-17c/notes.md`) — SETTLED except figures
Content log **0 `[error]`**; climb survives three descend cycles (rider never dismounted);
aim-at-sky message; **Mini rider on the roof line, centred** (car 0/−60/132.5, rider +1.33,
0.00 lateral, legs in the roof, nothing through the flanks, still drives 184 blocks in 4 s);
no figure on the roof any more.
- [ ] **Chalet figures do not roam inside the shell: 0 of 7 moved over 6.5 min** (round b 2 of 7,
      round 1 1 of 7). Figures 4/5/6 are seated (by design). Walkers 1/2/3/7 spawn at +4.06 / +2.19
      / +3.94 / 0.00 with a `craftmatic:collider` under the feet (lo 0, hi 1 / 3 / 15 / a slab above
      fig 7) and a collider in the head cell for 1, 2 and 7 - i.e. they stand correctly on floor
      plates under a ceiling ~2.25 blocks up. A `/tp`'d figure on open grass walks at once (round 1).
      Hypothesis: mob navigation needs TWO full air cells above a walkable block (the 1.8-tall
      player fits under a 2.25 ceiling, the nav mesh does not), so every interior cell is
      unpathable. Next experiment (one number): figure `collision_box.height` 1.8 → 0.95 in
      `figureBehavior` and re-census; if that frees them, make the height a function of the
      interior clearance. Alternative: spawn figures OUTSIDE the footprint (the porch/garden cells).

### Still unverified on a device
- [ ] Whether LOOK DOWN still dives under the script chase camera — **not testable from adb**:
      look-area swipes do not register, `/rotate` does not exist in 1.26.51, and
      `/tp @s … facing …` dismounts a rider. Needs a human, or a debug command that sets pitch.
- [ ] Joystick steering on 1.26.51: the round-5 stick centre (337,550) is the LOOK area now and
      no probe found the ring. Two simultaneous touches are impossible from adb (single pointer;
      `sendevent` on `/dev/input/event2` is SELinux-denied for shell, phone unrooted). Workarounds
      that DO work are listed in the round's notes (stylus source = 2nd pointer;
      `input keyboard keyevent --duration` holds a key; SPACE dismounts a rider).
- [ ] Doors/lights left out at 200 % is confirmed only by the confirm dialog's own text.

## Open

### Interpenetration: not fixed by this round, and mostly not a defect either

Will's report named three symptoms. Floating and misplaced are answered above.
**Overlapping is untouched** by the arm fix — only arm lines moved, so
`overlap_parts_pct` is bit-identical across the 1,259 changed files: mean
**0.148 %**, max **5.97 %**, **52 files above geograde's 1.0 % threshold**,
while the median file is exactly 0 and 979 of 1,259 are clean. (Sunk parts do
improve slightly as a side effect, 791 → 768.) Both sets Will photographed
measure **0.00 %**, so this tail is not what he saw.

**Then the tail was examined, and it is largely a GRADER limit.** Grading the
seven worst and tallying `worst_overlaps` by part: **`6014b` Wheel Rim 12 x 11
dominates — 16 instances / 1,792 LDU³ across 5 of the 7 files** — followed by
`5330` Minifig Weapon Hilt, `69754` Projectile Launcher, `32062` Technic Axle 2
and `32016` Angle Connector. Those are rims inside tyres, a hilt inside a hand,
an axle inside a hole: legitimate insert geometry. GEOGRADE.md states its 8 LDU
erosion cancels "studs in tubes, axles in holes, bars in clips", and a rim
seated in a tyre is a deeper insert than that, so it survives erosion and scores
as bulk-inside-bulk. **Before treating any of these 52 files as broken, check
whether its worst overlaps are a wheel/tyre or hand/weapon pair.** The real work
here is a geograde exemption for encased pairs, not a converter change.


- [ ] **`mecabricks` residual, after the minifig fix shipped** (clego `5810501d`;
      full write-up in `docs/lego-sources-guide.md`). **55 of 2,002 arm-bearing files
      (2.7 %) still have no resolvable torso**: Mecabricks decorated refs `973j`,
      `973aq` … (47 refs / 256 placements) that LDraw names `973pNNN`, emitted
      verbatim and resolving to nothing, plus `2550` falsely hitting LDraw's "Animal
      Monkey Body". Needs a decorated-torso map in `mb_partmap.DESIGN_TO_LDRAW` —
      the same place `3814 → 973` went. After that: hands `3820v2` (11,579
      placements) sit ~12 LDU off the LDraw wrist, because Mecabricks models the
      rest arm with the wrist 68.6° forward against LDraw's 27.9°; that is a
      decision (rotate the arms, or accept), not a bug.
      Pre-fix bytes kept at `lego_sets/_MecabricksLDR_prev` and
      `_MecabricksSearchLDR_prev`; the corpus is stamped `MB_ALIGN v5` but was built
      with the v6 table (nothing reads the stamp; the next full harvest corrects it).

- [ ] **71043 and 76435 on the phone — the only step left on the reported defects.**
      Prod is deployed and verified offline (see SHIPPED above): the three spots measure
      clean and the browser renders confirm them. What is NOT verified is how they look
      on Will's Pixel and, for the add-ons, in Minecraft itself. `scripts/_mcaddon_check.py`
      passes 8/8 on the built packs, but it checks the ARCHIVE, not the content.
      Note for a dense set: export 71043 or 31201 with **Vehicle detail = Ultra** or the
      studs are dropped.

- [ ] LXF residuals (strict cohort `output/lxf-gt/strict-hybrid_xml_first.json`): Technic sets score
      ~41 % weighted (pins/axles stored in the other of two equivalent poses; flex parts), System
      ~65 %. Next levers: synthesise multi-bone flex parts; per-part pose symmetry in the scorer.
- [ ] Sit pose leg sign (round 5: thighs read forward, hips occluded) - still unproven.
- [ ] X-wing figures' walk cycle and a first-person rider-in-cockpit view (round 5 J.1/J.2).
- [ ] Figure height reads 2.03 blocks (hair + head stud over the 1.8 player).
- [ ] `natural_fig4` walked off the platform edge in round 4; `minecraft:home` not re-measured.
- [ ] **The block grid is a mirror image of the LEGO model** (LDraw (x,y,z) → cells (x,−y,z)).
      Invisible on symmetric builds; fixing it changes every schematic byte-for-byte (rule 5) -
      a separate decision. The shell is compiled to the mirrored grid (frame −I) so it is consistent.
- [ ] Door openability under-measured (round 3: 1 of 7 taps toggled a leaf); a scripted
      `setPermutation`/`open_bit` probe from the wand would settle it.
- [ ] Which source the LEGO tab serves: prod index lists `IO/10326-noprint.io` first for 10326
      and DbixConvV3 for 1,705 sets. Those dbix files ARE spread instruction layouts and the
      arm fix barely moved that (chalet 125×116 → 124×97 studs) — so a "compact layout"
      quality flag, density below ~0.3 parts/stud², is still wanted (lego-sources-guide).
- [ ] Two museum doors "no room within three blocks"; 910047 sparse (17 % fill).
- [ ] Hogwarts 76419 is microscale: `auto` scale now reads its microfigure (85863) and exports at
      2× so it stands player height; its one 4-part torso group is still not an NPC (figureRole).
- [ ] Beds / brick-built chairs are not detected (no bed mould; chairs are bricks).
- [ ] Door sizing: a 1×4×6 leaf hangs 2 doors when it straddles two cells and 1 at 1.36 cells;
      below ¾× model scale no leaf reaches two cells, so no doors hang (documented in the popover).
- [ ] Repeated-part budget (76240 `70695` ×184); Tumbler 32 LDU grain reads 14.5 wide (11.5 true).
- [ ] Swipe-to-look untestable over adb; `30426`/`28710`/`x346` ids with no mould; stale pack
      folders on the Pixel (`adb shell rm` denied); `_chase`/`_boom` orbit presets ship unused.

## In flight (2026-09-18, started this session)

- **clego origin-correction + 802-file A/B.** Implements the measured rule for the
  10303 defect above: compare each embedded Studio `0 FILE <id>.dat` bbox against
  the LDraw part's; translate by `t' = t - R*(LDrawMin - StudioMin)` ONLY when the
  sizes agree and the origins differ; record (never silently translate) a size
  mismatch or a missing library part. **Nothing may be published until the A/B
  names every file that gets worse** — `80562`'s family (`60430`, `60432`,
  `60432-dp`) must come out byte-identical.
- **Device round**, five freshly rebuilt packs in
  `output/bedrock-entity-qa/device-2026-09-18/`: 10337 (car), 76286 ultra (plane),
  71043 ultra + 76435 + 31141 (structures). Verifying load, no `[error]` lines, no
  floating/overlapping/misplaced pieces, both arms on every figure, and that the
  71043/76435 pair no longer produces a `(1)` folder.
- **Prod probe.** `scripts/_lego-probe.mjs` drives the dev server but returns
  `{"bricks": 0, "error": "no viewer"}` with `net::ERR_ADDRESS_INVALID` against
  `https://craftmatic.click`, so the deployed build is verified only by a string
  match on the chunk (`assets/index-BaD2yxoz.js` contains the repair code), not
  behaviourally. Being fixed.

## Hard rules (from the spec)

1. No whole-model voxelization on the entity path; no `poly_mesh`.
2. `getPartDims()` only as an explicit, diagnosed AABB fallback.
3. No Minecraft block colours on the entity path.
4. Nothing silent: every part/print/transparency/pose/cluster/figure/door
   degradation lands in `craftmatic-diagnostics.json` and the export warning.
5. Don't touch the world-block pipeline, rideability, the DeLorean behaviour or
   the BlockGrid fallback to solve an entity-rendering problem.
6. Compile per unique part once; instance many; preserve exact source transforms.
