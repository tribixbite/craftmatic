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

**Follow-ups (tracked under #4/#5):** a `floating_artifacts` corruption has no
deterministic gate yet (needs connected-component analysis on the grid); a
`scripts/verify-corrupt.ts` CLI demo (Tekton's literal `demo:corrupt`) over a
saved golden artifact would make the refusal visible in a live run.

## 2. Carry provenance/confidence into the report (+ a confidence view)

**Problem.** `verify/report.ts` `composeReport()` writes geometry metrics (IoU,
h_err, watertight, voxels) to `pipeline-state.json` but **drops** the per-field
source/confidence fusion just computed. Tekton surfaces provenance (a toggle that
colours the build by evidence class; a pixel check that all four classes render).

**Why it matters.** Makes VLM scores **explainable** and separates "source-data
plateau" from "pipeline regression" — the single most-repeated frustration in
project history. A low colour score on a building whose wall is `inferred/0.2`
is a data gap, not a bug, and the iterate loop should stop chasing it.

- [ ] Add a `provenance` block to `FullVerificationReport` (per-field
      `{value, source, confidence}` for height, footprint, wall, roof).
- [ ] Thread `JointEvidence` from fusion through Stage 9 into `composeReport`.
- [ ] `summariseReport()` prints the lowest-confidence field.
- [ ] (stretch) a "confidence view" render colouring the build by evidence class.

## 3. Independent cross-check gates (measured-reality guard)

**Problem.** `heightErr` compares the generated mesh's Y-span against the *fused*
expected height — both flow from the same fusion. So the gate mostly catches
**synthesis** bugs, not **data-fidelity** errors: if fusion accepted a
truncated-tiles height, generation builds to it and the gate passes while reality
is wrong. Tekton's verifier checks against an *independent* corpus and explicitly
fails if a value was normalised toward an ideal (its V09).

- [ ] When tiles drove the height, cross-check against OSM `building:levels`×3.5
      and Solar; emit a first-class `heightDisagreement` signal (fusion already
      computes this delta to lower confidence — promote it into the report).
- [ ] Generalise: any field resolved from one source gets a soft-fail when an
      independent source disagrees beyond a threshold.

## 4. Promote the deterministic checklist to a production regression signal

**Problem.** `src/grade/defect-score.ts` (8 booleans) is deterministic but
**test-harness only**; production scoring is `gemini-2.5-pro` — the documented
source of noise (leading-question inflation, plateaus). Several booleans are
already computable from metrics the pipeline produces.

- [ ] `height_truncated` ← `heightErr` + the #3 cross-check.
- [ ] `footprint_wrong_shape` / `neighbor_merged` / `false_positives_merged` ←
      low footprint IoU.
- [ ] `floating_artifacts` ← connected-component pass on the grid (new; also
      unblocks the #1 floating-artifact corruption).
- [ ] Gate and *rank* the iterate loop on objective metrics + the deterministic
      score; reserve the VLM for genuinely perceptual categories (colour harmony,
      "reads as the building") as a final tie-break, not the optimization target.

## 5. Preserve failed reports as an immutable history

**Problem.** `composeReport` writes per-slug to `pipeline-state.json` — each run
**overwrites**; there is no history. Tekton keeps timestamped
`verifier-report.*.failed.json`.

- [ ] On a failing run, append to `output/failed/<slug>-<iso>.json`.
- [ ] Lets the iterate loop tell *oscillating* (noise) from *monotonically
      regressing* (real), and gives it memory across runs.

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
