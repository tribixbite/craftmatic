# LEGO model → Bedrock add-on — tracker

**Handoff rule:** assume a context switch after every turn. This file holds OPEN
work and the measurements a decision still needs. Completed items are deleted;
history is `git log` and `docs/bedrock-addon-guide.md`, which carries every
hard-won fact (frame, budgets, Pixel import/command/camera recipe, riding facts,
the 2026-09-15/16 rounds, the minifig rig, the building shell, the model scale
and the wand's size/aim). Spec: `docs/bedrock-entity-spec-2026-09-14.md`.

## State (2026-09-19 — scaling/memory/figure round; the corpus publish is the open chain)

Everything below is on `main`, with `bun run typecheck`, `typecheck:web` and
`bun run test` (1,738 passing) green locally. **`main` is 20 commits AHEAD of
`origin/main` — nothing since `a6f3b152` has been pushed, so CI/Deploy have not
seen any of it.** The clego side is committed locally too and **nothing is on
R2**, so production still serves the pre-regeneration bytes for the whole
corpus: none of this round's placement work is live.

### Shipped this round (craftmatic) — detail is in `git log`, not here

Kept only where a later decision needs the number:

- **Culling and colliders across size steps** (`e168bd49`). `visible_bounds_*`
  are baked into the GEOMETRY and are a RADIUS about the origin; `minecraft:scale`
  does not touch them. 70 of 71 geometries clipped at some step, 0 after.
  `fillBlocks` needs a `BlockVolume` INSTANCE, and the failure was swallowed by a
  bare `catch`, so the collider clear silently never ran.
  `test/bedrock-collider-scale.test.ts` asserts both directions at every step.
- **The device ceiling is CUBOIDS**, ~260,000 over ACTIVE packs, retained cost
  `739 MB + 3.08 kB/cuboid` (`348d9069`, `b662f354`). Box UV + one flat swatch
  per colour: **−34 % per cuboid**, 79,392 cubes colour-gated with 0 changed.
- **Decomposition is chosen by GRAIN** (`ae982fac`): `best-of` at 2 LDU and
  finer (−5.4 % per pack), `greedy` at 4 LDU (−0.8 %, and one golden model gets
  worse). The per-PART number, −7.4 %, is not the one that reaches the device —
  `mergeAlignedCuboids` has already taken it at a coarse grain.
  `scripts/decomposition-pack-ab.ts`.
- **A correction cannot be longer than the part it corrects** (`13f3c0d4`).
  The measured table now carries each part's bbox diagonal and the loader
  rejects a row over 2.0 diagonals — **244 of 1,805**. A DEFENCE, not a repair:
  0 of the 78 reachable ones appear in the first 400 `.lxf` picks.
- **The minifig rig no longer dresses a mini-doll** (`8651b67d`); a null-slot
  part is kept where the source put it and reported as a `bystander`.
- **Multi-term search** (`cc659b2d`, `6e288ebe`) and **a slow `_batch` no longer
  disables the part fast path for the session** (`ed509756`).

### The open chain: publish the clego corpus fixes

**The regeneration and polish halves are DONE, locally.** All 2,302 DbixConvV3
stems were regenerated with the converter fixes and re-polished on 2026-09-19;
1,971 of 2,249 comparable files changed. **Nothing is on R2**, so prod still
serves the pre-regen bytes for the whole corpus.

Measured on a random 500 primary picks, same grader both sides
(`docs/lego-sources-guide.md` §5): corpus PASS **47.2 % -> 50.0 %**, the 91
`DbixConvV3` picks **17.6 % -> 33.0 %**, figure defects **-27 %**, displaced
**-44 %**. One regression, located AND explained: big floating **+7 %**, which
is THREE sets of 91 (`41713` 0 -> 67, `71839` 10 -> 30, `42703` 0 -> 14, 86
unchanged) — and on 41713 the A/B says it is the POLISH, not the alignment. Its
zero came from `dbix_polish` parking 80 parts; the `DBIX_BOUND_RATIO=0` control
(old alignment, unpolished) floats 88 against the new corpus's 78. Figure
defects went 24 -> 0 and split parts 316 -> 9 on the same file.

What is left, as commands, all run from `C:/git/clego` (and one from
craftmatic). Nothing below has been run:

```
python merge_shard_summaries.py                    # FIRST — see the hazard below
python geograde/scoreboard.py --grade --full --workers 8   # re-grade the corpus
python build_model_index.py                        # writes BOTH clego's copy and
                                                   # craftmatic/web/public/lego-models-index.json
python -u sync_models_r2.py --only <changed paths…>   # NOT a bare sync — see below
# then, from craftmatic, verify the bytes prod actually serves:
node scripts/_lego-probe.mjs <set> output/verify-sets/<set> <set>   # DEV_URL=https://craftmatic.click
```

The changed paths are every `DbixConvV3/*.ldr` (all 2,302 were rewritten) plus
the `MecabricksLDR`/`MecabricksSearchLDR` files the stub remap touched (489 +
33). Prove freshness with each entry's `hash` in the index, not with
`index.generated`, which is DATE-only and cannot advance on a same-day
republish.

Hazards, unchanged: `sync_models_r2.py` uploads the index LAST and its
`_r2_uploaded.txt` records KEYS, so a changed file needs its line deleted first
or it is skipped silently; `scoreboard_extra.json` carries ONE `generated` stamp
for all of its paths. New: merge the sharded reconvert summaries with
`merge_shard_summaries.py` FIRST — it is now ownership-aware, and the old
last-writer-wins merge would have written 2,901 stale entries over fresh ones.

Also committed locally in clego and NOT published: the `io_model2_v2` assembly
expansion (118 files), `mb_partmap` +87 decorated rows, the grader's
`displaced`/`staged-capture`/`figures` rules, the family-ladder fix (a torso
whose file is a Studio MPD-style stub or carries a BrickLink description
identified as NOTHING — 910049 lost 11 of 14), and the inverse-prior fix for
the slide and the door.

### Needs a device (offline-verified only)

- [ ] The culling fix at 200-400 %, and whether the box is entity-local or
      world-axis-aligned. No diagonal pad was added, on the ender-dragon
      evidence; a 400 % off-axis placement is the case at risk.
- [ ] The collider clear: that `fillBlocks` accepts the `BlockVolume` plus
      `blockFilter` form, that 32-cubes stay under the 32,768 cap, and that the
      previous-footprint sweep does not make a 400 % place feel slow.
- [ ] Box UV's 50.7 MB saving surviving the per-colour split (71043 gains 37
      geometries, ~40 more draw-call groups), and where the ceiling now sits
      (288k-394k — the two counters disagree 4x, which is why
      `DEVICE_CUBOID_BUDGET` was NOT raised).
