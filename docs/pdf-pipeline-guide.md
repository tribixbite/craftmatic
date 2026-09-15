# PDF reconstruction pipeline

Read before working on PDF extraction, part identity, placement, autonomous reconstruction, or accuracy claims.

[Project guide](../CLAUDE.md). Paths in code spans are relative to the repository root unless explicitly qualified.

**PDF reconstruction (2026-09-07):** see [the audited status](../docs/pdf-reconstruction-status-2026-09-07.md).
The user requires PDF-only set input, optionally an available parts list, and **zero runtime VLM**; VLM is permitted
only during development/verification. Historical 95.4% extraction coverage is
not model accuracy. The live index has 2,355 reconstruction-only base sets;
no new audited output meets the latest >=90% full-model placement target. Do not launch the old VLM
batch or overwrite better-source models. The actual engine is in `C:/git/clego`;
`recon_extract.pdf_pipeline` is a quarantined deterministic research entry point,
not a certified assembler. Filter the full catalog before paginating results.
Follow-up [GPU matching trials](../docs/pdf-reconstruction-matching-trials-2026-09-07.md):
a small CNN improved eligible BOM-icon retrieval (374/411 vs 357/411 pixels),
but did not improve actual unseen-set PLI transfer. Learned scalar placement
rankers also failed. Do not equate this conditional icon score with model
accuracy or scale training on the contaminated historical step labels.
Current [placement rearchitecture](../docs/pdf-placement-rearchitecture-2026-09-07.md)
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
