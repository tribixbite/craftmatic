# LEGO model → Bedrock add-on — tracker

This file holds open work and the evidence needed to resume. Completed history
belongs in `git log`, `docs/lego-sources-guide.md`, and
`docs/bedrock-addon-guide.md`. Spec: `docs/bedrock-entity-spec-2026-09-14.md`.

## Active round — 2026-09-22, the set's own cars and a working elevator

**Current pack, device acceptance NOT yet run:**
`output/bedrock-entity-qa/10261-mpd-fixed.mcaddon`, 731,388 bytes, SHA256
`f70a977bc0be506ea116f44f5a6c174c1b1ec34c77c89f9a38d381111d025ba5`, built at
`ce50c838` from `C:/git/clego/lego_sets/LDR/10261 Roller Coaster.mpd`.
**6 own ride cars + 8 figures + 2 trains** — it replaces the 18:03 pack the
user installed in world 922, which had 1 fabricated grey cart and 0 figures.
Rebuild any set with
`bun scripts/_playable_ref.ts <source> <out>.mcaddon --label="..."`.
Gates at `ce50c838`: `bun run test` 2,191 passed / 26 skipped exit 0, both
typechecks, `build:web` clean.
**Commit before building a pack** — the name carries the pipeline stamp.

**A pack's own `COASTER.txt` says which cart it has**: "The set's own cars are
the ride" vs "The grey Ride Cart". Read it before blaming the device — it is
the cheapest possible check that an export detected the set's cars.

### The previous pack PASSED on the device (world 921, 2026-09-21 night)

Evidence `output/bedrock-entity-qa/round921/` (133 files). Log gate 0 Actor /
0 Molang / 0 Scripting. The colour shimmer is GONE (six frames 0.4 blocks apart
near a surface: one flat colour, no hatching). The ride passed every point:
runs riderless, gravity profile 7.5/7.5/4.2/2.7/0.8/2.4/2.5/2.5 blocks/s,
station brake and dwell, **the "Ride the coaster" prompt appeared and tapping it
boarded** (no `/ride`), 70+ s carry, three cars visibly separated, Undo removed
everything. Riders sit in their car with hair; standalone figures within ~15 %
of the player. Size row read `Size 100 → 150 (recommended)`.
User's standing verdict on close-up: **better but not yet "near-picture
accurate"** — at 2-5 blocks round track tubes are stair-stepped and 2x2 round
bricks read as squares. That is the voxel cell; 1 LDU costs 316k cuboids.

### What has landed since that pack (all committed, none device-verified)

- **The set's own cars ride** (`ab2aebf9`, `47a4495a`). Cars, riders, platform
  and counterweight leave the shell; one entity type per distinct car body;
  each rider is a bone in its car, hidden while a player occupies the seat.
  A route with no detected car keeps the fabricated cart.
- **The elevator closes the circuit** (`47a4495a`). State machine track ->
  lifting -> delivered -> track, counterweight opposite, same
  unloaded-chunk/refused-teleport/quiet-retire guarantees as the cart. 10303
  cycles every 1,112 ticks in host simulation with the rider retained.
- **10261 runs on the same code**: closed 244.7-block circuit, 3 of 6 cars
  riding, siding train parked by the short-route rule, chain lift holding
  2.5 blocks/s. `coaster-track.ts` now strips a leading `<set> - ` from
  embedded stems, without which its first-choice index source extracts NOTHING.
- **Model no longer vanishes** (`b3ec0c02`, `9831d222`, `54ed4805`). Bedrock
  culls an actor by its COLLISION BOX: a 0.1 x 0.1 shell culled at 64 blocks,
  which is why the device saw it disappear at 70. The box now sizes from the
  model (10303 draws to 176) and the LOD hull, being the same actor, is planned
  against that cull instead of shipping unreachable geometry.
- **Invisible steps where scaling outgrew a jump** (`9831d222`). Reach on foot,
  bare -> with treads: chalet 0.25 -> 2.0 at every size; coaster 0 -> 5.58 at
  150 % and 5.56 restored at 400 %; Himeji 0.19 -> 4.0 (4.5 at 400 %); micro
  Hogwarts 0 -> 2.0. Verified so reachable-before is a subset of
  reachable-after; 100 % output byte-identical.