- [ ] **A stranded probe pack** (`behavior_packs/Craftmatic` plus
      `resource_packs/Craftmatic`, 323 kB) and **16 Ultra test packs** (~684 MB)
      are on the Pixel and cannot be removed over adb (`rm` is denied in
      `Android/data`) — file manager only. Three Brick Wand hotbar items were
      dropped by a pack-set change; re-obtainable in Creative.

### Measured and CLOSED — do not re-open

- **Entity instancing of part geometry: NO-GO.** Bedrock cannot instance
  geometry inside an entity (no reference key in any format version;
  `geometry.child:parent` is invalid in modern formats; a render controller draws
  one geometry with no per-controller transform). The mesh IS shared between
  instances of one entity TYPE — a second summon of the 71043 shell costs
  +10.3 MB against 148 — so 93 % of the cost is definition-side. But an Actor
  costs **31-48 kB** against a 10 kB gate and 2,000 of them DOUBLE frame time
  (6,000 run at 7.5 fps with none on screen, so it is not overdraw); 71043 would
  need 1.23 GB of Actor overhead against 148 MB today. Blocks instance but are
  dead here: a part-block needs 20,480 permutations against a 65,536 world cap,
  and voxel-signature dedup measures 1.01-1.07x at shipped scale, because the
  28.7x cuboid-level dedup does not survive being cut on a world grid. 71043 is
  not even one lattice — 46.7 % of its cubes sit in a frame yawed 53.3 degrees.
