# Scenario B: "Bring Your Own Model", the converter sold as a tool

Planner's document, written 2026-11-09 for the Fable reviewer who merges plans A, B and D (`TASKS-BUSINESS.md`,
`BIZ-65`). It is a plan. No source file was changed to write it. Every claim about the repo cites a file and line,
read on `main` at `f9a1f5c0`. A figure marked **(measured)** was read off a file named beside it. A figure marked
**(target)** is a gate this plan proposes, and an implementer must measure it before quoting it as a result.

**This is not legal advice.** Every legal point in this plan comes from the BIZ-01 research and needs the user's
lawyer (section 9, Q1-Q6).

Contents:
1. What B is, and what it is not.
2. What exists today (measured).
3. Architecture: modules, boundaries, data types.
4. The photo route ("BYOM gen"): stages, honest accuracy, gates.
5. The test corpus: real public files and photo sets.
6. Product layer: accounts, tiers, watermark, Stripe test mode, terms, takedown, disclaimer, batch, showcase.
7. Work packages (one subagent each).
8. Parallelisation order.
9. Risks and open questions for the user.
10. REQUIREMENTS.md rows BIZ-30..BIZ-49.
11. The `TASKS-BUSINESS.md` section for B.

---

## 1. What B is, and what it is not

**B is** craftmatic.click selling a converter to creators. A creator brings their OWN brick model (a MOC) and gets
back a playable Bedrock add-on plus a validation report. The add-on has doors, seats, rideables, coasters and
cameras. The models come from three places:
- a model file: LDraw `.ldr`/`.mpd`, Studio `.io`, LDD `.lxf`/`.lxfml`;
- a 3D mesh: `.obj`, `.glb`/`.gltf`, `.stl`, `.3mf`, `.ply`, turned into bricks;
- PHOTOS of their real build, through an image-to-3D model, then into bricks.

**B is not:**
- a way to convert official LEGO sets: the terms forbid it, and an automatic screen flags them (WP B06);
- a store for players: we sell the tool, and a creator who wants to sell what they make lists it on the
  Marketplace themselves (`docs/business-scenarios.md:119-126`);
- branded with LEGO: the user-facing product is not called LEGO anywhere, and its showcase uses original models
  only (`docs/business-scenarios.md:142-144`).

**One fact shapes the whole product: the converter is open source.** The repo is PUBLIC and MIT-licensed (measured:
`gh repo view` returns `visibility: PUBLIC`, `licenseInfo: mit`). Anyone can run `bun dev:web` and export without
paying. A client-side paywall is therefore an honour system. The paid tiers must sell what the code alone cannot
give:
- a hosted service that needs no setup;
- a SIGNED validation report;
- commercial-use terms for the output;
- cloud batch builds for studios;
- support.

Whether to move the product layer (accounts, billing, cloud builder) into a private repo is the user's decision
(Q7). This plan keeps every product module behind interfaces, so it can move either way.

---

## 2. What exists today (measured)

### 2.1 Import, in the LEGO tab
| Input | Where | Notes |
|---|---|---|
| `.ldr` / `.mpd` | `web/src/ui/lego.ts:2384-2405` (`parseMpdFile`) → `parseLDraw` (`web/src/engine/ldraw-parser.ts:108`) | quality gate `reconstructionQuality` / `sourceCaveat` |
| `.io` | `lego.ts:2359-2382` → `extractIoModel` (`web/src/engine/io-extractor.ts`, password at `:30`) | carries `CustomParts/` geometry; Studio colour space via `ioColorFn` (`lego.ts:48-61`) |
| `.lxf` / `.lxfml` | `lego.ts:2344-2357` → `parseLxfWithDiagnostics` (`web/src/engine/lxf-parser.ts:1207`) | sniffs ZIP magic (`:1213-1214`); **uses `DOMParser` (`:1234`)**, so it runs only in a browser. No test parses an LXF end to end (no `DOMParser` in `test/`, and no DOM shim in `package.json`) |
| file picker | `lego.ts:707` | `accept=".mpd,.ldr,.io,.lxf,.lxfml"` |

The load logic is written TWICE: once for an upload (`parseMpdFile`, `lego.ts:2325`) and once for an index fetch
(`loadIndexedModelBody`, `lego.ts:1773`). Both are tied to the module's globals (`currentMpdContent`,
`currentCustomParts`, `currentSourceWarning`, `selectedSet`). Neither can be called from a script or a server.

### 2.2 Mesh import, in the Upload tab
- Formats: `glb`/`gltf`/`obj` only (`web/src/engine/mesh-import.ts:10`, `web/src/ui/upload.ts:14-17`). There is no
  STL, 3MF or PLY.
- `meshFileToGrid` (`web/src/engine/mesh-to-grid.ts:30`) voxelises into a Minecraft `BlockGrid`, by default
  capped at 96 blocks (`:51`), through `threeToGridAsync` (`src/convert/voxelizer.ts:195`).
- **Nothing turns a mesh into BRICKS.** A grep for brickify / voxelsToBricks / an LDraw writer finds none, and
  clego has no legolisation code either. A mesh reaches Bedrock only as static coloured blocks
  (`SchemSource.kind: 'grid'`, `web/src/engine/schem-pipeline.ts:61-69`).
- Every playable feature comes from part-based detection on `ParsedBrick[]`: doors, seats, vehicles, coasters,
  slides. So **a mesh has to become `ParsedBrick[]` before any of them can work.**

### 2.3 Export to `.mcaddon`
- One shared pipeline runs in the browser Worker and in the CLI:
  - `runSchemPipeline` (`schem-pipeline.ts:280`) calls `buildPlayableAddon` (`playable-addon.ts:2574`) at
    `schem-pipeline.ts:811`;
  - the Worker shell is `web/src/engine/schem-worker.ts`;
  - the CLI is `scripts/_playable_ref.ts`, which handles `.io`/`.mpd`/`.ldr` only (its usage text, lines 6-17)
    and hard-codes the local library at `C:/git/clego/extracted/studio_release/app/ldraw` (`:39`).
- Behaviour keyed on a set NUMBER or title, which a BYOM upload must not trigger:
  - `isTimeMachine` regex: `playable-addon.ts:2589`;
  - Batcave: `playable-addon.ts:2599`;
  - `/\b(?:76252|10300)\b/`: `playable-components.ts:107`;
  - canon lookup: `canonFor`, called at `schem-pipeline.ts:636-637`, defined at `set-canon.ts:101`;
  - a whole-vehicle guess from a title word: `isWholeVehicleLabel`, `playable-addon.ts:2596`.

  A creator who names an upload "10300" would get the DeLorean's time circuits.
- Player-facing text says LEGO and minifig. "LEGO" appears 10 times in `playable-addon.ts`, 6 in
  `lego-resource-pack.ts`, 3 in `bedrock-placement-pack.ts` and 1 in `mcpack.ts`. The README string at
  `playable-addon.ts:4099` says "the set's own LEGO parts".
- **No pack carries the Mojang disclaimer:** a grep for "Mojang"/"NOT AN OFFICIAL" in `web/src/engine` finds only
  data-source comments in `bedrock-block-states.json`.
- **No pack carries the LDraw CC BY attribution:** the only "attribution" hits are in `head-face.ts` and
  `bedrock-collider-scale.ts`, and neither is a credits file.
- Provenance already exists:
  - `PackProvenance` (`web/src/engine/pipeline-version.ts:96-108`);
  - `SourceProvenance` with sha256/12 (`:69-77`, `sourceHash12` `:307`).

  BYOM extends these instead of inventing new ones.
- Generality. Detection is tuned on the favourites. The census of 200 other sets had **26 that fail a sim
  scenario**, against 1 of the 40 favourites (`REQUIREMENTS.md` `IX-05`, `VEH-20`; memory
  `project-generality-census`). Fixes are landing, but MOCs are exactly the "any model" population, so B inherits
  this gap. Its corpus gate (WP B30) is a second census.

### 2.4 Export cost (measured)
`output/favsweep-4da29033/*.json` holds the sequential CLI sweep of the 40 favourites on this PC. Its `ms` field,
summarised by a scratch script:

| | Value |
|---|---|
| Wall time per pack, median | **138 s** |
| Wall time per pack, p90 | **846 s** |
| Wall time per pack, max | **1,782 s** (10261, 4,209 bricks) |
| Wall time per pack, min | 47 s (11374, 2,256 bricks) |
| Pack size, median | 1.06 MB |
| Pack size, max | 2.65 MB |

An older figure in `schem-worker.ts:9-11` is a 1.33 GB RSS peak for one encode chain.

**So conversion cannot run in a Cloudflare Worker.** Its CPU and memory limits are orders of magnitude short.
Conversion stays in the creator's BROWSER (the existing Worker), and it can also run in a container we host
(WP B24, prepared).

### 2.5 Validation that exists
| What | Where | Gap |
|---|---|---|
| Pack structure and identifiers | `scripts/_mcaddon_check.py` (307 lines) | Python, so not in the browser |
| Headless Bedrock sim | `web/src/sim`; `bun scripts/sim.ts`; ALREADY runs in the browser for the Walk preview (`web/src/ui/addon-sim-worker.ts:1-25`) | none: reused as is |
| Cuboid budget | `packCuboidBudget` (`playable-addon.ts:555`) | none |
| Seat census, access recommendation | `McpackSummary` (`schem-pipeline.ts:172-201`) | none |

### 2.6 Photos and image to 3D
- Image to 3D is set up on this PC:
  - ComfyUI v0.42.1 at `C:/git/comfyui-3d` (its own venv). It holds `pixal3d_multiview_int8_convrot`,
    `pixal3d_int8_convrot`, `trellis_2_int8_convrot` and `qwen_image_edit_2511_int8_convrot` in
    `models/diffusion_models/`.
  - A tested driver is the user's other project, `C:/git/pokeball/pokefit/imageto3d.py` (830 lines). It does
    BiRefNet masks, framing to Pixal3D's rig (20° FOV, azimuths 0/90/180/270, unit cube at 1/1.1 of a 1024 px
    frame), the multi-view template, a solid remesh, and a vertex-colour GLB.
  - `pokeball/NOTES.md:438-441`: 203 s for 3 views while another app held 12 GB of the 16 GB of VRAM.
  - The user's global notes: `RemeshMesh sign_mode "udf"` gives a double-walled skin; use `"solid"`.
- Photogrammetry, address to blocks:
  - `src/pipeline/capture/tiles-from-glb.ts`, `fusion/`, `export/photogrammetry-recolor.ts`;
  - `web/src/engine/mesh-to-grid.ts`, `tile-capture.ts`, `texture-sampler.ts`.

  It voxelises textured photogrammetry meshes to blocks, with surface mode for open meshes
  (`mesh-to-grid.ts:59-66`). Reusable here: the texture sampling and the solid/surface mode choice.
- The PDF reconstruction is the honest reference point for "image to EXACT parts". With instruction PDFs, CAD
  geometry and calibrated cameras it reaches **2/90 correct full poses** on 40377 (`docs/pdf-pipeline-guide.md`,
  first section). Photos of a finished build carry less information than instruction PDFs. **So this plan does
  not promise part-exact recovery from photos** (section 4).
- An offline software rasteriser exists: `web/src/sim/render/rasterizer.ts:82`, used by
  `scripts/_pack_render.ts`. It can render synthetic "photos" of a known model for ground truth (WP B16).

### 2.7 Hosting (`docs/deployment-guide.md`, `wrangler.toml`, `.github/workflows/deploy.yml`)
- The static build `web/dist` goes to GitHub Pages behind Cloudflare at `craftmatic.click`.
- One Worker, `worker/ldraw-omr.js` (plain JS), serves the routes declared in `wrangler.toml`:
  - `/ldraw-omr/*`, `/ldraw-parts/*`, `/lego-models/*`, `/lego-models-index.json`, `/bff/*`, `/seymouria-ldr/*`,
    `/connect*`;
  - an R2 binding `MODELS` (bucket `lego-models`);
  - a Durable Object `LIVE_DELIVERY` with SQLite (`wrangler.toml` `[durable_objects]`, migration
    `v1-live-delivery`).
- There is no D1, no auth and no payments. `deploy.yml` deploys the Worker on every push to `main`
  (`wrangler-action`, `wranglerVersion 4.95.0`).
- The R2 parts mirror still holds keys from the 2026-08-18 upload of the STUDIO-bundled library. The sync leaves
  R2-only keys alone (`scripts/sync-ldraw-r2.mjs:12-27`), so the prod part server can return Studio-only meshes
  (relevant to WP B05).
- `.gitignore:27` ignores `data/`, so `data/byom-corpus/` is ignored without a new rule (measured:
  `git check-ignore -v data/byom-corpus/x.ldr` → `.gitignore:27:data/`).

### 2.8 UI
- Dark theme tokens: `web/src/style.css:3-31` (`--bg-base #0a0a14`, `--accent #5865f2`, ...), with 9 `@media`
  blocks.
