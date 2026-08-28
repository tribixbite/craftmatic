# Verification Hardening Roadmap (Tekton-derived)

Status: **in progress** — opened 2026-06-21. Last worked 2026-08-16.

---

# ▶ START HERE — handoff (updated 2026-08-16)

**Reading order for this file:** items `## 1`–`## 6` are the original roadmap
(all DONE). Everything from *Visual QA findings 2026-07-18* onward is a
chronological work log — **oldest-first until "Live-consensus era", then
newest-first**. You do not need to read it all; this section is the summary.

## How to run anything (read this before your first build)

```bash
# One golden, replaying recorded API data — NO network, ~15-180s.
bun scripts/iterate.ts --only <slug> --local-tiles --offline

# Same but allowed to fetch + record whatever is missing (default mode).
bun scripts/iterate.ts --only <slug> --local-tiles

# Board / remediation queue.
bun scripts/iterate.ts --status
```

Every API input (geocode, Solar, OSM, SV panes, satellite) is cached per-slug
in `output/api-cache/`. **Always iterate with `--offline`** unless you
deliberately need fresh evidence: it makes your code change the only variable,
costs no quota, and survives Overpass outages. A cache miss throws rather than
silently reaching the network. `--cache-mode refresh` re-records.

Ground truth for a build is `output/pipeline/<slug>.verification.json`, not the
console — bun buffers child stderr into redirected logs until the process
exits, so a running build looks silent.

## Current board (all five goldens, 2026-08-16)

| slug | status | IoU | defect | color | features | massing | overall |
|---|---|---|---|---|---|---|---|
| pennzoil | **pass** | 1.00 | 10.0 | 8 | 7 | 9 | 9 |
| flatiron | fail-consensus | 0.98 | 10.0 | 3 | 2 | 9 | 4 |
| geisel | fail-consensus | 1.00 | 10.0 | 1 | 0 | 1 | 0 |
| guggenheim | fail-consensus | 0.99 | 10.0 | 1 | 0 | 0 | 0 |
| 240-highland | fail-consensus | 1.00 | 10.0 | 1 | 0 | 0 | 0 |

**The deterministic gates are saturated** — every build is IoU ≥ 0.98 and
defect 10.0. All remaining signal is subjective, so a change that doesn't move
a VLM dimension moved nothing. `massing` 0-1 alongside IoU 1.00 means the
footprint is right and the *vertical form* is wrong.

## Ranked open work

1. **guggenheim — diagnose capture contamination (best-evidenced lead).**
   Build logs `helical fit rejected: trend residual 8.37m > 15% of
   rMean=20.9m` AND `207 bands, Y range -7.2..40.8 (48.0m) → scaled to
   expected 21.0m (×0.438)`. A 48m capture for a 21m building means the
   capture very likely swallowed the taller 5th-Ave neighbours — which would
   *also* explain the radius oscillation that rejects the helical fit.
   **Diagnose the capture before touching the helical threshold**; the
   threshold may be innocent. Start at `sliced-tiles.ts` masking + the
   heightmap crop, not at `fitHelicalFrustum`.
2. **flatiron — recolor splotch (colour 3, features 2).** Photogrammetry
   noise fragments the facade. NOTE the rejected approach below before
   starting: attack the recolor's *sampling*, not post-hoc smoothing.
3. **geisel — DIAGNOSED: its height is 2× reality, and nothing checked it.**
   Evidence: `height = 72.9m (tiles/0.95)`, `levels = 24 (inferred)` — Geisel
   Library is ~33m and 8 floors. The grid is 650×438×186 @ 6 blocks/m ≈
   108 × 73 × 31m for a roughly-square 90m building.
   **Root cause:** tile height is `maxY − minY` of the whole captured mesh
   (`heightmap.ts` BboxAccumulator). Geisel sits on a canyon edge, so the
   capture spans canyon floor → roof (`Y range 61.9..114.9`). It measures
   CAPTURE EXTENT, not building height.
   **Fix direction:** derive the base from the ground under the FOOTPRINT
   (median terrain elevation inside the OSM polygon) rather than the global
   bbox minimum. Everything downstream — levels, storey pitch, window rows —
   inherits this error, so this is upstream of any overlay work.
   Made visible (not yet fixed) this round: the report now prints
   `h_unverified=73m/tiles`.