- **A resident "master" part library, instanced per set: still NO-GO, for a
  corrected reason (2026-09-19, second pass).** The 534,354-cuboid whole-library
  number is right but was the wrong question: ranked by sets-per-cuboid, a
  7,563-part library costs 259,957 cuboids (1.00x the ceiling) and fully covers
  7,201 of 10,169 sets (70.8 % by resolvable parts, 62.4 % strictly), and at
  half the ceiling (130k) the median set's residue is 71 cuboids (p90 425). What
  still kills it is the CONSUMER: a block cell holds one block, and at minifig
  scale 71043 has 3.1 placements per cell (9.8 % of placements alone in theirs),
  10307 2.9 (9.9 %); the 65,536 permutation cap is per WORLD and is NOT the
  problem (659 / 1,632 permutations for those two sets). And the library IS the
  ceiling: the entity route ships a median set for ~3,600 cuboids, 36-70x less
  device memory than a resident library. Corrected working, frontier tables and
  the five harnesses: `docs/bedrock-addon-guide.md`, last section.
- Better cuboid merging (0.1 % left), smaller atlases (textures <= 0.85 MB),
  chunking overhead (2.6 % of bytes).
- The `split0` union repair: it recreates a false positive on authentic `.io`
  (42202 goes 0 -> 87 big-floating).
- Guard rails from the same round: **~50-100k VISIBLE cuboids hold 60 fps,
  ~150k hold 30**; killing 6,000 entities leaked 142 MB.

### Still open from the 18-set round

- [x] **The Milano's stand mast — SIZED, and the proposed rule is unsafe.**
      Measured 2026-09-19 (`tmp/stand-probe.ts`, the pattern of
      `scripts/decomposition-pack-ab.ts`). On 76286: 52 placements drop as the
      stand, `strandedRepaired` 0, and the stand's XZ footprint is
      x [-140, 140] z [-26, 217] — most of the model's plan area. So "extend the
      drop while the candidate's footprint stays inside the dropped set's" would
      claim **80 kept placements**, and they are hull parts (`3020`, `3700`,
      `3623`, `3702`), not mast. A CONNECTIVITY continuation instead — grow from
      the dropped set through touching placements, never above the hull's lower
      envelope — claims exactly **2**, both `32524` Technic Beam 7, which is the
      reported mast stub.
      Not built, because the class is small: `stand-below-canopy` fired on
      **1 of 5** plane sources tested (76286 yes; 75367, 75275, 75277, 75306 no).
      If it is ever built, build the connectivity form, not the footprint form.
- [ ] **76435's loose parts are its exploded source** (42 clusters). The guide's
      "cut buildings from the `.io`/IOModel2V2" advice is WRONG for this set —
      there is no `IOModel2V2/76435`, and `IO/76435.io` is 70 clusters, worse.
- [ ] **`io_part_count` inflation** demotes the authentic `.io` for 390 of 406
      sets. **Do not fix the count alone** — the app cannot render those `.io`s
      better yet (`io-extractor.ts` prefers `model.ldr`, whose `bl_*.dat` refs do
      not resolve; `ldraw-parser.ts:237` needs `!LDRAW_ORG Unofficial_Part`,
      which Studio omits).
- [ ] **10 sets have a verified `IOModel2V2` promotion candidate** after the
      re-grade (688, 1552, 8225, 8439, 8448, 10304, 42057, 42140, 42184, 76393).
      Acting means `BEST_OVERRIDES` rows; three are multi-variant archives that
      would render several builds side by side.