- **Every in-game `%` is spelt "percent"** (`b3ec0c02`, `9831d222`) — Bedrock's
  form renderer deletes a bare percent sign.

### Device verdict 2026-09-22: both coasters ride; the four defects are FIXED

The user rode BOTH sets: 10261 "nearly flawless", 10303 "nearly perfect".
Screenshots in the session images dir. All four reported defects are fixed in
`680936ba` and `64dd5ecd`, NONE device-verified yet:

1. Slow drops were the per-tick step clamped to one authored sample spacing
   (7.5 blocks/s on a 1x 10303), not friction. Ticks now SUBSTEP, each substep
   still within the spacing: drops 10303 peak 8.9 -> 16.0, mean 7.3 -> 10.2
   blocks/s; 10261 peak 7.5 -> 13.0.
2. Cars see-sawed because each pitched on the tangent at its own centre. They
   ride the chord between wheel contacts now (50 LDU wheelbase, measured).
   Worst adjacent-car pitch 10303 66 -> 38 deg, median 7.3 -> 2.1.
3. The lift hand-off was NOT wrong: parallel transport carried the loops'
   torsion forward, leaving cars 61-84 deg banked, and delivery unwound roll
   0 -> -117 deg in one tick. Up vectors are gravity-up within 60 deg of
   upright, the smoothed curve normal when banked further inside a tight
   vertical curve, <= 20 deg/block. Hand-off now reads 0.0 both sides.
4. A player cannot roll, so a seat offset along the car's up vector threw the
   rider OUTSIDE an inversion. The entity now sits where the rider's head
   belongs and the body is drawn back on the rails through synced properties:
   eye 1.57 blocks BELOW the rails at both 10303 apexes (was 1.55 above), and
   every offset is exactly 0 on upright track.
5. Second trains dispatch at half a lap. 10261's is the siding's own three
   cars; **10303's is a second COPY of its own three — the set has no spare.**

Then the residue: the cars still tipped, and it was track data, the same
two-datum fault as the 80564 loops. `26559`/`26560`/`26561`/`34738` put their
SLOPED ends' running line 3.9 LDU below the rail top instead of 18.6 above.
Rebuilt on a measured rail-top table: vertices turning >25 deg went 10303
10 -> 0 (sharpest 64.6 -> 23.5) and 10261 20 -> 0; 10261's worst car-pair pitch
38.8 -> 26.1 deg. 10303's three rotated 26559 pull-outs are REAL 7.6-8.9 deg
kinks and were left, with an explicit stitcher overlap tolerance.

### Two QA surfaces now exist — use them before the phone

Documented in `docs/testing-guide.md`; `tools/console/README.md` for the first.
- **`bun run console`** (port 4600): every operation with its real arguments,
  over one model or a filtered batch, exporting results with their filter.
  `tools/console/inventory.ts` is the cheat sheet AND the single place to add
  an operation.
- **LEGO tab -> "Walk add-on"**: first-person walk over a built pack, colliding
  against the exact blocks it ships, with a key counting
  figures/seats/doors/track/vehicles/colliders/treads and a
  reachable/unreachable overlay.
Neither proves Bedrock's rendering, cull, form text, ride physics or memory.

Next steps for them, none urgent:
- [ ] Console: window filtering must go through the census op (the index's
  `defects` strings never carry "window"); browser and device operations are
  wired but never exercised; `_pixel_perf.sh ref` takes no label.
- [ ] Preview: `addon-walk.ts` exposes `world.simulated()`/`compareReach`
  (BFS-vs-player divergence) that the HUD does not surface yet — the natural
  next step, since that comparison is what found the BFS drop bug.
- [ ] Preview: no door candidates exist in either coaster pack, so the door row
  is only exercised by a synthetic test; cars on a route get no reach verdict.
- [ ] Preview cost: the `three` chunk grew 532.6 -> 554.1 kB because the walk
  pulls `CapsuleGeometry`/`Box3Helper`/`GridHelper` that were tree-shaken
  before. That chunk loads with the viewer, so ~21 kB is paid by everyone.

### Fixed 2026-09-22 evening: the grey cart was a SOURCE-SHAPE bug (`ce50c838`)

