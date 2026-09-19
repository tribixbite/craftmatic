# LEGO model → Bedrock add-on — tracker

**Handoff rule:** assume a context switch after every turn. This file holds OPEN
work and the measurements a decision still needs. Completed items are deleted;
history is `git log` and `docs/bedrock-addon-guide.md`, which carries every
hard-won fact (frame, budgets, Pixel import/command/camera recipe, riding facts,
the 2026-09-15/16 rounds, the minifig rig, the building shell, the model scale
and the wand's size/aim). Spec: `docs/bedrock-entity-spec-2026-09-14.md`.

## State (2026-09-19 — scaling/memory/figure round; the corpus publish is the open chain)

Everything below is on `main`. The clego side is committed LOCALLY ONLY and NOT
published — that is the one big open item. **The last commits on `main` have
NOT been pushed**; CI/Deploy were last green at `a6f3b152`.

### Shipped this round (craftmatic)

- **Scaled placements lost their model and kept their old walls** (`e168bd49`).
  Bedrock culls against the GEOMETRY's `visible_bounds_*`, which are baked, while
  `minecraft:scale` only resizes the visual — Mojang's own `slime.geo.json`
  declares a size-4 box for a half-block cube, and `ender_dragon.geo.json` has
  width 2x its furthest |x|, so the width is a RADIUS about the origin. 70 of 71
  geometries clipped at some size step; 0 after. Separately the collider re-lay's
  `fillBlocks` took a plain object where the API needs a `BlockVolume` INSTANCE,
  inside a `try {} catch {}`, so the clear silently never ran and the code MERGED
  with the previous size's walls; and fractional scales claimed every column a
  cell TOUCHED, so a 150 % wall ate its own doorway.
  `test/bedrock-collider-scale.test.ts` asserts both directions at every step
  (X/Z exact set equality per block, Y to the sixteenth of the `[lo,hi]` pair).
- **The device ceiling is CUBOIDS** (`348d9069`, `b662f354`). 10 Ultra packs OOM
  (`St9bad_alloc`, in-process, NOT the low-memory killer); retained cost fits
  `739 MB + 3.08 kB/cuboid`; ceiling ~260,000 cuboids over ACTIVE packs. Figures
  clamped to `high` (free: 71043 is 50,319 cuboids vs 48,683 at `balanced`, and
  260k over either is the same 5 packs, against 4 unclamped). Pack-level budget
  plus export warning. Geometry JSON minified (6.1x on disk, and the comment says
  plainly it does NOT move runtime memory — that A/B is 0.4 %). Box UV and one
  flat swatch per colour: **-34 % per cuboid**, colour-gated offline over 79,392
  cubes with 0 changed.
- **Mini-dolls and an LDD id suffix** (`e4396a31`). Doll slots had NO correction
  in either table; and `designID="1006030;I"` made LDD's own `.lxfml` dumps
  render EMPTY.

### The open chain: publish the clego corpus fixes

Committed locally in clego, **not published**: the `io_model2_v2` assembly
expansion (composite torsos, 118 files), the dbix `within_bound` cap
(headgear/glass, 1,970 files), `mb_partmap` +87 decorated torso/head rows,
`dbix_figure_align` (mini-dolls, 320 files), the grader's
`displaced`/`staged-capture`/`figures` rules, and (2026-09-19) the family
ladder fix — a torso whose own file is an MPD-style Studio stub, or carries a
BrickLink description, identified as NOTHING and invented orphan arms and
headgear around a correctly assembled figure (910049: 11 of 14 torsos).

**13 stems are already regenerated on disk** (the DbixConvV3 picks of the 15
sets Will listed) and A/B'd with the same grader on both sides — figure
defects −72 %, displaced −69 %, big floating −63 %, floating −54 %, and 52.3 %
of FIGURE placements moved against 4.6 % of windows. Numbers, per-set table and
the residue: `docs/lego-sources-guide.md` §3. **Nothing is on R2**, so prod
still serves the old bytes for those 13.

Sequence: regenerate DbixConvV3 + IOModel2V2 + Mecabricks -> re-grade -> rebuild
the index -> sync R2 -> verify on prod bytes.
**Expect the PASS rate to fall, measured not guessed**: a random 500 of the
9,425 graded picks, re-graded today, is **47.2 % PASS**, with `DbixConvV3` at
**17.6 %** — BELOW the 30–40 % this tracker used to predict, because that
prediction predates the figure gate. No PRIMARY PICK changes: picks come from
source priority plus `BEST_OVERRIDES`, never from a grade.
Hazards: `sync_models_r2.py` uploads the index LAST and its `_r2_uploaded.txt`
records KEYS, so a changed file needs its line deleted first or it is skipped
silently; `scoreboard_extra.json` carries ONE `generated` stamp for all paths.
`dbix_reconvert_summary.json` and `geograde/dbix_polish_log.jsonl` are dirty in
the clego tree with the 13 regenerated entries — commit them WITH the full
regen, not before, or the summary claims a state the corpus is not in.

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
- **A resident "master" part library, instanced per set: NO-GO.** Compiling
  every distinct corpus part once with the real `compilePartPrototype` at the
  COARSEST shipped quality is **534,354 cuboids = 2.06x the 260,000 ceiling**
  before a set is placed (1.19 M at high, 2.55 M at ultra); even the 95 %-of-
  placements subset only fits at balanced. And there is no consumer: blocks
  would need 208,074 axis-aligned (part, rotation, colour) types against a
  65,536 cap, because `tint_method` is biome tints only so colour cannot be
  per-instance, and 33 % of placements are not axis-aligned at all. The SPLIT
  matters: the behaviour pack, the texture pack and the per-set assembly
  manifest are all YES (71043 = 133 kB raw / 47 kB gzip). Full working and the
  three harnesses: `docs/bedrock-addon-guide.md`, last section.
- Better cuboid merging (0.1 % left), smaller atlases (textures <= 0.85 MB),
  chunking overhead (2.6 % of bytes).
- The `split0` union repair: it recreates a false positive on authentic `.io`
  (42202 goes 0 -> 87 big-floating).
- Guard rails from the same round: **~50-100k VISIBLE cuboids hold 60 fps,
  ~150k hold 30**; killing 6,000 entities leaked 142 MB.

### Still open from the 18-set round

- [ ] **The Milano's stand mast** — `stand-below-canopy` cuts at a fixed height
      and the Technic mast straddles it, so the base drops and the upper segments
      stay stuck to the hull. Needs a CONNECTIVITY rule: after the height cut,
      extend the drop UPWARD while a candidate's horizontal footprint stays
      inside the dropped set's and its box is below the hull's lower envelope,
      then keep the 20 % gate. Size it on several plane sources first.
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
- [ ] **Windows are still open.** The A/B moved 4.6 % of window/glass/door
      placements against 52.3 % of figure placements, so the class Will named
      alongside torsos and hair is substantially untouched. It needs its own
      measurement before a fix: there is no window-attachment rule in
      `geograde/family_attach.py`.
- [ ] **`figure_defects` is the corpus's LARGEST defect class** — 29.6 % ± 4.0
      of picks carry one, `figures` is the dominant defect on 69 of 264
      DEFECTIVE sets, and OMR/LDR carry ZERO. `docs/lego-sources-guide.md` §4.
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
