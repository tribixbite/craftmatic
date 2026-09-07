# PDF reconstruction diagnostics (Windows / PowerShell)

See [the status and limitations](../../docs/pdf-reconstruction-status-2026-09-07.md)
before interpreting any score. All generated files belong under
`output/pdf-recon-audit/`; none of these tools publishes models.

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
