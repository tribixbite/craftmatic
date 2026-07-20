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

**Consumption side: DONE — see §6.**

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

**Consumption side: DONE — see §6.**

---

## 6. Rank the iterate loop on deterministic signals (consumption of #4+#5) — **DONE (2026-06-24)**

**Problem.** `scripts/iterate.ts` `pickWorst` ordered the rebuild queue by the
status enum + attempt count only — blind to the deterministic `defectScore` and
the failed-history trend that now exist. So it couldn't tell a real regression
from tile-capture noise, and the VLM consensus implicitly drove priority.

**Done.**
- [x] `scripts/iterate-ranking.ts` (pure, unit-tested):
  - `classifyTrend(scores)` → `regressing | improving | new | plateau |
    oscillating` over the most recent 6 defectScores (≥2 direction changes past a
    0.3 jitter band ⇒ oscillating).
  - `readFailedScores(failedDir, slug)` reads the #5 archive chronologically
    (same year-digit prefix guard).
  - `compareRemediation` / `rankCandidates`: status band → trend (fix
    regressions first; push noisy oscillators last) → **deterministic defectScore
    (worse first)** → fewer attempts → **VLM consensus median as the LAST-resort
    tie-break** (the demotion).
- [x] `scripts/iterate.ts` rewired: `pickWorst` uses `rankCandidates`; `--status`
      prints a "Remediation queue (worst first)" with per-slug `trend` + `defect`,
      and the failure detail shows `defect=` / `trunc`.
- [x] Tests: `test/iterate-ranking.test.ts` (15); smoke-ran `iterate.ts --status`
      against live state (graceful on older records lacking `defectScore`).

**Policy notes (tunable, documented in the module):** trend try-first order is
`regressing > improving > new > plateau > oscillating` — runs help an improving
or regressing build but won't converge an oscillator or move a plateau (those
need a code change). Terminal statuses (`needs-human-review`,
`context-insufficient`) are still excluded from the queue.

**Still deferred:** the loop does not yet *auto-skip* a confirmed oscillator/
plateau after N rounds — it only deprioritises them in the ordering. A hard
"stop trying X" gate would need a confidence threshold on the trend.

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

## Visual QA findings — 2026-07-18 full-golden render sweep

All 5 goldens rebuilt live (`scripts/build.ts`) and rendered through the exact
VLM-scoring surface (`createGridRenderRound`: iso / front / td / cutaway).
Geometry gates pass near-perfectly on 4/5 (IoU 0.98–1.00, h_err 0%), yet 4/5
are visually unshippable — `defect_score=10.0` on three catastrophically bad
builds. Ranked findings, each with the concrete mechanism:

**P0-1 · Invalid block id `minecraft:deepslate_tile`** (real id is
`deepslate_tiles`). #1 block in flatiron (22.9%), guggenheim (36.7%). Renders
as hash-fallback purple in png-renderer (`colors.ts` hash path) and would be
missing-texture magenta in-game. Sources: `color-blocks.ts:197` cluster base;
`parametric.ts:98` / `cleaned-tiles.ts:71` whitelist the singular form;
`address-pipeline.ts:771`. Related: `smooth_stone_slab[type=double]` (valid
block) has no atlas entry → textureless flat fill. Fix: rename + add a
deterministic palette-validity gate (every emitted state ∈ block registry)
to the objective gates.

**P0-2 · Recolor bakes shadows/noise into materials.** Dark facade texels →
dark clusters (black splotch noise on geisel/pennzoil facades); flatiron glass
= 0.1% (windows nonexistent); pennzoil's black-glass towers = 50% tuff +
24.9% cobblestone. Every build carries 10–25% cobblestone. Fix direction:
luminance-normalise before Lab cluster match, per-face median vote instead of
per-voxel dither, archetype priors (commercial curtain-wall → glass family).

**P0-3 · Sliced-band masking failures** (`sliced-tiles.ts` masking block):
(a) cantilever exception (1.5–3× OSM area, centroid inside) has **no height
gate** → ground bands merged with streets/neighbours are kept verbatim →
plaza/street shards around every base; today's guggenheim absorbed neighbour
mass → **IoU 0.57 fail-objective** (June same-code run: 0.99 — Google tile
nondeterminism flips it). Fix: cantilever keep-as-is only above ~25% of
building height; always OSM-anchor at ground.
(b) adjacent bands alternate `ring = osmLocal` vs raw inside-ring as
photogrammetry jitters around the OSM edge → false-setback "layer-cake"
belts on flatiron (continuous real facade). Fix: majority/hysteresis
anchoring across uniform band runs; snap rings within ±15% of OSM area to OSM.
(c) routing: usable tiles → 7d beats spec'd curved→7b, so the
helical-frustum synthesizer (6e4b372, built for Guggenheim) is dead code
whenever tiles are usable; 7b scored 0.99 vs 7d's 0.57. Fix options: route
curved+polygon → 7b, or objective-gate fallback (7d fails IoU → re-synthesize
7b in-process).

