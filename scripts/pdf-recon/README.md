# PDF reconstruction diagnostics (Windows / PowerShell)

The [GPU matching/placement trial report](../../docs/pdf-reconstruction-matching-trials-2026-09-07.md)
documents the additional `matching_trials`, `step_transfer_trial`,
`artwork_reuse_trial`, and `placement_rank_trial` scripts and their limits.

Continued crop and full-model trials (all outputs quarantined):

```powershell
python -X utf8 -B scripts/pdf-recon/pdf_crop_trial.py
python -X utf8 -B scripts/pdf-recon/score_crop_gold.py
python -X utf8 -B scripts/pdf-recon/test_pdf_crop_trial.py
python -X utf8 -B scripts/pdf-recon/anchored_pipeline_trial.py C:/git/clego/lego_sets/PDF/6314914.pdf --out output/pdf-crop-trial/new-run --matcher cnn --strategy template --placement-matcher cnn
python -X utf8 -B scripts/pdf-recon/anchored_pipeline_trial.py C:/git/clego/lego_sets/PDF/6314914.pdf --out output/pdf-crop-trial/new-joint-run --matcher cnn --strategy template --placement-matcher cnn --joint
python -X utf8 -B scripts/pdf-recon/validate_joint_trial.py output/pdf-crop-trial/new-joint-run
python -X utf8 -B scripts/pdf-recon/test_joint_validation.py
```

The CNN trial requires the locally trained `artwork-encoder.pt`. The gold
fixture is a small visually checked development slice, not a population
benchmark. Keep the native `--out` directory new for every model run; crop
comparison and score aggregation commands use fixed research output paths.
`--candidate-budget` and `--page-prefilter` are experimental placement controls;
the measured 360-candidate/page-filter combination worsened strict placement.
`inventory_ceiling.py RUN_DIRECTORY INDEPENDENT_TRUTH.mpd` diagnoses exact-ID
catalog differences after reconstruction; its truth input is never assembly
input. Universal aliases still need explicit frame-aware reconciliation.

See [the status and limitations](../../docs/pdf-reconstruction-status-2026-09-07.md)
before interpreting any score. Generated files belong under dedicated
`output/pdf-*` research directories; none of these tools publishes models.

The engine and universal assets live in `C:/git/clego`; Python needs that
repository's installed NumPy/SciPy/OpenCV/PyMuPDF/Pillow dependencies. The new
engine entry point is there, not copied into this application repository:

```powershell
Set-Location C:/git/clego
python -B -m recon_extract.pdf_pipeline lego_sets/PDF/6248865.pdf --out C:/git/craftmatic/output/pdf-recon-audit/new-run --strategy contact
```

Use a new output directory for each run. An approximate result is not a
verification certificate. The PDF is the only set-specific input; unresolved
catalog mappings and assembly evidence remain in the manifest. Do not use
the legacy `recon_v7.pipeline --q1 deterministic` option as a synonym for
zero-VLM runtime: that flag controls extraction, not all placement calls.

From Craftmatic:

```powershell
python -B scripts/pdf-recon/test_pose_score.py
python -B scripts/pdf-recon/test_pipeline_gaps.py
python -B scripts/pdf-recon/pose_score.py output/pdf-recon-audit/new-run/model.ldr C:/git/clego/lego_sets/OMR/41624-1.mpd output/pdf-recon-audit/new-run/pose.json
$env:AUDIT_URL = 'https://craftmatic.click'
$env:AUDIT_OUT = 'output/pdf-recon-audit/browser-prod-new'
node scripts/pdf-recon/browser-check.mjs
```

`audit.py` reads the saved live-index snapshot and local experiment outputs to
recompute coverage and fixture metrics. `deterministic.py` retains the controlled
experiment harness (`--inventory io` is explicitly an evaluation aid, not a
PDF-only run). `icon_bench.py` records schema-invalid labels separately and uses
the remaining historical labels only for scoring; those labels still need
independent visual verification. Existing diagnostic result paths may be
overwritten by these aggregation tools; preserve an evidence snapshot first.

The browser tool requires locally installed Chrome and `playwright-core`.
Its default localhost mode renders the preserved four audit fixtures; the
HTTPS mode verifies production source filtering without uploading a model.

## Multi-page placement driver

`placement_autodrive.py` chains camera, registration, containment refinement,
candidate generation and search across a page scope, writing a hash-verified
journal. Everything it reads is PDF pixels, PDF text allocations and universal
CAD; nothing it writes is certified or publishable.

