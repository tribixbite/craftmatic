# LEGO model → Bedrock add-on — tracker

**Handoff rule:** assume a context switch after every turn. This file holds OPEN
work and the measurements a decision still needs. Completed items are deleted;
history is `git log` and `docs/bedrock-addon-guide.md`, which carries every
hard-won fact (frame, budgets, Pixel import/command/camera recipe, riding facts,
the 2026-09-15/16 rounds, the minifig rig, the building shell, the model scale
and the wand's size/aim). Spec: `docs/bedrock-entity-spec-2026-09-14.md`.

## State (2026-09-17 late — placement round landed; corpus republish is the open gate)

### Placement round (this session): `6062537`, `f0eeb17`, `2d4901e`, `26eb009` here + `df06a716` in clego

The user's report — floating / overlapping / misplaced pieces on 71043 (`.lxf`)
and 76435 (`dbix_conv_v3`), plus "all minifigs' arms but not hands floating
separately" — was TWO unrelated defects, both fixed.

- **Defect 1: two poisoned rows in the LDD correction table, shipped by both
  repos.** clego's learner writes, per design, the MODE of that design's
  correction votes; `agree` is the vote fraction the mode won and `sets` counts
  competing MODES, not sets. `3818` shipped t = (1, 112, 140) at agree **0.044**
  and `3819` t = (607, 111, −136) at **0.043**, so every minifig arm in every
  `.lxf` that fell back to the table AND in all 2,302 `dbix_conv_v3` files stood
  tens of studs from its shoulder. Authentic OMR files put an arm **17–18 LDU**
  from its torso; 71043 measured 183.7 / 647.1, 76435 141–299. Both now 18.1.
- **THE THRESHOLD GATE WAS BUILT, MEASURED AND REJECTED — do not rebuild it.**
  "Reject every row below an `agree` threshold" is the obvious fix and it is
  wrong. A low `agree` does not mean the measurement is noisy; it means the
  correct correction is **context-dependent**, so the disputed mode still beats
  the ldraw.xml fallback for many designs. geograde big-floating parts,
  converted-only: 41713 **63 → 372**, 4002021 **73 → 372** under `agree < 0.30`;
  even `agree < 0.10`, which admits seven rows, still leaves 4002021 at 370.
  Corpus-wide the 0.30 gate made **35 sets worse**. A blunt `agree >= 0.5` is
  worse again: 872 legitimate rows discarded, −2.61 pts weighted GEO.
  Inverting the ldraw.xml prior GLOBALLY has its own victims (43226 grades 0
  big-floating forward, **153** inverted).
- **What shipped is two explicit, evidence-backed entries**, `DROP_LEARNED` in
  clego `dbix_align.py` and in `scripts/gen-ldd-measured-align.py`: the two arm
  rows, with the xml prior inverted for those two designs only (forward leaves
  the arm at 54.7 LDU, inverted at 18.1). **Blast radius proved, not asserted**:
  regenerating the whole corpus twice, once with `DBIX_DROP_LEARNED=` (which
  reproduces the old bytes exactly) and once with the default, gives **1,043
  files identical, 1,259 differing ONLY in 3818/3819 lines, ZERO differing
  anywhere else** — 8,746 changed part lines, all arms. No other design can move.
- **Corpus arm measurement, 1,257 files / 8,734 arms**: arm-to-nearest-torso
  median **327.5 → 18.1 LDU**, within 25 LDU of a torso **6 (0.1 %) → 8,712
  (99.7 %)**, against 18.0 in authentic OMR. The 22 that stay beyond 25 LDU are
  a limit of the probe (their figures use a torso mould it does not look for),
  not a defect — checked in 75423.
- **The `.lxf` class, not just 71043.** geograde over nine native `.lxf` files
  dumped through both placements (`output/lxf-gt/geograde-ab/`): floating parts
  **107 → 0**, BIG floating clusters **81 → 0** (all of it 10213 Shuttle
  Adventure, 7.4 % of the model), zero-gap graph splits 10 → 0. Sunk is the one
  metric that does not improve: 27 → 29. With 71043's 16 → 0 the class reads
  **123 → 0** floating. That improvement is `38ea28c`'s (ldraw.xml applied as
  its inverse, primary), which this round only extended to the arms.
- **Read the A/B `.ldr` dumps for GEOMETRY only.** `scripts/lxf_gt_eval.py
  --dump` writes colours through its own `ldd_colour()`, so every render made
  from a dump (`output/lxf-gt/71043-probe/`, `output/lxf-gt/71043-ab/`) comes out
  magenta. The harness, not a palette regression.