**P1-4 · defect_score blind spots.** Scored 10.0 on flatiron/pennzoil/geisel.
Add deterministic penalties: invalid-block ratio > 0.5%; dominant exterior
facade block share < 25% (measured: bad=18%, good=31–36%); glass≈0 on
commercial archetypes; band-anchor oscillation count from synthesis meta.

**P1-5 · Renderer distortions that corrupt VLM scoring:** glass renders as
white lattice over black holes (alpha not composited) so correctly-glassed
builds would be penalised; atlas load timeout under I/O load silently falls
back to procedural textures (nondeterministic VLM input); block-face blit
gaps (black triangles) at tile≥16; hash-colour fallback hides invalid ids —
should fail loudly.

**P2-6 · Report/provenance gaps:** synthesis path (7a–7d) not persisted in
the verification report (goldens dashboard hardcodes stale paths); hollow
parametric cutaway view is a bare wall ring (wasted VLM view); parametric
window rows overshoot (5 rows on a 2-storey home).

**P2-7 · Committed goldens stale** (`web/public/goldens/` Apr-19, pre-7d
routing) — the visual baseline misrepresents the current pipeline.

Validated: 240-highland via 7a-parametric (router fix) is visually coherent —
correct hip roof, wall/roof palette, window grid; and the objective gates +
failed-history correctly caught & archived today's guggenheim regression
(defect_score 9.4, `footprint_wrong_shape`, immutable failed report).

### Fix status — 2026-07-19

- [x] **P0-1** `deepslate_tile` → shared `roofBaseToFullBlock()` (emitter was
      `sliced-tiles.ts pickRoofBlock`, an incomplete private copy of the
      suffix map) + **objective gate 8: palette validity** via browser-safe
      `blocks/known-blocks.ts` (texture-name ∪ colour-map registry;
      `COMMON_TEXTURES` moved to pure `render/texture-names.ts` leaf).
      Proven live: rebuilt flatiron palette holds `deepslate_tiles`, gate
      silent. (b59e0f3)
- [x] **P0-3a** cantilever height gate: band y0 ≥ max(8m, 25% of Y range);
      regression pair proves the branch decides on Y alone. Live: flatiron
      bad-tile-draw IoU 0.45 → **0.98**. (53541cf)
- [x] **P0-3c** curved+polygon routes 7b ahead of usable tiles. Live:
      guggenheim IoU 0.57 → **0.99**, defect 10.0. (53541cf)
- [x] **P1-4 (facade)** `facade_incoherent` (−1) when no block reaches 25%
      of side-exposed facade; rides the existing connectivity walk.
      Calibrated: bad sliced flatiron 18%, highland 59%. (94057ef)
- [x] **P1-5 (atlas)** self-healing atlas load — timeout no longer pins
      procedural textures for process life; warning states the VLM-score
      consequence. (e37c610)

- [x] **P0-3b (revised)** the layer-cake's dominant mechanism was NOT
      anchor oscillation but **vertical voids**: photogrammetry drops whole
      slices at reflective floor bands, and the surviving bands don't abut
      (fresh flatiron carried three voids, one 6m tall — confirmed by a
      per-layer occupancy profile). Two fixes: near-OSM inside rings snap to
      OSM below 0.85× area (6d906c5) and true Y-gaps are bridged by the
      band(s) ending at them via interval merge (dc47a34). Live: flatiron
      **defect 10.0, zero penalties** (floating_artifacts + facade_incoherent
      both cleared), one continuous shaft in the render.
- [x] **P2-6** synthesis path persisted: composeReport takes synthesisPath,
      report + pipeline-state records carry it, summariseReport prints
      `path=…`. (1b37620)

Remaining from the findings: P0-2 recolor shadow-baking (luminance
normalisation + per-face median + archetype priors — the residual facade
noise on shaded sides), P1-4 glass-on-commercial signal, P1-5 glass alpha
compositing + face-blit gaps, P2-7 golden refresh.

## Random-address generalization sweep — 2026-07-20

Four untuned addresses (Brooklyn rowhouse, Berwyn IL house, Ann Arbor
main-street, Durham NC commercial). One hard gate failure + three new
architecture gaps the goldens never exercised:

- [x] **Roof taper scaled about the origin** (all 5 pitched types +
      shed). Off-centre footprint → roof swings sideways off the walls.
      Invisible on goldens (pin ≈ centroid); berwyn produced a ~50m wedge
      beside an 8×12m building → IoU 0.35 fail. Centred on the
      area-weighted footprint centroid; regression test on a 30m-offset
      gable. Live: berwyn IoU 0.35 → **1.00**, grid 339 → 73 long. (committed
      with this doc)