```powershell
python -X utf8 -B scripts/pdf-recon/placement_autodrive.py `
  --pdf C:/git/clego/lego_sets/PDF/6314914.pdf `
  --allocation-run output/pdf-placement-diagnosis/40377-corrected-late-allocation `
  --base-run output/pdf-placement-beam/40377-p14-attach-4032a `
  --pages 15 16 17 18 19 --out output/pdf-placement-beam/NEW-RUN `
  --closure-mode evidence --fraction 0.01 --fallback 2 --views 3 `
  --max-closure-parents 128 --max-poses 8192 --native-rounds 3 --native-starts 3
```

Options that matter, and why:

* `--closure-mode evidence` (default) ranks the bounded closure's parents by the
  page's own arrowhead and silhouette evidence before spending the parent
  budget. `bank` reproduces the earlier enumeration order. The budget is spent
  in whatever order it is given, so on 40377 page index 17 the parent of the
  stacked second `60474` sat at bank index 3927 of 4147 and no pose cap could
  reach it; evidence ordering puts it at rank 70 and takes bank recall from 1/2
  to 2/2.
* `--scales` is an opt-in camera-scale ladder inside containment refinement. It
  is off by default and is *measured to pick the wrong direction* on page 17,
  because a tight overflow allowance rejects the correct larger scale before
  coverage is consulted. The mechanism that works is the cross-page scale prior,
  which is on by default and disabled with `--no-scale-prior`.
* `--pending-body PAGE=DIR` declares a subassembly built outside the page scope;
  the driver measures which page draws the body while allocating nothing and
  attaches it there. `--group-run PAGE=DIR` supplies a construction for a page
  the driver classifies as building a separate body.
* `--retry-passes N` retries pages that failed only for want of a camera, after
  later pages have supplied one.
* `--camera-gate {off,report,enforce}` (default `enforce`) accepts a page's
  camera only when its refined registration is contained, leaves no more drawn
  ink unexplained than the page's own allocated pieces could cover, and keeps
  the expected scale. `report` measures without filtering, which is how a gated
  run is compared with an ungated one. Thresholds are `--camera-unexplained-max`
  and `--camera-scale-tolerance`.
* `--no-exploded-target` scores every allocated piece against the drawing even
  when the page draws one of them detached, reproducing the round-two objective.
  With the default on, a detected detached piece is withheld from the
  image-judged search and placed afterwards from the page's arrows.
* `--no-drawing-scale` stops the driver measuring the scale between the previous
  page's drawing and this one. That measurement is PDF-only and does not pass
  through the emitted body, so it survives a wrong body; it supplies extra
  rescaled camera hypotheses and the camera gate's expected scale.
* `--local-rerank W` (default 0, off) blends the whole-drawing score with
  evidence restricted to the region an addition changes. It fixes a measured
  one-stud selection error on 41624 page index 2 and is not needed on the 40377
  pages tested, so it stays opt-in.

Body construction, for a page with no assembly to register against - a first
page, or one that starts a subassembly:

```powershell
python -X utf8 -B scripts/pdf-recon/placement_construct_body.py `
  --pdf C:/git/clego/lego_sets/PDF/6248865.pdf `
  --allocation-run output/pdf-placement-diagnosis/41624-bridged-allocation-p2to8 `
  --page 2 --prescan-pages 3 4 5 --roots 2 `
  --out output/pdf-placement-beam/NEW-CONSTRUCTION --closure-mode evidence `
  --fraction 0.01 --fallback 2 --views 3 --native-rounds 3 --native-starts 3
```

It nails one allocated piece to the identity transform - the reconstruction
frame is free and the camera sweep already covers every root orientation - and
runs the ordinary page pipeline for the rest. The selected result is written to
`construction/`, an ordinary placement directory a driver consumes with
`--base-run` or `--group-run`.

Evaluation is separate and post hoc. None of these read a reference model:

```powershell
python -X utf8 -B scripts/pdf-recon/placement_diagnose_bank_recall.py `
  --registry RUN/page-017/registry-00.json --base BASE/model.ldr `
  --out output/pdf-placement-diagnosis/recall.json
python -X utf8 -B scripts/pdf-recon/placement_diagnose_target_score.py `
  --registry RUN/page-017/registry-00.json --recall output/.../recall.json `
  --run RUN/page-017/placement --out output/.../target-score.json
python -X utf8 -B scripts/pdf-recon/placement_diagnose_alias_poses.py `
  RUN/page-017/placement "model.ldr" --out output/.../alias.json
```

