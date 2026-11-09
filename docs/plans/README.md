# Business build-out: master plan (BIZ-65)

**Goal.** Turn craftmatic's LDraw -> Bedrock add-on engine into three products the user chose on 2026-11-09: **A**,
original brick-style packs for the Minecraft Marketplace (a part mapper from real-building inputs, >= 20
hand-polished landmark icons, an epic coaster >= 3x 10303 Loop plus other show-stoppers, a garage, pinball,
furniture and funfair packs, our own figure, Marketplace readiness); **B**, a bring-your-own-model converter sold as
a tool (model files, meshes and photos in; a playable add-on and a validation report out; tested on real user files);
**D**, free releases of our own packs as the funnel. Everything shipped is our own design, carries LDraw attribution
and the Mojang disclaimer, never a LEGO name, set number, minifigure or licensed theme; nothing goes outward without
the user's per-instance approval. This file is the single entry point for the orchestrator and for a fresh session.

- Plans: [A: original packs](business-A-original-packs.md) | [B: BYOM converter](business-B-byom-converter.md) |
  [D: free releases](business-D-free-releases.md) | [the review](business-review.md) (read §2 of the review for why
  the shared packages below exist).
- Binding rules: Appendix A (the legal guard rails and process rules, verbatim from the planning brief). Every
  implementer brief repeats them.
- Tracker: `TASKS-BUSINESS.md` (open work only). Ledger: `REQUIREMENTS.md` §17 (`BIZ-05..64`, §6 below).

---

## 1. How the three plans merge

One pipeline, one profile, one core:

```
 inputs                         shared core (web/src/brickgen/)                  engine (existing)                 profile + gates
 ─────────────────────────      ─────────────────────────────────────────         ─────────────────────────         ───────────────────────────
 A: footprint/LiDAR/photos  ─►  site ─► massing ─► features ─► grammar ─┐                                            X-02 PackProfile (ids, version,
 B: .ldr/.io/.lxf (B01)    ─────────────────────────────────────────────┼─► IntentLattice ─► X-10 bricker ─► X-09    clock, texts, flags, entitlement)
 B: mesh/photos (B09,B15)  ─►  X-11 lattice-from-mesh ─► B12 surface ───┘    verify ─► X-08 writer ─► .ldr ─►      ─► X-03 id/folder rewriter
                                                                              parseLDrawDocument ─► runSchemPipeline ─► X-06/X-07 validators, X-04 credits,
                                                                              (X-17 explicit mode, no title canon)      X-05 lint, sim, T01 BDS ─► .mcaddon
```

Shared fixes have ONE owner (review §2): identity **X-01**, the pack profile seam **X-02**, the namespace/folder
rewriter **X-03**, part sources + official-only library + credits **X-04**, player text + disclaimer + lint **X-05**,
validators **X-06** (Python + mct) and **X-07** (TS port), brick core **X-08/X-09/X-10**, mesh lattice **X-11**,
metrics **X-12**, similarity **X-13**, media renderer **X-14**, Worker router **X-15**, explicit mode **X-17**, the
figure **F01..F03**. Original ids (A-xx as `A01`, `M01`, `C01`...; `B01`..`B30`; `D-01`..`D-18`) are kept where a
package is unchanged; a package absorbed into an X- row is listed once with "-> X-nn".

### 1.1 Shared type contract (so Wave-1 packages can start in parallel)

Copied from plan A §2.3; X-08 owns the file `web/src/brickgen/types.ts`. Until it merges, X-11 declares an identical
local type and switches the import in Wave 2.

```ts
/** One cell per stud column x plate layer; 0 = empty, otherwise 1 + index into `labels`. */
export interface IntentLattice { dims: [studsX: number, plates: number, studsZ: number]; cells: Uint16Array; labels: IntentLabel[] }
export interface IntentLabel {
  role: 'wall' | 'floor' | 'roof-slope' | 'roof-flat' | 'window' | 'arch' | 'column' | 'trim' | 'detail' | 'terrain' | 'support' | 'solid';
  colour: number;                       // LDraw colour code
  feature?: string;
  slope?: { dir: 0 | 1 | 2 | 3; rise: 1 | 2 | 3 };
  hollowOk?: boolean;
}
export interface BrickElement { part: string; footprint: [number, number]; heightPlates: number; occupancy?: Uint8Array;
  connections: { studsTop: Array<[number, number]>; antiStudsBottom: Array<[number, number]>; side?: 'clip' | 'bar' | 'pin' };
  roles: IntentLabel['role'][]; licence: string; author: string }
export interface PlacedElement { part: string; colour: number; at: [sx: number, plate: number, sz: number]; turn: 0 | 1 | 2 | 3; group: string }
export interface BrickPlan { elements: PlacedElement[]; groups: Array<{ id: string; label: string }>; scale: ModelScale; metas: AuthoringMeta[] }
export interface ModelScale { studsPerMetre: number; platesPerMetre: number; reason: string }
/** X-01 (web/src/release/types.ts). `namespace` is null until U1 is answered; a release build refuses null. */
export interface ProductIdentity { namespace: string | null; folderStem: string;
  uuids: { bpHeader: string; bpData: string; bpScript: string; rpHeader: string; rpResources: string } }
/** X-02: the one option that makes a dev pack a release/Marketplace/BYOM pack. All fields optional; absent = today's dev pack. */
export interface PackProfile { identity?: ProductIdentity & { namespace: string }; version?: [number, number, number]; clock?: number;
  texts?: Partial<{ packName: string; bpDescription: string; rpDescription: string; readme: string; lang: Record<string, string> }>;
  flags?: Partial<{ vanillaTextures: boolean; diagnostics: boolean; faceArt: boolean; devStamp: boolean; explicitOnly: boolean }>;
  entitlement?: unknown /* B08's ExportEntitlement */; deflate?: (data: Uint8Array) => Uint8Array }
```

The `IntentLattice` cell is 20 x 8 x 20 LDU (1 stud x 1 plate x 1 stud); mesh input (X-11) scales Y by 20/8 and
voxelises isotropically at 20 LDU. `role: 'solid'` is the mesh front-end's label (no architectural intent).

---

## 2. Merged work-package table

Columns: id | owner | goal | files touched | first failing test (`test/<file>.test.ts :: <name>`) | acceptance | dependencies |
needs user decision? (U-ids from §5; "no" = can start when deps are met). Status lives in `TASKS-BUSINESS.md`, not here.

### 2.1 Shared (X-)