- [ ] **4 part ids abstain from rotation** (`35186` x81, `4526` x14, `35473` x5,
      `5443` x2) — near-symmetric, translated correctly, may face the wrong way.
- [ ] A part can be lost to upstream 503s (one 10303 load gave 3,814 instances
      instead of 3,816); `# TODO` in `docs/testing-guide.md`.
- [ ] **The loader has no magnitude bound** like clego's `within_bound`, so 13
      doll-hair placements defer to a (1085, 23, -310) LDU learned vote.
- [ ] The Bedrock minifig assembler classifies doll parts as `held`, so a doll
      exported as a playable entity is not rigged.
- [ ] **Studio/upstream mould MISMATCH — class B, 2,311 sets.** 317 stems that
      BOTH libraries ship with a `dat_bbox` more than 4 LDU apart, over **12,719
      primary placements** (DBIX 8,608). Prod serves the UPSTREAM copy and clego
      fits against STUDIO's, so the fit and the rendered mesh disagree: `70681`
      (1,883 placements) is a different part upstream, `5092`/`5091` (2,400) are
      the mirror-image tile. Bigger than the class-A stub fix that surfaced it
      and untouched. A precedence + re-fit round.
      `clego/MB_TRANSFORM_AUDIT.md` §12.5, `docs/lego-sources-guide.md` §7.
- [ ] **Windows are still open.** The A/B moved 4.6 % of window/glass/door
      placements against 52.3 % of figure placements, so the class Will named
      alongside torsos and hair is substantially untouched. It needs its own
      measurement before a fix: there is no window-attachment rule in
      `geograde/family_attach.py`.
- [ ] **`figure_defects` is the corpus's LARGEST defect class** — 29.6 % ± 4.0
      of picks carry one, `figures` is the dominant defect on 69 of 264
      DEFECTIVE sets, and OMR/LDR carry ZERO. `docs/lego-sources-guide.md` §4.
      **After the regen it is concentrated in `ReconV3`: 452 of the sample's 807
      defects (56 %), 46 of its 121 picks, 9.8 per affected pick — against
      DbixConvV3's 2.3.** Nothing has ever been aimed at ReconV3's figures, and
      that is the next target, not another DbixConvV3 pass. `EurobricksLDR` has
      the worst rate (61 % of 38 picks). §6 of the same guide.
- [ ] **The 744 picks that never had a grade** are now graded (47.3 % PASS) and
      have a different profile: 13.8 % carry duplicate placements against 0.4 %
      in the random sample. `EurobricksLDD` and `EurobricksTopicLDR` are 100 %
      of their classes and were invisible to every earlier census.
- [ ] **The minifig creator wand is designed, not built.** Architecture and an
      ordered plan with its vitest assertions: `docs/minifig-creator-wand.md`;
      typed skeleton `web/src/engine/minifig-creator-types.ts`, imported by
      nothing yet. Steps 4 and 6 of that plan each need a device round.
- [ ] Two grader false-positive classes left deliberately: a torso whose neck
      holds a cone rather than a head (a fix would only loosen what the rule
      means), and a `Minifig Leg Medium` band that cannot be refitted because no
      authentic example of that pair exists anywhere in OMR.

## The add-on chain and its CLI gates

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

### Carried forward from the 2026-09-17 device round

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

## Hard rules (from the spec)

1. No whole-model voxelization on the entity path; no `poly_mesh`.
2. `getPartDims()` only as an explicit, diagnosed AABB fallback.
3. No Minecraft block colours on the entity path.
4. Nothing silent: every part/print/transparency/pose/cluster/figure/door
   degradation lands in `craftmatic-diagnostics.json` and the export warning.
5. Don't touch the world-block pipeline, rideability, the DeLorean behaviour or
   the BlockGrid fallback to solve an entity-rendering problem.
6. Compile per unique part once; instance many; preserve exact source transforms.
