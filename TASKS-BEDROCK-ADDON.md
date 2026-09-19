# LEGO model → Bedrock add-on — tracker

**Handoff rule:** assume a context switch after every turn. This file holds OPEN
work and the measurements a decision still needs. Completed items are deleted;
history is `git log` and `docs/bedrock-addon-guide.md`, which carries every
hard-won fact (frame, budgets, Pixel import/command/camera recipe, riding facts,
the 2026-09-15/16 rounds, the minifig rig, the building shell, the model scale
and the wand's size/aim). Spec: `docs/bedrock-entity-spec-2026-09-14.md`.

## State (2026-09-19, evening — publish chain RUNNING; corpus re-graded against what prod draws)

Everything below is on `main`, with `bun run typecheck`, `typecheck:web` and
`bun run test` (1,744 passing) green locally. **`main` is 34 commits AHEAD of
`origin/main` — nothing since `a6f3b152` has been pushed** (push needs Will's
go-ahead), so CI/Deploy have not seen any of it. clego is committed locally
(`37ed4a42`…`09b76722`) and **the R2 republish is RUNNING** (see the open
chain) — until it finishes prod serves the pre-regeneration bytes. The corpus
on disk is NOT git-tracked (`lego_sets/` is ignored) — R2 is its only durable
copy, so the publish is also the backup.

### Shipped this round — detail in `git log` / the guides, kept where a decision needs the number

- **ReconV3 figures assembled** (`clego/recon_figure_assemble.py`, wired into
  `recon_v3/beam.py`): 423 files / 990 figures / 4,919 parts moved in place;
  −44 % figure defects on the touched sample files, floating +4, overlap/sunk
  unchanged. Residual is inventory-side (surplus hands, dropped torsos).
  `docs/lego-sources-guide.md` §6a.
- **Class-B mould mismatch re-framed exactly** (`clego/class_b_census.py`,
  `class_b_apply.py`, wired into `reconvert_dbix.py`, the Mecabricks harvester
  and `recon_v3`): 8,073 of 12,868 primary placements are the SAME mould in
  another frame (70681 is a 20 LDU shift, not a different part) and were
  rewritten in place across 3,800 generated files (21,309 placements incl.
  alternates). **The grader now resolves parts UPSTREAM-first**
  (`CLEGO_LDRAW_LIB=upstream`, prod's ladder) — the running board is the first
  graded that way. The `.io`/`.lxf` picks are re-framed CLIENT-side
  (`class-b-reframe.ts`, verified in the browser: 60118 6, 21061 80). Not
  covered: 108 `different` stems (4,795 placements). §7a.
- **Mecabricks A/B against ORIGINAL bytes** (`geograde/_ab_prev.py`): the
  regen-vs-regen caveat is closed — 477 files 4,577 → 706 figure defects, 33
  search files 178 → 76, nothing else moved. §7.
- **The Milano stands on its hull** (`bd3e7dc0` + the fittings fix): the stand
  drop now continues through the mast (5 beams + 3 pins on 76286,
  `standContinued: 8`, `strandedRepaired: 0`); the device saw it hovering on
  a stalk because the render frame grounds the model on its lowest cuboid.
  `output/device-919/76286-v2.mcaddon` is the rebuilt pack — **not yet on the
  phone** (the Sonnet round is testing the stalk build; same uuid, so a
  re-import needs a new version in `world_*_packs.json`).
- Device round 1 (Opus, `output/device-919/HANDOFF.md`): 3 packs built and
  activated in world 919 (77,345 cuboids = 29.7 % of the ceiling); **culling
  at 100 % PASS** (origin 69.5° off-axis, hull intact); place latency
  2.1–5.3 s. Incident: the Play screen's LAN tile shifts local worlds one
  slot — read the tile LABEL before every tap.

### The open chain: publish the corpus (RUNNING — two detached jobs)

Done: pass 1 + pass 2 re-grades (all 10,169 primary picks, ONE grader, the
UPSTREAM library, 0 errors, 45 min), `--report --full` (board stamp
`2026-09-19 15:53:14`, **5,593 PASS = 55.0 %**; mecabricks 65 %, recon_v3
25 %, dbix_conv_v3 36 %, omr 94 %, ldr 88 %, io 79 %, lxf 55 %),
`build_model_index.py` (11,640 stamps: 6,236 verified / 5,316 defective; 775
ALTERNATE paths dropped as stale because alternates were not re-graded yet).

Running (started ~16:20 local, both detached from the session):

1. **R2 republish** — `python -u sync_models_r2.py --only-file
   C:/Users/wills/.claude/jobs/718e154d/tmp/changed_publish_prod.txt`
   (4,746 files whose sha differs from the index PROD serves — the same
   4,746 as against the local 09-18 index; ~67 files/min → ~70 min), log
   `…/tmp/r2_sync.log`, failures → `clego/_r2_only_failed.txt` (re-run with
   `--only-file` on it). It uploads `lego-models-index.json` LAST.
2. **Alternates grading** — `CLEGO_LDRAW_LIB=upstream python -u
   geograde/scoreboard.py --grade --full --alts --workers 10`, log
   `…/tmp/regrade_alts.log`; restores the alternates' `asm` stamps (and
   `rerank_proposals_full.json`, which went to 0 rows without them).

When BOTH have exited (`exit=0` at each log's tail; `Get-Process python`
shows neither), from `C:/git/clego`:

```
CLEGO_LDRAW_LIB=upstream python geograde/scoreboard.py --report --full   # re-stamp with the alternates
python build_model_index.py                                             # clego + craftmatic copies
: > empty.txt && python -u sync_models_r2.py --only-file empty.txt      # uploads ONLY the index (todo is empty)
# prove prod serves the new bytes (index max-age=300, models 3600 — use a cache-buster, re-check a minute later):
curl -s "https://craftmatic.click/lego-models-index.json?cb=$RANDOM" | python -c "import json,sys;d=json.load(sys.stdin);print(d['geograde'])"
curl -s "https://craftmatic.click/lego-models/DbixConvV3/76286.ldr?cb=$RANDOM" | sha256sum   # compare with the index entry `hash` (first 12 hex)
cd C:/git/craftmatic && node scripts/_lego-probe.mjs 76286 output/verify-sets/76286 76286   # DEV_URL=https://craftmatic.click
```

Then commit in clego (`geograde/scoreboard_full*.{json,jsonl,md}`,
`geograde/rerank_proposals_full.json`, `dbix_reconvert_summary.json`,
`lego-models-index.json`, `_model_index_summary.txt`) and in craftmatic
(`web/public/lego-models-index.json`) — the craftmatic copy is what Deploy
ships, so prod's index and the app's bundled index differ until `main` is
pushed and deployed (Will's call).

Also committed locally in clego and NOT published: the `io_model2_v2`
assembly expansion (118 files), `mb_partmap` +87 decorated rows, the
family-ladder fix, the slide/door inverse-prior fix.

### Five files are dirty in clego and are NOT this round's

`mecabricks_align.json`, `geograde/mb_fix_report.json`,
`geograde/mb_fix_report_MecabricksSearchLDR.json` (the Mecabricks fit tables,
also carrying 17 `stem-mesh` rows from another agent), `discovery/eb_ldd_sample_grades.json`,
`recon_v7_work/pdfpick_cache.json`. Left alone; do not sweep them into a commit.
The scoreboard `_targets.json` / `_grades.jsonl` / `dbix_reconvert_summary.json`
ARE this round's and get committed with the report.

### Needs a device (offline-verified only)

- [ ] The culling fix at 200-400 % (100 % PASSED on 919: origin 69.5° off
      axis, hull intact), and whether the box is entity-local or
      world-axis-aligned. No diagonal pad was added, on the ender-dragon
      evidence; a 400 % off-axis placement is the case at risk. A Sonnet agent
      is on it — results land in `output/device-919/REPORT.md`.
- [ ] The collider clear: that `fillBlocks` accepts the `BlockVolume` plus
      `blockFilter` form, that 32-cubes stay under the 32,768 cap, and that the
      previous-footprint sweep does not make a 400 % place feel slow.
- [ ] Box UV's 50.7 MB saving surviving the per-colour split (71043 gains 37
      geometries, ~40 more draw-call groups), and where the ceiling now sits
      (288k-394k — the two counters disagree 4x, which is why
      `DEVICE_CUBOID_BUDGET` was NOT raised).
- [ ] Will deleted every add-on before this round; the Pixel now carries
      only `GreatHall7`, `HogwartsCa`, `MilanoSpac` (the 919 packs, each with
      a stalk-era 76286 build) plus `/sdcard/Download/dev919-*.mcaddon`, which
      `adb shell rm` CAN remove. Packs cannot be removed over adb (`rm` is
      denied in `Android/data`) — file manager only.

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
- [ ] **Class B residual.** 108 `different` stems / 4,795 placements have no
      exact overlay (needs a per-stem alias to an upstream file with Studio's
      geometry; none found by description). The `.io`/`.lxf` picks are now
      re-framed client-side (`abea544e`, `class-b-reframe.ts`) — verified by
      unit tests only; a browser load of an `.lxf` set with `70681` should
      show `N placements re-framed` in the `.lxf` status note.
      `docs/lego-sources-guide.md` §7a.
- [ ] **Windows are still open.** The A/B moved 4.6 % of window/glass/door
      placements against 52.3 % of figure placements, so the class Will named
      alongside torsos and hair is substantially untouched. It needs its own
      measurement before a fix: there is no window-attachment rule in
      `geograde/family_attach.py`.
- [ ] **Figure defects, after the ReconV3 assembler**: the residue in ReconV3 is
      inventory-side (6–12 hands for 2 arms, torsos dropped by the reader —
      `76151`, `70403`, `76167`); `EurobricksLDR` still has the worst RATE
      (61 % of 38 picks) and nothing has been aimed at it. Re-measure on the
      500-pick sample once the upstream-library board is in.
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
      `_MecabricksSearchLDR_prev` (the A/B against them is in §7); the corpus is
      stamped `MB_ALIGN v5` but was built with the v6 table (nothing reads the
      stamp; the next full harvest corrects it).

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
