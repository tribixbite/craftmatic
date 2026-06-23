# Verification Hardening Roadmap (Tekton-derived)

Status: **in progress** — opened 2026-06-21.

## Origin

A session review compared [`../Tekton`](https://github.com/) — an evidence-gated
procedural reconstruction engine (Nanchan Temple / Notre-Dame spire) — to
craftmatic's photogrammetry→voxel pipeline.

Key finding: craftmatic's `src/pipeline/` **already owns Tekton's two headline
ideas**, arrived at independently:

- a **deterministic verifier that re-measures geometry** — `src/pipeline/verify/objective.ts`
  `runObjectiveGates()` (footprint-IoU-vs-OSM, height-error, watertight,
  edge-manifold, self-intersection, min-wall-thickness, voxel-occupancy) that
  **blocks VLM consensus on failure** (Stage 9 in `pipeline.ts`); and
- **per-field provenance** — `src/pipeline/fusion/reconcile.ts`
  `Evidence<T> = {value, source, confidence}` with explicit priority chains.

So the useful borrows are **five narrower refinements** that close the loop on
what the pipeline already computes, plus one philosophical audit. They are listed
in priority order (value ÷ effort).

The connective insight: craftmatic already holds the ground-truth inputs Tekton's
verifier needs (OSM footprint polygons, Mapbox/Solar heights, fused evidence) but
currently feeds them only into **generation**, not **verification**. Each item
below turns existing inputs into a deterministic signal.

---

## 1. End-to-end gate self-test on real geometry — **DONE (2026-06-21)**

**Problem.** `objective.test.ts` only exercises the gates against *toy* meshes (a
tetrahedron, an open shell). That proves the gate *functions*; it does not prove
a gate *catches a realistic regression in a building's output*. Tekton corrupts
the actual shipped spec (nudges the roof toward the rulebook ideal), runs the
full verifier, asserts it refuses (exit 1), then restores and asserts green —
its `demo:corrupt` / `demo:restore` proof that the gate has teeth.

**Done.**
- [x] `src/pipeline/verify/corruption.ts` — pure corruption toolkit mapping each
      real-world failure mode to the gate that must catch it:
      `crushHeight` (height_truncated → height gate), `shiftFootprint` &
      `mergeNeighbour` (mis-registration / neighbor_buildings_merged → IoU gate),
      `punctureMesh` (facade_holes_visible → watertight gate).
- [x] `src/pipeline/verify/corruption.test.ts` — synthesizes **real pipeline
      geometry** (`synthesizeParametric` → `evaluateBRep`), asserts the clean
      building passes every objective gate, then asserts each corruption trips
      its specific gate and flips `pass=false`, and that re-running clean inputs
      passes again (the "restore" beat).

**Follow-ups:** `floating_artifacts` now has a deterministic signal —
`analyseGridConnectivity()` in #4's `verify/defect.ts` (advisory, in
`defectScore`, not a hard gate). A `scripts/verify-corrupt.ts` CLI demo
(Tekton's literal `demo:corrupt`) over a saved golden artifact would still make
the refusal visible in a live run — tracked, not started.

## 2. Carry provenance/confidence into the report (+ a confidence view) — **DONE (2026-06-22)**

**Problem.** `verify/report.ts` `composeReport()` writes geometry metrics (IoU,
h_err, watertight, voxels) to `pipeline-state.json` but **dropped** the per-field
source/confidence fusion just computed. Tekton surfaces provenance (a toggle that
colours the build by evidence class; a pixel check that all four classes render).

**Why it matters.** Makes VLM scores **explainable** and separates "source-data
plateau" from "pipeline regression" — the single most-repeated frustration in
project history. A low colour score on a building whose wall is `inferred/0.2`
is a data gap, not a bug, and the iterate loop should stop chasing it.

**Done.**
- [x] `src/pipeline/verify/provenance.ts` — `summariseProvenance(JointEvidence)`
      → `ProvenanceSummary { fields[], weakest, meanConfidence }`; per-field
      `{field, value, source, confidence}` for footprint, height, levels, wall,
      roof, roofShape.
- [x] `FullVerificationReport.provenance` added; `composeReport()` takes optional
      `evidence` and fills it in every status branch (null when absent).
- [x] Threaded `JointEvidence` into `composeReport` at both call sites
      (`pipeline.ts`, `browser-entry.ts`) — both already had `evidence` in scope.
- [x] `summariseReport()` prints `prov_weak=<field>/<source>/<conf>` + `prov_mean`.
- [x] Persisted to `pipeline-state.json` via `scripts/build.ts`
      (`PipelineStateRecord.provenance`).
- [x] Tests: `report.test.ts` (+6 provenance cases), `pipeline.test.ts`
      end-to-end assertion.

**Deferred (stretch):** a "confidence view" render colouring the build by
evidence class (Tekton's provenance toggle + its 4-colour pixel check). Needs the
Three/PNG render layer — tracked here, not yet started.

## 3. Independent cross-check gates (measured-reality guard) — **DONE (2026-06-22)**

**Problem.** `heightErr` compares the generated mesh's Y-span against the *fused*
expected height — both flow from the same fusion. So the gate mostly catches
**synthesis** bugs, not **data-fidelity** errors: if fusion accepted a
truncated-tiles height, generation builds to it and the gate passes while reality
is wrong. Tekton's verifier checks against an *independent* corpus and explicitly
fails if a value was normalised toward an ideal (its V09).

**Done.**
- [x] `src/pipeline/verify/cross-check.ts` — `crossCheckHeight(ctx, evidence)`
      re-derives height estimates from sources that did NOT drive the chosen
      value (OSM `building:levels`×3.5, Solar `estimatedHeightM`, Smarty
      `storiesNumber`×3.5), and emits `CrossCheckResult { alternatives,
      maxDisagreement, truncationSuspected, ok, warnings }`. `truncationSuspected`
      = an independent survey ≥25% taller than the build (the Google-3D-Tiles
      LOD-truncation signature).
- [x] `FullVerificationReport.crossCheck`; `composeReport()` takes optional `ctx`
      and runs the check when both `ctx` + `evidence` are present.
- [x] Threaded `ctx: refined` into both call sites (`pipeline.ts`,
      `browser-entry.ts`); persisted to `pipeline-state.json` (`build.ts`).
- [x] `summariseReport()` prints `xcheck=truncated|disagree` + `xcheck_max=NN%`.
- [x] Tests: `cross-check.test.ts` (6 cases), `report.test.ts` (+3),
      `pipeline.test.ts` end-to-end assertion.

**Advisory by design:** it does NOT flip `objective.pass` — OSM/Solar are
themselves estimates, so a hard block would false-fail legitimate builds. The
signal lets the iterate loop / a human act on a truncation the gates alone miss.

**Deferred:** generalising the cross-check to non-height fields (e.g. footprint
area vs OSM `way` area) — tracked, not started.

## 4. Promote the deterministic checklist to a production regression signal — **DONE (2026-06-23)**

**Problem.** `src/grade/defect-score.ts` (8 booleans) is deterministic but
**test-harness only**; production scoring is `gemini-2.5-pro` — the documented
source of noise (leading-question inflation, plateaus). Several booleans are
already computable from metrics the pipeline produces.

**Done.**
- [x] `src/pipeline/verify/defect.ts` — `deriveDefects(objective, crossCheck,
      grid)` derives the *provable* checklist deterministically and rolls it into
      a stable 0-10 `DefectScoreResult { defects, score, penalties, grid }`:
      - `height_truncated` ← `crossCheck.truncationSuspected || heightErr > 0.10`
      - `facade_holes_visible` ← `!watertight`
      - `floating_artifacts` ← `analyseGridConnectivity()` (6-connected component
        pass; >2% of voxels off the main body) — **new; closes the #1
        floating-artifact gap**
      - `footprint_wrong_shape` ← `footprintIoU < 0.85`
      - `surface_detail_visible` ← distinct block types ≥ 3 (monochrome guard)
      - `proportions_correct` ← `heightErr ≤ 0.10 && footprintIoU ≥ 0.85`
- [x] `FullVerificationReport.defectScore`; `composeReport()` takes optional
      `grid`; `summariseReport()` prints `defect_score=N.N defects=[…]`; persisted
      to `pipeline-state.json` (`build.ts`).
- [x] Tests: `defect.test.ts` (9 — connectivity + every defect mapping),
      `report.test.ts` (+2), `pipeline.test.ts` end-to-end.

**Scope note (honest).** The two attribution-only defects — `neighbor_merged`,
`false_positives_merged` — are deliberately **excluded** from the deterministic
derivation: IoU can prove the footprint is wrong but not *why* (wrong shape vs
merged neighbour vs false positive), which needs visual judgement. They remain
the VLM's job.

**Deferred (the consumption side):** making the iterate loop actually *rank* on
`defectScore` (+ objective metrics) and demoting the VLM to a final tie-break —
that's a change to `scripts/iterate.ts`'s selection logic, tracked but not yet
done. The signal it needs is now in the report.

## 5. Preserve failed reports as an immutable history — **DONE (2026-06-24)**

**Problem.** `composeReport` writes per-slug to `pipeline-state.json` — each run
**overwrites**; there is no history. Tekton keeps timestamped
`verifier-report.*.failed.json`.

**Done.**
- [x] `scripts/failed-history.ts` — `preserveFailedReport(failedDir, slug,
      report)` appends every non-pass report to
      `output/failed/<slug>-<iso>.json` (colons/dots stripped for a safe
      filename), then `pruneFailedHistory()` keeps the most recent
      `MAX_FAILED_PER_SLUG` (25) per slug. The year-digit guard prevents a slug
      that is a prefix of another (`geisel` vs `geisel-east`) from pruning across
      slugs.
- [x] Wired into `scripts/build.ts` after `mergeStateRecord`; logs the archive
      path. `output/` is gitignored, so the archive is local-only (no churn).
- [x] Test: `test/failed-history.test.ts` (4 — pass=no-op, safe filename, prune
      cap, prefix-collision).

**Why it's in `scripts/` not `src/pipeline/`:** the archiver uses `node:fs`; the
pure-core `src/pipeline/` must stay browser-importable. `build.ts` already lives
in `scripts/` and is the persistence layer.

**Deferred (consumption):** having the iterate loop actually *read* the history
to distinguish oscillating from regressing builds — that's `scripts/iterate.ts`
logic, same bucket as #4's loop-ranking. The history it needs now exists.

---

## Audit flag (decision required, not a directive)

Tekton's hardest rule: "measured reality wins — never normalise toward an
aesthetic/textual ideal; record deviations as data," enforced by a gate that
*fails the build* if violated. craftmatic's colour "gray guard" (skip OSM
recolour when it resolves to grey), desaturation multipliers, and `MIN_BRIGHT`
floors do the opposite — they override a building's measured colour toward "more
varied / scores better." Legitimate for a Minecraft-build product, but it may be
a hidden cause of colour-score plateaus (optimizing for VLM-pleasing variety, not
fidelity). The #2 provenance manifest would make these overrides visible so they
can be judged case-by-case.

- [ ] Once #2 lands, audit: when OSM/SV give a high-confidence measured colour,
      does the pipeline honour it or override it? Quantify how often.
