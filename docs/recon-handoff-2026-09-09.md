# PDF-reconstruction program — handoff (2026-09-09)

Audience: the next agent taking over the recon pipeline with a mandate to
solve/fix/improve/rearchitect. This distills nine measured rounds (2026-09-08/09,
`scripts/pdf-recon/` + `docs/pdf-placement-rearchitecture-2026-09-07.md`, which
remains the detailed ledger — read it after this). Round 9 (opening backtracking
+ BOM-capacity likelihood) may still be running when you start: absorb its
report from the ledger before changing anything it touches.

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

## The honest scoreboard
| fixture | truth | best structural | driver's own contribution |
|---|---:|---:|---:|
| 40377 (hand-built p1-15 opening) | 90 | **54** | **+9** (45 inherited) |
| 41624 (from scratch) | 109 | 6 | +3 |
| 41601 (from scratch, round-8 breadth control) | 108 | 3 | **+0** |

Measured architecture ceilings (perfect selection over everything enumerable):
79/90 and 31/109. **Verdict (round 8, three independent lines): 90% is NOT
reachable under the image-scoring architecture.**

## The load-bearing findings (each has a tool that proves it — rerun, don't trust)
1. **The image objective's optimum is not the model.** Deterministic A/B:
   a strictly better optimum produced a strictly worse chain (54→51). Pooled
   over 3 fixtures: **78.6% of reachable losses are already objective
   preferences** (`placement_objective_gap`). No traversal/retention/budget/
   move-set investment is rational. The open image-side question is the
   objective's FORMULATION (per-class depth-composite IoU is blind to a wrong
   piece standing in the right place), not its optimisation.
2. **Openings dominate.** One wrong opening converts most of a model into
   unreachable-by-construction (closure enumerates around the body it has).
   The driver never revisits a committed page → round 9's backtracking.
3. **Ties are pervasive variance.** Half of all pages end in EXACT score ties
   between genuinely different assemblies (up to 12-way); a tie flip rerouted
   a whole chain's camera path. Deterministic tie-break (`--tie-break pose`) +
   tie census (`placement_score_ties`, wired into chain rows) are mandatory;
   any A/B without them measures coin flips. Rounds 2-6's chain deltas carry
   this exposure retroactively.
4. **Loss population** (`placement_population_table` + `placement_retention_audit`,
   reconciled): 68 enumeration / 20 retention / 8 screen / **4 ranking** of 100.
   Five rounds of scoring work targeted the 4%. Enumeration "unreachable" on
   from-scratch fixtures is mostly the opening cascade (finding 2).
5. **Colour classification**: LDraw 19/191 share OpenCV hue 20 (three palette
   orders gave three verdicts on the same pixels). `--chromatic-metric lab`
   is a correctness fix; 41624 has four colours within 9 hue degrees.
6. **Closures now complete** (`placement_fast_collision`, 18.4× bit-exact) —
   and completing them buys nothing (third confirmation). Budgets were always
   screen-cost parameters; adaptive budget flags exist.
7. **Registration**: drawing-to-drawing propagation (`M' = s·M`) beats
   registering against the emitted body (which accumulates its own errors);
   the camera gate (`placement_camera_gate`, unexplained-ink + scale_window)
   is necessary-not-sufficient. Exploded pages must be scored against what
   they DRAW (`placement_exploded_page/attach` — completeness was being
   penalised before).

