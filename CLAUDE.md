# Craftmatic — Project Guide

Minecraft schematic toolkit **and** an LDraw (LEGO) 3D viewer, web UI in `web/`
(Vite + TypeScript + Three.js). This file is the version-controlled source of
truth for architecture + hard-won conventions. Keep it current; do not keep
durable project knowledge only in private/agent memory.

**PDF reconstruction (2026-09-07):** see [the audited status](docs/pdf-reconstruction-status-2026-09-07.md).
The user requires PDF-only set input, optionally an available parts list, and **zero runtime VLM**; VLM is permitted
only during development/verification. Historical 95.4% extraction coverage is
not model accuracy. The live index has 2,355 reconstruction-only base sets;
no new audited output meets the latest >=90% full-model placement target. Do not launch the old VLM
batch or overwrite better-source models. The actual engine is in `C:/git/clego`;
`recon_extract.pdf_pipeline` is a quarantined deterministic research entry point,
not a certified assembler. Filter the full catalog before paginating results.
Follow-up [GPU matching trials](docs/pdf-reconstruction-matching-trials-2026-09-07.md):
a small CNN improved eligible BOM-icon retrieval (374/411 vs 357/411 pixels),
but did not improve actual unseen-set PLI transfer. Learned scalar placement
rankers also failed. Do not equate this conditional icon score with model
accuracy or scale training on the contaminated historical step labels.
Current [placement rearchitecture](docs/pdf-placement-rearchitecture-2026-09-07.md)
uses native PDF scenes, calibrated cameras, CAD geometry, joint additions and
exploded-step constraints. Adding arrowhead-to-stud contact evidence selects
6/6 exact poses in the opening development stage. Per-scene camera calibration,
atomic groups and GPU material/color plus visible-edge scoring extend this to 26/26 structurally
correct emitted parts (15/26 raw strict, 20/26 after authoritative filename aliases;
the remaining differences are verified unprinted-part yaw symmetries). This is only
26/90 full-model coverage, NOT complete-model accuracy or population accuracy.
Reference order is not necessarily PDF step order. Reference models remain
evaluation-only; runtime proposals and production data must stay separate.
Continued crop trials expose x-only component assignment and unmasked step
text as real defects. Quantity-anchored crops + frozen CNN score 11/11 on a
small visually checked development slice. Fixing a morphology coordinate shift
and using actual upper-ink distance recovers 409/412 quantity anchors on five
PDFs (crop coverage, NOT identity accuracy). 40377 improves from 45 to 83 emitted
parts / 31 to 69 correct part-color instances, but remains at 2/90 correct poses.
Joint PDF inventory-capacity assignment then emits 86 parts / 72 correct
part-color instances on the same fixture; full-pose accuracy stays 2/90.
The final v5 duplicate-label fix yields 410/411 unique crop anchors and emits
87 parts / 73 exact part-color instances on 40377, still 2/90 full poses.
The PDF BOM itself overlaps OMR at only 73/90 exact IDs: at least 14 of the
differences have universal catalog/rename evidence. Do not mislabel these all
as CNN errors. A 360-candidate page-filtered placement trial worsened to 1/90.
Keep `scripts/pdf-recon/anchored_pipeline_trial.py` opt-in and quarantined.
Round nine (backtracking + inventory capacity) settles where the remaining loss
is. Page-level backtracking is built (`placement_backtrack.py`) and works: the
`registration_collapse` trigger fires on round eight's known regression, reopens
page 19 and recovers 40377 from 51 to 53/90. But **the drive's own contribution
is +0 whatever body it starts from** - 41601 driven from a 6-of-7 opening lands
6/108 and adds nothing over sixteen pages, exactly as it added nothing from its
3-of-7 opening (3/108); 41624 from a +1 opening gains 13 emitted pieces, 5 placed
pages and zero correct poses. 15 of 17 driven pages on 41601 retain *nothing*
better than what was selected. So do not spend on the per-page search: spend on
what picks a body. `placement_construction_symmetry` (round six) selects 41601's
6-of-7 opening with no reference at all (plane agreement 1.000 vs 0.600).
**Inventory capacity is refuted as a ranker** (count capacity is vacuous where the
page quota is exact; 0 draw-down deficits; the look-ahead is identical on all 75
candidate bodies measured) - do not rebuild it. Mould variants
(`15573`/`3794a`/`3794b`, `4032a`/`4032b`) share an *exactly* equal universal
bounding box but differ in voxels, cores and connectors: **one capacity pool, not
one search candidate**, and admitting them takes 41601's drivable scope from 83
pieces on 19 pages to 92 on 23 (`placement_slot_adapter --mould-policy
withhold`). The open problem round nine created: every runtime-legal
branch-selection rule shipped picks the *worse* branch when a better one exists.
Round ten closes the on-ramp and leaves the drive where it was.
`scripts/pdf-recon/placement_autonomous_run.py` runs the whole chain from a PDF
and nothing else with **zero attended steps** - printed BOM, callout
association, identity/slot MILP, CAD-size gate, mould pooling, derived page
scope, construction, reference-free opening selection, drive. Across the six
BrickHeadz fixtures with stepped references it puts a **median 95% (mean 90%)**
of the printed inventory into a drivable page scope (round nine: 77% on one
fixture with the scope chosen by hand), and on 40377 the derived allocation
reproduces all seventeen hand-worked pages identically at part, colour and
count. Two association classes were repaired generically - translucent artwork
fragmenting under a single ink threshold, and anchor-to-component association
solved as an assignment rather than per-anchor-nearest - and measured over 25
PDFs / 1,104 anchors with **0 broken**. The **CAD-size consistency gate**
(`placement_slot_size_gate`: crop diagonal over universal CAD bounding-box
diagonal must agree across one page) is the program's first working non-pixel
channel; it fires only where an error is demonstrated (12 pairs on 41601, 0 on
41624 and 40377). Identity residue, measured: of 410 callouts 90.0% take their
own best slot, 6.8% are solver compromises, 3.2% get nothing, all because the
frozen encoder cannot separate small parts of the same shape. **The combined
41601 run - the symmetry-selected 6-of-7 opening on the mould-pooled scope -
lands 6/108 with 85 emitted and +0 of its own: exactly the maximum of the two
gains, with no interaction. The three AUTONOMOUS totals - PDF-only, zero
attended steps - are 2/90, 6/108 and 2/109, a mean of 3.2% against the 90%
target; quote these and not the older attended numbers, because 40377's 54/90
was 45 HAND-BUILT pieces plus nine and 41624's 6/109 rests on a construction
body its own objective does not prefer.** The multi-view probe is **refuted**: scoring the
36 retained bodies under a later page's accepted registration ranks them by
whose camera that registration was propagated from (the two lineages disagree
symmetrically, 5-6x either way) and the within-class 24-way tie survives every
view - so do not build multi-view aggregation on accepted registrations.
Do not raise the slot solver's acceptance floor (41601 prefers 0.50-0.70 by +1
accounted piece, 41624 prefers 0.30 by +3) and do not use crop-area against
inventory-icon area (a printed BOM scales each icon to its cell).
**Run the pdf-recon tests from the repo root** - several read `output/`
relative to the cwd. `placement_autodrive` needs `--continue-on-unsupported`.
**Round six measured the failure population instead of buying another channel**
(`placement_population_table`, `placement_retention_audit`). Across both fixtures
110 distinct reference instances are lost as: **68 never enumerated, 8 rejected
by the occupancy screen, 20 enumerated but in no retained assembly, 4 ranked
below another.** Ranking is 4% of the loss — do not buy another selection
objective. Visibility, which round five named as the plateau's cause, is 7 of 120
in-scope failures. Mirror completion, inventory-capacity forcing and a
mirror-consistency tie-break were built, measured and **not adopted** (2 of 25
distinct parts, 0, and 0); a construction's own bilateral symmetry is worth +1 on
40377 page 20. No page of either fixture has ever finished its closure — the
128-parent budget was hit on all 40 driven pages — and raising it to 1024 takes
page 26's bank recall 3/5 → 5/5 while changing its placement not at all, so the
budget is a precondition, not a fix. Measured architecture ceiling: **79/90 on
40377, 31/109 on 41624**. The two fixtures fail at different stages (retention
vs enumeration), so nothing here generalises on two fixtures.
**A chain-level A/B is untrustworthy until the tie-break is deterministic**
(`placement_score_ties`): 7 of 40377's 13 driven pages and 15 of 41624's 27 end
in an *exact* tie at the top image score, every one between genuinely different
assemblies, up to 12 of them. A perfect tie-break is worth **zero** coverage —
inside every exact tie on 40377 all members have the same correct-part count — so
ties are variance, not bias. But they redirect the chain: one 25269 quarter tile
on page 19, two quarter turns apart and identical to 16 significant figures,
moved page 22 from `drawing_to_drawing` at 1.6916 px/LDU to `body_template` at
1.4863 and its score 0.3668 → 0.2529. The raised-parent-budget chain's only
measurable effect through page 19 was enlarging that tied set from 2 to 3.
**Colour classification: LDraw 19 (Tan) and 191 (Bright Light Orange) both have
OpenCV hue 20**, hue was the sole discriminator and `argmin` broke the tie by
palette index, so 40377 pages 26/27 had *zero* bright-light-orange in their
coarse target and scored 0 agreement for all 1,926 and 4,142 candidates. Both
fixtures carry the collision (41624: 17 tan vs 8 orange parts). Lab distance
separates every pair in that warm cluster by ≥16.7 where hue separates two by 0.
**Round seven: the closure is finishable, and retention is the SMALLEST lever.**
`Assembly.collides` was 98.3% of parent-expansion time at 6.3 ms a call, so
finishing one page's first round projected to 26 minutes.
`placement_fast_collision` vectorises the predicate **bit-exactly** (same
association order, so every intermediate is identical; `collides` short-circuits
only on proven implications) — 18.4x, and now every 40377 page's *complete* first
round runs in seconds to 2.4 min, ~11 min for the whole chain. Banks grow from
the 8,192 cap to 50k–140k poses. **Finishing it buys nothing on its own** (third
confirmation): page 19 at 65,637 poses / 19,222 screened reaches the same score
as at 7,467. And the occupancy screen plus `build_bank` are **linear in the
bank** (~6 min/view at 65k candidates; 363–750 KB per screened survivor), so the
parent/pose budgets were always *screen-cost* parameters — use
`--max-bank-candidates` with a completed closure or `build_bank` refuses and the
page emits nothing. Retention re-measured (`placement_retention_stage`): of 21
distinct instances, bank truncation 0, beam width 0 (the reference-equivalent
complete assembly scores *below* the beam's own best complete state, so a perfect
search returns the same wrong answer), the low-paint-tail hypothesis refuted (the
one *retained* page-19 target paints the fewest pixels of all six), 5
closure-parent connectivity, 2 collision, and **14 lost on a plateau** — 46.9% of
page 19's screened candidates change the incremental score by *exactly* zero
because a candidate whose pixels are already painted with the same class adds
nothing, *including when a wrong piece stands there*. **10 of the 21 are the
native objective preferring another pose**, i.e. already ranking losses. Adopted:
`--exchange-window-order own_agreement` (order the exchange's rendered window by
each candidate's own painted agreement — one bincount, no extra render), worth
**+1 on the whole chain, exactly as predicted**; `--tie-break pose`;
`--chromatic-metric lab` (a correctness fix, **not** a lever — on pages 26/27 it
demotes the correct poses from the plateau to ranks 1,164–1,639). **Chain
numbers: r5's 53/90 survives re-baselining under determinism; the window
ordering reaches 54/90** (alias 38, strict 32, precision 0.684 at 79 emitted)
**and 41624 reaches 6/109** (86 emitted, the extra part on page 5, but 20 of 31
placed pages tie-exposed — the highest in the program).
Round six's 1024-parent chain finishing at **50/90 is a coin flip, not its
configuration**. `placement_trajectory` now prints a `tied` column per row — do
not quote an inter-round delta without it. The breadth clause has fired; the plan
is in the doc.
**The `scripts/pdf-recon` tests use three harnesses and mixing them hides
failures.** Most files are a `if __name__ == '__main__'` loop printing `ok  <name>`
(run with `python -X utf8 -B <file>`), some are `unittest` (`Ran N tests`), and a
few are **pytest** (`test_placement_multi_shape_batch.py`,
`test_placement_evidence_closure.py`, `test_placement_origin_refine.py`). Running a
pytest file with plain `python` exits **0 having run nothing**, so a sweep that only
checks exit codes silently skips them — run those with `python -m pytest -q` from
`scripts/pdf-recon`. Current totals: 148 tests across the print-style and unittest
files, 36 more under pytest.
Round two of the placement program fixed candidate generation and the page-17
camera. The bounded connector closure expands only a bounded number of
base-attached poses and visited them in enumeration order, so on 40377 page
index 17 the parent of the stacked second 60474 sat at bank index 3927 of 4147
and no pose cap could reach it. Ranking closure parents by the page's own
arrowhead evidence (an instruction arrow points at the connector receiving the
next piece, so it names the parent) moves it to rank 39-70 and takes bank recall
from 1/2 to 2/2 with a SMALLER bank. Page 17's stud-row camera is separately 13%
small - 29.1-30.1 px/stud against 33.8-34.1 on pages 15 and 16 - which is what
round one misread as a scoring failure after a VLM eyeballed the viewpoint;
the previous page's measured scale is now offered as an extra camera hypothesis.
The opt-in scale ladder inside containment refinement picks the WRONG direction
on that page and is off by default. Page kinds are measured, not assumed: a
drawing showing the assembly cannot be much smaller than the assembly's own
silhouette (40k-83k px on 40377's body pages, 18k and 8k on its two subassembly
pages), and the driver now holds a body table and schedules cross-page
attachment itself. 41624's three unmapped identities are resolved by confirming
the factorized universal-catalog bridge against the element's own inventory icon
(modal foreground colour, not the mean - the mean makes white read as grey);
all 109 pieces now carry one identity. RESULTS, honestly: whole-model coverage
on 40377 stays at 46/90 - fixing recall, the camera and the colour classifier
each changed the failure mode without moving the count. Round two blamed a
sub-stud pose difference; that was WRONG - page 17 draws one plate placed and
one exploded, so its target shows a one-plate assembly and every added plate
lowers the score (0.5954 body, 0.5679 one, 0.5409 both). Superseded by 64224c0. The colour fix is a correctness fix, not
an accuracy gain: it costs one structural match on 41624. The page-13 to
page-14 attachment now runs under the driver and reproduces the hand-issued
result to the part (42 emitted / 41 structural / precision 0.976). 41624 is
driven for the first time and reaches 3/109 - its blocker is now its 2-of-3
bootstrap, not identity. Do not re-litigate any of these as search failures.
Round three moved 40377 from 46/90 to **48/90 (53.3%, 48 correct of 51 emitted,
precision 0.941)** and found that round two's "the scorer cannot separate
sub-stud poses" verdict was three separate defects, none of them scorer
resolution. (1) `placement_diagnose_target_score` rebuilt the drawing without
the run's own mask, scoring 65,869 px where the run used 52,177, so its verdicts
compared two different questions - `placement_run_scene` now rebuilds the run's
target and the driver records `mask_source`. (2) An exploded page's target does
NOT contain the piece being added: 40377 page 17 draws one black plate placed
and one exploded, so body 0.5954 > body+one 0.5679 > body+both 0.5409 and
completeness itself is penalised. `placement_exploded_page` withholds such a
piece from the image phase (it fires on 1 of 40377's 26 pages and 2 of 41624's,
so nothing else changes) and `placement_exploded_attach` places it from the
arrows - 0.51 px arrowhead error, score 1.0 against 0.1244 for the next pose.
(3) The occupancy screen budgeted a candidate's overflow in the BODY's units:
2 px tolerance against a correct plate's own 19 px of antialiasing, so the right
pose was never in the bank. A proportional allowance in the candidate's own
units (0.01) keeps it, and page 17 then places both plates. `placement_camera_gate`
makes a camera an accepted/refused decision with a recorded reason - unexplained
drawn ink over what the page can add (0.05-0.62 on every page that placed
correctly, 1.10-1.58 on every page that did not, both fixtures) plus cross-page
scale; raw coverage CANNOT serve, it depends on body size and would refuse all
of 41624. `placement_drawing_scale` measures the camera scale from the drawings
alone (consecutive 40377 drawings align at 0.99-1.03, IoU 0.89-0.99), which is
what refutes page 18's own 12.6%-small stud rows without the body.
`placement_construct_body` builds a body from a drawing with nothing to register
against by nailing one allocated piece to the identity transform - the frame is
free and the camera sweep already covers every root orientation - and reproduces
41624's stage-specific 3-piece bootstrap (2/3) generically in 17 s. Do NOT
re-attack pages 12-19 for the target: they hold only 58 of 90 parts, so a
perfect drive through page 19 caps at 64%. Evaluating every retained candidate
rather than the selected one gives at most +1 pose per page (46 vs 47 on pages
17 and 18, equal on 16 and 19), so selection is not what is missing.
**2026-09-08 driver + search rewrite:** 40377 coverage moved 26/90 → **46/90
(51.1%, 46 correct of 49 emitted, precision 0.94)**, still far from 90%. The stage-specific runs are replaced by
`placement_autodrive.py` (camera → registration → silhouette-containment
refinement → multi-shape registry → search, atomic journal, hash-verified
resume). Two evaluation-only diagnostics proved the bottleneck was the SEARCH,
not the evidence: the pose bank already contained the reference poses and the
reference-equivalent assembly outscored the selected one under the runtime
scorer. `placement_layer_beam.py` replaced the depth-first traversal (which
reached ZERO complete assemblies in its 100k-node budget on a six-part page)
with a support-frontier beam ranked by the *exact* depth composite via sparse
bincount deltas, plus a quota-preserving exchange; `native_exchange` then
optimises the scorer that actually selects. Page 12: 33/38 → 37/38, hitting the
reference-equivalent score exactly. Cross-page attachment of a separately built
subassembly (page 13 built, page 14 attached) works end to end and is worth SIX
extra correct poses downstream, because a wrong body registers worse. **The
binding constraint is now CANDIDATE GENERATION at page index 17**: the bank
recall diagnostic finds only one of the two reference 60474 poses, and raising
the bounded connector closure to 1,024 parents / 24,000 poses does not produce
the stacked one. A development-only VLM visual check confirmed the camera and
scale there are right, so it is not registration. Nothing emitted after page 16
is correct — do not read a rising part count as rising accuracy. Structural evaluation itself was wrong until
`placement_part_symmetry_table.py` replaced a hand-written symmetry list with
per-part universal-CAD proofs (a square 4x4 plate's four-fold yaw was missing).
Round four did round three's first recommendation and it worked on its own terms
without moving the count. `placement_drawing_registration` propagates the previous
page's ACCEPTED registration through the similarity that aligns the two DRAWINGS
(`M' = s·M`, `o' = s·o + t`), so the emitted body no longer chooses the camera or
the origin: page 18 registers at 98.4% coverage inside the containment allowance
where its own stud rows reach 75.4% and round three could not contain it at any
offset, the gate accepts it and the search selects it. Three corrections came out
of driving it: the registration a run USES is the selected view's, not the first
accepted one; the drawing ratio OVER-states the camera ratio (15→16 optimises at
1.03 where both pages' stud rows agree within 1%) so the unit scale must always be
offered beside it; and the camera gate must charge a SKIPPED page's ink to that
page or it refuses every page after one. **Coverage stays 48/90.** The reason is
the commitment ORDER, not any part round four touched: page 18's single 4x4 plate
is the root of ≥13 further parts (page 19's six mount on it via the 41740, page
20's seven attach into the same region), its two candidates differ by 4 LDU, BOTH
engage twelve connectors, and three objectives rank them within 0.25% with two
wrong (whole-drawing 0.488517 vs 0.487312; local rerank widens it to 0.0172;
seated tie-break ties at 12 mates each). Page 19's drawing settles it — the fix is
a bounded TWO-PAGE decision window, not a fourth objective. Do not build another
selection objective for sub-stud ties. Two real defects were also fixed:
`98138pb072`'s female anti-stud reference point sat at the INNER end of its own
tube (from a flipped `stud4o` reference), so the printed tile had twelve legal
mates and ZERO collision-legal ones and page 20's construction returned
`no_models` at every root — `placement_connector_repair` moves it to the bottom
face where LDCad's own convention puts it (0→12 mates, exactly `25269`'s
transforms; opt-in `--repair-anti-studs`, seeds `recon_v8.assembly._pconn_cache`,
no upstream edit); and `ShapeRegistry.close` counted its parent budget GLOBALLY
across rounds, so a second connector hop was unreachable on any page whose
base-attached set exceeds the budget (page 19: 3,587) — `--per-round-parents`
reaches rounds 2-3 but does NOT recover page 19, because choosing WHAT to expand
in a later round is a separate problem the round-one evidence ordering does not
cover. Both subassembly constructions now COMPLETE (page 20 seven parts, page 31
four, from every root) and both are 1 structural of N, i.e. 0 of 6 and 0 of 3
beyond the nailed root — page 31's two drawings align at IoU 0.9914 because flat
black tiles on a black 6x6 plate barely change the silhouette, so that one is a
DATA limit. Attaching a 1-of-7 body would poison the pages after it, so the reach
drive runs without `--group-run`. **RESULT: 40377 moves 48/90 to 53/90 (58.9%)**
in one 16→32 invocation - ten of the thirteen pages 20-32 reached, nine placements
after page 19 on the propagated camera. Page 18 places its plate at EXACTLY
(0, -112, -48) in the full chain where every earlier run put it 4 LDU shallow, and
page 19 then places a corner-round tile on it - the piece that was 8 LDU out of
reach before. So **the page-18 tie was downstream of registration quality, not an
irreducible scorer limit; the earlier memo in this round saying otherwise is
corrected.** Honest checkpoints move opposite ways: page 18 is most accurate
(49 of 52, 0.942), page 29 highest coverage (53 of 68, 0.779), the run ends at
53 of 77 (0.688); pages 23-30 emit 14 for 3 correct. 41624 goes 3/109 to
**5/109**, accurate checkpoint page 4 at 9 emitted / 5 structural / 0.556, ending
22/5 at 0.227 - and its pages 5-8 were unblocked by a second gate defect:
`scale_window` makes the cross-page scale criterion an INTERVAL from the previous
accepted scale to that scale times the drawing ratio, because the ratio over-states
(1.23 on a nine-piece assembly) and round three used it as a point, refusing an
unchanged 1.0860 camera for being "19% off". **The binding constraint is now that
CONTAINMENT still passes through the body even though camera choice does not**:
40377 page 22's propagated registration covers 90.3% of its drawing against 76-80%
for the alternatives and is rejected by 116 pixels of 55,333, because the body
carries page 19's five wrong parts. Do not raise the fraction knob - compare a
page's registrations by coverage within a relative multiple of the best achievable
overflow instead. Also: 2 of page 20's 7 pieces CANNOT BE SCORED at all
(`98138pb072` in the PDF BOM vs `98138pz0` in the model, alias parked as a
candidate with its evidence), so page 20 caps at 5 of 7 until that is settled.
Round five took round four's three recommendations in order and **coverage stayed
at 53/90 (58.9%)** — the round's finding is that registration is no longer the
constraint anywhere on 40377 pages 16-30, evidence is.
(1) **Containment is judged WITHIN the page now.** `placement_origin_refine` also
admits a registration whose overflow AS A FRACTION OF ITS OWN RENDERED AREA is
within a multiple (default 4) of the smallest such fraction the page reaches,
capped at 3% and withheld when the page's own floor exceeds the cap. Normalising
by the render's own area is load-bearing — a too-small camera overflows less in
absolute pixels and would set an unbeatable floor (page 22: 147/46,380 = 0.317%
vs the propagated 669/55,333 = 1.209%; the absolute rule compares 147 to 669 and
gets it backwards). The rule is SELF-LIMITING: a page with any cleanly contained
hypothesis has a zero floor and nothing changes. `placement_containment_regression`
replays both rules over every recorded page (admission and camera verdict are
closed-form in the saved overflow/occupied/covered counts): 14 of 17 drawings
identical on 40377, 23 of 23 on 41624. Page 22 places and gets 1 of 2 right — the
only correct pose it adds — and pages 26/27 now place in the main pass and place
nothing right, costing one pose at page 29. **Net zero; precision at the coverage
peak falls 0.779 → 0.697.** Coverage ORDERING is implemented, measured and NOT
adopted (changes 10 of 17 first-accepted registrations).
(2) **`98138pb072` IS `98138pz0`** — the current official part declares
`!KEYWORDS ... BrickLink 98138pb072` (absent offline only because Studio bundles
LDraw release 207 and the keywords arrived in UPDATE 2023-03), Studio's
`StudioPartDefinition2.txt` has two rows for BL key 153546, and the CAD matches
(bboxes to 0.0 LDU, areas within 3 ppm, 94.2% shared vertices). Fetching the part
into `output/pdf-universal-parts/` is the whole change. It does NOT fix page 20:
`placement_diagnose_group_connectivity` shows its 7 pieces are THREE connector
components (5, 1, 1) — the two black round tiles engage ZERO mates with anything
and sit 31 LDU away on a page-19 piece — so the 7-piece build was never well
posed (page 31's 4 are one component, so the test discriminates). The PDF agrees:
page 20's drawings align 162↔164 at IoU 0.9334 but 168 at only 0.34, and the
final substep is 0.7% black where one round tile needs ~510 px (page 21, the
attachment, is 31% black). `placement_undrawn_pieces` withholds a colour whose
ink is below a fraction of ONE of its pieces; page 20 becomes well-posed at five
pieces, image score 0.4543→0.6120, and is **still 1 of 5**, so it is EXCLUDED
(`--exclude-construction PAGE=REASON`). That rule fires on 1 of 22 driven addition
pages and that one is a WRONG IDENTITY (41624 p3 `2431` at 0.523 where the bridged
allocation has `2780` at 0.967) — a PDF-only allocation cross-check.
(3) **Pages 23-30 are a VISIBILITY failure, not a closure-ordering one.** Bank
recall is 1/1, 3/3, 2/2, 2/3 on pages 23/28/29/30; the best RETAINED candidate
beats the selected on 1 of 7 pages by 1 pose; arrows reach pages 27-30 but NOT
23-26 (and they order closure parents, which recall says these pages don't need).
Page 23's plate paints **899 drawn pixels against its rivals' 10,939-11,003** and
loses under the coarse composite (rank 260), the native scorer (13/16), the LOCAL
objective (13/16, by more) AND the seated tie-break (10 mates/534 contacts vs
12/697). It paints **74** px on every later page and **75 against the COMPLETE
89-part reference model**, so the viewpoint hides it and repairing the body cannot
reveal it — a look-ahead window cannot decide it by silhouette (round four's
separate reachability argument for the window stands). Local rerank now has five
measurements (+1, −, neutral, −, +): a lever with a scope, not a default.
41624: round four's 3→5 was **entirely the opening**, not drawing-to-drawing
registration — the queued control (`--drawing-registration off`, same opening)
reaches the same 5/109 and refuses pages 7-8 that the propagated camera drove for
7 emitted, 0 correct. Also fixed: the page-kind body-area probe now borrows a
prescan camera, so a scope whose FIRST page is a subassembly page is no longer
driven as an ordinary addition.

> **Where to go next** → see **[ROADMAP.md](ROADMAP.md)**: the near-term (~100h)
> priorities (tests/CI first, then the user on-ramp, mobile, MC bridge,
> reliability) and the long-term (~10k h) vision — a universal LEGO pipeline:
> buildable *from* anything, *into* anything, with a physical-validity verifier
> as the moat. Read it before planning large work; it also lists the anti-goals
> (don't micro-polish the renderer; don't re-verify settled questions).

## Dev / commands
- Dev server: `bun dev:web` (port 4000). Add `--host` to expose on LAN (phone testing at the box's LAN IP:4000).
- Typecheck: root is `bun run typecheck` (`tsc --noEmit`, the `src/` tree); the whole `web/` tree is `bun run typecheck:web` (`tsc --noEmit -p web/tsconfig.json`). **Both run in CI** (ci.yml + deploy.yml) so a careless edit can't silently compile-break. The `web` tree is currently type-clean — keep it that way (the old ~34 `ui/*` errors were fixed; the app still *builds* via Vite/esbuild without type-gating, but CI now gates it).
- Build: `bun run build:web`. Tests: `bun test` (vitest). LEGO unit tests are **offline + deterministic** — `test/ldraw-parser.test.ts` (transforms/steps/primitives), `test/io-zip.test.ts` (ZipCrypto + WinZip-AES decrypt, validated against Node's own crypto as an oracle — no large `.io` fixtures), `test/lego-colors.test.ts` (the don't-conflate-colour-systems invariant), and `test/ldraw-geometry.test.ts` (**geometry regression**: `resolvePartGeometry` triangle/edge/winding/transform signature, GPU-free via a mocked `fetch` serving synthetic `.dat` — the de-risked stand-in for visual regression). Export-side offline suites: `test/schem-pipeline.test.ts` (the shared export module's grid path — byte-identical to a direct encode, no re-voxelization), `test/schem-settings.test.ts` (resolution planning vs the legacy ladder as an oracle), `test/light-fill.test.ts` (sealed room lit / open porch untouched), `test/palette-lint.test.ts` (every emitted block id is a real Minecraft block), `test/schem-seeded-geometry.test.ts` (the seeded resolver short-circuits fetch and matches the networked bytes; per-part progress advances; geometry is independent of fetch timing). Prefer this pattern over the network-fetching `test/lego-pipeline.test.ts` (and the flaky live-API `test/import-*` tests). Two more from the 2026-09-08 audit: `test/part-cache-revision.test.ts` (persistent-cache identity + transitive geometry invalidation, over a fake IndexedDB that survives `vi.resetModules()` — the WARM-browser path, not an incognito one) and `test/schem-real-set.test.ts` (real set through the real export pipeline; skips without the local corpus).
- Use **Chrome** for browser testing, not Edge.

## Manual gates (Chrome + the local corpus — deliberately NOT in CI)
Run these after touching the renderer, the part resolver, the LXF/alignment
path or the exporters. Each drives the REAL app in headless Chrome against
`bun dev:web`, so none of them can run on a CI box. Output lands in
`output/visual-fixtures/<date>/`.
- **`node scripts/lego-visual-fixtures.mjs`** — 4 fixtures (10316 headgear
  close-up, 71043 foundation/tower close-ups, 10182 official-OMR control, 21309
  rotated/SNOT control), each pinning its index path AND sha256/12 `hash`, the
  camera, explode 0 and all layers, with targeted numeric assertions (headgear
  seated on its head; only the 3 documented unmodelled moulds missing; assembled
  matrices restored after 0→100→0; a pinned rotation-profile baseline). **A
  corpus change FAILS the fixture** — re-baseline it deliberately, don't widen
  the tolerance. Exit non-zero names what moved.
- **`node scripts/lego-perf-baseline.mjs`** — cold/warm load, request counts,
  draw calls/triangles, heap, forced-composite time. Numbers +
  what-is-not-claimed: `docs/lego-perf-baseline-2026-09-09.md`. Works against
  prod too (`DEV_URL=https://craftmatic.click`), minus the in-page stats — the
  `window.__ldrawViewer` hook is DEV-only.
- **`node scripts/lego-export-validate.mjs`** — OBJ/STL/GLB byte-identity
  across explode 0→100→0, plus the OBJ bbox against 8 mm/stud. Byte identity is
  a WITHIN-run statement only: dev part resolution is nondeterministic.
- **`bunx vitest run test/schem-real-set.test.ts`** — the Minecraft half. Real
  set, real pipeline, cellLDU 20/10/8, bridging on vs off. Skips silently
  without the local corpus.
- **Kill stray dev servers first.** Three `vite` processes were running at once
  (4000/4001/4002) and `/` took 264 s to answer; after killing the extras it was
  0.1 s. A load-time or "model never finished rendering" result taken on that
  box is about the box, not the code — check
  `Get-NetTCPConnection -State Listen` and the CPU before believing one.

## InstancedMesh metadata contract (probes depend on it)
Each brick mesh carries `partName`, `brickColor`, `meshKind`
(`main`/`color`/`texture`) and, on exactly ONE mesh per (part, colour) bucket,
`primary: true`. Keep them: without part identity an offline probe can measure
where things are but never what they are, and **`primary` is what makes
placements countable** — a multi-coloured part emits several meshes over the
SAME matrices, so summing every instance over-counts (10182: 2,432 instances
for 2,417 placements). `mirrorOf` marks the floor-reflection clones; skip those.

## Key tabs
Generate · Import · Upload · Gallery · Comparison · Map · Tiles · **LEGO**

## Architecture (LEGO/LDraw path)
- `web/src/ui/lego.ts` — LEGO tab UI: search, auto-load chain, upload, 3D-render controls, step/explode sliders, missing-parts surfacing, **export menu** (PNG; GLB/OBJ/STL via `exporter.ts`+`viewer.exportMeshes()`; Minecraft `.schem`/`.litematic`/build guide via the SHARED `ui/schem-export.ts` (S4 — same module the Upload tab uses), with the `⚙ MC settings` popover next to the Download select; parts-list **`.csv` BOM** — part/color/count from `currentBricks`). OBJ/STL bake instances (no instancing in-format) → large on big sets; GLB is the compact 3D option. The slider row label is a **Step⟷Layer toggle**: layer mode slices by quantized plate height (`viewer.setSliderMode('layer')`) and is the DEFAULT for models without STEP meta (most Studio .io exports — 71043 has 5,936 bricks and ONE step); step mode is default when real steps exist.
- `web/src/engine/ldraw-parser.ts` — MPD/LDR → `ParsedBrick[]` (world transform = parentRot×local + parentPos, recursive; det<0 → winding flip). `countSteps()` counts `0 STEP` at ANY depth (sets that nest steps in sub-assemblies, e.g. 31084, depend on this).
- `web/src/viewer/ldraw/` — the direct 3D renderer (modular):
  - `viewer.ts` — Three.js scene/renderer/camera, lighting, env, post FX, camera framing/transitions, explode, picking, export (`exportMeshes()`). **Global instancing**: ONE InstancedMesh per (part,color) across the WHOLE model (not per step) + ONE global edge `LineSegments2`. Instances/segments are sorted step-ascending; the step slider sets `InstancedMesh.count` / `LineSegmentsGeometry.instanceCount` to a binary-search prefix — so a 1226-step set (UCS Falcon) is ~300 meshes / ~950 draw calls, not thousands. Static shadow map (`shadowMap.autoUpdate=false`, refreshed on scene change). **On-demand rendering**: the rAF loop only composites when `needsRender` is set (or a camera anim / autoRotate / Stats overlay is active) — idle scenes cost ~0 GPU. **Any new state mutation that changes the picture MUST call `this.invalidate()`** (or `requestShadowUpdate()`, which also invalidates); camera moves auto-invalidate via the OrbitControls `change` listener. Dev-only `window.__ldrawViewer` hook for `renderer.info` metrics.
  - `parts.ts` — fetch/parse/resolve `.dat` geometry; module-level caches **plus a persistent IndexedDB .dat-text cache** (`craftmatic-ldraw` db; positive results only — repeat sessions load big sets with ~zero part fetches; **prod 10316: cold 19.25 s → warm 2.68 s**); `prewarmCommonParts()`; `partTextureUrls` (TEXMAP); `preloadDatTexts()` (archive-bundled parts, model-specific, cleared by `clearMpdInlines`); `unresolvedDatNames` → `viewer.unresolvedSubparts` (sub-file refs that resolved nowhere = silent holes, surfaced in status). Candidate-path order is name-shape-aware (`looksLikePrimitive` → `p/` first) with a **`p/48/` hi-res alias tail** for bare primitive refs that only exist as 48-variants (e.g. `1-12ring14`). `LDRAW_BASE = /ldraw-parts`.
    - **Cache identity is tied to the DEPLOYED library revision (2026-09-09,
      audit P1 #6).** `IDB_VERSION_KEY` is now only the cache FORMAT version;
      the real identity is `GET /ldraw-parts/_rev` → `{rev}`, written into R2 as
      `ldraw/_rev.json` by `scripts/sync-ldraw-r2.mjs` and served by the worker
      (dev: a constant `dev-local-1` from the vite middleware, because dev's
      library is a frozen snapshot plus per-miss fallbacks and has no honest
      content revision). `rev` is a **content hash** of the mirrored file set,
      NOT the run time — the sync is weekly and usually a no-op, and a timestamp
      would evict every visitor's whole part cache every week for nothing. The
      stamp is published ONLY after a complete, fully successful run. A KNOWN,
      different revision clears the store once; an UNKNOWN one (no endpoint,
      404, offline, malformed, timeout) never invalidates and never records —
      guessing "changed" on a blip would re-download the library on the worst
      connections. (A canary set of part texts was rejected: a canary only
      detects changes to the canary, and the corrected part is exactly the one
      it doesn't contain.) `primePartCache()` runs the probe at app idle;
      `partCacheRevision()` feeds the diagnostics bundle (`library: null` means
      "could not be established", not "unversioned").
    - **Geometry invalidation is TRANSITIVE and RETURNS what it dropped.**
      `resolvePartGeometry` FLATTENS a child's triangles into its parent, so
      dropping only the child leaves every parent holding the old definition —
      a real leak, because a `.io`'s `CustomParts/` ships the exact primitives
      its modified parts need, names shared library parts also reference.
      `geomDependents` records the reverse edges; `invalidatePartGeom` walks
      them. **Any caller that invalidates in order to REBUILD must re-resolve
      the whole returned set** — the viewer's repair pass re-resolved only the
      empty parts it named, left the invalidated ancestors with no geometry at
      all, and that reported 71043's `90398` (25 placements) as missing.
  - `materials.ts` — LDraw color → THREE material (ABS / rubber / metallic / transparent / glow).
  - `types.ts` — Vec3/Triangle/Edge/PartGeom/TexturedTriangle.
- `web/src/engine/ldraw-colors.ts` — LDraw color id → hex (and → Minecraft block for voxelizer).
- Other importers: `bff-loader.ts` (BrickLink inventory → flat layout), `studio-colors.ts`, `ldd-colors.ts`.
  - `io-extractor.ts` (.io) — `extractIoModel()` returns `{text, customParts, sourceEntry, colorSpace, colorSpaceReason}` (see "Color systems" — the colour table MUST follow `colorSpace`, not the file extension): tries `model.ldr` → `model2.ldr` → `modelv2.ldr` (first with type-1 lines wins) AND pulls every **`CustomParts/**/*.dat`** from the archive (Studio's user-modified `m<hash>_<date>_<time>.dat` parts + the exact primitives they need). Without CustomParts, big Technic sets silently lose pieces (42110 was missing 24). They flow `lego.ts currentCustomParts` → `viewer.load(opts.datFiles)` → `preloadDatTexts`.
  - `zip-utils.ts` + `aes-zip.ts` — ZIP reader. Handles plain DEFLATE, legacy **ZipCrypto** (pw `soho0909`), and **WinZip AES-256** (method 99, pw `soho0909`) used by older/early-access .io exports. AES = PBKDF2-HMAC-SHA1 + pure-JS AES in little-endian CTR (Web Crypto's big-endian AES-CTR is incompatible).
  - `lxf-parser.ts` (.lxf/LDD) — **TWO alignment tables, measured-first (2026-09-09, audit P0 #2).** `parseBoneTransform` (LXFML column-major→row-major) and `axisAngleToMatrix` are unchanged; the placement maths is not.
    - **`F = diag(1,−1,−1)`, NOT `diag(1,−1,1)`.** The old value has **det = −1** — a reflection, so every `.lxf` model was MIRRORED and every chiral part (slopes, wedges, curved shells) landed in a physically wrong slot. LDD (Y-up) and LDraw (Y-down) are BOTH right-handed, so the map between them is a 180° rotation about X. `FRAME_SIGN` is exported and a test pins `det = +1`. Do not "simplify" it back to a Y-flip.
    - **`/ldd-measured-align.json` is primary** (`scripts/gen-ldd-measured-align.py` from clego `dbix_part_align.json`, 1,841 designs, 145 KB): clego's per-design correction MEASURED against authentic Studio placements over 207 sets. It is already in LDU and already in the flipped LDraw basis, so `composeLxfMeasured` applies it POST-flip: `rot = (F·R_bone·F)·D`, `pos = 25·(F·t_bone) + (F·R_bone·F)·e`. The generator re-orthonormalises the 302 rotations the learner's 1/20 quantisation left off (det 0.94–1.06) so no SVD is needed in the browser, and the row validator rejects any det off by >2 %.
    - **`/ldd-part-map.json` is the FALLBACK** (Studio's own `ldraw.xml` columns, 4,467 designs) and still the source of the LDraw FILENAME (60583 → 60583b.dat) for the ~8 % of placements the measured table doesn't name. `composeLxfPlacement` keeps composing it in LDD space. Angles there are RADIANS (clego's `convert_lxf.py` has a latent `math.radians()` bug on the already-radian value — ours is more correct).
    - **MEASURED, held out** against six sets with BOTH a native `.lxf` and an authentic (non-laundered) Studio `.io`, none in clego's training cohort, scored with clego's `dbix_gt_compare` over 10,327 GT parts: **ldraw.xml + old F 7.15 % · ldraw.xml + proper F 7.06 % · measured + old F 48.12 % · measured + proper F 72.70 % · no correction at all 3.78 %.** The shipped path was barely above the do-nothing control. **Both halves matter**: payload +65 pts, basis +25 pts. The old CLAUDE.md note that this was "an inherent limit shared with the state-of-the-art tool, NOT a cheap fix" was WRONG — it compared us to `convert_lxf.py`, which carries the same two faults. It WAS fixable; what was missing was ground truth, which clego now has.
    - **Coverage is not the failure mode.** 71043 Hogwarts had **100.00 % coverage** (5,967/5,967 placements, 310/310 design ids) while rendering as a splayed pile. Measure entry CORRECTNESS against ground truth, not entry presence.
    - `loadPartMap`/`loadMeasuredAlign` share a generic loader: schema-validated rows (bad rows dropped AND counted), transient failures retried (404/410 definitive), **a failure is never cached** (the old `{}`-forever bug — audit P1 #3), separate cache slots so a measured failure can't break the fallback. `parseLxfWithDiagnostics` returns `LxfDiagnostics` (per-table state/source/version/entries/rejected + measured vs fallback vs unaligned placement counts + skips); `describeLxfDiagnostics` turns it into the user-facing line. Tests: `test/lxf-alignment.test.ts` (maths), `test/lxf-part-map.test.ts` (loading + coverage, incl. the REAL shipped tables).
    - Still true: a `<Brick>` may hold MULTIPLE `<Part>` assemblies (hinge 73983 = 2430+2429), each with its own designID/materials/Bone — iterate every Part or halves vanish.
    - **Honest limit:** 72.70 %, not 100 %. 71043 has no authentic `.io` of its own (its `.io` files are laundered repacks per clego `io_authenticity.json`), so its accuracy is inferred from the held-out cohort. An authentic Studio `.io` of a set is still exact and still preferred.

## LDraw parts library — DEV vs PROD (critical)
The 3D renderer needs individual `.dat` geometry from `/ldraw-parts/*`.
- **DEV**: served by a Vite middleware in `web/vite.config.ts` from a local clego
  install (`C:/git/clego/extracted/studio_release/app/ldraw`, ~1.8 GB / 67k files),
  falling back on a local miss to the **prod worker's R2 mirror**
  (`craftmatic.click/ldraw-parts`) and only then to `library.ldraw.org`. The
  local install is a frozen Studio snapshot (**LDraw release 207**: 12,136
  official parts vs upstream's 24,737), so every mould released since 2020
  misses locally — going to the mirror first keeps dev coverage equal to prod
  without paying library.ldraw.org's throttling. A
  `FORCE_UPSTREAM` const (default `false`) bypasses local to mirror prod exactly.
  The fallback only caches a null on a DEFINITIVE upstream 404 (thrown fetches —
  throttling during a load burst — retry instead; concurrency capped at 6).
  Caching nulls on transient failures turned existing parts (73111 …) into
  permanently missing pieces for the whole dev session — don't reintroduce.
- **PROD**: the Cloudflare Worker (`worker/ldraw-omr.js`) serves `/ldraw-parts/*`
  **R2-FIRST** from the `lego-models` bucket (keys `ldraw/<relpath>`, LOWERCASED
  — R2 keys are case-sensitive and `normId()` lowercases every request; mirror
  maintained by `scripts/sync-ldraw-r2.mjs`), falling back to
  `library.ldraw.org/library/{official,unofficial}/*` for unsynced keys.
  Routed in `wrangler.toml` (`craftmatic.click/ldraw-parts/*`) with the R2
  binding `MODELS`. **Must `bunx wrangler deploy` to publish.** Without this
  route the deployed app has NO geometry and silently falls back to voxelization.
  **Why R2-first (prod incident 2026-08-17):** library.ldraw.org rate-limits
  cold big-set bursts (even `stud.dat` 503'd); worse, the worker's old blanket
  `cacheTtl+cacheEverything` EDGE-CACHED those failures for a week, so
  thousands of real parts read "missing". Rules now: `cacheTtlByStatus`
  (successes 1w, 404s 5min, errors 0), upstream throttle → 503 `no-store`
  (never a cacheable 404), one in-worker retry; client treats only 404/410 as
  definitive (`parts.ts`), and part-prefetch concurrency is 12.
- **Keeping the mirror CURRENT (2026-09-02).** The original seed was uploaded
  from the Studio-bundled library, i.e. LDraw release **207** — so R2 was five
  years stale and ~18k modern parts existed only behind the throttled upstream
  fallback. `scripts/sync-ldraw-r2.mjs` was rewritten to pull the **upstream
  release archives** (`updates/complete.zip` + `unofficial/ldrawunf.zip`) and
  upload a **stateless delta**: the R2 list API returns each object's etag
  (= content MD5 for single-shot PUTs), so new/changed files are computed by
  comparison — no done-file, no committed manifest, a missed run self-heals.
  New files upload first (a hole in the render beats a relicensed header).
  Uploads go through the **R2 REST API** with `CLOUDFLARE_API_TOKEN` (the
  deploy secret already has R2 write), ~300-600 files/min; keys present only in
  R2 are never deleted. `.github/workflows/sync-ldraw-r2.yml` runs it weekly.
  Verify coverage without a browser: `node scripts/check-missing-parts.mjs
  --recent 10` (or `<set> …`), which replays the client's candidate paths +
  alias ladder against prod or a local library.
- **Design-id ≠ LDraw part name.** Mecabricks-lineage models write LEGO's
  CURRENT design id; LDraw names a mould by its first/BrickLink-canonical
  number and never renames it. For re-tooled families the two share no digits
  (`42923`→`63868`, `44860`→`60897`, `26169`→`4865b`), so nothing resolves and
  no suffix rule can help — the mapping is DATA, in
  `web/src/engine/ldraw-part-aliases.ts` (every entry verified against the
  target `.dat`'s own description). Above it, `partAliasCandidates()` in
  `parts.ts` strips ONE suffix group per hop — lettered mould revisions
  (`6538c`→`6538`), decorations/versions (`3626d1024`, `30367v2`), prints
  (`98138pb042`→`98138`) — and chains (`u9132v1d1`→`u9132v1`→`u9132`).
  Measured over 6,325 tier-1 corpus `.ldr` files: 1,323 of 2,639 orphaned names
  = 20,289 of 39,081 placements recovered. Every candidate is verified against
  the library before use and the hop only runs after a DEFINITIVE miss, so a
  bad guess costs a lookup, not a wrong render. **The base must end in a digit**
  — without that guard the print rule shreds primitives (`stud4`→`stu`), which
  would substitute nonsense inside every part referencing them (test pins it).
  Substitutions are recorded in `substitutedDatNames` → `viewer.substitutedParts`
  → a LEGO-status note, so a near-mould swap is never silent. Tests:
  `test/part-alias.test.ts`.
- **Wrong-FRAME mappings belong in clego's harvester, never in the client
  alias table** (settled 2026-09-09, MB_TRANSFORM_AUDIT.md §11). The former
  "genuinely unmodelled" trio was superseded corpus-side: `20926`/`20932` map
  to `3816`/`3817` with a measured (0,24,0)-class delta, `1000337–1000341` are
  the 37341 sprue's lettered parts, and `98560` → `3684c` (631 placements /
  124 sets) — 21 mappings / 1,839 placements landed via `mb_partmap` +
  `mb_align` deltas at harvest, 38 sets DEFECTIVE→PASS, zero regressions.
  The client-side table is FILENAME-ONLY: adding any of these there would
  place the part 24–72 LDU out. If the census surfaces a new confirmed
  identity whose frame differs, route it to clego, don't alias it here.
- **Corpus hole rate is 0.067%, and it is almost entirely ONE source class**
  (census 2026-09-09, `scripts/missing-geometry-census.ts`, 214 sets / 80
  flagships + 20 per class, 564k placements): 379 missing pieces / 111 distinct
  names. `omr`, `io`, `dbix_conv_v2/v3`, `recon_v3`, `pdf_recon`, `recon_v8` and
  `lxf` are **clean (0)**; `mecabricks` + `mecabricks_search` carry 369 of the
  379, `eurobricks` 8, `ldr` 2. The deep pass (walk every resolved part, check
  ITS sub-file refs) found **0 unresolved sub-file names** — the "silent hole"
  class is empty. So do not go looking for a broad missing-geometry problem:
  what remains is a Mecabricks design-id ↔ LDraw-name mapping tail.
- **A ghost-box placeholder for a missing part is NOT derivable — don't build
  one.** Evaluated 2026-09-09 against the census: of the 111 unresolved names,
  exactly **1** (`98560`) has a real entry in `ldraw-part-dims.ts`; the other 110
  (338 pieces) fall through `getPartDims` to the 1×1×1 DEFAULT, so any box drawn
  for them would be an invented size. Same rule as substitution — fabricated
  geometry is worse than a hole. (`98560` is not an argument for the box either:
  it maps to a real mould and wants an alias row.)
- **The R2 mirror is a SUPERSET of upstream — verify misses against prod, not
  against the release archives.** R2 was first seeded from the Studio-bundled
  library and `sync-ldraw-r2.mjs` never deletes, so prod still serves parts the
  current `complete.zip`/`ldrawunf.zip` do not ship: every `bl_*` Studio
  synthetic (`bl_24246pb057` — 144 placements in 21063 alone) and legacy
  "Needs Work" moulds like `3814`. Measured on the census sample: **489 of 683**
  names absent from the release archives resolve fine on the mirror. A census or
  checker run against archives alone therefore invents holes; the census resolves
  offline in bulk and re-checks every miss against prod for exactly this reason.
  (Corollary: `ldraw-part-aliases.ts`'s note that `bl_*` names are uncovered is
  true of the ALIAS LADDER but not of prod resolution — they resolve directly.)
- **`_batch` sheds load under sustained bursts.** It returns the full TEXT of
  everything it finds, so a wide burst makes the Worker do real work and
  Cloudflare answers 503 (reproduced: 6 parallel 48-path batches → one 503).
  A 503 is indistinguishable from an absent part, so any offline tool must treat
  exhausted retries as FATAL rather than as misses, and must commit in slices.
- `library.ldraw.org` serves individual parts but sends **no CORS header** — must
  be proxied; cannot fetch from the browser directly. Official layout:
  `/library/official/{parts,p,parts/s,p/48}/<stem>.dat`.
- **Batched part fetch (2026-08-29)**: `parts.ts` micro-batches concurrent
  `fetchDatText` calls (20 ms window / 48 names) into ONE
  `/ldraw-parts/_batch?files=…` request (worker: ≤64 R2 keys in parallel,
  official+unofficial checked per name; dev: vite middleware mirror).
  Measured: cold UCS Falcon fetch phase was 4+ min via per-path probing
  (429 parts × ≤8 candidates × retries, 10-29 s single-part stalls);
  Concorde cold in dev = 5 batch requests, 0 individual, 4.3 s. Endpoint
  failure ×2 disables batching for the session (falls back to probing).
- **Models + index are SAME-ORIGIN through the worker** (2026-08-29):
  `/lego-models/*` and `/lego-models-index.json` routes → R2 binding. The raw
  `pub-*.r2.dev` domain serves bytes UNCOMPRESSED and off-zone; the worker
  path gets edge brotli/gzip (index 2.4 MB → 331 KB, .ldr ~5×) + edge cache.
  `MODELS_BASE = '/lego-models'` in both dev and prod; r2.dev is only the
  index fallback. **`buildStepGroup` is async + time-sliced** (yields ~24 ms,
  bails on stale loads, streams "placing bricks / building meshes / building
  edge outlines" into the warp overlay) — it used to freeze the main thread
  after the fetch hit 100% (Page-Unresponsive kills = the "crash between
  100% and display" class).
- **`#` in a filename is a THREE-WAY encoding contract** (prod incident
  2026-09-03, clego SOURCES.md §5b): client percent-encodes per segment
  (`encodeModelPath` in lego.ts / candidate paths in parts.ts), the worker
  DECODES before the R2 lookup (both `/lego-models/` and `/ldraw-parts/`), and
  the SYNC must percent-encode the key it PUTs. `wrangler r2 object put
  <bucket>/<key>` does NOT — the `#` opens a URL fragment and the object lands
  under a TRUNCATED key (`…/31378_step #cr.ldr` → `…/31378_step `), which
  `wrangler r2 object get` reads back identically, so the CLI looks healthy
  while prod 404s (96 index paths / 20 sets / 9 primary picks; dev was fine
  because Vite decodes `req.url`). Distinct files can truncate to the same key
  = silent data loss. Fixed on the sync side in BOTH mirrors
  (`scripts/sync-ldraw-r2.mjs`, clego `sync_models_r2.py` → R2 REST API for
  such keys). Guarded by `test/prod-smoke.test.ts`. Never diagnose this with
  `wrangler r2 object list` — only the R2 REST list shows the real key.
  **`%` is the same bug in disguise**: 8 corpus names contain a literal `%23`
  (`IO/42181-size%231.io`); wrangler sent it raw, the API DEcoded it, and the
  object landed under `…-size#1.io` — wrong key, same 404 (42181's primary
  pick). Any key with `#`, `?` or `%` must go through the REST API encoded.
- Parts that never resolve (a few set-custom OMR subparts like Red Baron
  `s100241`) are surfaced in the LEGO-tab status + console via
  `viewer.missingParts` — not silent. Sub-file refs that resolve nowhere (parent
  still renders, with small gaps) are surfaced separately via
  `viewer.unresolvedSubparts`.

## Source-quality gating (visual-QA 2026-07-20 — the renderer was never the problem)
A 12-set visual QA (real WebGL captures, `output/visual-qa-*/`) showed every
"broken-looking" render traced to **LXF-lineage source data**, not the renderer:
`Author: convert_lxf.py` LDRs carry raw LDD material-id colors + no per-part
alignment (10255 → stacked buildings, 1924 → exploded ferry decks, 8849 →
ghost tires). Pipeline defenses (classifier extracted to
`web/src/engine/source-quality.ts`, offline-tested in
`test/source-quality.test.ts`; `lego.ts` imports + wires the warnings):
- **`0 !LINEAGE <tool> <good|partial>` is the CANONICAL stamp** (clego
  converters emit it since 2026-08-28) and takes precedence over all legacy
  sniffs — the v2 DBIX reconverter's files also start with `0 LEGO DBIX v2`,
  which the legacy regex alone would misread as the warn-class. `good`→good,
  `partial`→approximate. Companion markers: `0 DBIX MULTIMODEL UNPLACED`
  (synthetic side-by-side layout → approximate + explicit caveat) and
  `0 DBIX FLOATING CLUSTER n=<k> gap_ldu=<g>` (authored mid-air parts, e.g.
  60502's airplane — informational note so users don't report it as a bug).
- `reconstructionQuality()` legacy sniffs: `convert_lxf.py` / `DBIX_LXFML`
  headers → 'broken'; un-stamped `0 LEGO DBIX` / `download_dbix_lxfml.py` →
  **'dbix'** (= legacy v1 conversions: dropped parts + lost sub-assembly
  transforms; superseded by `dbix_conv_v2` for ~2.1k sets). `sourceCaveat()`
  maps class+markers → the user-facing warning at every load path.
  NOTE (corrected 2026-08-28): the earlier claim that 72153's upstream LXFML
  "lacks the separation" was WRONG (a double-counted bone probe) — the clego
  v2 reconverter recovers all three Pokémon properly separated; genuine
  multi-model collapse exists in only 5 sets, marked MULTIMODEL UNPLACED.
  TASKS-FROM-CRAFTMATIC items #1–#6 are all DONE upstream (v2 sources:
  `dbix_conv_v2` 2,119 · `io_model2_v2` 790 · authentic `io` 896 entries).
  (A color-palette fingerprint was tried and REMOVED — dead code:
  `LDRAW_COLOR_RGB` already contains the extended ids like 10047/10070, so
  table-membership can't discriminate; origin-collision and volume-per-brick
  collapse metrics also proven non-discriminating. Don't re-add.)
- **Indexed auto-load iterates sources**: broken entries throw → next indexed
  source → classic OMR chain. 8849 now lands on its official OMR file (solid
  tires) instead of the gated conversion. Explicit source-picker choices pass
  `allowBroken` and load anyway, labelled.
- **`currentSourceWarning`** (reset by `newLoadEpoch()`): load paths set it and
  `voxelizeAndDisplay` appends it to the FINAL status — a plain setStatus()
  before display is silently clobbered by the render-success status (this hid
  every quality warning until the visual QA caught it).
- **Load-epoch token**: every load initiator (upload / indexed / OMR chain)
  bumps `loadEpoch` and bails at await-points if stale — a slow earlier load
  can no longer overwrite the user's newer selection. autoLoadFromOMR also
  falls through on transient OMR fetch errors (used to rethrow → skipped both
  fallbacks and stranded the button disabled) and re-enables its button in
  `finally`.
- **Known residual (data-bound, needs upstream index metadata)**: laundered
  conversions with no headers — 10255's ".io" is convert_lxf output repacked
  (all 3 entries identical, LDD colors) and its `Reconstructed/*_reconstructed
  .ldr` mirrors it. Text-level detection is impossible client-side; the model
  index (clego-generated) needs lineage/authenticity ranking.
- **A floating ACCESSORY on a mecabricks-lineage model is an upstream per-mould
  FRAME error — fix it in clego, never in the renderer (2026-09-09, audit P0
  #1).** 10316 Rivendell's five elf hairs (`10055`) sat 60.5 LDU above their
  heads; 40239 52.0, 92083 35.5, 10048 22.5. Craftmatic was measured innocent:
  `substitutedParts` empty, `unresolvedSubparts` empty, no alias hop, and the
  offset was CONSTANT IN THE HEAD'S LOCAL FRAME across every rotation and every
  instance — the signature of a per-mould source error, not an instance,
  renderer or alias fault. Root cause was `geograde/mb_align.py`'s NO-MESH
  fallback (7,696 mecabricks meshes are CDN 404s) assuming the mecabricks
  "origin on the bottom plane" convention for a part whose LDraw origin is
  INSIDE its geometry. Fixed as MB_ALIGN v5 (clego `772252b3`); corpus
  regenerated + republished. **The ground truth to check against**: LDraw's
  convention is that HEADGEAR ORIGIN == HEAD ORIGIN, i.e. the head-local offset
  is (0,0,~0) — verified over 100+ OMR instances (30210, 9469, 9470, 10224 …),
  and corpus-wide the OMR median local `dy` is 0.00 for every such mould. A
  quick scan of headgear-vs-head local `dy` in any flat `.ldr` is therefore a
  cheap, sharp detector for this whole class.
- **`bridgePartContacts` in the VOXEL path cannot fix a source float, and never
  hid one.** It only bridges gaps smaller than half a cell (pure quantization
  error). Measured on the 10316 elf: with the hair 60.5 LDU out, bridging added
  **0 cells** — grids byte-identical with and without it — at cellLDU 4/5/8/10/20.
  Don't reach for a voxel-side contact patch to explain or fix a direct-render
  placement defect; they are separate pipelines (`voxelizeAndDisplay` bypasses
  voxelization entirely in 3D-render mode).

## LSynth flexible parts (hoses / tubes / cables) — VERIFIED already-handled + synth fallback
- **Reality (measured across the whole corpus):** flexible parts already render.
  OMR ships them **pre-synthesized** (`0 SYNTH SYNTHESIZED BEGIN…END` blocks of
  placed `<set> - LSxx.dat` segment sub-parts, all inline-defined as
  `Unofficial_Part` from primitives) — 72/72 SYNTH files are pre-synthesized,
  0 need runtime synthesis (42006, 8272 verified: 0 missing). Studio `.io` bakes
  flex into CustomParts meshes (handled). `lsNN.dat` are NOT in the LDraw library
  (404) — they only ever appear inline-defined. So the old "LSynth surfaces as
  missing" note was imprecise; in practice it doesn't.
- **`ls<NN>` segment parts** (ls50, ls51 …) ship with the LSynth TOOL, not the
  LDraw library — files authored with LSynth reference them externally with
  matrices that stretch a unit-height segment along the hose path (8010 Darth
  Vader places 181 of them; they rendered as 181 missing pieces). `parts.ts`
  now synthesizes a placeholder on a definitive miss of `/^ls\d{1,3}$/`:
  cylinder y∈[0,1], radius 4.5 LDU (mirrors the one bundled example ls10.dat).
- **The one gap (uploads):** a hand-authored / editor-exported file with an
  UNsynthesized `0 SYNTH BEGIN <type> <colour>` + constraints + `0 SYNTH END`
  (no geometry between). `web/src/engine/lsynth.ts` `synthesizeLSynth(text)` is a
  pure TEXT→TEXT pass run before `parseLDraw` (both `.io` and `.ldr/.mpd` paths,
  via `maybeSynthesize` in lego.ts): each unsynthesized TUBE block (hose/
  pneumatic/ribbed/cable/flex — NOT band/chain/tread) → a swept round tube
  (centripetal Catmull-Rom spline through constraint positions + rotation-
  minimizing frame, radius by type) emitted as an inline `0 FILE lsynth-N.dat`
  tagged `Unofficial_Part` (so the parser emits it as a TERMINAL brick, not an
  empty assembly) referenced at identity. Already-synthesized / non-tube blocks
  pass through untouched — can't break working files. Tests: `test/lsynth.test.ts`.

## Renderer conventions (hard-won — do not regress)
- **NO `logarithmicDepthBuffer`.** It forces per-fragment depth writes that
  z-fight with InstancedMesh (used for every brick) and on near-coincident
  surfaces (stud-in-tube, coplanar faces) → flicker + interiors bleeding through
  walls. Use standard depth with a tuned near/far: `near = maxDim*0.01`,
  `far = (fitDist+maxDim)*8` (model-scale → ample 24-bit precision).
- **Transient part-fetch failures must NOT be cached as null.** `fetchDatText`
  retries each path 3× w/ backoff (8 s timeout) and only caches null on a
  definitive miss (all paths returned real HTTP responses). A load spike or
  flaky network otherwise permanently drops parts → missing connectors →
  supported parts appear to FLOAT. (Don't load many heavy models simultaneously
  in dev — it overwhelms the server and triggers this.)
- **Color pipeline** (matches box-art saturation): `THREE.NeutralToneMapping`
  (Khronos PBR Neutral) @ exposure 1.0 — preserves saturation where ACES shifts
  hues. **Dark** studio environment (`0x0a0a0e` surround + a few HDR emissive
  softbox panels), NOT a near-white blob (a white env floods diffuse onto every
  surface and washes dark colors grey). ONE physically-consistent ABS material
  for all opaque colors (roughness 0.36, no clearcoat, envMapIntensity 1.0) — no
  per-color "lum-gate" (that made dark bricks matte, light bricks glossy = wrong).
  Direct lights are neutral-temp; generous diffuse fill restores saturation.
- **Creased normals**: `toCreasedNormals(geom, 38°)` — smooth studs/cylinders,
  crisp brick edges (not blanket `computeVertexNormals`, which melts corners).
- **Studio floor look (2026-08-21)**: radial light-pool floor texture (bright
  pool ≈1.5×maxDim under the model → dark edges; the pool must occupy only the
  central ~15% of the canvas because the plane spans 10×maxDim), slightly
  transparent floor (opacity 0.8) + **fake-mirror reflection**: mirrored
  InstancedMeshes under the floor SHARING geometry AND instanceMatrix buffers
  (explode/step/resort follow for free), faded cloned materials registered in
  `allMeshMaterials`, `userData.mirrorOf` → applyStepVisibility reads the
  SOURCE mesh's step arrays (they're replaced on resort — read through the
  reference). Gated to ≤200 meshes; hidden while the verify-highlight is
  active. Transparent-pass back-to-front sorting draws reflections before the
  floor — don't make the floor opaque or reflections vanish.
- **Load cancellation**: `viewer.load()` carries a monotonic `loadSeq`; every
  awaited stage bails when a newer load starts. UI paths capture `loadEpoch`
  and skip stale status/progress writes. Rapid set-switching must always
  settle on the LAST selection.
- **ABS specularIntensity 0.45** (materials.ts, calibrated 2026-08-23 by
  pixel-sampling sand green on 21327 against #A0BCAC): full dielectric F0 laid
  a broad white specular on every mid-tone face and HALVED the chroma (colors
  read pale). Tone mapping measured innocent. Light levels re-tuned to match
  (amb 0.4 / hemi 0.34 / key 2.9 / fill 0.5 / env 0.8) — re-calibrate BOTH
  together or colors drift.
- **The vignette's `darkness` is NOT a strength — it is the COLOUR TARGET's
  complement** (fixed 2026-09-09; this was the user-reported "glare/brightness
  that looks like fog"). VignetteShader is
  `mix(texel.rgb, vec3(1.0 - darkness), dot(uv,uv))`, so `darkness: 0.8` dragged
  every pixel toward LINEAR 0.2 — which OutputPass tone-maps and sRGB-encodes to
  a **~124/255 mid grey** — and `offset: 1.2` gave the corners 72% of it. That is
  a grey veil over the whole frame, not a vignette, and being achromatic it
  DESATURATED everything. Measured (4 sets, identical cameras): it lifted mean
  frame luminance 14-18 and the darkest 1% by 3-13, and moved brick pixels up to
  50/255. Now `darkness 1.0` (target pure black ⇒ the pass is a plain multiply,
  `mix(c,0,t) === c*(1-t)`, so it can only darken and preserves chromaticity
  exactly) + `offset 0.95`. Saturation recovered ×1.23 with hue drift 0.15°.
  **Never raise `darkness` below 1.0 to "soften" the vignette** — that is the
  bug; soften with `offset`.
- **SAO's `saoScale`/`saoKernelRadius` must be SIZE-INVARIANT** (fixed
  2026-09-09). SAOShader uses `scale` only as `scale / cameraFar`, and occlusion
  grows as that ratio shrinks; `cameraFar = (fitDist+maxDim)*8` and the framing
  distance are both linear in maxDim, so the well-conditioned value is a
  CONSTANT. Deriving it from `maxDim` inverted that — the smaller the set, the
  heavier the smear — and SAO only runs on ≤80-mesh scenes, i.e. exactly the
  small sets. `saoKernelRadius` is in SCREEN PIXELS (shader divides by target
  size) so it must not carry world units either. Now `scale 13`, `kernel 24`:
  the pass's effect on brick pixels fell 59.7→17.4 / 52.2→16.4 / 26.0→12.6 mean
  on three small sets and p99 rose (highlights had been crushed).
- **`scene.fog` (FogExp2 at `0.15/maxDim`) is deliberate and stays.** It reads
  as a candidate for "haze" but measured only −2 to −4.7 luminance on bricks and
  it DARKENS rather than glares. It is what fades the 10×maxDim floor plane into
  the background; removing it would expose a hard floor horizon.
- **Diagnose look regressions with `scripts/renderer-pass-isolation.mjs`**
  before touching any constant — it captures one camera with exactly one pass
  disabled at a time, raycasts each sample back to its brick (so a sample knows
  its LDraw colour and camera distance, which is what separates a
  distance-dependent wash from a uniform lift), and `scripts/_calib_table.ts`
  turns two runs into a hue/chroma calibration table. `legacy-*` variants
  restore old parameter values at runtime for a same-session cost comparison.
- **Hyperspace warp loader** (`warp-loader.ts`): full-panel starfield + big
  percent + real part geometries as flying debris, owns the render loop while
  `warp.running` (composer skipped — the model scene is mid-build). begin()
  replaces any previous run; load()'s finally ends it only when
  `seq === loadSeq` (a newer load owns the overlay otherwise).
- **Minecraft exports are proportion-exact + high-res** (2026-08-23): schem/
  litematic pick the finest UNIFORM cubic cell from [4,5,8,10,20] LDU fitting
  max(w,l)≤640, h≤320, ≤30M cells (cellLDU 4 = 5 cells/stud, 2/plate — 4
  divides both 20 and 8, so NO 2.5× vertical stretch), geometry-voxelized
  with a bbox fallback + fillSingleVoxelGaps (no keepLargestComponent —
  minifigs are real separate components). The build guide stays at 1
  cell/stud. GLB/OBJ/STL were verified axis-exact already (STL bbox matches
  studs×8mm per axis to the decimal).
- **Minecraft export runs in a Web Worker + the OOM cause (S3, 2026-09-01).**
  `web/src/engine/schem-worker.ts` runs voxelize → fillSingleVoxelGaps → NBT →
  gzip off the main thread and streams `{phase, pct}` to the banner;
  `runSchemExportWorker` (now in `ui/schem-export.ts`, see S4 below) falls back
  to the identical inline path if a Worker can't be constructed. **`vite.config.ts` must keep
  `worker: { format: 'es' }`** — the rollup default (`iife`) can't code-split,
  which the worker's graph needs. MEASURED before→after (21063 .io, cellLDU 4,
  7.47M-cell grid): voxelize 85.5 s → 5.9 s, peak RSS 935 → 490 MB; at the
  30M-cell cap the NBT encode alone was **1.33 GB RSS for a 0.2 MB file** →
  338 MB. Three causes, all fixed, all output-preserving:
  1. **`number[]` byte accumulation** (the OOM): `encodeBlockData` and both NBT
     writers pushed every output byte into a JS array (+783 MB / +325 MB at
     30M cells). Now `web/src/engine/byte-writer.ts` (growable Uint8Array) and
     an exact-size two-pass varint encoder. Encoders moved to
     `web/src/engine/schem-encode.ts` (no THREE/DOM, so the worker can import
     them); `exporter.ts` re-exports them.
  2. **object-per-cell accumulator** in `ldraw-geometry.ts` — 1.60M
     `{gx,gy,gz,block,color}` objects ≈ 98 MB; now chunked parallel
     Int32/Uint16 arrays (14 B/cell) with interned block strings.
  3. **O(rays × triangles) sweep** (the 85 s): each sweep now has a
     per-triangle bbox bucket index (CSR). Provably equivalent — Möller-
     Trumbore's u/v test already rejects rays outside the projected bbox, and
     `parityFill` sorts hits so visit order can't matter.
  **Byte-identity is the gate, and it passed**: `scripts/_schem_ref.ts` on
  21063 gives the same sha256 before and after (CLI/filesystem = deterministic).
  Do NOT compare browser exports for identity — the dev `/ldraw-parts` upstream
  fallback makes part resolution nondeterministic (two runs of the SAME code
  differed by 570 blocks). Profilers: `scripts/_schem_profile.ts` (full path),
  `scripts/_schem_encode_profile.ts` (encode at the 30M cap).
- **Export filenames are `<Name≤12>-<setNumber>` (2026-09-08).**
  `web/src/engine/export-name.ts` `modelExportStem()` builds every LEGO-tab
  download name: the model name first (whole words, no spaces, ≤12 chars), then
  the set number with the `-1` primary-variant suffix dropped —
  `Colosseum-10276.schem`. The old stems were the internal loader label and
  leaked the SOURCE into the user's Downloads folder (`10276-1-omr.schem`,
  `21063-1-io.schem`), which says nothing about the model and made two exports of
  one set look like different things. A NON-`-1` variant is kept (a different
  physical release). Degrades: name+number → number → name → the uploaded file's
  own name → `model`. Applies to every format (schem/litematic/guide/mcpack, GLB/
  OBJ/STL/3MF, CSV, PNG, turntable) so one model gives one family of filenames;
  `runMinecraftExport` re-sanitizes the stem so no caller can put a path
  separator in a download name. Tests: `test/export-name.test.ts`.
- **ONE shared Minecraft-export module for every tab (S4, 2026-09-01).**
  `web/src/ui/schem-export.ts` `runMinecraftExport()` is the ONLY path that
  encodes a .schem/.litematic/.mcpack for a user download; it owns resolution planning,
  the Worker (+ identical inline fallback via the same function), the progress
  banner, the build-guide hand-off and the download. Two sources:
  `{kind:'bricks'}` (LEGO tab → voxelize → fillSingleVoxelGaps → encode) and
  `{kind:'grid'}` (Upload tab / generator / gallery inline+overlay viewers →
  encode ONLY; an uploaded schematic is already blocks, re-voxelizing or
  gap-filling it would be lossy). The work itself lives in
  `web/src/engine/schem-pipeline.ts` (`runSchemPipeline`), which
  `schem-worker.ts` is now just message plumbing around. `main.ts`'s old
  `exportSchem/exportLitematic` dropdown calls are gone; those exporter.ts
  helpers remain only for the dev/batch surfaces (tiles batch, comparison).
  - **User settings** (`⚙ MC settings` popover, `ui/schem-settings-panel.ts`,
    persisted in `localStorage['craftmatic.mcExportSettings']`, read at export
    time so both tabs always agree): **Resolution** (Auto = the shipped ladder,
    or 1 / 2.5 / 5 / **10** blocks per stud; an over-cap explicit choice is
    coarsened back to the auto pick and the status names the cap that refused
    it — usually HEIGHT, not width, so `refusedBy` is reported rather than
    guessed. **10 blocks per stud (cellLDU 2) is opt-in only and deliberately
    NOT in `AUTO_CELL_LADDER`**: it is ~7× the cells of the 5×/stud tier
    (5969-1: 15,502 → 107,191 non-air, 98 → 186 ms, peak RSS 295 MB) and only
    small models clear the caps at all — 21063, 60380, 71043 and 76416 are all
    refused (`scripts/_res_survey.ts` prints the auto and 10×/stud plans for any
    model). Putting it in the ladder would silently inflate every small export), **Block mapping profile**
    (`engine/block-profiles.ts` — TWO real profiles since 2026-09-08:
    `default` (concrete & glass) and `textured` (see below). Don't add
    placeholder profiles; an entry must be a genuinely different table), and
    **Light enclosed interiors** (OFF by default). Pure planning lives in
    `engine/schem-settings.ts` (`planResolution`, `spanOfBricks`, `describePlan`).
    The dims preview and the caps both use the BRICK-ORIGIN span + 80 LDU pad —
    it understates a tiny model's real extent (unchanged pre-S4 behaviour).
  - **"Textured + shapes" profile** (`engine/textured-palette.ts`, 2026-09-08) —
    OKLab nearest-neighbour over a palette of the families that actually HAVE
    slabs and stairs (stone/deepslate/blackstone, sandstone, bricks/mud,
    prismarine, quartz, purpur, end stone, waxed cut copper, all 11 planks) plus
    the 16 dyed concretes as the fallback. **Selectable, NOT the default** — a
    palette change repaints every export, so it ships opt-in. Measured on 21063:
    shaped cells 5,367 → 57,702; on 60380 slabs 2,480 → 66,112; `nonAir`
    identical either way (it only recolours). Three gates, and the third was
    forced by a schemat.io A/B rather than reasoned up front:
    1. absolute OKLab distance ≤ 0.08. A margin-only rule is NOT enough — OKLab
       genuinely rates `acacia_planks` (0.103) closer to LEGO Red than
       `red_concrete` (0.123), because MC's red concrete is a dark maroon, so
       the first cut repainted red as wood, orange as bamboo, purple as crimson.
    2. no worse than the best dyed candidate by more than 0.02.
    3. **hue/chroma character.** The first A/B came back with 121,594 cells of
       21063's Olive Green landscaping as `bamboo_planks` — a yellow floor where
       the set has a lawn — and Dark Tan as neutral `polished_andesite`. A
       chromatic colour now needs a candidate within 20° of hue keeping ≥35% of
       its chroma; a neutral one may not GAIN chroma; and the matcher takes the
       nearest candidate that PASSES (which is what makes Dark Tan `oak_planks`,
       dh 7°, instead of andesite).
    A colour is **only ever replaced by a shape-capable block** — where the
    gates refuse everything the default table's hand-curated answer is kept
    verbatim, rather than substituting the nearest dyed block (that is how LEGO
    Orange briefly became `yellow_concrete`: nearer, and wrong). Black is the
    honest hole: vanilla's darkest slab material, `blackstone`, is a whole OKLab
    lightness step above LEGO black, so 16,688 cells stay cubes.
    `scripts/_textured_survey.ts` prints every LDraw colour with both distances,
    and `--probe=#RRGGBB` the per-axis deltas for one — tune from THAT, not from
    estimates. Tests: `test/textured-palette.test.ts` (anchors in both
    directions, including the three greens the guard saves).
  - **Light fill** (`engine/light-fill.ts`): flood air inward from the grid
    boundary → everything unreached is an enclosed pocket → pockets ≥ 8 cells
    get a light on their FLOOR, one per `spacing`³ (6) bucket (glowstone, or a
    `lantern` when Block shapes is on — see below). A room with a doorway is
    reachable from outside, so it stays dark by design. Runs after
    fillSingleVoxelGaps, only when the flag is on.
  - **The export REUSES the viewer's part geometry — zero network (S6,
    2026-09-02).** The export resolver (`engine/ldraw-geometry.ts`) keeps its
    own `.dat` text cache, a different module from the viewer's
    (`viewer/ldraw/parts.ts`) and, in the worker, a different THREAD — so
    exporting the model already on screen re-downloaded its whole part library.
    `schem-export.ts` now snapshots the viewer's cache (`collectDatTexts()` —
    library fetches + the IndexedDB warm cache + MPD inlines + archive
    `CustomParts/`, `null` = definitive miss) and ships it as
    `SchemWorkerInput.datTexts`; `runSchemPipeline` calls `seedDatTexts()`
    before voxelizing. Texts in, triangles out — the resolver is untouched, and
    anything absent from the seed still fetches (with progress). Measured in
    Chrome on 21063: **53 `/ldraw-parts` requests during load, 0 during
    export** (with 3D Render OFF, i.e. nothing pre-loaded: 866 during export,
    as designed). Bonus: `.io` CustomParts exist only in the archive and used to
    hit the AABB box fallback in the export — they now voxelize for real.
    Tests: `test/schem-seeded-geometry.test.ts`.
  - **Geometry resolution was TIMING-DEPENDENT until 2026-09-02 — don't
    reintroduce.** `resolvePartTriangles` publishes a part's triangle array into
    `partGeomCache` before its sub-file refs are appended (the cycle guard), and
    the cache was checked BEFORE `geomInFlight` — so a parent could bake in a
    half-assembled child, and which caller lost the race depended purely on
    fetch timing. The same model voxelized to 1,184,777 cells over the network
    and 1,174,763 over a warm cache, with 4,474 cells of real geometry lost even
    cold. In-flight is now checked first; only a genuine reference CYCLE (an
    explicit ancestor set threaded through the recursion) may read the partial
    array. `viewer/ldraw/parts.ts` has the same shape and papers over it with
    `invalidatePartGeom` — if you touch either resolver, keep the ordering.
  - **Inter-part contact pass ("floating minifig hair", 2026-09-08).**
    `bridgePartContacts` in `engine/ldraw-geometry.ts`, ON by default
    (`VoxelizeOptions.bridgeParts: false` reproduces the old output).
    ROOT CAUSE, measured with `scripts/_hair_probe.ts` on 76416-1: LDraw authors
    a hairpiece so its socket CLEARS the head stud — 62810's underside sits
    **1.81 LDU** above the head's crown, 25972's 0.26, 99930's −0.12. A 4-LDU
    cell cannot represent a gap that small, and the rounding drops the hair's
    shell one row ABOVE and one column OUTSIDE the head's top row (which holds
    only the stud), so the two footprints meet **diagonally** — min Chebyshev
    distance 1, no shared face. In Minecraft that reads as a hovering hat.
    Nothing closed it: `fillSingleVoxelGaps` fills X/Z runs flanked on BOTH
    sides and has **no vertical pass at all**, so a diagonal step is invisible
    to it. The pass is PAIRWISE (the first attempt — "part with no contact
    anywhere" — missed the hair entirely, because the hair IS voxel-connected to
    the neck bracket it clips into while still visibly floating over the head):
    a pair is eligible only when its real world-LDU AABBs are within **half a
    cell** (a gap of one cell or more is representable, so it is REAL — measured
    4.00 LDU between stacked plates on 76416-1 — and stays open), it is skipped
    the moment the two footprints share any face, and otherwise every partner
    cell in the interface window takes its own shortest monotone path (≤1 cell)
    to the other part, coloured as the upper part. Two minifigs a stud apart are
    20 LDU / 5 cells apart: no pair is ever formed. Measured: 76416-1 2,229 near
    pairs → 29 bridged, +236 cells (+0.15%); 71043 Hogwarts 29,299 → 363,
    +3,765 cells (+0.10%), voxelize 8.7 s → 10.8 s. Content diff on 21063 (via
    `scripts/_schem_diff.ts`, which re-imports both files through the real
    parser): **1,748 gained, 0 lost**, 173 recoloured (gap-fill copies a
    neighbour, and the neighbour changed). Tests: `test/part-bridge.test.ts`
    (synthetic head+hair: 2 components → 1; a 3-LDU gap left alone; two heads
    never fused; additive-only). **Evidence on the real parts**:
    `scripts/_minifig_slice.ts <model.io> [cell] [figIndex] --pair [--out pfx]`
    voxelizes a head and the piece sitting on it both ways and prints the two
    slices side by side — 76416-1 fig #2 at cellLDU 4 goes from a FULL air row
    between hair and head (2 components) to a closed seam (1 component, +37
    cells) — and `--out` writes both as `.schem` for an external view:
    `output/schem-backlog/hair-off-zoom.png` vs `hair-on-zoom.png`.
    `scripts/_schem_ref.ts --no-bridge` is the A/B switch and still reproduces
    the pre-fix hash `d158beb…f3fd7` exactly, so the pass is provably the only
    change.
  - **Two "more accurate" voxelization rewrites were MEASURED AND REJECTED
    (2026-09-08) — don't retry them without a visual A/B.** Both are
    geometrically more correct than what ships and both look worse.
    1. **Exact triangle/cell overlap (Akenine-Möller SAT) instead of the
       surface pass's bounding-BOX fill.** Correct: the box fill marks cells a
       slanted triangle never enters. But the over-coverage is what carries
       sub-cell relief — with SAT, 21063's wall buttresses and arch recesses
       collapse flush into the wall behind them, and a curved part becomes a
       one-cell skin whose neighbours win half its boundary cells, so surfaces
       speckle. 1,190,999 → 1,049,085 cells. See
       `output/schem-backlog/before-z2.png` (ships) vs `sat-z2.png` (rejected).
    2. **Half-open cell lattice (cell g owns [g·c,(g+1)·c), floor instead of
       round).** Makes a part's dimensions exactly right — a 2×4 brick is
       10×7×20 cells at cellLDU 4 instead of 11×8×21 — and puts the ray lattice
       at true cell centres (origins are `(g+0.5)·c`, so today's rounding samples
       a cell CORNER). But every LEGO face is a multiple of 4 LDU, i.e. exactly
       on a lattice boundary at cellLDU 4, so tie-breaking decides every
       surface: −25.7% cells and the same flattening plus worse noise
       (`after-z2.png`). Centred cells over-cover by half a cell per side and
       that conservative bias is the fidelity.
    Measurement tools kept: `scripts/_vox_stats.ts` (set-level cells / bridge /
    time), `scripts/_vox_partcheck.ts` (per-part cells vs the part's real LDU
    extent + enclosed-air holes), `scripts/_vox_range.ts` (emitted cell range vs
    exact extent), `scripts/_schem_diff.ts` (decoded gained/lost/recoloured).
    `scripts/schem-external-check.mjs` now also accepts a `.schem` path directly,
    so two pipeline builds can be A/B'd in schemat.io without re-exporting.
  - **Partial blocks: slabs + stairs (2026-09-08).** `engine/block-shapes.ts`,
    behind the `Block shapes` MC setting (**ON by default**), run by
    `runSchemPipeline` after `fillSingleVoxelGaps`; **bricks source only** (an
    uploaded grid is already blocks). It never creates or removes a cell — it
    replaces one SOLID palette entry with another — so the over-coverage rule
    above still holds and a one-cell-thick feature keeps its cell either way.
    Two passes:
    * **occupancy → slab.** The voxelizer records per-cell vertical occupancy
      (`VoxelizeOptions.shapes`, 2-3 B/cell): each part's real world-Y extent
      clamped to each cell it emitted, unioned as a hull. A cell under 0.75 of
      its height with the mass on ONE side of the midline becomes a slab —
      **and only when the half it gives up is air anyway**, which is what keeps
      an interior seam (two stacked bricks share a boundary cell whose
      occupancy unions to "full") a cube. The proposal's literal rule
      ("bottom ≥0.6, top ≤0.2") was CORRECTED: centred cells put most of a
      stacked plate into the brick's own boundary cell and only ~10% into the
      cell above, so the commonest plate arrangement in LEGO scored 0.2 and
      stayed a cube (21063: 1,813 → 2,775 candidates at cellLDU 20).
    * **slope → stairs.** Membership from the LDraw library's OWN description
      line (350 parts start `Slope Brick`; 32-60° single-face only, so cheese
      31° and the steep/double/convex families are out) — NOT a part-id list,
      which would be stale immediately (`3040`/`3665` are `~Moved to` stubs).
      Direction and inverted-ness come from the part's triangles
      (`analyzeSlope`). **`facing` is the FULL-HEIGHT side** — verified by
      rendering (`output/schem-backlog/schemat-io-stair-flush.png`), NOT from
      this repo's generator, whose gable code reads inconsistently and which
      asks for the non-existent `minecraft:smooth_stone_stairs`. First attempt
      read normal slope 3040b as inverted: LEGO parts are hollow and studded, so
      a lattice cell inside a stud's top disc reports the part's HIGHEST surface
      as its lowest point. Top gradient is primary; the underside is consulted
      only when the top is flat.
    * **The ceiling: vanilla has NO slab or stair for any dyed family.** The
      DEFAULT tables emit ~97% concrete, so on 21063 only 5,355 of 87,800
      candidate cells (sandstone) can take a shape; 71,150 are concrete. No
      near-colour substitution is made — a quartz slab on a concrete wall is a
      visible material seam. `ShapeStats.noVariantByBlock` reports exactly what
      a slab-capable palette unlocks; the **Textured + shapes** profile below is
      that palette, and it takes 21063 to 55,722 slabs + 1,980 stairs.
    * **The residue, and why a CARPET does not fix it (slice 6, measured then
      REMOVED).** `<colour>_carpet` is the only partial shape vanilla gives a
      dyed colour, so it is the only thing that could reach the black cells the
      slab table structurally cannot. At the safe threshold (occupancy ≤0.25,
      where 1/16 of a block really is the nearest shape) it fired on **251 of
      87,800** cells and on **zero** of 21063's 16,688 black ones (they sit at
      0.4-0.7 of their cell). At the threshold the no-slab arithmetic implies
      (~0.53, since the alternative is a whole cube) it thins the top row of
      every dyed wall to a sheet — the exact "sub-cell relief collapses" failure
      that got both voxelization rewrites rejected. And unlike a slab it is a
      MATERIAL change (concrete→wool), breaking the "0 recoloured" property every
      gate here is written against. Don't re-add it; the reasoning lives on
      `ShapeStats.noVariantByBlock`'s docs.
    * Gates: **flag-off must ALWAYS reproduce the no-shapes hash**; shapes-ON is
      gated by CONTENT DIFF, never by hash. `scripts/_schem_diff.ts` separates a
      shape refinement from a recolour; 21058 shows 0 gained / 0 lost /
      0 recoloured / 20,793 shaped. `scripts/_schem_ref.ts --no-shapes` and
      `scripts/_export_browser_check.mjs --shapes on|off` are the A/B switches
      (`_schem_ref.ts --profile=<id>` A/Bs a palette).
      Tests: `test/block-shapes.test.ts`, `test/schem-block-states.test.ts`.
  - **Semantic elements: panes, fences, walls, bars, ladders (2026-09-08).**
    `engine/part-elements.ts`, same `Block shapes` toggle, run by
    `runSchemPipeline` BEFORE the slab/stair pass and zeroing `hints.element`
    for every cell it declines (so a declined cell can still become a slab).
    Same contract: one solid palette entry for another, footprint unchanged.
    * **Membership is the LDraw description line again**, never a part-id list.
      `Glass for …` → `<colour>_stained_glass_pane`/`glass_pane`; `^Fence` → the
      wood fence or stone wall of the cell's OWN material; `Lattice` →
      `iron_bars`, and only in a neutral gray/metal (iron_bars is a fixed
      colour, so anywhere else the swap is a recolour); `Ladder` →
      `ladder[facing]`. Connection states (`east/north/south/west`) are computed
      from the grid, so a window is a sheet of connected panes, not a row of
      posts.
    * **Ladder facing comes from the GRID, not the part.** The LDraw origin of
      "Plate 1 x 2 with Ladder" says nothing reliable about which face the rungs
      are on. A ladder is placed only where a solid cell sits BEHIND it
      (Minecraft's model hangs on the face opposite `facing`) and the climbing
      side is open; otherwise the cell keeps its cube.
    * **Resolution is part of the contract**: a Minecraft pane/fence/bar/ladder
      is ONE cell, so `MAX_ELEMENT_CELLS = 64` turns elements on at 1-2.5
      blocks/stud (a 1x4x6 window glass is ~5×8 cells) and off at 5, where the
      same glass is ~150 cells. Verified: 21063 at auto (cellLDU 4) runs no
      element pass at all.
    * **DOORS ARE DELIBERATELY REFUSED** (514 placements measured), and this was
      the proposal's headline element. Every LEGO door in the corpus is 3-4
      studs wide and 5-7 bricks tall; a Minecraft door is one block wide and two
      tall, so any mapping deletes ~95% of the part or leaves a door floating in
      a wall of cubes. Likewise "Grille" tiles/bricks (6,523 placements — SOLID
      mouldings; `iron_bars` would hole the wall), flora (1,533) and antennas
      (280), both of which would be recolours. `scripts/_element_survey.ts`
      reproduces every number (613 files, 530,695 placements).
    * Gates: 21325 at 1 block/stud → 65 fences + 14 bars; 60365 → 99 panes; both
      0 gained / 0 lost / 0 recoloured / 0 unshaped. Re-import through the real
      Upload-tab parser preserves dims, non-air and all 53 palette entries.
      Chrome (Worker path) reproduces the CLI's element counts exactly. Tests:
      `test/part-elements.test.ts`.
  - **Lanterns for the light fill (2026-09-08).** With `Block shapes` on, the
    interior light fill drops `lantern[hanging=false]` instead of a glowstone
    cube — same light level 15, reads as a lamp rather than a glowing floor
    tile. `LightFillOptions.floorLightBlock` is used only where something solid
    is below (a standing lantern otherwise pops off); with shapes off the light
    fill is byte-identical to before.
  - **Byte-identity is the gate.** With defaults **and `--no-shapes`** (auto /
    default profile / light fill OFF) `scripts/_schem_ref.ts` (driving the REAL
    shared pipeline) on 21063 gives sha256 `53dac11…9e40e2`, 1,190,999 non-air.
    **Re-derived 2026-09-08** (was `d158beb…f3fd7` / 1,189,251) by the contact
    pass above — deliberate, verified additive-only. The hash before that was
    `52d2211…4be6b` / 1,184,777, retired 2026-09-02 by the race fix — that one
    was reproducible only because the CLI's timing was. The seeded browser export is
    that grid **+16 cells** (1,189,267, confirmed in Chrome): the viewer's
    candidate-path list has the `p/48/` hi-res alias tail, so it resolves 7
    primitives (`1-12ring14`, `4-4aring`, …) that the bare export resolver
    misses. Nothing else differs — a seed built from the EXPORT resolver's own
    picks reproduces `d158beb…` exactly. `test/schem-pipeline.test.ts` proves
    the grid path is `bytes === encodeSchemBytes(grid)`.
- **External-viewer gate (S5, 2026-09-01)** — our importer round-trips whatever
  we write, so a palette/colour-space mistake is invisible internally (that's
  how S1 hid). Two halves:
  1. **Palette lint, offline** — `engine/palette-lint.ts` +
     `engine/mc-block-registry.json` (curated, verified Java 1.20 ids: the
     16-colour families + solids + light sources). `test/palette-lint.test.ts`
     asserts every value in BOTH colour tables, the fallbacks, the profile light
     blocks and a REAL exported .schem's `Palette` are `minecraft:<known id>`.
     A new block means adding it to the JSON deliberately. Since 2026-09-08 the
     `[k=v,…]` STATE tail is validated too (keys and values against a per-suffix
     schema for `_slab`/`_stairs`/`_pane`/`_fence`/`_wall`/`ladder`/`lantern`/
     `iron_bars`; syntax + duplicate keys otherwise) — a state
     string is where a plausible typo hides best, since `[type=lower]` and
     `[facing=up]` round-trip through our own encoder and importer perfectly and
     only fail in Minecraft. Registry discipline: a shape id is listed only for
     a base material already verified in `blocks`, and only where vanilla really
     has it (`smooth_stone_slab` exists, `smooth_stone_stairs` does not — and
     `src/gen/material-resolver.ts` still asks for the latter, a pre-existing
     generator bug this lint would catch if that path were linted).
  2. **Browser gate** — `node scripts/_export_browser_check.mjs [model.io] [label]`
     (node, dev server on 4000) drives the REAL LEGO tab in Chrome: it reads the
     ⚙ MC settings resolution list, uploads a model, exports a `.schem` through
     the Web Worker and reports the phases the progress banner showed. Verified
     2026-09-08: 71043 (5,936 bricks) exports in **3.2 s** with a warm geometry
     cache — banner phases `voxelizing 1…85% → joining parts → closing surface
     holes` — 637,850 blocks at 2.5×/stud; 76416-1 cold (no IDB cache) 157 s,
     dominated by part fetches, not voxelization.
  3. **schemat.io, scripted + manual** — `node scripts/schem-external-check.mjs`
     (node, NOT bun: `chromium.launch` hangs under bun here; `channel:'chrome'`)
     exports 21063 through the shared pipeline, checks the baseline sha256,
     uploads it to schemat.io/view and screenshots to `output/schem-backlog/`.
     Verified 2026-09-01: white castle, solid walls, green/brown base — no
     translucent walls, no magenta terrain. NOT in CI (third-party site).
- **Bedrock Edition export: native `.mcpack`, no lossy hop (2026-09-08).**
  The user's previous route was our Java `.schem` through `../HotSchem`, and that
  conversion is where quality was lost. Verified from HotSchem's own source
  (`HotSchem_BP/scripts/main.js`, `HotSchem-Importer.html`): it does **no block-id
  renaming at all**, so every Java id whose Bedrock name differs fails
  `BlockPermutation.resolve` and becomes **air** (`bricks`, `nether_bricks`,
  `red_nether_bricks`, `end_stone_bricks`, `stone_slab`, `cobblestone_stairs`,
  `snow_block`, `magma_block`, `slime_block`, `rooted_dirt`, `jack_o_lantern`,
  `light_gray_glazed_terracotta`, `prismarine_brick_stairs`,
  `end_stone_brick_stairs` — 14 of the ids our palette emits); it drops
  `type=double` (a full block becomes a half); and it sends ladder `facing` to
  `minecraft:cardinal_direction`, which `ladder` does not have (Bedrock uses
  `facing_direction`), so every ladder falls back to one default orientation.
  Its README says as much: "block-state translation is partial".
  - **The format**: `.mcstructure` is Bedrock's native placeable structure —
    little-endian NBT, **uncompressed, NO file header** (unlike `level.dat`'s
    8-byte version+length prefix), unnamed root compound. `block_indices` is a
    TAG_List of exactly **two** TAG_Lists of TAG_Int sharing one palette (layer 1
    is waterlogging; we write all `-1`). Cells run **Z fastest**:
    `index = x*sizeY*sizeZ + y*sizeZ + z` — the documented 2×3×4 example is
    pinned in `test/mcstructure.test.ts`, because getting it wrong transposes the
    whole model and no palette check would notice. `-1` means "leave the existing
    block", so air is written as an explicit `minecraft:air` entry and a placed
    model CLEARS its own box instead of having terrain poke through its interior.
    `web/src/engine/mcstructure-encode.ts`; LE writers added to `byte-writer.ts`.
  - **The mapping is DATA, generated from Mojang's own registry.**
    `scripts/gen-bedrock-blocks.mjs` pulls
    `bedrock-samples metadata/vanilladata_modules/mojang-blocks.json` (every
    Bedrock id, every state name, every allowed value) → checked-in
    `web/src/engine/bedrock-block-states.json` (444 blocks, 18 properties, 51
    double-slab ids), scoped to the ids `mc-block-registry.json` allows. The
    generator FAILS if a rename target does not exist, and forward-checks the
    result against `main` so an id Mojang removed fails there, not in a world.
    `engine/bedrock-blocks.ts` layers the translation on top and has **no silent
    fallback** — `toBedrockBlock` returns null and the gap is reported.
    `test/bedrock-blocks.test.ts` asserts every id in the registry maps.
  - **Three versions must agree, and 1.21.40 is the measured floor.** Generator
    ref `v1.21.40.3`, manifest `min_engine_version [1,21,40]`, palette `version`
    stamp `18163712` (= 0x01152800 = 1.21.40.0). The flattening arrived in waves:
    1.21.20 moved `stonebrick`+`stone_brick_type` → `stone_bricks`,
    `stone_block_slab4` → `normal_stone_slab` and the `dirt`/`sand`/`quartz_block`
    type states; **1.21.30** the whole wall family and `purpur_pillar`; **1.21.40**
    added `mushroom_stem`. Generating from a newer ref would ship an id a 1.21.40
    client lacks; from an older one, 15 of our ids don't resolve. Bedrock runs its
    upgrade schemas FORWARD from the stamp, so an older stamp is the safe
    direction (packs stamping 1.18.10.1 still load) — a stamp newer than the
    client has no downgrade path.
  - **The traps, all pinned by tests.** Bedrock's `stone_stairs` IS *cobblestone*
    stairs and its stone stairs are `normal_stone_stairs` — both names exist in
    both editions with different materials, so swapping them is invisible.
    `snow`/`snow_block` swap meaning across editions. Java `terracotta` is
    `hardened_clay`. Light gray glazed terracotta is `silver_glazed_terracotta`.
    A **double slab is its own block** and where "double" goes is data, not a rule
    (`oak_double_slab` but `waxed_double_cut_copper_slab`). Slabs use
    `minecraft:vertical_half` (string), NOT `top_slot_bit` (used by zero blocks
    now); stairs use `weirdo_direction` (**int** 0-3: east 0, west 1, south 2,
    north 3) + `upside_down_bit` (**byte**) and have no `shape`; walls use
    `wall_connection_type_*` where Java's `low` is **`short`**; panes, iron bars
    and fences carry NO connection states (Bedrock recomputes them) so Java's
    north/south/east/west must be DROPPED or the permutation is unresolvable. The
    NBT *type* matters as much as the name — an int written as a byte silently
    lands the block on its default permutation.
  - **Tiling**: Bedrock caps one structure at **64×384×64**, so a big model is
    split (`planStructureTiles`), each tile TRIMMED to its own occupied bbox and
    empty tiles dropped — `block_indices` costs a flat 4 bytes/cell/layer with no
    packing, so trimming is what keeps a 1.19M-block model at 233 KB. Because
    each tile records its grid origin, the pack also ships
    `functions/craftmatic/<name>.mcfunction` — one `structure load … ~dx ~dy ~dz`
    per tile — so the player stands at the corner and runs **one** `/function`
    instead of placing 15 pieces at computed coordinates. `engine/mcpack.ts`.
  - **Pack identity is deterministic, not random**: manifest UUIDs are hashed
    from the filename stem, so re-exporting a set UPDATES the pack the player
    already has rather than adding a duplicate with the same name, and the output
    is reproducible enough to test. `format_version: 2`, one `data` module,
    manifest at the ZIP ROOT, structures under an explicit `structures/craftmatic/`
    namespace (a file directly in `structures/` silently becomes `mystructure:…`).
    `createZip({alwaysDeflate:true})` — no official word on whether Bedrock
    accepts STORED entries, and DEFLATE costs nothing.
  - **Verified / not verified.** Verified offline: the bytes decode with
    `prismarine-nbt` in `little` mode and with an independent hand-written Python
    LE-NBT reader (real 21063 pack, 4.98 MB tile, consumed to the last byte);
    tiling reassembles cell-for-cell; the zip passes Python `zipfile.testzip()`
    with DEFLATE throughout and a root manifest. **NOT verifiable without a
    Bedrock client**: that the game accepts the `version` stamp, that a complete
    `states` compound is preferred over a partial one (undocumented — vanilla
    always writes complete), the ladder `facing_direction` north/south
    convention (derived from the shared pre-1.13 metadata, not a quoted
    cross-edition mapping), and `huge_mushroom_bits` 14/15 for cap/stem.
    Activating ANY external behavior pack permanently disables achievements in
    that world — the in-pack README says so.
- **Export progress is a FIXED banner** (`web/src/ui/export-progress.ts`, S2):
  `beginExportProgress(title)` → `update(phase, pct?)` / `done()` / `fail()`.
  `#lego-status` stays the log (it scrolls out of view — that's why exports
  looked hung); the banner is the live surface, wired into schem/litematic/
  guide/GLB/OBJ/STL/3MF (CSV is instant). It sits at `#nav`'s measured bottom
  so it never covers the tab bar, and toggles `style.display` (never
  `[hidden]` — a `display:` rule would override the attribute).
  **Every phase must report honestly (2026-09-02).** `prefetchPartGeometry`
  streams REAL `resolved/total` progress (it used to post a single `0` and sit
  there for the whole download — minutes of "loading part geometry 0%", which
  reads as a hang), and the worker's 80 ms progress throttle now ALWAYS posts a
  phase CHANGE: throttling one left the banner showing the previous phase's
  name and percentage. Omit `pct` for genuinely unknown work — the bar goes
  indeterminate, which is honest; a stale number is not.
- **All materials are `DoubleSide`** (LDraw `.dat` winding is unreliable), so
  triangle winding is **shading-irrelevant** — Three flips the normal per
  `gl_FrontFacing`. Consequence: `resolvePartGeometry`'s cache keys by part id
  and IGNORES its `invertWinding` arg (so a part used both normally and mirrored
  shares one winding) — a latent correctness bug with **zero visual impact under
  DoubleSide**. Don't "fix" it for shading. It ONLY becomes real if someone
  adopts FrontSide/BFC culling for perf — then key the cache by winding first.
- **`preserveDrawingBuffer` stays OFF** — it forces tiled mobile GPUs to copy the
  framebuffer every frame. `captureScreenshot()`/`captureScreenshotAt()` render
  explicitly before `toDataURL()`, which is the correct capture pattern.
- **Mobile profile** (`IS_MOBILE`: touch + short edge <900px): pixel ratio ≤1.5,
  shadow map 1024², SAO skipped (SAOPass re-renders the scene for depth+normals).
- **Adaptive edge LOD** (`EDGE_SEGMENT_BUDGET`, desktop 3.5M / mobile 1.2M): the
  global edge `LineSegments2` is collected per-brick; if total segments exceed
  the budget the WHOLE model's edges are dropped (`edgesDroppedForSize` → LEGO
  status note). Do NOT reinstate the old `segCount < 2_000_000` HARD cap — it
  truncated edges mid-model (hero sets like 71043 Hogwarts, ~2.65M segments, got
  partial/inconsistent outlines). 3.5M gives Hogwarts + all normal/flagship sets
  FULL consistent edges; only the 2 mega-sets whose edge buffers ≈200MB (UCS
  Falcon ~3.8M, Colosseum ~4.5M) drop them — memory-responsible AND sub-pixel at
  full view. Mobile drops earlier (fat lines are costly there).
- **Geometry is verified correct** at the fundamental level (flush controlled
  stack at exact heights; ~0 duplicate placements; ~0 isolated bricks; matches
  official box images). The historic "overlap/float/flicker" reports were the
  two rendering bugs above, not placement errors.
- **Renderer verified solid on the heaviest sets (2026-06, don't re-investigate):**
  UCS Falcon 75192 (7552 bricks, ~6.9M mesh tris) renders correct + recognizable
  at 97fps desktop, 0 missing; Colosseum 9060, Hogwarts 5936 likewise. **Printed
  parts render** (minifig faces, printed tiles, multi-colour prints resolve via
  the `colorTris` path — TEXMAP is only a subset). No correctness/fidelity gap.
  The remaining renderer gap is mobile triangle/LOD for UCS-class sets (the edge
  LOD above is a first lever; deeper mesh LOD needs a device to validate fps).

## Color systems (don't conflate)
- **LDraw** ids (0=Black, 1=Blue, 15=White) — `.mpd`/`.ldr`.
- **Studio/BL** ids (1=White, 7=Blue, 11=Black) — `.io` model2.ldr.
- **LDD material** ids — `.lxf`. See clego `StudioColorDefinition.txt`, `ldraw.xml`.
- **`.io` colour space is per-FILE, never per-extension** (backlog S1, fixed
  2026-09-01). Studio ships the SAME model twice: `model.ldr` in **LDraw** ids
  and `model2.ldr` in **Studio/BL** ids. `extractIoModel` returns the first
  entry with type-1 lines, so MODERN exports resolve to `model.ldr` — but
  `lego.ts` used to hard-wire `colorFn = studioColorToBlock` for every `.io`.
  Reading LDraw ids through the BL table sent LDraw 15 (White) to Studio 15
  (Trans-Light Blue): 21063's 939 white castle-wall bricks exported as
  `light_blue_stained_glass`, LDraw 71/28/19 as magenta/orange/yellow-glass
  terrain (~37% of blocks translucent). `extractIoModel` now returns
  `{sourceEntry, colorSpace, colorSpaceReason}` via `detectIoColorSpace()`,
  which PROVES the pairing by histogram (BL→LDraw-mapping model2's counts must
  reproduce model.ldr's — 100% vs 5% literal on 21063) and falls back to the
  per-entry convention for single-entry archives. `web/src/engine/bl-ldraw-map.ts`
  is generated by `scripts/gen-bl-ldraw-map.py`. Tests: `test/io-colorspace.test.ts`.
  **Why the existing round-trip tests missed it:** exporting AND re-importing
  through the same wrong table is self-consistent — only an EXTERNAL viewer
  (schemat.io) or a palette assertion catches a colour-space error.
- Unmapped ids in BOTH resolvers fall back to `gray_concrete` (never a loud
  magenta) and `console.warn` once per id — don't make the fallback colourful.

## Gotchas
- **PWA service worker** caches all modules and serves stale code. If changes
  don't take effect: unregister SW + clear caches, then hard reload. (See the
  snippet history; `navigator.serviceWorker.getRegistrations()...` + `caches.keys()...`.)
- **`[hidden]` + `display:flex` trap**: rows with `class="lego-scale-row"` (which
  sets `display:flex`) override the `hidden` attribute. Toggle `style.display`,
  not just `.hidden` (bit the help overlay AND the step/explode rows).
- LDraw Y is down; the viewer handles the handedness. Model-aware F/B/L/R
  orientation is derived from the longest horizontal axis + brick mass.

## Connectivity / "are pieces floating?" verification
It is a **contact-candidate heuristic, never a certificate** (audit 2026-09-08
P1 #5). The UI control is "**Contact check**"; the old "✓ Verified: all N pieces
form one connected structure" copy is gone and must not come back — a voxel
proximity test with a 4 LDU tolerance cannot certify assembly, and the tolerance
makes "one component" the WEAKER claim (it over-connects). All user-facing
wording lives in `web/src/ui/contact-check-status.ts` and is unit-tested against
that claim boundary (`test/contact-check-status.test.ts`); every message
discloses tolerance, snap-table coverage %, pieces with no resolved geometry,
and placements that never rendered so the audit never saw them.
- **The hybrid IS fused now** (`auditConnectivity`): surface contact ∪ LDCad
  attachment points. `web/src/viewer/ldraw/attachment-snaps.ts` (GENERATED by
  `scripts/gen-attachment-snaps.py`, 413 parts / 1,116 connectors) covers the
  blind classes — clip-bearing parts, bars/pins/axles, minifig heads + headgear,
  small stud families. Coverage is deliberately partial, so the report carries
  `piecesWithSnaps` / `snapOnlyUnions` and the UI states the % rather than
  implying completeness (measured: 10365 25%, 42007 54%). Matching thresholds
  are inherited from `scripts/ldcad_connectivity.py` (CELL 20, TOL 8 LDU,
  |cos| > 0.95, radius slack 1.5); `SNAP_GEN` is skipped — matching it needs
  group ids the table doesn't carry and a groupless match would invent unions.
- **Detached ≠ suspicious**: groups are split with geograde's calibrated rules
  into `airborne` (nothing within 12 LDU below AND >48 LDU above the model
  floor) and `grounded` (resting on something — minifigs, accessories, stands,
  second models). It is a geometry guess about intent and the copy says so.
- **`expand_grid` gotcha (fixed 2026-09-09)**: LDCad also emits a **3-axis**
  grid form (`1 C 2 C 2 0 80 60`, 13 lines in the shipped library). The old
  2-axis-only parser raised `ValueError` on the third spec's `C` and took the
  whole part's snaps down with it. Derive the axis count as `(len - nC) / 2`.
- Engine detail: the LEGO tab's checkbox runs `viewer.highlightDetached(4)`;
  unchecking calls
  `clearDetachedHighlight()` (restores stashed material colors + instance
  colors + edge overlay + prior status). Engine: `viewer.auditConnectivity(resLDU=4)`
  voxelizes each part's triangle SURFACE, transforms per instance, unions pieces
  whose surfaces share/neighbour a voxel → connected components (typed
  `ConnectivityReport`, offline-tested in `test/connectivity-audit.test.ts`).
  `web/src/viewer/ldraw/connectivity-audit.ts`. **It detects face contact
  (stud-stacking, flush) but is BLIND to clip/bar/pin/SNOT grips.** Result:
  traditional builds → one 100% component (21063 .io verified, incl. via the UI
  control); SNOT/microscale (71043) under-counts but the highlight shows the
  "detached" pieces are embedded base/spires → **no floaters**. It's genuinely
  useful on RECONSTRUCTED models: the 21063 dbix_recon LDR shows 87% / 409
  detached — real placement gaps in the reconstruction, not audit noise.
  **Highlight gotchas (hard-won)**: (1) `instanceColor` MULTIPLIES
  `material.color` — force materials white (stash/restore) or red-on-green
  renders black; (2) the global edge `LineSegments2` keeps original per-segment
  colors and is dense enough to visually MASK the recolor entirely — hide it
  while highlighted.
- **LDCad snaps (offline, supplement)**: `scripts/ldcad_connectivity.py <model.io|.ldr>` uses the real LDCad shadow library to match male/female SNAP_CYL/CLP/FGR/GEN connectors. **COMPLETE but proven insufficient ALONE** — even 21063 (geometry-proven 100%) only reaches 69% via snaps, because LEGO joints are dominated by clutch/tile/flush contacts snaps don't encode. It is also the offline reference the browser table is generated from (above).
- **Settled findings**: 21063 fully connected; **71043 has no floating pieces** (verified geometrically + visually). Don't re-litigate.

## Offline reference data (for the analysis scripts; in `C:/git/clego`, dev-only)
- **LDraw part library** (real `.dat` geometry): `extracted/studio_release/app/ldraw` (`parts/`, `p/`, `p/48/`, `parts/s/`).
- **LDCad shadow library** (SNAP metadata, 4255 `.dat`): `ldcad/unpacked/offLib/offLibShadow.csl` (a zip). Acquired from melkert.net LDCad 1.7 `shadow.sf` (zip → `offLibShadow.csl` zip). Snap format: `0 !LDCAD SNAP_CYL [gender=M|F] [secs=R <radius> <len>] [pos=...] [ori=...] [grid=...]`. Studs y=0 (M), anti-studs y=24 (F) in part space.
- **Mecabricks parts**: `mecabricks_parts/geometries` (810 high-fidelity meshes) + `configs` (857; `geometry.extras.knobs`=studs, `tubes`=anti-studs, 456 populated). NOT used — LDraw already covers all parts; Mecabricks is a higher-fidelity SUBSET in ~2.5×-LDU Y-up coords. Only worth it for Mecabricks-grade fidelity (big lift, partial coverage).
- `.io` AES decrypt (for offline model loading): WinZip AES-256, pw `soho0909`, PBKDF2-HMAC-SHA1 1000 iters, little-endian CTR (see `scripts/ldcad_connectivity.py` `read_io`).

## Browser-automation testing caveats (claude-in-chrome — hard-won, saves hours)
- The automation tab runs **backgrounded → `requestAnimationFrame` is throttled/paused**. So **on-demand rendering means the canvas often has no fresh frame** and `Page.captureScreenshot` **times out — just retry it** (usually succeeds 2nd try). Continuous-render checks (live FPS) are unmeasurable here.
- **Enable the Stats checkbox to force continuous rendering** when you need reliable screenshots (it sets `animating=true`).
- **Editing `viewer.ts` triggers HMR which disposes the viewer → `window.__ldrawViewer` becomes null/stale.** After any viewer edit you MUST reload the page AND re-load the model before using the dev hook.
- **Synthetic pointer/wheel events don't reliably drive OrbitControls.** To move the camera, set it via the hook: `v.cameraAnim=null; v.controls.target.copy(...); v.camera.position...; v.controls.update(); v.composer.render()`. `v.setView('iso'|'front'|...)` works (it animates).
- **Verify the loaded model** (`window.__collect?.().length` or `viewer` brick count) — a 404'd `fetch('/inspect-X.io')` silently leaves the PRIOR model loaded (this mislabeled an audit once).
- Test models: copy `C:/git/clego/lego_sets/IO/<set>.io` → `web/public/inspect-*.io`, dispatch `change` on `#lego-mpd-input`, delete after (keep out of git). OMR `.mpd` fetch directly via `/ldraw-omr/<set>-1.mpd`.
- Dev-only `window.__ldrawViewer` is set in `viewer.ts` load() under `import.meta.env.DEV`.

## Autonomous improvement loop
`scripts/renderer-improve-loop.mjs` is a Stop hook (in `.claude/settings.json`) that, when `.claude/improve-loop-state.json` has `"active": true`, blocks stop + re-injects a "find/implement/validate/commit the next improvement" directive (50-pass cap). Currently `active:false`. Re-arm: set `active:true, pass:0`.

## Model index schema 2 — MEASURED assembly metadata (2026-09-09)
`lego-models-index.json` (built by clego `build_model_index.py`) stamps every
`models[]` entry with geograde's verdict for **that file**, additively:
`asm` `'verified'|'defective'`, `sev`, `defects[]`, plus `lineage` (the file's
own `0 !LINEAGE <tool> <good|partial>`) and `hash` (sha256/12 of the bytes).
Root gains `schema: 2` and a `geograde` block (scoreboard timestamp, thresholds,
graded/stale counts). **`asm` ABSENT = unverified = NOT MEASURED, never a
defect** — 2,749 grades were dropped on the first build because the file was
re-emitted after grading (the scoreboard keys by path and records no hashes, so
mtime > scoreboard time ⇒ ungraded). Cost: index 2.44→3.55 MB raw, 331→533 KB
brotli, mostly the per-entry hashes.
- **Ranking** (`engine/lego-sources.ts` `verifiedPromotion`, above the existing
  conv demotion): a graded-PASS entry displaces a graded-**DEFECTIVE** first
  pick only. Guards that must stay — an *unverified* incumbent is never demoted;
  the candidate must be non-conv, in a same-or-better `sourceClass`, retain
  ≥95 % of the incumbent's placements, and not grade worse on severity.
  Measured: 145/10,092 sets change, none across a class boundary. **The
  unguarded "first verified wins" rule moved 360 sets and promoted a vision
  reconstruction over a conversion 34 times** — a recon can pass simply by
  reconstructing less. Don't loosen it. Worked example: 10365 dbix_conv_v3
  (defective, 60 big-floating) → dbix_conv_v2 (PASS) at the same 2,891 parts.
- **Intended vs actual**: `loadDiag` in lego.ts records the try-order's intent,
  every source the chain walked past + why, and what rendered. Badge shows the
  LOADED source (`⚠ fallback` when it isn't the intended one, trail in the
  tooltip); the status carries a one-line reason. `⤓ diagnostics`
  (`ui/lego-diagnostics.ts`) downloads the reproduction bundle — source
  URL/hash/lineage/verdict, index+geograde provenance, mapping sizes,
  missing/substituted parts, render state, last contact audit.
- **Publishing**: regen (`python build_model_index.py`) then
  `python sync_models_r2.py --only <paths…>` from clego — with **no** `--only`
  args it uploads just the index. A fresh regen picks up corpus files added
  since the last publish, so upload those too or prod 404s on them (92 new
  MecabricksLDR models on 2026-09-09). Verify by reading the index back through
  the worker, not from the done-list (`_r2_uploaded.txt` is a stale resume
  marker — 2,157 paths it omits are actually in R2).

## Deploy
Cloudflare: static build (`web/dist`) + Worker (`worker/ldraw-omr.js`).
**`deploy.yml` publishes to TWO hosts and they are not equivalent**: the GitHub
Pages mirror (`tribixbite.github.io/craftmatic`) has no Worker in front of it,
so `/lego-models/*`, `/lego-models-index.json`, `/ldraw-parts/*`, `/ldraw-omr/*`
and `/bff/*` all 404 there — the LEGO tab can search the bundled catalog and
then load nothing. `craftmatic.click` is the supported deployment (README says
so since 2026-09-09); always ask which host a LEGO bug came from.
`wrangler.toml` routes `/ldraw-omr/*`, `/ldraw-parts/*`, `/lego-models/*`,
`/lego-models-index.json` AND (since 2026-09-02) `/bff/*` + `/seymouria-ldr/*`
to the Worker. Those last two used to live only in the CF dashboard and were
**not in effect** — `craftmatic.click/bff/inventory/21063-1` returned GitHub
Pages' 404, so the LEGO tab's last-resort source was dead in prod while fine in
dev. Declare routes in `wrangler.toml`, never only in the dashboard. Run
`bunx wrangler deploy` after changing the Worker or routes.
**Pending deploy (2026-09-09):** `/ldraw-parts/_rev` is a new worker route and
`ldraw/_rev.json` is written by the next full `sync-ldraw-r2.mjs` run. Until
BOTH land, prod returns 404 there and every browser keeps its part cache — the
documented "unknown revision" behaviour, not a failure. `test/prod-smoke.test.ts`
accepts 200-or-404 for exactly this window; tighten it to 200 once a stamp
exists.

## Source freshness (new sets over time)
Two halves, split by what can run without the local corpus. See
`clego/SOURCES.md` for the full channel audit.
- **CI** — `.github/workflows/refresh-sources.yml`, weekly: `prebuild:lego`
  (Rebrickable → `lego-catalog.json`, gitignored, so a new set is searchable),
  `prebuild:omr` / `prebuild:seymouria`, then `scripts/source-freshness.ts`,
  which measures the gap the catalog refresh CANNOT close: fresh catalog ∖
  published model index = sourceless, intersected with the live DBIX skulist +
  OMR list = *harvestable today*. Commits `source-freshness.json` (timestamped,
  so it always commits — that push is what triggers `deploy.yml` and gets the
  fresh catalog to prod).
- **Local** — `clego/discovery/refresh_local.py --run`: refresh `sets.csv`,
  diff the DBIX skulist and harvest+convert what's new, geograde it, rebuild
  `lego-models-index.json` FRESH, publish scoped to R2 (`sync_models_r2.py
  --only`; an unscoped sync uploads another agent's in-progress corpus).
- **Why it exists (40975-1)**: the catalog refreshes every deploy, the model
  index is generated by hand from a 1.8 GB local corpus, so a 2026 set was
  searchable with zero sources — and its DBIX model had existed upstream all
  along (the harvest was 92 SKUs stale). Search freshness ≠ model freshness.
- **`#` in a model FILENAME is unfetchable in prod** (found 2026-09-02, NOT yet
  fixed): the R2 object uploads and `wrangler r2 object get` reads it, but the
  worker's `/lego-models/` handler 404s for every encoding (`%23`, `%2523`,
  `+`) while the same key with a space serves 200. Dev is fine — the Vite
  middleware decodes `req.url` itself — so it is invisible until you check
  prod. 96 index paths carry it (DBIX `_step #kh.ldr` naming) across 20 sets, 9
  as their primary pick. Repro + the two candidate fixes: `clego/SOURCES.md`
  §5b. **Verify any R2 publish by reading the keys back through the worker** —
  `wrangler r2 object put` also returns 429 under concurrency, so "Upload
  complete" is not proof (and urllib's default UA gets 403 from the edge, so
  set one or every object looks missing).