4. **240-highland — REOPENED; my earlier "source-data-limited" call was too
   strong.** Three of its four SV panes are genuinely foliage, but
   `sv-left.jpg` is a clear facade view: cream clapboard, green shutters,
   gabled dormers, a chimney. The model is a plain gabled prism in sandstone,
   so `massing 0` is at least partly a real detail/massing gap, not purely
   missing evidence. Treat it as a normal (hard) target.

## Traps that have already cost real time

- **A failed measurement must never look like a measurement.** This bit us
  FIVE separate ways — a height cross-check with `alternatives: []` reported
  `ok: true`, so geisel's 2×-wrong height read as corroborated. Read
  `crossCheck.verified`, never `ok`, when you care whether something was
  actually checked. The other four: an Overpass `null` (outage read as "no building"), the
  VLM scorer's zero-score error fallback, tree photos fed to the scorer as
  reference, and — inside the module written to fix the third — a
  `catch { return 'none' }` that reported every reference as clear when a
  field name was wrong. When you add a fallback, make it *distinguishable*,
  and catch only the failure you actually mean to tolerate.
- **The occlusion sniffer under-detects DARK foliage.** `veg ≥ 0.30` uses a
  hue+saturation test, so shadowed evergreens fall through as "building".
  240-highland's `sv-right.jpg` is near-solid dark conifer and sniffs as
  `none`. Verdicts already in `references.json` are never overwritten, so a
  human/agent correction sticks — that file accepts a `$comment`.
- **NEVER add a regional Overpass mirror** (`overpass.osm.ch` answers New York
  with HTTP 200 + `elements: []`). Global-coverage instances only.
- **Deterministic gates cannot see a blank facade.** The per-column-ceiling
  bug scored IoU 1.00 / defect 10.0 with an empty upper tower; only the VLM
  caught it. Re-render and look before trusting green gates.
- **`Atlas load exceeded 45s — rendering with procedural textures`** means the
  VLM scored fake textures — those scores are not comparable. Builds rarely
  hit it; the standalone `rescore.ts` scratch script often does. Grep for it.
- **Overpass outage tell-tale:** `prov_mean≈0.49`, `levels/inferred/0.13`, IoU
  collapse. That is the environment, not your code — rebuild, don't debug.

## Rejected with data (do not retry blind)

- **Per-face median snap in the recolor pass.** Two iterations, including
  correct outermost-shell face detection replacing a naive air-neighbour test.
  Moved `facadeDominantShare` by 0.000 and raised `uniqueBlockTypes` 13 → 15.
  Reverted. The splotch is real; this was not its fix.

---

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

### Fix status — 2026-07-20 (round 2)

- [x] **state race** mkdir-lock (stale-broken at 30s) + temp/rename atomic
      write in mergeStateRecord; `scripts/sync-state.ts` re-syncs state from
      verification.json artifacts; refresh-goldens `--json-only`. (c4ef633)
- [x] **P0-2 (consolidation half)** buffered 6-neighbour majority pass over
      recolored voxels (≥4 agreeing flips; boundaries with ≤3 untouched;
      overlay voxels excluded). Live durham rebuild: purple checker gone,
      roof reads sandstone, upper facades coherent; street-level
      photo-splotch remains — needs per-face segmentation (open).
- [-] **Smarty fetcher** stays a stub: no SMARTY credentials in .env; wiring
      an untestable API client would be worse than the stub. Unblocks when
      keys land.

## Architectural audit — 2026-08-08

Full-pipeline audit (stages 0–9, CLI + browser) triggered by the question
"is helical-fit telemetry/calibration really the most impactful next step?"
**Verdict: no.** The helical fit only fires for curved buildings (2 of 14
tracked) and telemetry is observability, not quality. Ranked findings:

**A0 · The iterate loop retried an unfixable state 282 times.** No VLM key
exists in .env, so `--consensus gemini` is never wired and every objective-
pass build lands at `fail-consensus` with `consensus=null`. The queue
treated that as remediable; the goldens burned 86/44/58/53/41 attempts on
signature-identical reports until the stop hook escalated ALL FIVE to
terminal `needs-human-review`. FIXED (a92ab42): `isBlockedOnConsensus()`
excludes credential-blocked records; `--status`/`--worst` explain the block.
**Residual decision for a human: supply a GEMINI_API_KEY and reset the five
goldens' status so they can re-enter the queue** (`scripts/sync-state.ts`
after one fresh `--only` run per slug, or manual status edit).

