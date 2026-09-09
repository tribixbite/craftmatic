# LEGO tab — load-performance baseline (2026-09-09)

Recorded for [the 2026-09-08 audit](lego-3d-generation-audit-2026-09-08.md)'s P2
item *"keep performance measurable"*. **This is a baseline, not an optimisation
report.** Nothing was tuned to produce these numbers; they exist so a later
regression can be argued about with measurements instead of impressions.

Reproduce with `node scripts/lego-perf-baseline.mjs` (dev server on :4000), or
`DEV_URL=https://craftmatic.click node scripts/lego-perf-baseline.mjs` for the
deployed build.

## Subject

**10316-1 Lord of the Rings: Rivendell** — `MecabricksLDR/10316.ldr`, index hash
`cce43c4b614e`, 6,271 indexed placements, 6,268 rendered (the 3 documented
unmodelled moulds stay missing on purpose). Chosen because the audit names it,
and because ~6.3k parts is the size class the audit asked to be measured.

## Production (`craftmatic.click`, 2026-09-09)

| run | load | `/ldraw-parts` requests |
| --- | --- | --- |
| cold (empty IndexedDB) | **19.25 s** | 121 batch + 24 individual |
| warm (same profile, second load) | **2.68 s** | 2 batch + 25 individual |
| mobile profile, cold | 13.58 s | 119 batch + 24 individual |

**The warm load is 7.2× faster than the cold one, and that difference is
entirely the persistent `.dat` cache.** Which is the whole reason audit P1 #6
matters: that cache was, until this change, unable to notice that the library it
was caching had been corrected.

The 24–25 individual requests survive a warm load by design — only POSITIVE
results are persisted, so definitive misses (the unmodelled moulds, alias-ladder
probes) are re-derived each session rather than being frozen in as permanent
holes.

Deployed builds do not expose the dev-only `window.__ldrawViewer` hook, so
placement counts, draw calls, triangles, heap and composite time are **not
measurable against production** and are recorded as `null` rather than guessed.

## Development (`localhost:4000`, local clego library)

| run | load | requests | placements | draw calls | triangles | heap | composite |
| --- | --- | --- | --- | --- | --- | --- | --- |
| desktop cold | 3.58 s | 85 batch + 72 individual | 6,268 / 3 missing | 1,983 | 22.21 M | 1,097 MB | 16.29 ms/frame (min 14.48) |
| desktop warm | 2.83 s | 2 batch + 25 individual | 6,268 / 3 missing | 1,983 | 22.22 M | 455 MB | 16.56 ms/frame (min 16.00) |
| mobile profile, cold | 3.12 s | 85 batch + 72 individual | 6,268 / 3 missing | 1,982 | **5.98 M** | 437 MB | 15.03 ms/frame (min 14.69) |

GPU: `ANGLE (Intel, Intel(R) Graphics (0x00007D67) Direct3D11 vs_5_0 ps_5_0, D3D11)`.

Dev numbers are **not comparable to production**: the parts library is a local
filesystem read, not a Worker→R2 hop. They are useful only against each other
and against future dev runs on the same machine.

The mobile profile's triangle count is a quarter of the desktop one — that is
the adaptive edge LOD dropping the fat-line edge geometry under the tighter
mobile budget, working as designed. Its 1,982 vs 1,983 draw calls confirm the
brick meshes themselves are untouched.

## What is deliberately NOT claimed here

- **No frames-per-second.** An automation tab is backgrounded, so `rAF` is
  throttled and any fps figure taken from it would be fiction. What is reported
  instead is the cost of *producing* a frame: 60 forced `composer.render()`
  calls, three batches, median reported and minimum kept. A single batch on a
  loaded box swung 3× (12.95 → 45.2 ms) with no code change — treat a spread
  like that as evidence about the machine and re-measure on a quiet one.
- **No mobile device numbers.** The "mobile profile" rows emulate the viewer's
  `IS_MOBILE` code path (touch, 390×844, pixel ratio ≤1.5, 1024² shadows, no
  SAO, tighter edge budget) on desktop silicon. They say the mobile path renders
  correctly and how much geometry it sheds. They say nothing about phone fps;
  that needs a device, and the audit's mobile-fps question stays open.
- **No geometry-coverage percentage.** Placements rendered and part types
  missing are counted directly; a coverage *ratio* would need a ground truth for
  what should have rendered, which the index's `n` is not (it counts placements
  in the file, and a multi-coloured part emits several meshes over the same
  matrices — 10182 shows 2,432 instances for 2,417 placements).