- **geograde COULD NOT SEE this defect, and that is the lesson.** A displaced
  arm lands at floor level, so geograde classed all of them `side model`, which
  is explicitly "not a defect". 76435 graded `float=5 BIG=0 ovl=0.00 % side=112`
  with a hundred loose arms lying beside the build, and grades `float=5 BIG=0
  ovl=0.00 % sunk=1` now they are on the shoulders — the headline metrics barely
  move. Will found it in a screenshot. What catches it is a part-identity check,
  not a geometry class: an arm sits 17-18 LDU from its torso. Recorded in clego
  `GEOGRADE.md` beside the `side model` rule.
- **Corpus geograde A/B, SETTLED — and quote the POST-POLISH number.** The
  pre-polish comparison over the 1,259 changed files is dramatic (big floating
  **69,137 → 42,934, −38 %**; floating **102,758 → 64,812**; 360 sets go
  defective → clean against 2 the other way, and those 2 have identical
  floating-part counts and main components). **But `dbix_polish` already cleaned
  up most of that**, so the honest shipped-vs-shipped figure, both corpora
  converted AND polished, over the 1,540 stems in both polish logs, is smaller:

  | | before | after |
  |---|---|---|
  | big floating parts | 12,674 | **10,836** (−14.5 %) |
  | floating parts | 20,767 | **18,906** (−9.0 %) |
  | sets worse / better / unchanged | | 22 / 27 / **1,491** |
  | clean → defective | | **1** |
  | defective → clean | | **13** |

  So the durable win of this round is the ARMS themselves — median 327.5 →
  18.1 LDU, 0.1 % → 99.7 % attached — which the polish pass never fixed, because
  it only relocates debris and cannot re-place a part on its socket. The
  floating-count movement is a welcome side effect, not the headline.
  Worst regressions post-polish: 4002021 +297, 76949 +120, 60317 +73, 76417 +22,
  71499 +18. On 4002021 the main component is 799 parts either way and the
  component count falls 71 → 48, so clusters are MERGING past the 5-part BIG
  threshold rather than parts newly detaching; deleting its arms outright from
  the pre-fix file leaves it at 73, ruling out phantom contact. Accepted on that
  evidence. Pre-fix bytes kept at `lego_sets/_DbixConvV3_prev`, and reproducible
  from source with `DBIX_DROP_LEARNED=`.
  Polish itself, on the new corpus: 1,705 stems, 1,625 acted, 996 kept, big
  floating 47,129 → 8,215 on the kept files. Arms survive it — 408 polished
  files sampled mid-run read median 18.4 LDU and 99.8 % attached, because polish
  moves whole clusters.
- **A SECOND, independent arm defect, in craftmatic this time** (`26eb009`).
  LDraw retires a mould with a `~Moved to <newid>` stub that names no part, so
  the `.io`-derived museum's `981`/`982` arms matched neither the description
  tests nor any id list and all seven figures compiled ARMLESS — **including the
  museum add-on signed off in the 2026-09-16 round**. `mouldFamilyId()` follows
  the redirect for every figure classifier; arm warnings on
  `IOModel2V2/10326-noprint.ldr` go **7 → 0**. With both fixes the museum cut
  from the regenerated dbix file is now CLEANER than the `.io` cut the tested
  pack used.
- **"DbixConvV3 files are exploded instruction layouts" STANDS — an earlier
  note in this file claiming otherwise was wrong and is deleted.** That claim
  came from the rejected threshold-gate corpus, where the dramatic footprint
  collapse was mis-placement, not correction. Measured on what actually ships
  (legacy → surgical): Winter Chalet 125 × 116 → **124 × 97** studs (density
  0.19 → 0.23), Natural History Museum 114 × 54 → **83 × 54** (0.65 → 0.89),
  76435 128 × 26 → **100 × 26** (0.52 → 0.67). Still spread. Keep cutting
  buildings from the `.io` / `IOModel2V2` file where one exists; density below
  ~0.3 parts/stud² marks a spread layout.
- **The arm fix does reach the add-on, and that is measurable.** Winter Chalet
  cut three ways through `scripts/_playable_ref.ts`, all defaults — every cut
  finds 7 figures and 9 seats:

  | chalet source | arm warnings | doors |
  |---|---|---|
  | `IO/910004.io` (the tested reference) | 0 | 4 in 3 doorways |
  | `DbixConvV3/910004.ldr` (shipped) | **7** | 2, 1 leaf outside bounds |
  | same file, arm fix | **0** | 2, 1 leaf outside bounds |

  The doors do not improve, because that is the exploded layout, not the arms.