The user's world-922 pack showed one grey cart and no minifigs. Cause was not
the ride code: that pack was built from `LDR/10261 Roller Coaster.mpd` (the
index's FIRST pick for the set) while every green test and every earlier device
round used `IOModel2V2/10261.ldr`. An MPD embeds its parts as
`<set> - <mould>.dat` sections, so the placed id was `10261 - 26021` and the
embedded description line a stub (`0 26021`) where the library says
`Train Base 4 x 5 Roller Coaster`. Only `coaster-track.ts` stripped that
prefix; **eight other detectors kept their own normaliser**. Both matches fail
OPEN, so detection found nothing and the exporter fabricated a cart — no error
anywhere. `partStem()` (`web/src/engine/part-id.ts`) is now the single
normaliser and a stub description falls back to the library mould.
**697 of 6,375 corpus sources (10.9 %) have this shape**, so any set whose
first pick is an MPD was degraded the same way.

### Source-directive coverage — 2026-09-23 (`74d0911d`, `ba446503`, `e43bdc58`)

The reader acted on 2 of the 74 line-type-0 directives the corpus contains;
the rest were comments to it. What the sweep of 69,867 LDraw + 9,357 LXFML
files found, and what changed, is in the commits. The permanent tools:

- `web/src/engine/ldraw-directives.ts` — every LDraw directive, its effect
  (geometry / colour / structure / view / metadata), whether the reader acts
  on it, and the corpus count. `viaExpansion: true` means "described by a meta
  we ignore, but written out as ordinary geometry we do read" (LSynth, LDCad
  flex, MLCad hoses) — NOT a gap.
- `web/src/engine/lxfml-schema.ts` — the same for LXFML elements and
  attributes, plus `LXFML_ELEMENT_PREFIXES` for the `EBT_SCENE_PREFS_*` family.
- `bun scripts/_converter_coverage_audit.ts [--class X] [--json out] [--no-archives]`
  — walks every source file INCLUDING `.lxf`/`.io` archives and exits 1 on a
  directive missing from those tables. **0 unknown** today; 28 known
  model-affecting gaps across 4,225 sets. Takes ~180 s with archives, ~90 s
  without.
- `test/ldraw-directives.test.ts` — 23 tests pinning each behaviour.
- `node scripts/_shoot_set.mjs <set> <out.png> [waitMs]` — load a set in the
  LEGO tab at localhost:4000 and screenshot the viewer (needs `bun dev:web`).
- `node scripts/_shoot_addon_walk.mjs <pack.mcaddon> <out.png> [layers]` —
  open a built pack in the in-app walk, set the legend layers (e.g.
  `model,collider`), fly out, screenshot.

**Three readings the corpus overturned — do not redo these.**
`0 MLCAD SKIP_BEGIN` reads as "content the file excludes"; honouring it deletes
40,862 parts, because all 231 blocks in the corpus expand a `MLCAD FLEXHOSE`,
`RUBBER_BELT` or `SPRING` and the block IS the hose. Skipping is gated on
`IMPLEMENTED_GENERATORS` in `ldraw-parser.ts`, which is empty.
`0 MLCAD HIDE` looks like parts we lose; 1,235 of 1,627 land on an origin a
visible part already occupies (the archive sweep raised the footprint to 181
sets / 3,492 lines, same shape). Still skipped, on purpose.
`0 BUFEXCHG RETRIEVE` reads as a rollback to a saved LENGTH; the saved state
can be longer, and truncating made OMR/358-1 come out at 219 parts instead of
249. It restores a snapshot.

### Coaster track: neither 76417 nor 42703 has a contiguous track in its source

**76417 Gringotts DOES have a vault-cart ride** — the box art shows a rail
spiralling the rock with a cart on it, and an earlier note here calling it "not
a coaster set" was wrong. What is true is that the ride is not in the source we
ship: `DbixConvV3/76417.ldr` carries one `26021` cart base, two `24869` wheels
and exactly two track placements (one `25059`, one `80562`), no continuous
rail, and no flexible rail either — its only five flex parts are `92338`
CHAIN 6M, about 5 studs each. The built pack reports `Track 0` because there
is nothing to route.
- [ ] **Identify what builds 76417's vault rail and whether the source has it.**
  The inventory count matches the set (4,826 placements against ~4,803 pieces),
  so the parts are probably present under moulds not described as track. Start
  from the rock sub-build and list the moulds along the spiral.