## Measured-and-rejected (do not re-litigate without new evidence)
Mirror completion (2/25, FP-prone) · inventory-capacity FORCING (fires 0; the
likelihood variant is round 9's live experiment — different thing) · beam
width/top-k raises (0) · parent/pose budget raises alone (0) · compound/double
exchange (-3 on the deterministic chain; off by default) · saturation tie-break
as default (subsumed by Lab) · assembly-level tie-breaking (worth 0 coverage) ·
raw-coverage camera acceptance (body-size dependent).

## The architecture map (all in scripts/pdf-recon/)
On-ramp: `pdf` → identity/allocation (`global_pdf_slot_assignment`,
`placement_catalog_factor_bridge`, icon matching; moulds as branches) →
per-page camera (`placement_page_camera`, prescan; gate) → construction
(`placement_construct_body`, generic bootstrap) → per-page drive
(`placement_autodrive`: closure/enumeration → occupancy screen → layer beam
`placement_layer_beam` → native GPU scoring w/ edges+materials →
`native_exchange`) → cross-page attachment + multi-body table. Journals are
atomic, source-snapshotted, hash-verified `--resume` (the resume guard's
tuple-vs-list bug is fixed — round 6).
Known on-ramp gaps: page-drop decisions are the one attended step (cost: 25/108
pieces on 41601); mould-variant pairs with LDU-identical CAD need the
equivalence-class treatment (filed; round 9 may have built it).

## Round 9 landed — read these five results before planning anything

Detail and every table: the ledger's "Round nine" section. In brief:

1. **Backtracking is built and works, and the drive still contributes +0.**
   `placement_backtrack.py` reopens a committed site, takes one representative
   per exact objective-score class and re-drives. On 40377 the
   `registration_collapse` trigger fired on round eight's known regression,
   reopened page 19 and recovered **51 → 53/90**. On 41601, driving from a
   **6-of-7** opening (against the selected 3-of-7) lands **6/108** and adds
   nothing across sixteen pages; 41624 from a +1 opening gains 13 emitted pieces
   and 5 placed pages and **zero** correct poses. Driver-own contribution: +0,
   +0, +2, +3-over-nine-pages.
2. **Retained sets, measured (`placement_alternatives_oracle.py`): 15 of 17
   pages on 41601 and 30 of 31 on 41624 retain NOTHING better than what was
   selected.** Any rescoring lever's ceiling on the driven pages is +2 and +1.
   The openings are the exception and are where all correct poses came from.
3. **A construction's own symmetry selects the right opening, with no
   reference**: round six's `placement_construction_symmetry` separates 41601's
   two opening classes completely (plane agreement 1.000 at 5/5 eligible parts
   against 0.600 at 3/5) and picks the 6-of-7 body — the oracle best. Three
   constructions measured: +1, +0 (abstains on one eligible part), +3.
4. **Inventory capacity is refuted as a ranker — do not rebuild it.** Count
   capacity is vacuous where the page quota is exact (34 of 46 keys fully
   allocated, every page placed its whole allocation); the draw-down audit finds
   0 deficits; the look-ahead is *identical* on all 75 candidate bodies measured
   and its one varying term ranks the wrong class higher.
5. **Mould variants are one capacity pool, not one search candidate**
   (`placement_mould_equivalence.py`): `15573`/`3794a`/`3794b` and
   `4032a`/`4032b` have exactly equal universal bounds (0.0 LDU) and differing
   voxels, cores and connectors. `placement_slot_adapter --mould-policy withhold`
   admits their pages: 41601's scope goes **83 pieces on 19 pages → 92 on 23**,
   and driving it emits **86 against 77** with 3 correct, unchanged.

**The open problem round 9 created:** every runtime-legal branch-selection rule
shipped picks the *worse* branch when a better one exists (3 over 6; 51 over 53).
`--selection contradictions` would have picked right on both and is fitted to
those two observations — test it on a fixture it was not derived from.

## Where the program should go (round-8 memo, priority-ordered, partly in flight)
1. Opening + page-level backtracking (round 9, in flight — read its result).
2. Non-pixel evidence: BOM-capacity likelihood (round 9), then connector-graph
   likelihood as a cheap rescoring experiment (a partially-built form measured
   non-discriminating — lead, not plan), then cross-page/multi-view consistency
   (13/17 pages on 41601 end in within-view ties no single view resolves).
3. The objective's formulation (wrong-piece-in-right-place blindness).
4. The on-ramp (it already costs more than the search delivers end-to-end).
5. Breadth fixtures 4-5: deprioritised — three fixtures answered profile
   consistency twice over.

## Operational notes
- GPU: local 16GB, free unless a drive is running; one drive at a time.
- Fixture PDFs: `C:/git/clego/lego_sets/PDF/` (40377=6314914.pdf); screened
  truth sets: `recon_v7_work/screened.json`. Only Cheenzo-authored OMR files
  carry `0 STEP` (10 of 22 BrickHeadz OMRs are stepless Darats files).
- Shared checkout: other agents work in `web/` and clego concurrently —
  `git diff HEAD` before commits, path-limited commits (`git commit -- paths`),
  never `rm -rf` an output dir a live process may own (use fresh names).
- Every trial: snapshot sources + start/end hashes; report structural vs
  alias vs strict separately; image metrics are never placement accuracy;
  a chain row without its tie census is not evidence.
- The older extraction-layer work (era-4/5 deterministic PLI readers,
  `recon_extract/` in clego, hybrid Q1 at VLM parity) is a SEPARATE arc from
  this placement program; RECON_EXTRACT_SPEC.md is its ledger. The clego
  recon_v7/v8 VLM pipeline (RECON_ARC_VERDICT.md) is a third, resting arc.
  Don't conflate their numbers.
