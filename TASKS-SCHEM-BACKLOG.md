# .schem export backlog (user, 2026-09-01)

Orchestrate AFTER the recon_v7/v8 arc completes. Evidence preserved in
output/schem-backlog/ (schemat.io screenshots of 21063-1-io.schem, mobile).

## S1 — schemat.io renders our .schem with wrong colors/blocks (HIGH, correctness)
Symptom: shape perfect; white castle walls render as TRANSLUCENT light-blue
(glass-like), terrain base magenta/orange/cyan. File was exported from the
LEGO tab, source = 21063 authentic .io.
LEAD HYPOTHESIS (from corpus work): colorspace confusion — io-derived models
carry LDraw-space colors when the export path maps them through
studioColorToBlock (Studio/BL space), or vice versa (the io_model2_v2
flattener already BL->LDraw-maps some files; lego.ts picks colorFn by
source ext). LDraw 15 (white) mis-read in the wrong table could land on a
glass/trans block; unknown ids -> fallback = magenta-ish concrete.
Verify: export 21063 from each source (io / io_model2_v2 / omr set), inspect
the palette NBT (strings in the .schem), load in schemat.io AND a second
external viewer; also check our own Upload-tab re-import for comparison
(it round-tripped cleanly in tests — the bug may be palette naming that our
importer tolerates but schemat.io does not, e.g. data-version field).

## S2 — export progress UI (MEDIUM, UX)
Progress currently a scrollable status entry; invisible when scrolled.
Build a FIXED overlaid top banner (position:fixed alert bar) showing the
current step/process ("voxelizing 34%", "writing NBT", "compressing"),
shared by all long exports in the LEGO tab.

## S3 — schem generation perf + mobile OOM (MEDIUM)
Hi-res export (up to 30M cells) OOMs/crashes mobile. Optimize WITHOUT
quality loss: stream/chunk the voxel grid (typed arrays per Y-slab instead
of one giant allocation), move voxelization + NBT encode into a Web Worker
(keeps UI alive; the gzip step too), process in batches; profile allocation
peaks first. Parallelize per-slab where the geometry voxelizer allows.

## S4 — port schem pipeline to the Upload tab + reconcile (MEDIUM)
One shared schem-export module used by BOTH tabs (today the Upload tab has
its own path). User-configurable: resolution (blocks per stud), block
mapping / texture-pack profile (future), extras like "insert light-emitting
blocks in enclosed spaces with no windows" (flood-fill dark-room detection).

## S5 — external-viewer compatibility tests (gate for S1-S4)
Automated check: export a reference set, load the .schem in >=1 external
web viewer (schemat.io via Playwright; also try mcschematic-compatible
tooling offline) and screenshot-compare; add a palette lint (all block ids
must exist in the target MC version's registry).