**42703 Mermaid Roller Coaster Ride routes nothing, and the cause is measured.**
`bun scripts/_coaster_route_probe.ts <model.ldr>` prints each track mould with
whether an LDD→LDraw alignment exists for it, the components that formed, and
whether open endpoints are TOUCHING (a profile fault) or APART (nothing to
stitch). On 42703 built from its own LXFML, the only component that forms is
`25061 + 25061 + 26559` — all three moulds that HAVE an alignment entry — while
every unaligned piece (`25059` x2, `26560`, `80566` x4) joins nothing.

Five coaster moulds have no entry in either `ldd-part-map.json` (Studio's
`ldraw.xml`, which does not name them) or `ldd-measured-align.json` (clego's
learner, which had no set carrying both an LXFML and an authentic `.io` for
them), so they are placed from their raw LDD origin and land studs away:

| mould | part | corpus sets |
|---|---|---|
| `25059` | Train Track Roller Coaster Straight 4 x 16 | 51 |
| `26560` | Ramp 4 x 16 x 6 S-Shape Upper | 42 |
| `80562` | Train Track Roller Coaster 4 x 4 | 40 |
| `26561` | Ramp 4 x 8 x 6 Straight | 13 |
| `80566` | (used by 42703) | — |

The PROFILES are not the problem: 10261's closed 649.5-stud circuit is built
from 42 fragments that include 4 x `26560` and 2 x `25059`, so every profile is
proven. `bun scripts/_coaster_mould_audit.ts` sweeps the library for moulds
described as coaster track and reports which lack a profile — today only cars
and wheels (`24869`, `26021`), correctly.

**The missing alignments are NOT why 42703's track is broken — measured, and
it overturns the reading above.** That the aligned pieces joined and the
unaligned ones did not is a correlation; `bun scripts/_solve_track_align.ts`
tests it directly by searching every axis-aligned rotation and every endpoint
hypothesis for a correction that joins a mould to the anchors, scoring each on
the WHOLE model. On 42703 the best candidates need 244-335 LDU offsets on parts
of about 80 LDU and tie at half the endpoints — the signature of coincidence,
not of an origin convention.

The solver is trusted because it passes a positive control: on 10261, whose
track routes closed, it returns `e = (0,0,0)` with `D` identity as the top
answer for `25059` (5/6 joins) and `e = (-0.7,0,0)` identity for `26560` (6/8).
It finds identity where identity is right.

**The Mecabricks ground-truth route is dead too, and not just for this.** Two
independent and both-good sources of one set — `DbixConvV3/60372.ldr` and
`MecabricksLDR/60372.ldr` — agree on **6.2 %** of placements (53 of 857) under
the best of the 24 axis-aligned frames. A Mecabricks model is rebuilt, not
transcribed, so it cannot be used as positional ground truth for an LDD
correction. `scripts/_derive_ldd_align.ts` implements that method and reports
its own refusal; keep it for a corpus where the pairing IS exact.

- [ ] **Five coaster moulds still have no alignment row** — `25059` (51 corpus
  sets), `26560` (42), `80562` (40), `26561` (13), `80566`. That remains a real
  gap worth closing for placement accuracy; it is simply not the cause of a
  broken track. Deriving it needs a source pairing that is exact, which neither
  Mecabricks nor the LXFML/LDR pairs provide today.
- [ ] **42703's track is not contiguous in ANY source.** Shipped DbixConvV3: 8
  pieces, 0 routes. Ours from the LXFML: 12 pieces, 1 open route of 55.5 studs.
  Mecabricks 31142 Space Roller Coaster, an independent build with no LDD
  conversion anywhere, also routes 0 with 5-23 stud gaps. Before more work on
  the reader, establish whether these sets' captures contain the ride at all.

**Our own LXFML reader beats the shipped source for 42703.** Built with
`bun scripts/_lxfml_to_ldr.ts <in.lxfml> <out.ldr>` (the DOM-free core of
`lxf-parser.ts` with both shipped tables):

| | DbixConvV3 (index first pick) | lxfml-direct |
|---|---|---|
| placements | 861 | **904** |
| connected pieces | 33 | **21** |
| largest piece | 90.5 % | **92.9 %** |
| track moulds found | 8 | **12** (recovers 4 x `80566`) |
| routes | 0 | **1** (55.5 studs, open) |