- Nav tabs: `web/index.html:41-49`.
- The LEGO tab is `initLego` (`lego.ts:431`), mounted at `web/src/main.ts:989`.

---

## 3. Architecture

### 3.1 Principles
1. **One conversion pipeline.** BYOM calls `runSchemPipeline` as the LEGO tab does. No fork, no `_byom` copy of
   any pipeline file. BYOM differs only through typed inputs: a `sourceKind`, the creator's hints and an
   entitlement.
2. **The build runs where the CPU is free: the creator's browser.** The server never parses a model on the free
   path. It sees only what the client sends:
   - a hash;
   - a part/colour fingerprint, for the official-set screen;
   - the part count;
   - the features found.

   Studio batch and "cloud build" run the SAME pipeline in a container (WP B24).
3. **The Worker is a thin, typed API:** auth, entitlements, Stripe, takedowns, the showcase and the photo-job
   queue, on D1 + R2. No model bytes are stored unless the creator submits to the showcase or asks for a cloud or
   photo job.
4. **Everything outward is a switch that is OFF:**
   - live Stripe keys;
   - the D1/R2 resources in the user's Cloudflare account;
   - email sending;
   - the GPU queue's public route;
   - the container deployment.

   Each is prepared, tested locally (`wrangler dev` with local D1, Stripe test mode) and marked
   "awaiting approval" in the tracker.

### 3.2 Module map (new paths are marked NEW)

```
web/src/engine/byom/                      NEW: pure TS, no DOM; runs in the browser Worker, Bun CLI and vitest
  import.ts          importModelFile(bytes, name) -> ImportedModel   (all formats, one dispatcher)
  xml.ts             DOM-free XML reader for LXFML (replaces DOMParser in lxf-parser.ts via injection)
  hints.ts           ByomHints schema + validation + application to bricks (which component is what)
  part-provenance.ts per-.dat origin (official / unofficial / studio-only / custom) + credits
  fingerprint.ts     part+colour MinHash fingerprint; official-set screen (shared with the Worker)
  pack-check.ts      TS port of scripts/_mcaddon_check.py (+ Marketplace-readiness rules)
  report.ts          ValidationReport assembly + HTML render (self-contained, dark)
  entitlement.ts     ExportEntitlement type, ticket verify (Ed25519 public key), watermark plan
  ldraw-writer.ts    ParsedBrick[] -> .ldr text (round-trips through parseLDraw)
web/src/engine/legolize/                  NEW: mesh -> bricks
  lattice.ts         mesh -> stud lattice (20 x 8 x 20 LDU cells) occupancy + colour
  palette.ts         sRGB/linear -> nearest LDraw solid colour (CIEDE2000), buildable palette
  merge.ts           plate/brick merge (stagger, connectivity, stability)
  surface.ts         stage-3 part fitting: slopes, tiles, rounds
  features.ts        tagged features -> real functional parts (door frame+leaf, seat, wheels)
  metrics.ts         voxel IoU, silhouette IoU (6 views via sim rasterizer), dE2000, connectivity
web/src/engine/mesh-import.ts            EXTEND: stl, 3mf, ply; draco/meshopt glb
web/src/ui/byom/                          NEW: the "Create" tab (mobile-first dark UI)
  index.ts  upload.ts  photos.ts  tag.ts  check.ts  export.ts  account.ts  billing.ts  batch.ts  state.ts
web/public/legal/                         NEW: terms.html privacy.html takedown.html (DRAFT, lawyer review)
web/public/showcase/                      NEW: static gallery shell (data from /api/showcase)
worker/index.ts                           NEW entry: /api/* -> api router, everything else -> ldraw-omr.js as today
worker/api/                               NEW (TypeScript)
  router.ts  env.ts  store.ts (interface)  store-d1.ts  store-memory.ts
  auth.ts (passkeys + sessions)  entitlements.ts  tickets.ts (Ed25519)
  stripe.ts (test mode only)  webhooks.ts  takedown.ts  showcase.ts  photo-jobs.ts  screen.ts
worker/migrations/0001_byom.sql           NEW: D1 schema
tools/photo3d/                            NEW: Bun TS ComfyUI client + GPU-host agent (runs on the GPU box only)
  comfy.ts  framing.ts  graphs.ts  agent.ts  cli.ts
services/byom-builder/                    NEW (prepared, not deployed): container image running runSchemPipeline + sim
scripts/byom-corpus-fetch.ts  scripts/byom-corpus-run.ts  scripts/_byom_metrics.ts  scripts/byom-batch.ts   NEW
test/fixtures/byom-corpus.manifest.json   NEW: committed METADATA only (url, licence, sha256, kind); bytes in data/byom-corpus/
```

**Boundary rules**, enforced by a test `test/byom-boundaries.test.ts` that greps the imports:
- `engine/byom/*` and `engine/legolize/*` import nothing from `web/src/ui`, nothing from `three/examples` except
  through `mesh-import.ts`, and touch no DOM.
- `worker/api/*` imports only `engine/byom/fingerprint.ts`, `entitlement.ts` and `report.ts`'s types from the
  engine. It never imports the pipeline.
- `tools/photo3d/*` never imports `worker/`.

### 3.3 Data types (contract; implementers refine names, not meaning)

```ts
/** What a creator brought, after import, before any pipeline option. */
export interface ImportedModel {
  format: 'ldr' | 'mpd' | 'io' | 'lxf' | 'lxfml' | 'mesh' | 'photos';
  file: string;                       // name as chosen
  hash12: string;                     // sourceHash12 of the bytes as chosen (pipeline-version.ts:307)
  bricks: ParsedBrick[];              // LDraw placements (mesh/photos: after legolize)
  colorSpace: BrickColorSpace;        // schem-pipeline.ts BrickSource.colorSpace
  ldrawText?: string;                 // .ldr/.mpd/.io text, for sub-model resolution in the viewer
  customParts?: ReadonlyMap<string, string>; // .io CustomParts
  submodels: Array<{ name: string; brickIndices: number[] }>; // MPD/.io sub-files: the creator's own grouping
  warnings: string[];                 // replaces the currentSourceWarning global
  lxf?: LxfDiagnostics;               // alignment coverage (lxf-parser.ts)
  mesh?: { triangles: number; units: 'mm' | 'ldu' | 'unknown'; legolize: LegolizeStats };
}

/** The creator's own statements about their model; replaces every set-number / title heuristic for BYOM. */
export interface ByomHints {
  title: string;                      // player-facing name; never parsed for set numbers or vehicle words
  namespace: string;                  // <creator>_<pack>, validated [a-z0-9_]{3,32} (Plan A's namespace WP)
  components: Array<{
    select: { submodel: string } | { brickIndices: number[] } | { box: [Vec3, Vec3] };
    kind: 'car' | 'plane' | 'boat' | 'hover' | 'flyer' | 'static' | 'coaster-car';
    facing?: '+x' | '-x' | '+z' | '-z';
    seats?: number;
  }>;
  features: Array<{ kind: 'door' | 'seat' | 'slide' | 'lift'; at: Vec3; yaw: number; size?: Vec3 }>; // mesh/photo models
  scale: AddonScaleChoice;            // engine/addon-scale.ts
  figures: 'keep' | 'brick-figure' | 'none';  // 'brick-figure' = Plan A's non-minifig figure (Q3)
}

export type Tier = 'free' | 'per-model' | 'creator' | 'studio';

/** What the server allows ONE export to be; signed so the report and pack can prove it. */
export interface ExportEntitlement {
  ticketId: string;                   // ULID
  tier: Tier;
  hash12: string;                     // binds the ticket to the model bytes
  partCount: number;
  features: { interactive: boolean; commercial: boolean; watermark: boolean; maxParts: number };
  issuedAt: string; expiresAt: string;
  signature: string;                  // Ed25519 over the canonical JSON above (worker/api/tickets.ts)
}

export interface ScreenResult {
  verdict: 'clear' | 'review' | 'blocked';
  nearest: Array<{ setNum: string; similarity: number }>; // MinHash Jaccard estimate, top 3
  exactHash: boolean;                 // hash12 equals a file in lego-models-index.json
  thresholds: { review: number; block: number };          // calibrated in WP B06
}

export interface ValidationReport {
  schema: 1;
  model: { file: string; hash12: string; parts: number; format: ImportedModel['format'] };
  pack: { bytes: number; sha256: string; namespace: string; entities: number; cuboids: number };
  structure: PackCheckFinding[];      // pack-check.ts: the _mcaddon_check.py rules + Marketplace rules
  features: {                         // what became playable, and what was found but not built (with why)
    doors: number; seats: number; vehicles: Array<{ kind: string; label: string }>;
    coasters: number; slides: number; lifts: number; figures: number;
    missed: Array<{ what: string; reason: string }>;
  };
  sim: { scenarios: number; pass: number; fail: number; unknown: number; violations: string[] }; // child-play
  parts: { official: number; unofficial: number; studioOnly: string[]; custom: string[]; substituted: number };
  screen: ScreenResult;
  entitlement: Pick<ExportEntitlement, 'ticketId' | 'tier'> | null;
  caveats: string[];                  // device-only facts the sim cannot prove (rendering, culling, form text)
  disclaimer: string;                 // the Mojang disclaimer, verbatim
}

/** Mesh -> bricks: one stud-lattice cell is 20 x 8 x 20 LDU (a 1x1 plate). */
export interface LatticeModel {
  dims: { x: number; y: number; z: number };   // cells
  occ: Uint8Array;                    // 1 = filled
  colour: Uint16Array;                // LDraw colour code per cell (palette-snapped)
  source: { meshUnitsPerLdu: number; mode: 'solid' | 'surface' };
}
export interface LegolizeStats { cells: number; bricks: number; plates: number; slopes: number; components: number; largestComponentShare: number }

export interface PhotoJob {
  id: string; owner: string; status: 'queued' | 'claimed' | 'meshing' | 'done' | 'failed';
  views: Array<{ name: 'front' | 'left' | 'back' | 'right' | 'extra'; r2Key: string }>;
  model: 'pixal3d-multiview' | 'pixal3d-single' | 'trellis2-single';
  resultGlbKey?: string; error?: string; seconds?: number;
}
```

D1 schema (`worker/migrations/0001_byom.sql`). Every table carries `created_at`; money is in cents.
| Table | Columns |
|---|---|
| `users` | `id`, `email?`, `display_name`, `age_confirmed_13`, `age_confirmed_18`, `deleted_at?` |
| `credentials` | `user_id`, `credential_id`, `public_key`, `counter`, `transports` (WebAuthn) |
| `sessions` | `id` (random 32 B, stored as SHA-256), `user_id`, `expires_at` |
| `plans` | `user_id`, `tier`, `stripe_customer`, `stripe_subscription?`, `period_end?`, `status` |
| `credits` | `user_id`, `balance`, `reason`, `stripe_event_id` (UNIQUE: webhook idempotency) |
| `exports` | `ticket_id`, `user_id?`, `hash12`, `parts`, `tier`, `screen_verdict`, `similarity`, `created_at` |
| `takedowns` | `id`, `claimant`, `contact`, `target` (`hash12`/`showcase id`/`url`), `basis`, `status`, `resolution`, `counter_notice?` |
| `strikes` | `user_id`, `takedown_id` (repeat-infringer policy) |
| `showcase_items` | `id`, `user_id`, `title`, `hash12`, `render_key`, `status` (`pending`/`approved`/`removed`), `screen_verdict` |
| `photo_jobs` | as `PhotoJob` |
| `audit_log` | `actor`, `action`, `target`, `at` |

### 3.4 Flows

**File to add-on, the free path.** All of it runs in the browser except the two marked calls.
1. Create tab → `importModelFile`.
2. Preview in `LDrawViewer`.
3. Tag the components (`ByomHints`).
4. `fingerprint`, then `POST /api/screen` (anonymous allowed, rate-limited) → `ScreenResult`. A `blocked` verdict
   stops; `review` asks for the declaration and records it.
5. `POST /api/exports` → `ExportEntitlement`. Anonymous gets the free tier.
6. `runSchemPipeline({ format: 'mcaddon', byom: { hints, entitlement } })` in the existing Worker.
7. `pack-check` + sim child-play in the sim Worker → `ValidationReport`.
8. Download a zip holding `<name>.mcaddon`, `report.html`, `report.json` and `CREDITS.txt`.

**Paid.** Same flow; step 5 debits a credit or a monthly allowance, and the ticket turns off the watermark and
turns on interactive features above 300 parts.

**Photos.**
1. Upload 1-4 photos → `POST /api/photo-jobs` (signed in, quota) → R2 `byom-jobs/<id>/`.
2. The GPU agent claims the job, runs ComfyUI and uploads the GLB.
3. The browser fetches the GLB, then `legolize`, then the file path from step 2.

