# LEGO model sources and parts library

Read before changing part resolution, source selection, quality gating, model-index metadata, or corpus refresh/publishing. Deployment routes are in [deployment](deployment-guide.md).

[Project guide](../CLAUDE.md). Paths in code spans are relative to the repository root unless explicitly qualified.

## LDraw parts library — DEV vs PROD (critical)

The 3D renderer needs individual `.dat` geometry from `/ldraw-parts/*`.
- **DEV**: served by a Vite middleware in `web/vite.config.ts` from a local clego
  install (`C:/git/clego/extracted/studio_release/app/ldraw`, ~1.8 GB / 67k files),
  falling back on a local miss to the **prod worker's R2 mirror**
  (`craftmatic.click/ldraw-parts`) and only then to `library.ldraw.org`. The
  local install is a frozen Studio snapshot (**LDraw release 207**: 12,136
  official parts vs upstream's 24,737), so every mould released since 2020
  misses locally — going to the mirror first keeps dev coverage equal to prod
  without paying library.ldraw.org's throttling. A
  `FORCE_UPSTREAM` const (default `false`) bypasses local to mirror prod exactly.
  The fallback only caches a null on a DEFINITIVE upstream 404 (thrown fetches —
  throttling during a load burst — retry instead; concurrency capped at 6).
  Caching nulls on transient failures turned existing parts (73111 …) into
  permanently missing pieces for the whole dev session — don't reintroduce.
- **PROD**: the Cloudflare Worker (`worker/ldraw-omr.js`) serves `/ldraw-parts/*`
  **R2-FIRST** from the `lego-models` bucket (keys `ldraw/<relpath>`, LOWERCASED
  — R2 keys are case-sensitive and `normId()` lowercases every request; mirror
  maintained by `scripts/sync-ldraw-r2.mjs`), falling back to
  `library.ldraw.org/library/{official,unofficial}/*` for unsynced keys.
  Routed in `wrangler.toml` (`craftmatic.click/ldraw-parts/*`) with the R2
  binding `MODELS`. **Must `bunx wrangler deploy` to publish.** Without this
  route the deployed app has NO geometry and silently falls back to voxelization.
  **Why R2-first (prod incident 2026-08-17):** library.ldraw.org rate-limits
  cold big-set bursts (even `stud.dat` 503'd); worse, the worker's old blanket
  `cacheTtl+cacheEverything` EDGE-CACHED those failures for a week, so
  thousands of real parts read "missing". Rules now: `cacheTtlByStatus`
  (successes 1w, 404s 5min, errors 0), upstream throttle → 503 `no-store`
  (never a cacheable 404), one in-worker retry; client treats only 404/410 as
  definitive (`parts.ts`), and part-prefetch concurrency is 12.
- **Keeping the mirror CURRENT (2026-09-02).** The original seed was uploaded
  from the Studio-bundled library, i.e. LDraw release **207** — so R2 was five
  years stale and ~18k modern parts existed only behind the throttled upstream
  fallback. `scripts/sync-ldraw-r2.mjs` was rewritten to pull the **upstream
  release archives** (`updates/complete.zip` + `unofficial/ldrawunf.zip`) and
  upload a **stateless delta**: the R2 list API returns each object's etag
  (= content MD5 for single-shot PUTs), so new/changed files are computed by
  comparison — no done-file, no committed manifest, a missed run self-heals.
  New files upload first (a hole in the render beats a relicensed header).
  Uploads go through the **R2 REST API** with `CLOUDFLARE_API_TOKEN` (the
  deploy secret already has R2 write), ~300-600 files/min; keys present only in
  R2 are never deleted. `.github/workflows/sync-ldraw-r2.yml` runs it weekly.
  Verify coverage without a browser: `node scripts/check-missing-parts.mjs
  --recent 10` (or `<set> …`), which replays the client's candidate paths +
  alias ladder against prod or a local library.
- **Design-id ≠ LDraw part name.** Mecabricks-lineage models write LEGO's
  CURRENT design id; LDraw names a mould by its first/BrickLink-canonical
  number and never renames it. For re-tooled families the two share no digits
  (`42923`→`63868`, `44860`→`60897`, `26169`→`4865b`), so nothing resolves and
  no suffix rule can help — the mapping is DATA, in
  `web/src/engine/ldraw-part-aliases.ts` (every entry verified against the
  target `.dat`'s own description). Above it, `partAliasCandidates()` in
  `parts.ts` strips ONE suffix group per hop — lettered mould revisions
  (`6538c`→`6538`), decorations/versions (`3626d1024`, `30367v2`), prints
  (`98138pb042`→`98138`) — and chains (`u9132v1d1`→`u9132v1`→`u9132`).
  Measured over 6,325 tier-1 corpus `.ldr` files: 1,323 of 2,639 orphaned names
  = 20,289 of 39,081 placements recovered. Every candidate is verified against
  the library before use and the hop only runs after a DEFINITIVE miss, so a
  bad guess costs a lookup, not a wrong render. **The base must end in a digit**
  — without that guard the print rule shreds primitives (`stud4`→`stu`), which
  would substitute nonsense inside every part referencing them (test pins it).
  Substitutions are recorded in `substitutedDatNames` → `viewer.substitutedParts`
  → a LEGO-status note, so a near-mould swap is never silent. Tests:
  `test/part-alias.test.ts`.
- **Wrong-FRAME mappings belong in clego's harvester, never in the client
  alias table** (settled 2026-09-09, MB_TRANSFORM_AUDIT.md §11). The former
  "genuinely unmodelled" trio was superseded corpus-side: `20926`/`20932` map
  to `3816`/`3817` with a measured (0,24,0)-class delta, `1000337–1000341` are
  the 37341 sprue's lettered parts, and `98560` → `3684c` (631 placements /
  124 sets) — 21 mappings / 1,839 placements landed via `mb_partmap` +
  `mb_align` deltas at harvest, 38 sets DEFECTIVE→PASS, zero regressions.
  The client-side table is FILENAME-ONLY: adding any of these there would
  place the part 24–72 LDU out. If the census surfaces a new confirmed
  identity whose frame differs, route it to clego, don't alias it here.
- **Corpus hole rate is 0.067%, and it is almost entirely ONE source class**
  (census 2026-09-09, `scripts/missing-geometry-census.ts`, 214 sets / 80
  flagships + 20 per class, 564k placements): 379 missing pieces / 111 distinct
  names. `omr`, `io`, `dbix_conv_v2/v3`, `recon_v3`, `pdf_recon`, `recon_v8` and
  `lxf` are **clean (0)**; `mecabricks` + `mecabricks_search` carry 369 of the
  379, `eurobricks` 8, `ldr` 2. The deep pass (walk every resolved part, check
  ITS sub-file refs) found **0 unresolved sub-file names** — the "silent hole"
  class is empty. So do not go looking for a broad missing-geometry problem:
  what remains is a Mecabricks design-id ↔ LDraw-name mapping tail.
- **A ghost-box placeholder for a missing part is NOT derivable — don't build
  one.** Evaluated 2026-09-09 against the census: of the 111 unresolved names,
  exactly **1** (`98560`) has a real entry in `ldraw-part-dims.ts`; the other 110
  (338 pieces) fall through `getPartDims` to the 1×1×1 DEFAULT, so any box drawn
  for them would be an invented size. Same rule as substitution — fabricated
  geometry is worse than a hole. (`98560` is not an argument for the box either:
  it maps to a real mould and wants an alias row.)
- **The R2 mirror is a SUPERSET of upstream — verify misses against prod, not
  against the release archives.** R2 was first seeded from the Studio-bundled
  library and `sync-ldraw-r2.mjs` never deletes, so prod still serves parts the
  current `complete.zip`/`ldrawunf.zip` do not ship: every `bl_*` Studio
  synthetic (`bl_24246pb057` — 144 placements in 21063 alone) and legacy
  "Needs Work" moulds like `3814`. Measured on the census sample: **489 of 683**
  names absent from the release archives resolve fine on the mirror. A census or
  checker run against archives alone therefore invents holes; the census resolves
  offline in bulk and re-checks every miss against prod for exactly this reason.
  (Corollary: `ldraw-part-aliases.ts`'s note that `bl_*` names are uncovered is
  true of the ALIAS LADDER but not of prod resolution — they resolve directly.)
- **`_batch` sheds load under sustained bursts.** It returns the full TEXT of
  everything it finds, so a wide burst makes the Worker do real work and
  Cloudflare answers 503 (reproduced: 6 parallel 48-path batches → one 503).
  A 503 is indistinguishable from an absent part, so any offline tool must treat
  exhausted retries as FATAL rather than as misses, and must commit in slices.
- `library.ldraw.org` serves individual parts but sends **no CORS header** — must
  be proxied; cannot fetch from the browser directly. Official layout:
  `/library/official/{parts,p,parts/s,p/48}/<stem>.dat`.
- **Batched part fetch (2026-08-29)**: `parts.ts` micro-batches concurrent
  `fetchDatText` calls (20 ms window / 48 names) into ONE
  `/ldraw-parts/_batch?files=…` request (worker: ≤64 R2 keys in parallel,
  official+unofficial checked per name; dev: vite middleware mirror).
  Measured: cold UCS Falcon fetch phase was 4+ min via per-path probing
  (429 parts × ≤8 candidates × retries, 10-29 s single-part stalls);
  Concorde cold in dev = 5 batch requests, 0 individual, 4.3 s. Endpoint
  failure ×2 disables batching for the session (falls back to probing).
- **Models + index are SAME-ORIGIN through the worker** (2026-08-29):
  `/lego-models/*` and `/lego-models-index.json` routes → R2 binding. The raw
  `pub-*.r2.dev` domain serves bytes UNCOMPRESSED and off-zone; the worker
  path gets edge brotli/gzip (index 2.4 MB → 331 KB, .ldr ~5×) + edge cache.
  `MODELS_BASE = '/lego-models'` in both dev and prod; r2.dev is only the
  index fallback. **`buildStepGroup` is async + time-sliced** (yields ~24 ms,
  bails on stale loads, streams "placing bricks / building meshes / building
  edge outlines" into the warp overlay) — it used to freeze the main thread
  after the fetch hit 100% (Page-Unresponsive kills = the "crash between
  100% and display" class).
- **`#` in a filename is a THREE-WAY encoding contract** (prod incident
  2026-09-03, clego SOURCES.md §5b): client percent-encodes per segment
  (`encodeModelPath` in lego.ts / candidate paths in parts.ts), the worker
  DECODES before the R2 lookup (both `/lego-models/` and `/ldraw-parts/`), and
  the SYNC must percent-encode the key it PUTs. `wrangler r2 object put
  <bucket>/<key>` does NOT — the `#` opens a URL fragment and the object lands
  under a TRUNCATED key (`…/31378_step #cr.ldr` → `…/31378_step `), which
  `wrangler r2 object get` reads back identically, so the CLI looks healthy
  while prod 404s (96 index paths / 20 sets / 9 primary picks; dev was fine
  because Vite decodes `req.url`). Distinct files can truncate to the same key
  = silent data loss. Fixed on the sync side in BOTH mirrors
  (`scripts/sync-ldraw-r2.mjs`, clego `sync_models_r2.py` → R2 REST API for
  such keys). Guarded by `test/prod-smoke.test.ts`. Never diagnose this with
  `wrangler r2 object list` — only the R2 REST list shows the real key.
  **`%` is the same bug in disguise**: 8 corpus names contain a literal `%23`
  (`IO/42181-size%231.io`); wrangler sent it raw, the API DEcoded it, and the
  object landed under `…-size#1.io` — wrong key, same 404 (42181's primary
  pick). Any key with `#`, `?` or `%` must go through the REST API encoded.
- Parts that never resolve (a few set-custom OMR subparts like Red Baron
  `s100241`) are surfaced in the LEGO-tab status + console via
  `viewer.missingParts` — not silent. Sub-file refs that resolve nowhere (parent
  still renders, with small gaps) are surfaced separately via
  `viewer.unresolvedSubparts`.

## Source-quality gating (visual-QA 2026-07-20 — the renderer was never the problem)

A 12-set visual QA (real WebGL captures, `output/visual-qa-*/`) showed every
"broken-looking" render traced to **LXF-lineage source data**, not the renderer:
`Author: convert_lxf.py` LDRs carry raw LDD material-id colors + no per-part
alignment (10255 → stacked buildings, 1924 → exploded ferry decks, 8849 →
ghost tires). Pipeline defenses (classifier extracted to
`web/src/engine/source-quality.ts`, offline-tested in
`test/source-quality.test.ts`; `lego.ts` imports + wires the warnings):
- **`io_model2_v2` placements were re-based against the LDraw library origin
  (published 2026-09-18, clego `a20ad7ab`/`0fd849f4`).** Studio `.io` files inline
  their own part meshes; for 178 part ids Studio's mesh and the library's sit in a
  DIFFERENT FRAME (14 of them also turned), so dropping the embedded definition and
  referencing the library part rendered those placements up to 22 studs out. The
  oracle is free and in every archive: `model.ldr` names library parts for the same
  placements `model2.ldr` inlines, and corrected placements land **0.00 LDU** from
  what it renders (8–51 LDU before). Worst corner error over all 5,503 moved
  placements **420.88 → 6.09 LDU**; 398 of 798 archives changed, the other 400
  byte-identical. Residual, stated not hidden: four near-symmetric ids (`35186` ×81,
  `5443` ×2, `35473` ×5, `4526` ×14) tie their best and runner-up rotation to within
  1.6 %, so the gate abstains — they are translated correctly and may face the wrong
  way, which beats being 8–144 LDU out of place.
  **Nothing about this changes a PRIMARY pick**: `IOModel2V2/*` is an entry for 598
  sets and `models[0]` for **zero** of them (measured on the 2026-09-18 index, before
  and after the regen), so it is the fallback/source-picker render that improves, not
  the default one. Don't quote this correction as a fix to what a set loads by default.
- **`mecabricks` placed every minifig wrong, two ways (fixed 2026-09-18, clego
  `5810501d`).** It is the largest source — 2,694 index entries — and the defect was
  user-visible: **1,541 of those 2,724 sets carry a `3814`-family torso (4,603
  torsos) and every one of them exported a Bedrock add-on with HEADLESS figures.**
  1. **The torso resolved to the wrong part.** `geograde/mb_partmap.py` consulted
     `_exists` BEFORE its design map, so design id `3814` hit Studio's *unofficial*
     `3814.dat`, "MINI UPPER PART (Needs Work)" — an LDD stub whose origin is on the
     bottom plane and 10 LDU off-centre. The geometry landed correctly but the ORIGIN
     sat (10, +32, 0) from where a `973` origin does, so every offset measured against
     it was 32 out. Heads read dy −56 instead of −24, which is outside
     `groupFigures`' dy −48..+80 window (`ldraw-entity-compiler.ts`) — hence the
     missing heads. Fix: map `3814`→`973` and consult the map first.
  2. **The arm rows had the wrong orientation.** 95.8 % of arm placements carry ref
     `3818v2`/`3819v2`, whose learned row is a Y↔Z swap at fit 0.6162 — because
     `compute()`'s orientation search scores each candidate only at its own bbox
     delta, and **identity at delta 0 scores 0.7114 and is never tried**. A solve over
     400 scenes / 956 arms gives delta (0.02, 0.38, −0.15), IQR < 0.4 LDU: the raw
     Mecabricks arm origin already IS the LDraw shoulder. Those four rows are now `gt`
     rows, because no mesh re-fit can derive them (the v2 mesh models the forearm ~40°
     forward of LDraw's).
  **Measured over the re-harvested corpus** (`geograde/_mb_arm_probe.py`, 3,467 files
  / 11,788 arms): arm-to-torso median **32.37 → 18.33 LDU**, within [14,21]
  **19.1 % → 95.1 %**; the search sibling 35.2 % → 95.9 %. Gate
  (`mb_gt_cohort.py --kind io` vs `mbgt_v5fix`): exact match COUNT **2,812 → 2,908**,
  no set losing any — read the count, not the rate, because mapping 3814→973 grows
  the matched denominator. Part-name resolution is unchanged (0.85 % unresolvable
  before and after), so the remap opened no new holes.
  **Residual, separate defect:** 55 of 2,002 arm-bearing files (2.7 %) have no
  resolvable torso — decorated refs `973j`/`973aq` … that LDraw names `973pNNN`,
  emitted verbatim, plus `2550` falsely hitting "Animal Monkey Body". After that,
  hands `3820v2` sit ~12 LDU off the LDraw wrist.
- **Two rows of the LDD→LDraw correction table are wrong, and the obvious fix
  for them is ALSO wrong (settled 2026-09-17).** clego's learner writes, per
  design, the MODE of that design's correction votes plus `agree`, the fraction
  of the vote mass the mode won, and a `sets` field that counts COMPETING MODES
  rather than sets. `3818` (minifig left arm) shipped t = (1, 112, 140) at agree
  **0.044** and `3819` t = (607, 111, −136) at **0.043**, so every minifig arm in
  every `.lxf` that fell back to the table AND in all 2,302 `dbix_conv_v3` files
  stood tens of studs from its shoulder. **An arm sits 17–18 LDU from its torso
  in authentic OMR files** — that constant is the cheapest check that a minifig
  is assembled, and it is what both fixes are measured against.
  **Do not replace the two-row list with an `agree` threshold.** It was built and
  measured twice and it is wrong: a low `agree` does not mean the measurement is
  noisy, it means the correct correction is CONTEXT-DEPENDENT, so the disputed
  mode still beats the ldraw.xml fallback for many designs. geograde big-floating
  parts, converted-only: 41713 **63 → 372** and 4002021 **73 → 372** under
  `agree < 0.30`; even `agree < 0.10`, which admits seven rows, leaves 4002021 at
  370. Corpus-wide the 0.30 gate made 35 sets worse, and a blunt `agree >= 0.5`
  cost 2.61 points of weighted GEO over a 29-set ground-truth cohort.
  **Nor invert the ldraw.xml prior globally.** Studio's row is the transform that
  carries the LDraw part onto the LDD part, so composing a bone with it needs its
  inverse, and that is why `web/src/engine/lxf-parser.ts` applies it inverted
  (forward 13.3 % GEO, inverse 93.6 % on 10242). But the dbix converter reaches
  ldraw.xml only as a biased tail, and flipping it corpus-wide has victims —
  43226 grades 0 big-floating forward and **153** inverted. It is inverted for
  the two arm designs only, where forward leaves the arm at 54.7 LDU and inverted
  at 18.1.
  Result, proved by regenerating the corpus twice (`DBIX_DROP_LEARNED=` reproduces
  the old bytes exactly): **1,043 files identical, 1,259 differing ONLY in
  3818/3819 lines, 0 differing anywhere else**. Over 1,257 files / 8,734 arms the
  arm-to-nearest-torso median goes **327.5 → 18.1 LDU** and the count within
  25 LDU goes **6 (0.1 %) → 8,712 (99.7 %)**.
- **The MINI-DOLL moulds are the one place where NEITHER correction table has an
  answer, and a third rule fills it.** The learned/measured table has zero doll
  rows and always will (0 of the 173 ground-truth sets contains a mini-doll
  torso), and the five doll moulds Studio's `ldraw.xml` names are all-zero rows,
  so a Friends doll came out at its raw LDD bone: hips ON the torso, head 50 LDU
  up instead of 33.20, arms 20 instead of 11.00. Craftmatic's loader now applies
  `MINIDOLL_SLOT_CORRECTION` (six per-SLOT vectors, clego `dbix_figure_align.py`)
  AFTER both tables and ONLY where the row that named the file corrects nothing,
  so the ldraw.xml-inverse-primary / measured-fallback order above is unchanged
  for every other part. The doll skeleton shares NO number with the minifig's
  (24 / 18 / 32 against 33.20 / 11.00 / 29.42) — never reuse one for the other.
- **`0 !LINEAGE <tool> <good|partial>` is the CANONICAL stamp** (clego
  converters emit it since 2026-08-28) and takes precedence over all legacy
  sniffs — the v2 DBIX reconverter's files also start with `0 LEGO DBIX v2`,
  which the legacy regex alone would misread as the warn-class. `good`→good,
  `partial`→approximate. Companion markers: `0 DBIX MULTIMODEL UNPLACED`
  (synthetic side-by-side layout → approximate + explicit caveat) and
  `0 DBIX FLOATING CLUSTER n=<k> gap_ldu=<g>` (authored mid-air parts, e.g.
  60502's airplane — informational note so users don't report it as a bug).
- `reconstructionQuality()` legacy sniffs: `convert_lxf.py` / `DBIX_LXFML`
  headers → 'broken'; un-stamped `0 LEGO DBIX` / `download_dbix_lxfml.py` →
  **'dbix'** (= legacy v1 conversions: dropped parts + lost sub-assembly
  transforms; superseded by `dbix_conv_v2` for ~2.1k sets). `sourceCaveat()`
  maps class+markers → the user-facing warning at every load path.
  NOTE (corrected 2026-08-28): the earlier claim that 72153's upstream LXFML
  "lacks the separation" was WRONG (a double-counted bone probe) — the clego
  v2 reconverter recovers all three Pokémon properly separated; genuine
  multi-model collapse exists in only 5 sets, marked MULTIMODEL UNPLACED.
  TASKS-FROM-CRAFTMATIC items #1–#6 are all DONE upstream (v2 sources:
  `dbix_conv_v2` 2,119 · `io_model2_v2` 790 · authentic `io` 896 entries).
  (A color-palette fingerprint was tried and REMOVED — dead code:
  `LDRAW_COLOR_RGB` already contains the extended ids like 10047/10070, so
  table-membership can't discriminate; origin-collision and volume-per-brick
  collapse metrics also proven non-discriminating. Don't re-add.)
- **Indexed auto-load iterates sources**: broken entries throw → next indexed
  source → classic OMR chain. 8849 now lands on its official OMR file (solid
  tires) instead of the gated conversion. Explicit source-picker choices pass
  `allowBroken` and load anyway, labelled.
- **`currentSourceWarning`** (reset by `newLoadEpoch()`): load paths set it and
  `voxelizeAndDisplay` appends it to the FINAL status — a plain setStatus()
  before display is silently clobbered by the render-success status (this hid
  every quality warning until the visual QA caught it).
- **Load-epoch token**: every load initiator (upload / indexed / OMR chain)
  bumps `loadEpoch` and bails at await-points if stale — a slow earlier load
  can no longer overwrite the user's newer selection. autoLoadFromOMR also
  falls through on transient OMR fetch errors (used to rethrow → skipped both
  fallbacks and stranded the button disabled) and re-enables its button in
  `finally`.
- **Known residual (data-bound, needs upstream index metadata)**: laundered
  conversions with no headers — 10255's ".io" is convert_lxf output repacked
  (all 3 entries identical, LDD colors) and its `Reconstructed/*_reconstructed
  .ldr` mirrors it. Text-level detection is impossible client-side; the model
  index (clego-generated) needs lineage/authenticity ranking.
- **A floating ACCESSORY on a mecabricks-lineage model is an upstream per-mould
  FRAME error — fix it in clego, never in the renderer (2026-09-09, audit P0
  #1).** 10316 Rivendell's five elf hairs (`10055`) sat 60.5 LDU above their
  heads; 40239 52.0, 92083 35.5, 10048 22.5. Craftmatic was measured innocent:
  `substitutedParts` empty, `unresolvedSubparts` empty, no alias hop, and the
  offset was CONSTANT IN THE HEAD'S LOCAL FRAME across every rotation and every
  instance — the signature of a per-mould source error, not an instance,
  renderer or alias fault. Root cause was `geograde/mb_align.py`'s NO-MESH
  fallback (7,696 mecabricks meshes are CDN 404s) assuming the mecabricks
  "origin on the bottom plane" convention for a part whose LDraw origin is
  INSIDE its geometry. Fixed as MB_ALIGN v5 (clego `772252b3`); corpus
  regenerated + republished. **The ground truth to check against**: LDraw's
  convention is that HEADGEAR ORIGIN == HEAD ORIGIN, i.e. the head-local offset
  is (0,0,~0) — verified over 100+ OMR instances (30210, 9469, 9470, 10224 …),
  and corpus-wide the OMR median local `dy` is 0.00 for every such mould. A
  quick scan of headgear-vs-head local `dy` in any flat `.ldr` is therefore a
  cheap, sharp detector for this whole class.
- **`bridgePartContacts` in the VOXEL path cannot fix a source float, and never
  hid one.** It only bridges gaps smaller than half a cell (pure quantization
  error). Measured on the 10316 elf: with the hair 60.5 LDU out, bridging added
  **0 cells** — grids byte-identical with and without it — at cellLDU 4/5/8/10/20.
  Don't reach for a voxel-side contact patch to explain or fix a direct-render
  placement defect; they are separate pipelines (`voxelizeAndDisplay` bypasses
  voxelization entirely in 3D-render mode).
## Offline reference data (for the analysis scripts; in `C:/git/clego`, dev-only)

- **LDraw part library** (real `.dat` geometry): `extracted/studio_release/app/ldraw` (`parts/`, `p/`, `p/48/`, `parts/s/`).
- **LDCad shadow library** (SNAP metadata, 4255 `.dat`): `ldcad/unpacked/offLib/offLibShadow.csl` (a zip). Acquired from melkert.net LDCad 1.7 `shadow.sf` (zip → `offLibShadow.csl` zip). Snap format: `0 !LDCAD SNAP_CYL [gender=M|F] [secs=R <radius> <len>] [pos=...] [ori=...] [grid=...]`. Studs y=0 (M), anti-studs y=24 (F) in part space.
- **Mecabricks parts**: `mecabricks_parts/geometries` (810 high-fidelity meshes) + `configs` (857; `geometry.extras.knobs`=studs, `tubes`=anti-studs, 456 populated). NOT used — LDraw already covers all parts; Mecabricks is a higher-fidelity SUBSET in ~2.5×-LDU Y-up coords. Only worth it for Mecabricks-grade fidelity (big lift, partial coverage).
- `.io` AES decrypt (for offline model loading): WinZip AES-256, pw `soho0909`, PBKDF2-HMAC-SHA1 1000 iters, little-endian CTR (see `scripts/ldcad_connectivity.py` `read_io`).
## Model index schema 2 — MEASURED assembly metadata (2026-09-09)

`lego-models-index.json` (built by clego `build_model_index.py`) stamps every
`models[]` entry with geograde's verdict for **that file**, additively:
`asm` `'verified'|'defective'`, `sev`, `defects[]`, plus `lineage` (the file's
own `0 !LINEAGE <tool> <good|partial>`) and `hash` (sha256/12 of the bytes).
Root gains `schema: 2` and a `geograde` block (scoreboard timestamp, thresholds,
graded/stale counts). **`asm` ABSENT = unverified = NOT MEASURED, never a
defect** — 2,749 grades were dropped on the first build because the file was
re-emitted after grading (the scoreboard keys by path and records no hashes, so
mtime > scoreboard time ⇒ ungraded). Cost: index 2.44→3.55 MB raw, 331→533 KB
brotli, mostly the per-entry hashes.
- **Ranking** (`engine/lego-sources.ts` `verifiedPromotion`, above the existing
  conv demotion): a graded-PASS entry displaces a graded-**DEFECTIVE** first
  pick only. Guards that must stay — an *unverified* incumbent is never demoted;
  the candidate must be non-conv, in a same-or-better `sourceClass`, retain
  ≥95 % of the incumbent's placements, and not grade worse on severity.
  Measured: 145/10,092 sets change, none across a class boundary. **The
  unguarded "first verified wins" rule moved 360 sets and promoted a vision
  reconstruction over a conversion 34 times** — a recon can pass simply by
  reconstructing less. Don't loosen it. Worked example: 10365 dbix_conv_v3
  (defective, 60 big-floating) → dbix_conv_v2 (PASS) at the same 2,891 parts.
- **Intended vs actual**: `loadDiag` in lego.ts records the try-order's intent,
  every source the chain walked past + why, and what rendered. Badge shows the
  LOADED source (`⚠ fallback` when it isn't the intended one, trail in the
  tooltip); the status carries a one-line reason. `⤓ diagnostics`
  (`ui/lego-diagnostics.ts`) downloads the reproduction bundle — source
  URL/hash/lineage/verdict, index+geograde provenance, mapping sizes,
  missing/substituted parts, render state, last contact audit.
- **Publishing**: regen (`python build_model_index.py`) then
  `python sync_models_r2.py --only <paths…>` from clego — with **no** `--only`
  args it uploads just the index. A fresh regen picks up corpus files added
  since the last publish, so upload those too or prod 404s on them (92 new
  MecabricksLDR models on 2026-09-09). Verify by reading the index back through
  the worker, not from the done-list (`_r2_uploaded.txt` is a stale resume
  marker — 2,157 paths it omits are actually in R2).
## Source freshness (new sets over time)

Two halves, split by what can run without the local corpus. See
`clego/SOURCES.md` for the full channel audit.
- **CI** — `.github/workflows/refresh-sources.yml`, weekly: `prebuild:lego`
  (Rebrickable → `lego-catalog.json`, gitignored, so a new set is searchable),
  `prebuild:omr` / `prebuild:seymouria`, then `scripts/source-freshness.ts`,
  which measures the gap the catalog refresh CANNOT close: fresh catalog ∖
  published model index = sourceless, intersected with the live DBIX skulist +
  OMR list = *harvestable today*. Commits `source-freshness.json` (timestamped,
  so it always commits — that push is what triggers `deploy.yml` and gets the
  fresh catalog to prod).
- **Local** — `clego/discovery/refresh_local.py --run`: refresh `sets.csv`,
  diff the DBIX skulist and harvest+convert what's new, geograde it, rebuild
  `lego-models-index.json` FRESH, publish scoped to R2 (`sync_models_r2.py
  --only`; an unscoped sync uploads another agent's in-progress corpus).
- **Why it exists (40975-1)**: the catalog refreshes every deploy, the model
  index is generated by hand from a 1.8 GB local corpus, so a 2026 set was
  searchable with zero sources — and its DBIX model had existed upstream all
  along (the harvest was 92 SKUs stale). Search freshness ≠ model freshness.
- **`#` in a model FILENAME is unfetchable in prod** (found 2026-09-02, NOT yet
  fixed): the R2 object uploads and `wrangler r2 object get` reads it, but the
  worker's `/lego-models/` handler 404s for every encoding (`%23`, `%2523`,
  `+`) while the same key with a space serves 200. Dev is fine — the Vite
  middleware decodes `req.url` itself — so it is invisible until you check
  prod. 96 index paths carry it (DBIX `_step #kh.ldr` naming) across 20 sets, 9
  as their primary pick. Repro + the two candidate fixes: `clego/SOURCES.md`
  §5b. **Verify any R2 publish by reading the keys back through the worker** —
  `wrangler r2 object put` also returns 429 under concurrency, so "Upload
  complete" is not proof (and urllib's default UA gets 403 from the edge, so
  set one or every object looks missing).

## Known gaps — a corpus-wide census (2026-09-19)

What is wrong with the corpus, counted rather than described, so a fix can be
aimed at a class instead of at whichever set someone happened to open. Two
different questions are answered separately because they give different answers
and only one of them is what a user sees.

### 1. Missing part geometry — the renderer's answer, not the grader's

`scripts/missing-geometry-census.ts` replays the RENDERER's own resolution
ladder (it imports `partAliasCandidates`, so it cannot drift from the app) over
a stratified sample of primary picks. 2026-09-09, 214 sets, 588,196 part
references:

| source class | sets | with >=1 hole | refs | missing refs | missing ids |
|---|---:|---:|---:|---:|---:|
| io | 32 | **0** | 155,733 | 0 | 0 |
| dbix_conv_v3 | 25 | **0** | 86,507 | 0 | 0 |
| omr | 19 | **0** | 56,267 | 0 | 0 |
| recon_v3 | 19 | **0** | 22,835 | 0 | 0 |
| pdf_recon | 18 | **0** | 31,948 | 0 | 0 |
| lxf | 19 | 1 | 24,103 | 1 | 1 |
| ldr | 19 | 2 | 48,584 | 2 | 2 |
| eurobricks | 19 | 6 | 19,220 | 8 | 6 |
| mecabricks_search | 10 | 6 | 20,933 | 64 | 40 |
| **mecabricks** | 31 | **22** | 120,676 | **305** | 69 |
| TOTAL | 214 | **37 (17.3 %)** | 588,196 | 380 (0.065 %) | — |

**The count is meaningless without its concentration: 28 of the 37 affected
sets are `mecabricks`/`mecabricks_search`**, and every one of the five
highest-tier classes is clean. `subHoles` is empty — no part resolves and then
renders with a hole inside it. The dominant verdict on the missing ids is
`missing:designid`: a Mecabricks design id with no LDraw part behind it.

**The GRADER's "unknown parts" is a different, larger number and must not be
quoted as this one.** geograde resolves against a frozen local Studio snapshot,
so it reports >=1 unknown id on **1,813 of 9,425 graded picks (19.2 %)** while
the app, which also has the R2 mirror and upstream, resolves them. Measured on
the 15 sets below: 26 grader-unknown placements, 0 renderer-missing (910049 is
the only exception — 3 genuinely missing ids, plus 38 decorated variants that
correctly render as their plain mould).

### 2. Geometry defects across the primary picks

Every set's `models[0]`, joined to the 2026-09-03 exhaustive grade.
**9,425 of 10,169 picks (92.7 %) have a grade**; the 744 without are
concentrated in `EurobricksLDD` (172, all), `EurobricksTopicLDR` (158, all),
`MecabricksLDR` (159 of 2,694), `Reconstructed` (103) and `DbixConvV3` (97).

| gap | picks | share |
|---|---:|---:|
| Floating pieces (>=1) | 3,942 | 41.8 % |
| ... >=3 % of parts float | 1,885 | 20.0 % |
| Big floating cluster (>=1) | 1,120 | 11.9 % |
| Sunk below the floor (>=1) | 2,584 | 27.4 % |
| Overlapping pieces (>=1 part) | 2,109 | 22.4 % |
| ... >=1 % of parts overlap | 950 | 10.1 % |
| Missing part geometry, grader's frozen library (>=1) | 1,813 | 19.2 % |
| ... >=1 % of placements unknown | 727 | 7.7 % |
| Under-placed vs catalogue (ratio < 0.95) | 1,255 | 13.3 % |
| ... severe (< 0.80) | 596 | 6.3 % |
| Duplicate placements (>=1) | 328 | 3.5 % |
| World-floor outliers (>=1) | 1,736 | 18.4 % |
| Clean on every check above | 1,409 | 14.9 % |

Two rows are deliberately NOT in that table because they are not defects:
"split into more than one connected component" (74.4 %) and "side-model
clusters" (61.1 %) both fire on a minifig standing beside a build, which is
what a staged capture looks like. geograde exempts them for that reason, and
`dbix_polish` was gaming the exemption until 2026-09-19.

By source, the same checks (the concentration is the point — the three
converted classes carry almost all of it):

| source | picks | float | BIG float | unknown | overlap | sunk | split |
|---|---:|---:|---:|---:|---:|---:|---:|
| MecabricksLDR | 2,535 | 27.3 % | 10.9 % | 42.3 % | 18.0 % | 11.6 % | 68.2 % |
| ReconV3 | 2,118 | 55.9 % | 12.7 % | 0.9 % | 38.1 % | 51.3 % | 78.1 % |
| DbixConvV3 | 1,608 | 63.1 % | 13.1 % | 16.7 % | 23.3 % | 36.4 % | 99.9 % |
| OMR | 963 | **6.0 %** | 0.9 % | 9.3 % | 2.1 % | 7.1 % | 41.4 % |
| LDR | 788 | **6.5 %** | 1.6 % | 11.4 % | 9.5 % | 12.8 % | 56.7 % |
| EurobricksLDR | 640 | 92.0 % | 39.8 % | 15.8 % | 35.9 % | 39.4 % | 99.1 % |
| IO | 406 | 17.5 % | 3.0 % | 36.7 % | 13.5 % | 18.2 % | 54.9 % |
| LXF | 269 | 80.3 % | 20.4 % | 1.1 % | 20.8 % | 28.6 % | 88.8 % |
| Reconstructed | 67 | 73.1 % | 11.9 % | 3.0 % | 34.3 % | 56.7 % | 88.1 % |
| MecabricksSearchLDR | 30 | 50.0 % | 36.7 % | 60.0 % | 33.3 % | 20.0 % | 60.0 % |

Reproduce any row: the grades are `clego/geograde/scoreboard_full_grades.jsonl`
(12,523 files), joined to `web/public/lego-models-index.json` on each set's
`models[0].path`.

### 3. What the 2026-09-19 clego fixes actually move (A/B on 15 sets)

The 13 `DbixConvV3` picks among the 15 sets Will listed were regenerated with
the local (unpublished) converter fixes — `reconvert_dbix.py --set <stem>
--force --out-dir lego_sets/DbixConvV3`, then `geograde/dbix_polish.py --sets
…`, which now REJECTS the polish on 9 of the 14 files because its float guard
fires. Both sides graded with the SAME (current) grader, so this is the
corpus delta and not a grader delta:

| defect | before | after | |
|---|---:|---:|---:|
| figure assembly defects | 226 | **64** | −72 % |
| displaced (polish-parked) parts | 1,461 | **459** | −69 % |
| big floating parts | 367 | **134** | −63 % |
| floating parts | 604 | **280** | −54 % |
| sunk parts | 29 | **21** | −28 % |
| overlapping parts | 18 | 18 | 0 % |

Per set, the large movers: 76417 float 170→25 and BIG 112→**0** (the model
stopped hovering and its airborne debris landed); 77092 float 122→14;
10354 BIG 71→**0**; 21360 float 10→**0**; 42639 fig 56→5; 42670 fig 49→5;
41732 fig 49→3. Regressions, stated: 10365 BIG 67→69, 76269 BIG 31→35,
60380 float 71→74, 76457 float 0→3, 80049 sunk 1→3.

**Which part families actually moved** (position diff over all 14 files,
classified by the grader's own description map, not by an id guess):

| class | placements moved > 0.5 u | placed | share |
|---|---:|---:|---:|
| figure parts | 971 | 1,857 | **52.3 %** |
| everything else | 1,843 | 33,591 | 5.5 % |
| window / glass / door | 84 | 1,838 | 4.6 % |
| plant / foliage | 53 | 1,196 | 4.4 % |

So this round is a FIGURE fix. Torsos, heads, hair and headgear moved on half
of all figure placements; **windows moved on 4.6 %** — the `within_bound` cap
touched some glass but windows are substantially untouched and remain open.

**It does not clear the verdicts: 12 of the 13 are still DEFECTIVE after.**
What is left is source-level, not placement-level — `76457` carries the
converter's own `main_frac 0.34` staged-capture stamp (the LXFML is a capture
mid-build), and the DBIX class lays a set's spare parts and minifigs out in a
row beside the model, which the displacement rule counts and should.

**The renderer resolves all of it.** The same 14 files probed through the
production app (`scripts/_lego-probe.mjs file:<abs> …` against
`https://craftmatic.click`, which uses the R2 part mirror): 0 missing parts, 0
substituted, 0 unresolved sub-parts on every one. Only 910049 (an authentic
`.io`, untouched by this round) reports 3 missing ids — `75c08`, `x167`,
`rename_4739a` — plus 38 decorated variants correctly rendered as their plain
mould.

**Detection.** With the 2026-09-03 grader, 6 of these 15 sets graded
DEFECTIVE. With the current one — figure gate, displacement rule,
staged-capture rule — **13 of 15** do, and the 2 that pass (71040, 11374)
render clean. The seven it used to miss were all figure-assembly or
polish-displacement, exactly the classes that had no rule.

### 4. The defect classes the 2026-09-03 census could not see (sampled, 2026-09-19)

`figure_defects`, `displaced_parts` and the staged-capture stamp did not exist
when the exhaustive grade was taken, so they are measured on a **random sample
of 500 primary picks** (seed 20260919, drawn from the 9,425 that had a grade),
re-graded with the current grader.

**This is the BEFORE side of §5.** It was taken over the corpus as it stood
before the DbixConvV3 regeneration, so its `DbixConvV3` numbers are superseded
there (17.6 % -> 33.0 % PASS); every other source is unchanged by that
regeneration and its numbers still hold.

| class | picks | share (95 % CI) |
|---|---:|---|
| **figure assembly defects >= 1** | 148 / 500 | **29.6 % ± 4.0** |
| displaced (polish-parked) parts >= 1 | 50 / 500 | 10.0 % ± 2.6 |
| staged capture (`main_frac` < 0.70) | 21 / 500 | 4.2 % ± 1.8 |
| duplicate placements over threshold | 2 / 500 | 0.4 % ± 0.6 |

**Overall verdict on that sample: 236 PASS / 264 DEFECTIVE = 47.2 % PASS**, and
the largest single dominant defect is `figures` (69), ahead of `displaced` (48),
`floating` (41) and `overlap` (35). Per source:

| source | picks | PASS | >=1 figure defect |
|---|---:|---:|---:|
| OMR | 41 | **97.6 %** | 0.0 % |
| LDR | 46 | **93.5 %** | 0.0 % |
| LXF | 12 | 75.0 % | 0.0 % |
| IO | 19 | 73.7 % | 26.3 % |
| MecabricksLDR | 127 | 63.0 % | 26.8 % |
| ReconV3 | 121 | 21.5 % | 38.0 % |
| EurobricksLDR | 38 | 18.4 % | 60.5 % |
| DbixConvV3 | 91 | **17.6 %** | 42.9 % |

The authentic classes are the control and they behave like one: OMR and LDR
carry no figure defects at all. `DbixConvV3` at 17.6 % is BELOW the 30–40 %
the tracker predicted for the post-displacement-rule re-grade — the prediction
was made before the figure gate existed, and figures cost it another 25 points.

The **744 picks that never had a grade** (`EurobricksLDD` 172, `EurobricksTopicLDR`
158, `MecabricksLDR` 159, `Reconstructed` 103, `DbixConvV3` 97, `HuntArchiveLDR`
47) were graded in full for this census: 47.3 % PASS, the same headline, but a
different profile — **13.8 % carry duplicate placements** against 0.4 % in the
random sample, and `duplicates` is their second-largest dominant defect.

Reproduce: `scripts/` has no driver for this (it is a clego-side grade); the
list and the per-file JSON are regenerated by running
`python geograde/geograde.py lego_sets/<rel> --out <dir>` over each pick.

### Named part-class gaps (sails, slides, doors)

Measured 2026-09-19 on the seven sets Will named, per set and per class, by
(1) grepping the index pick that production serves (`sets[id].models[0].path`,
fetched through `/lego-models/*`), (2) replaying the renderer's resolution
ladder with `scripts/missing-geometry-census.ts --sets … --corpus <the fetched
picks>`, (3) rendering through production with `scripts/_lego-probe.mjs`
(`missingParts`/`substitutedParts`/`unresolvedSubparts` + fixed-camera PNGs),
and (4) for the DBIX picks, re-placing the upstream `DBIX_LXFML/<set>.lxfml`
with THIS repo's own LXF placer (`buildLxfPlacements`, ldraw.xml-inverse
primary) and counting how many other parts sit within 24 LDU of each named
placement in both files. The BrickLink inventory (`/bff/inventory/<set>-1`)
is the ground truth for what the set contains.

| set | class | pick | verdict | evidence |
|---|---|---|---|---|
| 10365 | sails | `DbixConvV3/10365.ldr` | **absent in source** (converter drop) + **upstream data gap** | BL inventory: 10 cloth sails `112554`×3 `112555`×2 `112556`×2 `112557`×3 + flag `112558`. All 11 ARE in `DBIX_LXFML/10365.lxfml` (design ids verbatim) and NONE is in the pick. LDraw has no mould for any of them (prod + upstream 404). Renderer: 0 missing, 0 substituted — it never sees them. |
| 75397 | sails | `MecabricksLDR/75397.ldr` | **absent in source** + **upstream data gap** | BL: `109637`×2 "Cloth Sail 44 x 22 Jabba's Sail Barge". Not in the Mecabricks export, not in LDraw (404). The pick's 10 missing pieces are NOT sails: `60677`/`85526`/`56203`/`85523` = rigid hoses `75c20/24/31/49` (rigging), `98109`/`98112`/`98113` = Jabba's body. |
| 41703 | slides | `DbixConvV3/41703.ldr` | **resolved, misplaced (converter: polish-parked)** | `11267` "Slide 7 x 12 x 6.333 Half Turn" resolves (prod 200). Pick places it at (640, −103.5, 1000) with **1** neighbour within 24 LDU (lying on the floor 22 studs from the house); the ldraw.xml-inverse placement of the same LXFML bone is (420, −168.5, 560) with **38** neighbours and 8 supports — attached to the balcony. |
| 42652 | slides | `DbixConvV3/42652.ldr` | **resolved, misplaced (converter: alignment row)** | `11267` at (280, **+56.5**, 0): 0 neighbours, top of the slide at ground level, body below the floor. ldraw.xml-inverse: (180, −248.5, −20), 53 neighbours, 10 supports — from the upper deck to the ground. `27976` "Slide 4 x 6 x 6": both files agree on height, differ 60 LDU in x (not adjudicated). |
| 41395 | slides | `MecabricksLDR/41395.ldr` | **fine** | `11267` at (−20, −376, 240.5) sits on the roof deck (see `before-front.png`). The 7 missing ids in this pick (`24183`, `21634d1`, `94590d*`, `35620`, `35356d1`) are not slides or doors. |
| 42663 | doors | `DbixConvV3/42663.ldr` | **resolved, misplaced (converter: alignment row)** | BL: `43967` "Door 1 x 4 x 5 Train Left, Thick Support" — LXFML writes the pre-retool id `4181`, LDraw has both. Pick: `4181` at (70, **+48**, −30), identity rotation, **0** neighbours, 120 LDU BELOW the floor (the blue door standing beside the van). ldraw.xml-inverse: (70, −192, −30), 28 neighbours, 5 supports. `42205` (BL "Window 1 x 6 x 6 Flat Front", LDraw "Door 1 x 6 x 6 Frame" — same element), `35157`, `4533` are identical in both files. |
| 43267 | doors | `DbixConvV3/43267.ldr` | **resolved, misplaced (converter: alignment row)** | BL: `40066`×4 "Door, Frame 1 x 6 x 7 Arched" = LDraw `40066` (frame; `// Doorstep`, y 0..168). Pick puts all four **168 LDU (exactly one frame height) higher** and 50 LDU in z from the ldraw.xml-inverse placement, i.e. the learned row's t=(50,−168,0) is applied on top of a bone that already carries the LDraw origin; the frames render detached beside the castle base. The pick's 2 missing ids (`28318`, `28705`) are doll accessories in the parked row, not doors. |

**What this means for the renderer: nothing to fix.** Every sail, slide and
door mould these sets name resolves on prod without an alias hop (`11267`,
`27976`, `4181`, `43967`, `42205`, `40066`, `60596`, `60623`, `60616`);
`substitutedParts` and `unresolvedSubparts` are empty on all seven. The
placements are wrong in the BYTES of the `DbixConvV3` picks, and the same
LXFML bones placed by this repo's ldraw.xml-inverse path land attached in all
four cases (renders: `tmp/probe-lxf/<set>/lxf-iso.png` beside
`tmp/probe-before/<set>/before-iso.png` in the 2026-09-19 job dir). The three
rows to audit in clego are the **same class as the 3818/3819 arm rows**: the
learned mode for `11267`, `4181` and `40066` disagrees with ldraw.xml-inverse
by 305 / 240 / 168 LDU vertically, and in 41703 the mis-corrected slide then
read as floating and `dbix_polish` parked it (polish is a symptom here, not
the cause).

**Sails are an upstream data gap, not an alias candidate.** LDraw models
sails only as the older cut moulds (`64991` 28×17 trapezoid, `85651` 17×21
triangle, `96714`, `36069a/b`, `61898`); the 2025 tattered-hole cuts
(`112554`–`112558`) and the barge sail (`109637`) have no `.dat` anywhere.
`112554` (27.5×16.5) is close to `64991` in size only — a different die-cut
in an unmeasured frame, so an alias would draw the wrong sail in a guessed
place; the ladder leaves them unaliased and `test/part-alias.test.ts` pins
that. Converter-side: `reconvert_dbix.py` counts these under `dropped[]`, but
the file header only reports `stickers` ("0 sticker/brief instances excluded"
on 10365 while 23 structural parts were dropped) — surface `dropped` in the
`// parts emitted` line so a missing sail is visible in the file itself.

**Doors have a second, corpus-wide finding: production serves Studio
"(Needs Work)" LDD stubs that upstream LDraw does not ship, in a different
frame.** `parts/60616.dat` on prod is `GLASS DOOR FOR FRAME 1X4X6 (Needs
Work)` — origin on the BOTTOM plane, geometry y ∈ [−140, −7.5] — while the
real mould is `60616a`/`60616b` "Door 1 x 4 x 6 Smooth …" (origin at the top,
y ∈ [3.2, 136.8]); `library.ldraw.org` 404s `60616.dat` in both trees. Same
for `76041` (DOOR FOR FRAME 1X4X6), `47899`/`73194` (shop doors), `24225`/
`24234`, and one sail, `40385` (BACK SAIL 8X2X5). Exposure among primary
picks (7,787 non-DbixConvV3 `.ldr` picks scanned): `60616` — MecabricksLDR
184 placements / ~95 sets, MecabricksSearchLDR 8, LDR 2 (set 8404);
`76041` — EurobricksLDR 14 / 10 sets; `40385` — ReconV3 4 + EurobricksLDR 2;
`33216`/`6078`/`15627` are real official parts that merely share the
"Needs Work" phrasing locally. **Do not alias `60616` → `60616a` client-side:**
clego's `mecabricks_align.json` fitted `60616` against the STUB
(`method: mesh-weak`, delta (−2.5, −73.5, −6.5)), so on 41395 the doors sit
inside their `60596` frames today (verified in `before-front.png`) and the
alias would drop every one of the 184 by 144 LDU. The fix is the `3814`→`973`
recipe in clego: `mb_partmap` 60616→60616a with a re-fit delta, then a
regeneration — and the R2 sync should stop treating Studio-only stubs as
mirror content once no pick depends on them.

### 5. The full DbixConvV3 regeneration (2026-09-19, local only)

All 2,302 stems regenerated with the local converter fixes and re-polished;
**1,971 of the 2,249 comparable files changed**. Measured on the same random
500 primary picks as §4, with the same grader on both sides, so this is a
corpus delta:

| | before | after | |
|---|---:|---:|---:|
| PASS (all 500 picks) | 236 (47.2 %) | **250 (50.0 %)** | +2.8 pts |
| PASS among the 91 `DbixConvV3` picks | 16 (17.6 %) | **30 (33.0 %)** | nearly double |
| figure assembly defects | 1,104 | **807** | −27 % |
| picks with >= 1 figure defect | 148 | **136** | −8 % |
| displaced (polish-parked) parts | 4,253 | **2,386** | −44 % |
| floating parts | 3,041 | 3,082 | +1 % |
| big floating parts | 1,170 | 1,254 | **+7 %** |
| overlapping / sunk | 463 / 222 | 469 / 224 | +1 % |

**The big-floating regression is three sets, and it is the POLISH, not the
alignment.** 86 of the 91 regenerated picks are unchanged, 2 improve, and 3 get
worse — `41713` 0 → 67, `71839` 10 → 30, `42703` 0 → 14, most of the net +84
being 41713. Diagnosed with the converter's own A/B switch:

| 41713 | n | float | BIG | disp | fig | split0 |
|---|---:|---:|---:|---:|---:|---:|
| before (shipped, POLISHED) | 763 | 10 | **0** | **80** | 24 | 316p |
| after (regenerated, polish REJECTED) | 763 | 78 | 67 | 0 | **0** | **9p** |
| control: `DBIX_BOUND_RATIO=0` (old alignment, unpolished) | 763 | **88** | 63 | 0 | 1 | 316p |

The before's zero big-floating was `dbix_polish` parking 80 parts, which is the
grader-gaming this round removed; the control shows the new alignment makes the
file LESS floaty than the old one (78 against 88), not more. What actually
changed for the worse is that the defect is now visible. Figure defects went
24 → 0 and graph-split parts 316 → 9 on the same file.

**Nothing is published.** The regenerated corpus is on disk in
`C:/git/clego/lego_sets/DbixConvV3/` and prod still serves the old bytes.
Re-merge the sharded summary with `merge_shard_summaries.py` (now
ownership-aware) before rebuilding the index.

### 6. Where figure defects live AFTER the regeneration

Figure assembly is still the corpus's largest defect class (§4), and the regen
moved `DbixConvV3` a long way without touching where most of the damage
actually is. Same 500-pick sample, post-regen:

| source | picks | with >= 1 figure defect | total defects |
|---|---:|---:|---:|
| **ReconV3** | 121 | 46 (38 %) | **452** |
| MecabricksLDR | 127 | 34 (27 %) | 209 |
| DbixConvV3 | 91 | 27 (30 %) | **63** |
| EurobricksLDR | 38 | 23 (**61 %**) | 49 |
| IO | 19 | 5 (26 %) | 28 |
| OMR / LDR / LXF | 99 | **0** | **0** |
| all | 500 | 136 (27 %) | 807 |

**`ReconV3` carries 56 % of every figure defect in the sample** and nothing has
ever been aimed at its figures — that is the next target, not another pass over
DbixConvV3, which now averages 2.3 defects per affected pick against ReconV3's
9.8. `EurobricksLDR` has the worst RATE (61 % of its picks) on a small
population. The three authentic classes are the control and report zero.

#### 6a. ReconV3's figures: the cause, and the assembler that fixes 44 % of it (2026-09-19)

`recon_v3` places every inventory part at the centroid of the page-diff region
its step attributes it to, on the stud grid, identity-rotated. A minifig is
ONE callout on the page, so its head, arms, hands, hips and legs land as a
stack or a scatter 8–160 LDU around the torso (hands 8 LDU apart in a column,
arms 26–57 LDU from the torso) — never on the joints. On a seeded random 60 of
the 2,300 ReconV3 primary picks, 27 files carry 259 figure defects:
`orphan_hand` 127, `leg_missing_on_hips` 58, `torso_arms_missing` 26,
`orphan_arm` 22, `torso_no_hips` 14, `torso_no_head` 12.

`clego/recon_figure_assemble.py` (also wired into `recon_v3/beam.py` at the
write site, so a rebuild does it) claims, per torso, the nearest unclaimed
head / hips-or-hips-and-legs / handed arms / hands / handed legs / headgear
within 250 LDU and re-emits them at the standard minifig's torso-local slots
(`web/src/engine/minifig-rig.ts` `MINIFIG_CANON`), carried by the torso's own
rotation; a torso-less arm still gets its hand and a torso-less hips its legs.
A figure whose claimed parts already sit inside the grader's authentic bands
is left byte-identical — the control: 14 of 15 flat authentic `LDR/` files
with minifigs are untouched, the 15th (`1704 ice planet snow grader`) is a
posed figure with its legs 23 LDU apart that the grader's own 10–14.5 LDU
`hips->leg` band also calls defective. The pass is only ever applied to
`ReconV3`.

| 9 touched files of the 60 | before | after |
|---|---:|---:|
| figure defects | 147 | **82** (−44 %) |
| floating parts | 99 | 103 |
| big floating / overlap / sunk | 37 / 45 / 12 | 37 / 45 / 12 |

What is left is inventory-side, not placement: files with 6–12 hands for 2
arms and no torso at all (`76151`, `70403`, `76167` — the reader's parts list
carries surplus hands and drops the torso's print id), which no placement
rule can assemble. Whole corpus: **423 of 2,424 files touched, 990 figures,
4,919 parts moved**, stamped `0 !FIGURE_ASSEMBLE v1`.

### 7. Studio "(Needs Work)" stub moulds — and the larger mismatch behind them

The `3814 → 973` torso fix (above) was ONE member of a class: a design id whose
`.dat` exists only in Studio's `UnOfficial/` tree as an LDD-shaped stub, taken
by an existence check over the real mould. Censused in clego over the whole tree
(`MB_TRANSFORM_AUDIT.md` §12, clego `56f8a7c8`):

| | stems |
|---|---:|
| resolve from `UnOfficial/` at all (not in Studio's `parts/`) | 11,774 |
| **class A** — Studio-only, in neither upstream tree | **5,089** (698 "(Needs Work)") |
| **class B** — present upstream, `dat_bbox` differs > 1 LDU | **405** (317 over 4 LDU) |
| placed anywhere in the corpus | 2,193 |
| placed in a PRIMARY pick | 1,752 |
| class A with a size-matched real mould, in a primary pick | **14** (7 fixed) |

**Class A, fixed**: `60616`+`35290`/`35291` → `60616a`/`b` (184 placements over
99 sets), `64567` → `64567a` (644 / 546), `90393` → `90370`, `96859` → `4530`,
`85557`/`85558` → `85489a`/`b`, `6139` → `2582`. The honest result is smaller
than the premise: **1,244 of 1,252 paired placements move less than 1 LDU** —
clego's weak stub fits had already landed the geometry where the real mould
goes, so what the remap buys is a real mould at fit 0.89–1.00 and no Studio-only
dependency. The real misplacement was **8 `35291` doors sitting 73.7–74.2 LDU
from their nearest 1x4x6 frame**; six now sit at 3.8–6.8. Door-to-frame:
**7 sets better, 0 worse.**

**Class B is the larger defect and is NOT fixed**: 317 stems, **12,719 primary
placements over 2,311 sets** (DBIX 8,608). These are names both trees ship, and
prod serves the UPSTREAM copy while clego fits against STUDIO's — so the fit and
the rendered mesh disagree. `70681` (1,883 placements) is a different part
upstream; `5092`/`5091` (2,400) are the mirror-image tile. That is a precedence
and re-fit round, not a mapping row, and nothing has been aimed at it.

The 33 `MecabricksSearchLDR` files were once overwritten before the fixer had
an `--out` flag, so the round's A/B was regeneration-against-regeneration.
**Re-measured against the ORIGINAL bytes** kept in `_MecabricksSearchLDR_prev`
/ `_MecabricksLDR_prev` (`geograde/_ab_prev.py`, 2026-09-19): the 477 changed
`MecabricksLDR` files go figure defects **4,577 → 706**, unknown placements
3,007 → 2,882, overlap 698 → 688, floating / big-floating / sunk unchanged;
the 33 `MecabricksSearchLDR` files go **178 → 76** with every other counter
identical. The caveat is closed.

### 7a. Class B measured by geometry: mostly the SAME mould in another frame, and re-framed exactly (2026-09-19)

The §7 reading of class B was by DESCRIPTION, and Studio's stubs carry a
`0 FILE` header before their name — so `70681` read as "a different part
upstream". `clego/class_b_census.py` (durable replacement for the lost census
script) overlays the two vertex clouds under 256 candidate frames (axis
turns, 45° about Y for the cut tiles, and a mirror) and decides by the match:

| kind | stems in picks | placements | meaning |
|---|---:|---:|---|
| `shift` | 59 | **5,067** | same mould, other origin (`70681`: 1,883, cloud 1.0, 20 LDU) |
| `rotated` | 51 | **2,979** | same mould, other axis frame (`10313`, `36017`, `15362`, `60169`) |
| `mirrored` | 1 | 27 | same mould mirrored |
| `different` | 108 | 4,795 | no exact overlay (`79491` 0.69, `2752` 0.88, `7302` 0.15) |

327 stems, 219 in primary picks, 12,868 placements over 2,192 sets (LDraw-text
picks; the 1,291 `.io`/`.lxf` picks reference design ids, not these files, and
are NOT covered). For the three re-frame classes the census records `Q, t`
with `studio_local = Q · upstream_local + t`, and `clego/class_b_apply.py`
rewrites each placement exactly — `pos' = pos + R·t`, `R' = R·Q` — in every
clego-GENERATED LDraw source (authentic OMR/LDR/Eurobricks files were authored
against upstream and are left alone). It is wired into `reconvert_dbix.py`,
`harvest_mecabricks_sets.py` and `recon_v3/beam.py`, so a regeneration keeps
it. Applied in place 2026-09-19: DbixConvV3 1,132 files / 7,402 placements,
DbixConvV2 1,067 / 6,860, Reconstructed 876 / 4,288, MecabricksLDR 327 /
1,524, ReconV3 362 / 1,003, DbixLDR 31 / 117, MecabricksSearchLDR 9 / 110 —
stamped `0 !CLASS_B_REFRAME v1`.

**The grader had the same blind spot as prod's opposite.** `dbix_settle`
resolved every `.dat` from Studio's copy, so it graded what dev draws, not what
prod draws. `CLEGO_LDRAW_LIB=upstream` now resolves upstream-first (class-A
stubs as the fallback, exactly prod's ladder) with its own point cache, and
the corpus board is graded that way from this round on. On the 24 picks with
the most re-framed placements, before → after:

| library | floating | overlap parts | overlap volume |
|---|---:|---:|---:|
| upstream (what prod draws) | 345 → 338 | 175 → 174 | 38,336 → 38,272 |
| Studio (the old grader) | 335 → 339 | 150 → **163** | 31,424 → **32,576** |

The asymmetry is the proof: moved to where the upstream mesh belongs, the
placements read slightly better against upstream and worse against Studio.
The magnitudes are small because geograde's 4 LDU voxels with 8 LDU erosion
barely register a 20 LDU shift of a part inside a wall; the correction is
exact by construction (cloud match ≥ 0.9 at 2 LDU), not by this grader.
**The client applies the same table to what IT converts from the Studio
frame** (`web/src/engine/class-b-reframe.ts`, table generated by
`bun scripts/gen-class-b-reframe.ts` from the census, 127 rows after dropping
identity ones): every `.lxf` placement after the `ldraw.xml` / measured /
mini-doll ladder (`LxfDiagnostics.classBReframed`, in the `.lxf` status note)
and every type-1 line of an `.io`'s `model.ldr` (`IoModel.classBReframed`),
never a text that carries clego's `0 !CLASS_B_REFRAME` stamp — so the 1,291
`.io`/`.lxf` picks are covered too. Not covered: the 108 `different` stems
(4,795 placements) — a real mould difference that needs a per-stem alias to
the upstream file with Studio's geometry, of which the census found none by
description.
