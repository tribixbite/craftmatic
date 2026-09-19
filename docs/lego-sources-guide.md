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
