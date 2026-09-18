# Testing and browser automation

Read before validating renderer, resolver, alignment, or exporter changes. PDF-specific test harness requirements are in [PDF reconstruction](pdf-pipeline-guide.md); device QA is in [Bedrock add-ons](bedrock-addon-guide.md).

[Project guide](../CLAUDE.md). Paths in code spans are relative to the repository root unless explicitly qualified.

- Build: `bun run build:web`. Tests: `bun test` (vitest). LEGO unit tests are **offline + deterministic** — `test/ldraw-parser.test.ts` (transforms/steps/primitives), `test/io-zip.test.ts` (ZipCrypto + WinZip-AES decrypt, validated against Node's own crypto as an oracle — no large `.io` fixtures), `test/lego-colors.test.ts` (the don't-conflate-colour-systems invariant), and `test/ldraw-geometry.test.ts` (**geometry regression**: `resolvePartGeometry` triangle/edge/winding/transform signature, GPU-free via a mocked `fetch` serving synthetic `.dat` — the de-risked stand-in for visual regression). Export-side offline suites: `test/schem-pipeline.test.ts` (the shared export module's grid path — byte-identical to a direct encode, no re-voxelization), `test/schem-settings.test.ts` (resolution planning vs the legacy ladder as an oracle), `test/light-fill.test.ts` (sealed room lit / open porch untouched), `test/palette-lint.test.ts` (every emitted block id is a real Minecraft block), `test/schem-seeded-geometry.test.ts` (the seeded resolver short-circuits fetch and matches the networked bytes; per-part progress advances; geometry is independent of fetch timing). Prefer this pattern over the network-fetching `test/lego-pipeline.test.ts` (and the flaky live-API `test/import-*` tests). Two more from the 2026-09-08 audit: `test/part-cache-revision.test.ts` (persistent-cache identity + transitive geometry invalidation, over a fake IndexedDB that survives `vi.resetModules()` — the WARM-browser path, not an incognito one) and `test/schem-real-set.test.ts` (real set through the real export pipeline; skips without the local corpus).
## Manual gates (Chrome + the local corpus — deliberately NOT in CI)

Run these after touching the renderer, the part resolver, the LXF/alignment
path or the exporters. Each drives the REAL app in headless Chrome against
`bun dev:web`, so none of them can run on a CI box. Output lands in
`output/visual-fixtures/<date>/`.
- **`node scripts/lego-visual-fixtures.mjs`** — 4 fixtures (10316 headgear
  close-up, 71043 foundation/tower close-ups, 10182 official-OMR control, 21309
  rotated/SNOT control), each pinning its index path AND sha256/12 `hash`, the
  camera, explode 0 and all layers, with targeted numeric assertions (headgear
  seated on its head; only the 3 documented unmodelled moulds missing; assembled
  matrices restored after 0→100→0; a pinned rotation-profile baseline). **A
  corpus change FAILS the fixture** — re-baseline it deliberately, don't widen
  the tolerance. Exit non-zero names what moved.
- **`node scripts/lego-perf-baseline.mjs`** — cold/warm load, request counts,
  draw calls/triangles, heap, forced-composite time. Numbers +
  what-is-not-claimed: `docs/lego-perf-baseline-2026-09-09.md`. Works against
  prod too (`DEV_URL=https://craftmatic.click`), minus the in-page stats — the
  `window.__ldrawViewer` hook is DEV-only.
- **`node scripts/lego-export-validate.mjs`** — OBJ/STL/GLB byte-identity
  across explode 0→100→0, plus the OBJ bbox against 8 mm/stud. Byte identity is
  a WITHIN-run statement only: dev part resolution is nondeterministic.
- **`bunx vitest run test/schem-real-set.test.ts`** — the Minecraft half. Real
  set, real pipeline, cellLDU 20/10/8, bridging on vs off. Skips silently
  without the local corpus.
- **Kill stray dev servers first.** Three `vite` processes were running at once
  (4000/4001/4002) and `/` took 264 s to answer; after killing the extras it was
  0.1 s. A load-time or "model never finished rendering" result taken on that
  box is about the box, not the code — check
  `Get-NetTCPConnection -State Listen` and the CPU before believing one.
- **`python scripts/_mcaddon_check.py <pack>.mcaddon …`** — the cheap offline gate
  for "would Minecraft load this at all". A pack can satisfy every component count
  and warning the exporter prints and still fail silently in game: a geometry an
  entity names but the pack never defines, a texture path with no file, a
  behaviour pack that does not depend on its resource pack, a script `entry` that
  is not in the archive. Those cost a whole device round to find. Run it on every
  pack before a device round; it exits non-zero on failure. Verified 2026-09-18
  over the seven named-set packs (71043, 76435, 910004, 10326, 31201, 76405):
  8/8 valid. It does NOT check content — a pack can be structurally perfect and
  still show a headless minifig.

## Browser-automation testing caveats (claude-in-chrome — hard-won, saves hours)

- The automation tab runs **backgrounded → `requestAnimationFrame` is throttled/paused**. So **on-demand rendering means the canvas often has no fresh frame** and `Page.captureScreenshot` **times out — just retry it** (usually succeeds 2nd try). Continuous-render checks (live FPS) are unmeasurable here.
- **Enable the Stats checkbox to force continuous rendering** when you need reliable screenshots (it sets `animating=true`).
- **Editing `viewer.ts` triggers HMR which disposes the viewer → `window.__ldrawViewer` becomes null/stale.** After any viewer edit you MUST reload the page AND re-load the model before using the dev hook.
- **Synthetic pointer/wheel events don't reliably drive OrbitControls.** To move the camera, set it via the hook: `v.cameraAnim=null; v.controls.target.copy(...); v.camera.position...; v.controls.update(); v.composer.render()`. `v.setView('iso'|'front'|...)` works (it animates).
- **Verify the loaded model** (`window.__collect?.().length` or `viewer` brick count) — a 404'd `fetch('/inspect-X.io')` silently leaves the PRIOR model loaded (this mislabeled an audit once).
- Test models: copy `C:/git/clego/lego_sets/IO/<set>.io` → `web/public/inspect-*.io`, dispatch `change` on `#lego-mpd-input`, delete after (keep out of git). OMR `.mpd` fetch directly via `/ldraw-omr/<set>-1.mpd`.
- Dev-only `window.__ldrawViewer` is set in `viewer.ts` load() under `import.meta.env.DEV`.
- **A Playwright context MUST pass `serviceWorkers: 'block'` to load a set by SEARCH.** The PWA service worker installs on first load and then intercepts `/lego-models/*`; in a fresh automation context those fetches return `net::ERR_FAILED`, so the loader walks the entire source ladder and settles on *"No 3D model found — trying BL parts inventory"*. That reads exactly like a missing or broken index entry, and the same URL answers `200` to `curl`. `file:` mode hides it because the model never crosses the network. `scripts/_lego-probe.mjs` blocks them; any new script must too. Measured 2026-09-17, after two probe runs reported `{"error":"no viewer"}` against a set that loads fine.
- **`{"error":"no viewer","status":"1 set found"}` is a PRODUCTION STALL, not a
  broken set.** On `craftmatic.click` a cold set load reaches
  `Loading geometry: N/N parts (100%)`, freezes with the source badge stuck at
  `<src> · loading…`, and never renders: no failed request, no pending request,
  no console error. **A second click on the same card always loads it**, and the
  set renders identically to dev. Measured 2026-09-18: **7 of 18 sets** hung on
  the first pass (910047, 71043, 76435, 21063, 10341, 76286, 31141); a forced
  re-run cleared 6 of 7 in one round and the last in three. A 12-attempt
  single-set harness put the rate at ~45 % on prod versus 1 of 18 on dev. It is
  NOT set-specific — every one of the 18 sets loaded on prod when retried, with
  placements, source, arm counts and arm→torso LDU matching dev EXACTLY.
  So: never conclude "prod cannot render set X" from one probe run. Re-run with
  `bash scripts/_verify-sets-retry.sh <outDir> <rounds> <set>…`, which repeats
  only the sets that produced no positions dump.
- **Three benign artifacts appear on EVERY production page load.** All three
  were mis-read as the cause of the stall above; none of them is.
  `net::ERR_ADDRESS_INVALID` is Cloudflare's analytics beacon (the probe already
  filters it). `net::ERR_ABORTED …/ldraw-parts/parts/3001.dat` is the panel's own
  `HEAD` capability probe (`web/src/ui/lego.ts`): Chrome reports the discarded
  body as a request failure while `fetch()` still resolves `ok` — measured
  10/10 on prod AND 3/3 on dev, with direct-render enabled every time. The two
  `404`s are `/lego-thumbs/<set>-1.jpg`: those 23,711 thumbnails are 8.5 GB and
  git-ignored, so they exist in dev and never deploy; the `onerror` handler falls
  back to the Rebrickable CDN url.
- **`/ldraw-parts/*` behaves differently on prod and it is expected.** Printed and
  unofficial parts that are not in the R2 mirror are relayed to
  `library.ldraw.org`, which throttles a cold big-set load; the worker relays
  that as `503 no-store` so the client retries instead of caching a miss.
  Measured on a 10303 prod load: 91 of 200 individual part fetches returned 503
  and the model still rendered all 3,808 placements. Dev serves those from disk,
  so a dev run never sees them.