**A1 · Colour-conversion drift (9 private copies, 6 modules).** Synthesis
copies used 4-decimal XYZ matrices, recolor used 7-decimal, parametric
round-tripped Lab→hex→RGB. FIXED (d54b983): shared `src/pipeline/color.ts`
with round-trip tests; all consumers converted.

**A2 · Open design-scale gaps, in impact order** (all pre-audited, all still
open): (1) windows/glass representation — facadeGlassShare 0.3–2% vs ~50%
real curtain wall, EVERY commercial build; parametric windows still
single-facade. (2) P0-2 second half — per-face median vote + archetype
material priors (street-level photo splotch). (3) painter-order scallop at
tile≥16. (4) `photogrammetry-recolor.ts` (~600 lines) has NO unit tests —
riskiest untested module; extract pure helpers (k-means, majority pass,
luminance normalisation is already exported) before the P0-2 work lands.
(5) `synthesizeSlicedTilesImpl` ~490 lines / `evaluateBRep` ~250 —
split-worthy but only alongside planned feature work, not speculatively.

**A3 · Helical-fit telemetry** — done as a five-line follow-along
(d54b983): each rejection gate logs measured value vs threshold. Threshold
calibration itself WAITS for live rejections to accumulate; calibrating
now would tune against goldens the fit already passes.

## Live-consensus era — 2026-08-10

GEMINI_API_KEY landed (bashrc `.secrets`); consensus runs for real
(`gemini-fanout`, temp 0, single-model → spread 0, gate = median≥8.5 ∧
min≥7). First-ever baseline scores localised the gap precisely: massing
8-9 on the towers, color 1-4, features 0-1 everywhere. Two rebuilds landed
(703aac6):

- **True gable/hip ridges** (`brep.ts`): the uniform 0.02 tent taper was a
  pyramid; gables now keep a full-length ridge along the long axis, hips
  inset by the half-span. Mesh-level ridge-extent tests.
- **Evidence-driven overlay windows** (`voxel.ts`): metre-sized windows
  from the shared archetype table, one row per storey from fused levels,
  face-aware columns; commercial walls with L*<45 flip to curtain-wall
  (glass + storey spandrels + ~3m mullions).

**Result: pennzoil 4/1/8/3 → 8/7/10/9 — status `pass`, the first golden
through the full objective+consensus gate.** Flatiron color 1→3, features
still 1 (recolor splotch dominates its facade signal).

**Loop hygiene (77adae7, dcb5fbb):** the state-lock retry loop could spin
unbounded (pennzoil burned ~2h post-verify twice, died mid-merge leaving
the lock held, pass never persisted) — deadline now checked before every
retry path; attempts reset when the failure signature changes (stop-hook
ceiling was re-escalating improving goldens off credential-era counts);
sync-state handles the flat artifact layout (previously synced 0 records);
iterate enforces a 15min per-build ceiling + persistence breadcrumbs.
Verified: pennzoil rebuilt clean end-to-end (170s, pass, artifacts+state).
**Consensus nondeterminism:** identical inputs scored min 7.0/6.0/7.0
across three runs — the gate straddles min≥7 on borderline builds. Queue:
best-of-N or mean-of-3 scoring round before trusting near-threshold gates.

### 240-highland is source-data-limited — 2026-08-16 (2dd1e84)

Stated explicitly, as the loop's own escape clause invites: **240-highland's
subjective score is not pipeline-fixable through the overlay.** Evidence:

- Every deterministic signal is healthy — IoU **1.00**, defect **10.0**,
  facade dominant **70%** sandstone, glass 7.7%, 5 block types.
- The reference photos show **trees, not a building**. The house sits behind
  dense evergreens; the pipeline's own sniffer independently classifies both
  captured panes as `trees`.
- I previously recorded that its polygon override was "much larger than the
  real cottage". **That was wrong** — measured from the override: 12.0m ×
  14.6m = 175 m², an ordinary single-family footprint. Correcting the record.

So the VLM was scoring a correct model against foliage and returning
0/0/0/0 — the same failure mode as the Overpass `null` and the zero-score
scorer fallback: *a measurement that could not be made, presented as a
measurement that came out badly*. It then drove the loop to "improve
features" on a build whose features are fine.

