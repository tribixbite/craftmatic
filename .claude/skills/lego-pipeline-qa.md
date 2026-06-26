# LEGO Pipeline QA + Deploy Skill

Reproducible flow for validating the LEGO render/export pipeline and shipping
changes safely. Distilled from hard-won session experience — follow it so the
next agent doesn't re-derive the gotchas.

## When to use
Validating the LEGO tab (load/render/voxelize/export), stress-testing the
renderer, or deploying + verifying a change on prod.

## Tooling
- `bun`/`bunx` only (never npm/npx). Dev server: `bun dev:web` (port 4000); it
  exits between long idle gaps — restart as needed.
- Browser automation: the Playwright MCP works well (`navigate`/`evaluate`/
  `screenshot`); the `URL.createObjectURL` blob-intercept captures downloads.

## Export → import validation (the .schem pipeline)
- `bun scripts/_schem_pipeline.ts <N>` exercises the REAL export
  (`extractIoModel`/`parseLDraw` → `synthesizeLSynth` → `voxelizeLDraw` →
  `encodeSchemBytes`) and BOTH importers (Upload-tab `web/src/engine/schem.ts
  parseSchemFile` AND CLI `src/schem/parse.ts`). Writes 20 `.schem` +
  `_report.{md,json}` to `output/schem-iter-<N>/` (refuses to overwrite — bump N).
- Real gaps it flags: errors, round-trip mismatches, unmapped colours, and
  footprint-aware missing-dims (it resolves the part's real `.dat` bbox, so
  sub-voxel flex/hose segments where 1×1×1 is CORRECT are not false-flagged).
- Baseline is clean: 0 errors, perfect round-trips, 0 unmapped colours.

## Renderer stress-test (dev only)
- Heaviest sets: 75192 UCS Falcon (7552 bricks), 10276 Colosseum (9060),
  71043 Hogwarts (5936). Copy `C:/git/clego/lego_sets/IO/<set>.io` →
  `web/public/inspect-*.io`, dispatch `change` on `#lego-mpd-input`, delete after.
- Measure via the dev hook `window.__ldrawViewer` (set ONLY under
  `import.meta.env.DEV` — **absent in prod**): `renderer.info.render.{triangles,
  calls}`, frame-time loop, `getModelSizeStuds()`, `missingParts`,
  `edgesDroppedForSize`. Let the post-load shadow rebuild settle (~1.5 s) before
  timing, or fps reads low.
- Known accounting: per-frame triangles ≫ mesh triangles because of edges +
  shadow pass; `memory.geometries` is a COUNT not MB. Edge LOD: hero sets keep
  full edges, only >3.5M-segment mega-sets drop (see CLAUDE.md). SAO is off for
  >80-mesh models and on mobile.
- Editing `viewer.ts` triggers HMR → disposes the viewer (`__ldrawViewer` stale):
  reload the page AND re-load the model before using the hook.

## Deploy ritual (every change)
1. EOL: the Edit tool sometimes writes CRLF into LF files — normalize touched
   files to match their git blob before committing (diffs blow up otherwise).
2. Gates: `bun run typecheck` + `bun run typecheck:web` + `bun run test`
   (1000+ offline tests; live-network tests gated behind `RUN_LIVE_TESTS=1`).
3. CI-mirror: `git stash -u` then typecheck the CLEAN tracked tree (catches an
   imported-but-untracked file — this exact bug once broke a deploy), pop.
4. `git fetch origin main` → confirm `merge-base --is-ancestor origin/main HEAD`
   (the clego-side agent also pushes here; stay FF) → push feat → push
   `feat/lego-set-tab:main` (deploy.yml gates typecheck+test+build, deploys
   Pages + CF Worker).
5. Watch: `gh run watch <id> --exit-status`. After: `PROD_SMOKE=1 bunx vitest
   run test/prod-smoke.test.ts` (5 checks: app shell, /ldraw-parts+CORS, OMR
   proxy, catalog).

## Prod testing (craftmatic.click) gotchas
- Clear the PWA SW first (`getRegistrations().unregister()` + `caches.delete`),
  then reload — it serves stale code otherwise.
- `window.__ldrawViewer` is ABSENT in prod → verify via the visible
  `#lego-status` text (brick count, dims, completeness note) + a screenshot, not
  the dev hook.
- Real prod flow: search → click result → `#lego-auto-load` (OMR → parts via the
  CF Worker from library.ldraw.org). `lego-thumbs/*.jpg` 404s are EXPECTED
  (gitignored thumbnail cache, not hosted) — cosmetic, ignore.
- `ldraw-parts/parts/*.dat` 404s for letter-named primitives are the resolver
  probing `parts/` before `p/`; `looksLikePrimitive` (parts.ts) should cover the
  family so it probes `p/` first (each wrong probe is a Worker→upstream hop).
