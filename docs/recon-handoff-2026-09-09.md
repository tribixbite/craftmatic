# PDF-reconstruction program — handoff (2026-09-09, after round ten)

Audience: the next agent taking over the recon pipeline with a mandate to
solve/fix/improve/rearchitect. This distils ten measured rounds (2026-09-08/09,
`scripts/pdf-recon/` + `docs/pdf-placement-rearchitecture-2026-09-07.md`, which
remains the detailed ledger — read it after this).

## Mission and constraints (user-set, standing)
- ≥90% correct-pose reconstruction from **PDF alone** (optional parts list OK).
- **Zero runtime VLM.** The remote VLM (192.168.1.32:8090/v1, qwen3.8-27b,
  multi-image) is a development-verification instrument only — and it has been
  WRONG where measured instruments existed (round 1's camera call). Prefer
  measurement.
- Reference/OMR models are EVALUATION-ONLY. Never inputs. No training on the
  contaminated historical step labels (see CLAUDE.md's PDF section).
- Research stays quarantined in `scripts/pdf-recon/`; protected clego files
  (reconstruct_from_pdf.py, mating.py, ldr_utils.py, eval_reconstruction.py,
  pdf_reader_v2_snap.py) untouched; never overwrite better-source models.

## The state of the program in one paragraph

**The on-ramp is now the part that works and the per-page placement drive is the
part that does not.** A PDF is the pipeline's only input:
`placement_autonomous_run` extracts the printed BOM, associates every callout,
assigns identities against the inventory, gates them on CAD-size consistency,
pools proven mould variants, derives the page scope, builds an opening, selects
among openings by a reference-free channel and drives the booklet — with **no
attended step**. Across six BrickHeadz fixtures it puts a **median 95%** of the
printed inventory into a drivable page scope. What it cannot do is place them:
41601 end to end from the PDF alone scores **6 of 108 correct poses**, and the
drive's own contribution over its opening is **+0** — as it has been in every
from-scratch chain this program has measured.

## The honest scoreboard

| fixture | truth | best structural | driver's own contribution | notes |
| --- | ---: | ---: | ---: | --- |
| 40377 | 90 | **54** | +9 (45 inherited) | opening pages 1-15 were HAND-BUILT; the allocation it was driven from held only 54 of 90 pieces. Round ten's derived allocation reproduces those 17 pages exactly and adds the other 11 — a from-scratch drive was still running at handoff |
| 41624 | 109 | 6 | +3 | attended. **Autonomous: 2 of 109** — same page-2 allocation, same root, but the *derived* prescan set gives a 2-of-3 opening where the human's gave 3-of-3 |
| 41601 | 108 | **6** | **+0** | from scratch, **zero attended steps**, PDF-only (round ten) |

**Autonomous totals (the number the 90% is measured against): 6 of 108 on 41601
and 2 of 109 on 41624** — 5.6% and 1.8%, with the whole booklet in scope and no
human in the loop.

Round ten's five 41601 chains, all of which end at the same number:

| | r8 | r9 opening | r9 scope | r10 combined | r10 autonomous |
| --- | ---: | ---: | ---: | ---: | ---: |
| attended steps | 1 | 1 | 1 | 1 | **0** |
| opening | 3 of 7 | 6 of 7 | 3 of 7 | 6 of 7 | 6 of 7 |
| scope | 18p/83 | 18/83 | 22/92 | 22/92 | **23/103** |
| emitted | 77 | 75 | 86 | 85 | 78 |
| **structural** | 3 | 6 | 3 | 6 | **6 of 108** |
| driver contribution | +0 | +0 | +0 | +0 | **+0** |

Measured architecture ceilings (perfect selection over everything enumerable):
**79/90 and 31/109**. Verdict, on five independent lines: **90% is NOT reachable
under the image-scoring architecture.**

## The load-bearing findings (each has a tool that proves it — rerun, don't trust)

1. **The image objective's optimum is not the model.** Deterministic A/B: a
   strictly better optimum produced a strictly worse chain (54→51). Pooled over
   3 fixtures, **78.6% of reachable losses are already objective preferences**
   (`placement_objective_gap`). No traversal/retention/budget/move-set
   investment is rational.
2. **Openings decide everything, and are now selected reference-free.**
   `placement_construction_symmetry` ranks retained constructions by their own
   bilateral plane agreement — measured +3, +1, +0 on three constructions, equal
   to the oracle best on 41601. Every gain rounds 8–10 produced came from
   choosing a different body, none from driving better.
3. **A second view cannot break the tie** (round ten). Scoring the 36 retained
   bodies under a later page's *accepted registration* ranks them by whose
   camera that registration was propagated from: the two lineages disagree
   symmetrically (5–6× either way) and the 24-way within-class tie survives every
   view intact. `placement_multi_view_probe`. **Do not build multi-view
   aggregation on accepted registrations.**
4. **Ties are pervasive variance.** Half of all pages end in EXACT score ties
   between genuinely different assemblies. `--tie-break pose` plus a tie census
   are mandatory; any A/B without them measures coin flips.
5. **Loss population**: 68 enumeration / 20 retention / 8 screen / 4 ranking of
   100. Five rounds of scoring work targeted the 4%.
6. **A correct opening converts `unreachable` into `mis_selected`, not into
   `correct`** — so the candidate generator and the ranker are *both* inadequate
   and repairing one exposes the other.
7. **Colour**: LDraw 19/191 share OpenCV hue 20; `--chromatic-metric lab` is a
   correctness fix.
8. **Registration**: drawing-to-drawing propagation beats registering against
   the emitted body; the camera gate is necessary-not-sufficient.

## What round ten added (all measured before adoption)

* **Two association classes repaired generically.** Translucent artwork
  fragments under a single ink threshold (a trans-light-blue brick's crop was an
  8×9 stud) — repaired by grouping strong components a *weak* component joins and
  reporting the union of their STRONG boxes, so an already-single component is
  byte-identical. Anchor-to-component association is an assignment problem, not a
  per-anchor nearest lookup — an anchor is refused only when forbidding its match
  costs the page almost nothing. Measured over **25 PDFs / 1,104 anchors: 0
  broken**, 3 repaired, 12 boxes changed (3 byte-identical to the matcher, 1
  newly usable, 8 inspected and all the whole part replacing a fragment).
* **The page scope is derived** (`--auto-scope`), closing the pipeline's one
  attended step. On 40377 the derived allocation reproduces **all seventeen
  hand-worked pages identically** at part, colour and count and adds the eleven
  the hand-built opening had covered.
* **A CAD-size consistency gate** (`placement_slot_size_gate`) — the program's
  first working non-pixel channel. `crop diagonal / CAD bounding-box diagonal`
  must agree across one page; violating pairs leave the solver's candidate set
  and the assignment is re-solved to a fixed point. Fires 12 pairs on 41601 and
  **zero** on 41624 and 40377; restores 41601's opening page to the reference's
  own steps 1+2.
* **The PDF is the only input** (`placement_pdf_inventory`, `bind_pdf`).
* **On-ramp breadth**: six fixtures, median **95%** of the printed inventory in
  scope (mean 90%), mean 91% of the allocated multiset correct, mean 74% of
  allocated pieces on a reference-consistent page.

## Measured-and-rejected (do not re-litigate without new evidence)

Mirror completion (2/25, FP-prone) · inventory-capacity forcing AND likelihood
(0 deficits, 0 reorderings over 75 candidate bodies) · beam width/top-k raises
(0) · parent/pose budget raises alone (0) · compound/double exchange (−3) ·
saturation tie-break as default · assembly-level tie-breaking · raw-coverage
camera acceptance · **multi-view scoring under accepted registrations** (round
ten, circular) · **the slot solver's acceptance floor** (41601 prefers 0.50–0.70
by +1 accounted piece, 41624 prefers 0.30 by +3 — no fixture-independent value
helps both) · **crop area against inventory-icon area** (a printed BOM scales
each icon to its cell, so the ratio grows with part size).

## Where the program should go, in measured priority order

1. **A per-instance objective.** Today's score is a per-colour-class
   depth-composite IoU over the whole drawing plus a visible-edge term; it cannot
   say *this part in this pose explains this region*, which is why a wrong piece
   in the right place costs nothing and 24 different assemblies score identically.
   Replace it with local correspondence between a candidate's projected CAD
   silhouette/visible edges and the drawing's own strokes. **Validate on single
   pages before driving any chain.**
2. **Drawing-driven candidate generation.** 68% of losses are poses the bank
   never contained, and the bank is generated model-side by connector closure.
   The difference between two consecutive registered drawings localises exactly
   where new ink appeared. This is *not* the refuted multi-view idea: the later
   page says **where to look**, not how to **rank**.
3. The identity residue (6.8% solver compromises, 3.2% unassigned) — the frozen
   encoder cannot separate small parts of the same shape; the CAD-size gate
   cannot reach that class because those parts share a bounding box.
4. Breadth fixtures beyond the six BrickHeadz — deprioritised until 1 and 2 exist.

**Size, honestly:** each of 1 and 2 is a subsystem, not a parameter. On ten
rounds of evidence in which every costed lever returned +0 to +3 correct poses,
this is a **multi-month programme**. Anyone promising 90% from PDF alone by
tuning the current architecture is contradicted by five measurements.

**What is shippable now:** the on-ramp. From a PDF alone it emits a page-scoped,
identity-checked bill of materials — which piece, which colour, how many, on
which step page — at a median 95% of the printed inventory with every refusal
named and none guessed. That is a per-step parts list, and it does not depend on
the placement problem being solved.

## Operational notes
- GPU: local 16GB, shared with a llama-server holding ~11.6GB; one drive at a
  time. A 20–25 page BrickHeadz drive is 1.5–2 hours.
- **Run the pdf-recon tests from the REPO ROOT** (`python -m pytest
  scripts/pdf-recon -q`, 485 passing) — several read `output/` relative to the
  cwd and fail spuriously from inside the package directory.
- **`placement_autodrive` needs `--continue-on-unsupported`** or the first
  camera-refused page ends the chain; every round 7–10 run used it.
- Fixture PDFs in `C:/git/clego/lego_sets/PDF/`: 40377=6314914, 41601=6220569,
  41624=6248865, 41604=6234341, 41606=6234346, 41625=6248867. Only
  Cheenzo-authored OMR files carry `0 STEP`; those six are the whole usable
  BrickHeadz set.
- Shared checkout: other agents work in `web/` and clego concurrently — `git
  diff HEAD` before commits, path-limited commits, never `rm -rf` an output dir
  a live process may own.
- Every trial: snapshot sources + start/end hashes; report structural vs alias
  vs strict separately; image metrics are never placement accuracy; a chain row
  without its tie census is not evidence; register the prediction before the
  drive.
- The older extraction-layer work (era-4/5 deterministic PLI readers,
  `recon_extract/` in clego) is a SEPARATE arc; RECON_EXTRACT_SPEC.md is its
  ledger. The clego recon_v7/v8 VLM pipeline is a third, resting arc. Don't
  conflate their numbers.