Not published yet. It is a strict improvement on every measured axis and the
standing approval covers it, but the track is open either way, so publishing
buys completeness and connectivity, not a working ride. A candidate source is
staged at `C:/git/clego/lego_sets/LxfmlDirect/42703.ldr` (56,190 bytes).

**`applyMeasuredBound` is not optional in a script.** The learned table carries
325 rows whose correction is longer than the part it corrects (`50665` Minifig
Helmet moves 4,360 LDU on a 52 LDU part). The app drops them on load; a script
that calls `validateTable` alone ships them and flings parts across the model,
which then reads as a bad SOURCE. Cost the first time: a false "DbixConvV3
inflates the model" conclusion.

**1 LDD unit is 25 LDU, not 20** (`t_world = 25 (F t_bone) + …`, see
`scripts/gen-ldd-measured-align.py`). Comparing an LXFML extent against an
`.ldr` extent at 20 makes every converted model look 25 % inflated.

#### Regression gate for this round

`bun scripts/_favorites_export_sweep.ts --out output/bedrock-entity-qa/post-directive-sweep`
**40/40 exported, 0 problems**, coarsening unchanged against the recorded
baseline (42172 69 %, 77092 42 %, 10261 38 %, 10303 36 %). That is expected
rather than lucky: NO favourite source carries any of the changed directives,
so the sweep proves nothing broke rather than proving the fixes landed. The
fixes reach 14 other index first picks, 42097 and 10131 worst.

Walked `post-directive-sweep/76417.mcaddon` in the browser
(`node scripts/_shoot_addon_walk.mjs`): 54,700 cuboids / 17 entities, 12
minifigs, 8 doors with 4 vanilla at size, 3,388 collider cells. The legend's
"75 the preview could not read" is the two entities that do not spawn at that
size, not a pack defect.

#### Open gaps, largest first (from the audit's `--json`)

None is a bug in what we DO read; each is a feature of the source we do not
carry, and each was measured before being written down. Sets counted over the
whole corpus, not first picks.

- [ ] **Prints** — `Part@decoration` 3,874 sets, plus `PartVariant` (506) and
  `Part@variantID` (746), which are the SAME thing: the decoration catalogue
  for a part, keyed by 7-digit element id. LDraw has no print layer, but the
  Bedrock entity path already gives each material its own texture, so a
  decoration could ride in as a swatch. Largest remaining gap by set count.
- [ ] **Stickers** — `Sticker` 1,757 sets, `StickerAttributes` 283. A sticker
  `<Part>` carries a 7-digit element id with no LDraw mould, so it already
  resolves to nothing and adds no geometry; what is missing is its APPEARANCE
  on the part it is stuck to (`stuckToPartRef` + `anchor`).
- [ ] **Flex path** — `Bone@index`/`position`/`rotation`, 847 sets. A flex part
  carries a bone chain (10314 gives designID 75216 thirty-four bones) and the
  reader uses bone 0. That places the WHOLE element undeformed at the right
  anchor — 27965 is a 432 LDU cable — so the mass and the anchor are right and
  only the path is lost. Deforming it needs the mould cut into segments and
  skinned; nothing supplies that mapping. `partType="flex"` is 0.15 % of
  placements (2,371 of 1,562,110), so this is small and awkward, not urgent.
- [ ] **Second shell colour** — `Part@materials` comma list. 81.6 % of those
  lists repeat the same colour (minifig arms and legs list one material per
  shell and both match), so the first entry is exact there. The real gap is
  the other 18.4 %: ~10,050 placements corpus-wide.
- [ ] **`MLCAD HIDE`** (LDraw side) — 181 sets, 3,492 lines, deliberately
  skipped; see the note above. Revisit only with device evidence that a set is
  missing a part.

Reach today: the LXFML reader serves 271 `LXF` + 162 `EurobricksLDD` first
picks. `DbixConvV3` (1,713 first picks) is converted from LXFML by the clego
checkout, so the same gaps there need fixing in THAT repo.

### Open

- [ ] **Re-test 10261 in world 922 with `10261-mpd-fixed.mcaddon`** — the pack
  the user rode there was the broken one. Expect 6 LEGO cars in two 3-car
  trains, the second leaving the bay once the first is 121.8 blocks (half of
  243.6) ahead, and 8 minifigs.