**Studio batch.** A zip or folder of models goes into a browser queue (one pipeline Worker at a time, so memory
stays bounded) and comes out as one zip of packs and reports. The optional cloud batch posts the same jobs to
`services/byom-builder` (prepared).

### 3.5 Where the shared Scenario A work sits
B needs, and must NOT re-implement, these items from Plan A's Marketplace fixes (`docs/business-scenarios.md:98-114`):
- a per-pack namespace instead of `craftmatic:`;
- no vanilla `concrete_*` texture override (`lego-resource-pack.ts:362`);
- the RP manifest's `pack_scope: world` and its dependency on the BP;
- placement into air only, with undo;
- no dev stamps in player-facing names;
- Studio-only meshes resolved to LDraw ones;
- the non-minifig figure.

B's work packages name these as dependencies: `A:namespace`, `A:textures`, `A:manifest`, `A:figure`. The Fable
merge must give each ONE owner.

---

## 4. The photo route ("BYOM gen"), staged, with honest expectations

| Stage | In → out | Method | What it can be expected to do |
|---|---|---|---|
| **G0** | photos → masks + framed views | BiRefNet in ComfyUI; framing ported from `pokefit/imageto3d.py:149` `frame_views` (one scale across views, the mask box centred, 1024 px, pad 1.1) | reliable on a plain background; poor on cluttered tables (needs a re-shoot hint) |
| **G1** | views → coloured mesh | Pixal3D multi-view (front/left/back[/right]); 1 photo → Pixal3D single or TRELLIS.2; `RemeshMesh sign_mode "solid"`; vertex colours (`COLOR_0` is linear) | a plausible closed shape; hidden faces are invented; thin parts (antennas, rails, railings < 1 stud) are often lost; interiors absent; ~3.4 min for 3 views on the 16 GB GPU (the user's global notes) |
| **G2** | mesh → stud lattice | `legolize/lattice.ts`: scale Y by 20/8 and voxelise isotropically at 20 LDU (`threeToGridAsync`), solid fill; palette snap | bounded by the stud: a 30 cm build is about 38 studs wide |
| **G3** | lattice → bricks | `legolize/merge.ts`: per-layer greedy cover with the largest standard brick/plate, alternating direction, 3-plate stacks → bricks, connectivity repair (split weak articulations, re-merge) | a buildable-LOOKING, fully connected brick model. NOT the creator's part list |
| **G4** | surface fit | `legolize/surface.ts`: slopes 3040/3039/3665/54200 where the lattice staircase matches a slope normal, tiles on top surfaces, 1x1 rounds on curved columns | improves the silhouette; still not the creator's parts |
| **G5** | features | `legolize/features.ts`: the creator taps where the door/seat/wheels are; real functional LDraw parts are inserted so the existing detectors fire | the only route to playable doors, seats and vehicles from photos |

**What the plan does NOT promise:** recovering the creator's actual parts, colours per part, or interior from
photos. The PDF pipeline, with far more information, reaches 2/90 full poses (section 2.6). Part-exact recovery
from photos is research. It is listed as a stretch idea (section 9, R8) and is not in scope.

**Measurable gates.** Every number is a TARGET to calibrate in WP B16 and then freeze in the test.
- **Synthetic ground truth (WP B16).** Take the corpus LDraw MOCs (section 5A), render 4 views with the sim
  rasteriser at Pixal3D's rig, and run G0-G4. Compare against the source model voxelised on the same lattice.
  Targets:
  - voxel IoU ≥ 0.55 (single photo ≥ 0.40);
  - silhouette IoU ≥ 0.85 per held-out view (a 45° view not given to G1);
  - median CIEDE2000 ≤ 12 against the source's per-cell colour;
  - largest-component share = 1.0 after G3;
  - brick count within 0.5-2x the source's part count.
- **Mesh input, no photos (WP B10/B11).** On clean meshes (corpus 5A STL/OBJ/GLB, and our own exported GLBs of
  LDraw models): voxel IoU against the input mesh ≥ 0.85 at the chosen stud resolution; largest component 1.0.
- **Real photos (WP B17).** There is no ground truth, so use reprojection: render the brick model from each
  input view's camera, then compare the silhouette IoU with that photo's BiRefNet mask, ≥ 0.80. Also a
  human-graded contact sheet (1-5) per photo set, recorded but never used as a gate.
- **Throughput:** one GPU, 3 views, ≤ 300 s p90 per job (measure). Queue honesty: the UI shows the measured p50.

---

## 5. The test corpus: real public files and photo sets

Rules:
- Every item is for LOCAL tests only. The bytes go under `data/byom-corpus/{files,photos}/<id>/` (gitignored at
  `.gitignore:27`) and are never shipped, published or used in a showcase.
- The committed manifest `test/fixtures/byom-corpus.manifest.json` holds only `{id, kind, url, author, licence,
  sha256, fetchedAt, notes}`.
- The fetcher (WP B29) honours robots.txt, paces requests (≥ 2.5 s apart), stops on a 4xx, and downloads one item
  at a time. It never logs in and never accepts terms on the user's behalf.
- Any item whose licence is "not stated" is used only for import and robustness tests, never as a ground-truth
  render in a public document.
- Corpus tests skip themselves when the file is absent. The `existsSync` gate is computed at MODULE load and the
  read happens INSIDE `it` (the bun:test lesson).

The candidates below were found on 2026-11-09 by a research subagent using web search and page fetches. Nothing
was downloaded. Each URL appeared in a search result, an API response or a fetched page. I did not re-open every
URL myself, so WP B29 confirms each at fetch time and records any 404 or login wall as `unresolved`.

**Two gaps the search measured:**
- The LDraw OMR accepts OFFICIAL sets only, so it has no fan-model section. The LDraw rows below come from
  Datsville, GitHub, BrickHub and Eurobricks.
- Thingiverse and Printables mostly host single bricks, so the mesh rows are mainly Sketchfab.

**The "role" column** says what each item tests:
| Role | What it tests |
|---|---|
| `orig` | a clean original design: import → pack → sim |
| `ip` | a MOC of a licensed IP; the terms forbid it, and the fingerprint screen CANNOT see it. Kept as a negative example for the moderation checklist, never exported in a demo |
| `mod` | a modification of an official set; the screen should say `review` |
| `pair` | a model file and real photos of the same build: the only photo ground truth |
| `scan` | a photogrammetry scan of a real build: mesh-path realism |
| `off` | an official LEGO build in the photos: a photo-to-3D input only, never a MOC claim |

### 5A. Model files (41 candidates: 11 LDraw, 13 .io, 6 .lxf, 11 mesh)

| id | Title | Author | URL | Format | Licence as stated | Size | Role |
|---|---|---|---|---|---|---|---|
| F01 | Example Car | James Jessiman | https://github.com/pybricks/ldraw/blob/HEAD/models/car.ldr | .ldr | LDraw library, CC BY 4.0 | ~60 parts | orig |
| F02 | Example Pyramid | James Jessiman | https://github.com/pybricks/ldraw/blob/HEAD/models/pyramid.ldr | .ldr | CC BY 4.0 | 13 parts | orig |
| F03 | Datsville town blocks (`models_source/block_base_001..033.ldr`) | LUGNET community | https://github.com/mjhorvath/Datsville | .ldr/.dat | README: CC BY-SA 4.0 for models (some PD/"beerware") | ~1 GB repo | orig (fetch 3-5 blocks only) |
| F04 | Floppy/MOCs | Floppy | https://github.com/Floppy/MOCs | LDraw | not stated (no repo licence) | 1.9 MB | orig |
| F05 | Corona de Espinas 1:250 | VictorUceda | https://github.com/VictorUceda/corona-de-espinas-lego | LDraw + PDF | repo licence "Other" | 4,937 pieces | orig (large-model stress) |
| F06 | Figure Base with Marker | BrickHub user | https://brickhub.org/i/826 | LDraw | not stated | small | orig |
| F07 | Swingloader Mark Two | Eurobricks thread | https://www.eurobricks.com/forum/forums/topic/85320-moc-swingloader-mark-two/page/4/ | LDraw (Bricksafe link) | not stated | Technic | pair (with P39) |
| F08 | Little Devil (`littled.mpd`) | Eurobricks thread | https://www.eurobricks.com/forum/forums/topic/38677-instructions-for-little-devil/ | .mpd | not stated | Technic | orig |
| F09 | GMK6400 carrier (modified 42009) | gerger | https://www.eurobricks.com/forum/forums/topic/85388-mod-42009-mobile-crane-mods-and-improvements/page/14/ | LDraw | not stated | large Technic | mod |
| F10 | lego-moc-builder generated MOCs | ancientrain | https://github.com/ancientrain/lego-moc-builder | LDraw (whether examples ship: UNVERIFIED) | MIT | — | orig |
| F11 | snapwright (photo/sketch → model) | geastham | https://github.com/geastham/snapwright | LDraw outputs (examples UNVERIFIED) | MIT | — | orig, baseline |
| F12 | Turanic Raiders Missile Corvette (MOC-125115) | EverythingWasTakenSoIamJhon | https://rebrickable.com/mocs/MOC-125115/EverythingWasTakenSoIamJhon/homeworld-turanic-raiders-missile-corvette/ | .io + PDF | CC BY-NC-SA 4.0 (free confirmed on page) | 511 parts | ip |
| F13 | Turanic Raiders Standard Corvette (MOC-125114) | same | https://rebrickable.com/mocs/MOC-125114/EverythingWasTakenSoIamJhon/homeworld-turanic-raiders-standard-corvette/ | .io | CC BY-NC-SA 4.0 (free: not checked) | ? | ip |
| F14 | Taiidan Bomber (MOC-125112) | same | https://rebrickable.com/mocs/MOC-125112/EverythingWasTakenSoIamJhon/homeworld-taiidan-bomber/ | .io | CC BY-NC-SA 4.0 | ? | ip |
| F15 | GDI Bomber (MOC-145846) | same | https://rebrickable.com/mocs/MOC-145846/EverythingWasTakenSoIamJhon/command-conquer-gdi-bomber/ | .io | CC BY-NC-SA 4.0 | ? | ip |
| F16 | Emancipator Exosuit (MOC-184991) | same | https://rebrickable.com/mocs/MOC-184991/EverythingWasTakenSoIamJhon/helldivers-2-emancipator-exosuit/ | .io | CC BY-NC-SA 4.0 | ? | ip |
| F17 | First Order AT-ST | BrickLink user | https://www.bricklink.com/v3/studio/design.page?idModel=130211 | .io | not stated (BrickLink terms; login needed) | 757 parts | ip |
| F18 | Korean Hanok teahouse | BrickLink user | https://www.bricklink.com/v3/studio/design.page?idModel=879535 | .io | not stated | 96 parts | pair (with P38) |
| F19 | Flying Dutchman | BrickLink user | https://www.bricklink.com/v3/studio/design.page?idModel=37501 | .io | not stated | ? | orig (vehicle: ship) |
| F20 | Motorcycle and sidecar | BrickLink user | https://www.bricklink.com/v3/studio/design.page?idModel=717781 | .io | not stated | ? | orig (vehicle: car) |
| F21 | Generic Brickhead template | BrickLink user | https://www.bricklink.com/v3/studio/design.page?idModel=12461 | .io | not stated | small | orig |
| F22 | Lathe | snakebyte (hosted by MyBricks4U) | https://www.mybricks4u.com/uploads/6/7/8/0/6780867/lathe.io | .io | not stated; third-party upload | ? | orig |
| F23 | Rubik's Cube (working) | puzzLEGO (hosted by MyBricks4U) | https://www.mybricks4u.com/uploads/6/7/8/0/6780867/rubiks_cube__working_.io | .io | not stated | ? | ip (puzzle brand) |
| F24 | John Deere | LasseD (hosted by MyBricks4U) | https://www.mybricks4u.com/uploads/6/7/8/0/6780867/john_deere.io | .io | not stated | ? | ip (vehicle brand: the Usage Guidelines' "branded automobiles" case) |
| F25 | Mondriaan Red-Blue-Yellow | MyBricks4U | https://www.mybricks4u.com/uploads/6/7/8/0/6780867/mondriaan.lxf | .lxf | site: own models "can freely be used" | small | orig |
| F26 | Caravan Large | MyBricks4U | https://www.mybricks4u.com/uploads/6/7/8/0/6780867/caravan_large.lxf | .lxf | same | ? | orig (door, vehicle) |
| F27 | Grand Piano | MyBricks4U | https://www.mybricks4u.com/uploads/6/7/8/0/6780867/grand_piano.lxf | .lxf | same | ? | orig (hinged lid) |
| F28 | Old Style Pick-up | MyBricks4U | https://www.mybricks4u.com/uploads/6/7/8/0/6780867/pick_up.lxf | .lxf | same | ? | orig (vehicle) |
| F29 | Esscher | MyBricks4U | https://www.mybricks4u.com/uploads/6/7/8/0/6780867/esscher.lxf | .lxf | same | ? | orig |
| F30 | Old Style Radio | Chris McVeigh (hosted by MyBricks4U) | https://www.mybricks4u.com/uploads/6/7/8/0/6780867/radio.lxf | .lxf | not stated; third-party | small | orig |
| F31 | MOC Rock Crawler | zumaidi | https://sketchfab.com/3d-models/e7071116498c403dbd8cf53d84dd08e4 | glb | CC BY 4.0 (download needs a login) | 1.21M faces | orig (mesh) |
| F32 | MOC WALL-E | zumaidi | https://sketchfab.com/3d-models/3d972cc147d549a7a72a207911df660b | glb | CC BY 4.0 | 571k faces | ip (film character) |
| F33 | MOC The Bench | zumaidi | https://sketchfab.com/3d-models/b4e0005a8a234c408a82d5027cf31c0e | glb | CC BY 4.0 | 227k faces | orig (seat) |
| F34 | MOC M3 Half Track | zumaidi | https://sketchfab.com/3d-models/7e5f96f7ea2a428d9d6afe6d59584e00 | glb | CC BY 4.0 | 3.0M faces | orig (vehicle; decimation stress) |
| F35 | MOC Blackwing Starfighter | raenfox | https://sketchfab.com/3d-models/b3f18cc3bc374020b00278e2dec20381 | glb | CC BY 4.0 | 4.1M faces | orig (flyer; size stress) |
| F36 | MOC High Speed Racing Mech | Dominik | https://sketchfab.com/3d-models/95c8a99e99eb4e669bbacca7948acab5 | glb | CC BY 4.0 | 936k faces | orig |
| F37 | Medieval Tower (MOC) | Awesome | https://sketchfab.com/3d-models/5ac7eec0da274747b9d2316cb71fcbcf | glb | CC BY 4.0 | 984k faces | orig (door tagging) |
| F38 | Tan Van MOC | WAI | https://sketchfab.com/3d-models/4a6fcc164730425ead7ca164f7ad1c68 | glb | CC BY 4.0 | 1.56M faces | orig (vehicle) |
| F39 | City Park MOC #0069 | The Bobby Brix Channel | https://sketchfab.com/3d-models/lego-city-park-moc-0069-9df0ddcc59af42c98e69a6775d64bfab | glb | CC BY (a sibling page says "Do not distribute") | ? | orig (import only; licence conflict) |
| F40 | Blue Bionicle scan (photogrammetry) | Seth Berrier | https://sketchfab.com/3d-models/9e743126714247b58ea96c1d7ab903d1 | glb, 8K textures | CC BY 4.0 | 543k faces | scan, off |
| F41 | Mix of bricks with constructions (scan) | archiwum_xyz | https://sketchfab.com/3d-models/cb695100286343f297d6fd6ca83d9893 | glb | CC BY-NC 4.0 | 100k faces | scan |

Also from the same search, to add if needed: Sketchfab CC BY "Truck Chassis", "Bridge", "Roller Coaster" (a
coaster MOC mesh, useful for B13 track hints) and "Train". The listing gave these by title and id prefix only, so
B29 resolves the full URLs. Two were excluded:
- PrintableBricks (`thingiverse.com/thing:4787193`): single parts, not a MOC.
- Mecabricks "Free models for MOCs": no licence stated, and the export is editor-only.

**STL/3MF gap.** None of the 41 is a 3D-printable brick BUILD in STL. B09's STL/3MF/PLY tests therefore use
fixtures built in the test, plus F31-F38 converted to STL locally by our own exporter (`src/pipeline/export/`
writes GLB; add an STL writer in B09's test helpers only).

### 5B. Photo sets of real builds (41 candidates)

| id | Title | URL | Images | Licence | Multi-view | Role |
|---|---|---|---|---|---|---|
| P01 | Crankshaft from Lego | https://commons.wikimedia.org/wiki/Category:Crankshaft_from_Lego | 82 | CC BY-SA 3.0 (60 checked) | yes, one build | orig |
| P02 | Falkirk Wheel gears replica | https://commons.wikimedia.org/wiki/Category:Lego_Falkirk_Wheel_Gears_Replica | 19 | public domain | yes | orig |
| P03 | Bag End diorama, Adam Purves 2014 | https://commons.wikimedia.org/wiki/Category:Bag_End_hobbit_house_Lego_diorama,_by_Adam_Purves,_2014 | 9 | CC BY 2.0 (8), CC0 (1) | yes | ip |
| P04 | Dinotopia diorama, Bricks Cascade 2018 | https://commons.wikimedia.org/wiki/Category:Dinotopia_Lego_diorama_at_Bricks_Cascade_2018 | 10 | CC BY 2.0 | yes | ip |
| P05 | The Hobbit diorama, Bricks Cascade 2017 | https://commons.wikimedia.org/wiki/Category:Lego_diorama_of_The_Hobbit_-_Bricks_Cascade_2017 | 11 | CC BY 2.0 | yes | ip |
| P06 | Trojan War diorama, BrickCon 2012 | https://commons.wikimedia.org/wiki/Category:Trojan_War_diorama_-_BrickCon_2012 | 10 | CC BY 2.0 | yes | orig |
| P07 | Poseidon, Guardian of Atlantis, BrickCon 2012 | https://commons.wikimedia.org/wiki/Category:Poseidon,_Guardian_of_Atlantis_Lego_diorama_at_BrickCon_2012 | 5 | CC BY 2.0 | yes | orig |
| P08 | Last March of the Ents, BrickCon 2011 | https://commons.wikimedia.org/wiki/Category:The_Last_March_of_the_Ents_Lego_diorama_-_BrickCon_2011 | 5 | CC BY-SA 2.0 | yes | ip |
| P09 | Helm's Deep, Timothy Shortell, 2017 | https://commons.wikimedia.org/wiki/Category:Battle_of_Helm's_Deep_Lego_diorama_by_Timothy_Shortell_-_Bricks_Cascade_2017 | 5 | CC BY 2.0 | yes | ip |
| P10 | Laketown, Cole Blood and Timothy Shortell | https://commons.wikimedia.org/wiki/Category:Laketown_Lego_diorama_by_Cole_Blood_and_Timothy_Shortell | 3 | CC BY 2.0 | partial | ip |
| P11 | Small Middle-earth scene, Jeff Johnson | https://commons.wikimedia.org/wiki/Category:Small_Middle-Earth_scene_(The_Hobbit),_Lego_diorama,_by_Jeff_Johnson | 3 | CC BY 2.0 | partial | ip |
| P12 | Tatooine diorama, Skærbæk 2024 | https://commons.wikimedia.org/wiki/Category:Lego_Star_Wars_Tatooine_diorama_-_Skærbæk_Fan_Weekend_2024 | 7 | CC BY 4.0 | yes | ip |
| P13 | Frankfurt Hauptbahnhof model | https://commons.wikimedia.org/wiki/Category:Frankfurt_Hauptbahnhof_(Lego_model) | 11 | CC BY-SA 3.0 | yes | orig (landmark; also useful to Plan A's part mapper) |
| P14 | Praha hlavní nádraží model | https://commons.wikimedia.org/wiki/Category:Praha_hlavní_nádraží_(Lego_model) | 30 | CC0 / CC BY-SA 3.0 / 4.0 | yes | orig (landmark) |
| P15 | Technic model assembly | https://commons.wikimedia.org/wiki/Category:Lego_Technic_model_assembly | 18 | CC0 (11), CC BY / BY-SA | build stages | orig |
| P16 | Technic MOCs | https://commons.wikimedia.org/wiki/Category:Lego_Technic_MOCs | 36 | CC BY / BY-SA / PD mix | several builds | orig |
| P17 | Models of ships | https://commons.wikimedia.org/wiki/Category:Lego_models_of_ships | 64 | mostly CC BY 2.0 (Bill Ward) | several builds | orig (boats) |
| P18 | Space (BrickCon MOCs) | https://commons.wikimedia.org/wiki/Category:Lego_Space | 42 | CC BY 2.0 / CC0 / BY-SA | several builds | orig (flyers) |
| P19 | Models of automobiles | https://commons.wikimedia.org/wiki/Category:Lego_models_of_automobiles | 54 | CC BY / BY-SA / CC0 mix | several builds | mixed: per-file brand check |
| P20 | Models of Ferrari F1 | https://commons.wikimedia.org/wiki/Category:Lego_models_of_Ferrari_F1 | 12 | CC BY-SA 3.0 / 4.0 | yes | ip (car brand) |
| P21 | Model cars | https://commons.wikimedia.org/wiki/Category:Lego_model_cars | 12 | CC BY-SA mix | partial | mixed |
| P22 | Models of loaders | https://commons.wikimedia.org/wiki/Category:Lego_models_of_loaders | 6 | CC BY / BY-SA | partial | orig |
| P23 | Pompeii model | https://commons.wikimedia.org/wiki/Category:Pompeii_Lego_model | 3 | CC BY-SA 4.0 | partial | orig (landmark) |
| P24 | Llandudno exhibition, Aug 2023 | https://commons.wikimedia.org/wiki/Category:Lego_exhibition_at_St_John's_Methodist_Church,_Llandudno,_August_2023 | 14 | CC BY-SA 4.0 | several builds | mixed |
| P25 | Life-size Technic Bugatti Chiron | https://commons.wikimedia.org/wiki/Category:Life-size_Lego_Technic_Bugatti_Chiron | 33 | CC BY-SA 4.0 | yes, ~360° | off + ip (best multi-view input) |
| P26 | Elizabeth Tower, store build London | https://commons.wikimedia.org/wiki/Category:Lego_model_of_Elizabeth_Tower_in_Lego_store_(London) | 14 | CC BY-SA 4.0 / CC BY 2.0 | yes | off |
| P27 | Life-size Renault R.S.17 | https://commons.wikimedia.org/wiki/Category:Life-size_Lego_Renault_R.S.17 | 9 | per file, not checked | yes | off + ip |
| P28 | Models of Cologne Cathedral | https://commons.wikimedia.org/wiki/Category:Lego_models_of_Cologne_Cathedral | 12 | per file, not checked | yes | mixed (landmark) |
| P29 | Gothia Towers model | https://commons.wikimedia.org/wiki/Category:Lego_model_of_Gothia_Towers | 13 | not checked (API rate limit) | yes | mixed |
| P30 | Alberta Legislature model | https://commons.wikimedia.org/wiki/Category:Lego_model_of_Alberta_Legislature_building | 5 | not checked | partial | mixed |
| P31 | Piece of Peace, Tokyo 2008 | https://commons.wikimedia.org/wiki/Category:Piece_of_Peace_Lego_exhibition_Tokyo_2008 | 9 | not checked | several builds | mixed (landmarks) |
| P32 | Bill Ward photostream (convention MOCs) | https://www.flickr.com/photos/billward/8061807778/ | hundreds | CC BY 2.0 (read on the photo page) | many builds, several angles | orig |
| P33 | Pascal (pasukaru76) photostream | https://www.flickr.com/photos/pasukaru76/5666246358/ | hundreds | CC0 (Flickr licence code 9) | often | orig |
| P34 | wiredforsound23 photostream | https://www.flickr.com/photos/wiredforsound23/6207682525/ | many | CC BY-SA 2.0 | yes | orig |
| P35 | legozilla photostream | https://www.flickr.com/photos/legozilla/200280990/ | many | CC BY 2.0 | partial | orig |
| P36 | Adam Purves (S3ISOR) photostream | https://www.flickr.com/photos/59263516@N08/15793078362/ | many | CC BY 2.0 | yes | mixed |
| P37 | Ryan McNaught "Wonders of the World" album | https://www.flickr.com/photos/ryanmcnaught/albums/72157673365575463/ | dozens | UNVERIFIED | partial | mixed (landmarks) |
| P38 | Eurobricks: Korean Hanok teahouse (96 pcs) | https://www.eurobricks.com/forum/forums/topic/214361-my-first-hands-on-moc-creation-on-bricklink-studio-traditional-korean-teahouse-96-pieces/ | few | not stated | few | pair (with F18) |
| P39 | Eurobricks: Swingloader Mark Two | https://www.eurobricks.com/forum/forums/topic/85320-moc-swingloader-mark-two/page/4/ | several | not stated | yes | pair (with F07) |
| P40 | MobileBrick (CVPR 2023) | https://github.com/ActiveVisionLab/MobileBrick | 153 sequences (135 random shapes + 18 curated) | code MIT; dataset licence not stated | posed RGB-D + masks + **ground-truth meshes** | the best measured photo→shape benchmark |
| P41 | Mip-NeRF 360 "kitchen" (a real brick bulldozer) | https://jonbarron.info/mipnerf360/ | ~279 (from memory, not checked) | not stated on the page | 360° posed | off (an official set) |

**Photo ground truth, ranked by strength:**
1. **MobileBrick (P40)** has ground-truth meshes for real brick builds. WP B17 computes true 3D IoU on it, not just
   reprojection. This is the strongest real-photo gate available. Its dataset licence must be read first: local
   research use only until then.
2. The two Eurobricks pairs (F07+P39, F18+P38) have a model file and photos of the same build, but no stated
   licence. Local only.
3. Everything else is reprojection-only (section 4).

### 5C. Research datasets and baselines (local benchmarking only)
| Dataset | URL | Licence | Contents and use |
|---|---|---|---|
| BrickGPT / StableText2Brick (CMU, ICCV 2025) | https://github.com/AvaLovelace1/BrickGPT, https://huggingface.co/datasets/AvaLovelace/StableText2Brick | MIT; its bundled ImportLDraw and FlashTex keep their own licences | 47k brick structures from 28k objects, 24 rendered views each: a mesh→bricks benchmark for B11/B12 and a stability baseline |
| StableLego | https://github.com/intelligent-control-lab/StableLego | MIT | 50k+ layouts with stability labels: a test oracle for B11's stability repair |
| LEGO-Puzzles | https://huggingface.co/datasets/KexianTang/LEGO-Puzzles | none on the card | not used |
| Image2Lego | https://arxiv.org/abs/2108.08477 | paper only | method reference |
| Photos and renders of single bricks (Scientific Data 2023) | https://www.nature.com/articles/s41597-023-02682-2 | CC BY 4.0, per ResearchGate, to confirm | not needed for v1 (single parts) |
| B200C | https://www.kaggle.com/datasets/ronanpickell/b200c-lego-classification-dataset | CC BY-SA 4.0 | not needed for v1 (single parts) |
| awesome-lego-machine-learning | https://github.com/360er0/awesome-lego-machine-learning | — | index of Legolization, Break and Make, Brick-by-Brick, LEGO-manual work |
| sets_lego_omr_full | https://huggingface.co/datasets/DylanRiden/sets_lego_omr_full | — | official sets only: positive examples for B06's screen calibration (we already hold these sources in the index) |

**Licence caveats, binding on B29:**
- **Rebrickable:** the designer picks the licence. CC BY-NC-SA 4.0 is common, so non-commercial and share-alike:
  local tests only.
- **BrickLink Studio Gallery:** no licence on designs, and downloads need a login. The fetcher does not log in, so
  F17-F21 are fetched by the user by hand, or not at all.
- **MyBricks4U:** only the owner's own designs are "freely usable". The third-party uploads there (F22-F24, F30)
  have no stated consent: import tests only.
- **Sketchfab:** downloads need a signed-in account (by hand, by the user), and the credit must be exactly as
  given. F39 conflicts with itself: import test only.
- **Flickr and Commons:** licences are per photo and can change. Record the licence and credit per file at fetch
  time. ShareAlike applies to derivatives, and we make none public.
- **Official builds** (P25-P27, P41, F40): photo-to-3D inputs only; never presented as MOCs.

---

## 6. Product layer

### 6.1 Accounts (WP B19)
- **Passkeys first** (WebAuthn, `@simplewebauthn/server` in the Worker, `@simplewebauthn/browser` in the UI). They
  need no third-party account, so they can be built and tested end to end now.
- Email magic link is an adapter behind `EmailSender`. Its provider (Cloudflare Email Service or Resend) is an
  outward sign-up, so it is "awaiting approval".
- OAuth providers (Google, Discord, GitHub) need app registrations: outward, deferred.
- Session: an opaque random token in an `HttpOnly; Secure; SameSite=Lax` cookie on `craftmatic.click`. The API is
  same-origin through a new Worker route `craftmatic.click/api/*`. The DB stores only the token's SHA-256.
- Age:
  - 13+ to create an account (COPPA; Minecraft's audience includes children);
  - 18+ to pay, or a parent pays;
  - anonymous use of the free tier needs no account.
- GDPR/CCPA: export-my-data and delete-my-account endpoints. Model bytes are never stored on the free path.

### 6.2 Tiers and quotas (WP B20). The prices are the research's estimates (`docs/business-scenarios.md:130-137`)
| Tier | Price | Allowance | Features |
|---|---|---|---|
| Free | $0 | unlimited static block export; add-on export up to **300 parts** | personal use, **watermark**, interactive features on, report without signature |
| Per model | **$4.99** a credit (**$9.99** above 2,000 parts) | 1 export of one `hash12`. Re-exports of the same `hash12` within 30 days are free (options change; the model does not) | no watermark, signed report, commercial-use terms |
| Creator | **$8 a month / $72 a year** | **20 exports a month** (a distinct `hash12` counts once a month) | as per model, plus photo jobs (5 a month, *proposed*) |
| Studio | **$49 a month** (the $500-2,000 per-title licence is a manual invoice, out of scope) | fair use, 200 a month (*proposed*) | batch export, cloud build (when approved), priority photo queue, support email |

The tier rules live in ONE table, `worker/api/entitlements.ts` `TIER_RULES`, which the UI imports for display.
The test `test/byom-entitlements.test.ts` pins every boundary: 300/301 parts, 2,000/2,001, the 20th/21st export,
same-hash re-export.

### 6.3 Watermark, free tier (WP B08)
Visible but not destructive:
1. Pack display names carry the suffix " · made with craftmatic.click (free)".
2. The wand places one small "Made with craftmatic.click" sign entity at the model's corner. Undo removes it with
   the model.
3. `craftmatic-provenance.json` carries `tier: "free"`.
4. The report is marked unsigned.

There is no texture overlay on the model: that would spoil the creator's own design, and a determined user can
strip any watermark from MIT code anyway (section 1).

### 6.4 Payments: Stripe in TEST mode only (WP B21)
- **Checkout Sessions:**
  - one-time prices: credit $4.99, large credit $9.99;
  - subscriptions: Creator $8 a month, Creator $72 a year, Studio $49 a month.
- **Customer Portal** for cancel and change.
- **Webhooks** at `/api/stripe/webhook`:
  - events: `checkout.session.completed`, `customer.subscription.created|updated|deleted`, `invoice.paid`,
    `invoice.payment_failed`;
  - verified with `stripe.webhooks.constructEventAsync` and the Workers fetch HTTP client;
  - idempotent on `event.id`, through `credits.stripe_event_id UNIQUE`.
- **A guard in code:** `stripe.ts` refuses any key that is not `sk_test_`/`rk_test_`, unless both
  `LIVE_PAYMENTS_APPROVED=1` AND a `wrangler.toml` var name the approval date. A test pins the refusal.
- Products and prices are created by a script, `scripts/byom-stripe-seed.ts`, against the TEST account only. The
  user creates the Stripe account and pastes a test key into `.dev.vars` (gitignored, since `.env.*` and
  `.dev.vars` must both be ignored; WP B18 adds `.dev.vars` to `.gitignore`).
- **Tax and merchant of record are open (Q5).** Stripe direct needs Stripe Tax registrations; Paddle or Lemon
  Squeezy act as merchant of record. `stripe.ts` sits behind a `PaymentProvider` interface, so a merchant of
  record can replace it.

### 6.5 Terms, privacy and takedown (WP B22). All are DRAFTS marked "pending legal review"
- **Terms:**
  - you may upload only models you designed or have rights to;
  - no official LEGO sets, no part-for-part copies, no licensed IP (named examples: film, game and vehicle
    brands), no LEGO marks in pack names;
  - you own your output; we claim no rights in your model;
  - Minecraft and Mojang usage rules apply to your distribution of the output;
  - selling an output is your business and goes through the Marketplace's own rules;
  - the repeat-infringer termination policy.
- **The upload declaration:** a checkbox recorded per export in `exports` beside the screen verdict.
- **The takedown process:**
  1. A public form, `takedown.html` → `/api/takedown`: claimant, contact, the work, the infringing target (a
     showcase link, a `hash12` or a pack name), a good-faith statement, a signature.
  2. Acknowledgement within 2 business days.
  3. Remove or disable the showcase item and block that `hash12` from new exports.
  4. Notify the user; counter-notice path; a strike on the user.
  5. Terminate at 3 strikes.
  6. Every step goes in `audit_log`.
  7. The admin acts through `bun scripts/byom-admin.ts takedown ...` (an authenticated admin API key). There is
     no admin web UI in v1.
- **Outward:** registering a DMCA designated agent with the US Copyright Office is the user's step (awaiting
  approval).

### 6.6 The Mojang disclaimer and credits, in every output (WP B04)
- The verbatim text, from the Usage Guidelines as quoted in `output/business-1106/3-pricing-gtm.md:160`: "NOT AN
  OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT."
- It goes in:
  - both manifests' `description`;
  - `DISCLAIMER.txt` at both pack roots;
  - the report;
  - the Create tab footer.
- `CREDITS.txt` lists the LDraw parts library (CC BY 4.0 / 2.0) and every `.dat` used, with its `0 Author:` line,
  plus the creator's own credit.
- Product naming follows the Usage Guidelines: "Minecraft" never leads a product name; "craftmatic" leads.

### 6.7 Batch export for studios (WP B24, WP B28)
- **In the browser:** a queue over a dropped zip or folder, one model at a time through the existing pipeline
  Worker. Output: one zip with `<stem>.mcaddon` + `<stem>.report.html` per model and a `batch-summary.json`.
  Resumable: finished outputs are kept in IndexedDB until downloaded.
- **CLI for studios who self-host:** `bun scripts/byom-batch.ts <dir> --out=<dir>`. It wraps `runSchemPipeline`
  like `_playable_ref.ts`, adds `.lxf` (thanks to `xml.ts`) and the BYOM hints file `<stem>.byom.json`.
- **Cloud build (prepared):** `services/byom-builder/`, a Bun container that takes a job from the queue, runs the
  same CLI, and writes the zip to R2.
  - Size it by measured memory first (the lesson: size a pool by per-worker memory).
  - Its deployment (Cloudflare Containers, or Railway, which already hosts the ws bridge per `wrangler.toml`
    `MINECRAFT_WS_ORIGIN`) is the user's decision (Q6).

### 6.8 Showcase, original models only (WP B23)
- Seeded with Plan A's original designs; nothing else exists to show until creators submit.
- A submission requires:
  - a signed-in creator;
  - a `clear` screen verdict;
  - the declaration;
  - moderation (`status: pending`, then an admin approves).
- The gallery shows the viewer render and the creator's name. It never mentions LEGO, a set number or a
  licensed theme; the moderation checklist rejects those.
- **Marketing that shows a LEGO set "brings the risk back"** (`docs/business-scenarios.md:142-144`). A test
  rejects any showcase item whose title matches the LEGO, theme and set-number pattern table.

### 6.9 Mobile-friendly dark UI (WP B26-B28)
- A new nav tab, **Create** (`data-tab="create"`, `?tab=create` deep link). It is not "LEGO".
- It reuses the `style.css:3-31` tokens and adds nothing outside a `.byom-*` namespace.
- Layout: one column under 720 px and a two-pane viewer + panel above it; full viewport (`100dvh`); touch
  targets ≥ 44 px.
- Tagging works by touch: tap a part to select its sub-model or connected group; long-press for a box select.
- Use `style.display`, never `hidden` alone, on flex rows (CLAUDE.md gotcha).
- **Visual QA:** Playwright with Node (CLAUDE.md: not Bun) at 393x852, 768x1024 and 1440x900, with
  `serviceWorkers: 'block'` (the memory note); screenshots under 2000 px; the walkthrough also covers the
  flow's error states.

---

## 7. Work packages

Every package follows the binding process rules (`brief-common.md`):
- a worktree `.worktrees/biz-b<NN>-<slug>` on branch `biz/b<NN>-<slug>`;
- fail-first TDD with vitest (`bunx vitest run <file>`; the full gate is `bun run test` + `bun run typecheck` +
  `bun run typecheck:web`);
- the commit cites the BIZ id and ends with "— Opus 5.5";
- merge, never rebase; no recursive deletes; no phones.

"First failing test" is `test/<file>.test.ts :: <name>`.

### Track E: engine and conversion

**B01: one model-import service** (BIZ-30)
- **Goal:** `importModelFile(bytes, name): Promise<ImportedModel>` for `.ldr`, `.mpd`, `.io`, `.lxf`, `.lxfml` and
  `.zip` (the first model inside), with no DOM and no module globals.
  - `lego.ts` `parseMpdFile` and `loadIndexedModelBody` both call it; their behaviour is unchanged.
  - LXFML is read through `byom/xml.ts`, a small DOM-free XML tokenizer that `lxf-parser.ts` takes by injection,
    so LXF parses in vitest and Bun.
- **Files:**
  - NEW: `web/src/engine/byom/import.ts`, `xml.ts`;
  - EDIT: `web/src/engine/lxf-parser.ts` (`:1232-1236`), `web/src/ui/lego.ts` (`:1773-1880`, `:2325-2405`).
- **First failing test:** `test/byom-import.test.ts :: parses a bare .lxfml without DOMParser`. Then
  `:: .io keeps CustomParts and the Studio colour space`, `:: mpd sub-models listed with brick indices` and
  `:: warnings returned, not written to a global`.
- **Acceptance:**
  - all formats import in vitest;
  - for 5 corpus files, the `lego.ts` paths render the same brick count as before (a fixture parity test);
  - `bun run test` is green.
- **Depends on:** none.

**B02: BYOM mode, so no set-number behaviour** (BIZ-31)
- **Goal:** `SchemWorkerInput.byom?: { hints: ByomHints; entitlement: ExportEntitlement | null }`. When present:
  - `canonFor` is skipped;
  - the `isTimeMachine` and Batcave regexes are skipped;
  - `playable-components.ts:107` is skipped;
  - `isWholeVehicleLabel` is skipped;
  - the hints' components replace the title-derived kinds.

  It is one predicate, `labelHeuristicsAllowed(input)`, used at every site, so a new site cannot forget it.
- **Files:** `schem-pipeline.ts`, `playable-addon.ts` (`:2589`, `:2596-2601`), `playable-components.ts:107`,
  `set-canon.ts`.
- **First failing test:** `test/byom-mode.test.ts :: a BYOM model titled "10300 Time Machine" ships no time
  circuits`. Then `:: a BYOM title with a vehicle word stays static without a hint`.
- **Acceptance:** a grep test lists every label-regex site and asserts each is guarded.
- **Depends on:** B01 (the types).
- **Collides with:** B04, B08 and A:namespace on `playable-addon.ts`. Run it before them.

**B03: creator hints applied** (BIZ-31)
- **Goal:** `byom/hints.ts`, which:
  - validates `ByomHints` (namespace pattern, component selectors that resolve to at least one brick);
  - turns them into `PlayableGridComponent[]` and an explicit `vehicleMode`/`facing`/`seatCount` per component;
  - applies them as `<stem>.byom.json` beside a file for the CLI.
- **Files:** NEW `web/src/engine/byom/hints.ts`; EDIT `schem-pipeline.ts` (the component assembly only).
- **First failing test:** `test/byom-hints.test.ts :: the sub-model "Speeder" hinted plane ships as a scripted
  flyer`. Then `:: an unresolved selector is an error naming it`.
- **Acceptance:** a hinted car in a scene MOC drives in `sim.ts --scenario=vehicles`.
- **Depends on:** B02.

**B04: brand-neutral output, disclaimer, credits** (BIZ-35)
- **Goal:** for BYOM packs:
  - player-facing strings neutral: "brick" for "LEGO", "figure" for "minifig", "model" for "set";
  - the Mojang disclaimer in both manifests, `DISCLAIMER.txt` and the README;
  - `CREDITS.txt` with LDraw CC BY and every `.dat` author.

  One string table, `bedrock-player-text.ts`, so A and D reuse it.
- **Files:** NEW `web/src/engine/bedrock-player-text.ts`; EDIT `playable-addon.ts` (README `:4099`, manifests
  `:2624-2626`), `lego-resource-pack.ts`, `bedrock-placement-pack.ts`, `mcpack.ts`.
- **First failing test:** `test/byom-output-text.test.ts :: a BYOM pack's player-facing text never says LEGO or
  minifig`. Then `:: every BYOM pack carries the Mojang disclaimer verbatim` and `:: CREDITS lists the author of
  every .dat the pack used`.
- **Acceptance:** `_mcaddon_check.py` still passes; the existing favourite-pack tests are unchanged (the LEGO tab
  path keeps its current text until Plan A decides).
- **Depends on:** B02; shared with A:namespace (merge order set by the Fable plan).

**B05: part provenance and the Studio-only screen** (BIZ-36)
- **Goal:** the geometry resolver records each `.dat`'s origin: official, unofficial, `studio-only` (present only
  in the Studio snapshot or `UnOfficial/` of Studio), `custom` (`.io` CustomParts) or `substituted` (an alias).
  - The report lists them.
  - A commercial-tier export refuses `studio-only` meshes unless an LDraw alias exists (the user's lawyer decides
    `custom`: Q2).
  - A list of official-library part names, generated from `complete.zip` and `ldrawunf.zip` (the
    `sync-ldraw-r2.mjs` sources), is committed as a compact sorted file.
- **Files:** EDIT `web/src/engine/ldraw-geometry.ts` (resolver hook); NEW `web/src/engine/byom/part-provenance.ts`,
  `scripts/gen-ldraw-official-list.ts`, `web/src/engine/ldraw-official-parts.generated.ts`.
- **First failing test:** `test/byom-part-provenance.test.ts :: a part present only in Studio's UnOfficial tree is
  studio-only`. Then `:: the commercial tier refuses a studio-only mesh with no alias`.
- **Acceptance:** run on 10 corpus `.io` files and record the counts in the tracker.
- **Depends on:** none; touches `ldraw-geometry.ts` only.

**B06: the official-set screen** (BIZ-37)
- **Goal:** `byom/fingerprint.ts`. A 128-hash MinHash over the multiset of `partStem|colour` tokens (each token
  repeated by its count, then capped), plus `hash12`.
  - A build script makes `official-fingerprints.bin` from `C:/git/clego/rebrickable_tables/inventory_parts.csv.gz`
    + `inventories.csv.gz` (measured present) and the index hashes in `web/public/lego-models-index.json`
    (`sets` → `models[].hash`).
  - The binary is uploaded to R2 (`screen/official-fingerprints-<date>.bin`, an outward-free internal upload, but
    to prod R2: awaiting approval) and lazy-loaded by the Worker's `/api/screen` and by the browser for offline
    use.
- **Calibration:** run every corpus MOC (section 5A) and 500 official set sources from the index.
  - Pick `review` and `block` thresholds with ≤ 1 % false `block` on MOCs and ≥ 95 % `review`-or-`block` on
    official sources (targets).
  - Report counts per DISTINCT set (the concentration lesson).
- **Files:** NEW `web/src/engine/byom/fingerprint.ts`, `scripts/build-official-fingerprints.ts`,
  `worker/api/screen.ts`.
- **First failing test:** `test/byom-fingerprint.test.ts :: an official set's own LDraw file is blocked`. Then
  `:: a part-shuffled copy (positions changed, same inventory) is still blocked` and `:: a corpus MOC is clear`.
- **Acceptance:** the calibration table goes in the tracker; the thresholds are pinned in a test.
- **Depends on:** none. The Rebrickable licence check is Q4.

**B07: the validation report** (BIZ-38)
- **Goal:**
  - `byom/pack-check.ts`, a TS port of `scripts/_mcaddon_check.py`, every rule, plus Marketplace-readiness rules:
    namespace pattern, total size ≤ 25 MB, no vanilla texture override, `pack_scope`, the dependency, no dev stamp
    in names;
  - `byom/report.ts`, which assembles `ValidationReport` from pack-check, `McpackSummary` (seat census, access,
    mounts), sim child-play (`addon-sim-worker.ts` session, headless) and B05/B06, and renders a self-contained
    dark `report.html`.
- **Files:** NEW `web/src/engine/byom/pack-check.ts`, `report.ts`; EDIT none of the sim.
- **First failing test:** `test/byom-pack-check.test.ts :: pack-check agrees with _mcaddon_check.py on three built
  packs` (it spawns Python on the same packs and compares the findings). Then
  `test/byom-report.test.ts :: the report lists a door found but not hung, with its reason`.
- **Acceptance:** parity on the 40 favourites' packs in `output/favsweep-4da29033/` (a local-only test, gated on
  existence at module load).