| id | owner | goal | files | first failing test | acceptance | deps | decision? |
|---|---|---|---|---|---|---|---|
| **X-00** | orchestrator (wave 0, inline, no worktree) | Add `BIZ-05..64` rows (§6) and the three tracker sections to `TASKS-BUSINESS.md`; create the local designs repo (§8); commit. Nobody else edits these two files. | `REQUIREMENTS.md` §17, `TASKS-BUSINESS.md`, `C:/git/craftmatic-designs/` (new local git repo) | `test/requirements-ledger.test.ts` (existing) passes with 60 new OPEN rows | ledger test green; `bun scripts/requirements-ledger.ts --open` lists them | none | no (U2 default applied) |
| **X-01** (= D-01) | D | Product identity minted once (random v4 uuids, never from a label), semver, `:dev` salt so dev builds never shadow a release, append-only identity ledger (version rises; namespace/uuids frozen; no shipped entity/block/item id dropped) | NEW `web/src/release/{types,semver,product,identity-ledger}.ts`, `release/products/sampler.json` (`namespace: null`), `release/identity-ledger.json`, `scripts/release.ts` (`init-product` only) | `release-identity :: the same product at 1.0.0 and 1.1.0 keeps every uuid` | + `a version that does not rise is refused`; `dropping an entity id a released version shipped is refused`; `a null namespace refuses a release build`; `dev identity uuids differ from release uuids`; `semver maps to the manifest triple`; `init-product` refuses to overwrite | none | no (namespace stays null until U1) |
| **X-02** (= D-02 + A M04 + B04/B08 hooks) | D | ONE `PackProfile` option on `buildPlayableAddon` (§1.1): identity uuids + semver instead of `packIdentity`/`packVersionAt`; injected clock for `builtAt`/`computedAt`; texts for name/descriptions/README/lang (no stamp, no LEGO words); RP `pack_scope: "world"`, RP depends on BP header and BP on RP, `min_engine_version` on both; `vanillaTextures:false` skips the 17 `concrete_*.png`; `diagnostics:false` drops `craftmatic-diagnostics.json`; `faceArt:false` refuses `--faces`/head prints; `devStamp:false`; `deflate` injection; `entitlement` passed through to B08's hook. Dev pack byte-identical when the option is absent. | `web/src/engine/playable-addon.ts` (`:2606-2630`, `:2652-2657`, `:4062`, `:4099`), `pipeline-version.ts` (clock, profile-aware `packDisplayName`), `mcpack.ts` (only if needed), `scripts/_playable_ref.ts` (`--profile=<json>`) | `playable-addon-profile :: a profile build uses the registry uuids, the semver version and pack_scope world` | + `two profile builds at different wall clocks are byte-identical`; `a profile pack carries no craftmatic-diagnostics.json and no pipeline stamp in any name`; `vanillaTextures:false ships no file under textures/blocks/concrete_*`; `without a profile the dev pack is unchanged` | X-01 (type), D-03 (deflate), X-05 (default texts) | no |
| **X-03** (= A M01 + M02) | A | Post-pass rewriter over the finished file list: every `craftmatic:`/`craftmatic_`/`geometry.craftmatic.`/`animation.`/`controller.*` id, `.lang` keys, `.mcfunction`, script string literals and prefix constants -> `<creator>_<pack>`; `<type>/<creator>/<pack>/` folders with references rewritten; guard = zero `craftmatic` tokens (case-insensitive, credits file excepted) + `_mcaddon_check.py --release` + `sim.ts` on the result. `TODO(pack-ids)`: thread ids after wave 4. | NEW `web/src/engine/marketplace/rewrite.ts`, `scripts/_marketplace_pack.ts`; reads `ProductIdentity` from X-01 | `marketplace-rewrite :: a rewritten pack contains no craftmatic token and every geometry an entity names is defined` | + `no file sits loose in a content type folder after the rewrite`; clean on packs from 3 synthetic fixtures (`test/playable-addon.test.ts`); `_mcaddon_check.py` passes; sim `child-play` + `vehicles` pass on the rewritten pack | X-01 | no (uses placeholder creator `cmt` until U1) |
| **X-04** (= A M10 + M09 + B05 + D-04) | D | Part-source ledger: each resolved `.dat` records the library file actually read, class (`ldraw-official` / `ldraw-unofficial` CC BY / `studio` / `mirror` / `custom` (.io) / `substituted` alias), `!LICENSE` and `Author` lines (every subfile and primitive reached). Library mode `official` (`CRAFTMATIC_LDRAW_LIBRARY=official` or profile): resolve only from `ldraw_ref/official` (+ unofficial with CC BY line), no Studio `UnOfficial/`, no `bl_`, no alias substitution, no `logo*` primitives; unresolved parts FAIL the export with the list. `credits.ts` writes `CREDITS.txt`: LDraw CC BY 2.0/4.0 notice, each author once, "not endorsed by LDraw.org", OSM ODbL when a `SourceRef` is `odbl`, never part descriptions. Committed sorted official-parts list generated from `complete.zip` + `ldrawunf.zip`. | `web/src/engine/ldraw-geometry.ts` (`:181`, `:190-201`), `ldraw-entity-compiler.ts` (report fields beside `unresolvedParts:408` / `substitutedParts:447`), NEW `web/src/engine/part-source.ts`, `web/src/engine/credits.ts`, `scripts/gen-ldraw-official-list.ts`, `web/src/engine/ldraw-official-parts.generated.ts` | `part-source :: in official mode a part present only in Studio's UnOfficial tree fails the export with its name` | + `official 3001.dat records "Licensed under CC BY 4.0" and author James Jessiman` (existsSync-gated, read inside `it`); `credits list every author of every used part exactly once`; `credits never contain part descriptions`; `datSubstitutions stays empty in official mode`; default (dev) mode unchanged; counts on 10 corpus `.io` files recorded in the tracker | none | no |
| **X-05** (= A M08 + B04 + D-05) | D | `pack-text/`: the player-facing string table ("brick" not "LEGO", "figure" not "minifig", "model" not "set"); the Mojang disclaimer verbatim ("NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT."), publisher + contact block, `DISCLAIMER.txt`; the forbidden-terms lint over manifests, `.lang`, README, script string literals, book/form/action-bar strings and listing copy: `lego\|duplo\|minifig(ure)?\|technic\|bionicle\|ninjago\|brickheadz\|bricklink\|studio`, set-number shapes `\b\d{4,6}(-\d)?\b` in names, licensed themes (maintained list), the genre-reference names (Space Mountain, Seven Dwarfs, Speed Racer, Six Flags), dev stamps, `craftmatic` outside credits, "Minecraft" except secondary/disclaimer position; explicit exemptions with reasons. | NEW `web/src/engine/pack-text/{strings,notices,lint}.ts`, `release/copy/common/*.md` | `pack-text-lint :: the lint flags "minifig" in a README` | + `a set number in a pack name is flagged`; `the dev README text at playable-addon.ts:4099 fails the lint` (proves it catches today's text); `every profile pack carries the exact disclaimer in both manifests, DISCLAIMER.txt and README`; `exemptions are explicit` | none | no |
| **X-06** (= D-07 + A M05) | D | `scripts/_mcaddon_check.py --release` (ONE extra mode; `--marketplace` is an alias): `pack_scope: world`, RP->BP dependency, one namespace not `craftmatic` across entity/block/item/geometry/animation/render-controller ids, `<type>/<creator>/<pack>/` folders with no loose files, no vanilla-path textures, permutations <= 10,000 (dev mode keeps 65,536), <= 25 MB uncompressed and <= 3,500 files, block/item textures <= 256 px and others <= 2048, no `-beta` modules, no `minecraft:` definitions, no diagnostics file, CurseForge zip-without-root rule. `scripts/release-mctools.ts`: runs `bunx @minecraft/creator-tools@0.21.0 validate -i <unzipped>` (pinned), parses to `{errors, warnings, rules[]}`, reports `not-run` with the reason when `mct eula` is not accepted; never refuses on Node version alone (the package declares no `engines`). | `scripts/_mcaddon_check.py` (in place), NEW `scripts/release-mctools.ts`, fixture zips under `test/fixtures/mcaddon/` | `mcaddon-check-release :: a pack without pack_scope world fails --release` (spawns `python -I scripts/_mcaddon_check.py --release <fixture>`) | + `10,001 permutations fail --release while 65,536 still passes dev mode`; `a craftmatic: id fails --release`; `a texture at a vanilla path fails --release`; `the mct report parser counts Errors on a recorded output fixture`; today's 10261 pack fails with every T4-T9 blocker named; a rule-built fixture passes | none | no (the live mct run needs U13) |
| **X-07** (= B07) | B | TS port of `_mcaddon_check.py` incl. `--release` rules, as `pack-check.ts` (runs in the browser Worker, Bun and vitest); parity test against X-06; `report.ts` assembles B's `ValidationReport` (structure, `McpackSummary`, sim child-play via `addon-sim-worker`, part sources from X-04, screen from X-13) and renders a self-contained dark `report.html` | NEW `web/src/engine/byom/pack-check.ts`, `report.ts` | `byom-pack-check :: pack-check agrees with _mcaddon_check.py --release on three built packs` | + `the report lists a door found but not hung, with its reason`; parity on the 40 favourites' packs in `output/favsweep-4da29033/` (local-only, existence gated at module load) | X-06, X-04; X-13 may be a typed `null` with a TODO | no |
| **X-08** (= A01 + A02 + A03; absorbs B10 palette, B11 writer) | A | The brick core: `types.ts` (§1.1); `vocab/` of ~80 OFFICIAL elements (bricks/plates 1x1-2x10, slopes incl. inverted and curved, arches 1x3-1x12, round bricks/plates, cones, domes, windows + frames, doors, tiles, brackets, lattice/fence, bars) with occupancy and connections read from geometry and `!LICENSE`/`Author`; `scripts/_vendor_ldraw_vocab.ts` vendors those parts + every reached subfile/primitive into `test/fixtures/ldraw-vocab/` with a generated `LICENSE.md`; `colour.ts` `nearestLdrawColour(rgb, palette)` (Lab/CIEDE2000, transparents only when asked, deterministic ties); `emit/ldraw-writer.ts` `BrickPlan` -> MPD (one `0 FILE` per group, sorted group/y/z/x, LF, `0 Author:`, our `!LICENSE` line placeholder, exact quarter-turn matrices) and the authoring metas `!CRAFTMATIC FIGURE\|SEAT\|DOOR\|SPAWN\|DESIGN` registered in `ldraw-directives.ts`, parsed by `ldraw-parser.ts`, passing `_converter_coverage_audit.ts` | NEW `web/src/brickgen/{types,colour}.ts`, `web/src/brickgen/vocab/*`, `web/src/brickgen/emit/ldraw-writer.ts`, `scripts/_vendor_ldraw_vocab.ts`, `test/fixtures/ldraw-vocab/**`; EDIT `web/src/engine/ldraw-directives.ts`, `web/src/engine/ldraw-parser.ts` | `brickgen-vocab :: every vocabulary element is an official LDraw part with a CC BY licence line` | + `brickgen-colour :: pure white maps to LDraw 15 and a sandstone tan maps to 19`; `every production colour maps to itself`; `brickgen-ldraw-writer :: a written plan parses back through parseLDrawDocument to the same parts, colours and positions`; `byte-identical output for the same plan`; `metas survive the round trip`; `occupancy of a 45-degree slope matches its geometry`; 0 elements from Studio or `bl_`; coverage audit passes; `typecheck:web` clean | none | no |
| **X-09** (= A04) | A | Lattice verifier: stud/anti-stud connectivity components (target 1); stability = a load path to the ground per element, cantilever limits per element class (default 4 studs per plate layer; arches/slopes count as supported); overlaps; legality (vocabulary only, CC BY, no `logo`, no Studio/`bl_`); budget estimate (cuboids); `auditConnectivity` cross-check helper (it over-connects: may report the same or fewer components) | NEW `web/src/brickgen/verify/{connect,stability,overlap,legality,budget}.ts` | `brickgen-verify :: a 1x4 plate bridging two towers by one stud each is connected; the same plate one plate higher is two components` | + cantilever limits per class; budget within 15 % of the compiled cuboid count on 3 goldens (measured) | X-08 | no |
| **X-10** (= A06 = B11 merge) | A | Bricker: `IntentLattice` -> `BrickPlan`: largest legal element per run (1xN to 1x8, 2xN to 2x10), running bond (no aligned seams in consecutive layers), 3 plate layers -> brick, slopes by `slope` label, arches/rounds/cones by role, window/door frames sized to openings, hollow interiors where `hollowOk`; repair pass (split a seam-aligned element, re-cover) until X-09 reports one component | NEW `web/src/brickgen/bricker/*` | `brickgen-bricker :: a 6 x 6 x 9-plate solid wall lattice bricks to one connected component with no aligned seams in consecutive layers` | + `a solid 4x4x3-plate block becomes a 2x4-brick stack with no full-height vertical seam`; goldens (box house, L-plan, courtyard) verify at 1 component, 0 unsupported, part counts within bands | X-08, X-09 | no |
| **X-11** (= B10) | B | Mesh -> `IntentLattice` (`role: 'solid'`, colour per cell): scale Y by 20/8, voxelise isotropically at 20 LDU through `threeToGridAsync`, solid/surface mode as `mesh-to-grid.ts:59-66`, colours from `texture-sampler.ts` / vertex colours (linear -> sRGB), palette snap through an injected `nearest(rgb)` (X-08's `nearestLdrawColour` once merged); default buildable palette = 40 most common solid colours | NEW `web/src/engine/legolize/lattice.ts` (local type copy until X-08 merges) | `legolize-lattice :: a 40x24x40 LDU box fills exactly 2x3x2 plate cells` | + `a vertex-coloured red mesh snaps to LDraw 4`; voxel IoU vs input >= 0.85 on 5 clean corpus meshes (target, recorded) | none (B09 for formats, not for tests) | no |
| **X-12** (= B14 + A11 metric) | B | Metrics harness on the sim rasteriser (`web/src/sim/render/rasterizer.ts:82`): voxel IoU between two lattices (best integer shift +-2), silhouette IoU for 6 axis views + N cameras, median CIEDE2000 per matched cell, connectivity stats, part-type diversity (share of slopes/arches/rounds, distinct parts) and a contact-sheet PNG <= 1999 px; CLI `scripts/_byom_metrics.ts`. A's polish fidelity uses THIS (no headless Chrome). | NEW `web/src/engine/legolize/metrics.ts`, `scripts/_byom_metrics.ts` | `legolize-metrics :: IoU of a lattice with itself shifted one cell is 1 after alignment and < 1 before` | + silhouette of a known box from the +x camera equals its analytic outline; contact sheet under 2000 px | X-11 (type) | no |
| **X-13** (= B06 + A `_cleanroom_*`) | B | Similarity core: 128-hash MinHash over `partStem\|colour` multiset tokens + `hash12`; part-histogram cosine; aligned voxel IoU. Callers: (a) `scripts/_cleanroom_denylist.ts <keywords>` lists corpus paths matching a landmark; `scripts/_cleanroom_check.ts <design.ldr>` scores it against the denylist and writes `clearance` into the provenance log (run by a DIFFERENT agent than the designer); (b) the BYOM official-set screen `verdict clear/review/blocked` with thresholds calibrated per DISTINCT set on the corpus and index (`web/public/lego-models-index.json` hashes; Rebrickable tables only after U10). | NEW `web/src/engine/byom/fingerprint.ts`, `scripts/build-official-fingerprints.ts`, `scripts/_cleanroom_denylist.ts`, `scripts/_cleanroom_check.ts` | `byom-fingerprint :: an official set's own LDraw file is blocked` | + `a part-shuffled copy (positions changed, same inventory) is still blocked`; `a corpus MOC is clear`; `the denylist lists the corpus's landmark sets for "notre dame"`; calibration table (<= 1 % false block on MOCs, >= 95 % review-or-block on official sources) in the tracker; thresholds pinned in a test | X-08 (`partStem` is in `engine/part-id.ts`, exists) | partly: the clean-room half no; the Rebrickable-fed DB needs U10 |
| **X-14** (= D-11 + A S01 renderer) | D | `scripts/media-turntable.ts` on the shared framing module extracted IN PLACE from `_pack_render.ts`: `--game-frame` (mirror JSON X), 2x supersampling + Lanczos, auto-fit, ground shadow + backdrop; ffmpeg to WebM/MP4/GIF + posters; presets (`cf-logo` 800², `screenshot` 1600x900, `itch-cover` 630x500 / 1260x1000, `mcpedl-thumb` 1280x720, `og` 1200x630, `yt-thumb` 1280x720 <= 2 MB, `banner` 1600x400, `avatar` 512², `turntable` 1080² and 1080x1920; store presets added by S01), all < 2000 px and < 4 MB | NEW `web/src/release/media-presets.ts`, `scripts/media-turntable.ts`; EDIT `scripts/_pack_render.ts` (extract framing) | `release-media :: a game-frame render of an asymmetric fixture puts the marker on the side the device shows` (one-cube pack, marker at +X, per `block-collision-x-mirrored` / `worldFaces`) | + `every preset output is under 2000 px each side and under 4 MB`; `the GIF preset drops frames rather than exceed 4 MB`; 72-frame turntable of `60221-diving-yacht.mcaddon` in < 60 s; output LOOKED at; model fills 55-75 % of frame width | none | no |
| **X-15** (= B18) | B | Worker entry `worker/index.ts`: `/api/*` -> `worker/api/router.ts`, everything else -> `ldraw-omr.js` unchanged; `AccountStore` interface + `store-memory.ts` (D1 implementation and migrations deferred to B19); `wrangler.toml` `main` switched, any `/api/*` route and D1 binding COMMENTED "awaiting approval"; `.dev.vars` in `.gitignore`; a test asserts no active `/api/*` route unless `BYOM_ROUTES_APPROVED` is set (deploy.yml deploys on every push) | NEW `worker/index.ts`, `worker/api/{router,env,store,store-memory}.ts`; EDIT `wrangler.toml`, `.gitignore` | `byom-api-router :: an unknown /api route answers 404 JSON and /ldraw-parts still reaches the old handler` | + `wrangler.toml has no active /api route while BYOM_ROUTES_APPROVED is unset`; `bunx wrangler deploy --dry-run` succeeds | none | no, but its MERGE is an approval merge (§7.3) |
| **X-17** (= B02) | B | One predicate `labelHeuristicsAllowed(input)` guarding every title/set-number site: `canonFor` (`schem-pipeline.ts:636`), `isTimeMachine` (`playable-addon.ts:2589`), Batcave (`:2599`), `isWholeVehicleLabel` (`:2596`), `playable-components.ts:107`. Off for BYOM inputs AND for brickgen designs (profile `explicitOnly`); a grep test lists every site and asserts each is guarded | `schem-pipeline.ts`, `playable-addon.ts`, `playable-components.ts`, `set-canon.ts` | `explicit-mode :: a model titled "10300 Time Machine" exported in explicit mode ships no time circuits` | + `an explicit-mode title with a vehicle word stays static without a hint`; `every label-regex site is guarded` (grep test) | X-02 (the flag); `gen-seat4-veh`/`gen-view-veh` merged first (they edit `schem-pipeline.ts`, `playable-components.ts`) | no |

### 2.2 Scenario A (original packs) — unchanged ids from plan A §10 unless noted

| id | owner | goal | files | first failing test | acceptance | deps | decision? |
|---|---|---|---|---|---|---|---|
| A01, A02, A03 | -> **X-08** | | | | | | |
| A04 | -> **X-09** | | | | | | |
| **A05** | A | Massing: OSM footprint + `building:part` heights + tags -> `MassVolume[]`; polygon simplify + stud snapping (non-orthogonal = `TODO(non-orthogonal)`); scale choice clamped to the budget; licence gate refusing `google-maps-content`/`unknown` for a commercial run; `web/tsconfig.json` gains the pipeline's pure modules (`context`, `fusion`, `synthesis/slice-extract`, brep types) | NEW `web/src/brickgen/site/{osm,licence-gate}.ts`, `web/src/brickgen/massing/*`; EDIT `web/tsconfig.json` | `brickgen-massing :: a 20 x 10 m rectangle at 1 stud per metre becomes a 20 x 10 stud volume with edges on the grid` | polygons with holes; part heights; `the licence gate refuses google-maps-content`; `typecheck:web` clean | X-08 | no |
| A06 | -> **X-10** | | | | | | |
| **A07** | A | Roof + tower grammars (gabled, hipped, pyramidal, conical, dome, onion, spire, mansard; square/octagonal/round towers) | NEW `web/src/brickgen/grammar/{roof,tower,spire,dome}.ts` | `brickgen-grammar-roof :: a gabled roof over a 10-stud span at 45 degrees uses slope elements on both faces and closes at the ridge` | every roof golden verifies; slopes face outward | X-08, X-10 | no |
| **A08** | A | Facade grammars (bays, string courses, rectangular/round-arch/lancet openings, rose windows, buttresses, flying buttresses, columns, battlements, clock faces, lattice girders, cables) | NEW `web/src/brickgen/grammar/{wall,facade,window,arch,column,buttress,lattice}.ts` | `brickgen-grammar-facade :: a 3-bay facade with lancet windows leaves 3 openings of the requested size and stays one component` | cruciform-church golden verifies; openings within 1 stud / 1 plate | X-08, X-10 | no |
| **A09** | A | Features: tags, JSON annotation sidecars on licensed photos/drawings (authority), mesh slices (`sliceMeshAtY`), and an optional image-to-3D adapter (B15's GLB of a licence-clean elevation photo -> bands; local measurement only, the mesh never ships); legacy photo analysis only as a `TODO` suggestion adapter | NEW `web/src/brickgen/features/*` | `brickgen-features :: an annotation marking a rose window on edge 0 yields one rose FeatureSpec at the marked height` | an annotation beats any automatic source; every feature cites a `SourceRef` | A05 | no |
| **A10** | A | `bun scripts/brickgen.ts <site.json> --design=<design.json> --out=<dir>` -> `generated.ldr`, `verify.json`, optional dev `.mcaddon` via `runSchemPipeline` with `explicitOnly` | NEW `scripts/brickgen.ts`, `web/src/brickgen/index.ts` | `brickgen-pipeline :: the cruciform golden runs site to .ldr to a playable pack offline against the vendored vocabulary` | runs on CI; refuses to emit on a verify failure unless `--allow-unverified` | A05, A07-A09, X-10, X-17 | no |
| **A11** | A | Polish ops (`designs/<slug>/polish.ops.json`, each with `why`, replayed after regeneration) + fidelity through X-12 (silhouette IoU per reference elevation, dE2000, part diversity) + a reviewed contact sheet per design in the provenance log; thresholds calibrated on L01 | NEW `web/src/brickgen/polish/*`, `web/src/brickgen/provenance.ts` | `brickgen-polish :: replaying polish ops on a regenerated plan reproduces final.ldr byte for byte` | + `an op that targets a vanished group is reported, never dropped`; `a provenance log without a clearance entry fails validation` | X-08, X-12, A10 | U17 (who polishes; default agents) |
| M01, M02 | -> **X-03** | | | | | | |
| **M03** | A | Own brick blocks `<ns>:brick_<colour>` (+ `plate_` if budget) with own textures under `textures/<creator>/<pack>/blocks/`; collider states re-encoded as one `pair` 0..135 (or valid permutations only): 11,008 -> 5,848 so the sum stays <= 10,000; `addon-walk.ts` + sim read the same definition; dev pack device-proven behaviour unchanged | NEW `web/src/engine/marketplace/blocks.ts`; EDIT `web/src/engine/collider-form.ts` (`:87-88`, `:553-556`), `web/src/engine/addon-walk.ts`, sim collider reader | `marketplace-blocks :: a profile pack ships no file at a vanilla texture path and its block permutations total at most 10000` | sim `regressions` passes on the dev pack; dev pack byte-identical except the chosen state encoding | X-02, X-03 | no |
| M04 | -> **X-02** | | | | | | |
| M05 | -> **X-06** | | | | | | |
| **M06** | A | Runtime budget gate `scripts/_marketplace_budget.ts`: resident entities/cuboids after placement (from the sim's placement plan), median script ms/tick (`_sim_script_cost.ts`), plus X-06's static numbers; one `standard` tier (60k cuboids, 120 entities, 4 ms, 25 MB) until measured | NEW `scripts/_marketplace_budget.ts`, `web/src/engine/marketplace/budget.ts` | `marketplace-budget :: block permutations are summed over every custom block and states product` | reports 11,008 on today's collider set; JSON for the bundle | none | U17 (tiers; default one tier) |
| **M07** | A | Air-only placement with a prompt ("n foreign blocks; Find a clear spot / Move / Cancel"), never replaces; Undo restores the sim world exactly; no ticking area survives placement or Undo; onboarding guide book once per player; chat <= 28 chars on first join only; `[Brick Wand]` chat -> action bar under the profile | `web/src/engine/bedrock-placement-pack.ts` (`:998`, `:1013-1024`, `:1553`, `:1839`), `test/bedrock-placement-undo-reload.test.ts` | `bedrock-placement-air-only :: placing over one foreign block refuses and offers a clear spot; nothing is replaced` | Undo exact; no ticking area left; chat rule; dev behaviour unchanged without the profile | X-02, X-03 | no (ticking-area policy U17/publisher) |
| M08 | -> **X-05** | | | | | | |
| M09, M10 | -> **X-04** | | | | | | |
| **M14** | A | Simulator reads the namespace from the pack: replace the 54 `craftmatic:` literals in `web/src/sim/` | `web/src/sim/adapters/craftmatic/*`, `web/src/sim/quirks/*` | `sim-namespace :: child-play runs on a pack whose namespace is cmt_test` | all sim scenarios unchanged on dev packs | X-03 | no |
| **M15** | A | Stable Script API audit: `// @ts-check` of every emitted script against vendored stable `@minecraft/server` / `server-ui` typings | NEW `scripts/_script_api_audit.ts` | `script-api-stable :: an emitted script calling a beta-only API fails the audit` | API list with stability in the bundle | none | no |
| **T01** | A | BDS smoke gate: copy `C:/git/bds/1.26.63.1` to a NEW folder per run, a NEW world with no experiments/Beta APIs, install + bind the pack, run placement + a `scriptevent` smoke (place, one headless lap, Undo), parse the content log, exit 1 on any pack error/warning | NEW `scripts/_bds_smoke.ts`, `docs/testing-guide.md` (one section) | `bds-smoke-parse :: the content-log parser flags a pack warning line and ignores vanilla noise` | one profile pack loads with 0 pack errors/warnings; log saved | X-02, X-03 | no |
| **T02** | A | sim `--scenario=marketplace`: cluttered placement refuses/relocates; Undo exact; guide book once; chat <= 28; no ticking area; two players without cross-talk | NEW `web/src/sim/adapters/craftmatic/marketplace.ts`; EDIT `scripts/sim.ts` | `sim-marketplace :: the marketplace scenario fails a pack whose placement replaces a block` | two-player case included | M07, M14 | no |
| **C01** | A | `coaster-design.ts`: `CoasterDesign` elements -> `GeneratedCoaster` (points <= 0.4 blocks apart via clothoids, heartline rolls, explicit `ups`, zones, report {length, height, footprint, inversions, g, speed, lap}); validator: closure (position/tangent/up continuous), vertical g in [-1, 4.5], lateral <= 1.5, jerk, world height | NEW `web/src/engine/coaster-design.ts` | `coaster-design :: a station-lift-drop-loop-brake circuit closes with continuous position, tangent and up` | + `a loop of radius r reports one inversion`; `an airtime hill's crest g is below 0`; `the report of a 3x design exceeds 10303 on length (>= 545), height (>= 132), footprint (>= 120) and inversions (>= 6)` | none (pure math over `coaster-path.ts` types) | no |
| **C02** | A | A `CoasterDesign` feeds `coasterRuntimeConfig` with explicit ups and zones; cars from a hand-built LDraw car of generic parts (fixture; not 26021, not the P01 grammar) | `web/src/engine/schem-pipeline.ts` (`:556-620`), `web/src/engine/bedrock-coaster.ts` (route assembly) | `coaster-generated-route :: a pack built from a CoasterDesign carries its route with the design's length and ups` | sim `coaster-camera` runs on it | C01, X-17; `gen-seat4-veh`/`gen-view-veh` merged | no |
| **C03** | A | Rail geometry: brick-styled rails + ties (own geometry), chunked so every chunk root is within `STATIC_SHELL_RADIUS_LIMIT_BLOCKS` of its cubes; offline comparison entities vs custom-block rails recorded in `docs/bedrock-addon-guide.md` | NEW `web/src/engine/coaster-track-mesh.ts` | `coaster-track-mesh :: every rail chunk's root lies within STATIC_SHELL_RADIUS_LIMIT_BLOCKS of each of its cubes` | `_pack_render.ts --walk-away` shows continuous rail | C01 | no |
| **C04** | A | Zones: launch (target speed over a length), cable lift, block brakes + two-train dispatcher, trims, per-route `maxSpeedBps` replacing `MAX_SPEED`; sim metrics (lap, g, lateral, peak speed, darkness time, block holds) and a measured cap where teleports/chunk loading hold | `web/src/engine/bedrock-coaster.ts` (`:641`, `:760`), NEW `coaster-zones.ts`, `web/src/sim/adapters/craftmatic/coaster.ts` | `coaster-zones :: a launch zone takes a train from 2 to 30 blocks/s within its length` | two trains never share a block section; cap recorded in `docs/physics-architecture.md` (`_physics_spec_check.ts` passes; run `typecheck:web` first) | C02 | U17 (pace; default sqrt 2) |
| **C05** | A | Show cues by arc distance: darkness/blindness, `camera.fade`, light blocks into AIR only (Undo removes), emissive neon materials, own namespaced sounds/particles | `coaster-zones.ts`, `bedrock-coaster.ts` (cue runner) | `coaster-show :: entering a dark zone applies darkness to every rider once and removes it on exit` | Undo removes every light block; no cue touches a non-rider | C04 | U17 (sounds; default synthesised/CC0) |
| **C06** | A | Scenery grammars: hollow artificial mountain as own brick BLOCKS, cloud banks, station, queue, supports, neon arches | NEW `web/src/brickgen/grammar/{terrain,cloud,support}.ts`; `marketplace/blocks.ts` palette | `brickgen-grammar-scenery :: supports reach the ground from every track sample above 4 blocks and never cross the rider envelope` | renders reviewed | X-10, C01, M03 | no |
| **C07** | A | "Cloudbreak Summit" (working title): the P1 design to §5.1 targets (track 900-1,200, height 140-150, footprint 160-200, 6-7 inversions, 2 trains x 6 cars x 2 riders), polished; camera sim cases (6 inversions, launch, 140-block drop, `--client=both`) | `$CRAFTMATIC_DESIGNS/rides/cloudbreak/*`, sim case file | `cloudbreak :: the Cloudbreak report exceeds 3x 10303 on length, height, footprint and inversions` (designs-gated; the design file is the fixture) | every gate in A §7; `coaster-camera --client=both` passes; renders reviewed | C02-C06, X-02..X-06, M03, M07 | U2 (designs repo), U17 (name) |
| **F01** | A | Figure design study: 3 candidates from generic official parts (no minifig moulds; height ~120-140 LDU), distinctness metric (front/side silhouette IoU vs minifig composite < 0.6; head/height and shoulder/height ratios differ >= 25 %), contact sheets for the user | NEW `web/src/engine/figure-brickling.ts` (canon draft), `test/fixtures/figures/*.ldr`, `scripts/_figure_distinctness.ts` | `figure-brickling :: the candidate's normalised front silhouette IoU against the minifig composite is below 0.6` | 3 candidates pass; sheets in `output/biz-a/figures/`; U4 asked | X-08 (writer) | no (produces U4's options) |
| **F02** | A | `'brickling'` in `FigureSystem` with canon, bones, gait, seat offsets; `!CRAFTMATIC FIGURE` placement; per-system `LDU_PER_MINIFIG`, doorway pass size, head offsets, `SEATED_EYE_ABOVE_PAN_LDU`, `FIGURE_SEAT_MATCH_LDU`; minifig numbers unchanged; own face textures | `minifig-rig.ts`, `figure-brickling.ts`, `addon-scale.ts`, `lego-scale.ts`, `bedrock-scene-actors.ts` (`:346`, `:890`), `ldraw-entity-compiler.ts` (`:1436`), `bedrock-interactives.ts` (`:1796`) | `figure-brickling :: a model with a brickling FIGURE meta scales so the figure is the player's height and its doorway pass size is the brickling envelope` | every minifig test unchanged; constants table in `docs/physics-architecture.md` | F01, X-08 | **U4** (the pick) |
| **F03** | A | Walk/sit animations for the brickling bones; sim walking, seating, riding | `minifig-rig.ts` (`:1132`), `web/src/sim/adapters/craftmatic/figure-life.ts` | `bedrock-figure-life :: a brickling figure walks through its own doorway and sits on a SEAT meta without clipping` | `figure-life` invariants hold | F02, M14 | no |
| **L00** | A | Landmark source discovery for the 22 (OSM ids, open LiDAR/3D tiles with licences, PD drawings, Commons PD/CC0/CC BY photos, documented dimensions) into `site.json` drafts + the rights screen (hold/exclude) | `$CRAFTMATIC_DESIGNS/landmarks/*/site.json`, `output/biz-a/landmark-sources.md` | `brickgen-site-schema :: every landmark site.json validates and every source has a licence` | hold/exclusion lists applied | A05, X-00 | **U5**, U2 |
| **L01** | A | Notre-Dame pilot end to end; calibrates fidelity thresholds and stability rules; clearance by a second agent; a profile pack passing every gate | `$CRAFTMATIC_DESIGNS/landmarks/notre-dame-paris/*` | `landmark-notre-dame :: the design verifies at 1 component and its front silhouette IoU is at least 0.85` (designs-gated) | A §4.3 acceptance; contact sheet reviewed by the user | A10, A11, L00, X-02..X-06, M03 | U2, U17 |
| **L02..L05** | A | Icon batches by city (Paris 3; London 4; US 5; Europe/Asia 9), each adding its grammars in a separate file (lattice girders, onion domes) | designs repo; new `grammar/*.ts` per need | per icon: the L01 test shape | each icon: verify 1/0/0/0, fidelity >= 0.85 + colour threshold, budget, gates, clearance, reviewed sheet | L01 | U5 |
| **P01a** (new split) | A | Vehicle grammar + ONE original car + the door kit (2 doors, 1 window) + the seat kit (chair, bench, sofa): the sampler's content and the coaster's car source | NEW `web/src/brickgen/grammar/vehicle.ts`; designs (sampler designs are public, §8) | `brickgen-vehicle :: a generated car has 4 wheels on axles, a SEAT meta and passes driverSeesOut` | drives in sim `vehicles`; doors/seats pass `_ix_passability.ts` | F02, X-10, M07; `gen-side-1109` merged (`cockpit-seat.ts`) | U4 |
| **P01b** | A | Brick Garage: 8 vehicles + garage with roller doors | designs; `scene-vehicles.ts` if needed | `garage :: every garage vehicle passes driverSeesOut and boards from a fresh placement in the sim` | `_cockpit_view.ts` sheets reviewed | P01a, all vehicle branches merged | no |
| **P02** | A | Pinball Arcade: 3 tables; first check every part `detectPinballTable` keys on is official CC BY | designs; detector keys on metas where not | `pinball-official-parts :: every part detectPinballTable keys on is an official LDraw part` | 3 tables play in the sim | X-02..X-06, F02 | no |
| **P03** | A | Doors + Furniture kit (~30 pieces) with a kit placement menu | designs; `bedrock-placement-pack.ts` kit menu | `kit-placement :: a kit pack places one chosen piece and Undo removes only it` | | M07, F02 | no |
| **P04** | A | Funfair: multi-seat orbit ride, drop tower (lift with free-fall), swing ride, bumper cars, slide | `web/src/engine/bedrock-rides.ts` | `bedrock-rides-orbit :: a 12-seat orbit ride carries 12 riders on one path with equal spacing` | "a new ride kind adds a path, never its own teleport loop" | X-02..X-06, F02 | no |
| **A-SS1, A-SS2** (new) | A | Two more epic show-stoppers (the user's "several other epic show stoppers"); candidates in U5 | designs + the engine features each needs | per pick | each at "epic" scale with a measured target like C01's report | C07 or P04 depending on the pick | **U5** |
| **S01** | A | Store shot list + store-size presets on X-14 (offline art: turntables, cockpit, coaster POV frames) and the in-game capture plan awaiting the user | `scripts/_store_art.mjs` -> a preset set + `release/media/store-shotlist.json` | `store-art-size :: every generated image is under 2000 px a side and 4 MB` | | X-14, A10 | U16 (capture session) |
| **S02** | A | Submission bundle, prepared and NOT submitted: pack, unpacked BP/RP, mct report (0 errors), `--release` + budget reports, sim + BDS logs, provenance, clearance, credits, store text, art, device matrix, README "awaiting approval"; zipped with sha256 | NEW `scripts/_submission_bundle.ts` | `submission-bundle :: the bundle refuses to assemble without a 0-error MCTools report` | | X-06, M06, T01, S01 | U3 (lawyer), U13 |

### 2.3 Scenario B (BYOM converter)

| id | owner | goal | files | first failing test | acceptance | deps | decision? |
|---|---|---|---|---|---|---|---|
| **B01** | B | `importModelFile(bytes, name)` for `.ldr/.mpd/.io/.lxf/.lxfml/.zip`, no DOM, no module globals; `xml.ts` DOM-free XML reader injected into `lxf-parser.ts`; `lego.ts` `parseMpdFile` and `loadIndexedModelBody` both call it, behaviour unchanged | NEW `web/src/engine/byom/{import,xml}.ts`; EDIT `web/src/engine/lxf-parser.ts` (`:1232-1236`), `web/src/ui/lego.ts` (`:1773-1880`, `:2325-2405`) | `byom-import :: parses a bare .lxfml without DOMParser` | + `.io keeps CustomParts and the Studio colour space`; `mpd sub-models listed with brick indices`; `warnings returned, not written to a global`; parity on 5 corpus files | none | no |
| B02 | -> **X-17** | | | | | | |
| **B03** | B | `ByomHints` validation + application (selectors -> `PlayableGridComponent[]`, `vehicleMode`/`facing`/`seatCount`); `<stem>.byom.json` for the CLI | NEW `web/src/engine/byom/hints.ts`; EDIT `schem-pipeline.ts` (component assembly) | `byom-hints :: the sub-model "Speeder" hinted plane ships as a scripted flyer` | + `an unresolved selector is an error naming it`; a hinted car drives in sim `vehicles` | X-17; vehicle branches merged | no |
| B04 | -> **X-05** (strings, disclaimer) + **X-02** (where they are written) + **X-04** (credits) | | | | | | |
| B05 | -> **X-04** | | | | | | |
| B06 | -> **X-13** | | | | | | |
| B07 | -> **X-07** | | | | | | |
| **B08** | B | Entitlement in the pack via X-02's `entitlement` field: free = name suffix " · made with craftmatic.click (free)", one sign entity removed by Undo, `tier: free` in provenance; paid = `ticketId` + tier, Ed25519 verify with the bundled public key | `web/src/engine/byom/entitlement.ts`; hooks in `playable-addon.ts` (via X-02), `bedrock-placement-pack.ts` | `byom-watermark :: a free pack names itself "made with craftmatic.click (free)" and places one sign` | + `undo removes the sign` (sim); `a forged ticket fails verification` | X-02, M07 (same file), B20's ticket format (fixture key pair until then) | **U9** (free tier > 300 parts) |
| **B09** | B | STL (binary/ASCII), 3MF, PLY, GLB Draco/meshopt (vendored, lazy); units (mm x 2.5 = LDU; "real size" / "fit to N studs") | `web/src/engine/mesh-import.ts`, `web/src/ui/upload.ts:14-17` | `mesh-import-formats :: a binary STL cube 16 mm across reports 40 LDU` (triangles built in the test) | | none | no |
| B10 | -> **X-11** | | | | | | |
| **B11** | B | Legolize glue: `IntentLattice` (X-11) -> X-10 bricker -> X-08 writer; connectivity repair until X-09 says one component; `.ldr` download for the creator | NEW `web/src/engine/legolize/index.ts` | `legolize-merge :: every brick of a merged L-shape is connected` | largest-component share 1.0 on all clean corpus meshes; part count recorded | X-08..X-11 | no |
| **B12** | B | Surface fit on a `solid` lattice: infer `slope` labels where the staircase matches a slope normal (3040/3039/3665/54200, origin at the BOTTOM for 54200), tiles on tops, 1x1 rounds on curved columns; accept only if the column's silhouette IoU rises | NEW `web/src/engine/legolize/surface.ts` | `legolize-surface :: a 45° ramp lattice gets 3040 slopes and a higher side-view silhouette IoU` | median gain >= +0.02, never negative per model (target) | B11, X-12 | no |
| **B13** | B | Tagged features -> real parts: door (frame 60596 + leaf 60616a, mind `STUDIO_FRAME_REDIRECTS`), seat 4079, wheels table, coaster car only on a hinted track; existing detectors then fire | NEW `web/src/engine/legolize/features.ts` | `legolize-features :: a tagged door on a legolized wall ships as a hinged door entity` | + `a tagged seat is in the seat census`; sim child-play walks 3 tagged doorways | B11, B03 | no |
| B14 | -> **X-12** | | | | | | |
| **B15** | B | `tools/photo3d/`: ComfyUI HTTP client with timeouts; prompt graphs ported from `pokefit/imageto3d.py` (`mask_prompt :555`, `_pixal3d_chain :569`, `generate_prompt :646`, `single_prompt :657`) with `RemeshMesh sign_mode "solid"`; framing from `frame_views :149`; GLB vertex-colour reader; CLI; weights' licences in `tools/photo3d/LICENSES.md`; ComfyUI from `C:/git/comfyui-3d` only | NEW `tools/photo3d/{comfy,framing,graphs,cli}.ts` | `photo3d-framing :: every framed view has the same figure height and the largest extent spans 1024/1.1 px` | + `the multi-view graph remeshes with sign_mode solid`; `a mock ComfyUI returning a history entry yields the GLB bytes`; one live run (`RUN_GPU_TESTS=1`) on a corpus photo set, seconds recorded | none | no |
| **B16** | B | Synthetic ground truth: render 4 rig views + 1 held-out 45° view of corpus LDraw MOCs with the sim rasteriser; run B15 -> X-11 -> B11/B12 -> X-12; `output/byom-bench-<sha>/summary.md`; frozen gates (voxel IoU >= 0.55 / single 0.40; held-out silhouette >= 0.85; dE <= 12; component share 1.0; brick count 0.5-2x) | NEW `scripts/byom-photo-bench.ts`, `test/byom-photo-gates.test.ts` | `byom-photo-bench :: the held-out view's camera is none of the four input cameras and its silhouette is rendered from the source lattice` (a real unit test; the gate test reads the recorded summary and skips without it) | summary recorded; gates pinned | X-12, B15, B11, B12, B29 | no (GPU runs are local) |
| **B17** | B | Real photos: reprojected silhouette IoU vs BiRefNet masks (>= 0.80 target) + human-graded contact sheet; MobileBrick true 3D IoU (>= 0.45 on 18 curated) after its licence is read; per DISTINCT build | `scripts/byom-photo-bench.ts --real` | `byom-photo-bench :: reprojection uses the framing's own camera per input view` | recorded per distinct build | B16 | no |
| B18 | -> **X-15** | | | | | | |
| **B19** | B (deferred) | Passkeys + sessions + age gates + delete/export data; D1 store + migrations | NEW `worker/api/auth.ts`, `store-d1.ts`, `worker/migrations/0001_byom.sql` | `byom-auth :: a registered passkey logs in and the session cookie is HttpOnly Secure SameSite=Lax` | | X-15 | **U6** (build the SaaS layer now?) |
| **B20** | B (deferred) | `TIER_RULES`, `POST /api/exports` -> signed `ExportEntitlement` (Ed25519), debits, 30-day same-hash rule | NEW `worker/api/{entitlements,tickets}.ts` | `byom-entitlements :: 301 parts on the free tier gets the ticket TIER_RULES prescribes` | | B19 | U6, U9 |
| **B21** | B (deferred) | Stripe TEST mode behind `PaymentProvider`; webhooks idempotent on `event.id`; live-key refusal without `LIVE_PAYMENTS_APPROVED` | NEW `worker/api/{stripe,webhooks}.ts`, `scripts/byom-stripe-seed.ts` | `byom-stripe :: a live key is refused without the approval vars` | `stripe listen` against `wrangler dev` completes a test checkout (needs the user's TEST account) | B20 | U6, **U7** |
| **B22** | B (deferred) | Terms/privacy/takedown drafts ("DRAFT, pending legal review"), declaration, takedown intake + strikes + `hash12` blocklist, `byom-admin.ts` | NEW `web/public/legal/*`, `worker/api/takedown.ts`, `scripts/byom-admin.ts` | `byom-takedown :: an upheld takedown blocks new exports of that hash and adds a strike` | | X-15, B20 | U6, U3 |
| **B23** | B (deferred) | Showcase, originals only, moderated; title screen pattern table; seeded from A designs | NEW `worker/api/showcase.ts`, `web/public/showcase/*` | `byom-showcase :: a submission titled with a set number or a LEGO mark is rejected` | | X-15, X-13, A designs | U6 |
| **B24** | B | Batch: `scripts/byom-batch.ts` (CLI over `runSchemPipeline`, `.lxf` via B01, hints files) + `web/src/engine/byom/batch.ts` queue core; the cloud container is PREPARED only (sized by measured peak RSS) | NEW `scripts/byom-batch.ts`, `web/src/engine/byom/batch.ts`, `services/byom-builder/*` | `byom-batch :: three fixture models produce three packs, three reports and a summary, deterministic bytes on rerun` | | B01, B03, X-07, D-03 | U8 for deployment only |
| **B25** | B (deferred) | Photo-job queue + GPU agent (claim/expire/complete); route off until approved | NEW `worker/api/photo-jobs.ts`, `tools/photo3d/agent.ts` | `byom-photo-jobs :: a claimed job cannot be claimed twice and expires back to queued after 15 min` | | X-15, B19, B15 | U6, U8 |
| **B26** | B | The "Create" tab: pure state machine, nav tab, `?tab=create`, viewer reuse, touch tagging, screen + declaration, export progress, report view, zip download; dark, mobile-first, `.byom-*` CSS only; Node Playwright shots at 393/768/1440 | NEW `web/src/ui/byom/*`; EDIT `web/index.html`, `web/src/main.ts` | `byom-ui-state :: a blocked screen verdict cannot reach the export step` | no horizontal scroll at 393; controls >= 44 px; shots reviewed | B01, B03, X-07 | U18 (tab name; default "Create"); its MERGE is an approval merge |
| **B27** | B (deferred) | Account + billing UI from `TIER_RULES` | `web/src/ui/byom/{account,billing}.ts` | `byom-ui-billing :: the plan page prices come from TIER_RULES` | | B19-B21 | U6 |
| **B28** | B (deferred) | Batch UI + photo upload UI | `web/src/ui/byom/{batch,photos}.ts` | `byom-ui-state :: a batch resumes after reload with finished items kept` | | B24, B25, B26 | U6 |
| **B29** | B | Corpus manifest (metadata only, committed) + polite fetcher: one at a time, robots, >= 2.5 s, sha256, stops at login/terms walls and records `unresolved` (never "absent"), per-FILE licence for Commons/Flickr, `manual: true` with printed steps for BrickLink/Sketchfab; writes ONLY under `data/byom-corpus/` | NEW `test/fixtures/byom-corpus.manifest.json`, `scripts/byom-corpus-fetch.ts` | `byom-corpus-manifest :: every manifest entry has a url, licence and kind, and no path outside data/byom-corpus` | first fetch run recorded per DISTINCT item: fetched / unresolved / manual | none | no (the manual downloads are a user action, U-list) |
| **B30** | B | Corpus regression run: import, export (one at a time), check, sim, screen every corpus model; per-distinct-model counts, seconds, peak RSS in `output/byom-corpus-<sha>/summary.md` | NEW `scripts/byom-corpus-run.ts` | `byom-corpus-gates :: the last recorded corpus run imports every manifest model` (local-only) | numbers in the tracker | B01, B03, B08, X-07, X-13, B29 | no |

### 2.4 Scenario D (free releases)

| id | owner | goal | files | first failing test | acceptance | deps | decision? |
|---|---|---|---|---|---|---|---|
| D-01 | -> **X-01** | | | | | | |
| D-02 | -> **X-02** | | | | | | |
| **D-03** | D | Deterministic zip: `CreateZipOptions.deflate` hook (pako `deflateRaw` level 9) and sorted entries under `deterministic: true`; default unchanged | `web/src/engine/zip-utils.ts` | `zip-deterministic :: pako deflate yields identical archives regardless of CompressionStream` (stubs `CompressionStream` to another compressor; equal sha256 with the hook) | round trip through the existing reader (`test/threemf-export`) | none (pako is a dependency) | no |
| D-04 | -> **X-04** | | | | | | |
| D-05 | -> **X-05** | | | | | | |
| **D-06** | D | Curated Keep-a-Changelog per product is the source of truth; checker that every registry version has a section; renderings (in-pack `CHANGELOG.txt`, CurseForge per-file, itch devlog, site HTML), lint-clean. No commit extraction. | NEW `web/src/release/changelog.ts`, `release/changelogs/sampler.md` | `release-changelog :: a release whose version has no curated section is refused` | renderings pass X-05 | X-01, X-05 | no |
| D-07 | -> **X-06** | | | | | | |
| **D-08** | D | `bun scripts/release.ts prepare\|finalize\|verify\|status <product>` (plan D §3.3): clean tree, pins, NEW worktree per run (never removed), offline build with `CRAFTMATIC_LDRAW_LIBRARY=official` + `SOURCE_DATE_EPOCH` + the profile, every gate, artifacts (`.mcaddon`, root-less `.zip`, `SHA256SUMS` GNU format, `release.json`, `CHANGELOG.md`, `NOTICE.txt`, `CREDITS.txt`), media, channel bundles, catalog entry, `APPROVAL.md`; finalize rebuilds from the tag and requires identical sha256; NO upload code (static scan) | NEW `scripts/release.ts` (full), `web/src/release/checksums.ts` | `release-script :: prepare refuses a dirty tree` | + `SHA256SUMS verifies with sha256sum -c`; `finalize refuses a tag whose rebuild differs by one byte`; `APPROVAL.md lists every outward action unchecked`; `release sources contain no upload calls` (`fetch(`, `butler`, `wrangler`, `api.curseforge`, `itch.io/api`, `git push\|git tag`); end-to-end on a fixture product with a tiny ORIGINAL model, identical sha256 twice | X-01..X-06, D-03, D-06, D-09, X-14, D-12 (catalog schema) | no |
| **D-09** | D | ONE data-driven channel bundle generator over `release/channels/<channel>.json` (fields, limits marked verified/unverified, image presets, checklist template) for CurseForge, MCPEDL, itch, Ko-fi, Patreon, affiliate, site: `fields.json`, description, sized images, `CHECKLIST.md` of unchecked `ApprovalItem`s naming the user | NEW `web/src/release/channels.ts`, `release/channels/*.json` | `release-channels :: the curseforge logo is a square PNG of at least 400 px, under 2000 px and 4 MB` | + `the itch cover is exactly 630x500`; `every checklist item starts unchecked and names the user as approver`; `no listing carries an ad-gated or shortener link`; `donation links come last in the CurseForge description`; unverified limits listed at the top of `APPROVAL.md` | X-05, D-06, X-14 (fixtures suffice) | no |
| **D-10** | D | Listing + site copy (descriptions, install per platform, controls, FAQ, Ko-fi/Patreon text, affiliate application, Discord template), lint-clean, within channel limits | `release/copy/sampler/*.md`, `release/copy/common/*.md` | `release-copy :: every copy file passes the forbidden-terms lint and its channel's length limits` | the user reads the copy in the RC bundle | X-05, D-09 | U1 (brand words; drafts use `<Brand>`) |
| D-11 | -> **X-14** | | | | | | |
| **D-12** | D | craftmatic.click `/packs/`, `/packs/<id>/`, `/downloads/`, `/privacy/`, `/packs/catalog.json`; Vite multi-page inputs + a plugin emitting detail pages from the catalog; `<meta name="darkreader-lock">`; service worker excludes `/get/`, `/go/`, `*.mcaddon`, `*.zip`, `*.mp4`, `*.webm`; dark, mobile-first (16 px gutters, 44 px targets, scroll-snap carousel, `<video muted loop playsinline preload="none">`); funnel blocks render nothing while config is null; Node Playwright probe at 360/390/1440 | NEW `web/packs/index.html`, `web/src/site/*.ts`, `web/src/release/catalog.ts`, `scripts/_site_probe.mjs`; EDIT `web/vite.config.ts`, `web/public/sw.js` | `site-catalog :: every catalog download has a sha256 and a /get/ href` | + `a null newsletter config renders no form`; `sw.js does not cache /get/ or .mcaddon`; `bun run build:web` emits the pages; probe passes; shots reviewed | X-01 (schema), X-14 (fixture media) | no; its MERGE is an approval merge (a push deploys) |
| **D-13** | D | `worker/downloads.ts` mounted in X-15's router: `GET /get/<product>/<version>/<file>?ref=` (catalog allow-list, one Analytics Engine point: product/version/kind/ref/country; stream from R2 `RELEASES` with `Content-Disposition`), `GET /go/<target>?ref=` (counted 302 to a configured URL, no open redirect); no IP/UA/cookie stored; `wrangler.toml` bindings + routes COMMENTED until approved | NEW `worker/downloads.ts`; EDIT `worker/api/router.ts`, `wrangler.toml` | `worker-downloads :: an unknown product 404s and records nothing` | + `a counted download writes no IP or user agent` (fake AE binding); `/go/ to a target not in the config is refused` | X-15, X-01 | U11 (hosting; default R2 via Worker); approval merge |
| **D-14** | D | Funnel blocks (newsletter double opt-in with age wording, Discord invite, donations never beside a download button) + `/privacy/` text + Discord server template; all config-gated | `web/src/site/{funnel,site-config}.ts` | `site-funnel :: with every funnel config null the page has no newsletter, discord or donation element` | probe passes | D-12 | **U12** (providers) |
| **D-15** | D (deferred until after the first release) | `scripts/biz-weekly-report.ts`: GET-only adapters (github, curseforge, itch, cfAnalytics, workerCounters, kofi, patreon, manual); `not granted` never 0; units beside numbers; 2x swings flagged | NEW `scripts/biz-weekly-report.ts`, `web/src/release/telemetry/*.ts` | `biz-weekly-report :: a source with no credential reports "not granted", never zero` | a credential-less run writes a complete report | D-13 | U12 (credentials) |
| **D-16** | D | Storyboard JSON schema (30-45 s, 9:16 + 16:9; each shot names pack sha256, wand size, position, camera, duration) -> offline animatic (X-14 + `_cockpit_view.ts`) and the shot section of a device-round brief; no phone here | NEW `web/src/release/storyboard.ts`, `release/media/sampler.storyboard.json` | `release-storyboard :: a storyboard longer than 45 s or a shot without a pack sha256 is refused` | animatic MP4 for the fixture product | X-14 | no |
| **D-17** | D | `release/cadence.json` SKU matrix + calendar; checker: every free SKU's designs exist with provenance logs; no free design inside a paid SKU; each sampler update precedes the A launch it supports | NEW `web/src/release/cadence.ts`, `release/cadence.json` | `release-cadence :: a free SKU that names a design inside a paid SKU is refused` | + `a free SKU naming a design with no provenance log is refused`; green against a fixture registry | A11 (provenance schema) | **U15** (sampler content) |
| **D-18** | D | Sampler v1.0.0 release candidate end to end: `release/products/sampler.json` filled (namespace, publisher, P01a's designs), `release.ts prepare sampler` green on every gate, bundle + sha256 + `APPROVAL.md` to the user; device evidence via the device-round process | `release/products/sampler.json` | `release-sampler :: the sampler product refuses a design id with no provenance log` (fixture registry; real until P01a lands) | `verify` passes; device round finds no content-log errors on load/place/drive/open/sit | everything in D, X-01..X-06, M03, M07, P01a | **U1, U2, U15, U16** |

---

## 3. Wave 1 (start now): nine packages, no user decision, no shared files

Common to every brief (paste first): **Appendix A verbatim**, then: "Worktree: `git worktree add .worktrees/biz-<id> -b biz-<id> main`,
then `cd .worktrees/biz-<id> && bun install`. Work only in it. Fail-first: write the named test, run
`bunx vitest run test/<file>.test.ts`, see it fail on the ASSERTION (not an import), then implement. Before every
commit: `bun run typecheck && bun run typecheck:web && bunx vitest run <your test files>`. Do NOT run the full
`bun run test` in parallel with other agents' worktrees (contention produces false `onTaskUpdate` timeouts); the
orchestrator runs it once per merge. Do NOT edit `REQUIREMENTS.md`, `TASKS-BUSINESS.md`, `CLAUDE.md` or any file
outside your list; request a change through your final report. Commits: conventional, cite the BIZ id, end with
the signature line. Final report: files changed, test names, commands run with their output, what is unfinished
(`TODO` comments), and any claim in the plan you found wrong."

File-collision check for Wave 1 (each file has exactly one writer): `ldraw-directives.ts`, `ldraw-parser.ts` -> X-08;
`ldraw-geometry.ts`, `ldraw-entity-compiler.ts` -> X-04; `lxf-parser.ts`, `lego.ts` -> B01; `zip-utils.ts` -> D-03;
`_mcaddon_check.py` -> X-06; everything else is new files. None touches `playable-addon.ts`, `schem-pipeline.ts`,
`playable-components.ts`, `scene-vehicles.ts`, `cockpit-seat.ts` (the in-flight branches) or `wrangler.toml`.

### X-08 — brick core: types, vocabulary, colour, LDraw writer, authoring metas (BIZ-05, BIZ-07, BIZ-09) — `biz-x08`
- **Goal/scope.** `web/src/brickgen/types.ts` exactly as §1.1 plus plan A §2.3 (`SiteEvidence`, `SourceRef`, `InputLicence`,
  `MassVolume`, `FeatureSpec`, `VerifyReport`, `PolishOp`, `ProvenanceLog`, `AuthoringMeta`). `vocab/`: ~80 official
  elements with footprint, height in plates, occupancy mask for non-cuboids, stud/anti-stud connections read from
  the part's geometry, roles, `!LICENSE` and `Author` lines. `scripts/_vendor_ldraw_vocab.ts` copies those parts and
  every subfile/primitive they reach from `C:/git/clego/ldraw_ref/official/` into `test/fixtures/ldraw-vocab/` and
  writes `LICENSE.md` (CC BY, per-file authors). `colour.ts`: `nearestLdrawColour(rgb, palette = PRODUCTION_PALETTE)`
  in Lab with CIEDE2000 over `LDCONFIG_RGB`/`LDCONFIG_ALPHA` (`ldconfig-colors.generated.ts:5/:331`), transparents
  excluded unless asked, deterministic ties (lowest code). `emit/ldraw-writer.ts`: `BrickPlan` -> MPD text, one
  `0 FILE` per group, elements sorted (group, y, z, x), LF only, quarter-turn rotation matrices exact, `0 Author:`
  and `0 !LICENSE` lines from a `WriterIdentity` argument (placeholder studio name until U1). Metas
  `0 !CRAFTMATIC FIGURE|SEAT|DOOR|SPAWN|DESIGN ...` written by the writer, REGISTERED in
  `web/src/engine/ldraw-directives.ts` with effect + count (CLAUDE.md rule), parsed by `ldraw-parser.ts` into
  `LDrawDocument` (attach to the next type-1 line like `headPrint`), and `bun scripts/_converter_coverage_audit.ts`
  must still exit 0.
- **Files.** NEW: `web/src/brickgen/types.ts`, `web/src/brickgen/colour.ts`, `web/src/brickgen/vocab/{index,elements,occupancy}.ts`,
  `web/src/brickgen/emit/ldraw-writer.ts`, `scripts/_vendor_ldraw_vocab.ts`, `test/fixtures/ldraw-vocab/**`,
  `test/brickgen-vocab.test.ts`, `test/brickgen-colour.test.ts`, `test/brickgen-ldraw-writer.test.ts`.
  EDIT: `web/src/engine/ldraw-directives.ts`, `web/src/engine/ldraw-parser.ts`. Nothing else.
- **First failing test.** `test/brickgen-vocab.test.ts :: every vocabulary element is an official LDraw part with a CC BY licence line`
  (reads each element's `.dat` from the vendored fixture; fails first because `vocab/` exports nothing).
- **Then.** `:: no element name is a bl_ copy or a Studio-only part`; `:: the occupancy of 3040 (slope 45 2x1) matches its geometry`;
  `test/brickgen-colour.test.ts :: pure white maps to LDraw 15 and a sandstone tan maps to 19`; `:: every production colour maps to itself`;
  `:: a transparent is returned only when asked`; `test/brickgen-ldraw-writer.test.ts :: a written plan parses back through parseLDrawDocument to the same parts, colours and positions`;
  `:: the same plan writes byte-identical text twice`; `:: FIGURE and SEAT metas survive the round trip`;
  `:: a turn of 1 writes the exact quarter-turn matrix`.
- **Acceptance / verify.** All tests green: `bunx vitest run test/brickgen-*.test.ts`; `bun run typecheck:web`;
  `bun scripts/_converter_coverage_audit.ts` exits 0; `bun scripts/_vendor_ldraw_vocab.ts --check` reports every
  reached subfile present; `test/fixtures/ldraw-vocab/LICENSE.md` lists every file's author.
- **Do NOT touch.** `playable-addon.ts`, `schem-pipeline.ts`, `ldraw-geometry.ts` (X-04's), any `web/src/sim/**`,
  `web/tsconfig.json` (A05's), the Studio library (`C:/git/clego/extracted/...`): read ONLY `ldraw_ref/official`.

### X-01 — product identity registry, semver, identity ledger (BIZ-52) — `biz-x01`
- **Goal/scope.** Plan D §3.2 types (`ProductIdentity` as §1.1, `ProductRecord`, `ReleasedVersion`, `IdentityLedgerEntry`,
  `SemVer`); `semver.ts` parse/compare/bump and `toManifestTriple`; `product.ts` load + validate, `devIdentity(product)`
  = uuids re-derived with a `:dev` salt and a name suffix; `identity-ledger.ts` append rules (version rises, namespace
  and uuids frozen, no shipped entity/block/item id dropped); `scripts/release.ts init-product <id>` mints random v4
  uuids ONCE into `release/products/<id>.json` with `namespace: null` and refuses to overwrite. Pure TS under
  `web/src/release/` (no fs/network); only `scripts/release.ts` touches disk.
- **Files.** NEW `web/src/release/{types,semver,product,identity-ledger}.ts`, `release/products/sampler.json`,
  `release/identity-ledger.json` (`[]`), `scripts/release.ts` (init-product only; other subcommands are D-08's),
  `test/release-identity.test.ts`.
- **First failing test.** `test/release-identity.test.ts :: the same product at 1.0.0 and 1.1.0 keeps every uuid`.
- **Then.** `:: a version that does not rise is refused`; `:: dropping an entity id a released version shipped is refused`;
  `:: a null namespace refuses a release build`; `:: dev identity uuids differ from release uuids and the dev name carries "(dev"`;
  `:: semver maps to the manifest triple`; `:: init-product refuses to overwrite an existing product`;
  `:: uuids are not derived from the display name` (rename, same uuids).
- **Acceptance / verify.** `bunx vitest run test/release-identity.test.ts`; `bun run typecheck:web` (the `web/src/release`
  tree is inside `web/tsconfig.json`'s `src/**`); `bun scripts/release.ts init-product sampler` twice: second run refuses.
- **Do NOT touch.** `playable-addon.ts`, `mcpack.ts`, `pipeline-version.ts` (X-02's), `wrangler.toml`, `web/vite.config.ts`.

### X-04 — part-source ledger, official-only library mode, credits (BIZ-07, BIZ-55) — `biz-x04`
- **Goal/scope.** In `ldraw-geometry.ts`: record, for every part resolved, the library-relative file actually read and
  classify it (`ldraw-official` under `ldraw_ref/official`; `ldraw-unofficial` under `ldraw_ref/unofficial` with a
  CC BY `!LICENSE` line; `studio` for any `UnOfficial/` or Studio-tree path; `mirror` for a network fetch; `custom`
  for `.io` CustomParts; `substituted` when `datSubstitutions` served an alias). A library mode `official`
  (`CRAFTMATIC_LDRAW_LIBRARY=official` env, or an explicit option) that probes ONLY the official tree (+ unofficial
  CC BY), never Studio paths, never `bl_` fallbacks, never an alias, and never a `logo*.dat` / `stud-logo*`
  primitive; an unresolved part in that mode FAILS the export with the full list. `part-source.ts` exposes the
  ledger type and a `licenceGate(ledger)` -> `{ ok, offending }`. `credits.ts` renders `CREDITS.txt`: the LDraw
  CC BY 2.0/4.0 notice, "not endorsed by LDraw.org", every author once (sorted), `(c) OpenStreetMap contributors (ODbL)`
  when asked, never a part description. Add `partSources` beside `unresolvedParts`/`substitutedParts` in the
  compiler report (`ldraw-entity-compiler.ts:408/:447`). `scripts/gen-ldraw-official-list.ts` writes a compact sorted
  list of official part names from `ldraw_ref/_archives/complete.zip` into `web/src/engine/ldraw-official-parts.generated.ts`.
  The dev default mode is byte-for-byte unchanged.
- **Files.** EDIT `web/src/engine/ldraw-geometry.ts` (`:181`, `:190-201`, the resolver), `web/src/engine/ldraw-entity-compiler.ts`
  (report fields only). NEW `web/src/engine/part-source.ts`, `web/src/engine/credits.ts`, `scripts/gen-ldraw-official-list.ts`,
  `web/src/engine/ldraw-official-parts.generated.ts`, `test/part-source.test.ts`, `test/credits.test.ts`.
- **First failing test.** `test/part-source.test.ts :: in official mode a part present only in Studio's UnOfficial tree fails the export with its name`
  (fixture: a tiny library folder in the test with `parts/3001.dat` and `UnOfficial/parts/99999.dat`).
- **Then.** `:: official 3001.dat records "Licensed under CC BY 4.0" and author James Jessiman` (gated on `existsSync('C:/git/clego/ldraw_ref/official')`
  at module load, read inside `it`); `:: datSubstitutions stays empty in official mode`; `:: a logo stud primitive reached through a part is refused in official mode`;
  `:: the dev mode resolves the same file as before for 3001, 3626 and a subpart`; `test/credits.test.ts :: credits list every author of every used part exactly once`;
  `:: credits never contain part descriptions`; `:: OSM attribution appears only when a source is odbl`.
- **Acceptance / verify.** Tests green; `bun run typecheck:web`; run `bun scripts/_playable_ref.ts` (unchanged CLI)
  on one corpus `.io` in dev mode and confirm `substitutedParts` identical to before; run it with
  `CRAFTMATIC_LDRAW_LIBRARY=official` on 10 corpus `.io` files and record studio-only counts per file in your report
  (the tracker gets them). CLAUDE.md: the CLI must ask the mirror for the exact part BEFORE a local alias; keep that
  order in dev mode.
- **Do NOT touch.** `ldraw-parser.ts`, `ldraw-directives.ts` (X-08's), `playable-addon.ts`, the R2 sync script, the
  Studio library files themselves.

### X-06 — release validator: `_mcaddon_check.py --release` + mct wrapper (BIZ-24, BIZ-54) — `biz-x06`
- **Goal/scope.** Extend `scripts/_mcaddon_check.py` IN PLACE with `--release` (`--marketplace` accepted as an alias)
  adding: RP `pack_scope == "world"`; RP depends on the BP header uuid and BP on RP; exactly one namespace across
  entity/block/item/geometry/animation/render-controller ids and it is not `craftmatic`; `<type>/<creator>/<pack>/`
  folder rule with no loose files in content-type folders; no file at a vanilla texture path (`textures/blocks/concrete_*`
  and a vanilla-path list fixture); registered permutations <= 10,000 (dev mode keeps 65,536); uncompressed size <= 25 MB
  and <= 3,500 files; block/item textures <= 256 px, others <= 2048; no `-beta` script module; no `minecraft:`
  definitions; no `craftmatic-diagnostics.json`; zip-without-root for a `.zip`. `scripts/release-mctools.ts`: unzips to
  a NEW temp folder, runs `bunx @minecraft/creator-tools@0.21.0 validate -i <dir>` (version pinned in one constant),
  parses the output into `{ errors, warnings, rules: [{id, severity, message}] }` or `{ status: 'not-run', reason }`
  when the EULA is not accepted or `bunx` fails. It must not refuse on Node version (the package declares no `engines`).
- **Files.** EDIT `scripts/_mcaddon_check.py`. NEW `scripts/release-mctools.ts`, `test/fixtures/mcaddon/{release-ok,no-scope,vanilla-tex,many-perms}.zip`
  (built by a test helper, committed small), `test/fixtures/mctools-output.txt`, `test/mcaddon-check-release.test.ts`,
  `test/release-mctools.test.ts`.
- **First failing test.** `test/mcaddon-check-release.test.ts :: a pack without pack_scope world fails --release`
  (spawns `python -I scripts/_mcaddon_check.py --release <fixture>`; fails first because the flag is unknown).
- **Then.** `:: 10,001 permutations fail --release while 65,536 still passes the dev mode`; `:: a craftmatic: id fails --release`;
  `:: a texture at a vanilla path fails --release`; `:: a rule-built fixture passes --release`;
  `test/release-mctools.test.ts :: the parser counts Errors and Warnings on a recorded output fixture`; `:: a missing EULA yields not-run with a reason`.
- **Acceptance / verify.** Tests green; `python -I scripts/_mcaddon_check.py --release output/favsweep-4da29033/10261.mcaddon`
  fails naming namespace, folders, vanilla textures, pack_scope and permutations (record the output); the dev mode on
  the same pack is unchanged (`OK`). Try one live `bun scripts/release-mctools.ts <fixture dir>`: report whether the
  EULA blocked it (do not accept it yourself).
- **Do NOT touch.** `playable-addon.ts`, the emitters, `wrangler.toml`; do not install anything globally.

### D-03 — deterministic zip (BIZ-51) — `biz-d03`
- **Goal/scope.** `web/src/engine/zip-utils.ts`: `CreateZipOptions.deflate?: (data: Uint8Array) => Uint8Array | Promise<Uint8Array>`
  and `deterministic?: boolean` (entries sorted by name, fixed DOS date already at `:141`). Default path unchanged
  (`CompressionStream`). Document that pako `deflateRaw({ level: 9 })` is the release injection.
- **Files.** EDIT `web/src/engine/zip-utils.ts`; NEW `test/zip-deterministic.test.ts`.
- **First failing test.** `test/zip-deterministic.test.ts :: pako deflate yields identical archives regardless of CompressionStream`
  (stubs `globalThis.CompressionStream` with a different compressor; expects equal sha256 with the hook set and
  different without).
- **Then.** `:: entries are written in name order under deterministic`; `:: the archive still opens through the existing reader`
  (reuse `test/threemf-export`'s reader path).
- **Acceptance / verify.** `bunx vitest run test/zip-deterministic.test.ts test/threemf-export*.test.ts`; `bun run typecheck:web`.
- **Do NOT touch.** Anything else.

### C01 — coaster design -> path (BIZ-13) — `biz-c01`
- **Goal/scope.** `web/src/engine/coaster-design.ts` with the types of plan A §2.3 (`CoasterElement`, `CoasterZone`,
  `CoasterDesign`, `ShowCue`, `GeneratedCoaster`). `generateCoaster(design)`: elements -> a point list at <= 0.4-block
  spacing (the 25 LDU rule, `coaster-track.ts:48`) using clothoid transitions, heartline rolls about `heartlineB`,
  explicit `ups` per point (no inference), zones by arc distance, and a report `{ lengthB, heightB, footprintB,
  inversions, maxG, minG, maxLateralG, maxSpeedBps, lapS }` from an energy model (`GRAVITY 19.6`, `DRAG 0.008`
  at pace sqrt 2, read from `COASTER_PHYSICS`). `validateCoaster(gen)`: closure (position, tangent, up continuous at
  the station within tolerances), vertical g in [-1.0, +4.5], lateral <= 1.5, a jerk bound, world height (<= 319 with
  the ground at 64). Pure math over `coaster-path.ts` types; no runtime change.
- **Files.** NEW `web/src/engine/coaster-design.ts`, `test/coaster-design.test.ts`, `test/fixtures/coaster/3x-sketch.json`
  (a first sketch of plan A §5.1's layout, numbers only).
- **First failing test.** `test/coaster-design.test.ts :: a station-lift-drop-loop-brake circuit closes with continuous position, tangent and up`.
- **Then.** `:: a loop of radius r reports one inversion`; `:: an airtime hill's crest g is below 0`; `:: consecutive samples are at most 0.4 blocks apart`;
  `:: the report of the 3x sketch exceeds 10303 on every axis (length >= 545, height >= 132, longest footprint axis >= 120, inversions >= 6)`;
  `:: a design above world height is refused`; `:: lateral g above 1.5 in an unbanked turn is refused`.
- **Acceptance / verify.** Tests green; `bun run typecheck:web`; `bun scripts/_physics_spec_check.ts` passes (it
  reads physics-named modules; if it flags `coaster-design.ts`, add the module to its classification table in
  `docs/physics-architecture.md` with its constants, as the doc requires; run `typecheck:web` FIRST, the check hangs on a syntax error).
- **Do NOT touch.** `bedrock-coaster.ts`, `coaster-path.ts`, `coaster-track.ts`, `schem-pipeline.ts`, any sim adapter.

### X-11 — mesh -> stud lattice (BIZ-33) — `biz-x11`
- **Goal/scope.** `web/src/engine/legolize/lattice.ts`: `meshToLattice(object3d | parsed mesh, { lduPerUnit, mode, nearest })`
  -> `IntentLattice` (declare the §1.1 type locally in `legolize/types.ts` with a `// TODO(X-08): import from brickgen/types`;
  identical shape). Scale Y by 20/8 so one cell is 20 x 8 x 20 LDU; voxelise isotropically at 20 LDU through
  `threeToGridAsync` (`src/convert/voxelizer.ts:195`); solid vs surface mode chosen as `mesh-to-grid.ts:59-66`
  does; per-cell colour from `texture-sampler.ts` or `COLOR_0` (linear -> sRGB); labels `{ role: 'solid', colour }`
  one per distinct snapped colour; `nearest(rgb)` injected (a 40-colour default table in `legolize/palette.ts` until
  X-08's `nearestLdrawColour` lands). Also `latticeFromBricks(ParsedBrick[], meshes)` to voxelise an LDraw model on
  the same lattice (needed by X-12/B16 ground truth).
- **Files.** NEW `web/src/engine/legolize/{types,lattice,palette}.ts`, `test/legolize-lattice.test.ts`.
- **First failing test.** `test/legolize-lattice.test.ts :: a 40x24x40 LDU box fills exactly 2x3x2 plate cells` (triangles built in the test, never a `BoxGeometry` round-trip).
- **Then.** `:: a vertex-coloured red mesh snaps to LDraw 4`; `:: a 1-plate-thick slab is one cell tall, not zero`;
  `:: surface mode leaves the interior of a closed box empty and solid mode fills it`; `:: latticeFromBricks of one 2x4 brick fills 2x3x4 cells`.
- **Acceptance / verify.** Tests green; `bun run typecheck:web`; measure voxel IoU vs input on 5 clean GLBs you
  export yourself from LDraw fixtures (`src/pipeline/export/` writes GLB) and record the numbers (target >= 0.85).
- **Do NOT touch.** `mesh-to-grid.ts`, `mesh-import.ts` (B09's), `src/convert/voxelizer.ts`, `web/src/brickgen/**` (X-08's).

### B29 — corpus manifest + polite fetcher (BIZ-48) — `biz-b29`
- **Goal/scope.** `test/fixtures/byom-corpus.manifest.json` from plan B §5 tables (`{id, kind, title, author, url, licence,
  role, manual?, notes}`; sha256/fetchedAt filled by the fetcher). `scripts/byom-corpus-fetch.ts [--only=<id>]`: one
  item at a time, honours robots.txt, >= 2.5 s between requests, writes ONLY under `data/byom-corpus/{files,photos}/<id>/`
  (gitignored by `.gitignore:27`), records sha256 + `fetchedAt` + the licence read from the API/page PER FILE for
  Commons (`imageinfo` API) and Flickr, stops at any login/terms wall or 4xx and records `status: 'unresolved'` with the
  HTTP status (never "absent"), prints the exact manual steps for `manual: true` items (BrickLink, Sketchfab) and never
  logs in or accepts terms. Honours 429 with backoff that waits the window out.
- **Files.** NEW `test/fixtures/byom-corpus.manifest.json`, `scripts/byom-corpus-fetch.ts`, `web/src/engine/byom/corpus-manifest.ts`
  (schema + validation, pure), `test/byom-corpus-manifest.test.ts`.
- **First failing test.** `test/byom-corpus-manifest.test.ts :: every manifest entry has a url, licence and kind, and no path outside data/byom-corpus`.
- **Then.** `:: an entry with licence "not stated" is marked import-only`; `:: a 4xx response is recorded as unresolved with its status, never as absent`
  (fetcher core with an injected fetch); `:: a manual item prints steps and downloads nothing`; `:: requests are at least 2.5 s apart` (fake clock).
- **Acceptance / verify.** Tests green; one real run `bun scripts/byom-corpus-fetch.ts` over the non-manual items;
  report counts per DISTINCT item: fetched / unresolved (with status) / manual, and the exact list of manual
  downloads for the user (`U-list`). Nothing committed under `data/`.
- **Do NOT touch.** Anything under `web/src/ui`, the Worker, any file not listed; never download from a URL not in the manifest.

### B01 — one model-import service (BIZ-30) — `biz-b01`
- **Goal/scope.** `web/src/engine/byom/import.ts`: `importModelFile(bytes: Uint8Array, name: string): Promise<ImportedModel>`
  (type in plan B §3.3) for `.ldr`, `.mpd`, `.io` (via `extractIoModel`, keeping `CustomParts` and the Studio colour
  space), `.lxf`/`.lxfml` and `.zip` (first model inside); `byom/xml.ts`: a small DOM-free XML tokenizer producing the
  element/attribute access `lxf-parser.ts` needs; `parseLxfWithDiagnostics` takes the parser by injection (default
  `DOMParser` in the browser, `xml.ts` elsewhere) so LXF parses in vitest/Bun. `lego.ts` `parseMpdFile` (`:2325`) and
  `loadIndexedModelBody` (`:1773`) both call `importModelFile` and keep their behaviour; warnings come back in the
  result, not a module global.
- **Files.** NEW `web/src/engine/byom/{import,xml,types}.ts`, `test/byom-import.test.ts`. EDIT `web/src/engine/lxf-parser.ts`
  (`:1232-1236` injection only), `web/src/ui/lego.ts` (the two call sites).
- **First failing test.** `test/byom-import.test.ts :: parses a bare .lxfml without DOMParser` (a 3-brick LXFML string fixture; `DOMParser` undefined in vitest).
- **Then.** `:: .io keeps CustomParts and the Studio colour space`; `:: mpd sub-models are listed with brick indices`;
  `:: warnings are returned, not written to a global`; `:: a zip yields the first model inside`;
  `:: xml.ts and DOMParser agree on a corpus LXFML` (gated on `C:/git/clego/lego_sets` existing; read inside `it`).
- **Acceptance / verify.** Tests green; `bun run typecheck:web`; existing `test/lxf-*.test.ts` and `test/lego-*` green;
  manual check in `bun dev:web` that uploading an `.io` and picking an index set still render (screenshot < 2000 px).
- **Do NOT touch.** `schem-pipeline.ts`, `playable-addon.ts`, `upload.ts`, `mesh-import.ts` (B09's), the Worker.

---

## 4. Waves 2+ and the serial chains

Wave N starts when every package it depends on has MERGED into `main` and the orchestrator's post-wave gate is green
(`bun run test`, both typechecks, `bun scripts/sim.ts --scenario=regressions` on the favourites' packs). Within a
wave, packages joined by `->` are serial (same file) and run as one agent or in that order.

| Wave | Packages | Serial chains / collision notes |
|---|---|---|
| **2** | X-05, X-02 -> X-17, X-03, X-09, A05, X-12, X-13, X-15, B09, B15, F01, M15, M06, C03, D-06, D-16, X-14 | X-02 then X-17 own `playable-addon.ts` (X-17 also `schem-pipeline.ts`, `playable-components.ts`: **merge `gen-seat4-veh` and `gen-view-veh` first**, or X-17 waits); X-15 alone owns `wrangler.toml`; X-14 alone edits `_pack_render.ts`; A05 alone edits `web/tsconfig.json`; X-13 depends on X-08's `partStem` (exists) only |
| **3** | X-10, X-07, M03, M07 -> B08, M14, B03, B11, A09, C02, D-08 (stages flagged until deps land), D-09, D-13, F02 (if U4 answered) | `bedrock-placement-pack.ts`: M07 -> B08; `schem-pipeline.ts`: B03 -> C02 (after the vehicle branches); `collider-form.ts` + `addon-walk.ts` + sim collider reader: M03 only; `web/src/sim/**`: M14 only; `worker/api/router.ts`: D-13 after X-15 |
| **4** | A07, A08, A10, B12, B13, B16, C04, T01, T02, D-10, D-12, S01, L00 (if U5), P01a (if U4 and `gen-side-1109` merged) | `bedrock-coaster.ts`: C04 (then C05 in wave 5); `web/src/sim/**`: T02 then F03/C04 adapter; `web/vite.config.ts` + `sw.js`: D-12 only; D-12's merge is an approval merge |
| **5** | A11, C05, C06, F03, B17, B30, D-14, D-17, S02, B24, B26 (approval merge) | `bedrock-coaster.ts`: C05; `minifig-rig.ts`: F03; `web/index.html`/`main.ts`: B26 only |
| **6** | L01 (pilot), C07, P02, P03, P04, D-18 (RC; then the device round, then approvals), `TODO(pack-ids)` threading | designs repo; `bedrock-rides.ts`: P04 only; `bedrock-placement-pack.ts`: P03 kit menu |
| **7** | L02..L05 (4 agents, one city each), P01b, A-SS1, A-SS2, D-15 (after the first release) | designs repo + one new grammar file per batch |
| **8** (gated on U6/U7/U8) | B19 -> B20 -> B21 -> B22, B23, B25, B27, B28 | all in `worker/api/**` and `web/src/ui/byom/**`; D1 migrations; every route stays commented until approved |

Standing serial rules (never two at once): `playable-addon.ts` (X-02 -> X-17 -> M03 hook -> B08 -> F02 caps -> C02 hook);
`schem-pipeline.ts` (vehicle branches -> X-17 -> B03 -> C02); `bedrock-coaster.ts` (C02 -> C04 -> C05);
`web/src/sim/**` (M14 -> T02 -> F03 -> C04 adapter); `minifig-rig.ts` (F02 -> F03); `ldraw-directives.ts`/`ldraw-parser.ts`
(X-08 only; others request metas through it); `ldraw-geometry.ts` (X-04 only); `wrangler.toml` (X-15 -> D-13);
`REQUIREMENTS.md`/`TASKS-BUSINESS.md` (the orchestrator only). `cockpit-seat.ts` and `scene-vehicles.ts`: nobody until
`gen-side-1109`, `gen-seat4-veh`, `gen-view-veh` merge (the orchestrator merges or closes them first; `gen-view-1106`,
`gen-veh-1106`, `gen-ix-1107`, `gen-lift-1107`, `gen-seat4-1106` are already in `main` and can be pruned).

---

## 5. The user's open questions, ranked by the work they block, with a recommended default

| # | Question (merged from) | Blocks | Recommended default |
|---|---|---|---|
| **U1** | Brand: the `<creator>` namespace code (lowercase, no leading digit, e.g. `cmt`), the studio name for `0 Author:` and our `.ldr` `!LICENSE` line, the publisher name and a non-chat contact email for listings (A Q1, D 1, D 8) | every release identity (X-01 namespace), D-18, S02; code proceeds with placeholder `cmt` / `<Brand>` | Decide once, early in Wave 2; it is irreversible after any public build. No LEGO-like or Minecraft-like word; run a trade-mark search on the brand. |
| **U2** | Where proprietary sources live: designs, polish ops, provenance logs; also `release/` and `worker/api` (A Q3, B Q7, D 10) | L00+, C07, P0x designs, D-17/18 | §8: a local private git repo `C:/git/craftmatic-designs` now (X-00 creates it; not pushed); engine, fixtures, sampler designs and the product layer stay public. A private GitHub remote is an outward step for you to approve. |
| **U3** | Lawyer batch (A Q6, B Q1-Q3, D 2, B Q10): descriptive vs proper landmark names; Eiffel daytime-only; the hold list (Italy, Greece, Egypt, Mexico); generic studded blocks; figure distinctness evidence; LDraw/OSM credits wording in a pack; "Brick Wand"; charging for a converter whose output is a mod; `.io` CustomParts and Studio-only meshes in commercial output; minifigs in creators' MOCs; the free pack's licence (All Rights Reserved vs CC); DMCA agent and the business entity | nothing in code; every listing, submission, live payment and the paid tiers | Build on; send ONE document (the review's §1 E11 list + these items) to a lawyer before S02/D-18 approvals. Defaults until then: descriptive titles, daytime Eiffel, hold list held, refuse Studio-only/CustomParts in commercial output, replace minifigs with our figure in commercial exports, All Rights Reserved. |
| **U4** | Our figure: pick one of F01's three candidates and its name (A Q4) | F02, F03, P01a..P04, B's `brick-figure` default | Look at F01's contact sheets (Wave 2); default the candidate with the lowest silhouette IoU that still sits and rides in the sim; working name "Brickling". |
| **U5** | Approve the 22 landmarks + hold/exclusion lists (A Q7), and pick TWO more show-stoppers from: a 100-block drop tower + sky swing; a water-slide tower with four chutes; a dark ride in the same mountain; a stunt arena for the garage cars; a 400 % walk-in landmark | L00+, A-SS1/SS2 | Approve the list as proposed (Notre-Dame first); show-stoppers: the drop tower + sky swing (reuses P04's rides at epic scale) and the dark ride (reuses C05). |
| **U6** | Build B's SaaS layer now (accounts, tickets, Stripe test, takedown, showcase, photo queue: ~10 packages) or after the converter is proven on the corpus? (review §4.1) | B19-B23, B25, B27, B28 | After: Wave 8. Keep the three interfaces now. The paywall is an honour system on a public MIT repo; the signed report and terms are the paid value, and they need U3 first. |
| **U7** | Payments: Stripe direct (we register for tax) or a merchant of record (Paddle / Lemon Squeezy); the Stripe TEST account sign-up (B Q5) | B21, B27 | `PaymentProvider` seam; Stripe TEST mode first; the merchant-of-record choice with the entity/lawyer. The test-account sign-up is yours. |
| **U8** | Hosting for cloud builds and photo jobs (Cloudflare Containers, Railway, GPU rental) and a monthly cost ceiling (B Q6) | B24/B25 deployment only | None until demand: local GPU agent and the browser-side build. |
| **U9** | Free tier above 300 parts: static blocks only, or a watermarked add-on with every feature? (B Q8) | B08, B20 rules | Watermarked add-on with all features (the code is public anyway; friendlier funnel). |
| **U10** | Rebrickable data terms for the official-set fingerprint DB; BrickLink/Rebrickable terms for linking MOCs (B Q4) | X-13's official-set DB source | Build the DB from our own index hashes and the local corpus first (no Rebrickable); add Rebrickable only if its terms allow. |
| **U11** | Release-file hosting: R2 via the Worker `/get/*` (counted) and/or GitHub Releases as a mirror; itch pricing "No payments" vs "$0 or donate" (D 3, D 4) | D-13 config, D-09 itch fields | R2 via the Worker; no GitHub Releases; itch "No payments" (tips go to Ko-fi). |
| **U12** | Funnel providers: newsletter (Buttondown?), Discord, Cloudflare Web Analytics beacon, Patreon at launch or Ko-fi only; which telemetry credentials you will grant (D 5, 6, 12, 13) | D-14, D-15 | Everything null at launch except Ko-fi and the cookieless CF beacon; Patreon later; grant credentials only after the first release. |
| **U13** | Accept the Minecraft EULA for `mct` on this PC (`mct eula`), or run `mct validate` yourself (D 9) | the live mct gate in X-06/S02/D-08 | You run `bunx @minecraft/creator-tools@0.21.0 eula` once. |
| **U14** | The live `craftmatic.click/downloads/Craftmatic-Lego-Pack.mcpack` and the LEGO tab's place on the same domain as the "original designs only" funnel (D 11, B Q9) | nothing before Wave 4 | Rename the download to a neutral name and unlink it from the LEGO tab button; keep the LEGO tab as the dev tool, never linked from `/packs/`. |
| **U15** | Sampler content: car + door kit + seat kit only in v1.0, micro landmark in v1.2? (D 7) | D-17, D-18 | Yes as proposed. |
| **U16** | Approve the first device round (both phones, state checked first) and an in-game capture session for store art/trailer (A Q8, D device evidence, S01) | finalize of D-18, S02 store art, the cloud-height / hyper-speed / cull measurements | After X-02/X-03/M03/M07 land (end of Wave 3): one round with a written measurement list. |
| **U17** | Lower-impact defaults to confirm: budget tiers (one `standard` until measured), coaster pace (sqrt 2), sounds (synthesised/CC0), product names (working titles; trade-mark search before use), who polishes (agents, you approve each contact sheet), ticking-area policy (ask the publisher), publisher question list (A Q9) | C04, C05, A11, C07, M06 | Take the defaults in brackets. |
| **U18** | The converter tab's name ("Create") (B Q9); the implementer commit signature ("— Opus 5.5" in the brief vs the user's "model version" rule) | B26; every commit | "Create"; each implementer signs with its own model version. |
| **U-list** | Hand downloads for the corpus (Sketchfab, BrickLink items marked `manual` by B29), and reading MobileBrick's dataset licence | B30/B16/B17 coverage | B29's report gives the exact list; you download by hand into `data/byom-corpus/` or say "skip". |

---

## 6. REQUIREMENTS.md rows to add (section 17), de-duplicated

Status `OPEN`, guards `none`, device `—` for all. X-00 pastes them; each later commit fills guards from the tests
named above. Shared mechanisms have an owner row (BIZ-22, 23, 24, 52, 55, 07, 09, 33); consumer rows cite it.

```md
| `BIZ-05` | Part mapper: real-building inputs (footprint, licensed photos + annotations, optional open 3D) -> ORIGINAL LDraw model through modular stages (site, massing, features, grammar, bricker, verify, emit, polish); the user 2026-11-09 | OPEN | plan A §3; X-08, X-09, X-10, A05, A07-A11 | none | — | not started |
| `BIZ-06` | Input licence gate (no Google Maps content, no unknown licence in a commercial run) and a per-design provenance log with a clean-room clearance by a second agent | OPEN | A05 `licence-gate.ts`, A11 `provenance.ts`, X-13 `_cleanroom_*` | none | — | not started |
| `BIZ-07` | OWNER: part-source ledger per resolved .dat, official-only library mode (no Studio-only mesh, alias, bl_ copy, logo stud or LEGO face art in a shipped pack) and the generated LDraw CC BY credits; used by A, B and D | OPEN | X-04 (`ldraw-geometry.ts`, `part-source.ts`, `credits.ts`), X-08 vocab | none | — | resolver probes Studio's UnOfficial tree (`ldraw-geometry.ts:190-201`); no credits file today |
| `BIZ-08` | Generated models are connected and stable (stud-lattice load paths, cantilever limits, no overlaps, legal parts) | OPEN | X-09 | none | — | only a voxel flood fill exists (`defect.ts:83`) |
| `BIZ-09` | OWNER: deterministic LDraw writer with `!CRAFTMATIC` authoring metas (registered in `ldraw-directives.ts`), and polish ops that survive regeneration; shared by A's designs and B's mesh route | OPEN | X-08 `emit/ldraw-writer.ts`, A11 | none | — | no writer today (`bff-loader.ts:68` is a mosaic) |
| `BIZ-10` | Notre-Dame icon: our own design from the real building, polished, provenance-logged, the first icon and the calibration pilot | OPEN | L01 (`$CRAFTMATIC_DESIGNS/landmarks/notre-dame-paris`) | none | — | needs U2, U5 |
| `BIZ-11` | At least 19 more landmark icons (the approved list), generated then manually polished with a reviewed contact sheet each | OPEN | L00, L02..L05 | none | — | needs U5 |
| `BIZ-12` | Landmark rights screen: lighting designs (Eiffel daytime only), name trade marks (descriptive titles), state heritage-image laws (hold list), exclusions | OPEN | plan A §4.1-4.2, L00 | none | — | lawyer review (U3) |
| `BIZ-13` | Epic original coaster >= 3x 10303 Loop on every axis (track >= 545 blocks, height >= 132, longest footprint axis >= 120, inversions >= 6), descent starting in the clouds (crest above the cloud layer, own cloud banks) | OPEN | C01 `coaster-design.ts`, C02, C03, C07 | none | — | no generated track today; cloud height unmeasured |
| `BIZ-14` | Coaster launches, cable lift, block brakes with two trains, trims, a per-route speed cap set by measurement | OPEN | C04 (`coaster-zones.ts`, `bedrock-coaster.ts`) | none | — | none exist; `MAX_SPEED` is global (`bedrock-coaster.ts:657`) |
| `BIZ-15` | Dark indoor segment inside an artificial mountain (darkness + fade cues, light blocks into air only, genre-only mine/space theme) | OPEN | C05, C06 | none | — | no dark zones |
| `BIZ-16` | Neon racing styling: emissive materials and original art, no brand or ride names | OPEN | C05, C06 | none | — | not started |
| `BIZ-17` | Vehicle garage pack of our own vehicles (drive, fly, chase and cockpit cameras); first car + door and seat kits as the sampler's content | OPEN | P01a, P01b | none | — | waits on `gen-side-1109`, `gen-seat4-veh`, `gen-view-veh` and U4 |
| `BIZ-18` | Pinball arcade pack of our own tables on official parts only | OPEN | P02 | none | — | official-part check first |
| `BIZ-19` | Doors and furniture pack of our own pieces with a kit placement menu | OPEN | P03 | none | — | not started |
| `BIZ-20` | Funfair pack: multi-seat orbit ride, drop tower, swings, bumper cars, slide; plus two further epic show-stoppers chosen by the user | OPEN | P04, A-SS1, A-SS2 | none | — | needs U5 |
| `BIZ-21` | Our own figure, measurably not a minifigure (silhouette IoU < 0.6, proportions differ >= 25 %), integrated with walk, seat and ride code and the doorway envelope | OPEN | F01, F02, F03 (`figure-brickling.ts`) | none | — | only LEGO figure systems (`minifig-rig.ts:61`); needs U4 |
| `BIZ-22` | OWNER: per-pack `<creator>_<pack>:` namespace, `geometry.<creator>_<pack>.*` ids and `<type>/<creator>/<pack>/` folders through a post-pass rewriter whose gate is zero `craftmatic` tokens + validators + sim; later threaded (`TODO(pack-ids)`) | OPEN | X-03 (`marketplace/rewrite.ts`, `_marketplace_pack.ts`), M14 (sim) | none | — | 223 `craftmatic:` literals in 19 engine files + 54 in the sim |
| `BIZ-23` | OWNER: one `PackProfile` option on `buildPlayableAddon`: frozen uuids + semver, injected clock and deflate, release texts, RP `pack_scope: world`, RP<->BP dependencies, `min_engine_version`, no vanilla texture override, no diagnostics, no face art, no dev stamp; dev packs unchanged without it; plus own brick blocks and <= 10,000 permutations | OPEN | X-02 (`playable-addon.ts`, `pipeline-version.ts`), M03 (`collider-form.ts`, `marketplace/blocks.ts`) | none | — | 17 vanilla `concrete_*.png` (`playable-addon.ts:2652`); 11,008 permutations; no `pack_scope` |
| `BIZ-24` | OWNER: validators: `_mcaddon_check.py --release` (one rule set for Marketplace, CurseForge and MCPEDL), a pinned MCTools `mct validate` wrapper at 0 Errors, a TS `pack-check` port with a parity test, and a stable-only Script API audit | OPEN | X-06, X-07, M15 | none | — | dev gate caps permutations at 65,536 (`_mcaddon_check.py:267`) |
| `BIZ-25` | Low-end device budgets: size, files, permutations, textures (static, X-06) and resident entities/cuboids + script ms per tick (runtime, from the sim); one `standard` tier until measured | OPEN | M06 (`_marketplace_budget.ts`) | none | — | tiers unmeasured (U17) |
| `BIZ-26` | Placement into air only with a prompt and relocation, an exact Undo, no leftover ticking areas, a guide book once per player, chat <= 28 chars on first join; a sim `marketplace` scenario proves it | OPEN | M07, T02 | none | — | "Blocks in this area will be replaced." (`bedrock-placement-pack.ts:1553`) |
| `BIZ-27` | Marketplace packs: player-facing names from `product.json` with no LEGO words, set numbers or dev stamps (pass the BIZ-55 lint) and ship the BIZ-07 credits | OPEN | X-02 texts, X-05 lint, X-04 credits (consumer) | none | — | "Minifig Creator Wand" (`playable-addon.ts:4062`), LEGO in the RP description (`:2626`) |
| `BIZ-28` | Store art (offline presets on the shared renderer) and an in-game shot list awaiting a capture session; a submission bundle prepared and NOT submitted | OPEN | S01, S02, X-14 | none | — | in-game capture needs U16 |
| `BIZ-29` | Scenario A test strategy: vendored CC BY LDraw vocabulary for CI, synthetic golden sites, sim `marketplace` scenario, BDS content-log smoke in a fresh non-experimental world | OPEN | X-08 fixtures, T01, T02, M14 | none | — | CI has no LDraw library today |
| `BIZ-30` | One model-import service for .ldr/.mpd/.io/.lxf/.lxfml/.zip with no DOM and no module globals; LXF parses in tests | OPEN | B01 (`byom/import.ts`, `xml.ts`) | none | — | `DOMParser` in `lxf-parser.ts:1234`; load logic written twice in `lego.ts` |
| `BIZ-31` | Explicit mode: BYOM exports and brickgen designs never apply set-number/title heuristics; one guarded predicate at every site; the creator's hints decide components | OPEN | X-17 (`labelHeuristicsAllowed`), B03 (`byom/hints.ts`) | none | — | a title "10300" gets time circuits today (`playable-addon.ts:2589`) |
| `BIZ-32` | Mesh uploads: OBJ, GLB/GLTF (Draco/meshopt), STL, 3MF, PLY with unit handling | OPEN | B09 (`mesh-import.ts`) | none | — | glb/gltf/obj only |
| `BIZ-33` | OWNER: mesh -> stud lattice -> brick model through the shared core (X-10 bricker, X-09 verify, X-08 writer) with surface fitting and a metrics harness (voxel IoU, silhouette IoU, dE2000, connectivity, part diversity); `.ldr` download | OPEN | X-11, B11, B12, X-12 | none | — | nothing turns a mesh into bricks today |
| `BIZ-34` | Creator-tagged doors, seats, wheels (and a coaster car on a hinted track) on meshes and photos become real parts the existing detectors turn into playable features | OPEN | B13 (`legolize/features.ts`) | none | — | not started |
| `BIZ-35` | BYOM packs: brand-neutral text, the Mojang disclaimer and the credits via the shared BIZ-55 / BIZ-07 modules; the free-tier watermark (name suffix + one sign removed by Undo) | OPEN | X-05, X-04, B08 (consumer) | none | — | "LEGO" 10x in `playable-addon.ts`; no disclaimer anywhere |
| `BIZ-36` | Part provenance in every BYOM report (official / unofficial / studio-only / custom / substituted); a commercial-tier export refuses studio-only meshes with no alias | OPEN | X-04 ledger, X-07 report (consumer) | none | — | needs U3 for CustomParts |
| `BIZ-37` | Official-set screen (MinHash fingerprint + exact hash) with thresholds calibrated per DISTINCT set; the same core runs the landmark clean-room check | OPEN | X-13 | none | — | DB source needs U10 |
| `BIZ-38` | Validation report with every export: TS pack-check (parity with `--release`), `McpackSummary`, sim child-play, features found and missed with reasons, part sources, screen, caveats, disclaimer; self-contained dark HTML | OPEN | X-07 | none | — | Python-only check today |
| `BIZ-39` | BYOM gen: photos -> mesh (Pixal3D / TRELLIS.2 via ComfyUI from `C:/git/comfyui-3d`) -> bricks, with synthetic gates (sim-rendered views, held-out silhouette) and real-photo gates (reprojection IoU, MobileBrick 3D IoU) per distinct build; the GPU job queue prepared, route off | OPEN | B15, B16, B17, B25 | none | — | part-exact recovery from photos is out of scope (PDF pipeline reaches 2/90 poses) |
| `BIZ-40` | Tiers, quotas, signed Ed25519 export tickets; the free tier above 300 parts per U9 | OPEN | B20, B08 | none | — | deferred (U6) |
| `BIZ-41` | Typed Worker API skeleton on the existing Worker: `/api/*` router, store interface, D1 prepared; every route and binding inert until approved (deploy.yml deploys on every push) | OPEN | X-15 | none | — | approval merge |
| `BIZ-42` | Accounts: passkeys, sessions, 13+/18+ age gates, delete and export my data | OPEN | B19, B27 | none | — | deferred (U6) |
| `BIZ-43` | Stripe TEST-mode checkout, subscriptions, idempotent webhooks, live-key refusal without approval vars, `PaymentProvider` seam | OPEN | B21 | none | — | deferred (U6, U7) |
| `BIZ-44` | Terms/privacy/takedown drafts marked pending legal review, the upload declaration, takedown intake with strikes and a hash blocklist | OPEN | B22 | none | — | deferred (U6, U3) |
| `BIZ-45` | Batch export: browser queue, studio CLI (`byom-batch.ts`), cloud builder container prepared and sized by measured RSS, not deployed | OPEN | B24, B28 | none | — | deployment needs U8 |
| `BIZ-46` | Showcase of original models only, moderated, title pattern screen; seeded from our designs | OPEN | B23 | none | — | deferred (U6) |
| `BIZ-47` | Mobile-first dark "Create" tab: upload -> tag (touch) -> screen -> export -> report; Playwright shots at 393/768/1440 reviewed | OPEN | B26 | none | — | approval merge; U18 |
| `BIZ-48` | Real BYOM test corpus (model files and photo sets found online), licences recorded per file, local-only under `data/byom-corpus/`, unresolved never read as absent; manual items listed for the user | OPEN | B29 | none | — | 82 candidates, all unverified until fetched |
| `BIZ-49` | Corpus regression run (a MOC census): imports, packs, sim pass, features, screen verdict, seconds and peak RSS per DISTINCT model | OPEN | B30 | none | — | 26/200 census sets fail a sim scenario today (IX-05, VEH-20) |
| `BIZ-50` | Free sampler pack of OUR OWN designs (one drivable car + a door kit + a seat kit; a micro landmark in v1.2) released free as the funnel; no free design inside a paid SKU | OPEN | D-17, D-18, P01a | none | — | needs U1, U2, U15, U16 |
| `BIZ-51` | Reproducible release builds: rebuilding a tag yields a byte-identical .mcaddon (offline official library, pinned toolchain, SOURCE_DATE_EPOCH clock, deterministic zip) proven by `release.ts verify` | OPEN | X-02 clock, D-03, D-08 | none | — | builds embed the instant (`pipeline-version.ts:219`) and runtime deflate (`zip-utils.ts:89`) |
| `BIZ-52` | OWNER: product identity minted once (random uuids, never from a label), semantic versions that must rise, namespace and uuids frozen across versions, no shipped id dropped, dev builds salted so they never shadow a release | OPEN | X-01 (`web/src/release/*`, `release/products/*.json`, `identity-ledger.json`) | none | — | uuids follow the label (`mcpack.ts:170`); version is a build instant |
| `BIZ-53` | Curated changelog per product rendered into the pack, CurseForge file notes, itch devlog and the site | OPEN | D-06 | none | — | none exists |
| `BIZ-54` | Release packaging passes BIZ-24's validators plus CurseForge/MCPEDL packaging rules (zip without root, no external download links) | OPEN | X-06 (consumer), D-08 | none | — | today's packs fail T4-T9 of the BIZ-04 report |
| `BIZ-55` | OWNER: the Mojang disclaimer verbatim with publisher + contact, the player-facing string table, and the forbidden-terms lint (LEGO marks, set numbers, minifig, licensed themes, ride-brand names, dev stamps, `craftmatic` ids) over every player-facing and listing string, with explicit exemptions; used by A, B and D | OPEN | X-05 (`pack-text/*`) | none | — | dev README/RP text names LEGO (`playable-addon.ts:2626`, `:4099`) |
| `BIZ-56` | sha256 sums for every artifact and ONE command (`bun scripts/release.ts prepare <product>`) that builds in a fresh worktree, runs every gate, writes upload bundles and an approval sheet, contains no upload code; finalize/verify prove the tag rebuild matches | OPEN | D-08 | none | — | — |
| `BIZ-57` | CurseForge + MCPEDL listing prepared (fields, categories, logo/screenshots/`MCPEDL` thumbnail within limits, description, changelog, rewards), awaiting approval | OPEN | D-09, D-10 | none | — | summary length and MCPEDL thumbnail size unverified |
| `BIZ-58` | itch.io free page prepared (fields, 630x500 cover, screenshots, tags, butler command), awaiting approval | OPEN | D-09, D-10 | none | — | pricing mode is U11 |
| `BIZ-59` | Ko-fi tips, a Patreon dev log with no paywalled packs, CurseForge rewards and the Minecraft affiliate link prepared (copy, images, checklists; the affiliate link never in-game), awaiting approval | OPEN | D-09, D-10 | none | — | accounts are the user's |
| `BIZ-60` | craftmatic.click packs gallery, detail pages and downloads list (turntables, install guide, checksums, credits, disclaimer, donation links apart from download buttons); dark, mobile-first, touch-sized; service worker excludes downloads | OPEN | D-12 | none | — | Vite builds only index.html (`web/vite.config.ts:51`); sw caches every GET (`sw.js:49-66`) |
| `BIZ-61` | Config-gated newsletter/Discord funnel (nothing live until approved) and privacy-first analytics: cookieless page analytics plus Worker download/click-out counters storing no IP, user agent or cookie; a /privacy/ page | OPEN | D-13, D-14 | none | — | providers undecided (U12) |
| `BIZ-62` | Media production: shared offline renderer (game-frame mirroring, supersampling, auto-fit) with turntables and every platform preset under 2000 px / 4 MB; a trailer storyboard whose shots hand to the device-round process | OPEN | X-14, D-16, S01 | none | — | `_pack_render.ts` may draw the mirror image (`:24-26`) |
| `BIZ-63` | Telemetry after the first release: downloads per channel, update uptake, supporters, conversion to A and B, in a weekly report reading only public or granted counters and reporting "not granted", never zero | OPEN | D-15 | none | — | deferred until a release exists |
| `BIZ-64` | Release cadence: free vs paid matrix, no free design inside a paid SKU, sampler updates sequenced before each A launch and the B beta | OPEN | D-17 | none | — | depends on the design registry |
```

Also update `BIZ-65`'s gap cell to: "plans reviewed 2026-11-09 (`docs/plans/business-review.md`); master plan
`docs/plans/README.md`; Wave 1 = X-08, X-01, X-04, X-06, D-03, C01, X-11, B29, B01".

---

## 7. Handoff: resume with zero context

### 7.1 Read, in order
1. This file (§1 for the shape, §2 for the table, §4 for the waves, §5 for what the user still owes).
2. `TASKS-BUSINESS.md` "Start here" and its three scenario sections: the live status per package (status, branch,
   last commit, gate result), the answers the user has given to U1..U18, the measurements still needed.
3. `CLAUDE.md` (the project's hard-won gotchas) and `docs/plans/business-review.md` §2 (why the X- packages exist).
4. The scenario plan for whichever package you touch (A §10, B §7, D §9 hold the original briefs and rationale).
5. `REQUIREMENTS.md` §17 rows for the package's BIZ ids.

### 7.2 See what is done and in flight
- `git branch --list 'biz-*'` and `git worktree list | grep biz-` : packages in flight.
- `git log --oneline --merges main | grep -i 'biz-'` : merged packages (merge commits carry the branch name).
- `bun scripts/requirements-ledger.ts --open` : BIZ rows still open; a `DONE-OFFLINE` row names its guard test.
- `TASKS-BUSINESS.md` waves table : one line per package; prune a line when its package merges (history is `git log`).
- Before touching a shared file, `git diff --name-only main...<branch>` for every live `biz-*` and `gen-*` branch.

### 7.3 Merge and review protocol
1. Implementer: in the worktree, `git merge main` (never rebase), `bun run typecheck && bun run typecheck:web`,
   own test files green, commit, final report to the orchestrator (files, tests, commands + output, TODOs, plan claims found wrong).
2. Orchestrator review: read the diff against the brief (scope creep, DRY against the X- owners, no `_fixed`/`_v2`
   files, no recursive delete, no outward call, typed + JSDoc, a `TODO` on anything unfinished); run the FULL
   `bun run test` in that worktree, ONE worktree at a time (contention breaks vitest); run
   `bun scripts/sim.ts --scenario=regressions` when the package touches the engine or the sim.
3. Merge: `git merge --no-ff biz-<id>` into `main` (merge commits only; the commit message cites the BIZ ids). Add
   the guard test name to the BIZ row and set `DONE-OFFLINE`; prune the tracker line; commit.
4. **Approval merges**: a push to `main` runs `deploy.yml`, which deploys the Worker and the site. Any merge that
   changes `web/` pages, `worker/`, `wrangler.toml` or `web/public/sw.js` is outward: get the user's yes first, or
   keep the change behind a config null / commented route that renders or routes nothing (X-15, D-12, D-13, B26).
5. After every push: `gh run list --limit 3` then `gh run watch <id>`; a red CI blocks the next merge.
6. Never generate a pack from a dirty tree; restart a dev server after a commit (the pipeline stamp is computed at start).
7. Commit signature: conventional type, BIZ id in the message, final line "— <implementing model version>" (no
   Co-Authored-By, never the word "Claude").

### 7.4 Commands
- Worktree: `git worktree add .worktrees/biz-<id> -b biz-<id> main && cd .worktrees/biz-<id> && bun install`.
  Never `git worktree remove`; leave finished worktrees (a stale folder costs disk, a wrong delete costs work).
- One test file: `bunx vitest run test/<file>.test.ts`. Suite: `bun run test` (never bare `bun test`). Typecheck:
  `bun run typecheck && bun run typecheck:web`. Physics spec: `bun scripts/_physics_spec_check.ts` (typecheck first).
- Pack gates: `python -I scripts/_mcaddon_check.py --release <pack>`; `bun scripts/release-mctools.ts <dir>`;
  `bun scripts/sim.ts <pack> --scenario=child-play|vehicles|marketplace|regressions`; `bun scripts/_bds_smoke.ts <pack>`.
- Design: `bun scripts/brickgen.ts <site.json> --design=<design.json> --out=<dir>`; `bun scripts/_cleanroom_check.ts <design.ldr>` (a different agent).
- Release: `bun scripts/release.ts init-product|prepare|finalize|verify|status <product>`; the user runs `git tag`.
- Evidence: `output/biz-<id>/` (gitignored), bundles in `output/releases/` and `output/marketplace-bundles/`.

### 7.5 Binding rules
Appendix A, verbatim. Plus from this review: one writer per shared file per wave (§4); the full suite runs serially;
approval merges (§7.3.4); nothing from the corpus leaves `data/byom-corpus/`; the clean-room denylist in every
landmark brief; designs never committed to the public repo (§8).

---

## 8. Where proprietary design sources live (default; the user decides, U2)

The repo `tribixbite/craftmatic` is PUBLIC and MIT. A paid pack's `.ldr`, polish ops and provenance log committed
there would be published, and anyone could rebuild the pack from them.

**Default (applied by X-00 until U2 says otherwise):**
- `C:/git/craftmatic-designs/`: a NEW local git repo (`git init`, no remote), read by code through the env var
  `CRAFTMATIC_DESIGNS`. Layout: `landmarks/<slug>/{site.json,design.json,generated.ldr,polish.ops.json,final.ldr,provenance.json,provenance.md,fidelity.json,verify.json}`,
  `rides/<slug>/*`, `packs/<slug>/*`, `renders/` (gitignored there, < 2000 px). Tests that need it are gated on the
  env var at module load and marked ` (designs)` in the ledger the way ` (corpus)` is. It is backed up by the user
  (it is not pushed anywhere); creating a private GitHub remote is an outward step for the user to approve.
- The PUBLIC repo keeps: the engine and the shared core, synthetic fixtures (`test/fixtures/brickgen/`,
  `ldraw-vocab/`), the FREE sampler's designs (free content whose source being public costs nothing and proves the
  pipeline), `release/products/*.json` identities (uuids are inside every shipped pack anyway), `release/copy`,
  `release/channels`, and the product layer `worker/api` (useless without the secrets, which are never committed:
  `.dev.vars`, Worker secrets, Credential Manager).
- Never in either repo: user corpus bytes (`data/byom-corpus/`, gitignored), licensed photos, Google Maps content,
  LEGO face art, Studio library files.
- If the user prefers one private repo for designs AND `release/` AND `worker/api`, the module boundaries in §1 make
  it a move, not a rewrite: the public engine imports nothing from them.

---

## Appendix A: the binding brief (verbatim from `brief-common.md`, 2026-11-09)

### Legal guard rails (binding; from the BIZ-01 verdict)
- Everything sold or released is OUR OWN design: never a LEGO set's part-for-part design; no LEGO name or logo, no
  set names or numbers, no licensed theme; no minifigure (use our own figure proportions).
- A landmark is designed from the REAL building (photographs, plans, footprints), never from LEGO's model of it.
  Keep a provenance log per design.
- Ride inspirations (Space Mountain, Seven Dwarfs Mine Train, Speed Racer, Six Flags) are GENRE references only: an
  indoor dark coaster in an artificial mountain; a mine-train theme; neon racing; a huge steel hyper coaster. Use no
  Disney, Warner or Six Flags names, characters or likenesses.
- LDraw parts are CC BY: ship the attribution. Studio-only meshes cannot be redistributed.
- User test inputs downloaded from the web (photos of people's builds, their MOC files) are for LOCAL tests only:
  gitignored, with their source and licence recorded, never shipped or redistributed.
- NOTHING outward without the user's per-instance approval: no publisher pitch, store upload, CurseForge or itch
  page, Reddit post, account sign-up or live payment keys. Plan those as "prepared, awaiting approval" steps. The
  user owns three decisions: a business entity, a lawyer, and live payment accounts.

### Process rules (binding, and every implementing agent inherits them)
- Fail-first TDD: every unit of work starts with a test that fails for the right reason. Use vitest via
  `bun run test` (never bare `bun test`); a single file runs with `bunx vitest run <file>`.
- Every user request gets a REQUIREMENTS.md row. Every fix cites its id and adds a guard test.
- Commits: conventional commits ending with the line "— Opus 5.5" (read: the implementing model's version). No
  Co-Authored-By, never the word "Claude".
- Work in git worktrees under `.worktrees/<name>` on branches. Never edit pipeline sources in the main checkout while
  a build runs. Commit before generating any pack. Merge, never rebase.
- NEVER run a recursive delete: no rm -rf, rm -r, Remove-Item -Recurse, rmdir /s, find -delete or git worktree
  remove, not even in temp dirs. Use a NEW directory name instead.
- No git reset, revert, discard, force or history rewrite. No bare `git stash`.
- No phones and no adb. The Minecraft client on this PC belongs to the user: do not touch it.
- Screenshots must be under 2000 px on every side and under 4 MB.
- No `_fixed` / `_v2` copies of files: edit in place.
- Typed, DRY, production-level TypeScript with JSDoc. A `TODO` comment marks anything unfinished.