Fixed the scorer-misleading half (2dd1e84): occlusion verdicts are persisted
to `references.json` at capture and tree-occluded panes are excluded from the
consensus reference set, with the exclusion logged; satellite is always kept.
Verified: `excluded 2 tree-occluded reference(s): sv-front.jpg, sv-right.jpg`.

This does **not** rescue the address, and shouldn't be expected to — there is
no street-level view of this building to compare against. The right outcome
is the escalator retiring it after N signature-identical attempts. Options if
it ever matters: curate an oblique/aerial reference by hand into
`reference-data/240-highland/`, or exempt tree-occluded addresses from the
subjective gate entirely and let the deterministic gates stand alone.

### Per-column window ceiling; pennzoil re-passes — 2026-08-16 (c9f06f3)

The eave clamp shipped with the metre-scaled bands used the 25th percentile
of per-column tops as ONE global ceiling. Right for a simple pitched roof,
badly wrong for anything else: on Pennzoil's terraced tops three quarters of
the columns sit ABOVE that percentile, so the clamp blanked the whole upper
tower. **Consensus massing fell 10 → 1 on a build with IoU 1.00 and
defect_score 10.0** — perfect geometry, empty facade. Every deterministic
gate said the build was flawless; only the VLM caught it, which is precisely
the division of labour the consensus stage exists for.

Each column now stops below its OWN roof mass — no shape heuristic to
mis-fire. Verified offline (28 cache hits, no network): pennzoil
0/0/1/0 → **8/7/9/9, median 8.5, status=pass** — its first pass since the
outage destroyed the original.

**Golden board after the fix** (all IoU 0.98-1.00, all defect 10.0):

| slug | color | features | massing | overall | status |
|---|---|---|---|---|---|
| pennzoil | 8 | 7 | 9 | 9 | **pass** |
| flatiron | 3 | 2 | 9 | 4 | fail-consensus |
| geisel | 1 | 0 | 1 | 0 | fail-consensus |
| 240-highland | 2 | 0 | 0 | 0 | fail-consensus |
| guggenheim | 1 | 0 | 0 | 0 | fail-consensus |

Deterministic gates are saturated — every build scores defect 10.0 with
near-perfect IoU — so all remaining signal is subjective. massing 0-1 with
IoU 1.00 means the FOOTPRINT is right and the VERTICAL FORM is wrong.

**Next lead, with data.** The helical-fit rejection telemetry (added d54b983,
deliberately without calibration until live rejections existed) produced its
first datum: guggenheim logs `helical fit rejected: trend residual 8.37m >
15% of rMean=20.9m (oscillating profile)` — the rotunda the helical frustum
was *built for* is declined, so it falls back to stair-stepped bands. Before
loosening that threshold, note the same build logs `survived 207 bands, Y
range -7.2..40.8 (48.0m) → scaled to expected 21.0m (×0.438)`: the capture
spans 48m against a 21m building, i.e. it very likely swallowed the taller
5th-Ave neighbours, which would ALSO explain the radius oscillation.
Diagnose the capture contamination first; the threshold may be innocent.

**Renderer caveat:** a standalone rescore hit `Atlas load exceeded 45s —
rendering with procedural textures`, which the renderer itself flags as not
comparable. The five builds above logged zero atlas timeouts, so their scores
stand — but any score gathered outside a build must be checked for that line.

### Overpass failover + offline API cache — 2026-08-16 (9b1adc9)

**Overpass.** The "three servers for reliability" pool was three hostnames of
ONE deployment (`overpass-api.de`, `lz4.`, `z.`) — every retry hit the same
infrastructure, which is why the pipeline lost OSM twice in a day. Pool now
spans independent operators with a 5-minute failure cooldown, and `osm.ts`
fails over on ANY non-OK status (only 429/504 retried before; a 502 returned
`null`, i.e. "no building"). Exhausting all mirrors now **throws**
`OverpassUnavailableError` — the bf2347d outage guard was **inert** without
this, because osm.ts swallowed every error so `ctx.osmUnavailable` was never
set. Proven live: with the whole overpass-api.de family unreachable, failover
carried flatiron to IoU 0.98 / prov_mean 0.83 / defect 10.0.