- **Depends on:** B05 and B06 for their sections (stubs allowed only as typed `null` with a TODO, never invented
  numbers).

**B08: entitlement in the pack (watermark and ticket)** (BIZ-40)
- **Goal:** `buildPlayableAddon` takes `entitlement`.
  - Free: the name suffix, the sign entity in the placement (removed by undo), and `tier: free` in provenance.
  - Paid: `ticketId` + `tier` in provenance; the report verifies the signature with the public key bundled in
    `entitlement.ts`.
  - Above 300 parts, the free tier still exports (the research's tier says "add-ons up to ~300 parts"); Q8 asks
    the user whether "free above 300" means static blocks only.
- **Files:** `playable-addon.ts`, `bedrock-placement-pack.ts`, NEW `web/src/engine/byom/entitlement.ts`.
- **First failing test:** `test/byom-watermark.test.ts :: a free pack names itself "made with craftmatic.click
  (free)" and places one sign`. Then `:: undo removes the sign` (sim) and `:: a forged ticket fails verification`.
- **Depends on:** B02, B20 (ticket format; the test uses a fixture key pair).

**B09: more mesh formats** (BIZ-32)
- **Goal:** STL (binary and ASCII), 3MF, PLY, and GLB with Draco/meshopt (vendored decoders, lazy). Units
  heuristics: STL/3MF are usually mm; 1 stud = 8 mm = 20 LDU, so mm × 2.5 = LDU. The UI offers a "real size" or
  "fit to N studs" override.
- **Files:** `web/src/engine/mesh-import.ts`, `web/src/ui/upload.ts:14-17`.
- **First failing test:** `test/mesh-import-formats.test.ts :: a binary STL cube 16 mm across reports 40 LDU`.
  Fixtures are built in the test (Hard-won lesson: build test meshes as raw triangles, never via `creation.box`
  equivalents that round-trip as primitives).
- **Depends on:** none.

**B10: legolize stage 1, the stud lattice and palette** (BIZ-33)
- **Goal:** `legolize/lattice.ts` and `palette.ts`:
  - mesh → `LatticeModel` at 20×8×20 LDU, solid or surface mode as `mesh-to-grid.ts:59-66` chooses;
  - colours sampled with `texture-sampler.ts` / vertex colours (linear→sRGB);
  - snap to a buildable LDraw palette (CIEDE2000; the default palette is the 40 most common solid colours, from
    Rebrickable `elements.csv` counts).
- **Files:** NEW `web/src/engine/legolize/lattice.ts`, `palette.ts`.
- **First failing test:** `test/legolize-lattice.test.ts :: a 40x24x40 LDU box fills exactly 2x3x2 plate cells`.
  Then `:: a vertex-coloured red mesh snaps to LDraw 4`.
- **Acceptance:** voxel IoU vs input ≥ 0.85 on 5 clean corpus meshes (target).
- **Depends on:** B09 for the formats (not for its tests).

**B11: legolize stage 2, merge to bricks, plus the LDraw writer** (BIZ-33)
- **Goal:** `legolize/merge.ts`:
  - a per-layer greedy cover with standard parts (bricks 3001/3002/3003/3004/3005/3008/3009/3010; plates
    3020/3021/3022/3023/3024/3710/3666/3460/3034/3832);
  - alternating long-axis direction per layer;
  - 3 matching plate layers → a brick;
  - connectivity via stud contact (the clego geograde notion);
  - repair: split a seam-aligned brick, re-cover.

  `byom/ldraw-writer.ts` writes `.ldr` that `parseLDraw` reads back identically. The creator can also download it
  and open it in Studio or LDCad.
- **Files:** NEW `web/src/engine/legolize/merge.ts`, `web/src/engine/byom/ldraw-writer.ts`.
- **First failing tests:**
  - `test/legolize-merge.test.ts :: a solid 4x4x3-plate block becomes one 2x4-brick-based stack with no full-height
    vertical seam`;
  - `:: every brick of a merged L-shape is connected`;
  - `test/ldraw-writer.test.ts :: writes .ldr that parseLDraw reads back identically`.
- **Acceptance:** largest-component share 1.0 on all clean corpus meshes; part count recorded.
- **Depends on:** B10.

**B12: legolize stage 3, surface fitting** (BIZ-33)
- **Goal:** `legolize/surface.ts`: slopes (3040, 3039, 3665 inverted, 54200 — mind its origin at the BOTTOM,
  CLAUDE.md), tiles (3068, 3069, 3070) on exposed tops, 1x1 round bricks/plates (3062, 4073) on curved columns. A
  fit is accepted only if it raises the silhouette IoU of its own column.
- **Files:** NEW `web/src/engine/legolize/surface.ts`.
- **First failing test:** `test/legolize-surface.test.ts :: a 45° ramp lattice gets 3040 slopes and a higher
  side-view silhouette IoU`.
- **Acceptance:** median silhouette IoU gain ≥ +0.02 on the clean-mesh set, and never negative per model
  (target).
- **Depends on:** B11, B14.

**B13: feature placement for meshes and photos** (BIZ-34)
- **Goal:** `legolize/features.ts` turns `ByomHints.features` into real parts in the brick model:
  - door: a frame (60596) + a leaf (60616a, the official mould — mind `STUDIO_FRAME_REDIRECTS`, CLAUDE.md) cut
    into the wall;
  - seat: 4079;
  - vehicle wheels: 4600 + 3641/4624 + 3139/... from a small table;
  - coaster car (26021) only on a hinted track.

  The existing detectors (`bedrock-interactives.ts`, the seat census, `bedrock-vehicle.ts`) then find them
  unchanged.
- **Files:** NEW `web/src/engine/legolize/features.ts`.
- **First failing test:** `test/legolize-features.test.ts :: a tagged door on a legolized wall ships as a hinged
  door entity` (built pack). Then `:: a tagged seat is in the seat census`.
- **Acceptance:** sim child-play passes doorway walk-through on 3 tagged corpus meshes.
- **Depends on:** B11, B03.

**B14: the metrics harness** (BIZ-33)
- **Goal:** `legolize/metrics.ts` + `scripts/_byom_metrics.ts`:
  - voxel IoU (two `LatticeModel`s, aligned by best integer shift ±2 cells);
  - silhouette IoU for 6 axis views + N arbitrary cameras, via `web/src/sim/render/rasterizer.ts`;
  - median CIEDE2000 per matched cell;
  - connectivity stats.

  JSON + a contact-sheet PNG (≤ 1999 px).
- **Files:** NEW `web/src/engine/legolize/metrics.ts`, `scripts/_byom_metrics.ts`.
- **First failing test:** `test/legolize-metrics.test.ts :: IoU of a lattice with itself shifted one cell is 1
  after alignment and < 1 before`.
- **Depends on:** none (it uses `LatticeModel` from B10's types; agree the type first).

**B15: the photo-to-mesh client** (BIZ-39)
- **Goal:** `tools/photo3d/` in Bun TS:
  - a ComfyUI HTTP client (`/upload/image`, `/prompt`, `/history/<id>`, `/view`), with timeouts;
  - prompt graphs for the mask step and the multi-view/single generation, ported from `pokefit/imageto3d.py`
    `mask_prompt` `:555`, `_pixal3d_chain` `:569`, `generate_prompt` `:646` and `single_prompt` `:657`, with
    `RemeshMesh sign_mode: "solid"`;
  - framing, ported from `frame_views` `:149`, decoding PNGs with `src/pipeline/export/png-decode-node.ts`;
  - a GLB vertex-colour reader;
  - a CLI: `bun tools/photo3d/cli.ts --front a.jpg --left b.jpg --back c.jpg --out x.glb`.
- **Files:** NEW `tools/photo3d/comfy.ts`, `framing.ts`, `graphs.ts`, `cli.ts`.
- **First failing tests:**
  - `test/photo3d-framing.test.ts :: every framed view has the same figure height and the largest extent spans
    1024/1.1 px`;
  - `test/photo3d-graphs.test.ts :: the multi-view graph remeshes with sign_mode solid`;
  - `test/photo3d-client.test.ts :: a mock ComfyUI returning a history entry yields the GLB bytes`.

  A live GPU test is gated on `RUN_GPU_TESTS=1` + ComfyUI reachable at 127.0.0.1:8188.
- **Acceptance:** one live run on a corpus photo set (5B) produces a closed GLB; the seconds are recorded.
  ComfyUI is started from `C:/git/comfyui-3d`, never `C:/git/ComfyUI` (the user's own install, left untouched per
  `pokeball/NOTES.md:438-439`).
- **Depends on:** none.

**B16: the synthetic ground-truth benchmark** (BIZ-39)
- **Goal:** `scripts/byom-photo-bench.ts`:
  - for each LDraw MOC in the corpus, render 4 views at the Pixal3D rig plus 1 held-out 45° view with the sim
    rasteriser on a black background;
  - run B15 → B10-B12 → metrics against the source's own lattice;
  - write `output/byom-bench-<sha>/summary.md`.

  It calibrates the section 4 targets, and the frozen gates go into `test/byom-photo-gates.test.ts`, which is
  local-only and skips without GPU artefacts. The test reads the recorded summary, so CI never needs a GPU.
- **First failing test:** `test/byom-photo-gates.test.ts :: the recorded benchmark meets the frozen gates`. It
  fails until a benchmark summary exists.
- **Depends on:** B14, B15, B10-B12, B29.

**B17: the real-photo benchmark** (BIZ-39)
- **Goal:** over corpus photo sets (5B), compute the reprojected silhouette IoU against the BiRefNet masks (the
  input view cameras are the framing's), plus a contact sheet for human grading.
  - On MobileBrick (P40), whose dataset licence must be read first, compute TRUE 3D voxel IoU against its
    ground-truth meshes, using 4 frames picked nearest azimuths 0/90/180/270 from each posed sequence. Target:
    ≥ 0.45 on its 18 curated models.
  - Every result is reported per DISTINCT build.
- **First failing test:** `test/byom-photo-gates.test.ts :: real-photo reprojection IoU meets the gate`. Same
  pattern as B16.
- **Depends on:** B16.

### Track S: server (Worker API)

**B18: the API skeleton, D1 schema and local dev** (BIZ-41)
- **Goal:**
  - `worker/index.ts` becomes the Worker entry: `/api/*` goes to `worker/api/router.ts`, and everything else to
    the default export of `worker/ldraw-omr.js` (unchanged);
  - `wrangler.toml`: `main = "worker/index.ts"`, a `[[d1_databases]] binding = "BYOM"` (local), and the route
    `craftmatic.click/api/*`, COMMENTED with "awaiting approval" until the user creates the D1 database;
  - `AccountStore` interface + `store-memory.ts` (tests) + `store-d1.ts`;
  - migrations;
  - `.dev.vars` in `.gitignore`.
- **Files:** NEW `worker/index.ts`, `worker/api/router.ts`, `env.ts`, `store.ts`, `store-memory.ts`, `store-d1.ts`,
  `worker/migrations/0001_byom.sql`; EDIT `wrangler.toml`, `.gitignore`.
- **First failing test:** `test/byom-api-router.test.ts :: an unknown /api route answers 404 JSON and /ldraw-parts
  still reaches the old handler`.
- **Acceptance:** `bunx wrangler dev --local` serves `/api/health` against a local D1 with the migration applied (a
  smoke script); CI's `bun run test` is green; `bunx wrangler deploy --dry-run` succeeds.
- **Depends on:** none. Do NOT deploy: the deploy job runs on every push to `main` (`deploy.yml`), so the D1
  binding must stay inert (no route) until approved. The test asserts that `wrangler.toml` has no active
  `/api/*` route while `BYOM_ROUTES_APPROVED` is unset.

**B19: accounts (passkeys and sessions)** (BIZ-42)
- **Goal:**
  - `worker/api/auth.ts`: register and login with WebAuthn (`@simplewebauthn/server`), sessions, logout,
    delete-account, export-my-data;
  - age confirmations;
  - rate limits per IP on auth routes (a Durable Object counter or D1 window).
- **Files:** NEW `worker/api/auth.ts`; package.json deps.
- **First failing test:** `test/byom-auth.test.ts :: a registered passkey logs in and the session cookie is
  HttpOnly Secure SameSite=Lax`. Then `:: a deleted account's sessions stop working` and `:: under-13 cannot
  register`.
- **Depends on:** B18.

**B20: entitlements, quotas and tickets** (BIZ-40)
- **Goal:**
  - `TIER_RULES`;
  - `POST /api/exports {hash12, parts, features, declaration}` → `ExportEntitlement` signed with Ed25519
    (WebCrypto), the private key in a Worker secret;
  - debit logic (a credit or the monthly allowance; the same-hash 30-day re-export is free);
  - an `exports` row.
- **Files:** NEW `worker/api/entitlements.ts`, `tickets.ts`.
- **First failing test:** `test/byom-entitlements.test.ts :: 301 parts on the free tier gets a static-only or
  watermark ticket per TIER_RULES`. Then `:: the 21st Creator export in a month is refused`, `:: the same hash
  within 30 days does not debit` and `:: a ticket verifies with the bundled public key and fails when one byte
  changes`.
- **Depends on:** B18, B19.

**B21: Stripe, test mode** (BIZ-43)
- **Goal:** `worker/api/stripe.ts` (the `PaymentProvider` interface + the Stripe implementation), `webhooks.ts`,
  `scripts/byom-stripe-seed.ts`, the live-key guard, and the Customer Portal session.
- **First failing tests:**
  - `test/byom-stripe.test.ts :: a live key is refused without the approval vars`;
  - `:: checkout.session.completed for a credit adds exactly one credit, and the same event twice adds one` (a
    signed fixture payload generated with the test secret);
  - `:: subscription.deleted drops the tier at period end`.
- **Acceptance:** the Stripe CLI's `stripe listen` against `wrangler dev` completes a test checkout. **This needs
  the user's Stripe TEST account: an outward sign-up, awaiting approval. Until then, the fixtures alone.**
- **Depends on:** B20.

**B22: terms, privacy, takedown and the declaration** (BIZ-44)
- **Goal:**
  - the drafts in `web/public/legal/` (the banner "DRAFT, pending legal review");
  - `worker/api/takedown.ts` (form intake, admin actions, strikes, the `hash12` blocklist consulted by
    `/api/exports`);
  - `scripts/byom-admin.ts`.
- **First failing test:** `test/byom-takedown.test.ts :: an upheld takedown blocks new exports of that hash and
  adds a strike`. Then `:: the third strike disables the account`.
- **Depends on:** B18, B20.

**B23: the showcase, originals only** (BIZ-46)
- **Goal:** `worker/api/showcase.ts` (submit, moderate, list), `web/public/showcase/` (a static gallery), the
  title screen pattern table, and seeding from Plan A designs.
- **First failing test:** `test/byom-showcase.test.ts :: a submission titled with a set number or a LEGO mark is
  rejected`. Then `:: only approved items are listed`.
- **Depends on:** B18, B06, Plan A (seed content).

**B24: batch export, the studio CLI and the cloud builder (prepared)** (BIZ-45)
- **Goal:**
  - `scripts/byom-batch.ts` (CLI) and `web/src/engine/byom/batch.ts` (the queue core, shared with the UI);
  - `services/byom-builder/` (Dockerfile + `main.ts` taking jobs from `/api/build-jobs`), sized by measured peak
    RSS on the largest corpus model;
  - not deployed.
- **First failing test:** `test/byom-batch.test.ts :: three fixture models produce three packs, three reports and
  a summary, deterministic bytes on rerun`.
- **Depends on:** B01, B03, B07.

**B25: the photo-job queue and the GPU agent** (BIZ-39)
- **Goal:**
  - `worker/api/photo-jobs.ts`: create (R2 upload by signed URL or direct PUT ≤ 10 MB per photo, max 4), claim
    (agent token), complete, status;
  - `tools/photo3d/agent.ts`, which polls, runs B15 and uploads the result.

  The agent runs only when the user starts it on the GPU PC. Turning on the public route = awaiting approval.
- **First failing test:** `test/byom-photo-jobs.test.ts :: a claimed job cannot be claimed twice and expires back
  to queued after 15 min`.
- **Depends on:** B18, B19, B15.

### Track U: UI

**B26: the Create tab, upload → tag → check → export** (BIZ-47)
- **Goal:**
  - `web/src/ui/byom/*`, a pure state machine in `state.ts` (unit-tested), a nav tab, `?tab=create`;
  - viewer reuse, touch tagging, the screen + declaration, the export with progress (`export-progress.ts`), the
    report view, and the download zip.
- **First failing test:** `test/byom-ui-state.test.ts :: a blocked screen verdict cannot reach the export step`.
  Then `:: the free tier shows the watermark notice before export`.
- **Acceptance:** Playwright (Node) screenshots at 393x852, 768x1024 and 1440x900 under
  `output/byom-ui-<sha>/` (≤ 1999 px), reviewed by eye and listed in the tracker; no horizontal scroll at 393;
  every control ≥ 44 px (asserted by the probe).
- **Depends on:** B01, B03 (hint editing), B07 (the report view). It can start against typed fakes.

**B27: account and billing UI** (BIZ-42, BIZ-43)
- **Goal:** passkey sign-in/up, the plan page from `TIER_RULES`, a usage meter, the Stripe Checkout redirect (test),
  the portal link, and delete/export-my-data.
- **First failing test:** `test/byom-ui-billing.test.ts :: the plan page prices come from TIER_RULES` (no
  duplicated numbers).
- **Depends on:** B19, B20, B21.

**B28: studio batch UI and the photo upload UI** (BIZ-45, BIZ-39)
- **Goal:**
  - batch: a drop folder/zip, a queue list with per-item status and report links, resume from IndexedDB;
  - photos: a 1-4 view capture guide (front/left/back/right silhouettes, plain-background hint), camera capture
    on mobile (`<input capture>`), job status.
- **First failing test:** `test/byom-ui-state.test.ts :: a batch resumes after reload with finished items kept`.
- **Depends on:** B24, B25, B26.

### Track C: corpus

**B29: the corpus manifest and polite fetcher** (BIZ-48)
- **Goal:** `test/fixtures/byom-corpus.manifest.json` built from section 5's tables. `scripts/byom-corpus-fetch.ts`:
  - fetches one at a time, honours robots, waits ≥ 2.5 s, writes the sha256, skips the existing;
  - writes ONLY under `data/byom-corpus/`;
  - stops at any login or terms wall and records it as `unresolved`, never as "absent" (the CDX lesson);
  - marks login-only items (BrickLink F17-F21, Sketchfab F31-F41) `manual: true`, prints the steps for the user,
    and never logs in;
  - fetches Commons and Flickr per FILE, keeping each file's licence and credit from the API, never one licence for
    a whole category.
- **First failing test:** `test/byom-corpus-manifest.test.ts :: every manifest entry has a url, licence and kind,
  and no path outside data/byom-corpus`.
- **Depends on:** none.

**B30: the corpus regression run** (BIZ-49)
- **Goal:** `scripts/byom-corpus-run.ts` imports, exports (one at a time), checks, sims and screens every corpus
  model. It writes `output/byom-corpus-<sha>/summary.md`, counting per DISTINCT model: imports OK, packs OK, sim
  pass, features found, screen verdict, seconds and peak RSS. The numbers go into `TASKS-BUSINESS.md`.
- **First failing test:** `test/byom-corpus-gates.test.ts :: the last recorded corpus run imports every
  manifest model` (local-only; reads the summary).
- **Depends on:** B01-B08, B29.

---

## 8. Parallelisation order

These waves are drawn so that no two packages in a wave edit the same file. The hot files are:
- `playable-addon.ts`: B02, B04, B08 and Plan A;
- `schem-pipeline.ts`: B02, B03;
- `lego.ts`: B01 only;
- `wrangler.toml`: B18 only.

| Wave | Run at once | Why they do not collide |
|---|---|---|
| **1** | B01, B05, B06, B09, B10, B14, B15, B18, B29 | each owns new files; B01 alone edits `lego.ts`/`lxf-parser.ts`, B05 alone `ldraw-geometry.ts`, B09 alone `mesh-import.ts`/`upload.ts`, B18 alone `wrangler.toml`/`.gitignore` |
| **2** | B02 → then B04 (serial, one agent), B11, B19, B07, B26 (against fakes) | B02/B04 are the only `playable-addon.ts` editors in the wave; B07 and B26 are new files |
| **3** | B03, B08, B12, B20, B22, B25 | B03 edits `schem-pipeline.ts` (B02 merged); B08 edits `playable-addon.ts` after B04 merged |
| **4** | B13, B16, B21, B23, B24, B27 | |
| **5** | B17, B28, B30 | |

Merge order inside a wave: by package number. Each agent merges `main` into its branch before its final gate run.
Plan A's namespace, texture and manifest packages must land before B04 and B08 (or be done by the same agent).
The Fable merge decides who owns them.

---

## 9. Risks and open questions

### Risks
| # | Risk | Mitigation |
|---|---|---|
| R1 | **Is charging for a converter allowed by Mojang?** The Usage Guidelines list no case for selling a tool, and say what isn't covered "probably means we don't want you to do it" (`TASKS-BUSINESS.md:29-35`). Our output is a mod the creator distributes. | a lawyer (Q1); keep a free tier; charge for the hosted service, signed validation and support, never for "a mod"; no Minecraft assets in outputs |
| R2 | Users upload official sets anyway | the screen (B06), the declaration, takedown (B22), no set examples in marketing |
| R3 | The minifigure: a creator's MOC with minifigs produces minifig-shaped entities, and the 3D marks are upheld (T-297/22) | default `figures: 'brick-figure'` (Plan A's figure) for paid commercial exports; `keep` only for personal use (Q3) |
| R4 | Studio-only meshes compiled into outputs (the Studio EULA); the R2 part mirror still holds Studio keys (`sync-ldraw-r2.mjs:12-27`) | B05: classify, refuse for commercial, report |
| R5 | The MIT public repo makes the paywall an honour system | sell the service and the signature; Q7 on a private product repo |
| R6 | Detection does not generalise (26/200 census sets fail) | B30 is a MOC census; feature tags (B03/B13) as the explicit fallback; the report says what was missed |
| R7 | Export time: median 138 s, p90 846 s on this PC (section 2.4), slower on phones | progress UI; recommend desktop for > 2,000 parts; cloud build for Studio |
| R8 | Photo results disappoint (expectations) | section 4's honest table in the UI; show reprojection IoU; part-exact recovery is research, out of scope |
| R9 | The GPU is the user's PC; no production GPU | the agent model; a hosted GPU (RunPod, Modal, Replicate) is a paid outward step (Q6) |
| R10 | Model weight licences for commercial use (Pixal3D MIT per `pokefit/imageto3d.py:3`; TRELLIS.2, BiRefNet, MoGe, DINOv3, Qwen-Image-Edit each to verify) | B15 records each weight's licence in `tools/photo3d/LICENSES.md` before any public route; DINOv3's custom licence needs a reading |
| R11 | Corpus licences (Rebrickable MOC terms, Flickr per-photo, BrickLink gallery) | local-only, manifest records the licence, nothing redistributed (section 5) |
| R12 | Children: COPPA/GDPR-K | 13+ accounts, 18+ payments, anonymous free tier |
| R13 | The Worker deploys on every push: an accidental live route | B18's test that no `/api/*` route is active without approval |
| R14 | Abuse: free photo jobs consume GPU time | photo jobs require sign-in + quota; rate limits |

### Open questions for the user
1. **Q1, lawyer:** may we charge for a hosted converter whose OUTPUT is a Minecraft add-on? Must the paid tier be
   framed as "service and support" only?
2. **Q2:** `.io` CustomParts and Studio-only meshes. Refuse in commercial outputs (proposed), or allow with the
   creator's warranty?
3. **Q3:** minifigs in creators' MOCs. Replace with our brick figure by default for commercial exports (proposed)?
4. **Q4:** Rebrickable's data terms for building the official-set fingerprint DB, and BrickLink/Rebrickable terms
   for linking MOCs in the showcase.
5. **Q5:** payments. Stripe direct (we handle tax registration) or a merchant of record (Paddle/Lemon Squeezy)?
   Stripe only, as the brief says, or keep the `PaymentProvider` seam open?
6. **Q6:** where does a paid cloud build or photo job run? Cloudflare Containers, Railway (already used), a GPU
   rental? Cost ceiling per month?
7. **Q7:** keep the product layer (`worker/api`, `services/byom-builder`) in this public MIT repo, or in a private
   repo?
8. **Q8:** the free tier above 300 parts. Static blocks only (proposed), or a watermarked add-on with all
   features?
9. **Q9:** the tab name in the nav ("Create"?), and whether the LEGO tab stays public on craftmatic.click once B
   launches (it shows official sets, R2).
10. **Q10:** the DMCA designated-agent registration and the business entity (the user's, per `brief-common.md`).

---

## 10. REQUIREMENTS.md rows to add (section 17), all `OPEN`

| id | requirement | guards (to add when done) |
|---|---|---|
| `BIZ-30` | One model-import service for .ldr/.mpd/.io/.lxf/.lxfml/.zip with no DOM or globals; LXF parses in tests | `test/byom-import.test.ts :: parses a bare .lxfml without DOMParser` |
| `BIZ-31` | BYOM exports never apply set-number/title heuristics; the creator's hints decide components | `test/byom-mode.test.ts :: ships no time circuits`; `test/byom-hints.test.ts :: hinted plane ships as a scripted flyer` |
| `BIZ-32` | Mesh uploads: OBJ, GLB/GLTF (Draco/meshopt), STL, 3MF, PLY with units | `test/mesh-import-formats.test.ts :: binary STL cube` |
| `BIZ-33` | Mesh → brick model (lattice, merge, surface fit) with measured IoU/connectivity gates; .ldr download | `test/legolize-merge.test.ts`; `test/legolize-metrics.test.ts`; `test/ldraw-writer.test.ts` |
| `BIZ-34` | Creator-tagged doors/seats/wheels on meshes and photos become real playable features | `test/legolize-features.test.ts :: tagged door` |
| `BIZ-35` | BYOM outputs: brand-neutral text, Mojang disclaimer, LDraw CC BY credits | `test/byom-output-text.test.ts` |
| `BIZ-36` | Part provenance report; Studio-only meshes refused in commercial exports | `test/byom-part-provenance.test.ts` |
| `BIZ-37` | Official-set screen (fingerprint) with calibrated thresholds | `test/byom-fingerprint.test.ts` |
| `BIZ-38` | Validation report (pack-check parity with `_mcaddon_check.py`, sim, features, Marketplace readiness) shipped with every export | `test/byom-pack-check.test.ts`; `test/byom-report.test.ts` |
| `BIZ-39` | BYOM gen: photos → mesh (Pixal3D/TRELLIS.2 via ComfyUI) → bricks, with synthetic and real-photo gates; GPU job queue | `test/photo3d-framing.test.ts`; `test/byom-photo-gates.test.ts`; `test/byom-photo-jobs.test.ts` |
| `BIZ-40` | Tiers, quotas, signed export tickets, free-tier watermark | `test/byom-entitlements.test.ts`; `test/byom-watermark.test.ts` |
| `BIZ-41` | Typed Worker API on D1/R2, inert until approved | `test/byom-api-router.test.ts` |
| `BIZ-42` | Accounts: passkeys, sessions, age gates, delete/export data | `test/byom-auth.test.ts` |
| `BIZ-43` | Stripe TEST-mode checkout, subscriptions, webhooks, live-key guard | `test/byom-stripe.test.ts` |
| `BIZ-44` | Terms/privacy drafts, upload declaration, takedown + strikes | `test/byom-takedown.test.ts` |
| `BIZ-45` | Studio batch export (browser queue, CLI, cloud builder prepared) | `test/byom-batch.test.ts` |
| `BIZ-46` | Showcase of original models only, moderated | `test/byom-showcase.test.ts` |
| `BIZ-47` | Mobile-first dark "Create" tab, touch tagging, screenshots at 3 widths | `test/byom-ui-state.test.ts` + screenshot evidence |
| `BIZ-48` | Real BYOM test corpus (≥ 30 files, ≥ 30 photo sets), licences recorded, local-only | `test/byom-corpus-manifest.test.ts` |
| `BIZ-49` | Corpus regression run (a MOC census) with per-distinct-model counts | `test/byom-corpus-gates.test.ts` |

Each row's requirement cell quotes the user (2026-11-09: "find real user lego set pictures and imported 3d files
to test Bring your own model gen- and build out full"). Its implementation cell says "plan:
`docs/plans/business-B-byom-converter.md` WP B<NN>". Its guard cell stays `none` until the test exists (the ledger
test fails a `DONE-*` row without a guard).

---

## 11. The `TASKS-BUSINESS.md` section for B

Add it under "Start here", replacing nothing. Prune it as packages merge.

```md
## Scenario B: BYOM converter (plan: docs/plans/business-B-byom-converter.md)
- STATE <date>: wave <n> running. Worktrees: `.worktrees/biz-b<NN>-<slug>` (list each with its agent and branch).
- Merged: (package, commit) - delete the line from "Open" when merged.
- Open, in wave order: B01 ... B30 (one line each: id, owner, status, blocking item).
- Awaiting the user (outward, prepared, NOT done):
  - Stripe TEST account + `sk_test_` key in `.dev.vars` (B21)
  - D1 database `byom` + `/api/*` route in prod (B18), Ed25519 ticket key as a Worker secret (B20)
  - official-fingerprint upload to prod R2 (B06)
  - email provider for magic links (B19)
  - GPU host for photo jobs / container host for cloud builds (B25, B24; Q6)
  - DMCA agent registration; lawyer review of terms/privacy (B22; Q1)
- Measurements a decision still needs:
  - screen thresholds and their FP/TP per distinct set (B06)
  - photo gates: synthetic voxel IoU, held-out silhouette IoU, dE, real reprojection IoU (B16, B17)
  - corpus run: imports/packs/sim pass/features per distinct model, seconds, peak RSS (B30)
- Commands:
  - `bunx vitest run test/byom-*.test.ts test/legolize-*.test.ts test/photo3d-*.test.ts`
  - `bun scripts/byom-corpus-fetch.ts --only=<id>` (one at a time) ; `bun scripts/byom-corpus-run.ts`
  - `bun tools/photo3d/cli.ts --front ... --out ...` (ComfyUI from C:/git/comfyui-3d, port 8188)
  - `bunx wrangler dev --local` (API against local D1) ; `stripe listen --forward-to localhost:8787/api/stripe/webhook`
- Evidence paths: `output/byom-bench-<sha>/`, `output/byom-corpus-<sha>/`, `output/byom-ui-<sha>/`
```