- [ ] **Sweep the 697 embedded-part sources for other silent losses.** Figures,
  doors, chairs, vehicle facing and the voxelizer skip-lists all used the same
  broken id match, so those sets may have been exporting degraded packs too.
  Cheapest probe: export one and diff its entity list against the `.ldr` pick.
- [ ] **Device round for everything since the last one.** Unverified: the
  faster drops (16 blocks/s rider retention — only 7.5 is device-proved), the
  wheelbase ride, gravity-up at the lift hand-off, the rider-inside-loop body
  offset (it relies on Bedrock applying an animated root-bone `position` in the
  geometry's axis convention — zero on upright track, so if the body sits off
  the rails inside a loop that SIGN is the first suspect), the second trains,
  the ramp datum fix, the treads, and the 176-block draw distance.
  Settled offline since the last round: the 10303 station IS reachable on foot,
  bare, at 100 % — the earlier `/tp` was unnecessary.
- [ ] **10261 has never been device-tested at all** — its chain ride is
  host-simulation only.
- [ ] Close-up fidelity is still short of the user's bar, but one measured
  cause is now FIXED (`0913f4f7`): the planner scored a coarsened cylinder as a
  perfect box, so round parts were always coarsened first. 10303's shell now
  puts 22 parts at the coarsest 8 LDU instead of 40, at the same budget.
  Remaining levers, in measured order:
  1. **Budget — MEASURED, and deliberately not taken.** 10303 wants 139,409
     cuboids at its requested 2 LDU against a 43,976 budget; 10261 wants
     219,272 against 44,696; 42172 wants 223,809 against 48,716 (the worst, at
     69 % of placements coarsened). Exporting at `high` instead of `balanced`:
     10261 fidelity 0.8964 -> 0.9108 with placements at the coarsest 8 LDU
     1,120 -> 712, and 42172 0.8813 -> 0.9038 with 1,371 -> 324 — for 2x the
     pack cuboids (57.8k -> 97.7k, 46.6k -> 95.6k), i.e. ~4-5 simultaneous
     packs instead of ~8. **Not changed**: the user asked to restore close-up
     quality *while keeping* the memory reduction, and this spends exactly the
     memory. The UI already offers `high`/`ultra` per export
     (`schem-settings-panel.ts`, default `balanced`) if a one-off is wanted.
     Only the SHELL budget ever binds — figures use ~500 of 24,572 and door
     leaves 61 of 49,144, so there is no per-entity waste to reclaim.
  2. **Rotated-cuboid facets for round profiles — measured and half-built
     (`b4612548`).** `web/src/engine/ldraw-round-facets.ts` fits a part to a
     disc-swept-along-an-axis profile and measures the fan's IoU;
     `bun scripts/_round_facet_yield.ts <model>` prints the per-part verdict.
     Why it matters: round parts are 19.6 % of 10303's cuboids and **44.4 % of
     10261's** (one part, `6143` x530, is 76,850 cuboids = a third of the
     model). Facets do not compete with the finest grain, they dominate the
     COARSE rungs the budget forces round parts onto — 3941 is 26 cuboids at
     0.919 at 4 LDU and 5 at 0.919 at 8 LDU, against **4 at 0.929** as facets.
     194 of 239 round placements in 10303 qualify.
     **What is left: emitting them.** Nothing is wired in, so exports are
     unchanged. The constraints, read out of `ldraw-entity-compiler.ts` so the
     next attempt does not rediscover them:
     - `worldBoxes` and `renderCuboids` are built STRICTLY IN PARALLEL inside
       `instantiate` (one push each per prototype cuboid) and `forCull` indexes
       one by the other, so a facet path may not simply drop a part's cuboids —
       it must emit one worldBox per facet box or the indices desynchronise.
     - `mergeAlignedCuboids` would merge a rotated box with its neighbours, and
       `cullHiddenCuboidsWithinBudget` samples occupancy from the UNROTATED
       min/max when `aligned` is true. Facets must therefore not be `aligned`.
     - But `aligned: false` already means "unrotated box stored at the brick's
       pivot, placed by that bone's rotation", which is a different thing from
       "box carrying its own cube rotation". `studCuboids` dodges all of this by
       appending AFTER the cull and merge with no `aligned` field at all; the
       facet path most likely wants the same treatment, which then needs the
       part's occlusion volume still represented in `worldBoxes` so that stud
       exposure and culling of NEIGHBOURING parts stay correct.
     - Only `aligned` placements need facets (a signed-permutation matrix maps
       the profile axis to a cardinal axis exactly). A cylinder is rotationally
       symmetric, so the fan's absolute angle about that axis does not matter —
       the placement's in-plane rotation can be ignored rather than composed.
     - Facets are grain-INDEPENDENT, so a round part renders round even when the
       planner coarsened it. Teaching `planPartGrains` to re-spend the saving is
       a second step; without it the pack simply lands under budget.
  3. The stud facet ladder (4->3->1) and the 25 % stud cap: 71043 fits balanced
     at 46.2k but its 8,720 studs drop to 1 facet.
  Measure with `bun scripts/_round_part_fidelity.ts` (true per-part IoU per
  grain) and the `grainPlan` block in any export's diagnostics.