**⚠ Never add a regional Overpass instance.** Probed 2026-08-16:
`overpass.osm.ch` answers a New York query with **HTTP 200 + `elements: []`**
and the same query for Zurich with real data — a Switzerland-only database.
An empty 200 is indistinguishable from "nothing mapped here", so a regional
mirror doesn't degrade the pipeline, it **corrupts** it: footprint falls back
to a solar bbox and every downstream gate reports a confident wrong answer.
I added osm.ch, caught it poisoning flatiron's cache with a `null`, and
removed it. An outage is recoverable; a plausible wrong answer is not.

**API cache (`output/api-cache/<slug>/`).** Every API-drawn input — geocode,
Solar, OSM, siblings, building parts, Smarty, Street View panes, satellite
crops — is recorded on first fetch and replayed after. Images are
content-addressed blobs (deduped); JSON entries wrap their payload so a
cached `null` round-trips as a real answer rather than a miss. Modes: `auto`
(default), `refresh`, `offline`, `off` — via `--cache-mode`, `--offline` on
iterate.ts, or `CRAFTMATIC_CACHE_MODE`. In `offline` a miss **throws** rather
than silently reaching out, so "no network" is provable, not hoped for.

Measured on flatiron: **28 hits / 0 misses, byte-identical output (IoU 0.98,
942484 voxels), 39s vs 148s.** Synthesis/recolor/overlay work now iterates on
device with the code change as the only variable. Blobs are gitignored;
re-record with `--cache-mode refresh`.

### Outage guard + metre-scaled bands — 2026-08-10 (bf2347d)

The loop's next block pointed at `applyMaterialOverlay` for `features`, and
found the same resolution-unaware bug class already fixed for windows:
`corniceBandH`/`baseBandH` compared a BLOCK height against `50`/`15` and
emitted 2-3 BLOCK bands. At the default **6 blocks/m** that is a 0.5m cornice
and a 0.33m plinth on a 73m tower — invisible, while the scorer asks about
"cornices, parapets" by name. Now metre-based (~2.5% of facade height;
~one storey base), clamped so a cottage gets an eave, not a stripe.

**Verification of that fix is still pending: Overpass went down again**
mid-round and both rebuilds returned degraded context.

That second outage exposed something worse. `fetchers.osm(…).catch(() => null)`
made a REJECTED fetch indistinguishable from "no building here", so the 152m
**Pennzoil rebuilt as an 8m 3-level solar-bbox guess** (footprint conf 0.30,
height 0.25, levels 0.125) and was recorded `fail-objective` — blaming the
pipeline for an outage and **overwriting its verified pass**. This violated
the project's own "measured reality wins" rule: the pipeline invented a
building rather than reporting missing data.

Fixed: `ctx.osmUnavailable` tracks the transport failure; `runPipeline` bails
to `context-insufficient` *before synthesis* when the footprint also fell
below 0.5 confidence (so no artifacts overwrite a good prior build);
`mergeStateRecord` preserves a prior `pass` when a run comes back
context-insufficient. A resolved-null OSM response is explicitly NOT an
outage — tests pin both directions.

**Damage to repair when Overpass recovers:** pennzoil's pass and artifacts
were overwritten before the guard existed. Rebuild it (and flatiron) to
re-earn the status and finally verify the cornice/base change.

### Facade-coherence metric was wrong — 2026-08-10 (e1ea38f)

With the loop healthy again it immediately earned its keep: it blocked on
flatiron, the rebuild (post-Overpass-recovery) cleared the objective failure
**IoU 0.58 → 0.98, prov_mean 0.49 → 0.83, no code change** — confirming the
new provenance warning correctly identified an outage, not a regression.

That left `facade_incoherent` on a visually clean build. Measuring the actual
facade composition rather than theorising found the cause: `smooth_sandstone`
23.9% **+** `sandstone` 23.9% — one material, hash-split across two variants
by `rgbToWallBlock`'s deliberate per-position option spread, each half landing
just under the 25% floor. Together 47.8%. **The metric was wrong, the build
was fine.** Dominance is now tallied per material family. Measured state →
family: flatiron 23.9→48.4, highland 29.2→72.7, and pennzoil/geisel/
guggenheim **unchanged** (58.0/46.9/35.9) — targeted at the split, not a
blanket inflation. Flatiron defect 9.0 → **10.0**.