`placement_diagnose_bank_recall.py` answers whether the enumerated bank contains
the reference poses at all, `placement_diagnose_target_score.py` whether the
runtime scorer prefers them, and `placement_diagnose_alias_poses.py` reports raw
strict, authoritative-alias and structural pose agreement separately.
`placement_trajectory.py RUN --truth OMR.mpd` prints the whole run as a table of
emitted, structural, canonical-alias and raw-strict agreement per checkpoint.
`placement_diagnose_coarse_rank.py` rebuilds a page's own bank and reports where
a requested pose sits under the coarse composite and under the native scorer, so
a pose lost to the occupancy screen, to coarse ranking, or to the two objectives
disagreeing can be told apart; `--outside-fraction` applies the proportional
occupancy allowance. `placement_diagnose_local_delta.py` reports the same
candidates under the whole-drawing scorer and under region-local evidence.

## Population, and the round-six channels

Before choosing a lever, cost the class it addresses. `placement_population_table`
assigns every reference part a completed run fails to place exactly one primary
class — `out_of_scope`, `allocation_blocked`, `unreachable`, `visibility_limited`
or `mis_selected` — from the run's own journal, registries and accepted cameras:

```powershell
python -X utf8 -B scripts/pdf-recon/placement_population_table.py `
  --run output/pdf-placement-beam/RUN --truth C:/git/clego/lego_sets/OMR/40377-1.mpd `
  --allocation-run output/pdf-placement-diagnosis/ALLOCATION `
  --out output/pdf-placement-diagnosis/population.json
```

It reports two controls beside the table and both matter. Correctly placed
reference instances are measured the same way, so "paints too little" can be
checked against what a *successful* placement paints; and the complete-reference
control is declared **inapplicable** where a page's body is a small fraction of
the model, because the finished model then buries every addition at that page's
camera. Classification always uses the body the run actually scored against.

Round six's channels, all measured and none adopted:

```powershell
python -X utf8 -B scripts/pdf-recon/placement_verify_part_mirrors.py 3020 3024 4032a
python -X utf8 -B scripts/pdf-recon/placement_mirror_ceiling.py --run RUN --truth OMR.mpd --out out.json
python -X utf8 -B scripts/pdf-recon/placement_mirror_rerank.py --run RUN --truth OMR.mpd --out out.json
python -X utf8 -B scripts/pdf-recon/placement_inventory_forcing.py --run RUN --truth OMR.mpd --out out.json
python -X utf8 -B scripts/pdf-recon/placement_construction_symmetry.py CONSTRUCTION --truth OMR.mpd --out out.json
python -X utf8 -B scripts/pdf-recon/test_placement_mirror.py
```

`placement_verify_part_mirrors` records which of the 24 improper octahedral
elements a mould's universal CAD is invariant under, and
`placement_part_mirror_table` turns those proofs into the group a mirror channel
may use — at a stated 0.01 LDU vertex tolerance, because LDraw's rounded curved
primitives are not exactly mirror-symmetric, and never for a printed mould.
`placement_mirror_ceiling` separates opportunities from distinct parts and
separates proposals the driver could actually make (base-sourced) from ones only
an oracle could. `placement_inventory_forcing` counts a piece's distinct
one-stud locations; read the `cells` column, not `chain` — single-linkage
clustering chains through a dense body and reports the whole bank as one region.

Every diagnostic rebuilds the run's own target through `placement_run_scene`,
which reads the `mask_source` the run recorded. A diagnostic that rebuilds the
drawing from the PDF without it scores a different question: on 40377 page index
17 the run used the body's image component (52,177 px) and a naive rebuild uses
the whole drawing (65,869 px), and the same assembly scores 0.5442 or 0.2865
depending on which. Local
symmetries come from saved universal-CAD proofs
(`placement_verify_part_symmetries.py`), never a hand list.

## Inventory identity

`placement_catalog_factor_bridge.py` learns Rebrickable-to-LDraw part and colour
relations from element IDs both universal catalogs resolve unambiguously, and
keeps every conflict as ambiguity. `placement_element_bridge.py` then confirms
the colour against the element's own PDF inventory icon, comparing each
candidate's LDraw RGB to the icon's *modal* foreground colour with an explicit
separation margin, and confirms nothing when the part itself is disputed:

```powershell
python -X utf8 -B scripts/pdf-recon/placement_element_bridge.py `
  --pdf C:/git/clego/lego_sets/PDF/6248865.pdf `
  --source output/pdf-placement-vector/41624-fresh-identity-v2/identity-input `
  --out output/pdf-placement-diagnosis/41624-element-bridge
```

The output directory is an ordinary allocation source for
`global_pdf_slot_assignment.py`, and from there `placement_slot_adapter.py`
produces the page-scoped allocation the driver consumes.