- [ ] Both 10303 lift docks are SNAPPED (travel 1,884.9 LDU, 0.7 degrees off
  vertical) rather than the pure-axis 1,857.8, so the car lands on track at
  both ends. Reported in the pack warnings; revisit if it reads wrong in game.
- [ ] **8 of 38 favourites ship as SEVERAL sub-builds laid out side by side,
  not assembled** — measured with `bun scripts/_source_connectivity.ts`,
  counting a piece holding 5 %+ of the model as a sub-build:
  60446 51.4 % largest / 3 sub-builds, 76417 59.4 % / 2, 10354 72.5 % / 2,
  77092 73.6 % / 2, 42652 86.7 % / 2, 76269 89.6 % / 2, 42639 90.5 % / 2,
  42663 90.7 % / 2. (71043 is an `.lxf`; the LDraw reader returns nothing for
  it, so it is UNMEASURED rather than 0 %.) 76417 is the case the device
  confirmed: the white bank (2,867 parts) and the dark rock vault (1,511) stand
  115 studs apart at the same height, each ~46 studs tall, where the box art
  shows one ~90-stud tower. NOTHING in LEGO's own instruction file carries a
  placement transform for them — see the memory note, which lists every element
  checked so it is not re-searched.
  Deriving the join by contact-maximisation was tried and FAILED
  (`bun scripts/_assembly_mate.ts`): 2,240 offsets make contact, the best
  scores 36 contact cells over a 46x46-stud footprint and ties with the next, a
  0 % margin. AABB occupancy is too coarse. A real attempt needs stud and
  anti-stud geometry, and possibly rotation — which is the physical-validity
  work ROADMAP.md already names as the moat, and 8 affected favourites justify
  it over hand-fitting one transform.
- [ ] **The "loose in the SOURCE" warning fires on 39 of 40 favourites, so it
  carries no signal.** `connectedClusters` (ldraw-entity-compiler.ts) unions
  AABBs within 4 LDU; on 76417 it reports 1,832 placements in 72 pieces "will
  look like floating pieces in game", but geograde grades that same source
  float=24 (0.5 %) with BIG=0 and rates it the BEST of the set's three sources.
  The two agree on the geometry — geograde's zero-tolerance `split0` is
  1,806p — and differ only in tolerance, so the add-on is almost certainly
  over-reporting. Decide it by looking at one of these models in game before
  changing a threshold; totals per set are in
  `output/bedrock-entity-qa/favorites-sweep-v2/summary.json`.
- [ ] Counterweight detection is a heuristic (`COUNTERWEIGHT_LATERAL_MAX_LDU`
  480, axis parallel within cos 25 degrees).
- [ ] Two 64.6 degree zigzags at the mirrored 26559 start-start joins: a
  +/-1.1 LDU wobble from `measuredRamp`'s flat controls carrying a 0.9 endpoint
  slope. Pre-existing ramp-profile question, not a fold.
- [ ] `mainVehicleOnly` exports get no walk-through measurement (the scene block
  is skipped); grid sources cannot have one. Deliberate.
- [ ] A device round could try `%%` on one string; if Bedrock's form renderer
  honours it, `bedrockInGameText()` is the only change.

## Closed 2026-09-21: 10303 track repair, publication and the first rideable

Kept only because a later round could re-open one of these; the full story is in
`git log` and `docs/bedrock-addon-guide.md`.