Note this was partly self-inflicted: the b36baa5 calibration gave the
neutral-cream cluster two options, which is what created the 50/50 split.

**Rejected en route (recorded so it isn't retried blind):** a per-face median
snap in the recolor pass — group exterior voxels by (facade direction ×
vertical band), snap Lab outliers onto the band median. Two iterations,
including replacing a naive air-neighbour face test (which pooled opposite
walls, since a hollow shell has air on both sides of every wall voxel) with an
O(N) outermost-shell precompute. Result: `facadeDominantShare` moved by 0.000
and `uniqueBlockTypes` rose 13 → 15. Reverted. The visible splotch is real;
this was not its fix. A future attempt should target the recolor's *sampling*
(what gets read off the photogrammetry) rather than post-hoc smoothing.

### Stop-hook repair — 2026-08-10 (172054e)

The hook that drives this entire loop was **dead on its primary path**: a
stale `ESC_ATTEMPTS` reference (constant is `ESC_ATTEMPTS_IDENTICAL`) raised
NameError on every fail-objective build. A Stop hook exiting non-zero is a
*non-blocking* error — so instead of prescribing a fix, the loop silently
allowed the stop. It had no tests, so nothing caught it.

Fixed alongside it:
- **One-way escalation ratchet** (the mechanism that left all five goldens
  terminal): escalate → hook stops instructing rebuilds → never rebuilt →
  escalated forever. Escalations now record HEAD and auto-clear when the
  pipeline code moves, resetting the attempt tally with them — without the
  reset the stale tally re-trips the hard ceiling on the same run.
- **Obsolete "wire consensus" branch** removed; `consensus=null` now reports
  on stderr and allows the stop (same rule as `isBlockedOnConsensus`).
- State writes use build.ts's mkdir-lock + atomic-rename; escalation scoped
  to goldens (it was mutating `-qa` records); low provenance confidence
  surfaced so an OSM outage isn't mistaken for a code regression; lever map
  pointed at the modules that own these signals today.
- `test/stop-hook.test.ts` — 12 paths, verified to fail against the
  NameError before the fix. Two unwired hooks archived.

Live effect: the three stale escalations cleared to `fail-consensus` with
attempts 0, and the loop resumed prescribing work.

### Calibration round — 2026-08-10 (later)

- **WALL_CLUSTERS calibrated to rendered textures (b36baa5).** Texture-mean
  audit found options drifting 90-155 RGB-distance from their cluster
  targets (gray→gray_terracotta renders chocolate; sky-blue→
  light_blue_terracotta renders gray-purple; ochre→sandstone renders pale;
  pale-pink→pink_terracotta renders dusty rose). Replaced with
  measured-nearest full blocks; new neutral-cream cluster
  [212,197,169]→sandstone resolves the highland knife edge. Verified
  visually: highland walls now sandstone, not mauve.
- **Eave-aware window band** — 25th percentile of per-column tops; pitched
  roofs no longer clip the upper row (regression test).
- **Median-of-3 Gemini sampling** in fan-out mode (`gemini-fanout-med3`).
- **240-highland residual (massing 0) is DATA:** its polygon-overrides.json
  rectangle is far larger than the actual cottage — the model reads as a
  warehouse-scale barn vs a small tree-hidden gambrel in SV. Fix: redraw
  the override to the house body (or trust Solar bbox), then re-score.
- **Flatiron rebuild during OSM Overpass outage** correctly FAILED
  OBJECTIVE (IoU 0.58, prov_mean 0.49, levels inferred/0.13) — the gate
  caught degraded context before spending a VLM call, and the new
  signature reset its attempts counter. Rebuild when Overpass recovers.

**New root cause found — wall-cluster knife edge:** pale cream Lab
(~80,1,16) sits on the WALL_CLUSTERS boundary between `sandstone` (warm
cream texture) and `white_terracotta` (renders mauve-pink). 240-highland's
correct OSM cream resolves to white_terracotta and the whole house reads
muddy mauve → VLM color 0-1. The cluster's representative colours don't
match how the textures actually RENDER. Queue: re-derive WALL_CLUSTERS
representative Lab values from the block textures as rendered by
png-renderer (not the abstract colour map), then re-test the 21-building
set. Also open: upper residential window row clips under the eave — the
window band should end at the eave line (percentile of per-column topY),
not grid height minus a fixed roofDepth.