- [ ] **P0-A · Building-selection plausibility.** The geocode for
      "1123 Maple Ave, Berwyn" is RANGE_INTERPOLATED (street-interpolated
      pin); the ~50m nearest-OSM-building search returned a park TOILET
      BLOCK (`amenity=toilets`, 8×12m, 53m away) and the pipeline built it
      as the house. Needed: reject/deprioritise candidate ways tagged
      amenity=toilets/garage/shed/parking; weight by distance AND
      addr:housenumber match; flag RANGE_INTERPOLATED/GEOMETRIC_CENTER pins
      as low-confidence context (Evidence provenance already models this —
      polygonSource confidence should drop, and the report should surface
      it); cross-check footprint area vs Smarty/Parcl sqft (the `smarty`
      fetcher in build.ts is still a `null` stub).
- [ ] **P0-B · Satellite roof palette samples the surroundings.** Berwyn
      roof = lab(51,-18,15) @ sat/0.85 — lawn green, rendered as a green
      roof. Roof sampling must be masked to the building polygon (project
      OSM footprint into the satellite crop), not a pin-centred patch, and
      green-vegetation Lab should cap confidence.
- [ ] **P0-C · SV wall palette on shaded facades.** Carroll rowhouse walls
      are near-black (shaded street pano) → featureless dark tombstone at
      defect 10.0. Wall-luminance plausibility floor (L* < ~25 with
      residential archType ⇒ distrust / lift), same family as P0-2.
- [ ] **P1-D · defect blindness to implausible darkness/monochrome-dark**:
      carroll passes facade coherence (dominant share high) AND type-count
      while being visually unreadable. Add mean-facade-L* signal.
- [ ] **P2-E · Resolved context not persisted** — the chosen OSM way id /
      polygon / locationType aren't written with artifacts, so wrong-building
      forensics required a live re-query. Persist ctx summary
      (way id, polygon source+area, locationType) into the verification
      report.

Positive: annarbor-midrise is a credible main-street massing (windows only
on the front facade — parametric windows still single-facade); durham
(7d) shows the known P0-2 recolor noise but correct block massing;
carroll geometry (rowhouse proportions) is right.

### Fix status — 2026-07-20 ("proceed until all addressed")

- [x] **P0-A** scored building selection (aux-structure penalty 60m,
      addr:housenumber match −80m, containing-principal fast path) in BOTH
      osm clients; footprint confidence degrades on interpolated pins
      (ROOFTOP 1.0 / RANGE_INTERPOLATED 0.85 / GEOMETRIC_CENTER 0.7).
      Live: berwyn now resolves way/512361782 (the house), not the toilet. (4c6fcb6)
- [x] **P2-E** report.resolution {osmId, polygonSource, geocodeLocationType,
      footprintAreaSqm} persisted to state. (4c6fcb6)
- [x] **P0-B** satellite roof sampling masked to the footprint polygon
      (web-mercator projection, ≥200px) + vegetation guard for unmasked
      greens (0.85→0.35). Live: berwyn lawn-roof confidence 0.35. (fc4c427)
- [x] **P0-C** near-black SV walls on residential distrusted (0.9→0.4);
      commercial exempt (Pennzoil real black glass). (7cef182)
- [x] **P1-D** facade_implausibly_dark (−1), archetype-gated: calibrated
      shade-victim 98 / healthy 140-169 / legit-dark-commercial 103 —
      threshold 110, residential only. Fired on rebuilt carroll (109). (7cef182)
- [x] **P0-2 (lighting half)** percentile L* normalisation in recolor:
      spread p90−p10>25 → remap [p10,p90]→[30,75], chroma untouched;
      uniform-lit (incl. genuinely dark) buildings unchanged. (afbafe3)
- [x] **P1-4 (glass)** facadeGlassShare ADVISORY stat — measured 0.26-2.2%
      everywhere vs ~50% real curtain wall: no separation, so no penalty;
      it is the windows-workstream metric. (afbafe3)
- [x] **P1-5 (glass alpha)** transparent texels composited over block base
      colour at atlas load — glass renders solid light-blue, not
      hole-punched. (302a7d1)
- [x] **P1-5 (face gaps)** iso top-face diamond corrected to full
      projection width (was half-width; unused _tile param was the fossil).
      Residual large-tile scalloping (painter-order side-face overdraw)
      remains a cosmetic follow-up. (c047ad7)
- [x] **P2-7** `scripts/refresh-goldens.ts` + dashboard reads goldens.json
      generated from pipeline-state — no more hardcoded stale metrics.

Open (design-scale, tracked): recolor per-face median vote + archetype
material priors (P0-2 second half); windows/glass representation across all
paths (metric: facadeGlassShare); painter-order scallop at tile≥16;
Smarty fetcher stub (area cross-check data source).

**Known issue (found during golden refresh):** `mergeStateRecord` in
build.ts is a non-atomic read-modify-write of `pipeline-state.json`;
concurrent builds (parallel background tasks) can drop each other's
records — several July rebuilds show stale May state. Fix direction:
per-slug state files or an O_EXCL lockfile around the merge. The
immutable failed-history archive is per-file and unaffected.