- Six invisible `80564` loop quarters, the `43753` hair and the `x346` teeth
  were all fixed by ONE parser change (`caff7cff`): Studio DATs marked
  `IsSubModel False` / `IsAssembly False` are terminal meshes, and inherited
  colour `-1` normalises to LDraw 16. The repaired source is published — prod
  serves `df3b47c3…` and the index entry matches (75397 likewise, `b552734a…`).
  The user has since granted STANDING approval for scoped R2 publication and
  index corrections; publish with `--only <path>`, verify on the PLAIN url.
- The ride was device-proved on 2026-09-21 (377 s rider retention, shuttle
  reversal, clean log gate) and again on world 921. `x346` maps to `41669`
  (byte-identical mesh); `28710` and `30426` stay unmapped, honestly.
- The "missing top track piece" is not missing: 10303's lift is a brick-built
  platform parked at the base. The vertical `25059` stack is the
  COUNTERWEIGHT's guide — never route a car on it.
- **Still open from that round:** a same-UUID pack upgrade needs the ACTIVE
  folder overwritten (a UI deactivate/re-activate does NOT repoint a pinned
  uuid, and `adb push` cannot create a directory under `Android/data` while
  still reporting success). The user has since cleared every pack except the
  base Craftmatic one and made a flat blank world `921`, so a fresh import
  should be clean — check for a duplicate uuid folder before importing anyway.

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

## Device work — current state

The user cleaned the phone on 2026-09-21: **every behavior and resource pack
except the base Craftmatic one was deleted, and a new FLAT BLANK world `921`
was created** for QA. Use world 921. No reboot, no framework restart, no data
clear, no world deletion, and **no recursive delete anywhere** (the user
objected to one being attempted). Back up any device file before overwriting,
with sha256, under `output/bedrock-entity-qa/device-backups/`.

Working recipe, all measured:
- `C:/Android/Sdk/platform-tools/adb.exe -s 192.168.0.122:5555`. `error: closed`
  and `device offline` fire constantly — reconnect and retry; it is not a device
  failure. Wrap every call.
- Import with the content-URI VIEW intent while Minecraft is in the foreground,
  then verify by reading the INSTALLED folder's `manifest.json`, never the exit
  code. Check for a folder already carrying the pack's uuid FIRST.
- Gate a round on `grep -cE '\[Molang\]\[error\]'` over the newest content log
  in `…/files/games/com.mojang/logs/`. Nothing of this class reaches logcat, and
  the log can stop flushing mid-round — force-stop and relaunch to rotate it.
- `input motionevent DOWN/UP` does NOT activate in-game form buttons; a held
  press (`input swipe x y x y 150`) does. Main-menu buttons take motionevent.
- Git Bash mangles a device path ARGUMENT (`adb pull /sdcard/...`): use
  `MSYS_NO_PATHCONV=1` or PowerShell. Inside `adb shell "…"` it is fine.
- Screenshots: downscale below 2000 px and 4 MB before reading.

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
- [~] **The world-block mirror is being REMOVED (user decision, 2026-09-22).**
  It was never just the grid: LDraw is Y-down right-handed and the project
  converted by negating Y alone, which is a REFLECTION, so every model rendered
  mirrored. Measured on 10261's printed `3069bp82`: `det(instance matrix)`
  -0.9996 and **932 of 932 glyph triangles reversed** from the printed side.
  The user saw it as `COASTER` reading backwards against the box art.
  Mirrored today: viewer, GLB/OBJ/STL/3MF (an STL prints chiral-wrong with
  inward normals), the block grid, .schem/.litematic/.mcstructure, the shell,
  and the add-on preview — all mutually consistent. Chirally CORRECT: Bedrock
  vehicle/figure entities (det +1, Pixel-proven) and the LXF import since
  2026-09-17. `SHELL_FRAME = -I` is a COMPENSATION that exists only to land on
  the mirrored grid.
  Watch for the double-flip trap: before 2026-09-17 the LXF parser was itself
  mirrored and the viewer cancelled it, so LXF sets looked RIGHT while every
  other source looked wrong. Any source whose text reads correctly today is
  therefore suspect, not correct.
  The fix is `diag(1,-1,-1)` everywhere (the convention `FRAME_SIGN` and
  `ldrawToRenderRotation('+z')` already use). It is breaking: every previously
  exported pack or schematic becomes mirror-inconsistent with builds already
  placed in worlds, and **every Pixel-verified ride round was verified in the
  mirrored frame and needs re-verification**.
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
