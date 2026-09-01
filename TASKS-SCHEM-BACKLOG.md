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

## S4 — port schem pipeline to the Upload tab + reconcile (MEDIUM) — DONE 2026-09-01
The Upload tab held a **BlockGrid**, not bricks (it imports .schem/.litematic/
mesh), and exported it through `main.ts`'s download menu calling
`exportSchem`/`exportLitematic` synchronously on the main thread. Both surfaces
now call ONE module — `web/src/ui/schem-export.ts` `runMinecraftExport()` over
`web/src/engine/schem-pipeline.ts` (the S3 worker + encoders): source
`{kind:'bricks'}` voxelizes, `{kind:'grid'}` encodes only (an uploaded
schematic is already blocks). `schem-worker.ts` is now just message plumbing;
the inline fallback calls the same function, so the two cannot drift.
Settings (`⚙ MC settings` popover, shared + localStorage-persisted):
**resolution** (Auto / 1 / 2.5 / 5 blocks per stud, caps enforced, live dims
preview), **block-mapping profile** (`engine/block-profiles.ts` — one real
profile, the seam only), **light enclosed interiors** OFF by default
(`engine/light-fill.ts`: boundary flood → sealed pockets ≥8 cells get glowstone
one per 6³ bucket on the floor; a room with a doorway stays dark by design).
Verified in the app: Upload tab 16,112 → 16,128 blocks with lights on; LEGO tab
129×14×33 @5× vs 27×3×7 @1×. Defaults are byte-identical (below).

## S5 — external-viewer compatibility tests (gate for S1-S4) — DONE 2026-09-01
1. **Palette lint (offline, CI)**: `engine/palette-lint.ts` +
   `engine/mc-block-registry.json` (curated verified Java 1.20 ids).
   `test/palette-lint.test.ts` lints both colour tables, the fallbacks, the
   profile light blocks and a real exported .schem's `Palette` — all clean, and
   the lint proves non-vacuous on a deliberate typo.
2. **schemat.io (manual, repeatable)**: `node scripts/schem-external-check.mjs`
   exports 21063 through the shared path and screenshots schemat.io/view →
   `output/schem-backlog/schemat-io-21063.png`. Verdict: WHITE castle, solid
   walls, green/brown base — the S1 defect (translucent blue walls, magenta
   terrain) is gone.
3. **Byte-identical gate**: `scripts/_schem_ref.ts` (rewritten to drive the REAL
   shared pipeline) on 21063 at defaults → sha256
   `52d221188f5677475392a25c4e45f6d137ba43af547c9d8c4ba44b9a8194be6b`,
   equal to the S3 baseline. No regression.
