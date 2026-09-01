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

## S2 — export progress UI (MEDIUM, UX) — DONE 2026-09-01
`web/src/ui/export-progress.ts`: fixed banner pinned at #nav's measured
bottom (never covers the tab bar, verified at 390px), determinate bar with
live phase + %, green auto-dismiss / red sticky-with-×. Wired into schem,
litematic, build guide, GLB, OBJ, STL, 3MF; #lego-status stays the log.

## S3 — schem generation perf + mobile OOM (MEDIUM) — DONE 2026-09-01
PROFILED FIRST: BlockGrid was already a palette-indexed Uint16Array; the
peak was (a) `number[]` byte accumulation in encodeBlockData + both NBT
writers — **1.33 GB RSS for a 0.2 MB file at the 30M-cell cap** — and
(b) 1.60M `{gx,gy,gz,block,color}` objects (98 MB) in the geometry
voxelizer, whose ray sweep was also O(rays × triangles) = 85 s of blocked
main thread on 21063. Fixed with a growable-Uint8Array ByteWriter +
exact-size varint encode, chunked typed-array cells, and a per-triangle
bbox bucket index; then moved the whole chain into
`web/src/engine/schem-worker.ts` (progress → S2 banner, inline fallback).
Measured 21063 @ cellLDU 4: voxelize 85.5 s → 5.9 s, peak 935 → 490 MB;
30M-cell encode 1332 → 338 MB. Output **byte-identical** (sha256 match,
`scripts/_schem_ref.ts`) for .schem and .litematic; parseSchemFile
round-trip clean. See CLAUDE.md for the invariants.

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
