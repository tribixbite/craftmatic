# Review of the A, B and D plans (BIZ-65)

Reviewer: Fable 5.1, 2026-11-09, on `main` at `420c12a5`. Scope: `business-A-original-packs.md` (1,518 lines),
`business-B-byom-converter.md` (1,277), `business-D-free-releases.md` (1,111), against `brief-common.md`,
`CLAUDE.md`, `TASKS-BUSINESS.md`, `docs/business-scenarios.md` and the code. The merged plan is
[README.md](README.md). Nothing here is legal advice.

Method: every file:line cited in the "measured" sections was opened (`sed -n`), counts were re-run with `grep -c`,
the export-time claim was recomputed from `output/favsweep-4da29033/*.json`, external paths were listed, the live
download URL and the npm registry were fetched, and the in-flight branches were diffed against `main`. Claims I
could not check are marked UNVERIFIED below; everything else in the three plans' baseline tables reproduced.

## 1. Errors, stale facts and unverified claims

| # | Plan | Claim | What I found | Severity |
|---|---|---|---|---|
| E1 | A §2.2, §5.2, §9.1, §11.2 | Three branches are in flight on `cockpit-seat.ts` / `scene-vehicles.ts`: `gen-side-1109`, `gen-view-1106`, `gen-veh-1106`; this is the reason the Marketplace profile must be a post-pass rewriter rather than threaded through the emitters. | `git diff --name-only main...<branch>`: `gen-view-1106`, `gen-veh-1106`, `gen-ix-1107`, `gen-lift-1107` and `gen-seat4-1106` differ from `main` in NO engine file (merged). The live ones are `gen-side-1109` (`cockpit-seat.ts` only) and `gen-seat4-veh` / `gen-view-veh` (`playable-components.ts`, `scene-vehicles.ts`, `schem-pipeline.ts`). **Nothing in flight touches `playable-addon.ts`**, so A's "do not thread" argument is weaker than stated; and B02/B03 (which edit `schem-pipeline.ts` and `playable-components.ts`) collide with the two live vehicle branches, which B's collision map does not know. | High: changes the merge order |
| E2 | B §2.3 | "a grep for Mojang / NOT AN OFFICIAL in `web/src/engine` finds only data-source comments in `bedrock-block-states.json`" | 12 hits in 7 files (`bedrock-blocks.ts`, `bedrock-placement-pack.ts`, `gametest-pack.ts`, `mcpack.ts`, `mcstructure-encode.ts`, `playable-addon.ts`, plus the JSON). All are comments naming Mojang's docs; the conclusion (no disclaimer is shipped) holds. | Low |
| E3 | B §2.4 | export wall time "p90 846 s" | Recomputed from the 40 `ms` fields: median 138 s and max 1,782 s reproduce; p90 is 552 s by nearest rank (the 36th of 40). 846 s is the 37th value; the figure depends on the percentile method. Quote "p90 550-850 s". | Low |
| E4 | B §2.2 | formats listed at `mesh-import.ts:10` | Line 10 is blank; `MeshType` is at `:9`, the switch at `:24-26`. `upload.ts:14-17` is right. | Trivial |
| E5 | D §1 | `@minecraft/creator-tools` 0.21.0 "needs Node >= 22" | npm registry today: `dist-tags.latest = 0.21.0`, `bin.mct = cli/index.mjs`, **no `engines` field**. The Node requirement is UNVERIFIED (maybe from its README); the wrapper must not refuse on Node version alone. | Low |
| E6 | A §0.4 vs docs | 10303 loop radius 3.93 blocks (`physics-architecture.md:67`) | `bedrock-addon-guide.md:2201` says r ≈ 3.7. A doc inconsistency, not a plan error; the 3x sizing does not depend on it. | Info |
| E7 | A §0.1 | the `orbit` ride "exists for the flyer, one seat" | `bedrock-rides.ts:142` has `RideKind = 'slide' \| 'lift' \| 'orbit'`; confirmed. OK. | — |
| E8 | A, B, D | repo is PUBLIC and MIT; no git tags; `gh repo view` | `LICENSE` is MIT; `git tag` is empty; `gh` output not re-run (the planners' call). OK. | — |
| E9 | D §1 | `craftmatic.click/downloads/Craftmatic-Lego-Pack.mcpack` answers 200 as `application/octet-stream` | `curl -sI` 2026-11-09 19:42 UTC: HTTP 200, octet-stream. Confirmed. | — |
| E10 | B §5 | the 82 corpus candidates | Nothing was downloaded by the planner and I did not open the URLs either. Every URL, licence and size is UNVERIFIED until B29 fetches it. Several are login-only (BrickLink, Sketchfab) and need the USER to download by hand, which B29 flags but no plan lists as a user action. | Medium: the "real user files" test population may be far smaller than 41 + 41 |
| E11 | A §4.1-4.2 | the legal citations (17 U.S.C. 120(a), SETE lighting, Neuschwanstein EU mark C-488/16 P, Italian arts. 107-108, L621-42, Google Maps Terms 3.2.3(c), T-297/22, T-298/22) | Not re-opened by me; `TASKS-BUSINESS.md` records T-297/22 and T-298/22 as verified on 2026-11-06. All of them are research leads for the lawyer, as A says. | Info |
| E12 | A §5.1 | Bedrock clouds at about y 192 | Marked UNVERIFIED by A itself; keep it so. | Info |
| E13 | A §7.4 | stable script modules "2.11.0 and 2.3.0" seen on 2026-10-27 | Not re-checked; the packs do use 2.9.0 / 2.1.0 (`playable-addon.ts:2624`). | Info |
| E14 | B §2.4 | "conversion cannot run in a Cloudflare Worker" | Follows from the measured 138 s median and the 1.33 GB RSS note (`schem-worker.ts` header); correct conclusion. | — |
| E15 | D §3.3 | "a date-based dev version `[2611, …]` ranks above `[1,0,0]`" | True of Bedrock's version comparison and a real trap: a dev build of a released product would shadow the release. Keep the `:dev` identity salt. | — |

Everything else cited in A §0, B §2 and D §1 opened at the stated lines (`PACK_NAMESPACE` at `mcpack.ts:41` and
`ldraw-entity-compiler.ts:52`; the 17 concrete textures at `playable-addon.ts:2652-2657` and
`lego-resource-pack.ts:361-366`; 43 collider ids x 256 states = 11,008 at `collider-form.ts:87-88` / `:553-556`;
"Blocks in this area will be replaced." at `bedrock-placement-pack.ts:1553`; `[Brick Wand]` at `:998`; ticking areas
at `:1013-1024`; `packIdentity` at `mcpack.ts:170`; `packVersionAt` at `pipeline-version.ts:219`; the 65,536 cap at
`_mcaddon_check.py:253/:267`; `COASTER_MAX_CARS = 8` at `bedrock-coaster.ts:578`; zero `launch` in
`bedrock-coaster.ts`; 181.6 blocks at `bedrock-addon-guide.md:2163`; `LEGO` 10/6/3/1 times; `DOMParser` absent from
`test/`; `data/` ignored at `.gitignore:27`; `C:/git/comfyui-3d`, `pokefit/imageto3d.py` (830 lines),
`rebrickable_tables/inventory_parts.csv.gz`, `ldraw_ref/{official,unofficial,_archives/complete.zip}`,
`C:/git/bds/1.26.63.1` all present). No RGB -> nearest-LDraw-colour function and no brickifier exist
(`grep -ri 'nearest|closest.*colou?r|brickif|legoliz'` over `web/src`, `src`, `scripts`: nothing but `closestBlock`).

## 2. Contradictions and overlaps, with ONE owner each

The three plans were written in parallel and each re-plans the shared Marketplace fixes. Below, the owner is the
package in [README.md](README.md); the others consume it and must not re-implement it.

| Topic | A | B | D | Owner (README id) | Decision |
|---|---|---|---|---|---|
| **Namespace + folder layout** | WP-M01/M02: post-pass rewriter over the finished file list | "A:namespace" dependency | "A:namespace" dependency; D-02 threads identity INTO `buildPlayableAddon` | **X-03** (rewriter, A's author) for ids/folders now; `TODO(pack-ids)` threading later | Keep the rewriter: 223 `craftmatic:` literals in 19 files cannot be threaded in one wave. E1 removes A's in-flight excuse but not the size argument. The rewriter's guard is the whole-archive token scan + sim + BDS. |
| **Vanilla texture overwrite** | WP-M03 (profile skips the 17 files; own `<ns>:brick_<colour>` blocks) | "A:textures" | "A:vanilla-textures" | **X-02** carries the `vanillaTextures: false` flag (one `if` around `playable-addon.ts:2652-2657`); **M03** owns the own-brick blocks and the collider permutation re-encode | Two concerns, two packages. |
| **Manifest** (`pack_scope`, RP<->BP deps, frozen uuids, version, `min_engine_version`, modules) | WP-M04 inside the rewriter | — | D-02 `ReleaseBuildContext` in the emitter | **X-02** (D-02's author; A's M04 folded in) | The manifest is written in one place (`playable-addon.ts:2624-2626`); thread a `profile` there instead of rewriting JSON after the fact. A M04 is deleted. |
| **Identity registry** (`ProductIdentity`, uuid mint, semver, ledger) | `marketplace/product.ts`, `products/<pack>/product.json`, `--mint` | `ByomHints.namespace` | D-01 `release/types.ts`, `release/products/*.json`, `identity-ledger.json`, `init-product` | **X-01** (D-01) | One `ProductIdentity` type. A's `products/` folder is dropped; B's namespace validation imports X-01's pattern. |
| **Validator** | WP-M05 `_mcaddon_check.py --marketplace` + `_mctools_validate.ts` | B07 TS port `byom/pack-check.ts` + Marketplace rules | D-07 `_mcaddon_check.py --release` + `release-mctools.ts` | **X-06** Python `--release` (one mode, not two) + one mct wrapper; **X-07** TS `pack-check` with a parity test against X-06 | The TS port is needed anyway (it must run in the browser for B); the Python stays as the cross-check and CI gate. `--marketplace` and `--release` are the same rule set: one flag. |
| **Attribution / credits** | WP-M09 `marketplace/credits.ts` | B04 `CREDITS.txt` | D-04 `notices.ts` `CREDITS-LDRAW.txt` | **X-04** | One credits writer fed by one part-source ledger. |
| **Studio-only meshes / official-only library** | WP-M10 `ldraw-geometry.ts` official mode | B05 `ldraw-geometry.ts` resolver hook + provenance | D-04 `ldraw-geometry.ts` path recording + licence gate | **X-04** | Three packages planned to edit `ldraw-geometry.ts:190-201` in the same wave. One package: record the file each part resolved from, classify it (official / unofficial-CC-BY / studio / mirror / custom / substituted), expose a gate and a credits list. |
| **Disclaimer + player-facing text + forbidden-terms lint** | WP-M08 `text-lint.ts` + profile-aware `packDisplayName` | B04 `bedrock-player-text.ts` string table + disclaimer | D-05 `notices.ts`, `forbidden-terms.ts` | **X-05** | One `pack-text/` module: strings, the Mojang disclaimer verbatim, the lint with explicit exemptions. The profile-aware display name moves to X-02. |
| **The figure** | WP-F01..F03 | consumes (`figures: 'brick-figure'`) | consumes (`A:figure`) | **F01..F03** | Unchanged; the only producer. |
| **Set-number / title-keyed behaviour** | not addressed (A's designs carry metas) | B02 `labelHeuristicsAllowed` | — | **X-17** (B02) | A's brickgen packs must ALSO run with heuristics off, or a design titled "Alpine Swan Castle 10xxx" could trip a canon. The predicate is generic ("explicit mode"), not BYOM-only. |
| **Brick core** (types, vocabulary, colour, writer, verify, packing) | A01 types/vocab, A02 colour, A03 writer+metas, A04 verify, A06 bricker | B10 `legolize/palette.ts`, B11 `merge.ts` + `byom/ldraw-writer.ts`, B14 metrics | — | **X-08** (A01+A02+A03), **X-09** (A04), **X-10** (A06 = B11's merge), **X-11** (B10 lattice), **X-12** (B14 = A11's fidelity metric) | The single biggest duplication: two colour mappers, two LDraw writers, two greedy brick packers, two connectivity checks, two silhouette-IoU renderers (A via headless Chrome, B via the sim rasteriser). One core under `web/src/brickgen/`; B's `legolize/` becomes the mesh front-end that produces an `IntentLattice`. |
| **Similarity / clean room** | `_cleanroom_check.ts` (part-histogram cosine + aligned voxel IoU) | B06 MinHash fingerprint + official-set screen | — | **X-13** | One similarity core; the clean-room CLI and the BYOM screen are two callers. |
| **Media renders** | WP-S01 `_store_art.mjs` (web viewer via headless Chrome) | — | D-11 `media-turntable.ts` (sim rasteriser) | **X-14** (D-11) | One renderer; store sizes are presets. A's S01 keeps only the shot list. |
| **Worker routes** | — | B18 `worker/index.ts` router | D-13 `/get/*`, `/go/*` mounted from `ldraw-omr.js` | **X-15** (B18) owns the router; D-13 mounts into it | `wrangler.toml` has one writer. |
| **Ledger rows and tracker** | WP-A00 | §11 | §14 | **X-00** (the orchestrator, wave 0) | One writer of `REQUIREMENTS.md` / `TASKS-BUSINESS.md`; no implementer touches them. |
| **Worktree naming** | `.worktrees/biz-a-<id>`, branch `biz-a/<id>` | `.worktrees/biz-b<NN>-<slug>`, branch `biz/b<NN>-<slug>` | `.worktrees/biz-d<NN>-<slug>`, branch `biz/d<NN>-<slug>` | README | `.worktrees/biz-<id>`, branch `biz-<id>`, lowercase (`biz-x08`, `biz-c01`). |
| **"Three mechanisms for one compliant pack"** | post-pass rewriter | `byom` option threaded into `runSchemPipeline` / `buildPlayableAddon` | `release` option threaded | README §2 | ONE `PackProfile` option (X-02) carries ids, version, clock, texts, flags and the entitlement; the rewriter (X-03) runs after it for ids and folders only. B08's watermark and D-02's release texts are fields of the same profile. |

Smaller inconsistencies:
- A's `AuthoringMeta` names are `!CRAFTMATIC FIGURE/SEAT/DOOR/SPAWN/DESIGN`; the Marketplace guard is "zero `craftmatic`
  tokens in the archive". The metas live in the `.ldr` source, not the pack, so no conflict, but X-03's scan must
  exclude nothing and the `.ldr` must never be shipped inside a pack.
- B's `ValidationReport` and D's `ValidationReport` are different types with the same name. Rename D's to
  `ReleaseGateReport`.
- A proposes pace sqrt 2 and a 140-block drop reaching ~49 blocks/s; the runtime's `MAX_SPEED` is 28.28 (`:657`).
  A knows this (WP-C04 caps by measurement); the README keeps it as a measurement the design needs.
- The brief says commits end "— Opus 5.5"; the user's global rule is "emdash + model version". Read the brief as
  "the implementing model's version"; a Sonnet implementer signs "— Sonnet 5.x".

## 3. Gaps against the user's request

The request (verbatim in `brief-common.md`): a part mapper from image + building footprint; >= 20 hand-polished
icon designs; >= 5 other pack types including an epic coaster >= 3x Loop with a cloud-top descent and a dark
in-mountain segment, "and several other epic show stoppers"; BYOM tested on real user photos and model files;
modularise and generalise; fail-first TDD.

| Gap | Where | Fix in the README |
|---|---|---|
| **"Several other epic show-stoppers" has no package.** A's P3-P6 are ordinary packs (garage, pinball, furniture, funfair). Only the coaster is epic. | A §1, §5 | New rows **A-SS1**, **A-SS2** (two more show-stoppers), with candidates for the user to pick (U5): a 100-block drop tower + sky swing, a water-slide tower with four chutes (the slide ride exists), a dark ride inside the same mountain (reuses C05), a stunt arena for the garage cars, a 400 % walk-in landmark. |
| **The "image" half of the part mapper is thin.** Photo input is "annotations on licensed photos" plus the legacy `streetview-analysis.ts` heuristics; automatic window detection is a stub (`streetview.ts:248`). Honest, but the user asked for image + footprint. | A §3.1 step 3 | B15's image-to-3D (Pixal3D) is also an IMAGE input: a licence-clean elevation photo -> mesh -> `sliceMeshAtY` bands -> massing/feature candidates. Add it as an A09 input adapter (local measurement only; the derived mesh inherits the photo's licence and never ships). Keep annotations as the authority. |
| **BYOM on real files is unmeasured until wave 5.** B's corpus is 82 UNVERIFIED URLs, many login-only; the fetcher is B29; the first real-file gate is B30 (wave 5). | B §5, §8 | B29 and B01 are Wave 1. The orchestrator asks the user ONCE for the hand-downloads (Sketchfab, BrickLink) with the exact list (U-list item). Report counts per DISTINCT model from the first fetch, not at B30. |
| **"Hand-polished" is not defined by who does it.** A's Q5 offers agents / the user / a commissioned designer; the plan's acceptance is a silhouette IoU >= 0.85, which can be met by an unpolished voxel mosaic with the right outline. | A §3.1 step 9, §4.3 | Add a second fidelity axis to X-12: a part-type diversity floor and a "slope/arch/round share" per design, and a REVIEWED render contact sheet per icon in the provenance log (the user's rule: look at the render). Default owner of polish: agents, with the user approving each contact sheet (U-list). |
| **Fail-first tests that cannot fail for the right reason.** B16/B17 "fails until a benchmark summary exists"; D-18 "red until A's designs land"; C07/L01 "designs-gated". These are integration gates, not first unit tests. | B §7, D §9, A §10 | Each such package gets a REAL first unit test in the README (e.g. B16: "the held-out view's camera is not one of the four input cameras"; D-18: "the sampler product refuses a design id with no provenance log" against a fixture registry). |
| **Modularity is claimed per plan, not across plans.** Two brick cores, three lints, three validators, three credits writers, two renderers. | all | Section 2 above; the X- packages. |
| **The coaster's cars.** C02 says the cars come from "our own car design (brickgen vehicle grammar or a hand LDraw car), not from 26021", but the vehicle grammar is P01 (wave 8 in A). | A §10 | A hand-built LDraw car from generic parts is a C02 fixture; the grammar is not a dependency. Written into C02. |
| **The sampler's content comes from P01 (garage), which A schedules last.** D-18 needs one drivable original car, a door kit and a seat kit by "day 25". | D §8, A §11 | Split **P01a** (vehicle grammar + ONE car + the door/seat kits, wave 5) from **P01b** (the eight-vehicle Garage, wave 7). |
| **No package measures the cloud layer or the hyper speed on a device**, and both plans forbid phones. | A §5.1 | Kept as "measurements a decision still needs"; the first device round (U16) is the only way. The design targets a crest at about y 210 so it clears y 192 if that figure holds. |
| **The LEGO tab and the live `Craftmatic-Lego-Pack.mcpack` stay on the same domain as the "original designs only" funnel.** | D R3, B Q9 | One user decision (U14); D's pages do not link to the LEGO tab; default: rename the download and unlink it from the LEGO tab's button. |

## 4. Over-engineering to cut or defer

1. **B's SaaS layer before a converter worth paying for** (B19 passkeys, B20 tickets, B21 Stripe, B22 takedown +
   strikes, B23 showcase, B25 GPU queue, B24 cloud container, B27/B28 UIs): about 10 packages and a D1 schema of 11
   tables, for a product whose paywall B itself calls an honour system (public MIT repo). Defer all of it to wave 7+
   behind U6/U7; keep the `ExportEntitlement`, `PaymentProvider` and `AccountStore` INTERFACES (one file each) so the
   converter code does not change shape later. Build the converter quality first (B01, B03, B09-B14, B29, B30): that
   work also serves A (shared core) and the free tier.
2. **D's seven channel bundle builders as code** (`channels/{curseforge,mcpedl,itch,kofi,patreon,affiliate,site}.ts`).
   Ko-fi, Patreon and the affiliate programme are copy + two images. One data-driven generator over
   `release/channels/<channel>.json` (fields, limits, presets) is enough. D-09 is re-scoped so.
3. **D-15 weekly telemetry report with 8 adapters** before anything is released. Defer until after the first
   release; keep the `not granted` rule.
4. **D-06 conventional-commit changelog extraction.** The curated file is the source of truth; the extractor is
   noise. Cut to the curated check + renderings.
5. **A11 fidelity via headless Chrome + Playwright.** The sim rasteriser already renders packs offline
   (`_pack_render.ts`, `rasterizer.ts:82`) and B14 builds silhouette IoU on it. One renderer (X-12); no Chrome.
6. **A09 automatic photo analysis via `streetview-analysis.ts`** (`detectStories`, `analyzeFenestration`). Annotations
   always win, and the analysis was built for Street View captures. Keep it as an optional "suggestion" adapter with a
   `TODO`, not a stage.
7. **A's `_cleanroom_denylist.ts` + `_cleanroom_check.ts` + B06's fingerprint**: one similarity core (X-13).
8. **Budget tiers table before any measurement** (A §7.6). Keep as config with one `standard` tier until M06 measures.
9. **D-16 storyboard schema + generator**: a JSON file and one test; do not grow a module.
10. **Three validators** -> two (section 2).

## 5. Risks the plans under-weight

| Risk | Evidence | Mitigation in the README |
|---|---|---|
| **Every push to `main` deploys** the Worker and the site (`deploy.yml`, `wrangler-action`). Merging D-12/D-13/X-15 to `main` IS the "outward" deploy the plans mark as awaiting approval. | `.github/workflows/deploy.yml`; B18 knows (its no-active-route test); D does not say it. | Merges that change `web/` pages, `worker/` or `wrangler.toml` are **approval merges**: the user says yes before the merge, or the change is behind a config null that renders nothing. The README's merge protocol names them. |
| **Nine worktrees running `bun run test` at once on one PC.** The suite has 10-15 s synchronous phases; contention already produced `onTaskUpdate` timeouts at cores-1 workers (CLAUDE.md). | CLAUDE.md "Tests" | Implementers run their own test files + both typechecks in the worktree; the FULL suite runs once per merge, serialised by the orchestrator. |
| **Collisions the plans did not see** (E1): `gen-seat4-veh` / `gen-view-veh` hold unmerged edits to `schem-pipeline.ts`, `playable-components.ts`, `scene-vehicles.ts`; `gen-side-1109` to `cockpit-seat.ts`. B03, C02, X-17 edit `schem-pipeline.ts`. | `git diff --name-only main...<branch>` | Those three packages wait for the branches to merge (or the orchestrator merges the branches first). Listed in the README's serial chains. |
| **The post-pass rewriter misses a computed id** (`'craftmatic:' + x` in generated scripts, `craftmatic_` family names, dynamic-property keys). | A §2.2 admits it. | X-03's gate: zero tokens in the archive, `_mcaddon_check.py --release`, the sim's full scenario set, and the BDS smoke (T01) on the rewritten pack. `TODO(pack-ids)` threading after wave 4. |
| **Corpus and photo licences.** 82 candidates with "not stated" licences, CC BY-NC-SA, per-file Commons licences, Sketchfab "do not distribute". | B §5 | B29 records the licence per FILE and marks `unresolved`; nothing leaves `data/byom-corpus/`; nothing appears in a public document. |
| **OSM in a paid pack.** ODbL requires attribution on a Produced Work; share-alike applies to derived databases, not to the model. | A §3.2 | X-04 credits carry "(c) OpenStreetMap contributors" when a `SourceRef` is `odbl`. Lawyer item. |
| **The designs repo does not exist yet** (`C:/git/craftmatic-designs`: absent). L00+ and C07 write there. | `ls` | Wave 0 creates the local repo (not pushed); U2 decides a remote. |
| **The private repo question also covers `release/` and `worker/api`**, not only designs. | D R2, B Q7 | U2 answers all three at once; default below. |
| **Device-only facts gate three products** (cloud height, hyper speed, culling at 72 blocks, the chunk-loading pause). | A §5.1, §9.1 | One device round (U16) after X-02/X-03 land, with a written measurement list. |
| **Hand downloads by the user** for Sketchfab and BrickLink corpus items. | B §5 caveats | A one-time request with the exact list, in the U-list. |

## 6. What is good and kept

- A's measured baseline (§0) is accurate and the 10303 sizing (§0.4) is the right way to make "3x" testable.
- A's data types (§2.3) are a sound contract; the README copies `IntentLattice`, `BrickElement`, `PlacedElement`,
  `BrickPlan` and `ProvenanceLog` as the shared core's types.
- B's honesty about photos (2/90 poses on the PDF pipeline; no part-exact recovery) and its staged gates with
  synthetic ground truth from the sim rasteriser.
- B's "build runs in the browser, the server sees a hash" architecture and the live-key refusal test.
- D's release identity (frozen uuids, `:dev` salt, identity ledger), deterministic build (SOURCE_DATE_EPOCH, pako
  deflate), "no upload code" static scan, and the "not granted, never zero" telemetry rule.
- All three plans name a first failing test per package and keep outward steps as unchecked approval items.