- **Bedrock add-on, the user's question answered and verified.** UI chain:
  load the set → leave `Vehicle` on "Detect vehicle components" and every
  `⚙ MC settings` row at its default → `Download…` → **"Add-on — controls
  detected or selected components (.mcaddon)"**. Nothing else. Re-cutting the
  chalet from `IO/910004.io` reproduced the round-2026-09-17 reference pack's
  components and both warnings exactly (307,690 vs 307,380 bytes). Verified
  through the real UI on a `.lxf` (71043 → 617 KB, shell + 4 figures) and a dbix
  `.ldr` (76435 → 320 KB, shell + 10 figures + 3 seats):
  `output/addon-evidence-2026-09-17/`. Full chain and the two remaining limits
  (named-submodel vehicle isolation, the 50 % `fallbackPartCount` cliff) are in
  `docs/bedrock-addon-guide.md`.
- **A SECOND, independent arm defect, in craftmatic this time** (`26eb009`).
  LDraw retires a mould with a `~Moved to <newid>` stub that names no part, so
  the `.io`-derived museum's `981`/`982` arms matched neither the description
  tests nor any id list and all seven figures compiled ARMLESS — **including the
  museum add-on signed off in the 2026-09-16 round**. `mouldFamilyId()` follows
  the redirect for every figure classifier; arm warnings on
  `IOModel2V2/10326-noprint.ldr` go **7 → 0**. With both fixes the museum cut
  from the regenerated dbix file is now CLEANER than the `.io` cut the tested
  pack used.
- **"DbixConvV3 files are exploded instruction layouts" was mostly this bug.**
  Chalet footprint 125 × 116 → **71 × 49** studs (0.19 → 0.80 parts/stud²),
  museum 114 × 54 → **80 × 30** (0.65 → 1.69). The 2026-09-16 note that buildings
  must be cut from `.io` is superseded for these two; density below ~0.3
  parts/stud² still marks a genuinely spread file.
- **Bedrock add-on, the user's question answered and verified.** UI chain:
  load the set → leave `Vehicle` on "Detect vehicle components" and every
  `⚙ MC settings` row at its default → `Download…` → **"Add-on — controls
  detected or selected components (.mcaddon)"**. Nothing else. Re-cutting the
  chalet from `IO/910004.io` reproduced the round-2026-09-17 reference pack's
  components and both warnings exactly. Verified through the real UI on both a
  `.lxf` (71043 → 617 KB, shell + 4 figures) and a dbix `.ldr` (76435 → 320 KB,
  shell + 10 figures + 3 seats): `output/addon-evidence-2026-09-17/`. The old
  chalet cut from `DbixConvV3/910004.ldr` warned that **all seven figures lacked
  both arms** and hung 2 of 4 doors; after the fix it matches the `.io` profile.
  Full chain + the two remaining limits: `docs/bedrock-addon-guide.md`.

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

### SHIPPED AND VERIFIED (2026-09-18)

Both publishes are DONE. `main` is at `8173563`; the Deploy and CI workflows
both succeeded; prod serves the gated table (`craftmatic.click/ldd-measured-align.json`
= 1,839 rows, `3818`/`3819` absent). The corpus went to R2 in two passes,
2,460 + 6 = **2,466 files, 0 failures** (the first pass's 6 were transient
wrangler/bunx install races, not upload errors), index uploaded. Verified live:
`craftmatic.click/lego-models/DbixConvV3/{76435,910004,10326}.ldr` read arm
medians 18.1 / 18.0 / 18.4 LDU.

**The three defect types Will reported, on the two sets he photographed:**

| | floating | big clusters | sunk | overlap | arm→torso (authentic 18.0) |
|---|---|---|---|---|---|
| 71043 `.lxf` before | 16 | 0 | 5 | 0.05 % | **647.1 LDU, 0 % attached** |
| 71043 `.lxf` now | **0** | 0 | **0** | **0.00 %** | **18.1 LDU, 100 %** |
| 76435 dbix before | 5 | 0 | 1 | 0.00 % | **215.4 LDU, 0 % attached** |
| 76435 dbix now | 5 | 0 | 1 | 0.00 % | **18.1 LDU, 100 %** |

76435's geometry columns do not move because geograde never saw the defect (the
scattered arms were classed `side model`); the arm column is the one that
captures it. Renders at `output/verify-2026-09-18/`: `71043/v-hall-inside.png`
vs `71043/old-hall-inside.png` is the Grand Staircase from Will's second
screenshot — the white flights now rest ON their turntables instead of piercing
them, and the angled landing plate that cut across the shaft is gone.

**Add-on fidelity, every named set, all defaults, brick-accurate shells:**

| set | source | bricks | cuboids | figures | notes |
|---|---|---|---|---|---|
| 71043 | lxf | 5,937 | 15,650 | 4 | 290 unique parts, 0 unresolved, 0 AABB fallback |
| 76435 | dbix_conv_v3 | 1,750 | 7,579 | 10 | 4 doors |
| 910004 | io | 2,722 | 6,922 | 7 | 9 seats, 8 doors/lights |
| 10326 | io | 4,061 | 10,984 | 7 | 12 doors/lights |
| 31201 | mecabricks | 9,820 | 1,860 | 0 | flat crest mosaic; 9,256 studs over the 4,096 budget, omitted |
| 76405 | mecabricks | 1,950 | 5,422 | 20 | **all 20 figures lose their head** — see below |

