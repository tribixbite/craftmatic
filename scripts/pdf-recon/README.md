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
strict, authoritative-alias and structural pose agreement separately. Local
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