None degraded to the coloured-block fallback.

### The two publish steps — BOTH need Will's explicit go-ahead (outward-facing)

Everything else is done: the dbix corpus is regenerated, polished, restamped,
re-graded and re-indexed IN PLACE (clego `421996f6`), the index copy is committed
here, and every gate is green (typecheck, typecheck:web, vitest 1,634 passing,
build). Prod is simply still serving the old bytes on both paths.

1. **Deploy the web app.** `.github/workflows/deploy.yml` triggers on a push to
   `main`, and `feat/lego-set-tab` is ~45 commits ahead of it. Until that merge
   lands, craftmatic.click serves the pre-38ea28c `.lxf` maths and 71043 keeps
   its floating window and pierced tower plates.
2. **Republish the corpus + index to R2.** `python sync_models_r2.py` in clego.
   The resume file `_r2_uploaded.txt` records KEYS, not content, so every
   `models/DbixConvV3/` line must be deleted from it first or all 2,302 changed
   files are skipped silently. ~2 h at its 6 polite workers. Until then prod
   serves the old dbix bytes and 76435's arms stay scattered.

### Everything else


- [ ] **`mecabricks` minifigs — ROOT-CAUSED, fix specified, trial passed, NOT rolled out.**
      The largest source (2,694 index entries) places minifigs wrong two ways, and it
      is user-visible: **all 20 figures in 76405 export to an add-on with NO HEAD.**
      Blast radius measured 2026-09-18: of the **2,724 sets whose best source is
      mecabricks, 1,541 (57 %) contain a `3814`-family torso — 4,603 torsos**, and
      every one of those sets exports headless figures until this ships. That makes
      it the largest remaining user-visible defect in the corpus.
      1. **Torso identity.** Design id `3814` resolves through `geograde/mb_partmap.py:260`
         (`_exists` is consulted before the design map) to Studio's UNOFFICIAL
         `3814.dat`, "MINI UPPER PART (Needs Work)" — an LDD stub whose origin is on
         the bottom plane and 10 LDU off-centre. The geometry lands correctly but the
         ORIGIN is (10, +32, 0) from where a `973` origin sits, so every offset measured
         against it is 32 out. 5,632 placements / 1,355 table rows. Head reads dy −56
         instead of −24, which falls outside craftmatic's `groupFigures` window of
         dy −48..+80 (`ldraw-entity-compiler.ts:724-746`) — hence the missing heads.
         **The torso half alone fixes the head defect.**
      2. **Arm rows.** 95.8 % of arms (11,288 of 11,785) carry ref `3818v2`/`3819v2`,
         whose learned row is `delta (∓2.5,16,−7), rot [-1,0,0,0,0,1,0,1,0], fit 0.6162`.
         `compute()`'s orientation search scores each candidate only at its own bbox
         delta, so a Y↔Z swap wins at 0.6162 — but **identity at delta 0 scores 0.7114**
         and is never tried. A scene solve over 400 scenes / 956 arms gives delta
         (0.02, 0.38, −0.15) with IQR < 0.4 LDU: the raw Mecabricks arm origin already
         IS the LDraw shoulder. These must be `gt` rows; no mesh re-fit can derive it,
         because the v2 mesh's forearm is modelled ~40° forward of LDraw's.
      **Fix:** `mb_partmap.py` map `3814`→`973` and consult the map before `_exists`;
      `harvest_mecabricks_sets.py:282` emit the table's stem when it differs from the
      ref; set the four arm rows to delta 0 / rot null tagged `gt`, the ~30 `973`-family
      `bbox-origin` rows to delta (0,32,0), and re-derive the 1,355 `ldraw=='3814'` rows.
      **Trial over 32 sets: arm median 32.7 → 18.3 LDU, within [14,21] 15.6 % → 76.2 %.**
      **Gate before rollout:** `python geograde/mb_gt_cohort.py --kind io --workers 10
      --mbdir <trial> --tag minifig-fix` against `mbgt_v5fix` (165 sets, matched 134,887,
      exact 84,367) — read the exact COUNT, not the rate, because mapping 3814→973 grows
      the matched denominator. Rollout is a full re-harvest + `mb_fix` + reindex + R2.
      **Out of scope, separate defect:** the ≥100 LDU tail is decorated torso refs
      (`973j`, `973aq` … 47 refs / 256 placements) that LDraw names `973pNNN`, emitted
      verbatim and resolving to nothing; plus `2550` falsely resolving to "Animal Monkey
      Body". Follow-up after that: hands `3820v2` sit ~12 LDU off the LDraw wrist.

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
